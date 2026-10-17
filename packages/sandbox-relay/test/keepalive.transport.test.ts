import { createServer, connect, type Server as NetServer, type Socket } from 'node:net';
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
  SandboxExecClient,
  SandboxWorkerService,
  type ExecEvent,
  type ServerFrame,
  type WorkerFrame,
} from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';
import { RELAY_KEEPALIVE, relayServerOptions, startRelay } from '../src/main.js';

// SBX0 §3.4: some load balancers in front of a cluster router close a TCP connection after a short
// idle period (one measured at 50 s), so an Exec whose command prints nothing would die. The relay's
// servers ping every connection; this suite proves the pings flow while a command is silent, on
// both listeners (the client's Exec connection and the worker's Attach connection), and -- the
// negative control -- that with keepalive off the same silent window carries no bytes at all, so the
// bytes counted are the pings and nothing else.

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };
const EXEC_TOKEN = 'keepalive-exec-token'; // notsecret
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

/** A worker that waits `silentMs` before answering each Exec: a command that prints nothing. */
async function attachSilentWorker(addr: string, sandboxId: string, silentMs: number) {
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  stream.on('error', () => {});
  stream.on('data', (frame: ServerFrame) => {
    if (!frame.exec) return;
    const reqId = frame.exec.reqId;
    setTimeout(() => {
      stream.write({ chunk: { reqId, data: Buffer.from('done'), stream: 1 } } as WorkerFrame);
      stream.write({ end: { reqId, exitCode: 0 } } as WorkerFrame);
    }, silentMs);
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
  await new Promise((r) => setTimeout(r, 150));
}

/**
 * A TCP proxy in front of a relay listener that timestamps every server->client byte, so the test
 * can see traffic during the window in which the command itself sends nothing.
 */
async function countingProxy(targetPort: number) {
  const downstream: number[] = [];
  const server: NetServer = createServer((client: Socket) => {
    const upstream = connect(targetPort, '127.0.0.1');
    client.pipe(upstream);
    upstream.on('data', (b: Buffer) => {
      downstream.push(Date.now());
      client.write(b);
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  return { port, downstream };
}

function exec(addr: string, sandboxId: string) {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  md.set('authorization', `Bearer ${EXEC_TOKEN}`);
  const call = client.exec(
    {
      sandboxId,
      exec: {
        reqId: 7,
        command: 'sleep 2',
        stdin: new Uint8Array(),
        timeoutS: 30,
        streaming: true,
        workspaceKey: 'k',
      },
    },
    md,
  );
  const events: ExecEvent[] = [];
  call.on('data', (ev: ExecEvent) => events.push(ev));
  call.on('error', () => {});
  return new Promise<{ code: number; events: ExecEvent[] }>((resolve) =>
    call.on('status', (s: { code: number }) => resolve({ code: s.code, events })),
  ).finally(() => client.close());
}

/** grpc-js's own "keepalive off" value (KEEPALIVE_MAX_TIME_MS in its server.ts). */
const KEEPALIVE_OFF = { timeMs: 2 ** 31 - 1, timeoutMs: 2_000 };

/**
 * One Exec whose command is silent for 2 s, with the worker attached through one counting proxy and
 * the client calling through another. Returns the server->peer bytes each proxy saw in the window
 * after the call settled and before the command answered.
 */
async function silentExec(keepalive: { timeMs: number; timeoutMs: number }) {
  const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps, keepalive });
  closers.push(relay.shutdown);
  const attachProxy = await countingProxy(relay.port);
  const execProxy = await countingProxy(relay.execPort!);
  await attachSilentWorker(`127.0.0.1:${attachProxy.port}`, 'sbx_keepalive', 2_000);

  const started = Date.now();
  const r = await exec(`127.0.0.1:${execProxy.port}`, 'sbx_keepalive');
  const inWindow = (ts: number[]) =>
    ts.filter((t) => t > started + 500 && t < started + 1_900).length;
  return { r, exec: inWindow(execProxy.downstream), attach: inWindow(attachProxy.downstream) };
}

describe('relay keepalive (SBX0 §3.4)', () => {
  it('sets the two keepalive options grpc-js reads, plus the message ceiling', () => {
    const o = relayServerOptions();
    expect(o['grpc.keepalive_time_ms']).toBe(20_000);
    expect(o['grpc.keepalive_timeout_ms']).toBe(10_000);
    expect(o['grpc.max_receive_message_length']).toBeGreaterThan(4 * 1024 * 1024);
    expect(RELAY_KEEPALIVE).toEqual({ timeMs: 20_000, timeoutMs: 10_000 });
  });

  it('pings both connections while the command prints nothing, and the Exec still completes', async () => {
    const { r, exec: execBytes, attach } = await silentExec({ timeMs: 250, timeoutMs: 2_000 });

    expect(r.code).toBe(status.OK);
    expect(r.events.at(-1)?.end?.exitCode).toBe(0);
    // Bytes reached the client and the worker during the silent window: the servers' HTTP/2 PINGs,
    // on the exec listener and on the attach listener.
    expect(execBytes).toBeGreaterThan(0);
    expect(attach).toBeGreaterThan(0);
  }, 15_000);

  it('negative control: with keepalive off, the same silent window carries no bytes on either connection', async () => {
    const { r, exec: execBytes, attach } = await silentExec(KEEPALIVE_OFF);

    expect(r.code).toBe(status.OK);
    expect(r.events.at(-1)?.end?.exitCode).toBe(0);
    expect(execBytes).toBe(0);
    expect(attach).toBe(0);
  }, 15_000);
});
