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
  'grant_invalid',
  'invalid_grant',
  'subject_conflict',
  'unauthorized',
  'forbidden',
  'not_found',
  'session_not_found',
  'session_mismatch',
  'not_enrolled',
  'sandbox_not_found',
  'sandbox_terminated',
  'name_conflict',
  'quota_exceeded',
  'unknown_template',
  'template_not_found',
  'template_exists',
  'policy_refused',
  'no_active_slot',
  'template_unavailable',
  'template_not_active',
  'template_retired',
  'build_in_use',
  'mode_not_allowed',
  'self_attested',
  'digest_mismatch',
  'bundle_quota_exceeded',
  'config_bundle_not_found',
  'configRef_invalid',
  'envelope_invalid',
  'async_quota_exhausted',
  'workload_runs_unavailable',
  'async_tenancy_unsupported',
  'turn_not_cancellable',
  'turn_not_found',
  'turn_not_claimable',
  'credential_required',
  'credential_ambiguous',
  'credential_not_found',
  'credential_unavailable',
  'credential_unsafe',
  'destination_conflict',
  'destination_ambiguous',
  'no_credential',
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
  // 401: ONE code for every way a session grant can fail -- bad signature, wrong typ, wrong aud,
  // unknown kid, past `exp`, past `turn_exp` (MI1 §6.3's checklist item 1). Deliberately not split
  // the way the session token's token_invalid/token_expired are: a grant is presented by the data
  // plane, whose only move on any of them is to re-exchange, so a second code would buy it nothing.
  // Note this does NOT withhold which check failed -- `writeError` below sends `message`, and
  // verifyGrant's messages name the check. That is deliberate (the route is behind the shared
  // bearer, and an operator debugging a verifier needs it). Distinct from `invalid_grant` below, which
  // is OAuth's refresh-token refusal and has nothing to do with session grants despite the name.
  grant_invalid: 401,
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
  not_found: 404,
  session_not_found: 404,
  session_mismatch: 400,
  not_enrolled: 403,
  sandbox_not_found: 404,
  sandbox_terminated: 409,
  name_conflict: 409,
  quota_exceeded: 429,
  unknown_template: 400,
  // 404: GET /v1/templates/{id} names no template the caller can see (template lifecycle spec §4).
  template_not_found: 404,
  // 409: another subject owns this template id (ids are unique per deployment, spec §3.2).
  template_exists: 409,
  // 422: a create the policy refuses at create (spec §8.1); `rule` names the gating rule.
  policy_refused: 422,
  // 409: every host holding the build is at its active limit with leased builds (template lifecycle
  // spec §6.3); Retry-After says when the earliest lease ends.
  no_active_slot: 409,
  // 409: no host holds this build's snapshot, or the build is not registered (§3.3 `unavailable`).
  template_unavailable: 409,
  // 409: a sandbox create on a build that is not active (§6.4); its activation has started unless the
  // create said `activate: false`. Retry-After says when to try again.
  template_not_active: 409,
  // 410 Gone: the template, or the build a reference names, is retired (§5.1); its records stay.
  template_retired: 410,
  // 409: a live sandbox still runs on the build; delete it (or let it end), then retry (§5.1).
  build_in_use: 409,
  // 403: SH_SANDBOX_MODES_ALLOWED does not list the sandbox mode asked for (lease-mode spec §8.1).
  // The caller is authenticated and owns the sandbox; the operator's policy refuses the mode.
  mode_not_allowed: 403,
  // 409: deployment visibility for a template with a self-attested build, until an admin trusts its
  // gate record (trustedGateRecords).
  self_attested: 409,
  // A client-built bundle whose bytes do not hash to the digest it claimed (config-bundle store).
  digest_mismatch: 400,
  // 429: the config-bundle byte budget (per subject or deployment-wide) is full; retry after expiry.
  bundle_quota_exceeded: 429,
  // 404: a session asked for a digest nobody uploaded (or that expired) -- promote it first.
  config_bundle_not_found: 404,
  // Spelled as knative-server's existing /v1/turn code on purpose: same concept, second call site.
  configRef_invalid: 400,
  // Spelled as knative-server's existing /runs code on purpose: same concept, second call site.
  envelope_invalid: 400,
  // 429: the per-owner queued-turn quota (async fan-out spec §4.3). The body names the owner's
  // current count, so a client backs off against a number rather than guessing.
  async_quota_exhausted: 429,
  // 501, spelled as the data plane's own refusal (knative-server server.ts:972): same concept,
  // second call site. An async turn naming a workload is refused at submission so the 501 stays
  // synchronous instead of becoming a dead-letter (async spec §4.2).
  workload_runs_unavailable: 501,
  // 501: the M1 gate (async spec §9). Async needs the credential resolved from the turn record at
  // dequeue, which MI1 S2's interim allows under `single` only. A dated, conditional refusal rather
  // than an omission -- the shape ADR-0041 used for its own deprecation window.
  async_tenancy_unsupported: 501,
  // 409: DELETE on a turn that is not `queued`. A running leaf finishes and writes its result; the
  // message names the state so a client need not guess why (async spec §4.5).
  turn_not_cancellable: 409,
  // 404: the dequeue exchange was handed a turn id with no record, and it is what tells a worker
  // holding a stale queue entry to ack and drop rather than retry. Deliberately DISTINGUISHABLE
  // from the other claim refusals, and NOT the 404-not-403 of spec §8.1 -- the argument lives in
  // openapi.yaml's `/internal/turn-credentials` 404 description, and has to be reread when M2 stops
  // returning a real key, so it is stated in one place rather than four.
  // The harness emits a same-named `turn_not_found` of its own (knative-server server.ts); the two
  // are distinct codes at distinct hops that happen to share a name, not one code reused.
  turn_not_found: 404,
  // 409: the record exists but is `cancelled` or already terminal, so no credential is minted
  // (async spec §5.4). NEVER returned for `running`: a redelivery is the case the claim exists for.
  // Distinct from turn_not_cancellable, which is the CALLER's DELETE being refused; this is the
  // WORKER's claim being refused.
  turn_not_claimable: 409,
  credential_required: 400,
  credential_ambiguous: 400,
  credential_not_found: 404,
  credential_unavailable: 503,
  // 500: a stored egress secret renders to a header value with CR/LF/NUL; never forwarded.
  credential_unsafe: 500,
  // 409: another credential of the owner already holds the identical normalized destination.
  destination_conflict: 409,
  // 500: two of an owner's egress destinations are identical; stored state from a write race.
  destination_ambiguous: 500,
  // 404: egress lookup for a live sandbox whose owner holds no credential for the host.
  no_credential: 404,
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
    /** Seconds for a `Retry-After` header, on a refusal that may clear (no_active_slot, §6.3). */
    readonly retryAfterS?: number,
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
    res.writeHead(
      statusFor(err.code),
      err.retryAfterS !== undefined && Number.isSafeInteger(err.retryAfterS) && err.retryAfterS >= 0
        ? { ...JSON_HEADERS, 'Retry-After': String(err.retryAfterS) }
        : JSON_HEADERS,
    );
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(500, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'internal_error' }));
}
