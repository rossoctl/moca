import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_EXEC_TIMEOUT_S,
  OUTPUT_TRUNCATED_MARKER,
  type FastTier,
  type SandboxTransport,
} from '../src/transport.js';
import { createCapacityLatch } from '../src/capacity-latch.js';

/**
 * A scripted sandbox backend, transport-agnostic. Each transport's conformance
 * factory maps these fields onto its own wire (GrpcRelayTransport → scripted
 * ExecEvent frames).
 */
export interface FakeBehavior {
  /** chunks emitted on stdout (collected into the returned `stdout` buffer) */
  stdout?: string[];
  /** chunks emitted on stderr (streamed to onData, NOT in the returned buffer) */
  stderr?: string[];
  /** exit code delivered on completion */
  exitCode?: number | null;
  /** never complete — used to exercise timeout/abort */
  hang?: boolean;
}

/**
 * How a transport stops a flood when the cap trips. Each transport DECLARES its
 * mechanism and the battery asserts the factory observed exactly that one — instead of
 * accepting a bare `true`, which every transport could satisfy by killing something
 * local while the remote producer kept running (#185).
 *
 * Why an enum and not a "was it remote?" boolean: a boolean would assert `false` for
 * a transport that only kills something local while the remote producer kept running,
 * discarding the coverage that the stop actually happened. Every transport must make a
 * positive claim about its own mechanism.
 *
 *  - `remote-abort`       the far side is told to stop, correlated to this exec's req_id
 *                         (GrpcRelayTransport's `Abort` for this exec's req_id)
 *  - `local-kill`         we kill our local client; the in-pod process stops on EPIPE,
 *                         if at all (kept for a future in-cluster client)
 *  - `producer-side-cap`  the producer is bounded at the source in the sandbox, so there
 *                         is nothing to kill (kept for a future capped producer)
 *  - `none`               nothing stopped it. No transport may DECLARE this; it exists so
 *                         a regression that deletes the stop fails loudly instead of
 *                         silently reporting `true`.
 */
export type ProducerStop = 'remote-abort' | 'local-kill' | 'producer-side-cap' | 'none';

/** What a transport declares about itself to the battery. */
export interface TransportCapabilities {
  producerStop: ProducerStop;
  /**
   * Does this transport replay output to `opts.onData` as it arrives? Declared rather
   * than silently skipped: quietly omitting a case for one implementation is how the
   * #185 asymmetry survived in the first place.
   */
  streams: boolean;
  /**
   * Whether a burst of small file ops costs ONE reused shell or N round trips (#245).
   *
   * Declared for the same reason `producerStop` is an enum rather than a boolean: every
   * implementation must make a positive claim about itself, so a fourth transport cannot
   * ship without one being considered. Before this existed nothing recorded a transport's
   * fast tier — so `extension.ts`'s `opts.transport`, which overrides BOTH tiers, could
   * silently remove one.
   *
   * Unlike `producerStop`, the battery cannot observe this from one exec: it is a claim
   * about the COST OF N ops, and a scripted fake's process count is the factory's
   * fiction rather than the transport's behaviour. So the battery pins the claim against
   * `fastTier(transport)` — the value a CALLER reads to choose a tier — and the cost
   * itself is proved per-implementation (persistent-exec.test.ts counts spawns).
   * Asserting the declaration still earns its keep: it is what makes the value a caller
   * reads and the value the transport claims the same fact.
   */
  fastTier: FastTier;
}

export interface FakeHandle {
  transport: SandboxTransport;
  /** the stdin the transport forwarded to the backend, once exec has run */
  stdinSeen: () => Buffer | undefined;
  /**
   * Which stop mechanism did the factory actually observe for the exec just run? The
   * battery compares this against the transport's declared `producerStop`, so a
   * transport cannot pass by claiming one mechanism and performing another.
   */
  producerStop: () => ProducerStop;
}

/** opts.outputCapBytes MUST be honoured by every factory — it is how the cap case drives each transport's own cap, not a fixed default. */
export type TransportFactory = (
  behavior: FakeBehavior,
  opts?: { outputCapBytes?: number },
) => FakeHandle;

/**
 * The shared SandboxTransport contract. This battery runs against every
 * implementation — today, GrpcRelayTransport. That identical pass is what makes
 * implementations safely swappable (spec §11, driver #2).
 */
export function runConformance(
  label: string,
  make: TransportFactory,
  caps: TransportCapabilities,
): void {
  afterEach(() => vi.useRealTimers());

  describe(`SandboxTransport conformance: ${label}`, () => {
    it('returns collected stdout and the exit code', async () => {
      const { transport } = make({ stdout: ['foo', 'bar'], exitCode: 0 });
      const r = await transport.exec('echo hi');
      expect(r.stdout.toString()).toBe('foobar');
      expect(r.exitCode).toBe(0);
      expect(r.truncated).toBe(false); // an untruncated exec must say so explicitly
    });

    it.skipIf(!caps.streams)(
      'streams stdout and stderr to onData; stderr is excluded from stdout',
      async () => {
        const { transport } = make({ stdout: ['out'], stderr: ['err'], exitCode: 0 });
        const chunks: string[] = [];
        const r = await transport.exec('cmd', { onData: (c) => chunks.push(c.toString()) });
        expect(r.stdout.toString()).toBe('out'); // stderr NOT collected
        expect(chunks).toContain('out');
        expect(chunks).toContain('err'); // stderr streamed
      },
    );

    it('forwards stdin to the backend', async () => {
      const { transport, stdinSeen } = make({ stdout: [], exitCode: 0 });
      await transport.exec('base64 -d', { stdin: Buffer.from('payload') });
      expect(stdinSeen()?.toString()).toBe('payload');
    });

    it('propagates a non-zero exit code', async () => {
      const { transport } = make({ stdout: [], exitCode: 3 });
      const r = await transport.exec('false');
      expect(r.exitCode).toBe(3);
    });

    it('caps returned stdout, appends the truncation marker, and stops collecting', async () => {
      // All three transports advertise a total-output-per-exec cap (spec §8): the
      // concrete mitigation for a hostile sandbox flooding the model's context. A cap on
      // fewer than all transports is a divergence in the seam, not an implementation detail.
      const handle = make({ stdout: ['aaaa', 'bbbb', 'cccc'], exitCode: 0 }, { outputCapBytes: 6 });
      const r = await handle.transport.exec('cat big');
      const s = r.stdout.toString();
      expect(s).toContain(OUTPUT_TRUNCATED_MARKER);
      expect(s).not.toContain('cccc'); // collection stopped at the cap
      expect(r.exitCode).toBeNull(); // the exec was cut short, so there is no real exit code
      // The seam represents truncation explicitly rather than overloading a null exit
      // code, which also means "signalled, no status" (spec §3.1). Callers cannot tell
      // those apart without this flag, which is what let a killed bash read as success.
      expect(r.truncated).toBe(true);
      // Invariant asserted for every implementation: truncated ⇒ no real exit status.
      expect(r.exitCode).toBeNull();
      // Dropping bytes on the floor is not the defense — the flood must be stopped, or a
      // hostile sandbox keeps burning the pod's CPU and the relay's bandwidth after we
      // have stopped reading (spec §8). Each transport stops it differently, so assert
      // the mechanism it DECLARED rather than accepting any truthy value.
      expect(handle.producerStop()).toBe(caps.producerStop);
    });

    it('does not flag output that lands exactly on the cap', async () => {
      // The boundary is `> cap`, not `>= cap`. Output that lands exactly on the cap is
      // COMPLETE and must not be reported as truncated — otherwise every read of a
      // cap-sized file would fail. The over-cap case above pins the other side.
      const { transport } = make({ stdout: ['aaaa', 'bb'], exitCode: 0 }, { outputCapBytes: 6 });
      const r = await transport.exec('cat exactly-at-cap');
      expect(r.truncated).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe('aaaabb');
      expect(r.stdout.toString()).not.toContain(OUTPUT_TRUNCATED_MARKER);
    });

    it('rejects with timeout:<n> when the command exceeds the timeout', async () => {
      vi.useFakeTimers();
      const { transport } = make({ hang: true });
      const p = transport.exec('sleep 999', { timeout: 2 });
      const assertion = expect(p).rejects.toThrow('timeout:2');
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
    });

    // The default was pinned by nothing, so the three transports had silently diverged:
    // two armed no timer at all and the third used 120 s (#182). Whatever the value is,
    // every transport must apply the SAME one, or an exec's fate depends on which
    // transport served it -- something no caller above the seam can see.
    it('applies DEFAULT_EXEC_TIMEOUT_S when the caller names no timeout', async () => {
      vi.useFakeTimers();
      const { transport } = make({ hang: true });
      const p = transport.exec('sleep 999');
      const assertion = expect(p).rejects.toThrow(`timeout:${DEFAULT_EXEC_TIMEOUT_S}`);
      // Just short of the ceiling it must still be pending: a transport that timed out
      // early (or armed 120 s) would pass a bare "eventually rejects" check.
      await vi.advanceTimersByTimeAsync(DEFAULT_EXEC_TIMEOUT_S * 1000 - 1000);
      let settled = false;
      void p.catch(() => {}).finally(() => (settled = true));
      await Promise.resolve();
      expect(settled, 'rejected before the default ceiling elapsed').toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it('arms no timer at all for an explicit timeout: 0', async () => {
      vi.useFakeTimers();
      const { transport } = make({ hang: true });
      const p = transport.exec('sleep 999', { timeout: 0 });
      let settled = false;
      void p.catch(() => {}).finally(() => (settled = true));
      // Well past the default ceiling: an opt-out that quietly fell back to it would
      // reject here.
      await vi.advanceTimersByTimeAsync(DEFAULT_EXEC_TIMEOUT_S * 2 * 1000);
      await Promise.resolve();
      expect(settled, 'timeout: 0 must mean no timeout, not the default').toBe(false);
    });

    it("rejects with 'aborted' when the signal fires", async () => {
      const { transport } = make({ hang: true });
      const ac = new AbortController();
      const p = transport.exec('sleep 999', { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toThrow('aborted');
    });

    it('declares its fast tier, matching what a caller reads off the transport', async () => {
      // #245. The battery cannot MEASURE this from one exec — it is a claim about the cost
      // of N ops, and a scripted fake's process count is the factory's fiction. What it
      // can pin is that the value a caller reads is the value the transport claims, so a
      // fourth transport cannot ship without choosing one.
      const { transport } = make({ stdout: [], exitCode: 0 });
      expect(transport.fastTier).toBe(caps.fastTier);
    });

    it('still declares that fast tier through a capacity latch', async () => {
      // #245, the half the assertion above cannot reach. `extension.ts` never hands a tool
      // the raw transport on a harness turn: `watch` wraps BOTH tiers, so the value a
      // caller actually reads comes off the WRAPPER. A wrapper that hardcoded either
      // literal would make every latched transport claim the same tier and contradict the
      // thing it wraps — and the per-transport assertion above cannot see that, because it
      // reads the unwrapped object. Run here, in the battery, rather than once over one
      // transport in capacity-latch's own tests: forwarding must hold for whichever
      // transport is latched, including a fourth, and this is the only list of all of them.
      const { transport } = make({ stdout: [], exitCode: 0 });
      expect(createCapacityLatch().watch(transport).fastTier).toBe(caps.fastTier);
    });

    it('close() resolves and is idempotent', async () => {
      const { transport } = make({ stdout: [], exitCode: 0 });
      await expect(transport.close()).resolves.toBeUndefined();
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
}
