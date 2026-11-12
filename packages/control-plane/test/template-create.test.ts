import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore, sha256Hex, verifyExport } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { checkCreate, DEFAULT_POLICY, registryOf, type Policy } from '../src/template-policy.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// The repository's own worked examples: the default sandbox image's spec, and a SWE-bench spec with
// its image builder's gate record.
const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const DEFAULT_SPEC = JSON.parse(readFileSync(join(EX, 'default.json'), 'utf8')) as Record<
  string,
  unknown
>;
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const GATE = readFileSync(join(EX, 'django__django-11133.gate-record.json'), 'utf8');
const GATE_SHA = `sha256:${sha256Hex(Buffer.from(GATE, 'utf8'))}`;
const { id: ID, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const spec = { ...REST, guest_mb: REST.guest_ram_mb };
const benchmarkPolicy: Policy = { ...DEFAULT_POLICY, trustedGateRecords: [GATE_SHA] };

let seq = 0;
function stored(policy: Policy = benchmarkPolicy): TestDeps {
  const dir = mkdtempSync(join(tmpdir(), 'cp-create-'));
  const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
  const d = makeDeps({
    // Distinct in the first 26 hex characters, which is what a build handle keeps.
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    templates: new FileTemplateCatalog({ dir, declared: [], provenance }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    config: { routeProfile: 'sandbox' },
  });
  void d.policy!.set(policy, admin.sub);
  return d;
}
const body = (over: Record<string, unknown> = {}) => ({
  id: ID,
  image: IMAGE,
  spec,
  profile: 'benchmark',
  gateRecord: GATE,
  ...over,
});
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const create = async (d: TestDeps, b: unknown = body(), principal = alice) =>
  HANDLERS.createTemplate!(ctx({ principal, body: b }), d);
const refusal = async (d: TestDeps, b: unknown) => {
  try {
    await create(d, b);
  } catch (e) {
    return {
      code: (e as { code: string }).code,
      rule: (e as { extra?: { rule?: string } }).extra?.rule,
    };
  }
  return { code: 'none', rule: undefined };
};

describe('POST /v1/templates (§4, §8.1)', () => {
  it("queues the worked example's benchmark template: 202, a build handle, status queued", async () => {
    const d = stored();
    const r = await create(d);
    expect(r.status).toBe(202);
    const b = r.body as Body;
    expect(b).toMatchObject({ templateId: 'django-django-11133', buildId: null, status: 'queued' });
    expect(b.build).toMatch(/^\/v1\/templates\/django-django-11133\/builds\/b-[0-9a-f]{26}$/);
    const t = (await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: ID } }), d))
      .body as Body;
    expect(t).toMatchObject({ owner: alice.sub, visibility: 'deployment', onboarding: 'queued' });
    expect(t.builds[0]).toMatchObject({ status: 'queued', profile: 'benchmark', readiness: null });
    expect(t.builds[0].spec).toMatchObject({ guest_mb: 4096, vcpus: 2, seed: SPEC.seed });
  });

  it('records create, gate and check, chained to the policy record, verifiable offline', async () => {
    const d = stored();
    await create(d);
    const chain = await d.provenance!.chain(`template/${ID}`);
    expect(chain.map((r) => r.kind)).toEqual(['create', 'gate', 'check']);
    expect(chain[1].body).toMatchObject({ record_sha256: GATE_SHA, source: 'trusted' });
    expect(chain[2].body).toMatchObject({
      outcome: 'admitted',
      profile: 'benchmark',
      at: 'create',
    });
    const exp = await d.provenance!.export([`template/${ID}`]);
    expect(exp.blobs.map((b) => b.sha256)).toEqual([GATE_SHA]);
    expect(verifyExport(JSON.parse(JSON.stringify(exp)))).toMatchObject({ ok: true });
  });

  it.each([
    [
      'an untrusted gate record',
      { gateRecord: GATE.replace('"passed": true', '"passed":  true') },
      'X1.trusted',
    ],
    ['no gate record for a benchmark', { gateRecord: undefined }, 'X10.record'],
    [
      'a source_record_digest that is not the image',
      { spec: { ...spec, source_record_digest: `sha256:${'f'.repeat(64)}` } },
      'X10',
    ],
    ['egress on a benchmark', { spec: { ...spec, egress: true } }, 'X11'],
    ['an unmeasured probe', { spec: { ...spec, probe_status: 'unmeasured' } }, 'M9'],
    ['a 32-character id', { id: 'llm-inference-batching-scheduler' }, 'M7.id'],
    ['a spec naming another id', { spec: { ...spec, id: 'other-template' } }, 'M7.spec_id'],
    [
      'a spec naming another image',
      { spec: { ...spec, image: IMAGE.replace(/.$/, '0') } },
      'M7.spec_image',
    ],
    ['a tag, not a digest', { image: 'images/moca-microvm:latest' }, 'M1'],
    [
      'a registry the policy does not allow',
      { image: IMAGE.replace('images/', 'evil.example.com/x/') },
      'registry',
    ],
    ['8 GiB on a benchmark', { spec: { ...spec, guest_mb: 8192 } }, 'envelope'],
    ['an unknown profile', { profile: 'gold' }, 'profile'],
    [
      'a root identity into an image refusing commits',
      { spec: { ...spec, guest_home_gitconfig: true } },
      'M8',
    ],
  ])('refuses %s with 422 policy_refused and the rule', async (_n, over, rule) => {
    const d = stored();
    expect(await refusal(d, body(over))).toEqual({ code: 'policy_refused', rule });
    expect((await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body).toMatchObject({
      templates: [],
    });
  });

  it('records a refusal as a check on the template stream, and queues nothing', async () => {
    const d = stored();
    await refusal(d, body({ spec: { ...spec, egress: true } }));
    const chain = await d.provenance!.chain(`template/${ID}`);
    expect(chain.map((r) => r.kind)).toEqual(['check']);
    expect(chain[0].body).toMatchObject({ outcome: 'refused' });
  });

  it('X12 fails closed: skip_git_identity_check with a gate record that never measured the identity', async () => {
    const g = JSON.parse(GATE);
    delete g.observed.guest.git_identity;
    const bytes = JSON.stringify(g);
    const d = stored({
      ...benchmarkPolicy,
      trustedGateRecords: [`sha256:${sha256Hex(Buffer.from(bytes))}`],
    });
    expect(await refusal(d, body({ gateRecord: bytes }))).toEqual({
      code: 'policy_refused',
      rule: 'X12',
    });
  });

  it("records a refusal on a new id or the caller's own, never on another subject's", async () => {
    const d = stored();
    await create(d); // alice owns ID now
    const len = async () => (await d.provenance!.chain(`template/${ID}`)).length;
    const before = await len();
    const bad = body({ image: 'docker.io/library/python:3.12' }); // refused: an unpinned image
    // bob's refused create on alice's id answers as a refusal, and writes nothing to her stream.
    await expect(create(d, bad, bob)).rejects.toMatchObject({ code: 'policy_refused' });
    expect(await len()).toBe(before);
    // alice's own refused create is recorded on her stream.
    await expect(create(d, bad)).rejects.toMatchObject({ code: 'policy_refused' });
    expect((await d.provenance!.chain(`template/${ID}`)).at(-1)).toMatchObject({
      kind: 'check',
      body: { outcome: 'refused' },
    });
    // A refusal on an id no template holds yet is recorded too.
    await expect(create(d, { ...bad, id: 'fresh-id' }, bob)).rejects.toMatchObject({
      code: 'policy_refused',
    });
    expect((await d.provenance!.chain('template/fresh-id')).map((r) => r.kind)).toEqual(['check']);
  });

  it('lets a base-profile template through with no gate record', async () => {
    const d = stored();
    const r = await create(
      d,
      body({
        profile: 'base',
        gateRecord: undefined,
        spec: { ...spec, source_record_digest: undefined, skip_git_identity_check: false },
      }),
    );
    expect(r.status).toBe(202);
  });

  it("creates the default sandbox image's sample under base, once its registry is allowed", async () => {
    const { id, image, schema: _s, ...rest } = DEFAULT_SPEC;
    const b = { id, image, spec: rest };
    // The base policy allows only the build host's default registry; the sample is on ghcr.io.
    expect(await refusal(stored(), b)).toEqual({ code: 'policy_refused', rule: 'registry' });
    const d = stored({ ...benchmarkPolicy, allowedRegistries: ['<default>', 'ghcr.io'] });
    const r = await create(d, b);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ templateId: 'default', status: 'queued' });
    const t = (
      await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: String(id) } }), d)
    ).body as Body;
    expect(t.builds[0]).toMatchObject({ profile: 'base', spec: { guest_mb: 256, vcpus: 1 } });
  });

  it('keeps ids unique per deployment: 409 template_exists for another subject, a new build for the owner', async () => {
    const d = stored();
    await create(d);
    expect(await codeOf(() => create(d, body(), bob))).toBe('template_exists');
    expect(
      (await create(d, body({ spec: { ...spec, description: 'another build' } }))).status,
    ).toBe(202);
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds).toHaveLength(2);
  });

  it('reuses a build with the same inputs (§3.2): no second build, and a new one when they differ', async () => {
    const d = stored();
    const first = await create(d);
    const again = await create(d);
    // Still queued: the same build is answered, followed by its handle.
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ status: 'queued', buildId: null, reused: true });
    expect((again.body as Body).build).toBe((first.body as Body).build);
    const builds = async () =>
      ((await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d)).body as Body)
        .builds as Body[];
    expect(await builds()).toHaveLength(1);
    // A different spec is a different build.
    expect(
      (await create(d, body({ spec: { ...spec, description: 'another build' } }))).body,
    ).not.toHaveProperty('reused');
    expect(await builds()).toHaveLength(2);
  });

  it('answers a registered build 200 with its buildId, and builds again after a failure', async () => {
    const d = stored();
    await create(d);
    const setStatus = (status: string, buildId?: string) =>
      d.templates!.update!(ID, async (cur) => ({
        ...cur!,
        builds: cur!.builds.map((x) => ({
          ...x,
          status: status as never,
          ...(buildId ? { buildId } : {}),
        })),
      }));
    await setStatus('registered', 'sha256:' + 'a'.repeat(64));
    const r = await create(d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'registered',
      buildId: 'sha256:' + 'a'.repeat(64),
      build: `/v1/templates/${ID}/builds/sha256:${'a'.repeat(64)}`,
      reused: true,
    });
    await setStatus('failed');
    expect((await create(d)).status).toBe(202);
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds).toHaveLength(2);
  });

  it("hides another's private template behind 404 even on create", async () => {
    const d = stored();
    await create(d, body({ visibility: 'private' }));
    expect(await codeOf(() => create(d, body(), bob))).toBe('template_not_found');
  });

  it('POST /v1/templates/{id}/builds: the owner adds a build; others and unknown ids are refused', async () => {
    const d = stored();
    await create(d);
    const r = await HANDLERS.createTemplateBuild!(
      ctx({ principal: alice, params: { id: ID }, body: body() }),
      d,
    );
    expect(r.status).toBe(202);
    expect(
      await codeOf(() =>
        HANDLERS.createTemplateBuild!(ctx({ principal: bob, params: { id: ID }, body: body() }), d),
      ),
    ).toBe('template_exists');
    expect(
      await codeOf(() =>
        HANDLERS.createTemplateBuild!(
          ctx({ principal: alice, params: { id: 'nope' }, body: body({ id: 'nope' }) }),
          d,
        ),
      ),
    ).toBe('template_not_found');
  });

  it('enforces the per-subject quotas (§6.2): 429 quota_exceeded, naming which', async () => {
    const d = stored({ ...benchmarkPolicy, quota: { templates: 1, buildsQueued: 2, active: 1 } });
    await create(d);
    await create(d, body({ spec: { ...spec, description: 'a second build' } }));
    const e = await create(d, body({ spec: { ...spec, description: 'a third' } })).catch((x) => x);
    expect(e.code).toBe('quota_exceeded');
    expect(e.extra).toEqual({ quota: 'buildsQueued' });
    const other = await create(d, body({ id: 'other-template' })).catch((x) => x);
    expect(other.extra).toEqual({ quota: 'templates' });
  });

  it('counts a probing build as queued, and charges an admin-added build to the owner', async () => {
    const d = stored({ ...benchmarkPolicy, quota: { templates: 10, buildsQueued: 1, active: 1 } });
    await create(d);
    await d.templates!.update!(ID, async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((b) => ({ ...b, status: 'probing' as const })),
    }));
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.buildsQueued.used).toBe(1);
    const more = (principal: typeof alice) =>
      HANDLERS.createTemplateBuild!(
        ctx({
          principal,
          params: { id: ID },
          body: body({ spec: { ...spec, description: 'another build' } }),
        }),
        d,
      );
    expect((await more(alice).catch((x) => x)).extra).toEqual({ quota: 'buildsQueued' });
    // The admin's build of alice's template is alice's: refused on her quota, not the admin's.
    expect((await more(admin).catch((x) => x)).extra).toEqual({ quota: 'buildsQueued' });
    const qa = (await HANDLERS.getQuota!(ctx({ principal: admin }), d)).body as Body;
    expect(qa.buildsQueued.used).toBe(0);
  });

  it('holds the quotas under concurrent creates for different ids', async () => {
    const d = stored({ ...benchmarkPolicy, quota: { templates: 1, buildsQueued: 10, active: 1 } });
    const ids = ['par-a', 'par-b', 'par-c'];
    const rs = await Promise.allSettled(ids.map((id) => create(d, body({ id }))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = rs.flatMap((r) => (r.status === 'rejected' ? [r.reason.code] : []));
    expect(codes).toEqual(['quota_exceeded', 'quota_exceeded']);
    const listed = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(listed.templates).toHaveLength(1);

    // buildsQueued, with two new builds of two of one's own templates at once.
    const d2 = stored({ ...benchmarkPolicy, quota: { templates: 10, buildsQueued: 3, active: 1 } });
    await create(d2, body({ id: 'own-a' }));
    await create(d2, body({ id: 'own-b' }));
    const more = (id: string) =>
      HANDLERS.createTemplateBuild!(
        ctx({
          principal: alice,
          params: { id },
          body: body({ spec: { ...spec, description: `more of ${id}` } }),
        }),
        d2,
      );
    const rs2 = await Promise.allSettled([more('own-a'), more('own-b')]);
    expect(rs2.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs2.flatMap((r) => (r.status === 'rejected' ? [r.reason.extra] : []))).toEqual([
      { quota: 'buildsQueued' },
    ]);
  });

  it('answers that a deployment without SH_PROVENANCE_DIR stores no templates', async () => {
    const d = makeDeps({ config: { routeProfile: 'sandbox' } });
    expect(await codeOf(() => create(d))).toBe('invalid_request');
  });
});

describe('POST /v1/templates/{id}/builds/{build}/cancel (§5.1)', () => {
  const cancel = (d: TestDeps, build: string, principal = alice) =>
    HANDLERS.cancelTemplateBuild!(ctx({ principal, params: { id: ID, build } }), d);
  const handleOf = (r: { body: unknown }) => ((r.body as Body).build as string).split('/').pop()!;

  it('the owner cancels a queued build: failed, step cancelled, a build record naming who', async () => {
    const d = stored();
    const h = handleOf(await create(d));
    const r = await cancel(d, h);
    expect(r).toMatchObject({ status: 200, body: { templateId: ID, build: h, status: 'failed' } });
    const b = (
      await HANDLERS.getTemplateBuild!(ctx({ principal: alice, params: { id: ID, build: h } }), d)
    ).body as Body;
    expect(b).toMatchObject({
      status: 'failed',
      handle: h,
      reason: { step: 'cancelled', message: `cancelled by ${alice.sub}` },
    });
    const last = (await d.provenance!.chain(`template/${ID}`)).at(-1)!;
    expect(last).toMatchObject({
      kind: 'build',
      subject: alice.sub,
      body: { handle: h, outcome: 'cancelled' },
    });
    // A cancelled build is never reused, and no longer counts as queued.
    expect((await create(d)).body).not.toHaveProperty('reused');
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.buildsQueued.used).toBe(1);
  });

  it('frees the template slot of a template whose only build was cancelled', async () => {
    const d = stored({ ...benchmarkPolicy, quota: { templates: 1, buildsQueued: 10, active: 1 } });
    const h = handleOf(await create(d));
    expect((await create(d, body({ id: 'other-template' })).catch((x) => x)).extra).toEqual({
      quota: 'templates',
    });
    await cancel(d, h);
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.templates.used).toBe(0);
    expect((await create(d, body({ id: 'other-template' }))).status).toBe(202);
  });

  it('refuses another subject, an unknown build, and a build already failed', async () => {
    const d = stored();
    const h = handleOf(await create(d));
    expect(await codeOf(() => cancel(d, h, bob))).toBe('forbidden');
    expect(await codeOf(() => cancel(d, `b-${'0'.repeat(26)}`))).toBe('template_not_found');
    await cancel(d, h);
    expect(await codeOf(() => cancel(d, h))).toBe('invalid_request');
    // An admin may cancel any template's build.
    const h2 = handleOf(await create(d, body({ spec: { ...spec, description: 'b2' } })));
    expect((await cancel(d, h2, admin)).status).toBe(200);
  });
});

describe('policy and quota routes', () => {
  it('GET /v1/policy shows the policy and its record; PUT is admin-only and recorded', async () => {
    const d = stored();
    const g = (await HANDLERS.getPolicy!(ctx({ principal: alice }), d)).body as Body;
    expect(g.policy.trustedGateRecords).toEqual([GATE_SHA]);
    expect(g.digest).toMatch(/^sha256:/);
    expect(
      await codeOf(() => HANDLERS.putPolicy!(ctx({ principal: alice, body: DEFAULT_POLICY }), d)),
    ).toBe('forbidden');
    const p = (await HANDLERS.putPolicy!(ctx({ principal: admin, body: DEFAULT_POLICY }), d))
      .body as Body;
    expect(p.record).not.toBe(g.record);
    expect(
      await codeOf(() =>
        HANDLERS.putPolicy!(
          ctx({ principal: admin, body: { ...DEFAULT_POLICY, defaultProfile: 'none' } }),
          d,
        ),
      ),
    ).toBe('invalid_request');
    expect((await d.provenance!.chain('policy')).map((r) => r.subject)).toEqual([
      admin.sub,
      admin.sub,
    ]);
  });

  it("GET /v1/quota shows the limits and the caller's use", async () => {
    const d = stored();
    await create(d);
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q).toMatchObject({
      templates: { used: 1 },
      buildsQueued: { used: 1 },
      active: { used: 0 },
    });
    const qb = (await HANDLERS.getQuota!(ctx({ principal: bob }), d)).body as Body;
    expect(qb.templates.used).toBe(0);
    // The sandbox profile: its live-sandbox cap is shown, nothing used yet.
    expect(q.sandboxes).toEqual({ limit: 3, used: 0 });
  });

  it("shows the live-sandbox cap with the caller's live sandboxes, ended ones not counted", async () => {
    const d = stored();
    const nowS = NOW_MS / 1000;
    const rec = (id: string, expiresAt: number) => ({
      id,
      owner: alice.sub,
      tenant: alice.sub,
      name: '',
      template: 'default',
      worker: 'sbx_default',
      wsk: id,
      labels: {},
      createdAt: nowS - 120,
      expiresAt,
    });
    const limits = { perSubject: 3, total: 40, retentionS: 3600 };
    await d.sandboxes!.create(rec('sbx-live', nowS + 60), limits, nowS - 120);
    await d.sandboxes!.create(rec('sbx-ended', nowS - 60), limits, nowS - 120);
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.sandboxes).toEqual({ limit: 3, used: 1 });
    expect(q.active).toEqual({ limit: benchmarkPolicy.quota.active, used: 0 });
    // The harness profile holds no sandboxes: no cap is shown there.
    const h = stored();
    h.config = { ...h.config, routeProfile: 'harness', sandbox: undefined };
    h.sandboxes = undefined;
    expect((await HANDLERS.getQuota!(ctx({ principal: alice }), h)).body).not.toHaveProperty(
      'sandboxes',
    );
  });
});

describe('the rules alone', () => {
  it('reads the registry host of an image reference', () => {
    expect(registryOf('images/moca-microvm@sha256:ab')).toBe('<default>');
    expect(registryOf('ghcr.io/rossoctl/moca@sha256:ab')).toBe('ghcr.io');
    expect(registryOf('localhost:5000/x@sha256:ab')).toBe('localhost:5000');
    expect(registryOf('x@sha256:ab')).toBe('<default>');
  });

  it('passes the worked example in full under its policy, every rule listed', () => {
    const r = checkCreate(
      { id: ID, image: IMAGE, spec, profile: 'benchmark', gateRecordBytes: Buffer.from(GATE) },
      benchmarkPolicy,
    );
    expect(r.failed).toBeUndefined();
    expect(r.results.map((x) => x.rule)).toEqual(
      expect.arrayContaining([
        'M1',
        'M7.id',
        'M9',
        'X1',
        'X1.trusted',
        'X10',
        'X11',
        'X12',
        'X14',
        'X15',
      ]),
    );
  });
});

it("gives each build a distinct handle from a production id's random hex", async () => {
  const { randomUUID } = await import('node:crypto');
  const d = stored();
  d.newId = () => randomUUID();
  const a = ((await create(d)).body as Body).build as string;
  const b = ((await create(d, body({ spec: { ...spec, description: 'b' } }))).body as Body)
    .build as string;
  expect(a).not.toBe(b);
  expect(a).toMatch(/\/b-[0-9a-f]{26}$/);
});
