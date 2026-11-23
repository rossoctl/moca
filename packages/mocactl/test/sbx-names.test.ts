import { describe, expect, it } from 'vitest';
import { sandboxName } from '../src/sbx/names.js';

// The control plane's NAME_RE (packages/control-plane/src/sandbox-handlers.ts).
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe('sandboxName', () => {
  it('is adjective-surname, one the control plane takes, for any pick', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999_999, 1]) {
      const n = sandboxName(() => r);
      expect(n).toMatch(/^[a-z]+-[a-z]+$/);
      expect(n).toMatch(NAME_RE);
    }
    expect(sandboxName(() => 0)).toBe('admiring-agnesi');
  });

  it('varies with the default random', () => {
    const seen = new Set(Array.from({ length: 50 }, () => sandboxName()));
    expect(seen.size).toBeGreaterThan(40);
  });
});
