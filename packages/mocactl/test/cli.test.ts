import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { USAGE, main } from '../src/cli.js';
import type { Io } from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';
import { ApiError } from '../src/api/errors.js';
import { loadAuth, saveAuth } from '../src/config.js';
import { fakeControlPlane } from './helpers/fakes.js';
import { testRuntime } from './helpers/runtime.js';

const io = (): Io & { outs: string[]; errs: string[] } => {
  const o = {
    outs: [] as string[],
    errs: [] as string[],
    out: (s: string) => void o.outs.push(s),
    err: (s: string) => void o.errs.push(s),
  };
  return o;
};
// `vi.fn` infers its mock's `.mock.calls` element type from the wrapped function's own
// parameter list. `buildRuntime`/`startInteractive` fakes below take rest params (rather than
// matching the real multi-arg signatures) purely so `.mock.calls[n][i]` type-checks when tests
// index into a specific call argument; the real call sites still pass their normal arguments.
const fakeBuild = (..._args: unknown[]) =>
  ({ endpoints: {}, config: {}, auth: null }) as unknown as Runtime;

describe('main', () => {
  it('prints usage for --help', async () => {
    const o = io();
    expect(await main(['--help'], {}, o, { buildRuntime: fakeBuild })).toBe(0);
    expect(o.outs.join('')).toContain(USAGE);
  });

  it('prints the version for --version and -V, reading no config and no network', async () => {
    for (const flag of ['--version', '-V']) {
      const o = io();
      const build = vi.fn(fakeBuild);
      expect(await main([flag], {}, o, { buildRuntime: build })).toBe(0);
      // Under vitest (as under tsx) no build defined MOCACTL_VERSION.
      expect(o.outs.join('')).toBe('dev\n');
      expect(o.errs).toEqual([]);
      expect(build).not.toHaveBeenCalled();
    }
  });

  it('lists --version in the usage', () => {
    expect(USAGE).toContain('mocactl --version');
  });

  it('rejects an unknown command and an unknown flag', async () => {
    expect(await main(['frobnicate'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['--nope'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
  });

  it('requires a prompt for run and validates --option', async () => {
    expect(await main(['run'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    const o = io();
    expect(await main(['run', 'hi', '--option', 'oops'], {}, o, { buildRuntime: fakeBuild })).toBe(
      2,
    );
    expect(o.errs.join('\n')).toContain('--option expects key=value');
  });

  it('accepts run --new, and rejects it together with --session', async () => {
    const run = vi.fn(async (..._args: unknown[]) => 0);
    const headless = await import('../src/headless.js');
    const spy = vi.spyOn(headless, 'cmdRun').mockImplementation(run);
    onTestFinished(() => spy.mockRestore());
    expect(await main(['run', 'hi', '--new'], {}, io(), { buildRuntime: fakeBuild })).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({ prompt: 'hi', session: undefined });
    const o = io();
    expect(
      await main(['run', 'hi', '--new', '--session', 's1'], {}, o, { buildRuntime: fakeBuild }),
    ).toBe(2);
    expect(o.errs.join('\n')).toContain('--new and --session cannot be used together');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes flags to the runtime builder', async () => {
    const build = vi.fn(fakeBuild);
    await main(
      ['doctor', '--control-plane-url', 'http://cp', '--harness-url', 'http://h'],
      {},
      io(),
      { buildRuntime: build },
    );
    expect(build.mock.calls[0][0]).toEqual({
      controlPlaneUrl: 'http://cp',
      harnessUrl: 'http://h',
    });
  });

  it('hands the no-command case to startInteractive', async () => {
    const start = vi.fn((..._args: unknown[]) => Promise.resolve(0));
    expect(
      await main(['--setup'], {}, io(), { buildRuntime: fakeBuild, startInteractive: start }),
    ).toBe(0);
    expect(start.mock.calls[0][1]).toEqual({ setup: true, noAnimation: false });
  });

  it('refuses the interactive UI without a terminal, pointing at run', async () => {
    const start = vi.fn((..._args: unknown[]) => Promise.resolve(0));
    const o = io();
    expect(
      await main([], {}, o, {
        buildRuntime: fakeBuild,
        startInteractive: start,
        stdinIsTTY: false,
      }),
    ).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(o.errs.join('\n')).toContain('mocactl run');
  });

  // Each management command, spied on its headless function: [argv, function, the options it gets].
  it.each([
    [['sessions'], 'cmdSessions', { json: false }],
    [['sessions', '--json'], 'cmdSessions', { json: true }],
    [['sessions', 'delete', 's-1'], 'cmdSessionDelete', { id: 's-1', json: false }],
    [['credentials', '--json'], 'cmdCredentials', { json: true }],
    [['credentials', 'delete', 'gh'], 'cmdCredentialDelete', { name: 'gh', json: false }],
    [
      ['credentials', 'add', 'anthropic', '--kind', 'api-key', '--host', 'a.example,b.example'],
      'cmdCredentialAdd',
      {
        name: 'anthropic',
        kind: 'api-key',
        consumer: 'inference',
        hosts: ['a.example', 'b.example'],
        endpoint: undefined,
        stdinIsTTY: false,
      },
    ],
    [
      [
        'credentials',
        'add',
        'gh',
        '--consumer',
        'sandbox-egress',
        '--host',
        'github.com',
        '--host',
        'api.github.com',
      ],
      'cmdCredentialAdd',
      {
        name: 'gh',
        kind: 'bearer',
        consumer: 'sandbox-egress',
        hosts: ['github.com', 'api.github.com'],
        endpoint: undefined,
      },
    ],
  ] as Array<[string[], string, Record<string, unknown>]>)(
    'routes %j to %s',
    async (argv, fn, expected) => {
      const cmd = vi.fn(async (..._args: unknown[]) => 0);
      const headless = await import('../src/headless.js');
      const spy = vi.spyOn(headless, fn as 'cmdSessions').mockImplementation(cmd);
      onTestFinished(() => spy.mockRestore());
      const readStdin = async () => 'secret';
      expect(
        await main(argv, {}, io(), { buildRuntime: fakeBuild, readStdin, stdinIsTTY: false }),
      ).toBe(0);
      expect(cmd).toHaveBeenCalledTimes(1);
      expect(cmd.mock.calls[0][2]).toMatchObject(expected);
    },
  );

  it.each([
    [['sessions', 'delete'], 'usage'],
    [['sessions', 'rename', 's-1'], 'unknown sessions command "rename"'],
    [['sessions', 'delete', 's-1', 's-2'], 'usage'],
    [['credentials', 'add'], 'usage'],
    [['credentials', 'delete'], 'usage'],
    [['credentials', 'show', 'x'], 'unknown credentials command "show"'],
    [['run', 'hi', '--kind', 'bearer'], '--kind only applies to `mocactl credentials add`'],
    [['sessions', '--host', 'x'], '--host only applies to `mocactl credentials add`'],
  ])('rejects %j with exit 2', async (argv, message) => {
    const o = io();
    expect(await main(argv, {}, o, { buildRuntime: fakeBuild })).toBe(2);
    expect(o.errs.join('\n')).toContain(message);
  });

  // Through the real cmdCredentialAdd, with a logged-in runtime, so only its own checks refuse.
  it.each([
    [
      'a terminal on stdin',
      ['credentials', 'add', 'gh', '--host', 'github.com'],
      true,
      'pipe the secret',
    ],
    [
      '--endpoint for another consumer',
      [
        'credentials',
        'add',
        'gh',
        '--consumer',
        'sandbox-egress',
        '--host',
        'github.com',
        '--endpoint',
        'https://x.example',
      ],
      false,
      '--endpoint only applies to --consumer inference',
    ],
  ] as Array<[string, string[], boolean, string]>)(
    'refuses credentials add with %s, before reading stdin',
    async (_label, argv, stdinIsTTY, message) => {
      const readStdin = vi.fn(async () => 'secret');
      const o = io();
      const build = () => testRuntime();
      expect(await main(argv, {}, o, { buildRuntime: build, readStdin, stdinIsTTY })).toBe(2);
      expect(readStdin).not.toHaveBeenCalled();
      expect(o.errs.join('\n')).toContain(message);
    },
  );

  it('prints the config warning', async () => {
    const o = io();
    const build = () => ({ ...fakeBuild(), configWarning: 'ignoring unreadable x' }) as Runtime;
    await main(['frobnicate'], {}, o, { buildRuntime: build });
    expect(o.errs[0]).toBe('ignoring unreadable x');
  });

  it('promote --dry-run builds and prints without a login or a control plane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-cli-promote-'));
    mkdirSync(join(dir, '.claude/commands'), { recursive: true });
    writeFileSync(join(dir, '.claude/commands/go.md'), 'go');
    const o = io();
    expect(await main(['promote', dir, '--dry-run'], {}, o, { buildRuntime: fakeBuild })).toBe(0);
    expect(o.outs.join('')).toContain('dry run: not uploaded');
    expect(USAGE).toContain('mocactl promote DIR [--dry-run] [--json]');
  });

  it('bundles delete needs exactly one digest, and bundles has no other subcommand', async () => {
    expect(await main(['bundles', 'delete'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['bundles', 'delete', 'a', 'b'], {}, io(), { buildRuntime: fakeBuild })).toBe(
      2,
    );
    const o = io();
    expect(await main(['bundles', 'list'], {}, o, { buildRuntime: fakeBuild })).toBe(2);
    expect(o.errs.join('')).toContain('unknown bundles command "list"');
    expect(USAGE).toContain('mocactl bundles delete DIGEST [--json]');
  });

  it('promote needs exactly one directory', async () => {
    expect(await main(['promote'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['promote', 'a', 'b'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
  });

  it('rejects --config together with --session, and --config outside run', async () => {
    const o = io();
    expect(
      await main(['run', 'hi', '--session', 's1', '--config', 'sha256:x'], {}, o, {
        buildRuntime: fakeBuild,
      }),
    ).toBe(2);
    expect(o.errs.join('')).toContain('fixed when it is created');
    const o2 = io();
    expect(
      await main(['sessions', '--config', 'sha256:x'], {}, o2, { buildRuntime: fakeBuild }),
    ).toBe(2);
    expect(o2.errs.join('')).toContain('only applies to');
  });

  it('rejects an empty or blank --config rather than running without the bundle', async () => {
    for (const blank of ['', '   ']) {
      const o = io();
      expect(await main(['run', 'hi', '--config', blank], {}, o, { buildRuntime: fakeBuild })).toBe(
        2,
      );
      expect(o.errs.join('')).toContain('--config');
    }
  });
});

describe('B14: an expired login is refreshed before a command runs', () => {
  it('refreshes once, then lists sessions with the new token', async () => {
    const rt = testRuntime();
    const expired = { ...rt.auth!, expiresAt: 1, refreshToken: 'mrt_old' };
    saveAuth(rt.paths, expired);
    rt.auth = expired;
    const seen: string[] = [];
    rt.cp = fakeControlPlane({
      refreshAuth: async () => ({
        token: 'api-new',
        subject: 'github:1',
        roles: [],
        expiresAt: 4_000_000_000,
        refreshToken: 'mrt_new',
      }),
      listSessions: async () => {
        seen.push(rt.auth!.apiToken);
        return { sessions: [], nextCursor: null };
      },
    });
    expect(await main(['sessions'], {}, io(), { buildRuntime: () => rt })).toBe(0);
    expect(seen).toEqual(['api-new']);
    expect(loadAuth(rt.paths, 'http://cp')?.refreshToken).toBe('mrt_new');
  });

  it('says the login could not be refreshed, rather than "not logged in", when the control plane is down', async () => {
    const rt = testRuntime();
    const expired = { ...rt.auth!, expiresAt: 1, refreshToken: 'mrt_old' };
    saveAuth(rt.paths, expired);
    rt.auth = expired;
    rt.cp = fakeControlPlane({
      refreshAuth: async () => {
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const o = io();
    expect(await main(['sessions'], {}, o, { buildRuntime: () => rt })).toBe(2);
    expect(o.errs.join('')).toMatch(/could not be refreshed/);
  });

  it('says "not logged in" once the control plane refused the refresh token', async () => {
    const rt = testRuntime();
    const expired = { ...rt.auth!, expiresAt: 1, refreshToken: 'mrt_old' };
    saveAuth(rt.paths, expired);
    rt.auth = expired;
    rt.cp = fakeControlPlane(); // refreshAuth: invalid_grant by default
    const o = io();
    expect(await main(['sessions'], {}, o, { buildRuntime: () => rt })).toBe(2);
    expect(o.errs.join('')).toMatch(/not logged in/);
    expect(rt.auth).not.toHaveProperty('refreshToken');
  });
});

describe('B14 commands', () => {
  it('routes auth token and logout, and refuses their misuse', async () => {
    expect(await main(['auth'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['auth', 'nope'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['logout', 'extra'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['sessions', '--all'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(USAGE).toContain('mocactl auth token');
    expect(USAGE).toContain('mocactl logout [--all]');
  });
});
