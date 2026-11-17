import type {
  ExtensionContext,
  ExtensionFactory,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

export interface BudgetState {
  spent: number;
  estimated: number;
  limit: number;
}
export type BudgetDecision =
  { decision: 'commit' } | { decision: 'abort'; reason: 'budget_exceeded' };

/** Pure policy. Disabled (always commits) when limit is non-finite or <= 0. */
export function decideBudget(s: BudgetState): BudgetDecision {
  if (!Number.isFinite(s.limit) || s.limit <= 0) return { decision: 'commit' };
  return s.spent + s.estimated > s.limit
    ? { decision: 'abort', reason: 'budget_exceeded' }
    : { decision: 'commit' };
}

/**
 * Sum of assistant-message token usage over a SessionManager-like branch holder.
 * Returns 0 for an empty branch (a valid baseline); null only when getBranch is unavailable.
 * Exported so the caller (run-turn) can compute the pre-turn baseline directly from the
 * loaded SessionManager — the voter does not depend on a session_start event (see below).
 */
export function branchSpend(sm: { getBranch?: () => unknown[] } | undefined): number | null {
  if (!sm || typeof sm.getBranch !== 'function') return null;
  let total = 0;
  for (const entry of sm.getBranch() as Array<{
    type?: string;
    message?: {
      role?: string;
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
  }>) {
    if (entry?.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
      const u = entry.message.usage;
      total += u.input + u.output + u.cacheRead + u.cacheWrite;
    }
  }
  return total;
}

/**
 * The token limit in force for one turn, or undefined for no limit.
 *
 * Both inputs are CEILINGS, so the tighter one wins: a submitter's `caps.tokens` narrows the
 * deployment's `SH_BUDGET_TOKENS` and can never raise it, which is what the API contract promises
 * ("a cap above the deployment's own limit does not raise it"). The first cut read
 * `caps.tokens ?? SH_BUDGET_TOKENS`, which let an async caller buy itself a bigger budget than the
 * operator set — the one direction an unattended fan-out must not be able to go.
 *
 * Either side absent, non-numeric or <= 0 leaves the other in force; both absent means no cap.
 */
export function resolveBudgetLimit(turnCap: number | undefined): number | undefined {
  const usable = (n: number): number | undefined => (Number.isFinite(n) && n > 0 ? n : undefined);
  const deployment = usable(Number(process.env.SH_BUDGET_TOKENS));
  const turn = turnCap === undefined ? undefined : usable(turnCap);
  if (turn === undefined) return deployment;
  return deployment === undefined ? turn : Math.min(turn, deployment);
}

/** Cumulative assistant token spend on the current branch, read from a tool_call ctx. */
export function sessionSpendTotal(ctx: ExtensionContext): number | null {
  return branchSpend((ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager);
}

/**
 * Meters per-turn token spend (delta from the caller-supplied pre-turn `baseline`) and
 * blocks tool calls once the cap is breached, appending a single `abort` custom entry.
 * Inert when limit is non-finite or <= 0.
 *
 * Does NOT depend on the `session_start` event: the headless runTurn path never emits it
 * (only bindExtensions / interactive / print / rpc modes do), so a session_start-derived
 * baseline would stay null and the voter would never fire. The caller computes the pre-turn
 * baseline from the loaded session (branchSpend) and passes it as opts.baseline, so a resumed
 * session's loaded-tail spend is excluded from this turn's cap. Defaults to 0 (fresh session).
 *
 * `onExceeded` is how a CALLER learns the cap fired (#391): blocking the tool call is invisible from
 * outside -- pi's loop reports `end_turn` for a turn whose calls were all refused -- so an async
 * turn over its `caps.tokens` would otherwise be reported as a normal completion. Called on every
 * blocked call, not only the first; the callers set a flag, so the repeats are free.
 */
export function budgetVoterExtension(
  sm: SessionManager,
  opts: { limit: number; margin?: number; baseline?: number; onExceeded?: () => void },
): ExtensionFactory {
  const baseline = opts.baseline ?? 0;
  return (pi) => {
    pi.on('tool_call', (_e, ctx) => {
      const total = sessionSpendTotal(ctx);
      if (total == null) return {}; // defensive: don't block when spend is unknown
      const spent = total - baseline;
      const d = decideBudget({ spent, estimated: opts.margin ?? 0, limit: opts.limit });
      if (d.decision === 'abort') {
        sm.appendCustomEntry('abort', { reason: d.reason, spent, limit: opts.limit });
        opts.onExceeded?.();
        return { block: true, reason: 'Session token budget exceeded' };
      }
      return {};
    });
  };
}
