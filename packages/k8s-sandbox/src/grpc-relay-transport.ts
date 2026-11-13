import {
  CAPACITY_REFUSAL,
  DEFAULT_EXEC_TIMEOUT_S,
  DEFAULT_OUTPUT_CAP,
  OUTPUT_TRUNCATED_MARKER,
  SandboxCapacityRefusedError,
  type SandboxTransport,
} from './transport.js';
import { makeReqIdSource } from './req-id.js';
import {
  Exec,
  Stream,
  type AbortRequest,
  type ExecEvent,
  type ExecRequest,
} from './gen/sandbox/v1/sandbox.js';

/** Minimal surface of the generated SandboxExecClient the transport needs. */
export interface ExecClientLike {
  exec(request: ExecRequest): {
    on(event: 'data', cb: (ev: ExecEvent) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    cancel(): void;
  };
  abort(request: AbortRequest, cb: (err: Error | null) => void): unknown;
  /** Closes the underlying gRPC channel. Optional: scripted test fakes omit it. */
  close?(): void;
}

/**
 * One source per process, so every transport instance in this replica draws from the
 * same salted space. Injectable via opts.reqIdSource for tests.
 */
const defaultReqIdSource = makeReqIdSource();

// Was a local 120_000 -- two minutes, where both other transports applied no ceiling at all.
// Now the shared one (#182), so a caller that names no timeout gets the same budget whichever
// transport serves it. Still overridable per-instance via opts.deadlineMs.
const DEFAULT_DEADLINE_MS = DEFAULT_EXEC_TIMEOUT_S * 1000;

export function GrpcRelayTransport(
  sandboxId: string,
  client: ExecClientLike,
  opts: {
    deadlineMs?: number;
    outputCapBytes?: number;
    reqIdSource?: () => number;
    /**
     * The lease's run id, sent on every Exec as `workspace_key` (spec §3.4).
     * vmpool keys a per-run host-side workspace on it. Omitted (or '') means
     * "today's single shared workspace" on the container path; microvm-worker
     * refuses it, because on the VM path there is nothing to fall back to.
     */
    workspaceKey?: string;
    /**
     * The workload key the run names, sent as ExecRequest's `workload` (workload sandboxes spec
     * §3.3). Omitted (or '') for a shared-pool run. Only a relay with attach keys reads it.
     */
    workload?: string;
  } = {},
): SandboxTransport {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const outputCap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  const nextReqId = opts.reqIdSource ?? defaultReqIdSource;
  let closed = false;

  const exec: SandboxTransport['exec'] = (command, execOpts = {}) =>
    new Promise((resolve, reject) => {
      const reqId = nextReqId();
      const call = client.exec({
        sandboxId,
        workload: opts.workload ?? '',
        exec: Exec.fromPartial({
          reqId,
          command,
          stdin: execOpts.stdin ? new Uint8Array(execOpts.stdin) : new Uint8Array(),
          // The ceiling goes on the wire too, not just on our own timer. This is the one
          // transport whose process is remote: on the two kubectl paths the timer and the
          // child share a process, so the ceiling cannot be orphaned, but here a harness
          // that exits -- or a dropped connection, or an `abort` that never lands -- would
          // leave the remote process running with nothing left to stop it. `timeoutS: 0`
          // means "no timeout" to the worker (runner.go arms its timer only when > 0), so
          // sending 0 for the unspecified case handed away exactly the slot leak
          // DEFAULT_EXEC_TIMEOUT_S exists to prevent. Both ends now hold the same budget
          // independently, and an explicit `timeout: 0` still means unbounded on both.
          timeoutS: execOpts.timeout ?? DEFAULT_EXEC_TIMEOUT_S,
          streaming: true,
          // The lease's run id, or '' when the caller supplied none (today's behaviour
          // for every caller not on the microVM path, e.g. the container worker, which
          // ignores this field entirely). See the opts.workspaceKey doc comment above.
          workspaceKey: opts.workspaceKey ?? '',
        }),
      });

      const stdout: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let truncated = false;

      const finish = (fn: () => void) => {
        if (settled) return; // dedup: drop late frames for a settled reqId
        settled = true;
        clearTimeout(timer);
        if (execOpts.signal) execOpts.signal.removeEventListener('abort', onAbort);
        fn();
      };

      // Absent => the instance deadline (the shared ceiling unless opts.deadlineMs overrode
      // it); an explicit 0 means "no timeout at all", as on the other two transports (#182).
      //
      // The timer stays in milliseconds. Deriving it from the seconds label instead would
      // quantize deadlineMs -- a sub-second deadlineMs (the tests use 500) rounds to a whole
      // second and the timer fires late or not at all.
      const timeoutMs = execOpts.timeout !== undefined ? execOpts.timeout * 1000 : deadlineMs;
      const timeoutLabelS = execOpts.timeout ?? Math.round(deadlineMs / 1000);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              call.cancel();
              client.abort({ sandboxId, reqId }, () => {});
              finish(() => reject(new Error(`timeout:${timeoutLabelS}`)));
            }, timeoutMs)
          : undefined;

      const onAbort = () => {
        call.cancel();
        client.abort({ sandboxId, reqId }, () => {});
        finish(() => reject(new Error('aborted')));
      };
      if (execOpts.signal) {
        if (execOpts.signal.aborted) return onAbort();
        execOpts.signal.addEventListener('abort', onAbort);
      }

      call.on('data', (ev: ExecEvent) => {
        if (settled) return;
        if (ev.chunk) {
          const data = Buffer.from(ev.chunk.data);
          execOpts.onData?.(data);
          if (ev.chunk.stream !== Stream.STREAM_STDERR) {
            if (!truncated) {
              stdout.push(data);
              bytes += data.length;
              if (bytes > outputCap) {
                truncated = true;
                stdout.push(Buffer.from(OUTPUT_TRUNCATED_MARKER));
                call.cancel();
                client.abort({ sandboxId, reqId }, () => {});
                finish(() =>
                  resolve({ stdout: Buffer.concat(stdout), exitCode: null, truncated: true }),
                );
              }
            }
          }
        } else if (ev.end) {
          // The WORKER cut its own output at BufferCap and says so (#189). We cannot
          // detect this: BufferCap is the same 8 MiB as our cap and the trip above is
          // strictly-greater, so exactly-cap output never fires it. Honour the seam
          // invariant here rather than passing the worker's real exit code through --
          // `truncated === true ⇒ exitCode === null` (spec §8) is what lets a caller
          // tell "cut short" from "finished", and Pi reads the marker out of stdout.
          if (ev.end.truncated) {
            stdout.push(Buffer.from(OUTPUT_TRUNCATED_MARKER));
            finish(() =>
              resolve({ stdout: Buffer.concat(stdout), exitCode: null, truncated: true }),
            );
            return;
          }
          const code = ev.end.exitCode < 0 ? null : ev.end.exitCode;
          finish(() =>
            resolve({ stdout: Buffer.concat(stdout), exitCode: code, truncated: false }),
          );
        } else if (ev.error) {
          // A CAPACITY REFUSAL IS NOT A COMMAND FAILURE (#452). Both arrive in this one
          // frame because the wire has no "busy" form (CAPACITY_REFUSAL explains why),
          // so this is the only place the two can still be told apart — and the only
          // place the message is still the signal. Above here it is a type.
          //
          // Rejecting with a plain Error made `memory-budget: committing 301989888 more
          // bytes ...` the bash tool's OUTPUT: operations.ts hands it to Pi's bash.ts,
          // which bare-rethrows anything that is not 'aborted'/'timeout:', and Pi's
          // agent loop turns a tool throw into `isError: true` content and KEEPS GOING.
          // So the model read the host's admission-control arithmetic as its command's
          // result, the turn ended `end_turn`, and the 503 the harness has machinery for
          // was never produced.
          const message = ev.error.message;
          finish(() =>
            reject(
              CAPACITY_REFUSAL.test(message)
                ? new SandboxCapacityRefusedError(message)
                : new Error(message),
            ),
          );
        }
      });
      call.on('error', (err: Error) => finish(() => reject(err)));
      // Stream ended with no End frame: no exit status, and NOT our cap.
      call.on('end', () =>
        finish(() => resolve({ stdout: Buffer.concat(stdout), exitCode: null, truncated: false })),
      );
    });

  return {
    // Every exec is its own `SandboxExec.Exec` RPC, which the relay bridges onto the
    // worker's Attach stream and the worker answers with a fresh `bash -c`
    // (remote-worker/internal/exec/runner.go). There is no long-lived shell concept on the
    // wire — `Exec` is one command per RPC — so N fast ops cost N round trips and N
    // processes (#245). Giving THIS transport a fast tier needs a proto change, not a
    // parameterized argv; see the issue.
    fastTier: 'per-call-exec',
    exec,
    async close() {
      if (closed) return; // idempotent; per-exec calls own their own stream lifecycle
      closed = true;
      client.close?.(); // safe no-op for scripted fakes that don't implement close()
    },
  };
}
