import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ApiError, TurnCancelledError } from '../src/api/errors.js';
import { App, CLEAR_SCREEN, initialOverlay } from '../src/app.js';
import { loadAuth, loadConfig, saveAuth } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';
import { json } from './helpers/fake-fetch.js';
import { credential, doneFrame, fakeControlPlane, fakeHarness } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor } from './helpers/ink.js';
import { fakeOs, testRuntime } from './helpers/runtime.js';

const opts = { setup: false, noAnimation: true };

/**
 * ink-testing-library's stdout is not a TTY, so Ink is never interactive under it and
 * suspendTerminal() hands nothing over. This renders App on TTY-like fakes with interactive: true,
 * so raw mode really is released for the editor and can be observed through `rawMode`.
 */
function mountInteractive(rt: Runtime) {
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 40,
    frames: [] as string[],
    // Honour the Writable callback: Ink 8 awaits `write('', cb)` to flush the redraw when
    // suspendTerminal() resumes, so a fake that drops it never gives the terminal back.
    write(s: string, ...rest: unknown[]) {
      stdout.frames.push(s);
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    },
  });
  const rawMode: boolean[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    data: null as string | null,
    setRawMode: (on: boolean) => void rawMode.push(on),
    setEncoding: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    read: () => {
      const d = stdin.data;
      stdin.data = null;
      return d;
    },
    write(s: string) {
      stdin.data = s;
      stdin.emit('readable');
    },
  });
  const os = fakeOs();
  const write = vi.fn();
  const instance = inkRender(<App rt={rt} opts={opts} env={{}} os={os} write={write} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  onTestFinished(() => instance.unmount());
  const all = () => stdout.frames.join('');
  const until = (cond: () => boolean) => waitFor(cond, 1500, () => all().slice(-2000));
  return { stdin, os, write, rawMode, all, until };
}

const sessionList = (...ids: string[]) =>
  fakeControlPlane({
    listCredentials: async () => [credential('anthropic')],
    listSessions: async () => ({
      sessions: ids.map((sessionId) => ({
        sessionId,
        owner: 'github:1',
        tenant: 't',
        createdAt: 0,
        state: 'active' as const,
        lastTurnAt: null,
        turns: 1,
      })),
      nextCursor: null,
    }),
  });

/** A fetch that answers the onboarding probe per path; anything unlisted is a 500. */
function routedFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const route = routes[new URL(String(input)).pathname];
    return route ? route() : json({ error: 'internal_error' }, 500);
  }) as typeof fetch;
}
const never = () => new Promise<Response>(() => undefined);

function mount(rt: Runtime, over: Partial<typeof opts> = {}) {
  const write = vi.fn();
  const os = fakeOs();
  const r = render(<App rt={rt} opts={{ ...opts, ...over }} env={{}} os={os} write={write} />);
  const all = () => r.frames.join('\n');
  const frame = () => r.lastFrame() ?? '';
  const until = (cond: () => boolean, ms = 1500) => waitFor(cond, ms, r.lastFrame);
  // The chat input is ready once its placeholder is painted and Ink is listening to stdin.
  const ready = () => until(() => inputReady(r.stdin) && frame().includes('type a message'));
  return { ...r, write, os, all, frame, until, ready };
}

async function send(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(KEY.enter);
  await tick();
}

describe('initialOverlay', () => {
  it('chooses onboarding, then login, then nothing', () => {
    expect(initialOverlay(testRuntime({ endpoints: {} }), opts)).toEqual({ name: 'onboarding' });
    expect(initialOverlay(testRuntime(), { ...opts, setup: true })).toEqual({ name: 'onboarding' });
    expect(initialOverlay(testRuntime({ auth: null }), opts)).toEqual({ name: 'login' });
    expect(initialOverlay(testRuntime(), opts)).toBeUndefined();
  });
});

describe('App', () => {
  it('opens onboarding on a first run', () => {
    expect(mount(testRuntime({ endpoints: {} })).lastFrame()).toContain('Welcome to mocactl');
  });

  it('onboarding persists the endpoints it connected to and moves on', async () => {
    const rt = testRuntime({
      endpoints: {},
      config: { ...testRuntime().config, controlPlaneUrl: undefined, harnessUrl: undefined },
      // Onboarding rewires real clients on this fetch.
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/healthz' || path === '/health') return json({ ok: true });
        if (path === '/v1/discovery') return json({ harnessUrl: 'http://h2/' });
        if (path === '/v1/credentials') return json({ credentials: [credential('anthropic')] });
        return json({ error: 'internal_error' }, 500);
      }) as typeof fetch,
    });
    // A login already cached for the new control plane, so onboarding skips its login step.
    saveAuth(rt.paths, { ...rt.auth!, controlPlaneUrl: 'http://cp2' });
    const { stdin, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('Server URL'));
    stdin.write('http://cp2');
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('New session'));
    // Only the URL the user gave is saved: the harness is the control plane's to advertise, so a
    // moved harness is followed on the next launch instead of pinned in config.json.
    const saved = loadConfig(rt.paths).config;
    expect(saved.controlPlaneUrl).toBe('http://cp2');
    expect(saved.harnessUrl).toBeUndefined();
    expect(rt.endpoints).toEqual({ controlPlaneUrl: 'http://cp2' });
    expect(await rt.harness!.baseUrl()).toBe('http://h2');
    // createSession fails (500): the error screen has no input of its own, and Esc still closes it.
    await until(() => frame().includes('unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('New session') && frame().includes('type a message'));
  });

  it.each([
    ['null fields', { keybinds: null, presets: null, lastUsed: null }],
    ['wrongly typed fields', { keybinds: { quit: 5 }, presets: [{ name: 1 }], lastUsed: [] }],
  ])('survives a hand-edited config.json with %s and still starts a session', async (_, bad) => {
    const base = testRuntime();
    mkdirSync(base.paths.configDir, { recursive: true });
    writeFileSync(
      base.paths.configFile,
      JSON.stringify({ controlPlaneUrl: 'http://cp', harnessUrl: 'http://h', ...bad }),
    );
    const loaded = loadConfig(base.paths);
    const rt = testRuntime({
      paths: base.paths,
      config: loaded.config,
      configWarning: loaded.warning,
      harness: fakeHarness([
        { frames: [{ type: 'text', delta: 'still works' }, doneFrame('s-new')] },
      ]),
    });
    const { stdin, all, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('ignoring invalid keybinds'));
    await send(stdin, 'hi');
    await until(() => all().includes('still works'));
  });

  it('onboarding with a trailing-slash control-plane URL caches the login under the saved URL', async () => {
    const rt = testRuntime({
      endpoints: {},
      auth: null,
      config: { ...testRuntime().config, controlPlaneUrl: undefined, harnessUrl: undefined },
      fetchImpl: routedFetch({
        '/healthz': () => json({ ok: true }),
        '/health': () => json({ ok: true }),
        '/v1/discovery': () => json({ harnessUrl: 'http://h2' }),
        '/v1/auth/device': () =>
          json({
            deviceCode: 'd',
            userCode: 'ABCD-1234',
            verificationUri: 'https://github.com/login/device',
            interval: 0,
            expiresIn: 900,
          }),
        '/v1/auth/device/token': () =>
          json({ token: 'fresh', subject: 'github:1', expiresAt: 4_000_000_000 }), // notsecret
        '/v1/credentials': () => json({ credentials: [credential('anthropic')] }),
      }),
    });
    const { stdin, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('Server URL'));
    stdin.write('http://cp2/');
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('New session'));
    expect(loadConfig(rt.paths).config.controlPlaneUrl).toBe('http://cp2');
    // What the next launch does: look the login up under the URL config.json now holds.
    expect(loadAuth(rt.paths, 'http://cp2')?.apiToken).toBe('fresh');
  });

  it('shows the server-supplied display name in the status line terminal-safe', async () => {
    const base = testRuntime();
    const rt = testRuntime({
      auth: { ...base.auth!, displayName: 'Ada\u001b]52;c;c2VjcmV0\u0007\u001b[8mX' },
    });
    const { frame, all, ready } = mount(rt);
    await ready();
    expect(frame()).toContain('Ada');
    expect(all()).not.toMatch(/\u001b\]|\u001b\[8m|\u0007|c2VjcmV0/);
  });

  it('opens login when the cached login is missing', async () => {
    const { frame, until } = mount(testRuntime({ auth: null }));
    await until(() => frame().includes('Log in with GitHub'));
  });

  it('a first message creates a session and streams the reply', async () => {
    const rt = testRuntime({
      harness: fakeHarness([
        {
          frames: [
            { type: 'text', delta: 'Hello ' },
            { type: 'text', delta: 'world' },
            doneFrame('s-new'),
          ],
        },
      ]),
    });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi there');
    await until(() => all().includes('Hello world'));
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls.filter((c) => c === 'createSession')).toHaveLength(1);
    expect((rt.harness as unknown as { turns: unknown[] }).turns).toHaveLength(1);
    expect(all()).toContain('› hi there');
    expect(frame()).toContain('hi there'); // the auto title, in the status line
    expect(loadConfig(rt.paths).config.lastUsed).toEqual({ inferenceCredential: 'anthropic' });
  });

  const skillsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-app-promote-'));
    mkdirSync(join(dir, '.claude/skills/hello'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/skills/hello/SKILL.md'),
      '---\nname: hello\ndescription: d\n---\nx\n',
    );
    return dir;
  };

  it('/promote attaches the bundle to the next session only', async () => {
    const dir = skillsDir();
    const created: Array<{ configRef?: string }> = [];
    const rt = testRuntime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('anthropic')],
        createSession: async (req) => (
          created.push(req),
          { sessionId: `s-${created.length}`, token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
      harness: fakeHarness([{ frames: [doneFrame('s-1')] }, { frames: [doneFrame('s-2')] }]),
    });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, `/promote ${dir}`);
    await until(() => all().includes('config bundle sha256:'));
    await until(() => created.length === 1);
    expect(created[0]!.configRef).toMatch(/^sha256:/);
    await until(() => !frame().includes('New session'));
    await tick();
    await send(stdin, '/new');
    await until(() => created.length === 2);
    expect(created[1]!.configRef).toBeUndefined();
  });

  it('/promote toasts skills, commands and the warning count with the --dry-run hint', async () => {
    const dir = skillsDir();
    mkdirSync(join(dir, '.claude/commands'), { recursive: true });
    writeFileSync(join(dir, '.claude/commands/go.md'), 'go');
    const outside = mkdtempSync(join(tmpdir(), 'mocactl-app-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'x');
    symlinkSync(join(outside, 'secret.md'), join(dir, '.claude/skills/hello/leak.md'));
    const rt = testRuntime({
      cp: fakeControlPlane({ listCredentials: async () => [credential('a'), credential('b')] }),
    });
    const { stdin, all, until, ready } = mount(rt);
    await ready();
    await send(stdin, `/promote ${dir}`);
    // The toast wraps (even inside the path) at the test terminal's width, so compare unspaced.
    const flat = () => all().replace(/\s+/g, '');
    const want =
      `promoted 1 skill, 1 command — uploaded; 1 warning — run ` +
      `\`mocactl promote ${dir} --dry-run\` to see it`;
    await until(() => flat().includes(want.replace(/\s+/g, '')));
  });

  it('/promote --clear drops the pending bundle without creating a session', async () => {
    const dir = skillsDir();
    const created: Array<{ configRef?: string }> = [];
    const rt = testRuntime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('a'), credential('b')],
        createSession: async (req) => (
          created.push(req),
          { sessionId: `s-${created.length}`, token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
    });
    const { stdin, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, `/promote ${dir}`);
    await until(() => frame().includes('config bundle sha256:') && frame().includes('Inference'));
    await tick();
    stdin.write(KEY.escape);
    await until(() => !frame().includes('New session'));
    await tick();
    await send(stdin, '/promote --clear');
    await until(() => frame().includes('config bundle dropped'));
    expect(created).toHaveLength(0);
    await send(stdin, '/new');
    await until(() => frame().includes('Inference'));
    expect(frame()).not.toContain('config bundle sha256:');
    await tick();
    stdin.write(KEY.enter);
    await until(() => created.length === 1);
    expect(created[0]!.configRef).toBeUndefined();
  });

  it('/promote with an expired login opens Login, warns, and does not reopen New Session', async () => {
    const dir = skillsDir();
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('anthropic')],
      putConfigBundle: async () => {
        throw new ApiError('control-plane', 401, 'token_expired');
      },
      pollDeviceAuth: async () => ({
        token: 'a2',
        subject: 'github:1',
        displayName: 'Ada',
        expiresAt: 4_000_000_000,
      }),
    });
    const rt = testRuntime({ cp });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, `/promote ${dir}`);
    await until(() => all().includes('Log in with GitHub'));
    await until(() => all().includes('your login expired — log in, then run /promote again'));
    await until(() => rt.auth?.apiToken === 'a2' && !frame().includes('Log in with GitHub'));
    await tick();
    expect(frame()).not.toContain('New session');
    expect(all()).not.toContain('config bundle sha256:');
    expect(cp.calls).toContain('putConfigBundle');
    expect(cp.calls).not.toContain('createSession');
  });

  it('/promote of a bad directory notifies and creates nothing', async () => {
    const rt = testRuntime();
    const { stdin, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/promote /definitely/not/here');
    await until(() => frame().includes('no .claude/skills'));
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls).not.toContain('putConfigBundle');
    expect(calls).not.toContain('createSession');
    await send(stdin, '/promote --clear');
    await until(() => frame().includes('no config bundle pending'));
  });

  it('runs slash commands and reports unknown ones', async () => {
    const rt = testRuntime();
    const { stdin, frame, write, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/details');
    await until(() => rt.config.details === true);
    expect(loadConfig(rt.paths).config.details).toBe(true);
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN);
    await send(stdin, '/frobnicate');
    await until(() => frame().includes('unknown command /frobnicate'));
  });

  it('/thinking and /theme persist to config.json and redraw', async () => {
    const rt = testRuntime();
    const { stdin, frame, write, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/thinking');
    await until(() => loadConfig(rt.paths).config.thinking === false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(CLEAR_SCREEN);
    await send(stdin, '/theme');
    await until(() => frame().includes('theme: dark'));
    expect(loadConfig(rt.paths).config.theme).toBe('dark');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('opens the sessions overlay with the ctrl+x l leader chord', async () => {
    const { stdin, frame, until, ready } = mount(testRuntime());
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => frame().includes('Sessions'));
  });

  it('Esc cancels a running turn', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'thinking hard' }], hang: true }]),
    });
    const { stdin, all, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('thinking hard'));
    stdin.write(KEY.escape);
    await until(() => all().includes('cancelled'));
  });

  it('a second Esc within a second clears the queue before the next prompt is sent', async () => {
    const rt = testRuntime({
      harness: fakeHarness([
        { frames: [{ type: 'text', delta: 'first' }], hang: true },
        { frames: [{ type: 'text', delta: 'second' }], hang: true },
      ]),
    });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'one');
    await until(() => all().includes('first'));
    await send(stdin, 'two');
    await send(stdin, 'three');
    await until(() => frame().includes('queued: 2'));
    stdin.write(KEY.escape);
    await until(() => all().includes('cancelled'));
    stdin.write(KEY.escape);
    await until(() => frame().includes('queue cleared') && frame().includes('idle'));
    // Neither queued prompt was sent: the first Esc's cancel paused the queue for the second.
    expect((rt.harness as unknown as { turns: unknown[] }).turns).toHaveLength(1);
    expect(all()).not.toContain('second');
  });

  it('resuming a session with no local history says so', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => ({
        sessions: [
          {
            sessionId: 'remote-1',
            owner: 'github:1',
            tenant: 't',
            createdAt: 0,
            state: 'active',
            lastTurnAt: null,
            turns: 3,
          },
        ],
        nextCursor: null,
      }),
    });
    const { stdin, all, write, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => inputReady(stdin) && frame().includes('remote-1'));
    await tick();
    stdin.write(KEY.enter);
    await until(() => all().includes("isn't available on this device"));
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN);
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(1);
  });

  it('Esc closes an overlay stuck on an error screen', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => {
        throw new ApiError('control-plane', 503, 'redis_unavailable');
      },
    });
    const { stdin, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => frame().includes('control plane is unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('control plane is unavailable'));
    expect(frame()).toContain('type a message');
  });

  it('Esc closes the credentials overlay from its error screen', async () => {
    const cp = fakeControlPlane({
      listCredentials: async () => {
        throw new ApiError('control-plane', 503, 'redis_unavailable');
      },
    });
    const { stdin, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    await send(stdin, '/credentials');
    await until(() => frame().includes('control plane is unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('control plane is unavailable'));
  });

  it('diagnoses an untrusted harness instead of asking to log in again', async () => {
    const bad = new ApiError('harness', 401, 'token_invalid');
    const { stdin, frame, until, ready } = mount(
      testRuntime({ harness: fakeHarness([{ error: bad }, { error: bad }]) }),
    );
    await ready();
    await send(stdin, 'hi');
    await until(() => frame().includes('run /doctor'));
    expect(frame()).not.toContain('Log in with GitHub');
  });

  it('opens login when the API token expires mid-session, then re-sends the prompt', async () => {
    let mints = 0;
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('anthropic')],
      mintSessionToken: async () => {
        mints++;
        throw new ApiError('control-plane', 401, 'token_expired');
      },
      pollDeviceAuth: async () => ({
        token: 'a2',
        subject: 'github:1',
        displayName: 'Ada',
        expiresAt: 4_000_000_000,
      }),
    });
    const harness = fakeHarness([
      { error: new ApiError('harness', 401, 'token_expired') },
      { frames: [{ type: 'text', delta: 'replayed' }, doneFrame('s-new')] },
    ]);
    const rt = testRuntime({ cp, harness });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi');
    // The fake approves on the first poll, so Login can be gone by the next sample: check every frame.
    await until(() => all().includes('Log in with GitHub'));
    expect(mints).toBe(1);
    // The device flow completes (pollDeviceAuth approves on the first poll).
    await until(() => all().includes('replayed'));
    expect(rt.auth?.apiToken).toBe('a2');
    expect(harness.turns.map((t) => t.prompt)).toEqual(['hi', 'hi']);
    // The replay re-runs the turn, not the prompt (the view side is in use-session.test.tsx).
    await until(() => frame().includes('idle'));
    expect(rt.transcripts?.load('s-new')?.prompts).toEqual(['hi']);
  });

  it('an expired login met by the sessions overlay opens Login, then reopens and lists', async () => {
    const expired = () => new ApiError('control-plane', 401, 'token_expired');
    let rt!: Runtime;
    const listed = sessionList('remote-1');
    const cp = fakeControlPlane({
      listSessions: async (o) => {
        if (rt.auth?.apiToken !== 'a2') throw expired();
        return listed.listSessions(o);
      },
      pollDeviceAuth: async () => ({
        token: 'a2',
        subject: 'github:1',
        displayName: 'Ada',
        expiresAt: 4_000_000_000,
      }),
    });
    rt = testRuntime({ cp });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    // Login is transient here (the fake approves on the first poll): check every frame, not the last.
    await until(() => all().includes('Log in with GitHub'));
    // The device flow approves on the first poll; the Sessions overlay comes back and lists.
    await until(() => frame().includes('remote-1'));
    expect(frame()).toContain('Sessions');
    expect(rt.auth?.apiToken).toBe('a2');
    expect(cp.calls.filter((c) => c === 'listSessions')).toHaveLength(2);
  });

  it('after Esc on the startup Login, the next control-plane action opens Login again', async () => {
    let approve = false;
    let rt!: Runtime;
    const cp = fakeControlPlane({
      listCredentials: async () => {
        if (!rt.auth) throw new ApiError('control-plane', 401, 'token_required');
        return [credential('anthropic')];
      },
      pollDeviceAuth: async () =>
        approve
          ? { token: 'a2', subject: 'github:1', displayName: 'Ada', expiresAt: 4_000_000_000 }
          : 'pending',
    });
    rt = testRuntime({
      auth: null,
      cp,
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'made it' }, doneFrame('s-new')] }]),
    });
    const { stdin, all, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('ABCD-1234'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('Log in with GitHub'));
    await until(() => inputReady(stdin) && frame().includes('type a message'));
    approve = true;
    await send(stdin, 'hi'); // New Session lists credentials: token_required
    await until(() => all().includes('made it'));
    expect(rt.auth?.apiToken).toBe('a2');
    expect(cp.calls.filter((c) => c === 'startDeviceAuth')).toHaveLength(2);
    expect(cp.calls.filter((c) => c === 'createSession')).toHaveLength(1);
    expect(all()).toContain('› hi');
  });

  it('rings the bell when a turn ends after 10 s of input idleness', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = fakeHarness([], {
      async *streamTurn() {
        await gate;
        yield doneFrame('s-new');
      },
    });
    const { stdin, write, frame, until, ready } = mount(testRuntime({ harness, now: () => clock }));
    await ready();
    await send(stdin, 'slow one');
    await until(() => frame().includes('waiting for harness'));
    clock += 11_000;
    release();
    await until(() => write.mock.calls.some(([s]) => s === '\u0007'));
  });

  it('does not ring the bell when the input was used recently', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = fakeHarness([], {
      async *streamTurn() {
        await gate;
        yield doneFrame('s-new');
      },
    });
    const { stdin, write, frame, until, ready } = mount(testRuntime({ harness, now: () => clock }));
    await ready();
    await send(stdin, 'slow one');
    await until(() => frame().includes('waiting for harness'));
    clock += 11_000;
    stdin.write('x'); // typing, not submitting, still counts as input activity
    await tick();
    release();
    await until(() => frame().includes('idle'));
    expect(write.mock.calls.some(([s]) => s === '\u0007')).toBe(false);
  });

  it('copies the last reply through the OS clipboard', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'copy me' }, doneFrame('s-new')] }]),
    });
    const { stdin, os, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi');
    await until(() => all().includes('copy me') && frame().includes('idle'));
    await send(stdin, '/copy');
    await until(() => os.copy.mock.calls.length > 0);
    expect(os.copy).toHaveBeenCalledTimes(1);
    expect(os.copy).toHaveBeenCalledWith('copy me');
  });

  it('shows a toast instead of crashing when the editor cannot start', async () => {
    const rt = testRuntime();
    const { stdin, os, frame, until, ready } = mount(rt);
    os.editText.mockImplementation(() => {
      throw new Error('could not start editor "nope": command not found (exit 127)');
    });
    await ready();
    await send(stdin, '/editor');
    await until(() => frame().includes('could not start editor'));
    expect(frame()).toContain('type a message');
  });

  it('sends what was composed in the editor', async () => {
    const rt = testRuntime();
    const { stdin, all, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/editor');
    await until(() => all().includes('› from the editor'));
  });

  it('unmounting (ctrl+c included) cancels the turn in flight', async () => {
    const harness = fakeHarness([
      { frames: [{ type: 'text', delta: 'thinking hard' }], hang: true },
    ]);
    const { stdin, all, until, ready, unmount } = mount(testRuntime({ harness }));
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('thinking hard'));
    expect(harness.turns[0].signal?.aborted).toBe(false);
    unmount();
    expect(harness.turns[0].signal?.aborted).toBe(true);
  });

  it('switching sessions cancels the first one and drops its queue', async () => {
    const harness = fakeHarness([
      { frames: [{ type: 'text', delta: 'thinking hard' }], hang: true },
      { frames: [{ type: 'text', delta: 'must never run' }, doneFrame('s-new')] },
    ]);
    // A positive signal instead of a fixed wait: the first turn's stream has fully unwound.
    let firstStreamDone = false;
    const streamTurn = harness.streamTurn.bind(harness);
    harness.streamTurn = async function* (args) {
      try {
        yield* streamTurn(args);
      } finally {
        firstStreamDone = true;
      }
    };
    const { stdin, all, frame, until, ready } = mount(
      // No double-Esc pause, so a wrong next POST would follow the cancel on microtasks alone.
      testRuntime({ cp: sessionList('remote-1'), harness, cancelPauseMs: 0 }),
    );
    await ready();
    await send(stdin, 'first');
    await until(() => all().includes('thinking hard'));
    await send(stdin, 'queued');
    await until(() => frame().includes('queued: 1'));
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => inputReady(stdin) && frame().includes('remote-1'));
    await tick();
    stdin.write(KEY.enter);
    await until(() => all().includes("isn't available on this device"));
    await until(() => harness.turns[0].signal?.aborted === true && firstStreamDone);
    // From there to a (wrong) next POST is microtasks only: the cancelled turn-end, the drain loop
    // re-checking its queue, and streamTurn. One macrotask flushes them all, so it is not a race.
    await tick(0);
    expect(harness.turns).toHaveLength(1);
    expect(all()).not.toContain('must never run');
  });

  it('does not ring the bell for a cancelled turn', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = fakeHarness([], {
      // eslint-disable-next-line require-yield
      async *streamTurn() {
        await gate;
        throw new TurnCancelledError();
      },
    });
    const { stdin, write, all, until, ready } = mount(testRuntime({ harness, now: () => clock }));
    await ready();
    await send(stdin, 'slow one');
    clock += 11_000;
    release();
    await until(() => all().includes('cancelled'));
    await tick();
    expect(write.mock.calls.some(([s]) => s === '\u0007')).toBe(false);
  });

  it('Esc during a pending onboarding probe restores the working setup and closes', async () => {
    const rt = testRuntime({ fetchImpl: routedFetch({ '/healthz': never, '/health': never }) });
    const original = { cp: rt.cp, harness: rt.harness, endpoints: rt.endpoints };
    const { stdin, frame, until } = mount(rt, { setup: true });
    await until(() => inputReady(stdin) && frame().includes('Server URL'));
    stdin.write('2'); // http://cp -> http://cp2
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('connecting'));
    expect(rt.endpoints.controlPlaneUrl).toBe('http://cp2'); // applied in memory for the probe
    await tick();
    stdin.write(KEY.escape);
    await until(
      () => !frame().includes('Welcome to mocactl') && frame().includes('type a message'),
    );
    expect(rt.endpoints).toBe(original.endpoints);
    expect(rt.cp).toBe(original.cp);
    expect(rt.harness).toBe(original.harness);
    expect(loadConfig(rt.paths).config.controlPlaneUrl).toBeUndefined();
  });

  it('Esc during a first-run probe exits, since nothing is configured', async () => {
    const rt = testRuntime({
      endpoints: {},
      config: { ...testRuntime().config, controlPlaneUrl: undefined, harnessUrl: undefined },
      fetchImpl: routedFetch({ '/healthz': never, '/v1/discovery': never }),
    });
    const { stdin, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('Server URL'));
    stdin.write('http://cp2');
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('connecting'));
    await tick();
    stdin.write(KEY.escape);
    // Exiting unmounts Ink, which stops listening to stdin.
    await until(() => !inputReady(stdin));
    expect(rt.endpoints).toEqual({});
  });

  it('a failed onboarding probe persists nothing', async () => {
    const rt = testRuntime({
      endpoints: {},
      config: { ...testRuntime().config, controlPlaneUrl: undefined, harnessUrl: undefined },
      fetchImpl: routedFetch({
        '/healthz': () => json({ ok: true }),
        '/v1/discovery': () => json({ harnessUrl: 'http://bad-harness' }),
      }), // /health -> 500
    });
    const { stdin, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('Server URL'));
    stdin.write('http://cp2');
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('harness:'));
    expect(frame()).toContain('Welcome to mocactl');
    const saved = loadConfig(rt.paths).config;
    expect(saved.controlPlaneUrl).toBeUndefined();
    expect(saved.harnessUrl).toBeUndefined();
    expect(rt.config.harnessUrl).toBeUndefined();
  });

  it('runs the editor with the terminal handed over, and takes it back after', async () => {
    const { stdin, os, rawMode, all, until } = mountInteractive(testRuntime());
    let rawDuringEdit: boolean | undefined;
    os.editText.mockImplementation(() => {
      rawDuringEdit = rawMode.at(-1);
      return 'from the editor';
    });
    await until(() => rawMode.at(-1) === true && all().includes('type a message'));
    await send(stdin, '/editor');
    await until(() => all().includes('› from the editor'));
    expect(os.editText).toHaveBeenCalledTimes(1);
    expect(rawDuringEdit).toBe(false);
    expect(rawMode.at(-1)).toBe(true);
  });

  it('exports the transcript and opens it with the terminal handed over', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'reply' }, doneFrame('s-new')] }]),
    });
    const { stdin, os, rawMode, write, all, until } = mountInteractive(rt);
    let rawDuringEdit: boolean | undefined;
    os.openInEditor.mockImplementation(() => {
      rawDuringEdit = rawMode.at(-1);
    });
    await until(() => rawMode.at(-1) === true && all().includes('type a message'));
    await send(stdin, 'hi');
    await until(() => all().includes('reply') && all().includes('idle'));
    write.mockClear();
    await send(stdin, '/export');
    await until(() => all().includes('exported to'));
    expect(os.openInEditor).toHaveBeenCalledTimes(1);
    expect(os.openInEditor.mock.calls[0][0]).toMatch(/s-new\.md$/);
    expect(rawDuringEdit).toBe(false);
    expect(rawMode.at(-1)).toBe(true);
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN);
  });

  it('shows a toast when the export editor cannot start', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'reply' }, doneFrame('s-new')] }]),
    });
    const { stdin, os, all, frame, until, ready } = mount(rt);
    os.openInEditor.mockImplementation(() => {
      throw new Error('could not start editor "nope": command not found (exit 127)');
    });
    await ready();
    await send(stdin, 'hi');
    await until(() => all().includes('reply') && frame().includes('idle'));
    await send(stdin, '/export');
    await until(() => frame().includes('export failed: could not start editor'));
  });
});

describe('leaving a running detachable turn', () => {
  const turnF = { type: 'turn' as const, turnId: 't1', sessionId: 's-new' };
  const running = () =>
    fakeHarness([
      {
        frames: [turnF, { type: 'text', delta: 'working' }],
        ids: ['t1:1-0', 't1:2-0'],
        hang: true,
      },
    ]);
  // Exiting unmounts Ink, which stops listening to stdin (as the first-run Esc test relies on).

  it('ctrl+c asks; k keeps the turn running and exits', async () => {
    const harness = running();
    const { stdin, all, frame, until, ready } = mount(testRuntime({ harness }));
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('working'));
    stdin.write(KEY.ctrl('c'));
    await until(() => inputReady(stdin) && frame().includes('a turn is running'));
    stdin.write('k');
    await until(() => !inputReady(stdin));
    expect(harness.cancels).toEqual([]);
    expect(harness.turns[0]!.signal?.aborted).toBe(true); // stopped reading, nothing more
  });

  it('c cancels through the route, then exits', async () => {
    const harness = running();
    const { stdin, all, frame, until, ready } = mount(testRuntime({ harness }));
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('working'));
    stdin.write(KEY.ctrl('c'));
    await until(() => inputReady(stdin) && frame().includes('a turn is running'));
    stdin.write('c');
    await until(() => !inputReady(stdin));
    expect(harness.cancels).toMatchObject([{ turnId: 't1' }]);
  });

  it('a failed cancel stays, and says so once', async () => {
    const harness = fakeHarness(
      [
        {
          frames: [turnF, { type: 'text', delta: 'working' }],
          ids: ['t1:1-0', 't1:2-0'],
          hang: true,
        },
      ],
      {
        cancelTurn: async () => {
          throw new ApiError('harness', 503, 'redis_unavailable');
        },
      },
    );
    const { stdin, all, frame, until, ready } = mount(testRuntime({ harness }));
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('working'));
    stdin.write(KEY.ctrl('c'));
    await until(() => inputReady(stdin) && frame().includes('a turn is running'));
    stdin.write('c');
    await until(
      () => frame().includes("couldn't cancel") && !frame().includes('a turn is running'),
    );
    expect(frame().split("couldn't cancel")).toHaveLength(2); // the chat notice, no extra toast
    expect(inputReady(stdin)).toBe(true); // still running, still here
    expect(harness.turns[0]!.signal?.aborted).toBe(false);
  });

  it('a non-detachable turn quits on ctrl+c without asking', async () => {
    const harness = fakeHarness([{ frames: [{ type: 'text', delta: 'working' }], hang: true }]);
    const { stdin, all, until, ready } = mount(testRuntime({ harness }));
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('working'));
    stdin.write(KEY.ctrl('c'));
    await until(() => !inputReady(stdin));
    expect(all()).not.toContain('a turn is running');
    expect(harness.turns[0]!.signal?.aborted).toBe(true);
  });

  it('ctrl+c in an overlay still quits', async () => {
    const { stdin, frame, until, ready } = mount(testRuntime());
    await ready();
    await send(stdin, '/help');
    await until(() => inputReady(stdin) && frame().includes('Help'));
    stdin.write(KEY.ctrl('c'));
    await until(() => !inputReady(stdin));
  });

  it('resume attaches with the transcript last id and shows the rest of the turn', async () => {
    const rt = testRuntime({
      cp: sessionList('remote-1'),
      harness: fakeHarness([], {}, [
        {
          frames: [
            { type: 'turn', turnId: 't1', sessionId: 'remote-1' },
            { type: 'text', delta: 'the rest' },
            doneFrame('remote-1'),
          ],
          ids: ['t1:1-0', 't1:3-0', 't1:4-0'],
        },
      ]),
    });
    rt.transcripts!.appendPrompt('remote-1', 'go');
    rt.transcripts!.appendFrame(
      'remote-1',
      { type: 'turn', turnId: 't1', sessionId: 'remote-1' },
      't1:1-0',
    );
    rt.transcripts!.appendFrame('remote-1', { type: 'text', delta: 'the start ' }, 't1:2-0');
    rt.transcripts!.flush('remote-1');
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    // With local history the list shows the transcript's title, not the id.
    await until(() => inputReady(stdin) && frame().includes('local history'));
    await tick();
    stdin.write(KEY.enter);
    await until(() => all().includes('the rest'));
    const harness = rt.harness as unknown as { attaches: Array<{ lastEventId?: string }> };
    expect(harness.attaches[0]!.lastEventId).toBe('t1:2-0');
    expect(all()).not.toContain("isn't running"); // the attach found the turn: no #472 notice
  });
});
