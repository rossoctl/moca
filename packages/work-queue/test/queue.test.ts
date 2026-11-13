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

  // An omitted blockMs must OMIT the option, not send `BLOCK 0` -- which to Redis means block
  // forever. The drain loop holds an admission slot across this call (§5.3), so a hang here would
  // pin that slot for the life of the process. A timeout, not a null check: a `BLOCK 0` regression
  // would make this test hang rather than fail.
  it('returns null promptly on an empty queue when blockMs is omitted', async () => {
    const claimed = await Promise.race([
      queue.claim('c1', { minIdleMs: 50 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('claim blocked')), 1_000)),
    ]);
    expect(claimed).toBeNull();
  });

  it('still claims a waiting entry when blockMs is omitted', async () => {
    await put('t-abc');
    expect(await queue.claim('c1', { minIdleMs: 50 })).toMatchObject({ turnId: 't-abc' });
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

  // XAUTOCLAIM examines at most COUNT*10 PEL entries per call, so a scan that always restarts at
  // '0' can only ever see the ten oldest. Eleven entries, the first ten kept alive by a heartbeat:
  // the eleventh is stale and reclaimable, and a cursorless scan would never reach it -- the turn
  // would sit `running` until its three attempts expired, with no worker ever picking it up.
  it('resumes its XAUTOCLAIM scan, so a stale entry behind ten live ones is still reclaimed', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) await put(`t-${i}`);
    for (let i = 0; i < 11; i += 1) {
      const c = await queue.claim('holder', { minIdleMs: 10_000 });
      ids.push(c!.entryId);
    }
    await new Promise((r) => setTimeout(r, 600));
    // The ten oldest are alive; only the eleventh is past minIdleMs.
    for (const id of ids.slice(0, 10)) await queue.touch(id, 'holder');

    expect(await queue.claim('live', { minIdleMs: 500 })).toBeNull(); // scan 1: the ten live ones
    expect(await queue.claim('live', { minIdleMs: 500 })).toMatchObject({
      turnId: 't-10',
      reclaimed: true,
    });
  });

  it('touch resets idle time so a live holder is not reclaimed', async () => {
    await put('t-abc');
    const claimed = await queue.claim('live', { minIdleMs: 80, blockMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.touch(claimed!.entryId, 'live')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.claim('other', { minIdleMs: 80, blockMs: 50 })).toBeNull();
  });

  // A bare XCLAIM with min-idle 0 matches any entry, so a stalled worker's next beat would take the
  // entry BACK from the worker that legitimately reclaimed it -- two workers on one turn, two
  // results, and the loser's ack retiring the winner's entry.
  it('touch does not steal the entry back once another consumer has reclaimed it', async () => {
    await put('t-abc');
    const first = await queue.claim('stalled', { minIdleMs: 10_000 });
    await new Promise((r) => setTimeout(r, 60));
    const second = await queue.claim('reclaimer', { minIdleMs: 50 });
    expect(second).toMatchObject({ reclaimed: true });

    expect(await queue.touch(first!.entryId, 'stalled')).toBe(false);
    // Still the reclaimer's, and still fresh: the refused touch changed nothing at all.
    const pel = await client.xPendingRange(stream, 'leaf-workers', '-', '+', 10);
    expect(pel.map((e) => String(e.consumer))).toEqual(['reclaimer']);
  });

  it('touch reports false for an entry that is no longer pending at all', async () => {
    await put('t-abc');
    const claimed = await queue.claim('live', { minIdleMs: 50 });
    await queue.ack(claimed!.entryId);
    expect(await queue.touch(claimed!.entryId, 'live')).toBe(false);
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
    // The holder kept its name AND its entry: DELCONSUMER would have discarded the entry with it.
    expect(await queue.pending()).toBe(1);
    expect(
      (await client.xInfoConsumers(stream, 'leaf-workers')).map((c) => String(c.name)),
    ).toEqual(['holder']);
  });

  it('gcIdleConsumers leaves a consumer whose pending entry is young but whose name is idle', async () => {
    await put('t-held');
    await queue.claim('holder', { minIdleMs: 50, blockMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.gcIdleConsumers(50)).toBe(0);
    expect(await queue.pending()).toBe(1);
  });

  it('gcIdleConsumers removes several idle consumers in one call', async () => {
    for (const name of ['a', 'b', 'c']) await queue.claim(name, { minIdleMs: 50, blockMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(await queue.gcIdleConsumers(50)).toBe(3);
  });

  it('gcIdleConsumers keeps a freshly active consumer', async () => {
    await queue.claim('fresh', { minIdleMs: 50, blockMs: 20 });
    expect(await queue.gcIdleConsumers(60_000)).toBe(0);
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
