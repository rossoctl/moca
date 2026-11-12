import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createClient } from 'redis';
import { RedisWorkQueue } from '@moca/work-queue';
// All four from @moca/control-plane, which is where the queue NAMES live too (turn-queue.ts:10-11):
// they are exported "because a mismatch between submitter and consumer is a submission that
// enqueues successfully and is never drained -- silent, not loud."
import {
  LEAF_QUEUE_GROUP,
  LEAF_QUEUE_STREAM,
  RedisTurnQueue,
  TurnStore,
  turnKey,
  type CpRedisLike,
} from '@moca/control-plane';
import { resultKey } from '@moca/harness/leaf-result-store';
import { readConfig } from '../src/config.js';
import { startSupervisor, DEFAULT_WORKER_ENTRY, type Supervisor } from '../src/main.js';

/**
 * The only test that forks the REAL worker at `DEFAULT_WORKER_ENTRY`. Every other integration
 * test substitutes a hand-written `.mjs` fixture, which papers over precisely the things this
 * file exercises: forking a cross-package `.ts` file through inherited `--import tsx` execArgv,
 * `worker.ts`'s `pathToFileURL` main-module guard, its `process.send` presence check, and
 * `handler`'s import graph resolving from a foreign package root.
 *
 * It is also what makes the recorded justification for duplicating `WorkerToSupervisor` across
 * `supervisor/src/pool.ts` and `knative-server/src/worker.ts` true rather than aspirational:
 * the two copies must agree on the wire or these tests fail.
 *
 * It also depends on vitest's default per-file process isolation (`pool: 'forks'`,
 * `isolate: true` -- neither this package's `vitest.config.ts` nor any workspace-root
 * config overrides either, so both are vitest 2.x's defaults, not a setting pinned here).
 * `withRealWorker` below mutates `process.execArgv` directly on the running process rather
 * than threading a test-only option through `startSupervisor`; that mutation is safe only
 * because vitest gives each test file its own process. A future move to `pool: 'threads'`
 * (or an explicit `isolate: false`) would let this file's `process.execArgv` mutation leak
 * into whichever sibling test file happens to share its worker thread -- silently, and the
 * failure would surface in that other file's `fork()` calls, not in this one.
 */

/**
 * Production runs `node --import tsx src/main.ts` and `fork()` inherits execArgv, which is how
 * a TypeScript worker starts with no second loader flag. Under vitest the parent's execArgv is
 * `['--conditions', 'development', ...]` with no loader, and a bare `node worker.ts` dies with
 * `ERR_INVALID_TYPESCRIPT_SYNTAX` on `TurnCounter`'s parameter property (Node's strip-only mode
 * cannot compile it). Setting execArgv here exercises the real inheritance path rather than
 * adding a test-only option to `startSupervisor`.
 */
async function withRealWorker(
  config: Record<string, string>,
  /**
   * Variables the WORKER reads. `main.ts` forks with `{ ...process.env }`, so `readConfig`'s
   * argument below reaches the supervisor only -- anything the worker itself reads has to be on
   * `process.env`.
   */
  workerEnv: Record<string, string> = {},
  /** Captures the pool's log lines; the boot-failure test reads `worker_exit` out of them. */
  log: (line: Record<string, unknown>) => void = () => {},
): Promise<{ sup: Supervisor; restore: () => void }> {
  const savedArgv = process.execArgv;
  const savedEnv = Object.keys(workerEnv).map((k) => [k, process.env[k]] as const);
  process.execArgv = ['--import', 'tsx'];
  for (const [k, v] of Object.entries(workerEnv)) process.env[k] = v;
  // Restored in afterEach rather than here: a worker restart mid-test forks again and must
  // inherit the loader too.
  const restore = (): void => {
    process.execArgv = savedArgv;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        ...config,
      } as NodeJS.ProcessEnv),
      // workerEntry deliberately OMITTED: this is the point of the file.
      log,
    });
    return { sup, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

/** Waits for the single worker to report `ready`. */
async function waitReady(sup: Supervisor): Promise<void> {
  await vi.waitFor(() => expect(sup.pool.views().filter((v) => v.healthy)).toHaveLength(1), {
    timeout: 30_000,
  });
}

/** One request on its own connection, read to completion. */
async function speak(port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  const chunks: Buffer[] = [];
  socket.on('data', (c: Buffer) => chunks.push(c));
  await once(socket, 'end');
  socket.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

const HEALTH = 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';

let sup: Supervisor | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  await sup?.close();
  sup = undefined;
  restore?.();
  restore = undefined;
});

describe('the real worker, forked from DEFAULT_WORKER_ENTRY', () => {
  it('is the default entry, and forking it brings a worker up over IPC', async () => {
    // `DEFAULT_WORKER_ENTRY` had ZERO test references, so the highest-risk integration in the
    // slice ran only on a real VM.
    expect(DEFAULT_WORKER_ENTRY).toMatch(/knative-server[/\\]src[/\\]worker\.ts$/);

    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '8' }));
    await waitReady(sup!);

    // `ready` arriving at all is the conjunction of four things the fixtures never test:
    // execArgv inheritance loaded the TypeScript loader; `pathToFileURL(process.argv[1]).href`
    // matched `import.meta.url`, so the main-module block ran at all; `--role=turn` parsed
    // (any other role exits 2); and `process.send` was present (its absence exits 2). It also
    // means `handler`'s whole import graph resolved from a foreign package root.
    const [w] = sup!.pool.telemetry();
    expect(w!.pid).toBeGreaterThan(0);
    expect(w!.pid).not.toBe(process.pid);
  }, 60_000);

  it('serves a non-turn request through a handed-off socket', async () => {
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '8' }));
    await waitReady(sup!);
    // `GET /health` is the furthest a test can drive the real handler with no infrastructure:
    // it answers from `server.ts` directly, touching neither Redis nor a sandbox nor a model.
    // A real `POST /turn` would need Redis, a sandbox and a model endpoint, so it stays a live
    // smoke concern -- see the report for exactly what this does and does not protect.
    expect(await speak(sup!.port, HEALTH)).toContain('200 OK');
  }, 60_000);

  it('agrees with the supervisor on all four IPC rows', async () => {
    // `WorkerToSupervisor` is duplicated verbatim in `supervisor/src/pool.ts` and
    // `knative-server/src/worker.ts`, deliberately (spec §9). The recorded justification says
    // drift "fails a test rather than rotting" -- which only became true once something forked
    // a real worker. This is that test: every row crosses the boundary here.
    ({ sup, restore } = await withRealWorker(
      { SH_TURNS_PER_WORKER: '8' },
      { SH_STATS_INTERVAL_MS: '50' },
    ));

    // 'ready'
    await waitReady(sup!);

    // 'stats' -- the advisory fourth row: recorded for /metrics, never routed on.
    await vi.waitFor(() => expect(Number.isFinite(sup!.pool.telemetry()[0]!.rssBytes)).toBe(true), {
      timeout: 15_000,
    });
    // ...and `views()` is still exactly §3.9's three fields, whatever telemetry arrived.
    expect(sup!.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });

    // 'load' -- from the served connection's close report.
    expect(await speak(sup!.port, HEALTH)).toContain('200 OK');
    await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0));

    // 'draining' -- the supervisor sends `drain`, the real worker answers `draining`, and the
    // pool stops routing to it without killing it.
    sup!.pool.drainAll();
    await vi.waitFor(() => expect(sup!.pool.views()[0]!.healthy).toBe(false), { timeout: 15_000 });
  }, 60_000);

  it('refuses to boot on a malformed keyset instead of 503ing every turn', async () => {
    // #249's regression, reopened by this deployment shape. `startServer` calls
    // `assertKeysetUsable(process.env)` "before anything binds" (server.ts:657), and this path
    // deliberately never goes through `startServer` -- it builds a bare `createServer(handler)` and
    // never listens. So a malformed SH_SESSION_TOKEN_PUBLIC_KEYS stopped being a boot failure: every
    // worker reported `ready`, served `GET /health`, and 503'd every authenticated `/turn`. The
    // "healthy-looking deployment, per-request failure" shape #249 closed, on the one runtime whose
    // workers bypass the boot check.
    //
    // Driven against the REAL worker because the boot block only runs under the main-module guard;
    // no `.mjs` fixture has one.
    const logs: Array<Record<string, unknown>> = [];
    ({ sup, restore } = await withRealWorker(
      { SH_TURNS_PER_WORKER: '8' },
      { SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' },
      (line) => logs.push(line),
    ));

    // exit 2, the boot-failure code this block already uses for SH_SANDBOX_DISCOVERY -- so systemd
    // sees a crashloop with the reason in the journal, via the pool's restart backoff.
    await vi.waitFor(
      () =>
        expect(logs.filter((l) => l.event === 'worker_exit' && l.code === 2)).not.toHaveLength(0),
      { timeout: 30_000 },
    );
    // And it must never have looked healthy on the way down.
    expect(sup!.pool.views().filter((v) => v.healthy)).toHaveLength(0);
  }, 60_000);

  it('does not wedge into permanent 429s after non-turn connections at S=1', async () => {
    // THE regression pin for the monotonic-estimate defect. `handOff` credits +1 per admitted
    // CONNECTION while the worker reports `load` only from its TURN counter, and a non-turn
    // request never touches that counter. So each `GET /health` used to raise the estimate by
    // one permanently: at S=1 the second connection was refused before hand-off, so no turn
    // could ever arrive to reconcile, and the pool stayed wedged in 429s until a worker
    // crashed. `setup-vm.sh`'s own closing health check burned one unit per invocation.
    //
    // Driven against the REAL worker on purpose: the `.mjs` fixtures re-implement the IPC
    // contract by hand and papered this over.
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '1' }));
    await waitReady(sup!);

    for (let i = 1; i <= 4; i += 1) {
      expect(await speak(sup!.port, HEALTH), `connection ${i}`).toContain('200 OK');
      // The estimate must come back down, or connection i+1 is refused before hand-off.
      await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0), { timeout: 5000 });
    }
  }, 60_000);

  it('does not wedge on a connection that is HELD open and never runs a turn', async () => {
    // The close-only report closed the wedge for a connection that ENDS. This is the case it did
    // not close: a socket handed off, issuing no turn, and kept ALIVE. Nothing then lowers the
    // supervisor's optimistic +1 -- pool.ts only lowers on a `load` or on worker exit -- so at S=1
    // one held connection saturates the only slot, every later connection is refused BEFORE
    // hand-off, no turn can arrive, no `load` can arrive, and the pool stays in 429s until a worker
    // crashes. A load balancer or monitoring probe on a persistent connection does this by accident.
    //
    // It is invisible in /metrics while it happens: `spurious_refusals` can only rise on a `load`
    // reporting lower than the refusal estimate, and the wedge is precisely the state where no
    // `load` arrives.
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '1' }));
    await waitReady(sup!);

    // Keep-alive, and deliberately NOT read to completion: the socket stays open with no turn on it.
    const held = connect(sup!.port, '127.0.0.1');
    await once(held, 'connect');
    held.write('GET /health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await once(held, 'data'); // the response arrived, so the hand-off completed
    try {
      // The reconciliation must have happened on ACCEPT; there is no close to trigger it.
      await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0), { timeout: 5000 });
      // And the slot must still be usable, which is the property an operator actually notices.
      expect(await speak(sup!.port, HEALTH), 'second connection while the first is held').toContain(
        '200 OK',
      );
    } finally {
      held.destroy();
    }
  }, 60_000);
});

/**
 * §9.2: "the live crash test proves the one thing injected timings cannot: that the supervisor
 * restarts a worker whose leaf was mid-flight and the leaf completes once."
 *
 * Gated, following live-relay.test.ts's convention. It needs a real Redis, a reachable control
 * plane that will mint for SH_EXCHANGE_TOKEN, a real model credential for the leaf, and it waits
 * out the PRODUCTION minIdleMs of 90 s -- so it can never gate CI. Run it by hand whenever the
 * drain changes:
 *
 *   SH_ASYNC_LIVE_CRASH=1 REDIS_URL=redis://... SH_CONTROL_PLANE_URL=http://... \
 *   SH_EXCHANGE_TOKEN=... ANTHROPIC_API_KEY=... \
 *     packages/supervisor/node_modules/.bin/vitest run test/real-worker.integration.test.ts
 *
 * The turn is seeded straight into Redis rather than submitted over the control plane's public
 * API: from the worker's side the two are identical (a record plus a queue entry), and seeding
 * keeps the env surface to the four variables above instead of also needing an API key.
 */
const liveCrash = process.env.SH_ASYNC_LIVE_CRASH === '1';

describe.skipIf(!liveCrash)('async crash recovery, live (SH_ASYNC_LIVE_CRASH=1)', () => {
  it('restarts a worker killed mid-leaf, and the leaf completes exactly once', async () => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    const client = createClient({ url: redisUrl });
    await client.connect();
    const turns = new TurnStore(client as unknown as CpRedisLike, {
      resultTtlSeconds: 3600,
      ttlMarginSeconds: 60,
    });
    // The queue is read-only here: `WorkQueue` has no `enqueue` on purpose (turn-queue.ts:17-21),
    // so the submission goes through the real submitter, exactly as the control plane does it.
    const queue = new RedisWorkQueue(client as never, LEAF_QUEUE_STREAM, LEAF_QUEUE_GROUP);
    await queue.ensureGroup();
    const submitter = new RedisTurnQueue(client as unknown as CpRedisLike, LEAF_QUEUE_STREAM);

    const turnId = `t-live-${Date.now()}`;
    const sessionId = `sid-live-${Date.now()}`;
    try {
      // One worker, not two: with SH_WORKERS=2 the test cannot know WHICH slot claimed, and
      // killing the wrong pid proves nothing. One slot makes the claimant unambiguous.
      ({ sup, restore } = await withRealWorker(
        { SH_WORKERS: '1', SH_TURNS_PER_WORKER: '1' },
        {
          SH_ASYNC_DRAIN: '1',
          REDIS_URL: redisUrl,
          SH_STATS_INTERVAL_MS: '200',
        },
      ));
      await waitReady(sup!);
      const firstPid = sup!.pool.telemetry()[0]!.pid;

      // The same twelve-field record `submitTurn` writes (turn-record.ts:33-57). `credentialName`,
      // never a credential VALUE: the record and every audit entry carry the NAME (§5.1, §7.2).
      await turns.create({
        turnId,
        owner: 'live-crash',
        tenant: 'default',
        sessionId,
        cfg: '',
        credentialName: process.env.SH_LIVE_CREDENTIAL_NAME ?? 'default',
        caps: {},
        idempotencyKey: sessionId,
        envelope: { sessionId, kind: 'prompt', prompt: 'say the single word: ok' },
        state: 'queued',
        attempts: 0,
        createdAt: Date.now(),
      });
      await submitter.enqueue(turnId);

      // `running` means both halves happened: the loop claimed the entry AND the control plane
      // minted for it. Killing before that would test the queue, not the crash path.
      await vi.waitFor(async () => expect((await turns.get(turnId))?.state).toBe('running'), {
        timeout: 60_000,
        interval: 500,
      });

      // SIGKILL, not SIGTERM: §6.3's graceful drain is covered with injected timings in
      // async-drain.integration.test.ts. This is the path where NO cleanup runs at all -- no
      // ack, no record update, no XGROUP DELCONSUMER, nothing.
      process.kill(firstPid!, 'SIGKILL');

      // The supervisor's own job: fork a replacement. A new pid in the same slot is the proof.
      await vi.waitFor(
        () => {
          const pid = sup!.pool.telemetry()[0]!.pid;
          expect(pid).toBeGreaterThan(0);
          expect(pid).not.toBe(firstPid);
        },
        { timeout: 60_000, interval: 500 },
      );
      await waitReady(sup!);

      // Then the wait this test exists for: the entry is pending and unacked, and nothing can
      // happen until the PRODUCTION minIdleMs of 90 s elapses. No injected timing shortens it.
      await vi.waitFor(async () => expect((await turns.get(turnId))?.state).toBe('done'), {
        timeout: 300_000,
        interval: 2_000,
      });

      // "Exactly once", which is the whole assertion. A redelivery that ran the leaf TWICE also
      // ends with the record `done`: that test would pass while the owner was billed twice and
      // the session mutated twice. The counts are per-process and the first process's died with
      // it, so the replacement must show precisely one claim, and it must be a reclaim.
      //
      // Read from aggregates(), not telemetry(): asyncClaims/asyncReclaims/asyncDeadLetters are
      // summed pool-wide (pool.ts's own doc on aggregates()), not carried on the per-worker
      // WorkerTelemetry row. With SH_WORKERS=1 the sum is this one worker's count.
      const agg = sup!.pool.aggregates();
      expect(agg.asyncClaims).toBe(1);
      expect(agg.asyncReclaims).toBe(1);
      expect(agg.asyncDeadLetters).toBe(0);
      expect(await queue.pending()).toBe(0); // acked, so no third delivery is coming
      // Under the RECORD's session id AND this turn's id -- Task 4's fix for the leafResultKey
      // divergence, plus the per-turn key §4.3 needs. On a live rig this is also the assertion that
      // a poller would have been able to read.
      expect(JSON.parse((await client.get(resultKey(sessionId, turnId)))!)).toMatchObject({
        sessionId,
      });
    } finally {
      // No `queue.close()`: RedisWorkQueue takes an injected client and has none (Task 1). The
      // opener closes, which is this block.
      await client.del([turnKey(turnId), resultKey(sessionId, turnId)]).catch(() => {});
      if (client.isOpen) await client.close();
    }
  }, 420_000);
});
