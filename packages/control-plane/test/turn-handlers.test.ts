import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { OwnershipIndex } from '../src/ownership.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { TurnStore } from '../src/turn-store.js';
import { turnKey } from '../src/turn-record.js';
import { asyncCounters, resetAsyncCounters } from '../src/counters.js';
import { alice, bob, codeOf, ctx, makeDeps, NOW_MS, seedCredential } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

const item = { item_id: 'i1', file: 'f.ts', pattern: 'p' };

/**
 * Deps with a real OwnershipIndex and a real TurnStore over ONE fake Redis, so a session created
 * through createSession is the session submitTurn reads. `newId` is a counter rather than the
 * fixture's constant: a submission and its session must not share an id, or an idempotency test
 * would pass by accident. `leafResults` is re-pointed at the same fake for the same reason -- the
 * fixture's own default reads a DIFFERENT fake, so a result seeded here would be invisible.
 */
function turnDeps(over: Record<string, unknown> = {}) {
  const fake = fakeRedis();
  let n = 0;
  const deps = makeDeps({
    index: new OwnershipIndex(fake.redis),
    leafResults: { get: async (k: string) => fake.strings.get(k) ?? null },
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

  it('names the owner s current count in the refusal message', async () => {
    const d = turnDeps({ config: { asyncQueuedPerOwner: 1 } });
    const a = await session(d);
    const b = await session(d);
    await submit(d, a, { item, async: true });
    await expect(submit(d, b, { item, async: true })).rejects.toThrow(/1/);
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
    // A `queued` record with no queue entry would never drain, never go terminal and therefore never
    // acquire a TTL -- a leak that outlives the process. The compensation is what prevents it, and
    // releasing the key is what lets the caller retry at all.
    d.turnQueue.failWith = null;
    const retry = await submit(d, sid, { item, async: true });
    expect(retry.status).toBe(202);
    expect(d.turnQueue.depth()).toBe(1);
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
