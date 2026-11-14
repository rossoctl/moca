import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { buildJobSpec, HostRegistry } from '../src/host-handlers.js';
import { templateHostsFromEnv } from '../src/host-config.js';
import { matchRoute, ROUTES } from '../src/routes.js';
import { buildHandler } from '../src/server.js';
import { ProvenanceStore, sha256Hex, verifyExport } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY } from '../src/template-policy.js';
import { alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const GATE = readFileSync(join(EX, 'django__django-11133.gate-record.json'), 'utf8');
const GATE_SHA = `sha256:${sha256Hex(Buffer.from(GATE, 'utf8'))}`;
const { id: ID, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const DIGEST = IMAGE.slice(IMAGE.indexOf('@') + 1);
const HASH = `sha256:${'a'.repeat(64)}`;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let seq = 0;
async function setup(): Promise<TestDeps> {
  const dir = mkdtempSync(join(tmpdir(), 'cp-host-'));
  const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
  const d = makeDeps({
    // Distinct in the first 26 hex characters, which is what a build handle keeps.
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    templates: new FileTemplateCatalog({ dir, declared: [], provenance }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    hosts: new HostRegistry(),
    config: { routeProfile: 'sandbox' },
  });
  await d.policy!.set({ ...DEFAULT_POLICY, trustedGateRecords: [GATE_SHA] }, 'github:admin');
  await HANDLERS.createTemplate!(
    ctx({
      principal: alice,
      body: { id: ID, image: IMAGE, spec: REST, profile: 'benchmark', gateRecord: GATE },
    }),
    d,
  );
  return d;
}
const asHost = (host: string, params: Record<string, string> = {}, body: unknown = {}) =>
  ({ ...ctx({ params: { host, ...params }, body }), host }) as ReturnType<typeof ctx> & {
    host: string;
  };

/** What template-build.sh and build-snapshot.sh write for this spec (T and S), as files. */
const records = (over: { t?: Record<string, unknown>; s?: Record<string, unknown> } = {}) => ({
  templateRecord: JSON.stringify({
    schema: 'moca-sbx-template/1',
    id: ID,
    worker: 'sbx_django_django_11133_3d3e705ff379',
    snapshot: 'django-django-11133-3d3e705ff379',
    image: IMAGE,
    guest_ram_mb: 4096,
    vcpus: 2,
    manifest_hash: HASH,
    probe_status: 'vm',
    skip_git_identity_check: true,
    gate_record: { sha256: GATE_SHA, passed: true },
    ...over.t,
  }),
  manifest: JSON.stringify({
    hash_version: 2,
    hash: HASH,
    guest_ram_mb: 4096,
    vcpus: 2,
    source_image_digest: DIGEST,
    ...over.s,
  }),
});

async function claimAndBuild(d: TestDeps): Promise<string> {
  const c = (await HANDLERS.hostClaimBuilds!(asHost('host-1', {}, { max: 1 }), d)).body as Body;
  return c.builds[0].build as string;
}

describe('the host agent flow (§6.1, §8.2)', () => {
  it('claims the queued build with what to build, then registers it on a matching built report', async () => {
    const d = await setup();
    const c = (await HANDLERS.hostClaimBuilds!(asHost('host-1', {}, { max: 2 }), d)).body as Body;
    expect(c.builds).toHaveLength(1);
    const job = c.builds[0];
    expect(job).toMatchObject({ template: ID, image: IMAGE });
    expect(job.spec).toMatchObject({
      id: ID,
      image: IMAGE,
      guest_ram_mb: 4096,
      skip_git_identity_check: true,
    });
    expect(job.gateRecord).toBe(`/v1/hosts/host-1/blobs/${GATE_SHA}`);
    const blob = (await HANDLERS.hostBlob!(asHost('host-1', { digest: GATE_SHA }), d)).body as Body;
    expect(Buffer.from(blob.base64, 'base64').toString('utf8')).toBe(GATE);

    // Claimed builds are not handed out twice.
    expect(
      ((await HANDLERS.hostClaimBuilds!(asHost('host-2', {}, { max: 1 }), d)).body as Body).builds,
    ).toEqual([]);

    for (const event of ['building', 'probing']) {
      await HANDLERS.hostBuildReport!(asHost('host-1', { build: job.build }, { event }), d);
    }
    await HANDLERS.hostBuildLog!(
      asHost(
        'host-1',
        { build: job.build },
        { entries: [{ step: 'probe', level: 'info', message: 'OK' }] },
      ),
      d,
    );
    const r = (
      await HANDLERS.hostBuildReport!(
        asHost('host-1', { build: job.build }, { event: 'built', ...records() }),
        d,
      )
    ).body as Body;
    expect(r).toEqual({ status: 'registered', buildId: HASH });

    const t = (await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: ID } }), d))
      .body as Body;
    expect(t.onboarding).toBe('registered');
    expect(t.tags).toEqual({ default: HASH });
    expect(t.builds[0]).toMatchObject({
      buildId: HASH,
      status: 'registered',
      readiness: 'unknown',
    });

    const chain = await d.provenance!.chain(`template/${ID}`);
    expect(chain.map((x) => x.kind)).toEqual(['create', 'gate', 'check', 'build', 'check']);
    expect(chain[4].body).toMatchObject({ at: 'registration', outcome: 'registered' });
    const exp = JSON.parse(JSON.stringify(await d.provenance!.export([`template/${ID}`])));
    expect(verifyExport(exp)).toMatchObject({ ok: true });
  });

  it.each([
    [
      "a manifest hash that is not the record's",
      { s: { hash: `sha256:${'b'.repeat(64)}` } },
      'S.hash',
    ],
    ['a version-1 manifest', { s: { hash_version: undefined } }, 'S.hash_version'],
    [
      'a rootfs from another image',
      { s: { source_image_digest: `sha256:${'c'.repeat(64)}` } },
      'S.source_image_digest',
    ],
    [
      'another gate record',
      { t: { gate_record: { sha256: `sha256:${'d'.repeat(64)}` } } },
      'T.gate_record',
    ],
    ['another image', { t: { image: 'x@sha256:' + 'e'.repeat(64) } }, 'T.image'],
    ['a dropped identity skip', { t: { skip_git_identity_check: undefined } }, 'T.X12'],
    ['another guest size', { s: { guest_ram_mb: 2048 } }, 'S.guest_ram_mb'],
  ])('rejects, automatically and recorded, a built report with %s', async (_n, over, rule) => {
    const d = await setup();
    const build = await claimAndBuild(d);
    const r = (
      await HANDLERS.hostBuildReport!(
        asHost('host-1', { build }, { event: 'built', ...records(over) }),
        d,
      )
    ).body as Body;
    expect(r).toEqual({ status: 'rejected', rule });
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0].status).toBe('rejected');
    expect(t.tags).toEqual({});
    const chain = await d.provenance!.chain(`template/${ID}`);
    expect(chain.at(-1)!.body).toMatchObject({ outcome: 'rejected' });
  });

  it('rejects a second build of a snapshot the template already has (one build per build id)', async () => {
    const d = await setup();
    const first = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(
      asHost('host-1', { build: first }, { event: 'built', ...records() }),
      d,
    );
    // The same image and spec again under another profile and no gate record: not a reuse, so a new
    // build; template-build.sh finds the snapshot already built and reports the same manifest hash.
    const again = await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: {
          id: ID,
          image: IMAGE,
          spec: { ...REST, source_record_digest: undefined, skip_git_identity_check: false },
          profile: 'base',
        },
      }),
      d,
    );
    expect(again.status).toBe(202);
    const second = await claimAndBuild(d);
    expect(second).not.toBe(first);
    const r = (
      await HANDLERS.hostBuildReport!(
        asHost('host-1', { build: second }, { event: 'built', ...records() }),
        d,
      )
    ).body as Body;
    expect(r).toEqual({ status: 'rejected', rule: 'T.unique' });
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds.filter((b: Body) => b.buildId === HASH)).toHaveLength(1);
    expect(t.tags).toEqual({ default: HASH });
    const b = (
      await HANDLERS.getTemplateBuild!(
        ctx({ principal: alice, params: { id: ID, build: second } }),
        d,
      )
    ).body as Body;
    expect(b).toMatchObject({ status: 'rejected', reason: { rule: 'T.unique' } });
    expect(b.reason.message).toContain(first);
  });

  it('records a failed build with its step and message', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(
      asHost(
        'host-1',
        { build },
        { event: 'failed', step: 'probe', message: 'verify command exited 91' },
      ),
      d,
    );
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0].status).toBe('failed');
    expect(
      await codeOf(() =>
        HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event: 'built', ...records() }), d),
      ),
    ).toBe('invalid_request');
  });

  it('lets the owner cancel a build the host is building, and refuses the host its later reports', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event: 'building' }), d);
    const cancel = (principal = alice, ref = build) =>
      HANDLERS.cancelTemplateBuild!(ctx({ principal, params: { id: ID, build: ref } }), d);
    expect(await codeOf(() => cancel(bob))).toBe('forbidden');
    expect(await codeOf(() => cancel(alice, 'b-' + 'f'.repeat(26)))).toBe('template_not_found');
    expect((await cancel()).body).toMatchObject({ templateId: ID, build, status: 'failed' });
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0]).toMatchObject({ status: 'failed', reason: { step: 'cancelled' } });
    // The host finishes anyway: its report is refused, so the build never registers.
    expect(
      await codeOf(() =>
        HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event: 'built', ...records() }), d),
      ),
    ).toBe('invalid_request');
    // Once failed, it is not cancelled again; and a new create is not a reuse of it.
    expect(await codeOf(() => cancel())).toBe('invalid_request');
    const again = await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: { id: ID, image: IMAGE, spec: REST, profile: 'benchmark', gateRecord: GATE },
      }),
      d,
    );
    expect(again.status).toBe(202);
    expect(again.body).not.toHaveProperty('reused');
    // The cancel is on the template's stream, and the chain verifies.
    const ex = await d.provenance!.export([`template/${ID}`]);
    expect(verifyExport(ex).ok).toBe(true);
    expect(ex.records.some((r) => r.kind === 'build' && r.body.outcome === 'cancelled')).toBe(true);
  });

  it('keeps a cancel that lands while a built report is being written (re-checked in the update)', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event: 'building' }), d);
    // Hold the report in its first blob write, after it has read the build as `building`.
    const prov = d.provenance!;
    const putBlob = prov.putBlob.bind(prov);
    let entered!: () => void;
    let release!: () => void;
    const inBlob = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    prov.putBlob = async (buf: Buffer) => {
      entered();
      await held;
      return putBlob(buf);
    };
    const report = HANDLERS.hostBuildReport!(
      asHost('host-1', { build }, { event: 'built', ...records() }),
      d,
    );
    await inBlob;
    await HANDLERS.cancelTemplateBuild!(ctx({ principal: alice, params: { id: ID, build } }), d);
    release();
    expect(await codeOf(() => report)).toBe('invalid_request');
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0]).toMatchObject({ status: 'failed', reason: { step: 'cancelled' } });
    expect(t.tags).toEqual({});
    // No record says it was built or registered: the chain holds the cancel only.
    const chain = await prov.chain(`template/${ID}`);
    expect(chain.map((x) => x.kind)).toEqual(['create', 'gate', 'check', 'build']);
    expect(chain.at(-1)!.body).toMatchObject({ outcome: 'cancelled' });
  });

  it('refuses a report with an unknown event, and a building report on a cancelled build', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    expect(
      await codeOf(() =>
        HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event: 'done' }), d),
      ),
    ).toBe('invalid_request');
    await HANDLERS.cancelTemplateBuild!(ctx({ principal: alice, params: { id: ID, build } }), d);
    for (const event of ['building', 'probing', 'failed']) {
      expect(
        await codeOf(() => HANDLERS.hostBuildReport!(asHost('host-1', { build }, { event }), d)),
      ).toBe('invalid_request');
    }
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0]).toMatchObject({ status: 'failed', reason: { step: 'cancelled' } });
  });

  it('refuses a report for a build another host claimed (a host reports only for itself)', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    expect(
      await codeOf(() =>
        HANDLERS.hostBuildReport!(asHost('host-2', { build }, { event: 'building' }), d),
      ),
    ).toBe('not_found');
    expect(
      await codeOf(() => HANDLERS.hostBuildLog!(asHost('host-2', { build }, { entries: [] }), d)),
    ).toBe('not_found');
  });

  it('takes subjects in turn when claiming, oldest first within each', async () => {
    const d = await setup();
    let t = NOW_MS;
    d.now = () => (t += 1);
    for (const [p, id] of [
      [alice, 'a-two'],
      [alice, 'a-three'],
      [bob, 'b-one'],
    ] as const) {
      await HANDLERS.createTemplate!(
        ctx({
          principal: p,
          body: {
            id,
            image: IMAGE,
            spec: { ...REST, source_record_digest: undefined, skip_git_identity_check: false },
            profile: 'base',
          },
        }),
        d,
      );
    }
    const c = (await HANDLERS.hostClaimBuilds!(asHost('host-1', {}, { max: 4 }), d)).body as Body;
    expect(c.builds.map((b: Body) => b.template)).toEqual([ID, 'b-one', 'a-two', 'a-three']);
  });

  it('keeps the inventory a host reports', async () => {
    const d = await setup();
    await HANDLERS.hostInventory!(
      asHost(
        'host-1',
        {},
        {
          holds: [{ template: ID, manifestHash: HASH }],
          limits: { activeLimit: 24, idleLimitSeconds: 3600, diskFreeGb: 140, diskFloorGb: 60 },
        },
      ),
      d,
    );
    expect(d.hosts!.get('host-1')).toMatchObject({
      holds: { [HASH]: ID },
      limits: { activeLimit: 24 },
    });
  });
});

describe('host authentication', () => {
  const env = { SH_TEMPLATE_HOSTS: '[{"id":"host-1"}]', SH_HOST_TOKEN_HOST_1: 'f'.repeat(64) };
  it('reads hosts and their tokens, refusing a bad id, a short token and a reused one', () => {
    expect(templateHostsFromEnv(env)).toEqual([{ id: 'host-1', token: 'f'.repeat(64) }]);
    expect(templateHostsFromEnv({})).toEqual([]);
    expect(() => templateHostsFromEnv({ ...env, SH_HOST_TOKEN_HOST_1: 'short' })).toThrow(
      /SH_HOST_TOKEN_HOST_1/,
    );
    expect(() => templateHostsFromEnv({ SH_TEMPLATE_HOSTS: '[{"id":"HOST-1"}]' })).toThrow(
      /id must match/,
    );
    expect(() => templateHostsFromEnv(env, ['f'.repeat(64)])).toThrow(/must differ/);
  });

  it('mounts the host routes with auth host, every one naming its host in the path', () => {
    const host = ROUTES.filter((r) => r.auth === 'host');
    expect(host.map((r) => r.operationId).sort()).toEqual([
      'hostBlob',
      'hostBuildLog',
      'hostBuildReport',
      'hostClaimBuilds',
      'hostEgress',
      'hostInventory',
      'hostWanted',
      'hostWorkerReport',
    ]);
    for (const r of host) expect(r.path.startsWith('/v1/hosts/{host}/'), r.path).toBe(true);
    expect(matchRoute('POST', '/v1/hosts/host-1/builds/claim', 'harness')?.route.operationId).toBe(
      'hostClaimBuilds',
    );
  });
});

describe('host authentication through the router', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  const H1 = '1'.repeat(64); // notsecret
  const H2 = '2'.repeat(64); // notsecret
  const JANITOR = 'j'.repeat(40); // notsecret
  const EGRESS = 'e'.repeat(64); // notsecret

  async function serve(d: TestDeps): Promise<string> {
    const server = createServer(buildHandler(d));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function hostDeps(hosts = true): Promise<TestDeps> {
    const d = await setup();
    d.config.exchangeToken = 'x'.repeat(40); // notsecret
    d.config.sandbox = {
      ...d.config.sandbox!,
      janitorToken: JANITOR,
      egress: { hosts: [{ id: 'kvm', workers: ['sbx_default'], token: EGRESS }], ttlSeconds: 60 },
    };
    if (hosts)
      d.config.templateHosts = [
        { id: 'host-1', token: H1 },
        { id: 'host-2', token: H2 },
      ];
    return d;
  }
  // Every host route, for host H, with a body where it takes one.
  const calls = (h: string) =>
    [
      ['POST', `/v1/hosts/${h}/inventory`, { holds: [] }],
      ['POST', `/v1/hosts/${h}/builds/claim`, { max: 1 }],
      ['GET', `/v1/hosts/${h}/blobs/${GATE_SHA}`, undefined],
      ['POST', `/v1/hosts/${h}/builds/b-${'0'.repeat(26)}/log`, { entries: [] }],
      ['POST', `/v1/hosts/${h}/builds/b-${'0'.repeat(26)}/report`, { event: 'building' }],
    ] as const;
  const send = (base: string, method: string, path: string, body: unknown, token?: string) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("admits a host's token on its own routes only: another host's path is 401", async () => {
    const d = await hostDeps();
    const base = await serve(d);
    const own = await send(base, 'POST', '/v1/hosts/host-1/inventory', { holds: [] }, H1);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ host: 'host-1' });
    const blob = await send(base, 'GET', `/v1/hosts/host-2/blobs/${GATE_SHA}`, undefined, H2);
    expect(blob.status).toBe(200);
    for (const [method, path, body] of calls('host-2')) {
      const res = await send(base, method, path, body, H1);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    }
    // Nothing was claimed by the refused call.
    const t = (await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body;
    expect(t.builds[0].status).toBe('queued');
  });

  it('answers 401 to no token, a wrong one, a user API token, and the janitor, egress and exchange bearers', async () => {
    const d = await hostDeps();
    const user = d.signer.mint({
      sub: alice.sub,
      tenant: alice.sub,
      roles: ['admin'],
      scope: ['api'],
      ttlSeconds: 3600,
      now: Math.floor(NOW_MS / 1000),
    });
    const base = await serve(d);
    for (const token of [
      undefined,
      'c'.repeat(64),
      user,
      JANITOR,
      EGRESS,
      d.config.exchangeToken,
    ]) {
      for (const [method, path, body] of calls('host-1')) {
        const res = await send(base, method, path, body, token);
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'unauthorized' });
      }
    }
  });

  it('answers 401 on every host route with no SH_TEMPLATE_HOSTS', async () => {
    const d = await hostDeps(false);
    const base = await serve(d);
    for (const [method, path, body] of calls('host-1')) {
      const res = await send(base, method, path, body, H1);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('following a build by its handle', () => {
  it('resolves the 202 handle after registration, the body naming the manifest hash', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(
      asHost('host-1', { build }, { event: 'built', ...records() }),
      d,
    );
    const b = (
      await HANDLERS.getTemplateBuild!(ctx({ principal: alice, params: { id: ID, build } }), d)
    ).body as Body;
    expect(b).toMatchObject({ buildId: HASH, handle: build, status: 'registered', reason: null });
  });

  it('says why a build was rejected (the rule) or failed (the step)', async () => {
    const d = await setup();
    const build = await claimAndBuild(d);
    await HANDLERS.hostBuildReport!(
      asHost(
        'host-1',
        { build },
        { event: 'built', ...records({ s: { hash_version: undefined } }) },
      ),
      d,
    );
    const b = (
      await HANDLERS.getTemplateBuild!(ctx({ principal: alice, params: { id: ID, build } }), d)
    ).body as Body;
    expect(b.status).toBe('rejected');
    expect(b.reason).toMatchObject({ rule: 'S.hash_version' });
    const d2 = await setup();
    const b2 = await claimAndBuild(d2);
    await HANDLERS.hostBuildReport!(
      asHost('host-1', { build: b2 }, { event: 'failed', step: 'probe', message: 'exit 91' }),
      d2,
    );
    const f = (
      await HANDLERS.getTemplateBuild!(ctx({ principal: alice, params: { id: ID, build: b2 } }), d2)
    ).body as Body;
    expect(f.reason).toEqual({ message: 'exit 91', step: 'probe' });
  });
});

describe('the build job names the guest size template-build.sh reads (guest_mb)', () => {
  it('maps guest_mb to guest_ram_mb, keeps guest_ram_mb, and prefers guest_mb as the policy does', () => {
    expect(buildJobSpec('t', 'i@sha256:x', { guest_mb: 4096, vcpus: 2 })).toEqual({
      id: 't',
      image: 'i@sha256:x',
      vcpus: 2,
      guest_ram_mb: 4096,
    });
    expect(buildJobSpec('t', 'i', { guest_ram_mb: 2048 })).toEqual({
      id: 't',
      image: 'i',
      guest_ram_mb: 2048,
    });
    expect(buildJobSpec('t', 'i', { guest_mb: 1024, guest_ram_mb: 2048 })).toEqual({
      id: 't',
      image: 'i',
      guest_ram_mb: 1024,
    });
    expect(buildJobSpec('t', 'i', { vcpus: 1 })).toEqual({ id: 't', image: 'i', vcpus: 1 });
    // A spec's own id or image never renames the build or swaps its image.
    expect(
      buildJobSpec('t', 'i@sha256:x', { id: 'other', image: 'evil@sha256:y', vcpus: 1 }),
    ).toEqual({
      id: 't',
      image: 'i@sha256:x',
      vcpus: 1,
    });
  });

  it('claims a create that names guest_mb with guest_ram_mb', async () => {
    const d = await setup();
    // The queued build of setup() first, then this one.
    await claimAndBuild(d);
    const { guest_ram_mb: g, ...noRam } = REST as Body;
    const r = await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: {
          id: 'gmb',
          image: IMAGE,
          spec: {
            ...noRam,
            guest_mb: g,
            source_record_digest: undefined,
            skip_git_identity_check: false,
          },
          profile: 'base',
        },
      }),
      d,
    );
    expect(r.status).toBe(202);
    const c = (await HANDLERS.hostClaimBuilds!(asHost('host-1', {}, { max: 1 }), d)).body as Body;
    expect(c.builds[0].template).toBe('gmb');
    expect(c.builds[0].spec.guest_ram_mb).toBe(g);
    expect(c.builds[0].spec.guest_mb).toBeUndefined();
  });
});
