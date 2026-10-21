/**
 * Client-side ledger of spawned subagents at `$XDG_STATE_HOME/mocactl/subagents.jsonl` (0600).
 * Each line is a `record` (initial) or `update` (state delta); `readAll` folds updates onto
 * records by sessionId. Lock-free: single `O_APPEND` write per line on a local filesystem is
 * atomic, and the 64 KiB prompt cap keeps every line in one `write(2)`. `compact` rewrites via
 * tmp+rename; it has no automatic trigger (see spec §5).
 */
import {
  closeSync,
  constants as fsConst,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { HonestState } from '../transport/leaf-turn.js';

export interface LedgerEnvelope {
  /** `string` (not a union) so legacy rows (e.g. `kind: 'converge'`) read without a type lie. */
  kind: string;
  prompt?: string;
  repoUrl?: string;
  ref?: string;
  configRef?: string;
  workloadId?: string;
  contextWritable?: boolean;
}

export interface LedgerRecord {
  sessionId: string;
  tag?: string;
  /** A caller label for this one dispatch (`spawn --label`); mocactl-local, never sent to the server. */
  label?: string;
  bundle?: string;
  /** The workload the run was sent to (`spawn --workload`). */
  workloadId?: string;
  /** The run had its own writable copy of the workload's context (`spawn --writable`). */
  writable?: boolean;
  envelope: LedgerEnvelope;
  submittedAt: number;
  /** The detached worker's pid. Absent until the child is forked. */
  childPid?: number;
  /** Latest observed state. Starts as 'running'. */
  lastKnownState: HonestState;
  stateDetail?: string;
  /** When this state was last written, in epoch ms. */
  stateObservedAt: number;
}

type LedgerLine =
  | { v: 1; type: 'record'; record: LedgerRecord }
  | {
      v: 1;
      type: 'update';
      sessionId: string;
      lastKnownState: HonestState;
      stateDetail?: string;
      stateObservedAt: number;
      /** Set when the detached worker's pid is first known. */
      childPid?: number;
    };

export interface Ledger {
  append(record: LedgerRecord): void;
  updateState(
    sessionId: string,
    lastKnownState: HonestState,
    opts?: { detail?: string; childPid?: number; now?: number },
  ): void;
  readAll(): LedgerRecord[];
  find(sessionId: string): LedgerRecord | undefined;
  /** Rewrites the file as folded records. Not called on the hot path. */
  compact(): void;
}

export function openLedger(path: string, now: () => number = Date.now): Ledger {
  ensureParentDir(path);
  return {
    append(record: LedgerRecord): void {
      writeLine(path, { v: 1, type: 'record', record });
    },
    updateState(sessionId, lastKnownState, opts = {}): void {
      writeLine(path, {
        v: 1,
        type: 'update',
        sessionId,
        lastKnownState,
        ...(opts.detail !== undefined ? { stateDetail: opts.detail } : {}),
        stateObservedAt: opts.now ?? now(),
        ...(opts.childPid !== undefined ? { childPid: opts.childPid } : {}),
      });
    },
    readAll(): LedgerRecord[] {
      return foldLines(readLines(path));
    },
    find(sessionId: string): LedgerRecord | undefined {
      return foldLines(readLines(path)).find((r) => r.sessionId === sessionId);
    },
    compact(): void {
      const current = foldLines(readLines(path));
      const tmp = `${path}.tmp.${process.pid}.${now()}`;
      const body = current
        .map((r) => JSON.stringify({ v: 1, type: 'record', record: r } satisfies LedgerLine))
        .join('\n');
      // Atomic swap via rename: a reader opens either the old file or the new one.
      writeFileSync(tmp, body + (body ? '\n' : ''), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

function writeLine(path: string, line: LedgerLine): void {
  // Mode on the syscall + O_NOFOLLOW is TOCTOU-free; a symlinked state file ELOOPs.
  const flags = fsConst.O_WRONLY | fsConst.O_CREAT | fsConst.O_APPEND | fsConst.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, JSON.stringify(line) + '\n');
  } finally {
    closeSync(fd);
  }
}

function readLines(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (!text) return [];
  const out: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // partial write from a crash; `compact` clears it.
    }
    const l = line as LedgerLine;
    if (l?.v === 1 && (l.type === 'record' || l.type === 'update')) out.push(l);
  }
  return out;
}

function foldLines(lines: LedgerLine[]): LedgerRecord[] {
  const byId = new Map<string, LedgerRecord>();
  for (const line of lines) {
    if (line.type === 'record') {
      byId.set(line.record.sessionId, { ...line.record });
    } else {
      const existing = byId.get(line.sessionId);
      if (!existing) continue; // orphaned update; `compact` drops it.
      existing.lastKnownState = line.lastKnownState;
      existing.stateObservedAt = line.stateObservedAt;
      if (line.stateDetail !== undefined) existing.stateDetail = line.stateDetail;
      else delete existing.stateDetail;
      if (line.childPid !== undefined) existing.childPid = line.childPid;
    }
  }
  return [...byId.values()].sort((a, b) => a.submittedAt - b.submittedAt);
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Touch the file so `readAll` on a fresh install returns []. */
export function initLedger(path: string): void {
  ensureParentDir(path);
  const flags = fsConst.O_WRONLY | fsConst.O_CREAT | fsConst.O_APPEND | fsConst.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  closeSync(fd);
}
