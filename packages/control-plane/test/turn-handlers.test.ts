import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { AUDIT_STREAM, OwnershipIndex } from '../src/ownership.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { TurnStore } from '../src/turn-store.js';
import { idempotencyKeyKey, turnKey } from '../src/turn-record.js';
import { asyncCounters, resetAsyncCounters } from '../src/counters.js';
import { alice, bob, codeOf, ctx, makeDeps, NOW_MS, seedCredential } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

const item = { item_id: 'i1', file: 'f.ts', pattern: 'p' };

/**
 * Deps with a real OwnershipIndex and a real TurnStore over ONE fake Redis, so a session created
 * through createSession is the session submitTurn reads. `newId` is a counter rather than the
 * fixture's constant: a submission and its session must not share an id, or an idempotency test
 * would pass by accident.
 *
 * `leafResults` and `streams` are both re-pointed at that same fake, which is the hazard the comment
 * at the end of makeDeps warns about: overriding `index` brings a new fake with it, and the fixture's
 * own defaults still read the OTHER one. Left alone, a `leaf:result:<sid>` seeded here would be
 * written to one map and read from another, so the §4.4 result assertion would fail; and `d.streams`
 * would be a permanently empty map, so an audit-stream assertion could never fail.
 */
function turnDeps(over: Record<string, unknown> = {}) {
  const fake = fakeRedis();
  let n = 0;
  const deps = makeDeps({
    index: new OwnershipIndex(fake.redis),
    leafResults: { get: async (k: string) => fake.strings.get(k) ?? null },
    streams: fake.streams,
    newId: () => `id-${++n}`,
    ...over,
  });
  const turns = new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 });
  const turnQueue = new MemoryTurnQueue();
  return { ...deps, turns, turnQueue, fake } as typeof deps & {
    turns: TurnStore;
    turnQueue: MemoryTurnQueue;
    fake: ReturnType<typeof fakeRedis>;
  };
}

/**
 * Every turn id that has a RECORD in the fake, read out of the hash keyspace rather than from a
 * handler's answer -- a duplicate-submission test has to see the record a 202 never mentioned.
 */
const PREFIX = turnKey('');
const recordedTurnIds = (d: ReturnType<typeof turnDeps>): string[] =>
  [...d.fake.hashes.keys()].filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));

/** Create a session owned by alice and return its id. */
async function session(d: ReturnType<typeof turnDeps>): Promise<string> {
  await seedCredential(d, 'github:1234');
  const res = await HANDLERS.createSession!(
    ctx({ principal: alice, body: { credentials: { inference: 'my-anthropic' } } }),
    d,
  );
  return (res.body as { sessionId: string }).sessionId;
}

const submit = (d: ReturnType<typeof turnDeps>, sid: string, body: unknown, who = alice) =>
  HANDLERS.submitTurn!(ctx({ principal: who, params: { id: sid }, body }), d);

beforeEach(() => resetAsyncCounters());

describe('submitTurn (spec §4.1)', () => {
  it('answers 202 with the session and turn ids, and enqueues the turn id alone', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const res = await submit(d, sid, { item, async: true });
    expect(res.status).toBe(202);
    const body = res.body as { sessionId: string; turnId: string };
    expect(body.sessionId).toBe(sid);
    expect(body.turnId).toBeTruthy();
    // 202 carries the turnId and NOTHING else -- no result, no partial state (§4.1).
    expect(Object.keys(body).sort()).toEqual(['sessionId', 'turnId']);
    expect(d.turnQueue.ids).toEqual([body.turnId]);
  });

  it('records the owner, tenant, session, credential NAME and caps on the record (§5.1)', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const res = await submit(d, sid, { item, async: true, caps: { tokens: 1234 } });
    const rec = await d.turns.get((res.body as { turnId: string }).turnId);
    expect(rec).toMatchObject({
      owner: 'github:1234',
      tenant: 'github:1234',
      sessionId: sid,
      credentialName: 'my-anthropic',
      state: 'queued',
      attempts: 0,
      caps: { tokens: 1234 },
      idempotencyKey: sid,
    });
    // The NAME, never the credential. A test that only checked the name was present would pass on a
    // record that carried the secret beside it.
    const raw = d.fake.hashes.get(turnKey(rec!.turnId))!;
    expect(JSON.stringify(raw)).not.toContain('sk-fake');
  });

  it('carries no TTL while the turn is queued (§5.1)', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await submit(d, sid, { item, async: true });
    // The invariant: "a record must never expire while its turn is live". A TTL set here would 404 a
    // caller polling a turn that in fact succeeded.
    expect(d.fake.expires).toEqual([]);
  });

  it('404s another subject s session before looking at the body at all', async () => {
    const d = turnDeps();
    const sid = await session(d);
    expect(await codeOf(() => submit(d, sid, { nonsense: true }, bob))).toBe('session_not_found');
    expect(d.turnQueue.depth()).toBe(0);
  });

  it('404s a tombstoned session, so a deleted session cannot start a new turn', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await d.index.tombstone(sid);
    expect(await codeOf(() => submit(d, sid, { item, async: true }))).toBe('session_not_found');
    expect(d.turnQueue.depth()).toBe(0);
  });

  it('401s with no principal, which is what the enumeration sweep asserts', async () => {
    const d = turnDeps();
    expect(
      await codeOf(() => HANDLERS.submitTurn!(ctx({ params: { id: 'x' }, body: {} }), d)),
    ).toBe('token_required');
  });

  it('refuses a workloadId with 501 BEFORE the quota and with nothing enqueued (§4.2)', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 0 } });
    const sid = await session(d);
    // asyncQueuedPerOwner is 0, so the quota would refuse everything -- asserting 501 here is what
    // pins the ORDER: the workload refusal must come first, or a caller sees 429 for a request that
    // can never be served at all.
    expect(await codeOf(() => submit(d, sid, { item, async: true, workloadId: 'w-1' }))).toBe(
      'workload_runs_unavailable',
    );
    expect(d.turnQueue.depth()).toBe(0);
  });

  it('refuses async under MOCA_TENANCY=multi, by name (M1 gate, §9)', async () => {
    const d = turnDeps({ config: { tenancy: 'multi' } });
    const sid = await session(d);
    expect(await codeOf(() => submit(d, sid, { item, async: true }))).toBe(
      'async_tenancy_unsupported',
    );
    expect(d.turnQueue.depth()).toBe(0);
  });

  it('refuses past the per-owner quota with 429, enqueueing NOTHING for the refused one (§4.3)', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 2 } });
    // Distinct sessions, because the idempotency key defaults to the session id: a fan-out of N
    // leaves is N sessions (§4.3), and submitting twice to one session would deduplicate instead.
    const a = await session(d);
    const b = await session(d);
    const c = await session(d);
    await submit(d, a, { item, async: true });
    await submit(d, b, { item, async: true });
    expect(await codeOf(() => submit(d, c, { item, async: true }))).toBe('async_quota_exhausted');
    // The assertion §8 names is the queue DEPTH, not the status code.
    expect(d.turnQueue.depth()).toBe(2);
    expect(asyncCounters().async_quota_refusals).toBe(1);
  });

  it('holds the quota against submissions that arrive at once (§4.3)', async () => {
    const quota = 3;
    const burst = 12;
    const d = turnDeps({ config: { asyncQueuedPerOwner: quota } });
    // One session each, because the idempotency key defaults to the session id: a fan-out of N
    // leaves is N sessions (§4.3), so this is the shape the quota exists to contain.
    const sessions = [];
    for (let i = 0; i < burst; i += 1) sessions.push(await session(d));

    // In flight TOGETHER, not one after another. Reading the count and then checking it holds
    // sequentially and not here: every submission reads the same under-limit number before any
    // other has written anything, so all 12 pass. Against real Redis the same read-then-check
    // accepted 100 of 100 with the limit at 5 -- the unbounded fan-out the quota is the only
    // containment for.
    const answers = await Promise.all(
      sessions.map((sid) => submit(d, sid, { item, async: true }).catch((err: Error) => err)),
    );

    const accepted = answers.filter((a) => !(a instanceof Error));
    // NEVER more than the limit is the invariant; exactly the limit is not promised under a burst.
    // A reserve-then-count check can refuse a whole batch -- all of them write, then all of them
    // read the full count -- and that direction is the safe one: the refused caller retries and the
    // next attempt is admitted, whereas an over-admitted turn is already fanned out.
    expect(accepted.length).toBeLessThanOrEqual(quota);
    expect(accepted.length).toBeLessThan(burst);
    expect(d.turnQueue.depth()).toBe(accepted.length);
    // Every refusal is the quota's, not some other error the race happened to produce.
    for (const a of answers.filter((x) => x instanceof Error))
      expect((a as { code?: string }).code).toBe('async_quota_exhausted');
    // A refused submission leaves NOTHING behind (§4.3) -- in particular not the slot it reserved
    // to make the check atomic. A leaked slot is permanent: no record exists for it, so no terminal
    // transition will ever remove it, and the owner's quota is smaller forever.
    expect(await d.turns.countOpen('github:1234')).toBe(accepted.length);
    expect(recordedTurnIds(d)).toHaveLength(accepted.length);
    // ...so the owner can still submit afterwards, up to the limit, one at a time.
    for (let i = accepted.length; i < quota; i += 1) {
      const sid = await session(d);
      expect((await submit(d, sid, { item, async: true })).status).toBe(202);
    }
    const overflow = await session(d);
    expect(await codeOf(() => submit(d, overflow, { item, async: true }))).toBe(
      'async_quota_exhausted',
    );
  });

  it('frees the slot it reserved when the submission is deduplicated', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 2 } });
    const sid = await session(d);
    const other = await session(d);
    // The resubmission reserves a slot before it discovers the live key and returns the first turn.
    // Leaking that slot would cost the owner a quota place for every retry of a 202 they already
    // had -- so two retries alone would exhaust a quota of 2 holding ONE real turn.
    const first = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    for (let i = 0; i < 5; i += 1) {
      const again = (await submit(d, sid, { item, async: true })).body as { turnId: string };
      expect(again.turnId).toBe(first.turnId);
    }
    expect(await d.turns.countOpen('github:1234')).toBe(1);
    expect((await submit(d, other, { item, async: true })).status).toBe(202);
  });

  it('names the owner s current count in the refusal message', async () => {
    // The count (3) and the limit (1) are deliberately DIFFERENT numbers, which takes submitting
    // under a generous limit and then lowering it -- as an operator may. With count == limit a bare
    // /1/ would match the limit and pass on a message that never names the count at all.
    const d = turnDeps({ config: { asyncQueuedPerOwner: 5 } });
    const sessions = [await session(d), await session(d), await session(d), await session(d)];
    for (const s of sessions.slice(0, 3)) await submit(d, s, { item, async: true });
    d.config.asyncQueuedPerOwner = 1;
    await expect(submit(d, sessions[3]!, { item, async: true })).rejects.toThrow(
      /you already have 3 non-terminal async turns \(limit 1\)/,
    );
  });

  it('frees a quota slot when a turn goes terminal, and never refuses another owner', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 1 } });
    const a = await session(d);
    const b = await session(d);
    const first = await submit(d, a, { item, async: true });
    await d.turns.finalize((first.body as { turnId: string }).turnId, 'done', NOW_MS);
    // The count is of NON-TERMINAL records, so draining one lets the next submission through.
    expect((await submit(d, b, { item, async: true })).status).toBe(202);
  });

  it('frees the quota slot of a turn whose session was deleted (F2)', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 1 } });
    const a = await session(d);
    await submit(d, a, { item, async: true });
    // The turn is still `queued` -- nothing drains it in this branch -- so without the cleanup
    // this slot would stay burned for the deployment's lifetime (#387 review F2).
    await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: a } }), d);
    const b = await session(d);
    expect((await submit(d, b, { item, async: true })).status).toBe(202);
  });

  it('deduplicates a resubmission on a non-terminal key, returning the FIRST turn id (§4.3)', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const first = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    const again = await submit(d, sid, { item, async: true });
    expect(again.status).toBe(202);
    expect((again.body as { turnId: string }).turnId).toBe(first.turnId);
    // Deduplicated, NOT queued behind: a client retrying a 202 it already received must not fan out.
    expect(d.turnQueue.depth()).toBe(1);
  });

  it('lets a session submit again once its previous async turn is terminal', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const first = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    await d.turns.finalize(first.turnId, 'done', NOW_MS);
    const again = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(again.turnId).not.toBe(first.turnId);
    expect(d.turnQueue.depth()).toBe(2);
  });

  it('creates ONE turn when two submissions race past the same terminal holder (§4.3)', async () => {
    const d = turnDeps();
    const sid = await session(d);
    // The key's holder is a finished turn, so BOTH racing submissions are entitled to step over it.
    const stale = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    await d.turns.finalize(stale.turnId, 'done', NOW_MS);
    // finalize (F1) already released the key on this path; re-seed it to a stale claim, which is
    // the state claimKey's stepover exists for -- e.g. a resubmission racing finalize's own release
    // (the `releaseIdempotencyKeyIf` window toTerminal uses, not the one tested here).
    await d.turns.claimIdempotencyKey('github:1234', sid, stale.turnId);

    // Deterministic interleave, no real concurrency: B's read of the stale holder is the gap, so A
    // runs to completion -- release, re-claim, create -- inside it, and B then continues on the
    // reading it already took. An unconditional release at that point deletes A's LIVE claim, and B
    // creates a second record and a second queue entry for one key: the duplicate fan-out.
    const realGet = d.turns.get.bind(d.turns);
    let aResult: { turnId: string } | null = null;
    let armed = true;
    d.turns.get = async (turnId: string) => {
      if (armed && turnId === stale.turnId) {
        armed = false;
        aResult = (await submit(d, sid, { item, async: true })).body as { turnId: string };
      }
      return realGet(turnId);
    };
    const b = (await submit(d, sid, { item, async: true })).body as { turnId: string };

    expect(aResult).not.toBeNull();
    expect(b.turnId).toBe(aResult!.turnId);
    // One record for the stale turn and one for A -- B added none.
    expect(recordedTurnIds(d).sort()).toEqual([aResult!.turnId, stale.turnId].sort());
    expect(d.turnQueue.ids).toEqual([stale.turnId, aResult!.turnId]);
    expect(d.turnQueue.depth()).toBe(2);
  });

  it('honours an explicit idempotencyKey, so two turns on one session are possible', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const one = (await submit(d, sid, { item, async: true, idempotencyKey: 'k1' })).body as {
      turnId: string;
    };
    const two = (await submit(d, sid, { item, async: true, idempotencyKey: 'k2' })).body as {
      turnId: string;
    };
    expect(two.turnId).not.toBe(one.turnId);
    expect(d.turnQueue.depth()).toBe(2);
  });

  it('finalizes the record and releases the key when the enqueue fails', async () => {
    const d = turnDeps();
    const sid = await session(d);
    d.turnQueue.failWith = new Error('redis gone');
    await expect(submit(d, sid, { item, async: true })).rejects.toThrow();
    // Each half of the compensation is pinned SEPARATELY, because the retry's 202 proves neither:
    // without `finalize` the first record sits `queued` with no queue entry -- never drained, never
    // terminal, so never given a TTL, a leak that outlives the process -- and without the release
    // the retry still succeeds, because claimKey steps over the now-terminal holder. So the released
    // key is asserted DIRECTLY, on the keyspace, rather than inferred from the retry succeeding.
    const firstId = recordedTurnIds(d)[0]!;
    expect((await d.turns.get(firstId))?.state).toBe('failed');
    expect(d.fake.hashes.has(idempotencyKeyKey('github:1234', sid))).toBe(false);

    d.turnQueue.failWith = null;
    const retry = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(retry.turnId).not.toBe(firstId);
    expect((await d.turns.get(retry.turnId))?.state).toBe('queued');
    expect(d.turnQueue.ids).toEqual([retry.turnId]);
  });

  it('leaves a newer claim alone when the enqueue fails under it', async () => {
    const d = turnDeps();
    const sid = await session(d);
    d.turnQueue.failWith = new Error('redis gone');

    // The interleave this compensates for. A's enqueue fails, so A finalizes its record -- which
    // ALREADY releases the key (F1) -- and only then releases the key itself. B runs in that gap:
    // it finds A's holder terminal, steps over it (claimKey's stepover) and claims the key for its
    // own live turn. A's release must therefore COMPARE: a blind `del` deletes B's live claim, and
    // the next submission then claims the freed key outright and fans out a SECOND turn for one key.
    let bResult: { turnId: string } | null = null;
    const realFinalize = d.turns.finalize.bind(d.turns);
    d.turns.finalize = async (turnId, state, now) => {
      const out = await realFinalize(turnId, state, now);
      if (bResult === null) {
        d.turnQueue.failWith = null;
        bResult = (await submit(d, sid, { item, async: true })).body as { turnId: string };
      }
      return out;
    };

    await expect(submit(d, sid, { item, async: true })).rejects.toThrow('redis gone');
    expect(bResult).not.toBeNull();
    // B's claim survived A's compensation, so B's turn still owns the key...
    expect(d.fake.hashes.get(idempotencyKeyKey('github:1234', sid))?.turnId).toBe(bResult!.turnId);
    // ...and a retry deduplicates onto B rather than fanning out a second live turn.
    const retry = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(retry.turnId).toBe(bResult!.turnId);
    expect(d.turnQueue.ids).toEqual([bResult!.turnId]);
  });

  it('audits the submission with the turn id and the credential name', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const res = await submit(d, sid, { item, async: true });
    const row = d.logLines.find((l) => l.decision === 'turn_submitted')!;
    expect(row).toMatchObject({
      subject: 'github:1234',
      sessionId: sid,
      turnId: (res.body as { turnId: string }).turnId,
      credential: 'my-anthropic',
    });
  });

  it('writes the turn id into the audit STREAM, not just the log line', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const res = await submit(d, sid, { item, async: true });
    const { turnId } = res.body as { turnId: string };
    // d.logLines is written by handler-util BEFORE index.audit(), so it is blind to the stream's
    // field set: the whole `turnId` field could vanish from ownership.audit and every logLines
    // assertion above would still pass. The stream is the durable, queryable record -- a submission
    // whose row names no turn cannot be traced to the turn it authorized.
    const row = d.streams.get(AUDIT_STREAM)!.find((r) => r.decision === 'turn_submitted')!;
    expect(row.turnId).toBe(turnId);
    expect(row).toMatchObject({
      subject: 'github:1234',
      sessionId: sid,
      credential: 'my-anthropic',
    });
  });

  it('audits a quota refusal with the error code as its reason', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 0 } });
    const sid = await session(d);
    await codeOf(() => submit(d, sid, { item, async: true }));
    expect(d.logLines.find((l) => l.decision === 'turn_refused')).toMatchObject({
      reason: 'async_quota_exhausted',
    });
  });
});

describe('getTurn (spec §4.4)', () => {
  const get = (d: ReturnType<typeof turnDeps>, sid: string, tid: string, who = alice) =>
    HANDLERS.getTurn!(ctx({ principal: who, params: { id: sid, turnId: tid } }), d);

  it('answers state and attempts from the RECORD', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(await get(d, sid, turnId)).toEqual({
      status: 200,
      body: { turnId, state: 'queued', attempts: 0 },
    });
    await d.turns.markRunning(turnId, 2);
    expect((await get(d, sid, turnId)).body).toMatchObject({ state: 'running', attempts: 2 });
  });

  it('includes the result once the leaf has written one', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    await d.turns.finalize(turnId, 'solved', NOW_MS);
    d.fake.strings.set(
      `leaf:result:${sid}`,
      JSON.stringify({ status: 'solved', patch: 'diff --git', sessionId: sid }),
    );
    expect((await get(d, sid, turnId)).body).toMatchObject({
      state: 'solved',
      result: { status: 'solved', patch: 'diff --git' },
    });
  });

  it('withholds a result while the turn is non-terminal, and reports it once terminal', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    // The result key is per SESSION and shared with the synchronous path, so this is what an earlier
    // INTERACTIVE turn on the same session leaves behind. Reporting it beside `queued` would hand a
    // caller polling for completion a stale result as if it were this turn's.
    d.fake.strings.set(`leaf:result:${sid}`, JSON.stringify({ status: 'done', patch: 'stale' }));
    const queued = (await get(d, sid, turnId)).body as Record<string, unknown>;
    expect(queued).toEqual({ turnId, state: 'queued', attempts: 0 });
    expect(queued.result).toBeUndefined();

    await d.turns.markRunning(turnId, 1);
    expect(((await get(d, sid, turnId)).body as Record<string, unknown>).result).toBeUndefined();

    await d.turns.finalize(turnId, 'done', NOW_MS);
    expect((await get(d, sid, turnId)).body).toMatchObject({
      state: 'done',
      result: { status: 'done', patch: 'stale' },
    });
  });

  it('reports no result for a cancelled turn, which never ran (§4.5)', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    // What an earlier INTERACTIVE turn on this session left in the shared per-session result key.
    d.fake.strings.set(
      `leaf:result:${sid}`,
      JSON.stringify({ status: 'done', patch: 'stale-interactive' }),
    );
    await HANDLERS.cancelTurn!(ctx({ principal: alice, params: { id: sid, turnId } }), d);

    // `cancelled` is terminal, but §4.5 defines it as withdrawing a turn that was still `queued`:
    // no leaf ever started, so nothing was written for it. Keying the result off terminality alone
    // hands back the PREVIOUS turn's patch as this turn's -- a caller that cancelled a turn and
    // polled it would read a successful result for work that never happened.
    const body = (await get(d, sid, turnId)).body as Record<string, unknown>;
    expect(body).toEqual({ turnId, state: 'cancelled', attempts: 0 });
    expect(body.result).toBeUndefined();
  });

  it('404s an unknown turn, and another subject s session before reading params.turnId', async () => {
    const d = turnDeps();
    const sid = await session(d);
    expect(await codeOf(() => get(d, sid, 'nope'))).toBe('not_found');
    expect(await codeOf(() => get(d, sid, 'nope', bob))).toBe('session_not_found');
    expect(
      await codeOf(() => HANDLERS.getTurn!(ctx({ principal: bob, params: { id: sid } }), d)),
    ).toBe('session_not_found');
  });

  it('404s a turn that exists but belongs to another session of the SAME owner', async () => {
    const d = turnDeps();
    const a = await session(d);
    const b = await session(d);
    const { turnId } = (await submit(d, a, { item, async: true })).body as { turnId: string };
    // Owner-scoped is not enough: the turn must be ON the session in the path, or `GET
    // /v1/sessions/{b}/turns/{t}` would report a turn that has nothing to do with session b.
    expect(await codeOf(() => get(d, b, turnId))).toBe('not_found');
  });
});

describe('cancelTurn (spec §4.5)', () => {
  const cancel = (d: ReturnType<typeof turnDeps>, sid: string, tid: string, who = alice) =>
    HANDLERS.cancelTurn!(ctx({ principal: who, params: { id: sid, turnId: tid } }), d);

  it('202s a queued turn and marks it cancelled', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(await cancel(d, sid, turnId)).toEqual({
      status: 202,
      body: { turnId, state: 'cancelled' },
    });
    expect((await d.turns.get(turnId))?.state).toBe('cancelled');
  });

  it('409s a running turn, naming its state, and does NOT interrupt it', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    await d.turns.markRunning(turnId, 1);
    // Interrupting a running leaf needs control-plane-to-specific-worker machinery that does not
    // exist; interactive cancel rides the turn's own connection and async has none (§4.5, §12).
    expect(await codeOf(() => cancel(d, sid, turnId))).toBe('turn_not_cancellable');
    // The STATE, not just the code: a caller told only "not cancellable" cannot tell a turn already
    // running from one already finished, and the two call for different next steps.
    await expect(cancel(d, sid, turnId)).rejects.toThrow(/'running'/);
    expect((await d.turns.get(turnId))?.state).toBe('running');
  });

  it('409s an already-terminal turn and 404s an unknown one', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    await d.turns.finalize(turnId, 'done', NOW_MS);
    expect(await codeOf(() => cancel(d, sid, turnId))).toBe('turn_not_cancellable');
    expect(await codeOf(() => cancel(d, sid, 'nope'))).toBe('not_found');
  });

  it('404s another subject s session before touching the turn', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const { turnId } = (await submit(d, sid, { item, async: true })).body as { turnId: string };
    expect(await codeOf(() => cancel(d, sid, turnId, bob))).toBe('session_not_found');
    expect((await d.turns.get(turnId))?.state).toBe('queued');
  });

  it('frees the quota slot, since cancelled is terminal', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 1 } });
    const a = await session(d);
    const b = await session(d);
    const { turnId } = (await submit(d, a, { item, async: true })).body as { turnId: string };
    await cancel(d, a, turnId);
    expect((await submit(d, b, { item, async: true })).status).toBe(202);
  });
});
