import { describe, expect, it } from 'vitest';
import { resolveVersion } from '../src/version.js';

describe('resolveVersion', () => {
  it('prefers MOCA_VERSION so deploys can bake in the git tag', () => {
    expect(resolveVersion({ MOCA_VERSION: 'v9.9.9-rc1' })).toBe('v9.9.9-rc1');
  });

  it('reports dev when nothing was baked in — no package.json read', () => {
    // A bundled release asset does not ship package.json; unset means dev.
    expect(resolveVersion({})).toBe('dev');
    expect(resolveVersion({ MOCA_VERSION: '' })).toBe('dev');
  });
});
