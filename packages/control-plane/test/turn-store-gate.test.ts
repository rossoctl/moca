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

  it('does not count a FAILED resume as having answered the gate', async () => {
    // `submitResume` compensates a failed enqueue by finalizing the record it already created, and
    // that record keeps its `resumeOf`. Counting it would report the gate answered while nothing
    // ever ran it: the human retry would get 409 `gate_not_pending` and the gate would be stranded.
    await store.create({ ...base, turnId: 't-40', createdAt: 1000 });
    await store.finalize('t-40', 'paused', 2000);
    await store.create({ ...base, turnId: 't-41', createdAt: 3000, resumeOf: 't-40' });
    await store.finalize('t-41', 'failed', 4000);
    const found = await store.findPausedBySession(base.sessionId);
    expect(found?.paused.turnId).toBe('t-40');
    expect(found?.resumed).toBe(false);
  });

  it('releaseGate puts a claimed gate back at its own deadline', async () => {
    await store.create({ ...base, turnId: 't-50', gateDeadlineS: 60 });
    await store.finalize('t-50', 'paused', 1_000);
    expect(await store.claimGate('t-50')).toBe(true);
    expect(await store.dueGates(61_000)).toEqual([]);
    await store.releaseGate('t-50', 61_000);
    expect(await store.dueGates(61_000)).toEqual(['t-50']);
    // And not before it: the hand-back must not turn a deadline into an immediate one.
    expect(await store.dueGates(60_999)).toEqual([]);
  });

  it('pages gates due in the same millisecond in a stable order', async () => {
    // Real Redis breaks a score tie BY MEMBER, and the fake now does too -- so a bounded `dueGates`
    // page cannot come out in insertion order here and in member order in production.
    for (const turnId of ['t-b', 't-a']) {
      await store.create({ ...base, turnId, gateDeadlineS: 60 });
      await store.finalize(turnId, 'paused', 1_000);
    }
    expect(await store.dueGates(61_000)).toEqual(['t-a', 't-b']);
    expect(await store.dueGates(61_000, 1)).toEqual(['t-a']);
  });

  it('answers null for a session with no paused turn', async () => {
    await store.create({ ...base, turnId: 't-30' });
    expect(await store.findPausedBySession(base.sessionId)).toBeNull();
  });
});
