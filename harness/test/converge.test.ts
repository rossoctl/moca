import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  leafWorkspaceRef,
  buildConvergeScript,
  buildCleanupScript,
  convergeWorkspace,
  buildDiffCaptureScript,
  captureWorkspaceDiff,
} from '../src/converge.js';
import { buildLeafBindScript } from '../src/config-overlay.js';

describe('leafWorkspaceRef', () => {
  it('is /workspace/leaves/<sessionId>', () => {
    expect(leafWorkspaceRef('run-a-item-1')).toBe('/workspace/leaves/run-a-item-1');
  });
});

describe('buildConvergeScript', () => {
  const s = buildConvergeScript('https://git.example/r.git', 'abc123', 'leaf-1');
  it("fetches the per-leaf repoUrl+ref explicitly (never a fixed 'origin')", () => {
    // #67: fetch must target the URL from this leaf's envelope, so one pooled
    // sandbox can serve many repos. It must NOT fetch a fixed `origin`.
    expect(s).toContain("fetch --quiet 'https://git.example/r.git' 'abc123'");
    expect(s).not.toContain('fetch --quiet origin');
    // No `git clone` — init+fetch replaces it (clone binds origin to the first URL).
    expect(s).not.toContain('git clone');
  });
  it('does init+fetch inside the flocked subshell (no clone race)', () => {
    // #67 defect 2: the whole init+fetch must run under the flock, in order:
    // flock → init → fetch → close the lock fd.
    expect(s).toMatch(/flock 9[\s\S]*git init[\s\S]*fetch[\s\S]*9>"\$LOCK"/);
  });
  it('self-heals a missing or corrupt repo (init under lock, retry on fetch failure)', () => {
    // Missing/non-git /workspace/repo → rm -rf + git init (closes #59).
    expect(s).toContain('[ -d "$REPO/.git" ] || { rm -rf "$REPO"; git init');
    // A failed fetch (e.g. corrupt .git) re-inits and fetches once more.
    expect(s).toMatch(/fetch --quiet '[^']*' '[^']*' \|\| \{ rm -rf "\$REPO"; git init/);
  });
  it('adds a per-leaf worktree at the fetched commit and prints the path', () => {
    expect(s).toContain('worktree add');
    expect(s).toContain('/workspace/leaves/leaf-1');
    expect(s).toContain('printf');
  });
  it('single-quote-escapes inputs to resist injection', () => {
    const evil = buildConvergeScript("https://x/r.git'; rm -rf /; '", 'main', 'leaf-1');
    expect(evil).toContain(`'https://x/r.git'\\''; rm -rf /; '\\'''`);
  });
  it('appends `.sh-config` to the repo info/exclude so the promoted-config overlay symlink is ignored by `git add -A`', () => {
    // `leafConfigDir(sid)` is `/workspace/leaves/<sid>/.sh-config` — a child of the leaf worktree.
    // Without this ignore, `git add -A` in buildDiffCaptureScript would stage the symlink into
    // every captured solve patch. Idempotent: a repeat run must not re-append the line.
    expect(s).toContain('.git/info/exclude');
    expect(s).toContain('.sh-config');
    // `grep -qxF .sh-config "$REPO/.git/info/exclude"` guards the append on an exact full-line
    // match: a partial `grep .sh-config` would also match a user line like `# .sh-config` and
    // skip the append the overlay actually needs.
    expect(s).toContain('grep -qxF .sh-config');
  });
  it('writes the info/exclude entry inside the flock, before any worktree add', () => {
    // The flock serializes writers of the shared repo at /workspace/repo. The info/exclude line
    // belongs to that same shared repo, so a concurrent two-leaf converge mustn't append the
    // line twice. Pin the ordering: fetch → info/exclude write → close flock → worktree add.
    expect(s).toMatch(/fetch[\s\S]*info\/exclude[\s\S]*9>"\$LOCK"[\s\S]*worktree add/);
  });
});

describe('convergeWorkspace', () => {
  it('returns trimmed stdout as the workspace ref on success', async () => {
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('/workspace/leaves/leaf-1\n'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    expect(await convergeWorkspace(transport, 'u', 'r', 'leaf-1')).toBe('/workspace/leaves/leaf-1');
  });
  it('throws on non-zero exit', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 1, truncated: false }),
      close: async () => {},
    };
    await expect(convergeWorkspace(transport, 'u', 'r', 'leaf-1')).rejects.toThrow(
      /converge failed/,
    );
  });
  it('reports a capped converge as truncation, not a failed converge', async () => {
    // A converge whose fetch/worktree output overruns the sandbox output cap currently
    // surfaces as "converge failed (exit null)", which reads as a broken git command
    // rather than output too large for the seam.
    const transport = {
      exec: async () => ({ stdout: Buffer.from('partial'), exitCode: null, truncated: true }),
      close: async () => {},
    };
    await expect(convergeWorkspace(transport, 'u', 'r', 'leaf-1')).rejects.toThrow(/output cap/);
  });
});

describe('buildCleanupScript', () => {
  it('removes the leaf worktree and prunes', () => {
    const c = buildCleanupScript('leaf-1');
    expect(c).toContain('worktree remove');
    expect(c).toContain('/workspace/leaves/leaf-1');
    expect(c).toContain('worktree prune');
  });
});

describe('buildDiffCaptureScript', () => {
  it('stages all edits then emits the cached diff, scoped to the leaf worktree', () => {
    const s = buildDiffCaptureScript('run-1');
    expect(s).toContain('/workspace/leaves/run-1');
    expect(s).toContain('git -C "$LEAF" add -A');
    expect(s).toContain('git -C "$LEAF" diff --cached');
  });
});

describe('captureWorkspaceDiff', () => {
  it('returns stdout as the patch on exit 0', async () => {
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('diff --git a/x b/x\n'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    expect(await captureWorkspaceDiff(transport, 'run-1')).toBe('diff --git a/x b/x\n');
  });
  it('throws on non-zero exit', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 3, truncated: false }),
      close: async () => {},
    };
    await expect(captureWorkspaceDiff(transport, 'run-1')).rejects.toThrow(/exit 3/);
  });
  it('returns an empty string when the worktree has no changes (exit 0, empty stdout)', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
      close: async () => {},
    };
    expect(await captureWorkspaceDiff(transport, 'run-1')).toBe('');
  });
  it('restores a trailing newline the transport stripped (patch must not end mid-line)', async () => {
    // Some exec transports drop the trailing newline; a diff that ends mid-line is rejected by
    // `git apply` / GNU patch, so captureWorkspaceDiff must normalize it back.
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    const patch = await captureWorkspaceDiff(transport, 'run-1');
    expect(patch.endsWith('\n')).toBe(true);
    expect(patch).toBe('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n');
  });
  it('does not add a second newline when the patch already ends with one', async () => {
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('diff --git a/x b/x\n'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    expect(await captureWorkspaceDiff(transport, 'run-1')).toBe('diff --git a/x b/x\n');
  });
  it('reports a capped diff as truncation, not a failed capture', async () => {
    // A >8 MiB diff currently surfaces as "diff capture failed (exit null)", which reads
    // as a broken git command rather than a diff too large for the seam.
    const transport = {
      exec: async () => ({ stdout: Buffer.from('partial'), exitCode: null, truncated: true }),
      close: async () => {},
    };
    await expect(captureWorkspaceDiff(transport, 'run-1')).rejects.toThrow(/output cap/);
  });
});

// End-to-end over a real local file:// repo: proves the overlay symlink inside the leaf
// worktree is actually ignored by the diff capture, not just that the exclude line is in the
// script. Mirrors config-overlay.test.ts's "cleanup scripts, executed" harness: tmp root stands
// in for /workspace, flock is stubbed (macOS has none; the string tests above pin ordering),
// GIT_CONFIG_{GLOBAL,SYSTEM}=/dev/null isolates from the developer's own git config.
describe('converge + overlay + diff, executed end-to-end over a local repo', () => {
  const DIGEST = 'sha256:' + 'a'.repeat(64);
  const gitEnv = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let root: string;
  let bin: string;
  let seedRepo: string;
  const sh = (script: string) =>
    execFileSync('bash', ['-c', script.replaceAll('/workspace', `${root}/workspace`)], {
      env: { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}` },
    }).toString();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...gitEnv } }).toString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'converge-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    seedRepo = join(root, 'seed.git-src');
    execFileSync('git', ['init', '-q', '-b', 'main', seedRepo], {
      env: { ...process.env, ...gitEnv },
    });
    writeFileSync(join(seedRepo, 'src.txt'), 'original\n');
    git(seedRepo, 'add', '.');
    git(seedRepo, 'commit', '-q', '-m', 'seed');
    // Shared bundle cache so the bind's symlink has a target.
    const cache = `${root}/workspace/.sh-config/sha256-${'a'.repeat(64)}`;
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'CLAUDE.md'), 'promoted\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes `.sh-config` to info/exclude so the overlay symlink inside the worktree isn't staged into the captured patch", () => {
    const sid = 'leaf-1';
    sh(buildConvergeScript(`file://${seedRepo}`, 'main', sid));
    // The bind places a `.sh-config` symlink inside the leaf worktree, exactly as a real solve
    // leaf with configRef would. mkdir -p on the parent is a no-op because the worktree exists.
    sh(buildLeafBindScript(DIGEST, sid));
    const leaf = `${root}/workspace/leaves/${sid}`;
    // Explicit check per the review ask: the leaf really is a git worktree (not just a dir with
    // a symlink in it, which is what the pre-fix bug would have left).
    expect(git(leaf, 'rev-parse', '--is-inside-work-tree').trim()).toBe('true');
    writeFileSync(join(leaf, 'src.txt'), 'patched\n');
    const patch = sh(buildDiffCaptureScript(sid));
    expect(patch).toContain('src.txt');
    expect(patch).toContain('+patched');
    expect(patch).not.toContain('.sh-config');
  });
});
