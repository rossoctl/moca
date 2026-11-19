import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { acquireTurnSandbox } from '../src/run-turn.js';
import type { LeaseStore } from '../src/sandbox-lease.js';
import { TEMPLATE_LABEL, type AffinityStore } from '../src/sandbox-affinity.js';
import type { RecordStore, SandboxRecord } from '../src/pool-records.js';
import type { ExecClientLike, SandboxTransport } from '@moca/k8s-sandbox';

/**
 * `/turn` must close the gRPC channel it opened (#894). Sibling of the per-turn Redis client leak:
 * the same class of defect (a per-turn resource leak, fatal only at supervisor lifetimes) in the
 * same function, found the same way — on hardware, not in a suite.
 *
 * `selectPoolSandbox` builds one `SandboxExecClient` per lease, i.e. per turn, and grpc-js gives
 * each client its own channel. `GrpcRelayTransport.close()` existed and `run-leaf.ts` called it, but
 * `AcquiredTurnSandbox` exposed only `heartbeat`/`release`, so the sync path had no way to reach it
 * and never did. Measured on the P6 rig, heap-diffing one worker across ~2,400 turns: snapshot A
 * held 0 `InternalChannel`s, snapshot B held exactly 2,406 — one per turn, plus `DnsResolver` and
 * `ChannelWrap` at 1.00/turn, `createSubchannel`/`addChannelzChild`/`BackoffTimeout` at 2.00, and
 * `Timeout` at 6.02. ~15-19 KB per turn per worker, ~10 GB/hour at 149 turns/s.
 *
 * The retention is worth spelling out because it is NOT "a socket per turn": grpc-js shares
 * subchannels globally by target+credentials, so 2,406 dead channels held only 4 sockets (measured:
 * 200 turns moved the count 0 → 4, per-worker fds flat at 9). One permanently-live `Subchannel`'s
 * `stateListeners` Set accumulates an entry per unclosed channel, and each entry retains a whole
 * channel graph:
 *
 *   InternalChannel <- Subchannel.stateListeners <- Http2Transport.disconnectListeners
 *     <- ClientHttp2Session._events.goaway <- Http2Session <- synthetic:(Global handles)
 *
 * So the leak is invisible to every fd- and connection-count check, and bounded only by RAM. It is
 * also why no RSS-derived capacity figure for this tier was usable while it stood.
 *
 * Two kinds of test below, deliberately. The behavioural ones pin the seam; the structural one pins
 * the CALL, because the original bug was not a wrong `close()` — it was a correct `close()` that
 * nothing invoked, and a test that only drove `closeTransport()` directly would have passed against
 * the leaking build.
 */

/** Minimal lease store: this suite asserts on transports, not on lease bookkeeping. */
const fakeLeaseStore = (): LeaseStore => ({
  load: async () => 0,
  acquire: async () => true,
  heartbeat: async () => {},
  release: async () => {},
});

/** Affinity is injected only to keep the selection off Redis; it never decides anything here. */
const fakeAffinity = (): AffinityStore => ({
  get: async () => null,
  claim: async (_sessionId, entry) => entry,
  replace: async () => {},
  detachedSince: async (_sandboxId, nowMs) => nowMs,
});

const grpcRec: SandboxRecord = {
  sandboxId: 'sbx-remote-1',
  labels: {},
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
};

const fakeRecords = (recs: SandboxRecord[]): RecordStore => ({
  put: async () => {},
  remove: async () => {},
  list: async () => recs,
});

/** An ExecClientLike whose `close` is observable — the call the leak never made. */
function spyExecClient(): ExecClientLike & { close: ReturnType<typeof vi.fn> } {
  return {
    exec: () => ({ on: () => ({}), cancel: () => {} }) as never,
    abort: (_req, cb) => {
      cb(null);
      return {};
    },
    close: vi.fn(),
  };
}

/** The env that puts a turn on the grpc relay path (`SH_REMOTE_SANDBOX=1` + a pool selector). */
const remoteEnv = () =>
  ({
    KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
    SH_REMOTE_SANDBOX: '1',
  }) as NodeJS.ProcessEnv;

const acquireRemote = (
  deps: { makeExecClient?: () => ExecClientLike; makeTransport?: () => SandboxTransport },
  template?: { id: string; seed?: string },
) =>
  acquireTurnSandbox(
    undefined,
    remoteEnv(),
    '/head',
    'run-1',
    {
      lease: fakeLeaseStore(),
      affinity: fakeAffinity(),
      // A templated session only sees workers labelled for that template (spec §4), so the record
      // has to carry the label or the acquire fails as pool-empty before a transport is ever built.
      records: fakeRecords([
        template ? { ...grpcRec, labels: { [TEMPLATE_LABEL]: template.id } } : grpcRec,
      ]),
      ...deps,
    },
    undefined,
    template,
  );

describe('acquireTurnSandbox closes the grpc channel it opened', () => {
  it('closes the channel for a pool-leased grpc sandbox', async () => {
    const client = spyExecClient();

    const got = await acquireRemote({ makeExecClient: () => client });

    expect(got.sandbox?.transport).toBeDefined();
    expect(client.close).not.toHaveBeenCalled(); // not before the turn ends
    await got.closeTransport();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('is idempotent, so a second teardown path cannot double-close a shared channel', async () => {
    // Not hypothetical tidiness: executeTurn's finally and any future abort/timeout teardown can
    // both run. GrpcRelayTransport guards this with its own `closed` flag; this asserts the guard
    // survives being reached through this seam.
    const client = spyExecClient();

    const got = await acquireRemote({ makeExecClient: () => client });
    await got.closeTransport();
    await got.closeTransport();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('NEVER closes an injected transport — the caller owns it', async () => {
    // The load-bearing ownership rule. A prompt leaf injects the transport it leased and closes it
    // itself (run-leaf.ts:713, :903, :968, :1118, :1191, :1319) AFTER this turn returns, running
    // converge and cleanup execs over it. Closing it here would both break run-leaf's "closes it
    // exactly once" contract and cancel those execs out from under it.
    const close = vi.fn(async () => {});
    const injected = {
      transport: { exec: async () => ({ stdout: '', exitCode: 0 }), close } as never,
      podCwd: '/workspace',
    };

    const got = await acquireTurnSandbox(injected, remoteEnv(), '/head', 'run-1');
    await got.closeTransport();

    expect(close).not.toHaveBeenCalled();
  });

  it('is a safe no-op when no sandbox resolved at all (tools run local)', async () => {
    const got = await acquireTurnSandbox(undefined, {} as NodeJS.ProcessEnv, '/head', 'run-1');

    expect(got.sandbox).toBeNull();
    await expect(got.closeTransport()).resolves.toBeUndefined();
  });

  it('closes its own channel when a template seed throws, since the caller gets no handle', async () => {
    // A throwing acquire never returns a `closeTransport` for anyone to call, so this path has to
    // close its own channel — and it is the path that retries hardest, because a failing seed is
    // re-run on the next turn.
    const close = vi.fn(async () => {});
    const transport = {
      exec: async () => {
        throw new Error('seed exec failed');
      },
      close,
    } as unknown as SandboxTransport;

    await expect(
      acquireRemote(
        { makeExecClient: () => spyExecClient(), makeTransport: () => transport },
        { id: 'tpl', seed: 'install.sh' },
      ),
    ).rejects.toThrow(/seeding the workspace/);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** Strip comments, so the prose above (and in the sources) cannot satisfy a check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The teardown block of `executeTurn` — everything after the one call to `executeTurnCore`. Sliced
 * rather than grepped whole-file so this asserts the close happens in the turn's FINALLY, which is
 * what makes it run on a throw and on an abort, not merely somewhere in the module.
 */
function executeTurnTeardown(): string {
  const body = code(src('run-turn.ts'));
  // Anchored on the call's PREFIX, not the whole call: pinning the exact argument list would make
  // this guard silently un-anchorable — i.e. failing — on any future signature change that has
  // nothing to do with the leak it exists to catch.
  const at = body.indexOf('executeTurnCore(');
  expect(at).toBeGreaterThan(-1); // the slice anchor must exist, or this guard silently passes
  return body.slice(at);
}

describe('the close is actually wired into the turn teardown', () => {
  it("executeTurn's finally closes the transport", () => {
    const teardown = executeTurnTeardown();
    expect(teardown).toMatch(/\}\s*finally\s*\{/);
    expect(teardown).toMatch(/await acquired\.closeTransport\(\)/);
  });

  it('releases the lease before closing, matching run-leaf', () => {
    // Both orders are defensible and no exec is outstanding by this point; the reason to pin one is
    // that a divergence between the two paths is a thing future readers have to explain, whereas an
    // identical order means an ordering bug is one bug in two places.
    const teardown = executeTurnTeardown();
    const release = teardown.indexOf('acquired.release()');
    const close = teardown.indexOf('acquired.closeTransport()');
    expect(release).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(release);
  });

  it('swallows a close failure rather than failing a completed turn', () => {
    // Same reasoning as release(): teardown must not convert a turn that did its work into an error.
    // One retained channel in one worker is a bounded cost; a spurious 500 is not.
    expect(executeTurnTeardown()).toMatch(/acquired\.closeTransport\(\)\.catch\(/);
  });

  it('proves the guard can fail: a teardown with no close is detectable', () => {
    // An absence-assertion never shown capable of failing asserts nothing. This is the exact shape
    // of the leaking build.
    const leaking = code(`
      try {
        return await executeTurnCore(input, acquired.sandbox, opened);
      } finally {
        await attached?.detach().catch(() => {});
        if (leaseRenewal) clearInterval(leaseRenewal);
        await acquired.release().catch(() => {});
      }
    `);
    const at = leaking.indexOf('executeTurnCore(');
    expect(leaking.slice(at)).not.toMatch(/await acquired\.closeTransport\(\)/);
  });
});
