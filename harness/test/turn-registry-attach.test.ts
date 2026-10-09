import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  activeKey,
  eventsKey,
  lastKey,
  parseEventId,
  type LoggedFrame,
  TurnRegistry,
  watchKey,
} from '../src/turn-registry.js';

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const T = { leaseMs: 300, renewMs: 100, detachedMaxMs: 60_000, logTtlS: 60, maxLen: 1000 };
const redis = createClient({ url: URL });
await redis.connect();
const regs: TurnRegistry[] = [];
const reg = () => {
  const r = new TurnRegistry({ url: URL, ownerId: `a-${regs.length}`, timings: T });
  regs.push(r);
  return r;
};
const sid = () => `s-${randomUUID()}`;
const done = (sessionId: string) => ({ type: 'done' as const, sessionId, stopReason: 'stop' });
async function collect(gen: AsyncGenerator<LoggedFrame>): Promise<LoggedFrame[]> {
  const out: LoggedFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}
const types = (fs: LoggedFrame[]) => fs.map((f) => f.frame.type);

afterEach(async () => {
  await Promise.all(regs.splice(0).map((r) => r.close()));
});
afterAll(async () => {
  await redis.close();
});

describe('attach', () => {
  it('replays a finished turn from the start, turn frame first', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    await turn.append({ type: 'text', delta: 'a' });
    await turn.append({ type: 'text', delta: 'b' });
    await turn.end(done(s));
    const got = await collect(reg().attach(s, undefined));
    expect(types(got)).toEqual(['turn', 'text', 'text', 'done']);
    expect(got[0]!.frame).toEqual({ type: 'turn', turnId: turn.turnId, sessionId: s });
    expect(got.every((f) => parseEventId(f.id)?.turnId === turn.turnId)).toBe(true);
  });

  it('resumes after a cursor of the same turn, without repeats', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    const first = await turn.append({ type: 'text', delta: 'a' });
    await turn.append({ type: 'text', delta: 'b' });
    await turn.end(done(s));
    const got = await collect(reg().attach(s, first));
    expect(types(got)).toEqual(['turn', 'text', 'done']);
    expect(got[1]!.frame).toEqual({ type: 'text', delta: 'b' });
  });

  it('foreign or malformed cursor replays from the start', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    await turn.append({ type: 'text', delta: 'a' });
    await turn.end(done(s));
    for (const cursor of ['garbage', 'older-turn:1-0', '']) {
      expect(types(await collect(reg().attach(s, cursor)))).toEqual(['turn', 'text', 'done']);
    }
  });

  it('follows a live turn to its terminal and refreshes the watch key', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    const gen = reg().attach(s, undefined);
    const got: LoggedFrame[] = [];
    const reading = (async () => {
      for await (const f of gen) got.push(f);
    })();
    await expect.poll(() => got.length).toBe(1); // the turn frame
    await expect.poll(() => redis.exists(watchKey(s, turn.turnId))).toBe(1);
    await turn.append({ type: 'text', delta: 'live' });
    await turn.end(done(s));
    await reading;
    expect(types(got)).toEqual(['turn', 'text', 'done']);
  });

  it('marks a replay truncated when the cursor was trimmed away', async () => {
    const owner = reg();
    const s = sid();
    const turn = await owner.begin(s);
    await turn.append({ type: 'text', delta: 'a' });
    await turn.end(done(s));
    // A cursor older than every retained entry, in this turn.
    const got = await collect(reg().attach(s, `${turn.turnId}:0-1`));
    expect(got[0]!.frame).toMatchObject({ type: 'turn', truncated: true });
    expect(types(got)).toEqual(['turn', 'text', 'done']);
  });

  it('writes one synthetic terminal when the owner is gone, under concurrent attaches', async () => {
    const s = sid();
    const turnId = randomUUID();
    // A turn whose owner "crashed": a lapsing lease, a log with no terminal.
    await redis.set(activeKey(s), JSON.stringify({ turnId }), { PX: 200 });
    await redis.set(lastKey(s), turnId);
    await redis.xAdd(eventsKey(s, turnId), '*', {
      f: JSON.stringify({ type: 'turn', turnId, sessionId: s }),
    });
    await redis.xAdd(eventsKey(s, turnId), '*', {
      f: JSON.stringify({ type: 'text', delta: 'half' }),
    });
    const [a, b] = await Promise.all([
      collect(reg().attach(s, undefined)),
      collect(reg().attach(s, undefined)),
    ]);
    for (const got of [a, b]) {
      expect(got.at(-1)!.frame).toMatchObject({
        type: 'error',
        stopReason: 'aborted',
        abortReason: 'owner_lost',
        errorMessage: 'the harness process running this turn stopped',
      });
    }
    const rows = (await redis.xRange(eventsKey(s, turnId), '-', '+')) ?? [];
    expect(rows.filter((r) => JSON.parse(r.message.f).type === 'error')).toHaveLength(1);
  });

  it('throws TurnNotFoundError for a session with no retained turn', async () => {
    await expect(collect(reg().attach(sid(), undefined))).rejects.toMatchObject({
      name: 'TurnNotFoundError',
    });
  });

  it('abort destroys the reader at once', async () => {
    const owner = reg();
    const s = sid();
    await owner.begin(s);
    // A 1 s block window, so "at once" and "when the block times out" are far apart.
    const slow = new TurnRegistry({ url: URL, ownerId: 'slow', timings: { ...T, renewMs: 2000 } });
    regs.push(slow);
    const ac = new AbortController();
    const gen = slow.attach(s, undefined, ac.signal);
    await gen.next(); // the turn frame
    const pending = gen.next();
    await new Promise((r) => setTimeout(r, 100)); // the reader is now blocked in XREAD
    const t0 = Date.now();
    ac.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it('close ends a following attach at once and quietly', async () => {
    const owner = reg();
    const s = sid();
    await owner.begin(s);
    const r = new TurnRegistry({ url: URL, ownerId: 'closer', timings: { ...T, renewMs: 2000 } });
    const gen = r.attach(s, undefined);
    await gen.next(); // the turn frame
    const pending = gen.next();
    await new Promise((res) => setTimeout(res, 100)); // blocked in XREAD
    const t0 = Date.now();
    await r.close();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(Date.now() - t0).toBeLessThan(200); // at once, not when the 1 s block times out
  });
});
