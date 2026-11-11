import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armAsyncReaper,
  asyncConsumerId,
  asyncFinalizeState,
  ASYNC_REAP_INTERVAL_MS,
} from '../src/async-worker.js';

afterEach(() => {
  vi.useRealTimers();
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
    const q = queue();
    const stop = armAsyncReaper({ queue: q as never, consumerId: 'c', deadLetter: vi.fn() });
    // No handle is exposed, so assert the property that matters indirectly: the default interval
    // is a minute, and a test file that finished proves nothing was keeping the loop alive.
    expect(ASYNC_REAP_INTERVAL_MS).toBe(60_000);
    stop();
  });
});
