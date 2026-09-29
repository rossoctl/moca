import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The queue's connect memo must recover on BOTH channels that can break it.
 *
 * `RedisWorkQueue` assigned `ready` once in its constructor and never reassigned it, so it had neither
 * half of the recovery `RedisSessionBackend` already had:
 *
 *  - PROMISE channel: a rejected `connect()` left a permanently rejected promise that all eleven
 *    methods awaited. The async worker holds ONE queue for its whole life (server.ts memoises it
 *    process-wide), so a blip at boot poisoned every entry the worker would ever claim.
 *  - EVENT channel: past the bounded reconnect strategy node-redis gives up permanently and silently --
 *    it sets `isOpen` false, swallows its own `ReconnectStrategyError`, and rejects every later command
 *    with `ClientClosedError`. The connect SUCCEEDED, so `ready` stays resolved and the promise-channel
 *    re-arm above cannot see it.
 *
 * The second is the one this file exists for; it is the shape a reviewer caught after the first was
 * fixed. Full citations into node-redis 6.2.1 live on `resilientClientOptions` (@moca/session-backend),
 * and the sibling proof for the session store is `redis-backend-rearm.test.ts` -- not duplicated here.
 *
 * `queue.test.ts` drives a real Redis and so can exercise neither failure; this mock is why.
 */
class FakeClient extends EventEmitter {
  isOpen = false;
  // node-redis sets #isOpen true SYNCHRONOUSLY inside connect() (socket.js:170) and back to false on
  // the terminal give-up (socket.js:154). Modelling both is what makes "no re-arm while a connect is in
  // flight" a real assertion rather than an artefact of a mock that left isOpen false forever.
  connect = vi.fn(async () => {
    this.isOpen = true;
    try {
      return await this.attempt();
    } catch (err) {
      this.isOpen = false;
      throw err;
    }
  });
  attempt = vi.fn<() => Promise<void>>(async () => undefined);
  close = vi.fn(async () => undefined);
  xAdd = vi.fn(async () => '1-0');
}

let client: FakeClient;
vi.mock('redis', () => ({ createClient: () => client }));

const { RedisWorkQueue } = await import('../src/queue');

beforeEach(() => {
  client = new FakeClient();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('RedisWorkQueue connect re-arm', () => {
  it('retries the connect on the next call after one fails', async () => {
    client.attempt
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    const q = new RedisWorkQueue();

    await expect(q.enqueue({ a: 1 })).rejects.toThrow('connect ECONNREFUSED');
    // On the old code `ready` held that one rejected promise, so this replayed the same error forever.
    await expect(q.enqueue({ a: 1 })).resolves.toBe('1-0');
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects after node-redis permanently closes the socket', async () => {
    const q = new RedisWorkQueue();
    await q.enqueue({ a: 1 });
    expect(client.connect).toHaveBeenCalledTimes(1);

    // The event channel: terminal give-up past the reconnect bound. `ready` is still RESOLVED, so only
    // the isOpen check can notice; without it this queue would reject ClientClosedError forever.
    client.isOpen = false;

    await expect(q.enqueue({ a: 1 })).resolves.toBe('1-0');
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('does not re-attempt while a connect is still in flight or has succeeded', async () => {
    const q = new RedisWorkQueue();

    await Promise.all([q.enqueue({ a: 1 }), q.enqueue({ a: 2 }), q.enqueue({ a: 3 })]);

    // One connection per queue is the point of memoising it; a re-arm on the happy path would undo that.
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('close() resolves for a client that never connected', async () => {
    // close() awaited `ready` unguarded, so a never-connected client could not be closed AT ALL: it
    // rejected, and the socket was left dangling by the teardown meant to prevent exactly that.
    client.attempt.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const q = new RedisWorkQueue();
    await expect(q.enqueue({ a: 1 })).rejects.toThrow();

    await expect(q.close()).resolves.toBeUndefined();
    expect(client.close).not.toHaveBeenCalled(); // nothing was open to close
  });

  it('close() closes a client that did connect', async () => {
    const q = new RedisWorkQueue();
    await q.enqueue({ a: 1 });

    await q.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
