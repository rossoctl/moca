import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CpError } from '../src/errors.js';
import { MemoryPendingAuthStore, OidcProvider } from '../src/oidc.js';
import type { FetchLike } from '../src/identity.js';
import type { DeviceStart } from '../src/identity.js';
import { makeDeps, ctx } from './helpers/deps.js';
import { HANDLERS } from '../src/handlers.js';

/**
 * The whole flow is scripted offline, as identity.test.ts scripts GitHub: discovery and the JWKS
 * answer from a queue keyed by URL substring. The token endpoint replies with whatever id_token the
 * test last minted, and that id_token is a REAL RS256 JWS over a keypair generated per run (never
 * committed), so signature verification is exercised, not stubbed.
 */

const ISSUER = 'https://preprod.login.w3.ibm.com/oidc/endpoint/default';
const CLIENT_ID = 'fake-client-id'; // notsecret
const CLIENT_SECRET = 'fake-client-secret'; // notsecret
const REDIRECT_URI = 'https://moca-cp.apps.example.invalid/v1/auth/oidc/callback';

const NOW_MS = 1_757_000_000_000;

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64url');
}

/** An RSA keypair plus the JWKS entry and signer for id_tokens a test mints. */
function rsa() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = 'test-key-1';
  const jwks = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
  const sign = (claims: Record<string, unknown>): string => {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid }));
    const payload = b64url(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${b64url(sig)}`;
  };
  return { jwks, kid, sign };
}

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

interface Rig {
  provider: OidcProvider;
  seen: { url: string; method: string; body?: string }[];
  keys: ReturnType<typeof rsa>;
  now: { ms: number };
  /** What the token endpoint replies with; a test mints the id_token it wants verified. */
  idToken: { value: string };
}

function rig(
  over: {
    /** Overrides for queued replies (discovery, jwks, or a scripted token-endpoint refusal). */
    script?: Record<string, { status: number; body: unknown }[]>;
  } = {},
): Rig {
  const keys = rsa();
  const now = { ms: NOW_MS };
  const idToken = { value: '' };
  const seen: { url: string; method: string; body?: string }[] = [];
  const script: Record<string, { status: number; body: unknown }[]> = {
    'openid-configuration': [{ status: 200, body: DISCOVERY }],
    '/jwks': [{ status: 200, body: keys.jwks }],
    ...(over.script ?? {}),
  };
  const fetch: FetchLike = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    seen.push({ url, ...init });
    if (url.includes('/token') && !script['/token']) {
      return { status: 200, text: async () => JSON.stringify({ id_token: idToken.value }) };
    }
    const key = Object.keys(script).find((k) => url.includes(k));
    if (!key) throw new Error(`no scripted reply for ${url}`);
    const next = script[key]!.length > 1 ? script[key]!.shift()! : script[key]![0]!;
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  const provider = new OidcProvider({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    adminSubjects: ['oidc:admin-sub'],
    fetch,
    now: () => now.ms,
    store: new MemoryPendingAuthStore(() => now.ms),
  });
  return { provider, seen, keys, now, idToken };
}

/** Mint the id_token the token endpoint will hand back, over the rig's key. */
function mint(r: Rig, claims: Record<string, unknown>): void {
  r.idToken.value = r.keys.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...claims,
  });
}

const errOf = async (fn: () => Promise<unknown>): Promise<CpError> => {
  try {
    await fn();
  } catch (e) {
    return e as CpError;
  }
  throw new Error('expected a throw');
};

describe('startDeviceAuth', () => {
  it('returns the authorize URL with the state riding in it, and no user code', async () => {
    const r = rig();
    const start: DeviceStart = await r.provider.startDeviceAuth();
    const url = new URL(start.verificationUri);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe(start.deviceCode);
    // 32 bytes base64url: unguessable, and the capability the client polls with.
    expect(start.deviceCode).toMatch(/^[\w-]{43}$/);
    expect(start.userCode).toBeUndefined();
    expect(start.interval).toBeGreaterThan(0);
    expect(start.expiresIn).toBe(900);
  });

  it('polls pending before the callback lands', async () => {
    const r = rig();
    const start = await r.provider.startDeviceAuth();
    expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
      'authorization_pending',
    );
  });

  it('refuses a discovery document whose issuer is not the configured one', async () => {
    const r = rig({
      script: {
        'openid-configuration': [
          { status: 200, body: { ...DISCOVERY, issuer: 'https://evil.example.invalid' } },
        ],
      },
    });
    expect((await errOf(() => r.provider.startDeviceAuth())).code).toBe(
      'identity_provider_misconfigured',
    );
  });
});

describe('the callback and the poll', () => {
  it('completes a login: callback settles the state, the poll collects the principal', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example', email: 'alice@example.invalid' });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'auth-code-1', state: start.deviceCode });
    // The exchange went out with the client secret and the registered redirect_uri.
    const token = r.seen.find((s) => s.url.includes('/token'))!;
    expect(token.body).toContain('grant_type=authorization_code');
    expect(token.body).toContain(`client_secret=${encodeURIComponent(CLIENT_SECRET)}`);
    expect(token.body).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
    const principal = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(principal).toEqual({
      subject: 'oidc:user-1',
      displayName: 'Alice Example',
      roles: [],
    });
    // Single-use: a second poll on the same state is expired, not a replay of the principal.
    expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
      'device_code_expired',
    );
  });

  it('gives an enrolled admin the admin role, and falls back through the name claims', async () => {
    const r = rig();
    mint(r, { sub: 'admin-sub', preferred_username: 'admin' });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const p = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(p.roles).toEqual(['admin']);
    expect(p.displayName).toBe('admin');
  });

  it('reports an expired state to the poll, and an expiry that lapses mid-flight', async () => {
    const r = rig();
    expect((await errOf(() => r.provider.completeDeviceAuth('never-issued'))).code).toBe(
      'device_code_expired',
    );
    const start = await r.provider.startDeviceAuth();
    r.now.ms += 901 * 1000;
    expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
      'device_code_expired',
    );
  });

  it('records the provider error parameter as a denial the poll reports', async () => {
    const r = rig();
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ state: start.deviceCode, error: 'access_denied' });
    const e = await errOf(() => r.provider.completeDeviceAuth(start.deviceCode));
    expect(e.code).toBe('unauthorized');
    expect(e.message).toContain('access_denied');
  });

  it('records a refused token exchange as a denial, not a pending login', async () => {
    const r = rig({
      script: { '/token': [{ status: 400, body: { error: 'invalid_client' } }] },
    });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const e = await errOf(() => r.provider.completeDeviceAuth(start.deviceCode));
    expect(e.code).toBe('unauthorized');
    expect(e.message).toContain('invalid_client');
  });

  it('refuses a callback for an unknown state', async () => {
    const r = rig();
    expect((await errOf(() => r.provider.handleCallback({ code: 'c', state: 'nope' }))).code).toBe(
      'unauthorized',
    );
  });

  it('refuses a callback missing its parameters', async () => {
    const r = rig();
    expect((await errOf(() => r.provider.handleCallback({}))).code).toBe('invalid_request');
    const start = await r.provider.startDeviceAuth();
    expect((await errOf(() => r.provider.handleCallback({ state: start.deviceCode }))).code).toBe(
      'invalid_request',
    );
  });
});

describe('id_token verification', () => {
  it('refuses a token signed by a key the JWKS does not advertise', async () => {
    const r = rig();
    const forged = rsa();
    r.idToken.value = forged.sign({
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: Math.floor(NOW_MS / 1000) + 600,
      sub: 'user-1',
    });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const e = await errOf(() => r.provider.completeDeviceAuth(start.deviceCode));
    expect(e.code).toBe('unauthorized');
  });

  it('refuses a wrong issuer, audience, or an expired token', async () => {
    const r = rig();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['issuer', { sub: 'user-1', iss: 'https://other.example.invalid' }],
      ['audience', { sub: 'user-1', aud: 'some-other-client' }],
      // An hour stale, not a second: the 60 s clock-skew allowance must accept a just-lapsed token,
      // so the fixture has to be outside the allowance to test the refusal.
      ['exp', { sub: 'user-1', exp: Math.floor(NOW_MS / 1000) - 3600 }],
      ['sub', { sub: 'not a valid sub!' }],
    ];
    for (const [what, claims] of cases) {
      mint(r, claims);
      const start = await r.provider.startDeviceAuth();
      await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      const e = await errOf(() => r.provider.completeDeviceAuth(start.deviceCode));
      expect(e.code, what).toBe('unauthorized');
    }
  });

  it('accepts an audience that is a list containing this client', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', aud: ['other-client', CLIENT_ID] });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const p = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(p.subject).toBe('oidc:user-1');
  });

  it('accepts an email sub (w3id mints the intranet address), refusing only exotic values', async () => {
    const r = rig();
    mint(r, { sub: 'george@us.ibm.com', email: 'george@us.ibm.com', name: 'George Almasi' });
    const start = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const p = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(p.subject).toBe('oidc:george@us.ibm.com');
  });
});

describe('the callback route', () => {
  it('answers plain text and refuses a provider that holds its own flow', async () => {
    const d = makeDeps(); // StubIdentity: no handleCallback
    const res = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams('code=c&state=s') }),
      d,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/SH_IDENTITY_PROVIDER=oidc/);
  });

  it('hands the query to the provider and reports success', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    const res = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams(`code=c&state=${start.deviceCode}`) }),
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/return to your terminal/);
  });
});
