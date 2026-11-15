import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  mkdtempSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { MembersStore } from '../src/members.js';
import { DEFAULT_POLICY, type Policy } from '../src/template-policy.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
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
function setup(profile: 'sandbox' | 'harness' | 'combined' = 'sandbox'): TestDeps & {
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

  it("refuses an API-granted admin's policy change that widens trust, registries or repositories", async () => {
    const d = setup();
    const policy = new FilePolicyStore({
      dir: mkdtempSync(join(tmpdir(), 'cp-pol-')),
      provenance: d.provenance,
    });
    const base: Policy = {
      ...DEFAULT_POLICY,
      allowedRegistries: ['<default>', 'docker.io'],
      allowedRepositories: { 'docker.io': ['library/python'] },
      trustedGateRecords: [`sha256:${'a'.repeat(64)}`],
    };
    await policy.set(base, ENV_ADMIN);
    (d as { policy?: FilePolicyStore }).policy = policy;
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const put = (p: TokenClaims, body: Policy) => call(d, 'putPolicy', p, {}, body);
    // Each widening, by CAROL (an admin by an API grant): refused, the policy unchanged.
    for (const wider of [
      { ...base, trustedGateRecords: [...base.trustedGateRecords, `sha256:${'b'.repeat(64)}`] },
      { ...base, allowedRegistries: [...base.allowedRegistries, 'quay.io'] },
      { ...base, allowedRepositories: { 'docker.io': ['library/python', 'library/node'] } },
      { ...base, allowedRepositories: {} },
      // A second key in another case: the registry's list is the union of both, so it widens,
      // whichever key comes first.
      {
        ...base,
        allowedRepositories: { 'docker.io': ['library/python'], 'DOCKER.IO': ['library/node'] },
      },
      {
        ...base,
        allowedRepositories: { 'DOCKER.IO': ['library/node'], 'docker.io': ['library/python'] },
      },
    ]) {
      expect(await codeOf(() => put(who(CAROL), wider))).toBe('forbidden');
      expect((await policy.current()).policy).toEqual(base);
    }
    // Narrowing and quotas are CAROL's to change.
    const narrower = {
      ...base,
      trustedGateRecords: [],
      allowedRegistries: ['<default>', 'DOCKER.IO'],
      quota: { ...base.quota, templates: base.quota.templates + 1 },
    };
    await put(who(CAROL), narrower);
    expect((await policy.current()).policy.trustedGateRecords).toEqual([]);
    // A settings admin widens it again.
    await put(who(ENV_ADMIN), base);
    expect((await policy.current()).policy.trustedGateRecords).toEqual(base.trustedGateRecords);
  });

  it("refuses an API-granted admin's policy change that adds or loosens a profile, or weakens the default", async () => {
    const d = setup();
    const policy = new FilePolicyStore({
      dir: mkdtempSync(join(tmpdir(), 'cp-pol-')),
      provenance: d.provenance,
    });
    const P = DEFAULT_POLICY.profiles;
    const bench = P.benchmark!;
    const base: Policy = {
      ...DEFAULT_POLICY,
      profiles: {
        base: P.base!,
        benchmark: bench,
        'benchmark-self': P['benchmark-self']!,
        'general-self': P['general-self']!,
        strict: { ...bench, envelope: { ...bench.envelope, maxWorkspaceMb: 4096 } },
      },
      defaultProfile: 'benchmark',
    };
    await policy.set(base, ENV_ADMIN);
    (d as { policy?: FilePolicyStore }).policy = policy;
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const put = (p: TokenClaims, body: Policy) => call(d, 'putPolicy', p, {}, body);
    const withProfile = (name: string, pr: Policy['profiles'][string]): Policy => ({
      ...base,
      profiles: { ...base.profiles, [name]: pr },
    });
    const env = bench.envelope;
    const widenings: [string, Policy][] = [
      [
        'requires',
        withProfile('benchmark', { ...bench, requires: bench.requires.filter((r) => r !== 'X11') }),
      ],
      ['requireOfflineGate', withProfile('benchmark', { ...bench, requireOfflineGate: false })],
      ['selfAttest', withProfile('benchmark', { ...bench, selfAttest: true })],
      [
        'selfAttestEgress',
        withProfile('benchmark-self', { ...P['benchmark-self']!, selfAttestEgress: true }),
      ],
      ['a raised bound', withProfile('benchmark', { ...bench, envelope: { ...env, maxVcpus: 4 } })],
      [
        'exact removed',
        withProfile('benchmark', {
          ...bench,
          envelope: {
            maxGuestMb: env.maxGuestMb,
            maxVcpus: env.maxVcpus,
            maxWorkspaceMb: env.maxWorkspaceMb,
          },
        }),
      ],
      [
        'exact changed',
        withProfile('benchmark', {
          ...bench,
          envelope: { ...env, exact: { guestMb: 2048, vcpus: 2 } },
        }),
      ],
      ['a new profile', withProfile('extra', { ...bench })],
      ['a weaker default', { ...base, defaultProfile: 'base' }],
    ];
    for (const [name, wider] of widenings) {
      expect({ name, code: await codeOf(() => put(who(CAROL), wider)) }).toEqual({
        name,
        code: 'forbidden',
      });
      expect((await policy.current()).policy).toEqual(base);
    }
    const { 'general-self': _gone, ...withoutGeneralSelf } = base.profiles;
    const narrowings: [string, Policy][] = [
      ['requires added', withProfile('base', { ...P.base!, requires: ['X10'] })],
      [
        'requireOfflineGate on',
        withProfile('general-self', { ...P['general-self']!, requireOfflineGate: true }),
      ],
      [
        'selfAttestEgress off',
        withProfile('general-self', { ...P['general-self']!, selfAttestEgress: false }),
      ],
      [
        'selfAttest off',
        withProfile('benchmark-self', { ...P['benchmark-self']!, selfAttest: false }),
      ],
      [
        'a lowered bound',
        withProfile('base', { ...P.base!, envelope: { ...P.base!.envelope, maxVcpus: 4 } }),
      ],
      [
        'exact added',
        withProfile('base', {
          ...P.base!,
          envelope: { ...P.base!.envelope, exact: { guestMb: 4096, vcpus: 2 } },
        }),
      ],
      ['a profile removed', { ...base, profiles: withoutGeneralSelf }],
      ['a stricter default', { ...base, defaultProfile: 'strict' }],
    ];
    for (const [name, narrower] of narrowings) {
      expect({ name, status: (await put(who(CAROL), narrower)).status }).toEqual({
        name,
        status: 200,
      });
      expect((await policy.current()).policy).toEqual(narrower);
      // A settings admin's widening (back to base) goes through.
      expect((await put(who(ENV_ADMIN), base)).status).toBe(200);
      expect((await policy.current()).policy).toEqual(base);
    }
    // And a settings admin's widening of each kind.
    for (const [, wider] of widenings) {
      expect((await put(who(ENV_ADMIN), wider)).status).toBe(200);
      await put(who(ENV_ADMIN), base);
    }
  });

  it("never lets an API-granted admin's PUT built from an older policy restore trust a settings admin removed", async () => {
    const d = setup();
    const policy = new FilePolicyStore({
      dir: mkdtempSync(join(tmpdir(), 'cp-pol-')),
      provenance: d.provenance,
    });
    const G = `sha256:${'a'.repeat(64)}`;
    const base: Policy = { ...DEFAULT_POLICY, trustedGateRecords: [G] };
    await policy.set(base, ENV_ADMIN);
    // CAROL's write is slow: without one step for the check and the write, the settings admin's
    // removal lands between CAROL's check (against the policy with G) and CAROL's write (with G).
    const set = policy.set.bind(policy);
    policy.set = (async (pol: Policy, subject: string, extra?: Record<string, unknown>) => {
      if (subject === CAROL) await new Promise((r) => setTimeout(r, 50));
      return set(pol, subject, extra);
    }) as typeof policy.set;
    (d as { policy?: FilePolicyStore }).policy = policy;
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const put = (p: TokenClaims, body: Policy) => call(d, 'putPolicy', p, {}, body);
    // CAROL keeps G and changes a quota, from the policy she read; the settings admin removes G.
    const carols = { ...base, quota: { ...base.quota, templates: base.quota.templates + 1 } };
    const removal = { ...base, trustedGateRecords: [] };
    // Whichever PUT takes the lock first, G is not restored: CAROL's lands before the removal, or
    // is checked against the policy without G, and refused as a widening.
    for (const carolFirst of [true, false]) {
      await policy.set(base, ENV_ADMIN);
      const puts = [() => put(who(CAROL), carols), () => put(who(ENV_ADMIN), removal)];
      const [c, s] = carolFirst
        ? await Promise.allSettled(puts.map((f) => f()))
        : (await Promise.allSettled([puts[1]!(), puts[0]!()])).reverse();
      expect(s!.status).toBe('fulfilled');
      if (c!.status === 'rejected') expect((c!.reason as { code?: string }).code).toBe('forbidden');
      expect((await policy.current()).policy.trustedGateRecords).toEqual([]);
    }
  });

  it("never loses a quota write to a PUT /v1/policy whose read came before it, or the PUT's change", async () => {
    const d = setup();
    const policy = new FilePolicyStore({
      dir: mkdtempSync(join(tmpdir(), 'cp-pol-')),
      provenance: d.provenance,
    });
    const G = `sha256:${'a'.repeat(64)}`;
    const base: Policy = { ...DEFAULT_POLICY, trustedGateRecords: [G] };
    await policy.set(base, ENV_ADMIN);
    // The settings admin's PUT is slow to write: without one lock for both, CAROL's quota write
    // lands between that PUT's read and its write, and the PUT's policy replaces it unseen.
    const set = policy.set.bind(policy);
    policy.set = (async (pol: Policy, subject: string, extra?: Record<string, unknown>) => {
      if (subject === ENV_ADMIN) await new Promise((r) => setTimeout(r, 50));
      return set(pol, subject, extra);
    }) as typeof policy.set;
    (d as { policy?: FilePolicyStore }).policy = policy;
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const quota = { templates: 2, buildsQueued: 1, active: 1 };
    const [put, q] = await Promise.all([
      call(d, 'putPolicy', who(ENV_ADMIN), {}, { ...base, trustedGateRecords: [] }),
      call(d, 'putQuota', who(CAROL), { subject: DAVE }, quota),
    ]);
    expect(put.status).toBe(200);
    expect(q.status).toBe(200);
    // Both changes stand: the quota write ran after the PUT, on the policy it wrote.
    const now = (await policy.current()).policy;
    expect(now.trustedGateRecords).toEqual([]);
    expect(now.quotaBySubject).toEqual({ [DAVE]: quota });
    expect((q.body as { before: unknown }).before).toBeNull();
    const by = (await d.provenance.chain('policy')).map((r) => r.subject);
    expect(by.slice(-2)).toEqual([ENV_ADMIN, CAROL]);
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

  it('sees an out-of-process edit that keeps the mtime (the cache keys on inode and size too)', async () => {
    const d = setup();
    await call(d, 'grantAdmin', who(ENV_ADMIN), { subject: CAROL }, {});
    const file = (d.members as unknown as { path: string }).path;
    expect(await d.members.membershipNow(CAROL, nowS())).toMatchObject({ roles: ['admin'] });
    // One handle for the read of the times, the rewrite and the reset of the times.
    const fd = openSync(file, 'r+');
    try {
      const { mtime, atime } = fstatSync(fd);
      ftruncateSync(fd, 0);
      writeSync(fd, JSON.stringify({ members: {} }), 0);
      futimesSync(fd, atime, mtime);
    } finally {
      closeSync(fd);
    }
    expect(await d.members.membershipNow(CAROL, nowS())).toMatchObject({ roles: [] });
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
      // Rate-limited: many requests within the minute log one line, and the next line, a minute
      // later, carries the count of answers since the first.
      warn.mockClear();
      for (let i = 0; i < 5; i++) await d.members.membershipNow(ALLOWED, nowS());
      expect(warn).not.toHaveBeenCalled();
      now += 60_000;
      await d.members.membershipNow(ALLOWED, nowS());
      expect(warn).toHaveBeenCalledTimes(1);
      // 1 by listTemplates, 5 in the loop, and this one.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('(7 such answer(s) since the last warning)'),
      );
      await expect(d.members.membershipNow(CAROL, nowS())).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a members.json of the wrong shape is refused as a corrupt one', () => {
  for (const [name, content] of [
    ['members null', '{"members": null}'],
    ['members an array', '{"members": []}'],
    [
      'a member with no roles array',
      `{"members": {"${CAROL}": {"subject": "${CAROL}", "enrolled": true, "since": 1, "by": "${ENV_ADMIN}"}}}`,
    ],
    [
      'a role that is not a grant',
      `{"members": {"${CAROL}": {"subject": "${CAROL}", "enrolled": true, "roles": ["admin"], "since": 1, "by": "${ENV_ADMIN}"}}}`,
    ],
  ] as const) {
    it(`${name}: the settings' subjects are answered, everyone else fails closed, no TypeError`, async () => {
      const d = setup();
      const a = who(ENV_ADMIN);
      await call(d, 'enrollSubject', a, { subject: CAROL }, { enrolled: true });
      writeFileSync((d.members as unknown as { path: string }).path, content);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await d.members.membershipNow(ALLOWED, nowS())).toEqual({
          roles: [],
          enrolled: false,
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered from the settings'));
        // A request of an allow-listed subject is served, not a 500.
        expect((await call(d, 'listTemplates', who(ALLOWED))).status).toBe(200);
        await expect(d.members.membershipNow(CAROL, nowS())).rejects.toThrow(
          'members.json is invalid',
        );
        await expect(d.members.membershipNow(DAVE, nowS())).rejects.toThrow(
          'members.json is invalid',
        );
      } finally {
        warn.mockRestore();
      }
    });
  }

  it('through the router: an allow-listed subject is served, a store-only one is refused', async () => {
    // Combined: its tokens carry the issuer the test signer mints under, and /v1/sandboxes is
    // enrolled-only there.
    const d = setup('combined');
    await call(d, 'enrollSubject', who(ENV_ADMIN), { subject: CAROL }, { enrolled: true });
    writeFileSync((d.members as unknown as { path: string }).path, '{"members": null}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = createServer(buildHandler(d));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sandboxes`;
      const get = async (sub: string) =>
        (
          await fetch(url, {
            headers: {
              authorization: `Bearer ${d.signer.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 3600, now: nowS() })}`,
            },
          })
        ).status;
      expect(await get(ALLOWED)).toBe(200);
      // As for an unparseable file: the store-only subject fails closed (the read error, a 500).
      expect(await get(CAROL)).toBe(500);
    } finally {
      server.close();
      warn.mockRestore();
      err.mockRestore();
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
