import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { RedisWorkQueue } from '../src/queue.js';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
let client: RedisClientType;
let stream: string;
let queue: RedisWorkQueue;

/** The submitter's write, inlined: `RedisTurnQueue` owns it in production (§5.1). */
const put = (turnId: string) => client.xAdd(stream, '*', { turnId });

beforeAll(async () => {
  client = createClient({ url }) as RedisClientType;
  client.on('error', () => {});
  await client.connect();
});
afterAll(async () => {
  if (client.isOpen) await client.close();
});
beforeEach(async () => {
  stream = `test-leaf-queue-${Math.random().toString(36).slice(2)}`;
  queue = new RedisWorkQueue(client, stream, 'leaf-workers');
  await queue.ensureGroup();
});

describe('RedisWorkQueue', () => {
  it('ensureGroup is idempotent (BUSYGROUP is swallowed)', async () => {
    await expect(queue.ensureGroup()).resolves.toBeUndefined();
  });

  it('claims a fresh entry with the turn id, deliveryCount 1, reclaimed false', async () => {
    await put('t-abc');
    const claimed = await queue.claim('c1', { minIdleMs: 50, blockMs: 50 });
    expect(claimed).toMatchObject({ turnId: 't-abc', deliveryCount: 1, reclaimed: false });
    expect(await queue.pending()).toBe(1);
  });

  it('returns null when there is nothing to claim', async () => {
    expect(await queue.claim('c1', { minIdleMs: 50, blockMs: 50 })).toBeNull();
  });

  it('ack removes the entry from the PEL', async () => {
    await put('t-abc');
    const claimed = await queue.claim('c1', { minIdleMs: 50, blockMs: 50 });
    await queue.ack(claimed!.entryId);
    expect(await queue.pending()).toBe(0);
  });

  it('XAUTOCLAIM reclaims an abandoned entry for another consumer, flagged and counted', async () => {
    await put('t-abc');
    await queue.claim('dead', { minIdleMs: 50, blockMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    const again = await queue.claim('live', { minIdleMs: 50, blockMs: 50 });
    expect(again).toMatchObject({ turnId: 't-abc', reclaimed: true });
    expect(again!.deliveryCount).toBe(2);
  });

  it('touch resets idle time so a live holder is not reclaimed', async () => {
    await put('t-abc');
    const claimed = await queue.claim('live', { minIdleMs: 80, blockMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    await queue.touch(claimed!.entryId, 'live');
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.claim('other', { minIdleMs: 80, blockMs: 50 })).toBeNull();
  });

  it('reapDeadLetters returns only entries past maxAttempts and idle past minIdleMs', async () => {
    await put('t-dead');
    for (let i = 0; i < 4; i += 1) {
      await queue.claim(`c${i}`, { minIdleMs: 10, blockMs: 20 });
      await new Promise((r) => setTimeout(r, 15));
    }
    const reaped = await queue.reapDeadLetters('reaper', { minIdleMs: 10, maxAttempts: 3 });
    expect(reaped).toEqual([expect.objectContaining({ turnId: 't-dead' })]);
    // Still pending: the reap does NOT ack. The caller acks after the dead-letter write lands, so
    // an entry whose write fails is re-reaped instead of vanishing from the PEL.
    expect(await queue.pending()).toBe(1);
    await queue.ack(reaped[0]!.entryId);
    expect(await queue.pending()).toBe(0);
  });

  it('reapDeadLetters leaves a reaped entry claimable again when the caller never acks', async () => {
    await put('t-dead');
    for (let i = 0; i < 4; i += 1) {
      await queue.claim(`c${i}`, { minIdleMs: 10, blockMs: 20 });
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await queue.reapDeadLetters('reaper', { minIdleMs: 10, maxAttempts: 3 })).toHaveLength(
      1,
    );
    await new Promise((r) => setTimeout(r, 15));
    // The second sweep sees it again: this is what makes a failed dead-letter write recoverable.
    const again = await queue.reapDeadLetters('reaper', { minIdleMs: 10, maxAttempts: 3 });
    expect(again).toEqual([expect.objectContaining({ turnId: 't-dead' })]);
  });

  it('gcIdleConsumers removes only consumers with no pending entries', async () => {
    await put('t-held');
    await queue.claim('holder', { minIdleMs: 50, blockMs: 50 });
    await queue.claim('empty', { minIdleMs: 50, blockMs: 20 }); // creates the consumer, claims nothing
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.gcIdleConsumers(50)).toBe(1);
  });

  it('depth reports undelivered entries and the age of the oldest', async () => {
    await put('t-1');
    await queue.claim('c1', { minIdleMs: 50, blockMs: 50 });
    await put('t-2');
    await new Promise((r) => setTimeout(r, 20));
    const { depth, oldestAgeMs } = await queue.depth();
    expect(depth).toBe(1); // t-2 only: t-1 has been delivered
    expect(oldestAgeMs).toBeGreaterThan(0);
  });

  it('depth is zero with nothing waiting', async () => {
    expect(await queue.depth()).toEqual({ depth: 0, oldestAgeMs: 0 });
  });

  it('claim reports an empty turnId for a malformed entry rather than throwing', async () => {
    await client.xAdd(stream, '*', { note: 'not a turn' });
    const claimed = await queue.claim('c1', { minIdleMs: 50, blockMs: 50 });
    expect(claimed!.turnId).toBe('');
  });
});
