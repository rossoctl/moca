import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectPoolSandbox,
  SandboxPoolEmptyError,
  resetTierWarnings,
} from '../src/select-sandbox.js';
import type { SandboxRecord } from '../src/pool-records.js';
import { TEMPLATE_LABEL } from '../src/sandbox-affinity.js';
import { deps, env, fakeAffinity, fakeLease, opts, TIERS } from './select-sandbox-tiers.test.js';

/** The template filter and its affinity rule (session-templates spec §4). */

const rec = (id: string, labels: Record<string, string> = {}): SandboxRecord => ({
  sandboxId: id,
  labels,
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
});
const tpl = (id: string, template: string, tier?: string) =>
  rec(id, { [TEMPLATE_LABEL]: template, ...(tier ? { 'moca.dev/tier': tier } : {}) });

describe('selectPoolSandbox: the template filter', () => {
  beforeEach(() => resetTierWarnings());

  it('a session with a template lands only on a worker serving it, however loaded the others are', async () => {
    const { lease } = fakeLease({ 'dj-1': 1 });
    const recs = [rec('plain-1'), tpl('py-1', 'py312'), tpl('dj-1', 'django-django-11133')];
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'django-django-11133' }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe('dj-1');
  });

  it('a session without a template never lands on a templated worker', async () => {
    // The templated worker is the idle one: load alone would pick it.
    const { lease } = fakeLease({ 'plain-1': 1, 'py-1': 0 });
    const recs = [tpl('py-1', 'py312'), rec('plain-1')];
    const sel = await selectPoolSandbox(env(), '/h', 's-1', opts({ cap: 4 }), deps(recs, lease));
    expect(sel?.sandboxId).toBe('plain-1');
    // '' is the same as absent.
    const again = await selectPoolSandbox(
      env(),
      '/h',
      's-2',
      opts({ cap: 4, template: '' }),
      deps(recs, lease),
    );
    expect(again?.sandboxId).toBe('plain-1');
  });

  it('only templated workers attached: a plain session finds none, naming no template', async () => {
    const { lease } = fakeLease();
    const err = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts(),
      deps([tpl('py-1', 'py312')], lease),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxPoolEmptyError);
    expect((err as Error).message).not.toContain('template');
  });

  it('no worker of the template: the error names it and the variable to set', async () => {
    const { lease } = fakeLease();
    const err = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'django-django-11133' }),
      deps([rec('plain-1'), tpl('py-1', 'py312')], lease),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxPoolEmptyError);
    expect((err as Error).message).toContain("sandbox template 'django-django-11133'");
    expect((err as Error).message).toContain('SANDBOX_TEMPLATE=django-django-11133');
  });

  it('applies after the tier filter: the template in the session tier only', async () => {
    const { lease } = fakeLease();
    const recs = [tpl('py-c', 'py312', 'container'), tpl('py-m', 'py312', 'microvm')];
    const sel = await selectPoolSandbox(
      env(TIERS),
      '/h',
      's-1',
      opts({ tier: 'microvm', template: 'py312' }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe('py-m');
    expect(sel?.tier).toBe('microvm');
  });
});

describe('selectPoolSandbox: affinity across a template change', () => {
  beforeEach(() => resetTierWarnings());

  it("keeps the session on its affine worker while it still serves the session's template", async () => {
    const { lease } = fakeLease({ 'py-1': 1 });
    const aff = fakeAffinity({ 's-1': { sandboxId: 'py-1', tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'py312' }),
      deps([tpl('py-1', 'py312'), tpl('py-2', 'py312')], lease, { affinity: aff.store }),
    );
    expect(sel?.sandboxId).toBe('py-1');
    expect(sel?.workspaceReset).toBeUndefined();
  });

  it('an affine worker now serving another template is an immediate reset, no grace', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ 's-1': { sandboxId: 'w-1', tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'py312' }),
      deps([tpl('w-1', 'node22'), tpl('py-2', 'py312')], lease, { affinity: aff.store }),
    );
    expect(sel?.sandboxId).toBe('py-2');
    expect(sel?.workspaceReset).toEqual({ from: 'w-1', reason: 'retiered' });
    expect(aff.calls.some((c) => c.startsWith('detachedSince'))).toBe(false);
  });

  it('an affine worker that lost its template moves a templated session at once', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ 's-1': { sandboxId: 'w-1', tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'py312' }),
      deps([rec('w-1'), tpl('py-2', 'py312')], lease, { affinity: aff.store }),
    );
    expect(sel?.sandboxId).toBe('py-2');
    expect(sel?.workspaceReset?.reason).toBe('retiered');
  });
});
