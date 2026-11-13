export type ErrorSource = 'control-plane' | 'harness';

export class ApiError extends Error {
  /**
   * For `status === 0` network errors, the underlying error's `.code` (e.g. `ECONNREFUSED`,
   * `UND_ERR_HEADERS_TIMEOUT`), used to tell "request never left" from "request may have landed".
   */
  readonly causeCode?: string;
  /**
   * The body's `reason` beside its `error` code, e.g. `deleted` or `expired` on a
   * `sandbox_terminated` (SBX0 §5.1). A body with a `reason` and no `error` (`/runs`) has the reason
   * as its `code` instead.
   */
  readonly reason?: string;
  /** `policy_refused`: the gating rule the create failed (`M7.id`, `X10`, ...). */
  readonly rule?: string;
  /** `quota_exceeded` on a template create: which quota (`templates` or `buildsQueued`). */
  readonly quota?: string;
  constructor(
    readonly source: ErrorSource,
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly retryAfterS?: number,
    causeCode?: string,
    reason?: string,
    details: ApiErrorDetails = {},
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    this.causeCode = causeCode;
    if (reason !== undefined) this.reason = reason;
    if (details.rule !== undefined) this.rule = details.rule;
    if (details.quota !== undefined) this.quota = details.quota;
  }
}

/** The body fields a template refusal carries beside its code (openapi Error `rule`, `quota`). */
export interface ApiErrorDetails {
  rule?: string;
  quota?: string;
}

export class TurnCancelledError extends Error {
  constructor() {
    super('turn cancelled');
    this.name = 'TurnCancelledError';
  }
}

export async function errorFromResponse(source: ErrorSource, res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let code = `http_${res.status}`;
  let message: string | undefined;
  let reason: string | undefined;
  const details: ApiErrorDetails = {};
  try {
    // `/runs` reports failures as `{status, reason}`; most other routes as `{error}`, some with a
    // `reason` beside it (`{error:'sandbox_terminated', message, reason}`).
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body.error === 'string') {
      code = body.error;
      if (typeof body.reason === 'string') reason = body.reason;
    } else if (typeof body.reason === 'string') code = body.reason;
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.rule === 'string') details.rule = body.rule;
    if (typeof body.quota === 'string') details.quota = body.quota;
  } catch {
    /* non-JSON body (e.g. a proxy's HTML page): keep http_<status>. */
  }
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return new ApiError(
    source,
    res.status,
    code,
    message,
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
    undefined,
    reason,
    details,
  );
}

// Node's fetch reports every transport failure as `TypeError: fetch failed`; the cause tells a
// peer that was never reached (refused, DNS) from a connection that was open and then closed under
// the request, which is what a proxy's idle timeout does.
const CLOSED_CAUSES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

export function networkError(source: ErrorSource, err: unknown): ApiError {
  const message = err instanceof Error ? err.message : String(err);
  // undici attaches the real socket-layer error on `.cause`; its `.code` is how we tell
  // ECONNREFUSED (never left) from UND_ERR_HEADERS_TIMEOUT (may have landed).
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeCode =
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof (cause as { code: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : undefined;
  // undici's top-level message is just "fetch failed"; fold the cause code in so the
  // operator can tell why.
  const detail = causeCode ? `${message} (${causeCode})` : message;
  const closed = causeCode !== undefined && CLOSED_CAUSES.has(causeCode);
  return new ApiError(
    source,
    0,
    closed ? 'connection_dropped' : 'network_error',
    detail,
    undefined,
    causeCode,
  );
}

export const TOKEN_CODES: ReadonlySet<string> = new Set([
  'token_required',
  'token_invalid',
  'token_expired',
]);

const UNAVAILABLE = new Set(['redis_unavailable', 'credential_unavailable', 'internal_error']);

export type UiAction =
  | { kind: 'login' }
  | { kind: 'harness-token-rejected' }
  | { kind: 'session-gone' }
  | { kind: 'bundle-expired' }
  | { kind: 'bundle-quota' }
  | { kind: 'endpoint-unresolved'; message: string }
  | { kind: 'operator-misconfigured'; message: string }
  | { kind: 'retry-after'; seconds: number }
  | { kind: 'unavailable'; source: ErrorSource }
  | { kind: 'connection'; source: ErrorSource; message: string }
  | { kind: 'show'; message: string };

/** Spec §8.1: one mapping from the API's error codes to what the UI does. */
export function classify(err: ApiError): UiAction {
  if (err.status === 0) return { kind: 'connection', source: err.source, message: err.message };
  if (TOKEN_CODES.has(err.code)) {
    return err.source === 'harness' ? { kind: 'harness-token-rejected' } : { kind: 'login' };
  }
  if (err.code === 'session_not_found') return { kind: 'session-gone' };
  if (err.code === 'config_bundle_not_found') return { kind: 'bundle-expired' };
  if (err.code === 'bundle_quota_exceeded') return { kind: 'bundle-quota' };
  if (err.code === 'endpoint_unresolved')
    return { kind: 'endpoint-unresolved', message: err.message };
  // Before the >= 500 branch: a 502 here is not "try again shortly" -- retrying never helps (#405).
  if (err.code === 'identity_provider_misconfigured')
    return { kind: 'operator-misconfigured', message: err.message };
  if (err.source === 'harness' && err.status === 503 && err.retryAfterS !== undefined) {
    return { kind: 'retry-after', seconds: err.retryAfterS };
  }
  if (UNAVAILABLE.has(err.code) || err.status >= 500)
    return { kind: 'unavailable', source: err.source };
  return { kind: 'show', message: err.message };
}
