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
  claim(
    consumerId: string,
    opts: { minIdleMs: number; blockMs: number },
  ): Promise<ClaimedEntry | null>;
  ack(entryId: string): Promise<void>;
  touch(entryId: string, consumerId: string): Promise<void>;
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
    opts: { minIdleMs: number; blockMs: number },
  ): Promise<ClaimedEntry | null> {
    // 1. Prefer reclaiming a stale (delivered-but-unacked) entry — crash recovery (§6.2). This is
    // XAUTOCLAIM over the group's WHOLE PEL from '0', not this consumer's own: nobody reclaims
    // faster for being the original owner, which is the behaviour §6.2 specifies.
    const auto = await this.client.xAutoClaim(
      this.stream,
      this.group,
      consumerId,
      opts.minIdleMs,
      '0',
      { COUNT: 1 },
    );
    const reclaimed = auto.messages?.find((m) => m && m.message);
    if (reclaimed) {
      return {
        entryId: reclaimed.id,
        turnId: this.turnIdOf(reclaimed.message),
        deliveryCount: await this.deliveryCount(reclaimed.id),
        reclaimed: true,
      };
    }
    // 2. Otherwise read a brand-new entry. This is the call that BLOCKs, and the reason §5.3 takes
    // the admission slot before calling claim() rather than after.
    const res = await this.client.xReadGroup(
      this.group,
      consumerId,
      [{ key: this.stream, id: '>' }],
      { COUNT: 1, BLOCK: opts.blockMs },
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

  async touch(entryId: string, consumerId: string): Promise<void> {
    // Reset idle time without re-fetching the payload, so a healthy long run is not reclaimed.
    await this.client.xClaimJustId(this.stream, this.group, consumerId, 0, [entryId]);
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
    const info = await this.client.xInfoConsumers(this.stream, this.group);
    let removed = 0;
    for (const c of info) {
      // `pending === 0` is the whole safety property: a consumer still holding entries must keep
      // its name, or the entries leave the PEL with it.
      if (c.pending === 0 && c.idle >= minIdleMs) {
        await this.client.xGroupDelConsumer(this.stream, this.group, c.name);
        removed += 1;
      }
    }
    return removed;
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
