import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  type LeaseControlRequest,
  type LeaseControlResponse,
  type LeaseKeepaliveRequest,
  type LeaseKeepaliveResponse,
  MAX_EXEC_MESSAGE_BYTES,
  SandboxMode,
} from '@moca/k8s-sandbox';
import { RedisRecordStore, affinityTimings } from '@moca/harness';
import {
  ATTACH_CLOCK_LEEWAY_S,
  CpError,
  SANDBOX_CLOCK_LEEWAY_S,
  verifyAttachToken,
  type SandboxTokenClaims,
} from '@moca/control-plane';
import {
  createRelay,
  type Relay,
  type RelayDeps,
  type AttachStream,
  type AttachVerifier,
  type DetachMarks,
} from './relay.js';
import {
  DEFAULT_SANDBOX_MAX_INFLIGHT,
  keysetFromEnv,
  makeSandboxTokenVerifier,
  makeSetModeTokenVerifier,
  sandboxMaxInflight,
  type SandboxVerifier,
  type SetModeVerifier,
} from './sandbox-auth.js';
import { failExecStream, grpcError, pumpExec } from './exec-stream.js';
import {
  SANDBOX_DRAIN_GRACE_S,
  leaseOpName,
  makeAudit,
  makeSandboxCaller,
  type LeaseTimeoutsMs,
} from './sandbox-caller.js';

export { grpcError } from './exec-stream.js';
export { SANDBOX_DRAIN_GRACE_S, armDeadline } from './sandbox-caller.js';

/** Relay server dependencies: the relay's own, plus the SandboxExec caller checks (MI1 §5 R5, SBX0 §3). */
export interface RelayServerDeps extends RelayDeps {
  validateExecToken: (presented: string | undefined) => boolean;
  /** Sandbox tokens (SBX0 §3.2). Omitted: only the harness's exec token is accepted. */
  verifySandboxToken?: SandboxVerifier;
  /** Set-mode tokens, for LeaseControl set_mode (lease-mode §8.2). Omitted: every set_mode is refused. */
  verifySetModeToken?: SetModeVerifier;
  /**
   * LeaseControl's per-op timeouts. Defaults to 15 s for status and 31 min (the worker's
   * LeaseGraceLimit plus 60 s) for the mutate ops; tests set short ones.
   */
  leaseTimeoutsMs?: LeaseTimeoutsMs;
  /** In-flight Execs admitted per `sbx` (SBX0 §3.6). Defaults to 2. */
  sandboxMaxInflight?: number;
  /** Seconds past a token's `exp` at which its running Exec is cancelled. Defaults to 30; tests set 0. */
  sandboxLeewayS?: number;
  /**
   * Seconds after that cancel at which an Exec the worker never acknowledged gives back its in-flight
   * slot and its Abort ownership anyway. Defaults to 60.
   */
  sandboxDrainGraceS?: number;
  /** The key of the per-sandbox req_id mapping (workerReqId). Defaults to 32 random bytes per boot. */
  sandboxReqIdKey?: Buffer;
  /** Where the sandbox Exec audit lines go (SBX0 §3.5). Defaults to stdout. */
  log?: (line: string) => void;
  /** SH_SANDBOX_AUDIT_COMMANDS=1: audit lines carry the command's first 200 bytes (SBX0 §3.5). */
  sandboxAuditCommands?: boolean;
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
): Pick<
  RelayServerDeps,
  | 'validateExecToken'
  | 'verifySandboxToken'
  | 'verifySetModeToken'
  | 'sandboxMaxInflight'
  | 'sandboxAuditCommands'
> {
  const verifySandboxToken = makeSandboxTokenVerifier(env);
  const verifySetModeToken = makeSetModeTokenVerifier(env);
  const maxInflight = sandboxMaxInflight(env);
  if (!env.MOCA_RELAY_EXEC_TOKEN && !verifySandboxToken) {
    throw new Error(
      'MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS is required: the relay refuses unauthenticated SandboxExec',
    );
  }
  const validateExecToken = env.MOCA_RELAY_EXEC_TOKEN ? makeExecTokenValidator(env) : () => false;
  return {
    validateExecToken,
    ...(verifySandboxToken
      ? {
          verifySandboxToken,
          ...(verifySetModeToken ? { verifySetModeToken } : {}),
          sandboxMaxInflight: maxInflight,
          // Exactly "1": an operator debug flag, so anything else is off.
          ...(env.SH_SANDBOX_AUDIT_COMMANDS === '1' ? { sandboxAuditCommands: true } : {}),
        }
      : {}),
  };
}

type ExecAuth = Pick<
  RelayServerDeps,
  | 'validateExecToken'
  | 'verifySandboxToken'
  | 'verifySetModeToken'
  | 'leaseTimeoutsMs'
  | 'sandboxMaxInflight'
  | 'sandboxLeewayS'
  | 'sandboxDrainGraceS'
  | 'sandboxReqIdKey'
  | 'log'
  | 'sandboxAuditCommands'
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

/** The lease calls are a sandbox's own (lease-mode §8.2): the harness never uses leases. */
const HARNESS_NO_LEASES = 'lease calls not permitted: the harness never uses leases';

function addExecService(server: Server, relay: Relay, auth: ExecAuth): void {
  // Audit lines (SBX0 §3.5) only on a relay with sandbox keys, so a MOCA relay's output is
  // unchanged. Fixed reasons, the token's sub and sbx only when it verified; never the token.
  const audit = makeAudit(
    auth.verifySandboxToken ? (auth.log ?? ((l: string) => console.log(l))) : undefined,
    auth.sandboxAuditCommands === true,
  );
  const sandbox = makeSandboxCaller(relay, {
    maxInflight: auth.sandboxMaxInflight ?? DEFAULT_SANDBOX_MAX_INFLIGHT,
    leewayS: auth.sandboxLeewayS ?? SANDBOX_CLOCK_LEEWAY_S,
    drainGraceS: auth.sandboxDrainGraceS ?? SANDBOX_DRAIN_GRACE_S,
    // Never leaves this process. A new one at each boot changes every wid, which costs nothing: a
    // sandbox client re-sends a req_id only for a call that never started (SBX0 §6.5).
    reqIdKey: auth.sandboxReqIdKey ?? randomBytes(32),
    timers: auth.timers,
    audit,
    ...(auth.verifySetModeToken ? { verifySetMode: auth.verifySetModeToken } : {}),
    ...(auth.leaseTimeoutsMs ? { leaseTimeoutsMs: auth.leaseTimeoutsMs } : {}),
  });

  const execImpl: SandboxExecServer = {
    // Server-streaming: one ExecRequest in, a stream of ExecEvents out.
    exec: async (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      const t0 = Date.now();
      const caller = execCaller(call.metadata, auth);
      // Already decoded; read before the caller check so a refusal's line can name the request.
      const req = call.request;
      const e = req.exec;
      if (caller.kind === 'none') {
        // No claims and no command: nothing about this token verified, so both are its say-so.
        if (caller.reason)
          audit.exec(t0, {
            wrk: req.sandboxId,
            req_id: e?.reqId ?? 0,
            outcome: 'refused',
            reason: caller.reason,
            out_bytes: 0,
          });
        failExecStream(call, unauthenticated());
        return;
      }
      if (!e) {
        // The request itself is malformed, so this one IS the caller's fault.
        const why = 'ExecRequest missing exec field';
        if (caller.kind === 'sandbox')
          audit.exec(t0, {
            wrk: req.sandboxId,
            req_id: 0,
            claims: caller.claims,
            outcome: 'refused',
            reason: why,
            out_bytes: 0,
          });
        failExecStream(call, grpcError(status.INVALID_ARGUMENT, why));
        return;
      }
      if (caller.kind === 'sandbox') {
        await sandbox.exec(call, caller.claims, req.sandboxId, e, t0);
        return;
      }
      // The harness never uses leases: whatever it sent, its Execs run per-exec, unversioned.
      const harnessExec = {
        ...e,
        mode: SandboxMode.SANDBOX_MODE_UNSPECIFIED,
        modeEpoch: 0,
        idleTimeoutS: 0,
        keepalive: false,
      };
      await pumpExec(call, relay, req.sandboxId, harnessExec, { workload: req.workload });
    },
    abort: (
      call: ServerUnaryCall<AbortRequest, AbortResponse>,
      cb: sendUnaryData<AbortResponse>,
    ) => {
      const caller = execCaller(call.metadata, auth);
      if (caller.kind === 'none') {
        if (caller.reason)
          audit.abortRefused(call.request.sandboxId, call.request.reqId, caller.reason);
        cb(unauthenticated(), null);
        return;
      }
      const { sandboxId, reqId } = call.request;
      if (caller.kind === 'harness') {
        relay.routeAbort(sandboxId, reqId);
        cb(null, {});
        return;
      }
      const entry = sandbox.abort(caller.claims, sandboxId, reqId);
      if ('refusal' in entry) {
        cb(entry.refusal, null);
        return;
      }
      relay.routeAbort(entry.wrk, entry.wid);
      cb(null, {});
    },
    // SBX0.3 lease calls (lease-mode §8.2): sandbox-token callers only.
    leaseControl: (
      call: ServerUnaryCall<LeaseControlRequest, LeaseControlResponse>,
      cb: sendUnaryData<LeaseControlResponse>,
    ) => {
      const t0 = Date.now();
      const caller = execCaller(call.metadata, auth);
      const req = call.request;
      if (caller.kind !== 'sandbox') {
        const reason = caller.kind === 'harness' ? HARNESS_NO_LEASES : caller.reason;
        if (reason)
          audit.leaseControl(t0, {
            wrk: req.sandboxId,
            op: leaseOpName(req.op),
            outcome: 'refused',
            reason,
          });
        cb(
          caller.kind === 'harness'
            ? grpcError(status.PERMISSION_DENIED, HARNESS_NO_LEASES)
            : unauthenticated(),
          null,
        );
        return;
      }
      // A client that goes away withdraws its call: the relay drops the waiter and frees the slot.
      // The listener goes once the call settles, whichever way.
      const cancelled = new AbortController();
      const onCancelled = () => cancelled.abort();
      call.on('cancelled', onCancelled);
      if (call.cancelled) cancelled.abort();
      sandbox.leaseControl(caller.claims, req, t0, cancelled.signal).then(
        (res) => {
          call.off('cancelled', onCancelled);
          cb(null, res);
        },
        (err: Error) => {
          call.off('cancelled', onCancelled);
          cb(err, null);
        },
      );
    },
    leaseKeepalive: (
      call: ServerUnaryCall<LeaseKeepaliveRequest, LeaseKeepaliveResponse>,
      cb: sendUnaryData<LeaseKeepaliveResponse>,
    ) => {
      // Not audited, refusals included: a client may send one every few seconds.
      const caller = execCaller(call.metadata, auth);
      if (caller.kind !== 'sandbox') {
        cb(
          caller.kind === 'harness'
            ? grpcError(status.PERMISSION_DENIED, HARNESS_NO_LEASES)
            : unauthenticated(),
          null,
        );
        return;
      }
      try {
        sandbox.leaseKeepalive(caller.claims, call.request);
      } catch (err) {
        cb(err as Error, null);
        return;
      }
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

const ATTACH_KEYS_VAR = 'MOCA_ATTACH_PUBLIC_KEYS';

/**
 * The attach-token verifier (workload sandboxes spec §3.1-3.2), or undefined when
 * MOCA_ATTACH_PUBLIC_KEYS is unset or blank. Undefined is the whole "no keys, nothing changes"
 * guarantee: createRelay consults none of the workload-label rules without it. Set, it must parse,
 * or the relay does not boot. Public keys only: the relay can verify an attach token, never mint one.
 */
export function makeAttachVerifier(env: NodeJS.ProcessEnv): AttachVerifier | undefined {
  const raw = env[ATTACH_KEYS_VAR]?.trim();
  if (!raw) return undefined;
  const keys = keysetFromEnv(ATTACH_KEYS_VAR, raw);
  return (presented) => {
    if (!presented) return { reason: 'no bearer token' };
    try {
      const c = verifyAttachToken(presented, keys);
      return {
        binding: {
          workload: c.wl,
          owner: c.own,
          tier: c.tr,
          count: c.n,
          // The same leeway the verifier allows, so a token it admitted is never closed at once.
          expiresAtMs: (c.exp + ATTACH_CLOCK_LEEWAY_S) * 1000,
        },
      };
    } catch (err) {
      // CpError messages are the verifier's fixed strings; anything else could carry input.
      return { reason: err instanceof CpError ? err.message : 'invalid attach token' };
    }
  };
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
      // Before Redis too: a malformed keyset is a boot error.
      const verifyAttach = makeAttachVerifier(env);
      const records = new RedisRecordStore();
      ownedRecords = records;
      return {
        records,
        detach: detachMarks(records, env),
        validateToken: makeDefaultValidateToken(env),
        ...auth,
        ...(verifyAttach ? { verifyAttach } : {}),
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
