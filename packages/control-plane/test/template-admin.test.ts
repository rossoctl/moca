import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore, recordDigest, sha256Hex } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY, type Policy } from '../src/template-policy.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// Template lifecycle spec §5.1-§5.2: tags, edits and owner transfer, on the repository's own worked
// example (a SWE-bench spec with its image builder's gate record).
const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const GATE = readFileSync(join(EX, 'django__django-11133.gate-record.json'), 'utf8');
const GATE_SHA = `sha256:${sha256Hex(Buffer.from(GATE, 'utf8'))}`;
const { id: ID, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const spec = REST;
const policy: Policy = { ...DEFAULT_POLICY, trustedGateRecords: [GATE_SHA] };
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const HASH = /^sha256:[0-9a-f]{64}$/;

let seq = 0;
function stored(
  declared: { id: string; worker: string; description: string; tools: string[] }[] = [],
  dir = mkdtempSync(join(tmpdir(), 'cp-tadmin-')),
): TestDeps {
  const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
  const d = makeDeps({
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    templates: new FileTemplateCatalog({ dir, declared, provenance }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    config: { routeProfile: 'sandbox' },
  });
  void d.policy!.set(policy, admin.sub);
  return d;
}

const createBody = (over: Record<string, unknown> = {}) => ({
  id: ID,
  image: IMAGE,
  spec,
  profile: 'benchmark',
  gateRecord: GATE,
  ...over,
});

/**
 * The worked example's template with `n` builds, each registered as a build host would leave it:
 * build i has buildId hash(i) and worker sbx_w<i>. No host routes are needed for that here.
 */
async function registered(d: TestDeps, n = 1): Promise<void> {
  await HANDLERS.createTemplate!(ctx({ principal: alice, body: createBody() }), d);
  for (let i = 2; i <= n; i++)
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: ID },
        body: createBody({ spec: { ...spec, description: `build ${i}` } }),
      }),
      d,
    );
  await d.templates!.update!(ID, async (cur) => {
    // Builds are newest first: the oldest is build 1.
    const builds = cur!.builds.map((x, k) => {
      const i = String(cur!.builds.length - k);
      return { ...x, status: 'registered' as const, buildId: hash(i), worker: `sbx_w${i}` };
    });
    return { ...cur!, builds, tags: { default: hash('1') } };
  });
}

const move = (d: TestDeps, body: unknown, principal = alice, id = ID) =>
  HANDLERS.moveTemplateTags!(ctx({ principal, params: { id }, body }), d);
const untag = (d: TestDeps, tag: string, principal = alice) =>
  HANDLERS.removeTemplateTag!(ctx({ principal, params: { id: ID, tag } }), d);
const patch = (d: TestDeps, body: unknown, principal = alice) =>
  HANDLERS.updateTemplate!(ctx({ principal, params: { id: ID }, body }), d);
const transfer = (d: TestDeps, id: string, owner: unknown, principal = admin) =>
  HANDLERS.transferTemplateOwner!(ctx({ principal, params: { id }, body: { owner } }), d);
const tagsOf = async (d: TestDeps) =>
  (
    (await HANDLERS.listTemplateTags!(ctx({ principal: alice, params: { id: ID } }), d))
      .body as Body
  ).tags as { tag: string; buildId: string; assignedBy: string | null }[];
const servedBuild = async (d: TestDeps, template: string) =>
  ((await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template } }), d)).body as Body)
    .buildId;
const chain = (d: TestDeps, id = ID) => d.provenance!.chain(`template/${id}`);

describe('tags (§3.2, §5.1)', () => {
  it('moves default to a new build: new sandboxes follow it, a pinned one keeps its build', async () => {
    const d = stored();
    await registered(d, 2);
    expect((await tagsOf(d)).find((t) => t.tag === 'default')?.buildId).toBe(hash('1'));
    const r = (await move(d, { tags: ['default', 'stable'], build: hash('2') })).body as Body;
    expect(r).toMatchObject({ templateId: ID, subject: alice.sub, buildId: hash('2') });
    expect(r.tags).toEqual([
      {
        tag: 'default',
        buildId: hash('2'),
        before: hash('1'),
        record: expect.stringMatching(HASH),
      },
      { tag: 'stable', buildId: hash('2'), before: null, record: expect.stringMatching(HASH) },
    ]);
    expect((await tagsOf(d)).map((t) => [t.tag, t.buildId, t.assignedBy])).toEqual([
      ['default', hash('2'), alice.sub],
      ['stable', hash('2'), alice.sub],
    ]);
    // One `tag` record per tag moved, naming the new build and the one before.
    const recs = (await chain(d)).slice(-2);
    expect(recs.map((x) => [x.kind, x.subject, x.body])).toEqual([
      ['tag', alice.sub, { tag: 'default', buildId: hash('2'), before: hash('1') }],
      ['tag', alice.sub, { tag: 'stable', buildId: hash('2'), before: null }],
    ]);
    expect(r.tags[0].record).toBe(recordDigest(recs[0]!));
    // A bare id and a tag follow the move; a build named by its id does not.
    expect(await servedBuild(d, ID)).toBe(hash('2'));
    expect(await servedBuild(d, `${ID}:stable`)).toBe(hash('2'));
    expect(await servedBuild(d, `${ID}@${hash('1')}`)).toBe(hash('1'));
  });

  it('writes nothing for a tag already on the build, and removing a tag keeps its build', async () => {
    const d = stored();
    await registered(d, 2);
    await move(d, { tags: ['stable'], build: hash('2') });
    const n = (await chain(d)).length;
    const again = (await move(d, { tags: ['stable'], build: hash('2') })).body as Body;
    expect(again.tags).toEqual([
      { tag: 'stable', buildId: hash('2'), before: hash('2'), record: null },
    ]);
    expect((await chain(d)).length).toBe(n);
    // A build is also found by its handle.
    const handle = (await d.templates!.get(ID))!.builds[0]!.handle!;
    expect(((await move(d, { tags: ['v2'], build: handle })).body as Body).buildId).toBe(hash('2'));

    const rm = (await untag(d, 'stable')).body as Body;
    expect(rm).toEqual({
      templateId: ID,
      subject: alice.sub,
      tag: 'stable',
      buildId: null,
      before: hash('2'),
      record: expect.stringMatching(HASH),
    });
    expect((await chain(d)).at(-1)).toMatchObject({
      kind: 'tag',
      subject: alice.sub,
      body: { tag: 'stable', buildId: null, before: hash('2') },
    });
    expect((await tagsOf(d)).map((t) => t.tag)).toEqual(['default', 'v2']);
    expect((await d.templates!.get(ID))!.builds.map((x) => x.status)).toEqual([
      'registered',
      'registered',
    ]);
    expect(await codeOf(() => servedBuild(d, `${ID}:stable`))).toBe('unknown_template');
    expect(await servedBuild(d, `${ID}@${hash('2')}`)).toBe(hash('2'));
  });

  it('refuses bad tags, unknown or unregistered builds, removing default, and other subjects', async () => {
    const d = stored();
    await registered(d, 2);
    const bad = (body: unknown, principal = alice) => codeOf(() => move(d, body, principal));
    expect(await bad({ tags: [], build: hash('1') })).toBe('invalid_request');
    expect(await bad({ tags: 'default', build: hash('1') })).toBe('invalid_request');
    expect(await bad({ tags: ['Bad Tag'], build: hash('1') })).toBe('invalid_request');
    expect(await bad({ tags: ['a', 'a'], build: hash('1') })).toBe('invalid_request');
    expect(
      await bad({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`), build: hash('1') }),
    ).toBe('invalid_request');
    expect(await bad({ tags: ['a'], build: hash('9') })).toBe('template_not_found');
    expect(await bad({ tags: ['a'] })).toBe('template_not_found');
    expect(await codeOf(() => untag(d, 'default'))).toBe('invalid_request');
    expect(await codeOf(() => untag(d, 'nope'))).toBe('template_not_found');
    expect(await bad({ tags: ['a'], build: hash('1') }, bob)).toBe('forbidden');
    expect(await codeOf(() => untag(d, 'default', bob))).toBe('forbidden');
    expect(await codeOf(() => move(d, { tags: ['a'], build: hash('1') }, alice, 'nope'))).toBe(
      'template_not_found',
    );
    // A build not registered (here: a queued one) is not tagged.
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: ID },
        body: createBody({ spec: { ...spec, description: 'queued' } }),
      }),
      d,
    );
    const queued = (await d.templates!.get(ID))!.builds[0]!;
    expect(queued.status).toBe('queued');
    expect(await bad({ tags: ['a'], build: queued.handle })).toBe('invalid_request');
    // Nothing above changed a tag or wrote a tag record.
    expect((await tagsOf(d)).map((t) => [t.tag, t.buildId])).toEqual([['default', hash('1')]]);
    expect((await chain(d)).some((x) => x.kind === 'tag')).toBe(false);
  });

  it('takes a tag named as an Object.prototype property as any other tag', async () => {
    const d = stored();
    await registered(d, 2);
    // `constructor` matches the tag grammar; it is not on the template until moved there.
    expect(await codeOf(() => servedBuild(d, `${ID}:constructor`))).toBe('unknown_template');
    expect(await codeOf(() => untag(d, 'constructor'))).toBe('template_not_found');
    const r = (await move(d, { tags: ['constructor'], build: hash('2') })).body as Body;
    expect(r.tags).toEqual([
      { tag: 'constructor', buildId: hash('2'), before: null, record: expect.stringMatching(HASH) },
    ]);
    expect((await chain(d)).at(-1)).toMatchObject({
      kind: 'tag',
      body: { tag: 'constructor', buildId: hash('2'), before: null },
    });
    expect((await tagsOf(d)).find((t) => t.tag === 'constructor')).toMatchObject({
      buildId: hash('2'),
      assignedBy: alice.sub,
    });
    expect(await servedBuild(d, `${ID}:constructor`)).toBe(hash('2'));
    expect(((await untag(d, 'constructor')).body as Body).before).toBe(hash('2'));
    // A removal names a tag by the tag grammar, checked before the lock is taken.
    for (const t of ['toString', '__proto__', 'hasOwnProperty', 'Bad Tag', ''])
      expect(await codeOf(() => untag(d, t))).toBe('invalid_request');
    expect((await tagsOf(d)).map((t) => t.tag)).toEqual(['default']);
  });

  it("lets an admin move and remove another subject's tags; the record names the admin", async () => {
    const d = stored();
    await registered(d, 2);
    await move(d, { tags: ['stable'], build: hash('1') }, admin);
    expect((await chain(d)).at(-1)).toMatchObject({ kind: 'tag', subject: admin.sub });
    expect((await tagsOf(d)).find((t) => t.tag === 'stable')?.assignedBy).toBe(admin.sub);
    expect((await untag(d, 'stable', admin)).status).toBe(200);
  });
});

describe('edit description and visibility (§5.1)', () => {
  it('the owner makes it private: others no longer see or use it; each change is a record', async () => {
    const d = stored();
    await registered(d);
    const get = (principal = bob) =>
      HANDLERS.getTemplate!(ctx({ principal, params: { id: ID } }), d);
    expect(((await get()).body as Body).id).toBe(ID);
    const before = (await d.templates!.get(ID))!.description;
    const r = (await patch(d, { visibility: 'private', description: 'Django 11133, v1' }))
      .body as Body;
    expect(r).toMatchObject({
      templateId: ID,
      subject: alice.sub,
      visibility: 'private',
      description: 'Django 11133, v1',
    });
    expect(r.changes.map((c: Body) => [c.field, c.value, c.before])).toEqual([
      ['visibility', 'private', 'deployment'],
      ['description', 'Django 11133, v1', before],
    ]);
    const recs = (await chain(d)).slice(-2);
    expect(recs.map((x) => [x.kind, x.subject, x.body])).toEqual([
      ['visibility', alice.sub, { field: 'visibility', value: 'private', before: 'deployment' }],
      ['visibility', alice.sub, { field: 'description', value: 'Django 11133, v1', before }],
    ]);
    expect(r.changes.map((c: Body) => c.record)).toEqual(recs.map(recordDigest));
    // Bob no longer sees it (404, as for no such template) nor uses it; an admin still sees it.
    expect(await codeOf(() => get())).toBe('template_not_found');
    expect(
      await codeOf(() =>
        HANDLERS.createSandbox!(ctx({ principal: bob, body: { template: ID } }), d),
      ),
    ).toBe('unknown_template');
    expect(((await get(admin)).body as Body).id).toBe(ID);
    // An edit to the values it already has writes nothing.
    const n = (await chain(d)).length;
    expect(((await patch(d, { visibility: 'private' })).body as Body).changes).toEqual([]);
    expect((await chain(d)).length).toBe(n);
    // Back to deployment: bob sees it again.
    await patch(d, { visibility: 'deployment' });
    expect(((await get()).body as Body).id).toBe(ID);
  });

  it('refuses bad values, an empty edit, and another subject; an admin may edit', async () => {
    const d = stored();
    await registered(d);
    expect(await codeOf(() => patch(d, { visibility: 'public' }))).toBe('invalid_request');
    expect(await codeOf(() => patch(d, { description: 7 }))).toBe('invalid_request');
    expect(await codeOf(() => patch(d, { description: 'x'.repeat(1025) }))).toBe('invalid_request');
    expect(await codeOf(() => patch(d, { visibility: 'private', description: 7 }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(() => patch(d, {}))).toBe('invalid_request');
    expect(await codeOf(() => patch(d, { description: 'mine now' }, bob))).toBe('forbidden');
    // A refused edit changes nothing, not even the field that was valid.
    expect((await d.templates!.get(ID))!.visibility).toBe('deployment');
    expect((await chain(d)).some((x) => x.kind === 'visibility')).toBe(false);
    expect((await patch(d, { description: 'by an admin' }, admin)).status).toBe(200);
    expect((await chain(d)).at(-1)).toMatchObject({ kind: 'visibility', subject: admin.sub });
  });

  it('answers that a deployment without SH_PROVENANCE_DIR stores no templates', async () => {
    const d = makeDeps({ config: { routeProfile: 'sandbox' } });
    expect(
      await codeOf(() =>
        HANDLERS.updateTemplate!(
          ctx({ principal: alice, params: { id: 'default' }, body: { description: 'x' } }),
          d,
        ),
      ),
    ).toBe('invalid_request');
  });
});

describe('every change is a record (§7.1)', () => {
  it('refuses a description holding a lone surrogate, before anything is written', async () => {
    const d = stored();
    await registered(d);
    const before = (await d.templates!.get(ID))!;
    // JSON.parse('"\\ud800"') holds one: a body can carry it, a provenance record cannot.
    const lone = JSON.parse('"half \\ud800 a pair"') as string;
    expect(await codeOf(() => patch(d, { description: lone }))).toBe('invalid_request');
    expect(await codeOf(() => patch(d, { visibility: 'private', description: lone }))).toBe(
      'invalid_request',
    );
    expect(await d.templates!.get(ID)).toEqual(before);
    expect((await chain(d)).some((x) => x.kind === 'visibility')).toBe(false);
    // A whole pair (an emoji) is a string as any other.
    expect((await patch(d, { description: 'ok \u{1f600}' })).status).toBe(200);
  });

  it('writes no change whose record fails to append', async () => {
    const d = stored();
    await registered(d, 2);
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: ID },
        body: createBody({ spec: { ...spec, description: 'queued' } }),
      }),
      d,
    );
    const queued = (await d.templates!.get(ID))!.builds[0]!.handle!;
    await move(d, { tags: ['stable'], build: hash('1') });
    const doc = await d.templates!.get(ID);
    const n = (await chain(d)).length;
    const prov = d.provenance!;
    const append = prov.append.bind(prov);
    prov.append = () => Promise.reject(new Error('the chain is not writable'));
    const changes: [string, () => Promise<unknown>][] = [
      ['move', () => move(d, { tags: ['default', 'v2'], build: hash('2') })],
      ['untag', () => untag(d, 'stable')],
      ['edit', () => patch(d, { visibility: 'private', description: 'new' })],
      ['transfer', () => transfer(d, ID, bob.sub)],
      [
        'cancel',
        () =>
          HANDLERS.cancelTemplateBuild!(
            ctx({ principal: alice, params: { id: ID, build: queued } }),
            d,
          ),
      ],
    ];
    for (const [what, run] of changes)
      await expect(run(), what).rejects.toThrow('the chain is not writable');
    prov.append = append;
    expect(await d.templates!.get(ID)).toEqual(doc);
    expect((await chain(d)).length).toBe(n);
  });
});

describe('owner transfer (§5.2)', () => {
  it('an admin moves a template to another enrolled subject, who then owns its actions', async () => {
    const d = stored();
    await registered(d);
    expect(await codeOf(() => patch(d, { description: 'x' }, bob))).toBe('forbidden');
    const r = (await transfer(d, ID, bob.sub)).body as Body;
    expect(r).toEqual({
      templateId: ID,
      subject: admin.sub,
      owner: bob.sub,
      before: alice.sub,
      record: expect.stringMatching(HASH),
    });
    expect((await d.templates!.get(ID))!.owner).toBe(bob.sub);
    expect((await chain(d)).at(-1)).toMatchObject({
      kind: 'owner',
      subject: admin.sub,
      body: { owner: bob.sub, before: alice.sub },
    });
    expect(recordDigest((await chain(d)).at(-1)!)).toBe(r.record);
    // Now bob owns it, and alice no longer does.
    expect(await codeOf(() => patch(d, { description: 'x' }))).toBe('forbidden');
    expect((await patch(d, { description: 'bob' }, bob)).status).toBe(200);
    expect((await move(d, { tags: ['stable'], build: hash('1') }, bob)).status).toBe(200);
    // A transfer to the current owner writes nothing.
    const n = (await chain(d)).length;
    expect(((await transfer(d, ID, bob.sub)).body as Body).record).toBe(null);
    expect((await chain(d)).length).toBe(n);
  });

  it('an admin hands a declared template to a subject; a restart keeps it; its new owner builds it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-tadmin-decl-'));
    const declared = [
      { id: 'decl-1', worker: 'sbx_decl_1', description: 'declared', tools: ['bash'] },
    ];
    const d = stored(declared, dir);
    expect((await d.templates!.get('decl-1'))!.owner).toBe(null);
    const build = (dd: TestDeps, principal = bob) =>
      HANDLERS.createTemplateBuild!(
        ctx({
          principal,
          params: { id: 'decl-1' },
          body: createBody({ id: 'decl-1' }),
        }),
        dd,
      );
    // Before: a declared id is no subject's own, so a new build under it is refused.
    expect(await codeOf(() => build(d))).toBe('template_exists');
    const r = (await transfer(d, 'decl-1', bob.sub)).body as Body;
    expect(r).toMatchObject({ templateId: 'decl-1', owner: bob.sub, before: null });
    expect((await chain(d, 'decl-1')).at(-1)).toMatchObject({
      kind: 'owner',
      subject: admin.sub,
      body: { owner: bob.sub, before: null },
    });
    // A restart: a new catalog over the same directory, with the same declared list, does not
    // re-import it or reset its owner (the import runs only into an empty catalog).
    const d2 = stored(declared, dir);
    expect((await d2.templates!.get('decl-1'))!.owner).toBe(bob.sub);
    // Its new owner builds a new version of it and edits it, as any template of theirs.
    expect((await build(d2)).status).toBe(202);
    expect(
      (
        await HANDLERS.updateTemplate!(
          ctx({ principal: bob, params: { id: 'decl-1' }, body: { description: 'mine' } }),
          d2,
        )
      ).status,
    ).toBe(200);
    // Another subject's create under the id is still another's template.
    expect(
      await codeOf(() =>
        HANDLERS.createTemplate!(
          ctx({
            principal: alice,
            body: createBody({ id: 'decl-1' }),
          }),
          d2,
        ),
      ),
    ).toBe('template_exists');
  });

  it("checks the owner again under the lock: a transfer meanwhile refuses the old owner's change", async () => {
    const d = stored();
    await registered(d, 2);
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: ID },
        body: createBody({ spec: { ...spec, description: 'queued' } }),
      }),
      d,
    );
    const queued = (await d.templates!.get(ID))!.builds[0]!.handle!;
    await move(d, { tags: ['stable'], build: hash('1') });
    // Alice's read sees her template; an admin moves it to bob before her write takes the lock.
    const stale = (await d.templates!.get(ID))!;
    await transfer(d, ID, bob.sub);
    const cat = d.templates!;
    const get = cat.get.bind(cat);
    cat.get = async (id) => (id === ID ? structuredClone(stale) : get(id));
    const doc = await get(ID);
    const n = (await chain(d)).length;
    const changes: [string, () => Promise<unknown>][] = [
      ['move', () => move(d, { tags: ['stable'], build: hash('2') })],
      ['untag', () => untag(d, 'stable')],
      ['edit', () => patch(d, { description: 'still mine' })],
      [
        'cancel',
        () =>
          HANDLERS.cancelTemplateBuild!(
            ctx({ principal: alice, params: { id: ID, build: queued } }),
            d,
          ),
      ],
    ];
    for (const [what, run] of changes) expect(await codeOf(run), what).toBe('forbidden');
    cat.get = get;
    expect(await get(ID)).toEqual(doc);
    expect((await chain(d)).length).toBe(n);
  });

  it("charges an admin's new build to the owner it finds under the lock", async () => {
    const d = stored();
    await registered(d);
    const stale = (await d.templates!.get(ID))!;
    await transfer(d, ID, bob.sub);
    const cat = d.templates!;
    const get = cat.get.bind(cat);
    let staleReads = 1;
    cat.get = async (id) => (id === ID && staleReads-- > 0 ? structuredClone(stale) : get(id));
    const build = () =>
      HANDLERS.createTemplateBuild!(
        ctx({
          principal: admin,
          params: { id: ID },
          body: createBody({ spec: { ...spec, description: 'by an admin' } }),
        }),
        d,
      );
    // The first read names alice; the write finds bob, writes nothing, and runs again as bob's.
    expect((await build()).status).toBe(202);
    expect((await get(ID))!.builds.filter((x) => x.status === 'queued')).toHaveLength(1);
    // An owner that changes on every read is refused after three tries, with nothing written.
    staleReads = Infinity;
    const n = (await chain(d)).length;
    const doc = await get(ID);
    expect(
      await codeOf(() =>
        HANDLERS.createTemplateBuild!(
          ctx({
            principal: admin,
            params: { id: ID },
            body: createBody({ spec: { ...spec, description: 'again' } }),
          }),
          d,
        ),
      ),
    ).toBe('internal_error');
    expect(await get(ID)).toEqual(doc);
    expect((await chain(d)).length).toBe(n);
  });

  it("checks the new owner's templates quota again when a transfer lands before the write", async () => {
    const d = stored();
    await d.policy!.set({ ...policy, quota: { ...policy.quota, templates: 1 } }, admin.sub);
    await registered(d);
    await transfer(d, ID, bob.sub);
    const cat = d.templates!;
    // bob's one slot is taken by another template; the transferred one holds none (its build
    // failed), so a new build of it must count against bob's templates quota.
    const moved = (await cat.get(ID))!;
    await cat.update!('bobs-other', async () => ({ ...structuredClone(moved), id: 'bobs-other' }));
    await cat.update!(ID, async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((x) => ({ ...x, status: 'failed' as const })),
    }));
    // The first read still names alice, who holds no slot and would pass.
    const stale = { ...(await cat.get(ID))!, owner: alice.sub };
    const get = cat.get.bind(cat);
    let staleReads = 0;
    cat.get = async (id) => (id === ID && staleReads++ === 0 ? structuredClone(stale) : get(id));
    const doc = await get(ID);
    const n = (await chain(d)).length;
    const err = await HANDLERS.createTemplateBuild!(
      ctx({
        principal: admin,
        params: { id: ID },
        body: createBody({ spec: { ...spec, description: 'after the transfer' } }),
      }),
      d,
    ).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'quota_exceeded', extra: { quota: 'templates' } });
    expect(staleReads).toBeGreaterThan(1); // the stale read, then the retry's
    expect(await get(ID)).toEqual(doc);
    expect((await chain(d)).length).toBe(n);
  });

  it('refuses a non-admin, and a malformed or unenrolled subject', async () => {
    const d = stored();
    await registered(d);
    expect(await codeOf(() => transfer(d, ID, bob.sub, alice))).toBe('forbidden');
    expect(await codeOf(() => transfer(d, ID, 'bob'))).toBe('invalid_request');
    expect(await codeOf(() => transfer(d, ID, 42))).toBe('invalid_request');
    expect(await codeOf(() => transfer(d, ID, 'github:5555'))).toBe('invalid_request');
    expect(await codeOf(() => transfer(d, 'nope', bob.sub))).toBe('template_not_found');
    // #701: an oidc subject passes the grammar (refused here only as not enrolled); test:N never does.
    const why = (owner: string) =>
      transfer(d, ID, owner).then(
        () => 'none',
        (e: Error) => e.message,
      );
    expect(await why('oidc:erin@example.test')).toMatch(/is not enrolled/);
    expect(await why('test:1')).toMatch(/owner must be a subject, github:<numeric id> or oidc:/);
    expect((await d.templates!.get(ID))!.owner).toBe(alice.sub);
    expect((await chain(d)).some((x) => x.kind === 'owner')).toBe(false);
  });

  it('hands a template to an enrolled oidc subject', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-tadmin-oidc-'));
    const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
    const base = makeDeps({ config: { routeProfile: 'sandbox' } });
    const d = makeDeps({
      newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
      templates: new FileTemplateCatalog({ dir, declared: [], provenance }),
      provenance,
      policy: new FilePolicyStore({ dir, provenance }),
      config: {
        routeProfile: 'sandbox',
        sandbox: {
          ...base.config.sandbox!,
          allowedSubjects: [alice.sub, 'oidc:erin@example.test'],
        },
      },
    });
    await d.policy!.set(policy, admin.sub);
    await registered(d);
    const r = (await transfer(d, ID, 'oidc:erin@example.test')).body as Body;
    expect(r).toMatchObject({ owner: 'oidc:erin@example.test', before: alice.sub });
  });
});
