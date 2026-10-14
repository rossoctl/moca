export type ErrorSource = 'control-plane' | 'harness';

export class ApiError extends Error {
  /**
   * For `status === 0` network errors, the underlying error's `.code` (e.g. `ECONNREFUSED`,
   * `UND_ERR_HEADERS_TIMEOUT`), used to tell "request never left" from "request may have landed".
   */
  readonly causeCode?: string;
  constructor(
    readonly source: ErrorSource,
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly retryAfterS?: number,
    causeCode?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    this.causeCode = causeCode;
  }
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
  try {
    // `/runs` reports failures as `{status, reason}`; most other routes as `{error}`.
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; reason?: unknown };
    if (typeof body.error === 'string') code = body.error;
    else if (typeof body.reason === 'string') code = body.reason;
    if (typeof body.message === 'string') message = body.message;
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
  );
}

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
  return new ApiError(source, 0, 'network_error', detail, undefined, causeCode);
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
