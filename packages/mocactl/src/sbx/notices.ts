import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaseNotice, type LeaseEvent } from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SbxCtx } from './commands.js';

/**
 * Unseen lease notices (spec §5): `mocactl sbx` prints a lease event the user has not seen yet on
 * their next command, so a user whose harness had exited still learns of it. What was seen is kept
 * in `<state dir>/sbx/notices.json` (beside the flight recorder's logs), as
 * `{[sandboxId]: lastSeenAtUnixMs}`: an event is shown when its `at_unix_ms` is newer.
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
 * The notice lines for `events` not yet seen for sandbox `id`, and records them seen. A start is
 * shown only when no end is shown with it; an `expiring` event is shown every time (only the last,
 * spec §5: it rides on every lease Exec) and marks nothing seen.
 */
export function unseenNotices(
  stateDir: string,
  id: string,
  events: LeaseEvent[],
  nowMs: number,
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
  const ended = fresh.some((ev) => ev.state === 'end');
  const lastExpiring = fresh.map((ev) => ev.state).lastIndexOf('expiring');
  const lines: string[] = [];
  fresh.forEach((ev, i) => {
    if (ev.state === 'start' && ended) return;
    if (ev.state === 'expiring' && i !== lastExpiring) return;
    const l = leaseNotice(ev, nowMs);
    if (l !== undefined) lines.push(l);
  });
  if (at.size > 0) save(file, { ...store, [id]: Math.max(last, ...at) });
  return { lines, fresh };
}

/**
 * Prints, on stderr, the notices for `events` the user has not seen for sandbox `id`, and returns
 * the events that were unseen. The reason and process names are the worker's text: sanitized
 * before they reach a terminal.
 */
export function printNotices(
  c: SbxCtx,
  id: string,
  events: Array<LeaseEvent | undefined>,
): LeaseEvent[] {
  const known = events.filter((ev): ev is LeaseEvent => ev !== undefined);
  const { lines, fresh } = unseenNotices(c.rt.paths.stateDir, id, known, Date.now());
  for (const l of lines) c.io.err(sanitizeRemote(l));
  return fresh;
}

/** Forgets sandbox `id` (it was deleted): the store does not grow with every sandbox ever made. */
export function forgetNotices(stateDir: string, id: string): void {
  const file = noticesFile(stateDir);
  const store = load(file);
  if (!(id in store)) return;
  delete store[id];
  save(file, store);
}
