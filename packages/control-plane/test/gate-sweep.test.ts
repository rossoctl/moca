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
import { alice, ctx, makeDeps, seedCredential } from './helpers/deps.js';
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
    deps.fake.strings.set(
      leafResultKey(turn.sessionId, turn.turnId),
      JSON.stringify({ status: 'paused', gateId: 0, gate: { summary: 's', proposed_action: 'p' } }),
    );
  }
  await deps.turns.finalize(turn.turnId, 'paused', PAUSED_AT);
  return turn;
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
    deps.fake.strings.set(
      leafResultKey(sessionId, turnId),
      JSON.stringify({ status: 'paused', gateId: 0, gate: { summary: 's', proposed_action: 'p' } }),
    );
    await deps.turns.finalize(turnId, 'paused', PAUSED_AT);
    deps.turnQueue.ids.length = 0;

    const byHand = await HANDLERS.decideGate!(
      ctx({ principal: alice, params: { id: sessionId }, body: { gateId: 0, action: 'approve' } }),
      deps,
    );
    // The decision cleared the index, so the sweep has nothing left to expire -- which is the point:
    // an approved gate must not also be aborted thirty seconds later.
    expect(await sweepGates(deps)).toBe(0);
    expect(deps.turnQueue.ids).toEqual([(byHand.body as { turnId: string }).turnId]);
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
});
