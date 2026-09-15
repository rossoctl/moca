import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Socket } from 'node:net';
import {
  WorkerPool,
  type WorkerHandle,
  type SupervisorToWorker,
  type PoolOptions,
} from '../../src/pool.js';

let nextPid = 1000;

export class FakeWorker extends EventEmitter implements WorkerHandle {
  readonly pid = nextPid++;
  readonly sent: Array<{ msg: SupervisorToWorker; hasHandle: boolean }> = [];
  /** Mirrors `ChildProcess.connected`: false once the IPC channel is gone. */
  connected = true;
  /**
   * A DEAD channel: `send()` throws (`ERR_IPC_CHANNEL_CLOSED`). Together with `connected`
   * this is what a hand-off failure actually looks like — a `false` return is not.
   */
  sendThrows = false;
  /**
   * A QUEUED handle. Node returns `false` for the third and later handle sent inside one tick
   * while still delivering every one of them: measured `[true,true,false,false,false,false]`
   * for six sends, with all six received by the child WITH their handle. So the boolean
   * reports queue position, not success, and `sent` is appended below even when it is false —
   * because the message IS delivered. A pool that reads it as failure retries the socket on a
   * second worker, and Node's fd hand-off is destructive: exactly one worker ends up with the
   * descriptor and the other receives a handle-less `conn`.
   */
  sendReturnsFalse = false;
  killed: NodeJS.Signals | undefined;

  send(msg: SupervisorToWorker, handle?: Socket): boolean {
    if (this.sendThrows) throw new Error('ERR_IPC_CHANNEL_CLOSED');
    this.sent.push({ msg, hasHandle: handle !== undefined });
    // Kept independent of `connected` on purpose, even though production Node throws when the
    // channel is gone: a test can then pin WHICH signal the pool consulted, because a fake
    // that only threw would pass whether or not `connected` was ever read.
    return !this.sendReturnsFalse;
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
  ready(): void {
    this.emit('message', { type: 'ready', pid: this.pid });
  }
  load(inFlight: number): void {
    this.emit('message', { type: 'load', inFlight });
  }
  draining(): void {
    this.emit('message', { type: 'draining' });
  }
  stats(s: {
    loopLagP99Ms?: number;
    lagResolutionMs?: number;
    rssBytes?: number;
    cpuSeconds?: number;
    leasesHeld?: number;
    leasePoolSize?: number;
    fileOpP95Ms?: number;
  }): void {
    this.emit('message', { type: 'stats', ...s });
  }
  exit(code: number | null = 1): void {
    this.emit('exit', code, null);
  }
  get conns(): number {
    return this.sent.filter((s) => s.msg.type === 'conn').length;
  }
}

export interface Harness {
  pool: WorkerPool;
  forked: FakeWorker[];
  timers: Array<{ fn: () => void; ms: number }>;
  logs: Array<Record<string, unknown>>;
  clock: { t: number };
  runTimers: () => void;
}

export function harness(overrides: Partial<PoolOptions> = {}, workers = 2): Harness {
  const forked: FakeWorker[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const clock = { t: 0 };
  const pool = new WorkerPool({
    workers,
    fork: () => {
      const w = new FakeWorker();
      forked.push(w);
      return w;
    },
    now: () => clock.t,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    log: (line) => logs.push(line),
    ...overrides,
  });
  const runTimers = (): void => {
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
  };
  return { pool, forked, timers, logs, clock, runTimers };
}

export const fakeSocket = (): Socket => ({ destroy: vi.fn(), pause: vi.fn() }) as unknown as Socket;
