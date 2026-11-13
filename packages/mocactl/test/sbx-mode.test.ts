import { LeaseControlError, type LeaseOpName, type LeaseStatusView } from '@moca/sandbox-client';
import { describe, expect, it } from 'vitest';
import { sbxMain } from '../src/sbx/cli.js';
import type { ExecFactory } from '../src/sbx/exec.js';
import { modeRank, sendSetMode } from '../src/sbx/mode.js';
import { fakeCp, fakeLease, sandbox, SBX, setup, TOKEN } from './helpers/sbx.js';

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

  it('create --mode lease refused without a TTY (exit 2)', async () => {
    const w = world({ tty: false });
    expect(await w.run(['create', '--mode', 'lease'])).toBe(2);
    expect(w.err()).toContain('an upgrade needs a terminal: run it yourself');
    // Refused before any request: nothing was created.
    expect(w.cp.calls).toEqual([]);
    expect(w.lease.calls).toEqual([]);
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
    expect(w.conns()).toEqual({ opened: 1, closed: 1 });
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
