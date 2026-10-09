import { generateKeyPairSync } from 'node:crypto';
import { bundleKey } from '@moca/config-bundle';
import { InMemoryCredentialStore, parseCredentialBody } from '../../src/credential-store.js';
import type { CpConfig, CpDeps, RequestCtx } from '../../src/handlers.js';
import { OwnershipIndex } from '../../src/ownership.js';
import { MemoryRefreshStore, type AuditFields } from '../../src/refresh-store.js';
import { makeSigner, publicKeyFromBase64, type TokenClaims } from '../../src/token.js';
import { fakeBundleRedis, fakeRedis } from './fake-redis.js';
import { StubIdentity } from './stub-identity.js';

/** Fixed epoch ms, so nothing in these suites depends on the wall clock. */
export const NOW_MS = 1_757_000_000_000;

export type TestDeps = CpDeps & {
  publicKeyBase64: string;
  /** The fake's audit-stream map, for asserting what was audited. */
  streams: Map<string, Record<string, string>[]>;
  /** The memory refresh store's audit array, for asserting what was audited (B14). */
  refreshAudit: AuditFields[];
  /** ...and its separate stream for refusals of a token nobody issued. */
  refreshAnonAudit: AuditFields[];
};

/**
 * A CpDeps wired entirely to in-memory fakes. `config` is MERGED over the defaults, so a caller
 * overrides one field without restating the rest -- restating it is how a test ends up asserting
 * against a config the deployment would never have.
 *
 * The signing keypair is GENERATED per call, never embedded: a committed Ed25519 private key would be
 * a gitleaks finding on the blob, which no later `# notsecret` comment can retract.
 */
export function makeDeps(
  over: Partial<Omit<CpDeps, 'config'>> & {
    config?: Partial<CpConfig>;
    withStreams?: boolean;
  } = {},
): TestDeps {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const fake = fakeRedis();
  const { config: configOver, withStreams: _withStreams, ...rest } = over;
  const config: CpConfig = {
    apiTokenTtlSeconds: 3600,
    sessionTokenTtlSeconds: 300,
    refreshIdleTtlSeconds: 30 * 86_400,
    refreshMaxTtlSeconds: 90 * 86_400,
    refreshReuseGraceSeconds: 30,
    allowOperatorFallback: false,
    injectorConfigured: false,
    sandboxNamespace: 'default',
    sandboxTiers: null,
    bundleSubjectBytes: 16 * 1024 * 1024,
    bundleTotalBytes: 64 * 1024 * 1024,
    ...configOver,
  };
  const refresh = new MemoryRefreshStore({
    idleTtlS: config.refreshIdleTtlSeconds,
    maxTtlS: config.refreshMaxTtlSeconds,
    graceS: config.refreshReuseGraceSeconds,
  });
  const base: TestDeps = {
    index: new OwnershipIndex(fake.redis),
    credentials: new InMemoryCredentialStore(),
    bundles: fakeBundleRedis(),
    identity: new StubIdentity({ subject: 'github:1234', displayName: 'Alice', roles: [] }),
    signer,
    refresh,
    refreshAudit: refresh.audit,
    refreshAnonAudit: refresh.anonAudit,
    publicKeyBase64: signer.publicKeyBase64,
    verifyKeys: new Map([[signer.kid, publicKeyFromBase64(signer.publicKeyBase64)]]),
    streams: fake.streams,
    config,
    now: () => NOW_MS,
    newId: () => 'sid-fixed',
  };
  // A caller-supplied `index` brings its own fake, so `streams` must follow it or an audit assertion
  // would read the wrong map.
  return { ...base, ...rest };
}

export const ctx = (over: Partial<RequestCtx> = {}): RequestCtx => ({
  params: {},
  query: new URLSearchParams(),
  body: undefined,
  ...over,
});

// Only the claims a handler reads. The double assertion is deliberate: a partial literal is a TS2352
// error against the full TokenClaims, and filling in iss/aud/iat/exp/jti here would imply these
// principals came from a verified token, which they did not -- the router is what produces those.
export const alice = {
  sub: 'github:1234',
  tenant: 'github:1234',
  roles: [],
  scope: ['api'],
} as unknown as TokenClaims;
export const bob = {
  sub: 'github:9999',
  tenant: 'github:9999',
  roles: [],
  scope: ['api'],
} as unknown as TokenClaims;
export const admin = {
  sub: 'github:1',
  tenant: 'github:1',
  roles: ['admin'],
  scope: ['api'],
} as unknown as TokenClaims;

/** Return the CpError code a call throws. Fails loudly if it does not throw at all. */
export async function codeOf(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected a throw');
}

/** Make a digest exist in the fake bundle store, as a prior POST /v1/config-bundles would. */
export function seedBundle(deps: CpDeps, digest: string): void {
  (deps.bundles as ReturnType<typeof fakeBundleRedis>).store.set(bundleKey(digest), 'stored');
}

/** Store an inference credential. Defaults are the ones every suite here assumes. */
export async function seedCredential(
  deps: CpDeps,
  subject = 'github:1234',
  name = 'my-anthropic',
  over: Record<string, unknown> = {},
): Promise<void> {
  await deps.credentials.put(
    subject,
    parseCredentialBody(name, {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: ['litellm.internal'] },
      endpoint: 'https://litellm.internal/v1',
      secret: { token: 'sk-fake' }, // notsecret
      ...over,
    }),
  );
}
