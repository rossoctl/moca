import { TurnStore } from '../src/turn-store.js';
import { turnKey } from '../src/turn-record.js';
import { fakeRedis } from './helpers/fake-redis.js';
import { turnStoreContract } from './helpers/turn-store-contract.js';

const resultTtlSeconds = 86_400;
const ttlMarginSeconds = 3_600;

turnStoreContract('fake', async () => {
  const { redis, expires } = fakeRedis();
  return {
    store: new TurnStore(redis, { resultTtlSeconds, ttlMarginSeconds }),
    now: 1_757_000_000_000,
    resultTtlSeconds,
    ttlMarginSeconds,
    // The fake records every `expire` call rather than simulating one; the last call for this
    // key is its current TTL, and no call at all means the record carries none (§5.1).
    ttlOf: async (turnId: string) => {
      const forKey = expires.filter((e) => e.key === turnKey(turnId));
      return forKey.length ? forKey[forKey.length - 1]!.seconds : -1;
    },
    done: async () => undefined,
  };
});
