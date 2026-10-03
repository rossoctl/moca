import { describe, expect, it, vi } from 'vitest';
import { RedisRecordStore } from '../src/pool-records.js';

/**
 * These two tests are about the store SURVIVING redis misbehaving, not about it working — the
 * happy path lives in pool-records.test.ts and needs a real redis. Both cases here run against
 * a port nothing listens on, so they need no redis at all and are safe in CI.
 */
describe('RedisRecordStore resilience', () => {
  it('a genuinely unreachable redis REJECTS rather than hanging, and does not poison the store', async () => {
    // Two properties in one, because they are coupled and one without the other is a bug.
    //
    // REJECTS: probed on the pinned redis ^6 -- WITHOUT an 'error' listener a connect() to a
    // dead port surfaces the failure as a rejection, but WITH one the listener consumes that
    // error and connect() stays pending, retrying, indefinitely (still pending at 15s). So the
    // listener that stops the crash would, alone, trade it for a silent hang: the relay binds
    // its port before any record call, so the hang surfaces much later as a client-side
    // timeout with nothing in the relay's log. The bounded reconnectStrategy is what keeps
    // the failure loud.
    //
    // DOES NOT POISON: `ready` used to memoise one connect(), so a first failure stayed
    // rejected for the life of the process and every later call failed even after redis came
    // back -- a live race for the experiment drivers, which start redis with `docker run -d`
    // (returns when the container exists, not when it accepts) and then start the relay
    // immediately. A failed attempt now clears the memo, so a second call tries again.
    // maxReconnectAttempts=0: give up on the first failed attempt, so this pins TERMINATION
    // without waiting out the production backoff (which would make it a ~40s test).
    const store = new RedisRecordStore('redis://127.0.0.1:6399', 0);

    await expect(store.list()).rejects.toThrow();
    // The retry is the point: a second call must make its own attempt and fail on its own
    // terms, not inherit the first attempt's settled rejection forever.
    await expect(store.list()).rejects.toThrow();
    await expect(store.close()).resolves.toBeUndefined();
  }, 20_000);

  it('attaches an error listener, so a client error cannot kill the process', async () => {
    // The crash this prevents: a node-redis client is an EventEmitter, and an 'error' event
    // with no listener exits the process. A rejected connect() is safe on the pinned redis ^6,
    // which is why most call sites in this repo omit the listener — but a socket that
    // connected and LATER closes emits 'error' on the client, and that killed a relay twice:
    // once when a redis container was recreated under it, and again mid-E11-run, where the
    // relay had already bound its port and a worker had already attached.
    //
    // Asserted by checking the listener is actually registered, and then by emitting the very
    // event that used to be fatal. Without a listener the emit throws (EventEmitter's
    // unhandled-'error' behaviour); with one it must not. That makes the presence reachable
    // rather than assumed.
    const store = new RedisRecordStore('redis://127.0.0.1:6399', 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (store as any).client as {
      listenerCount(e: string): number;
      emit(e: string, payload: unknown): boolean;
    };

    expect(client.listenerCount('error')).toBeGreaterThan(0);
    expect(() => client.emit('error', new Error('Socket closed unexpectedly'))).not.toThrow();

    await expect(store.close()).resolves.toBeUndefined();
  });

  it('never puts the Redis password into the unreachable error or the error log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    try {
      const store = new RedisRecordStore('redis://:topsecret@127.0.0.1:6399', 0);
      const err = await store.list().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/unreachable/);
      expect(String(err)).not.toContain('topsecret');
      expect(logged.join('\n')).not.toContain('topsecret');
      await store.close().catch(() => {});
    } finally {
      spy.mockRestore();
    }
  });
});
