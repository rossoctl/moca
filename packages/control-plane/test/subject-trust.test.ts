import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore, sha256Hex, verifyExport } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import {
  checkCreate,
  DEFAULT_POLICY,
  policyProblems,
  type Policy,
} from '../src/template-policy.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// Self-attestation: per-subject trust for gate records
// (docs/specs/2026-11-08-subject-trust-gate-records-design.md).
const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { id: _id, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const DIGEST = IMAGE.slice(IMAGE.indexOf('@') + 1);
const spec = { ...REST };

/**
 * A record in the general-gate shape (`moca-gate-record/1`, the default SH_GATE_RECORD_SCHEMA): no
 * testbed/environment/base image and no recipe, the gate run as given.
 */
const general = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 'moca-gate-record/1',
    image: { repository: 'images/moca-microvm', digest: DIGEST },
    contract_sha256: 'c'.repeat(64),
    gate: {
      passed: true,
      kind: 'general',
      network: 'none',
      rootfs: 'read-only',
      user: 'root',
      floor_checked_offline: true,
      network_needed: false,
    },
    observed: {
      testbed: { agent_can_commit: 'no' },
      guest: { git_identity: 'none' },
    },
    problems: [],
    test_cmd_sha256: 'd'.repeat(64),
    workdir: '/testbed',
    tools: ['bash', 'git'],
    builder: { arch: 'amd64', engine: 'podman' },
    built_at: '2026-11-08T00:00:00Z',
    tool: { name: 'general_gate', commit: null },
    ...over,
  });
const GATE = general();
const SHA = `sha256:${sha256Hex(Buffer.from(GATE, 'utf8'))}`;

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let seq = 0;
async function setup(policy: Policy = DEFAULT_POLICY): Promise<TestDeps> {
  const dir = mkdtempSync(join(tmpdir(), 'cp-trust-'));
  const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
  const d = makeDeps({
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    templates: new FileTemplateCatalog({ dir, declared: [], provenance }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    config: { routeProfile: 'sandbox' },
  });
  await d.policy!.set(policy, admin.sub);
  return d;
}
const body = (over: Record<string, unknown> = {}) => ({
  id: 't-self',
  image: IMAGE,
  spec,
  profile: 'benchmark-self',
  gateRecord: GATE,
  ...over,
});
const create = (d: TestDeps, b: unknown = body(), principal = alice) =>
  HANDLERS.createTemplate!(ctx({ principal, body: b }), d);
const rule = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return (
      (e as { extra?: { rule?: string }; code: string }).extra?.rule ?? (e as { code: string }).code
    );
  }
  return 'none';
};
/** What a host's report does to the catalog on `built` (registration): status and build id. */
async function register(d: TestDeps, id: string, h: string) {
  await d.templates!.update!(id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x, i) =>
      i === 0 ? { ...x, status: 'registered' as const, buildId: h, worker: `sbx_${id}` } : x,
    ),
    tags: { ...cur!.tags, default: h },
  }));
}
const HASH = `sha256:${'a'.repeat(64)}`;
const view = async (d: TestDeps, id = 't-self', principal = alice) =>
  (await HANDLERS.getTemplate!(ctx({ principal, params: { id } }), d)).body as Body;
const putPolicy = (d: TestDeps, p: Policy) =>
  HANDLERS.putPolicy!(ctx({ principal: admin, body: p }), d);
/** A sandbox of the template, for `principal`: the build it resolved to. */
const use = async (d: TestDeps, principal = alice, template = 't-self') =>
  ((await HANDLERS.createSandbox!(ctx({ principal, body: { template } }), d)).body as Body)
    .buildId as string;
/**
 * Stored visibility set to `deployment`, as the owner's edit of its template would; the edit route
 * refuses it for a self-attested build (409 self_attested), so these tests set it only once the
 * record is trusted.
 */
const makeVisible = (d: TestDeps, id = 't-self') =>
  d.templates!.update!(id, async (cur) => ({ ...cur!, visibility: 'deployment' as const }));

describe('the default policy (self-attestation)', () => {
  it('holds benchmark-self (offline) and general-self (allowlisted egress) beside a curated benchmark', () => {
    expect(DEFAULT_POLICY.profiles.benchmark!.selfAttest).toBeUndefined();
    expect(DEFAULT_POLICY.profiles['benchmark-self']).toMatchObject({
      selfAttest: true,
      selfAttestEgress: false,
    });
    expect(DEFAULT_POLICY.profiles['benchmark-self']!.requires).toContain('X11');
    expect(DEFAULT_POLICY.profiles['general-self']).toMatchObject({
      selfAttest: true,
      selfAttestEgress: true,
    });
    expect(DEFAULT_POLICY.profiles['general-self']!.requires).not.toContain('X11');
    expect(policyProblems(DEFAULT_POLICY)).toEqual([]);
  });

  it('refuses malformed self-attestation settings', () => {
    const bad = (pr: Record<string, unknown>) =>
      policyProblems({ ...DEFAULT_POLICY, profiles: { ...DEFAULT_POLICY.profiles, x: pr } });
    const env = { maxGuestMb: 4096, maxVcpus: 2, maxWorkspaceMb: 8192 };
    expect(bad({ requires: ['X1'], envelope: env, selfAttest: 'yes' })).toContain(
      'x.selfAttest must be true or false',
    );
    expect(bad({ requires: ['X1'], envelope: env, selfAttestEgress: true })).toContain(
      'x.selfAttestEgress needs selfAttest',
    );
    expect(bad({ requires: [], envelope: env, selfAttest: true })).toContain(
      'x.selfAttest needs X1 in requires (a gate record to attest)',
    );
  });
});

describe('a subject self-attests its own gate record (self-attestation)', () => {
  it('admits its submitter on benchmark-self, private, with a gate record naming source self, scope and policy', async () => {
    const d = await setup();
    const r = await create(d);
    expect(r.status).toBe(202);
    const t = await view(d);
    expect(t).toMatchObject({ owner: alice.sub, visibility: 'private' });
    const chain = await d.provenance!.chain('template/t-self');
    const gate = chain.find((x) => x.kind === 'gate')!;
    const { record: policyRecord } = await d.policy!.current();
    expect(gate.subject).toBe(alice.sub);
    expect(gate.body).toEqual({
      record_sha256: SHA,
      source: 'self',
      scope: alice.sub,
      policy: policyRecord,
    });
    const exp = await d.provenance!.export(['template/t-self']);
    expect(verifyExport(JSON.parse(JSON.stringify(exp)))).toMatchObject({ ok: true });
  });

  it('refuses another subject the same sha256 (the record counts only for its submitter)', async () => {
    const d = await setup();
    await create(d);
    expect(await rule(() => create(d, body({ id: 't-bob' }), bob))).toBe('X1.self.scope');
  });

  it('lets one of two concurrent subjects claim a record, never both', async () => {
    const d = await setup();
    const rs = await Promise.allSettled([
      create(d, body({ id: 't-a' }), alice),
      create(d, body({ id: 't-b' }), bob),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as { extra?: { rule?: string } }).extra?.rule).toBe('X1.self.scope');
  });

  it('counts only self-attestations: a build made while the record was trusted claims nothing', async () => {
    const d = await setup();
    expect((await create(d, body({ id: 't-a' }))).status).toBe(202);
    const promoted = { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] };
    await putPolicy(d, promoted);
    expect((await create(d, body({ id: 't-b' }), bob)).status).toBe(202);
    await putPolicy(d, { ...promoted, trustedGateRecords: [] });
    // The record is untrusted again: its first submitter keeps it, the other subject does not.
    expect((await create(d, body({ id: 't-a2' }))).status).toBe(202);
    expect(await rule(() => create(d, body({ id: 't-b2' }), bob))).toBe('X1.self.scope');
  });

  /** Sets every build of a template to one status, as a host's report or an admin would. */
  const endAs = (d: TestDeps, id: string, status: 'failed' | 'retired' | 'rejected') =>
    d.templates!.update!(id, async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((x) => ({ ...x, status })),
    }));

  it('releases a claim whose build failed: another subject then self-attests the record', async () => {
    const d = await setup();
    await create(d);
    await endAs(d, 't-self', 'failed');
    expect((await create(d, body({ id: 't-bob' }), bob)).status).toBe(202);
    // The record is bob's now: alice's next self-attested create is refused.
    expect(await rule(() => create(d, body({ id: 't-a2' })))).toBe('X1.self.scope');
  });

  it.each(['retired', 'rejected'] as const)(
    'holds a claim whose build is %s: another subject is still refused',
    async (status) => {
      const d = await setup();
      await create(d);
      await endAs(d, 't-self', status);
      expect(await rule(() => create(d, body({ id: 't-bob' }), bob))).toBe('X1.self.scope');
    },
  );

  it("attests an admin's build on another subject's template for that template's owner", async () => {
    const d = await setup();
    const other = general({ built_at: '2026-11-09T00:00:00Z' });
    expect((await create(d, body({ gateRecord: other }))).status).toBe(202);
    const add = (principal: typeof admin, id = 't-self') =>
      HANDLERS.createTemplateBuild!(
        ctx({ principal, params: { id }, body: { ...body(), id: undefined } }),
        d,
      );
    expect((await add(admin)).status).toBe(202);
    const gates = (await d.provenance!.chain('template/t-self')).filter((x) => x.kind === 'gate');
    const g = gates.find((x) => x.body.record_sha256 === SHA)!;
    expect(g.subject).toBe(admin.sub);
    expect(g.body).toMatchObject({ source: 'self', scope: alice.sub });
    // The record now counts for the owner: another subject is refused, the owner is not.
    expect(await rule(() => create(d, body({ id: 't-bob' }), bob))).toBe('X1.self.scope');
    expect((await create(d, body({ id: 't-a2' }))).status).toBe(202);
    // The admin can't attest the owner's record for another subject's template.
    await create(
      d,
      body({ id: 't-bob', gateRecord: general({ built_at: '2026-11-10T00:00:00Z' }) }),
      bob,
    );
    expect(await rule(() => add(admin, 't-bob'))).toBe('X1.self.scope');
  });

  it('still refuses an untrusted record on the curated benchmark profile', async () => {
    const d = await setup();
    expect(await rule(() => create(d, body({ profile: 'benchmark' })))).toBe('X1.trusted');
  });

  it('refuses egress on benchmark-self (benchmark integrity)', async () => {
    const d = await setup();
    expect(await rule(() => create(d, body({ spec: { ...spec, egress: true } })))).toBe('X11');
    // Without X11 in its requires, the self-attested egress rule is what refuses it.
    const noX11: Policy = {
      ...DEFAULT_POLICY,
      profiles: {
        ...DEFAULT_POLICY.profiles,
        'benchmark-self': {
          ...DEFAULT_POLICY.profiles['benchmark-self']!,
          requires: ['X1', 'X10', 'X12', 'X14', 'X15'],
        },
      },
    };
    const d2 = await setup(noX11);
    expect(await rule(() => create(d2, body({ spec: { ...spec, egress: true } })))).toBe(
      'X1.self.egress',
    );
  });

  it('accepts egress on general-self for its submitter, and still refuses another subject', async () => {
    const d = await setup();
    const r = await create(d, body({ profile: 'general-self', spec: { ...spec, egress: true } }));
    expect(r.status).toBe(202);
    expect(
      await rule(() =>
        create(
          d,
          body({ id: 't-bob', profile: 'general-self', spec: { ...spec, egress: true } }),
          bob,
        ),
      ),
    ).toBe('X1.self.scope');
  });

  it('holds X12 strict on a self-attested record, whatever the spec', async () => {
    const d = await setup();
    const commits = general({
      observed: { testbed: { agent_can_commit: 'yes' }, guest: { git_identity: 'none' } },
    });
    expect(
      await rule(() =>
        create(d, body({ gateRecord: commits, spec: { ...spec, skip_git_identity_check: false } })),
      ),
    ).toBe('X12.self');
  });

  it('checks X1.image on the new profile', async () => {
    const d = await setup();
    const other = general({
      image: { repository: 'images/moca-microvm', digest: `sha256:${'e'.repeat(64)}` },
    });
    expect(await rule(() => create(d, body({ gateRecord: other })))).toBe('X1.image');
  });

  it('accepts the general-gate record shape (no base image, no recipe)', () => {
    const r = checkCreate(
      {
        id: 't',
        image: IMAGE,
        spec,
        profile: 'benchmark-self',
        gateRecordBytes: Buffer.from(GATE),
        subject: alice.sub,
      },
      DEFAULT_POLICY,
    );
    expect(r.failed).toBeUndefined();
    expect(r.gateTrust).toBe('self');
    expect(r.results.map((x) => x.rule)).toEqual(
      expect.arrayContaining([
        'X1',
        'X1.trusted',
        'X1.image',
        'X1.self.scope',
        'X12.self',
        'X1.self.egress',
        'X11',
        'X14',
        'X15',
      ]),
    );
  });

  it('refuses a self-attested build on a template already visible to others', async () => {
    const d = await setup();
    await create(
      d,
      body({
        profile: 'base',
        gateRecord: undefined,
        spec: { ...spec, source_record_digest: undefined, skip_git_identity_check: false },
        visibility: 'deployment',
      }),
    );
    expect(await codeOf(() => create(d, body()))).toBe('self_attested');
  });
});

describe("a gate's floor checked offline (X1.offline)", () => {
  const gate1 = (g: Record<string, unknown>) =>
    general({
      gate: {
        passed: true,
        kind: 'general',
        network: 'none',
        rootfs: 'read-only',
        user: 'root',
        ...g,
      },
    });
  const online = gate1({
    floor_checked_offline: false,
    network_needed: true,
    floor_met_offline: false,
  });
  const missing = gate1({});
  const shaOf = (x: string) => `sha256:${sha256Hex(Buffer.from(x, 'utf8'))}`;
  // A curated family record (moca-microvm) predates the field: absence is offline.
  const FAMILY = readFileSync(join(EX, 'django__django-11133.gate-record.json'), 'utf8');

  it('passes a family-schema record with no field on benchmark (the trusted records keep working)', async () => {
    const d = await setup({ ...DEFAULT_POLICY, trustedGateRecords: [shaOf(FAMILY)] });
    const fam = JSON.parse(FAMILY) as { gate?: Record<string, unknown> };
    expect(fam.gate?.floor_checked_offline).toBeUndefined();
    const r = await create(
      d,
      body({ id: 'django-django-11133', profile: 'benchmark', gateRecord: FAMILY, spec }),
    );
    expect(r.status).toBe(202);
    expect((await view(d, 'django-django-11133')).builds[0].gateFloorCheckedOffline).toBe(true);
  });

  it('refuses a gate/1 record with floor_checked_offline false on benchmark and benchmark-self', async () => {
    const d = await setup({ ...DEFAULT_POLICY, trustedGateRecords: [shaOf(online)] });
    expect(await rule(() => create(d, body({ profile: 'benchmark', gateRecord: online })))).toBe(
      'X1.offline',
    );
    const d2 = await setup();
    expect(await rule(() => create(d2, body({ gateRecord: online })))).toBe('X1.offline');
  });

  it('refuses a gate/1 record missing the field on benchmark (fail closed)', async () => {
    const d = await setup({ ...DEFAULT_POLICY, trustedGateRecords: [shaOf(missing)] });
    expect(await rule(() => create(d, body({ profile: 'benchmark', gateRecord: missing })))).toBe(
      'X1.offline',
    );
  });

  it("reads the deployment's general-gate schema (SH_GATE_RECORD_SCHEMA), default moca-gate-record/1", async () => {
    // Another builder's schema: its records must carry the field once the deployment names it.
    const other = (g: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(gate1(g)), schema: 'builder.example/gate/1' });
    const d = await setup();
    // Not the default schema: read as a curated family record, absence is offline.
    expect((await create(d, body({ gateRecord: other({}) }))).status).toBe(202);
    const d2 = await setup();
    d2.config.sandbox!.gateRecordSchema = 'builder.example/gate/1';
    expect(await rule(() => create(d2, body({ gateRecord: other({}) })))).toBe('X1.offline');
    // ...and the default schema is then the family case.
    expect((await create(d2, body({ id: 't-self2', gateRecord: missing }))).status).toBe(202);
    const pol = (await HANDLERS.getPolicy!(ctx({ principal: alice }), d2)).body as Body;
    expect(pol.gateRecordSchema).toBe('builder.example/gate/1');
    const pol1 = (await HANDLERS.getPolicy!(ctx({ principal: alice }), d)).body as Body;
    expect(pol1.gateRecordSchema).toBe('moca-gate-record/1');
  });

  it('checkCreate takes the schema as an option', () => {
    const input = { id: 't-x', image: IMAGE, spec, profile: 'benchmark-self', subject: 'github:1' };
    const of = (gate: string, gateRecordSchema?: string) =>
      checkCreate(
        { ...input, gateRecordBytes: Buffer.from(gate) },
        DEFAULT_POLICY,
        gateRecordSchema ? { gateRecordSchema } : {},
      ).failed?.rule;
    expect(of(missing)).toBe('X1.offline');
    expect(of(missing, 'builder.example/gate/1')).toBeUndefined();
  });

  it('accepts either value on general-self, shown on the build', async () => {
    const d = await setup();
    expect((await create(d, body({ profile: 'general-self', gateRecord: online }))).status).toBe(
      202,
    );
    const b = (await view(d)).builds[0];
    expect(b.gateFloorCheckedOffline).toBe(false);
    expect(b.gateFloorMetOffline).toBe(false);
    const d2 = await setup();
    expect((await create(d2, body({ profile: 'general-self' }))).status).toBe(202);
    const b2 = (await view(d2)).builds[0];
    expect(b2.gateFloorCheckedOffline).toBe(true);
    expect(b2).not.toHaveProperty('gateFloorMetOffline');
  });
});

describe('promotion and removal of trust (self-attestation)', () => {
  it('shows attestation self, refuses a deployment-visible create, and flips on promotion with no rewrite', async () => {
    const d = await setup();
    expect(await codeOf(() => create(d, body({ visibility: 'deployment' })))).toBe('self_attested');
    await create(d);
    await register(d, 't-self', HASH);
    const stored = JSON.stringify(await d.templates!.get('t-self'));
    let t = await view(d);
    expect(t.attestation).toBe('self');
    expect(t.builds[0].attestation).toBe('self');
    // Even with deployment stored, a self-attested build keeps the template private in effect.
    await makeVisible(d);
    expect((await view(d)).visibility).toBe('private');
    expect(await codeOf(() => view(d, 't-self', bob))).toBe('template_not_found');
    // An admin trusts the record: the build reads as deployment-trusted, nothing rewritten.
    const visibleStored = JSON.stringify(await d.templates!.get('t-self'));
    expect(visibleStored).not.toBe(stored);
    await putPolicy(d, { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] });
    expect(JSON.stringify(await d.templates!.get('t-self'))).toBe(visibleStored);
    t = await view(d);
    expect(t.attestation).toBe('deployment');
    expect(t.builds[0].attestation).toBe('deployment');
    expect((await view(d, 't-self', bob)).visibility).toBe('deployment');
  });

  it('refuses a visibility edit to deployment while a build is self-attested, and allows it once trusted', async () => {
    const d = await setup();
    await create(d);
    const edit = (visibility: string, principal = alice) =>
      HANDLERS.updateTemplate!(
        ctx({ principal, params: { id: 't-self' }, body: { visibility } }),
        d,
      );
    // Queued, then registered: refused either way, for the owner and for an admin alike.
    expect(await codeOf(() => edit('deployment'))).toBe('self_attested');
    await register(d, 't-self', HASH);
    expect(await codeOf(() => edit('deployment'))).toBe('self_attested');
    expect(await codeOf(() => edit('deployment', admin))).toBe('self_attested');
    expect((await d.templates!.get('t-self'))!.visibility).toBe('private');
    expect(
      (await d.provenance!.chain('template/t-self')).some((x) => x.kind === 'visibility'),
    ).toBe(false);
    // An admin trusts the record: the edit goes through.
    await putPolicy(d, { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] });
    const r = (await edit('deployment')).body as Body;
    expect(r.visibility).toBe('deployment');
    expect((await view(d, 't-self', bob)).visibility).toBe('deployment');
  });

  it('refuses an owner transfer while a build is self-attested, and allows it once trusted', async () => {
    const d = await setup();
    await create(d);
    const transfer = () =>
      HANDLERS.transferTemplateOwner!(
        ctx({ principal: admin, params: { id: 't-self' }, body: { owner: bob.sub } }),
        d,
      );
    // Queued, then registered: refused either way, with no owner record written.
    expect(await codeOf(transfer)).toBe('self_attested');
    await register(d, 't-self', HASH);
    expect(await codeOf(transfer)).toBe('self_attested');
    expect((await d.templates!.get('t-self'))!.owner).toBe(alice.sub);
    expect((await d.provenance!.chain('template/t-self')).some((x) => x.kind === 'owner')).toBe(
      false,
    );
    // An admin trusts the record: the transfer goes through.
    await putPolicy(d, { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] });
    const r = (await transfer()).body as Body;
    expect(r.owner).toBe(bob.sub);
    expect((await d.templates!.get('t-self'))!.owner).toBe(bob.sub);
  });

  it('narrows a visible template to private on removal, names it in the policy record, and refuses others', async () => {
    const d = await setup();
    await create(d);
    await register(d, 't-self', HASH);
    const promoted = { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] };
    await putPolicy(d, promoted);
    await makeVisible(d);
    expect(await use(d, bob)).toBe(HASH);
    // The admin takes the trust away: the template is private again, on read.
    const r = (await putPolicy(d, { ...promoted, trustedGateRecords: [] })).body as Body;
    expect(r.narrowed).toEqual([{ template: 't-self', buildId: HASH }]);
    const rec = (await d.provenance!.chain('policy')).at(-1)!;
    expect(rec.body.narrowed).toEqual([{ template: 't-self', buildId: HASH }]);
    expect((await view(d)).visibility).toBe('private');
    expect(await codeOf(() => view(d, 't-self', bob))).toBe('template_not_found');
    expect(await codeOf(() => use(d, bob))).toBe('unknown_template');
    const listed = (await HANDLERS.listTemplates!(ctx({ principal: bob }), d)).body as Body;
    expect(listed.templates.map((x: Body) => x.id)).not.toContain('t-self');
    // Its owner still uses it.
    expect(await use(d, alice)).toBe(HASH);
  });

  it("narrows on removal another subject's build made on a selfAttest profile while the record was trusted", async () => {
    const d = await setup();
    const promoted = { ...(await d.policy!.current()).policy, trustedGateRecords: [SHA] };
    await putPolicy(d, promoted);
    // Trusted at create: no self-attestation, and the requested (default) deployment visibility.
    expect((await create(d, body({ id: 't-bob' }), bob)).status).toBe(202);
    await register(d, 't-bob', HASH);
    expect((await view(d, 't-bob', alice)).visibility).toBe('deployment');
    expect(await use(d, alice, 't-bob')).toBe(HASH);
    const r = (await putPolicy(d, { ...promoted, trustedGateRecords: [] })).body as Body;
    expect(r.narrowed).toEqual([{ template: 't-bob', buildId: HASH }]);
    const t = await view(d, 't-bob', bob);
    expect(t).toMatchObject({ visibility: 'private', attestation: 'self' });
    expect(t.builds[0].attestation).toBe('self');
    expect(await codeOf(() => view(d, 't-bob', alice))).toBe('template_not_found');
    expect(await codeOf(() => use(d, alice, 't-bob'))).toBe('unknown_template');
    // Its owner keeps using it, as decision (i) says.
    expect(await use(d, bob, 't-bob')).toBe(HASH);
  });

  it('keeps every other policy field across a policy write, and names nothing when nothing narrows', async () => {
    const d = await setup();
    const changed: Policy = {
      ...DEFAULT_POLICY,
      quota: { templates: 50, buildsQueued: 5, active: 4 },
    };
    await putPolicy(d, changed);
    await putPolicy(d, { ...changed, trustedGateRecords: [SHA] });
    const r = (await putPolicy(d, { ...changed, trustedGateRecords: [] })).body as Body;
    expect(r).not.toHaveProperty('narrowed');
    expect((await d.provenance!.chain('policy')).at(-1)!.body).not.toHaveProperty('narrowed');
    const { policy } = await d.policy!.current();
    expect(policy).toEqual({ ...changed, trustedGateRecords: [] });
  });
});
