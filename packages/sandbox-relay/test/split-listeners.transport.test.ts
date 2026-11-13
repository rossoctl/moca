import {
  Metadata,
  credentials,
  makeGenericClientConstructor,
  status,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Exec,
  SandboxExecClient,
  SandboxWorkerService,
  type ExecEvent,
  type ServerFrame,
  type WorkerFrame,
} from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';
import { startRelay } from '../src/main.js';

// The split shape compose and deploy/vm run by default (MI1 §5 R5): sandboxes attach on one
// listener, workers call SandboxExec on another, and both are served by ONE relay instance -- so an
// Exec presented on the exec listener must route to a worker attached on the attach listener. Real
// grpc-js transport end to end, modelled on main-exec-status.transport.test.ts.

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };
const EXEC_TOKEN = 'split-exec-token'; // notsecret
const deps = {
  records,
  validateToken: () => true,
  validateExecToken: (p: string | undefined) => p === EXEC_TOKEN,
};

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/** Attaches a worker that answers every Exec with `hi` on stdout and exit code 0. */
async function attachEchoWorker(addr: string, sandboxId: string): Promise<void> {
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  stream.on('error', () => {});
  stream.on('data', (frame: ServerFrame) => {
    if (!frame.exec) return;
    const reqId = frame.exec.reqId;
    stream.write({ chunk: { reqId, data: Buffer.from('hi'), stream: 1 } } as WorkerFrame);
    stream.write({ end: { reqId, exitCode: 0 } } as WorkerFrame);
  });
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
  closers.push(() => {
    stream.cancel();
    client.close();
  });
  // The relay parks the session on the Hello frame; give the round trip a moment rather than
  // reaching into server internals.
  await new Promise((r) => setTimeout(r, 150));
}

function exec(
  addr: string,
  sandboxId: string,
  token?: string,
): Promise<{ code: number; details: string; events: ExecEvent[] }> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (token) md.set('authorization', `Bearer ${token}`);
  const call = client.exec(
    {
      sandboxId,
      workload: '',
      exec: Exec.fromPartial({
        reqId: 1,
        command: 'echo hi',
        stdin: new Uint8Array(),
        timeoutS: 5,
        streaming: true,
        workspaceKey: 'k',
      }),
    },
    md,
  );
  const events: ExecEvent[] = [];
  call.on('data', (ev: ExecEvent) => events.push(ev));
  call.on('error', () => {});
  return new Promise<{ code: number; details: string; events: ExecEvent[] }>((resolve) =>
    call.on('status', (s: { code: number; details: string }) =>
      resolve({ code: s.code, details: s.details, events }),
    ),
  ).finally(() => client.close());
}

describe('split listeners route an Exec to a worker attached on the other listener (MI1 R5)', () => {
  it('an Exec with the exec token on the exec listener reaches the worker attached on the attach listener', async () => {
    const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps });
    closers.push(relay.shutdown);
    await attachEchoWorker(`127.0.0.1:${relay.port}`, 'sbx-split');

    const r = await exec(`127.0.0.1:${relay.execPort}`, 'sbx-split', EXEC_TOKEN);
    expect(r.code).toBe(status.OK);
    const stdout = r.events
      .map((e) => (e.chunk?.data ? Buffer.from(e.chunk.data).toString() : ''))
      .join('');
    expect(stdout).toBe('hi');
    expect(r.events.at(-1)?.end?.exitCode).toBe(0);
  });

  it('the exec listener still refuses an Exec without the exec token', async () => {
    const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps });
    closers.push(relay.shutdown);
    await attachEchoWorker(`127.0.0.1:${relay.port}`, 'sbx-split');

    expect((await exec(`127.0.0.1:${relay.execPort}`, 'sbx-split')).code).toBe(
      status.UNAUTHENTICATED,
    );
  });

  it('the attach listener does not serve Exec, even with the exec token and a worker attached', async () => {
    const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps });
    closers.push(relay.shutdown);
    await attachEchoWorker(`127.0.0.1:${relay.port}`, 'sbx-split');

    expect((await exec(`127.0.0.1:${relay.port}`, 'sbx-split', EXEC_TOKEN)).code).toBe(
      status.UNIMPLEMENTED,
    );
  });
});
