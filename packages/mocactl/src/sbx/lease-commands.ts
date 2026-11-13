import {
  LeaseControlError,
  type LeaseEvent,
  type LeaseStatusView,
  type SandboxModeName,
} from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxSandbox } from './api.js';
import { failed, SBX_EXIT, type SbxCtx } from './commands.js';
import { jwtMode, openExec, sandboxFailureText, type ExecFactory } from './exec.js';
import { modeRank, sendSetMode, setModeFailureText, UPGRADE_NEEDS_TTY } from './mode.js';
import { printNotices } from './notices.js';

/**
 * `mocactl sbx mode`, `reset` and `get` (lease-mode spec §5, §8): a sandbox's mode, changed and
 * sent to the worker; its lease, ended; and both, shown. Each prints the lease event the user has
 * not seen yet (notices.ts).
 */

const withSignal = (c: SbxCtx) => (c.signal ? { signal: c.signal } : {});

/** Whether a lease event is an end for `reason`. */
const isEnd =
  (reason: string) =>
  (ev: LeaseEvent): boolean =>
    ev.state === 'end' && ev.reason === reason;

/** A set_mode the worker did not get (spec §8.2): the mode is stored, and lands at the next command. */
export const modeStoredText = (mode: SandboxModeName, epoch: number, code: string): string =>
  `mode ${mode} stored (epoch ${epoch}); the worker could not be reached (${code}): it applies at the next command`;

/** A connection that could not be opened (the token mint): its own exit, never the command's. */
function connFailed(c: SbxCtx, err: unknown): number {
  if (err instanceof ApiError) return failed(c, err);
  if (c.signal?.aborted) return SBX_EXIT.interrupted;
  c.io.err(`sbx: ${sandboxFailureText(err)}`);
  return SBX_EXIT.failed;
}

/**
 * `mocactl sbx mode <mode> [ID] [--idle-timeout S]` (spec §8.1, §8.2). The record is read first: a
 * move to a higher rank is an upgrade, the user's own act at a terminal. The PUT keeps the record's
 * idle timeout unless `--idle-timeout` is given (an omitted one is stored as 0). Then the PUT's
 * set-mode token is sent once (sendSetMode); a worker that cannot be reached is pending, exit 0,
 * and Ctrl-C leaves it pending too, exit 130 (P4-R12).
 */
export async function cmdMode(
  c: SbxCtx,
  id: string,
  mode: SandboxModeName,
  o: { idleTimeoutS?: number; tty: boolean; factory?: ExecFactory },
): Promise<number> {
  let s: SbxSandbox;
  let setModeToken: string;
  try {
    const cur = await c.api.getSandbox(id);
    if (modeRank(mode) > modeRank(cur.mode) && !o.tty) {
      c.io.err(`sbx: ${UPGRADE_NEEDS_TTY}`);
      return SBX_EXIT.usage;
    }
    const carried = o.idleTimeoutS === undefined && cur.idleTimeoutS > 0;
    const idle = o.idleTimeoutS ?? (carried ? cur.idleTimeoutS : undefined);
    try {
      ({ sandbox: s, setModeToken } = await c.api.setSandboxMode(id, {
        mode,
        ...(idle !== undefined ? { idleTimeoutS: idle } : {}),
      }));
    } catch (err) {
      // A carried idle timeout an operator's lowered ceiling refuses must not refuse the mode
      // change: once more without it, stored as 0, the worker default, and said (P4-R18).
      if (!(
        carried &&
        err instanceof ApiError &&
        err.status === 400 &&
        err.code === 'invalid_request'
      ))
        throw err;
      ({ sandbox: s, setModeToken } = await c.api.setSandboxMode(id, { mode }));
      c.io.err(
        `sbx: idle timeout reset to the worker default: the deployment's ceiling no longer allows ${cur.idleTimeoutS} s`,
      );
    }
  } catch (err) {
    return failed(c, err);
  }
  const stored = `mode ${s.mode} stored (epoch ${s.modeEpoch})`;
  let x;
  try {
    x = await openExec(c.api, id, o.factory);
  } catch (err) {
    if (c.signal?.aborted) return pendingByCtrlC(c, s);
    c.io.err(`sbx: ${stored}, but set_mode was not sent`);
    return connFailed(c, err);
  }
  try {
    const r = await sendSetMode(x, c.api, id, setModeToken, c.signal);
    if (r.outcome === 'pending') {
      c.io.out(modeStoredText(s.mode, s.modeEpoch, r.code) + '\n');
      return SBX_EXIT.ok;
    }
    // A downgrade ends a live lease (spec §5): its end comes back as the status's pending event,
    // said once (a later set_mode still carries it until a lease Exec does), by the stdout line
    // alone: marked seen with no notice line (P4-R17).
    const fresh = printNotices(c, id, [r.status.pending], isEnd('mode_change'));
    c.io.out(`mode ${s.mode} (epoch ${s.modeEpoch})\n`);
    if (fresh.some(isEnd('mode_change'))) {
      c.io.out('lease ended (mode_change)\n');
    }
    return SBX_EXIT.ok;
  } catch (err) {
    if (c.signal?.aborted) return pendingByCtrlC(c, s);
    if (err instanceof ApiError) {
      c.io.err(`sbx: ${stored}, but set_mode was not sent`);
      return failed(c, err);
    }
    c.io.err(`sbx: ${stored}, but ${setModeFailureText(err)}`);
    return SBX_EXIT.failed;
  } finally {
    x.close();
  }
}

/** Ctrl-C during a set_mode: the mode is stored, as for a worker that could not be reached. */
function pendingByCtrlC(c: SbxCtx, s: SbxSandbox): number {
  c.io.out(modeStoredText(s.mode, s.modeEpoch, 'cancelled') + '\n');
  return SBX_EXIT.interrupted;
}

/**
 * `mocactl sbx reset [ID]` (spec §8.3): ends the live lease, so the next command starts a new
 * guest. The status is asked first, so a reset of no lease is a no-op; a per-exec sandbox (the
 * token's mode, as `sandbox_info` decides it) has none, and no lease call is made (P4-R9).
 * Ctrl-C is exit 130: the worker may still end the lease.
 */
export async function cmdReset(c: SbxCtx, id: string, factory?: ExecFactory): Promise<number> {
  let x;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return connFailed(c, err);
  }
  try {
    if (jwtMode(x.token.token) === 'per-exec') {
      c.io.out('no lease\n');
      return SBX_EXIT.ok;
    }
    const before = await x.leaseControl('status', undefined, withSignal(c));
    if (before.state === 'none') {
      printNotices(c, id, [before.pending]);
      c.io.out('no lease\n');
      return SBX_EXIT.ok;
    }
    const after = await x.leaseControl('reset', undefined, withSignal(c));
    // The stdout line reports the reset's end: marked seen with no notice line (P4-R17).
    printNotices(c, id, [before.pending, after.pending], isEnd('reset'));
    c.io.out('lease ended (reset)\n');
    return SBX_EXIT.ok;
  } catch (err) {
    if (c.signal?.aborted) {
      c.io.err('sbx: interrupted: the worker may still end the lease');
      return SBX_EXIT.interrupted;
    }
    if (err instanceof LeaseControlError) {
      c.io.err(`sbx: reset failed (${err.code}): ${sanitizeRemote(err.message)}`);
      return SBX_EXIT.failed;
    }
    return connFailed(c, err);
  } finally {
    x.close();
  }
}

type LeaseInfo = LeaseStatusView | { error: string } | null;

const errorCode = (err: unknown): string =>
  err instanceof LeaseControlError || err instanceof ApiError ? err.code : 'failed';

/**
 * `mocactl sbx get [ID] [--json]`: the record's mode, epoch and idle timeout, and the lease as the
 * worker has it. A per-exec sandbox has no lease to ask about (P4-R9). A lease record whose epoch
 * the worker does not know (a set_mode that was pending) gets its set_mode again, with a mode
 * token minted now (spec §8.2). A failed status is shown, not a failed get.
 */
export async function cmdGet(c: SbxCtx, id: string, factory?: ExecFactory): Promise<number> {
  let s: SbxSandbox;
  try {
    s = await c.api.getSandbox(id);
  } catch (err) {
    return failed(c, err);
  }
  let lease: LeaseInfo = null;
  let setMode: { outcome: 'applied' } | { outcome: 'pending'; code: string } | undefined;
  let code: number = SBX_EXIT.ok;
  if (modeRank(s.mode) > 0) {
    let x;
    try {
      x = await openExec(c.api, id, factory);
    } catch (err) {
      if (c.signal?.aborted) return SBX_EXIT.interrupted;
      lease = { error: errorCode(err) };
    }
    if (x) {
      try {
        let v = await x.leaseControl('status', undefined, withSignal(c));
        printNotices(c, id, [v.pending]);
        if (!v.epochKnown) {
          try {
            const { setModeToken } = await c.api.mintSandboxModeToken(id);
            const r = await sendSetMode(x, c.api, id, setModeToken, c.signal);
            c.io.err(`re-sent mode ${s.mode}: ${r.outcome}`);
            if (r.outcome === 'applied') {
              v = r.status;
              printNotices(c, id, [v.pending]);
              setMode = { outcome: 'applied' };
            } else setMode = { outcome: 'pending', code: r.code };
          } catch (err) {
            if (c.signal?.aborted) throw err;
            c.io.err(`sbx: re-sending mode ${s.mode} failed: ${setModeFailureText(err)}`);
            code = SBX_EXIT.failed;
          }
        }
        lease = v;
      } catch (err) {
        if (c.signal?.aborted) return SBX_EXIT.interrupted;
        lease = { error: errorCode(err) };
      } finally {
        x.close();
      }
    }
  }
  if (c.json) {
    c.io.out(JSON.stringify({ sandbox: s, lease, ...(setMode ? { setMode } : {}) }) + '\n');
    return code;
  }
  const rows: Array<[string, string]> = [
    ['id', sanitizeRemote(s.id)],
    ['template', sanitizeRemote(s.template)],
    ['mode', s.mode],
    ['epoch', String(s.modeEpoch)],
    ['idle timeout', s.idleTimeoutS > 0 ? `${s.idleTimeoutS} s` : 'worker default'],
    ['lease', leaseText(lease)],
  ];
  for (const [k, v] of rows) c.io.out(`${k.padEnd(14)}${v}\n`);
  return code;
}

function leaseText(lease: LeaseInfo): string {
  if (lease === null) return 'none (per-exec)';
  if ('error' in lease) return `unknown (${sanitizeRemote(lease.error)})`;
  if (lease.state === 'none') return 'none';
  return `${lease.state} (age ${Math.floor(lease.ageMs / 1000)} s)`;
}
