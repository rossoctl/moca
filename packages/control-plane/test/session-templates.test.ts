import { describe, expect, it } from 'vitest';
import { exchangeCredential, sessionTemplate } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { parseTemplates, sessionTemplatesFromEnv } from '../src/sandbox-config.js';
import type { SessionRecord } from '../src/ownership.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/** Session sandbox templates (session-templates spec §3.3). */

const TEMPLATES = parseTemplates(
  JSON.stringify([
    {
      id: 'django-django-11133',
      worker: 'sbx_django',
      description: 'SWE-bench django__django-11133',
      tools: ['bash', 'git', 'python3'],
      seed: 'cp -a /opt/repo/. /workspace/',
    },
    { id: 'py312', worker: 'sbx_py312', description: 'Python 3.12', tools: ['python3'] },
  ]),
);
const templated = () => makeDeps({ config: { sessionTemplates: TEMPLATES } });

async function create(d: CpDeps, sandbox?: unknown, id = 'sid-fixed') {
  return HANDLERS.createSession!(
    ctx({ principal: alice, body: sandbox === undefined ? {} : { sandbox } }),
    { ...d, newId: () => id },
  );
}

describe('SH_SANDBOX_TEMPLATES on the harness profile', () => {
  it('is null when unset or blank, so nothing about sessions changes', () => {
    expect(sessionTemplatesFromEnv({})).toBeNull();
    expect(sessionTemplatesFromEnv({ SH_SANDBOX_TEMPLATES: '  ' })).toBeNull();
  });

  it('parses the seed as an optional string, dropping a blank one', () => {
    expect(TEMPLATES[0].seed).toBe('cp -a /opt/repo/. /workspace/');
    expect(TEMPLATES[1]).not.toHaveProperty('seed');
    const blank = parseTemplates(
      JSON.stringify([{ id: 'a', worker: 'w', description: '', tools: [], seed: ' ' }]),
    );
    expect(blank[0]).not.toHaveProperty('seed');
  });

  it('refuses a seed that is not a string, naming the entry', () => {
    expect(() =>
      parseTemplates(
        JSON.stringify([{ id: 'a', worker: 'w', description: '', tools: [], seed: 7 }]),
      ),
    ).toThrow('SH_SANDBOX_TEMPLATES[0]: seed must be a string');
  });
});

describe('createSession: sandbox.template', () => {
  it('stores the requested template', async () => {
    const t = templated();
    await seedCredential(t);
    await create(t, { template: 'py312' });
    expect((await t.index.get('sid-fixed'))?.sandboxTemplate).toBe('py312');
  });

  it('stores none when none is requested', async () => {
    const t = templated();
    await seedCredential(t);
    await create(t);
    expect((await t.index.get('sid-fixed'))?.sandboxTemplate).toBeUndefined();
  });

  it('400s an undeclared template, naming the declared ones, and creates nothing', async () => {
    const t = templated();
    await seedCredential(t);
    const err = (await create(t, { template: 'gpu' }).catch((e: unknown) => e)) as {
      code: string;
      message: string;
    };
    expect(err.code).toBe('invalid_request');
    expect(err.message).toContain("'gpu'");
    expect(err.message).toContain('django-django-11133, py312');
    expect(await t.index.get('sid-fixed')).toBeNull();
  });

  it('400s a non-string template', async () => {
    const t = templated();
    await seedCredential(t);
    expect(await codeOf(() => create(t, { template: 7 }))).toBe('invalid_request');
  });

  it('400s any template on a deployment that declares none', async () => {
    const d = makeDeps();
    await seedCredential(d);
    const err = (await create(d, { template: 'py312' }).catch((e: unknown) => e)) as {
      message: string;
    };
    expect(err.message).toContain('declares no sandbox templates');
  });

  it('takes a template with a tier', async () => {
    const t = makeDeps({
      config: {
        sessionTemplates: TEMPLATES,
        sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
      },
    });
    await seedCredential(t);
    await create(t, { tier: 'microvm', template: 'django-django-11133' });
    const rec = await t.index.get('sid-fixed');
    expect(rec?.sandboxTier).toBe('microvm');
    expect(rec?.sandboxTemplate).toBe('django-django-11133');
  });
});

describe('the exchange and the views', () => {
  async function token(d: CpDeps, sandbox?: unknown) {
    await seedCredential(d);
    return ((await create(d, sandbox)).body as { token: string }).token;
  }

  it('names the template and its seed', async () => {
    const t = templated();
    const res = await exchangeCredential(await token(t, { template: 'django-django-11133' }), t);
    expect(res.sandboxTemplate).toBe('django-django-11133');
    expect(res.sandboxSeed).toBe('cp -a /opt/repo/. /workspace/');
    // No store: the seed is the declared one, and says so.
    expect(res.sandboxSeedSource).toBe('declared');
  });

  it('names a template without a seed, and no seed', async () => {
    const t = templated();
    const res = await exchangeCredential(await token(t, { template: 'py312' }), t);
    expect(res.sandboxTemplate).toBe('py312');
    expect(res).not.toHaveProperty('sandboxSeed');
    expect(res).not.toHaveProperty('sandboxSeedSource');
  });

  it('omits both for a session without a template, and on a deployment without templates', async () => {
    const t = templated();
    const res = await exchangeCredential(await token(t), t);
    expect(res).not.toHaveProperty('sandboxTemplate');
    expect(res).not.toHaveProperty('sandboxSeed');
    const d = makeDeps();
    const plain = await exchangeCredential(await token(d), d);
    expect(plain).not.toHaveProperty('sandboxTemplate');
  });

  it('fails closed: a template no longer declared is still named, without a seed', () => {
    // No default template exists, so dropping one must not move its sessions to untemplated workers.
    const rec = { sandboxTemplate: 'gone' } as SessionRecord;
    expect(sessionTemplate(rec, TEMPLATES)).toEqual({ id: 'gone' });
    expect(sessionTemplate({ sandboxTemplate: 'py312' } as SessionRecord, null)).toEqual({
      id: 'py312',
    });
    expect(sessionTemplate({} as SessionRecord, TEMPLATES)).toBeUndefined();
  });

  it('the session view shows the template on a templated deployment only', async () => {
    const t = templated();
    await token(t, { template: 'py312' });
    const page = await HANDLERS.listSessions!(ctx({ principal: alice }), t);
    const [s] = (page.body as { sessions: { sandboxTemplate?: string | null }[] }).sessions;
    expect(s.sandboxTemplate).toBe('py312');
    const d = makeDeps();
    await token(d);
    const plain = await HANDLERS.listSessions!(ctx({ principal: alice }), d);
    expect((plain.body as { sessions: object[] }).sessions[0]).not.toHaveProperty(
      'sandboxTemplate',
    );
  });

  it('discovery lists the templates without their seeds, and is unchanged without templates', async () => {
    const t = templated();
    const res = await HANDLERS.getDiscovery!(ctx({}), t);
    expect((res.body as { sandboxTemplates: unknown }).sandboxTemplates).toEqual([
      {
        id: 'django-django-11133',
        description: 'SWE-bench django__django-11133',
        tools: ['bash', 'git', 'python3'],
      },
      { id: 'py312', description: 'Python 3.12', tools: ['python3'] },
    ]);
    const d = makeDeps();
    expect((await HANDLERS.getDiscovery!(ctx({}), d)).body).not.toHaveProperty('sandboxTemplates');
  });
});
