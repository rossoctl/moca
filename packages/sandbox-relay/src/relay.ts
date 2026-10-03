import type { RecordStore, SandboxRecord } from '@moca/harness';
import type { Exec, ExecEvent, ServerFrame, WorkerFrame } from '@moca/k8s-sandbox';

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

export interface RelayDeps {
  records: RecordStore;
  validateToken: (token: string | undefined, sandboxId: string) => boolean;
  /** Defaults to the global timers. */
  timers?: RelayTimers;
}

interface Parked {
  stream: AttachStream;
  // per-reqId sinks for in-flight execs, populated by routeExec
  sinks: Map<number, (ev: ExecEvent) => void>;
  // Cancels a pending presence-put retry; set by Hello, called by teardown.
  cancelPresence?: () => void;
}

/** Presence-put backoff: 250 ms, doubling, capped at 10 s, with no attempt limit (#423, Task 16b). */
const PRESENCE_RETRY_BASE_MS = 250;
const PRESENCE_RETRY_MAX_MS = 10_000;

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
   */
  routeExec(sandboxId: string, exec: Exec): AsyncIterable<ExecEvent>;
  routeAbort(sandboxId: string, reqId: number): void;
}

function bearer(md?: { get: (k: string) => string[] }): string | undefined {
  const v = md?.get('authorization')?.[0];
  return v?.startsWith('Bearer ') ? v.slice(7) : undefined;
}

export function createRelay(deps: RelayDeps): Relay {
  const sessions = new Map<string, Parked>();
  const timers = deps.timers ?? defaultTimers;

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
    let sandboxId: string | undefined;
    stream.on('data', (frame: WorkerFrame) => {
      if (frame.hello && !sandboxId) {
        const id = frame.hello.sandboxId;
        if (!deps.validateToken(bearer(stream.metadata), id)) {
          stream.end(); // reject before parking; no presence written
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
          stream.end();
          return;
        }
        sandboxId = id;
        const session: Parked = { stream, sinks: new Map() };
        sessions.set(id, session);
        const rec: SandboxRecord = {
          sandboxId: id,
          labels: frame.hello.labels,
          capabilities: frame.hello.capabilities,
          // Advertised by the worker but not yet consulted for leasing —
          // select-sandbox still leases against its own opts.cap. Wiring
          // capacityMax into leasing decisions is a later slice.
          capacityMax: frame.hello.capacityMax,
          transport: 'grpc',
        };
        putPresence(id, session, rec);
        return;
      }
      // chunk/end/error frames are dispatched to the per-reqId sink registered by routeExec
      const parked = sandboxId ? sessions.get(sandboxId) : undefined;
      if (!parked) return;
      const reqId = frame.chunk?.reqId ?? frame.end?.reqId ?? frame.error?.reqId;
      if (reqId !== undefined) parked.sinks.get(reqId)?.(toExecEvent(frame));
    });
    const teardown = () => {
      if (sandboxId) {
        // Fail any in-flight execs fast instead of leaving their routeExec
        // generators parked forever on a frame that will never arrive.
        const parked = sessions.get(sandboxId);
        if (parked) {
          parked.cancelPresence?.();
          for (const [reqId, sink] of parked.sinks) {
            sink({ error: { reqId, message: 'worker disconnected' } } as ExecEvent);
          }
        }
        sessions.delete(sandboxId);
        void deps.records
          .remove(sandboxId)
          .catch((e) => console.error('presence remove failed', e));
      }
    };
    stream.on('end', teardown);
    stream.on('error', teardown);
  }

  async function* routeExec(sandboxId: string, exec: Exec): AsyncGenerator<ExecEvent> {
    const reqId = exec.reqId;
    const parked = sessions.get(sandboxId);
    if (!parked) throw new Error(`no live worker for sandbox '${sandboxId}'`);

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

  return { onAttach, parked: () => [...sessions.keys()], routeExec, routeAbort };
}

/** Map a worker→relay frame to the harness-facing ExecEvent oneof (Task 6 uses this). */
export function toExecEvent(frame: WorkerFrame): ExecEvent {
  if (frame.chunk) return { chunk: frame.chunk } as ExecEvent;
  if (frame.end) return { end: frame.end } as ExecEvent;
  return { error: frame.error } as ExecEvent;
}
