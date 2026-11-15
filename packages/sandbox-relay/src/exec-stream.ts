import { status, type ServerWritableStream } from '@grpc/grpc-js';
import { Stream, type End, type Exec, type ExecEvent, type ExecRequest } from '@moca/k8s-sandbox';
import type { Relay } from './relay.js';

// The Exec stream primitives every caller kind shares: how a call ends non-OK, and how one Exec is
// pumped from its worker to its caller.

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
export function failExecStream(
  call: ServerWritableStream<ExecRequest, ExecEvent>,
  err: Error,
): void {
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
export function execStreamError(message: string): Error {
  return grpcError(status.INTERNAL, message);
}

/** How a pumped Exec's events and failures reach its caller. The defaults are the harness's. */
export interface PumpOpts {
  /** Rewrites each event before it is written (a sandbox caller's req_id; SBX0 §3.6). */
  toCaller?: (ev: ExecEvent) => ExecEvent;
  /** Rewrites a routing failure before it becomes the call's status. */
  mapError?: (err: Error) => Error;
  /** True once the call was already ended (a sandbox token expiring): drain, write nothing. */
  over?: () => boolean;
  /** Runs when the client cancels the call, at once: the worker may never acknowledge the Abort. */
  onCancelled?: () => void;
  /**
   * Filled in as the Exec runs and returned at the end. Passed in by a caller that must read it
   * before the drain finishes (a sandbox Exec's expiry line).
   */
  result?: PumpResult;
  /** The caller's ExecRequest.workload, for the relay's workload check (workload sandboxes §3.3). */
  workload?: string;
}

/**
 * How a pumped Exec went, for its audit line (SBX0 §3.5). Never the output itself.
 * None of `end`, `execError` and `cancelled` set means routing threw (no live worker, a collision).
 */
export interface PumpResult {
  /** Stdout bytes written to the caller (stderr is not counted). */
  outBytes: number;
  /** The worker's End, when it sent one. */
  end?: End;
  /** The worker's in-stream ExecError message, when it sent one (it may be empty). */
  execError?: string;
  /** The client cancelled the call. */
  cancelled: boolean;
  /** What routing threw, when it did (no live worker, a collision, a refused kind). */
  thrown?: Error;
}

export function newPumpResult(): PumpResult {
  return { outBytes: 0, cancelled: false };
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
export async function pumpExec(
  call: ServerWritableStream<ExecRequest, ExecEvent>,
  relay: Relay,
  sandboxId: string,
  exec: Exec,
  opts: PumpOpts = {},
): Promise<PumpResult> {
  const result = opts.result ?? newPumpResult();
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
    result.cancelled = true;
    relay.routeAbort(sandboxId, exec.reqId);
    opts.onCancelled?.();
  };
  call.on('cancelled', onCancelled);

  try {
    // Tracked as a flag, not by testing the message text: an ExecEvent.error with an
    // EMPTY message is still a failing Exec, and classifying on `message` alone would
    // silently re-admit it as a success (the Go exec-driver learned the same lesson --
    // see its sawErr note in cmd/exec-driver/drive.go).
    let sawExecError = false;
    let execErrorMessage = '';
    for await (const ev of relay.routeExec(sandboxId, exec, { workload: opts.workload })) {
      if (over()) continue;
      call.write(toCaller(ev));
      if (ev.chunk && ev.chunk.stream !== Stream.STREAM_STDERR)
        result.outBytes += ev.chunk.data.length;
      if (ev.end) result.end = ev.end;
      if (ev.error) {
        sawExecError = true;
        execErrorMessage = ev.error.message ?? '';
        result.execError = execErrorMessage;
      }
    }
    if (over()) return result;
    // A failed Exec must not terminate OK (#295). routeExec returns normally after
    // yielding an error event, so ending here would report success for a command that
    // never ran: it would count toward throughput, enter p95, and never be classified
    // as an error by a client that reads only the terminal status.
    if (sawExecError && !cancelled) {
      failExecStream(call, execStreamError(execErrorMessage));
      return result;
    }
    call.end();
  } catch (err) {
    result.thrown = err as Error;
    if (over()) return result;
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
  return result;
}

/** The same event with its req_id replaced, whichever oneof it carries. */
export function withReqId(ev: ExecEvent, reqId: number): ExecEvent {
  if (ev.chunk) return { chunk: { ...ev.chunk, reqId } };
  if (ev.end) return { end: { ...ev.end, reqId } };
  if (ev.error) return { error: { ...ev.error, reqId } };
  if (ev.lease) return { lease: { ...ev.lease, reqId } };
  return ev;
}
