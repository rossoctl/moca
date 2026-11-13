import { createServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { RedisWorkQueue } from '@moca/work-queue';

/**
 * S1: captures every client `armAsyncLeafWorker` builds, after the same wrapper
 * `runtime-reporter-redis-errors.test.ts` uses, so the test can assert the queue and the turn store
 * each got their own connection without reaching into the module's private state.
 */
const created = vi.hoisted(() => [] as { isOpen: boolean; destroy: () => void }[]);
vi.mock('redis', async (importOriginal) => {
  const real = await importOriginal<typeof import('redis')>();
  return {
    ...real,
    createClient: (...args: Parameters<typeof real.createClient>) => {
      const c = real.createClient(...args);
      created.push(c as never);
      return c;
    },
  };
});
const {
  armAsyncReaper,
  armAsyncLeafWorker,
  asyncConsumerId,
  asyncFinalizeState,
  ASYNC_REAP_INTERVAL_MS,
  ASYNC_DEPTH_INTERVAL_MS,
  reconnecting,
  createAsyncTally,
} = await import('../src/async-worker.js');

/** A port nothing listens on: a real socket target, with no real Redis needed. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnecting', () => {
  it('M2: re-arms before the call when the client is !isOpen', async () => {
    let isOpen = false;
    const connect = vi.fn(async () => {
      isOpen = true;
    });
    const client = {
      get isOpen() {
        return isOpen;
      },
      connect,
    };
    const target = { greet: async (name: string) => `hi ${name}` };
    const wrapped = reconnecting(target, client as never);

    await expect(wrapped.greet('a')).resolves.toBe('hi a');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm when the client is already open', async () => {
    const connect = vi.fn(async () => undefined);
    const client = { isOpen: true, connect };
    const target = { greet: async (name: string) => `hi ${name}` };
    const wrapped = reconnecting(target, client as never);

    await expect(wrapped.greet('a')).resolves.toBe('hi a');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('asyncConsumerId', () => {
  it('is moca-<host>-w<worker id>', () => {
    expect(asyncConsumerId({ HOSTNAME: 'vm-1', SH_WORKER_ID: '3' })).toBe('moca-vm-1-w3');
  });
  it('falls back to the supervisor pid where HOSTNAME is unset (systemd)', () => {
    expect(asyncConsumerId({ SH_WORKER_ID: '3' })).toBe(`moca-${process.ppid}-w3`);
  });
  it('falls back to w0 rather than an empty id: two consumers sharing a name never go stale', () => {
    expect(asyncConsumerId({ HOSTNAME: 'vm-1' })).toBe('moca-vm-1-w0');
  });
  it('gives two workers on one host different identities', () => {
    const a = asyncConsumerId({ HOSTNAME: 'vm-1', SH_WORKER_ID: '0' });
    const b = asyncConsumerId({ HOSTNAME: 'vm-1', SH_WORKER_ID: '1' });
    expect(a).not.toBe(b);
  });
});

describe('asyncFinalizeState', () => {
  it.each(['done', 'failed', 'paused', 'solved', 'responded'] as const)(
    'maps %s to itself',
    (s) => {
      expect(asyncFinalizeState(s)).toBe(s);
    },
  );
  it('maps aborted to cancelled: it stopped because something asked it to', () => {
    expect(asyncFinalizeState('aborted')).toBe('cancelled');
  });
});

describe('armAsyncReaper', () => {
  const queue = () => ({
    reapDeadLetters: vi.fn(async () => [{ entryId: '1-1', turnId: 't-1' }]),
    gcIdleConsumers: vi.fn(async () => 0),
    ack: vi.fn(async () => {}),
  });

  it('sweeps once immediately, before any interval elapses', async () => {
    const q = queue();
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter: vi.fn() });
    await vi.waitFor(() => expect(q.reapDeadLetters).toHaveBeenCalledTimes(1));
    stop();
  });

  it('dead-letters every entry the sweep returns', async () => {
    const q = queue();
    const deadLetter = vi.fn(async () => {});
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter });
    await vi.waitFor(() => expect(deadLetter).toHaveBeenCalledWith('t-1'));
    stop();
  });

  it('acks a dead letter with no turn id without calling deadLetter', async () => {
    const q = queue();
    q.reapDeadLetters = vi.fn(async () => [{ entryId: '1-1', turnId: '' }]);
    const deadLetter = vi.fn(async () => {});
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter });
    await vi.waitFor(() => expect(q.ack).toHaveBeenCalledWith('1-1'));
    expect(deadLetter).not.toHaveBeenCalled();
    stop();
  });

  it('acks only AFTER the dead-letter write: a failed write leaves the entry pending', async () => {
    const q = queue();
    const order: string[] = [];
    q.ack = vi.fn(async () => {
      order.push('ack');
    });
    const deadLetter = vi.fn(async () => {
      order.push('write');
    });
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter });
    await vi.waitFor(() => expect(order).toEqual(['write', 'ack']));
    stop();
  });

  it('does not ack an entry whose dead-letter write threw: it is re-reaped, not lost', async () => {
    const q = queue();
    const log = vi.fn();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(async () => {
        throw new Error('redis write failed');
      }),
      log,
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(q.ack).not.toHaveBeenCalled();
    stop();
  });

  // A count taken before the write turns a Redis outage into a rising async_dead_letters with
  // nothing finalized anywhere -- the opposite of what the counter is read for (§7).
  it('counts a reap only after the write AND the ack land', async () => {
    const q = queue();
    const order: string[] = [];
    q.ack = vi.fn(async () => {
      order.push('ack');
    });
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(async () => {
        order.push('write');
      }),
      onReaped: () => order.push('count'),
    });
    await vi.waitFor(() => expect(order).toEqual(['write', 'ack', 'count']));
    stop();
  });

  it('does not count an entry whose write threw', async () => {
    const q = queue();
    const onReaped = vi.fn();
    const log = vi.fn();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(async () => {
        throw new Error('redis write failed');
      }),
      onReaped,
      log,
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(onReaped).not.toHaveBeenCalled();
    stop();
  });

  // The loop's own branch counts a turnId-less entry as dead_lettered too (`processOne`), so the
  // two paths must not disagree about what a dead letter is.
  it('counts an entry with no turn id, which is acked and nothing else', async () => {
    const q = queue();
    q.reapDeadLetters = vi.fn(async () => [{ entryId: '1-1', turnId: '' }]);
    const onReaped = vi.fn();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(),
      onReaped,
    });
    await vi.waitFor(() => expect(onReaped).toHaveBeenCalledTimes(1));
    stop();
  });

  // One unwritable record must not strand the whole batch unacked: every entry behind it would keep
  // its PEL slot and be re-reaped forever, so one bad turn would stall the reap permanently.
  it('keeps going after one entry fails, and still acks the rest of the batch', async () => {
    const q = queue();
    q.reapDeadLetters = vi.fn(async () => [
      { entryId: '1-1', turnId: 'bad' },
      { entryId: '1-2', turnId: 'good' },
    ]);
    const log = vi.fn();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(async (turnId: string) => {
        if (turnId === 'bad') throw new Error('redis write failed');
      }),
      log,
    });
    await vi.waitFor(() => expect(q.ack).toHaveBeenCalledWith('1-2'));
    expect(q.ack).not.toHaveBeenCalledWith('1-1');
    expect(log.mock.calls.flat().join(' ')).toContain('1-1');
    stop();
  });

  it('collects idle consumers even when the reap itself failed', async () => {
    const q = queue();
    q.reapDeadLetters = vi.fn(async () => {
      throw new Error('redis down');
    });
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(),
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(q.gcIdleConsumers).toHaveBeenCalled());
    stop();
  });

  it('collects idle consumers even when an entry failed', async () => {
    const q = queue();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(async () => {
        throw new Error('redis write failed');
      }),
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(q.gcIdleConsumers).toHaveBeenCalled());
    stop();
  });

  it('logs a failed consumer gc without failing the sweep', async () => {
    const q = queue();
    q.gcIdleConsumers = vi.fn(async () => {
      throw new Error('gc exploded');
    });
    const log = vi.fn();
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter: vi.fn(), log });
    await vi.waitFor(() => expect(log.mock.calls.flat().join(' ')).toContain('gc exploded'));
    expect(q.ack).toHaveBeenCalledWith('1-1');
    stop();
  });

  it('collects idle consumers in the same sweep', async () => {
    const q = queue();
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter: vi.fn() });
    await vi.waitFor(() => expect(q.gcIdleConsumers).toHaveBeenCalledWith(300_000));
    stop();
  });

  it('keeps sweeping on the interval, and stops when stopped', async () => {
    vi.useFakeTimers();
    const q = queue();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(),
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(q.reapDeadLetters.mock.calls.length).toBeGreaterThanOrEqual(3);
    const seen = q.reapDeadLetters.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(q.reapDeadLetters.mock.calls.length).toBe(seen);
  });

  it('survives a sweep that throws and sweeps again', async () => {
    vi.useFakeTimers();
    const q = queue();
    q.reapDeadLetters = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue([]);
    const log = vi.fn();
    const stop = armAsyncReaper({
      queue: q as never,
      consumerId: 'c',
      deadLetter: vi.fn(),
      intervalMs: 1_000,
      log,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(log.mock.calls.flat().join(' ')).toContain('redis down');
    expect(q.reapDeadLetters.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  it('unrefs its timer: the reaper must never hold the process open', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const q = queue();
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter: vi.fn() });
    const handle = setIntervalSpy.mock.results.at(-1)?.value as ReturnType<typeof setInterval>;
    expect(handle.hasRef()).toBe(false);
    setIntervalSpy.mockRestore();
    stop();
  });
});

describe('armAsyncLeafWorker', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  let warnLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await settle();
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  const counter = () => ({ inFlight: 0, start: () => () => undefined });

  it('returns null and opens no client when SH_ASYNC_DRAIN is not set', () => {
    const worker = armAsyncLeafWorker({ counter: counter(), env: {} });
    expect(worker).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('gives the queue and the turn store their OWN Redis connection (S1): node-redis multiplexes one socket, so the claim loop would sit in front of every turn-record write', async () => {
    const env = {
      SH_ASYNC_DRAIN: '1',
      SH_CONTROL_PLANE_URL: 'http://cp.example',
      SH_EXCHANGE_TOKEN: 'tok',
      REDIS_URL: `redis://127.0.0.1:${await closedPort()}`,
    };
    const worker = armAsyncLeafWorker({ counter: counter(), env });
    expect(worker).not.toBeNull();
    // Exactly three clients: the queue's, the turn store's, and getResultStore's own (unrelated)
    // one -- so a shared queue/turns client (the regression this guards) collapses this to two.
    expect(created).toHaveLength(3);
    expect(created[0]).not.toBe(created[1]);
    await worker!.stop();
  });

  // Against real Redis, not a fake: the only way to exercise pollDepth, since armAsyncLeafWorker
  // builds its own queue/client internally with no injection seam, and every other test in this
  // describe points REDIS_URL at a closed port so ensureGroup (and so pollDepth) never runs.
  it('reaches pollDepth over real Redis: stats() carries the two gauges from one depth() call, and a failed poll leaves the previous reading in place', async () => {
    // A per-run stream, never the production LEAF_QUEUE_STREAM: this test deletes its stream mid-run
    // to force a poll failure, and doing that to the production name would drop its consumer group
    // and every other in-flight entry on a real Redis (e.g. deploy/compose's).
    const stream = `test-leaf-stream-${randomUUID()}`;
    const raw = createClient({ url: 'redis://127.0.0.1:6379' }) as RedisClientType;
    await raw.connect();
    await raw.xAdd(stream, '*', { turnId: 'seed' });

    const env = {
      SH_ASYNC_DRAIN: '1',
      SH_CONTROL_PLANE_URL: 'http://cp.example',
      SH_EXCHANGE_TOKEN: 'tok',
      REDIS_URL: 'redis://127.0.0.1:6379',
      SH_WORKER_ID: '0', // slot 0: the only slot that polls
    };
    const worker = armAsyncLeafWorker({ counter: counter(), env, stream });
    expect(worker).not.toBeNull();

    try {
      // The immediate post-ensureGroup poll, well under the 10 s interval.
      await vi.waitFor(
        () => {
          expect(worker!.stats().asyncQueueDepth).toBe(1);
        },
        { timeout: 5_000, interval: 50 },
      );
      const firstOldestAgeMs = worker!.stats().asyncOldestAgeMs;
      expect(Number.isFinite(firstOldestAgeMs)).toBe(true);

      // Break the NEXT poll: delete the stream (and its group) so depth()'s xInfoGroups
      // rejects with "no such key" -- the .catch()'s contract under test.
      await raw.del(stream);
      await new Promise((r) => setTimeout(r, ASYNC_DEPTH_INTERVAL_MS + 500));

      expect(worker!.stats()).toMatchObject({
        asyncQueueDepth: 1,
        asyncOldestAgeMs: firstOldestAgeMs,
      });
    } finally {
      await worker!.stop();
      await raw.del(stream).catch(() => undefined);
      await raw.quit().catch(() => undefined);
    }
  }, 15_000);

  // Guards stop()'s depth-timer teardown: without `clearInterval(depthTimer)` the 10 s poll
  // outlives stop() and, through the reconnecting Proxy's `!isOpen` re-arm, reopens the client
  // stop() just destroyed -- inside the 20 s shutdown grace, not after it.
  it('stop() cancels the depth poll: no further depth() call after stop, even past one interval', async () => {
    const stream = `test-leaf-stream-${randomUUID()}`;
    const depthSpy = vi.spyOn(RedisWorkQueue.prototype, 'depth');
    const env = {
      SH_ASYNC_DRAIN: '1',
      SH_CONTROL_PLANE_URL: 'http://cp.example',
      SH_EXCHANGE_TOKEN: 'tok',
      REDIS_URL: 'redis://127.0.0.1:6379',
      SH_WORKER_ID: '0', // slot 0: the only slot that polls
    };
    const worker = armAsyncLeafWorker({ counter: counter(), env, stream });
    expect(worker).not.toBeNull();

    try {
      await vi.waitFor(() => expect(depthSpy.mock.calls.length).toBeGreaterThanOrEqual(1), {
        timeout: 5_000,
        interval: 50,
      });
      const callsAtStop = depthSpy.mock.calls.length;
      await worker!.stop();
      await new Promise((r) => setTimeout(r, ASYNC_DEPTH_INTERVAL_MS + 500));
      expect(depthSpy.mock.calls.length).toBe(callsAtStop);
    } finally {
      depthSpy.mockRestore();
      const raw = createClient({ url: 'redis://127.0.0.1:6379' }) as RedisClientType;
      await raw.connect();
      await raw.del(stream).catch(() => undefined);
      await raw.quit().catch(() => undefined);
    }
  }, 15_000);
});

describe('createAsyncTally', () => {
  it('starts at zero', () => {
    expect(createAsyncTally().snapshot()).toEqual({
      asyncClaims: 0,
      asyncReclaims: 0,
      asyncDeadLetters: 0,
      asyncClaimDeniedFull: 0,
    });
  });

  it('counts every claimed entry, whatever became of it', () => {
    const t = createAsyncTally();
    t.onOutcome({ kind: 'completed', turnId: 'a', status: 'done', reclaimed: false });
    t.onOutcome({ kind: 'redelivered', turnId: 'b', reclaimed: false });
    t.onOutcome({ kind: 'refused', turnId: 'c', reclaimed: false });
    t.onOutcome({ kind: 'dead_lettered', turnId: 'd', reclaimed: false });
    expect(t.snapshot().asyncClaims).toBe(4);
  });

  it('does not count an idle poll as a claim', () => {
    const t = createAsyncTally();
    t.onOutcome({ kind: 'idle' });
    t.onOutcome({ kind: 'idle' });
    expect(t.snapshot().asyncClaims).toBe(0);
  });

  it('counts a reclaim on any outcome, not only a completion', () => {
    const t = createAsyncTally();
    t.onOutcome({ kind: 'completed', turnId: 'a', status: 'done', reclaimed: true });
    t.onOutcome({ kind: 'dead_lettered', turnId: 'b', reclaimed: true });
    t.onOutcome({ kind: 'refused', turnId: 'c', reclaimed: false });
    expect(t.snapshot().asyncReclaims).toBe(2);
  });

  it('counts dead letters from the loop and from the reaper, without double counting', () => {
    const t = createAsyncTally();
    t.onOutcome({ kind: 'dead_lettered', turnId: 'a', reclaimed: false }); // the loop's branch
    t.onReaped(); // the periodic reaper's
    expect(t.snapshot().asyncDeadLetters).toBe(2);
  });

  it('counts claims not attempted because the worker was full', () => {
    const t = createAsyncTally();
    t.onCapDenied();
    t.onCapDenied();
    expect(t.snapshot().asyncClaimDeniedFull).toBe(2);
  });

  it('snapshots a copy: a later increment does not mutate an earlier reading', () => {
    const t = createAsyncTally();
    const first = t.snapshot();
    t.onCapDenied();
    expect(first.asyncClaimDeniedFull).toBe(0);
  });
});
