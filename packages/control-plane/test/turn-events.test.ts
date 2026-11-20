import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { OwnershipIndex } from '../src/ownership.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { TurnStore } from '../src/turn-store.js';
import { compareCursor, type TurnRecord } from '../src/turn-record.js';
import { eventFrames, EVENT_HEARTBEAT_MS, EVENT_IDLE_MS } from '../src/turn-handlers.js';
import { alice, bob, codeOf, ctx, makeDeps, NOW_MS } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

/** Deps with a real TurnStore over one fake Redis, as turn-handlers.test.ts's turnDeps does. */
function eventDeps() {
  const fake = fakeRedis();
  const deps = makeDeps({ index: new OwnershipIndex(fake.redis), streams: fake.streams });
  const turns = new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 });
  return { ...deps, turns, turnQueue: new MemoryTurnQueue(), fake } as typeof deps & {
    turns: TurnStore;
    turnQueue: MemoryTurnQueue;
    fake: ReturnType<typeof fakeRedis>;
  };
}

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't-1',
  owner: alice.sub,
  tenant: alice.sub,
  sessionId: 's-1',
  cfg: '',
  credentialName: 'anthropic',
  model: '',
  sandboxTier: '',
  caps: { tokens: 1000 },
  idempotencyKey: 's-1',
  envelope: { item: { item_id: 'i1', file: 'f', pattern: 'p' } },
  state: 'queued',
  attempts: 0,
  createdAt: NOW_MS,
  ...over,
});

/** A clock whose `sleep` IS the passage of time: no timers, so the loop is deterministic. */
function clock(start: number) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/**
 * The first `n` frames of a stream, then close it. Pulling exactly as many as the stream already
 * has queued means no frame is ever awaited through the idle sleep, so this needs no fake timers.
 */
async function take(body: unknown, n: number): Promise<string[]> {
  const it = (body as AsyncIterable<string>)[Symbol.asyncIterator]();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = await it.next();
    if (next.done) break;
    out.push(next.value);
  }
  await it.return?.(undefined);
  return out;
}

const dataOf = (frame: string) =>
  JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as Record<string, unknown>;
const idOf = (frame: string) => /^id: (.*)$/m.exec(frame)?.[1];

const stream = (d: ReturnType<typeof eventDeps>, principal: unknown, since?: string) =>
  HANDLERS.streamEvents!(
    ctx({
      principal: principal as never,
      query: new URLSearchParams(since === undefined ? {} : { since }),
    }),
    d,
  );

describe('GET /v1/events (#392)', () => {
  it('primes the stream at once, then frames one event per transition with its cursor as the id', async () => {
    const d = eventDeps();
    // `since: '0-0'` is "everything retained": the whole log, from before the first entry.
    const res = await stream(d, alice, '0-0');
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/event-stream');
    expect(res.headers).toMatchObject({ 'cache-control': 'no-store' });

    await d.turns.create(rec());
    await d.turns.markRunning('t-1', 1);
    await d.turns.finalize('t-1', 'solved', NOW_MS + 5);

    const frames = await take(res.body, 4);
    expect(frames[0]).toBe(': ok\n\n');
    expect(frames.slice(1).map((f) => dataOf(f).state)).toEqual(['queued', 'running', 'solved']);
    expect(frames.slice(1).map(idOf)).toEqual(frames.slice(1).map((f) => dataOf(f).cursor));
    expect(dataOf(frames[1]!)).toMatchObject({ sessionId: 's-1', turnId: 't-1', attempts: 0 });
    expect(frames.slice(1).every((f) => f.startsWith('id: ') && f.includes('event: turn\n'))).toBe(
      true,
    );
  });

  it("never shows another subject's transitions", async () => {
    const d = eventDeps();
    const mine = await stream(d, alice, '0-0');
    await d.turns.create(rec({ turnId: 'b-1', owner: bob.sub, tenant: bob.sub, sessionId: 's-b' }));
    await d.turns.create(rec({ turnId: 'a-1', sessionId: 's-a' }));

    const frames = await take(mine.body, 2);
    expect(frames[0]).toBe(': ok\n\n');
    expect(frames).toHaveLength(2);
    expect(dataOf(frames[1]!)).toMatchObject({ turnId: 'a-1', sessionId: 's-a' });

    // And the mirror image, so the test cannot pass by alice's stream being empty. bob's log
    // already had an entry when this stream opened, and '0-0' replays it: no gap frame, because
    // '0-0' asks for everything retained rather than resuming from an issued cursor.
    const theirs = await stream(d, bob, '0-0');
    const bobFrames = await take(theirs.body, 2);
    expect(bobFrames[0]).toBe(': ok\n\n');
    expect(bobFrames.slice(1).map((f) => dataOf(f).turnId)).toEqual(['b-1']);
  });

  it('a reconnect with the last cursor misses no transition and repeats none', async () => {
    const d = eventDeps();
    const first = await stream(d, alice, '0-0');
    await d.turns.create(rec());
    const seen = await take(first.body, 2);
    const cursor = idOf(seen[1]!)!;

    // Transitions while the client is away.
    await d.turns.markRunning('t-1', 1);
    await d.turns.finalize('t-1', 'solved', NOW_MS + 5);

    const again = await stream(d, alice, cursor);
    const frames = await take(again.body, 3);
    expect(frames[0]).toBe(': ok\n\n');
    expect(frames.slice(1).map((f) => dataOf(f).state)).toEqual(['running', 'solved']);
  });

  it('starts from now without `since`, replaying nothing', async () => {
    const d = eventDeps();
    await d.turns.create(rec());
    const res = await stream(d, alice);
    await d.turns.markRunning('t-1', 1);
    const frames = await take(res.body, 2);
    expect(frames[0]).toBe(': ok\n\n');
    expect(dataOf(frames[1]!).state).toBe('running');
  });

  it('sends one gap frame when the cursor is older than the oldest retained event', async () => {
    const d = eventDeps();
    await d.turns.create(rec());
    // An issued cursor this log can no longer serve: later than `FROM_START`, so it is not the
    // "everything retained" sentinel, and asserted to precede the oldest entry rather than assumed
    // to -- the fake's ids are its own business.
    const oldest = await d.turns.firstEventId(alice.sub);
    const trimmed = '0-1';
    expect(compareCursor(trimmed, oldest)).toBeLessThan(0);
    const res = await stream(d, alice, trimmed);
    const frames = await take(res.body, 3);
    expect(frames[0]).toBe(': ok\n\n');
    expect(frames[1]).toBe(`event: gap\ndata: {"since":"${trimmed}"}\n\n`);
    expect(dataOf(frames[2]!).state).toBe('queued');

    // A cursor still inside the window gets no gap.
    const warm = await stream(d, alice, oldest);
    expect((await take(warm.body, 1))[0]).toBe(': ok\n\n');
  });

  it('sends the gap frame when NOTHING is retained, not just when the head was trimmed', async () => {
    // The whole key expired, which is what an owner idle for `resultTtl + margin` gets: there is no
    // oldest id to compare against, and a `since` cannot be continuous with a log that is gone.
    // Without this the client resumes silently at a later id -- the hole the frame exists to name.
    const d = eventDeps();
    expect(await d.turns.firstEventId(alice.sub)).toBe('');
    const res = await stream(d, alice, '5-0');
    expect((await take(res.body, 2))[1]).toBe('event: gap\ndata: {"since":"5-0"}\n\n');

    // No `since` on an empty log is NOT a gap: a client that asked for nothing lost nothing.
    const fresh = await stream(d, alice);
    expect((await take(fresh.body, 1))[0]).toBe(': ok\n\n');
  });

  it('refuses a `since` that is not a cursor', async () => {
    const d = eventDeps();
    expect(await codeOf(() => stream(d, alice, 'not-a-cursor'))).toBe('invalid_request');
    expect(await codeOf(() => stream(d, alice, '12-'))).toBe('invalid_request');
  });

  it('keeps an idle stream alive with a comment, and ends it at the cap', async () => {
    const d = eventDeps();
    const c = clock(0);
    const frames: string[] = [];
    for await (const f of eventFrames({
      turns: d.turns,
      owner: alice.sub,
      from: '0-0',
      gap: false,
      now: c.now,
      sleep: c.sleep,
      maxMs: EVENT_HEARTBEAT_MS + 5 * EVENT_IDLE_MS,
    })) {
      frames.push(f);
    }
    // Terminates on its own (the `for await` returning is the assertion), having kept the socket
    // written to once per heartbeat window: a comment, carrying no id, so no cursor moves.
    expect(frames).toEqual([': ok\n\n', ': keepalive\n\n']);
  });
});
