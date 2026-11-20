export type GateAction = 'approve' | 'reject' | 'abort';

export interface GateRequest {
  gateId: number;
  summary: string;
  proposed_action: string;
}

export interface Decision {
  gateId: number;
  action: GateAction;
  feedback?: string;
}

/** Same shape as Decision; persisted as a durable custom entry to mark a gate consumed. */
export type GateDecision = Decision;

export const GATE_REQUEST_ENTRY_TYPE = 'gate-request';
export const GATE_DECISION_ENTRY_TYPE = 'gate-decision';

export function validateDecision(
  obj: unknown,
): { ok: true; value: Decision } | { ok: false; error: string } {
  if (typeof obj !== 'object' || obj === null)
    return { ok: false, error: 'decision must be an object' };
  const o = obj as Record<string, unknown>;
  if (typeof o.gateId !== 'number' || !Number.isInteger(o.gateId) || o.gateId < 0) {
    return { ok: false, error: 'gateId must be a non-negative integer' };
  }
  if (o.action !== 'approve' && o.action !== 'reject' && o.action !== 'abort') {
    return { ok: false, error: 'action must be "approve", "reject", or "abort"' };
  }
  if (o.feedback !== undefined && typeof o.feedback !== 'string') {
    return { ok: false, error: 'feedback must be a string when present' };
  }
  return {
    ok: true,
    value: { gateId: o.gateId, action: o.action, feedback: o.feedback as string | undefined },
  };
}

type CustomEntry = { type?: string; customType?: string; data?: unknown };

export function isGateRequestEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === 'custom' && e.customType === GATE_REQUEST_ENTRY_TYPE;
}

export function isGateDecisionEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === 'custom' && e.customType === GATE_DECISION_ENTRY_TYPE;
}

export function gateRequestFromEntry(entry: unknown): GateRequest | null {
  if (!isGateRequestEntry(entry)) return null;
  const d = (entry as CustomEntry).data as Record<string, unknown> | undefined;
  if (
    !d ||
    typeof d.gateId !== 'number' ||
    typeof d.summary !== 'string' ||
    typeof d.proposed_action !== 'string'
  ) {
    return null;
  }
  return { gateId: d.gateId, summary: d.summary, proposed_action: d.proposed_action };
}

export function gateDecisionFromEntry(entry: unknown): GateDecision | null {
  if (!isGateDecisionEntry(entry)) return null;
  const r = validateDecision((entry as CustomEntry).data);
  return r.ok ? r.value : null;
}

export interface GateState {
  gateRequests: GateRequest[];
  gateDecisions: GateDecision[];
  pendingGate: GateRequest | null;
  lastDecision: GateDecision | null;
  nextGateId: number;
}

/** Derive gate state from the durable session entries (the .entry payloads from store.read). */
export function computeGateState(entries: unknown[]): GateState {
  const gateRequests = entries
    .map(gateRequestFromEntry)
    .filter((r): r is GateRequest => r !== null);
  const gateDecisions = entries
    .map(gateDecisionFromEntry)
    .filter((d): d is GateDecision => d !== null);
  const decidedIds = new Set(gateDecisions.map((d) => d.gateId));
  // At most one gate is unanswered at a time (gates are sequential); pick the latest undecided.
  let pendingGate: GateRequest | null = null;
  for (const r of gateRequests) {
    if (!decidedIds.has(r.gateId)) pendingGate = r;
  }
  const lastDecision = gateDecisions.length ? gateDecisions[gateDecisions.length - 1] : null;
  return {
    gateRequests,
    gateDecisions,
    pendingGate,
    lastDecision,
    nextGateId: gateRequests.length,
  };
}

export function continuationPrompt(action: 'approve' | 'reject', feedback?: string): string {
  if (action === 'approve') {
    return [
      `Human decision: APPROVED.${feedback ? ` ${feedback}` : ''}`,
      `Proceed with the proposed action. When finished, call submit_verdict exactly once, then stop.`,
    ].join('\n');
  }
  return [
    `Human decision: REJECTED. ${feedback ?? 'No feedback provided.'}`,
    `Revise accordingly. You may call request_approval again when ready, or call submit_verdict when done.`,
  ].join('\n');
}

export type SeedDecision =
  | { kind: 'paused'; gate: GateRequest }
  | { kind: 'abort'; record: GateDecision | null }
  | { kind: 'seed'; prompt: string; record: GateDecision | null };

export type GateShortCircuit = Extract<SeedDecision, { kind: 'paused' } | { kind: 'abort' }>;

/** The decision entry to append for a gate this invocation is consuming, or null if already there. */
function decisionRecord(state: GateState, decision: Decision): GateDecision | null {
  if (state.gateDecisions.some((d) => d.gateId === decision.gateId)) return null;
  return { gateId: decision.gateId, action: decision.action, feedback: decision.feedback };
}

/**
 * The half of `decideSeed` that needs no prompt: does this invocation stop before doing any work?
 * `null` means "run the turn".
 *
 * Split out so a leaf can answer paused or aborted BEFORE it leases a sandbox (#393). The verdict
 * path used to lease a pod and converge a worktree on its way to discovering it was parked -- on a
 * saturated pool, a lease taken from a leaf that could have used it.
 */
export function gateShortCircuit(
  state: GateState,
  decision: Decision | null,
): GateShortCircuit | null {
  const { pendingGate, lastDecision } = state;
  if (pendingGate) {
    if (!decision || decision.gateId !== pendingGate.gateId) {
      return { kind: 'paused', gate: pendingGate };
    }
    if (decision.action !== 'abort') return null;
    return { kind: 'abort', record: decisionRecord(state, decision) };
  }
  // No pending gate: a prior abort is terminal.
  if (lastDecision?.action === 'abort') return { kind: 'abort', record: null };
  return null;
}

/**
 * Decide what a runLeaf invocation should do, given the durable gate state, the (optional) decision
 * read from decisionRef, and the fresh job-mode prompt. Pure: the caller performs the side effects
 * (append `record`, run `session.prompt(prompt)`, set capture flags). See spec §3.
 *
 * Delegates the stop-now half to `gateShortCircuit` so the two can never disagree; what is left here
 * is only the cases that need a prompt.
 */
export function decideSeed(
  state: GateState,
  decision: Decision | null,
  freshPrompt: string,
): SeedDecision {
  const short = gateShortCircuit(state, decision);
  if (short) return short;

  const { pendingGate, lastDecision } = state;
  // Narrowed by gateShortCircuit returning null: with a pending gate this decision matches it and is
  // not an abort.
  if (pendingGate && decision && decision.action !== 'abort') {
    return {
      kind: 'seed',
      prompt: continuationPrompt(decision.action, decision.feedback),
      record: decisionRecord(state, decision),
    };
  }

  // No pending gate: re-derive the last continuation, else the fresh prompt. The `!== 'abort'` is
  // what narrows GateAction to continuationPrompt's two values -- gateShortCircuit already returned
  // for an abort, but that is not a narrowing the compiler can see.
  const prompt =
    lastDecision && lastDecision.action !== 'abort'
      ? continuationPrompt(lastDecision.action, lastDecision.feedback)
      : freshPrompt;
  return { kind: 'seed', prompt, record: null };
}
