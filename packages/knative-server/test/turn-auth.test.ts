import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CP_ERROR_CODES, CpError, statusFor, type CpErrorCode } from '@moca/control-plane';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

// Fix round 1, Important 2: lets the retry test control connect() success/failure per attempt
// without a live Redis. Nothing else in this file touches Redis (sharedRuntimeReporter's own test
// only compares closure identity; it never invokes a reporter), so mocking the whole module is safe.
vi.mock('redis', () => ({ createClient: vi.fn() }));
import { createClient } from 'redis';
import {
  PASSTHROUGH,
  assertKeysetUsable,
  makeRuntimeReporter,
  resolveTurnAuth,
  runtimeFieldsForTurn,
  sharedRuntimeReporter,
  turnAuthDepsFromEnv,
  type TurnAuthDeps,
} from '../src/turn-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const KEYSET = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
const NOW_S = 1_757_000_000;

const sessionToken = (over: Record<string, unknown> = {}) =>
  signer.mint({
    sub: 'github:1234',
    tenant: 'github:1234',
    roles: [],
    scope: ['turn:write'],
    sid: 'sid-1',
    ttlSeconds: 300,
    now: NOW_S,
    ...over,
  });

/** A scripted exchange endpoint. Records the requests so auth headers can be asserted. */
function fakeExchange(reply: { status: number; body: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      text: async () => JSON.stringify(reply.body),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (over: Partial<TurnAuthDeps> = {}): TurnAuthDeps => ({
  keys: new Map([[keyIdFor(publicKey), publicKey]]),
  requireAuth: false,
  controlPlaneUrl: 'http://cp.default.svc:8080',
  exchangeToken: 'shared-abc', // notsecret
  now: () => NOW_S * 1000,
  fetchImpl: fakeExchange({
    status: 200,
    body: {
      mode: 'direct',
      anthropicAuthToken: 'sk-alice', // notsecret
      anthropicBaseUrl: 'https://litellm.internal/v1',
      sessionId: 'sid-1',
      subject: 'github:1234',
    },
  }).fetchImpl,
  ...over,
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return (e as CpError).code;
  }
  throw new Error('expected a throw');
};

describe('the SH_REQUIRE_AUTH table (spec §4.3.1)', () => {
  it('permissive default + no token → proceeds unauthenticated', async () => {
    expect(await resolveTurnAuth({}, {}, deps({ requireAuth: false }))).toBeNull();
  });

  it('required + no token → 401 token_required', async () => {
    expect(await codeOf(() => resolveTurnAuth({}, {}, deps({ requireAuth: true })))).toBe(
      'token_required',
    );
  });

  it('a present-but-bad token is 401 in EITHER mode', async () => {
    // The flag governs whether auth is REQUIRED, never whether it is ENFORCED. "Unauthenticated is
    // allowed here" and "this bad token is close enough" are different statements, and only the first
    // is a deployment choice (spec §4.3.1).
    for (const requireAuth of [false, true]) {
      const code = await codeOf(() =>
        resolveTurnAuth(
          { authorization: 'Bearer not-a-jwt' },
          { sessionId: 'sid-1' },
          deps({ requireAuth }),
        ),
      );
      expect(code, `requireAuth=${requireAuth}`).toBe('token_invalid');
    }
  });

  it('evaluates expiry at TURN START only, so a long turn is not killed mid-stream', async () => {
    // Spec §9.2. resolveTurnAuth is called once, before executeTurn; nothing re-checks `exp` while a
    // turn runs, which is why a 5-minute token can outlive its own lifetime mid-stream. Asserted by
    // resolving successfully at t and then showing the resolver is not consulted again -- the only
    // clock read is the one passed in here.
    const auth = await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}` },
      { sessionId: 'sid-1' },
      deps({ now: () => (NOW_S + 299) * 1000 }),
    );
    expect(auth?.credential.value).toBe('sk-alice'); // notsecret
    // One second past expiry a NEW turn is refused -- the boundary applies per turn, not per stream.
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ now: () => (NOW_S + 301) * 1000 }),
        ),
      ),
    ).toBe('token_expired');
  });

  it('an expired token is 401, never a silent downgrade to ambient', async () => {
    const expired = sessionToken({ now: NOW_S - 400 });
    expect(
      await codeOf(() =>
        resolveTurnAuth({ authorization: `Bearer ${expired}` }, { sessionId: 'sid-1' }, deps()),
      ),
    ).toBe('token_expired');
  });

  it('rejects every token when no public key is configured, in either mode', async () => {
    // Fail closed: an operator who set SH_REQUIRE_AUTH but forgot the keyset gets 401s, not a
    // deployment that quietly accepts nothing and runs everything ambiently.
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ keys: new Map() }),
        ),
      ),
    ).toBe('token_invalid');
  });

  it('rejects an api-scoped token — only a session token may drive a turn', async () => {
    const api = signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      ttlSeconds: 3600,
      now: NOW_S,
    });
    expect(
      await codeOf(() => resolveTurnAuth({ authorization: `Bearer ${api}` }, {}, deps())),
    ).toBe('token_invalid');
  });
});

describe('the one rule /turn enforces', () => {
  it('accepts a matching sessionId and derives the subject from the token', async () => {
    const auth = await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}` },
      { sessionId: 'sid-1' },
      deps(),
    );
    expect(auth).toEqual({
      subject: 'github:1234',
      sessionId: 'sid-1',
      credential: { mode: 'direct', value: 'sk-alice' }, // notsecret
      anthropicBaseUrl: 'https://litellm.internal/v1',
    });
  });

  it('400 session_mismatch when the body names a different session', async () => {
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'someone-elses' },
          deps(),
        ),
      ),
    ).toBe('session_mismatch');
  });

  it('uses token.sid when the body names no session', async () => {
    const auth = await resolveTurnAuth({ authorization: `Bearer ${sessionToken()}` }, {}, deps());
    expect(auth?.sessionId).toBe('sid-1');
  });

  it('performs no ownership lookup — it holds no ownership data (spec §4.3)', async () => {
    // Proved by there being no Redis or control-plane call other than the exchange itself.
    const { fetchImpl, calls } = fakeExchange({
      status: 200,
      body: {
        mode: 'direct',
        anthropicAuthToken: 'sk-alice', // notsecret
        anthropicBaseUrl: 'https://x/v1',
        sessionId: 'sid-1',
        subject: 'github:1234',
      },
    });
    await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}` },
      { sessionId: 'sid-1' },
      deps({ fetchImpl }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://cp.default.svc:8080/internal/credentials');
  });
});

describe('the subject is derived, never asserted', () => {
  it('ignores an inbound X-SH-Subject that agrees with the token', async () => {
    const auth = await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}`, 'x-sh-subject': 'github:1234' },
      { sessionId: 'sid-1' },
      deps(),
    );
    expect(auth?.subject).toBe('github:1234');
  });

  it('400 subject_conflict on a conflicting X-SH-Subject, rather than resolving by precedence', async () => {
    // A silent winner here is a cross-tenant bug waiting to be written (spec §3.5). P5 reads the
    // header, which is correct for a trusted orchestrator but spoofable once arbitrary users can call
    // the API -- so when a token is present, the token wins and a conflict is REJECTED.
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}`, 'x-sh-subject': 'github:9999' },
          { sessionId: 'sid-1' },
          deps(),
        ),
      ),
    ).toBe('subject_conflict');
  });

  it('leaves an inbound X-SH-Subject alone when there is no token (the operator path)', async () => {
    // The operator-driven and leaf paths keep P5's inbound-header behaviour; they are not
    // user-facing (spec §3.5).
    expect(
      await resolveTurnAuth({ 'x-sh-subject': 'github:9999' }, {}, deps({ requireAuth: false })),
    ).toBeNull();
  });
});

describe('the exchange hop', () => {
  it('presents the shared exchange token', async () => {
    const { fetchImpl, calls } = fakeExchange({
      status: 200,
      body: {
        mode: 'direct',
        anthropicAuthToken: 'sk-alice', // notsecret
        anthropicBaseUrl: 'https://x/v1',
        sessionId: 'sid-1',
        subject: 'github:1234',
      },
    });
    await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}` },
      { sessionId: 'sid-1' },
      deps({ fetchImpl }),
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer shared-abc'); // notsecret
  });

  it('503 credential_unavailable when the control plane is unreachable — NEVER an env fallback', async () => {
    // The single most important behaviour in the design (spec §9.2). §6 is scaffolding for it.
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    try {
      const { fetchImpl } = fakeExchange(new Error('ECONNREFUSED'));
      expect(
        await codeOf(() =>
          resolveTurnAuth(
            { authorization: `Bearer ${sessionToken()}` },
            { sessionId: 'sid-1' },
            deps({ fetchImpl }),
          ),
        ),
      ).toBe('credential_unavailable');
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('503 when no control-plane URL is configured at all', async () => {
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ controlPlaneUrl: undefined }),
        ),
      ),
    ).toBe('credential_unavailable');
  });

  it('propagates EVERY passthrough code, with the status statusFor gives it', async () => {
    // Iterating the exported set rather than restating four of its eight members: a hand-listed copy
    // covers whatever it happens to name and is silent about the rest, which is how half of PASSTHROUGH
    // came to be untested. Deriving the reply status from statusFor also means the fixture cannot drift
    // from the taxonomy.
    expect(PASSTHROUGH.size).toBeGreaterThan(0);
    for (const error of PASSTHROUGH) {
      const status = statusFor(error as CpErrorCode);
      const { fetchImpl } = fakeExchange({ status, body: { error } });
      expect(
        await codeOf(() =>
          resolveTurnAuth(
            { authorization: `Bearer ${sessionToken()}` },
            { sessionId: 'sid-1' },
            deps({ fetchImpl }),
          ),
        ),
        error,
      ).toBe(error);
    }
  });

  it('reports a rejected EXCHANGE as 503, not as the caller`s 401', async () => {
    // On /internal/credentials, `unauthorized` has exactly two sources -- checkExchangeAuth's shared
    // bearer and handlers.ts's defensive re-check -- and neither involves the caller. The user's own
    // token is checked separately inside exchangeCredential and fails as token_invalid /
    // token_expired / session_not_found. So `unauthorized` here means one thing: the harness cannot
    // authenticate to its own control plane, i.e. SH_EXCHANGE_TOKEN disagrees across the two tiers.
    //
    // Passing it through made that a 401 -- "your token is bad" -- so the user re-runs the device
    // flow, gets a brand-new token, and fails identically, while 5xx alerting sees nothing. It
    // belongs with its three neighbours: unreachable, non-JSON body and unknown mode are all 503.
    const { fetchImpl } = fakeExchange({ status: 401, body: { error: 'unauthorized' } });
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ fetchImpl }),
        ),
      ),
    ).toBe('credential_unavailable');
  });

  it('keeps the exchange status in the message, so the log still says what happened', async () => {
    // Reclassifying must not lose the diagnosis: whoever reads the harness log needs the 401.
    const { fetchImpl } = fakeExchange({ status: 401, body: { error: 'unauthorized' } });
    await expect(
      resolveTurnAuth(
        { authorization: `Bearer ${sessionToken()}` },
        { sessionId: 'sid-1' },
        deps({ fetchImpl }),
      ),
    ).rejects.toThrow(/401/);
  });

  it('excludes `unauthorized`, because every PASSTHROUGH member must be caller-attributable', () => {
    // The invariant that makes this set safe, pinned rather than left in a comment: a code belongs
    // here when the CALLER can act on it, not merely because the control plane can return it.
    expect(PASSTHROUGH.has('unauthorized')).toBe(false);
  });

  it('every PASSTHROUGH member is a real CP_ERROR_CODES code', async () => {
    // The assertion that makes a typo unshippable. A mistyped member is not a passthrough code at all:
    // it silently degrades that refusal to credential_unavailable, and if one ever reached statusFor,
    // `res.writeHead(undefined)` throws inside the error path and the caller gets a 500 with a
    // stringified error instead of the refusal the control plane sent.
    expect([...PASSTHROUGH].every((c) => CP_ERROR_CODES.includes(c as CpErrorCode))).toBe(true);
  });

  it('reduces an unrecognised failure body to credential_unavailable', async () => {
    const { fetchImpl } = fakeExchange({ status: 500, body: { oops: true } });
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ fetchImpl }),
        ),
      ),
    ).toBe('credential_unavailable');
  });

  it('refuses a reply with no base url, rather than passing undefined into TurnConfig', async () => {
    const { fetchImpl } = fakeExchange({
      status: 200,
      body: { mode: 'direct', anthropicAuthToken: 'sk-alice', sessionId: 'sid-1' }, // notsecret
    });
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ fetchImpl }),
        ),
      ),
    ).toBe('endpoint_unresolved');
  });

  it('refuses an unknown mode rather than guessing', async () => {
    // A mislabelled credential is exactly what the tag exists to prevent (spec §3.6); an unknown tag
    // must not default to `direct`, which would send a placeholder upstream as though it were real.
    const { fetchImpl } = fakeExchange({
      status: 200,
      body: {
        mode: 'whatever',
        anthropicAuthToken: 'x',
        anthropicBaseUrl: 'https://x/v1',
        sessionId: 'sid-1',
      },
    });
    expect(
      await codeOf(() =>
        resolveTurnAuth(
          { authorization: `Bearer ${sessionToken()}` },
          { sessionId: 'sid-1' },
          deps({ fetchImpl }),
        ),
      ),
    ).toBe('credential_unavailable');
  });

  it('carries a placeholder through with its tag intact', async () => {
    const { fetchImpl } = fakeExchange({
      status: 200,
      body: {
        mode: 'placeholder',
        anthropicAuthToken: 'sh-placeholder-github:1234',
        anthropicBaseUrl: 'https://x/v1',
        sessionId: 'sid-1',
      },
    });
    const auth = await resolveTurnAuth(
      { authorization: `Bearer ${sessionToken()}` },
      { sessionId: 'sid-1' },
      deps({ fetchImpl }),
    );
    expect(auth?.credential).toEqual({ mode: 'placeholder', value: 'sh-placeholder-github:1234' });
  });
});

describe('turnAuthDepsFromEnv', () => {
  it('is permissive by default and reads exactly `true` for the flag', () => {
    expect(turnAuthDepsFromEnv({}).requireAuth).toBe(false);
    expect(turnAuthDepsFromEnv({ SH_REQUIRE_AUTH: 'true' }).requireAuth).toBe(true);
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      expect(turnAuthDepsFromEnv({ SH_REQUIRE_AUTH: v }).requireAuth, v).toBe(false);
    }
  });

  it('parses the keyset and the control-plane wiring', () => {
    const d = turnAuthDepsFromEnv({
      SH_SESSION_TOKEN_PUBLIC_KEYS: KEYSET,
      SH_CONTROL_PLANE_URL: 'http://cp:8080',
      SH_EXCHANGE_TOKEN: 'shared-abc', // notsecret
    });
    expect(d.keys.size).toBe(1);
    expect(d.controlPlaneUrl).toBe('http://cp:8080');
  });

  it('yields an empty keyset when none is published, rather than throwing at startup', () => {
    // The permissive default must still boot on a deployment that has never heard of MU1 -- which is
    // every existing one. A malformed keyset, by contrast, is an operator error and does throw.
    expect(turnAuthDepsFromEnv({}).keys.size).toBe(0);
    expect(() => turnAuthDepsFromEnv({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' })).toThrow();
  });

  it('throws a TYPED refusal on a malformed keyset, not parseKeyset`s own Error', () => {
    // A bare `.toThrow()` above passes for either, which is how the raw throw shipped: it reached the
    // route's catch as `500 {"error":"Error: SH_SESSION_TOKEN_PUBLIC_KEYS entry ..."}`. The code is
    // what routes it to 503, and the fixed message is what keeps the entry text out of the reply.
    let err: unknown;
    try {
      turnAuthDepsFromEnv({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CpError);
    expect((err as CpError).code).toBe('credential_unavailable');
    expect(statusFor((err as CpError).code)).toBe(503);
    expect((err as CpError).message).not.toMatch(/garbage|base64|SPKI/);
  });

  it('rejects each of parseKeyset`s three failure modes, not just an unparseable entry', () => {
    // The rotation footgun the keyset design exists to support is the third one: publish the new key
    // alongside the old and forget to update the kid. All three must reach the same typed refusal.
    const { publicKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const raw of [
      'no-colon-at-all', // malformed entry
      `some-kid:${rsa.export({ format: 'der', type: 'spki' }).toString('base64')}`, // wrong curve
      `wrong-kid:${publicKeyToBase64(publicKey)}`, // a real Ed25519 key under the wrong kid
    ]) {
      expect(() => turnAuthDepsFromEnv({ SH_SESSION_TOKEN_PUBLIC_KEYS: raw }), raw).toThrow(
        CpError,
      );
    }
  });
});

describe('assertKeysetUsable', () => {
  it('rethrows parseKeyset`s own message, so the boot log names the bad entry', () => {
    // Deliberately NOT the typed refusal: this one is read by an operator in a container log, and the
    // whole point is that it says which entry is wrong. Only the per-request path must stay opaque.
    expect(() => assertKeysetUsable({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' })).toThrow(
      /SH_SESSION_TOKEN_PUBLIC_KEYS entry 'garbage'/,
    );
    expect(() => assertKeysetUsable({ SH_SESSION_TOKEN_PUBLIC_KEYS: 'garbage' })).not.toThrow(
      CpError,
    );
  });

  it('accepts an absent keyset, so every pre-MU1 deployment still boots', () => {
    expect(() => assertKeysetUsable({})).not.toThrow();
    expect(() => assertKeysetUsable({ SH_SESSION_TOKEN_PUBLIC_KEYS: '' })).not.toThrow();
  });
});

describe('runtimeFieldsForTurn', () => {
  it('reports pod identity from the environment Knative already provides', async () => {
    const fields = runtimeFieldsForTurn(
      { HOSTNAME: 'harness-abc', K_REVISION: 'moca-00003' },
      'start',
    );
    expect(fields).toMatchObject({
      harnessPod: 'harness-abc',
      revision: 'moca-00003',
    });
    expect(Number(fields.turnStartedAt)).toBeGreaterThan(0);
    expect(fields.turnEndedAt).toBeUndefined();
  });

  it('reports the pinned sandbox pod, else the pool selector (plan gap #5)', async () => {
    expect(runtimeFieldsForTurn({ KAGENTI_SANDBOX_POD: 'sandbox-0-0' }, 'start').sandboxPod).toBe(
      'sandbox-0-0',
    );
    expect(
      runtimeFieldsForTurn({ KAGENTI_SANDBOX_POOL_SELECTOR: 'a=b' }, 'start').sandboxSelector,
    ).toBe('a=b');
  });

  it('reports the end phase without re-stamping the start', async () => {
    const end = runtimeFieldsForTurn({}, 'end');
    expect(Number(end.turnEndedAt)).toBeGreaterThan(0);
    expect(end.turnStartedAt).toBeUndefined();
    expect(Number(end.lastTurnAt)).toBeGreaterThan(0);
  });

  it('omits a field the environment does not carry, rather than writing an empty string', async () => {
    expect(runtimeFieldsForTurn({}, 'start').harnessPod).toBeUndefined();
  });
});

describe('makeRuntimeReporter', () => {
  it('is a no-op when no Redis URL is configured, and never throws', async () => {
    await expect(
      makeRuntimeReporter(undefined)('sid-1', { harnessPod: 'p' }),
    ).resolves.toBeUndefined();
  });

  it('shares one reporter per URL, so a per-request deps build does not leak a connection', () => {
    // turnAuthDepsFromEnv runs on EVERY turn so an env change takes effect without a restart, and
    // makeRuntimeReporter memoises its Redis client inside the closure it returns. A fresh closure
    // per request would therefore open one connection per authenticated turn and close none.
    expect(sharedRuntimeReporter('redis://127.0.0.1:6379')).toBe(
      sharedRuntimeReporter('redis://127.0.0.1:6379'),
    );
    expect(sharedRuntimeReporter('redis://other:6379')).not.toBe(
      sharedRuntimeReporter('redis://127.0.0.1:6379'),
    );
    // The env-driven builder must hand out the shared one, not a fresh closure.
    const a = turnAuthDepsFromEnv({ REDIS_URL: 'redis://127.0.0.1:6379' });
    const b = turnAuthDepsFromEnv({ REDIS_URL: 'redis://127.0.0.1:6379' });
    expect(a.reportRuntime).toBe(b.reportRuntime);
  });

  it('retries after a transient connect failure, rather than permanently no-op-ing forever (fix round 1, Important 2)', async () => {
    // A shared, process-lifetime reporter (sharedRuntimeReporter) turned a per-request transient
    // failure into a permanent one unless the catch clears its memoised `ready`/`index` on error.
    // Each attempt gets its own fresh client (as the real code does), so `attempt` lives outside the
    // factory to observe both.
    let attempt = 0;
    const hSet = vi.fn(async () => undefined);
    vi.mocked(createClient).mockImplementation(
      () =>
        ({
          connect: vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('ECONNREFUSED');
          }),
          hSet,
        }) as unknown as ReturnType<typeof createClient>,
    );

    const reporter = makeRuntimeReporter('redis://127.0.0.1:6379');

    // First call: connect() rejects. Must resolve (display-only data must never fail a turn) and
    // must not write.
    await expect(reporter('sid-1', { harnessPod: 'p' })).resolves.toBeUndefined();
    expect(hSet).not.toHaveBeenCalled();

    // Second call: connect() succeeds this time. If the first failure's `ready`/`index` were left in
    // place instead of cleared, this call would still no-op forever.
    await reporter('sid-1', { harnessPod: 'p' });
    expect(attempt).toBe(2);
    expect(hSet).toHaveBeenCalledTimes(1);
  });

  describe('closes the client it discards', () => {
    // Clearing the memoised state is what makes the retry work, but the client it abandons was
    // block-scoped -- so nothing held it and nothing closed it. A flapping Redis then accumulated one
    // CONNECTED, still-reconnecting client per failure, each retrying on its own timer, in the very
    // function whose sibling comment is about not opening a connection per turn.
    //
    // destroy(), not quit(): quit() is deprecated in node-redis 6 and close() waits for pending
    // commands against a server that has just gone away. This client is being abandoned on a failure
    // path, so reject its commands immediately.
    const clientFactory = () => {
      const made: { destroy: ReturnType<typeof vi.fn>; connected: boolean }[] = [];
      const hSet = vi.fn(async () => undefined);
      let failConnect = false;
      vi.mocked(createClient).mockImplementation(() => {
        const rec = { destroy: vi.fn(), connected: false };
        made.push(rec);
        return {
          connect: vi.fn(async () => {
            if (failConnect) throw new Error('ECONNREFUSED');
            rec.connected = true;
          }),
          hSet,
          destroy: rec.destroy,
        } as unknown as ReturnType<typeof createClient>;
      });
      return { made, hSet, setFailConnect: (v: boolean) => (failConnect = v) };
    };

    it('destroys the client when a call fails AFTER connecting — the case that definitely leaks', async () => {
      const { made, hSet } = clientFactory();
      hSet.mockRejectedValueOnce(new Error('connection lost'));
      const reporter = makeRuntimeReporter('redis://127.0.0.1:6379');

      await expect(reporter('sid-1', { harnessPod: 'p' })).resolves.toBeUndefined();
      expect(made).toHaveLength(1);
      expect(made[0]!.connected).toBe(true);
      expect(made[0]!.destroy).toHaveBeenCalledTimes(1);

      // And the retry still builds a FRESH client rather than reusing the destroyed one.
      await reporter('sid-1', { harnessPod: 'p' });
      expect(made).toHaveLength(2);
      expect(made[1]!.destroy).not.toHaveBeenCalled();
    });

    it('destroys the client when connect() itself rejects', async () => {
      const { made, setFailConnect } = clientFactory();
      setFailConnect(true);
      const reporter = makeRuntimeReporter('redis://127.0.0.1:6379');

      await expect(reporter('sid-1', { harnessPod: 'p' })).resolves.toBeUndefined();
      expect(made[0]!.destroy).toHaveBeenCalledTimes(1);
    });

    it('accumulates no orphans across repeated flapping — one destroy per clearing', async () => {
      // The steady state the leak produced: one live client plus one orphan per flap, unbounded until
      // the pod died. Every client but the last must have been destroyed exactly once.
      const { made, hSet } = clientFactory();
      hSet.mockRejectedValue(new Error('connection lost'));
      const reporter = makeRuntimeReporter('redis://127.0.0.1:6379');

      for (let i = 0; i < 5; i++) await reporter('sid-1', { harnessPod: 'p' });

      expect(made).toHaveLength(5);
      for (const [i, c] of made.entries())
        expect(c.destroy, `client ${i}`).toHaveBeenCalledTimes(1);
    });

    it('survives a destroy() that throws, without failing the turn or blocking the retry', async () => {
      // destroy() throws on a client that is not open. Display-only data must never fail a turn, and
      // a throw inside the catch would both reject this promise and skip the state clearing.
      const { made, hSet, setFailConnect } = clientFactory();
      setFailConnect(true);
      const reporter = makeRuntimeReporter('redis://127.0.0.1:6379');
      vi.mocked(createClient).mockImplementationOnce(() => {
        const rec = {
          destroy: vi.fn(() => {
            throw new Error('client is not open');
          }),
          connected: false,
        };
        made.push(rec);
        return {
          connect: vi.fn(async () => {
            throw new Error('ECONNREFUSED');
          }),
          hSet,
          destroy: rec.destroy,
        } as unknown as ReturnType<typeof createClient>;
      });

      await expect(reporter('sid-1', { harnessPod: 'p' })).resolves.toBeUndefined();
      expect(made[0]!.destroy).toHaveBeenCalledTimes(1);
      // State was still cleared: the next call retries rather than awaiting the rejected `ready`.
      setFailConnect(false);
      await reporter('sid-1', { harnessPod: 'p' });
      expect(hSet).toHaveBeenCalled();
    });
  });
});
