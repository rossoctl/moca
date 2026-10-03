import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkExchangeAuth, exchangeCredential, placeholderFor } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { OwnershipIndex, type CpRedisLike } from '../src/ownership.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/** Create a session through the real handler and return its session token. */
async function sessionToken(d: CpDeps, id = 'sid-fixed'): Promise<string> {
  const res = await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
    ...d,
    newId: () => id,
  });
  return (res.body as { token: string }).token;
}

describe('checkExchangeAuth', () => {
  it('accepts the configured token', () => {
    expect(() => checkExchangeAuth('shared-abc', 'shared-abc')).not.toThrow(); // notsecret
  });

  it('rejects a wrong token', () => {
    expect(() => checkExchangeAuth('nope', 'shared-abc')).toThrow(
      // notsecret
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('rejects a same-length, different-content token via the constant-time compare', () => {
    // 'shared-xyz' and 'shared-abc' are both 10 characters, so this is the one case that actually
    // exercises `timingSafeEqual` rather than the `a.length !== b.length` shortcut immediately
    // before it (spec §5.3.1) -- deleting the timingSafeEqual term from that OR-expression would
    // leave every OTHER checkExchangeAuth test passing.
    expect(() => checkExchangeAuth('shared-xyz', 'shared-abc')).toThrow(
      // notsecret
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('rejects EVERY call when no token is configured — fail-closed, not fail-open', () => {
    // /internal/credentials hands out real credentials, so an unconfigured deployment must reject
    // everything rather than accept anything (spec §5.3.1, plan gap #3).
    expect(() => checkExchangeAuth('anything', undefined)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(() => checkExchangeAuth(undefined, undefined)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(() => checkExchangeAuth('', '')).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('never puts the presented value in the error', () => {
    // A request with the wrong token gets 401 and is NOT logged with the presented value (spec §5.3.1).
    try {
      checkExchangeAuth('super-secret-guess', 'shared-abc'); // notsecret
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-guess'); // notsecret
    }
  });
});

describe('placeholderFor', () => {
  it('is inert and names the subject', () => {
    expect(placeholderFor('github:1234')).toBe('sh-placeholder-github:1234');
  });

  it('differs per subject, so an injector can tell two tenants apart', () => {
    expect(placeholderFor('github:1')).not.toBe(placeholderFor('github:2'));
  });
});

describe('exchangeCredential', () => {
  let d: CpDeps;
  beforeEach(async () => {
    d = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: undefined }, // notsecret
    });
    await seedCredential(d); // github:1234 / my-anthropic, endpoint https://litellm.internal/v1
  });

  it('returns the subject`s own credential in direct mode when no injector is configured', async () => {
    const token = await sessionToken(d);
    expect(await exchangeCredential(token, d)).toEqual({
      mode: 'direct',
      anthropicAuthToken: 'sk-fake', // notsecret
      anthropicBaseUrl: 'https://litellm.internal/v1',
      sessionId: 'sid-fixed',
      subject: 'github:1234',
    });
  });

  it('returns a placeholder, not the real key, whenever the deployment has an injector', async () => {
    // Placeholder mode WINS whenever an injector exists, so adding one strictly NARROWS what the
    // harness may hold, and MU3 deletes direct mode outright (spec §3.6).
    const withInjector = makeDeps({
      credentials: d.credentials,
      index: d.index,
      signer: d.signer,
      verifyKeys: d.verifyKeys,
      config: { exchangeToken: 'shared-abc', injectorConfigured: true }, // notsecret
    });
    const token = await sessionToken(withInjector, 'sid-inj');
    const res = await exchangeCredential(token, withInjector);
    expect(res.mode).toBe('placeholder');
    expect(res.anthropicAuthToken).toBe('sh-placeholder-github:1234');
    expect(res.anthropicAuthToken).not.toContain('sk-fake'); // notsecret
  });

  it('rejects an api-scoped token — only a session token may drive a turn', async () => {
    // A valid session must exist for this sid, and the token must otherwise be a real session
    // token in every respect except its scope -- otherwise the missing-sid guard (exchange.ts:73)
    // would independently throw token_invalid for the same fixture, and removing the
    // requiredScope check from verifyToken would not make this test fail.
    await sessionToken(d);
    const api = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      sid: 'sid-fixed',
      ttlSeconds: 3600,
    });
    expect(await codeOf(() => exchangeCredential(api, d))).toBe('token_invalid');
  });

  it('rejects an expired token', async () => {
    const expired = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      sid: 'sid-fixed',
      ttlSeconds: 300,
      now: Math.floor(d.now() / 1000) - 400,
    });
    expect(await codeOf(() => exchangeCredential(expired, d))).toBe('token_expired');
  });

  it('rejects a token whose sid names no session', async () => {
    const orphan = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      sid: 'never-created',
      ttlSeconds: 300,
      now: Math.floor(d.now() / 1000),
    });
    expect(await codeOf(() => exchangeCredential(orphan, d))).toBe('session_not_found');
  });

  it('rejects a token with no sid at all', async () => {
    const noSid = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      ttlSeconds: 300,
    });
    expect(await codeOf(() => exchangeCredential(noSid, d))).toBe('token_invalid');
  });

  it("refuses a token whose subject is not the session's owner", async () => {
    // A valid token minted for Alice must not exchange against a session owned by Bob, even though
    // both facts are individually true (spec §8.1, session-drive row).
    const token = await sessionToken(d);
    const rec = (await d.index.get('sid-fixed'))!;
    await d.index.create({ ...rec, owner: 'github:9999' });
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('session_not_found');
  });

  it('refuses a tombstoned session, so a deleted session cannot start a new turn', async () => {
    const token = await sessionToken(d);
    await d.index.tombstone('sid-fixed');
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('session_not_found');
  });

  it('refuses when the recorded credential has since been deleted', async () => {
    // The second of the two policy points that make MU1 fail closed before P5's sentinel lands: the
    // exchange REFUSES rather than reaching for the deployment's own key (spec §3.5).
    const token = await sessionToken(d);
    await d.credentials.delete('github:1234', 'my-anthropic');
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('credential_required');
  });

  it('refuses with the deployment key present in the environment', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    try {
      const token = await sessionToken(d);
      await d.credentials.delete('github:1234', 'my-anthropic');
      expect(await codeOf(() => exchangeCredential(token, d))).toBe('credential_required');
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('falls back to the operator key only when explicitly allowed, and audits it', async () => {
    // The operator fallback RELOCATES rather than disappearing (spec §6.4): the decision is made by
    // the trusted tier, is attributable to a subject, and is logged -- never an env fallback in the
    // harness, where a control-plane bug would quietly borrow a neighbour's identity.
    const deps = makeDeps({
      withStreams: true,
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: 'sk-operator', // notsecret
        defaultInferenceEndpoint: 'https://default.gateway/v1',
      },
    });
    const streams = deps.streams;
    // A subject with no inference credential at all: the case the fallback exists for (#368).
    const token = await sessionToken(deps);
    const res = await exchangeCredential(token, deps);
    expect(res).toMatchObject({
      mode: 'direct',
      anthropicAuthToken: 'sk-operator', // notsecret
      anthropicBaseUrl: 'https://default.gateway/v1',
    });
    expect(
      (streams.get('sh:cp:audit') ?? []).some((r) => r.decision === 'operator_fallback_used'),
    ).toBe(true);
  });

  it('refuses when the fallback is allowed but no operator key is configured', async () => {
    // A session created on the fallback (no credential of its own), exchanged after the operator
    // key is gone: it has nothing to spend. (createSession needs the key to create one at all.)
    const fb = makeDeps({
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: 'sk-operator', // notsecret
        defaultInferenceEndpoint: 'https://default.gateway',
      },
    });
    const token = await sessionToken(fb);
    fb.config.operatorInferenceToken = undefined;
    let message = '';
    try {
      await exchangeCredential(token, fb);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code: string }).code).toBe('credential_required');
    }
    expect(message).toContain('started on the operator fallback');
  });

  it('resolves the base url from the credential, else the deployment default', async () => {
    const noEndpoint = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: 'https://fallback/v1' }, // notsecret
    });
    await seedCredential(noEndpoint, 'github:1234', 'my-anthropic', { endpoint: null });
    const res = await exchangeCredential(await sessionToken(noEndpoint), noEndpoint);
    expect(res.anthropicBaseUrl).toBe('https://fallback/v1');
  });

  it('REFUSES rather than returning an undefined base url', async () => {
    // If anthropicBaseUrl came back undefined, run-turn.ts:313's `||` would fall through to
    // process.env.ANTHROPIC_BASE_URL and, failing that, applyModelGateway would return a model
    // carrying Bearer <subject's token> with NO baseUrl override -- sending one user's gateway token
    // to the default Anthropic endpoint. That is a misdirected secret, not a degraded request
    // (spec §6.2, §9.2).
    const noBase = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    await seedCredential(noBase, 'github:1234', 'my-anthropic', { endpoint: null });
    expect(await codeOf(async () => exchangeCredential(await sessionToken(noBase), noBase))).toBe(
      'endpoint_unresolved',
    );
  });

  it('audits the issue by credential NAME, never by value', async () => {
    const deps = makeDeps({
      withStreams: true,
      config: { exchangeToken: 'shared-abc' }, // notsecret
    });
    const streams = deps.streams;
    await seedCredential(deps);
    await exchangeCredential(await sessionToken(deps), deps);
    const rows = streams.get('sh:cp:audit') ?? [];
    expect(
      rows.some((r) => r.decision === 'credential_issued' && r.credential === 'my-anthropic'),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-fake'); // notsecret
  });
});

describe('the exchangeCredential handler', () => {
  it('401s unless the router marked the request exchange-authorized', async () => {
    const d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    await seedCredential(d);
    const token = await sessionToken(d);
    expect(await codeOf(() => HANDLERS.exchangeCredential!(ctx({ body: { token } }), d))).toBe(
      'unauthorized',
    );
    await expect(
      HANDLERS.exchangeCredential!(ctx({ body: { token }, exchangeAuthorized: true }), d),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('requires a token in the body', async () => {
    const d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    expect(
      await codeOf(() =>
        HANDLERS.exchangeCredential!(ctx({ body: {}, exchangeAuthorized: true }), d),
      ),
    ).toBe('invalid_request');
  });
});

describe('readyz', () => {
  it('is ok when the index answers', async () => {
    const d = makeDeps();
    expect((await HANDLERS.readyz!(ctx(), d)).status).toBe(200);
  });

  it('503s when Redis is down, while /v1/credentials stays up', async () => {
    // Spec §9.2: Redis down => session routes 503, credentials keep working, because §7.1 put them in
    // different stores.
    const down = redisDown();
    expect(await codeOf(() => HANDLERS.readyz!(ctx(), down))).toBe('redis_unavailable');
    await expect(HANDLERS.listCredentials!(ctx({ principal: alice }), down)).resolves.toMatchObject(
      {
        status: 200,
      },
    );
  });

  it('answers redis_unavailable at once while the client is not ready, without touching the index', async () => {
    // A command issued while node-redis is disconnected waits in its offline queue forever, so a
    // readyz that awaited the index hung the probe instead of failing it (#423, spike finding F2).
    const get = vi.fn(async () => {
      throw new Error('index.get must not be called while Redis is not ready');
    });
    const d = makeDeps({
      index: { get } as unknown as OwnershipIndex,
      redisReady: () => false,
    });
    expect(await codeOf(() => HANDLERS.readyz!(ctx(), d))).toBe('redis_unavailable');
    expect(get).not.toHaveBeenCalled();
  });

  it('is ok when the client is ready and the index answers', async () => {
    const d = makeDeps({ redisReady: () => true });
    expect(await HANDLERS.readyz!(ctx(), d)).toEqual({ status: 200, body: 'ok' });
  });
});

/**
 * A CpDeps holding a REAL OwnershipIndex over a Redis client whose every command rejects, which is
 * what an outage actually looks like. Overriding the index's own methods instead -- as this suite used
 * to -- bypasses `OwnershipIndex.guard`, so the failures arrive as plain Errors and nothing ever
 * exercises the `redis_unavailable` mapping that §9.2's promise rests on. `xAdd` (the audit stream) is
 * down like everything else, on purpose: leaving it working is what let §9.2 look satisfied while
 * `putCredential` returned 503 in a real outage.
 */
function redisDown() {
  const boom = async (): Promise<never> => {
    throw new Error('ECONNREFUSED');
  };
  const dead = new Proxy({} as CpRedisLike, { get: () => boom });
  return makeDeps({ index: new OwnershipIndex(dead) });
}

describe('spec §9.2: the credential routes survive a Redis outage, the session routes do not', () => {
  // The write routes are the whole point of the promise: a user must be able to REPAIR a broken
  // credential while Redis is down. Both patch a Kubernetes Secret and then audit, and the audit is a
  // Redis write -- so before the best-effort catch in handlers.ts the Secret was written and the caller
  // was told 503, which is a status that lies about what happened. The old test exercised only
  // listCredentials, the one credential route that touches no Redis at all, so it could not fail here.
  let down: ReturnType<typeof redisDown>;
  let logged: string[];
  let restoreErr: typeof console.error;

  beforeEach(() => {
    down = redisDown();
    logged = [];
    restoreErr = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(' '));
  });
  afterEach(() => {
    console.error = restoreErr;
  });

  it('putCredential still succeeds, and says so out loud that the audit was lost', async () => {
    await expect(
      HANDLERS.putCredential!(
        ctx({
          principal: alice,
          params: { name: 'my-anthropic' },
          body: {
            kind: 'bearer',
            consumer: 'inference',
            destination: { hosts: ['litellm.internal'] },
            endpoint: 'https://litellm.internal/v1',
            secret: { token: 'sk-repair' }, // notsecret
          },
        }),
        down,
      ),
    ).resolves.toMatchObject({ status: 204 });
    // The Secret really was written -- the 204 is not a lie in the other direction either.
    expect((await down.credentials.list('github:1234')).map((d) => d.name)).toContain(
      'my-anthropic',
    );
    // The audit gap is discoverable, and the stored VALUE never reaches the log.
    expect(logged.join('\n')).toContain('putCredential');
    expect(logged.join('\n')).toContain('my-anthropic');
    expect(logged.join('\n')).not.toContain('sk-repair'); // notsecret
  });

  it('deleteCredential still succeeds', async () => {
    await seedCredential(down);
    await expect(
      HANDLERS.deleteCredential!(ctx({ principal: alice, params: { name: 'my-anthropic' } }), down),
    ).resolves.toMatchObject({ status: 204 });
    expect(await down.credentials.list('github:1234')).toEqual([]);
    expect(logged.join('\n')).toContain('deleteCredential');
  });

  it('but a SESSION route still 503s in the same outage — that half is spec-mandated', async () => {
    // The credential routes' availability must not have been bought by making `audit` best-effort
    // globally: a session route's own state lives in the Redis that is down, so 503 is the honest
    // answer there and this asserts it is still what happens.
    await seedCredential(down); // else createSession 400s on credential_required before Redis
    expect(
      await codeOf(() => HANDLERS.createSession!(ctx({ principal: alice, body: {} }), down)),
    ).toBe('redis_unavailable');
    expect(
      await codeOf(() =>
        HANDLERS.getSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), down),
      ),
    ).toBe('redis_unavailable');
  });
});
