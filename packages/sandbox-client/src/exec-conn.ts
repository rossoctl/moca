import { randomBytes } from 'node:crypto';
import * as tls from 'node:tls';
import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import {
  Exec as ExecMessage,
  ExecKind,
  LeaseControlRequest,
  LeaseKeepaliveRequest,
  LeaseOp,
  ProcessArgs,
  SandboxExecClient,
  Stream,
  type ExecEvent,
  type LeaseControlResponse,
  type LeaseEvent,
} from './gen/sandbox/v1/sandbox.js';
import {
  LeaseControlError,
  leaseStatusView,
  type LeaseStatusView,
  type TrackedProcessView,
} from './lease.js';

/**
 * The sandbox/v1 exec client for SBX0's clients (spec §6.5, §7): TLS to the exec Route, keepalive
 * under a load balancer's idle cut, and a short-lived sandbox token kept fresh through `token()`.
 *
 * The one retry rule: a token refusal (UNAUTHENTICATED) is retried once, with a forced fresh token,
 * ONLY if no event arrived. A command that started is never run twice: any failure after the first
 * event -- a dropped connection included -- is surfaced as an error. The worker's `stale_mode:`
 * refusal (the token predates a mode change) is retried the same way, once, under a new req_id
 * (ruling P4-R21): the worker refuses it before the start, so nothing ran. So is the relay's
 * `processes_not_enabled:` refusal of a process kind (P5-R29): the held token may predate an
 * upgrade to lease+processes, and the fresh one reads the record as it is now. The lease calls follow
 * the token rule (ruling P4-R7): `leaseControl`, every op, and `leaseKeepalive` retry a token
 * refusal once with a forced fresh token, and a second refusal is a LeaseControlError
 * `unauthenticated`. The relay refuses the bearer before routing, so `set_mode` resends the same
 * set-mode token, never used yet. The process calls (plan 5, `process`) are Execs of a process
 * kind, under the same retries as `exec`.
 */
export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** < 0: killed by a signal (an abort, a timeout, a crash). */
  exitCode: number;
  /** stdout hit the worker's 8 MiB cap. */
  truncated: boolean;
  /**
   * Set when the worker timed the command out (`ExecError{"timeout:<n>"}`): the `<n>` it reports.
   * `exitCode` is then < 0. A timeout is the command's outcome, not a machinery failure.
   */
  timedOutS?: number;
  /** Set when the requested `timeoutS` was cut to fit the sandbox token's life (spec §6.5). */
  capped?: boolean;
  /** Every lease event the Exec's response carried, in order (spec §5); empty without a lease. */
  lease: LeaseEvent[];
}

/**
 * What went wrong, when it was not the command:
 * - `machinery`: VM boot, worker gone, a dropped connection, any other ExecError or non-OK status;
 * - `busy`: the relay's per-sandbox in-flight cap (RESOURCE_EXHAUSTED "sandbox busy"). Nothing ran;
 * - `template_busy`: the template's shared worker is saturated (`busy: queue full`, `memory-budget:`
 *   or `max-runs:`). Nothing ran;
 * - `token_expired`: the relay cancelled the Exec at its token's `exp` (DEADLINE_EXCEEDED);
 * - `expiring`: the sandbox itself ends too soon for a command to run (its token, capped at the
 *   sandbox's `expiresAt`, has no more than the 60 s margin left), or even a freshly asked-for
 *   token has no more than that margin left by this machine's clock. Nothing ran.
 */
export type ExecFailureKind = 'machinery' | 'busy' | 'template_busy' | 'token_expired' | 'expiring';

/**
 * The machinery failed: NOT the command's outcome. `kind` says how (see `ExecFailureKind`).
 * `mayHaveRun` is set when the failure came after the command may have started: output had
 * arrived, the worker reported a failure of an Exec it had accepted (any in-stream ExecError but
 * its known refusals before the start, e.g. the relay's `worker disconnected`), or the connection
 * was lost (UNAVAILABLE, the client's backstop, a stream ended without its End) after the Exec went
 * out. A refusal, or a worker refusal before the start (a VM that could not be restored, a bad
 * workspace key, no live worker), leaves it false.
 */
export class ExecMachineryError extends Error {
  /**
   * The lease events the failed Exec's response carried before it failed, in order: the worker
   * sends them before an error too (`lease_ended(<reason>)`, `stale_mode`), so a client learns of a
   * lease end even when that Exec failed (spec §5).
   */
  lease: LeaseEvent[] = [];

  constructor(
    message: string,
    readonly grpcCode?: number,
    readonly kind: ExecFailureKind = 'machinery',
    readonly mayHaveRun = false,
    /** The relay's or worker's own text, when the failure carried one: what wire strings match. */
    readonly wire?: string,
  ) {
    super(message);
    this.name = 'ExecMachineryError';
  }
}

/**
 * The relay refused the call (token, worker, workspace) after the one permitted refresh. `lease`
 * holds the events a first attempt refused as `stale_mode:` carried, before the retry's own
 * refusal: the worker acked them, so they are said nowhere else (spec §5).
 */
export class ExecRefusedError extends Error {
  constructor(
    message: string,
    readonly grpcCode: number,
    public lease: LeaseEvent[] = [],
  ) {
    super(message);
    this.name = 'ExecRefusedError';
  }
}

/**
 * The caller aborted the Exec (its `signal`): named `AbortError`, as an abort is, with the signal's
 * reason as its `cause`. `lease` holds the events the response carried before the abort: the
 * worker acks an event once it is queued, so a client that drops them never sees them again
 * (spec §5).
 */
export class ExecAbortedError extends Error {
  lease: LeaseEvent[] = [];

  constructor(readonly signal: AbortSignal) {
    super('the Exec was aborted', { cause: signal.reason });
    this.name = 'AbortError';
  }
}

/**
 * A process call the relay or the worker refused with one of its wire strings (spec §7): nothing
 * ran. `code` is the wire prefix: `processes_not_enabled` (the sandbox's mode is below
 * lease+processes), `process_not_found`, `process_limit`, `process_name_taken`, `process_cwd`,
 * `process_name_invalid`, `process_signal`, or `lease_unsupported` (the guest has no level 2).
 * `lease` holds the events the response carried, as ExecMachineryError's does.
 */
export class ProcessError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly wire: string,
    public lease: LeaseEvent[] = [],
  ) {
    super(wire || `${code}: ${detail}`);
    this.name = 'ProcessError';
  }
}

/** A process wire string: its code, then its detail. */
const PROCESS_WIRE = /^(process_[a-z_]+|processes_not_enabled|lease_unsupported):\s*([\s\S]*)$/;

export type ProcessOp = 'start' | 'list' | 'logs' | 'stop';
/** A process selected by id or by name; an id wins over an equal name (the guest's rule). */
export interface ProcessSelector {
  id?: string;
  name?: string;
}

/**
 * A process as a client is given it (P5-R6): `p<n>` (an id as clients show it) or a decimal `n` is
 * the id; anything else a name. No name is shaped like an id (P5-R33), so an id-shaped name can
 * only mean the id. Leading zeros are dropped (`p007` is id `7`): the guest compares id strings.
 * The MCP tools and `mocactl sbx proc` both read their selector through this.
 */
export function processSelector(given: string): ProcessSelector {
  const m = /^p?(\d+)$/.exec(given);
  return m ? { id: m[1]!.replace(/^0+(?=\d)/, '') } : { name: given };
}

const PROCESS_NAME_WANT = 'want 1-64 characters of [A-Za-z0-9._-], not shaped like an id (p<n>)';

/**
 * Why `name` is refused as a process name, as the guest's `process_name_invalid:` detail says it
 * (rulings P5-R8, P5-R33; guestagent validateProcessName): undefined when it is allowed. Clients
 * check it before sending, with the same text.
 */
export function processNameProblem(name: string): string | undefined {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(name) && !/^p?[0-9]+$/.test(name)) return undefined;
  const bytes = Buffer.byteLength(name);
  return bytes > 64
    ? `a name of ${bytes} bytes: ${PROCESS_NAME_WANT}`
    : `${JSON.stringify(name)}: ${PROCESS_NAME_WANT}`;
}

/** A process name refused before sending, as the guest would have refused it. */
export function processNameError(name: string): ProcessError | undefined {
  const d = processNameProblem(name);
  return d === undefined
    ? undefined
    : new ProcessError('process_name_invalid', d, `process_name_invalid: ${d}`);
}
export interface ProcessArgsByOp {
  /** `cwd` is inside the workspace (default /workspace); `name` is unique among running ones. */
  start: { command: string; name?: string; cwd?: string };
  list: Record<string, never>;
  /** `tail`: the last lines (default 200). */
  logs: ProcessSelector & { tail?: number };
  /** `signal`: default TERM; the cgroup is killed 10 s later. */
  stop: ProcessSelector & { signal?: string };
}
export interface ProcessStarted {
  id: string;
  name: string;
  pid: number;
}
export interface ProcessResultByOp {
  start: ProcessStarted;
  /** The table, oldest first, exited entries included. */
  list: TrackedProcessView[];
  /** The last lines of combined stdout and stderr. */
  logs: string;
  /** The final state. */
  stop: TrackedProcessView;
}
/** A process call's answer, and the lease events its response carried (spec §5). */
export interface ProcessOutcome<T> {
  result: T;
  lease: LeaseEvent[];
}
export interface ProcessCallOptions {
  signal?: AbortSignal;
  /** Seconds (default 60): short, so the call fits the token already held. */
  timeoutS?: number;
}
export type ProcessCall = <O extends ProcessOp>(
  op: O,
  args: ProcessArgsByOp[O],
  opts?: ProcessCallOptions,
) => Promise<ProcessOutcome<ProcessResultByOp[O]>>;

/** A process call's default timeout; the worker raises it to its own floor (30 s) if need be. */
export const PROCESS_TIMEOUT_S = 60;
const PROCESS_KINDS: Record<ProcessOp, ExecKind> = {
  start: ExecKind.EXEC_KIND_PROCESS_START,
  list: ExecKind.EXEC_KIND_PROCESS_LIST,
  logs: ExecKind.EXEC_KIND_PROCESS_LOGS,
  stop: ExecKind.EXEC_KIND_PROCESS_STOP,
};

/** What an Exec asks of the worker beyond its command: its kind and process arguments. */
interface ExecKindArgs {
  kind: ExecKind;
  process?: ProcessArgs;
}
const COMMAND: ExecKindArgs = { kind: ExecKind.EXEC_KIND_COMMAND };

/** One row of the guest's tracked table, as its JSON has it (guestagent.TrackedProcess). */
function rowView(x: unknown, nowMs: number): TrackedProcessView | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  const r = x as Record<string, unknown>;
  const { id, name, pid, state, code } = r;
  const started = r.started_unix_ms;
  const memory = r.memory_bytes;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof pid !== 'number' ||
    typeof state !== 'string' ||
    typeof code !== 'number' ||
    typeof started !== 'number' ||
    typeof memory !== 'number'
  ) {
    return undefined;
  }
  // Ages by this clock: the guest's is set from the host's at each Exec.
  return { id, name, pid, state, code, ageMs: Math.max(0, nowMs - started), memoryBytes: memory };
}

/** The guest's answer to `op`, from its stdout; undefined when it is not what `op` answers. */
function parseProcessAnswer(op: ProcessOp, stdout: string, nowMs: number): unknown {
  if (op === 'logs') return stdout;
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (op === 'list') {
    if (!Array.isArray(v)) return undefined;
    const rows = v.map((x) => rowView(x, nowMs));
    return rows.every((x) => x !== undefined) ? rows : undefined;
  }
  if (op === 'stop') return rowView(v, nowMs);
  const r = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<
    string,
    unknown
  >;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.pid === 'number'
    ? { id: r.id, name: r.name, pid: r.pid }
    : undefined;
}

/** What the connection asks of its token source before an Exec. */
export interface TokenRequest {
  /** Mint a new token even if the held one is still valid (after an UNAUTHENTICATED). */
  force: boolean;
  /**
   * The token must have at least this many seconds left, or the source mints a new one. It is
   * `timeoutS + 60`, so for a defaulted timeout it equals the token's whole lifetime: such an Exec
   * gets a token minted for it. The connection's first ask is 60, to learn the lifetime.
   */
  minValidS: number;
}

export interface SandboxTokenGrant {
  token: string;
  /** The token's `exp`, in epoch seconds; 0 if it cannot be read. */
  expiresAt: number;
  /** The token's `exp − iat` in seconds; 0 if it cannot be read. */
  lifetimeS: number;
}

export type TokenFn = (o: TokenRequest) => Promise<SandboxTokenGrant>;

export interface ExecConnOptions {
  addr: string;
  tls: boolean;
  /** PEM of a self-issued exec certificate, trusted IN ADDITION to the system roots. */
  caPem?: string;
  sandboxId: string;
  workspaceKey: string;
  token: TokenFn;
  keepaliveMs?: number;
  /**
   * Seconds beyond `timeout_s` before the client gives up on an unanswered Exec (default 90): a
   * backstop for a relay or connection that goes silent without closing. Lowered only by tests.
   */
  backstopMarginS?: number;
  /**
   * The sandbox's own `expiresAt` (epoch s), if known. The control plane caps every token's `exp`
   * at it, so a token ending there is short because the sandbox is ending, not because the
   * deployment's lifetime is: it is run with a cut timeout, and refused as "the sandbox expires in
   * N s" (kind `expiring`) only when nothing can run (final review M1).
   */
  sandboxExpiresAt?: number;
  /** The clock, in epoch milliseconds (tests). */
  now?: () => number;
  /**
   * Sets `Exec.keepalive` (default false): the client's opt-in to the lease's keepalive-loss rule
   * (spec §4), for a client that sends `leaseKeepalive()` every 30 s. A function is read at each
   * Exec, after its token, so the flag can follow the mode of each re-minted token (P4-R6).
   */
  keepalive?: boolean | (() => boolean);
}

export interface ExecOptions {
  stdin?: Uint8Array;
  /**
   * Seconds. Defaults to, and is capped at, the token lifetime minus 60 s (120 s when the lifetime
   * cannot be read), and is cut further to what the token has left, minus 60 s.
   */
  timeoutS?: number;
  signal?: AbortSignal;
}

export type Exec = (command: string, opts?: ExecOptions) => Promise<ExecResult>;

const MAX_MESSAGE = 16 * 1024 * 1024;
export const CLIENT_CHANNEL_OPTIONS: Record<string, number> = {
  'grpc.max_receive_message_length': MAX_MESSAGE,
  'grpc.max_send_message_length': MAX_MESSAGE,
  'grpc.keepalive_time_ms': 20_000,
  'grpc.keepalive_timeout_ms': 10_000,
  'grpc.keepalive_permit_without_calls': 1,
};

/**
 * Seconds of token life kept spare beyond an Exec's timeout, so the worker's own timeout fires
 * before the relay cancels the Exec at the token's `exp` (spec §3.6, §6.5).
 */
export const TOKEN_MARGIN_S = 60;
/** The timeout when the token's lifetime cannot be read. */
const FALLBACK_TIMEOUT_S = 120;
/** A token lifetime must leave at least this much timeout after the margin: 121 s gives 61 s. */
const MIN_LIFETIME_S = 2 * TOKEN_MARGIN_S + 1;
/** The client-side backstop deadline is `timeout_s` plus this (spec §6.5: never wait forever). */
const BACKSTOP_MARGIN_S = 90;
/**
 * The client-side backstops of the lease calls: the relay's own timeouts (spec §8.3: 15 s for
 * status, 31 min for reset, set_mode and sandbox_deleted) plus a margin, so the relay's answer
 * comes first. A keepalive is answered at once.
 */
const LEASE_STATUS_BACKSTOP_MS = 30_000;
const LEASE_MUTATE_BACKSTOP_MS = 32 * 60_000;
const LEASE_KEEPALIVE_BACKSTOP_MS = 15_000;
const LEASE_OPS = {
  status: LeaseOp.LEASE_OP_STATUS,
  reset: LeaseOp.LEASE_OP_RESET,
  set_mode: LeaseOp.LEASE_OP_SET_MODE,
  sandbox_deleted: LeaseOp.LEASE_OP_SANDBOX_DELETED,
} as const;
export type LeaseOpName = keyof typeof LEASE_OPS;

/** The worker's ExecError for a command that ran out of `timeout_s`. */
const TIMEOUT_MESSAGE = /^timeout:(\d+)$/;
/** The worker's refusals when the template's shared worker is saturated (spec §6.4). */
const TEMPLATE_BUSY = /^(?:busy: queue full|memory-budget:|max-runs:)/;
/**
 * The worker's ExecErrors that it sends BEFORE the command starts (remote-worker: vmpool's
 * refusals and key checks, the container tier's workspace and spawn failures, the session's req_id
 * collision). Every other ExecError comes from an Exec the worker ACCEPTED -- which is as precise as
 * the wire allows, since there is no "started" frame: the relay's own `worker disconnected`, a guest
 * that closed before End, a wait failure. Those may have run part of the command.
 */
const NOT_STARTED =
  /^(?:invalid-workspace-key:|empty-workspace-key:|spawn-failure:|req_id collision:|workspace \/|start bash:|stdin pipe:|stdout pipe:|stderr pipe:|vmpool: closed|vmpool: popped VM is bound|remote-worker is unix-only|stale_mode:|lease_unsupported:)/;

/** Random, unique per call, and below 2^53: the relay decodes the uint64 as a JavaScript number. */
export function newReqId(): number {
  return Number(randomBytes(8).readBigUInt64BE() >> 11n);
}

/** The worker's refusal of an Exec whose token's mode epoch is below the stored one (spec §8.2). */
const STALE_MODE = /^stale_mode:/;
/** The relay's refusal of a process kind under a token whose mode is below lease+processes. */
const PROCESSES_NOT_ENABLED = /^processes_not_enabled:/;

class NotStarted extends Error {}

/**
 * A refusal that a token minted now may not get: the worker's `stale_mode:` or the relay's
 * `processes_not_enabled:`. Nothing ran. `surfaced` is the error a second one is reported as.
 */
class Remint extends Error {
  constructor(
    readonly surfaced: ExecMachineryError,
    readonly refusal: 'stale_mode' | 'processes_not_enabled',
  ) {
    super(surfaced.message);
  }
}

/**
 * The lease events an Exec's failure carries (spec §5): its `lease` array, whichever error it is.
 * The connection attaches the events of a refused first attempt even to a token source's own
 * error when the re-mint fails, as the worker acked them.
 */
export function leaseEventsOf(err: unknown): LeaseEvent[] {
  const lease = typeof err === 'object' && err !== null ? (err as { lease?: unknown }).lease : [];
  return Array.isArray(lease) ? (lease as LeaseEvent[]) : [];
}

/** Where the trusted roots come from: `node:tls`, or a fake in tests. */
export interface RootSource {
  getCACertificates?: (type: 'default') => string[];
  rootCertificates: readonly string[];
}

/**
 * The CA bundle for a self-issued exec certificate: Node's default roots, then the extra PEM. The
 * default roots are `tls.getCACertificates('default')` where it exists (Node >= 22.15), which also
 * carries NODE_EXTRA_CA_CERTS and, under --use-system-ca, the OS store. Older Nodes fall back to
 * the bundled `tls.rootCertificates`. grpc-js REPLACES the roots with whatever it is given, so the
 * defaults must be in the bundle or a relay behind a public certificate would stop verifying.
 */
export function caBundle(extraPem: string, source: RootSource = tls): Buffer {
  const roots =
    typeof source.getCACertificates === 'function'
      ? source.getCACertificates('default')
      : source.rootCertificates;
  return Buffer.from([...roots, extraPem].join('\n'));
}

export class SandboxExecConn {
  private readonly client: SandboxExecClient;
  private readonly now: () => number;
  /** The last readable token lifetime, so later Execs ask for exactly the life they need. */
  private lifetimeS = 0;

  constructor(private readonly o: ExecConnOptions) {
    const creds = o.tls
      ? credentials.createSsl(o.caPem ? caBundle(o.caPem) : null)
      : credentials.createInsecure();
    this.client = new SandboxExecClient(o.addr, creds, {
      ...CLIENT_CHANNEL_OPTIONS,
      ...(o.keepaliveMs ? { 'grpc.keepalive_time_ms': o.keepaliveMs } : {}),
    });
    this.now = o.now ?? Date.now;
  }

  exec: Exec = (command, opts = {}) => this.send(command, opts, COMMAND);

  /**
   * One process call (spec §7): an Exec of the op's kind, under `exec`'s retries (the token
   * refusal, the stale_mode re-mint). It answers the guest's result, parsed, with the lease events
   * its response carried. A refusal with a process wire string is a ProcessError; an answer that
   * is not what the op answers, a timeout or a non-zero exit is an ExecMachineryError.
   */
  process: ProcessCall = async (op, args, opts = {}) => {
    const a = args as ProcessSelector & {
      command?: string;
      cwd?: string;
      tail?: number;
      signal?: string;
    };
    const kind: ExecKindArgs = {
      kind: PROCESS_KINDS[op],
      process: ProcessArgs.fromPartial({
        name: a.name ?? '',
        id: a.id ?? '',
        cwd: a.cwd ?? '',
        tail: a.tail ?? 0,
        signal: a.signal ?? '',
      }),
    };
    let r: ExecResult;
    try {
      r = await this.send(
        op === 'start' ? (a.command ?? '') : '',
        { timeoutS: opts.timeoutS ?? PROCESS_TIMEOUT_S, signal: opts.signal },
        kind,
      );
    } catch (err) {
      const wire = err instanceof ExecMachineryError ? err.wire : undefined;
      const m = wire === undefined ? null : PROCESS_WIRE.exec(wire);
      if (m) throw new ProcessError(m[1]!, m[2]!, wire!, (err as ExecMachineryError).lease);
      throw err;
    }
    const what = `process_${op}`;
    // start and stop act on the guest: a bad answer does not mean nothing happened.
    const acted = op === 'start' || op === 'stop';
    const bad = (why: string) => {
      const e = new ExecMachineryError(`sandbox failure: ${why}`, undefined, 'machinery', acted);
      e.lease = r.lease;
      return e;
    };
    // A process kind is quick in the guest (a stop takes ~10 s at most, well inside the budget),
    // but it queues on the sandbox's one run gate, and the wait counts: a timeout means another
    // command held the sandbox (final review M4).
    if (r.timedOutS !== undefined) {
      throw bad(`${what} timed out waiting for the sandbox (another command may still be running)`);
    }
    if (r.exitCode !== 0) throw bad(`${what} answered exit ${r.exitCode}`);
    const out = r.stdout.toString();
    const result = parseProcessAnswer(op, out, this.now());
    if (result === undefined) {
      const shown = out.length > 200 ? `${out.slice(0, 200)}…` : out;
      throw bad(`unreadable ${what} answer: ${JSON.stringify(shown)}`);
    }
    return { result: result as ProcessResultByOp[typeof op], lease: r.lease };
  };

  /** An Exec of `kind` under the retry rules (see the top of the file). */
  private send = async (
    command: string,
    opts: ExecOptions,
    kind: ExecKindArgs,
  ): Promise<ExecResult> => {
    const requested = opts.timeoutS;
    if (requested !== undefined && !(Number.isFinite(requested) && requested > 0)) {
      throw new RangeError(`timeoutS must be a positive number of seconds, got ${requested}`);
    }
    if (opts.signal?.aborted) throw new ExecAbortedError(opts.signal);
    const want = requested === undefined ? undefined : Math.ceil(requested);
    // Unique within the sandbox: the relay namespaces it per sandbox.
    let reqId = newReqId();
    const attempt = async (force: boolean) => {
      const { grant, timeoutS, capped } = await this.prepare(want, force);
      const r = await this.once(command, opts, reqId, timeoutS, grant.token, kind);
      return capped ? { ...r, capped: true } : r;
    };
    /** The lease events of a stale_mode refusal, which ride before the retry's own. */
    let carried: LeaseEvent[] = [];
    let reminted: Remint['refusal'] | undefined;
    try {
      return await attempt(false);
    } catch (err) {
      if (err instanceof Remint) {
        // The token predates a mode change (P4-R21, P5-R29): refused before the start. The
        // retry's token carries the new epoch, which the worker's req_id cache fingerprints, so
        // the same id would read there as a collision: it is a different Exec, under a new id.
        carried = err.surfaced.lease;
        reminted = err.refusal;
        reqId = newReqId();
      } else if (!(err instanceof NotStarted)) throw err;
    }
    // The token was refused before anything ran (the relay refuses before routing, the worker's
    // stale_mode before the start): refresh once and retry. The fresh token is fitted by the same
    // freshness rules, as it may be shorter than the first (one minted near the sandbox's expiry).
    try {
      const r = await attempt(true);
      return carried.length > 0 ? { ...r, lease: [...carried, ...r.lease] } : r;
    } catch (err) {
      if (err instanceof NotStarted) {
        // The retry after a stale_mode refusal was a re-mint for the new epoch, not a refresh.
        const after = reminted
          ? `after a ${reminted} refusal and a fresh token`
          : 'after one token refresh';
        throw new ExecRefusedError(`${err.message} (${after})`, status.UNAUTHENTICATED, carried);
      }
      const e = err instanceof Remint ? err.surfaced : err;
      // The first attempt's events ride whatever the retry failed with: the worker acked them.
      if (
        e instanceof ExecMachineryError ||
        e instanceof ExecAbortedError ||
        e instanceof ExecRefusedError
      ) {
        e.lease = [...carried, ...e.lease];
      } else if (carried.length > 0 && typeof e === 'object' && e !== null) {
        // The re-mint itself failed (the token source's error): it still carries them, unchanged
        // otherwise, so its callers read it as before (Minor 1).
        try {
          Object.assign(e, { lease: [...carried, ...leaseEventsOf(e)] });
        } catch {
          // A frozen error cannot carry them: nothing else to do.
        }
      }
      throw e;
    }
  };

  close = (): void => {
    this.client.close();
  };

  /**
   * One lease operation on this sandbox's lease (spec §8.3), under the sandbox token as an Exec.
   * `setModeToken` is sent with `set_mode` only. A failure is a LeaseControlError, after the one
   * token-refusal retry (see the top of the file); a token source failure propagates unchanged.
   * An abort of `signal` cancels the call (a set_mode or reset may wait up to 31 min): it rejects
   * with a LeaseControlError `cancelled`, and one already aborted sends nothing (P4-R12).
   */
  leaseControl = async (
    op: LeaseOpName,
    setModeToken?: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LeaseStatusView> => {
    const req = LeaseControlRequest.fromPartial({
      sandboxId: this.o.sandboxId,
      op: LEASE_OPS[op],
      setModeToken: op === 'set_mode' ? (setModeToken ?? '') : '',
    });
    const backstopMs = op === 'status' ? LEASE_STATUS_BACKSTOP_MS : LEASE_MUTATE_BACKSTOP_MS;
    const { signal } = opts;
    const res = await this.leaseCall(
      (md) =>
        new Promise<LeaseControlResponse>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new LeaseControlError('cancelled', 'the lease call was cancelled'));
            return;
          }
          const call = this.client.leaseControl(
            req,
            md,
            { deadline: Date.now() + backstopMs },
            (e, r) => {
              signal?.removeEventListener('abort', cancel);
              if (e) reject(LeaseControlError.fromStatus(e.code, e.details || e.message));
              else resolve(r);
            },
          );
          // The cancel ends the call with CANCELLED, which the callback maps to `cancelled`.
          const cancel = () => call.cancel();
          signal?.addEventListener('abort', cancel, { once: true });
        }),
    );
    return leaseStatusView(res.status);
  };

  /** Records harness liveness for a live lease (spec §4, §8.3); the relay answers OK at once. */
  leaseKeepalive = async (): Promise<void> => {
    const req = LeaseKeepaliveRequest.fromPartial({ sandboxId: this.o.sandboxId });
    await this.leaseCall(
      (md) =>
        new Promise<void>((resolve, reject) =>
          this.client.leaseKeepalive(
            req,
            md,
            { deadline: Date.now() + LEASE_KEEPALIVE_BACKSTOP_MS },
            (e) =>
              e ? reject(LeaseControlError.fromStatus(e.code, e.details || e.message)) : resolve(),
          ),
        ),
    );
  };

  /**
   * Sends a lease call under the sandbox token; on a token refusal, once more under a forced fresh
   * token (P4-R7). The ask is an Exec's first: the token must have the 60 s margin left. The first
   * mint is outside the retry: only the relay's refusal is retried, never a token source failure.
   */
  private async leaseCall<T>(send: (md: Metadata) => Promise<T>): Promise<T> {
    const bearer = async (force: boolean) => {
      const { token } = await this.o.token({ force, minValidS: TOKEN_MARGIN_S });
      const md = new Metadata();
      md.set('authorization', `Bearer ${token}`);
      return md;
    };
    const md = await bearer(false);
    try {
      return await send(md);
    } catch (err) {
      if (!(err instanceof LeaseControlError && err.code === 'unauthenticated')) throw err;
    }
    return send(await bearer(true));
  }

  private learn(g: SandboxTokenGrant): void {
    if (g.lifetimeS <= 0) return;
    const end = this.o.sandboxExpiresAt;
    if (end && end > 0 && g.expiresAt > 0 && g.expiresAt >= end) {
      // Cut short by the sandbox's own expiry: not the deployment's lifetime, so nothing is
      // learnt from it. `prepare` cuts the timeout to what is left, while a command can still run.
      const leftS = Math.max(0, Math.ceil(end - this.now() / 1000));
      if (leftS <= TOKEN_MARGIN_S) {
        throw new ExecMachineryError(
          `the sandbox expires in ${leftS} s; pull your work now: \`mocactl sbx pull --apply\``,
          undefined,
          'expiring',
        );
      }
      return;
    }
    if (g.lifetimeS < MIN_LIFETIME_S) {
      // Lifetime minus the 60 s margin would leave a timeout of a minute or less, cut to 1 s at
      // worst: fail loudly instead of running every command under a uselessly short timeout.
      throw new ExecMachineryError(
        `sandbox token lifetime ${g.lifetimeS}s is too short (minimum ${MIN_LIFETIME_S}s)`,
      );
    }
    this.lifetimeS = g.lifetimeS;
  }

  /** Seconds the grant has left by this machine's clock; undefined if its expiry is unreadable. */
  private left(g: SandboxTokenGrant): number | undefined {
    return g.expiresAt > 0 ? g.expiresAt - this.now() / 1000 : undefined;
  }

  /**
   * Token freshness (spec §6.5): the token to send, the timeout to send, and whether the timeout
   * was cut. `timeout_s` defaults to, and is capped at, the token lifetime minus 60 s, and the token
   * must have the timeout plus 60 s left, or the relay would cancel the Exec at `exp`. `force` is
   * the one retry after UNAUTHENTICATED: a fresh token, fitted the same way.
   */
  private async prepare(requested: number | undefined, force = false) {
    const ask = async (f: boolean, minValidS: number) => {
      const g = await this.o.token({ force: f, minValidS });
      this.learn(g);
      return g;
    };
    let grant: SandboxTokenGrant;
    if (this.lifetimeS || force) {
      grant = await ask(force, this.timeoutFor(requested).timeoutS + TOKEN_MARGIN_S);
    } else {
      // The lifetime is learnt from the first token; then ask once more only if it falls short.
      grant = await ask(false, TOKEN_MARGIN_S);
      const want = this.timeoutFor(requested).timeoutS + TOKEN_MARGIN_S;
      // ceil, as below: a token minted within the last second is as fresh as one can be.
      const left = this.left(grant);
      if (left !== undefined && Math.ceil(left) < want) grant = await ask(false, want);
    }
    let t = this.timeoutFor(requested);
    // Even a fresh token may not cover it: one minted near the sandbox's expiry is shorter, and
    // clocks differ. Then the timeout is cut to what the token has left, less 60 s, and the
    // result says so -- a defaulted timeout included, since it was cut below the default.
    const left = this.left(grant);
    if (left !== undefined && t.timeoutS + TOKEN_MARGIN_S > left) {
      // ceil: a token minted this instant keeps its full cap.
      const cut = Math.ceil(left) - TOKEN_MARGIN_S;
      if (cut < 1) {
        // Even the token just asked for (a fresh mint, if the held one fell short) has no more
        // than the margin left: clock skew, or an exp all but here. A 1 s timeout would only
        // report a timeout that is not the command's, so refuse it before sending anything.
        throw new ExecMachineryError(
          `the sandbox token has ${Math.max(0, Math.ceil(left))} s left, no more than the ` +
            `${TOKEN_MARGIN_S} s margin a command needs; nothing ran. Check this machine's clock, ` +
            'or the sandbox may be about to expire: `mocactl sbx pull --apply`',
          undefined,
          'expiring',
        );
      }
      if (cut < t.timeoutS) t = { timeoutS: cut, capped: true };
    }
    return { grant, ...t };
  }

  /** The timeout for the lifetime known so far: the default, or the request capped to it. */
  private timeoutFor(requested: number | undefined): { timeoutS: number; capped: boolean } {
    const life = this.lifetimeS;
    if (!life) return { timeoutS: requested ?? FALLBACK_TIMEOUT_S, capped: false };
    const cap = life - TOKEN_MARGIN_S;
    return requested === undefined
      ? { timeoutS: cap, capped: false }
      : { timeoutS: Math.min(requested, cap), capped: requested > cap };
  }

  private once(
    command: string,
    opts: ExecOptions,
    reqId: number,
    timeoutS: number,
    token: string,
    kind: ExecKindArgs,
  ): Promise<ExecResult> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(new ExecAbortedError(signal));
    const md = new Metadata();
    md.set('authorization', `Bearer ${token}`);
    const backstopS = timeoutS + (this.o.backstopMarginS ?? BACKSTOP_MARGIN_S);
    const call = this.client.exec(
      {
        sandboxId: this.o.sandboxId,
        // A sandbox caller names no workload: the relay refuses it on a workload sandbox (§3.3).
        workload: '',
        exec: ExecMessage.fromPartial({
          reqId,
          command,
          stdin: opts.stdin ? new Uint8Array(opts.stdin) : new Uint8Array(),
          timeoutS,
          streaming: true,
          workspaceKey: this.o.workspaceKey,
          keepalive:
            typeof this.o.keepalive === 'function'
              ? this.o.keepalive()
              : (this.o.keepalive ?? false),
          kind: kind.kind,
          ...(kind.process ? { process: kind.process } : {}),
        }),
      },
      md,
      // Real wall time, not `now`: grpc-js measures the deadline against the system clock.
      { deadline: Date.now() + backstopS * 1000 },
    );
    // A call can report both 'error' and 'end' on some grpc-js paths; a settled promise ignores
    // the second, so both handlers only resolve or reject.
    return new Promise<ExecResult>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const lease: LeaseEvent[] = [];
      let started = false;
      /** A chunk arrived: the command was running (final review M2). */
      let output = false;
      let aborted = false;
      let end: { exitCode: number; truncated: boolean } | undefined;
      let execError: string | undefined;
      const result = (r: {
        exitCode: number;
        truncated: boolean;
        timedOutS?: number;
      }): ExecResult => ({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        ...r,
        lease,
      });
      /** Rejects with `e`, carrying the lease events that arrived before the failure. */
      const fail = (e: Error) => {
        if (
          e instanceof ExecMachineryError ||
          e instanceof ExecAbortedError ||
          e instanceof ExecRefusedError
        ) {
          e.lease = lease;
        } else if (e instanceof Remint) e.surfaced.lease = lease;
        reject(e);
      };
      const onAbort = () => {
        aborted = true;
        // The relay also aborts at the worker when it sees the cancel; this says so explicitly.
        this.client.abort(
          { sandboxId: this.o.sandboxId, reqId },
          md,
          { deadline: Date.now() + 10_000 },
          () => {},
        );
        call.cancel();
        // The events that arrived before the abort ride the rejection (review #4569829023).
        fail(new ExecAbortedError(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => signal?.removeEventListener('abort', onAbort);

      /** A worker message (in-stream ExecError, or the status details) that is not a failure. */
      const outcomeOf = (message: string | undefined) => {
        const m = message === undefined ? null : TIMEOUT_MESSAGE.exec(message);
        return m ? result({ exitCode: -1, truncated: false, timedOutS: Number(m[1]) }) : undefined;
      };
      /**
       * `inStream`: the message arrived as an ExecError event, so the relay routed the Exec to a
       * worker. Unless it is one of the worker's refusals before the start (NOT_STARTED), the Exec
       * was accepted and may have run, output or not. A failure carried only by the status (no
       * event) may have run only if output arrived.
       */
      const workerFailure = (message: string, code?: number, inStream = false) =>
        TEMPLATE_BUSY.test(message)
          ? new ExecMachineryError(
              `template busy: ${message}`,
              code,
              'template_busy',
              false,
              message,
            )
          : new ExecMachineryError(
              `sandbox failure: ${message || 'exec failed'}`,
              code,
              'machinery',
              output || (inStream && !NOT_STARTED.test(message)),
              message,
            );
      /** The worker's in-stream ExecError: a stale_mode refusal before any output is retried. */
      const inStreamFailure = (message: string, code?: number): Error => {
        const e = workerFailure(message, code, true);
        return !output && STALE_MODE.test(message) ? new Remint(e, 'stale_mode') : e;
      };

      call.on('data', (ev: ExecEvent) => {
        started = true;
        if (ev.chunk) {
          output = true;
          (ev.chunk.stream === Stream.STREAM_STDERR ? err : out).push(Buffer.from(ev.chunk.data));
        } else if (ev.end) {
          end = { exitCode: ev.end.exitCode, truncated: ev.end.truncated };
        } else if (ev.error) {
          execError = ev.error.message ?? '';
        } else if (ev.lease) {
          lease.push(ev.lease);
        }
      });
      call.on('error', (e: ServiceError) => {
        done();
        if (aborted) return;
        // The command's outcome arrived; whatever the status says after it is not the command's.
        if (end) return resolve(result(end));
        const details = e.details || e.message;
        const outcome = outcomeOf(execError ?? details);
        if (outcome) return resolve(outcome);
        if (execError !== undefined) return fail(inStreamFailure(execError, e.code));
        if (!started && e.code === status.UNAUTHENTICATED) return fail(new NotStarted(details));
        if (!started && e.code === status.PERMISSION_DENIED) {
          return fail(new ExecRefusedError(details, e.code));
        }
        if (
          !started &&
          e.code === status.FAILED_PRECONDITION &&
          PROCESSES_NOT_ENABLED.test(details)
        ) {
          // The relay read the held token's mode claim before routing: nothing ran (P5-R29).
          const refused = new ExecMachineryError(
            `sandbox failure: ${status[e.code]}: ${details}`,
            e.code,
            'machinery',
            false,
            details,
          );
          return fail(new Remint(refused, 'processes_not_enabled'));
        }
        // Only the relay's "sandbox busy" is busy: grpc-js message-size limits are RESOURCE_EXHAUSTED too.
        if (e.code === status.RESOURCE_EXHAUSTED && details.startsWith('sandbox busy')) {
          return fail(new ExecMachineryError(details, e.code, 'busy'));
        }
        if (
          e.code === status.DEADLINE_EXCEEDED &&
          details.startsWith('sandbox token expired during the Exec')
        ) {
          return fail(
            new ExecMachineryError(
              `${details}: the command outlived its sandbox token and was cancelled`,
              e.code,
              'token_expired',
            ),
          );
        }
        if (e.code === status.DEADLINE_EXCEEDED) {
          // Not the relay's token expiry (matched by its text above): this client's own deadline.
          return fail(
            new ExecMachineryError(
              `sandbox failure: no answer within ${backstopS}s, the client-side backstop deadline ` +
                `(timeout_s ${timeoutS} + ${backstopS - timeoutS}s): ${details}`,
              e.code,
              'machinery',
              true, // it went out, and may be running still
            ),
          );
        }
        if (TEMPLATE_BUSY.test(details)) return fail(workerFailure(details, e.code));
        fail(
          new ExecMachineryError(
            `sandbox failure: ${status[e.code] ?? e.code}: ${details}`,
            e.code,
            'machinery',
            output || e.code === status.UNAVAILABLE, // UNAVAILABLE: the connection was lost
            details, // the relay's refusal, e.g. FAILED_PRECONDITION processes_not_enabled: …
          ),
        );
      });
      call.on('end', () => {
        done();
        if (aborted) return;
        if (end) return resolve(result(end));
        const outcome = outcomeOf(execError);
        if (outcome) return resolve(outcome);
        if (execError !== undefined) return fail(inStreamFailure(execError));
        fail(
          new ExecMachineryError(
            'sandbox failure: the exec stream ended without an End event',
            undefined,
            'machinery',
            true,
          ),
        );
      });
    });
  }
}
