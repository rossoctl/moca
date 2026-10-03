import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay } from '../src/relay.js';
import type { SandboxRecord, RecordStore } from '@moca/harness';

/**
 * Defect A (#423, Task 16b): a presence put that failed once -- Redis not yet reachable when the
 * sandbox attached -- was dropped for good, so the attached sandbox never appeared in
 * sh:sandbox:records and no turn could lease it. These pin the retry: bounded exponential backoff,
 * for exactly as long as the SAME session stays attached, and never a put after teardown's remove.
 */

/** A store whose put fails `failures` times (Infinity: always), then lands. */
function flakyRecords(failures: number) {
  const map = new Map<string, SandboxRecord>();
  let calls = 0;
  const store: RecordStore = {
    put: vi.fn(async (r: SandboxRecord) => {
      calls += 1;
      if (calls <= failures) {
        // The shape RedisRecordStore rejects with: already redacted (Task 3).
        throw new Error('redis at redis://***@redis:6379 unreachable after 11 attempts');
      }
      map.set(r.sandboxId, r);
    }),
    remove: vi.fn(async (id: string) => void map.delete(id)),
    list: async () => [...map.values()],
  };
  return { store, map };
}

/** Injected timers: nothing runs until the test fires it, and every requested delay is recorded. */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      pending.set(next, { fn, ms });
      delays.push(ms);
      return next;
    },
    clearTimeout: (h: unknown) => void pending.delete(h as number),
  };
  /** Fire the single pending timer (there is never more than one per session). */
  const fire = () => {
    const [h, t] = [...pending][0]!;
    pending.delete(h);
    t.fn();
  };
  return { timers, pending, delays, fire };
}

/** Fake bidi Attach stream, as in relay-attach.test.ts. */
function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: (k) => (k === 'authorization' ? ['Bearer good'] : []) };
  s.write = () => undefined;
  s.end = () => s.emit('end');
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const hello = (sandboxId: string) => ({
  hello: { sandboxId, labels: {}, capabilities: [], capacityMax: 1 },
});

let errorLog: ReturnType<typeof vi.spyOn>;
let infoLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  infoLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  errorLog.mockRestore();
  infoLog.mockRestore();
});

describe('relay presence put retry (#423 Task 16b, defect A)', () => {
  it('retries a rejected put with exponential backoff until it lands, exactly once', async () => {
    const { store, map } = flakyRecords(2);
    const t = manualTimers();
    const relay = createRelay({ records: store, validateToken: () => true, timers: t.timers });
    const s = fakeAttach();
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));

    await vi.waitFor(() => expect(t.pending.size).toBe(1));
    t.fire();
    await vi.waitFor(() => expect(t.pending.size).toBe(1));
    expect(store.put).toHaveBeenCalledTimes(2);
    t.fire();
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeTruthy());

    expect(store.put).toHaveBeenCalledTimes(3);
    expect(t.delays).toEqual([250, 500]);
    expect(t.pending.size).toBe(0); // landed: nothing more is scheduled
    // One line per failed attempt, and only the (already redacted) message.
    expect(errorLog).toHaveBeenCalledTimes(2);
    for (const call of errorLog.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).not.toContain('\n');
      expect(String(call[0])).toContain('sbx-1');
    }
    // The recovery line follows the put's settlement, a tick after the write itself.
    await vi.waitFor(() =>
      expect(infoLog).toHaveBeenCalledWith(
        'presence put for sbx-1 landed after 2 failed attempt(s)',
      ),
    );
  });

  it('stops retrying at teardown, and never puts after the remove', async () => {
    const { store, map } = flakyRecords(Infinity);
    const t = manualTimers();
    const relay = createRelay({ records: store, validateToken: () => true, timers: t.timers });
    const s = fakeAttach();
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(t.pending.size).toBe(1));
    // Hold the pending retry, so it can be run even if the relay forgot to cancel it.
    const stale = [...t.pending.values()][0]!.fn;

    s.end();
    await vi.waitFor(() => expect(store.remove).toHaveBeenCalledTimes(1));
    expect(t.pending.size).toBe(0); // teardown cancelled the retry

    stale(); // and a retry that fires anyway is a no-op: identity guard
    await new Promise((r) => setImmediate(r));
    expect(store.put).toHaveBeenCalledTimes(1);
    const removeOrder = vi.mocked(store.remove).mock.invocationCallOrder[0]!;
    for (const order of vi.mocked(store.put).mock.invocationCallOrder) {
      expect(order).toBeLessThan(removeOrder);
    }
    expect(map.size).toBe(0);
  });

  it('a stale retry does not write for a new session that reattached under the same id', async () => {
    const { store } = flakyRecords(1);
    const t = manualTimers();
    const relay = createRelay({ records: store, validateToken: () => true, timers: t.timers });
    const s1 = fakeAttach();
    relay.onAttach(s1 as never);
    s1.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(t.pending.size).toBe(1));
    const stale = [...t.pending.values()][0]!.fn;
    s1.end();
    await vi.waitFor(() => expect(store.remove).toHaveBeenCalledTimes(1));

    // The worker reconnects: a NEW session for the same sandboxId, whose own put lands.
    const s2 = fakeAttach();
    relay.onAttach(s2 as never);
    s2.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(2));

    stale(); // the first session's retry: the session map holds a different object now
    await new Promise((r) => setImmediate(r));
    expect(store.put).toHaveBeenCalledTimes(2);
    s2.end();
  });

  it('a store that keeps rejecting never throws unhandled; the loop backs off to 10 s until teardown', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { store } = flakyRecords(Infinity);
      const t = manualTimers();
      const relay = createRelay({ records: store, validateToken: () => true, timers: t.timers });
      const s = fakeAttach();
      relay.onAttach(s as never);
      s.emitData(hello('sbx-1'));

      for (let i = 1; i <= 10; i += 1) {
        await vi.waitFor(() => expect(t.pending.size).toBe(1));
        expect(store.put).toHaveBeenCalledTimes(i);
        t.fire();
      }
      await vi.waitFor(() => expect(t.pending.size).toBe(1));
      expect(store.put).toHaveBeenCalledTimes(11);
      expect(t.delays).toEqual([
        250, 500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000,
      ]);

      s.end();
      await vi.waitFor(() => expect(store.remove).toHaveBeenCalledTimes(1));
      expect(t.pending.size).toBe(0);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
