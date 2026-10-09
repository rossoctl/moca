import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortMessage,
  activeKey,
  compareEntryIds,
  eventId,
  eventsKey,
  lastKey,
  parseEventId,
  turnRegistryTimings,
  TurnRegistry,
  watchKey,
} from '../src/turn-registry.js';

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const T = { leaseMs: 300, renewMs: 100, detachedMaxMs: 400, logTtlS: 60, maxLen: 1000 };
const redis = createClient({ url: URL });
await redis.connect();
const regs: TurnRegistry[] = [];
const reg = (timings = T) => {
  const r = new TurnRegistry({ url: URL, ownerId: `test-${regs.length}`, timings });
  regs.push(r);
  return r;
};
const sid = () => `s-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = (sessionId: string) => ({ type: 'done' as const, sessionId, stopReason: 'stop' });
const aborted = (sessionId: string) => ({
  type: 'error' as const,
  sessionId,
  stopReason: 'aborted',
});

afterEach(async () => {
  await Promise.all(regs.splice(0).map((r) => r.close()));
});
afterAll(async () => {
  await redis.close();
});

describe('helpers', () => {
  it('pins the wire names', () => {
    expect(activeKey('s')).toBe('sh:turn:s:active');
    expect(lastKey('s')).toBe('sh:turn:s:last');
    expect(eventsKey('s', 't')).toBe('sh:turn:s:t:events');
    expect(watchKey('s', 't')).toBe('sh:turn:s:t:watch');
  });
  it('builds and parses event ids', () => {
    expect(eventId('t1', '5-0')).toBe('t1:5-0');
    expect(parseEventId('t1:5-0')).toEqual({ turnId: 't1', entryId: '5-0' });
    expect(parseEventId('garbage')).toBeUndefined();
    expect(parseEventId('t1:5')).toBeUndefined();
  });
  it('compares entry ids numerically', () => {
    expect(compareEntryIds('9-0', '10-0')).toBeLessThan(0);
    expect(compareEntryIds('10-2', '10-10')).toBeLessThan(0);
    expect(compareEntryIds('10-0', '10-0')).toBe(0);
  });
  it('reads timings, ignoring junk', () => {
    expect(turnRegistryTimings({})).toEqual({
      leaseMs: 30_000,
      renewMs: 10_000,
      detachedMaxMs: 1_800_000,
      logTtlS: 86_400,
      maxLen: 100_000,
    });
    expect(
      turnRegistryTimings({ SH_TURN_DETACHED_MAX_S: '60', SH_TURN_LOG_TTL_S: 'x' }),
    ).toMatchObject({ detachedMaxMs: 60_000, logTtlS: 86_400 });
  });
  it('words the unwatched message in minutes or seconds', () => {
    expect(abortMessage('unwatched', turnRegistryTimings({}))).toBe('turn unwatched for 30 min');
    expect(abortMessage('unwatched', { ...T, detachedMaxMs: 400 })).toBe(
      'turn unwatched for 0.4 s',
    );
  });
});

describe('begin / append / end', () => {
  it('logs the turn frame first, then frames, then the terminal; releases the lease', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    expect(turn.start.frame).toEqual({ type: 'turn', turnId: turn.turnId, sessionId: s });
    expect(parseEventId(turn.start.id)?.turnId).toBe(turn.turnId);
    const id = await turn.append({ type: 'text', delta: 'hi' });
    expect(parseEventId(id!)?.turnId).toBe(turn.turnId);
    const end = await turn.end(done(s));
    expect(end.frame).toEqual(done(s));
    const rows = (await redis.xRange(eventsKey(s, turn.turnId), '-', '+')) ?? [];
    expect(rows.map((x) => JSON.parse(x.message.f).type)).toEqual(['turn', 'text', 'done']);
    expect(await redis.get(activeKey(s))).toBeNull();
    expect(await redis.get(lastKey(s))).toBe(turn.turnId);
    expect(await redis.ttl(eventsKey(s, turn.turnId))).toBeGreaterThan(0);
    expect(await redis.ttl(lastKey(s))).toBeGreaterThan(0);
  });

  it('refuses a second turn of the same session, naming the running one', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    await expect(r.begin(s)).rejects.toMatchObject({
      name: 'TurnInProgressError',
      turnId: turn.turnId,
    });
    expect(await r.peek(s)).toBe(turn.turnId);
    await turn.end(done(s));
    expect(await r.peek(s)).toBeNull();
  });

  it('keeps the lease alive past its TTL while the turn runs', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    await sleep(T.leaseMs * 2);
    expect(await r.peek(s)).toBe(turn.turnId);
    await turn.end(done(s));
  });

  it('gives both keys a retention TTL while the turn runs, so a crashed owner leaks nothing', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    expect(await redis.ttl(lastKey(s))).toBeGreaterThan(0);
    expect(await redis.ttl(eventsKey(s, turn.turnId))).toBeGreaterThan(0);
    await turn.append({ type: 'text', delta: 'hi' });
    // Run both clocks down, then let a renewal pass: it must have put them back to logTtlS.
    await redis.expire(lastKey(s), 1);
    await redis.expire(eventsKey(s, turn.turnId), 1);
    await sleep(T.renewMs * 2);
    expect(await redis.ttl(lastKey(s))).toBeGreaterThan(1);
    expect(await redis.ttl(eventsKey(s, turn.turnId))).toBeGreaterThan(1);
    await turn.end(done(s));
  });

  it('reports a Redis it cannot reach as unavailable', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = new TurnRegistry({
        url: 'redis://127.0.0.1:1',
        ownerId: 'x',
        timings: T,
        maxReconnectAttempts: 2,
      });
      regs.push(r);
      await expect(r.begin(sid())).rejects.toMatchObject({
        name: 'TurnRegistryUnavailableError',
      });
    } finally {
      quiet.mockRestore();
    }
  });

  it('re-arms a client and a cancel subscriber that node-redis closed for good', async () => {
    const r = reg();
    const other = reg();
    const s1 = sid();
    await (await r.begin(s1)).end(done(s1));
    // What node-redis leaves behind past its reconnect bound: both clients closed, isOpen false.
    const inner = r as unknown as { client: RedisClientType; subClient: RedisClientType };
    const deadSub = inner.subClient;
    deadSub.destroy();
    inner.client.destroy();
    const s2 = sid();
    const turn = await r.begin(s2);
    expect(await r.peek(s2)).toBe(turn.turnId);
    expect(inner.subClient).not.toBe(deadSub);
    expect(inner.subClient.isOpen).toBe(true);
    await other.cancel(s2, turn.turnId);
    await expect.poll(() => turn.abortReason, { timeout: 1000 }).toBe('cancelled');
    await turn.end(aborted(s2));
  });

  // Slower clocks than T: the abort lands within renewMs of leaseMs - renewMs after the last good
  // renew, so the headroom below the leaseMs bound is renewMs -- 200 ms here rather than 100.
  const L = { ...T, leaseMs: 600, renewMs: 200 };

  it('aborts with lease_lost before the lease can lapse when renewals fail', async () => {
    const r = reg(L);
    const s = sid();
    const turn = await r.begin(s);
    let abortedAt = 0;
    turn.signal.addEventListener('abort', () => (abortedAt = Date.now()));
    // A hash where the lease string was: RENEW_LUA's GET fails WRONGTYPE from here on. No renewal
    // succeeds after this instant, so the lease lapses at most leaseMs after it.
    const brokenAt = Date.now();
    await redis.multi().del(activeKey(s)).hSet(activeKey(s), 'x', '1').exec(); // never absent
    await expect.poll(() => turn.abortReason, { timeout: 2000 }).toBe('lease_lost');
    expect(abortedAt - brokenAt).toBeLessThan(L.leaseMs);
    await redis.del(activeKey(s)); // let END's GET succeed
    await turn.end(aborted(s));
  });

  it('aborts with lease_lost before the lease can lapse when a renew never settles', async () => {
    const r = reg(L);
    const s = sid();
    const turn = await r.begin(s);
    let abortedAt = 0;
    turn.signal.addEventListener('abort', () => (abortedAt = Date.now()));
    // A blackholed Redis: the socket stays open, the eval never answers, its catch never runs.
    const hungAt = Date.now();
    vi.spyOn(r, 'renew').mockReturnValue(new Promise(() => {}));
    await expect.poll(() => turn.abortReason, { timeout: 2000 }).toBe('lease_lost');
    expect(abortedAt - hungAt).toBeLessThan(L.leaseMs);
    await turn.end(aborted(s));
  });
});

describe('cancel', () => {
  it('aborts the owner through Pub/Sub, from another registry, and marks the terminal', async () => {
    const owner = reg();
    const other = reg();
    const s = sid();
    const turn = await owner.begin(s);
    expect(await other.cancel(s, turn.turnId)).toEqual({
      turnId: turn.turnId,
      outcome: 'requested',
    });
    await expect.poll(() => turn.signal.aborted, { timeout: 1000 }).toBe(true);
    expect(turn.abortReason).toBe('cancelled');
    const end = await turn.end(aborted(s));
    expect(end.frame).toMatchObject({ abortReason: 'cancelled', errorMessage: 'cancelled' });
  });

  it('the lease flag cancels without Pub/Sub', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    // Set the flag directly, publishing nothing: the renewal must find it.
    const lease = JSON.parse((await redis.get(activeKey(s)))!);
    await redis.set(activeKey(s), JSON.stringify({ ...lease, cancelRequested: true }), {
      KEEPTTL: true,
    });
    await expect.poll(() => turn.abortReason, { timeout: 1000 }).toBe('cancelled');
    await turn.end(aborted(s));
  });

  it('refuses a cancel naming another turn, and no-ops on an ended turn', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    await expect(r.cancel(s, 'not-this-one')).rejects.toMatchObject({
      name: 'TurnMismatchError',
      turnId: turn.turnId,
    });
    await turn.end(done(s));
    expect(await r.cancel(s, turn.turnId)).toEqual({ turnId: turn.turnId, outcome: 'ended' });
    await expect(r.cancel(sid())).rejects.toMatchObject({ name: 'TurnNotFoundError' });
  });
});

describe('watching', () => {
  it('aborts a turn nobody watches after detachedMaxMs', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    turn.watched(false);
    await expect.poll(() => turn.abortReason, { timeout: 2000 }).toBe('unwatched');
    const end = await turn.end(aborted(s));
    expect(end.frame).toMatchObject({ abortReason: 'unwatched' });
  });

  it('a watch key keeps an unwatched owner alive', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    turn.watched(false);
    const keep = setInterval(
      () => void redis.set(watchKey(s, turn.turnId), '1', { PX: T.leaseMs }),
      T.renewMs,
    );
    await redis.set(watchKey(s, turn.turnId), '1', { PX: T.leaseMs });
    await sleep(T.detachedMaxMs * 2);
    clearInterval(keep);
    expect(turn.signal.aborted).toBe(false);
    await turn.end(done(s));
  });

  it('aborts with lease_lost when another turn holds the lease', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    await redis.set(activeKey(s), JSON.stringify({ turnId: 'someone-else' }), { PX: 5000 });
    await expect.poll(() => turn.abortReason, { timeout: 1000 }).toBe('lease_lost');
    await turn.end(aborted(s));
    expect(JSON.parse((await redis.get(activeKey(s)))!).turnId).toBe('someone-else');
  });
});

describe('abortAll', () => {
  it('aborts every live turn with the reason and waits for their ends', async () => {
    const r = reg();
    const s = sid();
    const turn = await r.begin(s);
    turn.signal.addEventListener('abort', () => void turn.end(aborted(s)));
    await r.abortAll('restarting', 1000);
    expect(turn.abortReason).toBe('restarting');
    const rows = (await redis.xRange(eventsKey(s, turn.turnId), '-', '+')) ?? [];
    expect(JSON.parse(rows.at(-1)!.message.f)).toMatchObject({
      abortReason: 'restarting',
      errorMessage: 'harness restarting',
    });
  });
});
