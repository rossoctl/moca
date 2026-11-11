import { createServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';

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
    await vi.waitFor(() => expect(q.reapDeadLetters).toHaveBeenCalled());
    expect(deadLetter).not.toHaveBeenCalled();
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

  it('gives the queue and the turn store their OWN Redis connection (S1): a blocking XREADGROUP on a shared client would starve the turn store', async () => {
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
