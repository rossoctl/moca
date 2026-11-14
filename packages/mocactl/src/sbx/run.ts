import { posix } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ExecAbortedError,
  execFailureText,
  ExecMachineryError,
  ExecRefusedError,
  TOKEN_MARGIN_S,
  type Exec,
  type ExecResult,
  WORKSPACE,
  writeFileCommand,
} from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { Io } from '../headless.js';
import { SBX_EXIT, type SbxCtx } from './commands.js';
import {
  EXIT_BUSY,
  EXIT_KILLED,
  execFailed,
  openExec,
  refusedBeforeStart,
  type ExecFactory,
} from './exec.js';
import { serveSbxMcp, stdioTransport } from './mcp.js';
import { printNotices } from './notices.js';

/** `put`'s timeout: a write of at most 14 MiB, well inside any token's life (no extra mint). */
export const PUT_TIMEOUT_S = 120;

/**
 * `--timeout S`: a whole number of seconds, at least 1. Undefined when absent; null (after saying
 * why) when malformed. The upper bound is the token's, known only once one is minted.
 */
export function parseTimeout(io: Io, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    io.err(`sbx: --timeout must be a whole number of seconds, at least 1 (got '${raw}')`);
    return null;
  }
  return n;
}

/** A refusal's reason in one line, for the retry note: the client's own text, sanitized. */
function sandboxReason(err: unknown): string {
  return sanitizeRemote(execFailureText(err, { audience: 'cli' }) ?? String(err));
}

/** The command's own output, byte for byte: never decoded, never given a newline. */
function passThrough(io: Io, stdout: Buffer, stderr: Buffer): void {
  if (stdout.length) {
    if (io.outBytes) io.outBytes(stdout);
    else io.out(stdout.toString());
  }
  if (stderr.length) {
    if (io.errBytes) io.errBytes(stderr);
    else io.err(stderr.toString().replace(/\n$/, ''));
  }
}

/** How many times `sbx run` sends a command the sandbox refused before starting it. */
export const DEFAULT_BUSY_RETRIES = 4;
/** The waits between those tries: 1, 2, 4, 8 s (under 30 s in all with the jitter), then 8 s each. */
const BUSY_BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * MOCACTL_SBX_BUSY_RETRIES: a whole number of retries, 0 for none; anything else is the default.
 */
export function busyRetries(env: NodeJS.ProcessEnv): number {
  const raw = env.MOCACTL_SBX_BUSY_RETRIES?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return DEFAULT_BUSY_RETRIES;
  return Math.min(Number(raw), 20);
}

export interface RunRetry {
  /** Retries after a refusal before start (`refusedBeforeStart`); 0 for none. */
  retries: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0 to 1, for the jitter; tests fix it. */
  random?: () => number;
}

/**
 * One Exec, sent again after a refusal before start (`refusedBeforeStart`) up to `retry.retries`
 * times, with a note per retry: the command runs at most once. Returns the result, or the exit to
 * stop with: `EXIT_BUSY` when every try was refused, 130 when interrupted while waiting. Any other
 * failure is thrown, for the caller's `execFailed`.
 */
async function execRetrying(
  c: SbxCtx,
  x: { exec: Exec },
  command: string,
  opts: Parameters<Exec>[1],
  retry: RunRetry,
  capS?: number,
): Promise<ExecResult | number> {
  // The backoff sleeps spend the sandbox token's lifetime: each retry's timeout is re-capped to
  // what the token has left (capS, its lifetime minus the margin, less the time waited so far).
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    let attemptOpts = opts;
    if (capS !== undefined && waitedMs > 0) {
      const leftS = capS - Math.ceil(waitedMs / 1000);
      if (leftS <= 0) {
        c.io.err(
          `sbx: the sandbox token has too little time left to send the command again; nothing ran (exit ${EXIT_BUSY})`,
        );
        return EXIT_BUSY;
      }
      if (opts?.timeoutS === undefined || opts.timeoutS > leftS)
        attemptOpts = { ...opts, timeoutS: leftS };
    }
    try {
      return await x.exec(command, attemptOpts);
    } catch (err) {
      if (!refusedBeforeStart(err) || c.signal?.aborted) throw err;
      if (attempt >= retry.retries) {
        execFailed(c, err);
        c.io.err(
          `sbx: the sandbox refused the command ${attempt + 1} time${attempt ? 's' : ''} before starting it; nothing ran (exit ${EXIT_BUSY})`,
        );
        return EXIT_BUSY;
      }
      const base = BUSY_BACKOFF_MS[Math.min(attempt, BUSY_BACKOFF_MS.length - 1)]!;
      const waitMs = Math.round(base * (0.75 + 0.5 * (retry.random ?? Math.random)()));
      c.io.err(
        `sbx: ${sandboxReason(err)}; nothing ran; retrying in ${(waitMs / 1000).toFixed(1)}s (${attempt + 1}/${retry.retries})`,
      );
      await retry.sleep(waitMs, c.signal);
      waitedMs += waitMs;
      if (c.signal?.aborted) return 130;
    }
  }
}

/**
 * `mocactl sbx run` (SBX0 §6.1): one Exec, never retried once started. Exits with the command's
 * code; 124 when it timed out (`ExecError{"timeout:<n>"}`) or was killed; 125 when the sandbox
 * failed (`execFailed`). The timeout defaults to, and is capped at, the sandbox token's lifetime
 * minus 60 s (§6.5); a larger `--timeout` is clamped with a note.
 *
 * A command the sandbox refused BEFORE starting it, for want of capacity (the relay's in-flight
 * cap, or the template worker's `memory-budget:`, `max-runs:`, `busy: queue full`),
 * is sent again after a backoff with jitter, up to `retry.retries` times (MOCACTL_SBX_BUSY_RETRIES,
 * default 4), with a note each time. Nothing ran, so the command still runs at most once. Refused
 * every time: exit 75 (`EXIT_BUSY`). Interrupted while waiting: 130. The waits count against the
 * sandbox token's lifetime: each retry's timeout is re-capped to what the token has left, and with
 * nothing left the command is not sent again (exit 75).
 */
export async function cmdRun(
  c: SbxCtx,
  id: string,
  command: string,
  timeout: number | undefined,
  factory?: ExecFactory,
  retry: RunRetry = { retries: 0, sleep: async () => {} },
): Promise<number> {
  let x;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return execFailed(c, err);
  }
  try {
    // A token near the sandbox's end leaves no positive cap: send no timeout, so the exec client
    // says why ("the sandbox expires in N s; pull your work now") instead of a range error.
    const cap = x.lifetimeS - TOKEN_MARGIN_S > 0 ? x.lifetimeS - TOKEN_MARGIN_S : undefined;
    let timeoutS = timeout ?? cap;
    if (timeout !== undefined && cap !== undefined && timeout > cap) {
      c.io.err(
        `sbx: --timeout ${timeout}s is over what the sandbox token allows; running with ${cap}s ` +
          `(the token's lifetime minus ${TOKEN_MARGIN_S}s)`,
      );
      timeoutS = cap;
    }
    const r = await execRetrying(
      c,
      x,
      command,
      { ...(timeoutS !== undefined ? { timeoutS } : {}), signal: c.signal },
      retry,
      cap,
    );
    if (typeof r === 'number') return r;
    // A lease end happened before this command ran: said first, as an MCP result starts with it.
    printNotices(c, id, r.lease);
    passThrough(c.io, r.stdout, r.stderr);
    // mocactl's own notes start on a line of their own, after the command's stderr.
    const notes = r.truncated || r.capped || r.timedOutS !== undefined || r.exitCode < 0;
    if (notes && c.io.errBytes && r.stderr.length && r.stderr.at(-1) !== 0x0a) {
      c.io.errBytes(Buffer.from('\n'));
    }
    if (r.truncated) c.io.err("sbx: stdout exceeded the sandbox's 8 MiB cap and was cut");
    if (r.capped) {
      c.io.err('sbx: the timeout was cut to fit what the sandbox token had left');
    }
    if (r.timedOutS !== undefined) {
      c.io.err(`sbx: the command timed out after ${r.timedOutS}s`);
      return EXIT_KILLED;
    }
    if (r.exitCode < 0) {
      c.io.err('sbx: the command was killed (out of memory, or a signal)');
      return EXIT_KILLED;
    }
    return r.exitCode;
  } catch (err) {
    // The worker sends lease events before an error too (spec §5): said before the failure, or
    // the refusal, or the interrupt; the worker acked them, so nothing else will say them.
    if (
      err instanceof ExecMachineryError ||
      err instanceof ExecRefusedError ||
      err instanceof ExecAbortedError
    ) {
      printNotices(c, id, err.lease);
    }
    return execFailed(c, err);
  } finally {
    x.close();
  }
}

/**
 * Where `put PATH` writes: relative to /workspace, or an absolute path under it. Undefined for a
 * path outside /workspace, which no later Exec would see (each runs in a fresh VM).
 */
export function workspacePath(path: string): string | undefined {
  const p = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(WORKSPACE, path);
  return p.startsWith(`${WORKSPACE}/`) ? p : undefined;
}

/**
 * `mocactl sbx put PATH` (SBX0 §6.1): stdin, byte for byte, written atomically (`writeFileCommand`).
 * A refusal before start is retried as `run`'s (the write is atomic and did not start), and exits 75
 * when every try was refused.
 */
export async function cmdPut(
  c: SbxCtx,
  id: string,
  /** Already resolved by `workspacePath`. */
  target: string,
  content: Buffer,
  factory?: ExecFactory,
  retry: RunRetry = { retries: 0, sleep: async () => {} },
): Promise<number> {
  let x;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return execFailed(c, err);
  }
  try {
    const r = await execRetrying(
      c,
      x,
      writeFileCommand(target),
      { stdin: content, timeoutS: PUT_TIMEOUT_S, signal: c.signal },
      retry,
      x.lifetimeS - TOKEN_MARGIN_S > 0 ? x.lifetimeS - TOKEN_MARGIN_S : undefined,
    );
    if (typeof r === 'number') return r;
    if (r.exitCode !== 0) {
      c.io.err(
        `sbx: put failed: ${sanitizeRemote(r.stderr.toString().trim()) || `exit ${r.exitCode}`}`,
      );
      return SBX_EXIT.failed;
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return execFailed(c, err);
  } finally {
    x.close();
  }
}

/**
 * `mocactl sbx mcp` (SBX0 §6.4): serves until the client closes stdin or the signal aborts. Only
 * MCP frames go to stdout; a failure to start is reported on stderr.
 */
export async function cmdMcp(
  c: SbxCtx,
  id: string,
  transport?: Transport,
  factory?: ExecFactory,
): Promise<number> {
  try {
    await serveSbxMcp(c, id, transport ?? (await stdioTransport()), factory);
    return SBX_EXIT.ok;
  } catch (err) {
    return execFailed(c, err);
  }
}
