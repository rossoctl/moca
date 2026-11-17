import { describe, it, expect, vi } from 'vitest';
import { decideBudget, sessionSpendTotal, budgetVoterExtension } from '../src/budget-voter';

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
