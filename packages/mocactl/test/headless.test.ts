import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadAuth, resolvePaths, saveAuth } from '../src/config.js';
import { HarnessUntrustedError } from '../src/core/session-manager.js';
import {
  cmdAuthToken,
  cmdDoctor,
  cmdLogin,
  cmdLogout,
  cmdPromote,
  cmdRun,
  type Io,
} from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';
import { ApiError } from '../src/api/errors.js';
import type { ControlPlaneApi } from '../src/api/types.js';
import { testRuntime } from './helpers/runtime.js';
import { credential, doneFrame, fakeControlPlane, fakeHarness } from './helpers/fakes.js';

function io(): Io & { stdout: string; stderr: string[] } {
  const o = {
    stdout: '',
    stderr: [] as string[],
    out: (s: string) => void (o.stdout += s),
    err: (s: string) => void o.stderr.push(s),
  };
  return o;
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mocactl-promote-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const skill = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;

function runtime(over: Partial<Runtime> = {}): Runtime {
  const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-rt-')));
  return {
    paths,
    config: { ...DEFAULT_CONFIG },
    configExists: true,
    endpoints: { controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' },
    auth: {
      apiToken: 'a',
      subject: 'github:1',
      roles: [],
      expiresAt: 4_000_000_000,
      controlPlaneUrl: 'http://cp',
    },
    cp: fakeControlPlane({ listCredentials: async () => [credential('anthropic')] }),
    harness: fakeHarness([
      {
        frames: [
          { type: 'text', delta: 'Hello' },
          { type: 'text', delta: ' world' },
          doneFrame('s-new'),
        ],
      },
    ]),
    now: () => 1_000_000_000_000,
    sleep: async () => undefined,
    fetchImpl: fetch,
    ...over,
  };
}

describe('cmdRun', () => {
  it('streams text to stdout and exits 0', async () => {
    const o = io();
    expect(await cmdRun(runtime(), o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(o.stdout).toBe('Hello world\n');
    expect(o.stderr).toContain('session s-new');
  });

  it('emits newline-delimited frames with --json, starting with the session', async () => {
    const o = io();
    await cmdRun(runtime(), o, { prompt: 'hi', options: {}, json: true });
    const lines = o.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'session', sessionId: 's-new' });
    expect(lines.map((l) => l.type)).toEqual(['session', 'text', 'text', 'done']);
  });

  it('asks for --option when several inference credentials exist', async () => {
    const o = io();
    const rt = runtime({
      cp: fakeControlPlane({ listCredentials: async () => [credential('a'), credential('b')] }),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(2);
    expect(o.stderr.join('\n')).toContain('--option inferenceCredential=<value>: a, b');
  });

  it('names a rejected --option credential, terminal-safe, listing the declared ones', async () => {
    const o = io();
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('a'), credential('b')],
    });
    expect(
      await cmdRun(runtime({ cp }), o, {
        prompt: 'hi',
        options: { inferenceCredential: 'zz\u001b[2J' },
        json: false,
      }),
    ).toBe(2);
    const err = o.stderr.join('\n');
    expect(err).toContain("unknown inference credential 'zz'; declared: a, b");
    expect(err).not.toContain('\u001b');
    expect(cp.calls).not.toContain('createSession');
  });

  it('uses the credential named with --option', async () => {
    let asked: unknown;
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('a'), credential('b')],
        createSession: async (req) => (
          (asked = req),
          { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
    });
    expect(
      await cmdRun(rt, io(), { prompt: 'hi', options: { inferenceCredential: 'b' }, json: false }),
    ).toBe(0);
    expect(asked).toEqual({ credentials: { inference: 'b' } });
  });

  it('is blocked with a hint when the server refuses a session without an inference credential', async () => {
    const o = io();
    const cp = fakeControlPlane({
      createSession: async () => {
        throw new ApiError(
          'control-plane',
          400,
          'credential_required',
          'no credential with consumer: inference',
        );
      },
    });
    expect(await cmdRun(runtime({ cp }), o, { prompt: 'hi', options: {}, json: false })).toBe(2);
    expect(o.stderr.join('\n')).toContain('add an inference credential to start');
  });

  it('asks the server for a session with no credential of its own, for the operator fallback (#368)', async () => {
    const o = io();
    const requests: unknown[] = [];
    const cp = fakeControlPlane({
      createSession: async (req) => {
        requests.push(req);
        return { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 };
      },
    });
    expect(await cmdRun(runtime({ cp }), o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(requests).toEqual([{}]);
  });

  it('leaves the sandbox tier to the server default when none was chosen (P6.3)', async () => {
    const o = io();
    const requests: unknown[] = [];
    const cp = fakeControlPlane({
      discovery: async () => ({
        harnessUrl: 'http://h',
        sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
      }),
      listCredentials: async () => [credential('anthropic')],
      createSession: async (req) => {
        requests.push(req);
        return { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 };
      },
    });
    expect(await cmdRun(runtime({ cp }), o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(requests).toEqual([{ credentials: { inference: 'anthropic' } }]);
    expect(requests[0]).not.toHaveProperty('sandbox');
  });

  it('refuses an undeclared tier locally, listing the declared ones (P6.3)', async () => {
    const o = io();
    const cp = fakeControlPlane({
      discovery: async () => ({
        harnessUrl: 'http://h',
        sandboxTiers: { names: ['container', 'microvm'], default: 'container' },
      }),
      listCredentials: async () => [credential('anthropic')],
    });
    expect(
      await cmdRun(runtime({ cp }), o, {
        prompt: 'hi',
        options: { sandboxTier: 'gpu' },
        json: false,
      }),
    ).toBe(2);
    // It says the given value was rejected, rather than asking as though none had been given.
    expect(o.stderr.join('\n')).toContain(
      "unknown sandbox tier 'gpu'; declared: container, microvm",
    );
    expect(o.stderr.join('\n')).not.toContain('choose the');
    expect(cp.calls).not.toContain('createSession');
  });

  it('refuses to run without a valid login', async () => {
    const o = io();
    expect(
      await cmdRun(runtime({ auth: null }), o, { prompt: 'hi', options: {}, json: false }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/not logged in/);
  });

  it('resumes an existing session with --session', async () => {
    const rt = runtime();
    await cmdRun(rt, io(), { prompt: 'hi', session: 's1', options: {}, json: false });
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls).toContain('mintSessionToken');
    expect(calls).not.toContain('createSession');
  });

  it('strips escape sequences from reply text written to the terminal', async () => {
    const o = io();
    const rt = runtime({
      harness: fakeHarness([
        {
          frames: [
            { type: 'text', delta: 'a\u001b]52;c;' },
            { type: 'text', delta: 'c2VjcmV0\u0007b' },
            doneFrame('s-new'),
          ],
        },
      ]),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(o.stdout).not.toMatch(/[\u0007\u001b]/);
    expect(o.stdout).toMatch(/^a.*b\n$/); // a split sequence leaves printable residue only
  });

  it('exits 1 with a readable message when the turn fails', async () => {
    const o = io();
    const bad = new ApiError('harness', 401, 'token_invalid');
    const rt = runtime({ harness: fakeHarness([{ error: bad }, { error: bad }]) });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(1);
    expect(o.stderr).toContain(new HarnessUntrustedError().message);
    // Headless, the fix is a command the user can run from this shell, not a slash command.
    expect(o.stderr.join('\n')).toContain('`mocactl doctor`');
  });

  it('exits 130 when cancelled', async () => {
    const ac = new AbortController();
    const rt = runtime({ harness: fakeHarness([{ hang: true }]) });
    const p = cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await p).toBe(130);
  });

  it('exits 130 without running a turn when cancelled during session setup', async () => {
    const ac = new AbortController();
    const harness = fakeHarness([{ frames: [doneFrame('s-new')] }]);
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('anthropic')],
        createSession: async () => {
          ac.abort();
          return { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 };
        },
      }),
      harness,
    });
    expect(
      await cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, signal: ac.signal }),
    ).toBe(130);
    expect(harness.turns).toEqual([]);
  });
});

describe('cmdDoctor', () => {
  it('prints the checks and exits 0 when all pass', async () => {
    const o = io();
    expect(await cmdDoctor(runtime(), o, false)).toBe(0);
    expect(o.stdout.trim().split('\n')).toHaveLength(7);
  });

  it('exits 1 and prints JSON on failure with --json', async () => {
    const o = io();
    expect(await cmdDoctor(runtime({ auth: null }), o, true)).toBe(1);
    expect(JSON.parse(o.stdout).at(-1)).toMatchObject({ id: 3, status: 'fail' });
  });
});

describe('cmdLogin', () => {
  it('prints the code, stores the login, and exits 0', async () => {
    const o = io();
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({
        pollDeviceAuth: async () => ({
          token: 'new-api',
          subject: 'github:9',
          roles: [],
          expiresAt: 4_000_000_000,
        }),
      }),
    });
    expect(await cmdLogin(rt, o)).toBe(0);
    expect(o.stderr[0]).toContain('ABCD-1234');
    // #431: say how long the code lasts, from the server's expiresIn (900 s in the fake).
    expect(o.stderr[0]).toContain('valid for 15 minutes');
    expect(loadAuth(rt.paths, 'http://cp')?.apiToken).toBe('new-api');
    expect(rt.transcripts).toBeDefined();
  });

  it('prints a new code when the first expires, and logs in with it', async () => {
    let n = 0;
    const o = io();
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({
        startDeviceAuth: async () => {
          n += 1;
          return {
            deviceCode: `d${n}`,
            userCode: `CODE-000${n}`,
            verificationUri: 'https://github.com/login/device',
            interval: 5,
            expiresIn: 600,
          };
        },
        pollDeviceAuth: async (dc) =>
          dc === 'd1'
            ? 'expired'
            : { token: 'new-api', subject: 'github:9', roles: [], expiresAt: 4_000_000_000 },
      }),
    });
    expect(await cmdLogin(rt, o)).toBe(0);
    expect(o.stderr[0]).toContain('CODE-0001');
    expect(o.stderr[0]).toContain('valid for 10 minutes');
    expect(o.stderr[1]).toMatch(/expired/);
    expect(o.stderr[1]).toContain('CODE-0002');
    expect(loadAuth(rt.paths, 'http://cp')?.apiToken).toBe('new-api');
  });

  it('says to run `mocactl login` again when the re-issued code expires too, and exits 1', async () => {
    const o = io();
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({ pollDeviceAuth: async () => 'expired' }),
    });
    expect(await cmdLogin(rt, o)).toBe(1);
    expect(o.stderr.at(-1)).toContain('run `mocactl login` again');
  });

  it('exits 2 without a control-plane URL', async () => {
    expect(await cmdLogin(runtime({ cp: undefined, endpoints: {} }), io())).toBe(2);
  });

  it('strips escape sequences from the code and URL printed to stderr', async () => {
    const o = io();
    const hostileCode = 'ABCD\u001b[8m-1234';
    const hostileUri = 'https://github.com\u001b]52;c;ZXZpbA==\u0007/login/device';
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({
        startDeviceAuth: async () => ({
          deviceCode: 'd',
          userCode: hostileCode,
          verificationUri: hostileUri,
          interval: 5,
          expiresIn: 900,
        }),
        pollDeviceAuth: async () => ({
          token: 'new-api',
          subject: 'github:9',
          roles: [],
          expiresAt: 4_000_000_000,
        }),
      }),
    });
    expect(await cmdLogin(rt, o)).toBe(0);
    expect(o.stderr[0]).not.toMatch(/[\u0007\u001b]/);
    expect(o.stderr[0]).toContain('https://github.com/login/device');
    expect(o.stderr[0]).toContain('ABCD-1234');
  });

  it('exits 130 quietly when cancelled during the device-flow poll', async () => {
    const ac = new AbortController();
    const o = io();
    const rt = runtime({
      auth: null,
      sleep: async () => {
        ac.abort();
      },
    });
    expect(await cmdLogin(rt, o, ac.signal)).toBe(130);
    expect(o.stderr.join('\n')).not.toContain('login failed');
  });
});

describe('cmdPromote', () => {
  it('uploads, prints the digest and exits 0', async () => {
    const o = io();
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    expect(await cmdPromote(runtime(), o, { dir: p, json: false })).toBe(0);
    expect(o.stdout).toMatch(/sha256:[0-9a-f]{64}/);
    expect(o.stdout).toContain('hello');
  });

  it('prints the report to stderr BEFORE uploading', async () => {
    const o = io();
    const outside = project({ 'secret.md': 'x' });
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    symlinkSync(join(outside, 'secret.md'), join(p, '.claude/skills/hello/leak.md'));
    let stderrAtUpload = '';
    const rt = runtime({
      cp: fakeControlPlane({
        putConfigBundle: async (req) => (
          (stderrAtUpload = o.stderr.join('\n')),
          { digest: req.digest, uploaded: true }
        ),
      }),
    });
    expect(await cmdPromote(rt, o, { dir: p, json: false })).toBe(0);
    expect(stderrAtUpload).toContain('skill_symlink_escaped');
  });

  it('--dry-run builds and prints without uploading or logging in, and exits 0', async () => {
    const o = io();
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    const cp = fakeControlPlane();
    const rt = runtime({ cp, auth: undefined });
    expect(await cmdPromote(rt, o, { dir: p, json: false, dryRun: true })).toBe(0);
    expect(cp.calls).not.toContain('putConfigBundle');
    expect(o.stdout).toMatch(/sha256:[0-9a-f]{64}  \(dry run: not uploaded\)/);
    expect(o.stdout).toContain('hello');
  });

  it('--dry-run --json reports dryRun and uploaded: false', async () => {
    const o = io();
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    await cmdPromote(runtime(), o, { dir: p, json: true, dryRun: true });
    expect(JSON.parse(o.stdout)).toMatchObject({ uploaded: false, dryRun: true });
  });

  it('exits with the PromoteError code', async () => {
    const o = io();
    expect(await cmdPromote(runtime(), o, { dir: '/definitely/not/here', json: false })).toBe(1);
    expect(o.stderr.join('\n')).toContain('no .claude/skills');
  });

  it('prints one JSON object with --json', async () => {
    const o = io();
    const p = project({ '.claude/skills/hello/SKILL.md': skill('hello') });
    await cmdPromote(runtime(), o, { dir: p, json: true });
    expect(JSON.parse(o.stdout)).toMatchObject({ uploaded: true, skills: ['hello'] });
  });
});

describe('cmdRun --config', () => {
  it('creates the session with configRef', async () => {
    const created: unknown[] = [];
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('anthropic')],
        createSession: async (req) => (
          created.push(req),
          { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
    });
    const digest = 'sha256:' + 'a'.repeat(64);
    expect(
      await cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, configRef: digest }),
    ).toBe(0);
    expect(created[0]).toMatchObject({ configRef: digest });
  });

  it('forwards an empty configRef so the server refuses it', async () => {
    const created: unknown[] = [];
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('anthropic')],
        createSession: async (req) => (
          created.push(req),
          { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
    });
    await cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, configRef: '' });
    expect(created[0]).toMatchObject({ configRef: '' });
  });
});

describe('mocactl auth token (the hook contract, B14 §5.3)', () => {
  const H12 = 12 * 3_600_000;

  /** A runtime whose login is on disk, as after `mocactl login`, then 12 h asleep. */
  function slept(over: Partial<ControlPlaneApi> = {}) {
    const loginAt = 1_800_000_000_000;
    const rt = testRuntime({ now: () => loginAt + H12 });
    const auth = {
      apiToken: 'api-old',
      subject: 'github:1',
      roles: [],
      expiresAt: Math.floor(loginAt / 1000) + 900,
      controlPlaneUrl: 'http://cp',
      refreshToken: 'mrt_old',
      refreshExpiresAt: Math.floor(loginAt / 1000) + 90 * 86_400,
    };
    saveAuth(rt.paths, auth);
    rt.auth = auth;
    rt.cp = fakeControlPlane({
      refreshAuth: async () => ({
        token: 'api-new',
        subject: 'github:1',
        roles: [],
        expiresAt: Math.floor((loginAt + H12) / 1000) + 900,
        refreshToken: 'mrt_new',
        refreshExpiresAt: auth.refreshExpiresAt,
      }),
      ...over,
    });
    return rt;
  }

  it('ACCEPTANCE 1: after 12 h asleep, prints a fresh token with no device flow', async () => {
    const rt = slept();
    const o = io();
    expect(await cmdAuthToken(rt, o, false)).toBe(0);
    expect(o.stdout).toBe('api-new\n');
    expect((rt.cp as ReturnType<typeof fakeControlPlane>).calls).not.toContain('startDeviceAuth');
    expect(loadAuth(rt.paths, 'http://cp')?.refreshToken).toBe('mrt_new');
  });

  it('--json prints token, expiresAt and subject', async () => {
    const o = io();
    expect(await cmdAuthToken(slept(), o, true)).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      token: 'api-new',
      expiresAt: Math.floor((1_800_000_000_000 + H12) / 1000) + 900,
      subject: 'github:1',
    });
  });

  it('exits 3 when a login is required, never prompting', async () => {
    const rt = slept({
      refreshAuth: async () => {
        throw new ApiError('control-plane', 400, 'invalid_grant');
      },
    });
    const o = io();
    expect(await cmdAuthToken(rt, o, false)).toBe(3);
    expect(o.stdout).toBe('');
    expect(o.stderr.join('')).toMatch(/mocactl login/);
    expect((rt.cp as ReturnType<typeof fakeControlPlane>).calls).not.toContain('startDeviceAuth');
  });

  it('exits 4 when the control plane is unreachable', async () => {
    const rt = slept({
      refreshAuth: async () => {
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    expect(await cmdAuthToken(rt, io(), false)).toBe(4);
  });
});

describe('mocactl logout', () => {
  function loggedIn(over: Partial<ControlPlaneApi> = {}) {
    const rt = testRuntime();
    const auth = { ...rt.auth!, refreshToken: 'mrt_cur' };
    saveAuth(rt.paths, auth);
    rt.auth = auth;
    const revoked: string[] = [];
    rt.cp = fakeControlPlane({
      revokeAuth: async (t) => void revoked.push(t),
      ...over,
    });
    return { rt, revoked };
  }

  it('revokes this login on the server, then deletes auth.json', async () => {
    const { rt, revoked } = loggedIn();
    expect(await cmdLogout(rt, io(), { all: false })).toBe(0);
    expect(revoked).toEqual(['mrt_cur']);
    expect(loadAuth(rt.paths, 'http://cp')).toBeNull();
    expect(rt.auth).toBeNull();
  });

  it('--all revokes every login of the subject', async () => {
    const { rt } = loggedIn({ revokeAllAuth: async () => 3 });
    const o = io();
    expect(await cmdLogout(rt, o, { all: true })).toBe(0);
    expect((rt.cp as ReturnType<typeof fakeControlPlane>).calls).toContain('revokeAllAuth');
    expect(o.stderr.join('')).toMatch(/3 logins/);
  });

  it('still logs out locally when the server cannot be told, and says what that leaves', async () => {
    const { rt } = loggedIn({
      revokeAuth: async () => {
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const o = io();
    expect(await cmdLogout(rt, o, { all: false })).toBe(1);
    expect(loadAuth(rt.paths, 'http://cp')).toBeNull();
    expect(o.stderr.join('')).toMatch(/mocactl login.*logout --all/);
  });

  it('--all refreshes an expired API token before revoking every login', async () => {
    const rt = testRuntime();
    const nowSec = Math.floor(rt.now() / 1000);
    const auth = {
      ...rt.auth!,
      expiresAt: nowSec - 60,
      refreshToken: 'mrt_cur',
      refreshExpiresAt: nowSec + 86_400,
    };
    saveAuth(rt.paths, auth);
    rt.auth = auth;
    rt.cp = fakeControlPlane({
      refreshAuth: async () => ({
        token: 'api-new',
        subject: 'github:1',
        roles: [],
        expiresAt: nowSec + 900,
        refreshToken: 'mrt_new',
        refreshExpiresAt: auth.refreshExpiresAt,
      }),
      revokeAllAuth: async () => 2,
    });
    expect(await cmdLogout(rt, io(), { all: true })).toBe(0);
    const calls = (rt.cp as ReturnType<typeof fakeControlPlane>).calls;
    expect(calls.indexOf('refreshAuth')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('refreshAuth')).toBeLessThan(calls.indexOf('revokeAllAuth'));
    expect(loadAuth(rt.paths, 'http://cp')).toBeNull();
  });
});
