import {
  LeaseControlError,
  type LeaseStatusView,
  type SandboxModeName,
} from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SandboxApiClient } from './api.js';
import { sandboxFailureText, type LeaseControlFn } from './exec.js';

/** The mode names, in rank order (spec §8.1): what `--mode` takes. */
export const MODE_NAMES: readonly SandboxModeName[] = ['per-exec', 'lease', 'lease+processes'];

export const isModeName = (m: string): m is SandboxModeName =>
  (MODE_NAMES as readonly string[]).includes(m);

/** A mode's rank: per-exec < lease < lease+processes. A move to a higher rank is an upgrade. */
export function modeRank(m: SandboxModeName): 0 | 1 | 2 {
  return m === 'lease+processes' ? 2 : m === 'lease' ? 1 : 0;
}

/** An upgrade (creating with a lease mode counts as one) is the user's own act, at a terminal. */
export const UPGRADE_NEEDS_TTY = 'an upgrade needs a terminal: run it yourself';

export type SetModeOutcome =
  { outcome: 'applied'; status: LeaseStatusView } | { outcome: 'pending'; code: string };

/**
 * `LeaseControl set_mode` with a set-mode token just minted (spec §8.2). A token is never cached
 * (M8): on PERMISSION_DENIED one fresh token is minted from `POST …/mode-token` and sent once more
 * (ruling R11). UNAVAILABLE or DEADLINE_EXCEEDED is `pending`: the control plane has the mode, and
 * the worker applies it at the next Exec. Any other failure throws its LeaseControlError; an abort
 * of `signal` (Ctrl-C) is one, `cancelled` (P4-R12).
 */
export async function sendSetMode(
  conn: { leaseControl: LeaseControlFn },
  cp: Pick<SandboxApiClient, 'mintSandboxModeToken'>,
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<SetModeOutcome> {
  const send = async (t: string): Promise<SetModeOutcome> => {
    try {
      const status = await conn.leaseControl('set_mode', t, signal ? { signal } : {});
      return { outcome: 'applied', status };
    } catch (err) {
      if (
        err instanceof LeaseControlError &&
        (err.code === 'unavailable' || err.code === 'timeout')
      )
        return { outcome: 'pending', code: err.code };
      throw err;
    }
  };
  try {
    return await send(token);
  } catch (err) {
    if (!(err instanceof LeaseControlError && err.code === 'denied')) throw err;
    return send((await cp.mintSandboxModeToken(id)).setModeToken);
  }
}

/** One line for a set_mode that failed (not pending): the lease call's code, or the exec failure. */
export function setModeFailureText(err: unknown): string {
  if (err instanceof LeaseControlError)
    return `set_mode failed (${err.code}): ${sanitizeRemote(err.message)}`;
  return sandboxFailureText(err);
}

/** The warning for a pending set_mode (spec §8.2): the mode is stored, not yet applied. */
export const pendingText = (id: string, code: string): string =>
  `lease pending (${code}): the sandbox runs per-Exec until "mocactl sbx get ${id}" re-sends the mode`;
