import {
  assertValidDigest,
  BundleDigestMismatchError,
  bundleKey,
  DEFAULT_BUNDLE_TTL_SECONDS,
  MAX_BUNDLE_BYTES,
  prepareBundle,
  type BundleRedisLike,
} from '@moca/config-bundle';
import {
  admitBundle,
  bundleOwnerHash,
  dropBundleEntry,
  listBundlesByOwner,
  MIN_BUNDLE_CHARGE_BYTES,
  recordBundle,
  refreshBundle,
  touchBundle,
  unrecordBundle,
  withBundleLock,
  type BundleBudgetRedisLike,
} from './bundle-budget.js';
import { type AuditLog, defaultAuditLog } from './audit-log.js';
import { CpError, statusFor } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  requireEnrolledPrincipal,
  seconds,
} from './handler-util.js';
import { subjectHash } from './subject-document.js';
import { asyncCounters } from './counters.js';
import {
  resolveInferenceName,
  parseCredentialBody,
  validateCredentialName,
  type CredentialDescriptor,
  type CredentialStore,
  type InferenceAuthHeader,
} from './credential-store.js';
import {
  exchangeCredential,
  OPERATOR_FALLBACK_NAME,
  refuseMisdirectedSecret,
  resolveInference,
  targetOf,
  viewTier,
} from './exchange.js';
import { MODEL_ID_RE } from './models.js';
import { exchangeTurnCredential } from './turn-exchange.js';
import { issueTurnGrants, refreshTurnGrants } from './grant-exchange.js';
import { isMintedTurnId } from './turn-record.js';
import {
  catalogAllowList,
  chooseModel,
  fetchModelCatalog,
  type ModelChoice,
} from './model-catalog.js';
import type { RunKubectl } from './kubectl.js';
import { DEFAULT_PAGE_SIZE, type OwnershipIndex, type SessionRecord } from './ownership.js';
import type { IdentityProvider, TestUserProvider } from './identity.js';
import type { KeyObject } from 'node:crypto';
import { DEFAULT_ISSUER, SANDBOX_API_ISSUER, type MintInput, type TokenClaims } from './token.js';
import { isRefreshTokenShape, type RefreshStore } from './refresh-store.js';
import { projectResources, resolveSandbox } from './resources.js';
import type { SandboxTiers } from './sandbox-tiers.js';
import type { RouteProfile } from './routes.js';
import {
  isEnrolled,
  isEnrolledForSandbox,
  notEnrolled,
  type SandboxConfig,
  type SandboxTemplate,
} from './sandbox-config.js';
import type { ProvenanceStore } from './provenance.js';
import type { PresenceReader, TemplateBuild, TemplateCatalog } from './template-catalog.js';
import type { PolicyStore } from './template-policy.js';
import type { SandboxStore } from './sandbox-store.js';
import { SANDBOX_HANDLERS, requireActive, resolveForUse } from './sandbox-handlers.js';
import type { TemplateHost } from './host-config.js';
import { HOST_HANDLERS, type HostRegistry } from './host-handlers.js';
import { EGRESS_HANDLERS } from './egress-handlers.js';
import { TURN_HANDLERS } from './turn-handlers.js';
import type { Tenancy } from './tenancy.js';
import type { TurnQueue } from './turn-queue.js';
import type { ResultRedisLike } from './turn-result.js';
import type { TurnStore } from './turn-store.js';
import type { EgressHost } from './egress-config.js';
import type { EgressStore } from './egress-log.js';
import { formatDestination, parseDestination } from './egress-destination.js';

/** A stored destination in normalized form; a legacy or corrupt entry compares as written. */
function normalizeStored(h: string): string {
  try {
    return formatDestination(parseDestination(h));
  } catch {
    return h;
  }
}

/** The `iss` this control plane mints API tokens under and accepts on API routes. */
export function apiIssuer(config: Pick<CpConfig, 'routeProfile'>): string {
  return config.routeProfile === 'sandbox' ? SANDBOX_API_ISSUER : DEFAULT_ISSUER;
}

export interface CpConfig {
  /** Which routes this control plane mounts (SBX0 §4.1). Absent means `harness`. */
  routeProfile?: RouteProfile;
  /** The template hosts (SH_TEMPLATE_HOSTS, template lifecycle spec §6.1); absent or empty: none. */
  templateHosts?: TemplateHost[];
  apiTokenTtlSeconds: number;
  sessionTokenTtlSeconds: number;
  /** A refresh family dies this long after its last use (`SH_REFRESH_IDLE_TTL_SECONDS`, B14). */
  refreshIdleTtlSeconds: number;
  /** ...and this long after login, however often it is used (`SH_REFRESH_MAX_TTL_SECONDS`). */
  refreshMaxTtlSeconds: number;
  /** How long a just-superseded refresh token still gets its successor back (spec §4.3 step 4). */
  refreshReuseGraceSeconds: number;
  /** The shared bearer the data plane presents to /internal/credentials (spec §5.3.1). */
  exchangeToken?: string;
  /** Deployment-level gateway origin, used when a credential carries no `endpoint` (spec §6.2). */
  defaultInferenceEndpoint?: string;
  /**
   * Hosts the model catalog may contact besides api.anthropic.com and defaultInferenceEndpoint's
   * host (`SH_MODEL_CATALOG_HOSTS`, per-session model spec §4.1): exact, lower-case hostnames.
   */
  modelCatalogHosts?: string[];
  /** The operator's own key, resolved at EXCHANGE time behind allowOperatorFallback (spec §6.4). */
  operatorInferenceToken?: string;
  /**
   * The header the operator's token travels in, in direct mode (#368): `authorization` (Bearer, a
   * gateway token) or `x-api-key` (a raw Anthropic key). Absent means `authorization`.
   */
  operatorInferenceHeader?: InferenceAuthHeader;
  allowOperatorFallback: boolean;
  /** Placeholder mode wins whenever the deployment has an injector (spec §3.6). */
  injectorConfigured: boolean;
  sandboxNamespace: string;
  /**
   * The harness base URL as a CLIENT reaches it, advertised by GET /v1/discovery so a client needs
   * only this control plane's URL. Unset means the deployment advertises none.
   */
  publicHarnessUrl?: string;
  /**
   * The declared sandbox tiers (P6.3), or null when the deployment declares none. Read once at boot:
   * configFromEnv refuses a list it cannot serve, so a session is never validated against a typo.
   */
  sandboxTiers: SandboxTiers | null;
  /**
   * The declared session templates (session-templates spec §3.3), harness profile only: absent or
   * null when the deployment declares none, and then sessions are exactly as before.
   */
  sessionTemplates?: SandboxTemplate[] | null;
  /** Stored config-bundle bytes one subject may hold (`SH_BUNDLE_SUBJECT_BYTES`). */
  bundleSubjectBytes: number;
  /** Stored config-bundle bytes the whole deployment may hold (`SH_BUNDLE_TOTAL_BYTES`). */
  bundleTotalBytes: number;
  /** Advertised alongside harnessUrl; null when the deployment reports none (predates MOCA_VERSION). */
  version?: string;
  /** ADR-0045: how many `test:N` logins `SH_TEST_USERS` enabled; 0 means the path is off. */
  testUsers: number;
  /** The sandbox profile's settings (SBX0 §4, §5); configFromEnv sets it on that profile only. */
  sandbox?: SandboxConfig;
  /**
   * Non-terminal async turns one owner may hold (`MOCA_ASYNC_QUEUED_PER_OWNER`, default 50; async
   * spec §4.3). The only containment against unbounded fan-out in M1, which is why it ships with
   * the submission route rather than after it. Distinct from the worker's SH_TURNS_PER_SUBJECT
   * (#360): that counts turns EXECUTING, in one process; this counts turns WAITING, per deployment.
   */
  asyncQueuedPerOwner: number;
  /**
   * `MOCA_TENANCY` (async spec §9). Async submission is refused by name under `multi` until M2:
   * M1 resolves the credential from the turn record at dequeue, which MI1 S2's interim allows under
   * `single` only.
   */
  tenancy: Tenancy;
  /**
   * How long a TERMINAL turn record lives: `LEAF_RESULT_TTL_SECONDS` plus a margin (async spec
   * §5.1). A non-terminal record has no TTL at all, which is the invariant TurnStore owns.
   */
  turnRecordTtlSeconds: number;
  /**
   * `MOCA_GRANT_TTL_S`, default 300 (MI1 §15): how long a session grant lives before the worker
   * must refresh it. Short on purpose -- with no revocation list, this IS the revocation latency.
   */
  grantTtlS: number;
  /**
   * `MOCA_TURN_MAX_S`, default 1800 (MI1 §15): the deployment-wide ceiling on one turn. A turn may
   * ask for less through its caps and never for more; the clamp is at mint (`grant.ts`'s `turnExp`).
   */
  turnMaxS: number;
}

export interface CpDeps {
  index: OwnershipIndex;
  credentials: CredentialStore;
  /** Content-addressed config bundles (ADR-0038); the same Redis the ownership index uses. */
  bundles: BundleRedisLike & BundleBudgetRedisLike;
  identity: IdentityProvider;
  /** ADR-0045: present only when SH_TEST_USERS > 0; its absence is what 404s the test-login route. */
  testUsers?: TestUserProvider;
  signer: {
    kid: string;
    mint(input: MintInput): string;
    signJws(typ: string, claims: object): string;
  };
  /** Refresh-token families (B14). RedisRefreshStore in production; MemoryRefreshStore in tests. */
  refresh: RefreshStore;
  /**
   * The public halves used to VERIFY a presented token at the exchange (Task 12). Normally just the
   * signer's own public key; a list during a rotation window.
   */
  verifyKeys: Map<string, KeyObject>;
  config: CpConfig;
  /** Epoch MILLISECONDS. Injectable so no test depends on the wall clock. */
  now(): number;
  /** randomUUID by default. A control-plane-minted id is always its own leafSessionId (gap #10). */
  newId(): string;
  runKubectl?: RunKubectl;
  /** The model catalog's fetch (per-session model spec §4.1); global fetch when absent. A test seam. */
  fetchImpl?: typeof fetch;
  /**
   * Whether the Redis client is connected and ready (main.ts: `client.isReady`). A command issued
   * while it is not ready waits in node-redis's offline queue for as long as the outage lasts, so
   * readyz consults this first rather than awaiting a probe that cannot fail (#423, spike F2).
   * Absent means "do not know", and readyz falls back to asking the index.
   */
  redisReady?: () => boolean;
  /**
   * How long readyz waits on the index before calling Redis unavailable; 500 ms by default. Below
   * the kubelet's 1 s default probe timeout, so a connected-but-wedged Redis answers 503 rather
   * than timing the probe out (#434). A test seam, not a setting.
   */
  readyzTimeoutMs?: number;
  /** Release the Redis client. A test that builds deps through depsFromEnv must call it. */
  close?: () => Promise<void>;
  /** The sandbox resource (SBX0 §5); present on the sandbox profile only. */
  sandboxes?: SandboxStore;
  /** Per-sandbox egress logs, beside `sandboxes`; absent, the routes store nothing. */
  egress?: EgressStore;
  /**
   * The template provenance store (template lifecycle spec §7). Absent, nothing is recorded and no
   * handler's behavior changes; when present, a sandbox's create and end are recorded on its
   * template's chain.
   */
  provenance?: ProvenanceStore;
  /**
   * The template catalog (template lifecycle spec §3.1), opened with `provenance` when
   * SH_PROVENANCE_DIR is set. Absent: built from the sandbox profile's SH_SANDBOX_TEMPLATES, as
   * before the catalog existed.
   */
  templates?: TemplateCatalog;
  /** The relay's presence records, which template readiness is derived from (§3.3). */
  presence?: PresenceReader;
  /**
   * The deployment's template policy (§8), stored with the catalog and recorded in `provenance`;
   * absent without SH_PROVENANCE_DIR, where templates cannot be created through the API.
   */
  policy?: PolicyStore;
  /** The template hosts' inventories and limits (§6.1), as their agents last reported them. */
  hosts?: HostRegistry;
  /** Stdout mirror of audit decisions; defaults to `defaultAuditLog` in depsFromEnv. */
  log?: AuditLog;
  /** The async turn record store (async spec §5.1); absent only in suites that never submit. */
  turns?: TurnStore;
  /** The leaf queue, holding turn ids and nothing else (§5.1). */
  turnQueue?: TurnQueue;
  /** Reads `leaf:result:<sid>:<turnId>` for the status route (§4.4); absent means no result. */
  leafResults?: ResultRedisLike;
  /**
   * The GRANT ring's private half (MI1 §6.1), a SEPARATE key from `signer` so a session token can
   * never pass as a grant. Present only when `MOCA_GRANT_SIGNING_KEY` is set, and its absence is
   * what 404s both grant routes (ADR-0045's shape, `server.ts`'s `grants` feature).
   */
  grantSigner?: { kid: string; signJws(typ: string, claims: object): string };
  /**
   * The public halves used to verify a grant presented at `/internal/grants/refresh`: the grant
   * signer's own key, plus `MOCA_GRANT_PUBLIC_KEYS` during a rotation window. Set together with
   * `grantSigner`; the refresh route is the control plane's only grant verifier, since workers
   * receive grants over the authenticated exchange and never verify them.
   */
  grantVerifyKeys?: Map<string, KeyObject>;
}

/** `deps.log` with the production default; keeps the field optional on `CpDeps`. */
export const resolveAuditLog = (deps: Pick<CpDeps, 'log'>): AuditLog => deps.log ?? defaultAuditLog;

export interface RequestCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Set by the router for `auth: 'api'` routes. */
  principal?: TokenClaims;
  /** Set by the router for `auth: 'exchange'` routes. */
  exchangeAuthorized?: boolean;
  /** Set by the router for `auth: 'janitor'` routes. */
  janitorAuthorized?: boolean;
  /** Set by the router for `auth: 'egress'` routes: the host whose token was presented. */
  egressHost?: EgressHost;
  /** Set by the router for `auth: 'host'` routes: the template host whose token was presented. */
  host?: string;
}

export type Handler = (
  ctx: RequestCtx,
  deps: CpDeps,
) => Promise<{
  status: number;
  body: unknown;
  contentType?: string;
  /** Extra response headers (the oidc page's cache/frame policy); nothing by default. */
  headers?: Record<string, string>;
}>;

export function requirePrincipal(ctx: RequestCtx): TokenClaims {
  if (!ctx.principal) throw new CpError('token_required', 'this route requires a token');
  return ctx.principal;
}

/**
 * The single ownership choke point (spec §5.4). Every session-scoped handler goes through it, and
 * Task 13's enumeration test proves that claim rather than trusting it.
 *
 * A non-owner gets 404, NOT 403: a 403 is an existence oracle. Session ids are unguessable UUIDs so
 * the leak is small, but 404 is the standard answer and the one we would otherwise have to change
 * later (spec §8.1). An unknown session and someone else's session are therefore indistinguishable.
 *
 * `admin` deliberately does NOT bypass this. The role gates `?owner=` on the LIST route only; the
 * privilege to read another user's session body is a separate one MU1 does not grant, and folding it
 * in here would make every later authz rule ambiguous.
 */
export async function assertOwner(
  sessionId: string,
  principal: TokenClaims | undefined,
  deps: CpDeps,
): Promise<SessionRecord> {
  if (!principal) throw new CpError('token_required', 'this route requires a token');
  const rec = await deps.index.get(sessionId);
  if (!rec || rec.owner !== principal.sub) {
    throw new CpError('session_not_found', undefined, sessionId);
  }
  return rec;
}

/** A query integer must be rejected, not coerced: `parseInt('abc')` is NaN and pages by nothing. */
function intQuery(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CpError('invalid_request', `${name} must be a number`);
  return n;
}

/**
 * The body both grants answer with (device flow and refresh, B14 §4.3): an API token now, and the
 * refresh token behind it. Roles are the CALLER's current ones -- never replayed from a record.
 */
function loginBody(
  deps: CpDeps,
  who: { subject: string; displayName: string; roles: string[] },
  refresh: { refreshToken: string; absExpS: number },
) {
  const iat = seconds(deps);
  return {
    token: deps.signer.mint({
      sub: who.subject,
      tenant: who.subject, // one subject is one tenant in MU1 (spec §11.2)
      roles: who.roles,
      scope: ['api'],
      ttlSeconds: deps.config.apiTokenTtlSeconds,
      iss: apiIssuer(deps.config),
      now: iat,
    }),
    subject: who.subject,
    displayName: who.displayName,
    roles: who.roles,
    expiresAt: iat + deps.config.apiTokenTtlSeconds,
    refreshToken: refresh.refreshToken,
    refreshExpiresAt: refresh.absExpS,
  };
}

/**
 * A `session` record on its build's chain (lifecycle spec §7.1), written BEST EFFORT: it records a
 * create or delete that has already happened, so a failed append is logged and the write stands, as
 * the audit mirroring does (auditBestEffort). Throwing would answer 500 for a session that exists,
 * or is gone, and a client retrying that create would make a second session.
 */
async function appendSessionRecord(
  deps: CpDeps,
  stream: string,
  subject: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.provenance!.append({ stream, kind: 'session', subject, body });
  } catch (err) {
    console.error(
      `[control-plane] session record write failed for ${String(body.sessionId)} (${String(body.state)}): ` +
        `${(err as Error)?.message ?? String(err)} -- the write itself SUCCEEDED`,
    );
  }
}

async function turnInFlight(sessionId: string, deps: CpDeps): Promise<boolean> {
  const runtime = await deps.index.getRuntime(sessionId);
  const started = Number(runtime.turnStartedAt ?? 0);
  const ended = Number(runtime.turnEndedAt ?? 0);
  return started > 0 && started > ended;
}

/** The body of putConfigBundle; `seen` collects what the refusal audit row can name. */
async function storeConfigBundle(
  p: TokenClaims,
  body: Record<string, unknown>,
  deps: CpDeps,
  seen: { configRef?: string; bytes?: number },
): Promise<{ status: number; body: unknown }> {
  const digest = body.digest;
  if (typeof digest !== 'string') throw new CpError('invalid_request', 'digest must be a string');
  try {
    assertValidDigest(digest);
  } catch {
    throw new CpError('invalid_request', 'digest must be sha256:<64 lowercase hex>');
  }
  seen.configRef = digest;
  if (typeof body.tar !== 'string' || body.tar.length === 0) {
    throw new CpError('invalid_request', 'tar must be a non-empty base64 string');
  }
  // Buffer.from skips invalid characters, which would surface a garbled upload as digest_mismatch.
  if (body.tar.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.tar)) {
    throw new CpError('invalid_request', 'tar must be strict base64');
  }
  const tar = Buffer.from(body.tar, 'base64');
  seen.bytes = tar.length;
  if (tar.length > MAX_BUNDLE_BYTES) {
    throw new CpError(
      'invalid_request',
      `bundle is ${tar.length} bytes; the limit is ${MAX_BUNDLE_BYTES} bytes`,
    );
  }
  let uploaded: boolean;
  const nowMs = deps.now();
  const limits = {
    subjectBytes: deps.config.bundleSubjectBytes,
    totalBytes: deps.config.bundleTotalBytes,
  };
  const key = bundleKey(digest);
  /** A stored digest is free: refresh it and report it unchanged. */
  const refreshed = async () => {
    if ((await deps.bundles.exists(key)) === 0) return false;
    await deps.bundles.expire(key, DEFAULT_BUNDLE_TTL_SECONDS);
    await refreshBundle(deps.bundles, digest, nowMs);
    return true;
  };
  try {
    const value = prepareBundle(digest, tar);
    uploaded =
      !(await refreshed()) &&
      (await withBundleLock(async () => {
        if (await refreshed()) return false; // stored by a concurrent upload while we queued
        const charged = Math.max(value.length, MIN_BUNDLE_CHARGE_BYTES);
        await admitBundle(deps.bundles, limits, p.sub, digest, charged, nowMs);
        // Charged before the SET, so a stored bundle is never left uncharged. A record that fails
        // partway is rolled back too, so it leaves no phantom charge on the budget.
        try {
          await recordBundle(deps.bundles, p.sub, digest, charged, nowMs);
          await deps.bundles.set(key, value, { EX: DEFAULT_BUNDLE_TTL_SECONDS });
        } catch (err) {
          await unrecordBundle(deps.bundles, p.sub, digest).catch(() => undefined);
          throw err;
        }
        return true;
      }));
  } catch (err) {
    if (err instanceof CpError) throw err;
    if (err instanceof BundleDigestMismatchError) throw new CpError('digest_mismatch', err.message);
    console.error(
      `[control-plane] putConfigBundle configRef=${digest}: ${(err as Error)?.message ?? String(err)}`,
    );
    throw new CpError('redis_unavailable', 'redis is not answering');
  }
  await auditBestEffort(deps, 'putConfigBundle', `configRef=${digest}`, {
    subject: p.sub,
    configRef: digest,
    bytes: tar.length,
    decision: uploaded ? 'config_bundle_uploaded' : 'config_bundle_unchanged',
  });
  return { status: 201, body: { digest, uploaded } };
}

/** Public view of a session record. `turns` comes from the display-only runtime hash. */
async function sessionView(rec: SessionRecord, deps: CpDeps) {
  const runtime = await deps.index.getRuntime(rec.sessionId);
  // The tier the session actually runs in: what it was created with, or -- for '' or a record that
  // predates P6.3 -- today's default, which the exchange names for it. Null only when untiered.
  const tier = viewTier(rec, deps.config.sandboxTiers);
  return {
    sessionId: rec.sessionId,
    owner: rec.owner,
    tenant: rec.tenant,
    createdAt: rec.createdAt,
    state: rec.state,
    configRef: rec.configRef,
    lastTurnAt: runtime.lastTurnAt ? Number(runtime.lastTurnAt) : null,
    turns: runtime.turns ? Number(runtime.turns) : 0,
    sandboxTier: tier,
    // Shown on a deployment that declares templates, and wherever the session named one, so a
    // dropped template is visible too (it fails closed); a view elsewhere is unchanged.
    ...(deps.config.sessionTemplates || rec.sandboxTemplate
      ? {
          sandboxTemplate: rec.sandboxTemplate || null,
          // The build the template resolved to at creation (combined control plane spec §3.4),
          // which its turns run on; its manifest hash, null for an imported build.
          sandboxBuildId: rec.sandboxBuildId || null,
          templateManifestHash: rec.sandboxBuildId?.startsWith('sha256:')
            ? rec.sandboxBuildId
            : null,
        }
      : {}),
    model: rec.model || null,
  };
}

/**
 * The credential a session created now would record: the named one, or -- for a subject with no
 * inference credential of its own -- '' for the operator fallback (spec §6.4). Shared by
 * createSession and the catalog route, which must list for exactly the credential a session would use.
 */
export function newSessionCredential(
  descriptors: CredentialDescriptor[],
  requested: string | undefined,
  deps: CpDeps,
): string {
  const fallback =
    requested === undefined &&
    deps.config.allowOperatorFallback &&
    !!deps.config.operatorInferenceToken &&
    !descriptors.some((d) => d.consumer === 'inference');
  return fallback ? '' : resolveInferenceName(descriptors, requested);
}

/** A requested model id, validated: undefined when absent (spec §4.2). */
function modelParam(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !MODEL_ID_RE.test(raw)) {
    throw new CpError(
      'invalid_request',
      'model must be a model id: 1-256 printable ASCII characters, no spaces',
    );
  }
  return raw;
}

/** Check a model against the catalog of the credential `rec` runs on (spec §4.2, §4.3). */
async function chooseFor(
  rec: { owner: string; credentialName: string; sessionId?: string },
  model: string,
  deps: CpDeps,
): Promise<ModelChoice> {
  const r = await resolveInference(rec, deps);
  // The catalog sends the real secret in every mode, so the exchange's direct-mode refusal applies
  // here unconditionally: a misdirected secret must not leave even to list models (final review F1).
  refuseMisdirectedSecret(r, rec.sessionId);
  return chooseModel(targetOf(r), model, r.credentialName, catalogHostsOf(deps), deps.fetchImpl);
}

/** The hosts the catalog may contact (spec §4.1): never a user-chosen endpoint unvetted (R1). */
const catalogHostsOf = (deps: CpDeps) =>
  catalogAllowList(deps.config.modelCatalogHosts ?? [], deps.config.defaultInferenceEndpoint);

/** The catalog body for the credential `rec` runs on (per-session model spec §4.1). */
async function catalogFor(
  rec: { owner: string; credentialName: string; sessionId?: string },
  deps: CpDeps,
) {
  const r = await resolveInference(rec, deps);
  refuseMisdirectedSecret(r, rec.sessionId); // as in chooseFor
  return {
    status: 200,
    body: {
      credential: r.credentialName,
      // Wildcard routes are not models (final review F8): the body keeps its `{ credential, models }`.
      models: (await fetchModelCatalog(targetOf(r), catalogHostsOf(deps), deps.fetchImpl)).models,
    },
  };
}

/**
 * Escape everything HTML-significant in a value that came from a query string (the callback's
 * `state`, an error message) before it is placed in the page: the page is served to a browser on
 * the strength of a URL a forger can construct, so a `<script>` in a parameter must render as
 * text, never execute.
 */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The callback page: one inline-styled HTML document, no external resources, no scripts. The
 * headers make it un-frameable, uncached and referer-silent: a framed confirmation form is a
 * clickjacking surface, and the page's URLs and tokens must not live in a cache or leak onward.
 */
function htmlPage(
  title: string,
  bodyHtml: string,
  status = 200,
): {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
} {
  const page =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>moca — ${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:28em;margin:4em auto;padding:0 1em">` +
    `<h2>moca</h2>${bodyHtml}</body></html>`;
  return {
    status,
    body: page,
    contentType: 'text/html; charset=utf-8',
    headers: {
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
    },
  };
}

/** The OIDC callback's two rounds, shared by the GET (query) and POST (form) routes. */
async function oidcCallbackImpl(
  deps: CpDeps,
  field: (k: string) => string | null,
): Promise<{ status: number; body: string; contentType: string; headers: Record<string, string> }> {
  if (!deps.identity.handleCallback) {
    return {
      status: 400,
      body: 'this control plane has no oidc identity provider: set SH_IDENTITY_PROVIDER=oidc',
      contentType: 'text/plain',
      headers: {},
    };
  }
  const state = field('state') ?? undefined;
  try {
    const { outcome, confirmToken } = await deps.identity.handleCallback({
      code: field('code') ?? undefined,
      state,
      error: field('error') ?? undefined,
      confirm: field('confirm') ?? undefined,
      token: field('ct') ?? undefined,
    });
    if (outcome === 'confirmed') {
      return htmlPage('Sign-in confirmed', '<p>Sign-in confirmed — return to your terminal.</p>');
    }
    if (outcome === 'refused') {
      return htmlPage(
        'Sign-in refused',
        '<p>The sign-in was refused. Return to your terminal for the reason, and start again there.</p>',
      );
    }
    const wrong = outcome === 'wrong_code';
    // A wrong-code re-render echoes back the ct THIS request carried: the sender already holds
    // it, so echoing exposes nothing, while omitting it would ship ct="" and make every retry
    // fail the token check -- four more submits and the login is refused even with the right
    // code (review round 3). Only round 1 ever introduces a NEW token.
    const ct = confirmToken ?? field('ct') ?? '';
    // The one case neither source covers: a reload of, or Back to, the round-1 page. That re-GETs
    // the provider's redirect; the spent code is refused, the login is left parked, and there is
    // no token to put in a form. Rendering a form with ct="" would burn a try per submit until
    // the login is denied -- so render an explanation instead, and never a form that cannot work.
    if (ct === '') {
      return htmlPage(
        'Sign-in page expired',
        '<p>This page is no longer valid — use the tab that opened from the sign-in, or start' +
          ' again in your terminal.</p>',
      );
    }
    return htmlPage(
      'Confirm your sign-in',
      `${wrong ? '<p style="color:#b00">That code is not right — try again.</p>' : ''}` +
        '<p>Enter the code shown in your terminal to finish signing in.</p>' +
        `<form method="POST" action="/v1/auth/oidc/callback">` +
        `<input type="hidden" name="state" value="${escapeHtml(state ?? '')}">` +
        // The browser-bound half of the binding (oidc.ts): minted in the round-1 response this
        // browser received, invisible to whoever started the login, required in round 2.
        `<input type="hidden" name="ct" value="${escapeHtml(ct)}">` +
        `<input name="confirm" autocomplete="off" autofocus required maxlength="9" ` +
        `placeholder="XXXX-XXXX" style="font-size:1.2em;padding:.4em;letter-spacing:.15em">` +
        `<button style="font-size:1.1em;padding:.4em .8em">Confirm</button></form>`,
    );
  } catch (err) {
    const status = err instanceof CpError ? statusFor(err.code) : 500;
    const message =
      err instanceof CpError && err.message ? err.message : 'the sign-in could not be completed';
    return htmlPage('Sign-in failed', `<p>${escapeHtml(message)}</p>`, status);
  }
}

export const HANDLERS: Record<string, Handler> = {
  healthz: async () => ({ status: 200, body: 'ok' }),

  /**
   * §7's `async_quota_refusals`. Process-local and reset by a restart, like every count in the
   * supervisor's own /metrics: with more than one replica a scraper sees one replica's share per
   * request. That is the right trade for a rate signal -- a shared counter would put a Redis write
   * on the refusal path, which is the one path already shedding load.
   */
  getMetrics: async (ctx) => {
    const p = requirePrincipal(ctx);
    if (!isAdmin(p)) throw new CpError('forbidden', '/metrics requires the admin role');
    return { status: 200, body: { counters: asyncCounters() } };
  },
  // `null`, not a 404, when unset: the client can tell "this deployment advertises no harness" from
  // "this control plane predates discovery" and name the right fix for each.
  // SBX0 §4.1 (v1.1): the sandbox profile answers only where clients send Exec, and the CA to trust
  // when its certificate is self-issued (absent otherwise); templates are at the fixed /v1/templates.
  getDiscovery: async (_ctx, deps) => {
    const profile = deps.config.routeProfile ?? 'harness';
    let sandboxFields: Record<string, string> = {};
    if (profile !== 'harness') {
      const sbx = deps.config.sandbox;
      // Never fall through to the harness body: a sandbox profile without its config is a bug.
      if (!sbx) throw new CpError('internal_error', `the ${profile} profile has no sandbox config`);
      sandboxFields = {
        execEndpoint: sbx.execEndpoint,
        ...(sbx.execCa ? { execCa: sbx.execCa } : {}),
      };
    }
    if (profile === 'sandbox') {
      return { status: 200, body: { profile: 'sandbox', ...sandboxFields } };
    }
    // harness, and combined (combined control plane spec §3.1): the harness fields, plus the
    // sandbox ones on combined.
    return {
      status: 200,
      body: {
        harnessUrl: deps.config.publicHarnessUrl ?? null,
        sandboxTiers: deps.config.sandboxTiers,
        // Only when declared (session-templates spec §3.3), so discovery elsewhere is byte-identical.
        // The seed is the harness's business: clients see what they choose between.
        ...(deps.config.sessionTemplates
          ? {
              sandboxTemplates: deps.config.sessionTemplates.map((t) => ({
                id: t.id,
                description: t.description,
                tools: t.tools,
              })),
            }
          : {}),
        version: deps.config.version ?? null,
        profile,
        ...sandboxFields,
      },
    };
  },

  startDeviceAuth: async (_ctx, deps) => ({
    status: 200,
    body: await deps.identity.startDeviceAuth(),
  }),

  completeDeviceAuth: async (ctx, deps) => {
    const deviceCode = asRecord(ctx.body).deviceCode;
    if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
      throw new CpError('invalid_request', 'deviceCode is required');
    }
    // A pending authorization propagates as authorization_pending (428) -- the client polls.
    const principal = await deps.identity.completeDeviceAuth(deviceCode);
    // SBX0 §4.2: on the sandbox profile only enrolled subjects (and admins) get a login, and the
    // refusal comes BEFORE a refresh family is issued, so nothing is left behind for them.
    if (!isEnrolled(principal.subject, principal.roles, deps.config)) {
      throw notEnrolled(principal.subject);
    }
    const label = asRecord(ctx.body).label;
    const issued = await deps.refresh.issue({
      subject: principal.subject,
      displayName: principal.displayName,
      label: typeof label === 'string' ? label : '',
      nowMs: deps.now(),
    });
    return { status: 200, body: loginBody(deps, principal, issued) };
  },

  /**
   * A test-user login (ADR-0045). Deliberately the same two calls as completeDeviceAuth -- issue a
   * refresh family, return loginBody -- so a test user is indistinguishable from a GitHub user
   * everywhere downstream: token TTLs, rotation, roles, ownership, audit, credentials.
   *
   * Order matters. The 404 comes first, so a deployment without test users reveals nothing; the
   * secret check comes before the index is even looked at, so an unauthenticated caller cannot
   * learn how many test users exist by probing indexes.
   */
  testUserToken: async (ctx, deps) => {
    const provider = deps.testUsers;
    // Belt and braces: routes.ts leaves this route UNMOUNTED when test users are off, so what a
    // caller actually sees is an unrouted 404 -- before server.ts reads the body, which would
    // otherwise answer 400 to an empty one and reveal that the route exists. This guard only
    // matters if a future wiring mistake mounts the route without a provider.
    if (!provider) throw new CpError('not_found', 'not_found');
    const body = asRecord(ctx.body);
    const secret = body.secret;
    if (typeof secret !== 'string' || !provider.authenticates(secret)) {
      // Audited, because this endpoint mints a real login -- an admin one, if SH_ADMIN_SUBJECTS
      // names the subject -- so a brute-force attempt must leave a trace an operator can find.
      // The presented value is NEVER recorded; the subject is '-' because the caller proved nothing.
      resolveAuditLog(deps)({
        event: 'audit',
        ts: String(deps.now()),
        subject: '-',
        decision: 'test_user_login_refused',
        reason: typeof secret === 'string' ? 'wrong_secret' : 'no_secret',
      });
      // One code for a missing and a wrong secret alike: distinguishing them tells a prober which
      // half of the problem to work on.
      throw new CpError('unauthorized', 'test-user login refused: wrong or missing secret');
    }
    const index = body.index;
    if (typeof index !== 'number' || !provider.has(index)) {
      throw new CpError('invalid_request', `index must be a whole number in 1..${provider.count}`);
    }
    const principal = provider.principalFor(index);
    // SBX0 §4.2's enrolment gate still applies: main.ts refuses to boot test users on the sandbox
    // profile, and this keeps the invariant even if that guard were ever relaxed.
    if (!isEnrolled(principal.subject, principal.roles, deps.config)) {
      throw notEnrolled(principal.subject);
    }
    const label = body.label;
    const issued = await deps.refresh.issue({
      subject: principal.subject,
      displayName: principal.displayName,
      label: typeof label === 'string' ? label : '',
      nowMs: deps.now(),
    });
    return { status: 200, body: loginBody(deps, principal, issued) };
  },

  // The OIDC callback is the one route answered by a BROWSER, not by mocactl, so it answers HTML
  // (escapeHtml escapes everything a provider or a forger can put in a query or a form field).
  // Two rounds share the path (oidc.ts): the provider's redirect (GET ?code=) renders the
  // confirmation form that asks for the terminal's user code -- the browser-to-terminal binding
  // -- and the form's submission (POST, urlencoded) completes the sign-in, keeping the code and
  // the browser token out of URLs, access logs and browser history. The refusal for a provider
  // that holds its own flow (GitHub) names the setting to change, as the device-flow refusals do.
  // GET is the provider's redirect target only; the confirmation submits by POST, so a confirm
  // attempt over GET (an old bookmarked form, a hand-built link) is refused rather than run --
  // the code and the browser token must never ride a URL, an access log, or browser history.
  oidcCallback: async (ctx, deps) => {
    if (ctx.query.get('confirm') !== null || ctx.query.get('ct') !== null) {
      return htmlPage(
        'Confirm your sign-in',
        '<p>This link only receives the sign-in redirect. Use the form on the sign-in page to' +
          ' enter your code.</p>',
        400,
      );
    }
    return oidcCallbackImpl(deps, (k) => ctx.query.get(k));
  },

  oidcCallbackSubmit: (ctx, deps) => {
    const form = asRecord(ctx.body);
    return oidcCallbackImpl(deps, (k) => {
      const v = form[k];
      return typeof v === 'string' ? v : null;
    });
  },

  refreshAuth: async (ctx, deps) => {
    const body = asRecord(ctx.body);
    // RFC 6749 §6's shape, so a standard OAuth client library can drive it.
    if (body.grant_type !== 'refresh_token') {
      throw new CpError('invalid_request', "grant_type must be 'refresh_token'");
    }
    const token = body.refresh_token;
    if (typeof token !== 'string')
      throw new CpError('invalid_request', 'refresh_token is required');
    // The wrong shape is refused before it is hashed or looked up (B14 Review Focus 3).
    if (!isRefreshTokenShape(token)) throw new CpError('invalid_grant', 'refresh token refused');
    const r = await deps.refresh.rotate(token, deps.now());
    // One code for every refusal: the client's only move is to log in again (errors.ts).
    if (!r.ok) throw new CpError('invalid_grant', `refresh token refused: ${r.reason}`);
    const roles = deps.identity.rolesFor(r.subject);
    // A subject removed from SH_ALLOWED_SUBJECTS loses access at its next refresh, not its next login.
    // rotate() has already stored a successor the client never sees, so the token it still holds is
    // superseded: presented again after the grace window it would read as reuse, revoke the family
    // as theft and audit refresh_reuse_detected. Revoke the family here, under a reason of its own,
    // so that token is a plain `revoked` refusal instead.
    // The revoke is best effort: a store failure here must not turn the answer into a 503, which a
    // client reads as "unreachable" and so keeps the superseded token. The refusal is the 403.
    if (!isEnrolled(r.subject, roles, deps.config)) {
      try {
        await deps.refresh.revoke(r.refreshToken, deps.now(), 'not_enrolled');
      } catch (err) {
        console.error(
          `[control-plane] refreshAuth: revoking a de-enrolled family failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      throw notEnrolled(r.subject, 'no longer');
    }
    return {
      status: 200,
      body: loginBody(deps, { subject: r.subject, displayName: r.displayName, roles }, r),
    };
  },

  revokeAuth: async (ctx, deps) => {
    const token = asRecord(ctx.body).token;
    if (typeof token !== 'string') throw new CpError('invalid_request', 'token is required');
    // RFC 7009 §2.2: 200 whether or not the token named anything, so the answer is no oracle.
    if (isRefreshTokenShape(token)) await deps.refresh.revoke(token, deps.now());
    return { status: 200, body: {} };
  },

  revokeAllAuth: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    return { status: 200, body: { revoked: await deps.refresh.revokeAllFor(p.sub, deps.now()) } };
  },

  getMe: async (ctx) => {
    const p = requirePrincipal(ctx);
    return { status: 200, body: { subject: p.sub, tenant: p.tenant, roles: p.roles ?? [] } };
  },

  listModels: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const requested = ctx.query.get('credential') ?? undefined;
    const descriptors = await deps.credentials.list(p.sub);
    return catalogFor(
      { owner: p.sub, credentialName: newSessionCredential(descriptors, requested, deps) },
      deps,
    );
  },

  createSession: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const body = asRecord(ctx.body);
    const requested = asRecord(body.credentials).inference;
    if (requested !== undefined && typeof requested !== 'string') {
      throw new CpError('invalid_request', 'credentials.inference must be a string');
    }
    let configRef: string | null = null;
    if (body.configRef !== undefined) {
      if (typeof body.configRef !== 'string') {
        throw new CpError('configRef_invalid', 'configRef must be a string');
      }
      try {
        configRef = assertValidDigest(body.configRef);
      } catch {
        throw new CpError('configRef_invalid', 'configRef must be sha256:<64 lowercase hex>');
      }
    }
    // Resolved HERE, at creation, and recorded -- so a missing key fails now rather than three turns
    // in, and a credential added later cannot turn a running session ambiguous (spec §6.4, gap #4).
    // This is also the first of the two policy points that make MU1 fail closed before P5's sentinel
    // exists (spec §3.5): the deployment's own ANTHROPIC_AUTH_TOKEN is not consulted, so a
    // credential-less subject gets a session only through the operator fallback below.
    const descriptors = await deps.credentials.list(p.sub);
    // The operator fallback (spec §6.4) is for a subject with no inference credential of its own: such
    // a session records NO credential name, and the exchange resolves the operator's key per turn,
    // attributably. A session that names a credential never falls back, here or at exchange: a typo
    // must 400, and a credential deleted mid-session ends its turns (exchange.ts).
    const credentialName = newSessionCredential(descriptors, requested, deps);
    const requestedModel = modelParam(body.model);

    // The sandbox tier (P6.3 spec §3.3), resolved and RECORDED here like the credential: a later change
    // to the deployment default must not move an existing session between tiers.
    const sandbox = body.sandbox;
    if (
      sandbox !== undefined &&
      (typeof sandbox !== 'object' || sandbox === null || Array.isArray(sandbox))
    ) {
      throw new CpError('invalid_request', 'sandbox must be an object');
    }
    const requestedTier = asRecord(sandbox).tier;
    if (requestedTier !== undefined && typeof requestedTier !== 'string') {
      throw new CpError('invalid_request', 'sandbox.tier must be a string');
    }
    const tiers = deps.config.sandboxTiers;
    if (requestedTier !== undefined && !tiers) {
      throw new CpError('invalid_request', 'this deployment declares no sandbox tiers');
    }
    if (requestedTier !== undefined && tiers && !tiers.names.includes(requestedTier)) {
      throw new CpError(
        'invalid_request',
        `unknown sandbox tier '${requestedTier}': this deployment declares ${tiers.names.join(', ')}`,
      );
    }
    const sandboxTier = requestedTier ?? tiers?.default ?? '';
    // The sandbox template (session-templates spec §3.3), recorded like the tier. Omitted: none, and
    // the session runs only on untemplated workers (§4).
    const requestedTemplate = asRecord(sandbox).template;
    if (requestedTemplate !== undefined && typeof requestedTemplate !== 'string') {
      throw new CpError('invalid_request', 'sandbox.template must be a string');
    }
    const activateField = asRecord(sandbox).activate;
    if (activateField !== undefined && typeof activateField !== 'boolean') {
      throw new CpError('invalid_request', 'sandbox.activate must be true or false');
    }
    // With a template store, a session's template resolves through the catalog as a sandbox's does
    // (combined control plane spec §3.4): `id`, `id:tag` or `id@sha256:…`, a registered build the
    // caller may see. Its activation on first use (§6.4) comes last, below, once nothing else can
    // refuse the create.
    let resolved: { id: string; buildId: string; build: TemplateBuild } | undefined;
    let forUse: Awaited<ReturnType<typeof resolveForUse>> | undefined;
    if (requestedTemplate !== undefined && deps.templates && deps.provenance) {
      forUse = await resolveForUse(deps, p, requestedTemplate);
      resolved = { id: forUse.id, buildId: forUse.buildId, build: forUse.build };
    }
    const templates = deps.config.sessionTemplates;
    if (requestedTemplate !== undefined && !resolved && !templates) {
      throw new CpError('invalid_request', 'this deployment declares no sandbox templates');
    }
    if (
      requestedTemplate !== undefined &&
      !resolved &&
      templates &&
      !templates.some((t) => t.id === requestedTemplate)
    ) {
      throw new CpError(
        'invalid_request',
        `unknown sandbox template '${requestedTemplate}': this deployment declares ${templates.map((t) => t.id).join(', ')}`,
      );
    }
    const sandboxTemplate = resolved?.id ?? requestedTemplate ?? '';
    // The build the reference resolved to, kept for the session's life; none without a store.
    const sandboxBuildId = resolved?.buildId ?? '';

    if (configRef) {
      let found: boolean;
      try {
        found = (await deps.bundles.exists(bundleKey(configRef))) > 0;
        if (found) await touchBundle(deps.bundles, configRef, deps.now());
      } catch (err) {
        console.error(
          `[control-plane] createSession configRef=${configRef}: ${(err as Error)?.message ?? String(err)}`,
        );
        throw new CpError('redis_unavailable', 'redis is not answering');
      }
      // Fail at creation: a session on a missing bundle would 410 every turn.
      if (!found) {
        throw new CpError(
          'config_bundle_not_found',
          'no config bundle with that digest — promote the directory first',
        );
      }
    }

    // Checked against the catalog of the credential just resolved (per-session model spec §4.2).
    const choice = requestedModel
      ? await chooseFor({ owner: p.sub, credentialName }, requestedModel, deps)
      : undefined;

    // Activation on first use, after every other check, so a create refused for another reason
    // holds no lease. Only a subject enrolled for sandboxes takes one: on `combined` any login may
    // create a session, but activation is enrolled-only, as on the activate route (spec §3.2).
    if (forUse) {
      await requireActive(
        deps,
        p,
        forUse,
        activateField !== false,
        isEnrolledForSandbox(p.sub, p.roles ?? [], deps.config),
      );
    }

    const sessionId = deps.newId();
    const rec: SessionRecord = {
      sessionId,
      owner: p.sub,
      tenant: p.tenant ?? p.sub,
      createdAt: deps.now(),
      state: 'active',
      poolSelector: null, // MU2's tenant-labelled partition fills this (spec §8.2)
      credentialName,
      configRef,
      sandboxTier,
      ...(sandboxTemplate ? { sandboxTemplate } : {}),
      ...(sandboxBuildId ? { sandboxBuildId } : {}),
      tombstone: false,
      model: choice?.model ?? '',
      ...(choice?.limits ? { modelLimits: choice.limits } : {}),
    };
    await deps.index.create(rec);
    const sessionCreatedEntry = {
      subject: p.sub,
      sessionId,
      credential: credentialName || OPERATOR_FALLBACK_NAME,
      decision: 'session_created' as const,
      ...(choice ? { model: choice.model } : {}),
    };
    resolveAuditLog(deps)({ event: 'audit', ...sessionCreatedEntry });
    await deps.index.audit(sessionCreatedEntry);
    const iat = seconds(deps);
    // The session on its build's chain (lifecycle spec §7.1), as a sandbox is: its lease is the
    // caller's live lease on the build, as the digest of the activate record that granted it (null:
    // no lease, e.g. no host agents). Written after the session is stored, so a create that any check
    // refuses, its activation on first use included, writes no `created` record.
    if (resolved && deps.provenance) {
      const live = (resolved.build.leases ?? []).find((l) => l.subject === p.sub && l.until > iat);
      await appendSessionRecord(deps, `template/${resolved.id}`, p.sub, {
        sessionId,
        buildId: resolved.buildId,
        // Null for a build imported from SH_SANDBOX_TEMPLATES, which names no snapshot, as on a
        // sandbox's record: resolveForUse returns only registered builds, imported ones included.
        templateManifestHash: resolved.buildId.startsWith('sha256:') ? resolved.buildId : null,
        lease: live?.record ?? null,
        state: 'created',
      });
    }
    return {
      status: 201,
      body: {
        sessionId,
        token: deps.signer.mint({
          sub: p.sub,
          tenant: rec.tenant,
          roles: p.roles ?? [],
          scope: ['turn:write'],
          ttlSeconds: deps.config.sessionTokenTtlSeconds,
          sid: sessionId,
          now: iat,
        }),
        expiresAt: iat + deps.config.sessionTokenTtlSeconds,
        ...(choice ? { model: choice.model, modelVerified: choice.verified } : {}),
      },
    };
  },

  listSessions: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const requestedOwner = ctx.query.get('owner');
    let owner = p.sub;
    if (requestedOwner !== null && requestedOwner !== p.sub) {
      // 403, not 404: "authenticated but insufficiently privileged on a resource you may know
      // exists" is exactly what 403 is reserved for (spec §8.1).
      if (!isAdmin(p)) {
        throw new CpError('forbidden', '?owner= requires the admin role');
      }
      owner = requestedOwner;
    }
    const page = await deps.index.listByOwner(owner, {
      limit: intQuery(ctx.query, 'limit') ?? DEFAULT_PAGE_SIZE,
      cursor: intQuery(ctx.query, 'cursor'),
    });
    return {
      status: 200,
      body: {
        sessions: await Promise.all(page.sessions.map((rec) => sessionView(rec, deps))),
        nextCursor: page.nextCursor,
      },
    };
  },

  getSession: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    return { status: 200, body: await sessionView(rec, deps) };
  },

  /**
   * Switch the session's model (per-session model spec §4.3). A turn in flight read its model at
   * its exchange and keeps it; the next turn's exchange returns the new one -- so there is no
   * turn-in-progress refusal. `null` returns the session to the deployment default.
   */
  updateSession: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    if (rec.tombstone) throw new CpError('session_not_found', undefined, rec.sessionId);
    const body = asRecord(ctx.body);
    const extra = Object.keys(body).filter((k) => k !== 'model');
    if (extra.length > 0) {
      throw new CpError('invalid_request', `only model can be changed (got ${extra.join(', ')})`);
    }
    if (!('model' in body)) {
      throw new CpError(
        'invalid_request',
        'model is required: a model id, or null for the deployment default',
      );
    }
    const choice: ModelChoice =
      body.model === null
        ? { model: '', verified: true }
        : await chooseFor(rec, modelParam(body.model)!, deps);
    // The catalog can take seconds (R8): a DELETE in that window must not be undone by an HSET
    // that recreates `session:<id>` with only model fields -- a key nothing reads and nothing
    // cleans up -- and an overlapping PATCH must not audit a stale `fromModel`. So re-read here.
    const fresh = await deps.index.get(rec.sessionId);
    if (!fresh || fresh.owner !== rec.owner || fresh.tombstone) {
      throw new CpError('session_not_found', undefined, rec.sessionId);
    }
    await deps.index.setModel(rec.sessionId, choice.model, choice.limits);
    const modelChangedEntry = {
      subject: rec.owner,
      sessionId: rec.sessionId,
      decision: 'model_changed' as const,
      model: choice.model || 'default',
      fromModel: fresh.model || 'default',
    };
    resolveAuditLog(deps)({ event: 'audit', ...modelChangedEntry });
    await deps.index.audit(modelChangedEntry);
    const updated: SessionRecord = { ...fresh, model: choice.model, modelLimits: choice.limits };
    return {
      status: 200,
      body: { ...(await sessionView(updated, deps)), modelVerified: choice.verified },
    };
  },

  mintSessionToken: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    // A tombstoned session must not be handed a fresh capability: the exchange would refuse it
    // anyway, but issuing one invites a client to retry a turn that can never run.
    if (rec.tombstone) throw new CpError('session_not_found', undefined, rec.sessionId);
    const iat = seconds(deps);
    return {
      status: 200,
      body: {
        token: deps.signer.mint({
          sub: rec.owner,
          tenant: rec.tenant,
          roles: ctx.principal!.roles ?? [],
          scope: ['turn:write'],
          ttlSeconds: deps.config.sessionTokenTtlSeconds,
          sid: rec.sessionId,
          now: iat,
        }),
        expiresAt: iat + deps.config.sessionTokenTtlSeconds,
      },
    };
  },

  deleteSession: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const inFlight = await turnInFlight(rec.sessionId, deps);
    await deps.index.cascadeDelete(rec);
    // Reclaim this session's open async turns and their quota slots (F2): nothing else in the
    // design will ever move an orphaned queued/running turn to terminal, so without this a
    // submit-then-delete cycle burns a slot forever. `deps.turns` is absent on the sandbox profile,
    // which mounts no turn routes and so can never have created one.
    await deps.turns?.deleteSessionTurns(rec.sessionId, rec.owner);
    const deletedEntry = {
      subject: rec.owner,
      sessionId: rec.sessionId,
      decision: (inFlight ? 'session_deleted_in_flight' : 'session_deleted') as
        'session_deleted' | 'session_deleted_in_flight',
    };
    resolveAuditLog(deps)({ event: 'audit', ...deletedEntry });
    await deps.index.audit(deletedEntry);
    // Its end on the build's chain (§7.1): a session has a build id only when its template resolved
    // through the store at creation, which wrote its `created` record, so the same gate on both
    // sides gives every `created` its end, an `imported:` build's included.
    if (deps.provenance && rec.sandboxTemplate && rec.sandboxBuildId) {
      await appendSessionRecord(
        deps,
        `template/${rec.sandboxTemplate}`,
        ctx.principal?.sub ?? rec.owner,
        {
          sessionId: rec.sessionId,
          buildId: rec.sandboxBuildId,
          state: 'terminated',
          reason: 'deleted',
          endedAt: seconds(deps),
        },
      );
    }
    // 202 rather than pretending a synchronous delete happened; a sweeper reaps what the in-flight
    // turn writes on its way out (spec §7.3).
    return { status: inFlight ? 202 : 204, body: undefined };
  },

  /**
   * Write-only. There is deliberately no read-back path anywhere in /v1 (spec §4.2): the value goes
   * in and is never returned, so a compromised api token cannot exfiltrate a stored provider key.
   * The subject comes from the TOKEN, never from the path or the body -- the principal is never in a
   * path (spec §4.1), which is what stops the URL and the token being two sources of truth for one
   * fact.
   */
  putCredential: async (ctx, deps) => {
    const sandbox = deps.config.routeProfile === 'sandbox';
    const p = sandbox ? requireEnrolledPrincipal(ctx, deps.config) : requirePrincipal(ctx);
    const name = validateCredentialName(ctx.params.name ?? '');
    if (name === OPERATOR_FALLBACK_NAME) {
      // The audit names the operator's key this way (exchange.ts, createSession): a subject's own
      // credential under the same name would make the two indistinguishable in the audit.
      throw new CpError('invalid_request', `credential name '${name}' is reserved`);
    }
    const cred = parseCredentialBody(name, ctx.body);
    if (sandbox && cred.descriptor.consumer !== 'sandbox-egress') {
      throw new CpError(
        'invalid_request',
        'the sandbox service stores only consumer: sandbox-egress credentials',
      );
    }
    // Two egress credentials of one subject never hold one destination: keyed on the consumer, so
    // it holds on `combined` (whose credential routes keep the harness behaviour) as on `sandbox`.
    const servesSandboxes = sandbox || deps.config.routeProfile === 'combined';
    if (servesSandboxes && cred.descriptor.consumer === 'sandbox-egress') {
      const mine = new Set(cred.descriptor.destination.hosts);
      for (const other of await deps.credentials.list(p.sub)) {
        if (other.consumer !== 'sandbox-egress' || other.name === name) continue;
        const hit = other.destination.hosts.find((h) => mine.has(normalizeStored(h)));
        if (hit !== undefined) {
          throw new CpError(
            'destination_conflict',
            `destination '${hit}' is already held by credential '${other.name}'`,
          );
        }
      }
    }
    await deps.credentials.put(p.sub, cred);
    await auditBestEffort(deps, 'putCredential', `credential=${name}`, {
      subject: p.sub,
      credential: name,
      decision: 'credential_written',
    });
    return { status: 204, body: undefined };
  },

  /** Metadata only, and it decrypts nothing: the descriptor lives in annotations (spec §6.2). */
  listCredentials: async (ctx, deps) => {
    const sandbox = deps.config.routeProfile === 'sandbox';
    const p = sandbox ? requireEnrolledPrincipal(ctx, deps.config) : requirePrincipal(ctx);
    // No ?owner= is read here. Listing another user's credential NAMES is not a privilege MU1
    // grants, and not reading the parameter is what stops it becoming one by accident.
    const all = await deps.credentials.list(p.sub);
    const descriptors = sandbox ? all.filter((d) => d.consumer === 'sandbox-egress') : all;
    return {
      status: 200,
      body: {
        credentials: descriptors.map((d) => ({
          name: d.name,
          kind: d.kind,
          consumer: d.consumer,
          destination: d.destination,
          binding: d.binding,
          endpoint: d.endpoint,
        })),
      },
    };
  },

  deleteCredential: async (ctx, deps) => {
    const p =
      deps.config.routeProfile === 'sandbox'
        ? requireEnrolledPrincipal(ctx, deps.config)
        : requirePrincipal(ctx);
    const name = validateCredentialName(ctx.params.name ?? '');
    await deps.credentials.delete(p.sub, name);
    await auditBestEffort(deps, 'deleteCredential', `credential=${name}`, {
      subject: p.sub,
      credential: name,
      decision: 'credential_deleted',
    });
    // 204 whether or not it existed: a 404 here would be an existence oracle over credential names.
    return { status: 204, body: undefined };
  },

  putConfigBundle: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const seen: { configRef?: string; bytes?: number } = {};
    try {
      return await storeConfigBundle(p, asRecord(ctx.body), deps, seen);
    } catch (err) {
      if (err instanceof CpError && err.code !== 'redis_unavailable') {
        await auditBestEffort(deps, 'putConfigBundle', `refused=${err.code}`, {
          subject: p.sub,
          ...seen,
          decision: 'config_bundle_refused',
          reason: err.code,
        });
      }
      throw err;
    }
  },

  /**
   * The caller's own live bundles, newest first (rossoctl/moca#559). Without it a digest lost between
   * `promote` returning and whatever wrote it down was an orphan holding budget for its whole TTL,
   * findable only by an admin's keyspace scan.
   *
   * No `withBundleLock`: this writes nothing, and a listing that races a concurrent upload may simply
   * miss or include that one digest. Taking the lock would queue every listing behind every upload.
   */
  listConfigBundles: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    try {
      return {
        status: 200,
        body: { bundles: await listBundlesByOwner(deps.bundles, p.sub, deps.now()) },
      };
    } catch (err) {
      console.error(`[control-plane] listConfigBundles: ${(err as Error)?.message ?? String(err)}`);
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  },

  /**
   * Frees budget: the subject the digest is charged to, or an admin, may delete it. Sessions still
   * naming it get 410 on their next turn, as for an expired bundle. A 403 for someone else's digest
   * reveals nothing an upload does not: re-uploading any digest already says whether it is stored.
   */
  deleteConfigBundle: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const digest = ctx.params.digest ?? '';
    try {
      assertValidDigest(digest);
    } catch {
      throw new CpError('invalid_request', 'digest must be sha256:<64 lowercase hex>');
    }
    const key = bundleKey(digest);
    try {
      await withBundleLock(async () => {
        const stored = (await deps.bundles.exists(key)) > 0;
        const owner = await bundleOwnerHash(deps.bundles, digest);
        if (!stored && owner === null) {
          throw new CpError('config_bundle_not_found', 'no config bundle with that digest');
        }
        // A bundle with no budget entry was stored by /promote straight into Redis: nobody's to delete.
        if (!isAdmin(p) && owner !== subjectHash(p.sub)) {
          throw new CpError(
            'forbidden',
            'only the subject that uploaded this bundle, or an admin, may delete it',
          );
        }
        await deps.bundles.del(key);
        await dropBundleEntry(deps.bundles, digest);
      });
    } catch (err) {
      if (err instanceof CpError) throw err;
      console.error(
        `[control-plane] deleteConfigBundle configRef=${digest}: ${(err as Error)?.message ?? String(err)}`,
      );
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
    await auditBestEffort(deps, 'deleteConfigBundle', `configRef=${digest}`, {
      subject: p.sub,
      configRef: digest,
      decision: 'config_bundle_deleted',
    });
    return { status: 204, body: undefined };
  },

  getSessionResources: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const runtime = await deps.index.getRuntime(rec.sessionId);
    const sandbox = await resolveSandbox(
      runtime,
      deps.config.sandboxNamespace,
      deps.runKubectl,
      rec.tenant,
    );
    return { status: 200, body: projectResources(rec, runtime, sandbox, deps.config.sandboxTiers) };
  },

  listSessionModels: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    if (rec.tombstone) throw new CpError('session_not_found', undefined, rec.sessionId);
    return catalogFor(rec, deps);
  },

  exchangeCredential: async (ctx, deps) => {
    // The router performs the shared-bearer check (it is the only layer that sees headers) and marks
    // the request. A handler reached without that mark is a routing bug, and 401 is the safe answer.
    if (!ctx.exchangeAuthorized) {
      throw new CpError('unauthorized', 'exchange authentication failed');
    }
    const token = asRecord(ctx.body).token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new CpError('invalid_request', 'token is required');
    }
    return { status: 200, body: await exchangeCredential(token, deps) };
  },

  exchangeTurnCredential: async (ctx, deps) => {
    // The router performs the shared-bearer check (it is the only layer that sees headers) and marks
    // the request. A handler reached without that mark is a routing bug, and 401 is the safe answer.
    if (!ctx.exchangeAuthorized) {
      throw new CpError('unauthorized', 'exchange authentication failed');
    }
    const turnId = asRecord(ctx.body).turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new CpError('invalid_request', 'turnId is required');
    }
    // Refused BEFORE Redis, so caller input cannot pick the key shape this route reads. `submitTurn`
    // is the only minter and its ids are always `t-<uuid>`, so a well-formed id that has no record
    // still answers 404 `turn_not_found` -- the shape check only removes ids no submission could
    // have produced. 400 rather than 404 deliberately, for the reason openapi.yaml's 404 description
    // gives: nothing this route refuses tells its caller anything a success would not.
    if (!isMintedTurnId(turnId)) {
      throw new CpError('invalid_request', 'turnId is not a turn id this control plane minted');
    }
    // `turnId` ALONE. No deliveryCount, no caps, no envelope: everything else comes from the record
    // the control plane wrote at the authenticated enqueue, which is what makes a queue entry
    // carrying one id sufficient (§5.1) and a queue entry carrying a credential unnecessary (§6.5).
    return { status: 200, body: await exchangeTurnCredential(turnId, deps) };
  },

  issueTurnGrants: async (ctx, deps) => {
    // Same shape as the two exchanges above: the router is the only layer that sees headers, so a
    // handler reached without its mark is a routing bug and 401 is the safe answer.
    if (!ctx.exchangeAuthorized) {
      throw new CpError('unauthorized', 'exchange authentication failed');
    }
    const token = asRecord(ctx.body).token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new CpError('invalid_request', 'token is required');
    }
    return { status: 200, body: await issueTurnGrants(token, deps) };
  },

  refreshTurnGrants: async (ctx, deps) => {
    if (!ctx.exchangeAuthorized) {
      throw new CpError('unauthorized', 'exchange authentication failed');
    }
    // `grant`, not `token`: the two fields carry different credentials to different verifiers, and a
    // worker that sent a session token here would otherwise get a confusing grant_invalid instead of
    // being told it used the wrong field.
    const grant = asRecord(ctx.body).grant;
    if (typeof grant !== 'string' || grant.length === 0) {
      throw new CpError('invalid_request', 'grant is required');
    }
    return { status: 200, body: await refreshTurnGrants(grant, deps) };
  },

  /**
   * Readiness is "can I serve session routes", i.e. is Redis answering. Credentials live in
   * Kubernetes Secrets, so they stay up while Redis is down (spec §7.1, §9.2) -- which is why this
   * probe checks only the index. A client that is not ready fails at once: awaiting the index then
   * would park the probe in the offline queue until Redis came back, a timeout rather than a 503.
   */
  readyz: async (_ctx, deps) => {
    if (deps.redisReady?.() === false) {
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
    // Ready is not the same as answering: a client node-redis reports ready can sit on a GET that
    // never returns (a wedged server, a half-open socket), so the probe is bounded too (#434).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('readyz probe timed out')),
        deps.readyzTimeoutMs ?? 500,
      );
    });
    try {
      await Promise.race([deps.index.get('__readyz__'), timeout]);
    } catch {
      throw new CpError('redis_unavailable', 'redis is not answering');
    } finally {
      clearTimeout(timer);
    }
    return { status: 200, body: 'ok' };
  },

  // SBX0 §5.1: the sandbox resource (sandbox-handlers.ts), mounted on the sandbox profile only.
  ...SANDBOX_HANDLERS,
  ...HOST_HANDLERS,
  ...EGRESS_HANDLERS,
  ...TURN_HANDLERS,
};
