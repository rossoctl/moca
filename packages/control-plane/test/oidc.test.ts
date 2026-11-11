import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CpError } from '../src/errors.js';
import { MemoryPendingAuthStore, OidcProvider } from '../src/oidc.js';
import type { FetchLike } from '../src/identity.js';
import type { DeviceStart, OidcCallbackResult } from '../src/identity.js';
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

/** Both callback rounds, as the browser runs them: the redirect lands (handing back the
 * browser-bound token), then the terminal's code confirms with that token carried along. */
async function signIn(r: Rig, start: DeviceStart): Promise<OidcCallbackResult> {
  const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
  if (landed.outcome !== 'awaiting_confirmation') return landed;
  return r.provider.handleCallback({
    state: start.deviceCode,
    confirm: start.userCode,
    token: landed.confirmToken,
  });
}

describe('startDeviceAuth', () => {
  it('returns the authorize URL with the state riding in it, and the terminal code not', async () => {
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
    // The confirmation code: mocactl's user-code shape, and NEVER in the authorize URL -- the URL
    // is what a victim can be handed, the code is the terminal's half of the binding.
    expect(start.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.verificationUri).not.toContain(start.userCode!);
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

  it('accepts an issuer that legitimately ends in a slash, matching it exactly', async () => {
    // Auth0-style: the slash is part of the identity. The provider is configured verbatim and
    // the discovery document agrees, so both exact-match comparisons pass.
    const slash = 'https://tenant.example.invalid/';
    const provider = new OidcProvider({
      issuer: slash,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: async (url: string) => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            issuer: slash,
            authorization_endpoint: `${slash}authorize`,
            token_endpoint: `${slash}token`,
            jwks_uri: `${slash}jwks`,
          }),
      }),
    });
    const start = await provider.startDeviceAuth();
    expect(start.verificationUri.startsWith(`${slash}authorize?`)).toBe(true);
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
    const outcome = await r.provider.handleCallback({
      code: 'auth-code-1',
      state: start.deviceCode,
    });
    expect(outcome.outcome).toBe('awaiting_confirmation');
    // The browser-bound token: unguessable, and never handed out at login start.
    expect(outcome.confirmToken).toMatch(/^[\w-]{43}$/);
    // The exchange went out with the client secret and the registered redirect_uri.
    const token = r.seen.find((s) => s.url.includes('/token'))!;
    expect(token.body).toContain('grant_type=authorization_code');
    expect(token.body).toContain(`client_secret=${encodeURIComponent(CLIENT_SECRET)}`);
    expect(token.body).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
    // A verified id_token is not a login yet: the poll still waits for the confirmation.
    expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
      'authorization_pending',
    );
    expect(
      (
        await r.provider.handleCallback({
          state: start.deviceCode,
          confirm: start.userCode,
          token: outcome.confirmToken,
        })
      ).outcome,
    ).toBe('confirmed');
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
    await signIn(r, start);
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
      // Symmetrically, an nbf an hour in the future is outside the skew allowance.
      ['nbf', { sub: 'user-1', nbf: Math.floor(NOW_MS / 1000) + 3600 }],
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

  it('accepts a multi-value audience only when azp names this client (OIDC Core §3.1.3.7)', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', aud: ['other-client', CLIENT_ID], azp: CLIENT_ID });
    const start = await r.provider.startDeviceAuth();
    await signIn(r, start);
    const p = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(p.subject).toBe('oidc:user-1');
    // The same token with azp naming the other client is refused.
    mint(r, { sub: 'user-1', aud: ['other-client', CLIENT_ID], azp: 'other-client' });
    const start2 = await r.provider.startDeviceAuth();
    await r.provider.handleCallback({ code: 'c', state: start2.deviceCode });
    const e = await errOf(() => r.provider.completeDeviceAuth(start2.deviceCode));
    expect(e.code).toBe('unauthorized');
    expect(e.message).toContain('azp');
  });

  it('accepts an email sub (w3id mints the intranet address), refusing only exotic values', async () => {
    const r = rig();
    mint(r, { sub: 'alex@us.ibm.com', email: 'alex@us.ibm.com', name: 'Alex Example' });
    const start = await r.provider.startDeviceAuth();
    await signIn(r, start);
    const p = await r.provider.completeDeviceAuth(start.deviceCode);
    expect(p.subject).toBe('oidc:alex@us.ibm.com');
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

  it('renders the confirmation form when the provider redirect lands', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    const res = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams(`code=c&state=${start.deviceCode}`) }),
      d,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    // The form posts back with the state, the browser-bound token, and the typed code; the user
    // code itself is nowhere on the page.
    expect(String(res.body)).toContain('name="confirm"');
    expect(String(res.body)).toContain(`value="${start.deviceCode}"`);
    expect(String(res.body)).toContain('name="ct"');
    expect(String(res.body)).not.toContain(start.userCode!);
  });

  it('confirms and reports success', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const res = await HANDLERS.oidcCallbackSubmit!(
      ctx({ body: { state: start.deviceCode, confirm: start.userCode, ct: landed.confirmToken } }),
      d,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(String(res.body)).toMatch(/return to your terminal/);
  });

  describe('the pending-auth store under attack and accident (review round 2)', () => {
    it('never flips a parked login: a replayed ?error= changes nothing', async () => {
      const r = rig();
      mint(r, { sub: 'user-1' });
      const start = await r.provider.startDeviceAuth();
      const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      expect(landed.outcome).toBe('awaiting_confirmation');
      // The state is in the victim's browser history; anyone replaying the callback with an error
      // parameter must not turn the parked login into a denial.
      const flipped = await r.provider.handleCallback({
        state: start.deviceCode,
        error: 'access_denied',
      });
      expect(flipped.outcome).toBe('awaiting_confirmation');
      expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
        'authorization_pending',
      );
      // The real browser still completes it.
      expect(
        (
          await r.provider.handleCallback({
            state: start.deviceCode,
            confirm: start.userCode,
            token: landed.confirmToken,
          })
        ).outcome,
      ).toBe('confirmed');
    });

    it('never replaces a parked principal: a second exchange does not re-issue the confirm token', async () => {
      const r = rig();
      mint(r, { sub: 'user-1' });
      const start = await r.provider.startDeviceAuth();
      const first = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      mint(r, { sub: 'someone-else' });
      const second = await r.provider.handleCallback({ code: 'c2', state: start.deviceCode });
      // Second landing: no token handed out (only a completing redirect may carry one), and the
      // poll still waits on the FIRST principal's confirmation.
      expect(second.outcome).toBe('awaiting_confirmation');
      expect(second.confirmToken).toBeUndefined();
      expect(
        (
          await r.provider.handleCallback({
            state: start.deviceCode,
            confirm: start.userCode,
            token: first.confirmToken,
          })
        ).outcome,
      ).toBe('confirmed');
      expect(await r.provider.completeDeviceAuth(start.deviceCode)).toMatchObject({
        subject: 'oidc:user-1',
      });
    });

    it('settles a denial when the exchange fails at the transport level, not a 15-minute hang', async () => {
      // A token endpoint that rejects outright (provider down, network cut): the poll must hear
      // the refusal, not authorization_pending for the rest of the window. Discovery and the JWKS
      // still answer, so the failure is exactly at the exchange.
      const keys = rsa();
      const now = { ms: NOW_MS };
      const fetch: FetchLike = async (url: string) => {
        if (url.includes('/token')) throw new Error('connect ECONNREFUSED');
        if (url.includes('openid-configuration'))
          return { status: 200, text: async () => JSON.stringify(DISCOVERY) };
        if (url.includes('/jwks'))
          return { status: 200, text: async () => JSON.stringify(keys.jwks) };
        throw new Error('unscripted ' + url);
      };
      const provider = new OidcProvider({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch,
        now: () => now.ms,
        store: new MemoryPendingAuthStore(() => now.ms),
      });
      const start = await provider.startDeviceAuth();
      const out = await provider.handleCallback({ code: 'c', state: start.deviceCode });
      expect(out.outcome).toBe('refused');
      const e = await errOf(() => provider.completeDeviceAuth(start.deviceCode));
      expect(e.code).toBe('unauthorized');
      expect(e.message).toContain('could not complete');
      expect(e.message).toContain('ECONNREFUSED');
    });

    it('refuses login starts past the store cap (429), and recovers once entries expire', async () => {
      const keys = rsa();
      const now = { ms: NOW_MS };
      const idToken = { value: '' };
      const store = new MemoryPendingAuthStore(() => now.ms, 2);
      const fetch: FetchLike = async (url: string) => {
        if (url.includes('/token'))
          return { status: 200, text: async () => JSON.stringify({ id_token: idToken.value }) };
        if (url.includes('openid-configuration'))
          return { status: 200, text: async () => JSON.stringify(DISCOVERY) };
        if (url.includes('/jwks'))
          return { status: 200, text: async () => JSON.stringify(keys.jwks) };
        throw new Error('unscripted ' + url);
      };
      const provider = new OidcProvider({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetch,
        now: () => now.ms,
        store,
      });
      await provider.startDeviceAuth();
      await provider.startDeviceAuth();
      const capped = await errOf(() => provider.startDeviceAuth());
      expect(capped.code).toBe('quota_exceeded');
      // The cap is live entries, not all history: let them expire and a start works again.
      now.ms += 901 * 1000;
      const again = await provider.startDeviceAuth();
      expect(again.deviceCode).toMatch(/^[\w-]+$/);
    });

    it('a malformed confirmation does not burn a try', async () => {
      const r = rig();
      mint(r, { sub: 'user-1' });
      const start = await r.provider.startDeviceAuth();
      const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      for (let i = 0; i < 8; i++) {
        const out = await r.provider.handleCallback({
          state: start.deviceCode,
          confirm: 'not a code',
          token: landed.confirmToken,
        });
        expect(out.outcome).toBe('wrong_code');
      }
      // Still not exhausted (no try was burned), and the right code still confirms.
      expect(
        (
          await r.provider.handleCallback({
            state: start.deviceCode,
            confirm: start.userCode,
            token: landed.confirmToken,
          })
        ).outcome,
      ).toBe('confirmed');
    });
  });

  describe('the browser-to-terminal binding (review item 3)', () => {
    it('defeats the walk-in attack end to end, the attacker holding state AND user code', async () => {
      // The attacker starts the login, so their terminal shows BOTH the state and the user code.
      // The victim's browser (a live SSO session) completes the provider redirect; the id_token is
      // genuinely the victim's. The attacker then confirms directly, with everything their
      // terminal showed -- and fails, for want of the browser-bound token that only the victim's
      // round-1 response ever carried. (Review round 2: the user code alone binds nothing against
      // a malicious initiator, who saw it first.)
      const r = rig();
      mint(r, { sub: 'victim@us.ibm.com', name: 'Victim Example' });
      const start = await r.provider.startDeviceAuth();
      const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      expect(landed.outcome).toBe('awaiting_confirmation');
      expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
        'authorization_pending',
      );
      const attacker = await r.provider.handleCallback({
        state: start.deviceCode,
        confirm: start.userCode,
      });
      expect(attacker.outcome).toBe('wrong_code');
      expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
        'authorization_pending',
      );
      // The victim's browser, carrying its token, still completes the login.
      const victim = await r.provider.handleCallback({
        state: start.deviceCode,
        confirm: start.userCode,
        token: landed.confirmToken,
      });
      expect(victim.outcome).toBe('confirmed');
      expect(await r.provider.completeDeviceAuth(start.deviceCode)).toMatchObject({
        subject: 'oidc:victim@us.ibm.com',
      });
    });

    it('accepts a lowercase or padded confirmation code, and is single-use', async () => {
      const r = rig();
      mint(r, { sub: 'user-1' });
      const start = await r.provider.startDeviceAuth();
      const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      expect(
        (
          await r.provider.handleCallback({
            state: start.deviceCode,
            confirm: ` ${start.userCode!.toLowerCase()} `,
            token: landed.confirmToken,
          })
        ).outcome,
      ).toBe('confirmed');
      expect(await r.provider.completeDeviceAuth(start.deviceCode)).toMatchObject({
        subject: 'oidc:user-1',
      });
    });

    it('counts wrong codes and refuses the login at the limit', async () => {
      const r = rig();
      mint(r, { sub: 'user-1' });
      const start = await r.provider.startDeviceAuth();
      const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
      for (let i = 0; i < 4; i++) {
        expect(
          (
            await r.provider.handleCallback({
              state: start.deviceCode,
              confirm: 'AAAA-AAAA',
              token: landed.confirmToken,
            })
          ).outcome,
        ).toBe('wrong_code');
        // Still pending between wrong tries.
        expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
          'authorization_pending',
        );
      }
      // The fifth wrong code exhausts the login: refused for the browser AND the poll.
      expect(
        (
          await r.provider.handleCallback({
            state: start.deviceCode,
            confirm: 'AAAA-AAAA',
            token: landed.confirmToken,
          })
        ).outcome,
      ).toBe('refused');
      const e = await errOf(() => r.provider.completeDeviceAuth(start.deviceCode));
      expect(e.code).toBe('unauthorized');
      expect(e.message).toContain('too many wrong');
      // Even the RIGHT code no longer revives it.
      expect(
        (
          await errOf(() =>
            r.provider.handleCallback({ state: start.deviceCode, confirm: start.userCode }),
          )
        ).code,
      ).toBe('unauthorized');
    });

    it('refuses a confirmation that arrives before the provider redirect', async () => {
      const r = rig();
      const start = await r.provider.startDeviceAuth();
      expect(
        (
          await errOf(() =>
            r.provider.handleCallback({ state: start.deviceCode, confirm: 'AAAA-AAAA' }),
          )
        ).code,
      ).toBe('invalid_request');
    });
  });

  it('submits the confirmation over POST (urlencoded), keeping the code out of the URL', async () => {
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const res = await HANDLERS.oidcCallbackSubmit!(
      ctx({ body: { state: start.deviceCode, confirm: start.userCode, ct: landed.confirmToken } }),
      d,
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/return to your terminal/);
    // The page's headers make it un-frameable and uncached.
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  });

  it('a wrong-code page still carries the ct, so the retry can succeed (review round 3)', async () => {
    // The exact shape the reviewer described: land, submit a wrong code, take the ct from the
    // RE-RENDERED page (not from round 1 by hand), submit the right code, expect confirmed.
    const r = rig();
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    const landed = await r.provider.handleCallback({ code: 'c', state: start.deviceCode });
    const wrong = await HANDLERS.oidcCallbackSubmit!(
      ctx({ body: { state: start.deviceCode, confirm: 'AAAA-AAAA', ct: landed.confirmToken } }),
      d,
    );
    expect(String(wrong.body)).toContain('not right');
    // The re-rendered form's hidden ct, scraped like a browser would.
    const ct = /name="ct" value="([^"]*)"/.exec(String(wrong.body))![1]!;
    expect(ct).toBe(landed.confirmToken);
    const right = await HANDLERS.oidcCallbackSubmit!(
      ctx({ body: { state: start.deviceCode, confirm: start.userCode, ct } }),
      d,
    );
    expect(String(right.body)).toMatch(/return to your terminal/);
  });

  it('a reload of the round-1 page gets an explanation, never a form with an empty ct (round 4)', async () => {
    // Back/reload re-sends the provider's redirect; the spent code is refused by the provider,
    // the login stays parked, and the re-render has no token to carry. The page must say so
    // rather than ship ct="" -- a form that burns a try per submit until the login is denied.
    // A mutable reply queue: the id_token only exists after mint(), so the entries are filled
    // in below -- first exchange succeeds, the replayed code is refused.
    const tokenReplies: { status: number; body: unknown }[] = [];
    const r = rig({ script: { '/token': tokenReplies } });
    mint(r, { sub: 'user-1', name: 'Alice Example' });
    tokenReplies.push({ status: 200, body: { id_token: r.idToken.value } });
    tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
    const d = makeDeps({ identity: r.provider });
    const start = await r.provider.startDeviceAuth();
    // Round 1 through the route, so the scripted queue is consumed in order.
    const first = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams(`code=c&state=${start.deviceCode}`) }),
      d,
    );
    expect(String(first.body)).toContain('<form');
    // The reload: same code, same state, no ct anywhere.
    const reload = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams(`code=c&state=${start.deviceCode}`) }),
      d,
    );
    expect(String(reload.body)).not.toContain('<form');
    expect(String(reload.body)).toContain('no longer valid');
    // And the login is still parked, not denied: the original tab can still confirm.
    expect((await errOf(() => r.provider.completeDeviceAuth(start.deviceCode))).code).toBe(
      'authorization_pending',
    );
  });

  it('never reflects a forged state, markup included', async () => {
    // A state that is not live never reaches the confirmation form -- the refusal names nothing
    // the caller sent -- and a live state is base64url by construction, so the form's value
    // escaping is defense in depth on top of an unreachable path.
    const r = rig();
    const d = makeDeps({ identity: r.provider });
    // GET no longer runs the confirm round at all: the confirmation submits by POST, so a
    // confirm-carrying GET (an old bookmarked form, a hand-built link) is refused up front and
    // nothing from the query is reflected.
    const res = await HANDLERS.oidcCallback!(
      ctx({ query: new URLSearchParams('state=%3Cscript%3Ealert(1)%3C%2Fscript%3E&confirm=x') }),
      d,
    );
    expect(res.status).toBe(400);
    expect(String(res.body)).toContain('form on the sign-in page');
    expect(String(res.body)).not.toContain('<script>');
    expect(String(res.body)).not.toContain('alert(1)');
  });
});
