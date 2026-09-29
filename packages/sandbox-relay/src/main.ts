import {
  Server,
  ServerCredentials,
  status,
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
import { RedisRecordStore } from '@moca/harness';
import { createRelay, type RelayDeps, type AttachStream } from './relay.js';

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

export function buildServer(deps: RelayDeps): { server: Server } {
  const relay = createRelay(deps);
  // Raise the ingress limit above gRPC's 4 MiB default. This is the hop that rejects an
  // oversized write today: the harness's ExecRequest carries base64 stdin at 4/3 of the
  // file, so a file the read path can return (DEFAULT_OUTPUT_CAP, 8 MiB) needs ~10.7 MiB
  // here. MAX_EXEC_MESSAGE_BYTES is shared with the Go worker's session.MaxRecvMsgBytes
  // and pinned equal to it — a relay that accepts more than the worker would forward a
  // payload the worker refuses on its Attach stream, killing every exec on it (#173 item 2).
  const server = new Server({ 'grpc.max_receive_message_length': MAX_EXEC_MESSAGE_BYTES });

  const workerImpl: SandboxWorkerServer = {
    // AttachStream types metadata.get() as returning string[]; grpc-js's real
    // Metadata.get() returns MetadataValue[] (string | Buffer). The relay only
    // ever reads a bearer token (always sent as a string by well-behaved
    // clients), so the cast is safe here without widening relay.ts's contract.
    attach: (call: ServerDuplexStream<WorkerFrame, ServerFrame>) =>
      relay.onAttach(call as unknown as AttachStream),
  };
  server.addService(SandboxWorkerService, workerImpl);

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
      relay.routeAbort(call.request.sandboxId, call.request.reqId);
      cb(null, {});
    },
  };
  server.addService(SandboxExecService, execImpl);

  return { server };
}

/**
 * Default token validator: fail-closed. A sandbox authenticates only against
 * an exact, non-empty match on its per-sandbox override (`SH_RELAY_TOKEN_<id>`)
 * or the global `SH_RELAY_TOKEN`. If neither env var is set for a sandbox,
 * `expected` is `undefined` and every token — including an undefined one from
 * a tokenless worker — is rejected, instead of the two `undefined`s comparing
 * equal.
 */
export function makeDefaultValidateToken(
  env: NodeJS.ProcessEnv,
): (token: string | undefined, sandboxId: string) => boolean {
  return (token, sandboxId) => {
    const expected = env[`SH_RELAY_TOKEN_${sandboxId}`] ?? env.SH_RELAY_TOKEN;
    return expected !== undefined && token === expected;
  };
}

export async function startRelay(
  opts: { port?: number; deps?: RelayDeps } = {},
): Promise<{ port: number; shutdown: () => Promise<void> }> {
  const deps = opts.deps ?? {
    records: new RedisRecordStore(),
    validateToken: makeDefaultValidateToken(process.env),
  };
  const { server } = buildServer(deps);
  const addr = `0.0.0.0:${opts.port ?? Number(process.env.SH_RELAY_PORT ?? 8443)}`;
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(addr, ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  return { port, shutdown: () => new Promise((r) => server.tryShutdown(() => r())) };
}

// Bootstrap when run directly (tsx entrypoint), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  startRelay().then(({ port }) => console.log(`sandbox-relay listening on :${port}`));
}
