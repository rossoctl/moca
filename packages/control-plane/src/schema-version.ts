import { createClient } from 'redis';

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
 * Write the version when absent, then classify what is stored. Throws `SchemaVersionError` for a
 * newer or malformed version; any other throw is Redis itself (unreachable, refused), which the
 * caller retries.
 */
export async function checkSchemaVersion(
  redis: SchemaVersionRedisLike,
  known: number = SCHEMA_VERSION,
): Promise<SchemaVersionResult> {
  if (Number(await redis.setNX(SCHEMA_VERSION_KEY, String(known))) === 1) {
    return { outcome: 'written', stored: known, known };
  }
  const raw = await redis.get(SCHEMA_VERSION_KEY);
  // Deleted between the two commands: the next start writes it; nothing stored disagrees now.
  if (raw === null) return { outcome: 'current', stored: known, known };
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
  /** Between attempts while Redis is unreachable. */
  retryMs?: number;
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
 * Never logs the URL or an error object: the URL carries the Redis password.
 */
export async function guardSchemaVersion(opts: SchemaGuardOptions): Promise<void> {
  const newClient = opts.newClient ?? defaultClient;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  const error = opts.error ?? ((line: string) => console.error(line));
  const retryMs = opts.retryMs ?? DEFAULT_SCHEMA_RETRY_MS;
  let reported = false;
  for (;;) {
    const client = newClient(opts.url);
    // Without a listener an 'error' event is an uncaught exception; the rejection is the signal.
    client.on('error', () => undefined);
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
      // Once: the component's own clients already report the outage, every few seconds.
      if (!reported) {
        error(
          `[${opts.component}] redis schema version not checked yet (${(err as Error)?.message ?? String(err)}); retrying`,
        );
        reported = true;
      }
    } finally {
      if (client.isOpen) client.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
