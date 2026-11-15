import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecAbortedError,
  ExecMachineryError,
  ExecRefusedError,
  noticeLines,
  type Exec,
  type LeaseEvent,
} from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxCtx } from './commands.js';

/**
 * Unseen lease notices (spec §5): `mocactl sbx` prints a lease event the user has not seen yet on
 * their next command, so a user whose harness had exited still learns of it. What was seen is kept
 * in `<state dir>/sbx/notices.json` (beside the flight recorder's logs), as
 * `{[sandboxId]: lastSeenAtUnixMs}`: an event is shown when its `at_unix_ms` is newer.
 *
 * The store keeps only the newest `at_unix_ms` per sandbox, stamped by the worker's clock: events
 * from a worker whose clock is behind the one that stamped the stored value (a sandbox moved to
 * another host) stay hidden until its clock passes that value.
 */
export const noticesFile = (stateDir: string): string => join(stateDir, 'sbx', 'notices.json');

type Store = Record<string, number>;

/** The store; a missing, unreadable or foreign file is an empty one (a notice is best-effort). */
function load(file: string): Store {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'),
    );
  } catch {
    return {};
  }
}

/** Write-then-rename, 0600 in a 0700 directory; a failure is ignored (best-effort, as the events). */
function save(file: string, store: Store): void {
  try {
    const dir = join(file, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // The worst case is a notice shown twice.
  }
}

/**
 * The notice lines for `events` not yet seen for sandbox `id`, and records them seen. The lines
 * are sandbox-client's `noticeLines`: a start only when no end is shown with it, only the last
 * `expiring`. An `expiring` event is shown every time (it rides on every lease Exec, spec §5) and
 * marks nothing seen. The `reportedAt` event (its `at_unix_ms`: the event's identity) is marked
 * seen, and counts as shown, so a start beside it stays hidden, but gets no line: the command
 * reports it itself (ruling P4-R17). Any other event, whatever its text, is shown as usual.
 */
export function unseenNotices(
  stateDir: string,
  id: string,
  events: LeaseEvent[],
  nowMs: number,
  reportedAt?: number,
): { lines: string[]; fresh: LeaseEvent[] } {
  if (events.length === 0) return { lines: [], fresh: [] };
  const file = noticesFile(stateDir);
  const store = load(file);
  const last = store[id] ?? 0;
  const at = new Set<number>();
  const fresh = events.filter((ev) => {
    if (ev.state === 'expiring') return true;
    if (ev.atUnixMs <= last || at.has(ev.atUnixMs)) return false;
    at.add(ev.atUnixMs);
    return true;
  });
  const own = (ev: LeaseEvent) => ev.state === 'end' && ev.atUnixMs === reportedAt;
  // The reported end is shown by the command: a start beside it is hidden as beside any end.
  const ownEnd = fresh.some(own);
  const lines = noticeLines(
    fresh.filter((ev) => !own(ev) && !(ownEnd && ev.state === 'start')),
    nowMs,
  );
  if (at.size > 0) save(file, { ...store, [id]: Math.max(last, ...at) });
  return { lines, fresh };
}

/**
 * Prints, on stderr, the notices for `events` the user has not seen for sandbox `id`, and returns
 * the events that were unseen. `reportedAt`: the event the command reports itself (unseenNotices).
 * The reason and process names are the worker's text: sanitized before they reach a terminal.
 */
export function printNotices(
  c: SbxCtx,
  id: string,
  events: Array<LeaseEvent | undefined>,
  reportedAt?: number,
): LeaseEvent[] {
  const known = events.filter((ev): ev is LeaseEvent => ev !== undefined);
  const { lines, fresh } = unseenNotices(c.rt.paths.stateDir, id, known, Date.now(), reportedAt);
  for (const l of lines) c.io.err(sanitizeRemote(l));
  return fresh;
}

/**
 * `exec`, saying the lease events each Exec carried (spec §5): on its result, or on its failure
 * before the failure is reported (the worker acked them, so nothing else will say them). For the
 * commands whose Execs are not the user's command: put, push, pull, up, `--seed` and doctor
 * (plan-4 M2). `run` says its own, around the command's output.
 */
export function noticingExec(c: SbxCtx, id: string, exec: Exec): Exec {
  return async (command, opts) => {
    try {
      const r = await exec(command, opts);
      printNotices(c, id, r.lease);
      return r;
    } catch (err) {
      if (
        err instanceof ExecMachineryError ||
        err instanceof ExecRefusedError ||
        err instanceof ExecAbortedError
      ) {
        printNotices(c, id, err.lease);
      }
      throw err;
    }
  };
}

/** Forgets sandbox `id` (it was deleted): the store does not grow with every sandbox ever made. */
export function forgetNotices(stateDir: string, id: string): void {
  const file = noticesFile(stateDir);
  const store = load(file);
  if (!(id in store)) return;
  delete store[id];
  save(file, store);
}
