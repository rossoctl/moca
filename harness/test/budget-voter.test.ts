import { describe, it, expect, vi } from 'vitest';
import { afterEach } from 'vitest';
import {
  decideBudget,
  sessionSpendTotal,
  budgetVoterExtension,
  resolveBudgetLimit,
} from '../src/budget-voter';

// --- minimal fakes (no Pi runtime) -------------------------------------------
function fakeCtx(
  assistantUsages: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }>,
) {
  return {
    sessionManager: {
      getBranch: () =>
        assistantUsages.map((usage) => ({
          type: 'message',
          message: { role: 'assistant', usage },
        })),
    },
  } as unknown as Parameters<typeof sessionSpendTotal>[0];
}
function emptyCtx() {
  return { sessionManager: { getBranch: () => [] } } as unknown as Parameters<
    typeof sessionSpendTotal
  >[0];
}
function brokenCtx() {
  return {} as unknown as Parameters<typeof sessionSpendTotal>[0];
}
// Captures handlers + appendCustomEntry calls.
function harness() {
  const handlers: Record<string, Function> = {};
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on: (ev: string, h: Function) => {
      handlers[ev] = h;
    },
  };
  const sm = {
    appendCustomEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      return 'id';
    },
  };
  return { handlers, appended, pi, sm };
}

describe('resolveBudgetLimit', () => {
  const saved = process.env.SH_BUDGET_TOKENS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SH_BUDGET_TOKENS;
    else process.env.SH_BUDGET_TOKENS = saved;
  });

  it('takes the deployment limit when the turn names no cap', () => {
    process.env.SH_BUDGET_TOKENS = '1000';
    expect(resolveBudgetLimit(undefined)).toBe(1000);
  });

  it('takes the turn cap when the deployment sets none', () => {
    delete process.env.SH_BUDGET_TOKENS;
    expect(resolveBudgetLimit(500)).toBe(500);
  });

  // The review's must-fix: `caps.tokens ?? SH_BUDGET_TOKENS` let a submitter RAISE the operator's
  // limit, which is exactly what the API contract forbids ("a cap above the deployment's own limit
  // does not raise it"). An unattended fan-out is the caller this protects the operator from.
  it('clamps a turn cap above the deployment limit down to it', () => {
    process.env.SH_BUDGET_TOKENS = '1000';
    expect(resolveBudgetLimit(999999)).toBe(1000);
  });

  it('honours a turn cap below the deployment limit', () => {
    process.env.SH_BUDGET_TOKENS = '1000';
    expect(resolveBudgetLimit(250)).toBe(250);
  });

  it('is no cap at all when neither side is usable', () => {
    process.env.SH_BUDGET_TOKENS = 'not-a-number';
    expect(resolveBudgetLimit(undefined)).toBeUndefined();
    expect(resolveBudgetLimit(0)).toBeUndefined();
    expect(resolveBudgetLimit(-5)).toBeUndefined();
  });

  it('ignores an unusable side rather than disabling the other', () => {
    process.env.SH_BUDGET_TOKENS = '0';
    expect(resolveBudgetLimit(700)).toBe(700);
    process.env.SH_BUDGET_TOKENS = '700';
    expect(resolveBudgetLimit(Number.NaN)).toBe(700);
  });
});

describe('decideBudget', () => {
  it('commits below the cap', () => {
    expect(decideBudget({ spent: 10, estimated: 0, limit: 100 })).toEqual({ decision: 'commit' });
  });
  it('aborts when spent + estimated exceeds the cap', () => {
    expect(decideBudget({ spent: 90, estimated: 20, limit: 100 })).toEqual({
      decision: 'abort',
      reason: 'budget_exceeded',
    });
  });
  it('commits exactly at the cap (not strictly greater)', () => {
    expect(decideBudget({ spent: 100, estimated: 0, limit: 100 })).toEqual({ decision: 'commit' });
  });
  it('is disabled (always commits) when limit <= 0 or non-finite', () => {
    expect(decideBudget({ spent: 999, estimated: 0, limit: 0 })).toEqual({ decision: 'commit' });
    expect(decideBudget({ spent: 999, estimated: 0, limit: NaN })).toEqual({ decision: 'commit' });
  });
});

describe('sessionSpendTotal', () => {
  it('sums all assistant usage fields', () => {
    const ctx = fakeCtx([
      { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
      { input: 20, output: 4, cacheRead: 0, cacheWrite: 1 },
    ]);
    expect(sessionSpendTotal(ctx)).toBe(41);
  });
  it('returns 0 for an empty branch (valid baseline, not null)', () => {
    expect(sessionSpendTotal(emptyCtx())).toBe(0);
  });
  it('returns null when the branch is unavailable', () => {
    expect(sessionSpendTotal(brokenCtx())).toBeNull();
  });
});

// The voter must work WITHOUT a session_start event: the headless runTurn path never
// emits session_start (only bindExtensions/interactive/print/rpc do), so the baseline is
// supplied by the caller via opts.baseline. These tests never fire session_start.
describe('budgetVoterExtension (headless: no session_start, injected baseline)', () => {
  it('blocks a tool call and appends exactly one abort entry once over cap', () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 50, baseline: 0 })(pi as never);
    // tool_call after 60 tokens of spend -> over the cap of 50 (no session_start fired)
    const ctx = fakeCtx([{ input: 40, output: 20, cacheRead: 0, cacheWrite: 0 }]);
    const res = handlers.tool_call({}, ctx);
    expect(res).toEqual({ block: true, reason: 'Session token budget exceeded' });
    expect(appended).toEqual([
      { customType: 'abort', data: { reason: 'budget_exceeded', spent: 60, limit: 50 } },
    ]);
  });
  it('does not block below the cap and writes no abort entry', () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 1000, baseline: 0 })(pi as never);
    const ctx = fakeCtx([{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }]);
    expect(handlers.tool_call({}, ctx)).toEqual({});
    expect(appended).toEqual([]);
  });
  it('subtracts the injected baseline so pre-turn spend is excluded', () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 50, baseline: 100 })(pi as never);
    // total 130 -> this-turn spend 30 (< 50): no block
    expect(
      handlers.tool_call({}, fakeCtx([{ input: 130, output: 0, cacheRead: 0, cacheWrite: 0 }])),
    ).toEqual({});
    expect(appended).toEqual([]);
    // total 160 -> this-turn spend 60 (> 50): block once
    const res = handlers.tool_call(
      {},
      fakeCtx([{ input: 160, output: 0, cacheRead: 0, cacheWrite: 0 }]),
    );
    expect(res).toEqual({ block: true, reason: 'Session token budget exceeded' });
    expect(appended).toEqual([
      { customType: 'abort', data: { reason: 'budget_exceeded', spent: 60, limit: 50 } },
    ]);
  });
  it('does not block when the stat reading is unavailable (defensive)', () => {
    const { handlers, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 1, baseline: 0 })(pi as never);
    expect(handlers.tool_call({}, brokenCtx())).toEqual({}); // total == null -> no block
  });
  // #391: the only signal a caller gets. Blocking the call is invisible from outside -- pi reports
  // `end_turn` for a turn whose every call was refused -- so without this an async turn over its
  // `caps.tokens` would be finalized as a normal completion.
  it('calls onExceeded exactly when it blocks, and still blocks', () => {
    const { handlers, pi, sm } = harness();
    const onExceeded = vi.fn();
    budgetVoterExtension(sm as never, { limit: 50, baseline: 0, onExceeded })(pi as never);
    expect(
      handlers.tool_call({}, fakeCtx([{ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }])),
    ).toEqual({});
    expect(onExceeded).not.toHaveBeenCalled();
    expect(
      handlers.tool_call({}, fakeCtx([{ input: 60, output: 0, cacheRead: 0, cacheWrite: 0 }])),
    ).toEqual({ block: true, reason: 'Session token budget exceeded' });
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });
  it('is disabled when limit <= 0', () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 0, baseline: 0 })(pi as never);
    expect(
      handlers.tool_call({}, fakeCtx([{ input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 }])),
    ).toEqual({});
    expect(appended).toEqual([]);
  });
});
