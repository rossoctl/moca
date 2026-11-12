import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processOne, type LeafJobDeps } from '../src/leaf-job-runner.js';
import type { ClaimedEntry, WorkQueue } from '@moca/work-queue';
import type { LeafEnvelope, LeafResult } from '../src/run-leaf.js';
import type { TurnConfig } from '../src/run-turn.js';

const ENV = {
  sessionId: 'c0ffee00-0000-4000-8000-000000000001',
  prompt: 'go',
  owner: 'alice',
} as unknown as LeafEnvelope;

const CONFIG = { redisUrl: 'redis://127.0.0.1:6379', serverMode: true } as unknown as TurnConfig;

class FakeQueue implements WorkQueue {
  next: ClaimedEntry | null = null;
  acked: string[] = [];
  touched: string[] = [];
  /** Set false to play a heartbeat that finds the entry reclaimed by another worker. */
  stillOwned = true;
  async ensureGroup() {}
  async claim() {
    const n = this.next;
    this.next = null;
    return n;
  }
  async ack(id: string) {
    this.acked.push(id);
  }
  async touch(id: string) {
    this.touched.push(id);
    return this.stillOwned;
  }
  async pending() {
    return 0;
  }
  async depth() {
    return { depth: 0, oldestAgeMs: 0 };
  }
  async deleteConsumer() {}
  async gcIdleConsumers() {
    return 0;
  }
  async reapDeadLetters() {
    return [];
  }
}

let queue: FakeQueue;
let store: Map<string, string>;
let finalized: Array<[string, string]>;
let deadLettered: string[];
let heartbeats: Array<() => void>;

function deps(over: Partial<LeafJobDeps> = {}): LeafJobDeps {
  return {
    queue,
    consumerId: 'moca-host-w0',
    claimTurn: async () => ({ envelope: ENV, sessionId: 'sess-1', attempts: 1, config: CONFIG }),
    runLeaf: async () => ({ status: 'done' }) as LeafResult,
    finalize: async (turnId, status) => {
      finalized.push([turnId, status]);
    },
    deadLetter: async (turnId) => {
      deadLettered.push(turnId);
    },
    resultStore: {
      set: async (k: string, v: string) => void store.set(k, v),
      get: async (k: string) => store.get(k) ?? null,
    },
    ttlSeconds: 60,
    now: () => '2026-11-10T00:00:00.000Z',
    setHeartbeat: (fn) => {
      heartbeats.push(fn);
      return heartbeats.length - 1;
    },
    clearHeartbeat: () => {},
    ...over,
  };
}

beforeEach(() => {
  queue = new FakeQueue();
  store = new Map();
  finalized = [];
  deadLettered = [];
  heartbeats = [];
});

const entry = (over: Partial<ClaimedEntry> = {}): ClaimedEntry => ({
  entryId: '1-0',
  turnId: 't-1',
  deliveryCount: 1,
  reclaimed: false,
  ...over,
});

describe('processOne', () => {
  it('is idle when there is nothing to claim', async () => {
    expect(await processOne(deps())).toEqual({ kind: 'idle' });
  });

  it('runs the leaf, writes the result under the TURN session id and turn id, finalizes, acks', async () => {
    queue.next = entry();
    const out = await processOne(deps());
    expect(out).toEqual({ kind: 'completed', turnId: 't-1', status: 'done', reclaimed: false });
    expect([...store.keys()]).toEqual(['leaf:result:sess-1:t-1']);
    expect(finalized).toEqual([['t-1', 'done']]);
    expect(queue.acked).toEqual(['1-0']);
  });

  it('keys two turns on one session apart, so neither overwrites the other (§4.3)', async () => {
    queue.next = entry({ entryId: '1-0', turnId: 't-1' });
    await processOne(deps());
    queue.next = entry({ entryId: '2-0', turnId: 't-2' });
    await processOne(deps());
    expect([...store.keys()].sort()).toEqual(['leaf:result:sess-1:t-1', 'leaf:result:sess-1:t-2']);
  });

  it('records the envelope session id on the result for caller correlation', async () => {
    queue.next = entry();
    await processOne(deps());
    const rec = JSON.parse(store.get('leaf:result:sess-1:t-1')!);
    expect(rec.sessionId).toBe(ENV.sessionId);
    expect(rec.status).toBe('done');
  });

  it('reports reclaimed so the loop can count a redelivery', async () => {
    queue.next = entry({ reclaimed: true, deliveryCount: 2 });
    expect(await processOne(deps())).toMatchObject({ kind: 'completed', reclaimed: true });
  });

  it('passes the delivery count to the claim so attempts is stamped from it', async () => {
    queue.next = entry({ deliveryCount: 3 });
    const claimTurn = vi.fn(async () => ({
      envelope: ENV,
      sessionId: 'sess-1',
      attempts: 3,
      config: CONFIG,
    }));
    await processOne(deps({ claimTurn }));
    expect(claimTurn).toHaveBeenCalledWith('t-1', 3);
  });

  it('runs the leaf with the config from THIS claim, not a loop-wide one', async () => {
    queue.next = entry();
    const runLeaf = vi.fn(async () => ({ status: 'done' }) as LeafResult);
    await processOne(deps({ runLeaf }));
    expect(runLeaf).toHaveBeenCalledWith(ENV, CONFIG);
  });

  it('dead-letters past maxAttempts without claiming a credential or running the leaf', async () => {
    queue.next = entry({ deliveryCount: 4 });
    const claimTurn = vi.fn();
    const runLeaf = vi.fn();
    const out = await processOne(deps({ claimTurn, runLeaf, maxAttempts: 3 }));
    expect(out).toEqual({ kind: 'dead_lettered', turnId: 't-1', reclaimed: false });
    expect(claimTurn).not.toHaveBeenCalled();
    expect(runLeaf).not.toHaveBeenCalled();
    expect(deadLettered).toEqual(['t-1']);
    expect(queue.acked).toEqual(['1-0']);
  });

  it('acks and drops a malformed entry with no turn id', async () => {
    queue.next = entry({ turnId: '' });
    const out = await processOne(deps());
    expect(out).toEqual({ kind: 'dead_lettered', turnId: '', reclaimed: false });
    expect(deadLettered).toEqual([]); // no record to finalize
    expect(queue.acked).toEqual(['1-0']);
  });

  it('reports reclaimed on a dead letter too: a reclaimed entry that dies is the signal', async () => {
    queue.next = entry({ deliveryCount: 4, reclaimed: true });
    const out = await processOne(deps({ maxAttempts: 3 }));
    expect(out).toMatchObject({ kind: 'dead_lettered', reclaimed: true });
  });

  it('acks and refuses when the turn is cancelled or already terminal', async () => {
    queue.next = entry();
    const runLeaf = vi.fn();
    const out = await processOne(deps({ claimTurn: async () => null, runLeaf }));
    expect(out).toEqual({ kind: 'refused', turnId: 't-1', reclaimed: false });
    expect(runLeaf).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(finalized).toEqual([]);
    expect(queue.acked).toEqual(['1-0']); // not left pending: re-reading it forever is the bug
  });

  it('redelivers a retryable failure with no result, no finalize and no ack', async () => {
    queue.next = entry();
    const runLeaf = async () => ({ status: 'failed', reason: 'saturated' }) as LeafResult;
    const out = await processOne(deps({ runLeaf }));
    expect(out).toEqual({ kind: 'redelivered', turnId: 't-1', reclaimed: false });
    expect(store.size).toBe(0);
    expect(finalized).toEqual([]);
    expect(queue.acked).toEqual([]);
  });

  it('completes a non-retryable failure: result, finalize, ack', async () => {
    queue.next = entry();
    const runLeaf = async () => ({ status: 'failed', reason: 'bad_inputs' }) as LeafResult;
    const out = await processOne(deps({ runLeaf }));
    expect(out).toMatchObject({ kind: 'completed', status: 'failed' });
    expect(finalized).toEqual([['t-1', 'failed']]);
    expect(queue.acked).toEqual(['1-0']);
  });

  it('writes the result before finalizing, so no terminal record lacks a result', async () => {
    queue.next = entry();
    const order: string[] = [];
    const d = deps({
      resultStore: {
        set: async (k: string, v: string) => {
          order.push('result');
          store.set(k, v);
        },
        get: async () => null,
      },
      finalize: async () => void order.push('finalize'),
    });
    await processOne(d);
    expect(order).toEqual(['result', 'finalize']);
  });

  it('touches the entry on each heartbeat tick while the leaf runs', async () => {
    queue.next = entry();
    await processOne(deps());
    expect(heartbeats).toHaveLength(1);
    heartbeats[0]!();
    await Promise.resolve();
    expect(queue.touched).toEqual(['1-0']);
  });

  // `touch` refuses to steal an entry back once another worker has reclaimed it, so a false return
  // means this leaf is a duplicate. Nothing can abort runLeaf, so the log is the only trace.
  it('logs loudly when a heartbeat finds the entry no longer this worker s', async () => {
    queue.next = entry();
    queue.stillOwned = false;
    const log = vi.fn();
    await processOne(deps({ log }));
    heartbeats[0]!();
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    expect(log.mock.calls.flat().join(' ')).toContain('1-0');
  });

  // The duplicate's output must not reach the owner's turn: the result SET is unconditional (so
  // finishing second would pair the owner's `done` with this body), and XACK takes no consumer (so
  // acking would retire the OWNER's pending entry and with it the redelivery that covers its death).
  it('discards a run whose entry was reclaimed mid-leaf: no result, no finalize, no ack', async () => {
    queue.next = entry();
    queue.stillOwned = false;
    const out = await processOne(
      deps({
        log: vi.fn(),
        // The beat the real loop fires on its timer, fired from inside the leaf instead: the loss
        // has to be discovered while runLeaf is still running for the flag to matter.
        runLeaf: async () => {
          heartbeats[0]!();
          for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
          return { status: 'done' } as LeafResult;
        },
      }),
    );
    expect(out).toEqual({ kind: 'lost', turnId: 't-1', reclaimed: false });
    expect([...store.keys()]).toEqual([]);
    expect(finalized).toEqual([]);
    expect(queue.acked).toEqual([]);
  });

  it('says nothing on a heartbeat that still owns the entry', async () => {
    queue.next = entry();
    const log = vi.fn();
    await processOne(deps({ log }));
    heartbeats[0]!();
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    expect(log).not.toHaveBeenCalled();
  });

  it('swallows a touch rejection on a heartbeat tick: a destroyed-client heartbeat must not kill the process', async () => {
    // Reproduces stop() racing an in-flight leaf: the queue client can be destroyed while this
    // leaf's heartbeat is still armed, so the next tick's touch() rejects ClientClosedError. The
    // tick is a bare `void`, so an unguarded rejection here becomes an unhandled rejection, which
    // ends the process under Node's default --unhandled-rejections=throw -- taking down healthy
    // sync traffic with it. A missed touch is safe to swallow: the entry simply becomes
    // reclaimable after minIdleMs.
    queue.next = entry();
    queue.touch = async () => {
      throw new Error('ClientClosedError: The client is closed');
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await processOne(deps());
      expect(heartbeats).toHaveLength(1);
      heartbeats[0]!();
      // Flush several microtask turns: an unguarded rejection surfaces as 'unhandledRejection'
      // once nothing has attached a handler by the end of the current tick.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('clears the heartbeat and rethrows when the leaf throws, leaving the entry pending', async () => {
    queue.next = entry();
    const clearHeartbeat = vi.fn();
    const runLeaf = async () => {
      throw new Error('sandbox gone');
    };
    await expect(processOne(deps({ runLeaf, clearHeartbeat }))).rejects.toThrow('sandbox gone');
    expect(clearHeartbeat).toHaveBeenCalledTimes(1);
    expect(queue.acked).toEqual([]);
    expect(store.size).toBe(0);
  });
});
