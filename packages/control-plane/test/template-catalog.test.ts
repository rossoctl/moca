import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS, type CpConfig } from '../src/handlers.js';
import { templateCatalogFromEnv } from '../src/main.js';
import { ProvenanceStore, verifyExport } from '../src/provenance.js';
import type { SandboxTemplate } from '../src/sandbox-config.js';
import {
  FileTemplateCatalog,
  MemoryTemplateCatalog,
  docFromDeclared,
  PRESENCE_KEY,
  importedBuildId,
  redisPresenceReader,
  resolveBuild,
  type PresenceRecord,
  type TemplateDoc,
} from '../src/template-catalog.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const DECLARED: SandboxTemplate[] = [
  {
    id: 'default',
    worker: 'sbx_default',
    description: 'bash, git, Python 3',
    tools: ['bash', 'git', 'python3'],
  },
  {
    id: 'django-django-11133',
    worker: 'sbx_django_django_11133_3d3e705ff379',
    description: 'SWE-bench django__django-11133',
    tools: ['bash', 'git', 'python3', 'rg'],
  },
];
const SEED = 'cp -a /opt/testbed-src/. /workspace/';
/** A catalog over fixed documents (the store's read side; tests build the documents). */
const fixed = (docs: TemplateDoc[]) => ({
  list: async () => docs,
  get: async (id: string) => docs.find((x) => x.id === id) ?? null,
});
/** The env list's two templates, the second's build carrying a seed in its spec. */
const seeded = (): TemplateDoc[] => {
  const docs = DECLARED.map((t) => docFromDeclared(t, 0));
  docs[1]!.builds[0]!.spec.seed = SEED;
  return docs;
};
const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-catalog-'));
const presence = (recs: PresenceRecord[]) => ({ list: async () => recs });
let seq = 0;
const sbxDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
  makeDeps({
    newId: () => (++seq).toString(16).padStart(26, '0'),
    ...over,
    config: { routeProfile: 'sandbox', ...(over.config ?? {}) },
  });
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (
  op: string,
  d: TestDeps,
  params: Record<string, string> = {},
  principal = alice,
): Promise<Body> => (await HANDLERS[op]!(ctx({ principal, params }), d)).body as Body;

describe('the catalog', () => {
  it('declares each env-list template as one registered build, tagged default, with an opaque id', async () => {
    const c = new MemoryTemplateCatalog(DECLARED, 100);
    const d = (await c.get('django-django-11133'))!;
    expect(d.owner).toBeNull();
    expect(d.visibility).toBe('deployment');
    expect(d.builds).toHaveLength(1);
    expect(d.builds[0]).toMatchObject({
      status: 'registered',
      profile: 'imported',
      createdAt: 100,
    });
    expect(d.builds[0].spec).toEqual({ tools: ['bash', 'git', 'python3', 'rg'] });
    expect(d.tags.default).toBe(d.builds[0].buildId);
    expect(d.builds[0].buildId).toMatch(/^imported:[0-9a-f]{12}$/);
    expect(d.builds[0].buildId).not.toContain('sbx_');
    expect(importedBuildId('sbx_default')).toBe(importedBuildId('sbx_default'));
  });

  it('resolves id, id:tag and id@build (§3.2)', () => {
    const d: TemplateDoc = {
      schema: 'moca-template/1',
      id: 't',
      owner: 'github:1',
      visibility: 'deployment',
      description: '',
      tags: { default: 'sha256:b', stable: 'sha256:a' },
      builds: ['sha256:b', 'sha256:a'].map((buildId) => ({
        buildId,
        status: 'registered' as const,
        profile: 'benchmark',
        worker: `w_${buildId.slice(-1)}`,
        spec: { tools: [] },
        createdAt: 0,
      })),
      createdAt: 0,
    };
    expect(resolveBuild(d, {})?.buildId).toBe('sha256:b');
    expect(resolveBuild(d, { tag: 'stable' })?.buildId).toBe('sha256:a');
    expect(resolveBuild(d, { build: 'sha256:a' })?.worker).toBe('w_a');
    expect(resolveBuild(d, { tag: 'nope' })).toBeNull();
    expect(resolveBuild(d, { build: 'sha256:zz' })).toBeNull();
  });
});

describe('FileTemplateCatalog: the env list imported once (§3.1)', () => {
  it('imports into an empty catalog with a provenance create record per template', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir, now: () => NOW_MS });
    const c = new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: prov,
      now: () => NOW_MS,
    });
    const docs = await c.list();
    expect(docs.map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    const chain = await prov.chain('template/django-django-11133');
    expect(chain.map((r) => r.kind)).toEqual(['create']);
    expect(chain[0]).toMatchObject({
      subject: 'deployment',
      body: { source: 'SH_SANDBOX_TEMPLATES' },
    });
    expect(docs[1].builds[0].provenance).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyExport(await prov.export(['template/django-django-11133'])).ok).toBe(true);
  });

  it('ignores the env list once the catalog holds templates, and warns when it differs', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir });
    await new FileTemplateCatalog({ dir, declared: DECLARED, provenance: prov }).list();
    const warnings: string[] = [];
    const again = new FileTemplateCatalog({
      dir,
      declared: [DECLARED[0]!],
      provenance: prov,
      warn: (m) => warnings.push(m),
    });
    expect((await again.list()).map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    expect(warnings.join()).toMatch(/SH_SANDBOX_TEMPLATES differs/);
    // No second create record: the import ran once.
    expect((await prov.chain('template/default')).length).toBe(1);
  });

  it('does not warn when the env list still matches', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir });
    await new FileTemplateCatalog({ dir, declared: DECLARED, provenance: prov }).list();
    const warnings: string[] = [];
    await new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: prov,
      warn: (m) => warnings.push(m),
    }).list();
    expect(warnings).toEqual([]);
  });

  it('answers null for an unknown id, and for a name that is not a template id', async () => {
    const dir = freshDir();
    const c = new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: new ProvenanceStore({ dir }),
    });
    expect(await c.get('nope')).toBeNull();
    expect(await c.get('../catalog')).toBeNull();
  });
});

describe('SH_PROVENANCE_DIR (templateCatalogFromEnv)', () => {
  const config = { sandbox: { templates: DECLARED } } as unknown as CpConfig;

  it('opens nothing unset, and refuses a relative path', () => {
    expect(templateCatalogFromEnv({}, config)).toEqual({});
    expect(() => templateCatalogFromEnv({ SH_PROVENANCE_DIR: 'rel/dir' }, config)).toThrow(
      /absolute path/,
    );
  });

  it('opens the provenance store and the catalog on one directory, the env list imported', async () => {
    const dir = freshDir();
    const { templates, provenance } = templateCatalogFromEnv({ SH_PROVENANCE_DIR: dir }, config);
    expect((await templates!.list()).map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    expect((await provenance!.chain('template/default')).map((r) => r.kind)).toEqual(['create']);
    expect(readdirSync(dir).sort()).toEqual(['blobs', 'catalog', 'heads', 'records']);
  });
});

describe('the read API (§4)', () => {
  const attached = (worker: string, cap = 3): PresenceRecord => ({
    sandboxId: worker,
    labels: { 'moca.dev/template': 'x' },
    capacityMax: cap,
  });

  it('derives readiness from presence: attached is active with its capacity, absent is inactive', async () => {
    const d = sbxDeps({ presence: presence([attached('sbx_default', 3)]) });
    await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), d);
    const ts = (await call('listTemplates', d)).templates as Body[];
    const def = ts.find((t) => t.id === 'default')!;
    expect(def.readiness).toBe('active');
    expect(def.builds[0].capacity).toEqual({ running: 3, inUse: 1 });
    const node = ts.find((t) => t.id === 'node22')!;
    expect(node.readiness).toBe('inactive');
    expect(node.builds[0].capacity).toBeNull();
  });

  it('says unknown, not inactive, when presence cannot be read or is not wired', async () => {
    const broken = sbxDeps({ presence: { list: async () => Promise.reject(new Error('down')) } });
    expect(((await call('listTemplates', broken)).templates as Body[])[0].readiness).toBe(
      'unknown',
    );
    expect(((await call('listTemplates', sbxDeps())).templates as Body[])[0].readiness).toBe(
      'unknown',
    );
  });

  it('omits specs from the list and includes them, seed and all, on one template and its builds', async () => {
    const d = sbxDeps({ templates: fixed(seeded()) });
    const listed = (await call('listTemplates', d)).templates as Body[];
    expect(listed[1].builds[0].spec).toBeUndefined();
    const one = await call('getTemplate', d, { id: 'django-django-11133' });
    expect(one.builds[0].spec.seed).toBe(SEED);
    const builds = (await call('listTemplateBuilds', d, { id: 'django-django-11133' }))
      .builds as Body[];
    const b = await call('getTemplateBuild', d, {
      id: 'django-django-11133',
      build: builds[0].buildId,
    });
    expect(b.spec.tools).toEqual(['bash', 'git', 'python3', 'rg']);
    expect(b.tags).toEqual(['default']);
  });

  it('never sends a worker id', async () => {
    const d = sbxDeps({
      templates: new MemoryTemplateCatalog(DECLARED),
      presence: presence([attached('sbx_default')]),
    });
    const all = JSON.stringify([
      await call('listTemplates', d),
      await call('getTemplate', d, { id: 'django-django-11133' }),
      await call('listTemplateBuilds', d, { id: 'default' }),
    ]);
    expect(all).not.toMatch(/sbx_/);
  });

  it('answers 404 template_not_found for an unknown template or build', async () => {
    const d = sbxDeps();
    expect(await codeOf(() => call('getTemplate', d, { id: 'nope' }))).toBe('template_not_found');
    expect(await codeOf(() => call('listTemplateBuilds', d, { id: 'nope' }))).toBe(
      'template_not_found',
    );
    expect(
      await codeOf(() => call('getTemplateBuild', d, { id: 'default', build: 'sha256:00' })),
    ).toBe('template_not_found');
  });

  it('hides a private template from everyone but its owner and admins, as 404', async () => {
    const priv: TemplateDoc = {
      ...(await new MemoryTemplateCatalog([DECLARED[0]!]).get('default'))!,
      id: 'mine',
      owner: alice.sub,
      visibility: 'private',
    };
    const d = sbxDeps({ templates: fixed([priv]) });
    expect(
      ((await call('listTemplates', d, {}, alice)).templates as Body[]).map((t) => t.id),
    ).toEqual(['mine']);
    expect(
      ((await call('listTemplates', d, {}, bob)).templates as Body[]).map((t) => t.id),
    ).toEqual([]);
    expect(await codeOf(() => call('getTemplate', d, { id: 'mine' }, bob))).toBe(
      'template_not_found',
    );
    expect((await call('getTemplate', d, { id: 'mine' }, admin)).id).toBe('mine');
  });

  it('refuses a caller who is not enrolled', async () => {
    const outsider = { ...alice, sub: 'github:42', tenant: 'github:42' };
    for (const op of ['listTemplates', 'getTemplate', 'listTemplateBuilds', 'getTemplateBuild']) {
      expect(
        await codeOf(() => call(op, sbxDeps(), { id: 'default', build: 'x' }, outsider)),
        op,
      ).toBe('not_enrolled');
    }
  });
});

describe('presence', () => {
  it('reads the key the relay writes (harness pool-records.ts recordsKey)', () => {
    const src = readFileSync(resolve(__dirname, '../../../harness/src/pool-records.ts'), 'utf8');
    expect(src).toContain(`return '${PRESENCE_KEY}';`);
  });

  it('parses records and skips an unreadable one', async () => {
    const r = redisPresenceReader({
      hGetAll: async (k) => {
        expect(k).toBe(PRESENCE_KEY);
        return {
          a: JSON.stringify({
            sandboxId: 'sbx_a',
            labels: { x: 'y' },
            capacityMax: 4,
            capabilities: [],
            transport: 'grpc',
          }),
          b: '{not json',
          c: JSON.stringify({ labels: {} }),
        };
      },
    });
    expect(await r.list()).toEqual([{ sandboxId: 'sbx_a', labels: { x: 'y' }, capacityMax: 4 }]);
  });
});

describe('both profiles, lastUsedAt, tags (§4.1)', () => {
  const harnessDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
    makeDeps({
      ...over,
      config: { routeProfile: 'harness', sandbox: undefined, ...(over.config ?? {}) },
    });

  it("serves the harness profile the store's templates, with no sandbox counts (null, not 0)", async () => {
    const d = harnessDeps({
      templates: fixed(seeded()),
      presence: { list: async () => [{ sandboxId: 'sbx_default', labels: {}, capacityMax: 2 }] },
    });
    const ts = (
      await call('listTemplates', d, {}, { ...alice, sub: 'github:777', tenant: 'github:777' })
    ).templates as Body[];
    expect(ts.map((t) => t.id)).toEqual(['default', 'django-django-11133']);
    expect(ts[0].readiness).toBe('active');
    expect(ts[0].builds[0].capacity).toEqual({ running: 2, inUse: null });
    expect(ts[0].builds[0].lastUsedAt).toBeNull();
    expect(ts[1].readiness).toBe('inactive');
    const one = await call('getTemplate', d, { id: 'django-django-11133' });
    expect(one.builds[0].spec.seed).toBe(SEED);
  });

  it('lists nothing on a harness control plane that declares no templates', async () => {
    expect((await call('listTemplates', harnessDeps())).templates).toEqual([]);
  });

  it("reports a build's lastUsedAt as its newest sandbox's creation, retained records included", async () => {
    let now = NOW_MS;
    const d = sbxDeps({ now: () => now, presence: presence([]) });
    await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), d);
    now += 60_000;
    await HANDLERS.createSandbox!(ctx({ principal: bob, body: { template: 'default' } }), d);
    const ts = (await call('listTemplates', d)).templates as Body[];
    expect(ts.find((t) => t.id === 'default')!.builds[0].lastUsedAt).toBe(Math.floor(now / 1000));
    expect(ts.find((t) => t.id === 'node22')!.builds[0].lastUsedAt).toBeNull();
  });

  it('lists tags with their build, and when and by whom they were set', async () => {
    const d = sbxDeps({ templates: new MemoryTemplateCatalog(DECLARED, 500) });
    const { tags } = (await call('listTemplateTags', d, { id: 'default' })) as { tags: Body[] };
    expect(tags).toEqual([
      {
        tag: 'default',
        buildId: importedBuildId('sbx_default'),
        assignedAt: 500,
        assignedBy: null,
      },
    ]);
    expect(await codeOf(() => call('listTemplateTags', d, { id: 'nope' }))).toBe(
      'template_not_found',
    );
  });
});

it('lists an empty hosts block until a host agent reports (§6.2)', async () => {
  expect((await call('listTemplates', sbxDeps())).hosts).toEqual([]);
});

describe('a sandbox names id, id:tag or id@build, resolved once at create (§3.2, §9)', () => {
  const HASH = `sha256:${'a'.repeat(64)}`;
  const OLD = 'imported:000000000000';
  const tr = (over: Partial<TemplateDoc> = {}): TemplateDoc => ({
    schema: 'moca-template/1',
    id: 'tr',
    owner: alice.sub,
    visibility: 'deployment',
    description: 't',
    tags: { default: HASH, old: OLD },
    builds: [
      {
        buildId: HASH,
        status: 'registered',
        profile: 'base',
        worker: 'sbx_tr_new',
        spec: { tools: [] },
        createdAt: 0,
      },
      {
        buildId: OLD,
        status: 'registered',
        profile: 'imported',
        worker: 'sbx_tr_old',
        spec: { tools: [] },
        createdAt: 0,
      },
    ],
    createdAt: 0,
    ...over,
  });
  const mk = async (d: TestDeps, template: string, principal = bob) =>
    (await HANDLERS.createSandbox!(ctx({ principal, body: { template } }), d)).body as Body;

  it('records the build each reference resolves to, and the worker it routes to', async () => {
    const d = sbxDeps({ templates: fixed([tr()]) });
    expect(await mk(d, 'tr')).toMatchObject({
      template: 'tr',
      buildId: HASH,
      templateManifestHash: HASH,
    });
    const old = await mk(d, 'tr:old');
    expect(old).toMatchObject({ template: 'tr', buildId: OLD, templateManifestHash: null });
    expect(await mk(d, `tr@${HASH}`)).toMatchObject({ buildId: HASH });
    const rec = await d.sandboxes!.get(old.id as string, Math.floor(NOW_MS / 1000));
    expect(rec).toMatchObject({ worker: 'sbx_tr_old', buildId: OLD });
    const tok = (
      await HANDLERS.mintSandboxToken!(ctx({ principal: bob, params: { id: old.id as string } }), d)
    ).body as Body;
    expect(tok.wrk).toBe('sbx_tr_old');
  });

  it('refuses an unknown tag or build, one not registered, or a private template as unknown_template', async () => {
    const pending = tr();
    pending.builds[1]!.status = 'built';
    const d = sbxDeps({
      templates: fixed([pending, { ...tr(), id: 'mine', visibility: 'private' }]),
    });
    for (const ref of ['tr:nope', `tr@sha256:${'0'.repeat(64)}`, 'tr:old', 'nope', 'nope:x'])
      expect(await codeOf(() => mk(d, ref)), ref).toBe('unknown_template');
    // Private: its owner and admins may use it; anyone else reads it as unknown.
    expect(await codeOf(() => mk(d, 'mine', bob))).toBe('unknown_template');
    expect(await mk(d, 'mine', alice)).toMatchObject({ template: 'mine', buildId: HASH });
  });
});

describe('the build on the provenance chain (§7.1)', () => {
  it("names the sandbox's build in its created and terminated records", async () => {
    const dir = freshDir();
    const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
    const d = sbxDeps({ provenance });
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'node22' } }), d)
    ).body as Body;
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id as string } }), d);
    const chain = await provenance.chain('template/node22');
    expect(chain.map((r) => (r.body as Body).buildId)).toEqual([
      importedBuildId('sbx_node22'),
      importedBuildId('sbx_node22'),
    ]);
    expect((chain[0]!.body as Body).templateManifestHash).toBeNull();
  });
});
