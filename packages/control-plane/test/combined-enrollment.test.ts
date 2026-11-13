import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS, apiIssuer } from '../src/handlers.js';
import { ProvenanceStore } from '../src/provenance.js';
import { FileTemplateCatalog } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { isEnrolled, isEnrolledForSandbox } from '../src/sandbox-config.js';
import { mintSandboxToken } from '../src/sandbox-token.js';
import { DEFAULT_ISSUER } from '../src/token.js';
import { alice, codeOf, ctx, makeDeps, type TestDeps } from './helpers/deps.js';

/** The error code a call throws, or 'ok' when it does not throw. */
const outcome = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

// Combined control plane spec §3.2-§3.3, increment 2: login open as on harness; the sandbox routes
// and the template writes enrolled-only, test users refused there; the reads open; the token
// separation kept.

const outsider = { ...alice, sub: 'github:5555', tenant: 'github:5555' };
const tester = { ...alice, sub: 'test:1', tenant: 'test:1' };

function combined(): TestDeps {
  const base = makeDeps().config.sandbox!;
  // alice (github:1234) is enrolled; outsider and test:1 are not.
  return makeDeps({
    config: { routeProfile: 'combined', sandbox: { ...base, allowedSubjects: [alice.sub] } },
  });
}

describe('who may call what on the combined profile', () => {
  it('lets anyone log in (enrollment is not checked at login), as on harness', () => {
    const d = combined();
    for (const p of [alice, outsider, tester]) expect(isEnrolled(p.sub, [], d.config)).toBe(true);
    // The route gate is the allow list, plus admins.
    expect(isEnrolledForSandbox(alice.sub, [], d.config)).toBe(true);
    expect(isEnrolledForSandbox(outsider.sub, [], d.config)).toBe(false);
    expect(isEnrolledForSandbox(tester.sub, [], d.config)).toBe(false);
    expect(isEnrolledForSandbox(outsider.sub, ['admin'], d.config)).toBe(true);
  });

  it('refuses the sandbox routes to a subject not enrolled, and to a test user', async () => {
    const d = combined();
    for (const principal of [outsider, tester]) {
      expect(
        await codeOf(() =>
          HANDLERS.createSandbox!(ctx({ principal, body: { template: 'default' } }), d),
        ),
      ).toBe('not_enrolled');
      expect(await codeOf(() => HANDLERS.listSandboxes!(ctx({ principal }), d))).toBe(
        'not_enrolled',
      );
    }
  });

  it('refuses every template write to them, and leaves the reads open', async () => {
    const d = combined();
    const writes = [
      () => HANDLERS.createTemplate!(ctx({ principal: outsider, body: { id: 'x' } }), d),
      () =>
        HANDLERS.createTemplateBuild!(
          ctx({ principal: outsider, params: { id: 'x' }, body: {} }),
          d,
        ),
      () =>
        HANDLERS.activateTemplate!(ctx({ principal: outsider, params: { id: 'x' }, body: {} }), d),
      () =>
        HANDLERS.deactivateTemplate!(
          ctx({ principal: outsider, params: { id: 'x' }, body: {} }),
          d,
        ),
      () =>
        HANDLERS.cancelTemplateBuild!(
          ctx({ principal: outsider, params: { id: 'x', build: 'b' } }),
          d,
        ),
      () => HANDLERS.putPolicy!(ctx({ principal: outsider, body: {} }), d),
    ];
    for (const w of writes) expect(await codeOf(w)).toBe('not_enrolled');
  });

  it('answers the template, policy and quota reads to them (200, with a template store)', async () => {
    const d = combined();
    const dir = mkdtempSync(join(tmpdir(), 'cp-combined-'));
    const provenance = new ProvenanceStore({ dir, now: d.now });
    d.provenance = provenance;
    d.templates = new FileTemplateCatalog({
      dir,
      declared: [{ id: 'default', worker: 'sbx_default', description: 'default', tools: [] }],
      provenance,
      now: d.now,
    });
    d.policy = new FilePolicyStore({ dir, provenance });
    for (const principal of [outsider, tester, alice]) {
      const reads = {
        listTemplates: () => HANDLERS.listTemplates!(ctx({ principal }), d),
        getTemplate: () => HANDLERS.getTemplate!(ctx({ principal, params: { id: 'default' } }), d),
        getPolicy: () => HANDLERS.getPolicy!(ctx({ principal }), d),
        getQuota: () => HANDLERS.getQuota!(ctx({ principal }), d),
      };
      for (const [name, read] of Object.entries(reads)) {
        expect({ name, sub: principal.sub, status: (await read()).status }).toEqual({
          name,
          sub: principal.sub,
          status: 200,
        });
      }
    }
    const list = (await HANDLERS.listTemplates!(ctx({ principal: tester }), d)).body as {
      templates: { id: string }[];
    };
    expect(list.templates.map((t) => t.id)).toContain('default');
  });

  it('keeps sessions open to any logged-in subject, as on harness', async () => {
    const d = combined();
    expect(await outcome(() => HANDLERS.listSessions!(ctx({ principal: outsider }), d))).not.toBe(
      'not_enrolled',
    );
  });

  it('keeps the sandbox profile closed: a not-enrolled subject is refused even a read', async () => {
    const base = makeDeps().config.sandbox!;
    const d = makeDeps({
      config: { routeProfile: 'sandbox', sandbox: { ...base, allowedSubjects: [alice.sub] } },
    });
    expect(isEnrolled(outsider.sub, [], d.config)).toBe(false);
    expect(await codeOf(() => HANDLERS.listTemplates!(ctx({ principal: outsider }), d))).toBe(
      'not_enrolled',
    );
  });
});

describe('token separation on the combined profile (spec §3.3)', () => {
  it('mints API tokens under the harness issuer, so a sandbox stack on the same key refuses them', () => {
    expect(apiIssuer({ routeProfile: 'combined' })).toBe(DEFAULT_ISSUER);
    expect(apiIssuer({ routeProfile: 'sandbox' })).not.toBe(DEFAULT_ISSUER);
  });

  it('keeps the sandbox token its own type, audience and issuer', () => {
    const d = combined();
    const t = mintSandboxToken(d.signer, {
      sub: alice.sub,
      sbx: 'sbx-aaaa',
      wrk: 'sbx_default',
      wsk: 'sbx-aaaa',
      ttlSeconds: 60,
      now: 1_000,
      notAfter: 10_000,
      iss: d.config.sandbox!.issuer,
    } as never).token;
    const [h, b] = t
      .split('.')
      .slice(0, 2)
      .map((x) => JSON.parse(Buffer.from(x!, 'base64url').toString()));
    expect(h.typ).toBe('moca-sandbox+jwt');
    expect(b.aud).toBe('moca-sandbox');
    expect(b.iss).not.toBe(DEFAULT_ISSUER);
  });
});
