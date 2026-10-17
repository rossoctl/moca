import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Server,
  ServerCredentials,
  status,
  type ChannelOptions,
  type Metadata,
  type ServerDuplexStream,
  type ServerWritableStream,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import {
  SandboxWorkerService,
  SandboxExecService,
  type SandboxWorkerServer,
  type SandboxExecServer,
  type WorkerFrame,
  type ServerFrame,
  type Exec,
  type ExecRequest,
  type ExecEvent,
  type AbortRequest,
  type AbortResponse,
  MAX_EXEC_MESSAGE_BYTES,
} from '@moca/k8s-sandbox';
import { RedisRecordStore, affinityTimings } from '@moca/harness';
import { SANDBOX_CLOCK_LEEWAY_S, type SandboxTokenClaims } from '@moca/control-plane';
import {
  createRelay,
  type Relay,
  type RelayDeps,
  type AttachStream,
  type DetachMarks,
  type RelayTimers,
} from './relay.js';
import {
  DEFAULT_SANDBOX_MAX_INFLIGHT,
  makeSandboxTokenVerifier,
  sandboxMaxInflight,
  workerReqId,
  type SandboxVerifier,
} from './sandbox-auth.js';

/**
 * Ends a server-streaming exec call with a non-OK status.
 *
 * `call.destroy(err)` does NOT do that, which is the trap this helper exists to name. On
 * @grpc/grpc-js 1.14.4 a `ServerWritableStream` sends its status from `_final` (which calls
 * `call.sendStatus`), and Node's `Writable` never reaches `_final` once `destroyed` is set:
 * `end()` short-circuits with ERR_STREAM_DESTROYED. Destroying therefore sends no trailers
 * at all -- verified against a real client, which sat for 12s with no status, no `end` and
 * no `error`. A hang is strictly worse than the wrong-OK of #295, because an OK at least
 * lets the caller finish its request.
 *
 * Emitting 'error' is the supported path: grpc-js registers a listener in the stream's
 * constructor that runs the error through `serverErrorToStatus` and then ends the stream,
 * which is what actually puts a code on the wire. `serverErrorToStatus` takes a numeric
 * `code` and a string `details` when present, and otherwise reports UNKNOWN with `message`
 * as the details -- so a bare Error still terminates non-OK and still carries its reason.
 *
 * `main-exec-status.transport.test.ts` pins all of this over a real transport; a fake call
 * object cannot, because the status is produced by the transport rather than the handler.
 */
function failExecStream(call: ServerWritableStream<ExecRequest, ExecEvent>, err: Error): void {
  call.emit('error', err);
}

/**
 * The one constructor of a status-carrying error: grpc-js's `serverErrorToStatus` reads a numeric
 * `code` and a string `details`, so an error shaped like this terminates the call with exactly that
 * status. Every non-OK status this file sends is built here.
 */
export function grpcError(
  code: status,
  message: string,
): Error & { code: number; details: string } {
  const err = new Error(message) as Error & { code: number; details: string };
  err.code = code;
  err.details = message;
  return err;
}

/**
 * A worker-reported in-stream exec failure, shaped so grpc-js terminates the stream with
 * a non-OK status instead of OK. INTERNAL (not UNKNOWN) because the failure is server-side
 * and not the caller's fault: `ExecEvent.error` means the exec machinery itself failed,
 * whereas a command that merely exited non-zero comes back as `ExecEvent.end{exitCode}`.
 * The worker's message travels as the status details so the cause is not lost.
 */
function execStreamError(message: string): Error {
  return grpcError(status.INTERNAL, message);
}

/** Relay server dependencies: the relay's own, plus the SandboxExec caller checks (MI1 §5 R5, SBX0 §3). */
export interface RelayServerDeps extends RelayDeps {
  validateExecToken: (presented: string | undefined) => boolean;
  /** Sandbox tokens (SBX0 §3.2). Omitted: only the harness's exec token is accepted. */
  verifySandboxToken?: SandboxVerifier;
  /** In-flight Execs admitted per `sbx` (SBX0 §3.6). Defaults to 2. */
  sandboxMaxInflight?: number;
  /** Seconds past a token's `exp` at which its running Exec is cancelled. Defaults to 30; tests set 0. */
  sandboxLeewayS?: number;
  /** Where sandbox-caller refusal lines go (SBX0 §3.5). Defaults to stdout. */
  log?: (line: string) => void;
}

/**
 * Reserved sandbox ID names (configuration keys, not sandboxes). These must be excluded from both
 * the directory lookup and the env-var fallback to prevent them being used as actual sandbox tokens.
 * For example, 'DIR' must not resolve to SH_RELAY_TOKEN_DIR.
 */
const RESERVED_SANDBOX_IDS = new Set(['DIR']);

/**
 * The SandboxExec caller check. FAIL-CLOSED: with no MOCA_RELAY_EXEC_TOKEN there is no valid caller,
 * so building the validator throws and the relay does not boot. The token is the WORKERS' credential
 * and must be distinct from every sandbox's SH_RELAY_TOKEN[_<id>] (spec R5): a relay configured with
 * an exec token equal to any of them also refuses to boot, and the error names the variables, never
 * the value. Constant-time, length-checked first.
 */
export function makeExecTokenValidator(
  env: NodeJS.ProcessEnv,
): (presented: string | undefined) => boolean {
  const expected = env.MOCA_RELAY_EXEC_TOKEN;
  if (!expected) {
    throw new Error(
      'MOCA_RELAY_EXEC_TOKEN is required: the relay refuses unauthenticated SandboxExec',
    );
  }
  const clashes = Object.keys(env)
    .filter((k) => {
      if (k === 'SH_RELAY_TOKEN') return env[k] === expected;
      if (!k.startsWith('SH_RELAY_TOKEN_')) return false;
      const suffix = k.slice('SH_RELAY_TOKEN_'.length);
      if (RESERVED_SANDBOX_IDS.has(suffix)) return false;
      return env[k] === expected;
    })
    .sort();
  if (clashes.length > 0) {
    throw new Error(
      `MOCA_RELAY_EXEC_TOKEN must differ from every sandbox token, but equals ${clashes.join(', ')}`,
    );
  }
  const want = Buffer.from(expected);
  return (presented) => {
    if (!presented) return false;
    const got = Buffer.from(presented);
    return got.length === want.length && timingSafeEqual(got, want);
  };
}

function bearerOf(md: Metadata): string | undefined {
  const v = md.get('authorization')[0];
  return typeof v === 'string' && v.startsWith('Bearer ') ? v.slice('Bearer '.length) : undefined;
}

function unauthenticated(): Error & { code: number; details: string } {
  // The message never contains the presented value.
  return grpcError(status.UNAUTHENTICATED, 'exec authentication failed');
}

/**
 * The boot rule (SBX0 §3.3). FAIL-CLOSED: the relay serves SandboxExec only if at least one caller
 * credential is configured -- the harness's MOCA_RELAY_EXEC_TOKEN, or the sandbox control plane's
 * public keys (with their issuer). With neither there is no valid caller, and the relay does not
 * boot. Each credential keeps its own boot checks: makeExecTokenValidator's clash rules, the
 * keyset's parse. SH_SANDBOX_MAX_INFLIGHT is checked here too, so a bad value fails the boot.
 */
export function makeExecAuth(
  env: NodeJS.ProcessEnv,
): Pick<RelayServerDeps, 'validateExecToken' | 'verifySandboxToken' | 'sandboxMaxInflight'> {
  const verifySandboxToken = makeSandboxTokenVerifier(env);
  const maxInflight = sandboxMaxInflight(env);
  if (!env.MOCA_RELAY_EXEC_TOKEN && !verifySandboxToken) {
    throw new Error(
      'MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS is required: the relay refuses unauthenticated SandboxExec',
    );
  }
  const validateExecToken = env.MOCA_RELAY_EXEC_TOKEN ? makeExecTokenValidator(env) : () => false;
  return {
    validateExecToken,
    ...(verifySandboxToken ? { verifySandboxToken, sandboxMaxInflight: maxInflight } : {}),
  };
}

type ExecAuth = Pick<
  RelayServerDeps,
  | 'validateExecToken'
  | 'verifySandboxToken'
  | 'sandboxMaxInflight'
  | 'sandboxLeewayS'
  | 'log'
  | 'timers'
>;

type ExecCaller =
  | { kind: 'harness' }
  | { kind: 'sandbox'; claims: SandboxTokenClaims }
  | { kind: 'none'; reason?: string };

/**
 * The caller classification (SBX0 §3.1), first match wins: the harness's exec token (unrestricted,
 * exactly as before), then a sandbox token, else nobody. `reason` is set only when a sandbox
 * verifier looked at the token, and is for the refusal log alone.
 */
function execCaller(md: Metadata, auth: ExecAuth): ExecCaller {
  const presented = bearerOf(md);
  if (auth.validateExecToken(presented)) return { kind: 'harness' };
  if (!auth.verifySandboxToken) return { kind: 'none' };
  const v = auth.verifySandboxToken(presented);
  return v.claims ? { kind: 'sandbox', claims: v.claims } : { kind: 'none', reason: v.reason };
}

/** setTimeout's delay is a signed 32-bit ms count; a longer one fires at once (Node clamps to 1). */
const MAX_TIMER_MS = 2 ** 31 - 1;

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

/**
 * Server-side keepalive (SBX0 §3.4). Some load balancers in front of a cluster router close a TCP
 * connection after a short idle period -- one was measured at 50 s -- so an Exec whose command prints
 * nothing would die mid-command. The relay pings every connection instead. These are the two
 * keepalive options grpc-js 1.14's server reads; it does not police client ping rates, so a client's
 * own pings are never refused.
 */
export interface Keepalive {
  timeMs: number;
  timeoutMs: number;
}
export const RELAY_KEEPALIVE = { timeMs: 20_000, timeoutMs: 10_000 } as const;

export function relayServerOptions(keepalive: Keepalive = RELAY_KEEPALIVE): ChannelOptions {
  return {
    // Raise the ingress limit above gRPC's 4 MiB default. This is the hop that rejects an
    // oversized write today: the harness's ExecRequest carries base64 stdin at 4/3 of the
    // file, so a file the read path can return (DEFAULT_OUTPUT_CAP, 8 MiB) needs ~10.7 MiB
    // here. MAX_EXEC_MESSAGE_BYTES is shared with the Go worker's session.MaxRecvMsgBytes
    // and pinned equal to it — a relay that accepts more than the worker would forward a
    // payload the worker refuses on its Attach stream, killing every exec on it (#173 item 2).
    'grpc.max_receive_message_length': MAX_EXEC_MESSAGE_BYTES,
    'grpc.keepalive_time_ms': keepalive.timeMs,
    'grpc.keepalive_timeout_ms': keepalive.timeoutMs,
  };
}

function newServer(keepalive?: Keepalive): Server {
  return new Server(relayServerOptions(keepalive));
}

function addWorkerService(server: Server, relay: ReturnType<typeof createRelay>): void {
  const workerImpl: SandboxWorkerServer = {
    // AttachStream types metadata.get() as returning string[]; grpc-js's real
    // Metadata.get() returns MetadataValue[] (string | Buffer). The relay only
    // ever reads a bearer token (always sent as a string by well-behaved
    // clients), so the cast is safe here without widening relay.ts's contract.
    attach: (call: ServerDuplexStream<WorkerFrame, ServerFrame>) =>
      relay.onAttach(call as unknown as AttachStream),
  };
  server.addService(SandboxWorkerService, workerImpl);
}

/** How a pumped Exec's events and failures reach its caller. The defaults are the harness's. */
interface PumpOpts {
  /** Rewrites each event before it is written (a sandbox caller's req_id; SBX0 §3.6). */
  toCaller?: (ev: ExecEvent) => ExecEvent;
  /** Rewrites a routing failure before it becomes the call's status. */
  mapError?: (err: Error) => Error;
  /** True once the call was already ended (a sandbox token expiring): drain, write nothing. */
  over?: () => boolean;
}

/**
 * Routes one Exec to its worker and streams its events back, ending the call with the right status.
 *
 * Client cancellation (harness deadline/abort) fires the call's "cancelled" event. We must NOT rely
 * on calling .return() on the routeExec generator while it idles on its internal await -- that can
 * hang forever if the worker never sends another frame. Instead, on cancellation we tell the worker
 * to abort via relay.routeAbort(), under the id the WORKER knows; the worker then emits an End/Error
 * frame for that reqId, which drives the generator's sink so it yields that event and returns
 * normally (running its `finally`, which cleans up the sink). This makes worker-disconnect and
 * client-cancel both terminate the generator cleanly.
 */
async function pumpExec(
  call: ServerWritableStream<ExecRequest, ExecEvent>,
  relay: Relay,
  sandboxId: string,
  exec: Exec,
  opts: PumpOpts = {},
): Promise<void> {
  const toCaller = opts.toCaller ?? ((ev: ExecEvent) => ev);
  const over = opts.over ?? (() => false);
  // Registered synchronously (before the loop's first await) so a
  // cancellation that races the very first event is never missed.
  // A client cancel also reaches us as an in-stream ExecEvent.error (the worker's
  // acknowledgement of our abort), but that is OUR abort completing, not a server-side
  // exec failure -- so it must not be reclassified as INTERNAL below.
  let cancelled = false;
  const onCancelled = () => {
    // A call already ended by its token's expiry has had its Abort sent; grpc-js then reports the
    // torn-down call as cancelled, which must not send the worker a second one.
    if (over()) return;
    cancelled = true;
    relay.routeAbort(sandboxId, exec.reqId);
  };
  call.on('cancelled', onCancelled);

  try {
    // Tracked as a flag, not by testing the message text: an ExecEvent.error with an
    // EMPTY message is still a failing Exec, and classifying on `message` alone would
    // silently re-admit it as a success (the Go exec-driver learned the same lesson --
    // see its sawErr note in cmd/exec-driver/drive.go).
    let sawExecError = false;
    let execErrorMessage = '';
    for await (const ev of relay.routeExec(sandboxId, exec)) {
      if (over()) continue;
      call.write(toCaller(ev));
      if (ev.error) {
        sawExecError = true;
        execErrorMessage = ev.error.message ?? '';
      }
    }
    if (over()) return;
    // A failed Exec must not terminate OK (#295). routeExec returns normally after
    // yielding an error event, so ending here would report success for a command that
    // never ran: it would count toward throughput, enter p95, and never be classified
    // as an error by a client that reads only the terminal status.
    if (sawExecError && !cancelled) {
      failExecStream(call, execStreamError(execErrorMessage));
      return;
    }
    call.end();
  } catch (err) {
    if (over()) return;
    // Reached by every throw out of routeExec -- including `no live worker for sandbox`
    // (an ordinary state: the worker died, or has not attached yet) and the reqId
    // in-flight collision. Codes are left to grpc-js rather than classified here: an
    // arbitrary internal throw becomes UNKNOWN with its message as the details, and a
    // thrown error that already carries a numeric `code` keeps it. Mapping these onto
    // specific codes (UNAVAILABLE for a missing worker, say) is a relay-semantics
    // decision, not part of fixing the termination primitive.
    failExecStream(call, opts.mapError ? opts.mapError(err as Error) : (err as Error));
  } finally {
    call.removeListener('cancelled', onCancelled);
  }
}

/** The same event with its req_id replaced, whichever oneof it carries. */
function withReqId(ev: ExecEvent, reqId: number): ExecEvent {
  if (ev.chunk) return { chunk: { ...ev.chunk, reqId } };
  if (ev.end) return { end: { ...ev.end, reqId } };
  if (ev.error) return { error: { ...ev.error, reqId } };
  return ev;
}

function addExecService(server: Server, relay: Relay, auth: ExecAuth): void {
  const leewayS = auth.sandboxLeewayS ?? SANDBOX_CLOCK_LEEWAY_S;
  const maxInflight = auth.sandboxMaxInflight ?? DEFAULT_SANDBOX_MAX_INFLIGHT;
  // Refusal lines (SBX0 §3.5) only on a relay with sandbox keys, so a MOCA relay's output is
  // unchanged. Fixed reasons, the token's sub and sbx when it verified; never the token itself.
  const write = auth.verifySandboxToken ? (auth.log ?? ((l: string) => console.log(l))) : undefined;
  const refused = (call: 'exec' | 'abort', reason: string, claims?: SandboxTokenClaims) =>
    write?.(
      JSON.stringify({
        ts: new Date().toISOString(),
        outcome: 'refused',
        call,
        reason,
        ...(claims ? { sub: claims.sub, sbx: claims.sbx } : {}),
      }),
    );

  // A sandbox caller may abort only an Exec its own sandbox started and that is still in flight:
  // req_ids are not secret, so without this one sandbox could kill another's command. Keyed by the
  // token's sbx and the CALLER's req_id; the entry holds where the Exec actually runs.
  const owned = new Map<string, { wrk: string; wid: number }>();
  const ownKey = (sbx: string, reqId: number) => `${sbx}\0${reqId}`;
  // Accepted, unfinished sandbox Execs per sbx (SBX0 §3.6).
  const inflight = new Map<string, number>();

  async function sandboxExec(
    call: ServerWritableStream<ExecRequest, ExecEvent>,
    claims: SandboxTokenClaims,
    sandboxId: string,
    e: Exec,
  ): Promise<void> {
    // Exact equality on both (SBX0 §3.2): never a prefix, so sbx-a cannot reach sbx-ab.
    const denied =
      sandboxId !== claims.wrk
        ? "exec not permitted: sandbox_id is not this token's worker"
        : e.workspaceKey !== claims.wsk
          ? "exec not permitted: workspace_key is not this token's workspace"
          : undefined;
    if (denied) {
      refused('exec', denied, claims);
      failExecStream(call, grpcError(status.PERMISSION_DENIED, denied));
      return;
    }
    const key = ownKey(claims.sbx, e.reqId);
    if (owned.has(key)) {
      // Refused here, not left to routeExec's collision: that would name the worker's id, and
      // this Exec's cleanup must never drop the first one's ownership entry.
      failExecStream(
        call,
        grpcError(status.ALREADY_EXISTS, `req_id ${e.reqId} already in flight for this sandbox`),
      );
      return;
    }
    const n = inflight.get(claims.sbx) ?? 0;
    if (n >= maxInflight) {
      failExecStream(
        call,
        grpcError(status.RESOURCE_EXHAUSTED, `sandbox busy: ${n} Execs already in flight`),
      );
      return;
    }
    let wid: number;
    try {
      wid = workerReqId(claims.sbx, e.reqId);
    } catch {
      failExecStream(call, grpcError(status.INVALID_ARGUMENT, 'req_id out of range'));
      return;
    }
    const entry = { wrk: sandboxId, wid };
    // No Exec outlives its token (SBX0 §3.6): at exp + leeway the worker is told to abort and
    // the call ends at once. The handler then drains the worker's acknowledgement without
    // writing it, so the slot and the ownership entry are held until the worker lets go.
    let expired = false;
    let disarm: ReturnType<typeof armDeadline> | undefined;
    try {
      owned.set(key, entry);
      inflight.set(claims.sbx, n + 1);
      disarm = armDeadline(
        (claims.exp + leewayS) * 1000,
        () => {
          if (call.cancelled) return;
          expired = true;
          relay.routeAbort(sandboxId, wid);
          failExecStream(
            call,
            grpcError(status.DEADLINE_EXCEEDED, 'sandbox token expired during the Exec'),
          );
        },
        auth.timers,
      );
      await pumpExec(
        call,
        relay,
        sandboxId,
        { ...e, reqId: wid },
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
        },
      );
    } finally {
      if (disarm) disarm();
      if (owned.get(key) === entry) owned.delete(key);
      const left = (inflight.get(claims.sbx) ?? 1) - 1;
      if (left > 0) inflight.set(claims.sbx, left);
      else inflight.delete(claims.sbx);
    }
  }

  const execImpl: SandboxExecServer = {
    // Server-streaming: one ExecRequest in, a stream of ExecEvents out.
    exec: async (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      const caller = execCaller(call.metadata, auth);
      if (caller.kind === 'none') {
        if (caller.reason) refused('exec', caller.reason);
        failExecStream(call, unauthenticated());
        return;
      }
      const req = call.request;
      const e = req.exec;
      if (!e) {
        // The request itself is malformed, so this one IS the caller's fault.
        failExecStream(call, grpcError(status.INVALID_ARGUMENT, 'ExecRequest missing exec field'));
        return;
      }
      if (caller.kind === 'sandbox') {
        await sandboxExec(call, caller.claims, req.sandboxId, e);
        return;
      }
      await pumpExec(call, relay, req.sandboxId, e);
    },
    abort: (
      call: ServerUnaryCall<AbortRequest, AbortResponse>,
      cb: sendUnaryData<AbortResponse>,
    ) => {
      const caller = execCaller(call.metadata, auth);
      if (caller.kind === 'none') {
        if (caller.reason) refused('abort', caller.reason);
        cb(unauthenticated(), null);
        return;
      }
      const { sandboxId, reqId } = call.request;
      if (caller.kind === 'harness') {
        relay.routeAbort(sandboxId, reqId);
        cb(null, {});
        return;
      }
      const entry = owned.get(ownKey(caller.claims.sbx, reqId));
      if (!entry || entry.wrk !== sandboxId) {
        const why = 'abort not permitted: not an in-flight Exec of this sandbox';
        refused('abort', why, caller.claims);
        cb(grpcError(status.PERMISSION_DENIED, why), null);
        return;
      }
      relay.routeAbort(entry.wrk, entry.wid);
      cb(null, {});
    },
  };
  server.addService(SandboxExecService, execImpl);
}

/**
 * One listener serving both services — the Kubernetes shape, where the token is the ONLY control:
 * every sandbox can reach SandboxExec, and only a secret exec token keeps it out. With the base
 * manifest's public dev token there is no isolation between sandboxes at all.
 */
export function buildServer(
  deps: RelayServerDeps,
  keepalive?: Keepalive,
): { server: Server; relay: Relay } {
  const relay = createRelay(deps);
  const server = newServer(keepalive);
  addWorkerService(server, relay);
  addExecService(server, relay, deps);
  return { server, relay };
}

/**
 * Two listeners over ONE relay (MI1 §5 R5), so the exec server can be bound where sandboxes cannot
 * reach it: loopback on deploy/vm, the brain network in compose. That reachability comes from the
 * address it is bound to, not from this function; bound on an address sandboxes can reach, the
 * exec token is again the only control. Same relay instance, so an Exec routes to a worker attached
 * on the other listener.
 */
export function buildServers(
  deps: RelayServerDeps,
  keepalive?: Keepalive,
): {
  attachServer: Server;
  execServer: Server;
  relay: Relay;
} {
  const relay = createRelay(deps);
  const attachServer = newServer(keepalive);
  const execServer = newServer(keepalive);
  addWorkerService(attachServer, relay);
  addExecService(execServer, relay, deps);
  return { attachServer, execServer, relay };
}

function bind(server: Server, addr: string): Promise<number> {
  return new Promise((resolve, reject) =>
    server.bindAsync(addr, ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
}

/** A sandbox id the relay will look up: the shell-variable rule the VM path already enforces. */
const SANDBOX_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Default token validator, fail-closed (spec P6.2 §2.1-2.2). A sandbox's expected token is, in
 * order: the file `$SH_RELAY_TOKEN_DIR/<id>` (read on EACH attach, so a host added to the mounted
 * Secret is admitted without a relay restart), then `SH_RELAY_TOKEN_<id>`, then `SH_RELAY_TOKEN`.
 * A missing file (or directory) falls through; any other read error, and an empty file, refuse the
 * attach without falling through. A directory token equal to MOCA_RELAY_EXEC_TOKEN is refused (MI1
 * R5: a sandbox credential must never be a caller credential). Only ids matching SANDBOX_ID_RE are
 * looked up in the directory (no path traversal); any other id -- the container tier's dashed
 * moca-sandbox-N -- takes the env path exactly as before. Reserved names are refused outright with
 * no fallthrough. Constant-time, like the exec token's comparison. Logs name the id, never a value.
 */
export function makeDefaultValidateToken(
  env: NodeJS.ProcessEnv,
  deps: { readFile?: (path: string) => string } = {},
): (token: string | undefined, sandboxId: string) => boolean {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const dir = env.SH_RELAY_TOKEN_DIR;
  const execToken = env.MOCA_RELAY_EXEC_TOKEN;
  return (token, sandboxId) => {
    // Reserved names are never valid sandboxes (they are configuration keys).
    if (RESERVED_SANDBOX_IDS.has(sandboxId)) {
      return false;
    }
    let expected: string | undefined;
    let fromDir = false;
    if (dir && SANDBOX_ID_RE.test(sandboxId)) {
      try {
        expected = readFile(`${dir}/${sandboxId}`).replace(/\n$/, '');
        fromDir = true;
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') {
          console.error(`relay token for ${sandboxId} unreadable`);
          return false;
        }
      }
    }
    if (!fromDir) expected = env[`SH_RELAY_TOKEN_${sandboxId}`] ?? env.SH_RELAY_TOKEN;
    // `!`, not `=== undefined`: an empty token (file or env) is a configuration mistake, not a
    // token, and must not admit a worker presenting an empty one.
    if (!expected || !token) return false;
    if (fromDir && execToken && expected === execToken) {
      console.error(`relay token for ${sandboxId} equals the exec token; refused`);
      return false;
    }
    const want = Buffer.from(expected);
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
}

/**
 * The relay's detach marks, on the SAME RedisRecordStore as presence so a teardown's remove and mark
 * (and a Hello's clear and put) share one FIFO command queue. The TTL is the affinity TTL: a mark is
 * only ever read for an affine sandbox, and affinity cannot outlive SH_SANDBOX_AFFINITY_TTL_SECONDS.
 */
export function detachMarks(records: RedisRecordStore, env: NodeJS.ProcessEnv): DetachMarks {
  const { ttlMs } = affinityTimings(env);
  return {
    mark: (id) => records.markDetached(id, Date.now(), ttlMs),
    clear: (id) => records.clearDetached(id),
  };
}

/**
 * Graceful stop (#453), in this order: every server stops accepting new calls, the relay drains
 * (each parked session's record removed and detach mark written, awaited, then its stream ended),
 * and only then do the servers finish. `tryShutdown` waits for open calls, and an Attach stream is
 * open for the worker's whole life, so without the drain ending them it never returns at all.
 */
async function stopGracefully(servers: Server[], relay: Relay, close?: () => Promise<void>) {
  const stopped = Promise.all(
    servers.map((s) => new Promise<void>((r) => s.tryShutdown(() => r()))),
  );
  await relay.drain();
  await stopped;
  await close?.();
}

export async function startRelay(
  opts: {
    port?: number;
    execAddr?: string;
    deps?: RelayServerDeps;
    env?: NodeJS.ProcessEnv;
    keepalive?: Keepalive;
  } = {},
): Promise<{ port: number; execPort?: number; shutdown: () => Promise<void> }> {
  const env = opts.env ?? process.env;
  // The store startRelay built itself, and so closes on shutdown; injected deps belong to the caller.
  let ownedRecords: RedisRecordStore | undefined;
  // The exec auth first: it throws on a missing credential before anything touches Redis.
  const deps =
    opts.deps ??
    (() => {
      const auth = makeExecAuth(env);
      const records = new RedisRecordStore();
      ownedRecords = records;
      return {
        records,
        detach: detachMarks(records, env),
        validateToken: makeDefaultValidateToken(env),
        ...auth,
      };
    })();
  const close = ownedRecords ? () => ownedRecords!.close() : undefined;
  const attachAddr = `0.0.0.0:${opts.port ?? Number(env.SH_RELAY_PORT ?? 8443)}`;
  const execAddr = opts.execAddr ?? env.MOCA_RELAY_EXEC_ADDR;
  if (!execAddr) {
    const { server, relay } = buildServer(deps, opts.keepalive);
    const port = await bind(server, attachAddr);
    return { port, shutdown: () => stopGracefully([server], relay, close) };
  }
  const { attachServer, execServer, relay } = buildServers(deps, opts.keepalive);
  const port = await bind(attachServer, attachAddr);
  const execPort = await bind(execServer, execAddr);
  return {
    port,
    execPort,
    shutdown: () => stopGracefully([attachServer, execServer], relay, close),
  };
}

/**
 * How long a signalled stop may take before the process exits anyway. Well under both outer
 * limits -- systemd's TimeoutStopSec and the pod's terminationGracePeriodSeconds, 120 s each -- so
 * the relay always exits on its own terms rather than by SIGKILL.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * SIGTERM/SIGINT run the graceful stop once, then exit: 0 when it settled, 1 at the deadline. Without
 * a handler the default action skipped every teardown (#453), and under Kubernetes, where node is PID
 * 1 and has no default SIGTERM action, the pod also sat out its whole grace period.
 */
export function installShutdownSignals(
  shutdown: () => Promise<void>,
  opts: {
    proc?: NodeJS.Process;
    exit?: (code: number) => void;
    deadlineMs?: number;
  } = {},
): void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let stopping = false;
  const onSignal = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`sandbox-relay: ${signal}, draining`);
    const timer = setTimeout(() => {
      console.error(`sandbox-relay: shutdown missed its ${deadlineMs} ms deadline; exiting`);
      exit(1);
    }, deadlineMs);
    shutdown().then(
      () => {
        clearTimeout(timer);
        console.log('sandbox-relay: drained, exiting');
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.error(
          `sandbox-relay: shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        exit(1);
      },
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) proc.on(signal, () => onSignal(signal));
}

// Bootstrap when run directly (tsx entrypoint), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  startRelay().then(
    ({ port, execPort, shutdown }) => {
      installShutdownSignals(shutdown);
      console.log(
        `sandbox-relay attach :${port}${execPort ? `, exec :${execPort}` : ' (exec on the same listener)'}`,
      );
    },
    // Every boot refusal (a missing or clashing exec token, an unbindable address) lands here. Left
    // unhandled it would print a raw stack; the operator needs the reason, on one line.
    (err: unknown) => {
      console.error(
        `sandbox-relay: refusing to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    },
  );
}
