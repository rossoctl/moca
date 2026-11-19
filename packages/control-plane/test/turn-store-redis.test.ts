import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { TurnStore } from '../src/turn-store.js';
import { sessionTurnsKey, turnKey, type TurnRecord } from '../src/turn-record.js';
import { leafResultKey } from '../src/turn-result.js';
import type { CpRedisLike } from '../src/ownership.js';
import { turnStoreContract } from './helpers/turn-store-contract.js';

const resultTtlSeconds = 86_400;
const ttlMarginSeconds = 3_600;

// Needs Redis on 6379, as sandbox-redis.test.ts and refresh-redis.test.ts do; CI provides a redis:7
// service. The contract suite's TTL and set-membership rules are exactly the ones a fake can get
// wrong, so they are asserted against the real thing too.
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
  await client.connect();
});

afterAll(async () => {
  await client.destroy();
});

/**
 * One prefixed keyspace per make(), deleted by done(). The store's keys are absolute
 * (`sh:cp:turn:...`), so isolation comes from unique turn ids and subjects rather than a key prefix:
 * each make() mints its own suffix and `done()` deletes every key that mentions it.
 */
async function isolated() {
  const tag = `${process.pid}:${randomUUID()}`;
  return {
    store: new TurnStore(client as unknown as CpRedisLike, {
      resultTtlSeconds,
      ttlMarginSeconds,
      keyTag: tag,
    }),
    now: Date.now(),
    resultTtlSeconds,
    ttlMarginSeconds,
    // Observes the exact key the store wrote: the same `${id}:${tag}` suffix `TurnStore.tag()`
    // applies internally, wrapped in the same `turnKey()` the store uses.
    ttlOf: async (turnId: string) => client.ttl(turnKey(`${turnId}:${tag}`)),
    ttlOfSession: async (sessionId: string) => client.ttl(sessionTurnsKey(`${sessionId}:${tag}`)),
    indexedTurns: async (sessionId: string) =>
      client.zRange(sessionTurnsKey(`${sessionId}:${tag}`), 0, -1),
    // The tag is IN the session id, not appended by the store: `leafResultKey` is untagged, so this
    // is what puts the results below inside `done()`'s sweep.
    sessionId: `s-${tag}`,
    putResult: async (sessionId: string, turnId: string, body: string) => {
      await client.set(leafResultKey(sessionId, turnId), body);
    },
    hasResult: async (sessionId: string, turnId: string) =>
      (await client.exists(leafResultKey(sessionId, turnId))) === 1,
    done: async () => {
      const keys = await client.keys(`*${tag}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

turnStoreContract('redis', isolated);

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't-race',
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

/**
 * The races the CAS exists for, against real Redis -- NOT in the contract suite, because what is
 * being tested is that two interleaved transitions land on ONE server. Both tests lean on node-redis
 * issuing every command for a client in call order on one socket: the two transitions' reads are
 * both on the wire before either write, which is exactly the get-then-write gap `CAS_STATE_LUA`
 * closes. Without it both tests pass twice over -- two winners, two terminal writes.
 */
describe('TurnStore CAS races (redis)', () => {
  it('lets exactly ONE of two concurrent finalizes win', async () => {
    const { store, now, done } = await isolated();
    await store.create(rec());
    // Both read `queued`; the second's write must be refused, or both would release the idempotency
    // key and both would re-arm the TTL on a record the other had already made terminal.
    const outcomes = await Promise.all([
      store.finalize('t-race', 'done', now),
      store.finalize('t-race', 'failed', now + 1),
    ]);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes).toEqual(['ok', 'refused']);
    expect((await store.get('t-race'))?.state).toBe('done');
    // The winner alone removed the open-set member, so the quota slot is freed exactly once.
    expect(await store.countOpen('github:1234')).toBe(0);
    await done();
  });

  it('turns a cancel that raced a claim into a cancel REQUEST, not a refusal', async () => {
    const { store, now, done } = await isolated();
    await store.create(rec({ turnId: 't-cancel' }));
    // `cancel` is started FIRST, so its HGETALL is on the wire before `markRunning`'s EVAL: it reads
    // `queued` and then tries to write a record that has since gone `running`. The CAS catches that
    // -- without it the turn would read `cancelled` while a worker was running it, which §4.5
    // forbids -- and the second pass then re-reads and takes the running path. A 409 here would be a
    // lie the caller is meant to stop on: the turn is cancellable, it just started a millisecond ago.
    const [cancelled, claim] = await Promise.all([
      store.cancel('t-cancel', now),
      store.markRunning('t-cancel', 1),
    ]);
    expect(claim).toBe('ok');
    expect(cancelled).toBe('cancelling');
    expect((await store.get('t-cancel'))?.state).toBe('running');
    expect(await store.cancelRequested('t-cancel')).toBe(true);
    await done();
  });
});
