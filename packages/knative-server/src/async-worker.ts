import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import {
  credentialValue,
  LEAF_QUEUE_GROUP,
  LEAF_QUEUE_STREAM,
  TURN_RECORD_TTL_MARGIN_SECONDS,
  TurnStore,
  type CpRedisLike,
  type TurnState,
} from '@moca/control-plane';
import type { LeafJobDeps, ProcessOutcome } from '@moca/harness/leaf-job-runner';
import { runLeaf, type LeafResult } from '@moca/harness/run-leaf';
import { RedisWorkQueue, type WorkQueue } from '@moca/work-queue';
import { createLeafDrainLoop, asyncLeafCap, shouldArmAsync } from './leaf-drain-loop.js';
import { getResultStore, RESULT_TTL_SECONDS } from './server.js';
import { claimTurn, deadLetterTurn } from './turn-claim.js';
import type { SlotCounter } from './leaf-drain-loop.js';

/** §6.2's fixed constants. Injectable for tests; none of them is an operator knob. */
const MIN_IDLE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const CONSUMER_GC_IDLE_MS = 300_000;
export const ASYNC_REAP_INTERVAL_MS = 60_000;

/**
 * This worker's consumer identity (§6.2). HOSTNAME is set in a container and often unset under
 * systemd, so fall back to the supervisor's pid: stable for the whole worker set, and different
 * between two sets on one host. SH_WORKER_ID (injected at `supervisor/src/main.ts:60`) falls back to
 * 0 rather than to empty, because two consumers sharing a name would each reset the other's idle
 * clock through `touch` and a dead one's entry would never look reclaimable.
 *
 * shortcut: the ppid fallback can collide across two different HOSTS that share one Redis and
 * happen to allocate the same pid (e.g. both supervisors land on PID 1 under systemd), which would
 * make two real workers steal each other's pending entries. Bounded today because the fallback
 * only applies when HOSTNAME is absent, and neither of M1's deployments (deploy/vm is single-VM;
 * containers always set HOSTNAME) reaches it with more than one host. Upgrade to `os.hostname()`
 * ahead of the ppid tier if a multi-host systemd fleet ever shares one Redis.
 */
export function asyncConsumerId(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const host = env.HOSTNAME || String(process.ppid);
  const id = env.SH_WORKER_ID || '0';
  return `moca-${host}-w${id}`;
}

/**
 * The leaf's status as a turn state. Five of the six names are shared deliberately. `aborted` is
 * not a turn state: an aborted leaf stopped because something asked it to, which is `cancelled`.
 * `lost` is reserved for a turn that was delivered and never reported -- this one reported.
 *
 * A `switch` with a `never` default rather than `as TurnState`: a cast between two overlapping
 * string-literal unions compiles regardless of a status neither side recognises, which is exactly
 * how a 7th `LeafResult['status']` would silently become `TurnStore.get`'s coerced-back-to-`queued`
 * fallback for a turn that actually finished. This makes that addition a compile error instead.
 */
export function asyncFinalizeState(status: LeafResult['status']): TurnState {
  switch (status) {
    case 'aborted':
      return 'cancelled';
    case 'done':
    case 'failed':
    case 'paused':
    case 'solved':
    case 'responded':
      return status;
    default: {
      const _exhaustive: never = status;
      throw new Error(`asyncFinalizeState: unhandled leaf status ${String(_exhaustive)}`);
    }
  }
}

/**
 * Periodic dead-letter reap plus idle-consumer GC, after `armRunReaper`'s shape
 * (`server.ts:183-194`): sweep once now, then on an interval, with the timer unref'd so this is
 * never the reason a worker refuses to exit.
 *
 * Armed by EVERY worker. Redundant but safe -- the reap's XCLAIM hands one entry to one consumer
 * and `deadLetterTurn`'s finalize compare-and-sets -- and the immediate sweep matters for the same
 * reason armRunReaper's does: a worker restarted seconds after a crash would otherwise find the
 * orphan's heartbeat not yet stale and never look again.
 */
export function armAsyncReaper(opts: {
  queue: Pick<WorkQueue, 'reapDeadLetters' | 'gcIdleConsumers' | 'ack'>;
  consumerId: string;
  deadLetter: (turnId: string) => Promise<void>;
  /**
   * One entry this sweep DID dead-letter: the terminal write landed and the entry is acked. Called
   * from here rather than wrapped around `deadLetter` so that it fires after the work, not before
   * it -- a count taken first turns a Redis outage into a rising `async_dead_letters` with no turn
   * finalized anywhere -- and so that an entry with no turn id, which has no record to write and is
   * only acked, is counted the same way `processOne` counts its own (`dead_lettered`, turnId '').
   */
  onReaped?: () => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}): () => void {
  const log = opts.log ?? console.warn;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const sweep = () =>
    void (async () => {
      try {
        const dead = await opts.queue.reapDeadLetters(opts.consumerId, {
          minIdleMs: MIN_IDLE_MS,
          maxAttempts: MAX_ATTEMPTS,
        });
        for (const entry of dead) {
          // PER ENTRY, so one unwritable record does not strand the rest of the batch unacked --
          // every entry after it would keep its stale PEL slot and be re-reaped on the next sweep,
          // turning one bad turn into a permanently stalled reap.
          try {
            // Ack AFTER the write, the order `leaf-job-runner.ts:139` uses for its own branch: an
            // ack removes the entry from the PEL for good, so acking first would turn a failed
            // `deadLetterTurn` into a turn stuck `running` that nothing can ever redeliver. An
            // entry whose turnId field is missing or malformed has no record to finalize, so it is
            // only acked.
            if (entry.turnId) await opts.deadLetter(entry.turnId);
            await opts.queue.ack(entry.entryId);
            opts.onReaped?.();
          } catch (err) {
            // Left pending on purpose: XCLAIM reset its idle timer, so the next sweep after
            // minIdleMs retries it, and `deadLetterTurn`'s terminal guard makes a repeat harmless.
            log(
              `[async-reaper] entry ${entry.entryId} (turn ${entry.turnId || 'none'}) not dead-lettered: ${why(err)}`,
            );
          }
        }
      } catch (err) {
        log(`[async-reaper] reap failed: ${why(err)}`);
      }
      // Attempted even when the reap above failed outright: the two halves of a sweep are
      // independent, and consumer names accumulate once per worker restart whether or not any
      // entry is reapable.
      try {
        await opts.queue.gcIdleConsumers(CONSUMER_GC_IDLE_MS);
      } catch (err) {
        log(`[async-reaper] consumer gc failed: ${why(err)}`);
      }
    })().catch((err: unknown) => log(`[async-reaper] sweep failed: ${why(err)}`));
  sweep();
  const timer = setInterval(sweep, opts.intervalMs ?? ASYNC_REAP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface AsyncLeafWorker {
  /** Stop claiming and release the slot; see leaf-drain-loop's stop() for why it does not wait. */
  stop(): Promise<void>;
  readonly consumerId: string;
  stats(): AsyncWorkerStats;
}

/** What one worker contributes to §7's async metrics. Camel on the IPC row, snake at the port. */
export interface AsyncWorkerStats {
  asyncClaims: number;
  asyncReclaims: number;
  asyncDeadLetters: number;
  asyncClaimDeniedFull: number;
  /** Slot 0 only (§9.2): properties of Redis, wanted once per deployment, not once per worker. */
  asyncQueueDepth?: number;
  asyncOldestAgeMs?: number;
}

export interface AsyncTally {
  onOutcome(outcome: ProcessOutcome): void;
  onCapDenied(): void;
  /** One entry the PERIODIC reaper dead-lettered. The loop's own branch arrives via onOutcome. */
  onReaped(): void;
  snapshot(): Omit<AsyncWorkerStats, 'asyncQueueDepth' | 'asyncOldestAgeMs'>;
}

/**
 * §7's four worker-side counts. Cumulative per process: the supervisor sums across slots and a
 * restart resets this worker's contribution, which is visible in the same body as `restarts`.
 */
export function createAsyncTally(): AsyncTally {
  const t = { asyncClaims: 0, asyncReclaims: 0, asyncDeadLetters: 0, asyncClaimDeniedFull: 0 };
  return {
    onOutcome(outcome: ProcessOutcome): void {
      if (outcome.kind === 'idle') return; // an empty poll is not throughput
      t.asyncClaims += 1;
      if (outcome.reclaimed) t.asyncReclaims += 1;
      if (outcome.kind === 'dead_lettered') t.asyncDeadLetters += 1;
    },
    onCapDenied(): void {
      t.asyncClaimDeniedFull += 1;
    },
    onReaped(): void {
      t.asyncDeadLetters += 1;
    },
    snapshot: () => ({ ...t }),
  };
}

/**
 * How often slot 0 re-reads the queue's depth and oldest age. On its own timer rather than inside
 * the stats interval, which defaults to 1000 ms: `depth()` is two Redis round trips and the stats
 * callback is synchronous, so it could not await one anyway. Ten seconds of staleness on a gauge
 * nothing routes on costs nothing.
 */
export const ASYNC_DEPTH_INTERVAL_MS = 10_000;

/**
 * A client with the listener-plus-bounded-reconnect pair, via the canonical helpers rather than a
 * local copy -- `resilientClientOptions`/`swallowRedisErrors` (`@moca/session-backend`) are the
 * measured numbers this file's header cites, and copying them is how an omitted third part (the
 * `!isOpen` re-arm below) goes unnoticed.
 */
function asyncRedisClient(url: string, label: string): RedisClientType {
  const client = createClient(resilientClientOptions(url)) as RedisClientType;
  swallowRedisErrors(client, label);
  return client;
}

/**
 * `RedisWorkQueue` and `TurnStore` are handed an ALREADY-CONNECTED client at construction and call
 * it directly; neither owns a lazy `open()` the way `RedisResultStore` does (`leaf-result-store.ts`'s
 * `open()`/`arm()`), because Task 1 moved to an injected client precisely so this pairing would live
 * at the construction site instead. So the `!isOpen` re-arm `resilientClientOptions`'s own doc
 * comment requires (`redis-errors.ts`: "a client built with these options must also re-arm on
 * `!client.isOpen`") has to live here too: past the bounded reconnect's give-up, node-redis leaves
 * `isOpen` false for the rest of the process and rejects every later command `ClientClosedError`,
 * so without this a single ~5.5 s Redis blip would stop this worker draining for its whole life
 * while it kept serving sync traffic none the wiser.
 *
 * A Proxy rather than a per-class wrapper: `RedisWorkQueue` and `TurnStore` share nothing but "every
 * method calls through to one injected client", so one generic wrapper covers both instead of two
 * hand-written ones.
 *
 * shortcut: this wraps every function property as async and types the result `T`, which is sound
 * only because every CURRENT public method on `RedisWorkQueue` and `TurnStore` already returns a
 * Promise (checked both classes; their sync private helpers are reached via `.apply(obj, args)` on
 * the raw object, so they never go through this trap). A synchronous public method added to either
 * class later would silently receive a Promise typed as its plain return value here, with no
 * compile error -- the same unsound-cast shape `asyncFinalizeState`'s old `as TurnState` had.
 * Upgrade to a per-class wrapper (or a compile-time check that every property is already async) if
 * either class ever grows a synchronous public method.
 */
export function reconnecting<T extends object>(target: T, client: RedisClientType): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (!client.isOpen) await client.connect().catch(() => undefined);
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  }) as T;
}

/**
 * Arm the async leaf drain on this worker, or return null when the deployment has not asked for it
 * (`shouldArmAsync`). Everything it builds is per-process and torn down by `stop`.
 */
export function armAsyncLeafWorker(opts: {
  counter: SlotCounter;
  env?: NodeJS.ProcessEnv;
  /**
   * The stream name, defaulting to LEAF_QUEUE_STREAM. Overridable for the same reason
   * `turn-queue.ts`'s `RedisTurnQueue` makes its stream a parameter: a test run against real Redis
   * needs its own stream so it cannot delete production's.
   */
  stream?: string;
}): AsyncLeafWorker | null {
  const env = opts.env ?? process.env;
  if (!shouldArmAsync(env)) return null;

  // One Redis in M1's two deployments (deploy/vm, deploy/compose): sessions, results and turn
  // records all live in REDIS_URL's keyspace. A deployment that split them would need a second
  // variable; that is M2's.
  const url = env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  // The queue gets its OWN client. node-redis sends every command for a client over one socket, and
  // the drain's claim is a burst of stream commands (XAUTOCLAIM, XREADGROUP, XPENDING) issued on a
  // loop; keeping the turn-record writes off that socket means a claim in flight never delays a
  // finalize, and either client can reconnect without stalling the other. (`reconnecting` below
  // wraps each with its own retry, which only works because the two are separate.)
  const queueClient = asyncRedisClient(url, 'leaf queue');
  const cpClient = asyncRedisClient(url, 'turn records');
  const connected = Promise.all([queueClient.connect(), cpClient.connect()]);

  const queue = reconnecting(
    new RedisWorkQueue(queueClient, opts.stream ?? LEAF_QUEUE_STREAM, LEAF_QUEUE_GROUP),
    queueClient,
  );
  const turns = reconnecting(
    new TurnStore(cpClient as unknown as CpRedisLike, {
      // The control plane's own numbers (`main.ts:483-486`): a record finalized here must expire when
      // one finalized there would.
      resultTtlSeconds: RESULT_TTL_SECONDS,
      ttlMarginSeconds: TURN_RECORD_TTL_MARGIN_SECONDS,
    }),
    cpClient,
  );
  const consumerId = asyncConsumerId(env);
  // Both non-empty: shouldArmAsync returned true, which is exactly the check that they are. The
  // token goes through credentialValue for the same reason it does there -- on deploy/vm it is a
  // systemd credential file, not an env line (turn-auth.ts:111 resolves it identically).
  const controlPlaneUrl = String(env.SH_CONTROL_PLANE_URL);
  const exchangeToken = String(credentialValue(env, 'SH_EXCHANGE_TOKEN'));
  const resultStore = getResultStore();

  const job: LeafJobDeps = {
    queue,
    consumerId,
    claimTurn: (turnId, deliveryCount) =>
      claimTurn(turnId, deliveryCount, { controlPlaneUrl, exchangeToken, turns }),
    // The same runLeaf the sync route calls (`server.ts:1105`), with the same signature.
    runLeaf: (envelope, config) => runLeaf(envelope, config),
    finalize: async (turnId, status) => {
      await turns.finalize(turnId, asyncFinalizeState(status), Date.now());
    },
    deadLetter: (turnId) =>
      deadLetterTurn(turnId, { turns, resultStore, ttlSeconds: RESULT_TTL_SECONDS }),
    resultStore,
    ttlSeconds: RESULT_TTL_SECONDS,
    minIdleMs: MIN_IDLE_MS,
    maxAttempts: MAX_ATTEMPTS,
  };

  const tally = createAsyncTally();
  // One depth() call for both gauges: fetched separately they would describe two different
  // instants, and the pair is the point -- depth alone cannot tell a deep fast queue from a
  // stalled shallow one (§7).
  let gauges: { depth: number; oldestAgeMs: number } | undefined;
  const isSlotZero = (env.SH_WORKER_ID || '0') === '0';
  const pollDepth = () =>
    void queue
      .depth()
      .then((d) => {
        gauges = d;
      })
      .catch(() => {
        // Leave the last reading in place rather than blanking it: a single failed poll is not
        // evidence the queue drained.
      });
  let depthTimer: ReturnType<typeof setInterval> | undefined;
  if (isSlotZero) {
    depthTimer = setInterval(pollDepth, ASYNC_DEPTH_INTERVAL_MS);
    depthTimer.unref();
  }

  const loop = createLeafDrainLoop({
    job,
    counter: opts.counter,
    cap: asyncLeafCap(env),
    onOutcome: tally.onOutcome,
    onCapDenied: tally.onCapDenied,
  });
  const stopReaper = armAsyncReaper({
    queue,
    consumerId,
    deadLetter: job.deadLetter,
    onReaped: tally.onReaped,
  });

  // ensureGroup BEFORE the first claim, and the loop only after it: XREADGROUP against a missing
  // group is an error, not an empty read, so starting the loop first would log NOGROUP until the
  // submitter happened to create it.
  void connected
    .then(() => queue.ensureGroup())
    .then(() => {
      if (isSlotZero) pollDepth(); // the first reading, so it does not wait ten seconds
      loop.start();
    })
    .catch((err: unknown) => {
      console.error(
        `[async] leaf queue unavailable, not draining: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  return {
    consumerId,
    stats(): AsyncWorkerStats {
      return {
        ...tally.snapshot(),
        ...(gauges ? { asyncQueueDepth: gauges.depth, asyncOldestAgeMs: gauges.oldestAgeMs } : {}),
      };
    },
    async stop(): Promise<void> {
      if (depthTimer) clearInterval(depthTimer);
      stopReaper();
      await loop.stop();
      // Destroy, not close: close() waits on queued commands, which never drain while a blocking
      // read is outstanding (`control-plane/src/main.ts:478` makes the same choice).
      if (queueClient.isOpen) queueClient.destroy();
      if (cpClient.isOpen) cpClient.destroy();
    },
  };
}
