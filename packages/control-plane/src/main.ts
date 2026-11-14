import { ProvenanceStore } from './provenance.js';
import { FilePolicyStore } from './template-policy-store.js';
import { HostRegistry } from './host-handlers.js';
import { templateHostsFromEnv } from './host-config.js';
import type { PolicyStore } from './template-policy.js';
import {
  FileTemplateCatalog,
  redisPresenceReader,
  type PresenceRedisLike,
  type TemplateCatalog,
} from './template-catalog.js';
import { createClient } from 'redis';
import type { BundleRedisLike } from '@moca/config-bundle';
import { fileURLToPath } from 'node:url';
import type { KeyObject } from 'node:crypto';
import { defaultAuditLog } from './audit-log.js';
import { defaultNewId } from './handler-util.js';
import type { BundleBudgetRedisLike } from './bundle-budget.js';
import { keksFromBase64 } from './envelope.js';
import {
  UnavailableCredentialStore,
  type CredentialStore,
  type InferenceAuthHeader,
} from './credential-store.js';
import { directModeMismatch } from './exchange.js';
import { FileCredentialStore } from './file-store.js';
import {
  adminSubjectsFromEnv,
  GithubOAuthProvider,
  TestUserProvider,
  testUsersFromEnv,
  testUserSecretFromEnv,
  type IdentityProvider,
} from './identity.js';
import { OidcProvider } from './oidc.js';
import { K8sSecretStore } from './k8s-secret-store.js';
import { defaultRunKubectl } from './kubectl.js';
import { OwnershipIndex, type CpRedisLike } from './ownership.js';
import { RedisRefreshStore, type RefreshRedisLike } from './refresh-redis.js';
import { startControlPlane } from './server.js';
import type { CpConfig, CpDeps } from './handlers.js';
import { keyIdFor, makeSigner, parseKeyset, publicKeyFromBase64 } from './token.js';
import { resolveVersion } from './version.js';
import { VaultCredentialStore, vaultTokenSource } from './vault-store.js';
import { withCredentials } from './systemd-credentials.js';
import { parseSandboxTiers } from './sandbox-tiers.js';
import {
  routeProfileFromEnv,
  sandboxConfigFromEnv,
  sessionTemplatesFromEnv,
} from './sandbox-config.js';
import { RedisSandboxStore, type SandboxRedisLike } from './sandbox-redis.js';
import { RedisEgressStore, type EgressRedisLike } from './egress-log.js';
import { readTenancy } from './tenancy.js';
import { TurnStore } from './turn-store.js';
import { resultTtlSeconds, TURN_RECORD_TTL_MARGIN_SECONDS } from './turn-record.js';
import { RedisTurnQueue } from './turn-queue.js';
import type { ResultRedisLike } from './turn-result.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) {
    // Fail at STARTUP. A control plane that booted without a KEK would accept credential writes it
    // cannot encrypt; one without an exchange token would 401 every turn from a healthy-looking pod.
    throw new Error(`${name} is required`);
  }
  return v;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * An optional absolute http(s) URL, trailing slashes dropped. A malformed value fails STARTUP: a
 * control plane advertising a harness URL no client can use would fail every user's first turn.
 */
function urlEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  if (!v) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, got "${v}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`${name} must be an absolute http(s) URL, got "${v}"`);
  let end = v.length;
  // A loop, not /\/+$/: that regex is quadratic on a long run of slashes (CodeQL js/polynomial-redos).
  while (end > 0 && v.charCodeAt(end - 1) === 0x2f) end--;
  return v.slice(0, end);
}

/** A byte budget: unset means the default, anything but a positive integer refuses to boot. */
function byteBudgetEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^[1-9][0-9]*$/.test(v))
    throw new Error(`${name} must be a positive integer (bytes), got "${v}"`);
  return Number(v);
}

/**
 * A non-negative integer count. Unset means the default; anything else refuses to boot. Distinct
 * from intEnv because ZERO is meaningful for the async quota -- an operator who writes 0 means "no
 * async turns on this deployment", and silently serving 50 instead would be the opposite of the ask.
 */
function countEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^(0|[1-9][0-9]*)$/.test(v))
    throw new Error(`${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
}

function turnRecordTtlFromEnv(env: NodeJS.ProcessEnv): number {
  // `resultTtlSeconds` is the one parse of this variable, shared with the worker that writes the
  // same results (`server.ts:52`): one deployment, one meaning.
  return resultTtlSeconds(env) + TURN_RECORD_TTL_MARGIN_SECONDS;
}

/**
 * `SH_IDENTITY_PROVIDER`: `github` (the default, unchanged behavior) or `oidc`. A near-miss
 * refuses to boot, as routeProfileFromEnv refuses one, rather than silently serving GitHub.
 * The oidc client secret arrives through withCredentials (CONTROL_PLANE_SECRETS), so it is a
 * systemd credential or a K8s secret, never a committed value.
 */
function identityProviderFromEnv(env: NodeJS.ProcessEnv): IdentityProvider {
  const adminSubjects = adminSubjectsFromEnv(env.SH_ADMIN_SUBJECTS);
  const kind = env.SH_IDENTITY_PROVIDER || 'github';
  if (kind === 'github') {
    return new GithubOAuthProvider({
      clientId: required(env, 'SH_GITHUB_CLIENT_ID'),
      adminSubjects,
    });
  }
  if (kind !== 'oidc') {
    throw new Error(`SH_IDENTITY_PROVIDER must be exactly 'github' or 'oidc'`);
  }
  const redirectUri = urlEnv(env, 'SH_OIDC_REDIRECT_URI');
  if (!redirectUri) throw new Error('SH_OIDC_REDIRECT_URI is required for the oidc provider');
  return new OidcProvider({
    issuer: required(env, 'SH_OIDC_ISSUER'),
    clientId: required(env, 'SH_OIDC_CLIENT_ID'),
    clientSecret: required(env, 'SH_OIDC_CLIENT_SECRET'),
    // The callback route's public URL, as registered with the provider; a mismatch is the one
    // misconfiguration every OIDC deployment hits first, so it is caught at boot, not mid-login.
    redirectUri,
    adminSubjects,
    ...(env.SH_OIDC_SCOPE ? { scope: env.SH_OIDC_SCOPE } : {}),
  });
}

/**
 * `SH_MODEL_CATALOG_HOSTS`: the hosts the model catalog may contact besides api.anthropic.com and
 * SH_DEFAULT_INFERENCE_ENDPOINT's (per-session model spec §4.1). Comma-separated, case-insensitive,
 * exact hostnames: a URL, a port or a path is refused at BOOT rather than silently never matching.
 */
function catalogHostsEnv(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const raw of (env.SH_MODEL_CATALOG_HOSTS ?? '').split(',')) {
    const h = raw.trim().toLowerCase();
    if (h === '') continue;
    if (URL.parse(`http://${h}`)?.hostname !== h || h.includes('@')) {
      throw new Error(
        `SH_MODEL_CATALOG_HOSTS entries must be bare hostnames (no scheme, port or path), got "${h}"`,
      );
    }
    out.push(h);
  }
  return out;
}

export function portFromEnv(env: NodeJS.ProcessEnv): number {
  return intEnv(env, 'SH_CONTROL_PLANE_PORT', 8080);
}

/**
 * `SH_CONTROL_PLANE_HOST`: the address to bind. Unset listens on every interface, as every existing
 * deployment does (a Kubernetes pod IP, a compose container). deploy/vm ships 127.0.0.1: the control
 * plane speaks plain HTTP, so on a VM it is reached through an SSH tunnel, not a public interface.
 */
export function hostFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.SH_CONTROL_PLANE_HOST || undefined;
}

/**
 * The settings that are secrets. On deploy/vm each arrives as a systemd credential
 * (`LoadCredential=`, MI1 §6.7) rather than an env line; everywhere else, as today, from the env.
 */
// prettier-ignore
export const CONTROL_PLANE_SECRETS = ['SH_SESSION_TOKEN_PRIVATE_KEY', 'SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN', 'SH_OPERATOR_INFERENCE_TOKEN', 'SH_JANITOR_TOKEN', 'SH_TEST_USER_SECRET', 'SH_OIDC_CLIENT_SECRET', 'MOCA_GRANT_SIGNING_KEY'] as const;

/** The API, session and refresh token lifetimes, shared by both route profiles. */
function tokenTtlsFromEnv(
  env: NodeJS.ProcessEnv,
): Pick<
  CpConfig,
  | 'apiTokenTtlSeconds'
  | 'sessionTokenTtlSeconds'
  | 'refreshIdleTtlSeconds'
  | 'refreshMaxTtlSeconds'
  | 'refreshReuseGraceSeconds'
> {
  return {
    // 15 minutes: API tokens stay stateless, so their lifetime IS the revocation latency (B14 §2).
    apiTokenTtlSeconds: intEnv(env, 'SH_API_TOKEN_TTL_SECONDS', 900),
    // A session outlives a 5-minute token; POST /v1/sessions/{id}/token re-mints (spec §4.2).
    sessionTokenTtlSeconds: intEnv(env, 'SH_SESSION_TOKEN_TTL_SECONDS', 300),
    refreshIdleTtlSeconds: intEnv(env, 'SH_REFRESH_IDLE_TTL_SECONDS', 30 * 86_400),
    refreshMaxTtlSeconds: intEnv(env, 'SH_REFRESH_MAX_TTL_SECONDS', 90 * 86_400),
    refreshReuseGraceSeconds: intEnv(env, 'SH_REFRESH_REUSE_GRACE_SECONDS', 30),
  };
}

/**
 * MI1 §15's two grant lifetimes. Read on BOTH profiles -- the grant routes are harness-only, but
 * `CpConfig` is one type and a profile-specific default here would be a second place to keep the
 * numbers. Spread like `tokenTtlsFromEnv`, for the same reason.
 */
function grantTtlsFromEnv(env: NodeJS.ProcessEnv): Pick<CpConfig, 'grantTtlS' | 'turnMaxS'> {
  return {
    // 5 minutes. With no revocation list (§6.2 builds none deliberately), this IS the revocation
    // latency and the replay window of a stolen grant; the worker refreshes at half-life.
    grantTtlS: intEnv(env, 'MOCA_GRANT_TTL_S', 300),
    // 30 minutes, the deployment-wide ceiling on one turn. A turn's caps may ask for less; a caller
    // asking for more is clamped at mint rather than refused (async spec §5.4).
    turnMaxS: intEnv(env, 'MOCA_TURN_MAX_S', 1800),
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv): CpConfig {
  required(env, 'SH_SESSION_TOKEN_PRIVATE_KEY');
  // The github client id belongs to the github provider only; an oidc deployment has
  // SH_OIDC_CLIENT_ID instead, and identityProviderFromEnv enforces that one (main.ts).
  if ((env.SH_IDENTITY_PROVIDER || 'github') === 'github') {
    required(env, 'SH_GITHUB_CLIENT_ID');
  }
  const profile = routeProfileFromEnv(env);
  if (profile === 'sandbox') return sandboxProfileConfig(env);
  keksFromBase64(required(env, 'SH_CREDENTIAL_KEK'));
  const config: CpConfig = {
    ...tokenTtlsFromEnv(env),
    templateHosts: templateHostsFromEnv(env, [env.SH_EXCHANGE_TOKEN ?? ''].filter(Boolean)),
    ...grantTtlsFromEnv(env),
    exchangeToken: required(env, 'SH_EXCHANGE_TOKEN'),
    defaultInferenceEndpoint: env.SH_DEFAULT_INFERENCE_ENDPOINT || undefined,
    modelCatalogHosts: catalogHostsEnv(env),
    operatorInferenceToken: env.SH_OPERATOR_INFERENCE_TOKEN || undefined,
    operatorInferenceHeader: operatorHeaderFromEnv(env),
    // Exactly 'true'. A typo must not silently switch on a fallback that lets one subject spend the
    // operator's key (spec §6.4 defaults it off).
    allowOperatorFallback: env.SH_ALLOW_OPERATOR_FALLBACK === 'true',
    injectorConfigured: env.SH_INJECTOR_CONFIGURED === 'true',
    sandboxNamespace: env.SH_SANDBOX_NAMESPACE || 'default',
    publicHarnessUrl: urlEnv(env, 'SH_PUBLIC_HARNESS_URL'),
    sandboxTiers: parseSandboxTiers(env),
    sessionTemplates: sessionTemplatesFromEnv(env),
    // A quarter of the total: four subjects, not two, to fill it, and still room for one
    // incompressible max-size bundle (~10.7 MiB stored).
    bundleSubjectBytes: byteBudgetEnv(env, 'SH_BUNDLE_SUBJECT_BYTES', 16 * 1024 * 1024),
    bundleTotalBytes: byteBudgetEnv(env, 'SH_BUNDLE_TOTAL_BYTES', 64 * 1024 * 1024),
    version: resolveVersion(env),
    testUsers: testUsersFromEnv(env.SH_TEST_USERS),
    // Async fan-out: the only containment against unbounded fan-out in M1 (spec §4.3). Counts
    // NON-TERMINAL turns per owner, enforced before the enqueue.
    asyncQueuedPerOwner: countEnv(env, 'MOCA_ASYNC_QUEUED_PER_OWNER', 50),
    // The control plane reads MOCA_TENANCY for the first time here. readTenancy throws on a
    // near-miss NAME, so a control-plane env with a misspelled switch now fails to boot -- the same
    // contract the worker has had, and the point of the check.
    tenancy: readTenancy(env),
    turnRecordTtlSeconds: turnRecordTtlFromEnv(env),
  };
  // Validated at startup even though only the provider uses it: a deployment with
  // SH_TEST_USERS set and no secret must fail to boot, not serve an unguarded login path.
  testUserSecretFromEnv(env.SH_TEST_USER_SECRET, config.testUsers);
  checkInferenceConfig(config);
  checkRefreshConfig(config);
  return profile === 'combined' ? combinedProfileConfig(env, config) : config;
}

/**
 * Combined control plane spec §3.5: everything the harness profile requires (above) AND the sandbox
 * profile's own settings, each refusal naming what is missing. Test users may stay (they log in and
 * use sessions; the sandbox routes refuse them, §3.2). The template list is the one list both read.
 */
function combinedProfileConfig(env: NodeJS.ProcessEnv, harness: CpConfig): CpConfig {
  const sandbox = sandboxConfigFromEnv(env, { kekIsShared: true });
  return {
    ...harness,
    routeProfile: 'combined',
    sandbox,
    sessionTemplates: sandbox.templates,
    // Distinct from the exchange token, the janitor's and every egress host's bearer.
    templateHosts: templateHostsFromEnv(env, [
      ...(harness.exchangeToken ? [harness.exchangeToken] : []),
      ...(sandbox.janitorToken ? [sandbox.janitorToken] : []),
      ...(sandbox.egress?.hosts.map((h) => h.token) ?? []),
    ]),
  };
}

/**
 * ADR-0045: the test-user provider, as a spreadable fragment so `testUsers` is ABSENT (not
 * undefined) on a deployment that did not ask for it. Logs one line when enabled: an operator must
 * never have to wonder whether a cluster has password-gated test logins on.
 */
function testUserProvider(
  env: NodeJS.ProcessEnv,
  config: CpConfig,
): { testUsers?: TestUserProvider } {
  if (config.testUsers <= 0) return {};
  const provider = new TestUserProvider({
    count: config.testUsers,
    secret: testUserSecretFromEnv(env.SH_TEST_USER_SECRET, config.testUsers),
    adminSubjects: adminSubjectsFromEnv(env.SH_ADMIN_SUBJECTS),
  });
  console.warn(
    `[control-plane] SH_TEST_USERS=${config.testUsers}: test:1..test:${config.testUsers} ` +
      'can log in with SH_TEST_USER_SECRET (dev/test only, ADR-0045)',
  );
  return { testUsers: provider };
}

/**
 * SBX0 §4.1: the sandbox profile needs no credential store, KEK, exchange token or inference
 * settings, so none is required; the harness-only fields take inert values that no mounted route reads.
 */
function sandboxProfileConfig(env: NodeJS.ProcessEnv): CpConfig {
  // ADR-0045: the sandbox profile admits only ENROLLED subjects (SBX0 §4.2, SH_ALLOWED_SUBJECTS,
  // whose entries match SUBJECT_RE -- github: or oidc:). A synthetic `test:N` subject can never be
  // enrolled there, so rather than serve a route that always refuses, refuse to boot and say which
  // two settings conflict.
  if (testUsersFromEnv(env.SH_TEST_USERS) > 0) {
    throw new Error(
      'SH_TEST_USERS cannot be used on the sandbox profile: it admits only enrolled ' +
        'github:/oidc: subjects (SH_ALLOWED_SUBJECTS)',
    );
  }
  const sandbox = sandboxConfigFromEnv(env);
  const config: CpConfig = {
    routeProfile: 'sandbox',
    sandbox,
    // Distinct from the janitor's and every egress host's bearer (host-config.ts).
    templateHosts: templateHostsFromEnv(env, [
      ...(sandbox.janitorToken ? [sandbox.janitorToken] : []),
      ...(sandbox.egress?.hosts.map((h) => h.token) ?? []),
    ]),
    ...tokenTtlsFromEnv(env),
    ...grantTtlsFromEnv(env),
    allowOperatorFallback: false,
    injectorConfigured: false,
    sandboxNamespace: 'default',
    sandboxTiers: null,
    bundleSubjectBytes: 0,
    bundleTotalBytes: 0,
    version: resolveVersion(env),
    testUsers: 0,
    asyncQueuedPerOwner: 0,
    tenancy: 'single',
    turnRecordTtlSeconds: turnRecordTtlFromEnv(env),
  };
  checkRefreshConfig(config);
  return config;
}

/** `SH_OPERATOR_INFERENCE_HEADER`: exactly one of the two inference headers; unset means Bearer. */
function operatorHeaderFromEnv(env: NodeJS.ProcessEnv): InferenceAuthHeader {
  const v = env.SH_OPERATOR_INFERENCE_HEADER || 'authorization';
  if (v !== 'authorization' && v !== 'x-api-key') {
    // Exact, lower-case: a near-miss must fail startup, not send the operator's key in a header
    // nothing upstream reads.
    throw new Error(
      `SH_OPERATOR_INFERENCE_HEADER must be 'authorization' or 'x-api-key', got "${v}"`,
    );
  }
  return v;
}

/** Refuse at BOOT refresh limits that contradict each other (B14 spec §4.6). Names, never values. */
export function checkRefreshConfig(c: CpConfig): void {
  if (c.refreshMaxTtlSeconds < c.refreshIdleTtlSeconds) {
    throw new Error('SH_REFRESH_MAX_TTL_SECONDS must be at least SH_REFRESH_IDLE_TTL_SECONDS');
  }
  if (c.refreshReuseGraceSeconds > 300) {
    throw new Error('SH_REFRESH_REUSE_GRACE_SECONDS must be at most 300');
  }
}

/**
 * Refuse at BOOT the inference settings that cannot work (#368). The operator fallback's token,
 * header and endpoint are all deployment settings, so a mismatch is knowable before any turn -- and
 * refused here it reaches the operator, not a user as "control plane returned 503". Messages name
 * settings and key prefixes, never values.
 */
export function checkInferenceConfig(c: CpConfig): void {
  const dflt = c.defaultInferenceEndpoint;
  if (dflt) {
    const url = URL.parse(dflt);
    if (!url) {
      throw new Error(
        'SH_DEFAULT_INFERENCE_ENDPOINT is not a URL (want an origin, e.g. https://gateway.example)',
      );
    }
    // The Anthropic client appends /v1/messages itself; `.../v1` becomes /v1/v1/messages (a 404).
    if (url.hostname === 'api.anthropic.com' && (url.pathname !== '/' || url.search !== '')) {
      throw new Error(
        'SH_DEFAULT_INFERENCE_ENDPOINT for api.anthropic.com is the bare origin ' +
          'https://api.anthropic.com (no /v1): the client adds /v1/messages itself',
      );
    }
  }
  if (!c.allowOperatorFallback) return;
  const token = c.operatorInferenceToken;
  if (!token) {
    throw new Error(
      'SH_ALLOW_OPERATOR_FALLBACK=true needs SH_OPERATOR_INFERENCE_TOKEN (on deploy/vm, the file ' +
        '/etc/serverless-harness/credentials/operator-inference-token, then re-run setup-vm.sh)',
    );
  }
  if (!dflt) {
    throw new Error(
      'SH_ALLOW_OPERATOR_FALLBACK=true needs SH_DEFAULT_INFERENCE_ENDPOINT: the operator token has ' +
        'no endpoint of its own',
    );
  }
  // A caller's OWN sk-ant-oat credential is a working shape (#595), but the operator fallback is
  // shared by every caller, and spending one person's Claude Pro/Max subscription on all of them
  // is account sharing on a personal plan (PR #658 review). Refused in every mode, including
  // placeholder, because this is policy rather than a wire-shape check.
  if (token.startsWith('sk-ant-oat')) {
    throw new Error(
      'SH_OPERATOR_INFERENCE_TOKEN is an Anthropic OAuth token (sk-ant-oat…), which cannot be the ' +
        'shared operator fallback: one subscription must not serve every caller. Use a gateway ' +
        'token or an Anthropic API key (sk-ant-api…); callers may store their own OAuth token as ' +
        'an inference credential',
    );
  }
  // Placeholder mode: the injector, not the harness, picks the upstream header (exchange.ts).
  if (c.injectorConfigured) return;
  const mismatch = directModeMismatch(c.operatorInferenceHeader ?? 'authorization', token, dflt);
  if (mismatch === 'bearer-to-anthropic') {
    throw new Error(
      'SH_OPERATOR_INFERENCE_TOKEN would go as Bearer to api.anthropic.com, which reads API keys ' +
        'from x-api-key: set SH_OPERATOR_INFERENCE_HEADER=x-api-key for an Anthropic API key, or ' +
        'point SH_DEFAULT_INFERENCE_ENDPOINT at a gateway',
    );
  }
  if (mismatch === 'raw-key-elsewhere') {
    throw new Error(
      'SH_OPERATOR_INFERENCE_TOKEN is an Anthropic API key (sk-ant-api…), but ' +
        'SH_DEFAULT_INFERENCE_ENDPOINT is not https://api.anthropic.com: set it to ' +
        'https://api.anthropic.com with SH_OPERATOR_INFERENCE_HEADER=x-api-key, or use a gateway token',
    );
  }
  if (mismatch === 'oauth-token-elsewhere') {
    throw new Error(
      'SH_OPERATOR_INFERENCE_TOKEN is an Anthropic OAuth token (sk-ant-oat…), but ' +
        'SH_DEFAULT_INFERENCE_ENDPOINT is not https://api.anthropic.com, which is the only host ' +
        'that reads it: point SH_DEFAULT_INFERENCE_ENDPOINT at https://api.anthropic.com, or use ' +
        'a gateway token',
    );
  }
}

/** The signer's own public key, plus any extra published ones so a rotation window verifies both. */
export function verifyKeysFromEnv(
  env: NodeJS.ProcessEnv,
  signerPublicKeyBase64: string,
): Map<string, KeyObject> {
  const keys = parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
  const own = publicKeyFromBase64(signerPublicKeyBase64);
  keys.set(keyIdFor(own), own);
  return keys;
}

/**
 * The GRANT ring (MI1 §6.1), built only when `MOCA_GRANT_SIGNING_KEY` is set. A SEPARATE key from
 * the session signer, which is the §6.1 property that a session token can never pass as a grant even
 * where an `aud` check is forgotten -- sharing one key would leave `typ` as the only thing between
 * them.
 *
 * Undefined when no key is configured, and that absence is load-bearing: it is what unmounts both
 * grant routes (`server.ts`'s `grants` gate), so an existing deployment boots and behaves exactly as
 * before. Nothing redeems a grant yet, so there is nothing for it to turn on.
 *
 * The signer's label is its own variable name, so a bad key is a boot error naming
 * `MOCA_GRANT_SIGNING_KEY` rather than sending an operator to edit the session key that is fine.
 *
 * `sessionVerifyKeys` is taken so SEPARATENESS is enforced here rather than left to operator
 * discipline: a kid in both rings means one key signs both tokens, and the §6.1 property this whole
 * slice leans on is gone with only `typ` left between a session token and a grant. A kid is a sha256
 * of the SPKI (`keyIdFor`), so equal kid is equal key -- no false positive is possible. The session
 * map already holds the session signer's own key, so this one check covers both ways an operator
 * gets there: reusing `SH_SESSION_TOKEN_PRIVATE_KEY` as the grant key, and listing a session public
 * key in `MOCA_GRANT_PUBLIC_KEYS`. Refusing to boot is right for the reason `makeSigner` refuses a
 * public key: a deployment cannot discover this at runtime -- every token verifies.
 */
export function grantRingFromEnv(
  env: NodeJS.ProcessEnv,
  sessionVerifyKeys: Map<string, KeyObject>,
):
  | {
      grantSigner: ReturnType<typeof makeSigner>;
      grantVerifyKeys: Map<string, KeyObject>;
    }
  | undefined {
  const raw = env.MOCA_GRANT_SIGNING_KEY;
  if (!raw) return undefined;
  const grantSigner = makeSigner(raw, 'MOCA_GRANT_SIGNING_KEY');
  const grantVerifyKeys = parseKeyset(env.MOCA_GRANT_PUBLIC_KEYS, 'MOCA_GRANT_PUBLIC_KEYS');
  const own = publicKeyFromBase64(grantSigner.publicKeyBase64);
  grantVerifyKeys.set(keyIdFor(own), own);
  const shared = [...grantVerifyKeys.keys()].filter((kid) => sessionVerifyKeys.has(kid));
  if (shared.length > 0) {
    throw new Error(
      `the grant key ring shares key ${shared.join(', ')} with the session token ring, which ` +
        'would let a session token be signed by a grant key (MI1 §6.1 requires separate rings): ' +
        'generate a new keypair for MOCA_GRANT_SIGNING_KEY, and keep MOCA_GRANT_PUBLIC_KEYS and ' +
        'SH_SESSION_TOKEN_PUBLIC_KEYS disjoint',
    );
  }
  return { grantSigner, grantVerifyKeys };
}

export const CREDENTIAL_STORES = ['kubernetes', 'file', 'vault'] as const;
export type CredentialStoreKind = (typeof CREDENTIAL_STORES)[number];

/**
 * `SH_CREDENTIAL_STORE`: where credentials live, behind the one CredentialStore interface (spec §6.6).
 *
 *   kubernetes (default) -- per-user Secrets via kubectl (k8s-secret-store.ts). Unchanged, so every
 *                           existing Kubernetes deployment keeps its store without a new setting.
 *   file                 -- one file per subject under SH_CREDENTIAL_DIR (file-store.ts). For a
 *                           single-host trial -- the Docker Compose stack -- on a named volume.
 *   vault                -- HashiCorp Vault KV v2 (vault-store.ts). For a VM deployment with no
 *                           Kubernetes: test, staging, production.
 *
 * All three seal under the same SH_CREDENTIAL_KEK ring. An unknown value fails STARTUP rather than
 * falling back to the default: a typo'd `vualt` silently writing Secrets through a kubectl that is not
 * there would 503 every credential call from a healthy-looking process.
 */
export function credentialStoreFromEnv(env: NodeJS.ProcessEnv): CredentialStore {
  const kind = env.SH_CREDENTIAL_STORE || 'kubernetes';
  if (!(CREDENTIAL_STORES as readonly string[]).includes(kind)) {
    throw new Error(
      `SH_CREDENTIAL_STORE must be one of ${CREDENTIAL_STORES.join(', ')}, got "${kind}"`,
    );
  }
  const keks = keksFromBase64(env.SH_CREDENTIAL_KEK);
  switch (kind as CredentialStoreKind) {
    case 'file':
      return new FileCredentialStore({ dir: required(env, 'SH_CREDENTIAL_DIR'), keks });
    case 'vault':
      return new VaultCredentialStore({
        addr: required(env, 'VAULT_ADDR'),
        token: vaultTokenSource(env),
        namespace: env.VAULT_NAMESPACE,
        mount: env.SH_VAULT_KV_MOUNT || 'secret',
        prefix: env.SH_VAULT_PATH || 'moca/credentials',
        keks,
      });
    case 'kubernetes':
      return new K8sSecretStore({
        namespace: env.SH_CREDENTIAL_NAMESPACE ?? 'sh-credentials',
        keks,
        run: defaultRunKubectl,
      });
  }
}

/**
 * Retry FOREVER, backing off to 2 s. This is a long-running server, and on Kubernetes it is
 * routinely up before Redis (setup.sh applies every workload at once): a client that gave up -- as
 * node-redis does on a refused FIRST connect -- left /readyz failing until someone restarted the
 * pod, while /healthz kept the kubelet from doing so (#423, spike F2). RedisRecordStore's bounded
 * give-up is right for its callers, which re-arm; nothing here would. Exported, with the options
 * below, so a test pins both the backoff and that the client is built with it (#434).
 */
export function redisReconnectStrategy(retries: number): number {
  return Math.min(retries * 100, 2000);
}

export function redisClientOptions(url: string) {
  return { url, socket: { reconnectStrategy: redisReconnectStrategy } };
}

/**
 * `SH_PROVENANCE_DIR` (template lifecycle spec §3.1, §7.2), either profile: a directory on the
 * control plane's persistent volume holding the provenance store, the template catalog and the
 * template policy (policy.json), opened together. Set, the catalog is the store (SH_SANDBOX_TEMPLATES imported into it once, each import
 * a provenance `create` record); unset, templates come from SH_SANDBOX_TEMPLATES at every start, as
 * before, and nothing is recorded. Each store checks its directory writable here, so a missing or
 * read-only volume fails the start, not the first write.
 */
export function templateCatalogFromEnv(
  env: NodeJS.ProcessEnv,
  config: CpConfig,
): { templates?: TemplateCatalog; policy?: PolicyStore; provenance?: ProvenanceStore } {
  const dir = env.SH_PROVENANCE_DIR;
  if (!dir) return {};
  if (!dir.startsWith('/')) throw new Error('SH_PROVENANCE_DIR must be an absolute path');
  const provenance = new ProvenanceStore({ dir });
  return {
    templates: new FileTemplateCatalog({
      dir,
      declared: config.sandbox?.templates ?? [],
      provenance,
    }),
    policy: new FilePolicyStore({ dir, provenance }),
    provenance,
  };
}

export function depsFromEnv(env: NodeJS.ProcessEnv): CpDeps {
  const config = configFromEnv(env);
  const signer = makeSigner(env.SH_SESSION_TOKEN_PRIVATE_KEY!);
  // Named rather than inlined below: the grant ring is checked against it for a shared key.
  const verifyKeys = verifyKeysFromEnv(env, signer.publicKeyBase64);
  const client = createClient(redisClientOptions(env.REDIS_URL ?? 'redis://127.0.0.1:6379'));
  const sandboxProfile = config.routeProfile === 'sandbox';
  // The sandbox stores, on the sandbox profile and on combined (combined control plane spec §3.5).
  const servesSandboxes = config.routeProfile === 'sandbox' || config.routeProfile === 'combined';
  if (
    sandboxProfile &&
    config.sandbox?.egress &&
    (!env.SH_CREDENTIAL_STORE || env.SH_CREDENTIAL_STORE === 'kubernetes')
  ) {
    throw new Error(
      'SH_CREDENTIAL_STORE must be file or vault on the sandbox profile with egress credentials (it has no Kubernetes API access)',
    );
  }
  // Without a listener an 'error' event is an uncaught exception and the process exits. The message
  // only: node-redis socket errors name host:port, never userinfo, and the error object itself is not
  // logged in case some future one carries the URL (the test checks the password never appears).
  client.on('error', (err: unknown) =>
    console.error('[control-plane] redis client error:', (err as Error)?.message ?? String(err)),
  );
  // Connect eagerly. With the strategy above this settles only once connected (or on close); readyz
  // reports the outage meanwhile, so it is visible rather than an opaque 500 on every session route.
  void client
    .connect()
    .catch((err: unknown) =>
      console.error(
        '[control-plane] redis connect failed:',
        (err as Error)?.message ?? String(err),
      ),
    );
  return {
    redisReady: () => client.isReady,
    // destroy, not close: close() waits on queued commands, which never drain while disconnected.
    close: async () => {
      if (client.isOpen) client.destroy();
    },
    index: new OwnershipIndex(client as unknown as CpRedisLike),
    turns: new TurnStore(client as unknown as CpRedisLike, {
      resultTtlSeconds: config.turnRecordTtlSeconds - TURN_RECORD_TTL_MARGIN_SECONDS,
      ttlMarginSeconds: TURN_RECORD_TTL_MARGIN_SECONDS,
    }),
    turnQueue: new RedisTurnQueue(client as unknown as CpRedisLike),
    // The leaf result store's reader (§4.4). The same client, narrowed to one method: the control
    // plane reads this key and never writes it -- the worker writes it, the cascade deletes it.
    leafResults: client as unknown as ResultRedisLike,
    bundles: client as unknown as BundleRedisLike & BundleBudgetRedisLike,
    refresh: new RedisRefreshStore(
      client as unknown as RefreshRedisLike,
      {
        idleTtlS: config.refreshIdleTtlSeconds,
        maxTtlS: config.refreshMaxTtlSeconds,
        graceS: config.refreshReuseGraceSeconds,
      },
      undefined,
      defaultAuditLog,
    ),
    // The sandbox profile stores credentials only when egress is configured (SBX0.2b).
    credentials:
      sandboxProfile && !config.sandbox?.egress
        ? new UnavailableCredentialStore()
        : credentialStoreFromEnv(env),
    ...(servesSandboxes
      ? {
          sandboxes: new RedisSandboxStore(client as unknown as SandboxRedisLike),
          // A host's last post is kept for the replay check as long as a sandbox record is.
          egress: new RedisEgressStore(
            client as unknown as EgressRedisLike,
            config.sandbox?.retentionS ?? 14 * 86_400,
          ),
        }
      : {}),
    // Readiness (template lifecycle spec §3.3) from the relay's presence records, which the relay
    // writes into this same Redis on either profile.
    presence: redisPresenceReader(client as unknown as PresenceRedisLike),
    ...templateCatalogFromEnv(env, config),
    hosts: new HostRegistry(),
    // github or oidc, per SH_IDENTITY_PROVIDER (identityProviderFromEnv above); the oidc
    // provider additionally carries the browser-callback half the seam defines.
    identity: identityProviderFromEnv(env),
    // ADR-0045: constructed ONLY when SH_TEST_USERS > 0. Its absence is what makes the
    // test-login route 404, so an ordinary deployment gains no new code path at all.
    ...testUserProvider(env, config),
    signer,
    verifyKeys,
    // MI1 §6.1's grant ring, or nothing when no key is configured -- and nothing is what unmounts
    // both grant routes, so this costs an existing deployment no new code path. Takes the session
    // ring to refuse a boot where the two share a key, which would collapse §6.1's separation.
    ...grantRingFromEnv(env, verifyKeys),
    config,
    now: () => Date.now(),
    // A UUID, so a control-plane-minted id is always identical to its leafSessionId sanitisation
    // and the cascade needs no sanitising helper (plan gap #10). Named rather than inlined because
    // three consumers depend on its SHAPE and the turn one fails silently if it drifts --
    // handler-util.ts says which, and the tests inject this same binding.
    newId: defaultNewId,
    runKubectl: defaultRunKubectl,
    log: defaultAuditLog,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // Resolved once, into a copy: the secrets never enter process.env, which every kubectl child inherits.
  const env = withCredentials(process.env, CONTROL_PLANE_SECRETS);
  startControlPlane(depsFromEnv(env), portFromEnv(env), hostFromEnv(env));
}
