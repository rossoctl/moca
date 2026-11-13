import { status, type ServerWritableStream } from '@grpc/grpc-js';
import {
  LeaseOp,
  SandboxMode,
  type Exec,
  type ExecEvent,
  type ExecRequest,
  type LeaseControlRequest,
  type LeaseControlResponse,
  type LeaseKeepaliveRequest,
} from '@moca/k8s-sandbox';
import type { SandboxModeName, SandboxTokenClaims, SetModeClaims } from '@moca/control-plane';
import type { Relay, RelayTimers } from './relay.js';
import { workerReqId, type SetModeVerifier } from './sandbox-auth.js';
import {
  failExecStream,
  grpcError,
  newPumpResult,
  pumpExec,
  withReqId,
  type PumpResult,
} from './exec-stream.js';

const EXEC_MODE: Record<SandboxModeName, SandboxMode> = {
  'per-exec': SandboxMode.SANDBOX_MODE_PER_EXEC,
  lease: SandboxMode.SANDBOX_MODE_LEASE,
  'lease+processes': SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
};

/**
 * An Exec's mode fields, from the verified token (lease-mode spec §8.2). On the sandbox path the
 * relay is their only setter: whatever the client wrote is overwritten with these, so a client
 * cannot raise its own lease mode. A token minted before the claims existed was defaulted to
 * per-exec, 0, 0 by verifySandboxToken.
 */
export function claimsToExecMode(
  claims: Pick<SandboxTokenClaims, 'mode' | 'mode_epoch' | 'idle_timeout_s'>,
): Pick<Exec, 'mode' | 'modeEpoch' | 'idleTimeoutS'> {
  return {
    mode: EXEC_MODE[claims.mode],
    modeEpoch: claims.mode_epoch,
    idleTimeoutS: claims.idle_timeout_s,
  };
}

/**
 * One audit line per sandbox Exec (SBX0 §3.5), on the relay's refusal channel. Who (`sub`, `sbx`,
 * only from a token that VERIFIED), where (`wrk`, the sandbox_id asked for), which (`req_id`, the
 * caller's), how long, how it ended and how much stdout. Never the output, never the token, and the
 * command only as `cmd`, its first 200 bytes, with the operator's SH_SANDBOX_AUDIT_COMMANDS=1.
 * `audit` is the marker a log reader selects on (deploy/sbx/status.sh).
 */
export interface AuditLine {
  audit: 'sandbox_exec';
  /** When the relay received the Exec. */
  ts: string;
  sub?: string;
  sbx?: string;
  wrk: string;
  req_id: number;
  ms: number;
  outcome: AuditOutcome;
  exit_code?: number;
  truncated?: boolean;
  out_bytes: number;
  reason?: string;
  cmd?: string;
}

/**
 * - `end`: the worker sent End (any exit code);
 * - `timeout`: the worker timed the command out (ExecError `timeout:<n>`);
 * - `expired`: the relay cancelled it at its token's exp plus leeway;
 * - `busy`: the sandbox's in-flight cap refused it;
 * - `error`: any other ExecError, or routing failed (no live worker, a disconnect);
 * - `cancelled`: the client cancelled the call, or Aborted it;
 * - `refused`: UNAUTHENTICATED, PERMISSION_DENIED, ALREADY_EXISTS or INVALID_ARGUMENT, with `reason`.
 */
export type AuditOutcome =
  'end' | 'timeout' | 'expired' | 'busy' | 'error' | 'cancelled' | 'refused';

/**
 * One audit line per LeaseControl (lease-mode spec §8.2), marker `sandbox_lease_control`. `mode`
 * and `modeEpoch` are a set_mode's, from its set-mode token, and only once that token verified.
 * Keepalives are not audited: a client may send one every few seconds.
 */
export interface LeaseControlAuditLine {
  audit: 'sandbox_lease_control';
  ts: string;
  sub?: string;
  sbx?: string;
  wrk: string;
  op: LeaseOpName;
  mode?: SandboxModeName;
  modeEpoch?: number;
  ms: number;
  outcome: LeaseControlOutcome;
  reason?: string;
}

/**
 * The op as an audit line names it; `unspecified` for 0 or a value this relay does not know.
 * `sandbox_deleted` is the control plane's notice that the sandbox is gone: the worker ends the
 * lease with that reason. Like reset, it takes no mode and no epoch.
 */
export type LeaseOpName = 'status' | 'reset' | 'set_mode' | 'sandbox_deleted' | 'unspecified';

/**
 * - `ok`: the worker answered without an error;
 * - `failed`: the worker answered with one (FAILED_PRECONDITION; `reason` is its wire string);
 * - `timeout`: the worker did not answer within the op's timeout (DEADLINE_EXCEEDED);
 * - `error`: no live worker, the frame could not be written, or it disconnected first (UNAVAILABLE);
 * - `busy`: the sandbox already had LEASE_CONTROL_MAX_INFLIGHT calls in flight (RESOURCE_EXHAUSTED);
 * - `cancelled`: the client cancelled the call before the worker answered;
 * - `refused`: UNAUTHENTICATED, PERMISSION_DENIED or INVALID_ARGUMENT, with `reason`.
 */
export type LeaseControlOutcome =
  'ok' | 'failed' | 'timeout' | 'error' | 'busy' | 'cancelled' | 'refused';

export function leaseOpName(op: LeaseOp): LeaseOpName {
  switch (op) {
    case LeaseOp.LEASE_OP_STATUS:
      return 'status';
    case LeaseOp.LEASE_OP_RESET:
      return 'reset';
    case LeaseOp.LEASE_OP_SET_MODE:
      return 'set_mode';
    case LeaseOp.LEASE_OP_SANDBOX_DELETED:
      return 'sandbox_deleted';
    default:
      return 'unspecified';
  }
}

/** The worker's timeout form, byte-identical across transports (remote-worker session/loop.go). */
const WORKER_TIMEOUT_RE = /^timeout:\d+$/;

/** The most of a command an audit line carries (SBX0 §3.5). */
export const AUDIT_COMMAND_BYTES = 200;
/** The most of a caller-chosen sandbox_id an audit line carries: one request, one bounded line. */
const AUDIT_WRK_BYTES = 128;

/** The first `max` bytes of `s` in UTF-8, cut back to a character boundary. */
function utf8Prefix(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  let end = max;
  // Back off continuation bytes (10xxxxxx) so the cut never lands inside a sequence.
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}

/** A command's first 200 bytes, cut on a character boundary. */
export function commandPreview(command: string): string {
  return utf8Prefix(command, AUDIT_COMMAND_BYTES);
}

/** Writes the audit lines. Built only on a relay with sandbox keys; `write` absent writes nothing. */
export function makeAudit(write: ((line: string) => void) | undefined, withCommands: boolean) {
  // An audit line must never stop enforcement: it runs before the expiry abort and the slot's
  // release, so a throw while BUILDING the line (a timestamp, a prefix, a claims getter) or while
  // writing it is reported and swallowed. `build` runs inside the try, so every method's whole body
  // is covered, not only the write.
  const emit = (build: () => Record<string, unknown>) => {
    try {
      write?.(JSON.stringify(build()));
    } catch (err) {
      console.error(
        `[sandbox-relay] audit line not written: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  };
  return {
    /**
     * One Exec's line. `t0` is when the relay received it; `command` is dropped unless the flag.
     * Pass `claims` and `command` only for a token that verified: an unverified one's are its own.
     */
    exec(
      t0: number,
      l: Omit<AuditLine, 'audit' | 'ts' | 'ms' | 'cmd' | 'sub' | 'sbx' | 'wrk'> & {
        wrk: string;
        claims?: SandboxTokenClaims;
        command?: string;
      },
    ): void {
      // A fixed key order (SBX0 §3.5), whatever order the caller built `l` in; absent, never null.
      emit(() => {
        const { claims, command } = l;
        return {
          audit: 'sandbox_exec',
          ts: new Date(t0).toISOString(),
          ...(claims ? { sub: claims.sub, sbx: claims.sbx } : {}),
          wrk: utf8Prefix(l.wrk, AUDIT_WRK_BYTES),
          req_id: l.req_id,
          ms: Math.max(0, Date.now() - t0),
          outcome: l.outcome,
          ...(l.exit_code !== undefined ? { exit_code: l.exit_code } : {}),
          ...(l.truncated !== undefined ? { truncated: l.truncated } : {}),
          out_bytes: l.out_bytes,
          ...(l.reason !== undefined ? { reason: l.reason } : {}),
          ...(withCommands && command !== undefined ? { cmd: commandPreview(command) } : {}),
        };
      });
    },
    /**
     * An expired Exec whose worker never ended it within the drain grace: its slot and Abort
     * ownership are given back anyway. Not an Exec line (that was `expired`), so its own marker.
     */
    released(wrk: string, reqId: number, graceS: number, claims: SandboxTokenClaims): void {
      emit(() => ({
        audit: 'sandbox_release',
        ts: new Date().toISOString(),
        sub: claims.sub,
        sbx: claims.sbx,
        wrk: utf8Prefix(wrk, AUDIT_WRK_BYTES),
        req_id: reqId,
        outcome: 'released',
        reason: `the worker did not end the Exec within ${graceS} s of its expiry abort`,
      }));
    },
    /** One LeaseControl's line. `t0` is when the relay received it. */
    leaseControl(
      t0: number,
      l: Omit<
        LeaseControlAuditLine,
        'audit' | 'ts' | 'ms' | 'sub' | 'sbx' | 'mode' | 'modeEpoch'
      > & {
        claims?: SandboxTokenClaims;
        setMode?: SetModeClaims;
      },
    ): void {
      emit(() => ({
        audit: 'sandbox_lease_control',
        ts: new Date(t0).toISOString(),
        ...(l.claims ? { sub: l.claims.sub, sbx: l.claims.sbx } : {}),
        wrk: utf8Prefix(l.wrk, AUDIT_WRK_BYTES),
        op: l.op,
        ...(l.setMode ? { mode: l.setMode.mode, modeEpoch: l.setMode.mode_epoch } : {}),
        ms: Math.max(0, Date.now() - t0),
        outcome: l.outcome,
        ...(l.reason !== undefined ? { reason: l.reason } : {}),
      }));
    },
    /** A refused Abort (not an Exec, so a separate marker that Exec statistics skip). */
    abortRefused(wrk: string, reqId: number, reason: string, claims?: SandboxTokenClaims): void {
      emit(() => ({
        audit: 'sandbox_abort',
        ts: new Date().toISOString(),
        ...(claims ? { sub: claims.sub, sbx: claims.sbx } : {}),
        wrk: utf8Prefix(wrk, AUDIT_WRK_BYTES),
        req_id: reqId,
        outcome: 'refused',
        reason,
      }));
    },
  };
}
export type Audit = ReturnType<typeof makeAudit>;

/** The outcome of an Exec that ran to its end (not expired, not cancelled at the call). */
function finished(
  r: PumpResult,
  aborted: boolean,
): Pick<AuditLine, 'outcome' | 'exit_code' | 'truncated'> {
  if (r.cancelled || aborted) return { outcome: 'cancelled' };
  if (r.end) return { outcome: 'end', exit_code: r.end.exitCode, truncated: r.end.truncated };
  if (r.execError !== undefined)
    return { outcome: WORKER_TIMEOUT_RE.test(r.execError) ? 'timeout' : 'error' };
  return { outcome: 'error' };
}

/** setTimeout's delay is a signed 32-bit ms count; a longer one fires at once (Node clamps to 1). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long after an expiry Abort an unacknowledged sandbox Exec keeps its in-flight slot. The Go
 * worker always sends a terminal frame; this bounds a wedged guest or a lost frame, which would
 * otherwise hold the slot for as long as the attach stream lives.
 */
export const SANDBOX_DRAIN_GRACE_S = 60;

/**
 * Runs `fn` once at the absolute time `deadlineMs`, re-arming across setTimeout's 24.8-day ceiling
 * so a long-lived token is never cancelled early. Returns the canceller.
 */
export function armDeadline(
  deadlineMs: number,
  fn: () => void,
  timers: RelayTimers = { setTimeout, clearTimeout: (h) => clearTimeout(h as never) },
): () => void {
  let handle: unknown;
  const arm = () => {
    const left = deadlineMs - Date.now();
    handle =
      left > MAX_TIMER_MS
        ? timers.setTimeout(arm, MAX_TIMER_MS)
        : timers.setTimeout(fn, Math.max(0, left));
  };
  arm();
  return () => timers.clearTimeout(handle);
}

/** How long a LeaseControl status waits for the worker's answer. */
export const LEASE_STATUS_TIMEOUT_MS = 15_000;
/**
 * How long a mutate op (reset, set_mode, sandbox_deleted) waits: the worker's LeaseGraceLimit
 * (30 min, remote-worker/internal/vmpool/config.go), for which EndLease and SetMode can block, plus
 * 60 s. Linked to `maxLeaseGraceS` in remote-worker/cmd/microvm-worker/main.go, the largest grace a
 * worker boots with: raise one only with the other (a contract test on each side reads the other's
 * literal).
 */
export const LEASE_MUTATE_TIMEOUT_MS = 31 * 60_000;

/**
 * LeaseControl calls in flight per `sbx` (plan 3 ruling R13). Each holds a waiter in the relay for
 * up to LEASE_MUTATE_TIMEOUT_MS, so without a cap one sandbox could grow the relay's memory without
 * bound. A cancelled call gives its slot back at once.
 */
export const LEASE_CONTROL_MAX_INFLIGHT = 4;

/** The per-op LeaseControl timeouts; tests set short ones (plan 3 ruling R4). */
export interface LeaseTimeoutsMs {
  status: number;
  mutate: number;
}

/** What the sandbox caller needs from the relay server (SBX0 §3.6). */
export interface SandboxCallerOpts {
  maxInflight: number;
  /** Seconds past a token's `exp` at which its running Exec is cancelled. */
  leewayS: number;
  /** Seconds after the expiry Abort at which an unacknowledged Exec gives back its slot anyway. */
  drainGraceS: number;
  /** The key of the per-sandbox req_id mapping (workerReqId); never leaves the relay. */
  reqIdKey: Buffer;
  timers?: RelayTimers;
  /** Where the audit lines go (SBX0 §3.5). */
  audit: Audit;
  /** Verifies a set_mode's set-mode token. Absent, every set_mode is refused. */
  verifySetMode?: SetModeVerifier;
  /** Defaults to LEASE_STATUS_TIMEOUT_MS and LEASE_MUTATE_TIMEOUT_MS. */
  leaseTimeoutsMs?: LeaseTimeoutsMs;
}

/**
 * The sandbox caller kind's Exec and Abort rules (SBX0 §3.6), behind the caller check: exact
 * worker and workspace, per-sandbox request ids, no Exec outliving its token, the in-flight cap,
 * and Abort only of the caller's own in-flight Exec. One per Exec server.
 */
export function makeSandboxCaller(relay: Relay, opts: SandboxCallerOpts) {
  const { maxInflight, leewayS, drainGraceS, reqIdKey, audit } = opts;
  // A sandbox caller may abort only an Exec its own sandbox started and that is still in flight:
  // req_ids are not secret, so without this one sandbox could kill another's command. Keyed by the
  // token's sbx and the CALLER's req_id; the entry holds where the Exec actually runs.
  // `aborted`: the owner's Abort reached it, so however the worker acknowledges, it was cancelled.
  const owned = new Map<string, { wrk: string; wid: number; aborted?: boolean }>();
  const ownKey = (sbx: string, reqId: number) => `${sbx}\0${reqId}`;
  // Accepted, unfinished sandbox Execs per sbx (SBX0 §3.6).
  const inflight = new Map<string, number>();

  async function sandboxExec(
    call: ServerWritableStream<ExecRequest, ExecEvent>,
    claims: SandboxTokenClaims,
    sandboxId: string,
    e: Exec,
    t0: number,
  ): Promise<void> {
    // Exactly one line per Exec, whichever path ends it first.
    let logged = false;
    const log = (
      l: Pick<AuditLine, 'outcome' | 'exit_code' | 'truncated' | 'reason'>,
      outBytes = 0,
    ) => {
      if (logged) return;
      logged = true;
      audit.exec(t0, {
        wrk: sandboxId,
        req_id: e.reqId,
        claims,
        command: e.command,
        out_bytes: outBytes,
        ...l,
      });
    };
    // A call cancelled before its handler ran never fires 'cancelled' again, so nothing would abort
    // what it started: route nothing.
    if (call.cancelled) {
      log({ outcome: 'cancelled' });
      return;
    }
    // Exact equality on both (SBX0 §3.2): never a prefix, so sbx-a cannot reach sbx-ab.
    const denied =
      sandboxId !== claims.wrk
        ? "exec not permitted: sandbox_id is not this token's worker"
        : e.workspaceKey !== claims.wsk
          ? "exec not permitted: workspace_key is not this token's workspace"
          : undefined;
    if (denied) {
      log({ outcome: 'refused', reason: denied });
      failExecStream(call, grpcError(status.PERMISSION_DENIED, denied));
      return;
    }
    const key = ownKey(claims.sbx, e.reqId);
    if (owned.has(key)) {
      // Refused here, not left to routeExec's collision: that would name the worker's id, and
      // this Exec's cleanup must never drop the first one's ownership entry.
      log({ outcome: 'refused', reason: 'req_id_in_flight' });
      failExecStream(
        call,
        grpcError(status.ALREADY_EXISTS, `req_id ${e.reqId} already in flight for this sandbox`),
      );
      return;
    }
    const n = inflight.get(claims.sbx) ?? 0;
    if (n >= maxInflight) {
      log({ outcome: 'busy' });
      failExecStream(
        call,
        grpcError(status.RESOURCE_EXHAUSTED, `sandbox busy: ${n} Execs already in flight`),
      );
      return;
    }
    let wid: number;
    try {
      wid = workerReqId(reqIdKey, claims.sbx, e.reqId);
    } catch {
      log({ outcome: 'refused', reason: 'req_id out of range' });
      failExecStream(call, grpcError(status.INVALID_ARGUMENT, 'req_id out of range'));
      return;
    }
    const entry: { wrk: string; wid: number; aborted?: boolean } = { wrk: sandboxId, wid };
    // Read by the expiry and cancel lines before the drain ends, so they carry the bytes so far.
    const result = newPumpResult();
    // No Exec outlives its token (SBX0 §3.6): at exp + leeway the worker is told to abort and
    // the call ends at once. The handler then drains the worker's acknowledgement without
    // writing it, so the slot and the ownership entry are held until the worker lets go -- or,
    // if it never does (a wedged guest, a lost frame), until the drain grace has passed.
    let expired = false;
    let disarm: ReturnType<typeof armDeadline> | undefined;
    let disarmGrace: ReturnType<typeof armDeadline> | undefined;
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      if (owned.get(key) === entry) owned.delete(key);
      const left = (inflight.get(claims.sbx) ?? 1) - 1;
      if (left > 0) inflight.set(claims.sbx, left);
      else inflight.delete(claims.sbx);
    };
    try {
      owned.set(key, entry);
      inflight.set(claims.sbx, n + 1);
      disarm = armDeadline(
        (claims.exp + leewayS) * 1000,
        () => {
          expired = true;
          // Now, not after the drain: a worker that never acknowledges must still leave a line. A
          // call the client already cancelled has its line; this is a no-op then.
          log({ outcome: 'expired' }, result.outBytes);
          // Always, even on a call already cancelled: a second Abort is a no-op on the worker, and
          // a missed one leaves the command running to its own timeout.
          relay.routeAbort(sandboxId, wid);
          if (!call.cancelled) {
            failExecStream(
              call,
              grpcError(status.DEADLINE_EXCEEDED, 'sandbox token expired during the Exec'),
            );
          }
          disarmGrace = armDeadline(
            Date.now() + drainGraceS * 1000,
            () => {
              audit.released(sandboxId, e.reqId, drainGraceS, claims);
              free();
            },
            opts.timers,
          );
        },
        opts.timers,
      );
      await pumpExec(
        call,
        relay,
        sandboxId,
        // keepalive is the client's opt-in (spec §4); the mode fields are only ever the token's.
        { ...e, reqId: wid, ...claimsToExecMode(claims) },
        {
          // Never let the worker's id reach the caller: every frame carries the caller's own.
          toCaller: (ev) => withReqId(ev, e.reqId),
          // routeExec's collision message names the id it collided on; the caller sees its own.
          mapError: (err) => {
            const m = err.message.split(String(wid)).join(String(e.reqId));
            if (m === err.message) return err;
            const code = (err as { code?: unknown }).code;
            return typeof code === 'number' ? grpcError(code, m) : new Error(m);
          },
          over: () => expired,
          // Now, for the same reason as expiry.
          onCancelled: () => log({ outcome: 'cancelled' }, result.outBytes),
          result,
        },
      );
    } finally {
      // After the drain; a no-op when expiry or a cancel already wrote this Exec's line. Here, so a
      // throw out of the pump still leaves one (as `error`: it has no End).
      log(finished(result, entry.aborted === true), result.outBytes);
      if (disarm) disarm();
      if (disarmGrace) disarmGrace();
      free();
    }
  }

  /**
   * Where a sandbox caller's Abort goes, or the refusal: only an in-flight Exec of its own sandbox,
   * on the worker it named, under the worker's id.
   */
  function sandboxAbort(
    claims: SandboxTokenClaims,
    sandboxId: string,
    reqId: number,
  ): { wrk: string; wid: number } | { refusal: Error } {
    const entry = owned.get(ownKey(claims.sbx, reqId));
    if (!entry || entry.wrk !== sandboxId) {
      const why = 'abort not permitted: not an in-flight Exec of this sandbox';
      audit.abortRefused(sandboxId, reqId, why, claims);
      return { refusal: grpcError(status.PERMISSION_DENIED, why) };
    }
    entry.aborted = true;
    return entry;
  }

  const leaseTimeouts = opts.leaseTimeoutsMs ?? {
    status: LEASE_STATUS_TIMEOUT_MS,
    mutate: LEASE_MUTATE_TIMEOUT_MS,
  };
  // LeaseControl calls in flight per sbx, sent to the worker and not yet settled.
  const leaseInflight = new Map<string, number>();

  /**
   * A sandbox caller's LeaseControl (lease-mode spec §8.2): on its own worker and workspace only,
   * and a set_mode only with a set-mode token for this same sandbox, whose mode and epoch are the
   * ones sent. Nothing reaches the worker before every check has passed. At most
   * LEASE_CONTROL_MAX_INFLIGHT per sbx; `signal` aborting (the client cancelled) withdraws the
   * call and frees its slot at once. Rejects with the status the call ends with; exactly one audit
   * line either way.
   */
  async function sandboxLeaseControl(
    claims: SandboxTokenClaims,
    req: LeaseControlRequest,
    t0: number,
    signal?: AbortSignal,
  ): Promise<LeaseControlResponse> {
    const op = leaseOpName(req.op);
    let setMode: SetModeClaims | undefined;
    const line = (outcome: LeaseControlOutcome, reason?: string) =>
      audit.leaseControl(t0, {
        wrk: req.sandboxId,
        op,
        outcome,
        claims,
        ...(setMode ? { setMode } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    // Logs the refusal and returns the error the call ends with: `throw refusal(...)`.
    const refusal = (code: number, message: string, reason = message) => {
      line('refused', reason);
      return grpcError(code, message);
    };

    if (req.sandboxId !== claims.wrk) {
      throw refusal(
        status.PERMISSION_DENIED,
        "lease control not permitted: sandbox_id is not this token's worker",
      );
    }
    if (op === 'unspecified') throw refusal(status.INVALID_ARGUMENT, 'lease control needs an op');
    // The cap first, before the set-mode token: saturated, every call is answered busy alike, so
    // it is no oracle for a token's validity, and no verify work is spent on it. Nothing below
    // awaits before the slot is taken, so `n` is still current then.
    const n = leaseInflight.get(claims.sbx) ?? 0;
    if (n >= LEASE_CONTROL_MAX_INFLIGHT) {
      line('busy');
      throw grpcError(
        status.RESOURCE_EXHAUSTED,
        `sandbox busy: ${n} lease controls already in flight`,
      );
    }
    let mode = SandboxMode.SANDBOX_MODE_UNSPECIFIED;
    let modeEpoch = 0;
    if (op === 'set_mode') {
      const denied = 'set_mode not permitted: the set-mode token did not verify';
      if (!req.setModeToken) throw refusal(status.PERMISSION_DENIED, denied, 'no set-mode token');
      if (!opts.verifySetMode) throw refusal(status.PERMISSION_DENIED, denied, 'no set-mode keys');
      const v = opts.verifySetMode(req.setModeToken);
      if (!v.claims) throw refusal(status.PERMISSION_DENIED, denied, v.reason);
      setMode = v.claims;
      // Exact equality on all three, as an Exec's: a token for sbx-a never changes sbx-b's lease.
      // The same message as a token that did not verify (ruling R11): the client learns nothing
      // about whose token it holds; the audit line says which check refused it.
      if (setMode.sbx !== claims.sbx || setMode.wrk !== claims.wrk || setMode.wsk !== claims.wsk) {
        throw refusal(status.PERMISSION_DENIED, denied, 'set-mode token is for another sandbox');
      }
      ({ mode, modeEpoch } = claimsToExecMode(setMode));
    }

    leaseInflight.set(claims.sbx, n + 1);
    let result;
    try {
      result = await relay.routeLeaseControl(
        req.sandboxId,
        { workspaceKey: claims.wsk, op: req.op, mode, modeEpoch },
        op === 'status' ? leaseTimeouts.status : leaseTimeouts.mutate,
        signal,
      );
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const outcome =
        code === status.DEADLINE_EXCEEDED
          ? 'timeout'
          : code === status.CANCELLED
            ? 'cancelled'
            : code === status.PERMISSION_DENIED
              ? 'refused' // the relay's workload check
              : 'error';
      line(outcome, (err as Error).message);
      throw err;
    } finally {
      const left = (leaseInflight.get(claims.sbx) ?? 1) - 1;
      if (left > 0) leaseInflight.set(claims.sbx, left);
      else leaseInflight.delete(claims.sbx);
    }
    if (result.error) {
      line('failed', result.error);
      throw grpcError(status.FAILED_PRECONDITION, result.error);
    }
    line('ok');
    return { status: result.status };
  }

  /**
   * A sandbox caller's LeaseKeepalive: its own worker only, its own workspace. Not audited. Answered
   * OK even when the relay coalesces it (LEASE_KEEPALIVE_COALESCE_MS) and writes no frame.
   */
  function sandboxLeaseKeepalive(claims: SandboxTokenClaims, req: LeaseKeepaliveRequest): void {
    if (req.sandboxId !== claims.wrk) {
      throw grpcError(
        status.PERMISSION_DENIED,
        "lease keepalive not permitted: sandbox_id is not this token's worker",
      );
    }
    relay.routeKeepalive(req.sandboxId, claims.wsk);
  }

  return {
    exec: sandboxExec,
    abort: sandboxAbort,
    leaseControl: sandboxLeaseControl,
    leaseKeepalive: sandboxLeaseKeepalive,
  };
}
