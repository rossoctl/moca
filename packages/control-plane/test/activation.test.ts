import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { place, readinessOf } from '../src/activation.js';
import { writeError } from '../src/errors.js';
import { HANDLERS } from '../src/handlers.js';
import { HostRegistry } from '../src/host-handlers.js';
import { ProvenanceStore, recordDigest as recordDigestOf } from '../src/provenance.js';
import type { SandboxTemplate } from '../src/sandbox-config.js';
import { FileTemplateCatalog, type TemplateDoc } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY } from '../src/template-policy.js';
import { alice, bob, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { id: _id, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const BASE_SPEC = { ...REST, source_record_digest: undefined, skip_git_identity_check: false };
const DIGEST = IMAGE.slice(IMAGE.indexOf('@') + 1);
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const hash = (c: string) => `sha256:${c.repeat(64)}`;

let seq = 0;
let now = NOW_MS;
async function setup(quotaActive = 8, declared: SandboxTemplate[] = []): Promise<TestDeps> {
  now = NOW_MS;
  const dir = mkdtempSync(join(tmpdir(), 'cp-act-'));
  const provenance = new ProvenanceStore({ dir, now: () => now });
  const d = makeDeps({
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    now: () => now,
    templates: new FileTemplateCatalog({ dir, declared, provenance, now: () => now }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    hosts: new HostRegistry(),
    presence: {
      list: async () => attachedNow.map((w) => ({ sandboxId: w, labels: {}, capacityMax: 3 })),
    },
    config: { routeProfile: 'sandbox' },
  });
  await d.policy!.set(
    { ...DEFAULT_POLICY, quota: { ...DEFAULT_POLICY.quota, active: quotaActive } },
    'github:admin',
  );
  return d;
}
let attachedNow: string[] = [];
const asHost = (host: string, params: Record<string, string> = {}, body: unknown = {}) =>
  ({ ...ctx({ params: { host, ...params }, body }), host }) as ReturnType<typeof ctx> & {
    host: string;
  };

/** Creates, builds and registers template `id` with manifest hash `h` (via the host routes). */
async function registered(
  d: TestDeps,
  id: string,
  h: string,
  worker: string,
  principal = alice,
): Promise<void> {
  await HANDLERS.createTemplate!(
    ctx({ principal, body: { id, image: IMAGE, spec: BASE_SPEC, profile: 'base' } }),
    d,
  );
  const c = (await HANDLERS.hostClaimBuilds!(asHost('host-1', {}, { max: 1 }), d)).body as Body;
  const build = c.builds[0].build;
  const r = (
    await HANDLERS.hostBuildReport!(
      asHost(
        'host-1',
        { build },
        {
          event: 'built',
          templateRecord: JSON.stringify({
            schema: 'moca-sbx-template/1',
            id,
            worker,
            snapshot: `${id}-x`,
            image: IMAGE,
            guest_ram_mb: 4096,
            manifest_hash: h,
          }),
          manifest: JSON.stringify({
            hash_version: 2,
            hash: h,
            guest_ram_mb: 4096,
            vcpus: 2,
            source_image_digest: DIGEST,
          }),
        },
      ),
      d,
    )
  ).body as Body;
  expect(r.status).toBe('registered');
}
const inventory = (d: TestDeps, host: string, holds: Record<string, string>, activeLimit: number) =>
  HANDLERS.hostInventory!(
    asHost(
      host,
      {},
      {
        holds: Object.entries(holds).map(([manifestHash, template]) => ({
          manifestHash,
          template,
        })),
        limits: { activeLimit, idleLimitSeconds: 3600 },
      },
    ),
    d,
  );
const readiness = async (d: TestDeps, id: string) =>
  ((await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id } }), d)).body as Body)
    .readiness;
const activate = (d: TestDeps, id: string, principal = alice, body: unknown = {}) =>
  HANDLERS.activateTemplate!(ctx({ principal, params: { id }, body }), d);

describe('activation (§6.2-§6.3)', () => {
  it('goes inactive -> activating -> active -> deactivating -> inactive, from leases, placement and presence', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    expect(await readiness(d, 't1')).toBe('inactive');
    const r = (await activate(d, 't1')).body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      buildId: hash('1'),
      host: 'host-1',
      leaseUntil: Math.floor(now / 1000) + 3600,
    });
    expect(await readiness(d, 't1')).toBe('activating');
    const w = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    attachedNow = ['sbx_t1'];
    expect(await readiness(d, 't1')).toBe('active');
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    expect(await readiness(d, 't1')).toBe('deactivating');
    expect(((await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body).stop).toHaveLength(1);
    attachedNow = [];
    expect(await readiness(d, 't1')).toBe('inactive');
    const kinds = (await d.provenance!.chain('template/t1')).map((x) => x.kind);
    expect(kinds.slice(-2)).toEqual(['activate', 'deactivate']);
  });

  it('ages a lease out: no renewal, no longer wanted', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1', alice, { leaseSeconds: 120 });
    expect(await readiness(d, 't1')).toBe('activating');
    now += 121_000;
    expect(await readiness(d, 't1')).toBe('inactive');
  });

  it('renews a lease without limit, a day at most per grant', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    for (let i = 0; i < 3; i++) {
      await activate(d, 't1', alice, { leaseSeconds: 86_400 });
      now += 43_200_000;
    }
    expect(await readiness(d, 't1')).not.toBe('inactive');
    await expect(activate(d, 't1', alice, { leaseSeconds: 86_401 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it("clamps the default lease from the holders' idle limits, and range-checks only an explicit one", async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    const idle = (host: string, holds: Record<string, string>, idleLimitSeconds: number) =>
      HANDLERS.hostInventory!(
        asHost(
          host,
          {},
          {
            holds: Object.entries(holds).map(([manifestHash, template]) => ({
              manifestHash,
              template,
            })),
            limits: { activeLimit: 2, idleLimitSeconds },
          },
        ),
        d,
      );
    const nowS = () => Math.floor(now / 1000);
    // Over a day: the default is a day, never a refusal of a request that named no lease.
    await idle('host-1', { [hash('1')]: 't1' }, 172_800);
    expect(((await activate(d, 't1')).body as Body).leaseUntil).toBe(nowS() + 86_400);
    // Under a minute: the default is a minute.
    await idle('host-1', { [hash('1')]: 't1' }, 5);
    expect(((await activate(d, 't1')).body as Body).leaseUntil).toBe(nowS() + 60);
    // Only the hosts that hold the build: another host's longer idle limit is not this build's.
    await idle('host-1', { [hash('1')]: 't1' }, 0);
    await idle('host-2', {}, 7200);
    expect(((await activate(d, 't1')).body as Body).leaseUntil).toBe(nowS() + 3600);
    // An explicit lease is the client's, and checked.
    for (const leaseSeconds of [59, 86_401, 'x', 1.5]) {
      await expect(activate(d, 't1', alice, { leaseSeconds })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  it('never evicts a leased build: over the limit is 409 no_active_slot with Retry-After', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    await activate(d, 't1', alice, { leaseSeconds: 600 });
    const e = await activate(d, 't2', bob).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect(e.retryAfterS).toBe(600);
    const res = { headersSent: false, status: 0, headers: {} as Record<string, string>, body: '' };
    writeError(
      {
        headersSent: false,
        writeHead: (st: number, h: Record<string, string>) => (
          (res.status = st),
          (res.headers = h)
        ),
        end: (b: string) => (res.body = b),
      },
      e,
    );
    expect(res.status).toBe(409);
    expect(res.headers['Retry-After']).toBe('600');
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'no_active_slot',
      readiness: 'unavailable',
    });
    // The held build is untouched; once its lease ends, the other fits.
    expect((await HANDLERS.hostWanted!(asHost('host-1'), d)).body).toMatchObject({
      run: [{ template: 't1' }],
    });
    now += 601_000;
    expect((await activate(d, 't2', bob)).status).toBe(200);
  });

  it('never evicts for a lease taken in the same second: the tie on since does not reorder placement', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    expect((await activate(d, 't2', bob)).status).toBe(200);
    const e = await activate(d, 't1', alice).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect((await HANDLERS.hostWanted!(asHost('host-1'), d)).body).toMatchObject({
      run: [{ template: 't2' }],
    });
  });

  it('refuses a build no host holds as template_unavailable, and a draft build too', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', {}, 2);
    expect(await activate(d, 't1').catch((x) => x.code)).toBe('template_unavailable');
    await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: { id: 'draft', image: IMAGE, spec: BASE_SPEC, profile: 'base' },
      }),
      d,
    );
    expect(await activate(d, 'draft').catch((x) => x.code)).toBe('template_unavailable');
  });

  it("caps a subject's active builds at quota.active", async () => {
    const d = await setup(1);
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    await activate(d, 't1');
    const e = await activate(d, 't2').catch((x) => x);
    expect(e.code).toBe('quota_exceeded');
    expect(e.extra).toEqual({ quota: 'active' });
    expect((await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body).toMatchObject({
      active: { limit: 1, used: 1 },
    });
  });

  it("keeps a shared build wanted while another subject's lease stands", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1', alice);
    await activate(d, 't1', bob);
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    expect(await readiness(d, 't1')).toBe('active');
  });

  it('fills the hosts block from the agents: limits, use, disk', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const b = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(b.hosts).toEqual([
      {
        id: 'host-1',
        active: { limit: 2, used: 1 },
        idleLimitSeconds: 3600,
        disk: { freeGb: 0, floorGb: 0 },
      },
    ]);
  });

  it("records a host's attach and detach reports for a build it holds, and refuses others", async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await HANDLERS.hostWorkerReport!(
      asHost('host-1', {}, { buildId: hash('1'), event: 'attached' }),
      d,
    );
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'activate',
      subject: 'host:host-1',
    });
    await expect(
      HANDLERS.hostWorkerReport!(
        asHost('host-2', {}, { buildId: hash('1'), event: 'attached' }),
        d,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('activation on first use (§6.4)', () => {
  const createSandbox = (d: TestDeps, body: Record<string, unknown>, principal = alice) =>
    HANDLERS.createSandbox!(ctx({ principal, body }), d);
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      const x = e as { code: string; extra?: Record<string, string>; retryAfterS?: number };
      return { code: x.code, readiness: x.extra?.readiness, retryAfterS: x.retryAfterS };
    }
    return { code: 'none' };
  };
  const leases = async (d: TestDeps, id: string) =>
    ((await d.templates!.get(id))!.builds[0]!.leases ?? []).filter(
      (l) => l.until > Math.floor(now / 1000),
    );

  it('starts the activation and answers 409 template_not_active; the retry creates once active', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    expect(await refusal(() => createSandbox(d, { template: 't1' }))).toEqual({
      code: 'template_not_active',
      readiness: 'activating',
      retryAfterS: 30,
    });
    // The lease is the caller's, recorded as first use, and the host is asked to run it.
    expect((await leases(d, 't1')).map((l) => l.subject)).toEqual([alice.sub]);
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({ kind: 'activate', body: { reason: 'first_use' } });
    const w = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    // No sandbox was kept while waiting.
    expect(await d.sandboxes!.listByOwner(alice.sub, Math.floor(now / 1000))).toHaveLength(0);
    // Still activating: the retry waits again, without a second lease.
    expect((await refusal(() => createSandbox(d, { template: 't1' }))).code).toBe(
      'template_not_active',
    );
    expect(await leases(d, 't1')).toHaveLength(1);
    attachedNow = ['sbx_t1'];
    const r = await createSandbox(d, { template: 't1' });
    expect(r.status).toBe(201);
    expect((r.body as Body).buildId).toBe(hash('1'));
  });

  it('with activate: false, answers 409 and starts nothing', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    expect(await refusal(() => createSandbox(d, { template: 't1', activate: false }))).toEqual({
      code: 'template_not_active',
      readiness: 'inactive',
      retryAfterS: 30,
    });
    expect(await leases(d, 't1')).toHaveLength(0);
    expect(await refusal(() => createSandbox(d, { template: 't1', activate: 'no' }))).toMatchObject(
      { code: 'invalid_request' },
    );
  });

  it('answers what activate would: no_active_slot when the host is full', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    await activate(d, 't1', bob);
    expect((await refusal(() => createSandbox(d, { template: 't2' }))).code).toBe('no_active_slot');
    expect(await leases(d, 't2')).toHaveLength(0);
  });

  it('refuses before any configured host has reported, and serves an attached worker', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.config.templateHosts = [{ id: 'host-1', token: 'f'.repeat(64) }];
    // No inventory from host-1 yet: refused, not left to wait at the relay; the lease is taken.
    expect(await refusal(() => createSandbox(d, { template: 't1' }))).toEqual({
      code: 'template_not_active',
      readiness: 'activating',
      retryAfterS: 30,
    });
    expect((await leases(d, 't1')).map((l) => l.subject)).toEqual([alice.sub]);
    expect(await d.sandboxes!.listByOwner(alice.sub, Math.floor(now / 1000))).toHaveLength(0);
    // Once host-1 reports, it is asked to run the build the lease wants.
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    const w = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    // A control plane restarted under attached workers (no inventory yet) still serves them.
    d.hosts = new HostRegistry();
    attachedNow = ['sbx_t1'];
    expect((await createSandbox(d, { template: 't1' })).status).toBe(201);
  });

  it('never gates a template imported from SH_SANDBOX_TEMPLATES, beside a host-built one', async () => {
    const d = await setup(8, [{ id: 'py', worker: 'sbx_py', description: 'py', tools: [] }]);
    attachedNow = ['sbx_py'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.config.templateHosts = [{ id: 'host-1', token: 'f'.repeat(64) }];
    // Hosts configured, none reported yet: the imported template serves, the host-built one waits.
    expect((await createSandbox(d, { template: 'py' })).status).toBe(201);
    expect((await refusal(() => createSandbox(d, { template: 't1' }))).code).toBe(
      'template_not_active',
    );
    // After the first inventory: the imported one still serves, and is active, never deactivating.
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    expect(await readiness(d, 'py')).toBe('active');
    expect((await createSandbox(d, { template: 'py' })).status).toBe(201);
    // Its worker detached: inactive, and the create is the relay's to answer, as without hosts.
    attachedNow = [];
    expect(await readiness(d, 'py')).toBe('inactive');
    expect((await createSandbox(d, { template: 'py' })).status).toBe(201);
    // It takes no lease, so it is never placed and no host is asked to run or stop it.
    expect(await activate(d, 'py').catch((x) => x.code)).toBe('invalid_request');
    expect(await leases(d, 'py')).toHaveLength(0);
    const w = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect([...w.run, ...w.stop].map((x: Body) => x.template)).not.toContain('py');
    // The host-built one, leased by alice's first try and now attached, serves (bob: alice's
    // live-sandbox cap is spent above).
    attachedNow = ['sbx_t1'];
    expect((await createSandbox(d, { template: 't1' }, bob)).status).toBe(201);
  });

  it('changes nothing without host agents: the create succeeds as before', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.hosts = undefined;
    expect((await createSandbox(d, { template: 't1' })).status).toBe(201);
  });
});

describe('every link of a sandbox is a record digest (§7.1)', () => {
  it('sandbox -> its lease (the activate record) -> the build record; its end too', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (
      await HANDLERS.createSandbox!(
        ctx({ principal: alice, body: { template: `t1@${hash('1')}` } }),
        d,
      )
    ).body as Body;
    const chain = await d.provenance!.chain('template/t1');
    const digestOf = (r: (typeof chain)[number]) => recordDigestOf(r);
    const created = chain.find(
      (r) => r.kind === 'sandbox' && (r.body as Body).state === 'created',
    )!;
    expect(created).toMatchObject({
      subject: alice.sub,
      body: { sandboxId: sb.id, buildId: hash('1'), templateManifestHash: hash('1') },
    });
    // The lease is exactly the activate record that granted it, and the lease stores its digest.
    const act = chain.find((r) => digestOf(r) === (created.body as Body).lease)!;
    expect(act).toMatchObject({
      kind: 'activate',
      subject: alice.sub,
      body: { buildId: hash('1'), host: 'host-1' },
    });
    const lease = (await d.templates!.get('t1'))!.builds[0]!.leases![0]!;
    expect(lease.record).toBe(digestOf(act));
    // The build record, by its manifest hash, is what the registration check cited.
    const build = chain.find(
      (r) => r.kind === 'build' && (r.body as Body).manifest_hash === hash('1'),
    )!;
    const check = chain.find((r) => r.kind === 'check' && (r.body as Body).at === 'registration')!;
    expect((check.body as Body).build).toBe(digestOf(build));
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    const after = await d.provenance!.chain('template/t1');
    expect(
      after.find((r) => r.kind === 'sandbox' && (r.body as Body).state === 'terminated'),
    ).toMatchObject({
      subject: alice.sub,
      body: { sandboxId: sb.id, reason: 'deleted' },
    });
  });

  it('a sandbox with no lease cites none (a deployment without host agents)', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.hosts = undefined;
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    const created = (await d.provenance!.chain('template/t1')).find(
      (r) => r.kind === 'sandbox' && (r.body as Body).sandboxId === sb.id,
    )!;
    expect((created.body as Body).lease).toBeNull();
  });

  it("an expired sandbox's end is recorded once, by the janitor's sweep, with its true end", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    const janitor = () =>
      HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    await janitor();
    const ends = async () =>
      (await d.provenance!.chain('template/t1')).filter(
        (r) => r.kind === 'sandbox' && (r.body as Body).state === 'terminated',
      );
    expect(await ends()).toHaveLength(0);
    now += 8 * 86_400_000;
    await janitor();
    await janitor();
    const e = await ends();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      subject: 'janitor',
      body: { sandboxId: sb.id, reason: 'expired', expiresAt: sb.expiresAt },
    });
  });
});

describe('activation is one check-and-write at a time across templates', () => {
  /**
   * Holds every `activate` record's append until `release()`: each activation, once past its
   * checks, waits inside its critical section, so without the lock a second activation reads the
   * catalog before the first one's lease is written: a real race, not a sequence.
   */
  function gateActivateRecords(d: TestDeps) {
    const prov = d.provenance!;
    const orig = prov.append.bind(prov);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered = 0;
    prov.append = (async (rec: Parameters<typeof orig>[0]) => {
      if (rec.kind === 'activate') {
        entered++;
        await gate;
      }
      return orig(rec);
    }) as typeof prov.append;
    return {
      release: () => open(),
      entered: () => entered,
    };
  }
  /**
   * Starts every op at once, waits until all are held at the gate (or 250 ms: under the lock only
   * one can get there), releases it, and answers each op's outcome: 'ok' or its error code.
   */
  async function race(g: ReturnType<typeof gateActivateRecords>, ops: (() => Promise<unknown>)[]) {
    const all = Promise.allSettled(ops.map((f) => f()));
    for (let i = 0; i < 50 && g.entered() < ops.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    g.release();
    return (await all).map((r) =>
      r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code ?? r.reason),
    );
  }
  const liveLeasesOf = async (d: TestDeps) =>
    (await d.templates!.list())
      .flatMap((x) => x.builds)
      .flatMap((b) => (b.leases ?? []).filter((l) => l.until > Math.floor(now / 1000)));

  it("two concurrent activations of different templates never pass one subject's active quota", async () => {
    const d = await setup(2);
    attachedNow = [];
    await registered(d, 't0', hash('0'), 'sbx_t0');
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await registered(d, 't3', hash('3'), 'sbx_t3');
    await inventory(
      d,
      'host-1',
      { [hash('0')]: 't0', [hash('1')]: 't1', [hash('2')]: 't2', [hash('3')]: 't3' },
      8,
    );
    await activate(d, 't0'); // one of alice's two held already: room for exactly one more
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1'),
      () => activate(d, 't2'),
      () => activate(d, 't3'),
    ]);
    expect(out.filter((x) => x === 'ok')).toHaveLength(1);
    expect(out.filter((x) => x === 'quota_exceeded')).toHaveLength(2);
    expect((await liveLeasesOf(d)).filter((l) => l.subject === alice.sub)).toHaveLength(2);
    // Every kept lease names its record, and no refused one left a record.
    const recs = (
      await Promise.all(['t0', 't1', 't2', 't3'].map((id) => d.provenance!.chain(`template/${id}`)))
    )
      .flat()
      .filter((r) => r.kind === 'activate');
    expect(recs).toHaveLength(2);
    for (const l of await liveLeasesOf(d))
      expect(recs.map((r) => recordDigestOf(r))).toContain(l.record);
  });

  it("two concurrent activations of different templates never pass a host's activeLimit", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    const g = gateActivateRecords(d);
    const out = await race(g, [() => activate(d, 't1', alice), () => activate(d, 't2', bob)]);
    expect([...out].sort()).toEqual(['no_active_slot', 'ok']);
    expect(await liveLeasesOf(d)).toHaveLength(1);
    expect((await HANDLERS.hostWanted!(asHost('host-1'), d)).body).toMatchObject({
      run: [{ template: out[0] === 'ok' ? 't1' : 't2' }],
    });
  });

  it('activation on first use takes the same lock as an owner activation', async () => {
    const d = await setup(1);
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1'),
      () => HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't2' } }), d),
    ]);
    // The first-use create answers template_not_active when it took the lease, quota_exceeded when not.
    expect(
      (out[0] === 'ok' && out[1] === 'quota_exceeded') ||
        (out[0] === 'quota_exceeded' && out[1] === 'template_not_active'),
    ).toBe(true);
    expect((await liveLeasesOf(d)).filter((l) => l.subject === alice.sub)).toHaveLength(1);
  });

  it('a renewal does not count against itself, also beside a concurrent activation', async () => {
    const d = await setup(1);
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    const first = (await activate(d, 't1', alice, { leaseSeconds: 600 })).body as Body;
    now += 60_000;
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1', alice, { leaseSeconds: 600 }),
      () => activate(d, 't2', alice),
    ]);
    expect(out).toEqual(['ok', 'quota_exceeded']);
    const ls = await liveLeasesOf(d);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ subject: alice.sub, until: first.leaseUntil + 60 });
  });
});

describe('place, alone', () => {
  const doc = (id: string, h: string, sinceS: number, until = 10_000): TemplateDoc => ({
    schema: 'moca-template/1',
    id,
    owner: 'github:1',
    visibility: 'deployment',
    description: '',
    tags: { default: h },
    builds: [
      {
        buildId: h,
        status: 'registered',
        profile: 'base',
        worker: `w_${id}`,
        spec: { tools: [] },
        createdAt: 0,
        leases: [{ subject: 'github:1', until, since: sinceS }],
      },
    ],
    createdAt: 0,
  });
  it('places first-leased first, on the least-used holder, and never evicts', () => {
    const docs = [doc('a', hash('a'), 3), doc('b', hash('b'), 1), doc('c', hash('c'), 2)];
    const hosts = [
      { id: 'h1', holds: { [hash('a')]: 'a', [hash('b')]: 'b', [hash('c')]: 'c' }, activeLimit: 1 },
      { id: 'h2', holds: { [hash('a')]: 'a', [hash('c')]: 'c' }, activeLimit: 1 },
    ];
    const p = place(docs, hosts, 0);
    expect([...p.placed]).toEqual([
      [hash('b'), 'h1'],
      [hash('c'), 'h2'],
    ]);
    expect(p.unplaced.get(hash('a'))).toBe('no_slot');
  });
  it('reads readiness unknown when presence is unreadable', () => {
    expect(readinessOf(doc('a', hash('a'), 0).builds[0]!, 0, null, null)).toBe('unknown');
  });
});
