import { createClient } from 'redis';
import { fileURLToPath } from 'node:url';
import type { KeyObject } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { keksFromBase64 } from './envelope.js';
import type { CredentialStore, InferenceAuthHeader } from './credential-store.js';
import { directModeMismatch } from './exchange.js';
import { FileCredentialStore } from './file-store.js';
import { adminSubjectsFromEnv, GithubOAuthProvider } from './identity.js';
import { K8sSecretStore } from './k8s-secret-store.js';
import { defaultRunKubectl } from './kubectl.js';
import { OwnershipIndex, type CpRedisLike } from './ownership.js';
import { startControlPlane } from './server.js';
import type { CpConfig, CpDeps } from './handlers.js';
import { keyIdFor, makeSigner, parseKeyset, publicKeyFromBase64 } from './token.js';
import { VaultCredentialStore, vaultTokenSource } from './vault-store.js';
import { withCredentials } from './systemd-credentials.js';

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
export const CONTROL_PLANE_SECRETS = ['SH_SESSION_TOKEN_PRIVATE_KEY', 'SH_CREDENTIAL_KEK', 'SH_EXCHANGE_TOKEN', 'SH_OPERATOR_INFERENCE_TOKEN'] as const;

export function configFromEnv(env: NodeJS.ProcessEnv): CpConfig {
  required(env, 'SH_SESSION_TOKEN_PRIVATE_KEY');
  required(env, 'SH_GITHUB_CLIENT_ID');
  keksFromBase64(required(env, 'SH_CREDENTIAL_KEK'));
  const config: CpConfig = {
    apiTokenTtlSeconds: intEnv(env, 'SH_API_TOKEN_TTL_SECONDS', 3600),
    // A session outlives a 5-minute token; POST /v1/sessions/{id}/token re-mints (spec §4.2).
    sessionTokenTtlSeconds: intEnv(env, 'SH_SESSION_TOKEN_TTL_SECONDS', 300),
    exchangeToken: required(env, 'SH_EXCHANGE_TOKEN'),
    defaultInferenceEndpoint: env.SH_DEFAULT_INFERENCE_ENDPOINT || undefined,
    operatorInferenceToken: env.SH_OPERATOR_INFERENCE_TOKEN || undefined,
    operatorInferenceHeader: operatorHeaderFromEnv(env),
    // Exactly 'true'. A typo must not silently switch on a fallback that lets one subject spend the
    // operator's key (spec §6.4 defaults it off).
    allowOperatorFallback: env.SH_ALLOW_OPERATOR_FALLBACK === 'true',
    injectorConfigured: env.SH_INJECTOR_CONFIGURED === 'true',
    sandboxNamespace: env.SH_SANDBOX_NAMESPACE || 'default',
    publicHarnessUrl: urlEnv(env, 'SH_PUBLIC_HARNESS_URL'),
  };
  checkInferenceConfig(config);
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
  if (token.startsWith('sk-ant-oat')) {
    throw new Error(
      'SH_OPERATOR_INFERENCE_TOKEN is an Anthropic OAuth token (sk-ant-oat…), which the inference ' +
        'path cannot send; use an API key (sk-ant-api…)',
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

export function depsFromEnv(env: NodeJS.ProcessEnv): CpDeps {
  const config = configFromEnv(env);
  const signer = makeSigner(env.SH_SESSION_TOKEN_PRIVATE_KEY!);
  const client = createClient({
    url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    // Retry FOREVER, backing off to 2 s. This is a long-running server, and on Kubernetes it is
    // routinely up before Redis (setup.sh applies every workload at once): a client that gave up --
    // as node-redis does on a refused FIRST connect -- left /readyz failing until someone restarted
    // the pod, while /healthz kept the kubelet from doing so (#423, spike F2). RedisRecordStore's
    // bounded give-up is right for its callers, which re-arm; nothing here would.
    socket: { reconnectStrategy: (retries: number) => Math.min(retries * 100, 2000) },
  });
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
    credentials: credentialStoreFromEnv(env),
    identity: new GithubOAuthProvider({
      clientId: env.SH_GITHUB_CLIENT_ID!,
      adminSubjects: adminSubjectsFromEnv(env.SH_ADMIN_SUBJECTS),
    }),
    signer,
    verifyKeys: verifyKeysFromEnv(env, signer.publicKeyBase64),
    config,
    now: () => Date.now(),
    // randomUUID, so a control-plane-minted id is always identical to its leafSessionId
    // sanitisation and the cascade needs no sanitising helper (plan gap #10).
    newId: () => randomUUID(),
    runKubectl: defaultRunKubectl,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // Resolved once, into a copy: the secrets never enter process.env, which every kubectl child inherits.
  const env = withCredentials(process.env, CONTROL_PLANE_SECRETS);
  startControlPlane(depsFromEnv(env), portFromEnv(env), hostFromEnv(env));
}
