import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { SandboxTransport } from '@moca/k8s-sandbox';
import { forLog } from './sandbox-affinity.js';

/**
 * The workspace marker (#338, option 2): how a turn learns that its session's workspace was reset
 * on the SAME sandbox, with no wire change.
 *
 * A sandbox worker deletes a session's workspace after SH_WORKSPACE_IDLE with no Exec (idle
 * reclaim, on both tiers), and the next Exec for that `workspace_key` simply gets a fresh one. The
 * placement code already reports a reset when the session MOVES (`detached`, `retiered`), but a
 * reclaim leaves the session on its sandbox, so nothing in the selection can see it. The harness
 * therefore leaves a small file in the workspace, holding the workspace key, and records in the
 * session's own log that it did. A later turn that finds the record but not the file (or the file
 * holding another key) knows the workspace is not the one its earlier turns wrote to.
 *
 * It is a convention, not a guarantee, and the docs say so: a session that deletes the marker
 * itself is reported as reset (it cannot be told from a reclaim), and nothing here prevents the
 * reset. The explicit release (#338 option 3) is the change that addresses the reclaim itself.
 */

/**
 * The marker's name, relative to the workspace. `.moca-*` is the namespace Moca already keeps its
 * own workspace files in (the seed's `.moca-seeded`, `.moca-seed.log`, `.moca-baseline`), and a
 * templated session's patch already leaves every `.moca-*` out (PATCH_EXCLUDES), so the marker never
 * shows in a patch. A plain file at the root rather than a dot-directory: `.moca/` would not match
 * that exclude, and a directory adds an entry to clean up for nothing.
 */
export const WORKSPACE_MARKER = '.moca-session';

/**
 * The custom entry the session log carries for the marker: `{ key, written }`, the latest one
 * winning. An ABSENT entry means "never written", which is what every session created before this
 * change has, so none of them is reported as reset on its first turn after an upgrade.
 *
 * In the session log rather than a new Redis key: the log is the session's own state, is deleted
 * with it (the control plane's cascade already names it), and already carries the harness's other
 * bookkeeping (`checkpoint`, `abort`, gate and verdict entries). Pi never sends a custom entry to the
 * model.
 */
export const WORKSPACE_MARKER_ENTRY = 'workspace_marker';

/**
 * The note the model gets on a turn whose workspace was reset. It travels as a separate custom
 * message (`workspace_reset`, see workspaceResetNoteExtension), never inside the user's prompt: the
 * prompt must reach Pi unchanged, because Pi runs extension commands, `/skill:` and prompt templates
 * only for text that STARTS with `/`, and the session log must keep the user's own words.
 */
export const WORKSPACE_RESET_NOTE =
  "[Moca] This session's workspace was reset since its previous turn: files written in earlier " +
  'turns are gone, and the workspace may be empty. Re-create anything you need before relying on it.';

/** Where a session's workspace is: the key its Execs carry and the directory it is mounted at. */
export interface SessionWorkspace {
  /** The Exec's `workspace_key`: the session id. Never empty (an empty key has no workspace). */
  key: string;
  /** The workspace's directory in the sandbox: `/workspace` on a microVM, `<root>/<key>` on a container worker. */
  dir: string;
}

/** What one marker Exec saw (`prev`) and left (`now`), or why it saw nothing. */
export type MarkerObservation =
  { prev: 'ours' | 'other' | 'absent'; now: 'ours' | 'none' } | { error: string };

/**
 * The turn's verdict. `first`: no record, so nothing to compare (a new session, or one from before
 * this change). `intact`: recorded and present. `reset`: recorded and missing or another key's.
 * `unknown`: the Exec failed, so no verdict either way.
 */
export type MarkerVerdict = 'first' | 'intact' | 'reset' | 'unknown';

export interface MarkerDecision {
  verdict: MarkerVerdict;
  /** A record to append (`written`), or undefined for none. */
  record?: boolean;
  /** Whether the end of the turn must (re)write the marker: the start found nothing of ours. */
  finishWrite: boolean;
}

/**
 * The decision, pure. `recorded` is the session log's latest `written` for this key.
 *
 * With a record, the start-of-turn Exec only READS (buildMarkerScript's `write: false`): a reset
 * is rewritten by the end-of-turn write, once the turn has run. So a turn that fails or is aborted
 * before its end (a missing config bundle, a throw before the agent runs) leaves the marker missing
 * and the record unchanged, and the next turn reports the same reset again: none is used up by a
 * turn nobody saw. An intact marker is never written or removed by a turn at all.
 *
 * Without a record the start may write: the marker goes only into a workspace that holds something
 * besides it, so `now` can be `none` on a container worker's still-empty directory. Such a turn
 * tries again at its end, when the agent may have written files, so a session whose first turn
 * clones a repository is marked before it goes idle.
 */
export function decideWorkspaceMarker(recorded: boolean, obs: MarkerObservation): MarkerDecision {
  if ('error' in obs) return { verdict: 'unknown', finishWrite: false };
  const finishWrite = obs.now !== 'ours';
  if (!recorded) {
    return { verdict: 'first', finishWrite, ...(obs.now === 'ours' ? { record: true } : {}) };
  }
  if (obs.prev === 'ours') return { verdict: 'intact', finishWrite };
  return { verdict: 'reset', finishWrite };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One Exec that reads the marker and, with `write` and when the workspace holds anything besides
 * it, (re)writes it, printing `<prev> <now>`: `prev` is `ours`, `other` or `absent`, `now` is `ours`
 * or `none`. Without `write` it only reads (`now` is `ours` exactly when `prev` is).
 *
 * Only shell builtins on the common path, plus one `mv` (and the git step below) when it writes. The write is to a temporary
 * name and renamed, so a concurrent turn of the same session never reads a half-written marker.
 *
 * The "holds anything" test exists for the container worker's early removal of EMPTY session
 * directories (SH_WORKSPACE_EMPTY_IDLE, #551): a marker in every directory would make none of them
 * empty, and so undo that removal. An empty directory loses no file when it goes, so it needs no
 * marker. (A microVM workspace is a fresh ext4 volume, whose `lost+found` counts, so it is marked
 * at its first Exec.)
 *
 * When the workspace is in a git repository, the marker is added to that repository's
 * `info/exclude` (found with `git rev-parse --git-path`, as seedWorkspace does, so a worktree or a
 * submodule, whose `.git` is a file, is covered too), so an agent's `git add -A` does not commit it.
 * Best effort: no git, no repository or a failing git is ignored, and never fails the write.
 */
export function buildMarkerScript(ws: SessionWorkspace, opts: { write: boolean }): string {
  const m = WORKSPACE_MARKER;
  const key = shq(ws.key);
  return [
    `cd ${shq(ws.dir)} || exit 90`,
    // `read`, not `cat` or `head`: a builtin, so a marked workspace costs no process at all.
    `p=absent; if [ -e ${m} ]; then v=; IFS= read -r v <${m} 2>/dev/null; if [ "$v" = ${key} ]; then p=ours; else p=other; fi; fi`,
    `n=none; [ "$p" = ours ] && n=ours`,
    `full=; [ "$n" = ours ] || [ ${opts.write ? 1 : 0} = 0 ] || for f in .[!.]* ..?* *; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; case "$f" in ${m}|${m}.tmp.*) continue ;; esac; full=1; break; done`,
    `if [ -n "$full" ]; then`,
    `  printf '%s' ${key} >${m}.tmp.$$ && mv -f ${m}.tmp.$$ ${m} || { rm -f ${m}.tmp.$$; exit 91; }`,
    `  n=ours`,
    `  if command -v git >/dev/null 2>&1; then`,
    `    { x=$(git rev-parse --git-path info/exclude) && pf=$(git rev-parse --show-prefix) && { grep -qxF "/$pf${m}" "$x" || { mkdir -p "$(dirname "$x")" && echo "/$pf${m}" >>"$x"; }; }; } >/dev/null 2>&1`,
    `  fi`,
    `fi`,
    `printf '%s %s\\n' "$p" "$n"`,
  ].join('\n');
}

/** Parse the script's one line; anything else is an error (a transport that ran something else). */
export function parseMarkerOutput(stdout: string): MarkerObservation {
  const m = /^(ours|other|absent) (ours|none)$/.exec(stdout.trim());
  if (!m) return { error: `unexpected marker output '${forLog(stdout.trim().slice(0, 80))}'` };
  return { prev: m[1] as 'ours' | 'other' | 'absent', now: m[2] as 'ours' | 'none' };
}

/** Run the marker script once. Never throws: a failure is an observation with `error`. */
export async function observeMarker(
  transport: Pick<SandboxTransport, 'exec'>,
  ws: SessionWorkspace,
  opts: { write: boolean },
): Promise<MarkerObservation> {
  try {
    const res = await transport.exec(buildMarkerScript(ws, opts), { timeout: 30 });
    if (res.exitCode !== 0) return { error: `marker exec exited ${res.exitCode ?? 'none'}` };
    return parseMarkerOutput(res.stdout.toString('utf8'));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The part of Pi's SessionManager the marker reads and writes: its loaded entries, and an append. */
export interface MarkerSessionLog {
  getEntries(): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

/**
 * The latest record for `key` in the loaded log. Only the LOADED entries: a session reopened from
 * a compaction checkpoint loads from there, so a record older than it reads as absent. That turn
 * then counts as a first one (and rewrites the record), which can miss a reset on exactly that turn
 * but never reports a false one.
 */
export function recordedMarker(log: Pick<MarkerSessionLog, 'getEntries'>, key: string): boolean {
  let written = false;
  for (const e of log.getEntries()) {
    const entry = e as { type?: string; customType?: string; data?: unknown } | null;
    if (entry?.type !== 'custom' || entry.customType !== WORKSPACE_MARKER_ENTRY) continue;
    const d = entry.data as { key?: unknown; written?: unknown } | null;
    if (d?.key === key && typeof d.written === 'boolean') written = d.written;
  }
  return written;
}

export interface WorkspaceMarkerCheck {
  verdict: MarkerVerdict;
  /**
   * The end-of-turn write, when the start found nothing of ours. Never throws. Called only by a
   * turn that ran: one that fails or is aborted before it leaves the marker as the start found it.
   */
  finish(): Promise<void>;
}

/**
 * The turn-start check: one Exec, then the decision, then the record. Never throws, so it cannot
 * fail a turn: an Exec that fails is logged and the turn runs with no verdict.
 */
export async function checkWorkspaceMarker(
  transport: Pick<SandboxTransport, 'exec'>,
  ws: SessionWorkspace,
  log: MarkerSessionLog,
  label: string,
): Promise<WorkspaceMarkerCheck> {
  let recorded = false;
  try {
    recorded = recordedMarker(log, ws.key);
  } catch {
    // A log that cannot be read is no record: the safe side, as for a session from before this.
  }
  // Read-only when recorded: only a first turn writes at its start (see decideWorkspaceMarker).
  const obs = await observeMarker(transport, ws, { write: !recorded });
  const decision = decideWorkspaceMarker(recorded, obs);
  if ('error' in obs) {
    console.warn(
      `workspace marker: session ${forLog(ws.key)}: check failed (${forLog(obs.error)}); no verdict this turn`,
    );
  } else if (decision.verdict === 'reset') {
    console.warn(
      `workspace marker: session ${forLog(ws.key)}: the workspace on ${forLog(label)} no longer carries ` +
        `its marker (${obs.prev}); reporting a workspace reset`,
    );
  }
  append(log, ws.key, decision.record);
  const recordedNow = decision.record ?? recorded;
  return {
    verdict: decision.verdict,
    finish: async () => {
      if (!decision.finishWrite) return;
      const end = await observeMarker(transport, ws, { write: true });
      if ('error' in end) {
        console.warn(
          `workspace marker: session ${forLog(ws.key)}: end-of-turn write failed (${forLog(end.error)})`,
        );
        return;
      }
      // Record only a change. A reset turn that left its fresh workspace empty records `false`, so
      // the next turn does not report the same reset again; one that wrote keeps `true`.
      const written = end.now === 'ours';
      if (written !== recordedNow) append(log, ws.key, written);
    },
  };
}

function append(log: MarkerSessionLog, key: string, written: boolean | undefined): void {
  if (written === undefined) return;
  try {
    log.appendCustomEntry(WORKSPACE_MARKER_ENTRY, { key, written });
  } catch (err) {
    // Best effort: a lost record is a later turn counted as a first one, never a false reset.
    console.warn(
      `workspace marker: session ${forLog(key)}: could not record the marker: ${forLog(String(err))}`,
    );
  }
}

/**
 * The reset note as a Pi extension: one custom message (`workspace_reset`, not displayed) beside
 * the turn's user message, added by `before_agent_start` (which Pi fires after expanding the
 * prompt), so the user's text, a `/skill:` or prompt-template call included, is left exactly as
 * sent. Pi stores it in the session log as its own entry, and sends it to the model.
 */
export function workspaceResetNoteExtension(note = WORKSPACE_RESET_NOTE): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', () => ({
      message: { customType: WORKSPACE_RESET_MESSAGE, content: note, display: false },
    }));
  };
}

/** The custom message type the reset note travels as. */
export const WORKSPACE_RESET_MESSAGE = 'workspace_reset';
