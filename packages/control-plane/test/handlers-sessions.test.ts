import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleKey, DEFAULT_BUNDLE_TTL_SECONDS } from '@moca/config-bundle';
import { BUNDLES_ALL_KEY, recordBundle } from '../src/bundle-budget.js';
// Fixtures live in test/helpers so five test files share one set (created in Step 1 below).
import { fakeRedis } from './helpers/fake-redis.js';
import {
  makeDeps,
  ctx,
  alice,
  bob,
  admin,
  codeOf,
  seedBundle,
  seedCredential,
  type TestDeps,
} from './helpers/deps.js';
import { OwnershipIndex } from '../src/ownership.js';
import { HANDLERS, assertOwner } from '../src/handlers.js';
import { publicKeyFromBase64, verifyToken } from '../src/token.js';
import { StubIdentity } from './helpers/stub-identity.js';
import { NOW_MS } from './helpers/deps.js';

describe('the device-flow handlers', () => {
  it('starts a flow and returns what the operator must type', async () => {
    const d = makeDeps();
    const res = await HANDLERS.startDeviceAuth!(ctx(), d);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userCode: 'WDJB-MJHT', interval: 5 });
  });

  it('exchanges a device code for an api-scoped token carrying the subject and roles', async () => {
    const d = makeDeps({
      identity: new StubIdentity({
        subject: 'github:1234',
        displayName: 'Alice',
        roles: ['admin'],
      }),
    });
    const res = await HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'dc-1' } }), d);
    expect(res.status).toBe(200);
    const body = res.body as { token: string; subject: string; expiresAt: number };
    expect(body.subject).toBe('github:1234');
    const claims = verifyToken(
      body.token,
      new Map([[d.signer.kid, publicKeyFromBase64(d.publicKeyBase64)]]),
      { now: Math.floor(NOW_MS / 1000), requiredScope: 'api' },
    );
    expect(claims.roles).toEqual(['admin']);
    expect(claims.sid).toBeUndefined(); // an api token names no session
    expect(body.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 3600);
  });

  it('requires a deviceCode', async () => {
    expect(await codeOf(() => HANDLERS.completeDeviceAuth!(ctx({ body: {} }), makeDeps()))).toBe(
      'invalid_request',
    );
  });

  it('propagates authorization_pending so the client keeps polling', async () => {
    const pending = Object.assign(new Error('pending'), { code: 'authorization_pending' });
    const d = makeDeps({ identity: new StubIdentity(pending as never) });
    await expect(HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'x' } }), d)).rejects.toBe(
      pending,
    );
  });
});

describe('GET /v1/me', () => {
  it('returns the subject, display name and roles from the token', async () => {
    const res = await HANDLERS.getMe!(ctx({ principal: admin }), makeDeps());
    expect(res.body).toEqual({ subject: 'github:1', tenant: 'github:1', roles: ['admin'] });
  });

  it('needs a principal', async () => {
    expect(await codeOf(() => HANDLERS.getMe!(ctx(), makeDeps()))).toBe('token_required');
  });
});

describe('POST /v1/sessions', () => {
  let d: TestDeps;
  beforeEach(() => {
    d = makeDeps();
  });

  it('creates an ownership record and returns a session token bound to it', async () => {
    await seedCredential(d);
    const res = await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    expect(res.status).toBe(201);
    const body = res.body as { sessionId: string; token: string; expiresAt: number };
    expect(body.sessionId).toBe('sid-fixed');
    expect(body.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 300);
    const rec = await d.index.get('sid-fixed');
    expect(rec).toMatchObject({
      owner: 'github:1234',
      tenant: 'github:1234',
      state: 'active',
      credentialName: 'my-anthropic',
      tombstone: false,
    });
  });

  it('records the chosen credential so the exchange does not re-resolve it per turn', async () => {
    await seedCredential(d, 'github:1234', 'a');
    await seedCredential(d, 'github:1234', 'b');
    const res = await HANDLERS.createSession!(
      ctx({ principal: alice, body: { credentials: { inference: 'b' } } }),
      d,
    );
    expect((res.body as { sessionId: string }).sessionId).toBe('sid-fixed');
    expect((await d.index.get('sid-fixed'))?.credentialName).toBe('b');
  });

  it('refuses a subject with no inference credential, even with the deployment key in the env', async () => {
    // §9.3 test 1, policy phase: with ANTHROPIC_AUTH_TOKEN set in the environment, session creation
    // for a credential-less subject must still fail -- so the ambient value is never what a session
    // runs on. Tightens to the process version once P5's sentinel lands (spec §3.5).
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    try {
      expect(
        await codeOf(() => HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d)),
      ).toBe('credential_required');
      expect(await d.index.get('sid-fixed')).toBeNull(); // and no record was left behind
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('refuses to pick when the subject has several and names none', async () => {
    await seedCredential(d, 'github:1234', 'a');
    await seedCredential(d, 'github:1234', 'b');
    expect(
      await codeOf(() => HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d)),
    ).toBe('credential_ambiguous');
  });

  it('accepts an absent body', async () => {
    await seedCredential(d);
    await expect(
      HANDLERS.createSession!(ctx({ principal: alice, body: undefined }), d),
    ).resolves.toMatchObject({ status: 201 });
  });

  it('audits the creation with the credential NAME', async () => {
    const f = fakeRedis();
    const d2 = makeDeps({ index: new OwnershipIndex(f.redis) });
    await seedCredential(d2);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d2);
    const rows = f.streams.get('sh:cp:audit') ?? [];
    expect(
      rows.some((r) => r.decision === 'session_created' && r.credential === 'my-anthropic'),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-fake'); // notsecret
  });

  describe('the sandbox tier (P6.3 spec §3.3)', () => {
    const tiered = () =>
      makeDeps({
        config: { sandboxTiers: { names: ['container', 'microvm'], default: 'container' } },
      });

    it('stores the requested tier', async () => {
      const t = tiered();
      await seedCredential(t);
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        t,
      );
      expect((await t.index.get('sid-fixed'))?.sandboxTier).toBe('microvm');
    });

    it('stores the default when none is requested, so a later default change does not move the session', async () => {
      const t = tiered();
      await seedCredential(t);
      await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), t);
      expect((await t.index.get('sid-fixed'))?.sandboxTier).toBe('container');
    });

    it('400s an undeclared tier, naming the declared ones, and creates nothing', async () => {
      const t = tiered();
      await seedCredential(t);
      const err = (await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'gpu' } } }),
        t,
      ).catch((e: unknown) => e)) as { code: string; message: string };
      expect(err.code).toBe('invalid_request');
      expect(err.message).toContain("'gpu'");
      expect(err.message).toContain('container, microvm');
      expect(await t.index.get('sid-fixed')).toBeNull();
    });

    it('400s a non-string tier', async () => {
      const t = tiered();
      await seedCredential(t);
      expect(
        await codeOf(() =>
          HANDLERS.createSession!(ctx({ principal: alice, body: { sandbox: { tier: 7 } } }), t),
        ),
      ).toBe('invalid_request');
    });

    it('400s a non-object sandbox (string or array)', async () => {
      const t = tiered();
      await seedCredential(t);
      expect(
        await codeOf(() =>
          HANDLERS.createSession!(ctx({ principal: alice, body: { sandbox: 'microvm' } }), t),
        ),
      ).toBe('invalid_request');
      expect(
        await codeOf(() =>
          HANDLERS.createSession!(ctx({ principal: alice, body: { sandbox: ['microvm'] } }), t),
        ),
      ).toBe('invalid_request');
    });

    it('400s any tier on a deployment that declares none, and stores "" otherwise', async () => {
      await seedCredential(d);
      const err = (await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        d,
      ).catch((e: unknown) => e)) as { code: string; message: string };
      expect(err.code).toBe('invalid_request');
      expect(err.message).toContain('declares no sandbox tiers');
      await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
      expect((await d.index.get('sid-fixed'))?.sandboxTier).toBe('');
    });

    it('a session view carries the tier', async () => {
      const t = tiered();
      await seedCredential(t);
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        t,
      );
      const page = await HANDLERS.listSessions!(ctx({ principal: alice }), t);
      const [s] = (page.body as { sessions: { sandboxTier: string | null }[] }).sessions;
      expect(s.sandboxTier).toBe('microvm');
    });

    it("a pre-P6.3 record (no sandboxTier field) shows today's default in the view", async () => {
      // Created as 'microvm', so the stored value DIFFERS from today's default: the view can show
      // 'container' only through sessionTier's fallback for a missing field, never by echoing the
      // record. The field is deleted from the store outright -- hSet merges, so overwriting the hash
      // without it would leave the stored tier in place.
      const f = fakeRedis();
      const t = makeDeps({
        index: new OwnershipIndex(f.redis),
        config: { sandboxTiers: { names: ['container', 'microvm'], default: 'container' } },
      });
      await seedCredential(t);
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        t,
      );
      delete f.hashes.get('sh:cp:session:sid-fixed')!.sandboxTier;
      expect((await t.index.get('sid-fixed'))!.sandboxTier).toBeUndefined();
      const page = await HANDLERS.listSessions!(ctx({ principal: alice }), t);
      const [s] = (page.body as { sessions: { sandboxTier: string | null }[] }).sessions;
      expect(s.sandboxTier).toBe('container');
    });

    it("a record stored with '' shows today's default on a tiered deployment", async () => {
      // '' means "created while no tiers were declared". The exchange leaves the tier out for it,
      // and the data plane gives it the deployment default (harness select-sandbox), so that is
      // the tier the view must show -- not null.
      const f = fakeRedis();
      const t = makeDeps({
        index: new OwnershipIndex(f.redis),
        config: { sandboxTiers: { names: ['container', 'microvm'], default: 'container' } },
      });
      await seedCredential(t);
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        t,
      );
      f.hashes.get('sh:cp:session:sid-fixed')!.sandboxTier = '';
      expect((await t.index.get('sid-fixed'))!.sandboxTier).toBe('');
      const page = await HANDLERS.listSessions!(ctx({ principal: alice }), t);
      const [s] = (page.body as { sessions: { sandboxTier: string | null }[] }).sessions;
      expect(s.sandboxTier).toBe('container');
    });

    it('a session created while no tiers were declared shows null in the view', async () => {
      await seedCredential(d);
      await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
      const page = await HANDLERS.listSessions!(ctx({ principal: alice }), d);
      const [s] = (page.body as { sessions: { sandboxTier: string | null }[] }).sessions;
      expect(s.sandboxTier).toBeNull();
    });

    it('a tier stored while tiers were declared shows null in the list and get views once the deployment declares none', async () => {
      // The record still says 'microvm', but an untiered data plane no longer filters on it: the
      // views must go through viewTier, never read rec.sandboxTier directly.
      const t = tiered();
      await seedCredential(t);
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { tier: 'microvm' } } }),
        t,
      );
      expect((await t.index.get('sid-fixed'))?.sandboxTier).toBe('microvm');
      const untiered = { ...t, config: { ...t.config, sandboxTiers: null } };
      const page = await HANDLERS.listSessions!(ctx({ principal: alice }), untiered);
      const [s] = (page.body as { sessions: { sandboxTier: string | null }[] }).sessions;
      expect(s.sandboxTier).toBeNull();
      const one = await HANDLERS.getSession!(
        ctx({ principal: alice, params: { id: 'sid-fixed' } }),
        untiered,
      );
      expect((one.body as { sandboxTier: string | null }).sandboxTier).toBeNull();
    });
  });
});

describe('GET /v1/sessions', () => {
  it("returns only the caller's sessions", async () => {
    const d = makeDeps();
    await seedCredential(d, 'github:1234');
    await seedCredential(d, 'github:9999');
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
      ...d,
      newId: () => 'a-1',
    });
    await HANDLERS.createSession!(ctx({ principal: bob, body: {} }), { ...d, newId: () => 'b-1' });
    const res = await HANDLERS.listSessions!(ctx({ principal: alice }), d);
    const ids = (res.body as { sessions: { sessionId: string }[] }).sessions.map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual(['a-1']);
  });

  it('exposes limit and cursor and echoes nextCursor', async () => {
    const d = makeDeps();
    await seedCredential(d);
    let t = NOW_MS;
    for (const id of ['s1', 's2', 's3']) {
      await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
        ...d,
        newId: () => id,
        now: () => (t += 1000),
      });
    }
    const first = await HANDLERS.listSessions!(
      ctx({ principal: alice, query: new URLSearchParams('limit=2') }),
      d,
    );
    const firstBody = first.body as {
      sessions: { sessionId: string }[];
      nextCursor: number | null;
    };
    expect(firstBody.sessions.map((s) => s.sessionId)).toEqual(['s3', 's2']);
    expect(firstBody.nextCursor).not.toBeNull();
  });

  it('403s a non-admin passing ?owner=, and honours it for an admin', async () => {
    // 403, not 404: this is "authenticated but insufficiently privileged on a resource you may know
    // exists", which is exactly what 403 is reserved for (spec §8.1).
    const d = makeDeps();
    await seedCredential(d, 'github:1234');
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
      ...d,
      newId: () => 'a-1',
    });
    expect(
      await codeOf(() =>
        HANDLERS.listSessions!(
          ctx({ principal: bob, query: new URLSearchParams('owner=github:1234') }),
          d,
        ),
      ),
    ).toBe('forbidden');
    const asAdmin = await HANDLERS.listSessions!(
      ctx({ principal: admin, query: new URLSearchParams('owner=github:1234') }),
      d,
    );
    expect((asAdmin.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('rejects a non-numeric limit rather than paging by NaN', async () => {
    const d = makeDeps();
    expect(
      await codeOf(() =>
        HANDLERS.listSessions!(
          ctx({ principal: alice, query: new URLSearchParams('limit=abc') }),
          d,
        ),
      ),
    ).toBe('invalid_request');
    expect(
      await codeOf(() =>
        HANDLERS.listSessions!(
          ctx({ principal: alice, query: new URLSearchParams('cursor=abc') }),
          d,
        ),
      ),
    ).toBe('invalid_request');
  });
});

describe('assertOwner', () => {
  it('returns the record for its owner', async () => {
    const d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    expect((await assertOwner('sid-fixed', alice, d)).owner).toBe('github:1234');
  });

  it('404s a non-owner, so a 403 cannot act as an existence oracle', async () => {
    const d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    expect(await codeOf(() => assertOwner('sid-fixed', bob, d))).toBe('session_not_found');
  });

  it('404s an unknown session with the SAME code, so the two are indistinguishable', async () => {
    const d = makeDeps();
    expect(await codeOf(() => assertOwner('never-existed', bob, d))).toBe('session_not_found');
  });

  it('does not grant an admin implicit access to another user`s session', async () => {
    // Admin gates ?owner= on the LIST route only (spec §4.1). Reading another user's session body is
    // a separate privilege MU1 does not grant, and quietly folding it in here would make every
    // future authz rule ambiguous.
    const d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    expect(await codeOf(() => assertOwner('sid-fixed', admin, d))).toBe('session_not_found');
  });

  it('401s with no principal at all', async () => {
    expect(await codeOf(() => assertOwner('sid-fixed', undefined, makeDeps()))).toBe(
      'token_required',
    );
  });
});

describe('GET and DELETE /v1/sessions/{id}, POST .../token', () => {
  let d: TestDeps;
  beforeEach(async () => {
    d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
  });

  it('returns owner, timestamps, state and turn count', async () => {
    const res = await HANDLERS.getSession!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect(res.body).toMatchObject({
      sessionId: 'sid-fixed',
      owner: 'github:1234',
      state: 'active',
      createdAt: NOW_MS,
      turns: 0,
    });
  });

  it("grows the summary's turn count as turns complete, rather than reporting 0 forever (#420)", async () => {
    // `turns` was read here and allow-listed for the runtime hash, but no writer existed, so every
    // real deployment reported 0. This is the end-to-end shape the issue asks for: what the data
    // plane's reporter calls on turn end must be what this summary shows.
    const summary = async () =>
      (
        (await HANDLERS.getSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d))
          .body as { turns: number }
      ).turns;
    expect(await summary()).toBe(0);
    await d.index.bumpTurns('sid-fixed');
    expect(await summary()).toBe(1);
    await d.index.bumpTurns('sid-fixed');
    expect(await summary()).toBe(2);
  });

  it('re-mints a session token, because a session outlives a 5-minute token', async () => {
    const res = await HANDLERS.mintSessionToken!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    const body = res.body as { token: string; expiresAt: number };
    expect(body.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 300);
    const keys = new Map([[d.signer.kid, publicKeyFromBase64(d.publicKeyBase64)]]);
    expect(
      verifyToken(body.token, keys, {
        now: Math.floor(NOW_MS / 1000),
        requiredScope: 'turn:write',
      }).sid,
    ).toBe('sid-fixed');
  });

  it('refuses to re-mint for a tombstoned session', async () => {
    await d.index.tombstone('sid-fixed');
    expect(
      await codeOf(() =>
        HANDLERS.mintSessionToken!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d),
      ),
    ).toBe('session_not_found');
  });

  it('returns 204 for an idle session and leaves nothing visible', async () => {
    const res = await HANDLERS.deleteSession!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect(res.status).toBe(204);
    expect(await d.index.get('sid-fixed')).toBeNull();
    expect((await d.index.listByOwner('github:1234')).sessions).toEqual([]);
  });

  it('returns 202 when a turn is in flight, rather than pretending a sync delete happened', async () => {
    // A best-effort hint from the runtime hash (plan gap #11): wrong only changes the status code.
    await d.index.putRuntime('sid-fixed', { turnStartedAt: String(NOW_MS) });
    expect(
      (await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d))
        .status,
    ).toBe(202);
  });

  it('returns 204 when the last turn already ended', async () => {
    await d.index.putRuntime('sid-fixed', {
      turnStartedAt: String(NOW_MS - 2000),
      turnEndedAt: String(NOW_MS - 1000),
    });
    expect(
      (await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d))
        .status,
    ).toBe(204);
  });

  it('sets the tombstone BEFORE it deletes, so no new turn can start', async () => {
    // Final state is identical under either ordering -- the hash is gone either way -- so asserting it
    // proved nothing about the order. fakeRedis records an ordered `ops` array; use it. The order is
    // the property: tombstone-then-delete closes the window in which an in-flight turn could start a
    // new one, and delete-then-tombstone leaves it open.
    const f = fakeRedis();
    const d2 = makeDeps({ index: new OwnershipIndex(f.redis) });
    await seedCredential(d2);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d2);
    await d2.index.putRuntime('sid-fixed', { turnStartedAt: String(NOW_MS) });
    const before = f.ops.length;
    await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: 'sid-fixed' } }), d2);
    const ops = f.ops.slice(before);
    const firstHSet = ops.findIndex((o) => o.startsWith('hSet '));
    const firstDel = ops.findIndex((o) => o.startsWith('del '));
    expect(firstHSet, `no tombstone write in ${ops.join(' -> ')}`).toBeGreaterThanOrEqual(0);
    expect(firstDel, `no delete in ${ops.join(' -> ')}`).toBeGreaterThanOrEqual(0);
    expect(firstHSet, ops.join(' -> ')).toBeLessThan(firstDel);
    // ...and the delete really did happen, so the ordering assertion is not standing alone.
    expect(await d2.index.get('sid-fixed')).toBeNull();
  });

  it('404s every session route for a non-owner', async () => {
    for (const op of ['getSession', 'deleteSession', 'mintSessionToken']) {
      expect(
        await codeOf(() => HANDLERS[op]!(ctx({ principal: bob, params: { id: 'sid-fixed' } }), d)),
        op,
      ).toBe('session_not_found');
    }
  });
});

describe('POST /v1/sessions configRef', () => {
  const digest = 'sha256:' + 'e'.repeat(64);

  it('records configRef and returns it from getSession and listSessions', async () => {
    const d = makeDeps();
    await seedCredential(d);
    seedBundle(d, digest);
    await HANDLERS.createSession!(ctx({ principal: alice, body: { configRef: digest } }), d);
    expect((await d.index.get('sid-fixed'))!.configRef).toBe(digest);
    const got = await HANDLERS.getSession!(
      ctx({ principal: alice, params: { id: 'sid-fixed' } }),
      d,
    );
    expect((got.body as { configRef: string | null }).configRef).toBe(digest);
    const list = await HANDLERS.listSessions!(ctx({ principal: alice }), d);
    expect((list.body as { sessions: { configRef: string | null }[] }).sessions[0]!.configRef).toBe(
      digest,
    );
  });

  it('records null when no configRef is given', async () => {
    const d = makeDeps();
    await seedCredential(d);
    await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), d);
    expect((await d.index.get('sid-fixed'))!.configRef).toBeNull();
  });

  it('refuses a malformed configRef with configRef_invalid and creates nothing', async () => {
    const d = makeDeps();
    await seedCredential(d);
    for (const configRef of ['', 'sha256:short', 42]) {
      expect(
        await codeOf(() =>
          HANDLERS.createSession!(ctx({ principal: alice, body: { configRef } }), d),
        ),
      ).toBe('configRef_invalid');
    }
    expect(await d.index.get('sid-fixed')).toBeNull();
  });

  it('validates configRef before looking up credentials', async () => {
    const d = makeDeps();
    const list = vi.spyOn(d.credentials, 'list');
    expect(
      await codeOf(() =>
        HANDLERS.createSession!(ctx({ principal: alice, body: { configRef: 'nope' } }), d),
      ),
    ).toBe('configRef_invalid');
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses a well-formed digest that was never uploaded, and creates nothing', async () => {
    const d = makeDeps();
    await seedCredential(d);
    await expect(
      HANDLERS.createSession!(ctx({ principal: alice, body: { configRef: digest } }), d),
    ).rejects.toMatchObject({
      code: 'config_bundle_not_found',
      message: 'no config bundle with that digest — promote the directory first',
    });
    expect(await d.index.get('sid-fixed')).toBeNull();
  });

  it('refreshes the bundle TTL and its budget expiry when a session adopts it', async () => {
    const d = makeDeps();
    await seedCredential(d);
    seedBundle(d, digest);
    await recordBundle(d.bundles, alice.sub, digest, 10, NOW_MS - 5000);
    const fake = d.bundles as unknown as {
      expires: { key: string; seconds: number }[];
      zsets: Map<string, Map<string, number>>;
    };
    fake.expires.length = 0;
    await HANDLERS.createSession!(ctx({ principal: alice, body: { configRef: digest } }), d);
    expect(fake.expires).toContainEqual({
      key: bundleKey(digest),
      seconds: DEFAULT_BUNDLE_TTL_SECONDS,
    });
    expect(fake.zsets.get(BUNDLES_ALL_KEY)!.get(digest)).toBe(
      NOW_MS + DEFAULT_BUNDLE_TTL_SECONDS * 1000,
    );
  });
});
