import { status } from '@grpc/grpc-js';
import { OWNER_LABEL, TEMPLATE_LABEL, TIER_LABEL, WORKLOAD_LABEL } from '@moca/harness';
import type { RecordStore, SandboxRecord } from '@moca/harness';
import {
  ExecKind,
  LeaseControlFrame,
  LeaseKeepaliveFrame,
  type Exec,
  type ExecEvent,
  type LeaseControlResult,
  type ServerFrame,
  type WorkerFrame,
} from '@moca/k8s-sandbox';

/**
 * The reserved Hello capability of a worker that serves lease level 2's process kinds (ruling
 * P5-R37; remote-worker vmpool.CapabilityLeaseProcessesV1, the same string). A worker from before
 * plan 5 decodes Exec.kind as an unknown field and would run a process_start's command as a plain
 * Exec, so no process kind is forwarded to a worker whose Hello lacks it.
 */
export const LEASE_PROCESSES_CAPABILITY = 'sbx:lease-processes-v1';
/** The refusal, FAILED_PRECONDITION, of a process kind for a worker without the capability. */
export const WORKER_WITHOUT_PROCESSES =
  "lease_unsupported: this sandbox's worker does not support tracked processes";

export interface AttachStream {
  metadata?: { get: (k: string) => string[] };
  on(event: 'data', cb: (f: WorkerFrame) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  write(f: ServerFrame): void;
  end(): void;
}

/** The two timer calls the presence retry needs; injectable so tests do not wait in real time. */
export interface RelayTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * The detach mark (P6.3 spec §3.2): when a sandbox left, so the harness can measure an absent affine
 * sandbox's grace period from the real departure. Optional: a relay without it behaves exactly as
 * before, and the harness then starts the clock itself at the first turn that notices.
 */
export interface DetachMarks {
  mark(sandboxId: string): Promise<void>;
  clear(sandboxId: string): Promise<void>;
}

/** What a verified attach token binds a sandbox to (workload sandboxes spec §3.1). */
export interface AttachBinding {
  workload: string;
  owner: string;
  tier: string;
  /** The token's `n`: only sandbox ordinals below it may attach. */
  count: number;
  /** When the relay closes the stream (epoch ms): the token's `exp`, plus the clock leeway. */
  expiresAtMs: number;
}

/**
 * Verifies an attach token (`moca-attach+jwt`) with public keys only. Returns the binding, or a
 * refusal reason for the operator's log (a fixed string, never the token). main.ts builds it from
 * MOCA_ATTACH_PUBLIC_KEYS.
 */
export type AttachVerifier = (
  token: string | undefined,
) => { binding: AttachBinding; reason?: undefined } | { binding?: undefined; reason: string };

export interface RelayDeps {
  records: RecordStore;
  validateToken: (token: string | undefined, sandboxId: string) => boolean;
  /**
   * Trusted workload labels (workload sandboxes spec §3.2-3.3). Set only when the relay has attach
   * public keys. Absent, the relay behaves exactly as before: Hello labels are mirrored as sent and
   * an Exec's `workload` field is ignored. Present:
   *  - a Hello whose token is a valid attach token, and whose sandboxId is `<wl>-<ordinal>` with
   *    the ordinal below the token's `n`, is parked with moca.dev/workload, moca.dev/owner and
   *    moca.dev/tier taken from the token, and its stream is closed when the token expires;
   *  - a Hello admitted by the shared or per-id token loses any moca.dev/workload and
   *    moca.dev/owner label, and may not take a workload-shaped id;
   *  - an Exec whose `workload` differs from its sandbox's trusted workload is refused.
   */
  verifyAttach?: AttachVerifier;
  /** Detach marks; main.ts wires them to the record store's client. */
  detach?: DetachMarks;
  /** Defaults to the global timers. */
  timers?: RelayTimers;
  /**
   * The clock keepalive coalescing reads, in ms (ruling P4-R1). Defaults to performance.now, which
   * is monotonic: a wall clock stepped back must not hold keepalives off. Tests set one.
   */
  now?: () => number;
}

/**
 * The least time between two keepalive frames for one workspace on one worker (lease-mode plan 4).
 * A keepalive only proves the lease is still wanted, so the ones inside the window carry nothing
 * the worker does not already know: they are answered OK and not written.
 */
export const LEASE_KEEPALIVE_COALESCE_MS = 1_000;

interface Parked {
  stream: AttachStream;
  /** The worker's Hello.capabilities, as sent. */
  capabilities: readonly string[];
  /** The trusted workload key, from a verified attach token; undefined for a shared-pool sandbox. */
  workload?: string;
  // per-reqId sinks for in-flight execs, populated by routeExec
  sinks: Map<number, (ev: ExecEvent) => void>;
  // per-ctlId waiters for in-flight lease controls, populated by routeLeaseControl
  controls: Map<number, PendingControl>;
  // Cancels the attach token's expiry timer; set by an attach-token Hello, called by teardown.
  cancelExpiry?: () => void;
  // Cancels a pending presence-put retry; set by Hello, called by teardown.
  cancelPresence?: () => void;
  // When routeKeepalive last wrote a keepalive frame, per workspace key; goes with the session.
  keepaliveAtMs: Map<string, number>;
  // This stream's teardown, so drain can run it; settles once the remove and the mark have.
  teardown: () => Promise<void>;
}

/** One routeLeaseControl awaiting the worker's LeaseControlResult. */
interface PendingControl {
  resolve: (r: LeaseControlResult) => void;
  reject: (err: Error) => void;
}

/** Presence-put backoff: 250 ms, doubling, capped at 10 s, with no attempt limit (#423, Task 16b). */
const PRESENCE_RETRY_BASE_MS = 250;
const PRESENCE_RETRY_MAX_MS = 10_000;

/**
 * A sandbox id shaped like a workload sandbox's, `w-<32 hex>-<n>` (spec §4.2). With attach keys
 * configured, only an attach token for that workload may register one: a shared-pool sandbox taking
 * the id first would otherwise hold it against the workload's own pod (the duplicate-id refusal).
 */
const WORKLOAD_SANDBOX_ID_RE = /^w-[0-9a-f]{32}-[0-9]+$/;

/**
 * `sandboxId` is `<wl>-<ordinal>` with a canonical ordinal below the token's `n`: the binding check of
 * spec §3.2 (`^<wl>-(0|[1-9][0-9]*)$`). Canonical, so `-01` cannot shadow `-1`.
 */
function idMatchesWorkload(sandboxId: string, binding: AttachBinding): boolean {
  const prefix = `${binding.workload}-`;
  if (!sandboxId.startsWith(prefix)) return false;
  const ordinal = sandboxId.slice(prefix.length);
  return /^(0|[1-9][0-9]*)$/.test(ordinal) && Number(ordinal) < binding.count;
}

/** setTimeout's delay is a signed 32-bit ms count; a longer one fires at once (Node clamps to 1). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The labels a parked sandbox's record carries. With an attach binding, its three labels overwrite
 * whatever Hello sent; without one (a shared-pool sandbox on a relay with attach keys), the workload
 * and owner labels are removed, so no sandbox can claim to be someone's by saying so. A workload
 * sandbox (one with a binding) also loses any template label: workload sandboxes are not templated
 * (session-templates spec §3.2), and a template is not in the signed binding.
 */
function trustedLabels(
  sent: Record<string, string> | undefined,
  binding: AttachBinding | undefined,
): Record<string, string> {
  const labels = { ...(sent ?? {}) };
  delete labels[WORKLOAD_LABEL];
  delete labels[OWNER_LABEL];
  if (binding) {
    delete labels[TEMPLATE_LABEL];
    labels[WORKLOAD_LABEL] = binding.workload;
    labels[OWNER_LABEL] = binding.owner;
    labels[TIER_LABEL] = binding.tier;
  }
  return labels;
}

/** An error that carries its gRPC status, via grpc-js's code mapping. */
function statusError(code: number, message: string): Error & { code: number; details: string } {
  const err = new Error(message) as Error & { code: number; details: string };
  err.code = code;
  err.details = message;
  return err;
}

/** An Exec refused by the workload check: PERMISSION_DENIED on the wire. */
function workloadMismatch(message: string): Error & { code: number; details: string } {
  return statusError(status.PERMISSION_DENIED, message);
}

const defaultTimers: RelayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Relay {
  onAttach(stream: AttachStream): void;
  parked(): string[];
  /**
   * Route one Exec to the parked worker and stream its events back.
   *
   * Takes the whole `Exec` message rather than a parameter per field. It used to
   * destructure six of them and rebuild the message, which made every additive
   * proto field a relay change — and silently dropped any field the relay had not
   * been taught about. `workspace_key` was the field that made that concrete: the
   * relay is a bridge keyed by sandbox_id, not a translator (worker DESIGN.md,
   * "No matching in the relay").
   *
   * `opts.workload` is ExecRequest's `workload` (spec §3.3). Checked only when the relay has attach
   * keys: an Exec to a workload sandbox must name that workload, and one naming a workload must
   * target a sandbox bound to it. A mismatch throws PERMISSION_DENIED before the worker sees it.
   */
  routeExec(sandboxId: string, exec: Exec, opts?: { workload?: string }): AsyncIterable<ExecEvent>;
  routeAbort(sandboxId: string, reqId: number): void;
  /**
   * The live worker's Hello.capabilities for `sandboxId`, or undefined when none is attached. The
   * sandbox caller reads it to refuse a process kind before taking a slot (P5-R37); routeExec
   * checks it again at the write.
   */
  workerCapabilities(sandboxId: string): readonly string[] | undefined;
  /**
   * Send one lease operation to the parked worker (lease-mode §8.2) under a fresh `ctlId`, and
   * resolve with the worker's LeaseControlResult for that id. Every call ends: it rejects
   * DEADLINE_EXCEEDED at `timeoutMs` (a worker on code older than lease mode ignores the frame),
   * UNAVAILABLE when there is no live worker, the frame cannot be written or the worker disconnects
   * first, PERMISSION_DENIED for a workload sandbox (the workload check, as routeExec's: a lease
   * call names no workload), and CANCELLED when `signal` aborts (the caller went away). However it
   * settles, its waiter is gone at once, so a later answer for its ctl_id is dropped. A result's
   * own `error` is the caller's to read; this resolves with it.
   */
  routeLeaseControl(
    sandboxId: string,
    f: Omit<LeaseControlFrame, 'ctlId'>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LeaseControlResult>;
  /**
   * Activity on a live lease, without an Exec. Fire-and-forget: a no-op without a live worker, and
   * a write that fails is logged, not thrown. Coalesced: at most one frame per workspace per
   * LEASE_KEEPALIVE_COALESCE_MS, the rest dropped silently. Throws PERMISSION_DENIED only for a
   * workload sandbox (the workload check, as routeLeaseControl's).
   */
  routeKeepalive(sandboxId: string, workspaceKey: string): void;
  /**
   * Graceful stop (#453): refuse every later Hello, run each parked session's teardown and await
   * its record remove and detach mark, then end its stream. A relay stopped without this leaves
   * stale records that turns lease until the worker reattaches, failing inside the turn with `no
   * live worker` instead of answering 503 pending. Never rejects: store failures are logged.
   */
  drain(): Promise<void>;
}

function bearer(md?: { get: (k: string) => string[] }): string | undefined {
  const v = md?.get('authorization')?.[0];
  return v?.startsWith('Bearer ') ? v.slice(7) : undefined;
}

export function createRelay(deps: RelayDeps): Relay {
  const sessions = new Map<string, Parked>();
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => performance.now());
  let draining = false;
  // One ctl_id space for the whole relay, so an id is never reused while any call could hold it.
  let nextCtlId = 0;
  // Every attach stream still open, parked or not. A stream connected but not yet parked (its Hello
  // has not arrived, or never will) holds a server's tryShutdown open just as a parked one does, so
  // drain must end those too (#462 review).
  const open = new Set<AttachStream>();
  function close(stream: AttachStream): void {
    if (open.delete(stream)) stream.end();
  }

  /**
   * Write presence for `session`, retrying until it lands or that session is torn down.
   *
   * One put used to be the whole story, so a Redis that was not reachable at attach time -- on
   * Kubernetes, where setup.sh applies every workload at once, Redis routinely comes up after the
   * sandboxes -- left an attached sandbox missing from sh:sandbox:records for good: the stream stayed
   * up, so the worker never re-Hello'd, and no turn could lease it (#423, Task 16b). RedisRecordStore's
   * client gives up after a bounded reconnect, and the store then reconnects that same client on its
   * next call -- both after a failed first connect and after an established connection was given up
   * on -- so retrying the put is enough.
   *
   * Every attempt first checks that the session map still holds THIS session object, by identity.
   * After teardown it does not, so no attempt starts after teardown's remove: a late write would point
   * turns at a gone worker. A reattach under the same id is a different object, so a stale retry
   * cannot write on its behalf either. An attempt already in flight when teardown runs is ordered
   * before the remove: both go through RedisRecordStore's one client (a re-arm reconnects that client,
   * it never builds a second one), whose command queue is FIFO, so the hSet is queued ahead of the
   * hDel. If the put is still waiting on a reconnect, the remove waits on the same connect promise
   * and is issued after it.
   */
  function putPresence(id: string, session: Parked, rec: SandboxRecord): void {
    let delay = PRESENCE_RETRY_BASE_MS;
    let failures = 0;
    let handle: unknown;
    const live = () => sessions.get(id) === session;
    const attempt = () => {
      handle = undefined;
      if (!live()) return;
      // A synchronous throw from a store is a failed attempt too, not an escape from the retry.
      new Promise<void>((resolve) => resolve(deps.records.put(rec))).then(
        () => {
          if (failures > 0 && live()) {
            console.log(`presence put for ${id} landed after ${failures} failed attempt(s)`);
          }
        },
        (e: unknown) => {
          if (!live()) return;
          failures += 1;
          // One line, message only. RedisRecordStore's errors are already URL-redacted (Task 3).
          const message = e instanceof Error ? e.message : String(e);
          console.error(
            `presence put failed for ${id} (attempt ${failures}, retrying in ${delay} ms): ${message}`,
          );
          handle = timers.setTimeout(attempt, delay);
          delay = Math.min(delay * 2, PRESENCE_RETRY_MAX_MS);
        },
      );
    };
    session.cancelPresence = () => {
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
    };
    attempt();
  }

  function onAttach(stream: AttachStream): void {
    if (draining) {
      stream.end();
      return;
    }
    open.add(stream);
    let sandboxId: string | undefined;
    // The session THIS stream's Hello parked, so teardown acts on it and on nothing else.
    let own: Parked | undefined;
    stream.on('data', (frame: WorkerFrame) => {
      if (frame.hello && !sandboxId) {
        const id = frame.hello.sandboxId;
        // Draining: the stop already removed every record, so a session parked now would write one
        // that nothing removes.
        if (draining) {
          close(stream);
          return;
        }
        const token = bearer(stream.metadata);
        let binding: AttachBinding | undefined;
        if (deps.validateToken(token, id)) {
          // The shared or per-id token. With attach keys configured it cannot take a workload's id.
          if (deps.verifyAttach && WORKLOAD_SANDBOX_ID_RE.test(id)) {
            console.error(`attach refused for ${id}: a workload sandbox id needs an attach token`);
            close(stream);
            return;
          }
        } else if (deps.verifyAttach) {
          const verdict = deps.verifyAttach(token);
          if (!verdict.binding) {
            // Only reported when a token was presented: a missing one is the ordinary bad-token path.
            if (token) console.error(`attach refused for ${id}: ${verdict.reason}`);
            close(stream);
            return;
          }
          if (!idMatchesWorkload(id, verdict.binding)) {
            console.error(
              `attach refused for ${id}: sandbox id is not an ordinal below n of its token's workload`,
            );
            close(stream);
            return;
          }
          binding = verdict.binding;
        } else {
          close(stream); // reject before parking; no presence written
          return;
        }
        if (sessions.has(id)) {
          // Another worker is already live for this sandboxId. Reject the
          // duplicate rather than overwriting the session map: if we let this
          // Hello win, worker-1's later disconnect teardown would call
          // sessions.delete(id) on what is now worker-2's session, evicting
          // the live worker and removing its presence out from under it. A
          // genuine reconnect is unaffected — worker-1's own teardown already
          // ran (removing the old session) before a new Hello can arrive.
          close(stream);
          return;
        }
        sandboxId = id;
        const session: Parked = {
          stream,
          capabilities: [...frame.hello.capabilities],
          sinks: new Map(),
          controls: new Map(),
          keepaliveAtMs: new Map(),
          teardown,
          ...(binding ? { workload: binding.workload } : {}),
        };
        own = session;
        sessions.set(id, session);
        if (binding) armExpiry(session, binding.expiresAtMs);
        const rec: SandboxRecord = {
          sandboxId: id,
          // Without attach keys, exactly as sent (today's behaviour).
          labels: deps.verifyAttach
            ? trustedLabels(frame.hello.labels, binding)
            : frame.hello.labels,
          capabilities: frame.hello.capabilities,
          // Advertised by the worker but not yet consulted for leasing —
          // select-sandbox still leases against its own opts.cap. Wiring
          // capacityMax into leasing decisions is a later slice.
          capacityMax: frame.hello.capacityMax,
          transport: 'grpc',
        };
        // Cleared BEFORE the presence put: both go through the record store's one client, whose queue
        // is FIFO, so the DEL reaches Redis first and no reader sees a present sandbox with a stale mark.
        void deps.detach?.clear(id).catch((e) => console.error('detach mark clear failed', e));
        putPresence(id, session, rec);
        return;
      }
      // chunk/end/error/lease frames are dispatched to the per-reqId sink registered by routeExec
      const parked = sandboxId ? sessions.get(sandboxId) : undefined;
      if (!parked) return;
      if (frame.leaseResult) {
        // Settled once: an answer after the timeout, or a duplicate, finds no waiter.
        parked.controls.get(frame.leaseResult.ctlId)?.resolve(frame.leaseResult);
        return;
      }
      const reqId =
        frame.chunk?.reqId ?? frame.end?.reqId ?? frame.error?.reqId ?? frame.lease?.reqId;
      if (reqId !== undefined) parked.sinks.get(reqId)?.(toExecEvent(frame));
    });
    /**
     * Registered for both 'end' and 'error', and a stream can emit both. Guarded by session
     * identity (#434): only while the map still holds THIS stream's session does teardown act. The
     * second event finds the map empty -- or, if the worker reattached in between, holding the NEW
     * session under the same id, which a by-id teardown used to evict: cancelling its presence
     * retry, failing its execs and removing its record.
     */
    /**
     * No attach stream outlives its token (spec §3.1): at the deadline the session is torn down and
     * the stream ended, so the worker redials and re-reads its token file. Torn down first, as drain
     * does, so its record is gone before the worker can park again. Re-armed across setTimeout's
     * 24.8-day ceiling so a long-lived token is never cut early.
     */
    function armExpiry(session: Parked, deadlineMs: number): void {
      let handle: unknown;
      const arm = () => {
        const left = deadlineMs - Date.now();
        if (left > MAX_TIMER_MS) {
          handle = timers.setTimeout(arm, MAX_TIMER_MS);
          return;
        }
        handle = timers.setTimeout(
          () => {
            handle = undefined;
            if (sessions.get(sandboxId!) !== session) return;
            console.error(`attach stream for ${sandboxId} closed: its attach token expired`);
            void teardown().then(() => close(stream));
          },
          Math.max(0, left),
        );
      };
      session.cancelExpiry = () => {
        if (handle !== undefined) timers.clearTimeout(handle);
        handle = undefined;
      };
      arm();
    }
    function teardown(): Promise<void> {
      if (!sandboxId || !own || sessions.get(sandboxId) !== own) return Promise.resolve();
      const parked = own;
      own = undefined;
      parked.cancelExpiry?.();
      parked.cancelPresence?.();
      // Fail any in-flight execs fast instead of leaving their routeExec
      // generators parked forever on a frame that will never arrive.
      for (const [reqId, sink] of parked.sinks) {
        sink({ error: { reqId, message: 'worker disconnected' } } as ExecEvent);
      }
      // And every lease control waiting on this worker.
      const waiting = [...parked.controls.values()];
      parked.controls.clear();
      for (const c of waiting) c.reject(statusError(status.UNAVAILABLE, 'worker disconnected'));
      sessions.delete(sandboxId);
      const removed = deps.records
        .remove(sandboxId)
        .catch((e) => console.error('presence remove failed', e));
      // After the remove, through the same client: a reader that sees the record gone and no mark
      // yet writes its own (SET-if-absent), which this overwrite then corrects to the true time.
      // Issued now, not after `removed` settles: the client's FIFO queue already orders it.
      const marked = deps.detach
        ?.mark(sandboxId)
        .catch((e) => console.error('detach mark write failed', e));
      return Promise.all([removed, marked]).then(() => {});
    }
    stream.on('end', () => {
      open.delete(stream);
      void teardown();
    });
    stream.on('error', () => {
      open.delete(stream);
      void teardown();
    });
  }

  async function* routeExec(
    sandboxId: string,
    exec: Exec,
    opts: { workload?: string } = {},
  ): AsyncGenerator<ExecEvent> {
    const reqId = exec.reqId;
    const parked = sessions.get(sandboxId);
    if (!parked) throw new Error(`no live worker for sandbox '${sandboxId}'`);
    if (deps.verifyAttach) {
      const want = opts.workload ?? '';
      const have = parked.workload ?? '';
      if (have && want !== have) {
        throw workloadMismatch(
          `sandbox '${sandboxId}' belongs to a workload this Exec does not name`,
        );
      }
      if (!have && want) {
        throw workloadMismatch(
          `sandbox '${sandboxId}' belongs to no workload; this Exec names one`,
        );
      }
    }

    // P5-R37: checked against the worker this Exec is written to, so a worker that attached after
    // the sandbox caller's own check cannot be handed a kind it would run as a command. An unset
    // kind goes out as 0, a command, so it is one here too.
    const kind = exec.kind ?? ExecKind.EXEC_KIND_COMMAND;
    if (
      kind !== ExecKind.EXEC_KIND_COMMAND &&
      !parked.capabilities.includes(LEASE_PROCESSES_CAPABILITY)
    ) {
      throw statusError(status.FAILED_PRECONDITION, WORKER_WITHOUT_PROCESSES);
    }

    if (parked.sinks.has(reqId))
      throw new Error(
        `req_id ${reqId} already in flight for sandbox '${sandboxId}': refusing to overwrite the live sink (a collision would detach the first caller and interleave both execs' output — see #179)`,
      );

    const queue: ExecEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    parked.sinks.set(reqId, (ev) => {
      queue.push(ev);
      if (ev.end || ev.error) done = true;
      notify?.();
    });

    parked.stream.write({ exec } as ServerFrame);

    try {
      while (true) {
        while (queue.length) {
          const ev = queue.shift()!;
          yield ev;
          if (ev.end || ev.error) return;
        }
        if (done) return;
        await new Promise<void>((r) => (notify = r));
      }
    } finally {
      parked.sinks.delete(reqId);
    }
  }

  function routeAbort(sandboxId: string, reqId: number): void {
    sessions.get(sandboxId)?.stream.write({ abort: { reqId } } as ServerFrame);
  }

  function routeLeaseControl(
    sandboxId: string,
    f: Omit<LeaseControlFrame, 'ctlId'>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LeaseControlResult> {
    const parked = sessions.get(sandboxId);
    if (!parked) {
      return Promise.reject(
        statusError(status.UNAVAILABLE, `no live worker for sandbox '${sandboxId}'`),
      );
    }
    const refused = leaseOnWorkload(sandboxId, parked, 'lease control');
    if (refused) return Promise.reject(refused);
    if (signal?.aborted) {
      return Promise.reject(statusError(status.CANCELLED, 'lease control cancelled'));
    }
    const ctlId = ++nextCtlId;
    return new Promise<LeaseControlResult>((resolve, reject) => {
      let handle: unknown;
      // Every way out goes through here: the waiter, the timer and the abort listener all go at once.
      const settle = () => {
        if (parked.controls.get(ctlId) === entry) parked.controls.delete(ctlId);
        timers.clearTimeout(handle);
        signal?.removeEventListener('abort', onAbort);
      };
      const entry: PendingControl = {
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      };
      const onAbort = () => entry.reject(statusError(status.CANCELLED, 'lease control cancelled'));
      parked.controls.set(ctlId, entry);
      handle = timers.setTimeout(
        () =>
          entry.reject(
            statusError(
              status.DEADLINE_EXCEEDED,
              `the worker did not answer the lease control within ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort);
      try {
        // fromPartial: ts-proto's encode throws on a message literal missing a field.
        parked.stream.write({
          leaseControl: LeaseControlFrame.fromPartial({ ...f, ctlId }),
        } as ServerFrame);
      } catch (err) {
        entry.reject(
          statusError(
            status.UNAVAILABLE,
            `lease control not sent to the worker: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  function routeKeepalive(sandboxId: string, workspaceKey: string): void {
    const parked = sessions.get(sandboxId);
    if (!parked) return;
    const refused = leaseOnWorkload(sandboxId, parked, 'lease keepalive');
    if (refused) throw refused;
    const t = now();
    const last = parked.keepaliveAtMs.get(workspaceKey);
    if (last !== undefined && t - last < LEASE_KEEPALIVE_COALESCE_MS) return;
    try {
      parked.stream.write({
        keepalive: LeaseKeepaliveFrame.fromPartial({ workspaceKey }),
      } as ServerFrame);
      // Only a frame written opens a window: after a failed write the next keepalive tries again.
      // Entries past their window go too, so the map holds only workspaces active in the last one.
      for (const [k, at] of parked.keepaliveAtMs) {
        if (t - at >= LEASE_KEEPALIVE_COALESCE_MS) parked.keepaliveAtMs.delete(k);
      }
      parked.keepaliveAtMs.set(workspaceKey, t);
    } catch (err) {
      // Fire-and-forget: the caller is answered OK either way, and a stream this broken is torn
      // down by its own end or error event.
      console.error(
        `lease keepalive not sent to sandbox '${sandboxId}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The lease routes' half of routeExec's workload check (SBX0 §3.3): their only callers are
   * sandbox-token callers, which name no workload, so a workload sandbox refuses them, as it
   * refuses an Exec that names none. Checked only with attach keys, as routeExec's is.
   */
  function leaseOnWorkload(
    sandboxId: string,
    parked: Parked,
    what: string,
  ): (Error & { code: number; details: string }) | undefined {
    if (!deps.verifyAttach || !parked.workload) return undefined;
    return workloadMismatch(`${what} not permitted: sandbox '${sandboxId}' belongs to a workload`);
  }

  async function drain(): Promise<void> {
    draining = true;
    const parked = [...sessions.values()];
    const parkedStreams = new Set(parked.map((p) => p.stream));
    // Unparked streams have no record to remove, so they end at once.
    for (const stream of [...open]) if (!parkedStreams.has(stream)) close(stream);
    await Promise.all(
      parked.map(async (p) => {
        await p.teardown();
        // Ended only after the record is gone, so the worker cannot reattach (to a successor
        // relay) while this one's remove is still queued behind its new put.
        close(p.stream);
      }),
    );
  }

  return {
    onAttach,
    parked: () => [...sessions.keys()],
    routeExec,
    routeAbort,
    workerCapabilities: (id) => sessions.get(id)?.capabilities,
    routeLeaseControl,
    routeKeepalive,
    drain,
  };
}

/** Map a worker→relay frame to the harness-facing ExecEvent oneof (Task 6 uses this). */
export function toExecEvent(frame: WorkerFrame): ExecEvent {
  if (frame.chunk) return { chunk: frame.chunk } as ExecEvent;
  if (frame.end) return { end: frame.end } as ExecEvent;
  if (frame.lease) return { lease: frame.lease } as ExecEvent;
  return { error: frame.error } as ExecEvent;
}
