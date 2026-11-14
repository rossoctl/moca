import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectPoolSandbox,
  SandboxPoolEmptyError,
  resetTierWarnings,
} from '../src/select-sandbox.js';
import type { SandboxRecord } from '../src/pool-records.js';
import { BUILD_LABEL, TEMPLATE_LABEL } from '../src/sandbox-affinity.js';
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

  it('a session pinned to a build lands only on a worker serving that build', async () => {
    const A = 'sha256:' + 'a'.repeat(64);
    const B = 'sha256:' + 'b'.repeat(64);
    const of = (id: string, build?: string) =>
      rec(id, { [TEMPLATE_LABEL]: 'dj', ...(build ? { [BUILD_LABEL]: build } : {}) });
    // The B worker is idle and the A one loaded: load alone would pick B, or the unlabelled one.
    const { lease } = fakeLease({ 'dj-a': 1 });
    const recs = [of('dj-old'), of('dj-b', B), of('dj-a', A)];
    const pinned = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'dj', build: A }),
      deps(recs, lease),
    );
    expect(pinned?.sandboxId).toBe('dj-a');
    // Unpinned: any worker of the template, as before.
    const any = await selectPoolSandbox(
      env(),
      '/h',
      's-2',
      opts({ template: 'dj' }),
      deps(recs, lease),
    );
    expect(['dj-old', 'dj-b', 'dj-a']).toContain(any?.sandboxId);
    // No worker of the pinned build: refused, never another build.
    const C = 'sha256:' + 'c'.repeat(64);
    await expect(
      selectPoolSandbox(env(), '/h', 's-3', opts({ template: 'dj', build: C }), deps(recs, lease)),
    ).rejects.toBeInstanceOf(SandboxPoolEmptyError);
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

  it('an affine worker now serving another build of the template moves a pinned session at once', async () => {
    const A = 'sha256:' + 'a'.repeat(64);
    const B = 'sha256:' + 'b'.repeat(64);
    const of = (id: string, build: string) =>
      rec(id, { [TEMPLATE_LABEL]: 'dj', [BUILD_LABEL]: build });
    const { lease } = fakeLease();
    const aff = fakeAffinity({ 's-1': { sandboxId: 'w-1', tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ template: 'dj', build: A }),
      deps([of('w-1', B), of('w-2', A)], lease, { affinity: aff.store }),
    );
    expect(sel?.sandboxId).toBe('w-2');
    expect(sel?.workspaceReset).toEqual({ from: 'w-1', reason: 'retiered' });
    // No grace: waiting cannot bring the worker back to the pinned build.
    expect(aff.calls.some((c) => c.startsWith('detachedSince'))).toBe(false);
  });
});
