import { expect, it } from 'vitest';
import { TurnStore } from '../src/turn-store.js';
import { sessionTurnsKey, turnKey, type TurnRecord } from '../src/turn-record.js';
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
