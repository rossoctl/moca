import { describe, it, expect } from 'vitest';
import {
  envDirFromKey,
  buildSwebenchSetupScript,
  buildSwebenchDiffScript,
  buildSwebenchCleanupScript,
  swebenchCheckoutDir,
  swebenchVenvDir,
  buildSwebenchSolvePrompt,
  setupSwebenchWorkspace,
  captureSwebenchDiff,
} from '../src/swebench-setup.js';

describe('swebench-setup script builders', () => {
  const a = {
    repoUrl: '/repos/django/django.git',
    baseCommit: 'abc1234',
    envKey: 'sweb.env.py.x86_64.deadbeef:latest',
    sessionId: 'run-1',
  };
  it('derives env_dir by stripping a trailing :latest', () => {
    expect(envDirFromKey('sweb.env.py.x86_64.deadbeef:latest')).toBe('sweb.env.py.x86_64.deadbeef');
    expect(envDirFromKey('sweb.env.py.x86_64.deadbeef')).toBe('sweb.env.py.x86_64.deadbeef');
  });
  it('clones with --no-hardlinks, checks out base_commit, builds a system-site venv, editable-installs with build-iso fallback under HOME=/workspace', () => {
    const s = buildSwebenchSetupScript(a);
    expect(s).toContain("git clone --no-hardlinks '/repos/django/django.git'");
    expect(s).toContain("checkout -q 'abc1234'");
    expect(s).toContain(
      "/opt/miniconda3/envs/sweb.env.py.x86_64.deadbeef/bin/python' -m venv --system-site-packages",
    );
    expect(s).toContain('HOME=/workspace');
    expect(s).toContain('--no-build-isolation');
    expect(s).toContain('--no-cache-dir');
    // fallback: a second pip install WITHOUT --no-build-isolation
    expect(s.match(/pip" install -e/g)?.length).toBeGreaterThanOrEqual(2);
    // prints the checkout dir on stdout so the caller can set podCwd
    expect(s).toContain(swebenchCheckoutDir('run-1'));
  });
  it('diff script stages all and prints the cached diff from the checkout dir', () => {
    const s = buildSwebenchDiffScript('run-1');
    expect(s).toContain(`git -C '${swebenchCheckoutDir('run-1')}' add -A`);
    expect(s).toContain('diff --cached');
  });
  it('cleanup script removes the checkout, the venv, and the leaf dir created by the overlay bind', () => {
    // SWE-bench's real work lives in /workspace/co-<sid> and /workspace/venv-<sid>, but a solve
    // leaf with configRef materialises leafConfigDir(sid) = /workspace/leaves/<sid>/.sh-config,
    // whose parent is created by buildLeafBindScript's `mkdir -p`. attach.detach() removes the
    // symlink; without this cleanup the empty /workspace/leaves/<sid> would leak on the pooled
    // sandbox after a swebench solve.
    const s = buildSwebenchCleanupScript('run-1');
    expect(s).toContain(swebenchCheckoutDir('run-1'));
    expect(s).toContain(swebenchVenvDir('run-1'));
    expect(s).toContain('/workspace/leaves/run-1');
    // One `rm -rf` call — not three serial ones — keeps teardown fast and all-or-nothing per the
    // `set -u` surrounding (set -eu would bail; swebench cleanup is best-effort).
    expect(s.match(/rm -rf/g)?.length).toBe(1);
  });
  it('solve prompt names the checkout root and the venv python', () => {
    const p = buildSwebenchSolvePrompt(
      'fix the bug',
      '/workspace/co-run-1',
      '/workspace/venv-run-1/bin/python',
    );
    expect(p).toContain('/workspace/co-run-1');
    expect(p).toContain('/workspace/venv-run-1/bin/python');
    expect(p).toContain('fix the bug');
  });
});

const swebenchArgs = {
  repoUrl: '/repos/django/django.git',
  baseCommit: 'abc1234',
  envKey: 'sweb.env.py.x86_64.deadbeef:latest',
  sessionId: 'run-1',
};

describe('setupSwebenchWorkspace', () => {
  it('returns trimmed stdout as the checkout dir on success', async () => {
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('/workspace/co-run-1\n'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    expect(await setupSwebenchWorkspace(transport, swebenchArgs)).toBe('/workspace/co-run-1');
  });
  it('throws on non-zero exit', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 1, truncated: false }),
      close: async () => {},
    };
    await expect(setupSwebenchWorkspace(transport, swebenchArgs)).rejects.toThrow(
      /swebench setup failed/,
    );
  });
  it('reports a capped setup as truncation, not a failed setup', async () => {
    // A setup whose clone/venv/install output overruns the sandbox output cap currently
    // surfaces as "swebench setup failed (exit null)", which reads as a broken command
    // rather than output too large for the seam.
    const transport = {
      exec: async () => ({ stdout: Buffer.from('partial'), exitCode: null, truncated: true }),
      close: async () => {},
    };
    await expect(setupSwebenchWorkspace(transport, swebenchArgs)).rejects.toThrow(/output cap/);
  });
});

describe('captureSwebenchDiff', () => {
  it('returns stdout as the patch on exit 0', async () => {
    const transport = {
      exec: async () => ({
        stdout: Buffer.from('diff --git a/x b/x\n'),
        exitCode: 0,
        truncated: false,
      }),
      close: async () => {},
    };
    expect(await captureSwebenchDiff(transport, 'run-1')).toBe('diff --git a/x b/x\n');
  });
  it('throws on non-zero exit', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 3, truncated: false }),
      close: async () => {},
    };
    await expect(captureSwebenchDiff(transport, 'run-1')).rejects.toThrow(/exit 3/);
  });
  it('reports a capped diff as truncation, not a failed capture', async () => {
    // A >8 MiB diff currently surfaces as "swebench diff capture failed (exit null)",
    // which reads as a broken git command rather than a diff too large for the seam.
    const transport = {
      exec: async () => ({ stdout: Buffer.from('partial'), exitCode: null, truncated: true }),
      close: async () => {},
    };
    await expect(captureSwebenchDiff(transport, 'run-1')).rejects.toThrow(/output cap/);
  });
});
