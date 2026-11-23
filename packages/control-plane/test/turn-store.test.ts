import { expect, it } from 'vitest';
import { TurnStore } from '../src/turn-store.js';
import {
  EVENTS_MAXLEN,
  ownerEventsKey,
  sessionTurnsKey,
  turnKey,
  type TurnRecord,
} from '../src/turn-record.js';
import { leafResultKey } from '../src/turn-result.js';
import { fakeRedis } from './helpers/fake-redis.js';
import { turnStoreContract } from './helpers/turn-store-contract.js';

const resultTtlSeconds = 86_400;
const ttlMarginSeconds = 3_600;

// The fake records every `expire` call rather than simulating one; the last call for a key is its
// current TTL, and no call at all means it carries none (§5.1).
const lastExpire = (expires: { key: string; seconds: number }[], key: string): number => {
  const forKey = expires.filter((e) => e.key === key);
  return forKey.length ? forKey[forKey.length - 1]!.seconds : -1;
};

turnStoreContract('fake', async () => {
  const { redis, strings, expires, zsets } = fakeRedis();
  return {
    store: new TurnStore(redis, { resultTtlSeconds, ttlMarginSeconds }),
    now: 1_757_000_000_000,
    resultTtlSeconds,
    ttlMarginSeconds,
    ttlOf: async (turnId: string) => lastExpire(expires, turnKey(turnId)),
    ttlOfSession: async (sessionId: string) => lastExpire(expires, sessionTurnsKey(sessionId)),
    ttlOfEvents: async (owner: string) => lastExpire(expires, ownerEventsKey(owner)),
    indexedTurns: async (sessionId: string) =>
      (zsets.get(sessionTurnsKey(sessionId)) ?? []).map((m) => m.value),
    // No key tag to work around here: this fake's keyspace is one Map per store.
    sessionId: 's-1',
    putResult: async (sessionId: string, turnId: string, body: string) => {
      strings.set(leafResultKey(sessionId, turnId), body);
    },
    hasResult: async (sessionId: string, turnId: string) =>
      strings.has(leafResultKey(sessionId, turnId)),
    done: async () => undefined,
  };
});

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't-pre',
  owner: 'github:1234',
  tenant: 'github:1234',
  sessionId: 's-1',
  cfg: '',
  credentialName: 'anthropic',
  model: '',
  sandboxTier: '',
  caps: {},
  idempotencyKey: 's-1',
  envelope: {},
  state: 'queued',
  attempts: 0,
  createdAt: 1,
  ...over,
});

it('reaches a turn that has NO index entry through the owner set', async () => {
  const { redis, zsets } = fakeRedis();
  const store = new TurnStore(redis, { resultTtlSeconds, ttlMarginSeconds });
  await store.create(rec());
  // A record written before #390: its hash and open-set member exist, its index entry does not.
  // Such a turn is OPEN, so it carries no TTL at all -- dropping the owner-set pass in favour of
  // the index alone would leak its hash and its owner's quota slot for the deployment's lifetime.
  zsets.delete(sessionTurnsKey('s-1'));

  await store.deleteSessionTurns('s-1', 'github:1234');
  expect(await store.get('t-pre')).toBeNull();
  expect(await store.countOpen('github:1234')).toBe(0);
});

// The gate index (#393 §3). Its members are added by `toTerminal` on `paused` alone, so every case
// below finalizes a real record rather than writing the zset directly.
const gateStore = () => {
  const { redis } = fakeRedis();
  const store = new TurnStore(redis, { resultTtlSeconds, ttlMarginSeconds });
  const pause = async (turnId: string, gateDeadlineS?: number) => {
    await store.create(rec({ turnId, ...(gateDeadlineS ? { gateDeadlineS } : {}) }));
    await store.finalize(turnId, 'paused', 1_000);
  };
  return { store, pause };
};

it('indexes a paused turn with a deadline, and nothing else', async () => {
  const { store, pause } = gateStore();
  await pause('t-dl', 60);
  await pause('t-nodl');
  await store.create(rec({ turnId: 't-done', gateDeadlineS: 60 }));
  await store.finalize('t-done', 'responded', 1_000);
  expect(await store.dueGates(1_000 + 60_000)).toEqual(['t-dl']);
});

it('does not report a gate before its deadline', async () => {
  const { pause, store } = gateStore();
  await pause('t-dl', 60);
  expect(await store.dueGates(1_000 + 59_999)).toEqual([]);
});

it('claimGate is a CAS: exactly one caller wins', async () => {
  const { pause, store } = gateStore();
  await pause('t-dl', 60);
  const [a, b] = await Promise.all([store.claimGate('t-dl'), store.claimGate('t-dl')]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(await store.dueGates(1_000 + 60_000)).toEqual([]);
});

it('reports due gates oldest first', async () => {
  const { pause, store } = gateStore();
  await pause('t-late', 600);
  await pause('t-soon', 60);
  expect(await store.dueGates(1_000 + 600_000)).toEqual(['t-soon', 't-late']);
});

it('reports the OLDEST gates when more are due than the limit', async () => {
  // The sweep pages: taking the newest `limit` instead would starve the gates that waited longest,
  // which are the ones a deadline exists for.
  const { pause, store } = gateStore();
  for (const s of [600, 60, 300]) await pause(`t-${s}`, s);
  expect(await store.dueGates(1_000 + 600_000, 2)).toEqual(['t-60', 't-300']);
});

it('deleting the session clears its gates', async () => {
  const { pause, store } = gateStore();
  await pause('t-dl', 60);
  await store.deleteSessionTurns('s-1', 'github:1234');
  expect(await store.dueGates(1_000 + 60_000)).toEqual([]);
});

// Fake-only: `XADD MAXLEN ~` is APPROXIMATE in real Redis, so an exact bound asserted against it
// would be a flake. The fake trims exactly, which is what makes the bound observable at all.
it('bounds the owner event log to EVENTS_MAXLEN', async () => {
  const { redis } = fakeRedis();
  const store = new TurnStore(redis, { resultTtlSeconds: 10, ttlMarginSeconds: 1 });
  for (let i = 0; i < EVENTS_MAXLEN + 5; i++) {
    await store.create(rec({ turnId: `t-${i}` }));
  }
  expect((await store.readEvents('github:1234', '0-0', 10_000)).length).toBe(EVENTS_MAXLEN);
});
