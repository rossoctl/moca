import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecMachineryError,
  leaseNotice,
  ProcessError,
  type LeaseEvent,
  type ProcessArgsByOp,
  type ProcessCall,
  type ProcessOp,
  type TrackedProcessView,
} from '@moca/sandbox-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sbxMain } from '../src/sbx/cli.js';
import type { ExecFactory } from '../src/sbx/exec.js';
import {
  cleanupTmp,
  fakeCp,
  jwt,
  NO_LEASE,
  sandbox,
  SBX,
  setup,
  tmp,
  TOKEN,
  TOKEN_IAT,
} from './helpers/sbx.js';

afterEach(cleanupTmp);

/** A tracked process as `process_list` gives it (spec §7). */
const row = (over: Partial<TrackedProcessView> = {}): TrackedProcessView => ({
  id: '3',
  name: 'web',
  pid: 412,
  state: 'running',
  code: 0,
  ageMs: 130_400,
  memoryBytes: 12.5 * 1024 * 1024,
  ...over,
});

/** A lease event as the worker sends it (spec §5). */
const ev = (over: Partial<LeaseEvent>): LeaseEvent => ({
  reqId: 0,
  state: 'end',
  reason: 'idle',
  atUnixMs: 1_800_000_100_000,
  mode: 3,
  ageMs: 60_000,
  processes: [],
  endsByUnixMs: 0,
  tracked: [],
  ...over,
});

type Answer = (op: ProcessOp, args: unknown, signal?: AbortSignal) => unknown;

/**
 * `sbx proc`'s world: a control plane minting a token with the record's mode claim, and a
 * connection whose process calls are recorded and answered by `answer` (a value is the result,
 * with `lease` events; an Error is thrown).
 */
function world(
  o: {
    mode?: string;
    answer?: Answer;
    lease?: LeaseEvent[];
    cwd?: string;
    stdoutIsTTY?: boolean;
  } = {},
) {
  const s = setup();
  const mode = o.mode ?? 'lease+processes';
  const cp = fakeCp({
    [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: sandbox({ mode }) }),
    [`POST /v1/sandboxes/${SBX}/token`]: () => ({
      status: 200,
      body: { ...TOKEN, token: jwt({ iat: TOKEN_IAT, exp: TOKEN_IAT + 900, mode }) },
    }),
  });
  const calls: { op: ProcessOp; args: unknown; signal: boolean }[] = [];
  let closed = 0;
  const answer: Answer =
    o.answer ??
    ((op) =>
      ({
        start: { id: '3', name: 'web', pid: 412 },
        list: [row()],
        logs: 'listening on 8080\n',
        stop: row({ state: 'killed', code: 15 }),
      })[op]);
  const process = (async (op: ProcessOp, args: unknown, opts?: { signal?: AbortSignal }) => {
    calls.push({ op, args, signal: !!opts?.signal });
    const a = await answer(op, args, opts?.signal);
    if (a instanceof Error) throw a;
    return { result: a, lease: o.lease ?? [] };
  }) as ProcessCall;
  const factory: ExecFactory = () => ({
    exec: async () => {
      throw new Error('no command runs in these tests');
    },
    close: () => void closed++,
    ...NO_LEASE,
    process,
  });
  const ac = new AbortController();
  const run = (argv: string[]) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      execFactory: factory,
      signal: ac.signal,
      cwd: o.cwd ?? tmp('sbx-proc-cwd-'),
      ...(o.stdoutIsTTY !== undefined ? { stdoutIsTTY: o.stdoutIsTTY } : {}),
    });
  };
  return {
    ...s,
    cp,
    calls,
    ac,
    run,
    err: () => s.io.errs.join('\n'),
    out: () => s.io.outs.join(''),
    closed: () => closed,
  };
}

const args = <O extends ProcessOp>(c: { args: unknown }) => c.args as ProcessArgsByOp[O];

describe('mocactl sbx proc start (spec §7, P5-R31)', () => {
  it('start sends the command after --, quoted as run quotes it, and prints <id> <name> pid <n>', async () => {
    const w = world();
    expect(
      await w.run([
        'proc',
        'start',
        '--name',
        'web',
        '--cwd',
        'app',
        SBX,
        '--',
        'python3',
        '-m',
        'http.server',
        '8080',
      ]),
    ).toBe(0);
    expect(w.calls).toEqual([
      {
        op: 'start',
        args: { command: "'python3' '-m' 'http.server' '8080'", name: 'web', cwd: 'app' },
        signal: true,
      },
    ]);
    expect(w.out()).toBe('p3 web pid 412\n');
    expect(w.closed()).toBe(1);
  });

  it('an unnamed process is shown by its id, once (final review M3)', async () => {
    // The guest names an unnamed process p<id>; an empty name reads the same.
    for (const name of ['p7', '']) {
      const w = world({ answer: () => ({ id: '7', name, pid: 9 }) });
      expect(await w.run(['proc', 'start', SBX, '--', 'sleep', '100'])).toBe(0);
      expect(args<'start'>(w.calls[0]!)).toEqual({ command: "'sleep' '100'" });
      expect(w.out(), name).toBe('p7 pid 9\n');
    }
  });

  it('the sandbox defaults to the bound one; --sandbox works too', async () => {
    const d = tmp('sbx-proc-bound-');
    mkdirSync(join(d, '.sbx'));
    writeFileSync(join(d, '.sbx', 'sandbox.json'), JSON.stringify({ id: SBX }));
    const w = world({ cwd: d });
    expect(await w.run(['proc', 'start', '--', 'true'])).toBe(0);
    expect(w.out()).toBe('p3 web pid 412\n');
    const f = world();
    expect(await f.run(['proc', 'ls', '--sandbox', SBX])).toBe(0);
    // Neither: a usage error, before any request.
    const n = world();
    expect(await n.run(['proc', 'ls'])).toBe(2);
    expect(n.err()).toContain(
      'sbx: proc needs a sandbox id (or a .sbx/sandbox.json in this repository)',
    );
    expect(n.cp.calls).toEqual([]);
  });

  it('start needs a command after --, and at most one ID before it', async () => {
    const w = world();
    expect(await w.run(['proc', 'start', SBX])).toBe(2);
    expect(w.err()).toContain(
      'sbx: proc start needs a command: mocactl sbx proc start [ID] -- CMD',
    );
    expect(await w.run(['proc', 'start', SBX, '--'])).toBe(2);
    expect(await w.run(['proc', 'start', 'sleep', '100'])).toBe(2);
    expect(await w.run(['proc', 'start', SBX, 'extra', '--', 'true'])).toBe(2);
    expect(w.err()).toContain('too many arguments for proc start');
    expect(w.cp.calls).toEqual([]);
  });
});

describe('mocactl sbx proc ls', () => {
  it('ls prints one row per process, ids as p<id>; --json the TrackedProcessView[] array', async () => {
    const list = [
      row(),
      row({ id: '4', name: 'p4', pid: 9, state: 'exited', code: 1, ageMs: 4_999, memoryBytes: 0 }),
    ];
    const w = world({ answer: () => list });
    expect(await w.run(['proc', 'ls', SBX])).toBe(0);
    expect(w.calls).toEqual([{ op: 'list', args: {}, signal: true }]);
    expect(w.out()).toBe(
      'p3 web (pid 412): running, 2m10s, 12.5 MiB\np4 (pid 9): exited(1), 0.0 MiB\n',
    );
    expect(await w.run(['proc', 'ls', SBX, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(list);
    const e = world({ answer: () => [] });
    expect(await e.run(['proc', 'ls', SBX])).toBe(0);
    expect(e.out()).toBe('no tracked processes\n');
    expect(await e.run(['proc', 'ls', SBX, '--json'])).toBe(0);
    expect(JSON.parse(e.out())).toEqual([]);
  });

  it('a name from the worker is sanitized before it reaches the terminal', async () => {
    const w = world({ answer: () => [row({ name: 'we\u001b[2Jb' })] });
    expect(await w.run(['proc', 'ls', SBX])).toBe(0);
    expect(w.out()).not.toContain('\u001b');
  });
});

describe('mocactl sbx proc logs and stop (P5-R6, P5-R31)', () => {
  it('the process is p<n> or a decimal id (sent as the id), or a name', async () => {
    for (const [given, sel] of [
      ['p3', { id: '3' }],
      ['3', { id: '3' }],
      ['web', { name: 'web' }],
      ['p3x', { name: 'p3x' }],
    ] as const) {
      const w = world();
      expect(await w.run(['proc', 'logs', given, SBX])).toBe(0);
      expect(args<'logs'>(w.calls[0]!)).toEqual(sel);
      expect(await w.run(['proc', 'stop', given])).toBe(2);
      expect(await w.run(['proc', 'stop', given, '--sandbox', SBX])).toBe(0);
      expect(args<'stop'>(w.calls[1]!)).toEqual(sel);
    }
  });

  it('logs prints the tail as it came, with --tail N', async () => {
    const w = world();
    expect(await w.run(['proc', 'logs', 'web', '--tail', '50', SBX])).toBe(0);
    expect(w.calls).toEqual([{ op: 'logs', args: { name: 'web', tail: 50 }, signal: true }]);
    expect(w.out()).toBe('listening on 8080\n');
    expect(await w.run(['proc', 'logs', 'web', '--tail=4294967295', SBX])).toBe(0);
    expect(w.calls[1]).toEqual({
      op: 'logs',
      args: { name: 'web', tail: 4294967295 },
      signal: true,
    });
  });

  // PR #814 review: --tail is a uint32 on the wire; above 2^32-1 it would wrap (4294967296 sent
  // as 0, the guest's default), so it is a usage error.
  it('--tail that is not a whole number from 1 to 4294967295 is a usage error, nothing sent', async () => {
    const w = world();
    for (const bad of [
      '0',
      '-1',
      '2.5',
      'lots',
      '4294967296',
      '4294967297',
      '99999999999999999999',
    ]) {
      expect(await w.run(['proc', 'logs', 'web', `--tail=${bad}`, SBX])).toBe(2);
      expect(w.err()).toContain('--tail must be a whole number of lines, from 1 to 4294967295');
    }
    expect(w.calls).toHaveLength(0);
  });

  // PR #814 review: logs replays, later and out of band, output of a process the agent started;
  // on a terminal its control sequences (OSC 52 clipboard writes, OSC 8 links, titles) are
  // removed. Piped, or with --raw, it is passed through byte for byte.
  it('logs sanitizes on a terminal; piped or with --raw it is raw', async () => {
    const hostile = 'ok\n\x1b]52;c;cHduZWQ=\x07\x1b]0;title\x07\x1b[31mred\x1b[0m\tdone\n';
    const tty = world({ stdoutIsTTY: true, answer: () => hostile });
    expect(await tty.run(['proc', 'logs', 'web', SBX])).toBe(0);
    expect(tty.out()).toBe('ok\nred\tdone\n');
    expect(await tty.run(['proc', 'logs', 'web', '--raw', SBX])).toBe(0);
    expect(tty.out()).toBe(hostile);
    const piped = world({ stdoutIsTTY: false, answer: () => hostile });
    expect(await piped.run(['proc', 'logs', 'web', SBX])).toBe(0);
    expect(piped.out()).toBe(hostile);
    expect(await piped.run(['proc', 'ls', '--raw', SBX])).toBe(2);
    expect(piped.err()).toContain('--raw only applies to proc logs');
  });

  it('stop sends --signal and prints the final state', async () => {
    const w = world();
    expect(await w.run(['proc', 'stop', 'p3', '--signal', 'INT', SBX])).toBe(0);
    expect(w.calls).toEqual([{ op: 'stop', args: { id: '3', signal: 'INT' }, signal: true }]);
    expect(w.out()).toBe('p3 web (pid 412): killed(15), 12.5 MiB\n');
  });

  it('logs and stop need the process; at most one sandbox after it', async () => {
    const w = world();
    for (const sub of ['logs', 'stop']) {
      expect(await w.run(['proc', sub])).toBe(2);
      expect(w.err()).toContain(`sbx: proc ${sub} needs a process: its name, or its id (p<n>)`);
      expect(await w.run(['proc', sub, 'web', SBX, 'extra'])).toBe(2);
      expect(w.err()).toContain(`too many arguments for proc ${sub}`);
    }
    expect(w.cp.calls).toEqual([]);
  });
});

describe('mocactl sbx proc: usage', () => {
  it('an unknown or missing subcommand is a usage error', async () => {
    const w = world();
    expect(await w.run(['proc'])).toBe(2);
    expect(w.err()).toContain('sbx: proc needs a subcommand: start, ls, logs or stop');
    expect(await w.run(['proc', 'kill', 'web'])).toBe(2);
    expect(w.err()).toContain("sbx: unknown proc command 'kill'");
    expect(w.cp.calls).toEqual([]);
  });

  it('each flag belongs to its subcommand; --json to ls only', async () => {
    const w = world();
    for (const [argv, text] of [
      [['proc', 'ls', SBX, '--name', 'web'], '--name only applies to proc start'],
      [['proc', 'ls', SBX, '--cwd', 'x'], '--cwd only applies to proc start'],
      [['proc', 'start', '--tail', '5', SBX, '--', 'true'], '--tail only applies to proc logs'],
      [['proc', 'logs', 'web', '--signal', 'INT', SBX], '--signal only applies to proc stop'],
      [['proc', 'start', '--json', SBX, '--', 'true'], 'sbx: proc start has no --json output'],
      [['proc', 'stop', 'web', '--json', SBX], 'sbx: proc stop has no --json output'],
      [['ls', '--cwd', 'x'], '--cwd only applies to proc start'],
      [['run', '--signal', 'INT', '--', 'true'], '--signal only applies to proc stop'],
      [['get', SBX, '--tail', '5'], '--tail only applies to proc logs'],
      [['run', '--raw', '--', 'true'], '--raw only applies to proc logs'],
    ] as const) {
      expect(await w.run([...argv]), argv.join(' ')).toBe(2);
      expect(w.err()).toContain(text);
    }
    expect(w.cp.calls).toEqual([]);
  });

  it('the help lists the proc commands', async () => {
    const w = world();
    expect(await w.run(['--help'])).toBe(0);
    expect(w.out()).toContain('mocactl sbx proc start [--name N] [--cwd D] [ID] -- CMD ...');
    expect(w.out()).toContain('mocactl sbx proc ls [ID] [--json]');
    expect(w.out()).toContain('mocactl sbx proc logs (NAME|ID) [--tail N] [--raw] [ID]');
    expect(w.out()).toContain('control sequences are removed (--raw keeps them;');
    expect(w.out()).toContain('mocactl sbx proc stop (NAME|ID) [--signal S] [ID]');
    // A downgrade to lease keeps the lease (plan 5): the mode line no longer says it ends.
    expect(w.out()).not.toContain('command; a downgrade ends the lease');
    expect(w.out()).toContain('a downgrade to per-exec ends the lease;');
    expect(w.out()).toContain('lease+processes to lease keeps it and stops the');
  });
});

describe('mocactl sbx proc: refusals, failures, notices', () => {
  it('below lease+processes: the CLI §7 text, exit 1, and nothing is sent', async () => {
    for (const mode of ['per-exec', 'lease']) {
      const w = world({ mode });
      expect(await w.run(['proc', 'ls', SBX])).toBe(1);
      expect(w.err()).toBe(
        `sbx: processes not enabled for this sandbox; run: mocactl sbx mode lease+processes ${SBX}`,
      );
      expect(w.calls).toEqual([]);
      expect(w.closed()).toBe(1);
    }
  });

  it("the worker's refusals are said in the CLI's words, exit 1", async () => {
    for (const [err, text] of [
      [
        new ProcessError('process_not_found', 'web', 'process_not_found: web'),
        'sbx: no tracked process web; mocactl sbx proc ls shows them',
      ],
      [
        // The guest's bare id, shown as the rows show ids (final review M2).
        new ProcessError('process_not_found', '3', 'process_not_found: 3'),
        'sbx: no tracked process p3; mocactl sbx proc ls shows them',
      ],
      [
        // A call that queued behind a running command on the sandbox's run gate (final review M4).
        new ExecMachineryError(
          'sandbox failure: process_stop timed out waiting for the sandbox (another command may still be running)',
          undefined,
          'machinery',
          true,
        ),
        'sbx: sandbox failure: process_stop timed out waiting for the sandbox (another command may still be running); the command may have partly run',
      ],
      [
        new ProcessError('process_name_taken', 'web', 'process_name_taken: web'),
        'sbx: a running process is already named web; choose another name, or stop it first',
      ],
      [
        new ProcessError(
          'processes_not_enabled',
          'mode lease',
          'processes_not_enabled: mode lease',
        ),
        `sbx: processes not enabled for this sandbox; run: mocactl sbx mode lease+processes ${SBX}`,
      ],
      [
        new ExecMachineryError('sandbox failure: worker unavailable'),
        'sbx: sandbox failure: worker unavailable',
      ],
      [
        // The relay's worker gate (P5-R37): the worker predates level 2.
        new ProcessError(
          'lease_unsupported',
          "this sandbox's worker does not support tracked processes",
          "lease_unsupported: this sandbox's worker does not support tracked processes",
        ),
        "sbx: tracked processes are not available on this sandbox's worker yet (ask the operator)",
      ],
    ] as const) {
      const w = world({ answer: () => err });
      expect(await w.run(['proc', 'stop', 'web', SBX])).toBe(1);
      expect(w.err()).toBe(text);
      expect(w.out()).toBe('');
      expect(w.closed()).toBe(1);
    }
  });

  it("a failed token mint is the control plane's answer", async () => {
    const s = setup();
    const cp = fakeCp({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 409,
        body: { error: 'sandbox_terminated', message: 'sandbox was deleted', reason: 'deleted' },
      }),
    });
    expect(
      await sbxMain(['proc', 'ls', SBX], s.env, s.io, { home: s.home, fetchImpl: cp.fetchImpl }),
    ).toBe(1);
    expect(s.io.errs.join('\n')).toContain('sandbox was deleted');
  });

  it('the lease events a call carries are said first, on stderr, once; a failure says them too', async () => {
    const end = ev({ reason: 'idle' });
    const w = world({ lease: [end] });
    expect(await w.run(['proc', 'ls', SBX])).toBe(0);
    expect(w.io.errs).toEqual([leaseNotice(end, Date.now())]);
    expect(await w.run(['proc', 'ls', SBX])).toBe(0);
    expect(w.io.errs).toEqual([]);
    const later = ev({ reason: 'memory_reclaim', atUnixMs: end.atUnixMs + 60_000 });
    const f = world({
      answer: () => new ProcessError('process_not_found', 'web', 'process_not_found: web', [later]),
    });
    expect(await f.run(['proc', 'logs', 'web', SBX])).toBe(1);
    expect(f.io.errs).toEqual([
      leaseNotice(later, Date.now()),
      'sbx: no tracked process web; mocactl sbx proc ls shows them',
    ]);
  });

  it('Ctrl-C during a call exits 130', async () => {
    const w = world({
      answer: (_op, _a, signal) =>
        new Promise((_res, rej) =>
          signal?.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }),
        ),
    });
    const p = w.run(['proc', 'start', SBX, '--', 'sleep', '100']);
    await vi.waitFor(() => expect(w.calls).toHaveLength(1));
    w.ac.abort();
    expect(await p).toBe(130);
    expect(w.err()).toContain(
      'sbx: interrupted: the process may have started; mocactl sbx proc ls shows it',
    );
    expect(w.out()).toBe('');
    expect(w.closed()).toBe(1);
  });

  it('Ctrl-C during ls, logs or stop exits 130: silent for ls and logs, "may have stopped" for stop', async () => {
    for (const [argv, said] of [
      [['proc', 'ls', SBX], undefined],
      [['proc', 'logs', 'web', SBX], undefined],
      [
        ['proc', 'stop', 'web', SBX],
        'sbx: interrupted: the process may have stopped; mocactl sbx proc ls shows it',
      ],
    ] as const) {
      const w = world({
        answer: (_op, _a, signal) =>
          new Promise((_res, rej) =>
            signal?.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }),
          ),
      });
      const p = w.run([...argv]);
      await vi.waitFor(() => expect(w.calls).toHaveLength(1));
      w.ac.abort();
      expect(await p, argv.join(' ')).toBe(130);
      expect(w.io.errs, argv.join(' ')).toEqual(said === undefined ? [] : [said]);
      expect(w.out()).toBe('');
    }
  });

  it('Ctrl-C before the call was sent (during the token mint) says nothing was sent (fix round 1)', async () => {
    for (const argv of [
      ['proc', 'start', SBX, '--', 'sleep', '100'],
      ['proc', 'stop', 'web', SBX],
    ]) {
      const s = setup();
      let hung = 0;
      const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
        hung++;
        return new Promise<Response>((_res, rej) => {
          const stop = () => rej(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) stop();
          init?.signal?.addEventListener('abort', stop, { once: true });
        });
      }) as typeof fetch;
      let dialled = 0;
      const ac = new AbortController();
      const p = sbxMain(argv, s.env, s.io, {
        home: s.home,
        fetchImpl,
        execFactory: () => {
          dialled++;
          throw new Error('not dialled');
        },
        signal: ac.signal,
        cwd: tmp('sbx-proc-cwd-'),
      });
      await vi.waitFor(() => expect(hung).toBe(1));
      ac.abort();
      expect(await p, argv.join(' ')).toBe(130);
      expect(dialled).toBe(0);
      expect(s.io.errs, argv.join(' ')).toEqual(['sbx: interrupted: nothing was sent']);
    }
  });

  it('ls --json stdout stays pure JSON when the call carries a lease event: the notice is on stderr', async () => {
    const end = ev({ reason: 'idle' });
    const w = world({ lease: [end] });
    expect(await w.run(['proc', 'ls', SBX, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual([row()]);
    expect(w.io.errs).toEqual([leaseNotice(end, Date.now())]);
  });

  it('start --name refuses a name the guest would, id-shaped ones included, before any request (P5-R33)', async () => {
    const WANT = 'want 1-64 characters of [A-Za-z0-9._-], not shaped like an id (p<n>)';
    const w = world();
    for (const [name, detail] of [
      ['p3', `"p3": ${WANT}`],
      ['7', `"7": ${WANT}`],
      ['a b', `"a b": ${WANT}`],
    ] as const) {
      expect(await w.run(['proc', 'start', '--name', name, SBX, '--', 'true'])).toBe(2);
      // The line, then the usage.
      expect(w.io.errs[0]!.split('\n')[0]).toBe(`sbx: invalid name: ${detail}`);
    }
    expect(w.cp.calls).toEqual([]);
    expect(await w.run(['proc', 'start', '--name', 'p3x', SBX, '--', 'true'])).toBe(0);
  });
});
