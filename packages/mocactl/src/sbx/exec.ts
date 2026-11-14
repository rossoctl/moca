import {
  execFailureText,
  ExecMachineryError,
  SandboxExecConn,
  type Exec,
  type ExecConnOptions,
  type LeaseOpName,
  type LeaseStatusView,
  type SandboxModeName,
  type SandboxTokenGrant,
  type TokenFn,
} from '@moca/sandbox-client';
import { ApiError } from '../api/errors.js';
import { describeError } from '../core/messages.js';
import { sanitizeRemote } from '../core/sanitize.js';
import type { SandboxApiClient, SbxToken } from './api.js';
import { failed, type SbxCtx } from './commands.js';

/**
 * A connection's lease calls (spec §8.3), as `SandboxExecConn` has them: an abort of `signal`
 * cancels the call, a LeaseControlError `cancelled` (P4-R12).
 */
export type LeaseControlFn = (
  op: LeaseOpName,
  setModeToken?: string,
  opts?: { signal?: AbortSignal },
) => Promise<LeaseStatusView>;

/** Builds the gRPC connection; a seam so tests run the commands against a fake. */
export type ExecFactory = (o: ExecConnOptions) => {
  exec: Exec;
  close(): void;
  leaseControl: LeaseControlFn;
  leaseKeepalive: () => Promise<void>;
};
const realFactory: ExecFactory = (o) => {
  const c = new SandboxExecConn(o);
  return {
    exec: c.exec,
    close: c.close,
    leaseControl: c.leaseControl,
    leaseKeepalive: c.leaseKeepalive,
  };
};

/** Seconds of token life a held token must keep beyond what the connection asks (spec §6.5). */
const MIN_LEFT_S = 60;
/**
 * A first token shorter than this (the smallest lifetime `deploy/sbx/setup.sh` allows, 5 min) is
 * most likely cut by the sandbox's own expiry: the sandbox is looked up, so the connection can
 * tell the two apart and say "the sandbox expires in N s" (final review M1).
 */
const SHORT_TOKEN_S = 300;

/**
 * `iat` and `exp` from a JWT's payload, read WITHOUT verifying it: only to learn the token's
 * lifetime (the relay verifies it). Undefined for anything that is not a readable JWT.
 */
export function jwtTimes(token: string): { iat: number; exp: number } | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat?: unknown;
      exp?: unknown;
    };
    return typeof c.iat === 'number' && typeof c.exp === 'number'
      ? { iat: c.iat, exp: c.exp }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `mode` claim of a sandbox token, read WITHOUT verifying it: informational only (which mode the
 * token was minted for; the relay and worker enforce it). Anything else is per-exec.
 */
export function jwtMode(token: string): SandboxModeName {
  const payload = token.split('.')[1];
  if (!payload) return 'per-exec';
  try {
    const m = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { mode?: unknown })
      .mode;
    return m === 'lease' || m === 'lease+processes' ? m : 'per-exec';
  } catch {
    return 'per-exec';
  }
}

/** What the connection needs of a minted token: `lifetimeS` is `exp − iat`, 0 if unreadable. */
export function grantOf(t: SbxToken): SandboxTokenGrant {
  const times = jwtTimes(t.token);
  const lifetimeS = times && times.exp > times.iat ? times.exp - times.iat : 0;
  return { token: t.token, expiresAt: t.expiresAt || times?.exp || 0, lifetimeS };
}

/**
 * The sandbox token for one sandbox, minted through the control plane (with the user's login) and
 * kept while it has `max(60, minValidS)` seconds left (SBX0 §6.4: the MCP server refreshes in
 * process; §6.5: an Exec's token covers its timeout plus 60 s). `force` re-mints, for the exec
 * client's one retry after a refusal. Concurrent asks share one mint.
 */
export function sandboxTokenFn(
  api: SandboxApiClient,
  id: string,
  now: () => number = Date.now,
  /** Called with each token minted, before any caller gets it (`sbx mcp` reads its mode). */
  onMint?: (t: SbxToken) => void,
): { token: TokenFn; first(signal?: AbortSignal): Promise<SbxToken> } {
  let cur: SbxToken | undefined;
  let pending: Promise<SbxToken> | undefined;
  const mint = (signal?: AbortSignal) =>
    (pending ??= api.mintSandboxToken(id, signal ? { signal } : {}).then(
      (t) => {
        pending = undefined;
        cur = t;
        onMint?.(t);
        return t;
      },
      (err: unknown) => {
        pending = undefined;
        throw err;
      },
    ));
  const get = async (
    force: boolean,
    minValidS: number,
    signal?: AbortSignal,
  ): Promise<SbxToken> => {
    const need = Math.max(MIN_LEFT_S, minValidS);
    if (force || !cur || cur.expiresAt - now() / 1000 < need) return mint(signal);
    return cur;
  };
  return {
    token: async ({ force, minValidS }) => grantOf(await get(force, minValidS)),
    first: (signal?: AbortSignal) => get(false, MIN_LEFT_S, signal),
  };
}

export interface OpenedExec {
  exec: Exec;
  close(): void;
  leaseControl: LeaseControlFn;
  leaseKeepalive(): Promise<void>;
  /** The first token, minted before dialing: where to dial and which worker and workspace. */
  token: SbxToken;
  /** The token's lifetime (`exp − iat`), 0 if unreadable: the default timeout is this minus 60. */
  lifetimeS: number;
}

/**
 * One sandbox's Exec function. The first mint happens here, so a terminated sandbox fails early and
 * readably (an `ApiError`, which `execFailed` reports as the control plane's answer).
 */
export async function openExec(
  api: SandboxApiClient,
  id: string,
  factory: ExecFactory = realFactory,
  o: {
    /** The client-side backstop beyond each Exec's timeout (sandbox-client's default: 90 s). */
    backstopMarginS?: number;
    /** The sandbox's expiresAt, when the caller already has it; else looked up if need be. */
    sandboxExpiresAt?: number;
    /** Called with each sandbox token minted, the first included. */
    onToken?: (t: SbxToken) => void;
    /** The connection's `Exec.keepalive` (default false). */
    keepalive?: ExecConnOptions['keepalive'];
    /** Aborts the opening's requests: the first token mint and the expiry lookup. */
    signal?: AbortSignal;
  } = {},
): Promise<OpenedExec> {
  const t = sandboxTokenFn(api, id, Date.now, o.onToken);
  const first = await t.first(o.signal);
  let sandboxExpiresAt = o.sandboxExpiresAt;
  const life = grantOf(first).lifetimeS;
  if (sandboxExpiresAt === undefined && life > 0 && life < SHORT_TOKEN_S) {
    // Best effort: without it, a short token is only reported as a short lifetime.
    sandboxExpiresAt = await api.getSandbox(id, o.signal ? { signal: o.signal } : {}).then(
      (s) => s.expiresAt,
      () => undefined,
    );
  }
  const c = factory({
    addr: first.execEndpoint,
    tls: true,
    ...(first.execCa ? { caPem: first.execCa } : {}),
    sandboxId: first.wrk,
    workspaceKey: first.wsk,
    token: t.token,
    ...(o.backstopMarginS !== undefined ? { backstopMarginS: o.backstopMarginS } : {}),
    ...(sandboxExpiresAt ? { sandboxExpiresAt } : {}),
    ...(o.keepalive !== undefined ? { keepalive: o.keepalive } : {}),
  });
  return {
    exec: c.exec,
    close: c.close,
    leaseControl: c.leaseControl,
    leaseKeepalive: c.leaseKeepalive,
    token: first,
    lifetimeS: grantOf(first).lifetimeS,
  };
}

/** `sbx run`'s exit for a sandbox failure: neither the command's code nor its timeout. */
export const EXIT_SANDBOX_FAILED = 125;
/** `sbx run`'s exit for a command that timed out or was killed (spec §6.1). */
export const EXIT_KILLED = 124;
/**
 * `sbx run`'s exit when the sandbox refused the command before it started, every try: the
 * relay's in-flight cap or the template worker's capacity (`memory-budget:`,
 * `max-runs:`, `busy: queue full`). Nothing ran, so a caller may run it again later. 75 is
 * sysexits' EX_TEMPFAIL.
 */
export const EXIT_BUSY = 75;

/** Whether an Exec failed before its command started, for want of capacity: safe to send again. */
export function refusedBeforeStart(err: unknown): boolean {
  return (
    err instanceof ExecMachineryError &&
    (err.kind === 'busy' || err.kind === 'template_busy') &&
    !err.mayHaveRun
  );
}

/**
 * The exit for an error from `openExec` or from an Exec: never the command's outcome.
 * - an `ApiError` (the token mint: a terminated sandbox, the login) goes through `failed`, so a
 *   401 whose retry refresh failed names the real cause (exit 1, 3 or 4);
 * - an abort (Ctrl-C) is 130;
 * - any other (`ExecMachineryError`, `ExecRefusedError`, a dropped connection) is 125. Nothing is
 *   retried here: a started command is never run twice.
 */
export function execFailed(c: SbxCtx, err: unknown): number {
  if (err instanceof ApiError) return failed(c, err);
  if (c.signal?.aborted) return 130;
  c.io.err(`sbx: ${sandboxFailureText(err)}`);
  return EXIT_SANDBOX_FAILED;
}

/** One line for a failure that was not the command's outcome: sandbox-client's text, for a person. */
export function sandboxFailureText(err: unknown): string {
  // The relay's and worker's messages are remote text: sanitized before they reach a terminal.
  const text = execFailureText(err, { audience: 'cli' });
  return text !== undefined ? sanitizeRemote(text) : `sandbox failure: ${describeError(err)}`;
}
