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

/* ---------------- spawn / subagents / get ---------------- */

describe('spawn / subagents / get', () => {
  it('spawn routes --config, --kind, --repo, --ref, --tag through to cmdSpawn', async () => {
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const mod = await import('../src/subagent.js');
    const spy = vi.spyOn(mod, 'cmdSpawn').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    const DIGEST = 'sha256:' + 'a'.repeat(64);
    expect(
      await main(
        [
          'spawn',
          'do a thing',
          '--config',
          DIGEST,
          '--kind',
          'solve',
          '--repo',
          'https://x',
          '--ref',
          'main',
          '--tag',
          'parent-1',
        ],
        {},
        io(),
        { buildRuntime: fakeBuild },
      ),
    ).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][2]).toMatchObject({
      prompt: 'do a thing',
      kind: 'solve',
      configRef: DIGEST,
      repoUrl: 'https://x',
      ref: 'main',
      tag: 'parent-1',
    });
  });

  it('spawn refuses an invalid --kind at the CLI level (never reaches cmdSpawn)', async () => {
    const mod = await import('../src/subagent.js');
    const spy = vi.spyOn(mod, 'cmdSpawn');
    onTestFinished(() => spy.mockRestore());
    const o = io();
    expect(
      await main(['spawn', 'p', '--kind', 'converge'], {}, o, { buildRuntime: fakeBuild }),
    ).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    expect(o.errs.join('\n')).toContain('--kind must be prompt or solve');
  });

  it('rejects --repo / --ref outside spawn, and --tag outside spawn/subagents', async () => {
    for (const extra of [
      ['--repo', 'u'],
      ['--ref', 'r'],
    ]) {
      expect(await main(['sessions', ...extra], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    }
    expect(await main(['run', 'p', '--tag', 't'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    // --tag on subagents is allowed.
    const sub = await import('../src/subagent.js');
    const spy = vi.spyOn(sub, 'cmdSubagents').mockImplementation(async () => 0);
    onTestFinished(() => spy.mockRestore());
    expect(await main(['subagents', '--tag', 't'], {}, io(), { buildRuntime: fakeBuild })).toBe(0);
  });

  it('--config is accepted on both run and spawn, rejected elsewhere', async () => {
    const sub = await import('../src/subagent.js');
    const spawnStub = vi.spyOn(sub, 'cmdSpawn').mockImplementation(async () => 0);
    onTestFinished(() => spawnStub.mockRestore());
    const run = await import('../src/headless.js');
    const runStub = vi.spyOn(run, 'cmdRun').mockImplementation(async () => 0);
    onTestFinished(() => runStub.mockRestore());
    const DIGEST = 'sha256:' + 'b'.repeat(64);
    expect(
      await main(['spawn', 'p', '--config', DIGEST, '--kind', 'prompt'], {}, io(), {
        buildRuntime: fakeBuild,
      }),
    ).toBe(0);
    expect(
      await main(['run', 'p', '--config', DIGEST], {}, io(), { buildRuntime: fakeBuild }),
    ).toBe(0);
    expect(
      await main(['sessions', '--config', DIGEST], {}, io(), { buildRuntime: fakeBuild }),
    ).toBe(2);
  });

  it('subagents refuses extra positionals and routes --json through', async () => {
    const mod = await import('../src/subagent.js');
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const spy = vi.spyOn(mod, 'cmdSubagents').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    expect(await main(['subagents', 'extra'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(stub).not.toHaveBeenCalled();
    expect(await main(['subagents', '--json'], {}, io(), { buildRuntime: fakeBuild })).toBe(0);
    expect(stub.mock.calls[0][2]).toMatchObject({ json: true });
  });

  it('get needs exactly one sessionId and threads --out through', async () => {
    const mod = await import('../src/subagent.js');
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const spy = vi.spyOn(mod, 'cmdGet').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    expect(await main(['get'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['get', 'a', 'b'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    // --out only on get.
    expect(await main(['sessions', '--out', '/tmp'], {}, io(), { buildRuntime: fakeBuild })).toBe(
      2,
    );
    expect(
      await main(['get', 'sess1', '--out', '/tmp/x'], {}, io(), { buildRuntime: fakeBuild }),
    ).toBe(0);
    expect(stub.mock.calls[0][2]).toMatchObject({ sessionId: 'sess1', outDir: '/tmp/x' });
  });

  it('USAGE documents all three new commands so --help remains the one source of truth', () => {
    expect(USAGE).toContain('mocactl spawn');
    expect(USAGE).toContain('mocactl subagents');
    expect(USAGE).toContain('mocactl get');
  });
});

/* ---------------- workloads ---------------- */

describe('workloads and spawn --workload', () => {
  it('spawn routes --workload through to cmdSpawn; --workload is refused elsewhere', async () => {
    const mod = await import('../src/subagent.js');
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const spy = vi.spyOn(mod, 'cmdSpawn').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    expect(
      await main(['spawn', 'p', '--kind', 'prompt', '--workload', 'demo'], {}, io(), {
        buildRuntime: fakeBuild,
      }),
    ).toBe(0);
    expect(stub.mock.calls[0][2]).toMatchObject({ kind: 'prompt', workloadId: 'demo' });
    const o = io();
    expect(await main(['run', 'p', '--workload', 'demo'], {}, o, { buildRuntime: fakeBuild })).toBe(
      2,
    );
    expect(o.errs.join('\n')).toContain('--workload only applies to `mocactl spawn`');
  });

  it('spawn routes --writable through to cmdSpawn; --writable is refused elsewhere', async () => {
    const mod = await import('../src/subagent.js');
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const spy = vi.spyOn(mod, 'cmdSpawn').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    const argv = ['spawn', 'p', '--kind', 'prompt', '--workload', 'demo', '--writable'];
    expect(await main(argv, {}, io(), { buildRuntime: fakeBuild })).toBe(0);
    expect(stub.mock.calls[0][2]).toMatchObject({ workloadId: 'demo', writable: true });
    expect(
      await main(['spawn', 'p', '--kind', 'prompt', '--workload', 'demo'], {}, io(), {
        buildRuntime: fakeBuild,
      }),
    ).toBe(0);
    expect(stub.mock.calls[1][2]).toMatchObject({ writable: false });
    const o = io();
    expect(await main(['run', 'p', '--writable'], {}, o, { buildRuntime: fakeBuild })).toBe(2);
    expect(o.errs.join('\n')).toContain('--writable only applies to `mocactl spawn`');
  });

  it('spawn routes --label through to cmdSpawn; --label is refused elsewhere', async () => {
    const mod = await import('../src/subagent.js');
    const stub = vi.fn(async (..._a: unknown[]) => 0);
    const spy = vi.spyOn(mod, 'cmdSpawn').mockImplementation(stub);
    onTestFinished(() => spy.mockRestore());
    const argv = ['spawn', 'p', '--kind', 'prompt', '--label', 'diagnose'];
    expect(await main(argv, {}, io(), { buildRuntime: fakeBuild })).toBe(0);
    expect(stub.mock.calls[0][2]).toMatchObject({ label: 'diagnose' });
    const o = io();
    expect(
      await main(['subagents', '--label', 'diagnose'], {}, o, { buildRuntime: fakeBuild }),
    ).toBe(2);
    expect(o.errs.join('\n')).toContain('--label only applies to `mocactl spawn`');
  });

  it('spawn --writable without --workload exits 2 before spawning', async () => {
    const mod = await import('../src/subagent.js');
    const spy = vi.spyOn(mod, 'cmdSpawn');
    onTestFinished(() => spy.mockRestore());
    const o = io();
    expect(
      await main(['spawn', 'p', '--kind', 'prompt', '--writable'], {}, o, {
        buildRuntime: fakeBuild,
      }),
    ).toBe(2);
    expect(o.errs.join('\n')).toContain('--writable needs --workload ID');
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes workloads create, get and delete; --context and --name only on create', async () => {
    const mod = await import('../src/workloads.js');
    const create = vi.fn(async (..._a: unknown[]) => 0);
    const get = vi.fn(async (..._a: unknown[]) => 0);
    const del = vi.fn(async (..._a: unknown[]) => 0);
    const spies = [
      vi.spyOn(mod, 'cmdWorkloadCreate').mockImplementation(create),
      vi.spyOn(mod, 'cmdWorkloadGet').mockImplementation(get),
      vi.spyOn(mod, 'cmdWorkloadDelete').mockImplementation(del),
    ];
    onTestFinished(() => spies.forEach((s) => s.mockRestore()));
    const run = (argv: string[], o = io()) => main(argv, {}, o, { buildRuntime: fakeBuild });

    expect(
      await run(['workloads', 'create', '--context', 'ctx.context', '--name', 'demo', '--json']),
    ).toBe(0);
    expect(create.mock.calls[0][2]).toMatchObject({
      contextPath: 'ctx.context',
      name: 'demo',
      json: true,
    });
    expect(await run(['workloads', 'get', 'demo', '--json'])).toBe(0);
    expect(get.mock.calls[0][2]).toMatchObject({ id: 'demo', json: true });
    expect(await run(['workloads', 'delete', 'demo'])).toBe(0);
    expect(del.mock.calls[0][2]).toMatchObject({ id: 'demo', json: false });

    expect(
      await run([
        'workloads',
        'create',
        '--context',
        'ctx.context',
        '--sandboxes',
        '2',
        '--mount',
        'writable',
      ]),
    ).toBe(0);
    expect(create.mock.calls[1][2]).toMatchObject({ sandboxes: 2, mount: 'writable' });
    for (const bad of [
      ['--sandboxes', '0'],
      ['--sandboxes', 'x'],
      ['--sandboxes', '1.5'],
      ['--sandboxes', '1', '--mount', 'rw'],
    ]) {
      const o = io();
      expect(await run(['workloads', 'create', '--context', 'c', ...bad], o)).toBe(2);
      expect(o.errs.join('\n')).toMatch(/--(sandboxes|mount) must be/);
    }
    expect(await run(['workloads', 'get', 'demo', '--sandboxes', '1'])).toBe(2);
    expect(await run(['spawn', 'p', '--mount', 'writable'])).toBe(2);
    const noContext = io();
    expect(await run(['workloads', 'create'], noContext)).toBe(2);
    expect(noContext.errs.join('\n')).toContain('needs --context FILE');
    const noList = io();
    expect(await run(['workloads'], noList)).toBe(2);
    expect(noList.errs.join('\n')).toContain('there is no list');
    expect(await run(['workloads', 'list'])).toBe(2);
    expect(await run(['workloads', 'get'])).toBe(2);
    expect(await run(['workloads', 'delete', 'a', 'b'])).toBe(2);
    expect(await run(['workloads', 'get', 'demo', '--context', 'x'])).toBe(2);
    expect(await run(['sessions', '--name', 'x'])).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(USAGE).toContain('mocactl workloads create --context FILE');
    expect(USAGE).toContain('--workload ID');
  });
});
