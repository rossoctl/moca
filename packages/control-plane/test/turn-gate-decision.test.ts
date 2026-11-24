import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { OwnershipIndex } from '../src/ownership.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { TurnStore } from '../src/turn-store.js';
import { idempotencyKeyKey, sessionTurnsKey } from '../src/turn-record.js';
import { leafResultKey } from '../src/turn-result.js';
import { CLAIM_GRACE_MS } from '../src/turn-handlers.js';
import {
  alice,
  bob,
  codeOf,
  ctx,
  makeDeps,
  NOW_MS,
  pausedResult,
  seedCredential,
} from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

/**
 * The same one-fake wiring `turn-handlers.test.ts` uses, so the session `createSession` wrote is the
 * session the decision route reads and the leaf result seeded here is the one it sees.
 */
function turnDeps() {
  const fake = fakeRedis();
  let n = 0;
  const deps = makeDeps({
    index: new OwnershipIndex(fake.redis),
    leafResults: { get: async (k: string) => fake.strings.get(k) ?? null },
    streams: fake.streams,
    newId: () => `id-${++n}`,
  });
  const turns = new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 });
  const turnQueue = new MemoryTurnQueue();
  return { ...deps, turns, turnQueue, fake } as typeof deps & {
    turns: TurnStore;
    turnQueue: MemoryTurnQueue;
    fake: ReturnType<typeof fakeRedis>;
  };
}

type Deps = ReturnType<typeof turnDeps>;

async function session(d: Deps): Promise<string> {
  await seedCredential(d, 'github:1234');
  const res = await HANDLERS.createSession!(
    ctx({ principal: alice, body: { credentials: { inference: 'my-anthropic' } } }),
    d,
  );
  return (res.body as { sessionId: string }).sessionId;
}

/** A session with one prompt turn parked at gate 0, as a gated leaf would leave it. */
async function paused(d: Deps, sid: string, gateId = 0, gateDeadlineS?: number): Promise<string> {
  const res = await HANDLERS.submitTurn!(
    ctx({
      principal: alice,
      params: { id: sid },
      body: {
        async: true,
        kind: 'prompt',
        prompt: 'hi',
        requireApproval: true,
        ...(gateDeadlineS ? { gateDeadlineS } : {}),
      },
    }),
    d,
  );
  const turnId = (res.body as { turnId: string }).turnId;
  // BEFORE the fixture's frozen `now`, which is when a resume is created: `toTerminal` re-scores the
  // session index to this moment, and the walk is newest-first -- so a paused turn scored after its
  // own resume would hide the resume that answered it.
  await d.turns.finalize(turnId, 'paused', NOW_MS - 1000);
  d.fake.strings.set(leafResultKey(sid, turnId), pausedResult(gateId));
  d.turnQueue.ids.length = 0;
  return turnId;
}

const decide = (d: Deps, sid: string, body: unknown, who = alice) =>
  HANDLERS.decideGate!(ctx({ principal: who, params: { id: sid }, body }), d);

describe('decideGate (#393, design §2)', () => {
  it('202s and enqueues a resume turn carrying the decision', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);

    const res = await decide(d, sid, { gateId: 0, action: 'approve', feedback: 'go' });
    expect(res.status).toBe(202);
    const turnId = (res.body as { turnId: string }).turnId;
    expect(d.turnQueue.ids).toEqual([turnId]);
    const rec = await d.turns.get(turnId);
    expect(rec).toMatchObject({
      state: 'queued',
      resumeOf: pausedId,
      sessionId: sid,
      credentialName: 'my-anthropic',
    });
    // The envelope is COPIED from the paused record: a decision cannot change the turn's inputs.
    expect(rec!.envelope).toEqual({
      kind: 'prompt',
      prompt: 'hi',
      requireApproval: true,
      decision: { gateId: 0, action: 'approve', feedback: 'go' },
    });
  });

  it('takes the answered gate out of the deadline index', async () => {
    // Otherwise the sweep would expire a gate a human already answered, and `onTimeout: 'abort'`
    // would abort the work the decision just approved.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid, 0, 60);
    await decide(d, sid, { gateId: 0, action: 'approve' });
    expect(await d.turns.dueGates(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('is idempotent: a second identical decision returns the same turn', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    const once = await decide(d, sid, { gateId: 0, action: 'approve' });
    const twice = await decide(d, sid, { gateId: 0, action: 'approve' });
    expect(twice.body).toEqual(once.body);
    expect(d.turnQueue.ids).toHaveLength(1);
  });

  it('409s on a gateId that is not the pending one', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    expect(await codeOf(() => decide(d, sid, { gateId: 3, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
    expect(d.turnQueue.ids).toHaveLength(0);
  });

  it('lets the submitted gateId through when no leaf result names one', async () => {
    // The HARNESS is the authority on which gate is pending; a control plane that cannot see the
    // result must not refuse a decision it has no basis to judge.
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);
    d.fake.strings.delete(leafResultKey(sid, pausedId));
    expect((await decide(d, sid, { gateId: 7, action: 'approve' })).status).toBe(202);
  });

  it('409s when the gate was already resumed', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);
    const first = await decide(d, sid, { gateId: 0, action: 'approve' });
    // The idempotency key would answer this on its own, so it is released: what must refuse the
    // second decision is `resumeOf` on the turn above, nothing else.
    await d.turns.releaseIdempotencyKeyIf(
      'github:1234',
      `${sid}:gate:0`,
      (first.body as { turnId: string }).turnId,
    );
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
    expect(pausedId).toBeTruthy();
  });

  it('409s on a DIFFERENT decision for a gate already resumed, rather than replaying', async () => {
    // The replay is promised for "the same decision" only. A human's `approve` landing after the
    // deadline sweep's `abort` must not be answered 202 with the abort turn's id -- that reports a
    // conflict as success and drops the approval silently.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    const first = await decide(d, sid, { gateId: 0, action: 'abort' });
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
    // Same action, different feedback is also a different decision: the first one already ran.
    expect(
      await codeOf(() => decide(d, sid, { gateId: 0, action: 'abort', feedback: 'why' })),
    ).toBe('gate_not_pending');
    // And the decision that DID resume it still replays, with its own turn id.
    expect((await decide(d, sid, { gateId: 0, action: 'abort' })).body).toEqual(first.body);
    expect(d.turnQueue.ids).toHaveLength(1);
  });

  it('409s when another decision won the gate key between the read and the submit', async () => {
    // The race `found.resumed` cannot catch, because it was still false when this caller read: the
    // sweep's `abort` has written its record and claimed the gate key but not yet joined the session
    // index (`create` writes the hash first, the index after), so the human's `approve` sees an
    // unresumed gate and goes on to lose the claim. `submitResume` hands the loser the WINNER's turn
    // id, and a 202 there would report that the approval was accepted when the abort is what runs.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    const winner = (
      (await decide(d, sid, { gateId: 0, action: 'abort' })).body as { turnId: string }
    ).turnId;
    // Back to the mid-`create` window: record live and key held, session index not yet written.
    await d.fake.redis.zRem(sessionTurnsKey(sid), winner);
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
    // ...and no second resume fanned out: the abort is still the only queued turn.
    expect(d.turnQueue.ids).toEqual([winner]);
  });

  it('fans out NO second resume when the gate key is held by a turn still being created (#989)', async () => {
    // One step earlier than the race above: the winner has claimed the gate key but has not written
    // its record at all, so the loser cannot read it. Both resumes carry the same decision, and the
    // second leaf finds the gate already decided and re-derives the same continuation -- so a
    // stepover here runs one human approval TWICE. The claim is treated as live for its grace, and
    // the answer is the same 409 a readable winner gives: nothing created, nothing enqueued.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    await d.turns.claimIdempotencyKey('github:1234', `${sid}:gate:0`, 't-ghost');
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
    expect(d.turnQueue.ids).toEqual([]);
  });

  it('resumes the gate once the orphaned claim on its key is past the grace (#989)', async () => {
    // The other half: a claimant that died before writing its record must not hold the gate shut
    // forever. Past CLAIM_GRACE_MS the claim is stepped over and the decision resumes normally.
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);
    await d.turns.claimIdempotencyKey('github:1234', `${sid}:gate:0`, 't-ghost');
    d.fake.hashes.set(idempotencyKeyKey('github:1234', `${sid}:gate:0`), {
      turnId: 't-ghost',
      'claimedAt:t-ghost': String(NOW_MS - CLAIM_GRACE_MS - 1),
    });
    const res = await decide(d, sid, { gateId: 0, action: 'approve' });
    expect(res.status).toBe(202);
    const turnId = (res.body as { turnId: string }).turnId;
    expect((await d.turns.get(turnId))?.resumeOf).toBe(pausedId);
    expect(d.turnQueue.ids).toEqual([turnId]);
  });

  it('409s when the session has no paused turn', async () => {
    const d = turnDeps();
    const sid = await session(d);
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'approve' }))).toBe(
      'gate_not_pending',
    );
  });

  it('checks ownership before the body', async () => {
    // The authz enumeration contract: a stranger gets session_not_found, not invalid_request.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    expect(await codeOf(() => decide(d, sid, undefined, bob))).toBe('session_not_found');
  });

  it('refuses a malformed decision', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    expect(await codeOf(() => decide(d, sid, { action: 'approve' }))).toBe('invalid_request');
    expect(await codeOf(() => decide(d, sid, { gateId: 0, action: 'maybe' }))).toBe(
      'invalid_request',
    );
    expect(
      await codeOf(() =>
        decide(d, sid, { gateId: 0, action: 'approve', feedback: 'x'.repeat(5000) }),
      ),
    ).toBe('invalid_request');
  });
});

const submit = (d: Deps, sid: string, body: Record<string, unknown>) =>
  HANDLERS.submitTurn!(
    ctx({ principal: alice, params: { id: sid }, body: { async: true, ...body } }),
    d,
  );

const GATED_PROMPT = { kind: 'prompt', prompt: 'again', requireApproval: true };

describe('one open gate per session (#393)', () => {
  it('refuses a second GATED turn while a gate is open', async () => {
    // The gate is session state: a second gated turn parks on the OPEN gate, reports its id as its
    // own, and -- being newer -- is the turn a decision resumes, stranding the first.
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);
    expect(await codeOf(() => submit(d, sid, GATED_PROMPT))).toBe('gate_pending');
    expect(d.turnQueue.ids).toEqual([]);
    // Refused before the reservation, so it did not burn a quota slot either.
    expect(await d.turns.countOpen('github:1234')).toBe(0);
    // And the gate is still the first turn's, answerable as before.
    expect((await decide(d, sid, { gateId: 0, action: 'approve' })).status).toBe(202);
    expect((await d.turns.get(d.turnQueue.ids[0]!))?.resumeOf).toBe(pausedId);
  });

  it('refuses a converge turn that asks with item.require_approval', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    const item = { item_id: 'i1', file: 'a.ts', pattern: 'p', require_approval: true };
    expect(await codeOf(() => submit(d, sid, { item }))).toBe('gate_pending');
  });

  it('admits an UNGATED turn while a gate is open', async () => {
    // The refusal is narrow by design: an ordinary turn never calls `request_approval`, so it
    // cannot park on the open gate, and a session must stay usable while a human thinks.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    expect((await submit(d, sid, { kind: 'prompt', prompt: 'unrelated' })).status).toBe(202);
    expect(d.turnQueue.ids).toHaveLength(1);
  });

  it('admits a gated turn once the gate has been answered AND its resume has finished', async () => {
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    const resumeId = (
      (await decide(d, sid, { gateId: 0, action: 'approve' })).body as { turnId: string }
    ).turnId;
    // Not yet: the resume carries the paused turn's envelope, gate flag included, so while it is
    // queued it can still park on this session's gate itself. A fresh `idempotencyKey` throughout,
    // since the resume holds the session's default.
    expect(await codeOf(() => submit(d, sid, { ...GATED_PROMPT, idempotencyKey: 'k2' }))).toBe(
      'gate_pending',
    );
    // AFTER the paused turn's own `endedAt`, because `toTerminal` re-scores the session index to
    // this moment and the walk is newest-first -- which is also the real ordering: a resume ends
    // after the turn it resumes.
    await d.turns.finalize(resumeId, 'done', NOW_MS + 1000);
    // Now nothing holds the gate: the paused turn is answered and the resume is terminal.
    expect((await submit(d, sid, { ...GATED_PROMPT, idempotencyKey: 'k3' })).status).toBe(202);
  });

  it('refuses a second gated turn while the first is still QUEUED', async () => {
    // The window the `paused`-only read missed, and the wide one: a turn is unpaused for the whole
    // of its run, so a second gated turn used to be admitted through all of it and then park on the
    // first's gate once that opened.
    const d = turnDeps();
    const sid = await session(d);
    expect((await submit(d, sid, GATED_PROMPT)).status).toBe(202);
    expect(await codeOf(() => submit(d, sid, { ...GATED_PROMPT, idempotencyKey: 'k2' }))).toBe(
      'gate_pending',
    );
    // And an UNGATED turn is still admitted alongside it: it never calls request_approval.
    expect(
      (await submit(d, sid, { kind: 'prompt', prompt: 'hi', idempotencyKey: 'k3' })).status,
    ).toBe(202);
  });

  it('replays a RETRY of the gated submission that opened the gate', async () => {
    // The gate guard runs before the idempotency claim, so it saw a client re-sending a 202 it never
    // received as a second gated turn and refused it -- leaving that client unable to tell
    // "succeeded, here is your turn" from "rejected", against the 202-on-a-live-key the API promises.
    // No `idempotencyKey` here on purpose: the default is the session id, so this is the plain retry.
    const d = turnDeps();
    const sid = await session(d);
    const first = await submit(d, sid, GATED_PROMPT);
    const retry = await submit(d, sid, GATED_PROMPT);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(first.body);
    // Replayed, not re-run: one queue entry for the two submissions.
    expect(d.turnQueue.ids).toEqual([(first.body as { turnId: string }).turnId]);
    // And a retry on a DIFFERENT key is still a second gated turn, which is what the guard is for.
    expect(await codeOf(() => submit(d, sid, { ...GATED_PROMPT, idempotencyKey: 'k2' }))).toBe(
      'gate_pending',
    );
  });

  it('refuses a same-key retry once that turn is PAUSED', async () => {
    // `paused` is terminal, so its idempotency key has already been released -- a fall-through would
    // win the key fresh and open the second gated turn the guard exists to prevent. The retry's
    // answer here is the refusal's own instruction: answer the gate, do not resubmit.
    const d = turnDeps();
    const sid = await session(d);
    await paused(d, sid);
    expect(await codeOf(() => submit(d, sid, GATED_PROMPT))).toBe('gate_pending');
    expect(d.turnQueue.ids).toEqual([]);
  });

  it('400s on requireApproval sent with a converge submission', async () => {
    // Dropped silently until now, which ran an UNGATED turn for a caller who asked for a gate.
    const d = turnDeps();
    const sid = await session(d);
    const item = { item_id: 'i1', file: 'a.ts', pattern: 'p' };
    expect(await codeOf(() => submit(d, sid, { item, requireApproval: true }))).toBe(
      'invalid_request',
    );
    expect((await submit(d, sid, { item })).status).toBe(202);
  });

  it('reports resumeOf on the status read', async () => {
    const d = turnDeps();
    const sid = await session(d);
    const pausedId = await paused(d, sid);
    const resumeId = (
      (await decide(d, sid, { gateId: 0, action: 'approve' })).body as {
        turnId: string;
      }
    ).turnId;
    const status = (id: string) =>
      HANDLERS.getTurn!(ctx({ principal: alice, params: { id: sid, turnId: id } }), d);
    expect((await status(resumeId)).body).toMatchObject({ resumeOf: pausedId });
    // Absent on a turn that is not a resume, rather than null.
    expect('resumeOf' in ((await status(pausedId)).body as object)).toBe(false);
  });
});
