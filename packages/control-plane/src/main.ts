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
} from './identity.js';
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
import { routeProfileFromEnv, sandboxConfigFromEnv } from './sandbox-config.js';
import { RedisSandboxStore, type SandboxRedisLike } from './sandbox-redis.js';
import { readTenancy } from './tenancy.js';
import { TurnStore } from './turn-store.js';
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

/**
 * The turn record's TTL: `LEAF_RESULT_TTL_SECONDS` plus a margin (async fan-out spec §5.1). The
 * record must OUTLIVE its result -- a caller polling a finished turn whose record expired first
 * would read `404 not submitted` for a turn that in fact succeeded. One hour, which is longer than
 * any plausible gap between a result being read and a poll that follows it.
 */
const TURN_RECORD_TTL_MARGIN_SECONDS = 3_600;

function turnRecordTtlFromEnv(env: NodeJS.ProcessEnv): number {
  // Matches server.ts:49's parseInt of the same variable: one deployment, one meaning.
  const result = countEnv(env, 'LEAF_RESULT_TTL_SECONDS', 86_400);
  return result + TURN_RECORD_TTL_MARGIN_SECONDS;
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
export const CONTROL_PLANE_SECRETS = ['SH_SESSION_TOKEN_PRIVATE_KEY', 'SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN', 'SH_OPERATOR_INFERENCE_TOKEN', 'SH_JANITOR_TOKEN', 'SH_TEST_USER_SECRET'] as const;

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

export function configFromEnv(env: NodeJS.ProcessEnv): CpConfig {
  required(env, 'SH_SESSION_TOKEN_PRIVATE_KEY');
  required(env, 'SH_GITHUB_CLIENT_ID');
  if (routeProfileFromEnv(env) === 'sandbox') return sandboxProfileConfig(env);
  keksFromBase64(required(env, 'SH_CREDENTIAL_KEK'));
  const config: CpConfig = {
    ...tokenTtlsFromEnv(env),
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
  return config;
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
  // ADR-0045: the sandbox profile admits only ENROLLED GitHub subjects (SBX0 §4.2,
  // SH_ALLOWED_SUBJECTS, which every entry must match GITHUB_SUBJECT_RE). A synthetic `test:N`
  // subject can never be enrolled there, so rather than serve a route that always refuses, refuse
  // to boot and say which two settings conflict.
  if (testUsersFromEnv(env.SH_TEST_USERS) > 0) {
    throw new Error(
      'SH_TEST_USERS cannot be used on the sandbox profile: it admits only enrolled ' +
        'github: subjects (SH_ALLOWED_SUBJECTS)',
    );
  }
  const config: CpConfig = {
    routeProfile: 'sandbox',
    sandbox: sandboxConfigFromEnv(env),
    ...tokenTtlsFromEnv(env),
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

export function depsFromEnv(env: NodeJS.ProcessEnv): CpDeps {
  const config = configFromEnv(env);
  const signer = makeSigner(env.SH_SESSION_TOKEN_PRIVATE_KEY!);
  const client = createClient(redisClientOptions(env.REDIS_URL ?? 'redis://127.0.0.1:6379'));
  const sandboxProfile = config.routeProfile === 'sandbox';
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
    ...(sandboxProfile
      ? { sandboxes: new RedisSandboxStore(client as unknown as SandboxRedisLike) }
      : {}),
    identity: new GithubOAuthProvider({
      clientId: env.SH_GITHUB_CLIENT_ID!,
      adminSubjects: adminSubjectsFromEnv(env.SH_ADMIN_SUBJECTS),
    }),
    // ADR-0045: constructed ONLY when SH_TEST_USERS > 0. Its absence is what makes the
    // test-login route 404, so an ordinary deployment gains no new code path at all.
    ...testUserProvider(env, config),
    signer,
    verifyKeys: verifyKeysFromEnv(env, signer.publicKeyBase64),
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
