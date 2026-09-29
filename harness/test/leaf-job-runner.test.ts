// harness/test/leaf-job-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processOne, type LeafJobDeps } from '../src/leaf-job-runner';
import type { ClaimedEntry, WorkQueue } from '@moca/work-queue';
import type { LeafEnvelope } from '../src/run-leaf';
import type { RedisLike, LeafResultRecord } from '../src/leaf-result-store';

function fakeQueue(
  claimed: ClaimedEntry | null,
): WorkQueue & { acked: string[]; touched: string[] } {
  const acked: string[] = [];
  const touched: string[] = [];
  return {
    acked,
    touched,
    ensureGroup: async () => {},
    enqueue: async () => '1-0',
    claim: async () => claimed,
    ack: async (id: string) => {
      acked.push(id);
    },
    touch: async (id: string) => {
      touched.push(id);
    },
    pending: async () => 0,
    // processOne drives none of these three -- the consumer lifecycle lives in
    // knative-server/src/leaf-job.ts -- but WorkQueue requires them, and they were missing
    // from this fake until harness/test came under the typechecker (#190). Throwing rather
    // than no-op: if processOne ever does reach one, that should fail here loudly instead of
    // quietly succeeding against a stub that does nothing.
    deleteConsumer: async () => {
      throw new Error('fakeQueue.deleteConsumer: not exercised by processOne');
    },
    gcIdleConsumers: async () => {
      throw new Error('fakeQueue.gcIdleConsumers: not exercised by processOne');
    },
    reapDeadLetters: async () => {
      throw new Error('fakeQueue.reapDeadLetters: not exercised by processOne');
    },
    purge: async () => {},
    close: async () => {},
  };
}

function fakeStore() {
  const m = new Map<string, string>();
  const store: RedisLike = {
    async set(k, v) {
      m.set(k, v);
    },
    async get(k) {
      return m.get(k) ?? null;
    },
  };
  return {
    store,
    get: (id: string) => {
      const r = m.get(`leaf:result:${id}`);
      return r ? (JSON.parse(r) as LeafResultRecord) : null;
    },
  };
}

// Inline envelope shape: sessionId "run/i1" → leafSessionId sanitizes slash→dash → "run-i1"
const ENV: LeafEnvelope = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };

function baseDeps(over: Partial<LeafJobDeps>): LeafJobDeps {
  const { store } = fakeStore();
  return {
    queue: fakeQueue(null),
    runLeaf: async () => ({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    }),
    resultStore: store,
    ttlSeconds: 3600,
    consumerId: 'w1',
    now: () => 't',
    setHeartbeat: () => 0,
    clearHeartbeat: () => {},
    ...over,
  };
}

describe('processOne', () => {
  it('returns idle and does nothing when the queue is empty', async () => {
    const q = fakeQueue(null);
    const r = await processOne(baseDeps({ queue: q }));
    expect(r).toBe('idle');
    expect(q.acked).toEqual([]);
  });

  it('dead-letters (failed record + ack, runLeaf NOT called) past maxAttempts', async () => {
    const q = fakeQueue({ entryId: '9-0', envelope: ENV, deliveryCount: 4 });
    const runLeaf = vi.fn();
    const { store, get } = fakeStore();
    const r = await processOne(
      baseDeps({ queue: q, runLeaf: runLeaf as any, maxAttempts: 3, resultStore: store }),
    );
    expect(r).toBe('deadletter');
    expect(runLeaf).not.toHaveBeenCalled();
    expect(get('run-i1')).toMatchObject({ status: 'failed', reason: 'error' });
    expect(q.acked).toEqual(['9-0']);
  });

  it('writes a done record and acks', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const outcome = await processOne(
      baseDeps({
        queue: q,
        resultStore: store,
        runLeaf: async () => ({
          status: 'done',
          verdict: { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' },
        }),
      }),
    );
    expect(outcome).toBe('done');
    expect(get('run-i1')).toMatchObject({ status: 'done', sessionId: 'run/i1' });
    expect(q.acked).toEqual(['1-0']);
  });

  it('deterministic failure → failed record + ack', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const r = await processOne(
      baseDeps({
        queue: q,
        resultStore: store,
        runLeaf: async () => ({ status: 'failed', reason: 'bad_inputs' }),
      }),
    );
    expect(r).toBe('failed');
    expect(get('run-i1')).toMatchObject({ status: 'failed', reason: 'bad_inputs' });
    expect(q.acked).toEqual(['1-0']);
  });

  it('paused → acks, writes paused record, returns paused', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const r = await processOne(
      baseDeps({
        queue: q,
        resultStore: store,
        runLeaf: async () => ({
          status: 'paused',
          gateId: 0,
          gate: { summary: 's', proposed_action: 'a' },
        }),
      }),
    );
    expect(r).toBe('paused');
    expect(get('run-i1')).toMatchObject({ status: 'paused' });
    expect(q.acked).toEqual(['1-0']);
  });

  it('aborted → writes aborted record + ack, returns aborted', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const r = await processOne(
      baseDeps({ queue: q, resultStore: store, runLeaf: async () => ({ status: 'aborted' }) }),
    );
    expect(r).toBe('aborted');
    expect(get('run-i1')).toMatchObject({ status: 'aborted' });
    expect(q.acked).toEqual(['1-0']);
  });

  it('responded → writes a record + ack, returns responded', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const r = await processOne(
      baseDeps({
        queue: q,
        resultStore: store,
        runLeaf: async () => ({ status: 'responded', text: 'hi' }),
      }),
    );
    expect(r).toBe('responded');
    // A result record is written and the entry is acked (a prompt leaf is a terminal success).
    // The persisted record's shape for "responded" is leaf-result-store's concern (a later task);
    // here we only assert the runner's ack + return behavior.
    expect(get('run-i1')).not.toBeNull();
    expect(q.acked).toEqual(['1-0']);
  });

  it('does not write a record and does not ack on transient error (retry)', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const { store, get } = fakeStore();
    const outcome = await processOne(
      baseDeps({
        queue: q,
        resultStore: store,
        runLeaf: async () => ({ status: 'failed', reason: 'error' }),
      }),
    );
    expect(outcome).toBe('retry');
    expect(get('run-i1')).toBeNull();
    expect(q.acked).toEqual([]);
  });

  it('schedules and clears a heartbeat around the run', async () => {
    const q = fakeQueue({ entryId: '1-0', envelope: ENV, deliveryCount: 1 });
    const set = vi.fn(() => 42);
    const clear = vi.fn();
    await processOne(
      baseDeps({ queue: q, setHeartbeat: set as any, clearHeartbeat: clear as any }),
    );
    expect(set).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(42);
  });
});
