import { createHash, timingSafeEqual } from 'node:crypto';
import { touchBundle } from './bundle-budget.js';
import { inferenceAuthHeader, type InferenceAuthHeader } from './credential-store.js';
import { CpError } from './errors.js';
import type { CpConfig, CpDeps } from './handlers.js';
import type { InferenceTarget } from './model-catalog.js';
import type { SessionModel } from './models.js';
import type { SessionRecord } from './ownership.js';
import { verifyToken } from './token.js';

/**
 * The per-turn credential exchange (spec §5.3). The data plane presents the token it was given; the
 * control plane hands back that subject's credential.
 *
 * This puts the control plane on the CONTROL path once per turn -- never on the data path. It sees no
 * prompt and no model output; the SSE stream stays direct from the Knative Service to the client.
 *
 * If the credential rode inside the token instead, a client-visible bearer string would contain a
 * provider key -- landing in browser storage, proxy logs and shell history. This keeps it server-side.
 */
export type CredentialMode = 'placeholder' | 'direct';

export interface ExchangeResponse {
  mode: CredentialMode;
  anthropicAuthToken: string;
  /** NEVER undefined -- see the endpoint_unresolved refusal below. */
  anthropicBaseUrl: string;
  sessionId: string;
  subject: string;
  /**
   * The header the data plane sends the credential in (#368), from its binding. Present ONLY in
   * direct mode and only when it is not the default: absent means `Authorization: Bearer`, the wire
   * shape an older data plane expects. An `api-key` kind (default binding `X-API-Key`) now goes as
   * x-api-key in direct mode; before #368 every inference credential went as Bearer. In placeholder
   * mode it is always absent: the injector picks the upstream header. Under MI1 S2 the grant carries
   * the binding to moca-egress instead.
   */
  authHeader?: Exclude<InferenceAuthHeader, 'authorization'>;
  /** The session's config bundle digest (ADR-0038). Absent when the session has none. */
  configRef?: string;
  /**
   * The session's sandbox tier (P6.3 spec §3.3), which the data plane filters sandboxes on
   * (sessionTier). Absent only when the deployment declares no tiers, so that response is unchanged.
   */
  sandboxTier?: string;
  /**
   * The session's model and the limits snapshotted when it was chosen (per-session model spec
   * §4.5). Absent when the session names none, so that response is unchanged.
   */
  model?: SessionModel;
}

/**
 * An inert, subject-derived stand-in for the real credential. RC1's `static-inject` rewrites
 * `Bearer <placeholder>` to the real value from a mounted secret_dir (P5 §3.1-§3.2), so the exact
 * string an injector matches on is RC1/P5's to fix; MU1 guarantees only that it is inert and names
 * the subject, and this function is the single place to change when that is pinned.
 */
export function placeholderFor(subject: string): string {
  return `sh-placeholder-${subject}`;
}

/**
 * The tier to hand the data plane: the stored one, or -- for a session that names none (stored ''
 * because it was created while no tiers were declared, or a record written before P6.3 with no
 * field) -- TODAY's default, the tier such a session runs in. Naming the default here, rather than
 * leaving the data plane to apply its own SH_SANDBOX_DEFAULT_TIER, makes the exchange the one
 * source of truth for these sessions, so the placement cannot disagree with viewTier.
 *
 * '' whenever the deployment declares no tiers, which the exchange then leaves out, so the untiered
 * response stays byte-identical. That holds even for a record that stored a tier while tiers were
 * declared: the data plane runs untiered then and filters nothing, so naming the stored tier would
 * claim a placement that no longer happens (spec §3.3).
 */
export function sessionTier(rec: SessionRecord, tiers: CpConfig['sandboxTiers']): string {
  return tiers ? rec.sandboxTier || tiers.default : '';
}

/**
 * The tier a session view shows (sessionView, projectResources): the tier the session runs in,
 * which is exactly what the exchange names (sessionTier). Null whenever the deployment declares no
 * tiers, a stored tier included: the data plane runs untiered then, so no tier is in force.
 */
export function viewTier(rec: SessionRecord, tiers: CpConfig['sandboxTiers']): string | null {
  return sessionTier(rec, tiers) || null;
}

/**
 * The one check behind every static-bearer route kind (`exchange`, `janitor`): the presented
 * bearer against the configured one. FAIL-CLOSED: with none configured, EVERY call is rejected --
 * an unconfigured deployment must not accept anything. The message names `what` and never the
 * presented value, so a wrong token is not logged with it.
 */
export function checkStaticBearer(
  presented: string | undefined,
  configured: string | undefined,
  what: string,
): void {
  const deny = (): never => {
    throw new CpError('unauthorized', `${what} authentication failed`);
  };
  if (!configured || !presented) deny();
  // Compare SHA-256 digests, not the values: both are always 32 bytes, so timingSafeEqual (which
  // throws on a length mismatch) needs no length check first, and the time taken reveals neither
  // the content nor the length of the configured bearer.
  const a = createHash('sha256').update(presented!).digest();
  const b = createHash('sha256').update(configured!).digest();
  if (!timingSafeEqual(a, b)) deny();
}

/**
 * Shared-bearer auth for /internal/credentials (spec §5.3.1), reusing the pattern this repo already
 * runs for the relay and remote worker.
 *
 * mTLS remains the target, and Z1 is what makes it cheap: once per-session SPIFFE identities exist,
 * the exchange authorizes on the peer's SVID and gains what a shared token cannot -- the CALLER
 * identified per session rather than per deployment. Until then this hop's weakness is that any code
 * in the harness pod can call the exchange, which is why it returns only the credential for the
 * subject named by a SIGNED token it cannot mint.
 */
export function checkExchangeAuth(
  presented: string | undefined,
  configured: string | undefined,
): void {
  checkStaticBearer(presented, configured, 'exchange');
}

/**
 * The name the audit gives the operator's key (spec §6.4). Reserved: PUT /v1/credentials refuses it,
 * so an operator-fallback audit line is never a subject's own credential.
 */
export const OPERATOR_FALLBACK_NAME = 'operator-fallback';

/** The two direct-mode (header, secret, endpoint) triples known to 401 upstream (#368). */
export type DirectModeMismatch = 'bearer-to-anthropic' | 'raw-key-elsewhere';

/**
 * Which known-bad shape a direct-mode send would be, or undefined for none. Shared by the per-turn
 * check in exchangeCredential and the boot check (main.ts checkInferenceConfig), which sees the
 * operator fallback's whole triple before any turn does.
 */
export function directModeMismatch(
  header: InferenceAuthHeader,
  secret: string,
  baseUrl: string,
): DirectModeMismatch | undefined {
  const host = URL.parse(baseUrl)?.hostname;
  // Bearer there always 401s: it reads API keys from x-api-key only.
  if (header === 'authorization' && host === 'api.anthropic.com') return 'bearer-to-anthropic';
  // A raw Anthropic key aimed anywhere else is a misdirected secret (spec §6.2) and a 401 there.
  if (secret.startsWith('sk-ant-api') && host !== 'api.anthropic.com') return 'raw-key-elsewhere';
  return undefined;
}

export interface ResolvedInference {
  secretValue: string;
  /** The stored credential's name, or OPERATOR_FALLBACK_NAME when the operator's key is used. */
  credentialName: string;
  baseUrl: string;
  authHeader: InferenceAuthHeader;
  usedOperatorFallback: boolean;
}

/**
 * Which secret a session's inference uses, sent in which header, to which endpoint (spec §5.3,
 * §6.2, §6.4). Shared by the exchange and the model catalog (per-session model spec §4.1), so the
 * catalog is asked with exactly the credential a turn would spend. Throws what the exchange throws.
 */
export async function resolveInference(
  rec: { owner: string; credentialName: string; sessionId?: string },
  deps: CpDeps,
): Promise<ResolvedInference> {
  const stored = rec.credentialName
    ? await deps.credentials.get(rec.owner, rec.credentialName)
    : null;

  let secretValue: string | undefined;
  let credentialName = rec.credentialName;
  let endpoint: string | null = null;
  let authHeader: InferenceAuthHeader = 'authorization';
  let usedOperatorFallback = false;

  if (stored) {
    // The kind's SINGLE secret field is the credential value. That is true by construction, not by
    // coincidence: parseCredentialBody refuses `consumer: 'inference'` for any kind declaring more
    // than one secret field (credential-store.ts), so `basic` cannot reach here and send its
    // username upstream as the bearer. Insertion order is parseCredentialBody's loop over
    // spec.secretFields, so with exactly one field there is nothing to pick wrong.
    secretValue = Object.values(stored.secret)[0];
    endpoint = stored.descriptor.endpoint;
    const [field] = Object.keys(stored.secret);
    const header = field ? inferenceAuthHeader(stored.descriptor.binding, field) : undefined;
    if (!header) {
      // Written before parseCredentialBody refused unsendable bindings (#368). Falling back to Bearer
      // would send the secret in a header its binding never named -- refuse, attributably.
      throw new CpError(
        'credential_required',
        `credential '${rec.credentialName}' has a binding the inference path cannot send; store it ` +
          "again as kind 'bearer' (gateway token) or 'api-key' (Anthropic API key)",
        rec.sessionId,
      );
    }
    authHeader = header;
  } else if (
    // Only a session that recorded NO credential (created on the fallback, handlers.ts) falls back. A
    // session whose own credential is gone -- deleted mid-session, say because it leaked -- stops
    // here instead of carrying on on the operator's key (#411 review).
    !rec.credentialName &&
    deps.config.allowOperatorFallback &&
    deps.config.operatorInferenceToken
  ) {
    // The operator fallback relocates rather than disappearing (spec §6.4): resolved HERE, by the
    // trusted tier, attributable to a subject and logged -- never as an env fallback in the harness.
    secretValue = deps.config.operatorInferenceToken;
    credentialName = OPERATOR_FALLBACK_NAME;
    usedOperatorFallback = true;
    authHeader = deps.config.operatorInferenceHeader ?? 'authorization';
  }

  if (!secretValue) {
    // REFUSES rather than reaching for the deployment's own key. This is the second of the two policy
    // points that make MU1 fail closed before P5's sentinel lands (spec §3.5).
    throw new CpError(
      'credential_required',
      rec.credentialName
        ? `subject has no usable inference credential '${rec.credentialName}': store it again, ` +
            'or start a new session'
        : // A session created on the operator fallback records no credential of its own (handlers.ts
          // createSession); with the fallback since turned off it has nothing to spend.
          'this session was started on the operator fallback, which is now off: store an ' +
            'inference credential and start a new session',
      rec.sessionId,
    );
  }

  const baseUrl = endpoint ?? deps.config.defaultInferenceEndpoint;
  if (!baseUrl) {
    // Never returned undefined. run-turn.ts:313's `||` would fall through to the environment and,
    // failing that, applyModelGateway would return a model carrying Bearer <subject's token> with NO
    // baseUrl override -- sending one user's gateway token to the default Anthropic endpoint, where it
    // is neither valid nor intended to go. A credential whose destination cannot be resolved is not a
    // degraded request; it is a misdirected secret (spec §6.2).
    throw new CpError(
      'endpoint_unresolved',
      `credential '${credentialName}' has no endpoint and no deployment default is set`,
      rec.sessionId,
    );
  }
  return { secretValue, credentialName, baseUrl, authHeader, usedOperatorFallback };
}

/**
 * Refuse a resolved (header, secret, endpoint) triple that would misdirect the secret or 401
 * upstream (#368, spec §6.2). Shared by the direct-mode exchange and the model catalog (per-session
 * model spec §4.1), which ALWAYS sends the real secret, so it applies the check in every mode: one
 * set of codes and messages for both. Messages name the credential or the settings, never the value.
 */
export function refuseMisdirectedSecret(r: ResolvedInference, sessionId?: string): void {
  const { secretValue, credentialName, baseUrl, authHeader, usedOperatorFallback } = r;
  const host = URL.parse(baseUrl)?.hostname;
  const mismatch = directModeMismatch(authHeader, secretValue, baseUrl);
  // configFromEnv's boot check (main.ts checkInferenceConfig) refuses a misconfigured fallback
  // before any turn, so this branch is reached only by a config built without it (tests, or a
  // future caller). Kept as defence in depth.
  if (mismatch && usedOperatorFallback) {
    // The operator's token, not the caller's: the caller cannot re-store `operator-fallback`, so the
    // message names the settings and the code blames the deployment (PR #372 review). The data
    // plane shows the caller only "control plane returned 503" (turn-auth admits caller-attributable
    // codes only), so the log line is how the operator finds out. It names settings, never the value.
    const why =
      mismatch === 'bearer-to-anthropic'
        ? 'the operator fallback token (SH_OPERATOR_INFERENCE_TOKEN) is sent as Bearer, but ' +
          'SH_DEFAULT_INFERENCE_ENDPOINT is api.anthropic.com, which reads API keys from ' +
          'x-api-key; the deployment operator must set SH_OPERATOR_INFERENCE_HEADER=x-api-key or ' +
          'point SH_DEFAULT_INFERENCE_ENDPOINT at a gateway'
        : 'the operator fallback token (SH_OPERATOR_INFERENCE_TOKEN) is an Anthropic API key, but ' +
          `SH_DEFAULT_INFERENCE_ENDPOINT resolves to ${host ?? 'an unparseable URL'}; the ` +
          'deployment operator must fix the pair, or you can store your own inference credential';
    console.error(`[control-plane] operator fallback misconfigured: ${why}`);
    throw new CpError('credential_unavailable', why, sessionId);
  }
  if (mismatch === 'bearer-to-anthropic') {
    throw new CpError(
      'credential_required',
      `credential '${credentialName}' is a Bearer token, but its endpoint resolves to ` +
        "api.anthropic.com, which reads API keys from x-api-key: store the key with kind 'api-key'",
      sessionId,
    );
  }
  if (mismatch === 'raw-key-elsewhere') {
    throw new CpError(
      'credential_required',
      `credential '${credentialName}' is an Anthropic API key, but its endpoint resolves to ` +
        `${host ?? 'an unparseable URL'}: set its endpoint to https://api.anthropic.com`,
      sessionId,
    );
  }
}

export const targetOf = (r: ResolvedInference): InferenceTarget => ({
  baseUrl: r.baseUrl,
  secret: r.secretValue,
  header: r.authHeader,
});

export async function exchangeCredential(
  presentedToken: string,
  deps: CpDeps,
): Promise<ExchangeResponse> {
  // Only a SESSION token may drive a turn; an api token is rejected here (plan gap #7).
  const claims = verifyToken(presentedToken, deps.verifyKeys, {
    now: Math.floor(deps.now() / 1000),
    requiredScope: 'turn:write',
  });
  if (!claims.sid) throw new CpError('token_invalid', 'token names no session');

  const rec = await deps.index.get(claims.sid);
  // Owner mismatch and unknown session are the same 404-shaped answer: a valid token minted for one
  // subject must not exchange against another's session even though both facts are true separately.
  if (!rec || rec.owner !== claims.sub) {
    throw new CpError('session_not_found', undefined, claims.sid);
  }
  // The tombstone check is what stops a DELETED session starting a new turn (spec §5.3, §7.3).
  if (rec.tombstone) throw new CpError('session_not_found', undefined, claims.sid);

  const resolved = await resolveInference(rec, deps);
  const { secretValue, credentialName, baseUrl, authHeader, usedOperatorFallback } = resolved;

  // Placeholder mode WINS whenever the deployment has an injector, so adding one strictly narrows
  // what the harness may hold; direct mode is reachable only when none is configured, and MU3 deletes
  // it outright (spec §3.6).
  const mode: CredentialMode = deps.config.injectorConfigured ? 'placeholder' : 'direct';

  // In DIRECT mode the harness sends the secret itself, in the header its binding names, so the
  // header and the endpoint it resolves to must agree. PUT checks the credential's own endpoint but
  // cannot see the deployment default it may resolve to here. In placeholder mode the injector, not
  // the harness, picks the upstream header (AB1's `inject_header`), so none of this applies (#368).
  if (mode === 'direct') {
    refuseMisdirectedSecret(resolved, rec.sessionId);
  }

  await deps.index.audit({
    subject: rec.owner,
    sessionId: rec.sessionId,
    credential: credentialName,
    decision: usedOperatorFallback ? 'operator_fallback_used' : 'credential_issued',
  });

  if (rec.configRef) {
    // Best effort: a bundle in daily use must not age out, but a failed refresh never fails a turn.
    await touchBundle(deps.bundles, rec.configRef, deps.now()).catch((err: unknown) =>
      console.error(
        `[control-plane] bundle TTL refresh failed for configRef=${rec.configRef}: ` +
          `${(err as Error)?.message ?? String(err)}`,
      ),
    );
  }

  const tier = sessionTier(rec, deps.config.sandboxTiers);
  return {
    mode,
    anthropicAuthToken: mode === 'placeholder' ? placeholderFor(rec.owner) : secretValue,
    anthropicBaseUrl: baseUrl,
    sessionId: rec.sessionId,
    subject: rec.owner,
    // Direct mode only: in placeholder mode the harness sends `Bearer <placeholder>` as it always did,
    // and the injector decides the upstream header.
    ...(mode === 'direct' && authHeader === 'x-api-key' ? { authHeader } : {}),
    ...(rec.configRef ? { configRef: rec.configRef } : {}),
    ...(tier ? { sandboxTier: tier } : {}),
    ...(rec.model ? { model: { id: rec.model, ...rec.modelLimits } } : {}),
  };
}
