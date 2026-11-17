import { createClient, ErrorReply } from 'redis';

/**
 * The Redis schema version (change policy decision 6, #509): one key that says which layout of
 * stored data this keyspace holds, so the first change that needs one can tell old data from new.
 *
 * Until now nothing said, and new fields leaned on tolerant reads alone. That is enough for the
 * additive changes the policy allows (new keys, new fields older code ignores), and it is why
 * `SCHEMA_VERSION` is still 1: nothing written so far needs a newer reader. What it cannot do is
 * protect a deployment from the other direction -- a release rolled back, or pointed at a Redis
 * restored from a newer one, reading keys whose layout it does not know and acting on a misreading.
 * The key exists BEFORE the first such change on purpose: a version added together with the change
 * that needs it would be absent on every deployment that the older code is rolled back onto.
 *
 * The rules, and the one choice the policy leaves open:
 *
 *  - **Absent**: written with this code's version (`SET NX`, so concurrent first starts agree).
 *    Every component that runs the check may be the one to write it; none has to start first.
 *    Absent means version 1 whether the Redis is fresh or holds `sh:` data from before this key
 *    existed: every release before it wrote version-1 data. The key carries no TTL, so it relies
 *    on a `noeviction` or `volatile-*` policy; after a FLUSHALL or a restore that lost it, the next
 *    start stamps its own version, so re-stamp it by hand when that is not the data's version.
 *  - **Read first, written only when absent**: a GET answers the check on a Redis that refuses
 *    writes (full under `noeviction`, a read-only replica, an ACL without SET), so the stamp
 *    already there is still checked. A refused write on an ABSENT key leaves the version unknown;
 *    the guard says so once and keeps trying, without exiting.
 *  - **Equal**: nothing to do.
 *  - **Newer** than this code knows, or not a version at all: refused. The process must not run
 *    against data whose layout it cannot know (`SchemaVersionError`, and the guard below exits).
 *  - **Older**: accepted and LEFT AS IT IS. The policy requires a release to read what the
 *    previous one wrote, so an older stamp is data this code is required to read. Whether a newer
 *    release should then RAISE the stamp -- and so lock the older release out -- is a decision for
 *    the change that first bumps `SCHEMA_VERSION`, because only that change knows whether the
 *    previous release can still read what it writes (if it can, raising the stamp would break a
 *    rollback for nothing). That change edits `checkSchemaVersion`'s older branch, nothing else.
 */
export const SCHEMA_VERSION_KEY = 'sh:schema-version';

/**
 * The schema version this code writes and understands. Bump only with a change the previous
 * release cannot read.
 */
export const SCHEMA_VERSION = 1;

/** The slice of a node-redis client the check needs, so tests inject an in-memory fake. */
export interface SchemaVersionRedisLike {
  get(key: string): Promise<string | null>;
  /** node-redis returns 1 when it set the key and 0 when the key was already there. */
  setNX(key: string, value: string): Promise<number | boolean>;
}

export type SchemaVersionOutcome = 'written' | 'current' | 'older';

export interface SchemaVersionResult {
  outcome: SchemaVersionOutcome;
  /** The version stored now (after the write, for `written`). */
  stored: number;
  /** The version this code knows. */
  known: number;
}

/** A stored schema version this code must not run against: newer than it knows, or malformed. */
export class SchemaVersionError extends Error {
  constructor(
    readonly stored: string,
    readonly known: number,
  ) {
    super(
      /^[1-9]\d*$/.test(stored)
        ? `Redis holds schema version ${stored} (${SCHEMA_VERSION_KEY}), newer than the ${known} this release knows; ` +
            'run a release that knows it (a rollback past a schema change is not supported)'
        : `Redis key ${SCHEMA_VERSION_KEY} holds ${JSON.stringify(stored.slice(0, 32))}, which is not a schema version; ` +
            `this release knows version ${known}`,
    );
    this.name = 'SchemaVersionError';
  }
}

/**
 * Classify what is stored, writing the version only when the key is absent. Throws
 * `SchemaVersionError` for a newer or malformed version; any other throw is Redis itself -- an
 * error reply (`ErrorReply`: a refused write, a missing ACL permission) or a lost connection --
 * which the caller retries.
 */
export async function checkSchemaVersion(
  redis: SchemaVersionRedisLike,
  known: number = SCHEMA_VERSION,
): Promise<SchemaVersionResult> {
  let raw = await redis.get(SCHEMA_VERSION_KEY);
  if (raw === null) {
    if (Number(await redis.setNX(SCHEMA_VERSION_KEY, String(known))) === 1) {
      return { outcome: 'written', stored: known, known };
    }
    // Lost the SET NX to a concurrent first start: classify what it wrote.
    raw = await redis.get(SCHEMA_VERSION_KEY);
    // Deleted again in between: nothing stored disagrees now, and the next start writes it.
    if (raw === null) return { outcome: 'current', stored: known, known };
  }
  return classify(raw, known);
}

function classify(raw: string, known: number): SchemaVersionResult {
  // Strict: a positive integer and nothing else. `Number(' 2')` and `parseInt('2x')` would both
  // read a value no release wrote as one it knows.
  if (!/^[1-9]\d*$/.test(raw)) throw new SchemaVersionError(raw, known);
  const stored = Number(raw);
  if (stored > known) throw new SchemaVersionError(raw, known);
  return { outcome: stored === known ? 'current' : 'older', stored, known };
}

/** What `guardSchemaVersion` needs from a client: the check's commands plus a connection. */
export interface SchemaVersionClient extends SchemaVersionRedisLike {
  readonly isOpen: boolean;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  connect(): Promise<unknown>;
  destroy(): void;
}

export interface SchemaGuardOptions {
  /** The log prefix, e.g. `control-plane`. */
  component: string;
  url: string;
  known?: number;
  /** Between attempts while Redis is unreachable, and the first back-off after an error reply. */
  retryMs?: number;
  /** The cap the back-off after error replies doubles up to. */
  maxBackoffMs?: number;
  newClient?: (url: string) => SchemaVersionClient;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** A refused connect rejects at once instead of retrying inside node-redis: the loop retries. */
function defaultClient(url: string): SchemaVersionClient {
  return createClient({
    url,
    socket: { reconnectStrategy: false },
  }) as unknown as SchemaVersionClient;
}

const DEFAULT_SCHEMA_RETRY_MS = 2_000;
const DEFAULT_SCHEMA_MAX_BACKOFF_MS = 60_000;

/**
 * Run `checkSchemaVersion` once Redis answers, on a short-lived client of its own, and exit the
 * process on a version it must not run against.
 *
 * Not a blocking boot step, deliberately: every component here starts before Redis is reachable
 * and waits for it (on Kubernetes setup.sh applies every workload at once, #423), so refusing to
 * start while Redis is merely absent would be a new failure, not a check. The check therefore
 * retries until Redis answers and then exits within one round trip of learning the version is
 * newer -- before its first turn in practice, since a turn needs the same Redis. A client of its
 * own, rather than the component's long-lived one, so this needs no seam in any store and the
 * connection is closed once the answer is known.
 *
 * Two kinds of failure, kept apart. Unreachable (the connect fails or the connection drops) retries
 * every `retryMs`, as before. An error REPLY means Redis answered and refused a command: a full
 * Redis under `noeviction`, a read-only replica or an ACL without SET refusing the write on an
 * absent key, or an ACL without GET. The version is then unknown, not newer, so the process runs
 * on; the guard says so once, naming the reply, and retries with a back-off doubling to
 * `maxBackoffMs`, so the check lands once the refusal clears instead of never.
 *
 * Never logs the URL or an error object: the URL carries the Redis password.
 */
export async function guardSchemaVersion(opts: SchemaGuardOptions): Promise<void> {
  const newClient = opts.newClient ?? defaultClient;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  const error = opts.error ?? ((line: string) => console.error(line));
  const retryMs = opts.retryMs ?? DEFAULT_SCHEMA_RETRY_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_SCHEMA_MAX_BACKOFF_MS;
  let reportedUnreachable = false;
  let reportedRefused = false;
  let backoffMs = retryMs;
  for (;;) {
    const client = newClient(opts.url);
    // Without a listener an 'error' event is an uncaught exception; the rejection is the signal.
    client.on('error', () => undefined);
    let waitMs = retryMs;
    try {
      await client.connect();
      const r = await checkSchemaVersion(client, opts.known);
      log(
        `[${opts.component}] redis schema version ${r.stored} (${r.outcome}; this release knows ${r.known})`,
      );
      return;
    } catch (err) {
      if (err instanceof SchemaVersionError) {
        error(`[${opts.component}] refusing to run: ${err.message}`);
        exit(1);
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      if (err instanceof ErrorReply) {
        // Answered but refused: the check is not done, and nothing says the data is newer.
        if (!reportedRefused) {
          error(
            `[${opts.component}] redis schema version unknown: Redis refused the check (${message}); ` +
              'running on and retrying with back-off',
          );
          reportedRefused = true;
        }
        waitMs = backoffMs;
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      } else if (!reportedUnreachable) {
        // Once: the component's own clients already report the outage, every few seconds.
        error(`[${opts.component}] redis schema version not checked yet (${message}); retrying`);
        reportedUnreachable = true;
      }
    } finally {
      if (client.isOpen) client.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
