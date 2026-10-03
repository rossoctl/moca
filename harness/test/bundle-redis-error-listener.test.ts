import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The promoted-config bundle client (`getBundleRedis`, run-leaf.ts) runs inside the worker process --
 * `POST /runs` with a `configRef` reaches it -- and is memoised for the process's life. It had no
 * `'error'` listener, so once a worker had served one such run, a Redis restart was an uncaught
 * `SocketClosedUnexpectedlyError` and the worker exited, taking its in-flight turns with it: the same
 * defect as the runtime reporter's (#423, Task 16b, defect B), found by that task's createClient sweep.
 *
 * Same pairing as every other long-lived client (redis-errors.ts in @moca/session-backend): the
 * listener, a bounded reconnect so a refused connect still rejects rather than hanging the leaf, and a
 * re-arm when the client has given up for good (`!isOpen`), which no rejected connect would signal.
 */
class FakeClient extends EventEmitter {
  isOpen = false;
  // node-redis sets isOpen true synchronously inside connect() (socket.js:170).
  connect = vi.fn(async () => {
    this.isOpen = true;
    return this;
  });
}

const clients: FakeClient[] = [];
const createClient = vi.fn((_opts: unknown) => {
  const c = new FakeClient();
  clients.push(c);
  return c;
});
vi.mock('redis', () => ({ createClient }));

beforeEach(() => {
  clients.length = 0;
  createClient.mockClear();
  vi.resetModules(); // a fresh module-level memo per case
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const load = async () => (await import('../src/run-leaf.js')).getBundleRedis;

describe('getBundleRedis (#423 Task 16b sweep)', () => {
  it('survives an error emitted on an established connection', async () => {
    const getBundleRedis = await load();
    await getBundleRedis('redis://127.0.0.1:6379');

    expect(clients).toHaveLength(1);
    expect(() => clients[0]!.emit('error', new Error('Socket closed unexpectedly'))).not.toThrow();
    expect(clients[0]!.listenerCount('error')).toBe(1);
  });

  it('bounds the reconnect, so a refused connect still rejects instead of hanging', async () => {
    const getBundleRedis = await load();
    await getBundleRedis('redis://127.0.0.1:6379');

    const opts = createClient.mock.calls[0]![0] as {
      socket?: { reconnectStrategy?: (n: number) => number | Error };
    };
    expect(opts.socket?.reconnectStrategy?.(0)).toBe(0);
    expect(opts.socket?.reconnectStrategy?.(11)).toBeInstanceOf(Error);
  });

  it('re-arms once the client has given up for good, rather than reusing a closed one forever', async () => {
    const getBundleRedis = await load();
    const first = await getBundleRedis('redis://127.0.0.1:6379');
    expect(await getBundleRedis('redis://127.0.0.1:6379')).toBe(first); // memoised while open

    clients[0]!.isOpen = false; // node-redis past its reconnect bound (socket.js:154)
    const second = await getBundleRedis('redis://127.0.0.1:6379');
    expect(second).not.toBe(first);
    expect(clients).toHaveLength(2);
  });
});
