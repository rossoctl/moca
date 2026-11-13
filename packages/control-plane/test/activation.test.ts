import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { place, readinessOf } from '../src/activation.js';
import { writeError } from '../src/errors.js';
import { HANDLERS } from '../src/handlers.js';
import { HOST_STALE_S, HostRegistry } from '../src/host-handlers.js';
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
      list: async () => {
        if (attachedNow === null) throw new Error('presence unreadable');
        return attachedNow.map((w) => ({ sandboxId: w, labels: {}, capacityMax: 3 }));
      },
    },
    config: { routeProfile: 'sandbox' },
  });
  await d.policy!.set(
    { ...DEFAULT_POLICY, quota: { ...DEFAULT_POLICY.quota, active: quotaActive } },
    'github:admin',
  );
  return d;
}
/** The relay's attached workers; null: presence cannot be read. */
let attachedNow: string[] | null = [];
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
  opts: { another?: boolean; vcpus?: number; sourceDigest?: string; status?: string } = {},
): Promise<void> {
  if (opts.another)
    // Another build of an existing template, from the same image with another spec.
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal,
        params: { id },
        body: { image: IMAGE, spec: { ...BASE_SPEC, vcpus: opts.vcpus ?? 2 }, profile: 'base' },
      }),
      d,
    );
  else
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
            vcpus: opts.vcpus ?? 2,
            source_image_digest: opts.sourceDigest ?? DIGEST,
          }),
        },
      ),
      d,
    )
  ).body as Body;
  expect(r.status).toBe(opts.status ?? 'registered');
}
const inventory = (
  d: TestDeps,
  host: string,
  holds: Record<string, string>,
  activeLimit: number,
  running: string[] = [],
) =>
  HANDLERS.hostInventory!(
    asHost(
      host,
      {},
      {
        holds: Object.entries(holds).map(([manifestHash, template]) => ({
          manifestHash,
          template,
          ...(running.includes(manifestHash) ? { running: true } : {}),
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
      await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
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

  it("answers Retry-After from the build's own holders: when one of their leased builds loses its last lease", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await registered(d, 't3', hash('3'), 'sbx_t3');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    await inventory(d, 'host-2', { [hash('3')]: 't3' }, 1);
    // A lease ending soon on another host's build frees nothing for t2.
    expect(((await activate(d, 't3', alice, { leaseSeconds: 60 })).body as Body).host).toBe(
      'host-2',
    );
    // t1 holds host-1's slot until its last lease ends (1200 s), not its first (600 s).
    await activate(d, 't1', bob, { leaseSeconds: 600 });
    await activate(d, 't1', alice, { leaseSeconds: 1200 });
    const e = await activate(d, 't2', bob).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect(e.retryAfterS).toBe(1200);
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

  it('keeps a running build on its host: an earlier lease ending moves nothing', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await registered(d, 't3', hash('3'), 'sbx_t3');
    const both = { [hash('1')]: 't1', [hash('2')]: 't2' };
    await inventory(d, 'host-1', { ...both, [hash('3')]: 't3' }, 1);
    await inventory(d, 'host-2', both, 1);
    expect(((await activate(d, 't2', bob)).body as Body).host).toBe('host-1');
    now += 1000;
    expect(((await activate(d, 't1')).body as Body).host).toBe('host-2');
    const report = (host: string, h: string, event: string) =>
      HANDLERS.hostWorkerReport!(asHost(host, {}, { buildId: h, event }), d);
    await report('host-1', hash('2'), 'attached');
    await report('host-2', hash('1'), 'attached');
    // t2's lease ends: t1 stays on host-2, which runs it; host-1 is told to stop t2, not to run t1.
    await HANDLERS.deactivateTemplate!(ctx({ principal: bob, params: { id: 't2' }, body: {} }), d);
    expect((await HANDLERS.hostWanted!(asHost('host-2'), d)).body).toMatchObject({
      run: [{ template: 't1' }],
    });
    const w1 = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect(w1.run).toEqual([]);
    expect(w1.stop).toContainEqual({ template: 't2', buildId: hash('2'), worker: 'sbx_t2' });
    await report('host-1', hash('2'), 'detached');
    // host-1's slot is free for a build only it holds; the hosts block counts what each runs.
    expect(((await activate(d, 't3')).body as Body).host).toBe('host-1');
    const hb = ((await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body).hosts;
    expect(hb.map((h: Body) => [h.id, h.active.used])).toEqual([
      ['host-1', 1],
      ['host-2', 1],
    ]);
  });

  it("counts a draining worker against its host's activeLimit until its last sandbox ends", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    const holds = { [hash('1')]: 't1', [hash('2')]: 't2' };
    await inventory(d, 'host-1', holds, 1);
    await activate(d, 't1');
    await HANDLERS.hostWorkerReport!(
      asHost('host-1', {}, { buildId: hash('1'), event: 'attached' }),
      d,
    );
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    // t1 has no lease but drains a live sandbox: never stopped, and it keeps host-1's one slot.
    const w = (await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body;
    expect([...w.run, ...w.stop].map((x: Body) => x.template)).not.toContain('t1');
    expect((await activate(d, 't2', bob).catch((x) => x)).code).toBe('no_active_slot');
    // Its last sandbox ends: it is to stop, and its slot is free.
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    expect(((await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body).stop).toContainEqual({
      template: 't1',
      buildId: hash('1'),
      worker: 'sbx_t1',
    });
    expect(((await activate(d, 't2', bob)).body as Body).host).toBe('host-1');
  });

  it("stops a host's copy of a leased build that another host runs and is placed on", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    const holds = { [hash('1')]: 't1' };
    await inventory(d, 'host-1', holds, 2, [hash('1')]);
    await inventory(d, 'host-2', holds, 2, [hash('1')]);
    expect(((await activate(d, 't1')).body as Body).host).toBe('host-1');
    expect((await HANDLERS.hostWanted!(asHost('host-2'), d)).body).toEqual({
      run: [],
      stop: [{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }],
    });
  });

  it('leaves out a host whose last inventory is older than HOST_STALE_S, until it reports again', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    const both = { [hash('1')]: 't1', [hash('2')]: 't2' };
    await inventory(d, 'host-1', both, 1);
    await inventory(d, 'host-2', both, 1);
    now += (HOST_STALE_S - 60) * 1000;
    await inventory(d, 'host-2', both, 1);
    now += 61_000;
    // host-1 is silent past the limit: no placement on it, no slot of its counted, not listed.
    expect(((await activate(d, 't1')).body as Body).host).toBe('host-2');
    expect((await activate(d, 't2').catch((x) => x)).code).toBe('no_active_slot');
    const hb = ((await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body).hosts;
    expect(hb.map((h: Body) => h.id)).toEqual(['host-2']);
    // It reports again: back in placement, its slot free for the other build.
    await inventory(d, 'host-1', both, 1);
    expect((await activate(d, 't2')).status).toBe(200);
    // Every host silent: readiness is the workers' presence alone, as before any host reported.
    now += (HOST_STALE_S + 1) * 1000;
    attachedNow = ['sbx_t1'];
    expect(await readiness(d, 't1')).toBe('active');
    expect(await readiness(d, 't2')).toBe('inactive');
  });

  it("records a repeated refusal once while the build stays in the host's run", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const refusals = async () =>
      (await d.provenance!.chain('template/t1')).filter(
        (x) => x.subject === 'host:host-1' && (x.body as Body).event === 'refused',
      ).length;
    const refuse = (reason: string) =>
      HANDLERS.hostWorkerReport!(
        asHost('host-1', {}, { buildId: hash('1'), event: 'refused', reason }),
        d,
      );
    const poll = async (reason: string) => {
      await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
      expect(((await HANDLERS.hostWanted!(asHost('host-1'), d)).body as Body).run).toHaveLength(1);
      return (await refuse(reason)).body as Body;
    };
    expect(await poll('worker not installed')).toEqual({ recorded: 'refused' });
    for (let i = 0; i < 3; i++)
      expect(await poll('worker not installed')).toEqual({ recorded: null });
    expect(await refusals()).toBe(1);
    // A different reason is new, and so is the same one after any other report.
    await poll('systemctl start sbx-worker@sbx_t1.service failed');
    await HANDLERS.hostWorkerReport!(
      asHost('host-1', {}, { buildId: hash('1'), event: 'attached' }),
      d,
    );
    await poll('systemctl start sbx-worker@sbx_t1.service failed');
    expect(await refusals()).toBe(3);
    // Once the build leaves the host's run, a later refusal is a new episode, recorded.
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    await HANDLERS.hostWanted!(asHost('host-1'), d);
    await activate(d, 't1');
    await poll('systemctl start sbx-worker@sbx_t1.service failed');
    expect(await refusals()).toBe(4);
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
    // Still activating: the retries wait again, without a second lease, a renewal or a record.
    const firstUse = async () =>
      (await d.provenance!.chain('template/t1')).filter((x) => x.kind === 'activate').length;
    const before = await firstUse();
    const until = (await leases(d, 't1'))[0]!.until;
    now += 30_000;
    for (let i = 0; i < 3; i++) {
      expect(await refusal(() => createSandbox(d, { template: 't1' }))).toEqual({
        code: 'template_not_active',
        readiness: 'activating',
        retryAfterS: 30,
      });
    }
    expect(await leases(d, 't1')).toHaveLength(1);
    expect((await leases(d, 't1'))[0]!.until).toBe(until);
    expect(await firstUse()).toBe(before);
    // Another subject's first use takes its own lease.
    expect((await refusal(() => createSandbox(d, { template: 't1' }, bob))).code).toBe(
      'template_not_active',
    );
    expect(await firstUse()).toBe(before + 1);
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

describe('retire (§5.1)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const retire = (d: TestDeps, id: string, principal = alice, body: unknown = {}) =>
    HANDLERS.retireTemplate!(ctx({ principal, params: { id }, body }), d);
  const retireBuild = (d: TestDeps, id: string, build: string, principal = alice) =>
    HANDLERS.retireTemplateBuild!(ctx({ principal, params: { id, build } }), d);
  const sandbox = (d: TestDeps, template: string) =>
    HANDLERS.createSandbox!(ctx({ principal: alice, body: { template } }), d);
  const wanted = async (d: TestDeps, host: string) =>
    (await HANDLERS.hostWanted!(asHost(host), d)).body as Body;

  it('retires a template: builds retired, leases gone, 410 on use, a retire record per build', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const r = await retire(d, 't1', alice, { reason: 'superseded' });
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body).toMatchObject({ templateId: 't1', subject: alice.sub, status: 'retired' });
    // `build` is the handle the create answered; `buildId` the registered build's id.
    expect(body.builds).toEqual([
      {
        build: expect.stringMatching(/^b-[0-9a-f]{26}$/),
        buildId: hash('1'),
        readiness: 'retired',
        record: expect.any(String),
      },
    ]);
    expect((await d.templates!.get('t1'))!.builds[0]).toMatchObject({
      status: 'retired',
      leases: [],
    });
    expect(await readiness(d, 't1')).toBe('retired');
    const b = (
      await HANDLERS.getTemplateBuild!(
        ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
        d,
      )
    ).body as Body;
    // The host still holds its snapshot: removing it is not the retire's.
    expect(b).toMatchObject({ status: 'retired', readiness: 'retired', heldBy: ['host-1'] });
    // The record names the caller, the status before and the build record, by digest.
    const chain = await d.provenance!.chain('template/t1');
    const rec = chain.at(-1)!;
    expect(recordDigestOf(rec)).toBe(body.builds[0].record);
    const buildRec = chain.find((x) => x.kind === 'build' && (x.body as Body).outcome === 'built')!;
    expect(rec).toMatchObject({
      kind: 'retire',
      subject: alice.sub,
      body: {
        build: body.builds[0].build,
        buildId: hash('1'),
        buildRecord: recordDigestOf(buildRec),
        from: 'registered',
        reason: 'superseded',
      },
    });
    // Use is refused as gone, not unknown: by id, by tag and by build; an activation too.
    expect(await refusal(() => sandbox(d, 't1'))).toBe('template_retired');
    expect(await refusal(() => sandbox(d, 't1:default'))).toBe('template_retired');
    expect(await refusal(() => sandbox(d, `t1@${hash('1')}`))).toBe('template_retired');
    expect(await refusal(() => sandbox(d, 'nope'))).toBe('unknown_template');
    expect(await refusal(() => activate(d, 't1'))).toBe('template_retired');
    // Idempotent: a second retire answers retired, with no second record.
    const again = (await retire(d, 't1')).body as Body;
    expect(again.builds).toEqual([{ ...body.builds[0], record: null }]);
    expect((await d.provenance!.chain('template/t1')).length).toBe(chain.length);
    // The quota no longer counts it; a new build is the way back, under the same id.
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.templates.used).toBe(0);
    const nb = await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: 't1' },
        body: { image: IMAGE, spec: BASE_SPEC, profile: 'base' },
      }),
      d,
    );
    expect((nb.body as Body).status).toBe('queued');
  });

  it("drops a retired build's worker to stop in the wanted state, and takes its detached report", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await inventory(d, 'host-2', {}, 2);
    await activate(d, 't1');
    expect((await wanted(d, 'host-1')).run).toHaveLength(1);
    await retire(d, 't1');
    const entry = { template: 't1', buildId: hash('1'), worker: 'sbx_t1' };
    expect(await wanted(d, 'host-1')).toEqual({ run: [], stop: [entry] });
    // A host that does not hold it is told nothing about it.
    expect(await wanted(d, 'host-2')).toEqual({ run: [], stop: [] });
    // The stop is reported as for any worker; a start of a retired build is not taken.
    await HANDLERS.hostWorkerReport!(
      asHost('host-1', {}, { buildId: hash('1'), event: 'detached' }),
      d,
    );
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'deactivate',
      subject: 'host:host-1',
      body: { buildId: hash('1'), event: 'detached' },
    });
    expect(
      await refusal(() =>
        HANDLERS.hostWorkerReport!(
          asHost('host-1', {}, { buildId: hash('1'), event: 'attached' }),
          d,
        ),
      ),
    ).toBe('not_found');
  });

  it("reports a retired build's capacity while its worker still runs, and null once it stops", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    await retire(d, 't1');
    const read = async () =>
      (
        await HANDLERS.getTemplateBuild!(
          ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
          d,
        )
      ).body as Body;
    // Its worker still holds a presence record: the host has not stopped it yet.
    expect(await read()).toMatchObject({
      status: 'retired',
      readiness: 'retired',
      capacity: { running: 3, inUse: 0 },
    });
    // Presence unreadable: not known to be stopped, so `running` is null, never a null capacity.
    attachedNow = null;
    expect(await read()).toMatchObject({
      readiness: 'retired',
      capacity: { running: null, inUse: 0 },
    });
    attachedNow = [];
    expect(await read()).toMatchObject({ readiness: 'retired', capacity: null });
  });

  it('reports null capacity for a build retired before it registered, presence unreadable too', async () => {
    const d = await setup();
    attachedNow = null;
    await registered(d, 't1', hash('1'), 'sbx_t1');
    const q = (
      await HANDLERS.createTemplateBuild!(
        ctx({
          principal: alice,
          params: { id: 't1' },
          body: { image: IMAGE, spec: { ...BASE_SPEC, vcpus: 4 }, profile: 'base' },
        }),
        d,
      )
    ).body as Body;
    const handle = String(q.build).split('/').at(-1)!;
    await retireBuild(d, 't1', handle);
    // It never had a worker: nothing can stop, so no `running: null` to wait out.
    const b = (
      await HANDLERS.getTemplateBuild!(
        ctx({ principal: alice, params: { id: 't1', build: handle } }),
        d,
      )
    ).body as Body;
    expect(b).toMatchObject({ status: 'retired', readiness: 'retired', capacity: null });
  });

  it('never retires a build under a live sandbox (409 build_in_use); retires one build alone', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (await sandbox(d, 't1')).body as Body;
    expect(await refusal(() => retireBuild(d, 't1', hash('1')))).toBe('build_in_use');
    expect(await refusal(() => retire(d, 't1'))).toBe('build_in_use');
    expect((await d.templates!.get('t1'))!.builds[0].status).toBe('registered');
    // While it drains, its worker is in neither list of the wanted state.
    expect((await wanted(d, 'host-1')).stop).toEqual([]);
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    const r = (await retireBuild(d, 't1', hash('1'))).body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      subject: alice.sub,
      buildId: hash('1'),
      readiness: 'retired',
      status: 'retired',
    });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await refusal(() => retireBuild(d, 't1', hash('9')))).toBe('template_not_found');
  });

  it('judges build_in_use by build: a sandbox on another build of one worker does not block', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    // Two builds of t1 from one image, other specs: template-build.sh names both workers alike.
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't1', hash('2'), 'sbx_t1', alice, { another: true, vcpus: 4 });
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't1' }, 2);
    await activate(d, 't1', alice, { build: hash('2') });
    const sb = (await sandbox(d, `t1@${hash('2')}`)).body as Body;
    expect(sb.id).toEqual(expect.any(String));
    // The sandbox runs on build 2: build 1 retires, build 2 is refused.
    expect((await retireBuild(d, 't1', hash('1'))).status).toBe(200);
    expect(await refusal(() => retireBuild(d, 't1', hash('2')))).toBe('build_in_use');
  });

  it('judges build_in_use by worker for a sandbox record without a build id', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't1', hash('2'), 'sbx_t1', alice, { another: true, vcpus: 4 });
    // A record from before builds were traced: no buildId, so its worker's every build is in use.
    const nowS = Math.floor(now / 1000);
    await d.sandboxes!.create(
      {
        id: 'sb-untraced',
        owner: alice.sub,
        tenant: '',
        name: '',
        template: 't1',
        worker: 'sbx_t1',
        wsk: '',
        labels: {},
        createdAt: nowS,
        expiresAt: nowS + 3600,
      },
      { total: 10, perSubject: 10, retentionS: 60 },
      nowS,
    );
    expect(await refusal(() => retireBuild(d, 't1', hash('1')))).toBe('build_in_use');
    expect(await refusal(() => retireBuild(d, 't1', hash('2')))).toBe('build_in_use');
  });

  it('retires a build not yet built by its handle: no build id, no build record', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    const q = (
      await HANDLERS.createTemplateBuild!(
        ctx({
          principal: alice,
          params: { id: 't1' },
          body: { image: IMAGE, spec: { ...BASE_SPEC, vcpus: 4 }, profile: 'base' },
        }),
        d,
      )
    ).body as Body;
    const handle = String(q.build).split('/').at(-1)!;
    expect((await retireBuild(d, 't1', handle)).body).toMatchObject({
      build: handle,
      buildId: null,
      readiness: 'retired',
    });
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'retire',
      body: { build: handle, buildRecord: null, from: 'queued' },
    });
    // The registered build is untouched, and still serves.
    const doc = (await d.templates!.get('t1'))!;
    expect(doc.builds.find((x) => x.buildId === hash('1'))!.status).toBe('registered');
  });

  it('cites the build record of a build built and then rejected', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    // Built, then rejected at registration: its rootfs is not from the create's image.
    await registered(d, 't1', hash('2'), 'sbx_t1', alice, {
      another: true,
      vcpus: 4,
      sourceDigest: hash('f'),
      status: 'rejected',
    });
    const x = (await d.templates!.get('t1'))!.builds.find((b) => b.status === 'rejected')!;
    // A rejected build keeps its handle as its id; its build record names that handle.
    expect(x.buildId).toBe(x.handle);
    const chain = await d.provenance!.chain('template/t1');
    const built = chain.find(
      (r) =>
        r.kind === 'build' &&
        (r.body as Body).outcome === 'built' &&
        (r.body as Body).handle === x.handle,
    )!;
    await retireBuild(d, 't1', x.handle!);
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'retire',
      body: { build: x.handle, buildRecord: recordDigestOf(built), from: 'rejected' },
    });
  });

  it('an activation that resolved the build before a retire writes no lease onto it', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    // The activation reads the template (build registered), then the retire runs to its end
    // before the activation takes its lease.
    const cat = d.templates!;
    const get = cat.get.bind(cat);
    let race = true;
    cat.get = async (id: string) => {
      const doc = await get(id);
      if (race) {
        race = false;
        await retire(d, 't1');
      }
      return doc;
    };
    expect(await refusal(() => activate(d, 't1'))).toBe('template_retired');
    const b = (await get('t1'))!.builds[0];
    expect(b).toMatchObject({ status: 'retired', leases: [] });
    expect((await d.provenance!.chain('template/t1')).some((r) => r.kind === 'activate')).toBe(
      false,
    );
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.active.used).toBe(0);
  });

  it('a retire waits for an activation taking its lease, then drops that lease', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    // A retire arrives while the activation is between its checks and its lease write (its
    // `activate` record is written first). Under the lock the retire waits for the lease, then
    // drops it; without it, the retire would finish first and the lease land on a retired build.
    const prov = d.provenance!;
    const append = prov.append.bind(prov);
    let retiring: Promise<unknown> | null = null;
    prov.append = async (input) => {
      const rec = await append(input);
      if (input.kind === 'activate' && !retiring) {
        retiring = retire(d, 't1');
        await Promise.race([retiring, new Promise((r) => setTimeout(r, 200))]);
      }
      return rec;
    };
    expect((await activate(d, 't1')).status).toBe(200);
    await retiring;
    expect((await d.templates!.get('t1'))!.builds[0]).toMatchObject({
      status: 'retired',
      leases: [],
    });
  });

  it("refuses another subject and a bad reason; an admin may retire anyone's", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => retire(d, 't1', bob))).toBe('forbidden');
    expect(await refusal(() => retire(d, 't1', alice, { reason: 7 }))).toBe('invalid_request');
    expect(await refusal(() => retire(d, 't1', alice, { reason: 'x'.repeat(1025) }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => retire(d, 'nope'))).toBe('template_not_found');
    const admin = { ...bob, roles: ['admin'] };
    expect((await retire(d, 't1', admin)).status).toBe(200);
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'retire',
      subject: bob.sub,
    });
  });
});

describe('reject after the fact (§5.2)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const admin = { ...bob, roles: ['admin'] };
  const reject = (d: TestDeps, id: string, build: string, body: unknown, principal = admin) =>
    HANDLERS.rejectTemplateBuild!(ctx({ principal, params: { id, build }, body }), d);
  const sandbox = (d: TestDeps, template: string) =>
    HANDLERS.createSandbox!(ctx({ principal: alice, body: { template } }), d);
  const wanted = async (d: TestDeps, host: string) =>
    (await HANDLERS.hostWanted!(asHost(host), d)).body as Body;

  it('rejects a registered build: rejected by rule admin, leases gone, 400 on use, a reject record', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    expect((await wanted(d, 'host-1')).run).toHaveLength(1);
    const r = await reject(d, 't1', hash('1'), { reason: 'rule M1 found broken' });
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body).toMatchObject({
      templateId: 't1',
      subject: admin.sub,
      build: expect.stringMatching(/^b-[0-9a-f]{26}$/),
      buildId: hash('1'),
      status: 'rejected',
    });
    expect(body.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await d.templates!.get('t1'))!.builds[0]).toMatchObject({
      status: 'rejected',
      leases: [],
      reason: { message: 'rule M1 found broken', rule: 'admin' },
    });
    // The record names the admin, the reason and the build record it ends, by digest.
    const chain = await d.provenance!.chain('template/t1');
    const rec = chain.at(-1)!;
    expect(recordDigestOf(rec)).toBe(body.record);
    const buildRec = chain.find((x) => x.kind === 'build' && (x.body as Body).outcome === 'built')!;
    expect(rec).toMatchObject({
      kind: 'reject',
      subject: admin.sub,
      body: {
        build: body.build,
        buildId: hash('1'),
        buildRecord: recordDigestOf(buildRec),
        from: 'registered',
        reason: 'rule M1 found broken',
      },
    });
    // Its use is refused as for a build policy rejected at registration; an activation too.
    expect(await refusal(() => sandbox(d, 't1'))).toBe('unknown_template');
    expect(await refusal(() => sandbox(d, `t1@${hash('1')}`))).toBe('unknown_template');
    expect(await refusal(() => activate(d, 't1'))).toBe('template_unavailable');
    // A host holding it stops its worker, as for a retired build, and its stop is taken.
    const entry = { template: 't1', buildId: hash('1'), worker: 'sbx_t1' };
    expect(await wanted(d, 'host-1')).toEqual({ run: [], stop: [entry] });
    await HANDLERS.hostWorkerReport!(
      asHost('host-1', {}, { buildId: hash('1'), event: 'detached' }),
      d,
    );
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'deactivate',
      subject: 'host:host-1',
    });
    // Idempotent: a second reject answers rejected, with no second record.
    const n = (await d.provenance!.chain('template/t1')).length;
    expect((await reject(d, 't1', hash('1'), { reason: 'again' })).body).toMatchObject({
      status: 'rejected',
      record: null,
    });
    expect((await d.provenance!.chain('template/t1')).length).toBe(n);
  });

  it('never rejects under a live sandbox (409 build_in_use)', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (await sandbox(d, 't1')).body as Body;
    expect(await refusal(() => reject(d, 't1', hash('1'), { reason: 'broken' }))).toBe(
      'build_in_use',
    );
    expect((await d.templates!.get('t1'))!.builds[0].status).toBe('registered');
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    expect((await reject(d, 't1', hash('1'), { reason: 'broken' })).status).toBe(200);
  });

  it('a reject waits for an activation taking its lease, then drops that lease', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
    // A reject arrives while the activation is between its checks and its lease write: under the
    // activation lock it waits for the lease, then drops it.
    const prov = d.provenance!;
    const append = prov.append.bind(prov);
    let rejecting: Promise<unknown> | null = null;
    prov.append = async (input) => {
      const rec = await append(input);
      if (input.kind === 'activate' && !rejecting) {
        rejecting = reject(d, 't1', hash('1'), { reason: 'broken' });
        await Promise.race([rejecting, new Promise((r) => setTimeout(r, 200))]);
      }
      return rec;
    };
    expect((await activate(d, 't1')).status).toBe(200);
    await rejecting;
    expect((await d.templates!.get('t1'))!.builds[0]).toMatchObject({
      status: 'rejected',
      leases: [],
    });
    expect((await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body).toMatchObject({
      active: { used: 0 },
    });
  });

  for (const [how, code] of [
    ['reject', 'unknown_template'],
    ['retire', 'template_retired'],
  ] as const) {
    it(`a sandbox create that resolved the build before a ${how} stores nothing (${code})`, async () => {
      const d = await setup();
      attachedNow = ['sbx_t1'];
      await registered(d, 't1', hash('1'), 'sbx_t1');
      await inventory(d, 'host-1', { [hash('1')]: 't1' }, 2);
      await activate(d, 't1');
      // The create reads the build (registered); the build then ends, before the create stores
      // its sandbox. Its last read, under the activation lock, sees that and stores nothing.
      const cat = d.templates!;
      const get = cat.get.bind(cat);
      let armed = true;
      cat.get = async (id) => {
        const doc = await get(id);
        if (armed) {
          armed = false;
          if (how === 'reject') await reject(d, 't1', hash('1'), { reason: 'broken' });
          else
            await HANDLERS.retireTemplateBuild!(
              ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
              d,
            );
        }
        return doc;
      };
      expect(await refusal(() => sandbox(d, 't1'))).toBe(code);
      expect(await d.sandboxes!.listAll(NOW_MS / 1000)).toEqual([]);
    });
  }

  it('creates on two templates do not wait on each other (the use lock is per template)', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1', 'sbx_t2'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    await activate(d, 't1');
    await activate(d, 't2');
    // t1's create is held inside its store write, under t1's use lock; t2's runs meanwhile.
    const store = d.sandboxes!;
    const create = store.create.bind(store);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    store.create = async (rec, ...rest) => {
      if (rec.template === 't1') {
        entered();
        await held;
      }
      return create(rec, ...rest);
    };
    const first = sandbox(d, 't1');
    await inside;
    const second = await Promise.race([
      sandbox(d, 't2').then((r) => r.status),
      new Promise((r) => setTimeout(() => r('waited'), 1000)),
    ]);
    expect(second).toBe(201);
    // A retire of t1 waits for t1's create, then sees its sandbox live.
    const retiring = refusal(() =>
      HANDLERS.retireTemplateBuild!(
        ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
        d,
      ),
    );
    release();
    expect((await first).status).toBe(201);
    expect(await retiring).toBe('build_in_use');
  });

  it('refuses a non-admin (the owner too), no reason, an unknown build and one not registered', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => reject(d, 't1', hash('1'), { reason: 'x' }, alice))).toBe(
      'forbidden',
    );
    expect(await refusal(() => reject(d, 't1', hash('1'), {}))).toBe('invalid_request');
    expect(await refusal(() => reject(d, 't1', hash('1'), { reason: '  ' }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => reject(d, 't1', hash('1'), { reason: 'x'.repeat(1025) }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => reject(d, 't1', hash('9'), { reason: 'x' }))).toBe(
      'template_not_found',
    );
    // A queued build is cancelled, a registered one retired: neither is rejected.
    const q = (
      await HANDLERS.createTemplateBuild!(
        ctx({
          principal: alice,
          params: { id: 't1' },
          body: { image: IMAGE, spec: { ...BASE_SPEC, vcpus: 4 }, profile: 'base' },
        }),
        d,
      )
    ).body as Body;
    const handle = String(q.build).split('/').at(-1)!;
    expect(await refusal(() => reject(d, 't1', handle, { reason: 'x' }))).toBe('invalid_request');
    await HANDLERS.retireTemplateBuild!(
      ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
      d,
    );
    expect(await refusal(() => reject(d, 't1', hash('1'), { reason: 'x' }))).toBe(
      'invalid_request',
    );
  });
});

describe('admin quotas (§5.2)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const admin = { ...bob, roles: ['admin'] };
  const putQuota = (d: TestDeps, subject: string, body: unknown, principal = admin) =>
    HANDLERS.putQuota!(ctx({ principal, params: { subject }, body }), d);
  const quotaOf = async (d: TestDeps, principal = alice) =>
    (await HANDLERS.getQuota!(ctx({ principal }), d)).body as Body;

  it("an admin sets one subject's quota and the default; each is a policy record; it is enforced", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'host-1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    expect((await quotaOf(d)).quotaSource).toBe('default');
    const before = (await d.provenance!.chain('policy')).length;
    const r = (await putQuota(d, alice.sub, { templates: 5, buildsQueued: 2, active: 1 }))
      .body as Body;
    expect(r).toMatchObject({
      target: alice.sub,
      subject: admin.sub,
      quota: { active: 1 },
      before: null,
    });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.policy).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await d.provenance!.chain('policy')).length).toBe(before + 1);
    expect((await d.provenance!.chain('policy')).at(-1)).toMatchObject({ subject: admin.sub });
    expect(await quotaOf(d)).toMatchObject({
      quotaSource: 'subject',
      active: { limit: 1 },
      templates: { limit: 5 },
    });
    // Another subject still has the default.
    expect(await quotaOf(d, bob)).toMatchObject({ quotaSource: 'default', active: { limit: 8 } });
    // Enforced at once: alice holds one active, so a second activation is over her quota.
    await activate(d, 't1');
    expect(await refusal(() => activate(d, 't2'))).toBe('quota_exceeded');
    // The default too; removing alice's override returns her to it.
    const def = (await putQuota(d, 'default', { templates: 100, buildsQueued: 10, active: 3 }))
      .body as Body;
    expect(def).toMatchObject({ target: 'default', before: { active: 8 }, quota: { active: 3 } });
    expect((await quotaOf(d, bob)).active.limit).toBe(3);
    const rm = (await putQuota(d, alice.sub, null)).body as Body;
    expect(rm).toMatchObject({ quota: null, before: { active: 1 } });
    expect(await quotaOf(d)).toMatchObject({ quotaSource: 'default', active: { limit: 3 } });
    expect((await activate(d, 't2')).status).toBe(200);
    // No override left: the policy holds no empty quotaBySubject.
    expect((await d.policy!.current()).policy.quotaBySubject).toBeUndefined();
  });

  it('keeps both of two quota writes made together, for different subjects', async () => {
    const d = await setup();
    const erin = 'oidc:erin@example.test';
    const [a, e] = await Promise.all([
      putQuota(d, alice.sub, { templates: 5, buildsQueued: 2, active: 1 }),
      putQuota(d, erin, { templates: 2, buildsQueued: 1, active: 1 }),
    ]);
    expect((a.body as Body).before).toBeNull();
    expect((e.body as Body).before).toBeNull();
    // Neither write started from a policy the other had not yet changed.
    expect((await d.policy!.current()).policy.quotaBySubject).toEqual({
      [alice.sub]: { templates: 5, buildsQueued: 2, active: 1 },
      [erin]: { templates: 2, buildsQueued: 1, active: 1 },
    });
  });

  it('writes with ?expect= only when the quota is the value expected (409 quota_changed, nothing written)', async () => {
    const d = await setup();
    const q = { templates: 5, buildsQueued: 2, active: 1 };
    const putIf = (subject: string, body: unknown, expect: string) =>
      HANDLERS.putQuota!(
        ctx({
          principal: admin,
          params: { subject },
          body,
          query: new URLSearchParams({ expect }),
        }),
        d,
      );
    // No override yet: `null` is the value expected.
    expect((await putIf(alice.sub, q, 'null')).status).toBe(200);
    const n = (await d.provenance!.chain('policy')).length;
    // Another admin's write came in between: this one still expects no override.
    expect(await refusal(() => putIf(alice.sub, { ...q, active: 2 }, 'null'))).toBe(
      'quota_changed',
    );
    expect(await refusal(() => putIf(alice.sub, null, JSON.stringify({ ...q, active: 9 })))).toBe(
      'quota_changed',
    );
    expect((await d.provenance!.chain('policy')).length).toBe(n);
    expect((await d.policy!.current()).policy.quotaBySubject![alice.sub]).toEqual(q);
    // The value now, in any key order, is taken; so is the default's.
    const now = JSON.stringify({ active: 1, buildsQueued: 2, templates: 5 });
    expect((await putIf(alice.sub, null, now)).body).toMatchObject({ quota: null, before: q });
    const def = JSON.stringify((await d.policy!.current()).policy.quota);
    expect((await putIf('default', q, def)).status).toBe(200);
    expect(await refusal(() => putIf('default', q, def))).toBe('quota_changed');
    // An expect that is no quota is refused before any read.
    expect(await refusal(() => putIf(alice.sub, q, '{'))).toBe('invalid_request');
    expect(await refusal(() => putIf(alice.sub, q, '{"templates":1}'))).toBe('invalid_request');
  });

  it("enforces a subject's templates quota on create", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await putQuota(d, alice.sub, { templates: 1, buildsQueued: 10, active: 8 });
    const e = await HANDLERS.createTemplate!(
      ctx({ principal: alice, body: { id: 't2', image: IMAGE, spec: BASE_SPEC, profile: 'base' } }),
      d,
    ).then(
      () => null,
      (x: { code: string; details?: unknown }) => x,
    );
    expect(e).toMatchObject({ code: 'quota_exceeded' });
  });

  it('refuses a non-admin, a bad target and a bad quota', async () => {
    const d = await setup();
    const q = { templates: 1, buildsQueued: 1, active: 1 };
    expect(await refusal(() => putQuota(d, alice.sub, q, alice))).toBe('forbidden');
    expect(await refusal(() => putQuota(d, 'alice', q))).toBe('invalid_request');
    expect(await refusal(() => putQuota(d, 'test:1', q))).toBe('invalid_request');
    expect(await refusal(() => putQuota(d, alice.sub, { ...q, templates: -1 }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => putQuota(d, alice.sub, { templates: 1 }))).toBe('invalid_request');
    expect(await refusal(() => putQuota(d, 'default', null))).toBe('invalid_request');
    expect(await refusal(() => putQuota(d, alice.sub, [1, 1, 1]))).toBe('invalid_request');
  });

  it('keeps only the three counters: a quota with another key is refused, by both routes', async () => {
    const d = await setup();
    const q = { templates: 1, buildsQueued: 1, active: 1 };
    const n = (await d.provenance!.chain('policy')).length;
    expect(await refusal(() => putQuota(d, alice.sub, { ...q, note: 'x' }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => putQuota(d, 'default', { ...q, note: 'x' }))).toBe(
      'invalid_request',
    );
    const bad = { ...DEFAULT_POLICY, quotaBySubject: { [alice.sub]: { ...q, note: 'x' } } };
    expect(await refusal(() => HANDLERS.putPolicy!(ctx({ principal: admin, body: bad }), d))).toBe(
      'invalid_request',
    );
    expect((await d.provenance!.chain('policy')).length).toBe(n);
    // What is stored is a fresh object of the three, whatever key order the request used.
    await putQuota(d, alice.sub, { active: 1, buildsQueued: 1, templates: 1 });
    expect(Object.keys((await d.policy!.current()).policy.quotaBySubject![alice.sub]!)).toEqual([
      'templates',
      'buildsQueued',
      'active',
    ]);
  });

  it("takes an oidc subject's override as a github one's (#701)", async () => {
    const d = await setup();
    const erin = 'oidc:erin@example.test';
    const r = (await putQuota(d, erin, { templates: 2, buildsQueued: 1, active: 1 })).body as Body;
    expect(r).toMatchObject({ target: erin, quota: { templates: 2 }, before: null });
    expect((await putQuota(d, erin, null)).body).toMatchObject({ quota: null });
  });

  it('refuses a policy whose quotaBySubject names a non-subject', async () => {
    const d = await setup();
    const bad = {
      ...DEFAULT_POLICY,
      quotaBySubject: { 'test:1': { templates: 1, buildsQueued: 1, active: 1 } },
    };
    expect(await refusal(() => HANDLERS.putPolicy!(ctx({ principal: admin, body: bad }), d))).toBe(
      'invalid_request',
    );
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
  it("counts a retired build's worker draining a live sandbox against its host, until the sandbox ends", () => {
    const r = doc('r', hash('r'), 0);
    const retired: TemplateDoc = {
      ...r,
      builds: [{ ...r.builds[0]!, status: 'retired', leases: [] }],
    };
    const docs = [retired, doc('a', hash('a'), 1)];
    const hosts = [
      {
        id: 'h1',
        holds: { [hash('r')]: 'r', [hash('a')]: 'a' },
        activeLimit: 1,
        running: [hash('r')],
      },
    ];
    // A sandbox still runs on the retired build's worker: it drains, and keeps h1's one slot.
    const draining = place(docs, hosts, 0, new Set(['w_r']));
    expect(draining.used.get('h1')).toBe(1);
    expect(draining.placed.has(hash('r'))).toBe(false);
    expect(draining.unplaced.get(hash('a'))).toBe('no_slot');
    // Once the sandbox ends, the slot is free.
    const ended = place(docs, hosts, 0, new Set());
    expect(ended.placed.get(hash('a'))).toBe('h1');
  });
  it("counts an admin-rejected build's worker draining a live sandbox, as a retired one's", () => {
    const r = doc('r', hash('r'), 0);
    const rejected = (rule: string): TemplateDoc => ({
      ...r,
      builds: [
        {
          ...r.builds[0]!,
          status: 'rejected',
          leases: [],
          reason: { message: 'broken', rule, step: 'rejected' },
        },
      ],
    });
    const hosts = [
      {
        id: 'h1',
        holds: { [hash('r')]: 'r', [hash('a')]: 'a' },
        activeLimit: 1,
        running: [hash('r')],
      },
    ];
    const busy = new Set(['w_r']);
    const draining = place([rejected('admin'), doc('a', hash('a'), 1)], hosts, 0, busy);
    expect(draining.used.get('h1')).toBe(1);
    expect(draining.unplaced.get(hash('a'))).toBe('no_slot');
    expect(place([rejected('admin'), doc('a', hash('a'), 1)], hosts, 0).placed.get(hash('a'))).toBe(
      'h1',
    );
  });
  it('reads readiness unknown when presence is unreadable', () => {
    expect(readinessOf(doc('a', hash('a'), 0).builds[0]!, 0, null, null)).toBe('unknown');
  });
});
