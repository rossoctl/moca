import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ExecAbortedError,
  ExecMachineryError,
  ExecRefusedError,
  LEASE_RULE,
  LeaseControlError,
  leaseNotice,
  MAX_STDIN_BYTES,
  RESET_ENDED_TEXT,
  SANDBOX_BUSY_TEXT,
  SandboxExecConn,
  TEMPLATE_BUSY_TEXT,
  TOKEN_EXPIRED_TEXT,
  writeFileCommand,
  type ExecConnOptions,
  type ExecResult,
  type LeaseEvent,
  type LeaseStatusView,
} from '@moca/sandbox-client';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { DEFAULT_CONFIG, saveAuth, saveConfig } from '../src/config.js';
import { SandboxApiClient } from '../src/sbx/api.js';
import { sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { jwtMode, sandboxTokenFn, type ExecFactory } from '../src/sbx/exec.js';
import { busyRetries } from '../src/sbx/run.js';
import { readRecords, recordCall } from '../src/sbx/recorder.js';
import { fakeExecRelay } from '../../sandbox-client/test/helpers/fake-relay.js';
import {
  jwt,
  LOGIN,
  NO_LEASE,
  SBX,
  TOKEN,
  TOKEN_IAT,
  fakeCp,
  sandbox,
  setup,
  URL_,
} from './helpers/sbx.js';

const res = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: Buffer.from('out\n'),
  stderr: Buffer.from('err\n'),
  exitCode: 0,
  truncated: false,
  lease: [],
  ...over,
});

/** An exec factory that records its options and every command, answering from `answer`. */
function fakeExec(answer: (command: string) => ExecResult | Error = () => res()) {
  const opened: ExecConnOptions[] = [];
  const sent: { command: string; stdin?: string; timeoutS?: number }[] = [];
  let closed = 0;
  const factory = (o: ExecConnOptions) => {
    opened.push(o);
    return {
      exec: async (command: string, x: { stdin?: Uint8Array; timeoutS?: number } = {}) => {
        await o.token({ force: false, minValidS: 60 });
        sent.push({
          command,
          stdin: x.stdin ? Buffer.from(x.stdin).toString() : undefined,
          timeoutS: x.timeoutS,
        });
        const a = answer(command);
        if (a instanceof Error) throw a;
        return a;
      },
      close: () => void closed++,
      ...NO_LEASE,
    };
  };
  return { factory, opened, sent, closed: () => closed };
}
const mint = () =>
  fakeCp({ [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }) });
/** The end a reset of a live lease leaves pending (the worker's answer to `reset`). */
const RESET_END = {
  reqId: 0,
  state: 'end',
  reason: 'reset',
  atUnixMs: 1_800_000_100_000,
  mode: 2, // SANDBOX_MODE_LEASE
  ageMs: 5_000,
  processes: [],
  endsByUnixMs: 0,
};

/** TOKEN's lifetime is 900 s: the default timeout and the cap are 840 s (spec §6.5). */
const CAP = 840;

describe('mocactl sbx run (SBX0 §6.1, §6.5)', () => {
  it("runs a command on the sandbox's worker and workspace, passing output and the exit code through", async () => {
    const { home, env, io } = setup();
    const x = fakeExec(() => res({ exitCode: 7 }));
    const code = await sbxMain(['run', '--sandbox', SBX, '--', 'npm', 'test'], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
    });
    expect(code).toBe(7);
    expect(x.opened[0]).toMatchObject({
      addr: TOKEN.execEndpoint,
      tls: true,
      sandboxId: TOKEN.wrk,
      workspaceKey: TOKEN.wsk,
    });
    expect(x.opened[0]!.caPem).toBeUndefined();
    // The default timeout is the token lifetime minus 60 s, derived from the token's iat/exp.
    // Each word quoted: exactly what was typed runs (R1 of the review).
    expect(x.sent).toEqual([{ command: "'npm' 'test'", stdin: undefined, timeoutS: CAP }]);
    expect(Buffer.concat(io.outB).toString()).toBe('out\n');
    expect(Buffer.concat(io.errB).toString()).toBe('err\n');
    expect(io.outs).toEqual([]);
    expect(x.closed()).toBe(1);
  });

  it('runs each argument as typed: a space stays inside its word, $HOME stays literal', async () => {
    const { home, env, io } = setup();
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'grep', 'a b', 'f'], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
    });
    await sbxMain(['run', '--sandbox', SBX, '--', 'echo', '$HOME', "it's", '*'], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
    });
    expect(x.sent.map((s) => s.command)).toEqual([
      "'grep' 'a b' 'f'",
      `'echo' '$HOME' 'it'\\''s' '*'`,
    ]);
    // And through a real shell, those words come back unchanged.
    const words = execFileSync('sh', ['-c', `printf '%s\\n' ${x.sent[1]!.command.slice(7)}`])
      .toString()
      .split('\n');
    expect(words.slice(0, 3)).toEqual(['$HOME', "it's", '*']);
  });

  it("passes the command's output through byte for byte: no decoding, no newline added", async () => {
    const { home, env, io } = setup();
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x0a, 0x80]); // not UTF-8
    const x = fakeExec(() => res({ stdout: bin, stderr: Buffer.from('warning: no newline') }));
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'cat', 'img'], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
      }),
    ).toBe(0);
    expect(Buffer.concat(io.outB).equals(bin)).toBe(true);
    expect(Buffer.concat(io.errB).toString()).toBe('warning: no newline');
    expect(io.outs).toEqual([]);
    expect(io.errs).toEqual([]);
  });

  it("starts mocactl's own note on a new line after stderr with no trailing newline", async () => {
    const { home, env, io } = setup();
    const x = fakeExec(() =>
      res({ stdout: Buffer.alloc(0), stderr: Buffer.from('partial'), exitCode: -9 }),
    );
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'x'], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
      }),
    ).toBe(124);
    expect(Buffer.concat(io.errB).toString()).toBe('partial\n');
    expect(io.errs.join('\n')).toMatch(/killed/);
  });

  it('runs the script on stdin when no command is given, and honours --timeout', async () => {
    const { home, env, io } = setup();
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--timeout', '30'], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
      stdinIsTTY: false,
      readStdin: async () => 'set -e\nmake\n',
    });
    expect(x.sent[0]).toEqual({ command: 'set -e\nmake\n', stdin: undefined, timeoutS: 30 });
  });

  it('near the sandbox end sends no negative timeout, leaving the exec client to say why (final re-review)', async () => {
    // A token cut to the sandbox's end: 50 s of life leaves no positive cap (life - 60).
    const short = { ...TOKEN, token: jwt({ iat: TOKEN_IAT, exp: TOKEN_IAT + 50 }) };
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: short }),
    });
    const { home, env, io } = setup();
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'make'], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
    });
    expect(x.sent[0]!.timeoutS).toBeUndefined();
    expect(io.errs.join('\n')).not.toMatch(/positive number of seconds/);
  });

  it('clamps a --timeout over the cap to the cap, saying so on stderr', async () => {
    const { home, env, io } = setup();
    const x = fakeExec();
    const code = await sbxMain(
      ['run', '--sandbox', SBX, '--timeout', '1800', '--', 'make'],
      env,
      io,
      {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
      },
    );
    expect(code).toBe(0);
    expect(x.sent[0]!.timeoutS).toBe(CAP);
    expect(io.errs.join('\n')).toMatch(/--timeout 1800s is over .*840s/);
    // At the cap exactly: no note.
    const y = fakeExec();
    const quiet = setup();
    await sbxMain(
      ['run', '--sandbox', SBX, '--timeout', String(CAP), '--', 'make'],
      quiet.env,
      quiet.io,
      {
        home: quiet.home,
        fetchImpl: mint().fetchImpl,
        execFactory: y.factory,
      },
    );
    expect(y.sent[0]!.timeoutS).toBe(CAP);
    expect(quiet.io.errs.join('\n')).not.toMatch(/--timeout/);
  });

  it.each(['0', '-5', '1.5', 'abc', ''])(
    'refuses --timeout %j before any request (exit 2)',
    async (t) => {
      const { home, env, io } = setup();
      const cp = mint();
      const x = fakeExec();
      expect(
        await sbxMain(['run', '--sandbox', SBX, '--timeout', t, '--', 'ls'], env, io, {
          home,
          fetchImpl: cp.fetchImpl,
          execFactory: x.factory,
        }),
      ).toBe(2);
      expect(cp.calls).toEqual([]);
    },
  );

  it('exits 124 for a timed-out or killed command, 125 for a sandbox failure, 75 for a refusal before start', async () => {
    const run = async (answer: ExecResult | Error) => {
      const { home, env: env0, io } = setup();
      // No retry here (the retry before start has its own tests below): every failure exits on the first try.
      const env = { ...env0, MOCACTL_SBX_BUSY_RETRIES: '0' };
      const x = fakeExec(() => answer);
      const code = await sbxMain(['run', '--sandbox', SBX, '--', 'sleep', '9'], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
      });
      return { code, err: io.errs.join('\n'), sent: x.sent.length };
    };
    // ExecError{"timeout:<n>"}: a result with timedOutS (spec §6.1, §10.3).
    const timedOut = await run(res({ exitCode: -1, timedOutS: 840 }));
    expect(timedOut.code).toBe(124);
    expect(timedOut.err).toMatch(/timed out after 840s/);
    const killed = await run(res({ exitCode: -9 }));
    expect(killed.code).toBe(124);
    expect(killed.err).toMatch(/killed/);
    const machinery = await run(new ExecMachineryError('sandbox failure: vm boot failed'));
    expect(machinery.code).toBe(125);
    expect(machinery.err).toContain('vm boot failed');
    // A failure is never retried here: the command went out once (a started one is never re-run).
    expect(machinery.sent).toBe(1);
    const refused = await run(new ExecRefusedError('workspace key mismatch', 7));
    expect(refused.code).toBe(125);
    expect(refused.err).toContain('workspace key mismatch');
    const busy = await run(
      new ExecMachineryError('sandbox busy: 4 Execs already in flight', 8, 'busy'),
    );
    // Refused before start: nothing ran, so its own exit (75), not a sandbox failure.
    expect(busy.code).toBe(75);
    expect(busy.err).toContain(SANDBOX_BUSY_TEXT);
    const full = await run(
      new ExecMachineryError('template busy: busy: queue full', 2, 'template_busy'),
    );
    expect(full.code).toBe(75);
    expect(full.err).toContain(TEMPLATE_BUSY_TEXT);
    // Cut mid-command: the CLI says it may have partly run (final review M2).
    const cut = await run(
      new ExecMachineryError(
        'sandbox failure: UNAVAILABLE: Connection dropped',
        14,
        'machinery',
        true,
      ),
    );
    expect(cut.code).toBe(125);
    expect(cut.err).toBe(
      'sbx: sandbox failure: UNAVAILABLE: Connection dropped; the command may have partly run',
    );
    const expired = await run(
      new ExecMachineryError('sandbox token expired during the Exec', 4, 'token_expired'),
    );
    expect(expired.code).toBe(125);
    expect(expired.err).toContain(TOKEN_EXPIRED_TEXT);
  });

  describe('a refusal before start is retried', () => {
    const memoryBudget = () =>
      new ExecMachineryError(
        'template busy: memory-budget: promoting a standby would re-price it',
        2,
        'template_busy',
      );
    /** Answers `failures` in order, then a clean result; records the waits. */
    async function runWith(
      failures: Error[],
      over: {
        env?: Record<string, string>;
        signal?: AbortSignal;
        abortOnSleep?: AbortController;
      } = {},
    ) {
      const { home, env, io } = setup();
      let n = 0;
      const x = fakeExec(() => (n < failures.length ? failures[n++]! : res({ exitCode: 3 })));
      const waits: number[] = [];
      const code = await sbxMain(
        ['run', '--sandbox', SBX, '--', 'git', 'status'],
        { ...env, ...over.env },
        io,
        {
          home,
          fetchImpl: mint().fetchImpl,
          execFactory: x.factory,
          random: () => 0.5,
          sleep: async (ms) => {
            waits.push(ms);
            over.abortOnSleep?.abort();
          },
          ...(over.signal ? { signal: over.signal } : {}),
        },
      );
      return {
        code,
        sent: x.sent.length,
        timeouts: x.sent.map((m) => m.timeoutS),
        waits,
        err: io.errs.join('\n'),
      };
    }

    it("sends it again after a backoff, and exits with the command's code once it runs", async () => {
      const r = await runWith([
        memoryBudget(),
        new ExecMachineryError('sandbox busy: 4 Execs already in flight', 8, 'busy'),
      ]);
      expect(r.code).toBe(3);
      expect(r.sent).toBe(3);
      expect(r.waits).toEqual([1000, 2000]);
      expect(r.err).toMatch(/nothing ran; retrying in 1\.0s \(1\/4\)/);
      expect(r.err).toMatch(/nothing ran; retrying in 2\.0s \(2\/4\)/);
    });

    it('exits 75 when every try is refused, the waits under 30 s in all', async () => {
      const r = await runWith(Array.from({ length: 9 }, memoryBudget));
      expect(r.code).toBe(75);
      expect(r.sent).toBe(5);
      expect(r.waits).toEqual([1000, 2000, 4000, 8000]);
      expect(r.err).toMatch(
        /refused the command 5 times before starting it; nothing ran \(exit 75\)/,
      );
    });

    it("re-caps each retry's timeout to what the token has left after the waits", async () => {
      // TOKEN's 900 s lifetime less the 60 s margin is 840 s; the waits (1, 2, 4, 8 s) spend it.
      const r = await runWith(Array.from({ length: 9 }, memoryBudget));
      expect(r.timeouts).toEqual([840, 839, 837, 833, 825]);
    });

    it('keeps the waits under 30 s at the most jitter', async () => {
      const { home, env, io } = setup();
      const x = fakeExec(() => memoryBudget());
      const waits: number[] = [];
      await sbxMain(['run', '--sandbox', SBX, '--', 'true'], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
        random: () => 1,
        sleep: async (ms) => void waits.push(ms),
      });
      expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(30_000);
    });

    it('never retries a machinery failure, a token expiry, or a failure after the command may have run', async () => {
      for (const err of [
        new ExecMachineryError('sandbox failure: vm boot failed'),
        new ExecMachineryError('sandbox token expired during the Exec', 4, 'token_expired'),
        new ExecMachineryError('template busy: max-runs: full', 2, 'template_busy', true),
      ]) {
        const r = await runWith([err]);
        expect(r.code).toBe(125);
        expect(r.sent).toBe(1);
        expect(r.waits).toEqual([]);
      }
    });

    it('stops with 130 when interrupted while waiting', async () => {
      const ac = new AbortController();
      const r = await runWith([memoryBudget(), memoryBudget()], {
        signal: ac.signal,
        abortOnSleep: ac,
      });
      expect(r.code).toBe(130);
      expect(r.sent).toBe(1);
    });

    it('MOCACTL_SBX_BUSY_RETRIES=0 turns it off (exit 75 on the first refusal), and sets the count', async () => {
      const off = await runWith([memoryBudget()], { env: { MOCACTL_SBX_BUSY_RETRIES: '0' } });
      expect(off.code).toBe(75);
      expect(off.sent).toBe(1);
      expect(off.waits).toEqual([]);
      const one = await runWith([memoryBudget(), memoryBudget()], {
        env: { MOCACTL_SBX_BUSY_RETRIES: '1' },
      });
      expect(one.code).toBe(75);
      expect(one.sent).toBe(2);
    });

    it('MOCACTL_SBX_BUSY_RETRIES: a whole number, at most 20; anything else is the default (4)', () => {
      expect(busyRetries({})).toBe(4);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: '' })).toBe(4);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: '-1' })).toBe(4);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: '2.5' })).toBe(4);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: 'many' })).toBe(4);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: ' 7 ' })).toBe(7);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: '20' })).toBe(20);
      expect(busyRetries({ MOCACTL_SBX_BUSY_RETRIES: '500' })).toBe(20);
    });
  });

  it('says when the sandbox cut the output or the timeout', async () => {
    const { home, env, io } = setup();
    const x = fakeExec(() => res({ truncated: true, capped: true }));
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'cat', 'big'], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
      }),
    ).toBe(0);
    expect(io.errs.join('\n')).toMatch(/8 MiB/);
    expect(io.errs.join('\n')).toMatch(/timeout was cut/);
  });

  it('refuses to wait on a terminal for a script: no command and stdin is a TTY (exit 2)', async () => {
    const { home, env, io } = setup();
    const cp = mint();
    let read = false;
    expect(
      await sbxMain(['run', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        stdinIsTTY: true,
        readStdin: async () => ((read = true), 'ls'),
      }),
    ).toBe(2);
    expect(read).toBe(false);
    expect(cp.calls).toEqual([]);
    expect(io.errs.join('\n')).toMatch(/needs a command/);
  });

  it('refuses an empty script (exit 2)', async () => {
    const { home, env, io } = setup();
    const cp = mint();
    expect(
      await sbxMain(['run', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        stdinIsTTY: false,
        readStdin: async () => '  \n',
      }),
    ).toBe(2);
    expect(cp.calls).toEqual([]);
  });

  it('validates the sandbox id from --sandbox and from .sbx/sandbox.json before any use', async () => {
    const { home, env, io, paths } = setup();
    const cp = mint();
    expect(
      await sbxMain(['run', '--sandbox', '../../etc/x', '--', 'ls'], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
      }),
    ).toBe(2);
    expect(io.errs.join('\n')).toMatch(/not a sandbox id/);
    const repo = mkdtempSync(join(tmpdir(), 'mocactl-sbx-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.sbx'));
    writeFileSync(join(repo, '.sbx', 'sandbox.json'), JSON.stringify({ id: 'sbx-../../x' }));
    for (const argv of [['run', '--', 'ls'], ['mcp'], ['put', 'a.txt']]) {
      expect(await sbxMain(argv, env, io, { home, fetchImpl: cp.fetchImpl, cwd: repo })).toBe(2);
    }
    expect(cp.calls).toEqual([]);
    expect(existsSync(join(paths.stateDir, 'sbx'))).toBe(false);
  });

  it('needs a sandbox: --sandbox or a .sbx/sandbox.json (exit 2)', async () => {
    const { home, env, io } = setup();
    expect(await sbxMain(['run', '--', 'ls'], env, io, { home, cwd: tmpdir() })).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--sandbox ID/);
  });

  it('reports a terminated sandbox through the control-plane path, naming why', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 409,
        body: { error: 'sandbox_terminated', message: 'sandbox was deleted', reason: 'deleted' },
      }),
    });
    const x = fakeExec();
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'ls'], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        execFactory: x.factory,
      }),
    ).toBe(1);
    expect(io.errs.join('\n')).toMatch(/sandbox was deleted/);
    expect(x.opened).toEqual([]);
  });

  it("keeps 1b's real cause after a failed 401 retry: a refresh that cannot reach the control plane is exit 4", async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 401,
        body: { error: 'token_expired' },
      }),
      'POST /v1/auth/token': () => new TypeError('fetch failed'),
    });
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'ls'], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        execFactory: fakeExec().factory,
      }),
    ).toBe(4);
    expect(io.errs.join('\n')).toMatch(/cannot reach the sandbox control plane/);
  });

  it('refuses options that do not apply (exit 2)', async () => {
    const { home, env, io } = setup();
    expect(await sbxMain(['ls', '--sandbox', SBX], env, io, { home })).toBe(2);
    expect(await sbxMain(['put', 'a', '--sandbox', SBX, '--timeout', '9'], env, io, { home })).toBe(
      2,
    );
    expect(await sbxMain(['mcp', 'extra', '--sandbox', SBX], env, io, { home })).toBe(2);
  });
});

describe('mocactl sbx run lease notices (spec §5)', () => {
  const end = {
    reqId: 0,
    state: 'end',
    reason: 'idle',
    atUnixMs: 1_800_000_100_000,
    mode: 2,
    ageMs: 60_000,
    processes: [],
    endsByUnixMs: 0,
  };
  const start = { ...end, state: 'start', reason: '', atUnixMs: end.atUnixMs + 5 };
  const runIt = async (s: ReturnType<typeof setup>, answer: () => ExecResult | Error) => {
    s.io.errs.length = 0;
    s.io.errB.length = 0;
    return sbxMain(['run', '--sandbox', SBX, '--', 'true'], s.env, s.io, {
      home: s.home,
      fetchImpl: mint().fetchImpl,
      execFactory: fakeExec(answer).factory,
    });
  };

  it('run prints a lease end notice on stderr', async () => {
    const s = setup();
    expect(await runIt(s, () => res({ lease: [end, start] }))).toBe(0);
    const notice = leaseNotice(end, Date.now())!;
    expect(notice).toContain('[sandbox] guest restarted (idle, ');
    // The end, once; the start is not shown beside it.
    expect(s.io.errs).toEqual([notice]);
    expect(Buffer.concat(s.io.errB).toString()).toBe('err\n');
    // Seen: the same event on a later result is not shown again (the store in the sbx state dir).
    expect(await runIt(s, () => res({ lease: [end] }))).toBe(0);
    expect(s.io.errs).toEqual([]);
    // An event that came before a failure is shown before the failure's text.
    const later = { ...end, reason: 'memory_reclaim', atUnixMs: end.atUnixMs + 60_000 };
    const boom = new ExecMachineryError('sandbox failure: lease_ended(memory_reclaim)');
    boom.lease = [later];
    expect(await runIt(s, () => boom)).toBe(125);
    expect(s.io.errs[0]).toBe(leaseNotice(later, Date.now()));
    expect(s.io.errs[1]).toMatch(/^sbx: /);
    // A refused or aborted Exec carries the events it had received too (re-review New-2).
    const refusedEnd = { ...end, reason: 'grace_limit', atUnixMs: end.atUnixMs + 120_000 };
    expect(
      await runIt(s, () => new ExecRefusedError('token rejected', 16, [refusedEnd as LeaseEvent])),
    ).toBe(125);
    expect(s.io.errs[0]).toBe(leaseNotice(refusedEnd, Date.now()));
    expect(s.io.errs[1]).toMatch(/^sbx: /);
    const abortedEnd = { ...end, reason: 'reset', atUnixMs: end.atUnixMs + 180_000 };
    const ac = new AbortController();
    s.io.errs.length = 0;
    expect(
      await sbxMain(['run', '--sandbox', SBX, '--', 'true'], s.env, s.io, {
        home: s.home,
        fetchImpl: mint().fetchImpl,
        signal: ac.signal,
        execFactory: fakeExec(() => {
          ac.abort(); // Ctrl-C while the command runs
          const e = new ExecAbortedError(ac.signal);
          e.lease = [abortedEnd as LeaseEvent];
          return e;
        }).factory,
      }),
    ).toBe(130);
    expect(s.io.errs).toEqual([leaseNotice(abortedEnd, Date.now())]);
    // An expiring event is shown on every result: it marks nothing seen.
    const exp = {
      ...end,
      state: 'expiring',
      reason: 'max_duration',
      endsByUnixMs: Date.now() + 120_000,
    };
    for (let i = 0; i < 2; i++) {
      expect(await runIt(s, () => res({ lease: [exp] }))).toBe(0);
      expect(s.io.errs).toEqual([leaseNotice(exp, Date.now())]);
    }
  });
});

describe('mocactl sbx put (SBX0 §6.1)', () => {
  it('puts stdin, byte for byte, at a workspace path, with the atomic write command', async () => {
    const { home, env, io } = setup();
    const x = fakeExec(() => res({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const code = await sbxMain(['put', 'src/a b.txt', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
      stdinIsTTY: false,
      readStdinBytes: async () => Buffer.from('héllo\n'),
    });
    expect(code).toBe(0);
    expect(x.sent).toEqual([
      { command: writeFileCommand('/workspace/src/a b.txt'), stdin: 'héllo\n', timeoutS: 120 },
    ]);
    expect(io.outs).toEqual([]);
  });

  it('reports a write the sandbox refused (exit 1)', async () => {
    const { home, env, io } = setup();
    const x = fakeExec(() =>
      res({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('/workspace/ro: Permission denied\x1b]52;c;cGF5bG9hZA==\x07\n'),
      }),
    );
    expect(
      await sbxMain(['put', 'ro', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: mint().fetchImpl,
        execFactory: x.factory,
        stdinIsTTY: false,
        readStdinBytes: async () => Buffer.from('x'),
      }),
    ).toBe(1);
    expect(io.errs.join('\n')).toContain('put failed: /workspace/ro: Permission denied');
    expect(io.errs.join('\n')).not.toContain('\x1b'); // remote stderr cannot drive the terminal
  });

  it('refuses stdin over what one Exec can carry, before any request (exit 2)', async () => {
    const { home, env, io } = setup();
    const cp = mint();
    expect(
      await sbxMain(['put', 'big.bin', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        execFactory: fakeExec().factory,
        stdinIsTTY: false,
        readStdinBytes: async () => Buffer.alloc(MAX_STDIN_BYTES + 1),
      }),
    ).toBe(2);
    expect(io.errs.join('\n')).toMatch(/over the 14 MiB/);
    expect(cp.calls).toEqual([]);
  });

  it('refuses a PATH outside /workspace, before any request (exit 2)', async () => {
    const { home, env, io } = setup();
    const cp = mint();
    for (const p of ['/etc/passwd', '../outside', '/workspace']) {
      expect(
        await sbxMain(['put', p, '--sandbox', SBX], env, io, {
          home,
          fetchImpl: cp.fetchImpl,
          execFactory: fakeExec().factory,
          stdinIsTTY: false,
          readStdinBytes: async () => Buffer.from('x'),
        }),
      ).toBe(2);
    }
    expect(io.errs.join('\n')).toMatch(/not under it/);
    expect(cp.calls).toEqual([]);
  });

  it('reads stdin only up to one byte past the cap', async () => {
    const { home, env, io } = setup();
    const limits: (number | undefined)[] = [];
    await sbxMain(['put', 'a', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: fakeExec().factory,
      stdinIsTTY: false,
      readStdinBytes: async (limit) => (limits.push(limit), Buffer.from('x')),
    });
    expect(limits).toEqual([MAX_STDIN_BYTES + 1]);
  });

  it('refuses when stdin is a terminal, reading nothing (exit 2)', async () => {
    const { home, env, io } = setup();
    const cp = mint();
    let read = false;
    expect(
      await sbxMain(['put', 'a', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        stdinIsTTY: true,
        readStdinBytes: async () => ((read = true), Buffer.from('x')),
      }),
    ).toBe(2);
    expect(read).toBe(false);
    expect(cp.calls).toEqual([]);
    expect(io.errs.join('\n')).toMatch(/pipe or redirect/);
  });

  it('takes exactly one PATH (exit 2)', async () => {
    const { home, env, io } = setup();
    expect(await sbxMain(['put', '--sandbox', SBX], env, io, { home })).toBe(2);
    expect(await sbxMain(['put', 'a', 'b', '--sandbox', SBX], env, io, { home })).toBe(2);
  });
});

describe('mocactl sbx put: a refusal before start', () => {
  it("is retried as run's, and the write goes out once it is accepted", async () => {
    const { home, env, io } = setup();
    let n = 0;
    const x = fakeExec(() =>
      n++ === 0
        ? new ExecMachineryError('template busy: busy: queue full', 2, 'template_busy')
        : res({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    );
    const waits: number[] = [];
    const code = await sbxMain(['put', 'a.txt', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: mint().fetchImpl,
      execFactory: x.factory,
      stdinIsTTY: false,
      readStdinBytes: async () => Buffer.from('x'),
      random: () => 0.5,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(code).toBe(0);
    expect(x.sent).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });
});

describe('the sandbox token source (SBX0 §6.5)', () => {
  const at = (s: number) => s * 1000;

  it('mints once, and reuses the token while it has max(60, minValidS) seconds left', async () => {
    const cp = mint();
    let now = at(TOKEN_IAT);
    const api = new SandboxApiClient(URL_, () => 'api-1', cp.fetchImpl);
    const t = sandboxTokenFn(api, SBX, () => now);
    const g = await t.token({ force: false, minValidS: 60 });
    expect(g).toEqual({ token: TOKEN.token, expiresAt: TOKEN.expiresAt, lifetimeS: 900 });
    await t.token({ force: false, minValidS: 60 });
    // A token minted this instant has its whole lifetime left, so it covers a defaulted timeout.
    await t.token({ force: false, minValidS: 900 });
    expect(cp.calls).toHaveLength(1);
    now = at(TOKEN_IAT + 500); // 400 s left
    await t.token({ force: false, minValidS: 400 });
    expect(cp.calls).toHaveLength(1);
    await t.token({ force: false, minValidS: 401 }); // a timeout the token cannot cover
    expect(cp.calls).toHaveLength(2);
    now = at(TOKEN.expiresAt - 30); // within 60 s of exp
    await t.token({ force: false, minValidS: 1 });
    expect(cp.calls).toHaveLength(3);
    await t.token({ force: true, minValidS: 60 });
    expect(cp.calls).toHaveLength(4);
  });

  it('first() is the held grant: the connection reuses it', async () => {
    const cp = mint();
    const api = new SandboxApiClient(URL_, () => 'api-1', cp.fetchImpl);
    const t = sandboxTokenFn(api, SBX, () => at(TOKEN_IAT));
    expect((await t.first()).execEndpoint).toBe(TOKEN.execEndpoint);
    await t.token({ force: false, minValidS: 900 });
    expect(cp.calls).toHaveLength(1);
  });

  it('reads no lifetime from a token that is not a readable JWT (0), keeping the API expiry', async () => {
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 200,
        body: { ...TOKEN, token: 'opaque' },
      }),
    });
    const api = new SandboxApiClient(URL_, () => 'api-1', cp.fetchImpl);
    const t = sandboxTokenFn(api, SBX, () => at(TOKEN_IAT));
    expect(await t.token({ force: false, minValidS: 60 })).toEqual({
      token: 'opaque',
      expiresAt: TOKEN.expiresAt,
      lifetimeS: 0,
    });
  });

  it('a run with an unreadable lifetime sends no timeout of its own (the connection defaults it)', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 200,
        body: { ...TOKEN, token: jwt({ iat: 0, exp: 0 }) },
      }),
    });
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'ls'], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
    });
    expect(x.sent[0]!.timeoutS).toBeUndefined();
  });

  it("passes the sandbox's expiry to the connection when the first token is short (final review M1)", async () => {
    const { home, env, io } = setup();
    // 90 s left of the sandbox's life: the token is cut to its expiry, so the sandbox is looked up.
    const short = {
      ...TOKEN,
      token: jwt({ iat: TOKEN_IAT, exp: TOKEN_IAT + 90 }),
      expiresAt: TOKEN_IAT + 90,
    };
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: short }),
      [`GET /v1/sandboxes/${SBX}`]: () => ({
        status: 200,
        body: sandbox({ expiresAt: TOKEN_IAT + 90 }),
      }),
    });
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'true'], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
    });
    expect(x.opened[0]!.sandboxExpiresAt).toBe(TOKEN_IAT + 90);
    // A full-length first token needs no lookup.
    const cp2 = mint();
    const y = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'true'], env, io, {
      home,
      fetchImpl: cp2.fetchImpl,
      execFactory: y.factory,
    });
    expect(cp2.calls.some((c) => c.method === 'GET')).toBe(false);
    expect(y.opened[0]!.sandboxExpiresAt).toBeUndefined();
  });

  it('passes a self-issued exec CA to the connection', async () => {
    const { home, env, io } = setup();
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: { ...TOKEN, execCa: pem } }),
    });
    const x = fakeExec();
    await sbxMain(['run', '--sandbox', SBX, '--', 'ls'], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
    });
    expect(x.opened[0]!.caPem).toBe(pem);
  });
});

describe('mocactl sbx mcp (SBX0 §6.4)', () => {
  const cpWithSandbox = (over: Record<string, unknown> = {}) =>
    fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
      [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox(over) }),
    });

  it('serves the tools over MCP, recording each call to the flight recorder', async () => {
    const { home, env, io, paths } = setup();
    const cp = cpWithSandbox();
    const x = fakeExec(() => res({ stdout: Buffer.from('hi\n'), stderr: Buffer.alloc(0) }));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const served = sbxMain(['mcp', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
      mcpTransport: serverSide,
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const r = (await client.callTool({ name: 'bash', arguments: { command: 'echo hi' } })) as {
      content: { text: string }[];
    };
    expect(r.content[0]!.text).toBe('hi\n');
    const info = (await client.callTool({ name: 'sandbox_info', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(info.content[0]!.text).toMatch(/template node22.*expires/s);
    // A per-exec record: no lease call (P4-R9), so the fake's missing lease calls never show.
    expect(info.content[0]!.text).toContain('\nmode: per-exec\nlease: none (per-exec)\n');
    await client.close();
    expect(await served).toBe(0);
    expect(io.outs).toEqual([]); // stdout belongs to MCP frames only
    expect(x.closed()).toBe(1);
    const recs = readRecords(paths.stateDir, SBX);
    expect(recs).toMatchObject([
      { tool: 'bash', execs: 1, ok: true },
      { tool: 'sandbox_info', execs: 0 },
    ]);
    const file = join(paths.stateDir, 'sbx', `${SBX}.log`);
    // Never command text, command output or a token. Read first, then its mode.
    const raw = readFileSync(file, 'utf8');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(paths.stateDir, 'sbx')).mode & 0o777).toBe(0o700);
    expect(raw).not.toContain('echo');
    expect(raw).not.toContain('hi\\n');
    expect(raw).not.toContain(TOKEN.token);
  });

  it("names the sandbox's expiry when the sandbox turns out to have expired (reason carried)", async () => {
    const { home, env, io } = setup();
    const cp = cpWithSandbox();
    const gone = new ApiError(
      'control-plane',
      409,
      'sandbox_terminated',
      'sandbox has gone', // neither "deleted" nor "expired": only `reason` can say which
      undefined,
      undefined,
      'expired',
    );
    const x = fakeExec(() => gone);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const served = sbxMain(['mcp', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: x.factory,
      mcpTransport: serverSide,
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const r = (await client.callTool({ name: 'bash', arguments: { command: 'ls' } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(
      `sandbox expired on ${new Date(sandbox().expiresAt * 1000).toISOString()}`,
    );
    await client.close();
    await served;
  });

  it('refuses to start on a sandbox the control plane does not have, naming it on stderr', async () => {
    const { home, env, io } = setup();
    const cp = fakeCp({
      [`GET /v1/sandboxes/${SBX}`]: () => ({
        status: 404,
        body: { error: 'sandbox_not_found', message: 'no such sandbox' },
      }),
    });
    const [serverSide] = InMemoryTransport.createLinkedPair();
    expect(
      await sbxMain(['mcp', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        execFactory: fakeExec().factory,
        mcpTransport: serverSide,
      }),
    ).toBe(1);
    expect(io.errs.join('\n')).toContain('no such sandbox');
    expect(io.outs).toEqual([]);
  });

  /** A sandbox token whose (unverified) payload carries a `mode` claim. */
  const modeJwt = (mode: string) => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b({ alg: 'EdDSA' })}.${b({ sbx: SBX, iat: TOKEN_IAT, exp: TOKEN.expiresAt, mode })}.sig`;
  };
  const ACTIVE: LeaseStatusView = {
    mode: 'lease',
    epochKnown: true,
    state: 'active',
    ageMs: 5_000,
    idleTimeoutS: 0,
  };
  /**
   * A lease sandbox's MCP session: each token mint takes the next of `modes` (the last repeats);
   * a `remint` command forces a mint, as the exec client's retry does.
   */
  function leaseSession(
    modes: string[],
    over: {
      keepalive?: () => Promise<void>;
      record?: () => string;
      /** Answers `reset` in place of the default; gets the call's signal. */
      reset?: (signal?: AbortSignal) => Promise<LeaseStatusView>;
    } = {},
  ) {
    const { home, env, io } = setup();
    let minted = 0;
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 200,
        body: { ...TOKEN, token: modeJwt(modes[Math.min(minted++, modes.length - 1)]!) },
      }),
      [`GET /v1/sandboxes/${SBX}`]: () => ({
        status: 200,
        body: sandbox({ mode: over.record?.() ?? 'lease' }),
      }),
    });
    const flags: boolean[] = [];
    const ops: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    let keepalives = 0;
    const factory: ExecFactory = (o) => ({
      exec: async (command) => {
        await o.token({ force: command === 'remint', minValidS: 60 });
        flags.push(typeof o.keepalive === 'function' ? o.keepalive() : Boolean(o.keepalive));
        return res({ stderr: Buffer.alloc(0) });
      },
      close: () => {},
      leaseControl: async (op, _token, x) => {
        ops.push(op);
        signals.push(x?.signal);
        if (op === 'reset' && over.reset) return over.reset(x?.signal);
        // A reset of the live lease leaves its end pending, as the worker does (spec §5).
        return op === 'reset' ? { ...ACTIVE, state: 'none', pending: RESET_END } : ACTIVE;
      },
      leaseKeepalive: async () => {
        keepalives++;
        await over.keepalive?.();
      },
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const served = sbxMain(['mcp', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: cp.fetchImpl,
      execFactory: factory,
      mcpTransport: serverSide,
    });
    const client = new Client({ name: 't', version: '0' });
    const bash = (command: string) =>
      client.callTool({ name: 'bash', arguments: { command } }) as Promise<{
        content: { text: string }[];
      }>;
    return {
      io,
      served,
      client,
      bash,
      flags,
      ops,
      signals,
      keepalives: () => keepalives,
      connect: () => client.connect(clientSide),
    };
  }

  it("keepalive follows the token's mode; stops on close", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const m = leaseSession(['lease', 'per-exec', 'lease']);
      await m.connect();
      await m.bash('echo'); // the first mint: lease
      expect(m.keepalives()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.keepalives()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.keepalives()).toBe(2);
      await m.bash('remint'); // the owner downgraded: the next mint says per-exec
      await vi.advanceTimersByTimeAsync(90_000);
      expect(m.keepalives()).toBe(2);
      await m.bash('remint'); // and back to lease
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.keepalives()).toBe(3);
      // Exec.keepalive follows each Exec's token.
      expect(m.flags).toEqual([true, false, true]);
      await m.client.close();
      expect(await m.served).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(m.keepalives()).toBe(3);
      expect(m.io.errs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing keepalive is ignored and logged once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const m = leaseSession(['lease'], {
        keepalive: async () => {
          throw new LeaseControlError('unavailable', 'relay down');
        },
      });
      await m.connect();
      await m.bash('echo');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(m.keepalives()).toBe(3);
      expect(m.io.errs).toEqual([
        'sbx mcp: lease keepalive failed (unavailable): relay down; further failures are not logged',
      ]);
      await m.client.close();
      await m.served;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lease sandbox gets the lease texts; reset and sandbox_info reach the connection's lease calls", async () => {
    const m = leaseSession(['lease']);
    await m.connect();
    expect(m.client.getInstructions()).toContain(LEASE_RULE);
    expect(m.client.getInstructions()).not.toMatch(/fresh VM/);
    const { tools } = await m.client.listTools();
    expect(tools.find((t) => t.name === 'bash')!.description).toContain(LEASE_RULE);
    const info = (await m.client.callTool({ name: 'sandbox_info', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(info.content[0]!.text).toContain(LEASE_RULE);
    expect(info.content[0]!.text).not.toMatch(/fresh VM/);
    expect(info.content[0]!.text).toMatch(/\nmode: lease\nlease: active\nage: 5s\n/);
    const reset = (await m.client.callTool({ name: 'reset', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(reset.content[0]!.text).toBe(RESET_ENDED_TEXT);
    expect(m.ops).toEqual(['status', 'reset']);
    await m.client.close();
    await m.served;
  });

  it("the reset tool passes its call's cancel signal to the lease calls (M1)", async () => {
    const m = leaseSession(['lease'], {
      // Held behind another client's Exec until the call is cancelled.
      reset: (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new LeaseControlError('cancelled', 'the lease call was cancelled')),
          ),
        ),
    });
    await m.connect();
    const ac = new AbortController();
    const p = m.client.callTool({ name: 'reset', arguments: {} }, undefined, {
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(m.ops).toEqual(['reset']));
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(m.signals.every((x) => x instanceof AbortSignal && x.aborted)).toBe(true);
    // The server's call queue is free again: the next call runs.
    expect((await m.bash('echo')).content[0]!.text).toBe('out\n');
    await m.client.close();
    await m.served;
  });

  it("reset and sandbox_info follow the latest minted token's mode over the start record", async () => {
    // The owner upgraded after the server started: the record it read said per-exec.
    const m = leaseSession(['lease'], { record: () => 'per-exec' });
    await m.connect();
    const reset = async () =>
      (
        (await m.client.callTool({ name: 'reset', arguments: {} })) as {
          content: { text: string }[];
        }
      ).content[0]!.text;
    expect(await reset()).toBe('no lease to reset'); // no token yet: the record decides
    expect(m.ops).toEqual([]);
    await m.bash('echo'); // the first mint carries lease
    expect(await reset()).toBe(RESET_ENDED_TEXT);
    expect(m.ops).toEqual(['reset']);
    const info = (await m.client.callTool({ name: 'sandbox_info', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(info.content[0]!.text).toContain('\nmode: lease\nlease: active\n');
    expect(m.ops).toEqual(['reset', 'status']);
    await m.client.close();
    await m.served;
  });

  it('reset before any mint re-reads the record: upgraded since start, it resets', async () => {
    let record = 'per-exec';
    const m = leaseSession(['lease'], { record: () => record });
    await m.connect(); // the server read per-exec at start
    record = 'lease'; // the owner upgrades; no call has minted a token yet
    const r = (await m.client.callTool({ name: 'reset', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(r.content[0]!.text).toBe(RESET_ENDED_TEXT);
    expect(m.ops).toEqual(['reset']);
    await m.client.close();
    await m.served;
  });

  it('after a mode change, the next file tool call succeeds: the exec client re-mints on stale_mode (P4-R21)', async () => {
    // Review Focus 5, the Exec half: the owner downgrades while the MCP session runs. The held
    // token (900 s) still covers a file tool's 120 s ask, so the next `read` goes out under the old
    // epoch; the worker refuses it stale_mode, and the real exec client re-mints and retries.
    const { home, env, io } = setup();
    const epochJwt = (mode: string, mode_epoch: number) => {
      const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const claims = { sbx: SBX, iat: TOKEN_IAT, exp: TOKEN.expiresAt, mode, mode_epoch };
      return `${b({ alg: 'EdDSA' })}.${b(claims)}.sig`;
    };
    let current = { mode: 'lease', epoch: 1 };
    let mints = 0;
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => (
        mints++,
        { status: 200, body: { ...TOKEN, token: epochJwt(current.mode, current.epoch) } }
      ),
      [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ mode: 'lease' }) }),
    });
    type Claims = { mode_epoch: number };
    const epochOf = (bearer: string) =>
      (JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as Claims).mode_epoch;
    const relay = await fakeExecRelay((_req, bearer) =>
      epochOf(bearer) < current.epoch
        ? {
            refuse: `stale_mode: workspace_key ${SBX} Exec mode_epoch ${epochOf(bearer)} is below the stored ${current.epoch}`,
          }
        : { stdout: `file at epoch ${current.epoch}\n` },
    );
    try {
      // The real connection, dialed at the fake relay in plain text.
      const factory: ExecFactory = (o) => {
        const c = new SandboxExecConn({ ...o, addr: relay.addr, tls: false, caPem: undefined });
        return {
          exec: c.exec,
          close: c.close,
          leaseControl: c.leaseControl,
          leaseKeepalive: c.leaseKeepalive,
        };
      };
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const served = sbxMain(['mcp', '--sandbox', SBX], env, io, {
        home,
        fetchImpl: cp.fetchImpl,
        execFactory: factory,
        mcpTransport: serverSide,
      });
      const client = new Client({ name: 't', version: '0' });
      await client.connect(clientSide);
      const read = () =>
        client.callTool({ name: 'read', arguments: { path: 'f' } }) as Promise<{
          content: { text: string }[];
          isError?: boolean;
        }>;
      const before = await read();
      expect(before.isError).toBeFalsy();
      expect(before.content[0]!.text).toBe('file at epoch 1\n');
      current = { mode: 'per-exec', epoch: 2 }; // `mocactl sbx mode per-exec` in another terminal
      const after = await read();
      expect(after.isError).toBeFalsy();
      expect(after.content[0]!.text).toBe('file at epoch 2\n');
      expect(mints).toBe(2); // the first token, then the retry's forced mint
      expect(relay.seen.map((s) => epochOf(s.bearer))).toEqual([1, 1, 2]);
      // Exec.keepalive follows the re-minted per-exec token.
      expect(relay.seen.map((s) => s.req.exec!.keepalive)).toEqual([true, true, false]);
      await client.close();
      expect(await served).toBe(0);
    } finally {
      relay.close();
    }
  });

  it('jwtMode reads the mode claim; anything else is per-exec', () => {
    expect(jwtMode(modeJwt('lease+processes'))).toBe('lease+processes');
    expect(jwtMode(modeJwt('bogus'))).toBe('per-exec');
    expect(jwtMode(TOKEN.token)).toBe('per-exec');
    expect(jwtMode('not-a-jwt')).toBe('per-exec');
  });

  it('stops serving when the signal aborts', async () => {
    const { home, env, io } = setup();
    const ac = new AbortController();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const served = sbxMain(['mcp', '--sandbox', SBX], env, io, {
      home,
      fetchImpl: cpWithSandbox().fetchImpl,
      execFactory: fakeExec().factory,
      mcpTransport: serverSide,
      signal: ac.signal,
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    ac.abort();
    expect(await served).toBe(0);
  });
});

describe('the flight recorder', () => {
  it('appends JSON lines, skipping a torn line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-rec-'));
    recordCall(dir, SBX, { tool: 'ls', ms: 3 });
    writeFileSync(join(dir, 'sbx', `${SBX}.log`), '{"to\n', { flag: 'a' }); // a torn line
    recordCall(dir, SBX, { tool: 'read', ms: 4 });
    expect(readRecords(dir, SBX)).toEqual([
      { tool: 'ls', ms: 3 },
      { tool: 'read', ms: 4 },
    ]);
    expect(readRecords(dir, 'sbx-none')).toEqual([]);
  });

  it('refuses an id that is not a sandbox id, so no path can be named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-rec-'));
    expect(() => recordCall(dir, '../x', { tool: 'ls' })).toThrow(/not a sandbox id/);
    expect(() => readRecords(dir, '../x')).toThrow(/not a sandbox id/);
  });
});

describe("a bound sandbox's control plane (R5j)", () => {
  const MCP_URL = 'https://sbx-bound.example.invalid';
  const repoBoundTo = (controlPlaneUrl: string) => {
    const repo = mkdtempSync(join(tmpdir(), 'mocactl-sbx-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.sbx'));
    writeFileSync(
      join(repo, '.sbx', 'sandbox.json'),
      JSON.stringify({ id: SBX, controlPlaneUrl, template: 'node22' }),
    );
    return repo;
  };
  /** Records which host each request went to. */
  const hosts = () => {
    const seen: string[] = [];
    const inner = mint().fetchImpl;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen.push(new URL(String(input)).origin);
      return inner(input, init);
    }) as typeof fetch;
    return { seen, fetchImpl };
  };

  it("uses the binding's controlPlaneUrl when neither the flag nor MOCACTL_SBX_URL gives one", async () => {
    const { home, paths, io } = setup({ loggedIn: false });
    saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ }); // remembered: another one
    saveAuth(sbxPaths(paths), { ...LOGIN, controlPlaneUrl: MCP_URL });
    const h = hosts();
    const code = await sbxMain(['run', '--', 'ls'], { HOME: home }, io, {
      home,
      fetchImpl: h.fetchImpl,
      execFactory: fakeExec().factory,
      cwd: repoBoundTo(MCP_URL),
    });
    expect(code).toBe(0);
    expect(h.seen).toEqual([MCP_URL]);
  });

  it("with no login for the binding's control plane, says how to log in to that one (exit 3)", async () => {
    const { home, io } = setup(); // logged in to URL_, not MCP_URL
    const h = hosts();
    expect(
      await sbxMain(['mcp'], { HOME: home }, io, {
        home,
        fetchImpl: h.fetchImpl,
        cwd: repoBoundTo(MCP_URL),
      }),
    ).toBe(3);
    expect(io.errs.join('\n')).toContain(`mocactl sbx login --control-plane-url '${MCP_URL}'`);
    expect(io.errs.join('\n')).toContain(`at ${MCP_URL} (from .sbx/sandbox.json)`);
    expect(h.seen).toEqual([]);
  });

  it('warns when the binding names another control plane than the one logged in to', async () => {
    const { home, paths, io } = setup();
    saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ });
    const h = hosts();
    expect(
      await sbxMain(['mcp'], { HOME: home }, io, {
        home,
        fetchImpl: h.fetchImpl,
        cwd: repoBoundTo(MCP_URL),
      }),
    ).toBe(3);
    expect(io.errs.join('\n')).toContain(
      `that is not the control plane you logged in to (${URL_}): log in there only if you trust it`,
    );
  });

  it('ignores a binding URL with a control character or a space, and never prints the escape', async () => {
    const { home, paths, io } = setup();
    saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ });
    for (const bad of [
      'https://x.example.invalid/\u001b]52;c;aGk=\u0007',
      'https://a b.example.invalid',
    ]) {
      const h = hosts();
      await sbxMain(['run', '--', 'ls'], { HOME: home }, io, {
        home,
        fetchImpl: h.fetchImpl,
        execFactory: fakeExec().factory,
        cwd: repoBoundTo(bad),
      });
      expect(h.seen).toEqual([URL_]); // the remembered one, not the bad binding
    }
    expect(io.errs.join('\n')).not.toContain('\u001b');
  });

  it('prints a bad bound id without its terminal escapes', async () => {
    const { home, env, io } = setup();
    const repo = mkdtempSync(join(tmpdir(), 'mocactl-sbx-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.sbx'));
    writeFileSync(join(repo, '.sbx', 'sandbox.json'), JSON.stringify({ id: 'sbx-\u001b[2Jx' }));
    expect(await sbxMain(['run', '--', 'ls'], env, io, { home, cwd: repo })).toBe(2);
    expect(io.errs.join('\n')).toContain("'sbx-x' is not a sandbox id");
    expect(io.errs.join('\n')).not.toContain('\u001b');
  });

  it('a flag or MOCACTL_SBX_URL still wins over the binding', async () => {
    const { home, env, io } = setup();
    const h = hosts();
    await sbxMain(['run', '--', 'ls'], env, io, {
      home,
      fetchImpl: h.fetchImpl,
      execFactory: fakeExec().factory,
      cwd: repoBoundTo(MCP_URL),
    });
    expect(h.seen).toEqual([URL_]);
  });

  it('an explicit --sandbox id does not take the binding URL', async () => {
    const { home, paths, io } = setup();
    saveConfig(paths, { ...DEFAULT_CONFIG, sbxControlPlaneUrl: URL_ });
    const h = hosts();
    await sbxMain(['run', '--sandbox', SBX, '--', 'ls'], { HOME: home }, io, {
      home,
      fetchImpl: h.fetchImpl,
      execFactory: fakeExec().factory,
      cwd: repoBoundTo(MCP_URL),
    });
    expect(h.seen).toEqual([URL_]);
  });
});
