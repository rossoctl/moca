import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { publicKeyFromBase64 } from '../src/token.js';
import { verifySandboxToken } from '../src/sandbox-token.js';
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
      state: 'ready',
      reason: null,
      createdAt: NOW,
      expiresAt: NOW + 7 * 86_400,
      terminatedAt: null,
      labels: { project: 'p1' },
    });
    expect(b.id).toMatch(/^sbx-[0-9a-f]{26}$/);
    const rec = await d.sandboxes!.get(b.id as string, NOW);
    expect(rec).toMatchObject({ worker: 'sbx_node22', wsk: b.id, tenant: 'github:1234' });
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
    for (const op of ['getSandbox', 'deleteSandbox', 'mintSandboxToken'] as const) {
      expect(await codeOf(() => HANDLERS[op]!(on(outsider, id), d)), op).toBe('not_enrolled');
    }
  });

  it('lists templates without their worker ids', async () => {
    const r = await HANDLERS.listTemplates!(ctx({ principal: alice }), sbxDeps());
    expect((r.body as { templates: object[] }).templates).toEqual([
      { id: 'default', description: 'bash, git, Python 3', tools: ['bash', 'git', 'python3'] },
      { id: 'node22', description: 'Node 22', tools: ['node'] },
    ]);
  });

  it("hides another user's sandbox behind 404, on get, delete and token", async () => {
    const d = sbxDeps();
    const { id } = await create(d);
    for (const op of ['getSandbox', 'deleteSandbox', 'mintSandboxToken'] as const) {
      expect(await codeOf(() => HANDLERS[op]!(on(bob, id), d)), op).toBe('sandbox_not_found');
    }
    // ...and an unknown id answers the same.
    for (const op of ['getSandbox', 'deleteSandbox', 'mintSandboxToken'] as const) {
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
});
