import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxSeedError, SEED_MARKER, seedWorkspace } from '../src/run-turn.js';

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
