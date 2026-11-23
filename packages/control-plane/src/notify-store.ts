import { CpError } from './errors.js';
import type { NotifyConfig, NotifySink, StoredNotifyConfig } from './notify-config.js';
import type { CpRedisLike } from './ownership.js';
import { subjectHash } from './subject-document.js';
import type { TurnState } from './turn-record.js';

/**
 * Where one subject's notification config and the notifier's own cursor live (#394).
 *
 * Subject-hashed like every other owner key here (`ownerTurnsKey`, `ownerEventsKey`), so the
 * keyspace names no logins. NO TTL: unlike a session or a result, a config is something the subject
 * set deliberately and expects to still be there after a quiet month.
 */
export const notifyConfigKey = (subject: string): string =>
  `sh:cp:owner:${subjectHash(subject)}:notify`;

/**
 * The owner INDEX, and the reason this feature is buildable at all: `ownerEventsKey` is derived
 * through a non-reversible hash and nothing in the keyspace enumerates subjects, so a sweep cannot
 * otherwise discover whose streams to read. The set of subjects who configured notifications IS the
 * index -- bounded by the people who asked to be notified, not by everyone who ever logged in.
 *
 * A zset rather than a set for one reason: `CpRedisLike` declares zAdd/zRem/zRange and NO set
 * commands, so this needs no new interface method and no change to the test fake. The score is
 * `createdAt`, which also gives the sweep a stable order.
 *
 * The member is the PLAIN subject, not its hash: the sweep has to read that subject's event stream,
 * and `subjectHash` is one-way.
 */
export const NOTIFY_OWNERS_KEY = 'sh:cp:notify:owners';

/** This schema's version. A hash with any other `v` reads as absent rather than being guessed at. */
const V = '1';

/** Everything the sweep writes back after a pass. Computed by the sweep; stored verbatim. */
export interface NotifyProgress {
  /** The event id delivery resumes AFTER. */
  cursor: string;
  lastDeliveryAt: number;
  failures: number;
  mutedUntil: number;
  hourStart: number;
  hourCount: number;
}

const ZERO: NotifyProgress = {
  cursor: '0-0',
  lastDeliveryAt: 0,
  failures: 0,
  mutedUntil: 0,
  hourStart: 0,
  hourCount: 0,
};

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class NotifyStore {
  constructor(private readonly redis: CpRedisLike) {}

  /** As OwnershipIndex.guard and TurnStore.guard do: any transport failure is a 503, never a 500. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CpError) throw err;
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  async get(subject: string): Promise<StoredNotifyConfig | null> {
    const h = await this.guard(() => this.redis.hGetAll(notifyConfigKey(subject)));
    if (!h || h.v !== V) return null;
    let sinks: NotifySink[];
    try {
      sinks = JSON.parse(h.sinks ?? '');
    } catch {
      // A hand-edited or half-written key must read as "not configured" rather than throw: this
      // runs once per owner per sweep, and one bad key would stop every later owner's pass.
      return null;
    }
    if (!Array.isArray(sinks) || sinks.length === 0) return null;
    const states = (h.states ?? '').split(',').filter((s) => s !== '') as TurnState[];
    if (states.length === 0) return null;
    return {
      sinks,
      states,
      cursor: h.cursor ?? ZERO.cursor,
      createdAt: num(h.createdAt),
      lastDeliveryAt: num(h.lastDeliveryAt),
      failures: num(h.failures),
      mutedUntil: num(h.mutedUntil),
      hourStart: num(h.hourStart),
      hourCount: num(h.hourCount),
    };
  }

  /**
   * Write a config, and index the subject. The bookkeeping is RESET on every PUT, deliberately: a
   * subject whose webhook was broken long enough to be muted fixes it by re-PUTting, and that must
   * take effect on the next sweep rather than an hour later.
   */
  async put(subject: string, config: NotifyConfig, cursor: string, now: number): Promise<void> {
    await this.guard(async () => {
      await this.redis.hSet(notifyConfigKey(subject), {
        v: V,
        sinks: JSON.stringify(config.sinks),
        states: config.states.join(','),
        ...fields({ ...ZERO, cursor }, now),
      });
      // Indexed AFTER the hash: a crash between the two leaves a config that is never swept, which
      // the next PUT fixes. The other order leaves an indexed owner with no config, and the sweep
      // reads a null for them on every pass forever.
      await this.redis.zAdd(NOTIFY_OWNERS_KEY, { score: now, value: subject });
    });
  }

  async remove(subject: string): Promise<void> {
    await this.guard(async () => {
      await this.redis.zRem(NOTIFY_OWNERS_KEY, subject);
      await this.redis.del([notifyConfigKey(subject)]);
    });
  }

  /** Every subject to sweep, oldest configuration first. */
  async owners(): Promise<string[]> {
    return this.guard(() => this.redis.zRange(NOTIFY_OWNERS_KEY, '-inf', '+inf', { BY: 'SCORE' }));
  }

  /** The sweep's write-back. Touches the six bookkeeping fields and nothing else. */
  async advance(subject: string, next: NotifyProgress): Promise<void> {
    await this.guard(() => this.redis.hSet(notifyConfigKey(subject), fields(next)));
  }
}

/** Redis hash fields are strings; this is the one place that conversion happens. */
function fields(p: NotifyProgress, createdAt?: number): Record<string, string> {
  return {
    cursor: p.cursor,
    lastDeliveryAt: String(p.lastDeliveryAt),
    failures: String(p.failures),
    mutedUntil: String(p.mutedUntil),
    hourStart: String(p.hourStart),
    hourCount: String(p.hourCount),
    ...(createdAt === undefined ? {} : { createdAt: String(createdAt) }),
  };
}
