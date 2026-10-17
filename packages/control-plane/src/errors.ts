/**
 * The control plane's typed boundary errors. Codes are `snake_case` and bodies are
 * `{ error, message?, sessionId? }`, matching the data plane's existing `invalid_json` /
 * `session_not_found` / `prompt_required` (packages/knative-server/src/server.ts). Mapped to a
 * status in exactly one place, so a handler never picks a status itself (spec §9.1).
 */
/**
 * Every error code the control plane can emit, as a VALUE so tests can iterate it.
 *
 * The type derives from this array rather than being declared beside it, which makes the two
 * impossible to disagree: adding a code here forces a `STATUS` entry (Record exhaustiveness) and
 * forces the OpenAPI `Error.error` enum to list it (openapi-contract.test.ts). Order is irrelevant --
 * every consumer sorts.
 */
export const CP_ERROR_CODES = [
  'invalid_json',
  'invalid_request',
  'token_required',
  'token_invalid',
  'token_expired',
  'invalid_grant',
  'subject_conflict',
  'unauthorized',
  'forbidden',
  'session_not_found',
  'session_mismatch',
  'not_enrolled',
  'sandbox_not_found',
  'sandbox_terminated',
  'name_conflict',
  'quota_exceeded',
  'unknown_template',
  'digest_mismatch',
  'bundle_quota_exceeded',
  'config_bundle_not_found',
  'configRef_invalid',
  'credential_required',
  'credential_ambiguous',
  'credential_not_found',
  'credential_unavailable',
  'endpoint_unresolved',
  'model_unavailable',
  'model_catalog_unavailable',
  'authorization_pending',
  'device_code_expired',
  'identity_provider_misconfigured',
  'redis_unavailable',
  'internal_error',
] as const;

export type CpErrorCode = (typeof CP_ERROR_CODES)[number];

const STATUS: Record<CpErrorCode, number> = {
  invalid_json: 400,
  invalid_request: 400,
  token_required: 401,
  token_invalid: 401,
  token_expired: 401,
  // 400, as RFC 6749 §5.2 answers a refused grant: the refresh token is unknown, revoked, expired
  // or a replayed predecessor. One code for all four, so a client's only move is "log in again".
  invalid_grant: 400,
  // A request carrying both a session token and a conflicting X-SH-Subject is REJECTED rather than
  // resolved by precedence -- a silent winner here is a cross-tenant bug waiting (spec §3.5).
  subject_conflict: 400,
  unauthorized: 401,
  forbidden: 403,
  // 404, never 403, for another user's session: 403 is an existence oracle (spec §8.1). 403 is
  // reserved for "authenticated but insufficiently privileged on a resource you may know exists".
  session_not_found: 404,
  session_mismatch: 400,
  not_enrolled: 403,
  sandbox_not_found: 404,
  sandbox_terminated: 409,
  name_conflict: 409,
  quota_exceeded: 429,
  unknown_template: 400,
  // A client-built bundle whose bytes do not hash to the digest it claimed (config-bundle store).
  digest_mismatch: 400,
  // 429: the config-bundle byte budget (per subject or deployment-wide) is full; retry after expiry.
  bundle_quota_exceeded: 429,
  // 404: a session asked for a digest nobody uploaded (or that expired) -- promote it first.
  config_bundle_not_found: 404,
  // Spelled as knative-server's existing /v1/turn code on purpose: same concept, second call site.
  configRef_invalid: 400,
  credential_required: 400,
  credential_ambiguous: 400,
  credential_not_found: 404,
  credential_unavailable: 503,
  endpoint_unresolved: 400,
  // 400: the credential's endpoint does not offer that model id (per-session model spec §4.2).
  model_unavailable: 400,
  // 503: the endpoint could not list its models (timeout, non-2xx, no /model/info). A create or
  // switch naming a model is then accepted unverified instead (spec §4.2); only the list routes 503.
  model_catalog_unavailable: 503,
  // 428 Precondition Required: the device-flow poll has a distinct status so a polling client needs
  // no body inspection to tell "not yet" from "denied" (plan gap #8).
  authorization_pending: 428,
  // 410 Gone: the device code itself is spent, so polling it again cannot succeed. A distinct code
  // so a client offers a fresh one (#431) without string-matching GitHub's `expired_token`.
  device_code_expired: 410,
  // 502: the upstream identity provider refused the control plane's OWN configuration (device flow
  // off, unknown client id). Not 401 -- nothing the caller presents can fix it -- and a distinct code
  // so a client tells the user "ask the operator" without string-matching GitHub's text (#405).
  identity_provider_misconfigured: 502,
  redis_unavailable: 503,
  internal_error: 500,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class CpError extends Error {
  constructor(
    readonly code: CpErrorCode,
    message?: string,
    readonly sessionId?: string,
    /** Extra body fields a client branches on, e.g. sandbox_terminated's `reason`. Never a secret. */
    readonly extra?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = 'CpError';
  }
}

export function statusFor(code: CpErrorCode): number {
  return STATUS[code];
}

/** Minimal structural response surface -- lets tests assert without a live http server. */
interface WritableRes {
  headersSent: boolean;
  writeHead(status: number, headers?: unknown): unknown;
  end(body?: string): unknown;
}

/**
 * Terminate a request with a typed error. An unrecognised throwable becomes a bare
 * `internal_error` with NO message: an arbitrary error's text can carry a Redis connection string
 * or a presented token, and this body is returned to an arbitrary caller.
 */
export function writeError(res: WritableRes, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof CpError) {
    // `extra` first and the core fields last, so an extra field can never overwrite them: a stray
    // `error` in extra must not relabel the code a client branches on. A core field the error does
    // not carry is dropped from extra too, rather than supplied through it.
    const { error: _e, message: _m, sessionId: _s, ...extra } = err.extra ?? {};
    const body: Record<string, string> = { ...extra, error: err.code };
    if (err.message && err.message !== err.code) body.message = err.message;
    if (err.sessionId) body.sessionId = err.sessionId;
    res.writeHead(statusFor(err.code), JSON_HEADERS);
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(500, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'internal_error' }));
}
