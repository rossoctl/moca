import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import {
  authLockPath,
  DEFAULT_CONFIG,
  loadAuth,
  loadConfig,
  saveAuth,
  saveConfig,
} from '../src/config.js';
import { cmdLogin, devicePrompt } from '../src/headless.js';
import { buildRuntime } from '../src/runtime.js';
import { SandboxApiClient } from '../src/sbx/api.js';
import { openSbxRuntime, sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { createWaitingForActivation } from '../src/sbx/commands.js';
import { readBoundSandbox } from '../src/sbx/state.js';
import { LeaseControlError } from '@moca/sandbox-client';
import type { ExecFactory } from '../src/sbx/exec.js';
import {
  fakeCp,
  fakeLease,
  LOGIN,
  sandbox,
  SBX,
  setup,
  TOKEN,
  URL_,
  type Handler,
} from './helpers/sbx.js';

const MOCA_URL = 'https://moca-api.example.invalid';

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

  it('passes the terminal check and stdin through from the top-level CLI to sbx run', async () => {
    const { env, io } = setup();
    let read = 0;
    const readStdin = async () => (read++, '');
    expect(
      await main(['sbx', 'run', '--sandbox', SBX], env, io, { stdinIsTTY: true, readStdin }),
    ).toBe(2);
    expect(read).toBe(0);
    expect(
      await main(['sbx', 'run', '--sandbox', SBX], env, io, { stdinIsTTY: false, readStdin }),
    ).toBe(2);
    expect(read).toBe(1);
  });

  it('needs a control plane URL, and says how to give one', async () => {
    // No login either: a login's own controlPlaneUrl is the last fallback (a login file alone).
    const { home, io } = setup({ loggedIn: false });
    expect(await sbxMain(['ls'], { HOME: home }, io, { home })).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--control-plane-url|MOCACTL_SBX_URL/);
  });

  it("falls back to the login's own control plane when nothing else names one", async () => {
    // sbx-auth.json alone, no MOCACTL_SBX_URL, no config (a login file copied without config.json).
    const { home, io } = setup();
    const cp = fakeCp({ 'GET /v1/sandboxes': () => ({ status: 200, body: { sandboxes: [] } }) });
    expect(await sbxMain(['ls'], { HOME: home }, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(cp.calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /v1/sandboxes');
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

  it.each([
    [[], ['copy ABCD-EFGH', 'open https://github.com/login/device']],
    [['--no-browser'], []],
  ])('sbx login %j: copies and opens unless --no-browser', async (flags, expected) => {
    const { home, io } = setup({ loggedIn: false });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({ status: 200, body: SBX_DISCOVERY }),
      'POST /v1/auth/device': () => ({ status: 200, body: DEVICE }),
      'POST /v1/auth/device/token': () => ({
        status: 200,
        body: loginBody('api-new', 'github:7'),
      }),
    });
    const steps: string[] = [];
    const loginHelpers = {
      copy: async (t: string) => void steps.push(`copy ${t}`),
      openUrl: (u: string) => void steps.push(`open ${u}`),
    };
    expect(
      await sbxMain(['login', '--control-plane-url', URL_, ...flags], { HOME: home }, io, {
        home,
        fetchImpl: cp.fetchImpl,
        loginHelpers,
      }),
    ).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(steps).toEqual(expected);
  });

  it('refuses --no-browser on a command other than login', async () => {
    const { env, io } = setup();
    expect(await sbxMain(['templates', '--no-browser'], env, io)).toBe(2);
    expect(io.errs.join('\n')).toContain('--no-browser');
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

  it('logs in to a combined control plane, which serves sandboxes too (combined spec §3.1)', async () => {
    const { home, env, paths, io } = setup({ loggedIn: false });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({
        status: 200,
        body: { ...SBX_DISCOVERY, profile: 'combined', harnessUrl: 'https://h' },
      }),
      'POST /v1/auth/device': () => ({ status: 200, body: { ...DEVICE, userCode: 'X' } }),
      'POST /v1/auth/device/token': () => ({ status: 200, body: loginBody('api-c', 'github:1') }),
    });
    expect(await sbxMain(['login'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(loadAuth(sbxPaths(paths), URL_)?.apiToken).toBe('api-c');
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

  it('moves tags onto a build and removes one, saying what changed (lifecycle §5.1)', async () => {
    const { home, env, io } = setup();
    const b2 = `sha256:${'2'.repeat(64)}`;
    const b1 = `sha256:${'1'.repeat(64)}`;
    const cp = fakeCp({
      'POST /v1/templates/node22/tags': () => ({
        status: 200,
        body: {
          templateId: 'node22',
          subject: 'github:1',
          buildId: b2,
          tags: [
            { tag: 'default', buildId: b2, before: b1, record: `sha256:${'a'.repeat(64)}` },
            { tag: 'stable', buildId: b2, before: null, record: `sha256:${'b'.repeat(64)}` },
            { tag: 'v2', buildId: b2, before: b2, record: null },
          ],
        },
      }),
      'DELETE /v1/templates/node22/tags/stable': () => ({
        status: 200,
        body: {
          templateId: 'node22',
          subject: 'github:1',
          tag: 'stable',
          buildId: null,
          before: b2,
          record: `sha256:${'c'.repeat(64)}`,
        },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(
      await sbxMain(
        ['templates', 'tag', 'node22', 'default', 'stable', 'v2', '--build', b2],
        env,
        io,
        opts,
      ),
    ).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { tags: ['default', 'stable', 'v2'], build: b2 },
    });
    const out = io.outs.join('');
    expect(out).toContain(`node22:default -> ${b2} (was ${b1})`);
    expect(out).toContain(`node22:stable -> ${b2} (new)`);
    expect(out).toContain(`node22:v2 -> ${b2} (unchanged)`);
    io.outs.length = 0;
    expect(await sbxMain(['templates', 'untag', 'node22', 'stable'], env, io, opts)).toBe(0);
    expect(cp.calls.at(-1)!.method).toBe('DELETE');
    expect(io.outs.join('')).toContain(`removed node22:stable (was ${b2})`);
    io.outs.length = 0;
    expect(await sbxMain(['templates', 'untag', 'node22', 'stable', '--json'], env, io, opts)).toBe(
      0,
    );
    expect(JSON.parse(io.outs.join(''))).toMatchObject({ tag: 'stable', before: b2 });
    // Usage errors, before any request.
    const n = cp.calls.length;
    expect(await sbxMain(['templates', 'tag', 'node22', 'x'], env, io, opts)).toBe(2);
    expect(io.errs.join('\n')).toMatch(/templates tag needs --build BUILD/);
    expect(await sbxMain(['templates', 'tag', 'node22', '--build', b2], env, io, opts)).toBe(2);
    expect(await sbxMain(['templates', 'untag', 'node22'], env, io, opts)).toBe(2);
    expect(await sbxMain(['templates', 'untag', 'node22', 'a', 'b'], env, io, opts)).toBe(2);
    expect(await sbxMain(['templates', 'untag', 'node22', 'a', '--build', b2], env, io, opts)).toBe(
      2,
    );
    expect(io.errs.join('\n')).toMatch(
      /--build only applies to templates show, follow, cancel, tag/,
    );
    expect(cp.calls.length).toBe(n);
  });

  it('edits a template and transfers it, saying what changed (lifecycle §5.1, §5.2)', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'PATCH /v1/templates/node22': (req) => ({
        status: 200,
        body: {
          templateId: 'node22',
          subject: 'github:1',
          visibility: 'private',
          description: 'Node',
          changes: (req.body as { visibility?: string } | undefined)?.visibility
            ? [
                {
                  field: 'visibility',
                  value: 'private',
                  before: 'deployment',
                  record: `sha256:${'a'.repeat(64)}`,
                },
              ]
            : [],
        },
      }),
      'PUT /v1/templates/node22/owner': () => ({
        status: 200,
        body: {
          templateId: 'node22',
          subject: 'github:1',
          owner: 'github:9',
          before: 'github:1',
          record: `sha256:${'b'.repeat(64)}`,
        },
      }),
      'PUT /v1/templates/other/owner': () => ({
        status: 403,
        body: { error: 'forbidden', message: 'transferring a template requires the admin role' },
      }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(
      await sbxMain(['templates', 'edit', 'node22', '--visibility', 'private'], env, io, opts),
    ).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { visibility: 'private' } });
    expect(io.outs.join('')).toContain('node22: visibility changed');
    io.outs.length = 0;
    expect(
      await sbxMain(['templates', 'edit', 'node22', '--description', 'Node'], env, io, opts),
    ).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ body: { description: 'Node' } });
    expect(io.outs.join('')).toContain('node22: unchanged');
    io.outs.length = 0;
    expect(await sbxMain(['templates', 'transfer', 'node22', 'github:9'], env, io, opts)).toBe(0);
    expect(cp.calls.at(-1)).toMatchObject({ method: 'PUT', body: { owner: 'github:9' } });
    expect(io.outs.join('')).toContain('node22: owner github:9 (was github:1)');
    // A refusal is reported with its code (exit 1).
    expect(await sbxMain(['templates', 'transfer', 'other', 'github:9'], env, io, opts)).toBe(1);
    expect(io.errs.join('\n')).toMatch(/forbidden|admin role/);
    // Usage errors, before any request.
    const n = cp.calls.length;
    expect(await sbxMain(['templates', 'edit', 'node22'], env, io, opts)).toBe(2);
    expect(io.errs.join('\n')).toMatch(/templates edit needs --visibility or --description/);
    expect(
      await sbxMain(['templates', 'edit', 'node22', '--visibility', 'public'], env, io, opts),
    ).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--visibility must be private or deployment/);
    expect(await sbxMain(['ls', '--visibility', 'private'], env, io, opts)).toBe(2);
    expect(await sbxMain(['templates', 'show', 'x', '--description', 'd'], env, io, opts)).toBe(2);
    expect(await sbxMain(['templates', 'transfer', 'node22'], env, io, opts)).toBe(2);
    expect(
      await sbxMain(['templates', 'edit', 'a', 'b', '--description', 'd'], env, io, opts),
    ).toBe(2);
    expect(cp.calls.length).toBe(n);
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

  it('waits while the template activates (§6.4): retries a 409 template_not_active after its Retry-After', async () => {
    const { home, env, io } = setup();
    let n = 0;
    const cp = fakeCp({
      'POST /v1/sandboxes': () =>
        ++n < 3
          ? {
              status: 409,
              body: {
                error: 'template_not_active',
                message: "template 'node22' is activating; its activation has started",
                readiness: 'activating',
              },
              headers: { 'retry-after': '30' },
            }
          : { status: 201, body: sandbox() },
    });
    const { rt, api } = openSbxRuntime(URL_, env, { home, fetchImpl: cp.fetchImpl });
    const slept: number[] = [];
    let t = 0;
    rt.sleep = async (ms: number) => {
      slept.push(ms);
      t += ms;
    };
    rt.now = () => t;
    const s = await createWaitingForActivation(
      { rt, api, url: URL_, io, json: false },
      { template: 'node22' },
    );
    expect(s.id).toBe(SBX);
    expect(n).toBe(3);
    expect(slept).toEqual([30_000, 30_000]);
    expect(io.errs.join('')).toContain(
      "sbx: template 'node22' is activating; its activation has started; retrying in 30 s",
    );
  });

  it('gives up waiting for an activation after 10 minutes, with the refusal', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'POST /v1/sandboxes': () => ({
        status: 409,
        body: { error: 'template_not_active', message: 'activating', readiness: 'activating' },
        headers: { 'retry-after': '30' },
      }),
    });
    const { rt, api } = openSbxRuntime(URL_, env, { home, fetchImpl: cp.fetchImpl });
    let t = 0;
    rt.sleep = async (ms: number) => {
      t += ms;
    };
    rt.now = () => t;
    const err = await createWaitingForActivation(
      { rt, api, url: URL_, io, json: false },
      { template: 'node22' },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'template_not_active' });
    // 10 minutes of 30 s waits: the first try and 20 retries.
    expect(cp.calls.length).toBe(21);
  });

  it('does not wait on any other refusal of a create', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'POST /v1/sandboxes': () => ({
        status: 409,
        body: { error: 'no_active_slot', message: 'full', readiness: 'unavailable' },
        headers: { 'retry-after': '60' },
      }),
    });
    const { rt, api } = openSbxRuntime(URL_, env, { home, fetchImpl: cp.fetchImpl });
    const err = await createWaitingForActivation(
      { rt, api, url: URL_, io, json: false },
      { template: 'node22' },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'no_active_slot' });
    expect(cp.calls.length).toBe(1);
  });

  it('creates from the default template without --template (spec §6.1), and refuses a malformed --label', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({ 'POST /v1/sandboxes': () => ({ status: 201, body: sandbox() }) });
    expect(await sbxMain(['create'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    expect(cp.calls[0]!.body).toEqual({ template: 'default' });
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
    expect(out).toMatch(new RegExp(`${SBX}\\s+web\\s+node22\\s+per-exec\\s+ready`));
    expect(out).toMatch(/sbx-dead\s+-\s+node22\s+per-exec\s+terminated \(deleted\)/);
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
    // --force: this control plane mints no token, so the unpulled check (sbx-up.test.ts) is skipped.
    expect(await sbxMain(['rm', '--force', SBX], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(
      0,
    );
    // Delete is not immediate (SBX0 §5.4): the line says how long issued tokens keep working.
    expect(io.errs.join('\n')).toBe(
      `deleted ${SBX}; tokens already issued stop working within one token lifetime plus 30 s ` +
        '(15.5 minutes by default)',
    );
  });

  it('rm sends sandbox_deleted before DELETE for a lease sandbox, and not for per-exec', async () => {
    for (const mode of ['lease', 'lease+processes', 'per-exec']) {
      const { home, env, io } = setup();
      const order: string[] = [];
      const cp = fakeCp({
        [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ mode }) }),
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
        [`DELETE /v1/sandboxes/${SBX}`]: () => {
          order.push('DELETE');
          return { status: 200, body: { id: SBX, state: 'terminated', reason: 'deleted' } };
        },
      });
      const lease = fakeLease((op) => {
        order.push(op);
        return { mode: 'lease', epochKnown: true, state: 'none', ageMs: 0, idleTimeoutS: 0 };
      });
      let closed = 0;
      const execFactory: ExecFactory = () => ({
        exec: async () => {
          throw new Error('no command runs in this test');
        },
        close: () => void closed++,
        leaseControl: lease.leaseControl,
        leaseKeepalive: lease.leaseKeepalive,
      });
      expect(
        await sbxMain(['rm', '--force', SBX], env, io, {
          home,
          fetchImpl: cp.fetchImpl,
          execFactory,
        }),
      ).toBe(0);
      expect(order).toEqual(mode === 'per-exec' ? ['DELETE'] : ['sandbox_deleted', 'DELETE']);
      expect(closed).toBe(mode === 'per-exec' ? 0 : 1);
    }
    // Best effort: a lease call that fails, or a record that cannot be read, still deletes.
    for (const broken of ['lease', 'get'] as const) {
      const { home, env, io } = setup();
      const cp = fakeCp({
        [`GET /v1/sandboxes/${SBX}`]: () =>
          broken === 'get'
            ? { status: 500, body: { error: 'internal', message: 'boom' } }
            : { status: 200, body: sandbox({ mode: 'lease' }) },
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
        [`DELETE /v1/sandboxes/${SBX}`]: () => ({
          status: 200,
          body: { id: SBX, state: 'terminated', reason: 'deleted' },
        }),
      });
      const lease = fakeLease(() => new LeaseControlError('unavailable', 'no worker'));
      const execFactory: ExecFactory = () => ({
        exec: async () => {
          throw new Error('no command runs in this test');
        },
        close: () => {},
        ...lease,
      });
      expect(
        await sbxMain(['rm', '--force', SBX], env, io, {
          home,
          fetchImpl: cp.fetchImpl,
          execFactory,
        }),
      ).toBe(0);
      expect(cp.calls.at(-1)).toMatchObject({ method: 'DELETE' });
      expect(io.errs.join('\n')).toMatch(/^deleted /);
    }
  });

  it("rm bounds sandbox_deleted's wait at 15 s, then deletes; Ctrl-C during it deletes nothing", async () => {
    const world = () => {
      const s = setup();
      const cp = fakeCp({
        [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ mode: 'lease' }) }),
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
        [`DELETE /v1/sandboxes/${SBX}`]: () => ({
          status: 200,
          body: { id: SBX, state: 'terminated', reason: 'deleted' },
        }),
      });
      const leaseCalls: string[] = [];
      const execFactory: ExecFactory = () => ({
        exec: async () => {
          throw new Error('no command runs in this test');
        },
        close: () => {},
        // The worker blocks sandbox_deleted (up to grace_limit): only an abort ends this call.
        leaseControl: (op, _t, o) =>
          new Promise((_res, rej) => {
            leaseCalls.push(op);
            o?.signal?.addEventListener('abort', () =>
              rej(new LeaseControlError('cancelled', 'cancelled on client')),
            );
          }),
        leaseKeepalive: async () => {},
      });
      return { ...s, cp, leaseCalls, execFactory };
    };
    // The bound passes (the sleep seam answers once the call is waiting): the DELETE goes ahead.
    const w = world();
    const slept: number[] = [];
    expect(
      await sbxMain(['rm', '--force', SBX], w.env, w.io, {
        home: w.home,
        fetchImpl: w.cp.fetchImpl,
        execFactory: w.execFactory,
        sleep: async (ms) => {
          slept.push(ms);
          await vi.waitFor(() => expect(w.leaseCalls).toHaveLength(1));
        },
      }),
    ).toBe(0);
    expect(slept).toEqual([15_000]);
    expect(w.leaseCalls).toEqual(['sandbox_deleted']);
    expect(w.cp.calls.at(-1)).toMatchObject({ method: 'DELETE' });
    // Ctrl-C while it waits: no DELETE, said so, exit 130.
    const x = world();
    const ac = new AbortController();
    const p = sbxMain(['rm', '--force', SBX], x.env, x.io, {
      home: x.home,
      fetchImpl: x.cp.fetchImpl,
      execFactory: x.execFactory,
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(x.leaseCalls).toHaveLength(1));
    ac.abort();
    expect(await p).toBe(130);
    expect(x.cp.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(x.io.errs.join('\n')).toContain('nothing was deleted');
  });

  it("rm's 15 s bound covers the record read and the token mint too; Ctrl-C there deletes nothing (review #4569829061)", async () => {
    const world = (hang: 'get' | 'token') => {
      const s = setup();
      const cp = fakeCp({
        [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ mode: 'lease' }) }),
        [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
        [`DELETE /v1/sandboxes/${SBX}`]: () => ({
          status: 200,
          body: { id: SBX, state: 'terminated', reason: 'deleted' },
        }),
      });
      const hung: string[] = [];
      // A control plane that never answers the record read (or the mint): only an abort ends it.
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        const method = init?.method ?? 'GET';
        const slow =
          hang === 'get'
            ? method === 'GET' && u.pathname === `/v1/sandboxes/${SBX}`
            : method === 'POST' && u.pathname === `/v1/sandboxes/${SBX}/token`;
        if (!slow) return cp.fetchImpl(input, init);
        hung.push(`${method} ${u.pathname}`);
        return new Promise<Response>((_res, rej) => {
          const stop = () => rej(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) stop();
          init?.signal?.addEventListener('abort', stop, { once: true });
        });
      }) as typeof fetch;
      const execFactory: ExecFactory = () => ({
        exec: async () => {
          throw new Error('no command runs in this test');
        },
        close: () => {},
        ...fakeLease(() => ({
          mode: 'lease',
          epochKnown: true,
          state: 'none',
          ageMs: 0,
          idleTimeoutS: 0,
        })),
      });
      return { ...s, cp, fetchImpl, hung, execFactory };
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const hang of ['get', 'token'] as const) {
        const w = world(hang);
        const p = sbxMain(['rm', '--force', SBX], w.env, w.io, {
          home: w.home,
          fetchImpl: w.fetchImpl,
          execFactory: w.execFactory,
        });
        await vi.waitFor(() => expect(w.hung).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await p, hang).toBe(0);
        expect(w.cp.calls.at(-1), hang).toMatchObject({ method: 'DELETE' });
        expect(w.io.errs.join('\n')).toMatch(/^deleted /);
      }
      // Ctrl-C while the record read hangs: no DELETE, said so, exit 130.
      const x = world('get');
      const ac = new AbortController();
      const p = sbxMain(['rm', '--force', SBX], x.env, x.io, {
        home: x.home,
        fetchImpl: x.fetchImpl,
        execFactory: x.execFactory,
        signal: ac.signal,
      });
      await vi.waitFor(() => expect(x.hung).toHaveLength(1));
      ac.abort();
      expect(await p).toBe(130);
      expect(x.cp.calls.some((c) => c.method === 'DELETE')).toBe(false);
      expect(x.io.errs.join('\n')).toContain('nothing was deleted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rm forgets the sandbox\'s seen notices, the "already gone" path too', async () => {
    for (const gone of [false, true]) {
      const s = setup();
      const file = join(s.paths.stateDir, 'sbx', 'notices.json');
      mkdirSync(join(s.paths.stateDir, 'sbx'), { recursive: true });
      writeFileSync(file, JSON.stringify({ [SBX]: 1, 'sbx-other': 2 }));
      const cp = fakeCp({
        [`DELETE /v1/sandboxes/${SBX}`]: () =>
          gone
            ? { status: 404, body: { error: 'sandbox_not_found', message: 'no such sandbox' } }
            : { status: 200, body: { id: SBX, state: 'terminated', reason: 'deleted' } },
      });
      // Bound here, from this control plane: its 404 is "already gone".
      const r = mkdtempSync(join(tmpdir(), 'sbx-rm-'));
      mkdirSync(join(r, '.sbx'));
      writeFileSync(
        join(r, '.sbx/sandbox.json'),
        JSON.stringify({ id: SBX, controlPlaneUrl: URL_ }),
      );
      expect(
        await sbxMain(['rm', '--force', '--keep-config', SBX], s.env, s.io, {
          home: s.home,
          fetchImpl: cp.fetchImpl,
          cwd: r,
        }),
      ).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'sbx-other': 2 });
    }
  });

  it('ls shows MODE', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      'GET /v1/sandboxes': () => ({
        status: 200,
        body: {
          sandboxes: [
            sandbox(),
            sandbox({ id: 'sbx-lease', name: 'l', mode: 'lease+processes', modeEpoch: 2 }),
          ],
        },
      }),
    });
    expect(await sbxMain(['ls'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
    const lines = io.outs.join('').split('\n');
    expect(lines[0]).toMatch(new RegExp(`^${SBX}\\s+web\\s+node22\\s+per-exec\\s+ready\\s`));
    expect(lines[1]).toMatch(/^sbx-lease\s+l\s+node22\s+lease\+processes\s+ready\s/);
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
    expect(io.outs.join('')).toBe(`${TOKEN.token}\n`);
  });

  it('token --renew-every: a fresh token per period, one line each, until stopped', async () => {
    const { home, env, io } = setup();
    let n = 0;
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 200,
        body: { ...TOKEN, token: `${TOKEN.token}${n++}` },
      }),
    });
    const ac = new AbortController();
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 2) ac.abort();
    };
    const deps = { home, fetchImpl: cp.fetchImpl, sleep, signal: ac.signal };
    expect(await sbxMain(['token', SBX, '--renew-every', '600'], env, io, deps)).toBe(0);
    expect(io.outs.join('')).toBe(`${TOKEN.token}0\n${TOKEN.token}1\n`);
    expect(slept).toEqual([600_000, 600_000]);
    // Only on token, and only a whole number of seconds, at least 1: refused before any request.
    const calls = cp.calls.length;
    const d = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['ls', '--renew-every', '5'], env, io, d)).toBe(2);
    expect(await sbxMain(['token', SBX, '--renew-every', '0'], env, io, d)).toBe(2);
    expect(await sbxMain(['token', SBX, '--renew-every', '1.5'], env, io, d)).toBe(2);
    expect(io.errs.join('\n')).toContain('--renew-every must be a whole number of seconds');
    expect(cp.calls.length).toBe(calls);
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
    expect(out).not.toContain(TOKEN.token); // never the token itself: it lives 15 minutes
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

  describe('one runtime, one client (R5i)', () => {
    it("the runtime's control-plane client is the SandboxApiClient, and it reads no harness URL", async () => {
      const { home, paths } = setup();
      saveConfig(paths, { ...DEFAULT_CONFIG, harnessUrl: 'https://h-config.example.invalid' });
      const { rt, api } = openSbxRuntime(
        URL_,
        { HOME: home, SH_HARNESS_URL: 'https://h-env.example.invalid' },
        { home },
      );
      expect(rt.cp).toBe(api);
      expect(api).toBeInstanceOf(SandboxApiClient);
      expect(rt.endpoints).toEqual({ controlPlaneUrl: URL_ });
      expect(rt.harness).toBeUndefined();
      expect(rt.transcripts).toBeUndefined();
    });

    it('logout revokes the refresh token and deletes sbx-auth.json, leaving auth.json alone', async () => {
      const { home, env, paths, io } = setup();
      saveAuth(paths, { ...LOGIN, controlPlaneUrl: MOCA_URL, apiToken: 'api-moca' });
      const cp = fakeCp({ 'POST /v1/auth/revoke': () => ({ status: 200, body: {} }) });
      expect(await sbxMain(['logout'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
      expect(cp.calls).toEqual([
        expect.objectContaining({ path: '/v1/auth/revoke', body: { token: 'mrt_x' } }),
      ]);
      expect(existsSync(sbxPaths(paths).authFile)).toBe(false);
      expect(loadAuth(paths, MOCA_URL)?.apiToken).toBe('api-moca');
      expect(io.errs.join('\n')).toContain('logged out of the sandbox service');
    });

    it('logout still deletes the local login when the control plane cannot be told (exit 1)', async () => {
      const { home, env, paths, io } = setup();
      const cp = fakeCp({ 'POST /v1/auth/revoke': () => new TypeError('fetch failed') });
      expect(await sbxMain(['logout'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
      expect(existsSync(sbxPaths(paths).authFile)).toBe(false);
      expect(io.errs.join('\n')).toMatch(/did not confirm/);
    });

    it("logout leaves another control plane's login in place and names it", async () => {
      const { home, env, paths, io } = setup({ loggedIn: false });
      const OTHER = 'https://sbx-other.example.invalid';
      saveAuth(sbxPaths(paths), { ...LOGIN, controlPlaneUrl: OTHER });
      const cp = fakeCp({});
      expect(await sbxMain(['logout'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
      expect(cp.calls).toEqual([]);
      expect(loadAuth(sbxPaths(paths), OTHER)?.apiToken).toBe('api-1'); // untouched
      const msg = io.errs.join('\n');
      expect(msg).toContain(`not logged in to ${URL_}`);
      expect(msg).toContain(`is for ${OTHER}, left in place`);
      expect(msg).toContain(`mocactl sbx logout --control-plane-url '${OTHER}'`);
    });

    it('logout with no login says so and exits 0, asking nothing', async () => {
      const { home, env, io } = setup({ loggedIn: false });
      const cp = fakeCp({});
      expect(await sbxMain(['logout'], env, io, { home, fetchImpl: cp.fetchImpl })).toBe(0);
      expect(cp.calls).toEqual([]);
      expect(io.errs.join('\n')).toContain('not logged in to the sandbox service');
    });

    it.each(['login', 'logout', 'env'])(
      'refuses --json on %s (exit 2), before any request',
      async (cmd) => {
        const { home, env, io } = setup();
        const cp = fakeCp({});
        const argv = cmd === 'env' ? [cmd, SBX, '--json'] : [cmd, '--json'];
        expect(await sbxMain(argv, env, io, { home, fetchImpl: cp.fetchImpl })).toBe(2);
        expect(io.errs.join('\n')).toContain(`${cmd} has no --json output`);
        expect(cp.calls).toEqual([]);
      },
    );

    it('the device prompt is the one mocactl login shows', async () => {
      const { home, io } = setup({ loggedIn: false });
      const cp = fakeCp({
        'GET /v1/discovery': () => ({ status: 200, body: SBX_DISCOVERY }),
        'POST /v1/auth/device': () => ({ status: 200, body: DEVICE }),
        'POST /v1/auth/device/token': () => ({ status: 200, body: loginBody('api-n', 'github:7') }),
      });
      await sbxMain(['login', '--control-plane-url', URL_], { HOME: home }, io, {
        home,
        fetchImpl: cp.fetchImpl,
      });
      const expected: string[] = [];
      devicePrompt({ out: () => {}, err: (s) => expected.push(s) })(DEVICE, 1);
      expect(io.errs).toContain(expected[0]);
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
    expect(out).toMatch(/node22\s+per-exec\s+terminated\s+\d{4}-/);
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
