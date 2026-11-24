import { beforeEach, describe, expect, it } from 'vitest';
import type { NotifyConfig } from '../src/notify-config.js';
import { NOTIFY_OWNERS_KEY, NotifyStore, notifyConfigKey } from '../src/notify-store.js';
import { fakeRedis } from './helpers/fake-redis.js';

const CONFIG: NotifyConfig = {
  sinks: [
    { kind: 'webhook', url: 'https://hooks.example.com/moca' },
    { kind: 'ntfy', url: 'https://ntfy.example.com', topic: 'moca-alice' },
  ],
  states: ['paused', 'failed'],
};
const ALICE = 'github:1234';
const BOB = 'github:5678';
const NOW = 1_757_000_000_000;

let fake: ReturnType<typeof fakeRedis>;
let store: NotifyStore;

beforeEach(() => {
  fake = fakeRedis();
  store = new NotifyStore(fake.redis);
});

describe('NotifyStore', () => {
  it('round-trips a config and starts the bookkeeping at zero', async () => {
    await store.put(ALICE, CONFIG, '42-0', NOW);
    expect(await store.get(ALICE)).toEqual({
      ...CONFIG,
      cursor: '42-0',
      createdAt: NOW,
      lastDeliveryAt: 0,
      failures: 0,
      mutedUntil: 0,
      hourStart: 0,
      hourCount: 0,
    });
  });

  it('names no login in the keyspace', async () => {
    await store.put(ALICE, CONFIG, '0-0', NOW);
    expect(notifyConfigKey(ALICE)).not.toContain('github');
    expect(notifyConfigKey(ALICE)).not.toBe(notifyConfigKey(BOB));
  });

  it('indexes the PLAIN subject, because the sweep must read that subject streams', async () => {
    await store.put(ALICE, CONFIG, '0-0', NOW);
    await store.put(BOB, CONFIG, '0-0', NOW + 1);
    // Ordered by createdAt, so the sweep order is stable rather than hash order.
    expect(await store.owners()).toEqual([ALICE, BOB]);
  });

  it('re-PUT replaces the sinks and resets the failure bookkeeping, keeping one index entry', async () => {
    await store.put(ALICE, CONFIG, '0-0', NOW);
    await store.advance(ALICE, {
      cursor: '7-0',
      lastDeliveryAt: NOW + 10,
      failures: 3,
      mutedUntil: NOW + 99,
      hourStart: NOW,
      hourCount: 5,
    });
    await store.put(ALICE, { sinks: [CONFIG.sinks[0]!], states: ['solved'] }, '9-0', NOW + 20);

    const got = await store.get(ALICE);
    expect(got?.sinks).toEqual([CONFIG.sinks[0]]);
    expect(got?.states).toEqual(['solved']);
    expect(got?.cursor).toBe('9-0');
    // A subject who fixed their broken webhook must not stay muted.
    expect(got?.failures).toBe(0);
    expect(got?.mutedUntil).toBe(0);
    expect(got?.hourCount).toBe(0);
    expect(await store.owners()).toEqual([ALICE]);
  });

  it('advance writes only the bookkeeping, never the sinks', async () => {
    await store.put(ALICE, CONFIG, '0-0', NOW);
    await store.advance(ALICE, {
      cursor: '12-3',
      lastDeliveryAt: NOW + 5,
      failures: 0,
      mutedUntil: 0,
      hourStart: NOW,
      hourCount: 1,
    });
    const got = await store.get(ALICE);
    expect(got?.cursor).toBe('12-3');
    expect(got?.hourCount).toBe(1);
    expect(got?.sinks).toEqual(CONFIG.sinks);
    expect(got?.createdAt).toBe(NOW);
  });

  it('remove drops the hash and the index entry, and is idempotent', async () => {
    await store.put(ALICE, CONFIG, '0-0', NOW);
    await store.remove(ALICE);
    expect(await store.get(ALICE)).toBeNull();
    expect(await store.owners()).toEqual([]);
    await store.remove(ALICE); // a second DELETE must still be a 204, not a 500
  });

  it('reads an absent or unreadable hash as absent, so one bad key cannot stop the sweep', async () => {
    expect(await store.get(ALICE)).toBeNull();
    await fake.redis.hSet(notifyConfigKey(ALICE), { v: '1', sinks: 'not json', states: 'paused' });
    expect(await store.get(ALICE)).toBeNull();
    await fake.redis.hSet(notifyConfigKey(BOB), { v: '2', sinks: '[]', states: 'paused' });
    expect(await store.get(BOB)).toBeNull(); // a future schema version is not guessed at
  });

  it('turns a transport failure into 503, never 500', async () => {
    const boom = new NotifyStore({
      ...fake.redis,
      hGetAll: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(boom.get(ALICE)).rejects.toMatchObject({ code: 'redis_unavailable' });
  });
});
