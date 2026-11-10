import { afterAll, beforeAll } from 'vitest';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { TurnStore } from '../src/turn-store.js';
import { turnKey } from '../src/turn-record.js';
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
    done: async () => {
      const keys = await client.keys(`*${tag}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

turnStoreContract('redis', isolated);
