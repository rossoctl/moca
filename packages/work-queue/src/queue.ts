import { createClient, type RedisClientType } from 'redis';

/**
 * Inline implementation of redactUrl (canonical copy at @moca/session-backend).
 * A URL safe to print: any userinfo becomes `***@`. Non-URLs pass unchanged.
 * Inline rather than imported to avoid a package dependency on session-backend.
 */
function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.username === '' && u.password === '') return raw;
  u.username = '';
  u.password = '';
  return u.toString().replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, '$1***@');
}

export interface ClaimedEntry {
  entryId: string;
  envelope: unknown;
  deliveryCount: number;
}

export interface WorkQueue {
  ensureGroup(): Promise<void>;
  enqueue(envelope: unknown): Promise<string>;
  claim(
    consumerId: string,
    opts: { minIdleMs: number; blockMs: number },
  ): Promise<ClaimedEntry | null>;
  ack(entryId: string): Promise<void>;
  touch(entryId: string, consumerId: string): Promise<void>;
  pending(): Promise<number>;
  deleteConsumer(consumerId: string): Promise<void>;
  gcIdleConsumers(minIdleMs: number): Promise<number>;
  reapDeadLetters(
    consumerId: string,
    opts: { minIdleMs: number; maxAttempts: number },
  ): Promise<Array<{ entryId: string; envelope: unknown }>>;
  purge(): Promise<void>;
  close(): Promise<void>;
}

export class RedisWorkQueue implements WorkQueue {
  private client: RedisClientType;
  private ready: Promise<void> | null;
  constructor(
    url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    private readonly stream = 'leaf-queue',
    private readonly group = 'leaf-workers',
  ) {
    // Listener + bounded reconnect, and they only work as a pair. With no listener, an 'error' on an
    // established connection exits the process (proven with `CLIENT KILL` on the pinned redis@6.2.1).
    // With a listener but node-redis's DEFAULT strategy, the listener consumes the error that makes a
    // failed connect() reject, so an absent Redis leaves connect() pending forever instead — a silent
    // wedge in place of a loud crash. The bound keeps a transient blip recoverable and a genuinely
    // absent Redis loud. Inline rather than shared: the equivalent helper is `resilientClientOptions` /
    // `swallowRedisErrors` in @moca/session-backend (with the full rationale and the probe numbers), and
    // a queue depending on the session store to reach it would invert the layering.
    //
    // Two notes from that shared rationale apply here verbatim. A REFUSED port rejects in ~5.5 s at this
    // bound (its delays and nothing else), but a black-holed SYN -- the cluster shape, from a Service
    // with no ready endpoints or a NetworkPolicy drop -- pays the full 5 s connectTimeout per attempt,
    // so ~60 s to reject. And past this bound
    // node-redis gives up PERMANENTLY and silently; the isOpen re-arm in open() is the other half of
    // this fix, without which every later command rejects ClientClosedError for the life of the process.
    this.client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries: number) =>
          retries > 10
            ? new Error(`redis at ${redactUrl(url)} unreachable after ${retries} attempts`)
            : Math.min(retries * 100, 1000),
      },
    }) as RedisClientType;
    this.client.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[redis] work queue: ${message} (node-redis will reconnect)`);
    });
    this.ready = this.arm();
  }

  /** Connect, clearing the memo on rejection so the next call retries. Mirrors RedisSessionBackend.arm(). */
  private arm(): Promise<void> {
    const attempt = this.client.connect().then(() => undefined);
    void attempt.catch(() => {
      if (this.ready === attempt) this.ready = null;
    });
    return attempt;
  }

  /**
   * Await the live attempt, re-arming if the last one FAILED or if node-redis permanently closed the
   * socket past the bound above -- the second is invisible to the `.catch`, because that connect
   * succeeded. See redis-errors.ts for the citations.
   */
  private open(): Promise<void> {
    if (this.ready && !this.client.isOpen) this.ready = null;
    return (this.ready ??= this.arm());
  }

  async ensureGroup(): Promise<void> {
    await this.open();
    try {
      // "0" = deliver from the start of the stream; MKSTREAM creates it if absent.
      await this.client.xGroupCreate(this.stream, this.group, '0', { MKSTREAM: true });
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
  }

  async enqueue(envelope: unknown): Promise<string> {
    await this.open();
    return this.client.xAdd(this.stream, '*', { envelope: JSON.stringify(envelope) });
  }

  async claim(
    consumerId: string,
    opts: { minIdleMs: number; blockMs: number },
  ): Promise<ClaimedEntry | null> {
    await this.open();
    // 1. Prefer reclaiming a stale (delivered-but-unacked) entry — crash recovery.
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
        envelope: JSON.parse(reclaimed.message.envelope),
        deliveryCount: await this.deliveryCount(reclaimed.id),
      };
    }
    // 2. Otherwise read a brand-new entry.
    const res = await this.client.xReadGroup(
      this.group,
      consumerId,
      [{ key: this.stream, id: '>' }],
      { COUNT: 1, BLOCK: opts.blockMs },
    );
    const msg = res?.[0]?.messages?.[0];
    if (!msg) return null;
    return { entryId: msg.id, envelope: JSON.parse(msg.message.envelope), deliveryCount: 1 };
  }

  private async deliveryCount(id: string): Promise<number> {
    const rows = await this.client.xPendingRange(this.stream, this.group, id, id, 1);
    return rows?.[0]?.deliveriesCounter ?? 1;
  }

  async ack(entryId: string): Promise<void> {
    await this.open();
    await this.client.xAck(this.stream, this.group, entryId);
  }

  async touch(entryId: string, consumerId: string): Promise<void> {
    await this.open();
    // Reset idle time without re-fetching the payload, so a healthy long run is not reclaimed.
    await this.client.xClaimJustId(this.stream, this.group, consumerId, 0, [entryId]);
  }

  async pending(): Promise<number> {
    await this.open();
    const summary = await this.client.xPending(this.stream, this.group);
    return summary?.pending ?? 0;
  }

  async deleteConsumer(consumerId: string): Promise<void> {
    await this.open();
    await this.client.xGroupDelConsumer(this.stream, this.group, consumerId);
  }

  async gcIdleConsumers(minIdleMs: number): Promise<number> {
    await this.open();
    const info = await this.client.xInfoConsumers(this.stream, this.group);
    let removed = 0;
    for (const c of info) {
      if (c.pending === 0 && c.idle >= minIdleMs) {
        await this.client.xGroupDelConsumer(this.stream, this.group, c.name);
        removed++;
      }
    }
    return removed;
  }

  // Bounded per startup; backlogs > REAP_BATCH drain across successive pod restarts.
  private static readonly REAP_BATCH = 100;

  async reapDeadLetters(
    consumerId: string,
    opts: { minIdleMs: number; maxAttempts: number },
  ): Promise<Array<{ entryId: string; envelope: unknown }>> {
    await this.open();
    const deadLettered: Array<{ entryId: string; envelope: unknown }> = [];
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
        if (!msg) continue; // entry was reclaimed by another consumer between inspect and claim
        let envelope: unknown = null;
        try {
          envelope = msg.message?.envelope ? JSON.parse(msg.message.envelope) : null;
        } catch {
          /* malformed — still dead-letter it */
        }
        await this.client.xAck(this.stream, this.group, entry.id);
        deadLettered.push({ entryId: entry.id, envelope });
      }
    }
    return deadLettered;
  }

  async purge(): Promise<void> {
    await this.open();
    try {
      await this.client.xGroupDestroy(this.stream, this.group);
    } catch {
      /* ignore */
    }
    try {
      await this.client.del(this.stream);
    } catch {
      /* ignore */
    }
  }

  /**
   * Close what is open, without propagating a failed connect: `await this.ready` meant a client that
   * never connected could not be closed AT ALL. Same bug, same fix as RedisSessionBackend.close().
   */
  async close(): Promise<void> {
    await this.ready?.catch(() => {});
    if (this.client.isOpen) await this.client.close();
  }
}
