/**
 * The model a session runs on (per-session model selection spec §4). The control plane never
 * builds a model itself -- the harness does (spec §5.2) -- so these are plain data: an id the
 * credential's endpoint serves, and the limits its catalog reported, snapshotted at create/switch.
 */

/** Printable ASCII, no spaces: LiteLLM names carry `/` and `:` (`bedrock/anthropic.claude-3:0`). */
export const MODEL_ID_RE = /^[\x21-\x7e]{1,256}$/;

export interface ModelLimits {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export interface ModelEntry extends ModelLimits {
  id: string;
}

/** What the exchange hands the data plane for a session that names a model (spec §4.5). */
export type SessionModel = ModelEntry;

const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/**
 * The largest context window kept (R9). `Number.isInteger(1e300)` passes, and a bogus window from
 * a user-chosen gateway silently disables proactive compaction; nothing real is near 10M. The data
 * plane refuses the same bound (server turn-auth.ts `isSessionModel`).
 */
export const MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * Keep only the fields the harness reads, each of the right type. The input is a remote gateway's
 * body or a stored hash field, so anything else is dropped rather than trusted.
 */
export function sanitizeLimits(raw: unknown): ModelLimits | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ModelLimits = {};
  if (positiveInt(r.contextWindow) && r.contextWindow <= MAX_CONTEXT_WINDOW) {
    out.contextWindow = r.contextWindow;
  }
  // maxTokens becomes every request's max_tokens: one above the window fails each turn upstream with
  // a 400, so it is clamped down to the window rather than trusted (R9).
  if (positiveInt(r.maxTokens)) {
    out.maxTokens =
      out.contextWindow !== undefined ? Math.min(r.maxTokens, out.contextWindow) : r.maxTokens;
  }
  if (typeof r.reasoning === 'boolean') out.reasoning = r.reasoning;
  if (typeof r.vision === 'boolean') out.vision = r.vision;
  return Object.keys(out).length > 0 ? out : undefined;
}
