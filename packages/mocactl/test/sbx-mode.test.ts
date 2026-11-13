import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LeaseControlError,
  leaseNotice,
  type LeaseEvent,
  type LeaseOpName,
  type LeaseStatusView,
} from '@moca/sandbox-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sbxMain } from '../src/sbx/cli.js';
import type { ExecFactory } from '../src/sbx/exec.js';
import { modeRank, sendSetMode } from '../src/sbx/mode.js';
import {
  cleanupTmp,
  fakeCp,
  fakeLease,
  jwt,
  sandbox,
  SBX,
  setup,
  tmp,
  TOKEN,
  TOKEN_IAT,
} from './helpers/sbx.js';

afterEach(cleanupTmp);

/** What the worker answers once a lease mode's epoch is known (spec §8.3). */
const APPLIED: LeaseStatusView = {
  mode: 'lease',
  epochKnown: true,
  state: 'none',
  ageMs: 0,
  idleTimeoutS: 0,
};

/**
 * `sbx create`'s world: a control plane whose create stores the body's mode (epoch 1 for a lease
 * mode, as the control plane does), mints numbered set-mode tokens, and a connection whose lease
 * calls answer `setMode`.
 */
function world(
  o: {
    tty?: boolean;
    setMode?: (op: LeaseOpName, token?: string) => LeaseStatusView | Error;
  } = {},
) {
  const s = setup();
  let modeMints = 0;
  const cp = fakeCp({
    'POST /v1/sandboxes': (req) => {
      const b = req.body as { mode?: string; idleTimeoutS?: number };
      const mode = b.mode ?? 'per-exec';
      return {
        status: 201,
        body: sandbox({
          mode,
          modeEpoch: mode === 'per-exec' ? 0 : 1,
          idleTimeoutS: b.idleTimeoutS ?? 0,
        }),
      };
    },
    [`POST /v1/sandboxes/${SBX}/mode-token`]: () => ({
      status: 200,
      body: { setModeToken: `smt-${++modeMints}` },
    }),
    [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
  });
  const lease = fakeLease(o.setMode ?? (() => APPLIED));
  let opened = 0;
  let closed = 0;
  const factory: ExecFactory = () => {
    opened++;
    return {
      exec: async () => {
        throw new Error('no command runs in these tests');
      },
      close: () => void closed++,
      leaseControl: lease.leaseControl,
      leaseKeepalive: lease.leaseKeepalive,
    };
  };
  const run = (argv: string[]) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      execFactory: factory,
      stdinIsTTY: o.tty ?? true,
    });
  };
  return {
    ...s,
    cp,
    lease,
    run,
    err: () => s.io.errs.join('\n'),
    out: () => s.io.outs.join(''),
    conns: () => ({ opened, closed }),
    createBody: () => cp.calls.find((c) => c.path === '/v1/sandboxes')?.body,
    modeMints: () => cp.calls.filter((c) => c.path.endsWith('/mode-token')).length,
  };
}

describe('mocactl sbx create --mode (lease-mode spec §8.1, §8.2)', () => {
  it('create --mode lease sends set_mode with the minted token', async () => {
    const w = world();
    expect(await w.run(['create', '--template', 'node22', '--mode', 'lease'])).toBe(0);
    expect(w.createBody()).toEqual({ template: 'node22', mode: 'lease' });
    // The create answers no set-mode token: one is minted, then sent once, on its own connection.
    expect(w.modeMints()).toBe(1);
    expect(w.lease.calls).toEqual([{ op: 'set_mode', token: 'smt-1' }]);
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
    expect(w.out()).toBe(`${SBX}\n`);
    expect(w.err()).toContain('mode lease (epoch 1)');
  });

  it('create --mode lease, set_mode UNAVAILABLE → pending warning, exit 0', async () => {
    const w = world({ setMode: () => new LeaseControlError('unavailable', 'no live worker') });
    expect(await w.run(['create', '--mode', 'lease'])).toBe(0);
    expect(w.lease.calls).toEqual([{ op: 'set_mode', token: 'smt-1' }]);
    expect(w.err()).toContain(
      `lease pending (unavailable): the sandbox runs per-Exec until "mocactl sbx get ${SBX}" re-sends the mode`,
    );
    expect(w.out()).toBe(`${SBX}\n`);
  });

  it('create --mode lease+processes, set_mode DEADLINE_EXCEEDED is pending too', async () => {
    const w = world({ setMode: () => new LeaseControlError('timeout', 'deadline exceeded') });
    expect(await w.run(['create', '--mode', 'lease+processes'])).toBe(0);
    expect(w.err()).toContain('lease pending (timeout)');
  });

  it('create --mode lease or lease+processes refused without a TTY (exit 2)', async () => {
    for (const mode of ['lease', 'lease+processes']) {
      const w = world({ tty: false });
      expect(await w.run(['create', '--mode', mode])).toBe(2);
      expect(w.err()).toContain('an upgrade needs a terminal: run it yourself');
      // Refused before any request: nothing was created.
      expect(w.cp.calls).toEqual([]);
      expect(w.lease.calls).toEqual([]);
    }
  });

  it('create --json says whether set_mode was applied or is pending', async () => {
    const w = world();
    expect(await w.run(['create', '--mode', 'lease', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toMatchObject({ id: SBX, setMode: { outcome: 'applied' } });
    const p = world({ setMode: () => new LeaseControlError('unavailable', 'no live worker') });
    expect(await p.run(['create', '--mode', 'lease', '--json'])).toBe(0);
    expect(JSON.parse(p.out())).toMatchObject({
      id: SBX,
      setMode: { outcome: 'pending', code: 'unavailable' },
    });
    // A per-exec create has no set_mode, and says nothing of one.
    const e = world();
    expect(await e.run(['create', '--json'])).toBe(0);
    expect(JSON.parse(e.out())).not.toHaveProperty('setMode');
  });

  it("Ctrl-C during a lease create's set_mode prints the pending line, exit 130 (P4-R12)", async () => {
    const s = setup();
    const ac = new AbortController();
    const cp = fakeCp({
      'POST /v1/sandboxes': () => ({ status: 201, body: sandbox({ mode: 'lease', modeEpoch: 1 }) }),
      [`POST /v1/sandboxes/${SBX}/mode-token`]: () => ({
        status: 200,
        body: { setModeToken: 'smt-1' },
      }),
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    let sent = 0;
    let closed = 0;
    const factory: ExecFactory = () => ({
      exec: async () => {
        throw new Error('no command runs in this test');
      },
      close: () => void closed++,
      leaseControl: (op, t, o) => (sent++, untilAborted(op, t, o)),
      leaseKeepalive: async () => {},
    });
    const p = sbxMain(['create', '--mode', 'lease', '--seed'], s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      execFactory: factory,
      stdinIsTTY: true,
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(sent).toBe(1));
    ac.abort();
    expect(await p).toBe(130);
    expect(s.io.outs.join('')).toBe(`${SBX}\n`);
    expect(s.io.errs.join('\n')).toContain(`sbx: lease pending (cancelled)`);
    expect(closed).toBe(1);
  });

  it('create --mode per-exec needs no TTY and sends no set_mode', async () => {
    const w = world({ tty: false });
    expect(await w.run(['create', '--mode', 'per-exec'])).toBe(0);
    expect(w.createBody()).toEqual({ template: 'default', mode: 'per-exec' });
    expect(w.modeMints()).toBe(0);
    expect(w.lease.calls).toEqual([]);
    expect(w.conns().opened).toBe(0);
  });

  it('--idle-timeout 900 reaches the body', async () => {
    const w = world();
    expect(await w.run(['create', '--mode', 'lease', '--idle-timeout', '900'])).toBe(0);
    expect(w.createBody()).toEqual({ template: 'default', mode: 'lease', idleTimeoutS: 900 });
  });

  it('--idle-timeout must be a whole number of seconds, and only applies to create', async () => {
    for (const bad of ['0', '-5', '1.5', 'soon', '']) {
      const w = world();
      expect(await w.run(['create', '--mode', 'lease', '--idle-timeout', bad])).toBe(2);
      expect(w.err()).toContain('--idle-timeout');
      expect(w.cp.calls).toEqual([]);
    }
    const w = world();
    expect(await w.run(['ls', '--idle-timeout', '900'])).toBe(2);
    expect(w.err()).toContain('--idle-timeout only applies to create');
  });

  it('--mode bogus is a usage error (exit 2)', async () => {
    const w = world();
    expect(await w.run(['create', '--mode', 'bogus'])).toBe(2);
    expect(w.err()).toContain('--mode must be one of per-exec, lease, lease+processes');
    expect(w.cp.calls).toEqual([]);
    expect(await w.run(['ls', '--mode', 'lease'])).toBe(2);
    expect(w.err()).toContain('--mode only applies to create');
  });

  it('--json adds mode, modeEpoch and idleTimeoutS', async () => {
    const w = world();
    expect(await w.run(['create', '--mode', 'lease', '--idle-timeout', '600', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toMatchObject({
      id: SBX,
      mode: 'lease',
      modeEpoch: 1,
      idleTimeoutS: 600,
    });
  });

  it('a set_mode the worker refuses is exit 1, naming the sandbox that was created', async () => {
    const w = world({
      setMode: () => new LeaseControlError('failed', 'stale_mode: epoch 2 > 1', 'stale_mode: ...'),
    });
    expect(await w.run(['create', '--mode', 'lease'])).toBe(1);
    expect(w.out()).toBe(`${SBX}\n`);
    expect(w.err()).toContain(`sbx: ${SBX}: created, but its mode was not sent`);
    expect(w.err()).toContain('set_mode failed (failed): stale_mode: epoch 2 > 1');
    expect(w.err()).not.toContain('seed');
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
  });

  it('a hard set_mode failure on create --seed says the seed was not run', async () => {
    const w = world({
      setMode: () => new LeaseControlError('failed', 'stale_mode: epoch 2 > 1', 'stale_mode: ...'),
    });
    expect(await w.run(['create', '--mode', 'lease', '--seed'])).toBe(1);
    expect(w.out()).toBe(`${SBX}\n`);
    expect(w.io.errs).toContain(
      `sbx: ${SBX}: created, but its mode was not sent; the seed was not run`,
    );
    // No seed Exec went out: the factory's exec throws if one does.
    expect(w.err()).not.toContain('no command runs');
  });

  it('a control plane that ignores the mode is said so, and no set_mode is sent', async () => {
    const s = setup();
    const cp = fakeCp({ 'POST /v1/sandboxes': () => ({ status: 201, body: sandbox() }) });
    const old = sandbox() as Record<string, unknown>;
    delete old.mode;
    delete old.modeEpoch;
    delete old.idleTimeoutS;
    const oldCp = fakeCp({ 'POST /v1/sandboxes': () => ({ status: 201, body: old }) });
    for (const fetchImpl of [cp.fetchImpl, oldCp.fetchImpl]) {
      s.io.errs.length = 0;
      s.io.outs.length = 0;
      expect(
        await sbxMain(['create', '--mode', 'lease', '--json'], s.env, s.io, {
          home: s.home,
          fetchImpl,
          stdinIsTTY: true,
        }),
      ).toBe(0);
      expect(s.io.errs.join('\n')).toContain(
        `sbx: ${SBX} is per-exec, not lease: the control plane did not take the mode`,
      );
      // An answer without the mode fields reads as per-exec at epoch 0 (api.ts withMode).
      expect(JSON.parse(s.io.outs.join(''))).toMatchObject({
        mode: 'per-exec',
        modeEpoch: 0,
        idleTimeoutS: 0,
      });
    }
    expect([...cp.calls, ...oldCp.calls].map((c) => c.path)).toEqual([
      '/v1/sandboxes',
      '/v1/sandboxes',
    ]);
  });

  it("a lease mode the deployment does not allow is the control plane's 403, exit 1", async () => {
    const s = setup();
    const cp = fakeCp({
      'POST /v1/sandboxes': () => ({
        status: 403,
        body: {
          error: 'mode_not_allowed',
          message: "mode 'lease' is not allowed on this deployment",
        },
      }),
    });
    expect(
      await sbxMain(['create', '--mode', 'lease'], s.env, s.io, {
        home: s.home,
        fetchImpl: cp.fetchImpl,
        stdinIsTTY: true,
      }),
    ).toBe(1);
    expect(s.io.errs.join('\n')).toContain("mode 'lease' is not allowed on this deployment");
  });
});

describe('sendSetMode (spec §8.2, ruling R11)', () => {
  /** A control plane minting fresh set-mode tokens, and a connection answering `answers` in turn. */
  function parts(answers: Array<LeaseStatusView | Error>) {
    let mints = 0;
    const cp = {
      mintSandboxModeToken: async (id: string) => {
        expect(id).toBe(SBX);
        return { setModeToken: `fresh-${++mints}` };
      },
    };
    const lease = fakeLease(() => answers.shift() ?? new Error('no more answers'));
    return { cp, lease, mints: () => mints };
  }

  it('applied: the status after the op', async () => {
    const p = parts([APPLIED]);
    expect(await sendSetMode(p.lease, p.cp, SBX, 'smt')).toEqual({
      outcome: 'applied',
      status: APPLIED,
    });
    expect(p.lease.calls).toEqual([{ op: 'set_mode', token: 'smt' }]);
    expect(p.mints()).toBe(0);
  });

  it('sendSetMode retries once with a fresh mode token on PERMISSION_DENIED', async () => {
    const p = parts([new LeaseControlError('denied', 'set-mode token expired'), APPLIED]);
    expect(await sendSetMode(p.lease, p.cp, SBX, 'smt')).toEqual({
      outcome: 'applied',
      status: APPLIED,
    });
    expect(p.lease.calls).toEqual([
      { op: 'set_mode', token: 'smt' },
      { op: 'set_mode', token: 'fresh-1' },
    ]);
    expect(p.mints()).toBe(1);
  });

  it('fails on the second denial', async () => {
    const p = parts([
      new LeaseControlError('denied', 'first'),
      new LeaseControlError('denied', 'second'),
    ]);
    await expect(sendSetMode(p.lease, p.cp, SBX, 'smt')).rejects.toMatchObject({
      code: 'denied',
      message: 'second',
    });
    expect(p.lease.calls).toHaveLength(2);
    expect(p.mints()).toBe(1);
  });

  it('UNAVAILABLE or DEADLINE_EXCEEDED is pending, on the first send or the retry', async () => {
    for (const code of ['unavailable', 'timeout'] as const) {
      const p = parts([new LeaseControlError(code, 'x')]);
      expect(await sendSetMode(p.lease, p.cp, SBX, 'smt')).toEqual({ outcome: 'pending', code });
    }
    const p = parts([new LeaseControlError('denied', 'x'), new LeaseControlError('timeout', 'y')]);
    expect(await sendSetMode(p.lease, p.cp, SBX, 'smt')).toEqual({
      outcome: 'pending',
      code: 'timeout',
    });
  });

  it('every other error throws, with no retry', async () => {
    for (const code of ['invalid', 'busy', 'failed', 'cancelled', 'unauthenticated'] as const) {
      const p = parts([new LeaseControlError(code, 'x')]);
      await expect(sendSetMode(p.lease, p.cp, SBX, 'smt')).rejects.toMatchObject({ code });
      expect(p.lease.calls).toHaveLength(1);
      expect(p.mints()).toBe(0);
    }
  });

  it('modeRank: per-exec < lease < lease+processes', () => {
    expect([modeRank('per-exec'), modeRank('lease'), modeRank('lease+processes')]).toEqual([
      0, 1, 2,
    ]);
  });
});

/** A lease event as the worker sends it (spec §5). */
const ev = (over: Partial<LeaseEvent>): LeaseEvent => ({
  reqId: 0,
  state: 'end',
  reason: 'idle',
  atUnixMs: 1_800_000_100_000,
  mode: 2, // SANDBOX_MODE_LEASE
  ageMs: 60_000,
  processes: [],
  endsByUnixMs: 0,
  ...over,
});
const ACTIVE: LeaseStatusView = { ...APPLIED, state: 'active', ageMs: 42_000 };
/** A lease call that waits until its signal aborts, then fails as the relay's CANCELLED does. */
const untilAborted = (_op: LeaseOpName, _t?: string, o: { signal?: AbortSignal } = {}) =>
  new Promise<LeaseStatusView>((_res, rej) => {
    const stop = () => rej(new LeaseControlError('cancelled', 'cancelled on client'));
    if (o.signal?.aborted) stop();
    o.signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * `sbx mode`, `reset` and `get`'s world: a control plane holding one sandbox record (GET, PUT
 * …/mode raising the epoch, mode-token, token carrying the record's mode claim, DELETE), and a
 * connection whose lease calls answer `lease`.
 */
function leaseWorld(
  o: {
    record?: Record<string, unknown>;
    tty?: boolean;
    /** The working directory sbxMain sees (default: the test process's). */
    cwd?: string;
    /** A PUT body the control plane refuses with 400 invalid_request. */
    putRefuses?: (body: { mode: string; idleTimeoutS?: number }) => boolean;
    lease?: (
      op: LeaseOpName,
      token?: string,
      opts?: { signal?: AbortSignal },
    ) => LeaseStatusView | Error | Promise<LeaseStatusView>;
  } = {},
) {
  const s = setup();
  let rec = sandbox({ mode: 'lease', modeEpoch: 1, ...o.record });
  let modeMints = 0;
  const ac = new AbortController();
  const cp = fakeCp({
    [`GET /v1/sandboxes/${SBX}`]: () => ({ status: 200, body: rec }),
    [`PUT /v1/sandboxes/${SBX}/mode`]: (req) => {
      const b = req.body as { mode: string; idleTimeoutS?: number };
      if (o.putRefuses?.(b)) {
        return {
          status: 400,
          body: { error: 'invalid_request', message: 'idleTimeoutS must be 30..600' },
        };
      }
      rec = {
        ...rec,
        mode: b.mode,
        idleTimeoutS: b.idleTimeoutS ?? 0,
        modeEpoch: rec.modeEpoch + 1,
      };
      return { status: 200, body: { sandbox: rec, setModeToken: 'smt-put' } };
    },
    [`POST /v1/sandboxes/${SBX}/mode-token`]: () => ({
      status: 200,
      body: { setModeToken: `smt-${++modeMints}` },
    }),
    [`POST /v1/sandboxes/${SBX}/token`]: () => ({
      status: 200,
      body: { ...TOKEN, token: jwt({ iat: TOKEN_IAT, exp: TOKEN_IAT + 900, mode: rec.mode }) },
    }),
    [`DELETE /v1/sandboxes/${SBX}`]: () => ({
      status: 200,
      body: { id: SBX, state: 'terminated', reason: 'deleted' },
    }),
  });
  const calls: { op: LeaseOpName; token?: string; signal: boolean }[] = [];
  const answer = o.lease ?? (() => ACTIVE);
  let opened = 0;
  let closed = 0;
  const factory: ExecFactory = () => {
    opened++;
    return {
      exec: async () => {
        throw new Error('no command runs in these tests');
      },
      close: () => void closed++,
      leaseControl: async (op, token, opts) => {
        calls.push({ op, ...(token !== undefined ? { token } : {}), signal: !!opts?.signal });
        const a = await answer(op, token, opts);
        if (a instanceof Error) throw a;
        return a;
      },
      leaseKeepalive: async () => {},
    };
  };
  const run = (argv: string[]) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      execFactory: factory,
      stdinIsTTY: o.tty ?? true,
      signal: ac.signal,
      ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    });
  };
  return {
    ...s,
    cp,
    calls,
    ac,
    run,
    rec: () => rec,
    err: () => s.io.errs.join('\n'),
    out: () => s.io.outs.join(''),
    conns: () => ({ opened, closed }),
    puts: () => cp.calls.filter((c) => c.method === 'PUT').map((c) => c.body),
    modeMints: () => modeMints,
  };
}

describe('mocactl sbx mode (lease-mode spec §8.1, §8.2)', () => {
  it('mode upgrade refused without a TTY; downgrade allowed', async () => {
    for (const mode of ['lease', 'lease+processes']) {
      const w = leaseWorld({ tty: false, record: { mode: 'per-exec', modeEpoch: 0 } });
      expect(await w.run(['mode', mode, SBX])).toBe(2);
      expect(w.err()).toContain('sbx: an upgrade needs a terminal: run it yourself');
      // The GET came first (the current mode decides), and nothing was changed.
      expect(w.cp.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/sandboxes/${SBX}`]);
      expect(w.calls).toEqual([]);
    }
    const up = leaseWorld({ tty: false, record: { mode: 'lease' } });
    expect(await up.run(['mode', 'lease+processes', SBX])).toBe(2);
    expect(up.puts()).toEqual([]);
    expect(up.calls).toEqual([]);
    // A downgrade, and a same-rank change, need no terminal.
    for (const mode of ['per-exec', 'lease']) {
      const w = leaseWorld({ tty: false, record: { mode: 'lease' } });
      expect(await w.run(['mode', mode, SBX])).toBe(0);
      expect(w.puts()).toEqual([{ mode }]);
    }
  });

  it('mode tells a bound repository to run sbx up when the agent rules change (review #4569829055)', async () => {
    const HINT = 'run "mocactl sbx up" to update the agent rules';
    const bound = () => {
      const d = tmp('sbx-mode-bound-');
      mkdirSync(join(d, '.sbx'));
      writeFileSync(join(d, '.sbx', 'sandbox.json'), JSON.stringify({ id: SBX }));
      return d;
    };
    const w = leaseWorld({ record: { mode: 'lease' }, cwd: bound() });
    expect(await w.run(['mode', 'per-exec'])).toBe(0);
    expect(w.err()).toContain(HINT);
    // Not bound here: no hint.
    const other = leaseWorld({ record: { mode: 'lease' }, cwd: tmp('sbx-mode-unbound-') });
    expect(await other.run(['mode', 'per-exec', SBX])).toBe(0);
    expect(other.err()).not.toContain(HINT);
    // lease and lease+processes share one rules block: nothing to update.
    const same = leaseWorld({ record: { mode: 'lease' }, cwd: bound() });
    expect(await same.run(['mode', 'lease+processes'])).toBe(0);
    expect(same.err()).not.toContain(HINT);
    // A mode the control plane refused changed nothing.
    const refused = leaseWorld({ tty: false, record: { mode: 'per-exec' }, cwd: bound() });
    expect(await refused.run(['mode', 'lease'])).toBe(2);
    expect(refused.err()).not.toContain(HINT);
  });

  it('mode keeps the current idle timeout', async () => {
    const w = leaseWorld({ record: { mode: 'lease', idleTimeoutS: 900 } });
    expect(await w.run(['mode', 'lease+processes', SBX])).toBe(0);
    expect(w.puts()).toEqual([{ mode: 'lease+processes', idleTimeoutS: 900 }]);
    // --idle-timeout wins over the record's.
    const x = leaseWorld({ record: { mode: 'lease', idleTimeoutS: 900 } });
    expect(await x.run(['mode', 'lease', SBX, '--idle-timeout', '120'])).toBe(0);
    expect(x.puts()).toEqual([{ mode: 'lease', idleTimeoutS: 120 }]);
  });

  it("mode sends set_mode with the PUT's token and prints the new epoch", async () => {
    const w = leaseWorld({ record: { mode: 'per-exec', modeEpoch: 0 } });
    expect(await w.run(['mode', 'lease', SBX])).toBe(0);
    expect(w.calls).toEqual([{ op: 'set_mode', token: 'smt-put', signal: true }]);
    expect(w.out()).toBe('mode lease (epoch 1)\n');
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
  });

  it('mode downgrade prints lease ended (mode_change)', async () => {
    const end = ev({ reason: 'mode_change' });
    const w = leaseWorld({
      record: { mode: 'lease', modeEpoch: 2 },
      lease: () => ({ ...APPLIED, mode: 'per-exec', pending: end }),
    });
    expect(await w.run(['mode', 'per-exec', SBX])).toBe(0);
    expect(w.out()).toBe('mode per-exec (epoch 3)\nlease ended (mode_change)\n');
    // The stdout line is the report: the end is marked seen, with no notice line (P4-R17).
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([]);
    expect(await w.run(['mode', 'per-exec', SBX])).toBe(0);
    expect(w.out()).toBe('mode per-exec (epoch 4)\n');
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([]);
  });

  it('mode retries without a carried idle timeout the deployment no longer allows (P4-R18)', async () => {
    const w = leaseWorld({
      record: { mode: 'lease', idleTimeoutS: 900 },
      putRefuses: (b) => b.idleTimeoutS !== undefined,
    });
    expect(await w.run(['mode', 'per-exec', SBX])).toBe(0);
    expect(w.puts()).toEqual([{ mode: 'per-exec', idleTimeoutS: 900 }, { mode: 'per-exec' }]);
    expect(w.err()).toContain(
      "idle timeout reset to the worker default: the deployment's ceiling no longer allows 900 s",
    );
    expect(w.out()).toBe('mode per-exec (epoch 2)\n');
    // One the user gave is the user's: refused, not retried.
    const x = leaseWorld({
      record: { mode: 'lease', idleTimeoutS: 900 },
      putRefuses: (b) => b.idleTimeoutS !== undefined,
    });
    expect(await x.run(['mode', 'per-exec', SBX, '--idle-timeout', '900'])).toBe(1);
    expect(x.puts()).toHaveLength(1);
    expect(x.err()).toContain('idleTimeoutS must be 30..600');
  });

  it('mode with an unreachable worker prints the pending line, exit 0', async () => {
    for (const code of ['unavailable', 'timeout'] as const) {
      const w = leaseWorld({
        record: { mode: 'per-exec', modeEpoch: 4 },
        lease: () => new LeaseControlError(code, 'no live worker'),
      });
      expect(await w.run(['mode', 'lease', SBX])).toBe(0);
      expect(w.out()).toBe(
        `mode lease stored (epoch 5); the worker could not be reached (${code}): it applies at the next command\n`,
      );
    }
  });

  it('mode retries a denied set_mode once with a minted token (R11)', async () => {
    let n = 0;
    const w = leaseWorld({
      record: { mode: 'lease' },
      lease: () => (n++ === 0 ? new LeaseControlError('denied', 'expired') : APPLIED),
    });
    expect(await w.run(['mode', 'per-exec', SBX])).toBe(0);
    expect(w.calls.map((c) => c.token)).toEqual(['smt-put', 'smt-1']);
  });

  it('a refused set_mode is exit 1: the mode is stored, and said so', async () => {
    const w = leaseWorld({
      record: { mode: 'lease' },
      lease: () => new LeaseControlError('failed', 'stale_mode: epoch 1 < 2', 'stale_mode: ...'),
    });
    expect(await w.run(['mode', 'per-exec', SBX])).toBe(1);
    expect(w.err()).toContain('sbx: mode per-exec stored (epoch 2), but set_mode failed (failed)');
  });

  it('Ctrl-C during set_mode prints the pending line and exits 130 (P4-R12)', async () => {
    const w = leaseWorld({ record: { mode: 'lease' }, lease: untilAborted });
    const p = w.run(['mode', 'per-exec', SBX]);
    await vi.waitFor(() => expect(w.calls).toHaveLength(1));
    w.ac.abort();
    expect(await p).toBe(130);
    expect(w.out()).toBe(
      'mode per-exec stored (epoch 2); the worker could not be reached (cancelled): it applies at the next command\n',
    );
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
  });

  it('mode is a usage error without a valid mode, or with too many arguments', async () => {
    const w = leaseWorld();
    expect(await w.run(['mode'])).toBe(2);
    expect(w.err()).toContain('sbx: mode needs a mode: per-exec, lease or lease+processes');
    expect(await w.run(['mode', 'bogus', SBX])).toBe(2);
    expect(w.err()).toContain(
      "sbx: the mode must be one of per-exec, lease, lease+processes (got 'bogus')",
    );
    expect(await w.run(['mode', 'lease', SBX, 'extra'])).toBe(2);
    expect(await w.run(['mode', 'lease', SBX, '--json'])).toBe(2);
    expect(w.cp.calls).toEqual([]);
  });
});

describe('mocactl sbx reset (spec §8.3)', () => {
  it('reset ends the lease', async () => {
    const start = ev({ state: 'start', atUnixMs: 1_800_000_000_000 });
    const resetEnd = ev({ reason: 'reset' });
    let reset = false;
    const w = leaseWorld({
      lease: (op) => {
        if (op === 'reset') reset = true;
        return reset ? { ...APPLIED, pending: resetEnd } : { ...ACTIVE, pending: start };
      },
    });
    expect(await w.run(['reset', SBX])).toBe(0);
    expect(w.calls.map((c) => c.op)).toEqual(['status', 'reset']);
    expect(w.calls.every((c) => c.signal)).toBe(true);
    expect(w.out()).toBe('lease ended (reset)\n');
    // The stdout line reports the end: no notice for it, nor for the start beside it (P4-R17).
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([]);
    // Marked seen: a later get does not show it either.
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([]);
  });

  it('reset hides only the end it reports: another end of the same reason and minute still prints', async () => {
    // Two different events (their at_unix_ms differ), with the same reason and the same HH:MM.
    const earlier = ev({ reason: 'reset', atUnixMs: 1_800_000_100_000 });
    const own = ev({ reason: 'reset', atUnixMs: earlier.atUnixMs + 1000 });
    expect(leaseNotice(own, Date.now())).toBe(leaseNotice(earlier, Date.now()));
    const w = leaseWorld({
      lease: (op) =>
        op === 'status' ? { ...ACTIVE, pending: earlier } : { ...APPLIED, pending: own },
    });
    expect(await w.run(['reset', SBX])).toBe(0);
    expect(w.out()).toBe('lease ended (reset)\n');
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([
      leaseNotice(earlier, Date.now()),
    ]);
    // Both marked seen: neither prints again.
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([]);
  });

  it('reset with no lease', async () => {
    const w = leaseWorld({ lease: () => APPLIED });
    expect(await w.run(['reset', SBX])).toBe(0);
    expect(w.calls.map((c) => c.op)).toEqual(['status']);
    expect(w.out()).toBe('no lease\n');
    // A per-exec sandbox has no lease to ask about: no lease call at all (P4-R9).
    const p = leaseWorld({ record: { mode: 'per-exec', modeEpoch: 0 } });
    expect(await p.run(['reset', SBX])).toBe(0);
    expect(p.calls).toEqual([]);
    expect(p.out()).toBe('no lease\n');
  });

  it('a reset the worker refuses is exit 1, with its code', async () => {
    const w = leaseWorld({
      lease: (op) => (op === 'status' ? ACTIVE : new LeaseControlError('busy', 'busy: in flight')),
    });
    expect(await w.run(['reset', SBX])).toBe(1);
    expect(w.err()).toContain('sbx: reset failed (busy): busy: in flight');
  });

  it('Ctrl-C during reset exits 130 (P4-R12)', async () => {
    const w = leaseWorld({
      lease: (op, t, o) => (op === 'status' ? ACTIVE : untilAborted(op, t, o)),
    });
    const p = w.run(['reset', SBX]);
    await vi.waitFor(() => expect(w.calls).toHaveLength(2));
    w.ac.abort();
    expect(await p).toBe(130);
    expect(w.out()).toBe('');
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
  });
});

describe('mocactl sbx get (spec §5, §8.2)', () => {
  it('get shows mode and lease state', async () => {
    const w = leaseWorld({ record: { mode: 'lease', modeEpoch: 3, idleTimeoutS: 900 } });
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.out()).toBe(
      [
        `id            ${SBX}`,
        'template      node22',
        'mode          lease',
        'epoch         3',
        'idle timeout  900 s',
        'lease         active (age 42 s)',
        '',
      ].join('\n'),
    );
    expect(w.calls.map((c) => c.op)).toEqual(['status']);
    const d = leaseWorld({ record: { mode: 'lease' }, lease: () => APPLIED });
    expect(await d.run(['get', SBX])).toBe(0);
    expect(d.out()).toContain('idle timeout  worker default\n');
    expect(d.out()).toContain('lease         none\n');
    // A status that fails is shown, not a failed get.
    const u = leaseWorld({ lease: () => new LeaseControlError('unavailable', 'no worker') });
    expect(await u.run(['get', SBX])).toBe(0);
    expect(u.out()).toContain('lease         unknown (unavailable)\n');
    // A per-exec sandbox: no lease call (P4-R9).
    const p = leaseWorld({ record: { mode: 'per-exec', modeEpoch: 0 } });
    expect(await p.run(['get', SBX])).toBe(0);
    expect(p.out()).toContain('lease         none (per-exec)\n');
    expect(p.calls).toEqual([]);
    expect(p.conns().opened).toBe(0);
  });

  it('get --json', async () => {
    const w = leaseWorld({ record: { mode: 'lease', modeEpoch: 3 } });
    expect(await w.run(['get', SBX, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual({
      sandbox: { ...w.rec() },
      lease: ACTIVE,
    });
    const p = leaseWorld({ record: { mode: 'per-exec', modeEpoch: 0 } });
    expect(await p.run(['get', SBX, '--json'])).toBe(0);
    expect(JSON.parse(p.out())).toEqual({ sandbox: p.rec(), lease: null });
    const u = leaseWorld({ lease: () => new LeaseControlError('timeout', 'slow') });
    expect(await u.run(['get', SBX, '--json'])).toBe(0);
    expect(JSON.parse(u.out()).lease).toEqual({ error: 'timeout' });
  });

  it('get re-sends set_mode on an unknown epoch', async () => {
    const w = leaseWorld({
      record: { mode: 'lease', modeEpoch: 1 },
      lease: (op) => (op === 'status' ? { ...APPLIED, epochKnown: false } : ACTIVE),
    });
    expect(await w.run(['get', SBX])).toBe(0);
    // A token for the record's mode and epoch, minted now and sent once (M8).
    expect(w.modeMints()).toBe(1);
    expect(w.calls.map((c) => [c.op, c.token])).toEqual([
      ['status', undefined],
      ['set_mode', 'smt-1'],
    ]);
    expect(w.err()).toContain('re-sent mode lease: applied');
    // The status shown is the one after the re-send.
    expect(w.out()).toContain('lease         active (age 42 s)\n');
    const p = leaseWorld({
      lease: (op) =>
        op === 'status'
          ? { ...APPLIED, epochKnown: false }
          : new LeaseControlError('unavailable', 'gone'),
    });
    expect(await p.run(['get', SBX])).toBe(0);
    // The pending line is create's (review #4569829068).
    expect(p.err()).toContain(
      `sbx: lease pending (unavailable): the sandbox runs per-Exec until "mocactl sbx get ${SBX}" re-sends the mode`,
    );
    expect(p.err()).not.toContain('re-sent mode lease: pending');
    // A known epoch is not re-sent.
    const k = leaseWorld();
    expect(await k.run(['get', SBX])).toBe(0);
    expect(k.modeMints()).toBe(0);
    expect(k.calls.map((c) => c.op)).toEqual(['status']);
  });

  it("get --json says a re-sent set_mode's hard failure, as create --json does (review #4569829068)", async () => {
    const w = leaseWorld({
      lease: (op) =>
        op === 'status'
          ? { ...APPLIED, epochKnown: false }
          : new LeaseControlError(
              'failed',
              'stale_mode: epoch 1 is below the stored 2',
              'stale_mode: x',
            ),
    });
    expect(await w.run(['get', SBX, '--json'])).toBe(1);
    const j = JSON.parse(w.out());
    expect(j.setMode).toEqual({
      error: 'set_mode failed (failed): stale_mode: epoch 1 is below the stored 2',
    });
    expect(j.lease).toMatchObject({ epochKnown: false });
    // Pending and applied keep their outcome.
    const p = leaseWorld({
      lease: (op) =>
        op === 'status'
          ? { ...APPLIED, epochKnown: false }
          : new LeaseControlError('unavailable', 'gone'),
    });
    expect(await p.run(['get', SBX, '--json'])).toBe(0);
    expect(JSON.parse(p.out()).setMode).toEqual({ outcome: 'pending', code: 'unavailable' });
  });

  it('an unseen notice prints once across two get calls', async () => {
    const end = ev({ reason: 'idle' });
    let pending = end;
    const w = leaseWorld({ lease: () => ({ ...ACTIVE, pending }) });
    expect(await w.run(['get', SBX])).toBe(0);
    const notice = leaseNotice(end, Date.now())!;
    expect(notice).toContain('[sandbox] guest restarted (idle, ');
    expect(w.io.errs).toContain(notice);
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.io.errs).not.toContain(notice);
    // Stored per sandbox, in the sbx state directory.
    const store = JSON.parse(
      readFileSync(join(w.paths.stateDir, 'sbx', 'notices.json'), 'utf8'),
    ) as Record<string, number>;
    expect(store).toEqual({ [SBX]: end.atUnixMs });
    // A newer event prints again.
    pending = ev({ atUnixMs: end.atUnixMs + 60_000, reason: 'memory_reclaim' });
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.io.errs.filter((l) => l.startsWith('[sandbox]'))).toEqual([
      leaseNotice(pending, Date.now()),
    ]);
  });

  it('a corrupt notices.json does not fail get: it reads as empty', async () => {
    const end = ev({ reason: 'idle' });
    const w = leaseWorld({ lease: () => ({ ...ACTIVE, pending: end }) });
    const file = join(w.paths.stateDir, 'sbx', 'notices.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    expect(await w.run(['get', SBX])).toBe(0);
    expect(w.io.errs).toContain(leaseNotice(end, Date.now()));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [SBX]: end.atUnixMs });
  });
});
