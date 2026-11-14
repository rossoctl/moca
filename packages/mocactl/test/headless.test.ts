import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadAuth, resolvePaths, saveAuth } from '../src/config.js';
import { HarnessUntrustedError } from '../src/core/session-manager.js';
import {
  cmdAuthToken,
  cmdDoctor,
  cmdLogin,
  cmdLogout,
  COPY_TIMEOUT_MS,
  devicePrompt,
  cmdPromote,
  cmdRun,
  HEADLESS_CAPACITY_WAIT_MS,
  type Io,
} from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';
import { ApiError } from '../src/api/errors.js';
import type { ControlPlaneApi } from '../src/api/types.js';
import { toolSummary } from '../src/render/tools.js';
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

  it("prints a templated turn's seed origin and workspace patch on its terminal frame with --json", async () => {
    const o = io();
    const sandbox = {
      id: 'w-1',
      tier: 'microvm',
      seed: { source: 'build' as const, buildId: 'sha256:' + 'b'.repeat(64) },
    };
    const workspace = { baseline: 'abc', patch: 'diff\n', patchSha256: 'sha256:x', patchBytes: 5 };
    const rt = runtime({
      harness: fakeHarness([{ frames: [{ ...doneFrame('s-new'), sandbox, workspace }] }]),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: true })).toBe(0);
    const last = JSON.parse(o.stdout.trim().split('\n').at(-1)!);
    expect(last).toMatchObject({ type: 'done', sandbox, workspace });
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

  it('names a rejected --option model, the deployment default as the empty value (final review F3)', async () => {
    const o = io();
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('a')],
      listModels: async () => ({ credential: 'a', models: [{ id: 'm1' }, { id: 'm2' }] }),
    });
    expect(
      await cmdRun(runtime({ cp }), o, { prompt: 'hi', options: { model: 'gpt-x' }, json: false }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toContain(
      "unknown model 'gpt-x'; declared: m1, m2 (or empty for the deployment default)",
    );
  });

  it('sends an undeclared --option sandboxTemplate (id@build), and waits out template_not_active', async () => {
    const asked: unknown[] = [];
    const pin = 'django-django-11133@sha256:' + 'c'.repeat(64);
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('a')],
      discovery: async () =>
        ({
          harnessUrl: null,
          sandboxTiers: null,
          sandboxTemplates: [{ id: 'matplotlib-matplotlib-23476', description: '', tools: [] }],
        }) as never,
      createSession: async (req) => {
        asked.push(req);
        if (asked.length === 1)
          throw new ApiError('control-plane', 409, 'template_not_active', 'activating', 1);
        return { sessionId: 's-pin', token: 'st', expiresAt: 4_000_000_000 };
      },
    });
    const o = io();
    expect(
      await cmdRun(runtime({ cp }), o, {
        prompt: 'hi',
        options: { sandboxTemplate: pin },
        json: false,
      }),
    ).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ sandbox: { template: pin } });
    expect(o.stderr.join('\n')).toContain("the session's template is activating; retrying in 1 s");
  });

  it('reports unknown_template and template_retired from the control plane as given', async () => {
    for (const [status, code, msg] of [
      [400, 'unknown_template', 'no such template (GET /v1/templates lists them)'],
      [410, 'template_retired', "template 'x' build sha256:… is retired"],
    ] as const) {
      const o = io();
      const cp = fakeControlPlane({
        listCredentials: async () => [credential('a')],
        createSession: async () => {
          throw new ApiError('control-plane', status, code, msg);
        },
      });
      expect(
        await cmdRun(runtime({ cp }), o, {
          prompt: 'hi',
          options: { sandboxTemplate: 'x@sha256:' + 'd'.repeat(64) },
          json: false,
        }),
      ).toBe(1);
      expect(o.stderr.join('\n')).toContain(msg);
    }
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

  it('refuses an empty --session instead of starting a new session', async () => {
    const o = io();
    const rt = runtime();
    expect(await cmdRun(rt, o, { prompt: 'hi', session: '', options: {}, json: false })).toBe(2);
    expect(o.stderr.join('\n')).toContain('--session needs a session id');
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls).not.toContain('createSession');
    expect(calls).not.toContain('mintSessionToken');
  });

  it("prints the harness's reason beside 'no capacity', terminal-safe", async () => {
    const o = io();
    const busy = new ApiError(
      'harness',
      503,
      'sandbox_unavailable',
      "no attached sandbox in sandbox tier 'container'\u001b[2J",
      5,
    );
    const rt = runtime({
      harness: fakeHarness([{ error: busy }, { frames: [doneFrame('s-new')] }]),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    const line = o.stderr.find((l) => l.includes('no capacity')) ?? '';
    expect(line).toContain("(no attached sandbox in sandbox tier 'container'");
    expect(line).not.toMatch(/\u001b/);
  });

  it('gives up on "no capacity" after HEADLESS_CAPACITY_WAIT_MS and exits 1', async () => {
    const o = io();
    const busy = new ApiError('harness', 503, 'sandbox_unavailable', undefined, 600);
    const rt = runtime({
      harness: fakeHarness(Array.from({ length: 5 }, () => ({ error: busy }))),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(1);
    // 600 s a wait: one fits in 15 min, the second would pass it.
    expect(o.stderr.filter((l) => l.includes('retrying in 600s'))).toHaveLength(1);
    expect(HEADLESS_CAPACITY_WAIT_MS).toBe(15 * 60 * 1000);
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

  // #419: the demo needed `--json | jq -j '...'` to show an audience the commands the agent ran.
  describe('--show-tools', () => {
    // One bash call that fails, one that works, text on both sides. The frame order is the
    // server's: a tool_use, then its tool_result, interleaved with the text deltas.
    const toolTurn = () =>
      fakeHarness([
        {
          frames: [
            { type: 'text', delta: 'let me look' },
            { type: 'tool_use', id: 't1', name: 'bash', args: { command: 'ls /nope' } },
            { type: 'tool_result', id: 't1', isError: true, preview: 'No such file' },
            { type: 'tool_use', id: 't2', name: 'bash', args: { command: 'ls /tmp' } },
            { type: 'tool_result', id: 't2', isError: false, preview: 'a\nb\nc' },
            { type: 'text', delta: 'found it' },
            doneFrame('s-new'),
          ],
        },
      ]);

    it('prints each tool call and flags the failed one, in frame order with the text', async () => {
      const o = io();
      const rt = runtime({ harness: toolTurn() });
      expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false, showTools: true })).toBe(
        0,
      );
      expect(o.stdout).toBe(
        'let me look\n$ ls /nope\n  (that command failed)\n\n$ ls /tmp\nfound it\n',
      );
    });

    it('prints no tool calls without the flag, so plain `run` is unchanged', async () => {
      const o = io();
      const rt = runtime({ harness: toolTurn() });
      expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(0);
      expect(o.stdout).toBe('let me lookfound it\n');
    });

    // Not the preview: a successful command's output is the agent's business, and the preview is
    // remote multi-line text that would bury the answer the demo is there to show.
    it('says nothing about a tool call that SUCCEEDED beyond the command itself', async () => {
      const o = io();
      const rt = runtime({ harness: toolTurn() });
      await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false, showTools: true });
      expect(o.stdout).toContain('$ ls /tmp');
      expect(o.stdout).not.toContain('No such file');
      expect(o.stdout).not.toContain('a\nb\nc');
      // The failure marker belongs to t1 only -- one failed result, one marker.
      expect(o.stdout.match(/that command failed/g)).toHaveLength(1);
    });

    // The flag's whole output is server-originated, so it goes through the same sanitizeRemote as
    // the text path (#419). A tool NAME is remote too, not just its arguments.
    it('strips escape sequences from the tool name and its arguments', async () => {
      const o = io();
      const rt = runtime({
        harness: fakeHarness([
          {
            frames: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'ba\u001b]52;c;aGk=\u0007sh',
                args: { command: 'echo \u001b[31mred\u001b[0m' },
              },
              doneFrame('s-new'),
            ],
          },
        ]),
      });
      await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false, showTools: true });
      expect(o.stdout).not.toMatch(/[\u0007\u001b]/);
      expect(o.stdout).toContain('red');
    });

    // sanitizeRemote keeps \n (the text path needs it), so a multi-line argument would otherwise
    // spread one tool call over several lines and read as several calls.
    it('keeps a tool call on one line even when an argument spans lines', async () => {
      const o = io();
      const rt = runtime({
        harness: fakeHarness([
          {
            frames: [
              { type: 'tool_use', id: 't1', name: 'grep', args: { pattern: 'a\nb', path: 'src' } },
              doneFrame('s-new'),
            ],
          },
        ]),
      });
      await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false, showTools: true });
      // The fencing newlines around the call are the only ones it adds.
      expect(o.stdout.split('\n').filter((l) => l.includes('grep'))).toHaveLength(1);
      expect(o.stdout).toContain('grep a b in src');
    });

    // Uses the TUI's own formatter, so `--show-tools` and the transcript export never disagree
    // about what a given tool call looked like.
    it('formats a non-bash tool the way the TUI does (toolSummary)', async () => {
      const o = io();
      const rt = runtime({
        harness: fakeHarness([
          {
            frames: [
              { type: 'tool_use', id: 't1', name: 'read', args: { path: 'src/a.ts', offset: 10 } },
              doneFrame('s-new'),
            ],
          },
        ]),
      });
      await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false, showTools: true });
      expect(o.stdout).toContain(toolSummary('read', { path: 'src/a.ts', offset: 10 }));
    });

    // --json is a machine contract: one JSON document per line and nothing else. A stray
    // "$ ls /tmp" would break every reader, so the plain-text path must stay off under --json.
    it('adds no plain-text lines under --json, whose every line stays parseable', async () => {
      const o = io();
      const rt = runtime({ harness: toolTurn() });
      await cmdRun(rt, o, { prompt: 'hi', options: {}, json: true, showTools: true });
      const types = o.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).type);
      expect(types).toEqual([
        'session',
        'text',
        'tool_use',
        'tool_result',
        'tool_use',
        'tool_result',
        'text',
        'done',
      ]);
    });
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

// #529: auth.json holds a login, for another control plane. The gates used to say a flat "not
// logged in", so the user logged in again and overwrote the one login -- the loop reported as "the
// token only lasts an hour". Saying WHICH control plane is what breaks it.
describe('a cached login for another control plane (#529)', () => {
  function mismatched(): Runtime {
    const rt = runtime({ auth: null, endpoints: { controlPlaneUrl: 'http://cp-b' } });
    saveAuth(rt.paths, {
      apiToken: 'a',
      subject: 'github:1',
      roles: [],
      expiresAt: 4_000_000_000,
      controlPlaneUrl: 'http://cp-a',
    });
    return rt;
  }

  it('readyCp names both URLs, and the exit code does not change', async () => {
    const rt = mismatched();
    const o = io();
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(2);
    const err = o.stderr.join('\n');
    expect(err).toMatch(/not logged in/);
    expect(err).toContain('http://cp-a');
    expect(err).toContain('http://cp-b');
  });

  it('auth token names both URLs and still exits 3 for the hook', async () => {
    const o = io();
    expect(await cmdAuthToken(mismatched(), o, false)).toBe(3);
    const err = o.stderr.join('\n');
    expect(err).toContain('http://cp-a');
    expect(err).toContain('http://cp-b');
    expect(o.stdout).toBe('');
  });

  it('says only the plain thing when there is no cached login at all', async () => {
    const o = io();
    const rt = runtime({ auth: null, endpoints: { controlPlaneUrl: 'http://cp-b' } });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(2);
    expect(o.stderr.join('\n')).toBe('not logged in — run `mocactl login` first');
  });

  it('doctor names the other control plane in check 3', async () => {
    const o = io();
    expect(await cmdDoctor(mismatched(), o, true)).toBe(1);
    const login = (JSON.parse(o.stdout) as Array<{ id: number; fix?: string }>).find(
      (r) => r.id === 3,
    );
    expect(login?.fix).toContain('http://cp-a');
    expect(login?.fix).toContain('http://cp-b');
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

  it('with login helpers, copies the code and then opens the raw verification URL', async () => {
    const o = io();
    const steps: string[] = [];
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
    const helpers = {
      copy: async (t: string) => void steps.push(`copy ${t}`),
      openUrl: (u: string) => void steps.push(`open ${u}`),
    };
    expect(await cmdLogin(rt, o, undefined, helpers)).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(steps).toEqual(['copy ABCD-1234', 'open https://github.com/login/device']);
    expect(o.stderr.join('\n')).toContain('copied to the clipboard');
  });

  it('still opens the browser when the clipboard fails, and says nothing was copied', async () => {
    const o = io();
    const opened: string[] = [];
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
    const helpers = {
      copy: async () => {
        throw new Error('no clipboard');
      },
      openUrl: (u: string) => void opened.push(u),
    };
    expect(await cmdLogin(rt, o, undefined, helpers)).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual(['https://github.com/login/device']);
    expect(o.stderr.join('\n')).not.toContain('clipboard');
    expect(o.stderr.join('\n')).toContain('Opening the browser');
  });

  describe('the clipboard and browser (devicePrompt)', () => {
    const start = (userCode = 'ABCD-1234') => ({
      deviceCode: 'd',
      userCode,
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    });
    const flush = () => new Promise((r) => setImmediate(r));

    it('opens the browser after COPY_TIMEOUT_MS when the clipboard helper hangs', async () => {
      vi.useFakeTimers();
      try {
        const o = io();
        const opened: string[] = [];
        devicePrompt(o, {
          copy: () => new Promise<void>(() => undefined),
          openUrl: (u) => void opened.push(u),
        })(start(), 1);
        await vi.advanceTimersByTimeAsync(COPY_TIMEOUT_MS - 1);
        expect(opened).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(opened).toEqual(['https://github.com/login/device']);
        expect(o.stderr.join('\n')).not.toContain('clipboard');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not copy a code that is not device-code shaped, but still opens the browser', async () => {
      const o = io();
      const steps: string[] = [];
      devicePrompt(o, {
        copy: async (t) => void steps.push(`copy ${t}`),
        openUrl: (u) => void steps.push(`open ${u}`),
      })(start('ABCD-1234\nrm -rf ~\n'), 1);
      await flush();
      expect(steps).toEqual(['open https://github.com/login/device']);
      expect(o.stderr.join('\n')).not.toContain('clipboard');
    });

    it('neither opens nor mentions a browser for a URL openUrl would refuse', async () => {
      const o = io();
      const steps: string[] = [];
      devicePrompt(o, {
        copy: async (t) => void steps.push(`copy ${t}`),
        openUrl: (u) => void steps.push(`open ${u}`),
      })({ ...start(), verificationUri: 'file:///etc/passwd' }, 1);
      await flush();
      expect(steps).toEqual(['copy ABCD-1234']);
      expect(o.stderr.join('\n')).not.toContain('browser');
      expect(o.stderr.at(-1)).toBe('The code is copied to the clipboard.');
    });

    it('swallows an openUrl that throws rather than leaving an unhandled rejection', async () => {
      const o = io();
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => void unhandled.push(e);
      process.on('unhandledRejection', onUnhandled);
      try {
        devicePrompt(o, {
          copy: async () => undefined,
          openUrl: () => {
            throw new Error('spawn failed');
          },
        })(start(), 1);
        await flush();
        await flush();
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
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
