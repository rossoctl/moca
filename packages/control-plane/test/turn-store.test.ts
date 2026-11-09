import { TurnStore } from '../src/turn-store.js';
import { fakeRedis } from './helpers/fake-redis.js';
import { turnStoreContract } from './helpers/turn-store-contract.js';

turnStoreContract('fake', async () => ({
  store: new TurnStore(fakeRedis().redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 }),
  now: 1_757_000_000_000,
  done: async () => undefined,
}));
