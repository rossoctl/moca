import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePromoteArgs,
  projectMemoryDir,
  projectRoot,
  collectContextFiles,
  promoteInputs,
  resolveHomeDir,
  resolveProjectDir,
  LOCKFILE_OUT,
  readInventory,
  resolveInventoryPath,
  inventoryCandidates,
  inventoryFileName,
  INVENTORY_SUBDIR,
} from '../src/promote.js';

let root: string;
const write = (rel: string, body: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'promote-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parsePromoteArgs --exclude-prompt', () => {
  it('collects repeated exclusions in order', () => {
    const a = parsePromoteArgs([
      '--entry',
      'go',
      '--exclude-prompt',
      'promote',
      '--exclude-prompt',
      'scratch',
    ]);
    expect(a.excludePrompts).toEqual(['promote', 'scratch']);
  });

  it('requires a value, rather than silently excluding the empty name', () => {
    // Asserts the specific message, not just any error mentioning the flag: while the flag was
    // unknown, `unknown flag: --exclude-prompt` also matched /--exclude-prompt/ and the test
    // passed without the feature existing.
    expect(() => parsePromoteArgs(['--entry', 'go', '--exclude-prompt'])).toThrow(
      /--exclude-prompt requires a prompt name/,
    );
  });
});

describe('parsePromoteArgs', () => {
  it('requires an entry', () => {
    expect(() => parsePromoteArgs([])).toThrow(/--entry/);
  });

  it('defaults mode to unattended and the image to the one setup-k8s.sh deploys', () => {
    // Must match deploy/knative/setup-k8s.sh:30 and the inventory filename created in Task 14,
    // or readInventory() finds nothing and the binary check degrades to a warning forever.
    const a = parsePromoteArgs(['--entry', 'go']);
    expect(a).toEqual({
      entry: 'go',
      mode: 'unattended',
      sandboxImage: 'ghcr.io/rossoctl/moca-sandbox:latest',
      deny: [],
      excludePrompts: [],
      dryRun: false,
    });
  });

  it('accepts --mode attended, repeated --deny, and --dry-run', () => {
    const a = parsePromoteArgs([
      '--entry',
      'go',
      '--mode',
      'attended',
      '--deny',
      'a',
      '--deny',
      'b',
      '--dry-run',
    ]);
    expect(a.mode).toBe('attended');
    expect(a.deny).toEqual(['a', 'b']);
    expect(a.dryRun).toBe(true);
  });

  it('rejects an unknown mode rather than silently defaulting', () => {
    expect(() => parsePromoteArgs(['--entry', 'go', '--mode', 'sideways'])).toThrow(/mode/);
  });

  it('parses --project', () => {
    const a = parsePromoteArgs(['--entry', 'go', '--project', '/some/dir']);
    expect(a.project).toBe('/some/dir');
  });

  it('leaves project undefined when --project is not given', () => {
    const a = parsePromoteArgs(['--entry', 'go']);
    expect(a.project).toBeUndefined();
  });

  it('rejects an empty --project value', () => {
    expect(() => parsePromoteArgs(['--entry', 'go', '--project', ''])).toThrow(/--project/);
  });
});

// `--home` and `--redis-url` exist so the whole invocation can be one word-for-word command with
// no inline `VAR=value` prefix and no `$VAR`. That is not cosmetic: Claude Code parses every Bash
// command and refuses to match an `allowed-tools` grant against one it cannot analyze statically,
// so the env-var form of this invocation is unrunnable in the `dontAsk` and `auto` permission
// modes. Measured on 2.1.260 with `Bash(pnpm:*)` granted under `dontAsk`:
// `pnpm --dir /lit promote --entry x` is allowed, `HOME=/lit pnpm --dir /lit promote --entry x` is
// denied, and any argument containing `$PWD` is denied as `Contains expansion`.
describe('parsePromoteArgs --home / --redis-url', () => {
  it('parses --home', () => {
    const a = parsePromoteArgs(['--entry', 'go', '--home', '/some/dir']);
    expect(a.home).toBe('/some/dir');
  });

  it('parses --redis-url', () => {
    const a = parsePromoteArgs(['--entry', 'go', '--redis-url', 'redis://localhost:16379']);
    expect(a.redisUrl).toBe('redis://localhost:16379');
  });

  it('leaves both undefined when neither flag is given, so the env still decides', () => {
    const a = parsePromoteArgs(['--entry', 'go']);
    expect(a.home).toBeUndefined();
    expect(a.redisUrl).toBeUndefined();
  });

  it('rejects an empty --home value rather than promoting from the filesystem root', () => {
    // An empty value would otherwise resolve to '/' and sweep every skill under it into a bundle
    // bound for a shared store -- the same failure mode guard 1 exists to prevent.
    expect(() => parsePromoteArgs(['--entry', 'go', '--home', ''])).toThrow(
      /--home requires a directory/,
    );
  });

  it('rejects an empty --redis-url value rather than silently falling back to the env', () => {
    // Falling back would upload to whatever REDIS_URL happens to hold -- on this repo's own test
    // container, that reports a successful upload the harness then cannot read back.
    expect(() => parsePromoteArgs(['--entry', 'go', '--redis-url', ''])).toThrow(
      /--redis-url requires a url/,
    );
  });
});

describe('resolveHomeDir', () => {
  it('resolves a relative --home to an absolute path', () => {
    expect(resolveHomeDir({ home: 'sandbox' }, '/fallback')).toBe(join(process.cwd(), 'sandbox'));
  });

  it('prefers --home over the process home, so the flag can redirect user scope', () => {
    expect(resolveHomeDir({ home: '/tmp/sh-demo' }, '/Users/someone')).toBe('/tmp/sh-demo');
  });

  it('falls back to the process home when --home is absent, keeping HOME= working', () => {
    // The shell demo (deploy/knative/demo-promoted-workflow.sh) still uses `HOME=$SANDBOX`, which
    // is fine outside Claude Code; the flag must not break it.
    expect(resolveHomeDir({}, '/Users/someone')).toBe('/Users/someone');
  });
});

describe('resolveProjectDir', () => {
  it('resolves a relative --project to an absolute path against process cwd semantics', () => {
    // resolve() anchors relative paths at process.cwd(); pass a distinct fallback cwd to prove
    // the returned path is NOT that fallback -- it comes from resolving `args.project`.
    const resolved = resolveProjectDir({ project: 'some/relative/dir' }, '/fallback/cwd');
    expect(resolved).not.toBe('/fallback/cwd');
    expect(resolved.endsWith('/some/relative/dir')).toBe(true);
    expect(resolved.startsWith('/')).toBe(true);
  });

  it('resolves an absolute --project unchanged', () => {
    expect(resolveProjectDir({ project: '/abs/dir' }, '/fallback/cwd')).toBe('/abs/dir');
  });

  it('falls back to cwd when --project is not given -- this is the bug this fix closes', () => {
    // Before this fix, promote-cli.ts always used process.cwd(), which under
    // `cd harness && pnpm promote` is the harness package directory, not the caller's project.
    expect(resolveProjectDir({}, '/fallback/cwd')).toBe('/fallback/cwd');
  });

  it('redirects the memory lookup: projectMemoryDir differs for the resolved project vs. the harness subdirectory', () => {
    // This is the actual defect from C1: `cd harness && pnpm promote` (no --project) slugs to
    // ".../moca/harness", which Claude Code never created, so memory is always
    // empty. With --project pointed at the repo root, the slug matches the real project dir.
    const repoRoot = '/Users/p/Projects/aiplatform/moca';
    const harnessSubdir = join(repoRoot, 'harness');
    const withoutProjectFlag = resolveProjectDir({}, harnessSubdir);
    const withProjectFlag = resolveProjectDir({ project: repoRoot }, harnessSubdir);
    expect(projectMemoryDir(withoutProjectFlag, '/Users/p')).not.toBe(
      projectMemoryDir(withProjectFlag, '/Users/p'),
    );
    expect(projectMemoryDir(withProjectFlag, '/Users/p')).toBe(
      '/Users/p/.claude/projects/-Users-p-Projects-aiplatform-moca/memory',
    );
  });
});

describe('projectMemoryDir', () => {
  it('mirrors Claude Code path-slug layout', () => {
    expect(projectMemoryDir('/Users/p/Projects/x', '/Users/p')).toBe(
      '/Users/p/.claude/projects/-Users-p-Projects-x/memory',
    );
  });

  it('preserves hyphens in the final path segment', () => {
    // Slug collision is inherited from Claude Code; we match upstream behavior
    // so we find the directory it already created, even with hyphens present.
    expect(projectMemoryDir('/Users/p/my-project', '/Users/p')).toBe(
      '/Users/p/.claude/projects/-Users-p-my-project/memory',
    );
  });
});

describe('projectRoot', () => {
  it('bounds the walk at .git when one exists', () => {
    write('.git/config', 'dummy');
    write('CLAUDE.md', 'root');
    write('sub/CLAUDE.md', 'sub');
    const root_path = projectRoot(join(root, 'sub'));
    expect(root_path).toBe(root);
  });

  it('returns cwd when no .git is found', () => {
    write('CLAUDE.md', 'no git');
    const root_path = projectRoot(root);
    expect(root_path).toBe(root);
  });

  // In a linked worktree `.git` is a FILE holding a `gitdir:` pointer, not a directory. This repo
  // works out of worktrees constantly, so a directory-only boundary test would walk straight past
  // the root in the checkout where it matters most -- sweeping ancestor CLAUDE.md files into a
  // bundle bound for a shared store. Verified against 16 live worktrees, all `.git`-as-file.
  it('bounds the walk when .git is a file, as in a linked worktree', () => {
    write('.git', 'gitdir: /elsewhere/.git/worktrees/wt\n');
    write('CLAUDE.md', 'worktree root');
    write('sub/deep/CLAUDE.md', 'inner');
    expect(projectRoot(join(root, 'sub', 'deep'))).toBe(root);
  });

  it('terminates on the filesystem root, and on relative and nonexistent paths', () => {
    // A missing termination check here hangs the CLI rather than failing it.
    expect(projectRoot('/')).toBe('/');
    expect(projectRoot('relative/not/real')).toBe('relative/not/real');
    expect(projectRoot('/definitely/does/not/exist')).toBe('/definitely/does/not/exist');
  });
});

describe('collectContextFiles', () => {
  it('collects the CLAUDE.md chain from project root to cwd, outermost-first', () => {
    write('.git/config', 'dummy');
    write('CLAUDE.md', '# outer');
    write('sub/CLAUDE.md', '# inner');
    const files = collectContextFiles(join(root, 'sub'));
    expect(files.map((f) => f.content)).toEqual(['# outer', '# inner']);
  });

  it('does not collect files above the .git boundary', () => {
    // Create a repo with .git
    write('.git/config', 'dummy');
    write('CLAUDE.md', '# in-repo');
    const cwd = join(root, 'sub');
    write('sub/CLAUDE.md', '# inner');
    // Create a file above the repo that would be collected if .git did not bound it
    // mkdtempSync creates it atomically with 0700; a Math.random() name is predictable.
    const above = mkdtempSync(join(tmpdir(), 'promote-above-'));
    try {
      writeFileSync(join(above, 'CLAUDE.md'), '# above-root');
      // Even if our cwd is moved above root, projectRoot finds the .git and bounds there
      const files = collectContextFiles(cwd);
      const contents = files.map((f) => f.content);
      expect(contents).toEqual(['# in-repo', '# inner']);
      expect(contents).not.toContain('# above-root');
    } finally {
      rmSync(above, { recursive: true, force: true });
    }
  });

  it('accepts AGENTS.md as an alternative and returns [] when there is none', () => {
    write('.git/config', 'dummy');
    write('AGENTS.md', '# agents');
    expect(collectContextFiles(root)[0]!.content).toBe('# agents');
    const empty = mkdtempSync(join(tmpdir(), 'promote-empty-'));
    try {
      expect(collectContextFiles(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('promoteInputs', () => {
  it('wires user, project, plugin, memory and prompt roots from the standard layout', () => {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(cwd, { recursive: true });
    const input = promoteInputs({
      cwd,
      home,
      args: parsePromoteArgs(['--entry', 'go', '--deny', 'private-thing']),
      inventory: ['gh'],
      versions: { pi: '1', harness: '1' },
    });
    expect(input.roots.userDir).toBe(join(home, '.claude'));
    expect(input.roots.projectDir).toBe(join(cwd, '.claude'));
    expect(input.roots.pluginDirs).toEqual([join(home, '.claude', 'plugins')]);
    expect(input.promptsDir).toBe(join(home, '.claude', 'commands'));
    expect(input.memoryDir).toBe(projectMemoryDir(cwd, home));
    expect(input.userDenyList).toEqual(['private-thing']);
    expect(input.entry).toBe('go');
    expect(input.inventory).toEqual(['gh']);
  });
});

describe('LOCKFILE_OUT', () => {
  it('is committed inside the project .claude directory', () => {
    expect(LOCKFILE_OUT).toBe('.claude/promoted.lock.json');
  });
});

describe('readInventory', () => {
  const IMAGE = 'ghcr.io/rossoctl/moca-sandbox:latest';
  const FILE = 'ghcr.io_rossoctl_moca-sandbox_latest.json';

  it('derives the filename readInventory/promote-cli agree on', () => {
    // Off by one character here and preflight degrades to inventory_unavailable forever.
    expect(inventoryFileName(IMAGE)).toBe(FILE);
  });

  // The regression that matters: the inventory is a HARNESS-SHIPPED asset. Resolving it against
  // the invocation cwd made it unreachable for every real caller, because `sh promote` runs from
  // the user's own project. Measured before the fix: 29 findings from the repo root, 0 one
  // directory deeper -- a check that silently stopped checking.
  it('finds the shipped inventory relative to the module, not the cwd', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    write(join('pkg', INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['tar'] }));
    // cwd is somewhere entirely unrelated, as it is in real use.
    const unrelated = mkdtempSync(join(tmpdir(), 'user-project-'));
    try {
      expect(readInventory(IMAGE, unrelated, moduleDir)).toEqual(['tar']);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it('still honours a cwd-local inventory as a fallback override', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'no-inventory-'));
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['flock'] }));
    try {
      expect(readInventory(IMAGE, root, moduleDir)).toEqual(['flock']);
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no inventory exists anywhere', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'bare-'));
    try {
      expect(readInventory(IMAGE, root, moduleDir)).toBeUndefined();
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('prefers the module-relative inventory over a cwd-local one', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    write(
      join('pkg', INVENTORY_SUBDIR, FILE),
      JSON.stringify({ image: IMAGE, binaries: ['shipped'] }),
    );
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['local'] }));
    expect(readInventory(IMAGE, root, moduleDir)).toEqual(['shipped']);
  });

  // The Important finding from Task 14's review: precedence was silent, so a deliberate
  // cwd-local override was shadowed by the shipped copy with no way to tell which won.
  it('reports which inventory path won, so silent shadowing is visible', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    const shipped = join(root, 'pkg', INVENTORY_SUBDIR, FILE);
    write(join('pkg', INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['a'] }));
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['b'] }));
    expect(resolveInventoryPath(IMAGE, root, moduleDir)).toBe(shipped);
  });

  it('resolveInventoryPath returns undefined when nothing exists', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'bare2-'));
    try {
      expect(resolveInventoryPath(IMAGE, root, moduleDir)).toBeUndefined();
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('candidate list ends at the cwd fallback and terminates', () => {
    const c = inventoryCandidates(IMAGE, '/tmp/cwd', '/a/b/c');
    expect(c[c.length - 1]).toBe(join('/tmp/cwd', INVENTORY_SUBDIR, FILE));
    expect(c.length).toBeLessThan(20);
    expect(c[0]).toBe(join('/a/b/c', INVENTORY_SUBDIR, FILE));
  });
});
