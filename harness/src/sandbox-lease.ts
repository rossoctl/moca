import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';

/** Redis key holding the per-pod lease set (member = leaf id, score = expiry ms). */
export function leaseKey(pod: string): string {
  return `sh:sandbox:${pod}:leases`;
}

/** Pure: count members whose expiry (score, ms) is still in the future. */
export function activeCount(members: { value: string; score: number }[], now: number): number {
  return members.filter((m) => m.score > now).length;
}

/**
 * Atomic acquire. KEYS[1]=leaseKey. ARGV = [now, cap, holderId, expiry].
 * Sweeps expired members, then adds {holderId -> expiry} iff active < cap.
 * Returns 1 (acquired) or 0 (full). Crash reclaim is implicit: a dead leaf's
 * member ages past its expiry and is swept by the next acquire (spec §4.1).
 *
 * `holderId` identifies WHO HOLDS this lease, and it is deliberately not the session id. It is the
 * ZSET member, so two holders with equal ids are ONE lease: `ZADD` on an existing member refreshes
 * its score and leaves `ZCARD` unchanged, and `zRem` by the shared member releases a sandbox a
 * sibling is still executing in. A leaf is one session executing once, so it holds under its session
 * id; a `/turn` is one of many concurrent turns of a session, so it holds under a per-turn id
 * (`turnLeaseHolder`, run-turn.ts). #279 removed the old `runId` name for this; the identity itself
 * is real and is NOT `session_id` under another name — see docs/glossary.md.
 */
export const ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
  return 1
end
return 0`;

export interface LeaseStore {
  /** Active (non-expired) lease count for a pod; sweeps expired as a side effect. */
  load(pod: string): Promise<number>;
  /** Try to take a lease under the soft cap. `holderId` must be unique per holder — see ACQUIRE_LUA. */
  acquire(pod: string, cap: number, holderId: string, ttlMs: number): Promise<boolean>;
  /** Refresh a held lease's expiry (called on an interval while the holder runs). */
  heartbeat(pod: string, holderId: string, ttlMs: number): Promise<void>;
  /** Drop a held lease. */
  release(pod: string, holderId: string): Promise<void>;
}

/** Real node-redis-backed lease store. Connects lazily; reuses REDIS_URL. */
export class RedisLeaseStore implements LeaseStore {
  private client: RedisClientType;
  private ready: Promise<void>;
  /**
   * `maxReconnectAttempts` is a seam for tests, not a knob anyone is expected to set -- the same one
   * `resilientClientOptions` and `RedisRecordStore` expose, and for the same reason: it lets a test pin
   * "rejects rather than hangs" in milliseconds instead of waiting out the real ladder. At the default
   * a refused port costs ~5.5 s (redis-errors.ts), which is a long time to spend asserting two lines of
   * `close()`; it also decoupled a test's runtime from a bound nobody wants to think about retuning.
   *
   * Third rather than second so every existing positional caller (`(url)`, `(url, now)`) is unaffected.
   */
  constructor(
    url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    private now: () => number = Date.now,
    maxReconnectAttempts?: number,
  ) {
    // Listener + bounded reconnect, which only work as a pair: no listener and an 'error' on an
    // established connection exits the process; a listener with node-redis's default strategy silences
    // the error that makes a failed connect() reject, so it hangs instead. See redis-errors.ts.
    this.client = createClient(
      resilientClientOptions(url, maxReconnectAttempts),
    ) as RedisClientType;
    swallowRedisErrors(this.client, 'sandbox lease store');
    this.ready = this.client.connect().then(() => undefined);
  }
  async load(pod: string): Promise<number> {
    await this.ready;
    await this.client.zRemRangeByScore(leaseKey(pod), '-inf', this.now());
    return this.client.zCard(leaseKey(pod));
  }
  async acquire(pod: string, cap: number, holderId: string, ttlMs: number): Promise<boolean> {
    await this.ready;
    const now = this.now();
    const res = await this.client.eval(ACQUIRE_LUA, {
      keys: [leaseKey(pod)],
      arguments: [String(now), String(cap), holderId, String(now + ttlMs)],
    });
    return res === 1;
  }
  async heartbeat(pod: string, holderId: string, ttlMs: number): Promise<void> {
    await this.ready;
    await this.client.zAdd(leaseKey(pod), { score: this.now() + ttlMs, value: holderId });
  }
  async release(pod: string, holderId: string): Promise<void> {
    await this.ready;
    await this.client.zRem(leaseKey(pod), holderId);
  }
  /**
   * Tear the client down without re-throwing a failed connect.
   *
   * A bare `await this.ready` re-threw exactly on the store this is most often called for:
   * `select-sandbox.ts`'s `dropMemo` closes the store a rejected command evicted, and the commonest
   * such rejection IS the rejected connect. Nothing leaks either way -- a client past the reconnect
   * bound has `isOpen: false` and its socket already destroyed, and node-redis's `close()` rejects
   * `ClientClosedError` on it regardless (probed on the pinned redis 6.2.1) -- but a teardown that
   * rejects on the failure path is a trap for the next caller: today's two both swallow, and one that
   * awaits would fail precisely when teardown matters. Same shape as `RedisRecordStore.close()` and
   * `RedisSessionBackend.close()`.
   */
  async close(): Promise<void> {
    await this.ready.catch(() => {});
    if (this.client.isOpen) await this.client.close();
  }
}
