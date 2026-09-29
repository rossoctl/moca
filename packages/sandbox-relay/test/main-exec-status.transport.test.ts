import {
  ServerCredentials,
  credentials,
  makeGenericClientConstructor,
  status,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/main.js';
import {
  SandboxWorkerService,
  SandboxExecClient,
  type WorkerFrame,
  type ServerFrame,
  type ExecEvent,
} from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';

// These tests go over a REAL grpc-js transport -- a bound server, a real client, real
// trailers -- because the terminal status is a property of the transport, not of the
// handler's call object. The fake call in main-wiring.test.ts records `destroy(err)` and
// nothing else, so it reports success for a handler that in production never sends a
// status at all: on @grpc/grpc-js 1.14.4 a ServerWritableStream sends its status from
// `_final`, which Node's Writable never reaches once `destroyed` is set. `call.destroy()`
// therefore leaves the client hanging with no status, no end and no error -- verified
// against a real client at 12s. Only `emit('error')` -- whose grpc-js constructor
// listener sets pendingStatus and then ends -- actually puts a code on the wire.
//
// A hang is strictly worse than the OK that #295 is about: an OK at least lets a driver
// finish its rung. So every non-OK termination path in the exec handler is pinned here.

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };

type Harness = {
  addr: string;
  shutdown: () => void;
};

const live: Harness[] = [];

afterEach(() => {
  for (const h of live.splice(0)) h.shutdown();
});

async function startRelay(): Promise<Harness> {
  const { server } = buildServer({ records, validateToken: () => true });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    );
  });
  const h: Harness = {
    addr: `127.0.0.1:${port}`,
    shutdown: () => server.forceShutdown(),
  };
  live.push(h);
  return h;
}

/** Terminal status of a server-streaming Exec call, however it terminates. */
function execStatus(
  addr: string,
  request: unknown,
): { events: ExecEvent[]; done: Promise<{ code: number; details: string }> } {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const call = client.exec(request as never);
  const events: ExecEvent[] = [];
  call.on('data', (ev: ExecEvent) => events.push(ev));
  // An error on a streaming client call carries the same code/details as the status
  // event; listening to both means the assertion does not depend on which arrives.
  call.on('error', () => {});
  const done = new Promise<{ code: number; details: string }>((resolve) => {
    call.on('status', (s: { code: number; details: string }) =>
      resolve({ code: s.code, details: s.details }),
    );
  });
  return { events, done };
}

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/** Attaches a real worker over the wire and resolves once its Hello is parked. */
async function attachWorker(
  addr: string,
  sandboxId: string,
): Promise<ClientDuplexStream<WorkerFrame, ServerFrame>> {
  // makeGenericClientConstructor types its instances as the untyped ServiceClient, so the
  // generated method has to be named explicitly to be callable.
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  stream.on('error', () => {});
  stream.write({
    hello: {
      sandboxId,
      labels: {},
      capabilities: [],
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  } as WorkerFrame);
  // The relay parks the session synchronously on the Hello frame; give the round trip a
  // moment rather than reaching into server internals.
  await new Promise((r) => setTimeout(r, 150));
  return stream;
}

describe('exec terminal status over a real transport', () => {
  // #295 proper: the worker reports the failure as an in-stream ExecEvent.error and then
  // stops. routeExec yields it and returns normally, so the handler falls out of its
  // `for await`. If that lands on call.end() the client sees OK and a FAILED exec counts
  // toward throughput and enters p95.
  it('terminates non-OK when the worker reports an in-stream exec error', async () => {
    const { addr } = await startRelay();
    const worker = await attachWorker(addr, 'sbx-1');

    worker.on('data', (frame: ServerFrame) => {
      if (frame.exec)
        worker.write({
          error: { reqId: frame.exec.reqId, message: 'exec failed: boom' },
        } as WorkerFrame);
    });

    const { events, done } = execStatus(addr, {
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

    const s = await done;
    expect(s.code).not.toBe(status.OK);
    expect(s.code).toBe(status.INTERNAL);
    expect(s.details).toMatch(/exec failed: boom/);
    // The payload is unchanged -- clients reading the in-stream error still get it.
    expect(events.at(-1)?.error?.message).toBe('exec failed: boom');
  });

  // Pre-existing path, same broken primitive: routeExec THROWS when no worker is parked
  // (relay.ts, `no live worker for sandbox`), which reaches the handler's catch. A worker
  // that died or has not attached yet is an ordinary production state, so this must be a
  // status and not a hang.
  it('terminates non-OK when no worker is attached for the sandbox', async () => {
    const { addr } = await startRelay();
    const { done } = execStatus(addr, {
      sandboxId: 'sbx-absent',
      exec: {
        reqId: 1,
        command: 'true',
        stdin: new Uint8Array(),
        timeoutS: 0,
        streaming: true,
        workspaceKey: '',
      },
    });
    const s = await done;
    expect(s.code).not.toBe(status.OK);
    expect(s.details).toMatch(/no live worker/);
  });

  // Pre-existing path: a malformed request with no exec field.
  it('terminates non-OK when the request carries no exec field', async () => {
    const { addr } = await startRelay();
    const { done } = execStatus(addr, { sandboxId: 'sbx-1' });
    const s = await done;
    expect(s.code).not.toBe(status.OK);
    expect(s.details).toMatch(/missing exec field/);
  });
});
