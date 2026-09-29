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

export interface RelayDeps {
  records: RecordStore;
  validateToken: (token: string | undefined, sandboxId: string) => boolean;
}

interface Parked {
  stream: AttachStream;
  // per-reqId sinks for in-flight execs, populated by routeExec
  sinks: Map<number, (ev: ExecEvent) => void>;
}

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
        sessions.set(id, { stream, sinks: new Map() });
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
        void deps.records.put(rec).catch((e) => console.error('presence put failed', e));
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
