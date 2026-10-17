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
  type ExecRequest,
  type ExecEvent,
  type AbortRequest,
  type AbortResponse,
  MAX_EXEC_MESSAGE_BYTES,
} from '@moca/k8s-sandbox';
import { RedisRecordStore, affinityTimings } from '@moca/harness';
import {
  createRelay,
  type Relay,
  type RelayDeps,
  type AttachStream,
  type DetachMarks,
} from './relay.js';

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
 * A worker-reported in-stream exec failure, shaped so grpc-js terminates the stream with
 * a non-OK status instead of OK. INTERNAL (not UNKNOWN) because the failure is server-side
 * and not the caller's fault: `ExecEvent.error` means the exec machinery itself failed,
 * whereas a command that merely exited non-zero comes back as `ExecEvent.end{exitCode}`.
 * The worker's message travels as the status details so the cause is not lost.
 */
function execStreamError(message: string): Error {
  const err = new Error(message) as Error & { code: number; details: string };
  err.code = status.INTERNAL;
  err.details = message;
  return err;
}

/** Relay server dependencies: the relay's own, plus the SandboxExec caller check (MI1 §5 R5). */
export interface RelayServerDeps extends RelayDeps {
  validateExecToken: (presented: string | undefined) => boolean;
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
  const err = new Error('exec authentication failed') as Error & { code: number; details: string };
  err.code = status.UNAUTHENTICATED;
  err.details = err.message;
  return err;
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

function addExecService(
  server: Server,
  relay: ReturnType<typeof createRelay>,
  validate: RelayServerDeps['validateExecToken'],
): void {
  const execImpl: SandboxExecServer = {
    // Server-streaming: one ExecRequest in, a stream of ExecEvents out.
    //
    // Client cancellation (harness deadline/abort) fires the call's "cancelled"
    // event. We must NOT rely on calling .return() on the routeExec generator
    // while it idles on its internal await -- that can hang forever if the
    // worker never sends another frame. Instead, on cancellation we tell the
    // worker to abort via relay.routeAbort(); the worker then emits an
    // End/Error frame for that reqId, which drives the generator's sink so it
    // yields that event and returns normally (running its `finally`, which
    // cleans up the sink). This makes worker-disconnect (Task 6) and
    // client-cancel (this task) both terminate the generator cleanly.
    exec: async (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      if (!validate(bearerOf(call.metadata))) {
        failExecStream(call, unauthenticated());
        return;
      }
      const req = call.request;
      const e = req.exec;
      if (!e) {
        const err = new Error('ExecRequest missing exec field') as Error & {
          code: number;
          details: string;
        };
        // The request itself is malformed, so this one IS the caller's fault.
        err.code = status.INVALID_ARGUMENT;
        err.details = err.message;
        failExecStream(call, err);
        return;
      }
      // Registered synchronously (before the loop's first await) so a
      // cancellation that races the very first event is never missed.
      // A client cancel also reaches us as an in-stream ExecEvent.error (the worker's
      // acknowledgement of our abort), but that is OUR abort completing, not a server-side
      // exec failure -- so it must not be reclassified as INTERNAL below.
      let cancelled = false;
      const onCancelled = () => {
        cancelled = true;
        relay.routeAbort(req.sandboxId, e.reqId);
      };
      call.on('cancelled', onCancelled);

      try {
        // Tracked as a flag, not by testing the message text: an ExecEvent.error with an
        // EMPTY message is still a failing Exec, and classifying on `message` alone would
        // silently re-admit it as a success (the Go exec-driver learned the same lesson --
        // see its sawErr note in cmd/exec-driver/drive.go).
        let sawExecError = false;
        let execErrorMessage = '';
        for await (const ev of relay.routeExec(req.sandboxId, e)) {
          call.write(ev);
          if (ev.error) {
            sawExecError = true;
            execErrorMessage = ev.error.message ?? '';
          }
        }
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
        // Reached by every throw out of routeExec -- including `no live worker for sandbox`
        // (an ordinary state: the worker died, or has not attached yet) and the reqId
        // in-flight collision. Codes are left to grpc-js rather than classified here: an
        // arbitrary internal throw becomes UNKNOWN with its message as the details, and a
        // thrown error that already carries a numeric `code` keeps it. Mapping these onto
        // specific codes (UNAVAILABLE for a missing worker, say) is a relay-semantics
        // decision, not part of fixing the termination primitive.
        failExecStream(call, err as Error);
      } finally {
        call.removeListener('cancelled', onCancelled);
      }
    },
    abort: (
      call: ServerUnaryCall<AbortRequest, AbortResponse>,
      cb: sendUnaryData<AbortResponse>,
    ) => {
      if (!validate(bearerOf(call.metadata))) {
        cb(unauthenticated(), null);
        return;
      }
      relay.routeAbort(call.request.sandboxId, call.request.reqId);
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
  addExecService(server, relay, deps.validateExecToken);
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
  addExecService(execServer, relay, deps.validateExecToken);
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
  // The exec validator first: it throws on a missing token before anything touches Redis.
  const deps =
    opts.deps ??
    (() => {
      const validateExecToken = makeExecTokenValidator(env);
      const records = new RedisRecordStore();
      ownedRecords = records;
      return {
        records,
        detach: detachMarks(records, env),
        validateToken: makeDefaultValidateToken(env),
        validateExecToken,
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
