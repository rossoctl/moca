import { beforeEach, describe, expect, it } from 'vitest';
import { TurnStore } from '../src/turn-store.js';
import type { TurnRecord } from '../src/turn-record.js';
import { fakeRedis } from './helpers/fake-redis.js';

const resultTtlSeconds = 86_400;
const ttlMarginSeconds = 3_600;

const base: TurnRecord = {
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
};

// The fake, not real Redis: `findPausedBySession` needs only `zRange` REV BY SCORE with a LIMIT,
// which the fake serves, and the store's own contract suite already pins it against both.
describe('a gate resume on the record and the store (#393)', () => {
  let store: TurnStore;
  beforeEach(() => {
    store = new TurnStore(fakeRedis().redis, { resultTtlSeconds, ttlMarginSeconds });
  });

  it('round-trips resumeOf', async () => {
    await store.create({ ...base, turnId: 't-2', resumeOf: 't-1' });
    expect(await store.get('t-2')).toMatchObject({ resumeOf: 't-1' });
  });

  it('omits resumeOf when the record has none', async () => {
    await store.create({ ...base, turnId: 't-3' });
    expect('resumeOf' in (await store.get('t-3'))!).toBe(false);
  });

  it('finds the session newest paused turn', async () => {
    await store.create({ ...base, turnId: 't-10', createdAt: 1000 });
    await store.create({ ...base, turnId: 't-11', createdAt: 2000 });
    await store.finalize('t-11', 'paused', 3000);
    const found = await store.findPausedBySession(base.sessionId);
    expect(found?.paused.turnId).toBe('t-11');
    expect(found?.resumed).toBe(false);
  });

  it('reports a paused turn that a later turn already resumed', async () => {
    await store.create({ ...base, turnId: 't-20', createdAt: 1000 });
    await store.finalize('t-20', 'paused', 2000);
    await store.create({ ...base, turnId: 't-21', createdAt: 3000, resumeOf: 't-20' });
    const found = await store.findPausedBySession(base.sessionId);
    expect(found?.paused.turnId).toBe('t-20');
    expect(found?.resumed).toBe(true);
  });

  it('answers null for a session with no paused turn', async () => {
    await store.create({ ...base, turnId: 't-30' });
    expect(await store.findPausedBySession(base.sessionId)).toBeNull();
  });
});
