import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runConformance, type FakeBehavior, type TransportFactory } from './conformance.js';
import { GrpcRelayTransport, type ExecClientLike } from '../src/grpc-relay-transport.js';
import {
  DEFAULT_EXEC_TIMEOUT_S,
  OUTPUT_TRUNCATED_MARKER,
  SandboxCapacityRefusedError,
} from '../src/transport.js';
import {
  Stream,
  type AbortRequest,
  type ExecEvent,
  type ExecRequest,
} from '../src/gen/sandbox/v1/sandbox.js';

/** Build a fake ExecClientLike that scripts a FakeBehavior onto ExecEvent frames. */
function fakeClient(behavior: FakeBehavior): {
  client: ExecClientLike;
  stdinSeen: () => Buffer | undefined;
  aborted: () => number[];
  reqIdSeen: () => number | undefined;
} {
  let stdin: Buffer | undefined;
  let lastReqId: number | undefined;
  const aborted: number[] = [];
  const client: ExecClientLike = {
    exec(request: ExecRequest) {
      stdin = request.exec ? Buffer.from(request.exec.stdin) : undefined;
      const reqId = request.exec?.reqId ?? 0;
      lastReqId = reqId;
      const stream = new EventEmitter() as EventEmitter & { cancel: () => void };
      stream.cancel = () => {};
      // Emit scripted frames on the next tick so listeners attach first.
      queueMicrotask(() => {
        if (behavior.hang) return; // never completes
        for (const s of behavior.stdout ?? [])
          stream.emit('data', {
            chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDOUT },
          } as ExecEvent);
        for (const s of behavior.stderr ?? [])
          stream.emit('data', {
            chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDERR },
          } as ExecEvent);
        stream.emit('data', { end: { reqId, exitCode: behavior.exitCode ?? 0 } } as ExecEvent);
        stream.emit('end');
      });
      return stream;
    },
    abort(request: AbortRequest, cb: (err: Error | null) => void) {
      aborted.push(request.reqId);
      cb(null);
      return {};
    },
  };
  return { client, stdinSeen: () => stdin, aborted: () => aborted, reqIdSeen: () => lastReqId };
}

const grpcFactory: TransportFactory = (behavior, opts) => {
  const { client, stdinSeen, aborted, reqIdSeen } = fakeClient(behavior);
  const transport = GrpcRelayTransport('sbx-1', client, { outputCapBytes: opts?.outputCapBytes });
  return {
    transport,
    stdinSeen,
    // On this wire, stopping the producer means an Abort naming the exec's own req_id —
    // the relay routes the abort by that id, so an Abort for any other id would leave the
    // flood running. Correlate rather than just counting calls.
    producerStop: () => {
      const id = reqIdSeen();
      return id !== undefined && aborted().includes(id) ? 'remote-abort' : 'none';
    },
  };
};

runConformance('GrpcRelayTransport', grpcFactory, {
  producerStop: 'remote-abort',
  streams: true,
  // `rpc Exec` is ONE command per RPC and the worker answers each with a fresh `bash -c`,
  // so N fast ops cost N round trips and N processes (#245). This is the transport the
  // issue is about: giving it a fast tier needs a sandbox.proto change, not a flag here.
  fastTier: 'per-call-exec',
});

function manualClient() {
  let stream!: EventEmitter & { cancel: () => void };
  // The transport draws reqId from a salted per-process source (shared with every
  // other exec() call made earlier in this test file, e.g. the runConformance
  // battery above), so the id it actually uses is an unpredictable salt-plus-counter
  // value, not a literal we can predict. Capture it from the request
  // GrpcRelayTransport hands to exec() so assertions can compare against the
  // real id instead of guessing it.
  let lastReqId: number | undefined;
  let lastTimeoutS: number | undefined;
  const aborted: number[] = [];
  const client = {
    exec(request?: { exec?: { reqId: number; timeoutS?: number } }) {
      lastReqId = request?.exec?.reqId;
      lastTimeoutS = request?.exec?.timeoutS;
      stream = Object.assign(new EventEmitter(), { cancel: () => {} });
      return stream;
    },
    abort(req: { reqId: number }, cb: (e: Error | null) => void) {
      aborted.push(req.reqId);
      cb(null);
      return {};
    },
  };
  return {
    client,
    emit: (ev: ExecEvent) => stream.emit('data', ev),
    aborted: () => aborted,
    reqId: () => lastReqId,
    timeoutS: () => lastTimeoutS,
  };
}

describe('GrpcRelayTransport extra semantics', () => {
  // The shared battery pins what the CALLER observes, which cannot distinguish a ceiling both
  // ends enforce from one only we do. These three pin the wire value, because the difference
  // only shows up when the harness is no longer around to enforce its own timer: the worker
  // arms a timeout solely when timeout_s > 0 (remote-worker/internal/exec/runner.go), so a 0
  // here means a dropped connection or a dead harness leaves the remote process running
  // forever -- the slot leak DEFAULT_EXEC_TIMEOUT_S exists to prevent (#182).
  it('sends the shared ceiling as timeout_s when the caller names no timeout', async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999').catch(() => {});
    expect(timeoutS()).toBe(DEFAULT_EXEC_TIMEOUT_S);
  });

  it("sends the caller's own timeout_s verbatim when one is given", async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999', { timeout: 7 }).catch(() => {});
    expect(timeoutS()).toBe(7);
  });

  it('sends 0 for an explicit timeout: 0, so unbounded stays unbounded on both ends', async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999', { timeout: 0 }).catch(() => {});
    expect(timeoutS()).toBe(0);
  });

  it("the cap's Abort names the exec's own req_id", async () => {
    // The shared battery only asks "was the producer stopped". Here we pin the wire
    // detail the battery cannot express portably: the relay routes an Abort by req_id,
    // so an Abort carrying any other id would leave the flood running at full rate
    // while this exec has already stopped reading (spec §8).
    const { client, emit, aborted, reqId } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never, { outputCapBytes: 6 });
    const p = t.exec('cat big');
    await Promise.resolve(); // let exec() register its handlers
    emit({
      chunk: { reqId: reqId()!, data: Buffer.from('aaaabbbb'), stream: Stream.STREAM_STDOUT },
    } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toContain('[output truncated]');
    expect(aborted()).toContain(reqId());
  });

  // #189. This is the one truncation the harness cannot detect for itself: the Go
  // worker's BufferCap is the SAME 8 MiB as DEFAULT_OUTPUT_CAP and our own trip is
  // `bytes > cap`, strictly greater, so a worker that cut its output and delivered
  // exactly the cap looks complete. Only End.truncated distinguishes it, and no
  // first-party client can reach the path — `streaming: true` is hardcoded above —
  // so this scripted frame is the artifact that makes the defect observable at all.
  it('a worker-truncated End resolves as truncated with a null exit code', async () => {
    const { client, emit, reqId } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    const p = t.exec('cat huge');
    await Promise.resolve();
    emit({
      chunk: { reqId: reqId()!, data: Buffer.from('partial'), stream: Stream.STREAM_STDOUT },
    } as ExecEvent);
    // The worker reports the command's REAL status alongside the flag; honouring the
    // seam invariant `truncated ⇒ exitCode === null` is this transport's job.
    emit({ end: { reqId: reqId()!, exitCode: 0, truncated: true } } as ExecEvent);

    const r = await p;
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.stdout.toString()).toBe(`partial${OUTPUT_TRUNCATED_MARKER}`);
  });

  it('dedups: a late End for a settled reqId is dropped', async () => {
    const { client, emit } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    const p = t.exec('echo hi');
    emit({
      chunk: { reqId: 1, data: Buffer.from('hi'), stream: Stream.STREAM_STDOUT },
    } as ExecEvent);
    emit({ end: { reqId: 1, exitCode: 0 } } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toBe('hi');
    // A duplicate terminal frame after settlement must not throw or change the result.
    expect(() => emit({ end: { reqId: 1, exitCode: 9 } } as ExecEvent)).not.toThrow();
  });

  it('harness deadline fires independently of worker timeout_s', async () => {
    vi.useFakeTimers();
    const { client } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never, { deadlineMs: 500 });
    const p = t.exec('sleep 999'); // no exec opts.timeout ⇒ deadlineMs governs
    const assertion = expect(p).rejects.toThrow(/^timeout:/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    vi.useRealTimers();
  });

  it('close() closes the underlying gRPC channel via client.close()', async () => {
    const { client } = manualClient();
    const closeSpy = vi.fn();
    (client as unknown as { close: () => void }).close = closeSpy;
    const t = GrpcRelayTransport('sbx-1', client as never);
    await t.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent: calling it twice closes the channel at most once', async () => {
    const { client } = manualClient();
    const closeSpy = vi.fn();
    (client as unknown as { close: () => void }).close = closeSpy;
    const t = GrpcRelayTransport('sbx-1', client as never);
    await t.close();
    await t.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() is a safe no-op when the client exposes no close() (scripted fakes)', async () => {
    const { client } = manualClient(); // manualClient's fake has no `close` method
    const t = GrpcRelayTransport('sbx-1', client as never);
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe('GrpcRelayTransport workspace key (spec §3.4)', () => {
  // fakeClient's exec() auto-scripts an immediate End{exitCode: 0} via queueMicrotask
  // (the file's existing "ending stream" shape, used by runConformance above); we wrap
  // it only to observe the workspaceKey field on each outgoing ExecRequest.
  function captureWorkspaceKeys(): { client: ExecClientLike; keys: (string | undefined)[] } {
    const { client: inner } = fakeClient({ exitCode: 0 });
    const keys: (string | undefined)[] = [];
    const client: ExecClientLike = {
      ...inner,
      exec(request: ExecRequest) {
        keys.push(request.exec?.workspaceKey);
        return inner.exec(request);
      },
    };
    return { client, keys };
  }

  it('stamps every Exec with the workspace key it was built for', async () => {
    const { client, keys } = captureWorkspaceKeys();
    const t = GrpcRelayTransport('sbx-1', client, { workspaceKey: 'leaf-abc123' });
    await t.exec('true');
    await t.exec('cat /workspace/README.md');
    // Every Exec, not just the first: vmpool keys a per-run workspace on this and a
    // missing key on any one command is refused on the VM path (spec §3.4).
    expect(keys).toEqual(['leaf-abc123', 'leaf-abc123']);
  });

  it('sends an empty workspace key when none was supplied', async () => {
    const { client, keys } = captureWorkspaceKeys();
    await GrpcRelayTransport('sbx-1', client).exec('true');
    // '' is today's behaviour on the container arm, and is REFUSED on the VM arm —
    // which is the point: a caller that cannot supply a run id must fail loudly on
    // the VM tier rather than share one workspace (spec §3.4).
    expect(keys).toEqual(['']);
  });
});

describe('GrpcRelayTransport workload (workload sandboxes spec §3.3)', () => {
  function captureRequests(): { client: ExecClientLike; requests: ExecRequest[] } {
    const { client: inner } = fakeClient({ exitCode: 0 });
    const requests: ExecRequest[] = [];
    const client: ExecClientLike = {
      ...inner,
      exec(request: ExecRequest) {
        requests.push(request);
        return inner.exec(request);
      },
    };
    return { client, requests };
  }

  it('sends the workload on the ExecRequest, not inside the Exec the worker receives', async () => {
    const wl = `w-${'a'.repeat(32)}`;
    const { client, requests } = captureRequests();
    await GrpcRelayTransport(`${wl}-0`, client, { workload: wl }).exec('true');
    expect(requests[0]?.workload).toBe(wl);
    expect(requests[0]?.exec).not.toHaveProperty('workload');
  });

  it("sends '' for a shared-pool run", async () => {
    const { client, requests } = captureRequests();
    await GrpcRelayTransport('sbx-1', client).exec('true');
    expect(requests[0]?.workload).toBe('');
  });
});

/**
 * #452. An ExecError frame carries BOTH "your command failed" and "this host is at
 * capacity", because the wire has no separate refusal form. This transport is the last
 * place they can be told apart, and these cases pin that it does.
 *
 * manualClient, not fakeClient: FakeBehavior scripts chunks and an End, and cannot emit
 * an `error` frame at all — which is exactly why the defect survived the conformance
 * battery.
 */
describe('GrpcRelayTransport capacity refusals (#452)', () => {
  const emitError = async (message: string) => {
    const { client, emit, reqId } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    const p = t.exec('pytest -x');
    await Promise.resolve(); // let exec() register its handlers
    emit({ error: { reqId: reqId()!, message } } as ExecEvent);
    return p;
  };

  // The message in the original report, verbatim in shape: vmpool's RefusalError
  // rendering of RefuseMemoryBudget.
  it('rejects a memory-budget refusal as SandboxCapacityRefusedError', async () => {
    const p = emitError(
      'memory-budget: committing 301989888 more bytes would reach 4328521728 against a budget of 4294967296',
    );
    await expect(p).rejects.toBeInstanceOf(SandboxCapacityRefusedError);
    // The NAME is what `@moca/server` maps to 503, so assert it and not just the class:
    // `instanceof` is unsound across package instances there (see the class doc), and a
    // minifier renames the constructor.
    await expect(p).rejects.toMatchObject({ name: 'SandboxCapacityRefusedError' });
  });

  it('rejects a max-runs refusal and the session loop\'s "busy" refusal the same way', async () => {
    await expect(
      emitError('max-runs: 8 runs already resident, MaxRuns is 8'),
    ).rejects.toBeInstanceOf(SandboxCapacityRefusedError);
    await expect(emitError('busy: queue full')).rejects.toBeInstanceOf(SandboxCapacityRefusedError);
  });

  it('leaves an ordinary command failure a plain Error', async () => {
    // THE HALF THAT MATTERS AS MUCH. Classifying too widely would answer 503 +
    // Retry-After for a command that will fail identically on every retry, converting a
    // reported failure into an unbounded retry loop.
    const p = emitError('exit status 1: no such file or directory');
    await expect(p).rejects.toThrow('exit status 1: no such file or directory');
    await expect(p).rejects.not.toBeInstanceOf(SandboxCapacityRefusedError);
  });

  it('preserves the refusal message for the operator', async () => {
    // The model never sees this (the turn ends), but a human reading the 503's server log
    // needs the arithmetic — it is what says whether MICROVM_MAX_COMMITTED_MB is the knob
    // or whether the host is genuinely busy.
    const message = 'memory-budget: committing 301989888 more bytes would reach 4328521728';
    await expect(emitError(message)).rejects.toThrow(message);
  });
});
