import { describe, expect, it } from 'vitest';
import {
  LEAF_QUEUE_GROUP,
  LEAF_QUEUE_STREAM,
  MemoryTurnQueue,
  RedisTurnQueue,
} from '../src/turn-queue.js';
import { fakeRedis } from './helpers/fake-redis.js';

describe('RedisTurnQueue', () => {
  it('XADDs the turn id, and ONLY the turn id, to the leaf queue stream', async () => {
    const { redis, streams } = fakeRedis();
    const id = await new RedisTurnQueue(redis).enqueue('t-1');
    expect(id).toBeTruthy();
    const entries = streams.get(LEAF_QUEUE_STREAM) ?? [];
    expect(entries).toHaveLength(1);
    // The whole point of the port (spec §5.1): no envelope, no credential, no config. A field added
    // here is a field something downstream may read INSTEAD of the record, which is what makes the
    // dequeue-time credential resolution in §5.4 possible.
    expect(Object.keys(entries[0]!)).toEqual(['turnId']);
    expect(entries[0]!.turnId).toBe('t-1');
  });

  it('names the stream and group the restored consumer will read (§10)', () => {
    // Pinned, not incidental: #389's RedisWorkQueue defaults to these, and a mismatch is a submission
    // that enqueues successfully and is never drained -- a silent wedge rather than an error.
    expect(LEAF_QUEUE_STREAM).toBe('leaf-queue');
    expect(LEAF_QUEUE_GROUP).toBe('leaf-workers');
  });

  it('writes to an overridden stream, leaving the default one untouched', async () => {
    // The override exists for the end-to-end suite (Task 9), which needs a per-run stream against a
    // real Redis. Covered here so the parameter is not dead code reachable only from a test helper.
    const { redis, streams } = fakeRedis();
    await new RedisTurnQueue(redis, 'leaf-queue:test-tag').enqueue('t-1');
    expect(streams.get('leaf-queue:test-tag')).toHaveLength(1);
    expect(streams.get(LEAF_QUEUE_STREAM)).toBeUndefined();
  });

  it('refuses an empty turn id rather than writing an unaddressable entry', async () => {
    const { redis, streams } = fakeRedis();
    await expect(new RedisTurnQueue(redis).enqueue('')).rejects.toThrow(/turnId/);
    expect(streams.get(LEAF_QUEUE_STREAM)).toBeUndefined();
  });

  it('reports a transport failure as 503, not 500', async () => {
    const { redis } = fakeRedis();
    redis.xAdd = async () => {
      throw new Error('ECONNREFUSED');
    };
    // A failed enqueue is retryable, and the caller can only act on that if it is told so. Same
    // reading OwnershipIndex.guard gives a transport failure.
    await expect(new RedisTurnQueue(redis).enqueue('t-1')).rejects.toMatchObject({
      code: 'redis_unavailable',
    });
  });
});

describe('MemoryTurnQueue', () => {
  it('records ids in submission order and reports its depth', async () => {
    const q = new MemoryTurnQueue();
    expect(q.depth()).toBe(0);
    await q.enqueue('t-1');
    await q.enqueue('t-2');
    expect(q.ids).toEqual(['t-1', 't-2']);
    expect(q.depth()).toBe(2);
  });

  it('can be made to fail, so a handler s enqueue-failure path is testable', async () => {
    const q = new MemoryTurnQueue();
    q.failWith = new Error('redis gone');
    await expect(q.enqueue('t-1')).rejects.toThrow('redis gone');
    // Nothing recorded: the handler's compensation (Task 4) is asserted against this.
    expect(q.depth()).toBe(0);
  });
});
