import { EventEmitter } from 'node:events';
import { status } from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/main.js';
import type { RecordStore } from '@moca/harness';
import { MAX_EXEC_MESSAGE_BYTES } from '@moca/k8s-sandbox';

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };

/** Grabs the exact bound handler grpc-js registered for a full method path. */
function getHandler(server: unknown, path: string): (call: unknown) => unknown {
  const handlers = (server as { handlers: Map<string, { func: (call: unknown) => unknown }> })
    .handlers;
  const entry = handlers.get(path);
  if (!entry) throw new Error(`no handler registered for ${path}`);
  return entry.func;
}

describe('relay server wiring', () => {
  // #173 item 2. This is the limit that actually rejects an oversized write today: the
  // harness sends an ExecRequest whose base64 stdin is 4/3 of the file, and gRPC's
  // default ingress ceiling is 4 MiB — so a file the read path can return (up to
  // DEFAULT_OUTPUT_CAP, 8 MiB) could not be written back. It must equal the worker's
  // MaxRecvMsgBytes, not merely be raised: a relay that accepts MORE than the worker
  // forwards a payload the worker then refuses on the Attach stream, killing every
  // concurrent exec on it. message-size-coupling.test.ts pins the equality.
  it('raises the ingress message limit to the shared MAX_EXEC_MESSAGE_BYTES', () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const options = (server as unknown as { options: Record<string, unknown> }).options;
    expect(options['grpc.max_receive_message_length']).toBe(MAX_EXEC_MESSAGE_BYTES);
  });

  it('registers both gRPC services', () => {
    const { server } = buildServer({ records, validateToken: () => true });
    // grpc-js Server keeps registered handlers in a private `handlers` Map keyed
    // by full method path (e.g. "/sandbox.v1.SandboxWorker/Attach"). The brief's
    // original snippet assumed a plain Record with Object.keys(), but the
    // installed @grpc/grpc-js (1.14.x) stores it as a Map -- adapted accordingly.
    const handlers = (server as unknown as { handlers: Map<string, unknown> }).handlers;
    expect(handlers).toBeInstanceOf(Map);
    const names = [...handlers.keys()];
    expect(names.some((n) => n.includes('SandboxWorker'))).toBe(true);
    expect(names.some((n) => n.includes('SandboxExec'))).toBe(true);
  });
});

/** Fake bidi Attach stream, same shape used by relay-attach/relay-exec tests. */
function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: () => string[] };
    write: (f: unknown) => void;
    end: () => void;
    written: unknown[];
  };
  s.metadata = { get: () => [] };
  s.written = [];
  s.write = (f) => s.written.push(f);
  s.end = () => s.emit('end');
  return s;
}

/**
 * Fake server-streaming call, the shape main.ts's exec handler expects.
 *
 * `streamError` mirrors the listener @grpc/grpc-js registers in ServerWritableStream's own
 * constructor (`this.on('error', ...)`, which sets pendingStatus and ends the stream). That
 * listener is the ONLY thing that puts a non-OK code on the wire, so a fake without it both
 * misreports the handler and makes `emit('error')` throw as an unhandled error event.
 *
 * `destroy` is kept only so a regression back to it is visible here rather than silent --
 * on grpc-js 1.14.4 destroying a ServerWritableStream sends no status at all, because the
 * status is sent from `_final` and Node's Writable skips `_final` once destroyed. This fake
 * cannot show that; `main-exec-status.transport.test.ts` pins it over a real transport.
 */
function fakeExecCall(request: unknown) {
  const c = new EventEmitter() as EventEmitter & {
    request: unknown;
    write: (ev: unknown) => void;
    end: () => void;
    destroy: (err: Error) => void;
    written: unknown[];
    ended: boolean;
    destroyed?: Error;
    streamError?: Error;
  };
  c.request = request;
  c.written = [];
  c.ended = false;
  c.write = (ev) => c.written.push(ev);
  c.end = () => (c.ended = true);
  c.destroy = (err) => (c.destroyed = err);
  c.on('error', (err: Error) => {
    c.streamError = err;
  });
  return c;
}

describe('relay server exec cancellation wiring (via the real registered handler)', () => {
  it('aborts the worker on client cancel and cleanly drains the generator', async () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const attach = getHandler(server, '/sandbox.v1.SandboxWorker/Attach');
    const exec = getHandler(server, '/sandbox.v1.SandboxExec/Exec');

    const worker = fakeAttach();
    attach(worker);
    worker.emit('data', {
      hello: {
        sandboxId: 'sbx-1',
        labels: {},
        capabilities: [],
        image: '',
        arch: 'amd64',
        capacityMax: 1,
        trust: 'trusted',
      },
    });

    const call = fakeExecCall({
      sandboxId: 'sbx-1',
      exec: {
        reqId: 1,
        command: 'sleep 100',
        stdin: new Uint8Array(),
        timeoutS: 0,
        streaming: true,
        workspaceKey: '',
      },
    });
    exec(call);

    // routeExec has parked its sink and written ServerFrame{exec} to the worker.
    await vi.waitFor(() =>
      expect((worker.written.at(-1) as { exec?: { reqId: number } })?.exec?.reqId).toBe(1),
    );

    // Harness (client) cancels its own call -- e.g. its deadline fired.
    call.emit('cancelled');

    // The handler must NOT just call .return() on the idling generator; it must
    // tell the worker to abort so the worker's own reply drives cleanup.
    await vi.waitFor(() =>
      expect((worker.written.at(-1) as { abort?: { reqId: number } })?.abort?.reqId).toBe(1),
    );

    // Worker honors the abort with an error frame for that reqId.
    worker.emit('data', { error: { reqId: 1, message: 'aborted' } });

    // The generator yields that event and returns -- exec handler writes it and ends.
    await vi.waitFor(() =>
      expect((call.written.at(-1) as { error?: { message: string } })?.error?.message).toBe(
        'aborted',
      ),
    );
    await vi.waitFor(() => expect(call.ended).toBe(true));
    expect(call.destroyed).toBeUndefined();
    // A cancel is our own abort completing, not a server-side failure, so it must not be
    // reclassified into a non-OK status.
    expect(call.streamError).toBeUndefined();
  });

  it('fails the call with a status when routeExec throws (e.g. absent sandbox)', async () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const exec = getHandler(server, '/sandbox.v1.SandboxExec/Exec');

    const call = fakeExecCall({
      sandboxId: 'ghost',
      exec: {
        reqId: 1,
        command: 'x',
        stdin: new Uint8Array(),
        timeoutS: 0,
        streaming: true,
        workspaceKey: '',
      },
    });
    exec(call);

    // Via the 'error' event, not destroy(): destroying sends no status, so an absent
    // sandbox would hang the caller instead of answering it.
    await vi.waitFor(() => expect(call.streamError).toBeInstanceOf(Error));
    expect(call.streamError?.message).toMatch(/no live worker/);
    expect(call.destroyed).toBeUndefined();
  });
});

describe('relay server exec error status wiring', () => {
  // #295. The worker reports a failed Exec as an in-stream ExecEvent.error and then
  // stops. routeExec yields that event and returns NORMALLY (relay.ts sets done on
  // ev.error), so the handler's `for await` falls out and reaches call.end() -- a gRPC
  // OK. A client that only reads the terminal status therefore counts a FAILED Exec as
  // a success: it enters `throughput`, enters the distribution `p95` is taken over, and
  // never reaches `execErrorsByCause`. That is exactly the inflation the E11 driver
  // documents on its grpcurl path (e11-density.sh, the `*)` client note). The detail
  // must still reach the client, so the event is written either way -- only the terminal
  // status changes.
  it('ends the call with a non-OK status when the worker reports an in-stream exec error', async () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const attach = getHandler(server, '/sandbox.v1.SandboxWorker/Attach');
    const exec = getHandler(server, '/sandbox.v1.SandboxExec/Exec');

    const worker = fakeAttach();
    attach(worker);
    worker.emit('data', {
      hello: {
        sandboxId: 'sbx-1',
        labels: {},
        capabilities: [],
        image: '',
        arch: 'amd64',
        capacityMax: 1,
        trust: 'trusted',
      },
    });

    const call = fakeExecCall({
      sandboxId: 'sbx-1',
      exec: {
        reqId: 7,
        command: 'boom',
        stdin: new Uint8Array(),
        timeoutS: 0,
        streaming: true,
        workspaceKey: '',
      },
    });
    exec(call);

    await vi.waitFor(() =>
      expect((worker.written.at(-1) as { exec?: { reqId: number } })?.exec?.reqId).toBe(7),
    );

    worker.emit('data', { error: { reqId: 7, message: 'exec failed: boom' } });

    // The client still receives the error event itself -- the payload is unchanged.
    await vi.waitFor(() =>
      expect((call.written.at(-1) as { error?: { message: string } })?.error?.message).toBe(
        'exec failed: boom',
      ),
    );

    // But the stream must NOT terminate OK, and the status must carry the worker's message.
    // Raised as an 'error' event: that is the only termination grpc-js turns into a status
    // (destroy() sends none at all), which main-exec-status.transport.test.ts proves on a
    // real transport.
    await vi.waitFor(() => expect(call.streamError).toBeInstanceOf(Error));
    expect(call.streamError?.message).toMatch(/exec failed: boom/);
    // INTERNAL specifically, not grpc-js's default UNKNOWN for a bare Error: the exec
    // machinery failed server-side, which is not the caller's fault. A non-zero command
    // exit is a different thing entirely and arrives as ExecEvent.end{exitCode}.
    expect((call.streamError as { code?: number } | undefined)?.code).toBe(status.INTERNAL);
    expect(call.destroyed).toBeUndefined();
    expect(call.ended).toBe(false);
  });
});
