import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Exec, ExecResult } from './exec-conn.js';
import type { LeaseEvent } from './gen/sandbox/v1/sandbox.js';
import { LeaseControlError, type LeaseStatusView, type SandboxModeName } from './lease.js';
import { PI_SCHEMAS } from './schemas.js';

/**
 * The seven tools SBX0 serves (spec §6.4), with Pi's names and input schemas, reimplemented over an
 * Exec with no Pi dependency (ADR-0042), plus `sandbox_info` and the lease's `reset` (plan 4). Each
 * Pi tool costs ONE Exec -- edit two -- using the command shapes the prototype measured (#504's
 * fewer-execs.ts): on the microVM tier every per-exec Exec is a fresh VM, so a probe before the real
 * work costs as much as the work.
 *
 * The tools only depend on the `Exec` function type, never on the connection class. A machinery
 * failure (`ExecMachineryError`) or a refusal (`ExecRefusedError`) is THROWN, never returned as
 * text: it is not the command's output, and the MCP server maps it to a tool error that says so.
 */
export const WORKSPACE = '/workspace';
/** Pi's DEFAULT_MAX_LINES. */
export const MAX_LINES = 2000;
/** Pi's DEFAULT_MAX_BYTES. */
export const MAX_BYTES = 50 * 1024;
/** Pi's GREP_MAX_LINE_LENGTH. */
const GREP_MAX_LINE = 500;
/**
 * The file tools' explicit timeout. Short, so it fits the token already held: an Exec with no
 * timeout defaults to the token's whole lifetime and mints a fresh token on every call (spec §6.5).
 */
export const FILE_TOOL_TIMEOUT_S = 60;
/**
 * The most stdin one Exec may carry: the gRPC message limit is 16 MiB, and the request around the
 * stdin needs some of it. `write`, `edit` and `mocactl sbx push`/`put` refuse more.
 */
export const MAX_STDIN_BYTES = 14 * 1024 * 1024;
export const TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'sandbox_info',
  'reset',
] as const;

/**
 * The lease calls a tool may make (spec §8.3): `LeaseControl` status and reset. An abort of `signal`
 * cancels the call (a reset may wait up to grace_limit, 30 min).
 */
export type LeaseCall = (
  op: 'status' | 'reset',
  opts?: { signal?: AbortSignal },
) => Promise<LeaseStatusView>;

/**
 * What a lease mode tells the model in place of "every call is a fresh VM" (plan 4): one guest
 * may serve several calls, so /tmp may last, but still no process does.
 */
export const LEASE_RULE =
  'consecutive calls may share one guest until it restarts; no process survives a call; /tmp lasts until the guest restarts';
export const RESET_ENDED_TEXT = 'lease ended (reset): the next command starts a new guest';
export const RESET_NONE_TEXT = 'no lease to reset';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** The model's input was malformed: reported as a tool error, and nothing was sent. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface SandboxTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Exec cost: 1 for every tool, 2 for edit, 0 for sandbox_info and reset. Throws `ToolInputError` on
   * malformed input (nothing sent), and rethrows the Exec's own errors unchanged.
   */
  run(args: Record<string, unknown>, exec: Exec, signal?: AbortSignal): Promise<ToolResult>;
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** POSIX single-quoting for a shell word. */
export const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command that writes its stdin to `path` ATOMICALLY: the `write` tool's, `edit`'s write-back
 * and `mocactl sbx put`'s (one implementation of the write).
 *
 * The content goes to a temp file beside the target, which then replaces it with `mv`, so a full
 * disk or a killed VM leaves either the old file or the new one, never a cut one. It creates the
 * parent directories, keeps an existing target's mode (a new file gets the umask's), and writes
 * through a symlink to the file it points to, keeping the link. On any failure it removes the temp
 * file and exits non-zero. A read-only target is refused, as a plain write would refuse it. A
 * hard link to the target is not updated (the inode is replaced), and a kill mid-write can leave a
 * hidden `.sbx-*` temp beside the target.
 *
 * `expectSha256` (edit's write-back) makes the write conditional: the target's sha256, taken after
 * the temp file is complete and just before the rename, must equal it, or nothing is written and
 * the command exits `WRITE_CONFLICT_EXIT` (a target that no longer exists has changed too). The
 * check and the rename are one shell step apart, not one atomic operation: a writer landing in
 * that instant is not caught, one landing at any point between the read and the write is.
 */
export function writeFileCommand(path: string, o: { expectSha256?: string } = {}): string {
  const want = o.expectSha256;
  if (want !== undefined && !/^[0-9a-f]{64}$/.test(want)) {
    throw new RangeError('expectSha256 must be a lowercase hex sha256');
  }
  // GNU `chmod --reference` on the sandbox; `stat -f %Lp` is the BSD fallback (local tests).
  const mode =
    'if [ -e "$p" ]; then chmod --reference="$p" -- "$t" 2>/dev/null || ' +
    'chmod "$(stat -c %a -- "$p" 2>/dev/null || stat -f %Lp "$p")" "$t"; ' +
    `else chmod "$(printf '%o' $(( 0666 & ~$(umask) )))" "$t"; fi`;
  // coreutils `sha256sum` in the sandbox image; `shasum -a 256` is the BSD fallback (local tests).
  const unchanged =
    want === undefined
      ? ''
      : '{ [ -f "$p" ] && h=$({ sha256sum -- "$p" 2>/dev/null || shasum -a 256 -- "$p"; } | ' +
        `cut -d ' ' -f 1) && [ "$h" = ${q(want)} ] || ` +
        `{ rm -f -- "$t"; echo "$p: changed since it was read" >&2; exit ${WRITE_CONFLICT_EXIT}; }; } && `;
  return (
    `p=${q(path)}; if [ -L "$p" ]; then ` +
    'p=$(readlink -f -- "$p") || { echo "$p: cannot resolve the symlink" >&2; exit 1; }; fi; ' +
    'if [ -d "$p" ]; then echo "$p: Is a directory" >&2; exit 1; fi; ' +
    // The rename would replace a read-only file in a writable directory; refuse it, as a plain write would.
    'if [ -e "$p" ] && [ ! -w "$p" ]; then echo "$p: Permission denied" >&2; exit 1; fi; ' +
    'd=$(dirname -- "$p"); mkdir -p -- "$d" || exit 1; ' +
    't=$(mktemp "$d/.sbx-XXXXXX") || exit 1; ' +
    `if cat > "$t" && { ${mode}; } && ${unchanged}mv -f -- "$t" "$p"; then exit 0; fi; ` +
    'rm -f -- "$t"; exit 1'
  );
}
/** `writeFileCommand`'s exit status when `expectSha256` did not match: nothing was written. */
export const WRITE_CONFLICT_EXIT = 3;

/** Pi's line-ending and BOM handling for `edit` (edit-diff.ts), so CRLF files stay CRLF. */
function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  if (lf === -1 || crlf === -1) return '\n';
  return crlf < lf ? '\r\n' : '\n';
}
/** CRLF beside a lone LF, or a bare CR: one ending cannot be restored to every line. */
const mixedLineEndings = (text: string): boolean =>
  /\r(?!\n)/.test(text) || (text.includes('\r\n') && /(?<!\r)\n/.test(text));
const normalizeToLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const restoreLineEndings = (text: string, ending: '\r\n' | '\n'): string =>
  ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
const stripBom = (content: string): { bom: string; text: string } =>
  content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };

/** A model-supplied string must not carry NUL: no shell word or path can hold one. */
function noNul(k: string, v: string): string {
  if (v.includes('\0')) throw new ToolInputError(`${k} must not contain NUL characters`);
  return v;
}

function str(a: Record<string, unknown>, k: string): string {
  const v = a[k];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolInputError(`${k} is required and must be a non-empty string`);
  }
  return noNul(k, v);
}
function optStr(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolInputError(`${k} must be a non-empty string`);
  }
  return noNul(k, v);
}
function optInt(a: Record<string, unknown>, k: string, min: number): number | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ToolInputError(`${k} must be a whole number of at least ${min}`);
  }
  return v;
}
const optBool = (a: Record<string, unknown>, k: string): boolean => a[k] === true;

/** Pi's formatSize. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The last `max` bytes of `s`, starting on a character boundary. */
function lastBytes(s: string, max: number): string {
  const b = Buffer.from(s);
  let start = Math.max(0, b.length - max);
  while (start < b.length && (b[start]! & 0xc0) === 0x80) start++;
  return b.subarray(start).toString();
}

/** Keep the LAST lines (bash: the end of a build log is what matters), within both limits. */
function tail(text: string): string {
  const nl = text.endsWith('\n') ? '\n' : '';
  const lines = (nl ? text.slice(0, -1) : text).split('\n');
  if (lines.length <= MAX_LINES && Buffer.byteLength(text) <= MAX_BYTES) return text;
  let kept = lines.slice(-MAX_LINES);
  let bytes = Buffer.byteLength(kept.join('\n') + nl);
  while (bytes > MAX_BYTES && kept.length > 1) {
    bytes -= Buffer.byteLength(kept[0]!) + 1;
    kept = kept.slice(1);
  }
  if (bytes > MAX_BYTES) {
    const line = kept[0]!;
    return (
      `[Showing the last ${formatSize(MAX_BYTES)} of line ${lines.length} ` +
      `(${formatSize(Buffer.byteLength(line))})]\n${lastBytes(line, MAX_BYTES)}`
    );
  }
  return `[Showing the last ${kept.length} of ${lines.length} lines]\n${kept.join('\n')}${nl}`;
}

/** Pi's `appendStatus`: output, a blank line, then the status. */
const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ''}${status}`;

/** Why a file tool's Exec did not succeed, for its error text. */
const why = (r: ExecResult): string =>
  r.timedOutS !== undefined
    ? `timed out after ${r.timedOutS} seconds`
    : r.stderr.toString().trim() || `exit ${r.exitCode}`;

const capNote = (requested: number | undefined) =>
  requested === undefined
    ? "[timeout capped below the default, to fit the sandbox token's remaining lifetime]"
    : `[timeout capped below the requested ${requested}s, the sandbox token's lifetime]`;

export function sandboxTools(o: {
  info: () => Promise<string>;
  workspace?: string;
  /** The sandbox's mode, for the texts: a lease mode says calls may share a guest. */
  mode?: SandboxModeName;
  /** `reset`'s lease calls. Without them, `reset` fails as unavailable. */
  lease?: LeaseCall;
  /** The mode `reset` acts on, asked at each call (default `mode`): it may change mid-session. */
  currentMode?: () => Promise<SandboxModeName>;
  /**
   * Whether the pending event a reset answered with is the end this reset made (default: an end
   * with reason `reset`). The MCP server also marks it seen, so the next result does not repeat it.
   */
  resetEnded?: (pending: LeaseEvent | undefined) => boolean;
}): SandboxTool[] {
  const ws = o.workspace ?? WORKSPACE;
  const leased = (o.mode ?? 'per-exec') !== 'per-exec'; // the texts' mode
  const at = (p: string): string => (posix.isAbsolute(p) ? posix.normalize(p) : posix.join(ws, p));
  const rel = (line: string): string =>
    line.startsWith(`${ws}/`) ? line.slice(ws.length + 1) : line;
  const fileOpts = (signal?: AbortSignal) => ({ timeoutS: FILE_TOOL_TIMEOUT_S, signal });
  const rules = leased
    ? `It runs in a remote sandbox whose working directory is ${ws}: ${LEASE_RULE}. There is no ` +
      `network, and files under ${ws} persist. Calls run one at a time, so batch the work.`
    : `It runs in a remote sandbox whose working directory is ${ws}. Every call is a fresh VM: no ` +
      `process survives it, there is no network, and files under ${ws} persist. Calls run one at a ` +
      'time, so batch the work.';
  const size = `${MAX_LINES} lines or ${MAX_BYTES / 1024}KB`;

  const bash: SandboxTool = {
    name: 'bash',
    description:
      `Execute a bash command in ${ws}. ${rules} Returns stdout and stderr; output is truncated to ` +
      `the last ${size} (whichever is hit first). Never start background jobs or servers expecting ` +
      'them to keep running; chain the work into one command instead. Optionally provide a timeout ' +
      "in seconds; the default, and the maximum, is the sandbox's cap (its token lifetime less 60 s).",
    inputSchema: PI_SCHEMAS.bash as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const command = str(a, 'command');
      const timeout = a.timeout;
      if (
        timeout !== undefined &&
        !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
      ) {
        throw new ToolInputError('timeout must be a positive number of seconds');
      }
      // No timeout of our own: the connection defaults to, and caps at, the token's lifetime − 60 s.
      const r = await exec(command, { timeoutS: timeout, signal });
      const out = r.stdout.toString();
      const errText = r.stderr.toString();
      let body = tail(errText ? (out && !out.endsWith('\n') ? `${out}\n` : out) + errText : out);
      if (r.truncated) body += "\n[stdout exceeded the sandbox's 8 MiB cap and was cut]";
      if (r.timedOutS !== undefined) {
        const capped = r.capped
          ? ` (timeout capped at ${r.timedOutS}s, the sandbox token's lifetime)`
          : '';
        return err(appendStatus(body, `Command timed out after ${r.timedOutS} seconds${capped}`));
      }
      if (r.exitCode < 0) {
        return err(appendStatus(body, 'Command was killed (out of memory or a signal)'));
      }
      if (r.exitCode !== 0)
        return err(appendStatus(body, `Command exited with code ${r.exitCode}`));
      const text = body || '(no output)';
      return ok(r.capped ? appendStatus(text, capNote(timeout)) : text);
    },
  };

  const read: SandboxTool = {
    name: 'read',
    description:
      `Read the contents of a file in the sandbox. Output is truncated to ${size} (whichever is hit ` +
      'first); use offset/limit for large files, and continue with offset until complete. ' +
      rules,
    inputSchema: PI_SCHEMAS.read as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const path = at(str(a, 'path'));
      // Pi treats offset 0 as the start; so does this.
      const offset = Math.max(1, optInt(a, 'offset', 0) ?? 1);
      const limit = optInt(a, 'limit', 1);
      const r = await exec(`cat -- ${q(path)}`, fileOpts(signal));
      if (r.exitCode !== 0) return err(`Could not read ${path}: ${why(r)}`);
      if (r.truncated) {
        return err(
          `${path} is larger than 8 MiB, the sandbox's output cap; read it in parts with bash ` +
            `(sed -n '1,${MAX_LINES}p' ${q(path)})`,
        );
      }
      if (r.stdout.includes(0)) {
        return ok(`${path} is a binary file (${r.stdout.length} bytes); not shown`);
      }
      const text = r.stdout.toString();
      const nl = text.endsWith('\n') ? '\n' : '';
      const lines = text === '' ? [] : (nl ? text.slice(0, -1) : text).split('\n');
      const total = lines.length;
      if (offset > Math.max(total, 1)) {
        return err(`Offset ${offset} is beyond end of file (${total} lines total)`);
      }
      const start = offset - 1;
      const want = lines.slice(start, limit === undefined ? undefined : start + limit);
      const shown: string[] = [];
      let bytes = 0;
      let byBytes = false;
      for (const l of want) {
        const b = Buffer.byteLength(l) + (shown.length > 0 ? 1 : 0);
        if (shown.length >= MAX_LINES) break;
        if (bytes + b > MAX_BYTES) {
          byBytes = true;
          break;
        }
        shown.push(l);
        bytes += b;
      }
      if (shown.length === 0 && want.length > 0) {
        // Pi's wording: the first line alone is over the byte limit.
        return ok(
          `[Line ${offset} is ${formatSize(Buffer.byteLength(want[0]!))}, exceeds ` +
            `${formatSize(MAX_BYTES)} limit. Use bash: sed -n '${offset}p' ${q(path)} | head -c ${MAX_BYTES}]`,
        );
      }
      const end = start + shown.length;
      if (end === total) return ok(shown.join('\n') + (shown.length ? nl : ''));
      const limitNote = byBytes ? ` (${formatSize(MAX_BYTES)} limit)` : '';
      return ok(
        `${shown.join('\n')}\n\n[Showing lines ${offset}-${end} of ${total}${limitNote}. ` +
          `Use offset=${end + 1} to continue.]`,
      );
    },
  };

  const write: SandboxTool = {
    name: 'write',
    description:
      'Write content to a file in the sandbox. Creates the file if it does not exist, overwrites ' +
      `it if it does, and creates parent directories. ${rules}`,
    inputSchema: PI_SCHEMAS.write as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const path = at(str(a, 'path'));
      if (typeof a.content !== 'string') {
        throw new ToolInputError('content is required and must be a string');
      }
      const data = Buffer.from(a.content);
      if (data.length > MAX_STDIN_BYTES) {
        throw new ToolInputError(
          `content is ${formatSize(data.length)}, over the ${formatSize(MAX_STDIN_BYTES)} one call ` +
            'can carry; write it in parts (write the first part, then append with bash)',
        );
      }
      const r = await exec(writeFileCommand(path), { stdin: data, ...fileOpts(signal) });
      if (r.exitCode !== 0) return err(`Could not write ${path}: ${why(r)}`);
      return ok(`Successfully wrote ${data.length} bytes to ${path}`);
    },
  };

  const edit: SandboxTool = {
    name: 'edit',
    description:
      'Edit a single file in the sandbox using exact text replacement. Every edits[].oldText must ' +
      'match a unique, non-overlapping region of the original file. If two changes affect the same ' +
      `block or nearby lines, merge them into one edit instead of emitting overlapping edits. ${rules}`,
    inputSchema: PI_SCHEMAS.edit as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const path = at(str(a, 'path'));
      const edits = a.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new ToolInputError(
          'Edit tool input is invalid. edits must contain at least one replacement.',
        );
      }
      const many = edits.length > 1;
      const parsed = edits.map((e, i) => {
        const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
        if (typeof x.oldText !== 'string' || x.oldText === '' || typeof x.newText !== 'string') {
          throw new ToolInputError(
            `${many ? `edits[${i}]` : 'the edit'} needs a non-empty oldText and a newText`,
          );
        }
        return { oldText: x.oldText, newText: x.newText };
      });
      const r = await exec(`cat -- ${q(path)}`, fileOpts(signal));
      if (r.exitCode !== 0) return err(`Could not edit file: ${path}. ${why(r)}.`);
      // A cut read would be written back cut: refuse BEFORE writing (data loss otherwise).
      if (r.truncated) {
        return err(
          `Could not edit file: ${path}. It is larger than 8 MiB, the sandbox's output cap, so it ` +
            'cannot be edited whole; use bash (sed -i) instead.',
        );
      }
      const raw = r.stdout.toString();
      // Bytes that are not UTF-8 would come back as U+FFFD: refuse instead of corrupting them.
      if (!Buffer.from(raw).equals(r.stdout)) {
        return err(
          `Could not edit file: ${path}. It is not valid UTF-8 text, and editing it here would ` +
            'corrupt it; use bash instead.',
        );
      }
      // Pi's matching: on LF-normalized text without the BOM (the model never sends an invisible
      // BOM or CRs); the endings and the BOM are restored on write. Pi's fuzzy pass (NFKC, smart
      // quotes, trailing spaces) is left out on purpose: when it matches, Pi writes the WHOLE file
      // back in normalized form, which rewrites lines the edit never touched.
      const { bom, text: unbom } = stripBom(raw);
      // Normalizing and restoring one ending would rewrite the lines with the other: refuse, as
      // Pi's fuzzy pass is refused above, rather than touch lines the edit never named.
      if (mixedLineEndings(unbom)) {
        return err(
          `Could not edit file: ${path}. It has mixed line endings (CRLF beside LF, or a bare CR), ` +
            "and editing it here would rewrite every line's ending; use bash instead.",
        );
      }
      const ending = detectLineEnding(unbom);
      const original = normalizeToLF(unbom);
      const wanted = parsed.map((e) => ({
        oldText: normalizeToLF(e.oldText),
        newText: normalizeToLF(e.newText),
      }));
      const spans: { i: number; start: number; end: number; newText: string }[] = [];
      for (const [i, e] of wanted.entries()) {
        const first = original.indexOf(e.oldText);
        if (first < 0) {
          return err(
            many
              ? `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
              : `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
          );
        }
        const count = original.split(e.oldText).length - 1;
        if (count > 1) {
          return err(
            many
              ? `Found ${count} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
              : `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
          );
        }
        spans.push({ i, start: first, end: first + e.oldText.length, newText: e.newText });
      }
      spans.sort((x, y) => x.start - y.start);
      for (let k = 1; k < spans.length; k++) {
        if (spans[k]!.start < spans[k - 1]!.end) {
          return err(
            `edits[${spans[k - 1]!.i}] and edits[${spans[k]!.i}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
          );
        }
      }
      let next = '';
      let pos = 0;
      for (const s of spans) {
        next += original.slice(pos, s.start) + s.newText;
        pos = s.end;
      }
      next += original.slice(pos);
      if (next === original) {
        return err(
          many
            ? `No changes made to ${path}. The replacements produced identical content.`
            : `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        );
      }
      const out = Buffer.from(bom + restoreLineEndings(next, ending));
      if (out.length > MAX_STDIN_BYTES) {
        return err(
          `Could not edit file: ${path}. The result is ${formatSize(out.length)}, over the ` +
            `${formatSize(MAX_STDIN_BYTES)} one call can carry; use bash (sed -i) instead.`,
        );
      }
      // Optimistic concurrency: written only if the file is still the one read, so a concurrent
      // writer (another client, or a cancelled call still running remotely) is never overwritten.
      const read = createHash('sha256').update(r.stdout).digest('hex');
      const w = await exec(writeFileCommand(path, { expectSha256: read }), {
        stdin: out,
        ...fileOpts(signal),
      });
      if (w.exitCode === WRITE_CONFLICT_EXIT && w.timedOutS === undefined) {
        return err(
          `Could not edit file: ${path}. It changed since it was read, so nothing was written; ` +
            'read it again and redo the edit.',
        );
      }
      if (w.exitCode !== 0) return err(`Could not edit file: ${path}. ${why(w)}.`);
      return ok(`Successfully replaced ${spans.length} block(s) in ${path}.`);
    },
  };

  const grep: SandboxTool = {
    name: 'grep',
    description:
      'Search file contents in the sandbox with ripgrep (hidden files included, .git excluded; ' +
      'respects .gitignore). Returns matching lines as path:line:text, with paths relative to ' +
      `${ws}. Output is truncated to limit matches (default 100) or ${MAX_BYTES / 1024}KB; long ` +
      `lines are cut to ${GREP_MAX_LINE} chars. ${rules}`,
    inputSchema: PI_SCHEMAS.grep as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const pattern = str(a, 'pattern');
      const path = at(optStr(a, 'path') ?? ws);
      const glob = optStr(a, 'glob');
      const context = optInt(a, 'context', 0) ?? 0;
      const limit = optInt(a, 'limit', 1) ?? 100;
      const flags = [
        // -H: a single-file search still prints the file name, as Pi's does.
        '-n -H --no-heading --color=never --hidden',
        optBool(a, 'ignoreCase') ? '-i' : '',
        optBool(a, 'literal') ? '-F' : '',
        context ? `-C ${context}` : '',
        glob ? `--glob ${q(glob)}` : '',
        // LAST: in ripgrep the later --glob wins, so a user glob such as '*' cannot re-admit .git.
        "--glob '!.git'",
      ]
        .filter(Boolean)
        .join(' ');
      // The most lines `limit` matches can take: each with its context, and `--` between groups.
      const cap = limit * (2 * context + 1) + (context ? limit - 1 : 0);
      const r = await exec(
        `f=$(mktemp) || exit 2; rg ${flags} -e ${q(pattern)} -- ${q(path)} > "$f"; code=$?; ` +
          `head -n ${cap + 1} "$f"; rm -f "$f"; exit $code`,
        fileOpts(signal),
      );
      if (r.timedOutS !== undefined) return err(`grep ${why(r)}`);
      if (r.exitCode === 1) return ok('No matches found');
      if (r.exitCode !== 0) {
        return err(r.stderr.toString().trim() || `ripgrep exited with code ${r.exitCode}`);
      }
      const all = r.stdout
        .toString()
        .split('\n')
        .filter((l) => l.length > 0);
      if (all.length === 0) return ok('No matches found');
      const notices: string[] = [];
      let lines = all;
      if (lines.length > cap) {
        lines = lines.slice(0, cap);
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
      }
      let cut = false;
      lines = lines.map((l) => {
        const x = rel(l);
        if (x.length <= GREP_MAX_LINE) return x;
        cut = true;
        return `${x.slice(0, GREP_MAX_LINE)}... [truncated]`;
      });
      const head = headBytes(lines);
      if (head.cut) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
      if (cut) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE} chars. Use read tool to see full lines`,
        );
      }
      return ok(head.text + (notices.length ? `\n\n[${notices.join('. ')}]` : ''));
    },
  };

  const find: SandboxTool = {
    name: 'find',
    description:
      'Search for files by glob pattern in the sandbox (hidden files included, .git excluded; ' +
      'respects .gitignore). Returns matching file paths relative to the search directory, sorted. ' +
      `Output is truncated to limit results (default 1000) or ${MAX_BYTES / 1024}KB. ${rules}`,
    inputSchema: PI_SCHEMAS.find as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const pattern = str(a, 'pattern');
      const path = at(optStr(a, 'path') ?? ws);
      const limit = optInt(a, 'limit', 1) ?? 1000;
      // Exit 3 (which rg never uses) says the directory is missing.
      const r = await exec(
        `cd -- ${q(path)} || exit 3; f=$(mktemp) || exit 2; ` +
          // '!.git' LAST: the later --glob wins in ripgrep, so '*' or '**/*' cannot list .git.
          `rg --files --hidden --glob ${q(pattern)} --glob '!.git' > "$f"; code=$?; ` +
          `echo "__total:$(wc -l < "$f" | tr -d ' ')"; LC_ALL=C sort "$f" | head -n ${limit}; ` +
          `rm -f "$f"; exit $code`,
        fileOpts(signal),
      );
      if (r.timedOutS !== undefined) return err(`find ${why(r)}`);
      if (r.exitCode === 3) return err(`Path not found or not a directory: ${path}`);
      const [first, ...rest] = r.stdout.toString().split('\n');
      const total = Number(/^__total:(\d+)$/.exec(first ?? '')?.[1] ?? 0);
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return err(r.stderr.toString().trim() || `ripgrep exited with code ${r.exitCode}`);
      }
      if (total === 0) return ok('No files found matching pattern');
      const head = headBytes(rest.filter((l) => l.length > 0));
      const notices: string[] = [];
      if (total > head.shown)
        notices.push(`${head.shown} of ${total} results shown. Use limit to see more.`);
      if (head.cut) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
      return ok(head.text + (notices.length ? `\n\n[${notices.join(' ')}]` : ''));
    },
  };

  const ls: SandboxTool = {
    name: 'ls',
    description:
      'List directory contents in the sandbox. Returns entries sorted alphabetically, with / ' +
      `suffix for directories. Includes dotfiles. Output is truncated to limit entries (default ` +
      `500) or ${MAX_BYTES / 1024}KB. ${rules}`,
    inputSchema: PI_SCHEMAS.ls as unknown as Record<string, unknown>,
    async run(a, exec, signal) {
      const path = at(optStr(a, 'path') ?? ws);
      const limit = optInt(a, 'limit', 1) ?? 500;
      const r = await exec(`cd -- ${q(path)} && ls -1Ap`, fileOpts(signal));
      if (r.timedOutS !== undefined) return err(`ls ${why(r)}`);
      if (r.exitCode !== 0) return err(`Path not found or not a directory: ${path}`);
      // Pi's order: case-insensitive, whatever the sandbox's locale.
      const entries = r.stdout
        .toString()
        .split('\n')
        .filter((l) => l.length > 0)
        .sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
      if (entries.length === 0) return ok('(empty directory)');
      const head = headBytes(entries.slice(0, limit));
      const notices: string[] = [];
      if (entries.length > head.shown) {
        notices.push(`${head.shown} of ${entries.length} entries shown. Use limit to see more.`);
      }
      if (head.cut) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
      return ok(head.text + (notices.length ? `\n\n[${notices.join(' ')}]` : ''));
    },
  };

  const sandboxInfo: SandboxTool = {
    name: 'sandbox_info',
    description: "The sandbox's template, expiry, rules and lease. Costs no VM.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => ok(await o.info()),
  };

  const lease: LeaseCall =
    o.lease ??
    (async () => {
      throw new LeaseControlError('unavailable', 'this client has no lease calls');
    });
  const resetEnded =
    o.resetEnded ?? ((p: LeaseEvent | undefined) => p?.state === 'end' && p.reason === 'reset');
  const reset: SandboxTool = {
    name: 'reset',
    description:
      "End the sandbox's current guest, so the next command starts a new guest: /tmp, installs " +
      `outside ${ws} and background processes are gone; files under ${ws} stay. Use it when the ` +
      'guest is in a bad state. Costs no VM.',
    inputSchema: { type: 'object', properties: {} },
    async run(_a, _exec, signal) {
      // A per-exec sandbox has no lease (and its worker may have no lease calls): nothing to ask.
      const m = o.currentMode ? await o.currentMode() : (o.mode ?? 'per-exec');
      if (m === 'per-exec') return ok(RESET_NONE_TEXT);
      // The worker holds a reset behind another client's running Exec: a cancelled call stops
      // waiting, so it does not hold the MCP server's call queue past its cancel. A reset of no
      // lease is a no-op there, so no status is asked first: the text comes from the reset's own
      // answer, the end it left pending, with no check-then-act between two calls.
      const after = await lease('reset', { signal });
      return ok(resetEnded(after.pending) ? RESET_ENDED_TEXT : RESET_NONE_TEXT);
    },
  };

  return [bash, read, write, edit, grep, find, ls, sandboxInfo, reset];
}

/** The first lines that fit in MAX_BYTES, joined. */
function headBytes(lines: string[]): { text: string; shown: number; cut: boolean } {
  let bytes = 0;
  let n = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l) + (n > 0 ? 1 : 0);
    if (bytes + b > MAX_BYTES) break;
    bytes += b;
    n++;
  }
  return { text: lines.slice(0, n).join('\n'), shown: n, cut: n < lines.length };
}
