import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildPatchCaptureScript,
  captureTurnPatch,
  DEFAULT_PATCH_MAX_BYTES,
  patchMaxBytes,
  SandboxSeedError,
  SEED_BASELINE,
  SEED_MARKER,
  seedWorkspace,
} from '../src/run-turn.js';
import { buildLeafBindScript, configCacheDir } from '../src/config-overlay.js';

/**
 * The template seed (session-templates spec §5), run through a fake transport that executes the
 * command under a real bash with /workspace mapped to a scratch directory, so the quoting and the
 * marker are tested as the guest would run them.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bashTransport() {
  const ws = mkdtempSync(join(tmpdir(), 'seed-ws-'));
  dirs.push(ws);
  const commands: string[] = [];
  return {
    ws,
    commands,
    exec: async (command: string) => {
      commands.push(command);
      try {
        execFileSync('bash', ['-c', command.replaceAll('/workspace', ws)], { stdio: 'pipe' });
        return { exitCode: 0 };
      } catch (e) {
        return { exitCode: (e as { status: number }).status };
      }
    },
  };
}

/** Runs the command under bash with no path mapping: for tests that pass a real workspace dir. */
const realBash = {
  exec: async (command: string) => {
    try {
      execFileSync('bash', ['-c', command], { stdio: 'pipe' });
      return { exitCode: 0 };
    } catch (e) {
      return { exitCode: (e as { status: number }).status };
    }
  },
};
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'seed-sub-'));
  dirs.push(d);
  return d;
};

describe('seedWorkspace', () => {
  it('runs the seed, then leaves the marker', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', 'echo seeded > /workspace/file');
    expect(readFileSync(join(t.ws, 'file'), 'utf8')).toBe('seeded\n');
    expect(existsSync(join(t.ws, '.moca-seeded'))).toBe(true);
    expect(SEED_MARKER).toBe('.moca-seeded');
  });

  it('the marker is per workspace: two sessions on one container worker each get their seed', async () => {
    // A container worker gives each session /workspace/<sid> (workspace-subdir): one marker per dir.
    const root = scratch();
    for (const sid of ['s-1', 's-2']) {
      execFileSync('mkdir', ['-p', join(root, sid)]);
      await seedWorkspace(realBash, 'py312', 'echo seeded > file', join(root, sid));
    }
    expect(readFileSync(join(root, 's-1', 'file'), 'utf8')).toBe('seeded\n');
    expect(readFileSync(join(root, 's-2', 'file'), 'utf8')).toBe('seeded\n');
    expect(existsSync(join(root, '.moca-seeded'))).toBe(false);
  });

  it("keeps the seed's output out of the turn, in the workspace's seed log", async () => {
    const ws = scratch();
    await seedWorkspace(realBash, 'py312', 'echo loud; echo louder >&2', ws);
    expect(readFileSync(join(ws, '.moca-seed.log'), 'utf8')).toBe('loud\nlouder\n');
  });

  it("keeps the seed's files out of a seeded repository's patch (info/exclude), once", async () => {
    const ws = scratch();
    execFileSync('git', ['init', '-q', ws]);
    await seedWorkspace(realBash, 'py312', 'echo code > app.py', ws);
    // A later turn (a new marker after a reset) appends nothing twice.
    execFileSync('rm', ['-f', join(ws, '.moca-seeded')]);
    await seedWorkspace(realBash, 'py312', 'echo code > app.py', ws);
    const status = execFileSync(
      'git',
      ['-C', ws, 'status', '--porcelain', '--untracked-files=all'],
      {
        encoding: 'utf8',
      },
    );
    expect(status.split('\n').filter(Boolean)).toEqual(['?? app.py']);
    const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8').split('\n');
    for (const f of ['/.moca-seeded', '/.moca-seed.log', '/.moca-seed.lock', '/.moca-baseline'])
      expect(exclude.filter((l) => l === f)).toHaveLength(1);
  });

  it('seeds a workspace that is not a repository as before (no git step fails it)', async () => {
    const ws = scratch();
    await seedWorkspace(realBash, 'py312', 'echo code > app.py', ws);
    expect(existsSync(join(ws, '.moca-seeded'))).toBe(true);
    expect(existsSync(join(ws, '.git'))).toBe(false);
  });

  it('concurrent first turns run the seed once (flock, where the image has it)', async () => {
    const ws = scratch();
    const hasFlock = (() => {
      try {
        execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();
    const seed = 'echo run >> runs; sleep 1';
    const async = (cmd: string) =>
      new Promise<{ exitCode: number | null }>((res) => {
        import('node:child_process').then(({ execFile }) =>
          execFile('bash', ['-c', cmd], (err) => res({ exitCode: err ? 1 : 0 })),
        );
      });
    await Promise.all([1, 2].map(() => seedWorkspace({ exec: async }, 'py312', seed, ws)));
    const runs = readFileSync(join(ws, 'runs'), 'utf8').trim().split('\n').length;
    // macOS has no flock(1): the guard still runs, unlocked, so only Linux pins the single run.
    if (hasFlock) expect(runs).toBe(1);
    else expect(runs).toBeGreaterThanOrEqual(1);
  });

  it("a transport failure or the worker's timeout is still a SandboxSeedError naming the template", async () => {
    const err = await seedWorkspace(
      { exec: async () => Promise.reject(new Error('timeout:600')) },
      'django-django-11133',
      'sleep 9999',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxSeedError);
    expect((err as Error).message).toContain("'django-django-11133'");
    expect((err as Error).message).toContain('timeout:600');
  });

  it('runs once: a second turn finds the marker and runs nothing', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', 'echo x >> /workspace/count');
    await seedWorkspace(t, 'py312', 'echo x >> /workspace/count');
    expect(readFileSync(join(t.ws, 'count'), 'utf8')).toBe('x\n');
  });

  it('quotes the seed for bash: quotes and $ arrive as written', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', `printf '%s\\n' "it's" '$HOME' > /workspace/q`);
    expect(readFileSync(join(t.ws, 'q'), 'utf8')).toBe("it's\n$HOME\n");
  });

  it('a failed seed throws SandboxSeedError naming the template, and leaves no marker', async () => {
    const t = bashTransport();
    const err = await seedWorkspace(t, 'django-django-11133', 'exit 3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxSeedError);
    expect((err as Error).message).toContain("'django-django-11133'");
    expect((err as Error).message).toContain('exit 3');
    expect(existsSync(join(t.ws, '.moca-seeded'))).toBe(false);
  });

  it('a truncated or signalled seed (null exit) also fails', async () => {
    const err = await seedWorkspace(
      { exec: async () => ({ exitCode: null }) },
      'py312',
      'true',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxSeedError);
  });
});

describe('acquireTurnSandbox seeds a templated session (session-templates spec §5)', () => {
  // A records-path selection with one templated worker, through acquireTurnSandbox's real
  // selectPoolSandbox call, with every store faked.
  async function acquire(template: { id: string; seed?: string }, exitCode = 0) {
    const { acquireTurnSandbox } = await import('../src/run-turn.js');
    const commands: string[] = [];
    const released: string[] = [];
    const lease = {
      load: async () => 0,
      acquire: async () => true,
      heartbeat: async () => {},
      release: async (p: string) => void released.push(p),
    };
    const rec = {
      sandboxId: 'py-1',
      labels: { 'moca.dev/template': template.id },
      capabilities: [],
      capacityMax: 4,
      transport: 'grpc' as const,
    };
    const transport = {
      exec: async (c: string) => {
        commands.push(c);
        return { stdout: Buffer.alloc(0), exitCode, truncated: false };
      },
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    const env = {
      KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
      SH_SANDBOX_DISCOVERY: 'records',
      SH_REMOTE_SANDBOX: '1',
    } as NodeJS.ProcessEnv;
    const deps = {
      records: { put: async () => {}, remove: async () => {}, list: async () => [rec] },
      lease,
      makeExecClient: () => ({}) as never,
      makeTransport: () => transport,
      affinity: {
        get: async () => null,
        claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
        replace: async () => {},
        detachedSince: async (_id: string, now: number) => now,
      },
    };
    const got = acquireTurnSandbox(undefined, env, '/h', 's-1', deps, undefined, template);
    return { got, commands, released };
  }

  it('runs the seed in the selected sandbox before the turn', async () => {
    const r = await acquire({ id: 'py312', seed: 'echo hi' });
    const got = await r.got;
    expect(got.placement?.sandboxId).toBe('py-1');
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toContain('.moca-seeded');
    expect(r.commands[0]).toContain('echo hi');
    // It runs in the session's workspace (the record's podCwd), not a fixed path.
    expect(r.commands[0].startsWith("cd '/workspace' && ")).toBe(true);
  });

  it('a template without a seed runs nothing', async () => {
    const r = await acquire({ id: 'py312' });
    await r.got;
    expect(r.commands).toHaveLength(0);
  });

  it('renews the lease while a long seed runs', async () => {
    const { acquireTurnSandbox } = await import('../src/run-turn.js');
    let beats = 0;
    const lease = {
      load: async () => 0,
      acquire: async () => true,
      heartbeat: async () => void beats++,
      release: async () => {},
    };
    const rec = {
      sandboxId: 'py-1',
      labels: { 'moca.dev/template': 'py312' },
      capabilities: [],
      capacityMax: 4,
      transport: 'grpc' as const,
    };
    const transport = {
      exec: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { stdout: Buffer.alloc(0), exitCode: 0, truncated: false };
      },
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    await acquireTurnSandbox(
      undefined,
      {
        KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
        SH_SANDBOX_DISCOVERY: 'records',
        SH_REMOTE_SANDBOX: '1',
        // The floor is 1 s, so a 3 s TTL renews every 1 s; the heartbeat knob caps it lower.
        KAGENTI_SANDBOX_LEASE_TTL_MS: '3000',
        KAGENTI_SANDBOX_HEARTBEAT_MS: '20',
      } as NodeJS.ProcessEnv,
      '/h',
      's-1',
      {
        records: { put: async () => {}, remove: async () => {}, list: async () => [rec] },
        lease,
        makeExecClient: () => ({}) as never,
        makeTransport: () => transport,
        affinity: {
          get: async () => null,
          claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
          replace: async () => {},
          detachedSince: async (_id: string, now: number) => now,
        },
      },
      undefined,
      { id: 'py312', seed: 'sleep 1' },
    );
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it('a failed seed fails the turn and returns the lease', async () => {
    const r = await acquire({ id: 'py312', seed: 'false' }, 1);
    await expect(r.got).rejects.toBeInstanceOf(SandboxSeedError);
    expect(r.released).toEqual(['py-1']);
  });
});

describe('the seed baseline and the patch capture (session-templates spec §5.1)', () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      cwd,
      stdio: 'pipe',
    });

  /** A scratch repository at one commit, as an image builder's source checkout is. */
  function repo() {
    const src = scratch();
    git(src, 'init', '-q');
    execFileSync('bash', ['-c', 'printf "a\\nb\\n" > f.txt; printf "x" > keep.txt'], { cwd: src });
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'base');
    return src;
  }

  /** Runs under real bash, returning stdout as the transport does. */
  const bashOut = {
    exec: async (command: string) => {
      try {
        const stdout = execFileSync('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        return { stdout, exitCode: 0, truncated: false };
      } catch (e) {
        const x = e as { status: number; stdout: Buffer };
        return { stdout: x.stdout ?? Buffer.alloc(0), exitCode: x.status, truncated: false };
      }
    },
  };

  it('the seed records the baseline commit beside the marker', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws }).toString().trim();
    expect(readFileSync(join(ws, SEED_BASELINE), 'utf8').trim()).toBe(head);
    // The baseline is one of the seed's own files: a stock `git status` does not show it.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ws,
      encoding: 'utf8',
    });
    expect(status).toBe('');
  });

  it('a seed that leaves no repository still seeds, with no baseline', async () => {
    const ws = scratch();
    await seedWorkspace(realBash, 'py312', 'echo hi > f', ws);
    expect(existsSync(join(ws, '.moca-seeded'))).toBe(true);
    expect(existsSync(join(ws, SEED_BASELINE))).toBe(false);
  });

  it("captures the end state against the baseline: edits, new files, deletions; Moca's files left out", async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    execFileSync('bash', ['-c', 'printf "a\\nB\\n" > f.txt; rm keep.txt; echo new > n.txt'], {
      cwd: ws,
    });
    // The agent committing its work must not hide it: the base is the seed's commit, not HEAD.
    git(ws, 'add', 'n.txt');
    git(ws, 'commit', '-qm', 'agent');
    const w = await captureTurnPatch(bashOut, ws, 1 << 20);
    expect(w.error).toBeUndefined();
    expect(w.baseline).toBe(readFileSync(join(ws, SEED_BASELINE), 'utf8').trim());
    expect(w.patch).toContain('+B');
    expect(w.patch).toContain('deleted file mode');
    expect(w.patch).toContain('n.txt');
    expect(w.patch).not.toContain('.moca-');
    expect(w.patchBytes).toBe(Buffer.byteLength(w.patch!, 'utf8'));
    expect(w.patchSha256).toBe(
      'sha256:' + createHash('sha256').update(w.patch!, 'utf8').digest('hex'),
    );
    // The workspace's own index is untouched (a throwaway index): `git status` still shows the edits.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws }).toString()).toContain(
      'f.txt',
    );
    // The patch applies to the baseline as a stock agent's does.
    const check = scratch();
    execFileSync('bash', ['-c', `cp -a ${src}/. .`], { cwd: check });
    execFileSync('git', ['apply', '--check', '-'], { cwd: check, input: w.patch });
  });

  it('an unchanged workspace is an empty patch, not an error', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    const w = await captureTurnPatch(bashOut, ws, 1 << 20);
    expect(w).toMatchObject({ patch: '', patchBytes: 0 });
  });

  it('over the cap the patch is refused whole, never truncated', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    execFileSync('bash', ['-c', 'head -c 4000 /dev/zero | tr "\\0" a > big.txt'], { cwd: ws });
    const w = await captureTurnPatch(bashOut, ws, 1000);
    expect(w.patchRefused).toBe('too_large');
    expect(w.patch).toBeUndefined();
    expect(w.patchBytes).toBeGreaterThan(1000);
    expect(w.patchSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a binary change is carried whole, as base64 when it is not UTF-8', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    execFileSync('bash', ['-c', "printf '\\377\\376\\000' > bin.dat"], { cwd: ws });
    const w = await captureTurnPatch(bashOut, ws, 1 << 20);
    expect(w.patch ?? Buffer.from(w.patchBase64!, 'base64').toString('latin1')).toContain(
      'GIT binary patch',
    );
  });

  it('no repository, a failed exec or a truncated output is reported, never thrown', async () => {
    const ws = scratch();
    expect((await captureTurnPatch(bashOut, ws, 1 << 20)).error).toContain('no baseline commit');
    expect(
      (
        await captureTurnPatch(
          { exec: async () => Promise.reject(new Error('relay down')) },
          ws,
          10,
        )
      ).error,
    ).toContain('relay down');
    expect(
      await captureTurnPatch(
        { exec: async () => ({ stdout: Buffer.alloc(0), exitCode: null, truncated: true }) },
        ws,
        10,
      ),
    ).toEqual({ patchRefused: 'too_large' });
  });

  it('the cap is SH_TURN_PATCH_MAX_BYTES, defaulting to 4 MiB, never over the output cap', () => {
    expect(patchMaxBytes({})).toBe(DEFAULT_PATCH_MAX_BYTES);
    expect(patchMaxBytes({ SH_TURN_PATCH_MAX_BYTES: '1000' })).toBe(1000);
    expect(patchMaxBytes({ SH_TURN_PATCH_MAX_BYTES: 'x' })).toBe(DEFAULT_PATCH_MAX_BYTES);
    expect(patchMaxBytes({ SH_TURN_PATCH_MAX_BYTES: String(64 << 20) })).toBeLessThan(8 << 20);
  });

  it("leaves a promoted config's files out: its cache, its lock and the session's link", async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    // The layout a turn with a configRef holds while the capture runs (config-overlay.ts): the
    // shared cache with its lock and refs, and the session's link, all in the seed's checkout.
    const digest = `sha256:${'c'.repeat(64)}`;
    execFileSync(
      'bash',
      [
        '-c',
        [
          `mkdir -p "${configCacheDir(digest)}" /workspace/.sh-config/.refs/x`,
          `echo cfg > "${configCacheDir(digest)}/AGENTS.md"`,
          `: > /workspace/.sh-config/.refs/x/sess-1`,
          `: > /workspace/.sh-config.lock`,
          buildLeafBindScript(digest, 'sess-1'),
        ]
          .join('\n')
          .replaceAll('/workspace', ws),
      ],
      { stdio: 'pipe' },
    );
    execFileSync('bash', ['-c', 'echo new > n.txt; mkdir -p leaves/keep; echo k > leaves/keep/k'], {
      cwd: ws,
    });
    const w = await captureTurnPatch(bashOut, ws, 1 << 20);
    expect(w.error).toBeUndefined();
    expect(w.patch).toContain('b/n.txt');
    // The agent's own file under leaves/ is kept; only the session's link is Moca's.
    expect(w.patch).toContain('b/leaves/keep/k');
    expect(w.patch).not.toContain('.sh-config');
  });

  it('the patch ignores the workspace git config: it applies under color, noprefix, mnemonic', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    for (const [k, v] of [
      ['color.ui', 'always'],
      ['color.diff', 'always'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.external', 'false'],
    ])
      git(ws, 'config', k, v);
    execFileSync('bash', ['-c', 'printf "a\\nB\\n" > f.txt; git mv keep.txt kept.txt'], {
      cwd: ws,
    });
    const w = await captureTurnPatch(bashOut, ws, 1 << 20);
    expect(w.error).toBeUndefined();
    expect(w.patch).toMatch(/^diff --git a\/f\.txt b\/f\.txt$/m);
    expect(w.patch).not.toContain('\u001b[');
    // No rename detection: a moved file is a deletion and an addition.
    expect(w.patch).not.toContain('rename from');
    const check = scratch();
    execFileSync('bash', ['-c', `cp -a ${src}/. .`], { cwd: check });
    execFileSync('git', ['apply', '--check', '-'], { cwd: check, input: w.patch });
  });

  it('refuses a baseline that is not a full commit id: no option, no rev name', async () => {
    const src = repo();
    const ws = scratch();
    await seedWorkspace(realBash, 'example-repo', `cp -a ${src}/. .`, ws);
    const head = readFileSync(join(ws, SEED_BASELINE), 'utf8').trim();
    for (const bad of ['--output=x.out', 'HEAD~1', head.slice(0, 12), `${head}\n${head}`, 'ABC']) {
      execFileSync('bash', ['-c', `printf '%s' "$1" > ${SEED_BASELINE}`, '_', bad], { cwd: ws });
      expect((await captureTurnPatch(bashOut, ws, 1 << 20)).error).toBe(
        'the baseline is not a commit id',
      );
    }
    expect(existsSync(join(ws, 'x.out'))).toBe(false);
  });

  it("the capture script names the baseline file and excludes Moca's own files", () => {
    const c = buildPatchCaptureScript('/workspace');
    expect(c).toContain(SEED_BASELINE);
    expect(c).toContain("':(exclude).moca-*'");
    expect(c).toContain("':(exclude).sh-config*'");
    expect(c).toContain("':(exclude,glob)leaves/*/.sh-config'");
    expect(c).toContain('diff --cached --binary');
    expect(c).toContain('--src-prefix=a/ --dst-prefix=b/ "$BASE"');
    expect(c).toContain('GIT_INDEX_FILE');
  });
});

describe('the seed origin on the placement', () => {
  it('names the pinned build when the seed came from it', async () => {
    const { acquireTurnSandbox } = await import('../src/run-turn.js');
    const rec = {
      sandboxId: 'py-1',
      labels: { 'moca.dev/template': 'example-repo', 'moca.dev/build': 'sha256:' + 'b'.repeat(64) },
      capabilities: [],
      capacityMax: 4,
      transport: 'grpc' as const,
    };
    const transport = {
      exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    const deps = {
      records: { put: async () => {}, remove: async () => {}, list: async () => [rec] },
      lease: {
        load: async () => 0,
        acquire: async () => true,
        heartbeat: async () => {},
        release: async () => {},
      },
      makeExecClient: () => ({}) as never,
      makeTransport: () => transport,
      affinity: {
        get: async () => null,
        claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
        replace: async () => {},
        detachedSince: async (_id: string, now: number) => now,
      },
    };
    const env = {
      KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
      SH_SANDBOX_DISCOVERY: 'records',
      SH_REMOTE_SANDBOX: '1',
    } as NodeJS.ProcessEnv;
    const build = 'sha256:' + 'b'.repeat(64);
    const got = await acquireTurnSandbox(undefined, env, '/h', 's-1', deps, undefined, {
      id: 'example-repo',
      seed: 'true',
      seedSource: 'build',
      build,
    });
    expect(got.placement?.seed).toEqual({ source: 'build', buildId: build });
    const old = await acquireTurnSandbox(undefined, env, '/h', 's-2', deps, undefined, {
      id: 'example-repo',
      seed: 'true',
      build,
    });
    expect(old.placement?.seed).toEqual({ source: 'declared' });
    const none = await acquireTurnSandbox(undefined, env, '/h', 's-3', deps, undefined, {
      id: 'example-repo',
      build,
    });
    expect(none.placement?.seed).toBeUndefined();
  });
});

describe('withWorkspacePatch: which turns carry a patch', () => {
  const result = { sessionId: 's', response: '', stopReason: 'stop' };
  const commands: string[] = [];
  const transport = {
    exec: async (c: string) => {
      commands.push(c);
      return { stdout: Buffer.from('abc\ndiff\n'), exitCode: 0, truncated: false };
    },
  } as never;
  const sandbox = { transport, podCwd: '/workspace/s-1' };

  it('a leased turn on a templated session: captured in its workspace', async () => {
    commands.length = 0;
    const { withWorkspacePatch } = await import('../src/run-turn.js');
    const r = await withWorkspacePatch(result, { leased: true, sandbox }, 'example-repo', {});
    expect(r.workspace).toMatchObject({ baseline: 'abc', patch: 'diff\n', patchBytes: 5 });
    expect(commands[0].startsWith("cd '/workspace/s-1' ")).toBe(true);
  });

  it('no template, an injected sandbox, or none: unchanged, nothing run', async () => {
    commands.length = 0;
    const { withWorkspacePatch } = await import('../src/run-turn.js');
    expect(await withWorkspacePatch(result, { leased: true, sandbox }, undefined, {})).toBe(result);
    expect(await withWorkspacePatch(result, { leased: false, sandbox }, 'example-repo', {})).toBe(
      result,
    );
    expect(
      await withWorkspacePatch(result, { leased: true, sandbox: null }, 'example-repo', {}),
    ).toBe(result);
    expect(commands).toEqual([]);
  });
});
