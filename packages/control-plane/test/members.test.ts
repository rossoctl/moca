import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { MembersStore } from '../src/members.js';
import { ProvenanceStore, verifyExport } from '../src/provenance.js';
import { buildHandler } from '../src/server.js';
import { ctx, codeOf, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';
import type { TokenClaims } from '../src/token.js';

// Enrollment and roles through the API (enrollment and roles spec §3-§6).

const ENV_ADMIN = 'github:1';
const ALLOWED = 'github:2';
const CAROL = 'github:30';
const DAVE = 'github:40';

const who = (sub: string, roles: string[] = []): TokenClaims =>
  ({ sub, tenant: sub, roles, scope: ['api'] }) as unknown as TokenClaims;

let now = NOW_MS;
function setup(profile: 'sandbox' | 'harness' = 'sandbox'): TestDeps & {
  members: MembersStore;
  provenance: ProvenanceStore;
} {
  now = NOW_MS;
  const dir = mkdtempSync(join(tmpdir(), 'cp-members-'));
  const provenance = new ProvenanceStore({ dir, now: () => now });
  const members = new MembersStore({
    dir,
    provenance,
    bootstrap: { allowed: [ALLOWED], admins: [ENV_ADMIN] },
  });
  const d = makeDeps({
    now: () => now,
    provenance,
    members,
    config: {
      routeProfile: profile,
      sandbox: { allowedSubjects: [ALLOWED] } as never,
    },
  });
  return d as TestDeps & { members: MembersStore; provenance: ProvenanceStore };
}
const nowS = () => Math.floor(now / 1000);

/** The router's per-request step, as server.ts runs it, for handler-level tests. */
async function asRequest(d: ReturnType<typeof setup>, p: TokenClaims): Promise<TokenClaims> {
  return { ...p, ...(await d.members.membershipNow(p.sub, nowS())) };
}
const call = async (
  d: ReturnType<typeof setup>,
  op: string,
  p: TokenClaims,
  params: Record<string, string> = {},
  body?: unknown,
) => HANDLERS[op]!(ctx({ principal: await asRequest(d, p), params, body }), d);

describe('the bootstrap (spec §3)', () => {
  it('lists the settings subjects as env, and refuses a non-admin', async () => {
    const d = setup();
    const r = (await call(d, 'listSubjects', who(ENV_ADMIN))).body as { subjects: unknown[] };
    expect(r.subjects).toEqual([
      {
        subject: ENV_ADMIN,
        enrolled: true,
        source: 'env',
        storeEnrolled: false,
        roles: [{ role: 'admin', source: 'env', until: null, by: null }],
      },
      { subject: ALLOWED, enrolled: true, source: 'env', storeEnrolled: false, roles: [] },
    ]);
    expect(await codeOf(() => call(d, 'listSubjects', who(ALLOWED)))).toBe('forbidden');
  });

  it('refuses to unenroll or revoke a settings subject (409 bootstrap_subject)', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    expect(await codeOf(() => call(d, 'unenrollSubject', a, { subject: ALLOWED }))).toBe(
      'bootstrap_subject',
    );
    expect(await codeOf(() => call(d, 'unenrollSubject', a, { subject: ENV_ADMIN }))).toBe(
      'bootstrap_subject',
    );
    expect(await codeOf(() => call(d, 'revokeAdmin', a, { subject: ENV_ADMIN }))).toBe(
      'bootstrap_subject',
    );
    expect(await codeOf(() => call(d, 'grantAdmin', a, { subject: ENV_ADMIN }, {}))).toBe(
      'bootstrap_subject',
    );
  });

  it('answers an enroll of a settings subject unchanged, and writes no store enrollment', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    for (const subject of [ALLOWED, ENV_ADMIN]) {
      const r = (await call(d, 'enrollSubject', a, { subject }, { enrolled: true })).body as {
        source: string;
        storeEnrolled: boolean;
        record: string | null;
      };
      expect(r).toMatchObject({ source: 'env', storeEnrolled: false, record: null });
    }
    expect(await d.provenance.chain('members')).toEqual([]);
    // Once the settings drop ALLOWED, nothing in the store keeps it enrolled.
    const dropped = new MembersStore({
      dir: (d.members as unknown as { path: string }).path.replace(/\/members\.json$/, ''),
      provenance: d.provenance,
      bootstrap: { allowed: [], admins: [ENV_ADMIN] },
    });
    expect(await dropped.storeEnrolled(ALLOWED)).toBe(false);
    expect((await dropped.list(nowS())).map((v) => v.subject)).toEqual([ENV_ADMIN]);
  });

  it('shows the store enrollment apart from an admin role (storeEnrolled)', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    await call(d, 'grantAdmin', a, { subject: CAROL }, {});
    const view = async () =>
      (
        (await call(d, 'listSubjects', a)).body as { subjects: Record<string, unknown>[] }
      ).subjects.find((s) => s.subject === CAROL);
    // Enrolled by its role only: an enroll still has something to write.
    expect(await view()).toMatchObject({ enrolled: true, source: 'api', storeEnrolled: false });
    const r = (await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true })).body as {
      record: string | null;
    };
    expect(r.record).toMatch(/^sha256:/);
    expect(await view()).toMatchObject({ enrolled: true, storeEnrolled: true });
  });

  it('refuses a malformed subject and a missing store', async () => {
    const d = setup();
    expect(
      await codeOf(() =>
        call(d, 'enrollSubject', who(ENV_ADMIN), { subject: 'test:1' }, { enrolled: true }),
      ),
    ).toBe('invalid_request');
    const bare = makeDeps({
      config: { routeProfile: 'sandbox', sandbox: { allowedSubjects: [ALLOWED] } as never },
    });
    expect(
      await codeOf(() =>
        HANDLERS.listSubjects!(ctx({ principal: who(ENV_ADMIN, ['admin']) }), bare),
      ),
    ).toBe('invalid_request');
  });
});

describe('enroll and unenroll (spec §4)', () => {
  it('enrolls a subject at its next request, records it, and unenrolls it again', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    // Before: CAROL is refused on an enrolled-only route.
    expect(await codeOf(() => call(d, 'listTemplates', who(CAROL)))).toBe('not_enrolled');
    const r = (await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true })).body as {
      enrolled: boolean;
      source: string;
      record: string;
    };
    expect(r).toMatchObject({ enrolled: true, source: 'api' });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    // After: the same token (no new login) is let through.
    await call(d, 'listTemplates', who(CAROL));
    // Enrolling again changes nothing and writes nothing.
    const again = (await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true }))
      .body as { record: string | null };
    expect(again.record).toBeNull();
    const off = (await call(d, 'unenrollSubject', a, { subject: CAROL })).body as {
      enrolled: boolean;
      record: string;
    };
    expect(off.enrolled).toBe(false);
    expect(await codeOf(() => call(d, 'listTemplates', who(CAROL)))).toBe('not_enrolled');
    const chain = await d.provenance.chain('members');
    expect(chain.map((x) => [x.kind, x.subject, x.body])).toEqual([
      ['member', ENV_ADMIN, { subject: CAROL, enrolled: true, before: false }],
      ['member', ENV_ADMIN, { subject: CAROL, enrolled: false, before: true }],
    ]);
  });

  it('enrolls an oidc subject too (#701), and refuses what no provider mints', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    const ERIN = 'oidc:erin@example.test';
    expect(await codeOf(() => call(d, 'listTemplates', who(ERIN)))).toBe('not_enrolled');
    const r = (await call(d, 'enrollSubject', a, { subject: ERIN }, { enrolled: true })).body as {
      enrolled: boolean;
    };
    expect(r.enrolled).toBe(true);
    await call(d, 'listTemplates', who(ERIN));
    for (const bad of ['oidc:', 'oidc:a:b', 'oidc:-x', 'github:abc', 'gitlab:1', 'test:1']) {
      expect(
        await codeOf(() => call(d, 'enrollSubject', a, { subject: bad }, { enrolled: true })),
      ).toBe('invalid_request');
    }
  });

  it('refuses a body other than {enrolled: true}', async () => {
    const d = setup();
    expect(
      await codeOf(() =>
        call(d, 'enrollSubject', who(ENV_ADMIN), { subject: CAROL }, { enrolled: false }),
      ),
    ).toBe('invalid_request');
  });
});

describe('the admin role (spec §3, §6)', () => {
  it('grants admin by a settings admin, effective at the next request, and records who', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    // CAROL, holding a token minted with no roles, is an admin at its next request.
    expect((await asRequest(d, who(CAROL))).roles).toEqual(['admin']);
    const chain = await d.provenance.chain('members');
    expect(chain.map((x) => [x.subject, x.body.subject, x.body.state])).toEqual([
      [ENV_ADMIN, CAROL, 'granted'],
    ]);
    // An admin is enrolled by its role.
    await call(d, 'listTemplates', who(CAROL));
  });

  it('refuses every enrollment and role change by an API-granted admin (settings admins only)', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const asCarol = who(CAROL);
    // CAROL is an admin on every other admin route and may read the list ...
    await call(d, 'listSubjects', asCarol);
    // ... but changes nothing about who has access.
    for (const [op, args, body] of [
      ['grantAdmin', { subject: DAVE }, {}],
      ['revokeAdmin', { subject: CAROL }, undefined],
      ['enrollSubject', { subject: DAVE }, { enrolled: true }],
      ['unenrollSubject', { subject: ALLOWED }, undefined],
    ] as const) {
      expect(await codeOf(() => call(d, op, asCarol, args, body))).toBe('forbidden');
    }
    expect((await d.provenance.chain('members')).length).toBe(1);
  });

  it('revokes at the next request, and refuses a non-admin', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    expect(await codeOf(() => call(d, 'grantAdmin', who(DAVE), { subject: DAVE }, {}))).toBe(
      'not_enrolled',
    );
    await call(d, 'revokeAdmin', who(ENV_ADMIN), { subject: CAROL });
    expect((await asRequest(d, who(CAROL))).roles).toEqual([]);
    // A token minted with ['admin'] no longer counts: the per-request evaluation wins.
    expect((await asRequest(d, who(CAROL, ['admin']))).roles).toEqual([]);
    const last = (await d.provenance.chain('members')).at(-1)!;
    expect(last.body).toEqual({
      subject: CAROL,
      role: 'admin',
      state: 'revoked',
      before: 'granted',
    });
    // A settings admin's own role is the settings' (bootstrap_subject), so no admin can revoke itself.
    expect(await codeOf(() => call(d, 'revokeAdmin', who(ENV_ADMIN), { subject: ENV_ADMIN }))).toBe(
      'bootstrap_subject',
    );
  });

  it('refuses to unenroll a subject an admin grant keeps enrolled (409 admin_granted)', async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true });
    await call(d, 'grantAdmin', a, { subject: CAROL }, {});
    const before = (await d.provenance.chain('members')).length;
    expect(await codeOf(() => call(d, 'unenrollSubject', a, { subject: CAROL }))).toBe(
      'admin_granted',
    );
    expect((await d.provenance.chain('members')).length).toBe(before);
    // Revoke first, then the unenroll goes through and the subject is refused.
    await call(d, 'revokeAdmin', a, { subject: CAROL });
    await call(d, 'unenrollSubject', a, { subject: CAROL });
    expect(await codeOf(() => call(d, 'listTemplates', who(CAROL)))).toBe('not_enrolled');
  });

  it('refuses admin_granted under the store lock, for a grant that lands just before', async () => {
    const d = setup();
    const a = await asRequest(d, who(ENV_ADMIN));
    await call(d, 'enrollSubject', who(ENV_ADMIN), { subject: CAROL }, { enrolled: true });
    // Both started at once: the grant's change is queued first, so the unenroll sees it.
    const [grant, unenroll] = await Promise.allSettled([
      HANDLERS.grantAdmin!(ctx({ principal: a, params: { subject: CAROL }, body: {} }), d),
      HANDLERS.unenrollSubject!(ctx({ principal: a, params: { subject: CAROL } }), d),
    ]);
    expect(grant.status).toBe('fulfilled');
    expect(unenroll.status).toBe('rejected');
    expect((unenroll as PromiseRejectedResult).reason).toMatchObject({ code: 'admin_granted' });
    expect(await d.members.storeEnrolled(CAROL)).toBe(true);
  });

  it('lapses a grant at its until by itself, recording the expiry once', async () => {
    const d = setup();
    const until = nowS() + 60;
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, { until });
    expect((await asRequest(d, who(CAROL))).roles).toEqual(['admin']);
    now += 61_000;
    expect((await asRequest(d, who(CAROL))).roles).toEqual([]);
    expect((await asRequest(d, who(CAROL))).roles).toEqual([]);
    const chain = await d.provenance.chain('members');
    expect(chain.map((x) => x.body.state)).toEqual(['granted', 'expired']);
    expect(chain[1]).toMatchObject({
      kind: 'role',
      subject: 'control-plane',
      body: { subject: CAROL, role: 'admin', state: 'expired', until, before: 'granted' },
    });
    // The list no longer shows it, and CAROL (enrolled only by the role) is no longer enrolled.
    const list = (await call(d, 'listSubjects', who(ENV_ADMIN))).body as {
      subjects: { subject: string }[];
    };
    expect(list.subjects.map((s) => s.subject)).not.toContain(CAROL);
    expect(await codeOf(() => call(d, 'listTemplates', who(CAROL)))).toBe('not_enrolled');
  });

  it('refuses an until that is not a future whole number of seconds within 366 days', async () => {
    const d = setup();
    // Epoch milliseconds (a pasted Date.now()) and anything past 366 days are refused too.
    const max = nowS() + 366 * 86_400;
    for (const until of [nowS() - 1, nowS(), 1.5, 'tomorrow', now, max + 1]) {
      expect(
        await codeOf(() => call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, { until })),
      ).toBe('invalid_request');
    }
    const ok = (await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, { until: max }))
      .body as { roles: { until: number | null }[] };
    expect(ok.roles[0]!.until).toBe(max);
  });

  it('keeps a grant across a restart (a new store over the same directory)', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const again = new MembersStore({
      dir: (d.members as unknown as { path: string }).path.replace(/\/members\.json$/, ''),
      provenance: d.provenance,
      bootstrap: d.members.bootstrap,
    });
    expect(await again.rolesNow(CAROL, nowS())).toEqual(['admin']);
  });
});

describe('the members stream verifies offline (spec §4)', () => {
  it('is accepted by verifyExport and by verify-provenance.py', async () => {
    const d = setup();
    await call(d, 'enrollSubject', who(ENV_ADMIN), { subject: CAROL }, { enrolled: true });
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: DAVE }, { until: nowS() + 5 });
    now += 10_000;
    await asRequest(d, who(DAVE));
    const ex = JSON.parse(JSON.stringify(await d.provenance.export(['members'])));
    expect(ex.streams.map((h: { stream: string }) => h.stream)).toContain('members');
    expect(verifyExport(ex)).toMatchObject({ ok: true, errors: [] });
    const f = join(mkdtempSync(join(tmpdir(), 'cp-members-x-')), 'export.json');
    writeFileSync(f, JSON.stringify(ex));
    const script = join(__dirname, '../../../deploy/sbx/template-onboarding/verify-provenance.py');
    expect(() => execFileSync('python3', [script, f], { stdio: 'pipe' })).not.toThrow();
  });

  it('refuses a member record outside the members stream, and a template record in it', async () => {
    const d = setup();
    await expect(
      d.provenance.append({ stream: 'template/x', kind: 'member', subject: 'a', body: {} }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      d.provenance.append({ stream: 'members', kind: 'create', subject: 'a', body: {} }),
    ).rejects.toThrow(/does not belong/);
  });
});

describe('per-request evaluation from one read (spec §8)', () => {
  it('reads the store once per request, and not at all for a settings admin', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const reads = vi.spyOn(d.members, 'doc');
    expect(await d.members.membershipNow(CAROL, nowS())).toEqual({
      roles: ['admin'],
      enrolled: false,
    });
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    expect(await d.members.membershipNow(ENV_ADMIN, nowS())).toEqual({
      roles: ['admin'],
      enrolled: false,
    });
    expect(reads).not.toHaveBeenCalled();
  });

  it("still answers the settings' subjects when members.json can't be read; others fail closed", async () => {
    const d = setup();
    const a = who(ENV_ADMIN);
    await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true });
    await call(d, 'grantAdmin', a, { subject: ALLOWED }, {});
    const file = (d.members as unknown as { path: string }).path;
    writeFileSync(file, '{"members": {'); // truncated
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await d.members.membershipNow(ENV_ADMIN, nowS())).toEqual({
        roles: ['admin'],
        enrolled: false,
      });
      // The allow list still enrolls ALLOWED; its API grant doesn't count until the file is fixed.
      expect(await d.members.membershipNow(ALLOWED, nowS())).toEqual({
        roles: [],
        enrolled: false,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered from the settings'));
      await call(d, 'listTemplates', who(ALLOWED));
      await expect(d.members.membershipNow(CAROL, nowS())).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('per-request evaluation through the router (spec §3)', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it("replaces a token's roles with the subject's roles now", async () => {
    // The harness profile: its tokens carry the issuer the test signer mints under.
    const d = setup('harness');
    const server = createServer(buildHandler(d));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokenFor = (sub: string, roles: string[]) =>
      d.signer.mint({ sub, tenant: sub, roles, scope: ['api'], ttlSeconds: 900, now: nowS() });
    const get = (t: string) =>
      fetch(`${url}/v1/subjects`, { headers: { authorization: `Bearer ${t}` } });
    // A token claiming admin for a subject that holds no role is refused.
    expect((await get(tokenFor(CAROL, ['admin']))).status).toBe(403);
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    // The same subject, with a token minted with NO roles, is now an admin.
    expect((await get(tokenFor(CAROL, []))).status).toBe(200);
  });
});

describe('the wiring (main.ts)', () => {
  it('builds a members store with the settings as its bootstrap, only with SH_PROVENANCE_DIR', async () => {
    const { templateCatalogFromEnv } = await import('../src/main.js');
    const dir = mkdtempSync(join(tmpdir(), 'cp-members-main-'));
    const config = { sandbox: { allowedSubjects: [ALLOWED] } } as never;
    const built = templateCatalogFromEnv(
      { SH_PROVENANCE_DIR: dir, SH_ADMIN_SUBJECTS: ENV_ADMIN } as NodeJS.ProcessEnv,
      config,
    );
    expect(built.members?.bootstrap).toEqual({ allowed: [ALLOWED], admins: [ENV_ADMIN] });
    expect(templateCatalogFromEnv({} as NodeJS.ProcessEnv, config).members).toBeUndefined();
  });
});
