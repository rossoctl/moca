import type { RedisClientType } from 'redis';

/**
 * One claimed entry. The queue carries a turn id and nothing else (async fan-out spec §5.1): the
 * envelope, the caps and the credential name all live on the record the control plane owns, which is
 * what makes a queue entry carrying a credential unnecessary (MI1 §6.5).
 */
export interface ClaimedEntry {
  entryId: string;
  /** `''` for an entry with no `turnId` field — malformed, and the caller dead-letters it. */
  turnId: string;
  /** XPENDING's deliveries counter: 1 on a fresh read, N on the Nth delivery. */
  deliveryCount: number;
  /** True iff this came from XAUTOCLAIM. `async_reclaims` (§7) counts exactly these. */
  reclaimed: boolean;
}

/** The two deployment-wide gauges §7 asks for, read together so they describe one instant. */
export interface QueueDepth {
  /** Entries added but not yet delivered to the group. */
  depth: number;
  /** Age of the oldest undelivered entry, 0 when none is waiting. */
  oldestAgeMs: number;
}

/**
 * The CONSUMER's view of the queue, and nothing more. There is deliberately no `enqueue`:
 * `@moca/control-plane`'s `RedisTurnQueue` is the only submitter, and the two interfaces are
 * mirrors — a submitter that can claim could be mistaken for a worker, and a consumer that can
 * enqueue could be mistaken for a submitter.
 */
export interface WorkQueue {
  ensureGroup(): Promise<void>;
  /**
   * `blockMs` omitted (or 0) means a NON-BLOCKING read: the call costs two round trips and returns
   * null on an empty queue. That is what the drain loop wants -- it holds an admission slot across
   * this call (§5.3), so blocking here would reserve a slot for the whole wait on an idle
   * deployment. A caller that wants XREADGROUP's own wait passes a positive value.
   */
  claim(
    consumerId: string,
    opts: { minIdleMs: number; blockMs?: number },
  ): Promise<ClaimedEntry | null>;
  ack(entryId: string): Promise<void>;
  /**
   * Reset the entry's idle timer so a healthy long run is not reclaimed. Returns false when the
   * entry is NO LONGER this consumer's — reclaimed by someone else, or already acked — in which
   * case nothing was touched. Callers treat false as "stop pretending to own this".
   */
  touch(entryId: string, consumerId: string): Promise<boolean>;
  pending(): Promise<number>;
  depth(): Promise<QueueDepth>;
  deleteConsumer(consumerId: string): Promise<void>;
  gcIdleConsumers(minIdleMs: number): Promise<number>;
  /**
   * Claim every over-attempted stale entry for this consumer and return it. The caller ACKs each
   * one through `ack` after its terminal write lands: an acked entry is gone from the PEL forever,
   * so acking here would make a failed dead-letter write unrecoverable.
   */
  reapDeadLetters(
    consumerId: string,
    opts: { minIdleMs: number; maxAttempts: number },
  ): Promise<Array<{ entryId: string; turnId: string }>>;
}

/**
 * Idle-consumer GC, as ONE server-side step. The `pending == 0` test and the DELCONSUMER that
 * acts on it must not be two round trips: XGROUP DELCONSUMER DISCARDS the named consumer's pending
 * entries, so a consumer that claims an entry in the gap between the two is deleted along with the
 * entry it is holding — the turn's one redelivery is gone, and it sits `running` until nothing
 * redelivers it. Inside a script, nothing else runs between the read and the delete.
 *
 * XINFO CONSUMERS answers RESP2 inside a script, so each consumer arrives as a FLAT field/value
 * array rather than a map — hence the stride-2 walk. Fields are read by name, not by position: the
 * order is not contractual and Redis has added fields (`inactive` in 7.2) between the ones we want.
 */
const GC_IDLE_CONSUMERS_LUA = `
local min_idle = tonumber(ARGV[2])
local removed = 0
for _, c in ipairs(redis.call('XINFO', 'CONSUMERS', KEYS[1], ARGV[1])) do
  local name, pending, idle
  for i = 1, #c, 2 do
    if c[i] == 'name' then name = c[i + 1]
    elseif c[i] == 'pending' then pending = tonumber(c[i + 1])
    elseif c[i] == 'idle' then idle = tonumber(c[i + 1]) end
  end
  if name and pending == 0 and idle and idle >= min_idle then
    redis.call('XGROUP', 'DELCONSUMER', KEYS[1], ARGV[1], name)
    removed = removed + 1
  end
end
return removed
`;

/**
 * The heartbeat's idle reset, CONDITIONAL on still owning the entry. A bare `XCLAIM ... 0 JUSTID`
 * transfers ownership whatever the current state is, because min-idle 0 matches everything — so a
 * worker that stalled past `minIdleMs`, had its entry legitimately reclaimed by another worker, and
 * then woke up would STEAL IT BACK on its next beat. Both workers would then be running the same
 * turn, both would write a result, and the loser's ack would retire an entry the winner still
 * believed it owned. Checking the owner first and claiming in the same script closes that.
 *
 * XPENDING's per-entry reply is a flat four-element array (id, consumer, idle, deliveries); only
 * the consumer is read here. 0 entries means the entry is gone from the PEL — acked, or trimmed —
 * which is the other case where touching would be a lie.
 */
const TOUCH_IF_OWNED_LUA = `
local p = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[3], ARGV[3], 1)
if #p == 0 or p[1][2] ~= ARGV[2] then return 0 end
redis.call('XCLAIM', KEYS[1], ARGV[1], ARGV[2], 0, ARGV[3], 'JUSTID')
return 1
`;

export class RedisWorkQueue implements WorkQueue {
  /**
   * The client is INJECTED (§9.2): this class owning a `createClient`, a reconnect strategy, an
   * error listener and an inline `redactUrl` duplicated `@moca/session-backend`'s
   * `resilientClientOptions`/`swallowRedisErrors`, and the caller already builds one from those.
   * Connecting is the caller's business too, for the same reason.
   *
   * The stream and group names are parameters defaulting to nothing: the caller passes
   * `LEAF_QUEUE_STREAM`/`LEAF_QUEUE_GROUP` from `@moca/control-plane`, so the submitter and the
   * consumer read one pair of constants rather than two copies of two literals.
   */
  constructor(
    private readonly client: RedisClientType,
    private readonly stream: string,
    private readonly group: string,
  ) {}

  /** Where the next XAUTOCLAIM scan resumes; see `claim`. '0-0' is the start of the PEL. */
  private autoClaimCursor = '0-0';

  async ensureGroup(): Promise<void> {
    try {
      // "0" = deliver from the start of the stream; MKSTREAM creates it if absent.
      await this.client.xGroupCreate(this.stream, this.group, '0', { MKSTREAM: true });
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
  }

  async claim(
    consumerId: string,
    opts: { minIdleMs: number; blockMs?: number },
  ): Promise<ClaimedEntry | null> {
    // 1. Prefer reclaiming a stale (delivered-but-unacked) entry — crash recovery (§6.2). This is
    // XAUTOCLAIM over the group's WHOLE PEL, not this consumer's own: nobody reclaims faster for
    // being the original owner, which is the behaviour §6.2 specifies.
    const auto = await this.client.xAutoClaim(
      this.stream,
      this.group,
      consumerId,
      opts.minIdleMs,
      this.autoClaimCursor,
      { COUNT: 1 },
    );
    // RESUME WHERE THE LAST SCAN STOPPED. XAUTOCLAIM examines at most COUNT*10 PEL entries per
    // call, so restarting from '0' every time confines the scan to the ~10 oldest entries: a
    // genuinely stale entry sitting behind ten fresh, heartbeating ones would never be examined,
    // and so never reclaimed, for as long as those ten keep running. Redis answers '0-0' when the
    // scan reached the end of the PEL, which is also a valid start, so this walks the whole PEL in
    // ceil(pending/10) claims and then wraps on its own.
    this.autoClaimCursor = String(auto.nextId ?? '0-0');
    const reclaimed = auto.messages?.find((m) => m && m.message);
    if (reclaimed) {
      return {
        entryId: reclaimed.id,
        turnId: this.turnIdOf(reclaimed.message),
        deliveryCount: await this.deliveryCount(reclaimed.id),
        reclaimed: true,
      };
    }
    // 2. Otherwise read a brand-new entry. BLOCK is OMITTED unless the caller asked for it, and 0
    // counts as not asking: to Redis, `BLOCK 0` means block FOREVER, which would pin the drain
    // loop's admission slot for the life of the process on an idle queue.
    const res = await this.client.xReadGroup(
      this.group,
      consumerId,
      [{ key: this.stream, id: '>' }],
      { COUNT: 1, ...(opts.blockMs ? { BLOCK: opts.blockMs } : {}) },
    );
    const msg = res?.[0]?.messages?.[0];
    if (!msg) return null;
    return {
      entryId: msg.id,
      turnId: this.turnIdOf(msg.message),
      deliveryCount: 1,
      reclaimed: false,
    };
  }

  /** An entry with no `turnId` is malformed, not a crash: '' lets the caller dead-letter it. */
  private turnIdOf(fields: Record<string, string>): string {
    const raw = fields.turnId;
    return typeof raw === 'string' ? raw : '';
  }

  private async deliveryCount(id: string): Promise<number> {
    const rows = await this.client.xPendingRange(this.stream, this.group, id, id, 1);
    return rows?.[0]?.deliveriesCounter ?? 1;
  }

  async ack(entryId: string): Promise<void> {
    await this.client.xAck(this.stream, this.group, entryId);
  }

  async touch(entryId: string, consumerId: string): Promise<boolean> {
    const held = await this.client.eval(TOUCH_IF_OWNED_LUA, {
      keys: [this.stream],
      arguments: [this.group, consumerId, entryId],
    });
    return Number(held ?? 0) === 1;
  }

  async pending(): Promise<number> {
    const summary = await this.client.xPending(this.stream, this.group);
    return summary?.pending ?? 0;
  }

  async depth(): Promise<QueueDepth> {
    const groups = await this.client.xInfoGroups(this.stream);
    const g = groups.find((row) => String(row.name) === this.group);
    if (!g) return { depth: 0, oldestAgeMs: 0 };
    // `lag` is Redis 7.0+ and every deployment pins Valkey 9. It reads null after certain trims, so
    // an unusable value becomes 0: a gauge nothing routes on must never report NaN (`admin.ts`
    // stringifies non-finite numbers as 'NaN', which would then be the operator's whole signal).
    const lag = Number(g.lag);
    const lastId = String(g['last-delivered-id']);
    // Exclusive ranges ('(id') are Redis 6.2+. '0-0' means nothing has been delivered yet, and
    // '(0-0' is not a valid exclusive start, so the whole stream is the range in that case.
    const after = lastId === '0-0' ? '-' : `(${lastId}`;
    const next = await this.client.xRange(this.stream, after, '+', { COUNT: 1 });
    const firstId = next?.[0]?.id;
    const ms = firstId ? Number(String(firstId).split('-')[0]) : 0;
    // Stream ids are minted from Redis's own clock, not this process's. Comparing against
    // Date.now() would smuggle in whatever skew exists between this host and the Redis server
    // (real in a containerized Redis) as phantom age; TIME keeps both sides of the subtraction on
    // one clock.
    const [nowSec, nowMicros] = ms > 0 ? await this.client.time() : ['0', '0'];
    const now = Number(nowSec) * 1000 + Math.floor(Number(nowMicros) / 1000);
    return {
      depth: Number.isFinite(lag) && lag > 0 ? lag : 0,
      oldestAgeMs: ms > 0 ? Math.max(0, now - ms) : 0,
    };
  }

  async deleteConsumer(consumerId: string): Promise<void> {
    await this.client.xGroupDelConsumer(this.stream, this.group, consumerId);
  }

  async gcIdleConsumers(minIdleMs: number): Promise<number> {
    const removed = await this.client.eval(GC_IDLE_CONSUMERS_LUA, {
      keys: [this.stream],
      arguments: [this.group, String(minIdleMs)],
    });
    return Number(removed ?? 0);
  }

  // Bounded per sweep; a backlog deeper than this drains across successive sweeps.
  private static readonly REAP_BATCH = 100;

  async reapDeadLetters(
    consumerId: string,
    opts: { minIdleMs: number; maxAttempts: number },
  ): Promise<Array<{ entryId: string; turnId: string }>> {
    const deadLettered: Array<{ entryId: string; turnId: string }> = [];
    const pending = await this.client.xPendingRange(
      this.stream,
      this.group,
      '-',
      '+',
      RedisWorkQueue.REAP_BATCH,
    );
    for (const entry of pending) {
      if (
        entry.millisecondsSinceLastDelivery >= opts.minIdleMs &&
        entry.deliveriesCounter > opts.maxAttempts
      ) {
        const claimed = await this.client.xClaim(
          this.stream,
          this.group,
          consumerId,
          opts.minIdleMs,
          [entry.id],
        );
        const msg = claimed?.[0];
        if (!msg) continue; // reclaimed by another consumer between inspect and claim
        // No XACK here: the caller acks after the dead-letter write, the order `leaf-job-runner`'s
        // own branch already uses. XCLAIM reset the idle timer, so a re-reap is minIdleMs away and
        // `deadLetterTurn`'s terminal-state guard makes the repeat a no-op.
        deadLettered.push({ entryId: entry.id, turnId: this.turnIdOf(msg.message) });
      }
    }
    return deadLettered;
  }
}
