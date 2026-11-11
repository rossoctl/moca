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
import type { LeafJobDeps } from '@moca/harness/leaf-job-runner';
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
 * Armed by EVERY worker. Redundant but safe -- XCLAIM-then-XACK is per-entry atomic and
 * `deadLetterTurn`'s finalize compare-and-sets -- and the immediate sweep matters for the same
 * reason armRunReaper's does: a worker restarted seconds after a crash would otherwise find the
 * orphan's heartbeat not yet stale and never look again.
 */
export function armAsyncReaper(opts: {
  queue: Pick<WorkQueue, 'reapDeadLetters' | 'gcIdleConsumers'>;
  consumerId: string;
  deadLetter: (turnId: string) => Promise<void>;
  intervalMs?: number;
  log?: (msg: string) => void;
}): () => void {
  const log = opts.log ?? console.warn;
  const sweep = () =>
    void (async () => {
      const dead = await opts.queue.reapDeadLetters(opts.consumerId, {
        minIdleMs: MIN_IDLE_MS,
        maxAttempts: MAX_ATTEMPTS,
      });
      for (const entry of dead) {
        // An entry whose turnId field is missing or malformed is already acked by the reap; there
        // is no record to finalize, so there is nothing further to do with it.
        if (entry.turnId) await opts.deadLetter(entry.turnId);
      }
      await opts.queue.gcIdleConsumers(CONSUMER_GC_IDLE_MS);
    })().catch((err: unknown) =>
      log(`[async-reaper] sweep failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  sweep();
  const timer = setInterval(sweep, opts.intervalMs ?? ASYNC_REAP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface AsyncLeafWorker {
  /** Stop claiming and release the slot; see leaf-drain-loop's stop() for why it does not wait. */
  stop(): Promise<void>;
  readonly consumerId: string;
}

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
}): AsyncLeafWorker | null {
  const env = opts.env ?? process.env;
  if (!shouldArmAsync(env)) return null;

  // One Redis in M1's two deployments (deploy/vm, deploy/compose): sessions, results and turn
  // records all live in REDIS_URL's keyspace. A deployment that split them would need a second
  // variable; that is M2's.
  const url = env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  // The queue gets its OWN client: claim ends in XREADGROUP BLOCK 5000, and node-redis sends every
  // command for a client over one socket, so a TurnStore write sharing it would wait out the poll.
  const queueClient = asyncRedisClient(url, 'leaf queue');
  const cpClient = asyncRedisClient(url, 'turn records');
  const connected = Promise.all([queueClient.connect(), cpClient.connect()]);

  const queue = reconnecting(
    new RedisWorkQueue(queueClient, LEAF_QUEUE_STREAM, LEAF_QUEUE_GROUP),
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

  const loop = createLeafDrainLoop({ job, counter: opts.counter, cap: asyncLeafCap(env) });
  const stopReaper = armAsyncReaper({ queue, consumerId, deadLetter: job.deadLetter });

  // ensureGroup BEFORE the first claim, and the loop only after it: XREADGROUP against a missing
  // group is an error, not an empty read, so starting the loop first would log NOGROUP until the
  // submitter happened to create it.
  void connected
    .then(() => queue.ensureGroup())
    .then(() => loop.start())
    .catch((err: unknown) => {
      console.error(
        `[async] leaf queue unavailable, not draining: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  return {
    consumerId,
    async stop(): Promise<void> {
      stopReaper();
      await loop.stop();
      // Destroy, not close: close() waits on queued commands, which never drain while a blocking
      // read is outstanding (`control-plane/src/main.ts:478` makes the same choice).
      if (queueClient.isOpen) queueClient.destroy();
      if (cpClient.isOpen) cpClient.destroy();
    },
  };
}
