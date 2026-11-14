import { describe, expect, it } from 'vitest';
import {
  SESSION_OPTION_FIELDS,
  checkPreset,
  parseOptionFlags,
  resolveSessionOptions,
  fieldRefusedByServer,
  sandboxTierField,
  sandboxTemplateField,
  modelField,
} from '../src/core/session-options.js';
import { ApiError } from '../src/api/errors.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';

const api = (...names: string[]) =>
  fakeControlPlane({
    listCredentials: async () => [
      ...names.map((n) => credential(n)),
      credential('gh', { consumer: 'sandbox-egress' }),
    ],
  });

describe('resolveSessionOptions', () => {
  it('leaves the inference credential to the server when there is none (#368: the operator fallback)', async () => {
    const r = await resolveSessionOptions(api(), SESSION_OPTION_FIELDS, {}, {});
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('is blocked when the named credential does not exist and there is none at all', async () => {
    const r = await resolveSessionOptions(
      api(),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'x' },
      {},
    );
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.field.emptyHint).toMatch(/add an inference credential/);
  });

  it('maps the server refusing a credential-less session back to the field that needs one', () => {
    const refused = new ApiError('control-plane', 400, 'credential_required', 'no credential');
    expect(fieldRefusedByServer(refused, SESSION_OPTION_FIELDS)?.key).toBe('inferenceCredential');
    expect(
      fieldRefusedByServer(new ApiError('control-plane', 500, 'internal'), SESSION_OPTION_FIELDS),
    ).toBeUndefined();
    expect(
      fieldRefusedByServer(new Error('credential_required'), SESSION_OPTION_FIELDS),
    ).toBeUndefined();
  });

  it('maps a refusal to the field by its refusal code, whatever the field order', () => {
    const refused = new ApiError('control-plane', 400, 'credential_required', 'no credential');
    const reversed = [...SESSION_OPTION_FIELDS].reverse();
    // A field with no refusal code first, so the match is by code, not position.
    expect(reversed[0].key).toBe('sandboxTemplate');
    expect(fieldRefusedByServer(refused, reversed)?.key).toBe('inferenceCredential');
    // The tier field may also be left to the server, but no refusal is about it.
    expect(fieldRefusedByServer(refused, [sandboxTierField])).toBeUndefined();
  });

  it('picks the only inference credential silently, ignoring other consumers', async () => {
    const r = await resolveSessionOptions(api('anthropic'), SESSION_OPTION_FIELDS, {}, {});
    expect(r).toMatchObject({
      status: 'ready',
      request: { credentials: { inference: 'anthropic' } },
    });
  });

  it('asks when there are several, defaulting to the last one used', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      {},
      { inferenceCredential: 'b' },
    );
    expect(r.status).toBe('needs-input');
    if (r.status === 'needs-input') {
      expect(r.choices.map((c) => c.value)).toEqual(['a', 'b']);
      expect(r.defaultValue).toBe('b');
    }
  });

  it('is ready once the value is given', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'a' },
      {},
    );
    expect(r).toMatchObject({ status: 'ready', values: { inferenceCredential: 'a' } });
  });

  it('asks again when the given value no longer exists', async () => {
    const r = await resolveSessionOptions(
      api('a', 'b'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'gone' },
      {},
    );
    expect(r.status).toBe('needs-input');
  });

  it('asks even for a single choice when a different, missing value was given', async () => {
    const r = await resolveSessionOptions(
      api('a'),
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'gone' },
      {},
    );
    expect(r.status).toBe('needs-input');
  });
});

describe('sandboxTierField (P6.3)', () => {
  const api = (sandboxTiers: { names: string[]; default: string } | null) =>
    fakeControlPlane({ discovery: async () => ({ harnessUrl: null, sandboxTiers }) });

  it('offers the declared tiers, marking the default', async () => {
    expect(
      await sandboxTierField.source(
        api({ names: ['container', 'microvm'], default: 'container' }),
        {},
      ),
    ).toEqual([
      { value: 'container', label: 'container', isDefault: true },
      { value: 'microvm', label: 'microvm' },
    ]);
  });

  it('is skipped entirely when the deployment declares no tiers', async () => {
    const r = await resolveSessionOptions(api(null), [sandboxTierField], {}, {});
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('interactive: asks, preselecting the server default when nothing was used last', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'microvm' }),
      [sandboxTierField],
      {},
      {},
    );
    expect(r.status).toBe('needs-input');
    expect(r.status === 'needs-input' && r.defaultValue).toBe('microvm');
  });

  it('NON-interactive: an omitted tier is left to the server default, never a refusal', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      {},
      {},
      { interactive: false },
    );
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('a given tier goes into the request as sandbox.tier', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      { sandboxTier: 'microvm' },
      {},
    );
    expect(r).toMatchObject({ status: 'ready', request: { sandbox: { tier: 'microvm' } } });
  });

  it('a tier used last beats the server default as the preselection', async () => {
    const r = await resolveSessionOptions(
      api({ names: ['container', 'microvm'], default: 'container' }),
      [sandboxTierField],
      {},
      { sandboxTier: 'microvm' },
    );
    expect(r.status === 'needs-input' && r.defaultValue).toBe('microvm');
  });

  it('skips the field when the control plane predates /v1/discovery (a 404, with --harness-url)', async () => {
    const cp = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 404, 'http_404');
      },
      listCredentials: async () => [credential('anthropic')],
    });
    const r = await resolveSessionOptions(cp, SESSION_OPTION_FIELDS, {}, {});
    expect(r).toEqual({
      status: 'ready',
      values: { inferenceCredential: 'anthropic' },
      request: { credentials: { inference: 'anthropic' } },
    });
  });

  it('lets any other discovery failure propagate', async () => {
    const cp = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 500, 'internal_error');
      },
    });
    await expect(resolveSessionOptions(cp, [sandboxTierField], {}, {})).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    });
  });

  it('treats a malformed sandboxTiers in discovery as no tiers, not a TypeError', async () => {
    // Discovery is a remote body: anything but { names: string[], default: string } offers nothing.
    for (const bad of [
      {},
      { names: 'container', default: 'container' },
      { names: ['container', 7], default: 'container' },
      { names: ['container'] },
      'container',
    ]) {
      const cp = fakeControlPlane({
        discovery: async () => ({ harnessUrl: null, sandboxTiers: bad as never }),
      });
      expect(await sandboxTierField.source(cp, {})).toEqual([]);
      const r = await resolveSessionOptions(cp, [sandboxTierField], {}, {});
      expect(r).toEqual({ status: 'ready', values: {}, request: {} });
    }
  });

  it('a given tier on a deployment with none is blocked, saying so', async () => {
    const r = await resolveSessionOptions(
      api(null),
      [sandboxTierField],
      { sandboxTier: 'microvm' },
      {},
    );
    expect(r.status).toBe('blocked');
    expect(r.status === 'blocked' && r.field.emptyHint).toContain('declares no sandbox tiers');
  });
});

describe('presets', () => {
  it('splits known fields from stale ones', () => {
    expect(
      checkPreset(
        { name: 'p', values: { inferenceCredential: 'a', unknown: 'x' } },
        SESSION_OPTION_FIELDS,
      ),
    ).toEqual({
      values: { inferenceCredential: 'a' },
      stale: ['unknown'],
    });
  });
});

describe('parseOptionFlags', () => {
  it('parses key=value pairs, keeping = in values', () => {
    expect(parseOptionFlags(['inferenceCredential=a', 'x=b=c'])).toEqual({
      inferenceCredential: 'a',
      x: 'b=c',
    });
  });

  it('rejects a flag without =', () => {
    expect(() => parseOptionFlags(['oops'])).toThrow('--option expects key=value, got "oops"');
  });
});

describe('the model field', () => {
  const withModels = (models: Array<{ id: string; contextWindow?: number }>, names = ['c1']) =>
    fakeControlPlane({
      listCredentials: async () => names.map((n) => credential(n)),
      listModels: async (cred) => ({ credential: cred ?? 'c1', models }),
    });

  it('lists the chosen credentials models, labelled with their window', async () => {
    const seen: Array<string | undefined> = [];
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1'), credential('c2')],
      listModels: async (cred) => {
        seen.push(cred);
        return { credential: cred!, models: [{ id: 'a', contextWindow: 200000 }, { id: 'b' }] };
      },
    });
    const r = await resolveSessionOptions(
      api,
      SESSION_OPTION_FIELDS,
      { inferenceCredential: 'c2' },
      {},
    );
    expect(seen).toEqual(['c2']);
    expect(r.status).toBe('needs-input');
    if (r.status === 'needs-input') {
      expect(r.field.key).toBe('model');
      expect(r.choices.map((c) => c.label)).toEqual(['deployment default', 'a  200k ctx', 'b']);
      // Nothing used last: the deployment default is preselected (final review F3).
      expect(r.defaultValue).toBe('');
    }
  });

  // PR #540 review R6: a remote body, shape-checked like the sandbox tiers.
  it('skips the field on a catalog body with no models array', async () => {
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1')],
      listModels: async () => ({ credential: 'c1' }) as never,
    });
    const r = await resolveSessionOptions(api, SESSION_OPTION_FIELDS, {}, {});
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.request).not.toHaveProperty('model');
  });

  it('keeps only entries with a string id, and shows only a finite positive window', async () => {
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1')],
      listModels: async () =>
        ({
          credential: 'c1',
          models: [
            null,
            { id: 7 },
            { id: 'a', contextWindow: '200000' },
            { id: 'b', contextWindow: Number.POSITIVE_INFINITY },
            { id: 'c', contextWindow: -5 },
            { id: 'd', contextWindow: 400 },
            { id: 'e', contextWindow: 131072 },
          ],
        }) as never,
    });
    const r = await resolveSessionOptions(api, SESSION_OPTION_FIELDS, {}, {});
    expect(r.status).toBe('needs-input');
    if (r.status === 'needs-input') {
      expect(r.choices.map((c) => c.label)).toEqual([
        'deployment default',
        'a',
        'b',
        'c',
        'd  400 ctx',
        'e  131k ctx',
      ]);
    }
  });

  it('asks even with one model, the deployment default preselected (final review F3)', async () => {
    const r = await resolveSessionOptions(
      withModels([{ id: 'only' }]),
      SESSION_OPTION_FIELDS,
      {},
      {},
    );
    expect(r.status).toBe('needs-input');
    if (r.status === 'needs-input') {
      expect(r.choices).toEqual([
        { value: '', label: 'deployment default', isDefault: true },
        { value: 'only', label: 'only' },
      ]);
      expect(r.defaultValue).toBe('');
    }
  });

  it('does not pin the only model for a script that names none (final review F3)', async () => {
    const r = await resolveSessionOptions(
      withModels([{ id: 'only' }]),
      SESSION_OPTION_FIELDS,
      {},
      {},
      { interactive: false },
    );
    expect(r.status).toBe('ready');
    expect(r.status === 'ready' && r.request.model).toBe(undefined);
  });

  it.each([
    ['the deployment default chosen', { model: '' }, {}],
    ['a preset or last use that stored the default', {}, { model: '' }],
  ])('sends no model for %s (final review F3)', async (_n, given, lastUsed) => {
    const api = withModels([{ id: 'a' }]);
    const r = await resolveSessionOptions(api, SESSION_OPTION_FIELDS, given, lastUsed);
    if (Object.keys(given).length > 0) {
      expect(r.status).toBe('ready');
      expect(r.status === 'ready' && r.request.model).toBe(undefined);
      expect(r.status === 'ready' && 'model' in r.request).toBe(false);
    } else {
      expect(r).toMatchObject({ status: 'needs-input', defaultValue: '' });
    }
  });

  it('still sends a model given with --option', async () => {
    const r = await resolveSessionOptions(
      withModels([{ id: 'a' }]),
      SESSION_OPTION_FIELDS,
      { model: 'a' },
      {},
      { interactive: false },
    );
    expect(r.status === 'ready' && r.request.model).toBe('a');
  });

  it('preselects the last-used model', async () => {
    const r = await resolveSessionOptions(
      withModels([{ id: 'a' }, { id: 'b' }]),
      SESSION_OPTION_FIELDS,
      {},
      { model: 'b' },
    );
    expect(r).toMatchObject({ status: 'needs-input', defaultValue: 'b' });
  });

  it('leaves the model to the server for a script that names none', async () => {
    const r = await resolveSessionOptions(
      withModels([{ id: 'a' }, { id: 'b' }]),
      SESSION_OPTION_FIELDS,
      {},
      {},
      { interactive: false },
    );
    expect(r.status).toBe('ready');
    expect(r.status === 'ready' && r.request.model).toBe(undefined);
  });

  it.each([
    ['an older control plane', new ApiError('control-plane', 404, 'not_found')],
    ['a catalog outage', new ApiError('control-plane', 503, 'model_catalog_unavailable')],
    [
      'a 503 without the code (final review F10)',
      new ApiError('control-plane', 503, 'unavailable'),
    ],
    ['no credential at all', new ApiError('control-plane', 400, 'credential_required')],
  ])('is skipped on %s', async (_n, err) => {
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1')],
      listModels: async () => {
        throw err;
      },
    });
    const r = await resolveSessionOptions(api, SESSION_OPTION_FIELDS, {}, {});
    expect(r.status).toBe('ready');
    expect(r.status === 'ready' && r.request.model).toBe(undefined);
  });

  it('sends an explicit model as given when the catalog is unavailable', async () => {
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1')],
      listModels: async () => {
        throw new ApiError('control-plane', 503, 'model_catalog_unavailable');
      },
    });
    const r = await resolveSessionOptions(api, SESSION_OPTION_FIELDS, { model: 'gpt-x' }, {});
    expect(r).toMatchObject({ status: 'ready', request: { model: 'gpt-x' } });
  });

  it('rethrows a credential that does not exist, rather than hiding it', async () => {
    const api = fakeControlPlane({
      listCredentials: async () => [credential('c1')],
      listModels: async () => {
        throw new ApiError('control-plane', 404, 'credential_not_found');
      },
    });
    await expect(resolveSessionOptions(api, [modelField], {}, {})).rejects.toThrow();
  });
});

describe('sandboxTemplateField (session-templates spec §6)', () => {
  const T = [
    { id: 'django-django-11133', description: 'SWE-bench', tools: ['bash'] },
    { id: 'py312', description: 'Python 3.12', tools: ['python3'] },
  ];
  const api = (sandboxTemplates?: unknown) =>
    fakeControlPlane({
      discovery: async () => ({ harnessUrl: null, sandboxTiers: null, sandboxTemplates }) as never,
    });

  it('offers none first, preselected, then the declared templates', async () => {
    expect(await sandboxTemplateField.source(api(T), {})).toEqual([
      { value: '', label: 'none', isDefault: true },
      { value: 'django-django-11133', label: 'django-django-11133' },
      { value: 'py312', label: 'py312' },
    ]);
  });

  it('is skipped when the deployment declares none (absent, null or malformed)', async () => {
    for (const t of [undefined, null, 'x', [{ nope: 1 }]]) {
      expect(await resolveSessionOptions(api(t), [sandboxTemplateField], {}, {})).toEqual({
        status: 'ready',
        values: {},
        request: {},
      });
    }
  });

  it('one declared template is still a question, not picked for every session', async () => {
    const r = await resolveSessionOptions(api([T[1]]), [sandboxTemplateField], {}, {});
    expect(r.status).toBe('needs-input');
    expect(r.status === 'needs-input' && r.defaultValue).toBe('');
  });

  it('NON-interactive: an omitted template sends none', async () => {
    const r = await resolveSessionOptions(
      api(T),
      [sandboxTemplateField],
      {},
      {},
      {
        interactive: false,
      },
    );
    expect(r).toEqual({ status: 'ready', values: {}, request: {} });
  });

  it('a given template goes into the request as sandbox.template, beside a tier', async () => {
    const both = fakeControlPlane({
      discovery: async () =>
        ({
          harnessUrl: null,
          sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
          sandboxTemplates: T,
        }) as never,
    });
    const r = await resolveSessionOptions(
      both,
      [sandboxTierField, sandboxTemplateField],
      { sandboxTier: 'microvm', sandboxTemplate: 'py312' },
      {},
    );
    expect(r).toMatchObject({
      status: 'ready',
      request: { sandbox: { tier: 'microvm', template: 'py312' } },
    });
  });

  it("choosing 'none' sends no template", async () => {
    const r = await resolveSessionOptions(
      api(T),
      [sandboxTemplateField],
      { sandboxTemplate: '' },
      {},
    );
    expect(r).toEqual({ status: 'ready', values: { sandboxTemplate: '' }, request: {} });
  });

  it('sends an undeclared value as given, for the control plane to resolve (id@build, id:tag)', async () => {
    for (const v of [
      'django-django-11133@sha256:' + 'a'.repeat(64),
      'py312:stable',
      'self-serve-id',
    ]) {
      const r = await resolveSessionOptions(
        api(T),
        [sandboxTemplateField],
        { sandboxTemplate: v },
        {},
        { interactive: false },
      );
      expect(r).toEqual({
        status: 'ready',
        values: { sandboxTemplate: v },
        request: { sandbox: { template: v } },
      });
    }
  });

  it('sends an undeclared value even on a deployment that declares none (a store-only template)', async () => {
    const r = await resolveSessionOptions(
      api(undefined),
      [sandboxTemplateField],
      { sandboxTemplate: 'astropy-astropy-14995@sha256:' + 'b'.repeat(64) },
      {},
    );
    expect(r).toMatchObject({
      status: 'ready',
      request: { sandbox: { template: expect.any(String) } },
    });
  });

  it('is in SESSION_OPTION_FIELDS, after the tier', () => {
    const keys = SESSION_OPTION_FIELDS.map((f) => f.key);
    expect(keys.indexOf('sandboxTemplate')).toBe(keys.indexOf('sandboxTier') + 1);
  });
});
