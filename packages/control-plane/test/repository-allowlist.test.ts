// The policy's per-registry repository allowlist (allowedRepositories): a registry such as Docker Hub
// opened to named repositories only, not to all of it.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore } from '../src/provenance.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import {
  checkCreate,
  DEFAULT_POLICY,
  policyProblems,
  registryOf,
  repositoryAllowed,
  repositoryOf,
  type Policy,
} from '../src/template-policy.js';
import { admin, ctx, makeDeps, NOW_MS } from './helpers/deps.js';

const D = `sha256:${'a'.repeat(64)}`;
// The repository's worked example spec, as a `base` create (no gate record, no benchmark fields).
const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>;
const { id: _id, image: _image, schema: _s, notes: _n, ...REST } = SPEC;
const spec = {
  ...REST,
  source_record_digest: undefined,
  skip_git_identity_check: false,
};
const create = (image: string, policy: Policy) =>
  checkCreate({ id: 'py', image, spec, profile: 'base' }, policy);
const failed = (r: ReturnType<typeof checkCreate>) => r.failed?.rule;

const HUB: Policy = {
  ...DEFAULT_POLICY,
  allowedRegistries: ['<default>', 'docker.io'],
  allowedRepositories: { 'docker.io': ['library/python'] },
};

describe('registryOf and repositoryOf', () => {
  it('reads Docker Hub as docker.io, never as the build host default', () => {
    expect(registryOf(`docker.io/library/python@${D}`)).toBe('docker.io');
    expect(registryOf(`index.docker.io/library/python@${D}`)).toBe('docker.io');
    expect(registryOf(`python@${D}`)).toBe('<default>');
    expect(registryOf(`library/python@${D}`)).toBe('<default>');
    expect(registryOf(`images/moca-microvm@${D}`)).toBe('<default>');
    expect(registryOf(`ghcr.io/x/y@${D}`)).toBe('ghcr.io');
    expect(registryOf(`localhost:5000/x/y@${D}`)).toBe('localhost:5000');
  });

  it('normalizes an official Docker Hub name to library/<name>, and drops tag and digest', () => {
    expect(repositoryOf(`docker.io/python@${D}`)).toBe('library/python');
    expect(repositoryOf(`docker.io/library/python@${D}`)).toBe('library/python');
    expect(repositoryOf(`docker.io/library/python:3.12-slim@${D}`)).toBe('library/python');
    expect(repositoryOf(`index.docker.io/python@${D}`)).toBe('library/python');
    expect(repositoryOf(`ghcr.io/x/y@${D}`)).toBe('x/y');
    expect(repositoryOf(`ghcr.io/x/y:t@${D}`)).toBe('x/y');
    expect(repositoryOf(`localhost:5000/x/y@${D}`)).toBe('x/y');
    // No host: the build host's default registry, so no Docker Hub normalization.
    expect(repositoryOf(`python@${D}`)).toBe('python');
    expect(repositoryOf(`images/moca-microvm@${D}`)).toBe('images/moca-microvm');
  });
});

describe('repositoryAllowed: whole path segments, never string prefixes', () => {
  it.each([
    ['library/python', 'library/python', true],
    ['library/python-evil', 'library/python', false],
    ['library/pythonx', 'library/python', false],
    ['library/python/x', 'library/python', false],
    ['library/pytho', 'library/python', false],
    ['library/python', 'library/*', true],
    ['library/python/x', 'library/*', true],
    ['libraryx/python', 'library/*', false],
    ['library', 'library/*', false],
  ])('%s against %s: %s', (repo, entry, ok) => {
    expect(repositoryAllowed(repo, entry)).toBe(ok);
  });
});

describe('the create rule', () => {
  it('allows a listed repository and refuses another of the same registry', () => {
    expect(failed(create(`docker.io/library/python@${D}`, HUB))).toBeUndefined();
    expect(failed(create(`docker.io/python@${D}`, HUB))).toBeUndefined();
    const r = create(`docker.io/library/node@${D}`, HUB);
    expect(failed(r)).toBe('registry.repository');
    expect(r.failed?.message).toBe(
      'image repository library/node is not allowed from registry docker.io (policy allowedRepositories)',
    );
    expect(failed(create(`docker.io/library/python-evil@${D}`, HUB))).toBe('registry.repository');
  });

  it('still refuses a registry that is not allowed, whatever the repository', () => {
    expect(failed(create(`ghcr.io/library/python@${D}`, HUB))).toBe('registry');
  });

  it('leaves a registry with no repository list open, as before', () => {
    // The build host's default registry (the curated images) has no list: every repository passes.
    expect(failed(create(`images/moca-microvm@${D}`, HUB))).toBeUndefined();
    expect(failed(create(`images/anything@${D}`, HUB))).toBeUndefined();
    // And the default policy, with no allowedRepositories at all, behaves exactly as before.
    expect(failed(create(`images/moca-microvm@${D}`, DEFAULT_POLICY))).toBeUndefined();
    expect(failed(create(`docker.io/library/python@${D}`, DEFAULT_POLICY))).toBe('registry');
  });

  it.each([
    ['a `..` segment', 'library/../evil/x'],
    ['a `.` segment', 'library/./python'],
    ['an empty segment', 'library//python'],
    ['uppercase', 'Library/Python'],
    ['a trailing slash', 'library/python/'],
  ])(
    'refuses an image path with %s before matching, where the registry lists repositories',
    (_w, path) => {
      // M1's reference grammar refuses it first, so the repository rule is never reached.
      const p: Policy = { ...HUB, allowedRepositories: { 'docker.io': ['library/*'] } };
      const r = create(`docker.io/${path}@${D}`, p);
      expect(failed(r)).toBe('M1');
      expect(r.results.map((x) => x.rule)).not.toContain('registry.repository');
    },
  );

  it('reads a registry key in any case, as allowedRegistries does', () => {
    const p: Policy = {
      ...HUB,
      allowedRegistries: ['<default>', 'Docker.IO'],
      allowedRepositories: { 'Docker.IO': ['library/python'] },
    };
    expect(policyProblems(p)).toEqual([]);
    expect(failed(create(`docker.io/library/python@${D}`, p))).toBeUndefined();
    expect(failed(create(`docker.io/library/node@${D}`, p))).toBe('registry.repository');
  });

  it('admits a prefix entry by whole segments', () => {
    const p: Policy = { ...HUB, allowedRepositories: { 'docker.io': ['library/*'] } };
    expect(failed(create(`docker.io/library/node@${D}`, p))).toBeUndefined();
    expect(failed(create(`docker.io/libraryx/node@${D}`, p))).toBe('registry.repository');
  });
});

describe('policyProblems', () => {
  it('accepts the field, and none', () => {
    expect(policyProblems(HUB)).toEqual([]);
    expect(policyProblems(DEFAULT_POLICY)).toEqual([]);
  });

  it.each([
    ['not an object', ['docker.io'], 'allowedRepositories must map a registry'],
    ['a registry not allowed', { 'ghcr.io': ['x/y'] }, 'must also be in allowedRegistries'],
    ['an empty list', { 'docker.io': [] }, 'non-empty list of repository paths'],
    [
      'an entry with a space',
      { 'docker.io': ['library/py thon'] },
      'non-empty list of repository paths',
    ],
    ['an empty entry', { 'docker.io': [''] }, 'non-empty list of repository paths'],
    ['a bare star', { 'docker.io': ['*'] }, 'non-empty list of repository paths'],
  ])('refuses %s', (_n, repos, msg) => {
    const problems = policyProblems({ ...HUB, allowedRepositories: repos as never });
    expect(problems.join('; ')).toContain(msg);
  });
});

describe('PUT /v1/policy', () => {
  it('stores the field and keeps every other field of the policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-repos-'));
    const provenance = new ProvenanceStore({ dir, now: () => NOW_MS });
    const d = makeDeps({
      provenance,
      policy: new FilePolicyStore({ dir, provenance }),
      config: { routeProfile: 'sandbox' },
    });
    const before: Policy = {
      ...DEFAULT_POLICY,
      trustedGateRecords: [`sha256:${'b'.repeat(64)}`],
      quota: { templates: 50, buildsQueued: 5, active: 4 },
    };
    await d.policy!.set(before, admin.sub);
    const next = {
      ...before,
      allowedRegistries: [...before.allowedRegistries, 'docker.io'],
      allowedRepositories: { 'docker.io': ['library/python'] },
    };
    const r = await HANDLERS.putPolicy!(ctx({ principal: admin, body: next }), d);
    expect(r.status).toBe(200);
    const { policy } = await d.policy!.current();
    expect(policy.allowedRepositories).toEqual({ 'docker.io': ['library/python'] });
    expect(policy.trustedGateRecords).toEqual(before.trustedGateRecords);
    expect(policy.quota).toEqual(before.quota);
    expect(policy.profiles).toEqual(before.profiles);
  });
});
