import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalTar, contentDigest } from '@moca/config-bundle';
import { unpackBundle, promotedLoaderOptions } from '../src/config-resolver.js';
import { resourceLoaderOptionsFor } from '../src/run-turn.js';

const base = () => ({
  cwd: '/w',
  agentDir: '/a',
  settingsManager: { marker: 'sm' },
  extensionFactories: [() => ({})],
});

describe('resourceLoaderOptionsFor', () => {
  it('adds NOTHING when no bundle is promoted (the back-compat guarantee)', () => {
    const out = resourceLoaderOptionsFor(base(), undefined);
    expect(Object.keys(out).sort()).toEqual([
      'agentDir',
      'cwd',
      'extensionFactories',
      'settingsManager',
    ]);
  });

  it('passes the base fields through untouched', () => {
    const b = base();
    const out = resourceLoaderOptionsFor(b, undefined);
    expect(out.cwd).toBe('/w');
    expect(out.settingsManager).toBe(b.settingsManager);
    expect(out.extensionFactories).toBe(b.extensionFactories);
  });

  it('adds the promoted options when a bundle is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-promoted-'));
    try {
      const entries = [
        { path: 'skills/k/SKILL.md', content: Buffer.from('---\nname: k\ndescription: d\n---\nb') },
        { path: 'context/agents/0-CLAUDE.md', content: Buffer.from('# promoted') },
        { path: 'prompt/append-0.md', content: Buffer.from('note\nline two') },
      ];
      const promoted = unpackBundle(canonicalTar(entries), contentDigest(entries), dir);
      const out = resourceLoaderOptionsFor(base(), promoted);
      expect(out.noContextFiles).toBe(true);
      expect(out.additionalSkillPaths).toEqual([promoted.skillsDir]);
      expect(out.appendSystemPrompt).toEqual(promoted.promptFragments);
      // base fields survive the merge
      expect(out.cwd).toBe('/w');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promoted option keys never collide with the base four', () => {
    // resourceLoaderOptionsFor merges `{ ...base, ...promoted }`, so a promoted key colliding with
    // a base key would silently win -- a promoted `cwd` would replace the harness's real working
    // directory with a bundle path and nothing would error. No collision exists today; this pins
    // that invariant so a future promoted option can't introduce one unnoticed.
    const dir = mkdtempSync(join(tmpdir(), 'rt-promoted-collision-'));
    try {
      const entries = [
        { path: 'skills/k/SKILL.md', content: Buffer.from('---\nname: k\ndescription: d\n---\nb') },
        { path: 'context/agents/0-CLAUDE.md', content: Buffer.from('# promoted') },
        { path: 'prompt/append-0.md', content: Buffer.from('note\nline two') },
      ];
      const promoted = unpackBundle(canonicalTar(entries), contentDigest(entries), dir);
      const promotedKeys = Object.keys(promotedLoaderOptions(promoted));
      const baseKeys = Object.keys(base());
      expect(promotedKeys.filter((k) => baseKeys.includes(k))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
