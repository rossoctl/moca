import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentials } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrpcRelayTransport, type ExecClientLike } from '../src/grpc-relay-transport.js';
import { OUTPUT_TRUNCATED_MARKER } from '../src/transport.js';
import { SandboxExecClient } from '../src/gen/sandbox/v1/sandbox.js';

/**
 * Live counterpart to the hermetic conformance battery. The battery's fakes are
 * self-authored, so their agreement with the contract is not independent evidence —
 * the same misreading can sit on both sides. These cases run the real transport against
 * the real relay and the real Go worker, and cover the three §10 acceptance gates the
 * leaf smoke structurally cannot reach: its request shape is a grep verdict, so it
 * cannot ask for a sleep, a flood, or a mid-exec disconnect.
 *
 * Gated on SH_LIVE_RELAY=1, following the M3_LIVE_SMOKE convention. Setup:
 *
 *   docker run --rm -d -p 6380:6379 --name sh-live-relay-redis redis:7
 *   SH_RELAY_TOKEN=dev-token SH_RELAY_PORT=8443 REDIS_URL=redis://127.0.0.1:6380 \
 *     pnpm --filter @moca/sandbox-relay start &
 *   cd remote-worker && SANDBOX_ID=sbx-dev-1 RELAY_ADDR=localhost:8443 \
 *     SANDBOX_TOKEN=dev-token go run ./cmd/worker &
 *   SH_LIVE_RELAY=1 pnpm --filter @moca/k8s-sandbox test live-relay
 *
 * The first two cases exercise the externally-started worker above. The third
 * (worker-disconnect) spawns and kills its OWN worker process under a distinct
 * sandbox id, so the test is self-contained and repeatable — see makeSelfManagedWorker.
 */
const LIVE = process.env.SH_LIVE_RELAY === '1';
const SANDBOX_ID = process.env.SANDBOX_ID ?? 'sbx-dev-1';
const RELAY_ADDR = process.env.SH_RELAY_ADDR ?? 'localhost:8443';
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN ?? 'dev-token';

/** Same two-line construction as select-sandbox.ts:52's defaultExecClient — one dialing idiom in the repo. */
function makeExecClient(addr: string): ExecClientLike {
  return new SandboxExecClient(addr, credentials.createInsecure()) as unknown as ExecClientLike;
}

function makeLiveTransport(opts: { outputCapBytes?: number } = {}, sandboxId: string = SANDBOX_ID) {
  const client = makeExecClient(RELAY_ADDR);
  return GrpcRelayTransport(sandboxId, client, opts);
}

// ---- self-managed worker for the disconnect case ---------------------------------
//
// go run ./cmd/worker forks the compiled binary as a CHILD of the `go` tool process;
// SIGKILL-ing the `go run` wrapper does not reliably kill that child (SIGKILL can't be
// trapped to forward it, and the binary keeps its own socket open), which would leave
// the worker attached to the relay and the process orphaned after the test. So we
// build a real binary once and spawn THAT directly — SIGKILL on it is unambiguous.
let workerBinDir: string | undefined;
let workerBinPath: string | undefined;

const remoteWorkerDir = fileURLToPath(new URL('../../../remote-worker', import.meta.url));

beforeAll(() => {
  if (!LIVE) return;
  workerBinDir = mkdtempSync(path.join(tmpdir(), 'sh-live-relay-worker-'));
  workerBinPath = path.join(workerBinDir, 'worker');
  execFileSync('go', ['build', '-o', workerBinPath, './cmd/worker'], {
    cwd: remoteWorkerDir,
    stdio: 'pipe',
  });
});

afterAll(() => {
  if (workerBinDir) rmSync(workerBinDir, { recursive: true, force: true });
});

/** Waits for a line matching `pattern` on the child's stdout or stderr (Go's `log` writes to stderr). */
function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (pattern.test(buf)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`worker exited (code=${code}) before matching ${pattern}; output:\n${buf}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}; output so far:\n${buf}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
      child.removeListener('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

/** Spawns the compiled worker binary attached under `sandboxId` and waits for it to attach to the relay. */
async function spawnSelfManagedWorker(sandboxId: string): Promise<ChildProcess> {
  if (!workerBinPath) throw new Error('worker binary not built — beforeAll did not run');
  const child = spawn(workerBinPath, [], {
    env: {
      ...process.env,
      SANDBOX_ID: sandboxId,
      RELAY_ADDR,
      SANDBOX_TOKEN,
    },
  });
  try {
    await waitForLine(child, /attached, serving execs/, 10_000);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  return child;
}

describe.skipIf(!LIVE)('GrpcRelayTransport against a live relay + worker', () => {
  it('enforces the dual-ended timeout against a real long-running command', async () => {
    const t = makeLiveTransport();
    // The worker kills its own child at timeout_s AND the harness has its own deadline;
    // whichever fires, the caller must see timeout:2 rather than hang (spec §8). Asserting
    // elapsed time (not just the rejection) is what catches a timeout that was silently
    // ignored — a `sleep 30` that merely ran to completion would also "reject" eventually
    // via the transport's own 120s default deadline, but it would blow past this bound.
    const started = Date.now();
    try {
      await expect(t.exec('sleep 30', { timeout: 2 })).rejects.toThrow('timeout:2');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await t.close();
    }
  }, 30_000);

  it('truncates a real flood at the cap and marks it', async () => {
    const t = makeLiveTransport({ outputCapBytes: 64 * 1024 });
    // yes | head -c is a genuine multi-chunk flood through real 32 KiB Chunk frames,
    // which is the path the hermetic test's scripted frames only imitate.
    try {
      const r = await t.exec('yes AAAAAAAA | head -c 1000000');
      expect(r.stdout.toString()).toContain(OUTPUT_TRUNCATED_MARKER);
      // Near the 64 KiB cap, not the full ~1MB the command produced.
      expect(r.stdout.length).toBeLessThan(200 * 1024);
    } finally {
      await t.close();
    }
  }, 30_000);

  it('fails an in-flight exec when the worker disconnects, rather than hanging', async () => {
    // relay.ts's Attach teardown pushes {error: "worker disconnected"} into every live
    // sink. That is what lets run-leaf retry onto a healthy sandbox instead of blocking
    // on a dead one (§10: no mid-exec durability).
    //
    // This worker is spawned and killed by the test itself (not the externally-started
    // one the other two cases use) under its own sandbox id, so there is no manual
    // "kill -9 it now" step and the case is safe to re-run.
    const disconnectId = `${SANDBOX_ID}-disconnect`;
    const worker = await spawnSelfManagedWorker(disconnectId);
    try {
      const t = makeLiveTransport({}, disconnectId);
      const p = t.exec('sleep 20');
      // Let the exec actually land: the relay must have parked the sink and written
      // ServerFrame{exec} to the worker before we kill it, or we'd just be testing
      // "Attach never happened," not "Attach was torn down mid-exec".
      await new Promise((r) => setTimeout(r, 1000));
      worker.kill('SIGKILL');
      await expect(p).rejects.toThrow(/worker disconnected|timeout|CANCELLED|UNAVAILABLE/);
      await t.close();
    } finally {
      // Idempotent safety net: a process already dead ignores a second SIGKILL.
      worker.kill('SIGKILL');
    }
  }, 60_000);
});
