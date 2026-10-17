import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  authLockPath,
  DEFAULT_CONFIG,
  loadAuth,
  loadConfig,
  resolvePaths,
  saveAuth,
  saveConfig,
} from '../src/config.js';
import { cmdLogin } from '../src/headless.js';
import { buildRuntime } from '../src/runtime.js';
import { sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { readBoundSandbox } from '../src/sbx/state.js';

const URL_ = 'https://sbx-api.example.invalid';
const MOCA_URL = 'https://moca-api.example.invalid';
const SBX = 'sbx-0123456789abcdef0123456789';

type Req = { method: string; path: string; body: unknown; auth?: string };
type Handler = (req: Req) => { status: number; body?: unknown } | Error;

/** A scripted control plane: one handler per "METHOD /path", recording every call. */
function fakeCp(routes: Record<string, Handler>) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const req: Req = {
      method: init?.method ?? 'GET',
      path: u.pathname + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    };
    calls.push(req);
    const h = routes[`${req.method} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const r = h(req);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const LOGIN = {
  apiToken: 'api-1',
  subject: 'github:1',
  roles: [],
  expiresAt: 4_000_000_000,
  controlPlaneUrl: URL_,
  refreshToken: 'mrt_x',
  refreshExpiresAt: 4_000_000_000,
};

function setup(opts: { loggedIn?: boolean; expired?: boolean } = { loggedIn: true }) {
  const home = mkdtempSync(join(tmpdir(), 'mocactl-sbx-'));
  const env = { HOME: home, MOCACTL_SBX_URL: URL_ };
  const paths = resolvePaths(env, home);
  if (opts.loggedIn !== false) {
    // The sbx login lives in its own file (sbx-auth.json), never in MOCA's auth.json.
    saveAuth(sbxPaths(paths), { ...LOGIN, ...(opts.expired ? { expiresAt: 1_000 } : {}) });
  }
  const io = {
    outs: [] as string[],
    errs: [] as string[],
    out(s: string) {
      this.outs.push(s);
    },
    err(s: string) {
      this.errs.push(s);
    },
  };
  return { home, env, paths, io };
}

const sandbox = (over: Record<string, unknown> = {}) => ({
  id: SBX,
  owner: 'github:1',
  name: 'web',
  template: 'node22',
  state: 'ready',
  reason: null,
  createdAt: 1_800_000_000,
  expiresAt: 1_800_604_800,
  terminatedAt: null,
  labels: {},
  ...over,
});
const TOKEN = {
  token: 'eyJ.sbx.tok',
  expiresAt: 1_800_000_900,
  execEndpoint: 'sbx-exec.example.invalid:443',
  wrk: 'sbx_node22',
  wsk: SBX,
  execCa: null,
};
const DEVICE = {
  deviceCode: 'dc',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://github.com/login/device',
  interval: 0,
  expiresIn: 900,
};
const loginBody = (token: string, subject: string) => ({
  token,
  subject,
  displayName: 'Ana',
  roles: [],
  expiresAt: 4_000_000_000,
  refreshToken: `mrt_${token}`,
  refreshExpiresAt: 4_000_000_000,
});
const SBX_DISCOVERY = { profile: 'sandbox', execEndpoint: 'sbx-exec.example.invalid:443' };

describe('mocactl sbx (SBX0 §6.1, 1b subset)', () => {
  it('is reached from the top-level CLI', async () => {
    const { env, io } = setup();
    expect(await main(['sbx', '--help'], env, io)).toBe(0);
    expect(io.outs.join('')).toContain('mocactl sbx login');
  });

  it('needs a control plane URL, and says how to give one', async () => {
    const { home, io } = setup();
    expect(await sbxMain(['ls'], { HOME: home }, io, { home })).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--control-plane-url|MOCACTL_SBX_URL/);
  });

  it('asks for a login first (exit 3)', async () => {
    const { home, env, io } = setup({ loggedIn: false });
    const cp = fakeCp({});
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(3);
    expect(io.errs.join('\n')).toContain('mocactl sbx login');
    expect(cp.calls).toEqual([]);
  });

  it('logs in by device flow, stores the login in sbx-auth.json, and remembers the URL given by flag', async () => {
    const { home, paths, io } = setup({ loggedIn: false });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({ status: 200, body: SBX_DISCOVERY }),
      'POST /v1/auth/device': () => ({ status: 200, body: DEVICE }),
      'POST /v1/auth/device/token': () => ({
        status: 200,
        body: loginBody('api-new', 'github:7'),
      }),
    });
    expect(
      await sbxMain(['login', '--control-plane-url', URL_], { HOME: home }, io, {
        home,
        fetchImpl: cp.fetchImpl,
      }),
    ).toBe(0);
    expect(io.errs.join('\n')).toContain('ABCD-EFGH');
    expect(loadAuth(sbxPaths(paths), URL_)?.apiToken).toBe('api-new');
    expect(existsSync(paths.authFile)).toBe(false); // MOCA's auth.json is not touched
    expect(loadConfig(paths).config.sbxControlPlaneUrl).toBe(URL_);
  });

  it('keeps a MOCA login and an sbx login side by side, neither overwriting the other', async () => {
    const { home, paths, io } = setup({ loggedIn: false });
    const env = { HOME: home };
    const cpFor = (token: string) =>
      fakeCp({
        'GET /v1/discovery': () => ({ status: 200, body: SBX_DISCOVERY }),
        'POST /v1/auth/device': () => ({ status: 200, body: DEVICE }),
        'POST /v1/auth/device/token': () => ({ status: 200, body: loginBody(token, 'github:1') }),
      });
    const mocaLogin = async (token: string) => {
      const rt = buildRuntime({ controlPlaneUrl: MOCA_URL }, env, home, cpFor(token).fetchImpl);
      rt.sleep = async () => {};
      expect(await cmdLogin(rt, io)).toBe(0);
    };
    // MOCA first, then sbx: the sbx login must not replace the MOCA one.
    await mocaLogin('api-moca');
    expect(
      await sbxMain(['login', '--control-plane-url', URL_], env, io, {
        home,
        fetchImpl: cpFor('api-sbx').fetchImpl,
      }),
    ).toBe(0);
    expect(loadAuth(paths, MOCA_URL)?.apiToken).toBe('api-moca');
    expect(loadAuth(sbxPaths(paths), URL_)?.apiToken).toBe('api-sbx');
    // And the other way round: a MOCA login after it leaves the sbx one alone.
    await mocaLogin('api-moca-2');
    expect(loadAuth(sbxPaths(paths), URL_)?.apiToken).toBe('api-sbx');
    expect(loadAuth(paths, MOCA_URL)?.apiToken).toBe('api-moca-2');
    // The MOCA config keeps its own URL: the sbx one is a separate key.
    expect(loadConfig(paths).config.controlPlaneUrl).toBeUndefined();
    // Separate files, so separate refresh locks: neither refresh waits on (or spends) the other's.
    expect(sbxPaths(paths).authFile).toBe(join(paths.configDir, 'sbx-auth.json'));
    expect(authLockPath(sbxPaths(paths))).toBe(join(paths.configDir, 'sbx-auth.json.lock'));
    // A command sends the sbx login, never MOCA's.
    const ls = fakeCp({ 'GET /v1/sandboxes': () => ({ status: 200, body: { sandboxes: [] } }) });
    expect(
      await sbxMain(['ls'], { HOME: home, MOCACTL_SBX_URL: URL_ }, io, {
        home,
        fetchImpl: ls.fetchImpl,
      }),
    ).toBe(0);
    expect(ls.calls[0]!.auth).toBe('Bearer api-sbx');
  });

  it('refuses to log in to a control plane that is not the sandbox service', async () => {
    const { home, env, paths, io } = setup({ loggedIn: false });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({
        status: 200,
        body: { profile: 'harness', harnessUrl: 'https://h', sandboxTiers: [], version: '1' },
      }),
    });
    expect(await sbxMain(['login'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(2);
    expect(io.errs.join('\n')).toMatch(/not the sandbox service/);
    expect(cp.calls.map((c) => c.path)).toEqual(['/v1/discovery']);
    expect(existsSync(sbxPaths(paths).authFile)).toBe(false);
  });

  it('explains a not-enrolled login', async () => {
    const { home, env, io } = setup({ loggedIn: false });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({ status: 200, body: SBX_DISCOVERY }),
      'POST /v1/auth/device': () => ({ status: 200, body: { ...DEVICE, userCode: 'X' } }),
      'POST /v1/auth/device/token': () => ({
        status: 403,
        body: {
          error: 'not_enrolled',
          message: 'this account (github:777) is not enrolled in the sandbox service',
        },
      }),
    });
    expect(await sbxMain(['login'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/(not|no longer) enrolled.*operator/s);
    // The server's message is passed through, subject included, for the user to hand on.
    expect(io.errs.join('\n')).toContain('this account (github:777) is not enrolled');
  });

  it('tells a user de-enrolled since login so, at refresh (exit 1, not 4)', async () => {
    const { home, env, io, paths } = setup({ expired: true });
    const cp = fakeCp({
      'POST /v1/auth/token': () => ({
        status: 403,
        body: {
          error: 'not_enrolled',
          message: 'this account (github:1) is no longer enrolled in the sandbox service',
        },
      }),
    });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/(not|no longer) enrolled.*operator/s);
    expect(io.errs.join('\n')).not.toMatch(/cannot reach/);
    expect(cp.calls.map((c) => c.path)).toEqual(['/v1/auth/token']);
    // The server revoked the login; sbx-auth.json must never present that refresh token again.
    expect(readFileSync(sbxPaths(paths).authFile, 'utf8')).not.toContain('refreshToken');
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(3);
    expect(cp.calls.map((c) => c.path)).toEqual(['/v1/auth/token']);
  });

  it('says the control plane is unreachable only for a network failure (exit 4)', async () => {
    const { home, env, io } = setup({ expired: true });
    const cp = fakeCp({ 'POST /v1/auth/token': () => new TypeError('fetch failed') });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(4);
    expect(io.errs.join('\n')).toMatch(/cannot reach the sandbox control plane/);
  });

  it('lists templates, as a table and as JSON', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/templates': () => ({
        status: 200,
        body: { templates: [{ id: 'node22', description: 'Node 22', tools: ['node'] }] },
      }),
    });
    expect(await sbxMain(['templates'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toMatch(/node22\s+Node 22/);
    expect(cp.calls[0]!.auth).toBe('Bearer api-1');
    io.outs.length = 0;
    expect(await sbxMain(['templates', '--json'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(
      0,
    );
    expect(JSON.parse(io.outs.join(''))).toEqual([
      { id: 'node22', description: 'Node 22', tools: ['node'] },
    ]);
  });

  it('creates a sandbox with a template, a name and labels, and prints its id and expiry', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({ 'POST /v1/sandboxes': () => ({ status: 201, body: sandbox() }) });
    expect(
      await sbxMain(
        [
          'create',
          '--template',
          'node22',
          '--name',
          'web',
          '--label',
          'project=p',
          '--label',
          'team=t',
        ],
        env,
        io,
        { home, fetchImpl: cp.fetchImpl },
      ),
    ).toBe(0);
    expect(cp.calls[0]!.body).toEqual({
      template: 'node22',
      name: 'web',
      labels: { project: 'p', team: 't' },
    });
    expect(io.outs.join('')).toContain(SBX);
    expect(io.errs.join('')).toContain(new Date(1_800_604_800 * 1000).toISOString());
  });

  it('refuses create without --template, and a malformed --label', async () => {
    const { home, env, io } = setup();
    expect(await sbxMain(['create'], env, io, { home, fetchImpl: fakeCp({}).fetchImpl })).toBe(2);
    expect(
      await sbxMain(['create', '--template', 'x', '--label', 'nope'], env, io, {
        home,
        fetchImpl: fakeCp({}).fetchImpl,
      }),
    ).toBe(2);
  });

  it('reports a refusal from the control plane with its code (exit 1)', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'POST /v1/sandboxes': () => ({
        status: 429,
        body: { error: 'quota_exceeded', message: 'at most 3 live sandboxes per user' },
      }),
    });
    expect(
      await sbxMain(['create', '--template', 'node22'], env, io, { home, fetchImpl: cp.fetchImpl }),
    ).toBe(1);
    expect(io.errs.join('\n')).toContain('at most 3 live sandboxes per user');
  });

  it('says so when the URL is a control plane without sandbox routes', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({}); // every route 404 not_found, as on a MOCA (harness profile) control plane
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/no sandbox routes/);
  });

  it('lists sandboxes with state and expiry; --all passes all=1', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/sandboxes': () => ({
        status: 200,
        body: {
          sandboxes: [
            sandbox(),
            sandbox({ id: 'sbx-dead', name: null, state: 'terminated', reason: 'deleted' }),
          ],
        },
      }),
    });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).toMatch(new RegExp(`${SBX}\\s+web\\s+node22\\s+ready`));
    expect(out).toMatch(/sbx-dead\s+-\s+node22\s+terminated \(deleted\)/);
    expect(out).toContain(new Date(1_800_604_800 * 1000).toISOString());
    await sbxMain(['ls', '--all'], env, io, { home, fetchImpl: cp.fetchImpl });
    expect(cp.calls.at(-1)!.path).toBe('/v1/sandboxes?all=1');
  });

  it('deletes a sandbox', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      ['DELETE /v1/sandboxes/' + SBX]: () => ({
        status: 200,
        body: { id: SBX, state: 'terminated', reason: 'deleted' },
      }),
    });
    expect(await sbxMain(['rm', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    // Delete is not immediate (SBX0 §5.4): the line says how long issued tokens keep working.
    expect(io.errs.join('\n')).toBe(
      `deleted ${SBX}; tokens already issued stop working within one token lifetime plus 30 s ` +
        '(15.5 minutes by default)',
    );
  });

  it('refuses a malformed sandbox id before any request', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({});
    expect(await sbxMain(['env', '../../etc'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(2);
    expect(cp.calls.filter((c) => c.path.startsWith('/v1/sandboxes'))).toEqual([]);
  });

  it('prints only the token, for scripts', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    expect(await sbxMain(['token', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).toBe('eyJ.sbx.tok\n');
  });

  it('says why a terminated sandbox gives no token', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 409,
        body: { error: 'sandbox_terminated', message: 'sandbox was deleted', reason: 'deleted' },
      }),
    });
    expect(await sbxMain(['token', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toMatch(/sandbox was deleted/);
  });

  it('prints shell exports for the gRPC API, writing a self-issued CA to a 0600 file', async () => {
    const { home, env, io, paths } = setup();
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: { ...TOKEN, execCa: pem } }),
    });
    expect(await sbxMain(['env', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).toContain("export SBX_ADDR='sbx-exec.example.invalid:443'");
    expect(out).toContain("export SBX_TLS='1'");
    expect(out).toContain("export SBX_SANDBOX_ID='sbx_node22'");
    expect(out).toContain(`export SBX_WORKSPACE_KEY='${SBX}'`);
    // The URL came from MOCACTL_SBX_URL, so the command names it (quoted inside the quoted value).
    expect(out).toContain(
      `export SBX_TOKEN_CMD='mocactl sbx token --control-plane-url '\\''${URL_}'\\'' ${SBX}'`,
    );
    expect(out).not.toContain('eyJ.sbx.tok'); // never the token itself: it lives 15 minutes
    const ca = join(paths.stateDir, 'sbx', `${SBX}-exec-ca.crt`);
    expect(isAbsolute(ca)).toBe(true);
    expect(out).toContain(`export SBX_CA_FILE='${ca}'`);
    expect(readFileSync(ca, 'utf8')).toBe(pem);
    expect(statSync(ca).mode & 0o777).toBe(0o600);
    // A second run over an existing file still leaves it 0600 with the new contents.
    expect(await sbxMain(['env', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(statSync(ca).mode & 0o777).toBe(0o600);
  });

  it('prints no SBX_CA_FILE when the exec certificate is publicly trusted', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    expect(await sbxMain(['env', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(io.outs.join('')).not.toContain('SBX_CA_FILE');
  });

  it('writes the CA under an absolute path even with a relative XDG_STATE_HOME', async () => {
    const { home, io } = setup();
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const cwd = mkdtempSync(join(tmpdir(), 'mocactl-sbx-cwd-'));
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      const cp = fakeCp({
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({
          status: 200,
          body: { ...TOKEN, execCa: pem },
        }),
      });
      const env = { HOME: home, MOCACTL_SBX_URL: URL_, XDG_STATE_HOME: 'rel-state' };
      expect(await sbxMain(['env', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
      const line = io.outs.join('').match(/^export SBX_CA_FILE='(.*)'$/m);
      expect(line).not.toBeNull();
      expect(isAbsolute(line![1]!)).toBe(true);
      expect(readFileSync(line![1]!, 'utf8')).toBe(pem);
    } finally {
      process.chdir(prev);
    }
  });

  it('takes the id from the nearest .sbx/sandbox.json when none is given', async () => {
    const { home, env, io } = setup();
    const repo = mkdtempSync(join(tmpdir(), 'mocactl-sbx-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.sbx'));
    writeFileSync(join(repo, '.sbx', 'sandbox.json'), JSON.stringify({ id: SBX }));
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    expect(
      await sbxMain(['token'], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        cwd: join(repo, 'src', 'deep'),
      }),
    ).toBe(0);
    expect(
      await sbxMain(['token'], env, io, { home, fetchImpl: cp.fetchImpl, cwd: tmpdir() }),
    ).toBe(2);
  });

  it('stops looking for .sbx/sandbox.json at the repository root', () => {
    const outer = mkdtempSync(join(tmpdir(), 'mocactl-sbx-outer-'));
    mkdirSync(join(outer, '.sbx'));
    writeFileSync(join(outer, '.sbx', 'sandbox.json'), JSON.stringify({ id: SBX }));
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(readBoundSandbox(repo)).toBeUndefined();
    expect(readBoundSandbox(outer)).toBe(SBX);
  });

  describe('SBX_TOKEN_CMD names the control plane unless config.json does', () => {
    const tokenCmdLine = (out: string) => out.match(/^export SBX_TOKEN_CMD=(.*)$/m)?.[1];
    const evalSh = (quoted: string) => execFileSync('sh', ['-c', `printf %s ${quoted}`]).toString();

    it('from config.json: the bare command', async () => {
      const { home, paths, io } = setup();
      saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ });
      const cp = fakeCp({
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
      });
      expect(
        await sbxMain(['env', SBX], { HOME: home }, io, { home, fetchImpl: cp.fetchImpl }),
      ).toBe(0);
      expect(evalSh(tokenCmdLine(io.outs.join(''))!)).toBe(`mocactl sbx token ${SBX}`);
    });

    it('from --control-plane-url: the URL, shell-safe even with a quote in it', async () => {
      const { home, paths, io } = setup({ loggedIn: false });
      const odd = "https://sbx.example.invalid/it's";
      saveAuth(sbxPaths(paths), { ...LOGIN, controlPlaneUrl: odd });
      saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ }); // the flag wins
      const cp = fakeCp({
        [`POST /it's/v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
      });
      expect(
        await sbxMain(['env', '--control-plane-url', odd, SBX], { HOME: home }, io, {
          home,
          fetchImpl: cp.fetchImpl,
        }),
      ).toBe(0);
      const cmd = evalSh(tokenCmdLine(io.outs.join(''))!);
      expect(cmd).toBe(
        `mocactl sbx token --control-plane-url '${odd.replace(/'/g, `'\\''`)}' ${SBX}`,
      );
      // Run as a shell command line, it hands mocactl exactly these arguments.
      const argv = execFileSync('sh', ['-c', `printf '%s\\n' ${cmd.slice('mocactl '.length)}`])
        .toString()
        .trimEnd()
        .split('\n');
      expect(argv).toEqual(['sbx', 'token', '--control-plane-url', odd, SBX]);
    });
  });

  describe('a 401 whose retry refresh fails reports what the refresh hit', () => {
    // A fresh-looking login the control plane rejects: the client refreshes once (forced), and
    // that refresh is what fails.
    const rejectedThenRefresh = (refresh: Handler) =>
      fakeCp({
        'GET /v1/sandboxes': () => ({
          status: 401,
          body: { error: 'token_expired', message: 'token expired' },
        }),
        'POST /v1/auth/token': refresh,
      });

    it('a network failure: exit 4', async () => {
      const { home, env, io } = setup();
      const cp = rejectedThenRefresh(() => new TypeError('fetch failed'));
      expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(4);
      expect(io.errs.join('\n')).toMatch(/cannot reach the sandbox control plane/);
      expect(cp.calls.map((c) => c.path)).toEqual(['/v1/sandboxes', '/v1/auth/token']);
    });

    it('not_enrolled: exit 1, with the operator message', async () => {
      const { home, env, io } = setup();
      const cp = rejectedThenRefresh(() => ({
        status: 403,
        body: { error: 'not_enrolled', message: 'this account (github:1) is no longer enrolled' },
      }));
      expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
      expect(io.errs.join('\n')).toMatch(/(not|no longer) enrolled.*operator/s);
      expect(io.errs.join('\n')).toContain('(github:1)');
    });

    it('a refused refresh token: exit 3, log in again', async () => {
      const { home, env, io } = setup();
      const cp = rejectedThenRefresh(() => ({
        status: 400,
        body: { error: 'invalid_grant', message: 'refresh token refused: revoked' },
      }));
      expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(3);
      expect(io.errs.join('\n')).toContain('mocactl sbx login');
    });

    it('a refresh that works: the retry succeeds', async () => {
      const { home, env, io } = setup();
      let n = 0;
      const cp = fakeCp({
        'GET /v1/sandboxes': () =>
          n++ === 0
            ? { status: 401, body: { error: 'token_expired' } }
            : { status: 200, body: { sandboxes: [] } },
        'POST /v1/auth/token': () => ({ status: 200, body: loginBody('api-2', 'github:1') }),
      });
      expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
      expect(cp.calls.at(-1)!.auth).toBe('Bearer api-2');
    });
  });

  it('shows a terminated sandbox with no reason as just terminated', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/sandboxes': () => ({
        status: 200,
        body: { sandboxes: [sandbox({ state: 'terminated', reason: null })] },
      }),
    });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const out = io.outs.join('');
    expect(out).toMatch(/node22\s+terminated\s+\d{4}-/);
    expect(out).not.toMatch(/expired|\(/);
  });

  it('sanitizes before padding, so the columns still line up', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/sandboxes': () => ({
        status: 200,
        body: {
          sandboxes: [sandbox({ name: 'w\u001b[31meb' }), sandbox({ id: 'sbx-b', name: 'web' })],
        },
      }),
    });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const [a, b] = io.outs.join('').trimEnd().split('\n');
    expect(a).not.toContain('\u001b');
    expect(a!.indexOf('node22')).toBe(b!.indexOf('node22'));
  });
});
