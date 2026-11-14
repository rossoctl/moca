import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore, recordDigest, verifyExport } from '../src/provenance.js';
import { publicKeyFromBase64 } from '../src/token.js';
import { verifySandboxToken, verifySetModeToken } from '../src/sandbox-token.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const NOW = Math.floor(NOW_MS / 1000);
const DAY_MS = 86_400_000;
let seq = 0;
// 26 hex characters, unique per call: the handler keeps the first 26, so a wider id padded on the
// left would collide.
const sbxDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
  makeDeps({
    newId: () => (++seq).toString(16).padStart(26, '0'),
    ...over,
    config: { routeProfile: 'sandbox', ...(over.config ?? {}) },
  });
const create = async (d: TestDeps, principal = alice, body: unknown = { template: 'default' }) =>
  (await HANDLERS.createSandbox!(ctx({ principal, body }), d)).body as Record<string, unknown>;
const on = (principal: typeof alice, id: unknown) =>
  ctx({ principal, params: { id: id as string } });
const outsider = {
  sub: 'github:42',
  tenant: 'github:42',
  roles: [],
  scope: ['api'],
} as unknown as typeof alice;

describe('sandbox handlers (SBX0 §5)', () => {
  it('creates a ready sandbox with a derived id and workspace key, and a 7-day expiry', async () => {
    const d = sbxDeps();
    const r = await HANDLERS.createSandbox!(
      ctx({
        principal: alice,
        body: { template: 'node22', name: 'web', labels: { project: 'p1' } },
      }),
      d,
    );
    expect(r.status).toBe(201);
    const b = r.body as Record<string, unknown>;
    expect(b).toEqual({
      id: b.id,
      owner: 'github:1234',
      name: 'web',
      template: 'node22',
      // Template lifecycle spec §9: the build it runs on (an imported build has no manifest hash).
      buildId: b.buildId,
      templateManifestHash: null,
      state: 'ready',
      reason: null,
      createdAt: NOW,
      expiresAt: NOW + 7 * 86_400,
      terminatedAt: null,
      labels: { project: 'p1' },
      mode: 'per-exec',
      idleTimeoutS: 0,
      modeEpoch: 0,
    });
    expect(b.id).toMatch(/^sbx-[0-9a-f]{26}$/);
    const rec = await d.sandboxes!.get(b.id as string, NOW);
    expect(rec).toMatchObject({ worker: 'sbx_node22', wsk: b.id, tenant: 'github:1234' });
    expect(b.buildId).toMatch(/^imported:[0-9a-f]{12}$/);
    expect(rec?.buildId).toBe(b.buildId);
    // No mode asked for: per-exec, the worker's idle default, epoch 0 (lease-mode spec §8.1).
    expect(rec).toMatchObject({ mode: 'per-exec', idleTimeoutS: 0, modeEpoch: 0 });
  });

  it('shows an unnamed sandbox as name null', async () => {
    expect((await create(sbxDeps())).name).toBeNull();
  });

  it("takes a production id's 26 random hex characters, skipping a UUID's fixed nibbles", async () => {
    // randomUUID's version nibble is always 4 and its variant nibble carries only 2 random bits;
    // the id is 26 RANDOM hex characters (spec §5.1), so neither may be in it.
    const d = sbxDeps({ newId: () => '01234567-89ab-4cde-8f01-23456789abcd' });
    expect((await create(d)).id).toBe('sbx-0123456789abcdef0123456789');
  });

  it('refuses to build an id from fewer than 26 hex characters', async () => {
    const d = sbxDeps({ newId: () => 'sid-fixed' });
    expect(await codeOf(() => create(d))).toBe('internal_error');
  });

  it('refuses unknown templates, bad names and bad labels', async () => {
    const d = sbxDeps();
    expect(await codeOf(() => create(d, alice, { template: 'nope' }))).toBe('unknown_template');
    expect(await codeOf(() => create(d, alice, {}))).toBe('invalid_request');
    expect(await codeOf(() => create(d, alice, { template: 'default', name: 'Bad Name' }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(() => create(d, alice, { template: 'default', name: 7 }))).toBe(
      'invalid_request',
    );
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    expect(await codeOf(() => create(d, alice, { template: 'default', labels: many }))).toBe(
      'invalid_request',
    );
    expect(
      await codeOf(() => create(d, alice, { template: 'default', labels: { k: 'x'.repeat(257) } })),
    ).toBe('invalid_request');
    expect(await codeOf(() => create(d, alice, { template: 'default', labels: { k: 1 } }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(() => create(d, alice, { template: 'default', labels: ['a'] }))).toBe(
      'invalid_request',
    );
    expect(
      await codeOf(() => create(d, alice, { template: 'default', labels: { 'Bad Key': 'v' } })),
    ).toBe('invalid_request');
    // 16 labels of 256 bytes each is the limit, not over it.
    const sixteen = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, 'x'.repeat(256)]),
    );
    expect((await create(d, alice, { template: 'default', labels: sixteen })).state).toBe('ready');
  });

  it('maps quota and name outcomes to their codes', async () => {
    const d = sbxDeps({
      config: { sandbox: { ...makeDeps().config.sandbox!, maxPerSubject: 1 } },
    });
    await create(d, alice, { template: 'default', name: 'a' });
    expect(await codeOf(() => create(d))).toBe('quota_exceeded');
    // Names are per owner: bob may use alice's.
    const r = await HANDLERS.createSandbox!(
      ctx({ principal: bob, body: { template: 'default', name: 'a' } }),
      d,
    );
    expect(r.status).toBe(201);
    const full = sbxDeps({ config: { sandbox: { ...makeDeps().config.sandbox!, maxTotal: 1 } } });
    await create(full);
    expect(await codeOf(() => create(full, bob))).toBe('quota_exceeded');
    const d2 = sbxDeps();
    await create(d2, alice, { template: 'default', name: 'a' });
    expect(await codeOf(() => create(d2, alice, { template: 'default', name: 'a' }))).toBe(
      'name_conflict',
    );
  });

  it('refuses everything to a subject who is not enrolled', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    for (const op of ['listTemplates', 'createSandbox', 'listSandboxes'] as const) {
      const c = ctx({ principal: outsider, body: { template: 'default' } });
      expect(await codeOf(() => HANDLERS[op]!(c, d)), op).toBe('not_enrolled');
    }
    for (const op of [
      'getSandbox',
      'deleteSandbox',
      'mintSandboxToken',
      'setSandboxMode',
      'mintSandboxModeToken',
    ] as const) {
      expect(await codeOf(() => HANDLERS[op]!(on(outsider, id), d)), op).toBe('not_enrolled');
    }
  });

  it('lists templates without their worker ids, keeping the original three fields', async () => {
    const r = await HANDLERS.listTemplates!(ctx({ principal: alice }), sbxDeps());
    const ts = (r.body as { templates: Record<string, unknown>[] }).templates;
    expect(ts.map(({ id, description, tools }) => ({ id, description, tools }))).toEqual([
      { id: 'default', description: 'bash, git, Python 3', tools: ['bash', 'git', 'python3'] },
      { id: 'node22', description: 'Node 22', tools: ['node'] },
    ]);
    expect(JSON.stringify(ts)).not.toContain('sbx_default');
  });

  it("hides another user's sandbox behind 404, on get, delete, token, mode and mode-token", async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    const ops = [
      'getSandbox',
      'deleteSandbox',
      'mintSandboxToken',
      'setSandboxMode',
      'mintSandboxModeToken',
    ] as const;
    for (const op of ops) {
      const c = ctx({ principal: bob, params: { id: id as string }, body: { mode: 'lease' } });
      expect(await codeOf(() => HANDLERS[op]!(c, d)), op).toBe('sandbox_not_found');
    }
    // ...and an unknown id answers the same.
    for (const op of ops) {
      expect(await codeOf(() => HANDLERS[op]!(on(alice, 'sbx-nope'), d)), op).toBe(
        'sandbox_not_found',
      );
    }
    // bob's attempt deleted nothing.
    expect((await HANDLERS.getSandbox!(on(alice, id), d)).body).toMatchObject({ state: 'ready' });
  });

  it('lets an admin read and delete any sandbox', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    expect((await HANDLERS.getSandbox!(on(admin, id), d)).status).toBe(200);
    const del = await HANDLERS.deleteSandbox!(on(admin, id), d);
    expect(del.body).toEqual({ id, state: 'terminated', reason: 'deleted' });
  });

  it("never mints for an admin on another user's sandbox: 404 sandbox_not_found (spec §4.2)", async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    const err = await HANDLERS.mintSandboxToken!(on(admin, id), d).catch((e) => e);
    expect(err).toMatchObject({ code: 'sandbox_not_found' });
    // An admin mints for their OWN sandbox like anyone else.
    const mine = await create(d, admin);
    expect((await HANDLERS.mintSandboxToken!(on(admin, mine.id), d)).status).toBe(200);
  });

  it('lists own sandboxes; ?all=1 is admins only; ?state filters', async () => {
    const d = sbxDeps();
    const a = await create(d);
    await create(d, bob);
    await HANDLERS.deleteSandbox!(on(alice, a.id), d);
    const c = await create(d);
    const list = async (principal: typeof alice, q = '') =>
      (
        (await HANDLERS.listSandboxes!(ctx({ principal, query: new URLSearchParams(q) }), d))
          .body as { sandboxes: { id: string; owner: string; state: string }[] }
      ).sandboxes;
    // Newest first: c was created after a, at the same second, and ids break the tie.
    expect((await list(alice)).map((s) => s.id)).toEqual([c.id, a.id]);
    expect((await list(alice, 'state=ready')).map((s) => s.id)).toEqual([c.id]);
    expect((await list(alice, 'state=terminated')).map((s) => s.id)).toEqual([a.id]);
    expect(await codeOf(() => list(alice, 'all=1'))).toBe('forbidden');
    expect(await list(admin, 'all=1')).toHaveLength(3);
    expect(await list(admin)).toHaveLength(0); // admin's own: none
    expect(await codeOf(() => list(alice, 'state=gone'))).toBe('invalid_request');
  });

  it('mints a token bound to the sandbox, its worker and its workspace key', async () => {
    const d = sbxDeps();
    const { id } = await create(d, alice, { template: 'node22' });
    const r = await HANDLERS.mintSandboxToken!(on(alice, id), d);
    const b = r.body as Record<string, string | number | null>;
    expect(b).toEqual({
      token: b.token,
      expiresAt: NOW + 900,
      execEndpoint: 'sbx-exec.apps.example.invalid:443',
      wrk: 'sbx_node22',
      wsk: id,
      execCa: null,
    });
    const keys = new Map([[d.signer.kid, publicKeyFromBase64(d.publicKeyBase64)]]);
    const c = verifySandboxToken(b.token as string, keys, {
      issuer: 'sbx-control-plane',
      now: NOW,
    });
    expect(c).toMatchObject({ sub: 'github:1234', sbx: id, wrk: 'sbx_node22', wsk: id });
  });

  it("routes each sandbox to its own template's worker", async () => {
    const d = sbxDeps();
    const py = await create(d, alice, { template: 'default' });
    const node = await create(d, alice, { template: 'node22' });
    const wrk = async (id: unknown) =>
      ((await HANDLERS.mintSandboxToken!(on(alice, id), d)).body as { wrk: string }).wrk;
    expect(await wrk(py.id)).toBe('sbx_default');
    expect(await wrk(node.id)).toBe('sbx_node22');
  });

  it('keeps a sandbox on the worker it was created with when its template moves (a versioned update)', async () => {
    const d = sbxDeps();
    const old = await create(d, alice, { template: 'node22' });
    // The operator points node22 at a new worker: a new control plane with the new list, the same store.
    const moved = {
      ...d,
      config: {
        ...d.config,
        sandbox: {
          ...d.config.sandbox!,
          templates: d.config.sandbox!.templates.map((t) =>
            t.id === 'node22' ? { ...t, worker: 'sbx_node22_v2' } : t,
          ),
        },
      },
    };
    const fresh = await create(moved, alice, { template: 'node22' });
    const mint = async (id: unknown) =>
      (await HANDLERS.mintSandboxToken!(on(alice, id), moved)).body as { wrk: string };
    expect((await mint(old.id)).wrk).toBe('sbx_node22');
    expect((await mint(fresh.id)).wrk).toBe('sbx_node22_v2');
    // Both still read as the same template, and the janitor sees each on its own worker.
    expect([old.template, fresh.template]).toEqual(['node22', 'node22']);
    const b = (await HANDLERS.janitorSandboxes!(ctx({ janitorAuthorized: true }), moved)).body as {
      live: { wsk: string; wrk: string }[];
    };
    expect(b.live).toEqual(
      expect.arrayContaining([
        { wsk: old.id, wrk: 'sbx_node22' },
        { wsk: fresh.id, wrk: 'sbx_node22_v2' },
      ]),
    );
  });

  it('keeps minting for a sandbox whose template was removed, and refuses new creates', async () => {
    const d = sbxDeps();
    const old = await create(d, alice, { template: 'node22' });
    const removed = {
      ...d,
      config: {
        ...d.config,
        sandbox: {
          ...d.config.sandbox!,
          templates: d.config.sandbox!.templates.filter((t) => t.id !== 'node22'),
        },
      },
    };
    expect(await codeOf(() => create(removed, alice, { template: 'node22' }))).toBe(
      'unknown_template',
    );
    const r = await HANDLERS.mintSandboxToken!(on(alice, old.id), removed);
    expect((r.body as { wrk: string }).wrk).toBe('sbx_node22');
  });

  it('returns the exec CA when one is configured, and caps a token at the sandbox expiry', async () => {
    const execCa = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const d = sbxDeps({ config: { sandbox: { ...makeDeps().config.sandbox!, execCa } } });
    const { id, expiresAt } = await create(d);
    const late = { ...d, now: () => ((expiresAt as number) - 60) * 1000 };
    const b = (await HANDLERS.mintSandboxToken!(on(alice, id), late)).body as Record<
      string,
      unknown
    >;
    expect(b).toMatchObject({ execCa, expiresAt });
  });

  it('refuses to mint once deleted (with the reason) or expired, with no job having run', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    await HANDLERS.deleteSandbox!(on(alice, id), d);
    const err = await HANDLERS.mintSandboxToken!(on(alice, id), d).catch((e) => e);
    expect(err).toMatchObject({ code: 'sandbox_terminated', extra: { reason: 'deleted' } });

    // Review Focus 4: never deleted, and nothing ran -- the clock alone ends it.
    const later = sbxDeps();
    const s = await create(later);
    const expired = { ...later, now: () => NOW_MS + 7 * DAY_MS };
    const e2 = await HANDLERS.mintSandboxToken!(on(alice, s.id), expired).catch((e) => e);
    expect(e2).toMatchObject({ code: 'sandbox_terminated', extra: { reason: 'expired' } });
    const view = (await HANDLERS.getSandbox!(on(alice, s.id), expired)).body;
    expect(view).toMatchObject({
      state: 'terminated',
      reason: 'expired',
      terminatedAt: NOW + 7 * 86_400,
    });
    const listed = (await HANDLERS.listSandboxes!(ctx({ principal: alice }), expired)).body as {
      sandboxes: object[];
    };
    expect(listed.sandboxes).toEqual([expect.objectContaining({ state: 'terminated' })]);
    // One second earlier it was still ready and minted.
    const justBefore = { ...later, now: () => NOW_MS + 7 * DAY_MS - 1000 };
    expect((await HANDLERS.mintSandboxToken!(on(alice, s.id), justBefore)).status).toBe(200);
  });

  it('deletes idempotently, and reports an expired sandbox as expired', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    const first = await HANDLERS.deleteSandbox!(on(alice, id), d);
    const again = await HANDLERS.deleteSandbox!(on(alice, id), d);
    expect(first.body).toEqual({ id, state: 'terminated', reason: 'deleted' });
    expect(again.body).toEqual({ id, state: 'terminated', reason: 'deleted' });

    const e = await create(d);
    const expired = { ...d, now: () => NOW_MS + 7 * DAY_MS };
    expect((await HANDLERS.deleteSandbox!(on(alice, e.id), expired)).body).toEqual({
      id: e.id,
      state: 'terminated',
      reason: 'expired',
    });
  });

  it('gives the janitor every live and retained terminated sandbox, and nothing more', async () => {
    const d = sbxDeps();
    // Created a lifetime ago, so it expires exactly now: terminated by the clock alone.
    const aged = await create({ ...d, now: () => NOW_MS - 7 * DAY_MS });
    const gone = await create(d);
    await HANDLERS.deleteSandbox!(on(alice, gone.id), d);
    const live = await create(d, bob, { template: 'node22' });
    expect(await codeOf(() => HANDLERS.janitorSandboxes!(ctx(), d))).toBe('unauthorized');
    const b = (await HANDLERS.janitorSandboxes!(ctx({ janitorAuthorized: true }), d)).body;
    expect(b).toEqual({
      live: [{ wsk: live.id, wrk: 'sbx_node22' }],
      terminated: [
        { wsk: gone.id, wrk: 'sbx_default', terminatedAt: NOW },
        { wsk: aged.id, wrk: 'sbx_default', terminatedAt: NOW },
      ],
    });
  });

  it('audits create and delete with the sandbox id', async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    await HANDLERS.deleteSandbox!(on(alice, id), d);
    await HANDLERS.deleteSandbox!(on(alice, id), d); // idempotent: not audited twice
    const rows = [...d.streams.values()].flat();
    expect(rows.map((r) => [r.decision, r.sandboxId, r.subject])).toEqual([
      ['sandbox_created', id, 'github:1234'],
      ['sandbox_deleted', id, 'github:1234'],
    ]);
  });

  it('keeps a create that succeeded when the audit write fails', async () => {
    const d = sbxDeps();
    d.index.audit = async () => {
      throw new Error('redis down');
    };
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect(
        (await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), d))
          .status,
      ).toBe(201);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
  });

  describe('mode (lease-mode spec §8.1)', () => {
    const keysOf = (d: TestDeps) =>
      new Map([[d.signer.kid, publicKeyFromBase64(d.publicKeyBase64)]]);
    const put = (d: TestDeps, id: unknown, body: unknown, principal = alice) =>
      HANDLERS.setSandboxMode!(ctx({ principal, params: { id: id as string }, body }), d);
    const modeToken = (d: TestDeps, id: unknown, principal = alice) =>
      HANDLERS.mintSandboxModeToken!(on(principal, id), d);
    const withSandbox = (over: object): Parameters<typeof makeDeps>[0] => ({
      config: { sandbox: { ...makeDeps().config.sandbox!, ...over } },
    });

    it('creates a lease mode at epoch 1, and per-exec at epoch 0 (ruling R8)', async () => {
      // The worker serves every epoch-0 Exec as unversioned per-Exec, so a lease at epoch 0 could
      // never be served; per-exec stays 0, which is what every pre-change sandbox is.
      const d = sbxDeps();
      for (const mode of ['lease', 'lease+processes'] as const) {
        const dd = mode === 'lease' ? d : sbxDeps(withSandbox({ modesAllowed: new Set([mode]) }));
        const b = await create(dd, alice, { template: 'default', mode, idleTimeoutS: 600 });
        expect(b, mode).toMatchObject({ mode, idleTimeoutS: 600, modeEpoch: 1 });
        expect(await dd.sandboxes!.get(b.id as string, NOW), mode).toMatchObject({
          mode,
          idleTimeoutS: 600,
          modeEpoch: 1,
        });
      }
      const p = await create(d, alice, { template: 'default', mode: 'per-exec' });
      expect(p).toMatchObject({ mode: 'per-exec', idleTimeoutS: 0, modeEpoch: 0 });
      // A PUT on the lease sandbox raises from 1 to 2, and its set-mode token carries 2.
      const l = await create(d, alice, { template: 'default', mode: 'lease' });
      const r = (await put(d, l.id, { mode: 'lease' })).body as { sandbox: object };
      expect(r.sandbox).toMatchObject({ modeEpoch: 2 });
    });

    it('refuses a mode the policy does not allow (403), and an unknown mode (400), on create', async () => {
      const d = sbxDeps();
      const bad = (body: object) =>
        codeOf(() => create(d, alice, { template: 'default', ...body }));
      expect(await bad({ mode: 'lease+processes' })).toBe('mode_not_allowed');
      expect(await bad({ mode: 'resident' })).toBe('invalid_request');
      expect(await bad({ mode: 7 })).toBe('invalid_request');
      expect(await d.sandboxes!.listByOwner(alice.sub, NOW)).toEqual([]);
    });

    it('bounds the idle timeout to 30..SH_SANDBOX_IDLE_CEILING_S, on create and on PUT', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      const c = (body: object) => create(d, alice, { template: 'default', ...body });
      for (const idleTimeoutS of [29, 1801, 0, -1, 30.5, '60', null]) {
        expect(await codeOf(() => c({ idleTimeoutS })), `create ${idleTimeoutS}`).toBe(
          'invalid_request',
        );
        expect(
          await codeOf(() => put(d, id, { mode: 'lease', idleTimeoutS })),
          `put ${idleTimeoutS}`,
        ).toBe('invalid_request');
      }
      // The bounds themselves are in range.
      expect((await c({ idleTimeoutS: 30 })).idleTimeoutS).toBe(30);
      expect((await put(d, id, { mode: 'lease', idleTimeoutS: 1800 })).status).toBe(200);
      // Nothing refused raised the epoch: only the one accepted PUT did.
      expect((await d.sandboxes!.get(id as string, NOW))!.modeEpoch).toBe(1);
    });

    it('raises the epoch on an owner PUT and returns the sandbox and a set-mode token', async () => {
      const d = sbxDeps();
      const { id } = await create(d, alice, { template: 'node22' });
      const r = await put(d, id, { mode: 'lease', idleTimeoutS: 900 });
      expect(r.status).toBe(200);
      const b = r.body as { sandbox: Record<string, unknown>; setModeToken: string };
      expect(b.sandbox).toMatchObject({
        id,
        state: 'ready',
        mode: 'lease',
        idleTimeoutS: 900,
        modeEpoch: 1,
      });
      expect(Object.keys(b).sort()).toEqual(['sandbox', 'setModeToken']);
      const c = verifySetModeToken(b.setModeToken, keysOf(d), {
        issuer: 'sbx-control-plane',
        now: NOW,
      });
      expect(c).toMatchObject({
        sub: 'github:1234',
        sbx: id,
        wrk: 'sbx_node22',
        wsk: id,
        mode: 'lease',
        mode_epoch: 1,
        idle_timeout_s: 900,
        exp: NOW + 300,
      });
      // A second PUT, the same mode, raises it again; an omitted idle timeout is the worker's default.
      const again = (await put(d, id, { mode: 'lease' })).body as { sandbox: object };
      expect(again.sandbox).toMatchObject({ modeEpoch: 2, idleTimeoutS: 0 });
      // Sandbox tokens minted from now on carry the record's mode.
      const t = (await HANDLERS.mintSandboxToken!(on(alice, id), d)).body as { token: string };
      expect(
        verifySandboxToken(t.token, keysOf(d), { issuer: 'sbx-control-plane', now: NOW }),
      ).toMatchObject({ mode: 'lease', mode_epoch: 2, idle_timeout_s: 0 });
    });

    it('audits a mode change with who, the old mode, the new mode and the epoch', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      await put(d, id, { mode: 'lease', idleTimeoutS: 60 });
      await put(d, id, { mode: 'per-exec' });
      const rows = [...d.streams.values()].flat().filter((r) => r.decision !== 'sandbox_created');
      expect(
        rows.map((r) => [r.decision, r.sandboxId, r.subject, r.fromMode, r.toMode, r.modeEpoch]),
      ).toEqual([
        ['sandbox_mode_changed', id, 'github:1234', 'per-exec', 'lease', '1'],
        ['sandbox_mode_changed', id, 'github:1234', 'lease', 'per-exec', '2'],
      ]);
      expect(d.logLines.filter((l) => l.decision === 'sandbox_mode_changed')).toEqual([
        {
          event: 'audit',
          decision: 'sandbox_mode_changed',
          subject: 'github:1234',
          sandboxId: id,
          fromMode: 'per-exec',
          toMode: 'lease',
          modeEpoch: 1,
        },
        {
          event: 'audit',
          decision: 'sandbox_mode_changed',
          subject: 'github:1234',
          sandboxId: id,
          fromMode: 'lease',
          toMode: 'per-exec',
          modeEpoch: 2,
        },
      ]);
    });

    it("audits fromMode as the atomic update saw it, not as the handler's earlier read did (R9)", async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      // Another PUT lands between this handler's read and its setMode.
      const store = d.sandboxes!;
      const setMode = store.setMode.bind(store);
      let raced = false;
      store.setMode = async (...a) => {
        if (!raced) {
          raced = true;
          await setMode(id as string, 'lease', 0, NOW);
        }
        return setMode(...a);
      };
      await put(d, id, { mode: 'per-exec' });
      const rows = [...d.streams.values()]
        .flat()
        .filter((r) => r.decision === 'sandbox_mode_changed');
      expect(rows.map((r) => [r.fromMode, r.toMode, r.modeEpoch])).toEqual([
        ['lease', 'per-exec', '2'],
      ]);
    });

    it('refuses a mode the policy does not allow with 403, and never refuses per-exec', async () => {
      // An operator list without per-exec still lets an owner go back to it (ruling R7).
      const d = sbxDeps(withSandbox({ modesAllowed: new Set(['lease']) }));
      const { id } = await create(d, alice, { template: 'default', mode: 'lease' });
      expect(await codeOf(() => put(d, id, { mode: 'lease+processes' }))).toBe('mode_not_allowed');
      expect((await d.sandboxes!.get(id as string, NOW))!.modeEpoch).toBe(1);
      expect((await put(d, id, { mode: 'per-exec' })).status).toBe(200);
      expect((await create(d, alice, { template: 'default', mode: 'per-exec' })).mode).toBe(
        'per-exec',
      );
      expect((await create(d, alice, { template: 'default' })).mode).toBe('per-exec');
    });

    it('refuses a PUT body without a valid mode', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      for (const body of [undefined, {}, { mode: 'resident' }, { mode: 2 }, ['lease']]) {
        expect(await codeOf(() => put(d, id, body)), JSON.stringify(body)).toBe('invalid_request');
      }
    });

    it('lets only the owner change the mode or mint a set-mode token, admins included', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      expect(await codeOf(() => put(d, id, { mode: 'lease' }, admin))).toBe('sandbox_not_found');
      expect(await codeOf(() => modeToken(d, id, admin))).toBe('sandbox_not_found');
      expect((await d.sandboxes!.get(id as string, NOW))!.modeEpoch).toBe(0);
    });

    it('refuses a terminated sandbox as the token mint does: 409 with the reason, epoch untouched', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      await HANDLERS.deleteSandbox!(on(alice, id), d);
      for (const call of [() => put(d, id, { mode: 'lease' }), () => modeToken(d, id)]) {
        expect(await call().catch((e) => e)).toMatchObject({
          code: 'sandbox_terminated',
          extra: { reason: 'deleted' },
        });
      }
      const s = await create(d);
      const expired = { ...d, now: () => NOW_MS + 7 * DAY_MS };
      for (const call of [
        () => put(expired, s.id, { mode: 'lease' }),
        () => modeToken(expired, s.id),
      ]) {
        expect(await call().catch((e) => e)).toMatchObject({
          code: 'sandbox_terminated',
          extra: { reason: 'expired' },
        });
      }
      expect((await d.sandboxes!.get(s.id as string, NOW))!.modeEpoch).toBe(0);
      // Past retention it is gone, as get and the token mint read it.
      const purged = { ...d, now: () => NOW_MS + 30 * DAY_MS };
      expect(await codeOf(() => put(purged, s.id, { mode: 'lease' }))).toBe('sandbox_not_found');
      expect(await codeOf(() => modeToken(purged, s.id))).toBe('sandbox_not_found');
    });

    describe('a narrowed policy, at the next mint (review #4559538363)', () => {
      const opts = { issuer: 'sbx-control-plane', now: NOW };
      const narrowed = (d: TestDeps, over: object): TestDeps => ({
        ...d,
        config: { ...d.config, sandbox: { ...d.config.sandbox!, ...over } },
      });
      const sandboxToken = async (d: TestDeps, id: unknown) =>
        verifySandboxToken(
          ((await HANDLERS.mintSandboxToken!(on(alice, id), d)).body as { token: string }).token,
          keysOf(d),
          opts,
        );
      const setModeToken = async (d: TestDeps, id: unknown) =>
        verifySetModeToken(
          ((await modeToken(d, id)).body as { setModeToken: string }).setModeToken,
          keysOf(d),
          opts,
        );
      const modeChanges = (d: TestDeps) =>
        d.logLines.filter((l) => l.decision === 'sandbox_mode_changed');

      for (const first of ['sandbox token', 'set-mode token'] as const) {
        it(`downgrades a lease sandbox to per-exec at epoch+1 once its mode is not allowed (${first} first)`, async () => {
          const d = sbxDeps();
          const { id } = await create(d, alice, {
            template: 'default',
            mode: 'lease',
            idleTimeoutS: 600,
          });
          const n = narrowed(d, { modesAllowed: new Set(['per-exec']) });
          // A mint before the policy changed is untouched: lease at the create's epoch 1.
          expect(await sandboxToken(d, id)).toMatchObject({ mode: 'lease', mode_epoch: 1 });

          const a =
            first === 'sandbox token' ? await sandboxToken(n, id) : await setModeToken(n, id);
          const b =
            first === 'sandbox token' ? await setModeToken(n, id) : await sandboxToken(n, id);
          // A raised epoch, not a same-epoch re-issue, which the worker would treat as a retry.
          for (const c of [a, b]) expect(c).toMatchObject({ mode: 'per-exec', mode_epoch: 2 });
          expect(await d.sandboxes!.get(id as string, NOW)).toMatchObject({
            mode: 'per-exec',
            modeEpoch: 2,
          });
          // Audited once, as the policy's change rather than the owner's.
          expect(modeChanges(d)).toEqual([
            {
              event: 'audit',
              decision: 'sandbox_mode_changed',
              subject: 'github:1234',
              sandboxId: id,
              reason: 'mode_not_allowed',
              fromMode: 'lease',
              toMode: 'per-exec',
              modeEpoch: 2,
            },
          ]);
          const rows = [...d.streams.values()]
            .flat()
            .filter((r) => r.decision === 'sandbox_mode_changed');
          expect(rows.map((r) => [r.reason, r.fromMode, r.toMode, r.modeEpoch])).toEqual([
            ['mode_not_allowed', 'lease', 'per-exec', '2'],
          ]);
        });
      }

      it('leaves an allowed mode, and per-exec, as they are', async () => {
        const d = sbxDeps(withSandbox({ modesAllowed: new Set(['lease', 'lease+processes']) }));
        const l = await create(d, alice, { template: 'default', mode: 'lease' });
        const p = await create(d, alice, { template: 'default' });
        const n = narrowed(d, { modesAllowed: new Set(['lease']) });
        expect(await sandboxToken(n, l.id)).toMatchObject({ mode: 'lease', mode_epoch: 1 });
        expect(await setModeToken(n, p.id)).toMatchObject({ mode: 'per-exec', mode_epoch: 0 });
        const none = narrowed(d, { modesAllowed: new Set() });
        expect(await sandboxToken(none, p.id)).toMatchObject({ mode: 'per-exec', mode_epoch: 0 });
        expect(modeChanges(d)).toEqual([]);
      });

      it('clamps the idle timeout claim to a lowered ceiling, changing neither the record nor the epoch', async () => {
        const d = sbxDeps();
        const { id } = await create(d, alice, {
          template: 'default',
          mode: 'lease',
          idleTimeoutS: 1800,
        });
        const dflt = await create(d, alice, { template: 'default', mode: 'lease' });
        const n = narrowed(d, { idleCeilingS: 600 });
        expect(await sandboxToken(n, id)).toMatchObject({
          mode: 'lease',
          mode_epoch: 1,
          idle_timeout_s: 600,
        });
        expect(await setModeToken(n, id)).toMatchObject({
          mode: 'lease',
          mode_epoch: 1,
          idle_timeout_s: 600,
        });
        // 0 is the worker's default, not a value above the ceiling.
        expect(await sandboxToken(n, dflt.id)).toMatchObject({ idle_timeout_s: 0 });
        expect(await d.sandboxes!.get(id as string, NOW)).toMatchObject({
          idleTimeoutS: 1800,
          modeEpoch: 1,
        });
        expect(modeChanges(d)).toEqual([]);
      });
    });

    it('mints a set-mode token for the current mode and epoch, raising nothing', async () => {
      const d = sbxDeps();
      const { id } = await create(d);
      const first = (await modeToken(d, id)).body as { setModeToken: string };
      expect(Object.keys(first)).toEqual(['setModeToken']);
      const opts = { issuer: 'sbx-control-plane', now: NOW };
      expect(verifySetModeToken(first.setModeToken, keysOf(d), opts)).toMatchObject({
        sbx: id,
        mode: 'per-exec',
        mode_epoch: 0,
        idle_timeout_s: 0,
      });
      await put(d, id, { mode: 'lease', idleTimeoutS: 45 });
      await put(d, id, { mode: 'lease', idleTimeoutS: 45 });
      const r = await modeToken(d, id);
      expect(r.status).toBe(200);
      const t = (r.body as { setModeToken: string }).setModeToken;
      expect(verifySetModeToken(t, keysOf(d), opts)).toMatchObject({
        mode: 'lease',
        mode_epoch: 2,
        idle_timeout_s: 45,
      });
      expect((await d.sandboxes!.get(id as string, NOW))!.modeEpoch).toBe(2);
    });
  });
});

describe('every link of a sandbox is a record digest (template lifecycle §7.1)', () => {
  type Body = Record<string, unknown>;
  const withStore = () => {
    let nowMs = NOW_MS;
    const dir = mkdtempSync(join(tmpdir(), 'cp-sbx-provenance-'));
    const provenance = new ProvenanceStore({ dir, now: () => nowMs });
    const d = sbxDeps({ provenance, now: () => nowMs });
    return { d, dir, provenance, advance: (ms: number) => (nowMs += ms) };
  };
  const janitor = (d: TestDeps) => HANDLERS.janitorSandboxes!(ctx({ janitorAuthorized: true }), d);

  it('records nothing and changes nothing without a provenance store', async () => {
    const d = sbxDeps();
    expect(d.provenance).toBeUndefined();
    const { id } = await create(d);
    await HANDLERS.deleteSandbox!(on(alice, id), d);
    expect((await janitor(d)).status).toBe(200);
  });

  it("puts a sandbox's create and delete on its template's chain, each prev the record before", async () => {
    const { d, provenance } = withStore();
    const sb = await create(d);
    const other = await create(d, bob, { template: 'node22' });
    await HANDLERS.deleteSandbox!(on(alice, sb.id), d);
    await HANDLERS.deleteSandbox!(on(alice, sb.id), d); // idempotent: recorded once
    const chain = await provenance.chain('template/default');
    expect(chain.map((r) => [r.kind, r.subject, (r.body as Body).state])).toEqual([
      ['sandbox', alice.sub, 'created'],
      ['sandbox', alice.sub, 'terminated'],
    ]);
    expect(chain[0].body).toEqual({
      sandboxId: sb.id,
      // An imported build: its id, and no manifest hash (the env list names no snapshot).
      buildId: sb.buildId,
      templateManifestHash: null,
      // No activation lease exists yet; a lease, when one does, is a digest.
      lease: null,
      state: 'created',
      expiresAt: sb.expiresAt,
    });
    expect(chain[1].body).toEqual({
      sandboxId: sb.id,
      buildId: sb.buildId,
      state: 'terminated',
      reason: 'deleted',
      expiresAt: sb.expiresAt,
      endedAt: NOW,
      // The egress log's digest: empty here, so the sha256 of no bytes.
      egress: {
        events: 0,
        sha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        dropped: 0,
        droppedBy: { proxy: 0, cap: 0, budget: 0, invalid: 0 },
        complete: true,
      },
    });
    expect(chain[1].prev).toBe(recordDigest(chain[0]));
    // Another template's sandbox is on its own chain.
    expect((await provenance.chain('template/node22')).map((r) => r.body.sandboxId)).toEqual([
      other.id,
    ]);
    const doc = JSON.parse(
      JSON.stringify(await provenance.export(['template/default', 'template/node22'])),
    );
    expect(verifyExport(doc)).toMatchObject({ ok: true, errors: [] });
  });

  it("records an expired sandbox's end once, from the janitor's sweep, with its true end", async () => {
    const { d, provenance, advance } = withStore();
    const sb = await create(d);
    const ends = async () =>
      (await provenance.chain('template/default')).filter(
        (r) => (r.body as Body).state === 'terminated',
      );
    await janitor(d);
    expect(await ends()).toHaveLength(0);
    advance(8 * DAY_MS);
    await janitor(d);
    await janitor(d);
    // A delete after the expiry reports it expired and writes no second end.
    await HANDLERS.deleteSandbox!(on(alice, sb.id), d);
    const e = await ends();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      subject: 'janitor',
      body: { sandboxId: sb.id, reason: 'expired', expiresAt: sb.expiresAt },
    });
    expect(e[0].body).not.toHaveProperty('endedAt');
  });

  it('leaves the sandbox store as it was: the records live only in the provenance directory', async () => {
    const { d, dir } = withStore();
    await create(d);
    expect(readdirSync(join(dir, 'records'))).toHaveLength(1);
    expect(readdirSync(join(dir, 'heads'))).toHaveLength(1);
  });
});
