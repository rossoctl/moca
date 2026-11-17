import { createServer, connect, type Server as NetServer, type Socket } from 'node:net';
import {
  credentials,
  makeGenericClientConstructor,
  connectivityState,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxWorkerService, type ServerFrame, type WorkerFrame } from '@moca/k8s-sandbox';
import type { RecordStore, SandboxRecord } from '@moca/harness';
import { startRelay, type Keepalive } from '../src/main.js';

// #439: a P4 host whose network drops without a TCP close (a NAT or security-group change, a reboot,
// a cable pull) leaves the relay holding its Attach stream. Until that stream ends, the host's
// reconnect is refused as a duplicate sandbox id and presence still points at it. The relay's server
// keepalive is what ends it: a PING the peer never acks destroys the connection within
// keepalive time + timeout. This suite freezes a worker's connection mid-attach -- every byte in
// both directions is swallowed and no FIN or RST is sent, which is what a dropped network looks like
// from the relay -- and checks the session is torn down, presence removed, and the same id can
// attach again, all inside that bound. The negative control runs the same freeze with keepalive off.

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/** A presence store that records when each id was put and removed. */
function store() {
  const puts: Array<{ id: string; at: number }> = [];
  const removes: Array<{ id: string; at: number }> = [];
  const records: RecordStore = {
    put: async (r: SandboxRecord) => void puts.push({ id: r.sandboxId, at: Date.now() }),
    remove: async (id: string) => void removes.push({ id, at: Date.now() }),
    list: async () => [],
  };
  return { puts, removes, records };
}

/**
 * A TCP proxy whose `freeze()` turns every open connection into a black hole: bytes either way are
 * dropped and the sockets stay open, so neither side sees a close.
 */
async function freezableProxy(targetPort: number) {
  let frozen = false;
  let upChunks = 0;
  const sockets: Socket[] = [];
  const server: NetServer = createServer((client: Socket) => {
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.push(client, upstream);
    client.on('data', (b: Buffer) => {
      upChunks += 1;
      if (!frozen) upstream.write(b);
    });
    upstream.on('data', (b: Buffer) => void (frozen || client.write(b)));
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
    // Before the freeze a close passes through; after it, the black hole swallows closes too.
    client.on('close', () => void (frozen || end()));
    upstream.on('close', () => void (frozen || end()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return {
    port: (server.address() as { port: number }).port,
    freeze: () => void (frozen = true),
    /** Client->relay writes seen so far: with the call idle and the relay not pinging, PINGs. */
    upChunks: () => upChunks,
  };
}

function attach(addr: string, sandboxId: string, channelOptions: Record<string, number> = {}) {
  const client = new WorkerClient(
    addr,
    credentials.createInsecure(),
    channelOptions,
  ) as unknown as Client & { attach: () => ClientDuplexStream<WorkerFrame, ServerFrame> };
  const stream = client.attach();
  let failed = false;
  stream.on('error', () => void (failed = true));
  stream.on('data', () => {});
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
  return { client, failed: () => failed };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const KEEPALIVE: Keepalive = { timeMs: 300, timeoutMs: 300 };
/** grpc-js's own "keepalive off" value (KEEPALIVE_MAX_TIME_MS in its server.ts). */
const KEEPALIVE_OFF: Keepalive = { timeMs: 2 ** 31 - 1, timeoutMs: 300 };

async function frozenWorker(keepalive: Keepalive) {
  const s = store();
  const relay = await startRelay({
    port: 0,
    deps: { records: s.records, validateToken: () => true, validateExecToken: () => false },
    keepalive,
  });
  closers.push(relay.shutdown);
  const proxy = await freezableProxy(relay.port);
  attach(`127.0.0.1:${proxy.port}`, 'sbx_dead_peer');
  expect(await until(() => s.puts.length === 1, 3_000)).toBe(true);
  proxy.freeze();
  return { s, relay, frozenAt: Date.now() };
}

describe('relay keepalive detects a dead peer (#439)', () => {
  it('tears a frozen worker down within keepalive time + timeout, and the same id attaches again', async () => {
    const { s, relay, frozenAt } = await frozenWorker(KEEPALIVE);

    // One ping interval to send the PING, one timeout for it to go unanswered; the slack is for a
    // loaded test machine, and stays far below the router's 5 m idle limit the issue started from.
    const bound = KEEPALIVE.timeMs + KEEPALIVE.timeoutMs;
    expect(await until(() => s.removes.length === 1, bound + 2_000)).toBe(true);
    expect(s.removes[0]!.id).toBe('sbx_dead_peer');
    expect(s.removes[0]!.at - frozenAt).toBeLessThan(bound + 2_000);

    // The reconnect the stale stream used to refuse as a duplicate sandbox id.
    attach(`127.0.0.1:${relay.port}`, 'sbx_dead_peer');
    expect(await until(() => s.puts.length === 2, 3_000)).toBe(true);
  }, 15_000);

  it('negative control: with keepalive off, the frozen worker is still held after the same window', async () => {
    const { s, relay } = await frozenWorker(KEEPALIVE_OFF);

    await new Promise((r) => setTimeout(r, KEEPALIVE.timeMs + KEEPALIVE.timeoutMs + 1_500));
    expect(s.removes).toEqual([]);
    // The issue's symptom: the host's reconnect is refused as a duplicate sandbox id.
    attach(`127.0.0.1:${relay.port}`, 'sbx_dead_peer');
    await new Promise((r) => setTimeout(r, 500));
    expect(s.puts.length).toBe(1);
  }, 15_000);

  it("accepts a worker's own frequent pings: no GOAWAY too_many_pings, the connection stays up", async () => {
    // The Go worker pings every 30 s while its Attach stream is open (remote-worker/internal/session/
    // dial.go). grpc-js's server polices no client ping rate, so it never answers a ping with GOAWAY
    // ENHANCE_YOUR_CALM; this pins that with a client pinging 300 times faster, so a grpc-js upgrade
    // that starts enforcing a minimum interval fails here instead of in the field. The relay's own
    // keepalive is off here, so it sends no PING the client would ack: every client->relay write in
    // the idle window is the client's own PING.
    const s = store();
    const relay = await startRelay({
      port: 0,
      deps: { records: s.records, validateToken: () => true, validateExecToken: () => false },
      keepalive: KEEPALIVE_OFF,
    });
    closers.push(relay.shutdown);
    const proxy = await freezableProxy(relay.port);
    const w = attach(`127.0.0.1:${proxy.port}`, 'sbx_pinger', {
      'grpc.keepalive_time_ms': 100,
      'grpc.keepalive_timeout_ms': 1_000,
      'grpc.keepalive_permit_without_calls': 1,
    });
    expect(await until(() => s.puts.length === 1, 3_000)).toBe(true);
    const channel = w.client.getChannel();
    const states: connectivityState[] = [];
    let watching = true;
    const watch = () =>
      channel.watchConnectivityState(channel.getConnectivityState(false), Infinity, () => {
        if (!watching) return;
        states.push(channel.getConnectivityState(false));
        watch();
      });
    watch();
    closers.push(() => void (watching = false));

    const before = proxy.upChunks();
    await new Promise((r) => setTimeout(r, 2_000));
    watching = false;
    // The client did ping, about 20 times: with the relay silent, nothing else writes in this window.
    expect(proxy.upChunks() - before).toBeGreaterThanOrEqual(5);
    // A GOAWAY would move the channel off READY and end the Attach stream with an error.
    expect(states).toEqual([]);
    expect(channel.getConnectivityState(false)).toBe(connectivityState.READY);
    expect(w.failed()).toBe(false);
    expect(s.removes).toEqual([]);
  }, 15_000);
});
