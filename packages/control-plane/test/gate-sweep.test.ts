import { beforeEach, describe, expect, it, vi } from 'vitest';
// `handlers.js` FIRST, and before anything that reaches `turn-handlers.js`: the two are in a module
// cycle, and whichever side evaluates first wins -- entered through `turn-handlers.js`, HANDLERS
// spreads a TURN_HANDLERS that is not initialized yet and silently has no turn routes at all.
import { HANDLERS } from '../src/handlers.js';
import { GATE_TIMEOUT_FEEDBACK, startGateSweep, sweepGates } from '../src/gate-sweep.js';
import { OwnershipIndex } from '../src/ownership.js';
import { MemoryTurnQueue } from '../src/turn-queue.js';
import { turnKey, type TurnRecord } from '../src/turn-record.js';
import { leafResultKey } from '../src/turn-result.js';
import { TurnStore } from '../src/turn-store.js';
import { CLAIM_GRACE_MS } from '../src/turn-handlers.js';
import { alice, ctx, makeDeps, pausedResult, seedCredential } from './helpers/deps.js';
import { fakeRedis } from './helpers/fake-redis.js';

/** When the gate opened, and how long it may stay open: so it is due at exactly `PAUSED_AT + 60s`. */
const PAUSED_AT = 1_000;
const DEADLINE_S = 60;
const DUE_AT = PAUSED_AT + DEADLINE_S * 1000;

/** A queue that refuses ONE turn id, so a pass can be made to survive a single bad gate. */
class PickyQueue extends MemoryTurnQueue {
  readonly fails = new Set<string>();
  override async enqueue(turnId: string): Promise<string> {
    if (this.fails.has(turnId)) throw new Error(`enqueue refused ${turnId}`);
    return super.enqueue(turnId);
  }
}

/**
 * The same one-fake wiring `turn-gate-decision.test.ts` uses, with a MUTABLE clock: "due" is set by
 * moving `now` rather than by sleeping, which is the only thing a deadline test needs to control.
 */
function sweepDeps() {
  const fake = fakeRedis();
  let n = 0;
  let now = DUE_AT;
  const turns = new TurnStore(fake.redis, { resultTtlSeconds: 86_400, ttlMarginSeconds: 3_600 });
  const turnQueue = new PickyQueue();
  const deps = makeDeps({
    index: new OwnershipIndex(fake.redis),
    leafResults: { get: async (k: string) => fake.strings.get(k) ?? null },
    streams: fake.streams,
    newId: () => `id-${++n}`,
    now: () => now,
    turns,
    turnQueue,
  });
  // The concrete `turns`/`turnQueue` are re-stated AFTER the spread rather than cast over it: on
  // `CpDeps` both are optional, so a cast would be asserting past two `| undefined`s.
  return {
    ...deps,
    turns,
    turnQueue,
    fake,
    setNow: (v: number) => {
      now = v;
    },
    nowOf: () => now,
  };
}

type Deps = ReturnType<typeof sweepDeps>;

let deps: Deps;
beforeEach(() => {
  deps = sweepDeps();
});

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't-1',
  owner: 'github:1234',
  tenant: 'github:1234',
  sessionId: 's-1',
  cfg: '',
  credentialName: 'anthropic',
  model: '',
  sandboxTier: '',
  caps: {},
  idempotencyKey: 's-1',
  envelope: { kind: 'prompt', prompt: 'hi', requireApproval: true },
  state: 'queued',
  attempts: 0,
  createdAt: 1,
  gateDeadlineS: DEADLINE_S,
  ...over,
});

/** Park a turn at gate 0 and index it, as `toTerminal` does on the real paused transition. */
async function pausedTurn(over: Partial<TurnRecord> & { result?: null } = {}): Promise<TurnRecord> {
  const { result, ...fields } = over;
  const turn = rec(fields);
  await deps.turns.create(turn);
  if (result !== null) {
    deps.fake.strings.set(leafResultKey(turn.sessionId, turn.turnId), pausedResult(0));
  }
  await deps.turns.finalize(turn.turnId, 'paused', PAUSED_AT);
  return turn;
}

/**
 * A session the ROUTES built, with its one gated turn parked at gate 0: what the decision route
 * reads has to be the session `createSession` wrote, so these tests cannot shortcut it with `create`.
 */
async function gatedSession(): Promise<{ sessionId: string; turnId: string }> {
  await seedCredential(deps, 'github:1234');
  const created = await HANDLERS.createSession!(
    ctx({ principal: alice, body: { credentials: { inference: 'my-anthropic' } } }),
    deps,
  );
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const submitted = await HANDLERS.submitTurn!(
    ctx({
      principal: alice,
      params: { id: sessionId },
      body: {
        async: true,
        kind: 'prompt',
        prompt: 'hi',
        requireApproval: true,
        gateDeadlineS: DEADLINE_S,
      },
    }),
    deps,
  );
  // Parked by hand on the record the route created, rather than re-`create`d: the decision route
  // reads the session the route wrote, and a second create would replace its idempotency key.
  const turnId = (submitted.body as { turnId: string }).turnId;
  deps.fake.strings.set(leafResultKey(sessionId, turnId), pausedResult(0));
  await deps.turns.finalize(turnId, 'paused', PAUSED_AT);
  deps.turnQueue.ids.length = 0;
  return { sessionId, turnId };
}

const decisionOf = async (turnId: string) =>
  (await deps.turns.get(turnId))?.envelope.decision as
    { gateId: number; action: string; feedback?: string } | undefined;

describe('sweepGates (#393, design §3)', () => {
  it('resumes an expired gate with the turn onTimeout and a feedback note', async () => {
    await pausedTurn({ onTimeout: 'reject' });
    expect(await sweepGates(deps)).toBe(1);
    const resumeId = deps.turnQueue.ids[0]!;
    expect((await deps.turns.get(resumeId))?.resumeOf).toBe('t-1');
    expect(await decisionOf(resumeId)).toEqual({
      gateId: 0,
      action: 'reject',
      feedback: GATE_TIMEOUT_FEEDBACK,
    });
  });

  it('defaults to abort -- a clock cannot consent', async () => {
    await pausedTurn();
    await sweepGates(deps);
    expect((await decisionOf(deps.turnQueue.ids[0]!))?.action).toBe('abort');
  });

  it('leaves a gate that is not due', async () => {
    await pausedTurn();
    deps.setNow(DUE_AT - 1000);
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([]);
  });

  it('does nothing on a second pass', async () => {
    await pausedTurn();
    expect(await sweepGates(deps)).toBe(1);
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toHaveLength(1);
  });

  it('drops a gate whose record is gone', async () => {
    await pausedTurn();
    await deps.fake.redis.del([turnKey('t-1')]);
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([]);
    // The member is gone too, so the next pass costs nothing.
    expect(await deps.turns.dueGates(deps.nowOf())).toEqual([]);
  });

  it('keeps a gate whose result is not readable yet', async () => {
    await pausedTurn({ result: null });
    expect(await sweepGates(deps)).toBe(0);
    expect(await deps.turns.dueGates(deps.nowOf())).toEqual(['t-1']);
  });

  it('a human decision and the sweep converge on one resume', async () => {
    const { sessionId } = await gatedSession();
    const byHand = await HANDLERS.decideGate!(
      ctx({ principal: alice, params: { id: sessionId }, body: { gateId: 0, action: 'approve' } }),
      deps,
    );
    // The decision cleared the index, so the sweep has nothing left to expire -- which is the point:
    // an approved gate must not also be aborted thirty seconds later.
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([(byHand.body as { turnId: string }).turnId]);
  });

  it('hands the gate back when the resume fails to submit, and a later pass retries it', async () => {
    // The ZREM is the lock, so a claim whose submission failed is the one way a gate stops being
    // due forever. The hand-back is what keeps the deadline a promise rather than a best effort.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await pausedTurn();
      deps.turnQueue.fails.add('t-id-1');
      expect(await sweepGates(deps)).toBe(0);
      expect(await deps.turns.dueGates(deps.nowOf())).toEqual(['t-1']);
      // The failed resume must not look like an answer either, or nothing could retry it.
      expect((await deps.turns.findPausedBySession('s-1'))?.resumed).toBe(false);
      deps.turnQueue.fails.clear();
      expect(await sweepGates(deps)).toBe(1);
      expect(deps.turnQueue.ids).toEqual(['t-id-2']);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('does NOT hand the gate back when it was answered in the failing window', async () => {
    // The double-spend the hand-back could cause: a human decision lands while this pass is failing,
    // and by the time a later pass looked at the member that resume has finished -- which releases
    // its gate-keyed idempotency key, so only `resumeOf` still records that the gate was answered. A
    // second resume there would run the continuation twice for one decision.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const paused = await pausedTurn();
      // DURING the window, not before it: the answer has to arrive after this pass read the gate as
      // unresumed, or the pre-`submitResume` check catches it and there is no failure to guard.
      const enqueue = vi
        .spyOn(deps.turnQueue, 'enqueue')
        .mockImplementation(async (turnId: string) => {
          await deps.turns.create(
            rec({
              turnId: 't-human',
              createdAt: deps.nowOf(),
              resumeOf: paused.turnId,
              idempotencyKey: 's-1:gate:0',
            }),
          );
          // Finished, which releases the gate-keyed key: `resumeOf` is all that is left to read.
          await deps.turns.finalize('t-human', 'done', deps.nowOf());
          throw new Error(`enqueue refused ${turnId}`);
        });
      expect(await sweepGates(deps)).toBe(0);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(await deps.turns.dueGates(deps.nowOf())).toEqual([]);
      // A later pass therefore has nothing to retry, which is the point.
      expect(await sweepGates(deps)).toBe(0);
      expect(deps.turnQueue.ids).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not resume a gate whose member was STRANDED by an answered resume', async () => {
    // `submitResume` claims the gate only after its enqueue, so a crash or a Redis error in between
    // leaves the member on a gate that was answered. By the time a later pass reads it that resume
    // has finished, and `toTerminal` released the gate-keyed idempotency key -- so the key no longer
    // converges this pass onto it and a second resume would run the continuation twice.
    const paused = await pausedTurn();
    await deps.turns.create(
      rec({
        turnId: 't-orphan',
        createdAt: deps.nowOf(),
        resumeOf: paused.turnId,
        idempotencyKey: 's-1:gate:0',
      }),
    );
    // Finished, which is what releases the key: the only durable evidence left is `resumeOf`.
    await deps.turns.finalize('t-orphan', 'done', deps.nowOf());
    expect(await deps.turns.idempotencyHolder(paused.owner, 's-1:gate:0')).toBeNull();
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([]);
    // The stale member is taken out rather than handed back: the gate IS answered.
    expect(await deps.turns.dueGates(deps.nowOf())).toEqual([]);
  });

  it('does not count a resume a human created', async () => {
    // The sweep's return value is "gates this pass expired". A human's `submitResume` that claimed
    // the gate key between our `claimGate` and our own submission hands its turn id back to us, and
    // counting that would report an expiry for a gate a human answered.
    const paused = await pausedTurn();
    const human = 't-human';
    await deps.turns.create(
      rec({
        turnId: human,
        createdAt: deps.nowOf(),
        resumeOf: paused.turnId,
        idempotencyKey: 's-1:gate:0',
      }),
    );
    // The key, held and not yet released: exactly the state a human resume is in between its own
    // claim and its `claimGate`.
    expect(await deps.turns.claimIdempotencyKey(paused.owner, 's-1:gate:0', human)).toBe(human);
    expect(await sweepGates(deps)).toBe(0);
    // And no second turn was built: the claim replayed the human's.
    expect(deps.turnQueue.ids).toEqual([]);
  });

  it('hands the gate back when its key is held by a resume with no record YET (#989)', async () => {
    // Since #989 an unreadable holder is answered with ITS turn id inside the grace instead of being
    // stepped over, so `submitResume` returns `created: false` and does NOT throw -- the catch path
    // never sees it. `claimGate` has already taken the member out by then, and the member is the only
    // pointer back to this gate: if that claimant really died between its claim and its create,
    // nothing would ever answer the gate and `onTimeout` would silently never fire.
    const paused = await pausedTurn();
    const ghost = 't-ghost';
    expect(await deps.turns.claimIdempotencyKey(paused.owner, 's-1:gate:0', ghost)).toBe(ghost);
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([]);
    expect(await deps.turns.dueGates(deps.nowOf())).toEqual(['t-1']);
    // And the pass that comes back once the claim is past the grace answers it: the deadline was
    // deferred, not lost. The clock starts when the pass above first read the claim.
    deps.setNow(deps.nowOf() + CLAIM_GRACE_MS + 1);
    expect(await sweepGates(deps)).toBe(1);
    expect((await deps.turns.get(deps.turnQueue.ids[0]!))?.resumeOf).toBe(paused.turnId);
  });

  it('two passes racing on one gate resume it once', async () => {
    // Every replica runs the same pass, and `claimGate`'s ZREM is the only thing that picks one. The
    // fake returns the count it actually removed, so the loser really does lose.
    await pausedTurn();
    const [a, b] = await Promise.all([sweepGates(deps), sweepGates(deps)]);
    expect(a + b).toBe(1);
    expect(deps.turnQueue.ids).toHaveLength(1);
  });

  it('a sweep racing a human decision produces one resume', async () => {
    const { sessionId, turnId } = await gatedSession();
    const decision = HANDLERS.decideGate!(
      ctx({ principal: alice, params: { id: sessionId }, body: { gateId: 0, action: 'approve' } }),
      deps,
    ).then(
      (res) => (res.body as { turnId: string }).turnId,
      (e: { code?: string }) => e.code,
    );
    const [swept, answered] = await Promise.all([sweepGates(deps), decision]);
    // Whichever way they interleave, the gate-keyed idempotency key leaves ONE resume: the loser
    // either replays the winner's turn id or is told the gate has been answered.
    expect(deps.turnQueue.ids).toHaveLength(1);
    const only = deps.turnQueue.ids[0]!;
    expect((await deps.turns.get(only))?.resumeOf).toBe(turnId);
    expect(answered === only || answered === 'gate_not_pending').toBe(true);
    expect(swept).toBeLessThanOrEqual(1);
  });

  it('one error does not stop the pass', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await pausedTurn({ turnId: 't-1' });
      await pausedTurn({ turnId: 't-2', sessionId: 's-2', idempotencyKey: 's-2' });
      // The RESUME of the first gate, which is what the sweep enqueues.
      deps.turnQueue.fails.add('t-id-1');
      expect(await sweepGates(deps)).toBe(1);
      expect(deps.turnQueue.ids).toEqual(['t-id-2']);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('startGateSweep runs on its interval and does not hold the process open', async () => {
    vi.useFakeTimers();
    try {
      await pausedTurn();
      const stop = startGateSweep(deps, 1_000);
      await vi.advanceTimersByTimeAsync(3_500);
      stop();
      // Three ticks, one gate: the first resumed it and the other two found an empty index.
      expect(deps.turnQueue.ids).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick whose dueGates() rejects logs the error, with no unhandled rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dueGates = vi.spyOn(deps.turns, 'dueGates').mockRejectedValue(new Error('redis down'));
    vi.useFakeTimers();
    try {
      const stop = startGateSweep(deps, 1_000);
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(errSpy).toHaveBeenCalledWith('[gate-sweep]', expect.any(Error));
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
      dueGates.mockRestore();
    }
  });
});
