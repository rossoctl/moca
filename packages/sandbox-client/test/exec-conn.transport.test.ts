import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as nodeTls from 'node:tls';
import { join } from 'node:path';
import { Server, ServerCredentials, status, type ServerWritableStream } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecKind,
  LeaseEvent,
  LeaseOp,
  LeaseStatus,
  SandboxExecService,
  SandboxMode,
  type AbortRequest,
  type ExecEvent,
  type ExecRequest,
  type LeaseControlRequest,
  type LeaseControlResponse,
  type LeaseKeepaliveRequest,
} from '../src/gen/sandbox/v1/sandbox.js';
import {
  CLIENT_CHANNEL_OPTIONS,
  ExecAbortedError,
  ExecMachineryError,
  ExecRefusedError,
  ProcessError,
  SandboxExecConn,
  caBundle,
  newReqId,
  type ExecConnOptions,
  type TokenRequest,
} from '../src/exec-conn.js';
import { LeaseControlError } from '../src/lease.js';
import { execFailureText } from '../src/mcp-server.js';

type Behaviour = (call: ServerWritableStream<ExecRequest, ExecEvent>, n: number) => void;
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

/** `HANG`: the handler never answers, so only the client's cancel ends the call. */
const HANG = Symbol('hang');
type UnaryAnswer<R> = { code: number; details: string } | typeof HANG | R;
interface LeaseBehaviour {
  control?: (req: LeaseControlRequest) => UnaryAnswer<LeaseControlResponse>;
  keepalive?: (req: LeaseKeepaliveRequest) => UnaryAnswer<object>;
}

type Unary<Req> = { request: Req; metadata: { get(k: string): unknown[] } };
/** A unary handler that records the call and answers `answer`'s response or status. */
function unary<Req, Res>(
  calls: { req: Req; auth: string | undefined }[],
  answer: ((req: Req) => UnaryAnswer<Res>) | undefined,
) {
  return (c: Unary<Req>, cb: (e: object | null, r?: Res) => void) => {
    calls.push({ req: c.request, auth: c.metadata.get('authorization')[0] as string | undefined });
    const a = answer ? answer(c.request) : ({} as Res);
    if (a === HANG) return;
    if (a && typeof a === 'object' && 'code' in a && 'details' in a) {
      return cb(Object.assign(new Error(a.details as string), a));
    }
    cb(null, a as Res);
  };
}

async function fakeRelay(
  behave: Behaviour,
  tls?: { cert: Buffer; key: Buffer },
  lease: LeaseBehaviour = {},
) {
  const seen: { req: ExecRequest; auth: string | undefined }[] = [];
  const aborts: { req: AbortRequest; auth: string | undefined }[] = [];
  const controls: { req: LeaseControlRequest; auth: string | undefined }[] = [];
  const keepalives: { req: LeaseKeepaliveRequest; auth: string | undefined }[] = [];
  const cancelled: number[] = [];
  const server = new Server();
  server.addService(SandboxExecService, {
    exec: (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      seen.push({
        req: call.request,
        auth: call.metadata.get('authorization')[0] as string | undefined,
      });
      const n = seen.length;
      call.on('cancelled', () => cancelled.push(n));
      behave(call, n);
    },
    abort: (
      c: { request: AbortRequest; metadata: { get(k: string): unknown[] } },
      cb: (e: null, r: object) => void,
    ) => {
      aborts.push({ req: c.request, auth: c.metadata.get('authorization')[0] as string });
      cb(null, {});
    },
    leaseControl: unary(controls, lease.control),
    leaseKeepalive: unary(keepalives, lease.keepalive),
  });
  const creds = tls
    ? ServerCredentials.createSsl(null, [{ cert_chain: tls.cert, private_key: tls.key }], false)
    : ServerCredentials.createInsecure();
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync('127.0.0.1:0', creds, (e, p) => (e ? rej(e) : res(p))),
  );
  closers.push(() => server.forceShutdown());
  return { addr: `127.0.0.1:${port}`, seen, aborts, cancelled, controls, keepalives };
}

/** A TCP proxy in front of a fake relay whose live connections can be cut, as a load balancer does. */
async function tcpProxy(target: () => string) {
  const sockets = new Set<Socket>();
  const srv = createServer((down) => {
    const [host, port] = target().split(':');
    const up = netConnect(Number(port), host);
    for (const s of [down, up]) {
      sockets.add(s);
      s.on('error', () => {});
      s.on('close', () => sockets.delete(s));
    }
    down.pipe(up);
    up.pipe(down);
  });
  const port = await new Promise<number>((res) =>
    srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port)),
  );
  const kill = () => {
    for (const s of sockets) s.destroy();
  };
  closers.push(() => (kill(), new Promise<void>((r) => srv.close(() => r()))));
  return { addr: `127.0.0.1:${port}`, kill };
}

const chunk = (data: string, stream = 1) =>
  ({ chunk: { reqId: 0, data: Buffer.from(data), stream } }) as ExecEvent;
const ok: Behaviour = (call) => {
  call.write(chunk('out'));
  call.write(chunk('err', 2));
  call.write({ end: { reqId: 0, exitCode: 3, truncated: false } } as ExecEvent);
  call.end();
};
const fail =
  (code: number, details: string): Behaviour =>
  (call) =>
    call.emit('error', Object.assign(new Error(details), { code, details }));
/** The worker's in-stream ExecError, then the relay's INTERNAL carrying the same message. */
const execError =
  (message: string): Behaviour =>
  (call, n) => {
    call.write({ error: { reqId: 0, message } } as ExecEvent);
    fail(status.INTERNAL, message)(call, n);
  };

const NOW_S = 2_000_000_000;

function conn(
  addr: string,
  over: Partial<ExecConnOptions> = {},
  tok: { lifetimeS?: number; leftS?: (force: boolean) => number } = {},
) {
  const asks: TokenRequest[] = [];
  const lifetimeS = tok.lifetimeS ?? 900;
  const c = new SandboxExecConn({
    addr,
    tls: false,
    sandboxId: 'sbx_default',
    workspaceKey: 'sbx-aaaa',
    now: () => NOW_S * 1000,
    token: async (o) => {
      asks.push(o);
      return {
        token: o.force ? 'fresh' : 'stale',
        expiresAt: NOW_S + (tok.leftS ? tok.leftS(o.force) : lifetimeS),
        lifetimeS,
      };
    },
    ...over,
  });
  closers.push(() => c.close());
  return { c, asks };
}

describe('SandboxExecConn (SBX0 §6.5)', () => {
  it('sends the bound sandbox, workspace key and bearer, and splits stdout from stderr', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr);
    const res = await c.exec('echo hi', { stdin: Buffer.from('in'), timeoutS: 9 });
    expect(res).toEqual({
      stdout: Buffer.from('out'),
      stderr: Buffer.from('err'),
      exitCode: 3,
      truncated: false,
      lease: [],
    });
    const { req, auth } = r.seen[0]!;
    expect(auth).toBe('Bearer stale');
    expect(req.sandboxId).toBe('sbx_default');
    expect(req.exec).toMatchObject({
      command: 'echo hi',
      timeoutS: 9,
      streaming: true,
      workspaceKey: 'sbx-aaaa',
    });
    expect(Buffer.from(req.exec!.stdin)).toEqual(Buffer.from('in'));
    expect(req.exec!.reqId).toBeLessThan(2 ** 53);
  });

  it('refreshes the token once on UNAUTHENTICATED before any event, and retries the same req_id', async () => {
    const r = await fakeRelay((call, n) =>
      n === 1 ? fail(status.UNAUTHENTICATED, 'exec authentication failed')(call, n) : ok(call, n),
    );
    const { c, asks } = conn(r.addr);
    expect((await c.exec('x', { timeoutS: 30 })).exitCode).toBe(3);
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: true, minValidS: 90 },
    ]);
    expect(r.seen[1]!.req.exec!.timeoutS).toBe(30);
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(r.seen[1]!.req.exec!.reqId).toBe(r.seen[0]!.req.exec!.reqId);
  });

  it('gives up after the one refresh with ExecRefusedError', async () => {
    const r = await fakeRelay(fail(status.UNAUTHENTICATED, 'exec authentication failed'));
    const { c } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecRefusedError);
    expect(e).toMatchObject({ grpcCode: status.UNAUTHENTICATED });
    expect(r.seen).toHaveLength(2);
  });

  it('does not retry PERMISSION_DENIED', async () => {
    const r = await fakeRelay(
      fail(status.PERMISSION_DENIED, "exec not permitted: sandbox_id is not this token's worker"),
    );
    const { c } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecRefusedError);
    expect(e).toMatchObject({ grpcCode: status.PERMISSION_DENIED });
    expect(r.seen).toHaveLength(1);
  });

  it('NEVER re-runs a command that started: a token refusal after the first event is surfaced', async () => {
    const r = await fakeRelay((call) => {
      call.write(chunk('partial'));
      setTimeout(() => fail(status.UNAUTHENTICATED, 'late')(call, 0), 20);
    });
    const { c, asks } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'machinery' });
    expect(r.seen).toHaveLength(1);
    expect(asks.some((a) => a.force)).toBe(false);
  });

  it('NEVER re-runs a command that started: a connection dropped after one chunk is an error', async () => {
    let proxy: Awaited<ReturnType<typeof tcpProxy>> | undefined;
    const r = await fakeRelay((call) => {
      call.write(chunk('partial'));
      // The relay stays up and reachable: a retry would land on it and show as a second Exec.
      setTimeout(() => proxy!.kill(), 50);
    });
    proxy = await tcpProxy(() => r.addr);
    const { c } = conn(proxy.addr);
    const e = await c.exec('sleep 600', { timeoutS: 600 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'machinery', mayHaveRun: true }); // final review M2
    expect((e as Error).message).toMatch(/^sandbox failure: /);
    expect(r.seen).toHaveLength(1);
  });

  it('marks a failure after output as may-have-run, and one before any event as not (final review M2)', async () => {
    const late = await fakeRelay((call) => {
      call.write(chunk('partial'));
      setTimeout(() => fail(status.INTERNAL, 'worker went away')(call, 0), 20);
    });
    await expect(conn(late.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: true });
    const ended = await fakeRelay((call) => (call.write(chunk('half')), call.end()));
    await expect(conn(ended.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: true });
    const early = await fakeRelay(fail(status.UNKNOWN, 'no live worker for sandbox sbx_default'));
    await expect(conn(early.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: false });
    // A worker refusal it sends before starting the command (a VM that could not be restored).
    const boot = await fakeRelay(execError('spawn-failure: resume "sbx-aaaa": no snapshot'));
    await expect(conn(boot.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: false });
    // One after output did.
    const crash = await fakeRelay((call, n) => {
      call.write(chunk('partial'));
      execError('worker crashed')(call, n);
    });
    await expect(conn(crash.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: true });
  });

  it('marks an ExecError after the Exec was accepted as may-have-run, even with no output (review #554)', async () => {
    // The relay's own in-stream error when the worker's stream drops mid-command (relay.ts teardown).
    const gone = await fakeRelay(execError('worker disconnected'));
    await expect(conn(gone.addr).c.exec('touch f; sleep 9')).rejects.toMatchObject({
      kind: 'machinery',
      mayHaveRun: true,
    });
    // A guest that died mid-command, and any worker failure not known to precede the start.
    for (const m of ['vsock-short-response: vmpool: guest closed before End: EOF', 'wait: oops']) {
      const r = await fakeRelay(execError(m));
      await expect(conn(r.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: true });
    }
    // The worker's refusals before it starts anything stay not-run, and keep the one retry rule.
    for (const m of [
      'invalid-workspace-key: workspace_key "x" must match',
      'empty-workspace-key: the microVM path requires',
      'spawn-failure: restore for "k": boom',
      'req_id collision: a different Exec (command, mode, epoch or workspace) is already in flight for this id',
      'workspace /workspace/k: mkdir: permission denied',
      'start bash: fork failed',
      'vmpool: closed',
    ]) {
      const r = await fakeRelay(execError(m));
      await expect(conn(r.addr).c.exec('x')).rejects.toMatchObject({ mayHaveRun: false });
    }
  });

  it('reports an in-stream ExecError as a machinery failure', async () => {
    const r = await fakeRelay(execError('vm boot failed'));
    const { c } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'machinery', message: 'sandbox failure: vm boot failed' });
  });

  it('reports a non-OK status without an event as a machinery failure, naming the code', async () => {
    const r = await fakeRelay(fail(status.UNKNOWN, 'no live worker for sandbox sbx_default'));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({
      kind: 'machinery',
      grpcCode: status.UNKNOWN,
      message: 'sandbox failure: UNKNOWN: no live worker for sandbox sbx_default',
    });
  });

  it('reports a stream that ends without an End event as a machinery failure', async () => {
    const r = await fakeRelay((call) => (call.write(chunk('half')), call.end()));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({ kind: 'machinery' });
  });

  it('treats ExecError "timeout:<n>" as a RESULT with timedOutS, keeping the output so far', async () => {
    const r = await fakeRelay((call, n) => {
      call.write(chunk('so far'));
      execError('timeout:5')(call, n);
    });
    const { c } = conn(r.addr);
    const res = await c.exec('sleep 9', { timeoutS: 5 });
    expect(res.timedOutS).toBe(5);
    expect(res.exitCode).toBeLessThan(0);
    expect(res.stdout).toEqual(Buffer.from('so far'));
    expect(res.capped).toBeUndefined();
  });

  it('treats "timeout:<n>" carried only as the status details as a timeout too', async () => {
    const r = await fakeRelay(fail(status.INTERNAL, 'timeout:7'));
    const { c } = conn(r.addr);
    const res = await c.exec('sleep 9', { timeoutS: 7 });
    expect(res).toMatchObject({ timedOutS: 7, truncated: false });
    expect(res.exitCode).toBeLessThan(0);
  });

  it('does not take a near-miss of the timeout form for a timeout', async () => {
    const r = await fakeRelay(execError('timeout:5 and more'));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({ kind: 'machinery' });
  });

  it('maps the relay\'s RESOURCE_EXHAUSTED "sandbox busy" to kind busy, without a retry', async () => {
    const r = await fakeRelay(
      fail(status.RESOURCE_EXHAUSTED, 'sandbox busy: 2 Execs already in flight'),
    );
    const { c } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({
      kind: 'busy',
      grpcCode: status.RESOURCE_EXHAUSTED,
      message: 'sandbox busy: 2 Execs already in flight',
    });
    expect(r.seen).toHaveLength(1);
  });

  it('keeps any other RESOURCE_EXHAUSTED (a grpc-js size limit) a machinery failure', async () => {
    const r = await fakeRelay(fail(status.RESOURCE_EXHAUSTED, 'Received message larger than max'));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({ kind: 'machinery' });
  });

  it.each([
    'busy: queue full',
    'memory-budget: committing 1 more bytes would reach 2 against a budget of 1',
    'max-runs: MaxRuns=4 reached with 4 unparked runs',
  ])('maps the worker\'s "%s" to kind template_busy', async (message) => {
    const r = await fakeRelay(execError(message));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({
      kind: 'template_busy',
      message: `template busy: ${message}`,
    });
    expect(r.seen).toHaveLength(1);
  });

  it('maps a template-busy refusal carried only as the status details too', async () => {
    const r = await fakeRelay(fail(status.INTERNAL, 'busy: queue full'));
    const { c } = conn(r.addr);
    await expect(c.exec('x')).rejects.toMatchObject({ kind: 'template_busy' });
  });

  it('maps DEADLINE_EXCEEDED "sandbox token expired during the Exec" to kind token_expired', async () => {
    const r = await fakeRelay((call) => {
      call.write(chunk('working'));
      fail(status.DEADLINE_EXCEEDED, 'sandbox token expired during the Exec')(call, 0);
    });
    const { c } = conn(r.addr);
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'token_expired', grpcCode: status.DEADLINE_EXCEEDED });
    expect((e as Error).message).toMatch(/^sandbox token expired during the Exec/);
  });

  it("keeps the command's outcome when its End arrived before a non-OK status", async () => {
    const r = await fakeRelay((call) => {
      call.write({ end: { reqId: 0, exitCode: 0, truncated: true } } as ExecEvent);
      fail(status.DEADLINE_EXCEEDED, 'sandbox token expired during the Exec')(call, 0);
    });
    const { c } = conn(r.addr);
    expect(await c.exec('x')).toMatchObject({ exitCode: 0, truncated: true });
  });

  it("cancels at the worker on abort, and rejects with an AbortError whose cause is the signal's reason", async () => {
    const r = await fakeRelay((call) => call.write(chunk('started')));
    const { c } = conn(r.addr);
    const ac = new AbortController();
    const p = c.exec('sleep 600', { timeoutS: 60, signal: ac.signal });
    await new Promise((res) => setTimeout(res, 50));
    const reason = new Error('stop');
    ac.abort(reason);
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecAbortedError);
    expect(e).toMatchObject({ name: 'AbortError', cause: reason, lease: [] });
    await expect.poll(() => r.aborts.length).toBe(1);
    await expect.poll(() => r.cancelled).toEqual([1]);
    expect(r.aborts[0]).toEqual({
      req: { sandboxId: 'sbx_default', reqId: r.seen[0]!.req.exec!.reqId },
      auth: 'Bearer stale',
    });
  });

  it('sends nothing for a signal that is already aborted', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr);
    await expect(c.exec('x', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
      lease: [],
    });
    expect(r.seen).toHaveLength(0);
  });

  it('speaks TLS to a relay whose self-issued certificate the extra CA trusts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'c.pem'));
    const r = await fakeRelay(ok, { cert, key: readFileSync(join(dir, 'k.pem')) });
    // A hostname, as the real exec Route is: Node refuses an IP address as the TLS server name.
    const { c } = conn(r.addr.replace('127.0.0.1', 'localhost'), {
      tls: true,
      caPem: cert.toString(),
    });
    expect((await c.exec('x')).exitCode).toBe(3);
  });

  it("keeps Node's default roots beside the extra CA (getCACertificates where it exists)", () => {
    const extra = '-----BEGIN CERTIFICATE-----\nEXTRA\n-----END CERTIFICATE-----';
    const asked: string[] = [];
    const modern = {
      getCACertificates: (type: 'default') => (asked.push(type), ['DEFAULT-1', 'OS-ROOT']),
      rootCertificates: ['BUNDLED-ONLY'],
    };
    expect(caBundle(extra, modern).toString()).toBe(`DEFAULT-1\nOS-ROOT\n${extra}`);
    expect(asked).toEqual(['default']);
    // Node < 22.15 has no getCACertificates: the bundled roots.
    expect(caBundle(extra, { rootCertificates: ['BUNDLED-1', 'BUNDLED-2'] }).toString()).toBe(
      `BUNDLED-1\nBUNDLED-2\n${extra}`,
    );
    // And with the real node:tls, every default root is in the bundle.
    const real = caBundle(extra).toString();
    const defaults = nodeTls.getCACertificates?.('default') ?? nodeTls.rootCertificates;
    expect(defaults.length).toBeGreaterThan(0);
    for (const root of defaults) expect(real).toContain(root);
    expect(real.endsWith(extra)).toBe(true);
  });

  it('gives up on a silent relay at a client-side backstop of timeout_s + 90 s', async () => {
    // The relay accepts the Exec and then says nothing, ever.
    const r = await fakeRelay(() => {});
    const { c } = conn(r.addr, { backstopMarginS: 0.3 });
    const t0 = Date.now();
    const e = await c.exec('x', { timeoutS: 1 }).catch((x: unknown) => x);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'machinery', grpcCode: status.DEADLINE_EXCEEDED });
    expect((e as Error).message).toMatch(/client-side backstop deadline/);
    expect(r.seen).toHaveLength(1);
  });

  it('defaults the backstop to timeout_s + 90 s', async () => {
    let deadline: number | undefined;
    const r = await fakeRelay((call, n) => {
      deadline = Number(call.getDeadline());
      ok(call, n);
    });
    const { c } = conn(r.addr);
    const t0 = Date.now();
    await c.exec('x', { timeoutS: 30 });
    expect(deadline! - t0).toBeGreaterThan(119_000);
    expect(deadline! - t0).toBeLessThanOrEqual(121_000);
  });

  it('pings every 20 s, and draws req_ids below 2^53', () => {
    expect(CLIENT_CHANNEL_OPTIONS).toMatchObject({
      'grpc.keepalive_time_ms': 20_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
    });
    const ids = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const id = newReqId();
      expect(Number.isSafeInteger(id) && id >= 0 && id < 2 ** 53).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  it('exposes exec and close as bound functions', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr);
    const { exec, close } = c;
    expect((await exec('x')).exitCode).toBe(3);
    close();
  });
});

describe('SandboxExecConn token freshness (SBX0 §6.5)', () => {
  it('defaults timeout_s to the token lifetime minus 60 s', async () => {
    const r = await fakeRelay(ok);
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900 });
    const res = await c.exec('x');
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(840);
    expect(res.capped).toBeUndefined();
    // The first Exec learns the lifetime from the token it gets; that token already covers 840 + 60.
    expect(asks).toEqual([{ force: false, minValidS: 60 }]);
  });

  it('does not ask twice on the first Exec for a token minted a fraction of a second ago', async () => {
    const r = await fakeRelay(ok);
    const { c, asks } = conn(r.addr, { now: () => NOW_S * 1000 + 400 }, { lifetimeS: 900 });
    await c.exec('x');
    expect(asks).toHaveLength(1);
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(840);
  });

  it('asks for timeout_s + 60 s of life before each Exec once the lifetime is known', async () => {
    const r = await fakeRelay(ok);
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900 });
    await c.exec('x', { timeoutS: 100 });
    await c.exec('y', { timeoutS: 200 });
    await c.exec('z');
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([100, 200, 840]);
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: false, minValidS: 260 },
      { force: false, minValidS: 900 },
    ]);
  });

  it('asks again, once, when the first token does not cover the timeout', async () => {
    const r = await fakeRelay(ok);
    let n = 0;
    // The held token has 100 s left; a fresh mint has the full 900.
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900, leftS: () => (++n === 1 ? 100 : 900) });
    const res = await c.exec('x', { timeoutS: 300 });
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: false, minValidS: 360 },
    ]);
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(300);
    expect(res.capped).toBeUndefined();
  });

  it('caps a longer timeout at the lifetime minus 60 s, and says so on the result', async () => {
    const r = await fakeRelay(ok);
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900 });
    const res = await c.exec('x', { timeoutS: 1800 });
    await c.exec('y', { timeoutS: 1800 });
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([840, 840]);
    expect(res).toMatchObject({ capped: true, exitCode: 3 });
    // Never more life than a token can have: asking for 1860 s would mint on every Exec.
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: false, minValidS: 900 },
    ]);
  });

  it('cuts the timeout to what a short token has left, less 60 s, when even a fresh one is short', async () => {
    // A token minted near the sandbox's own expiry: 300 s left of a 900 s lifetime.
    const r = await fakeRelay(ok);
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900, leftS: () => 300 });
    const res = await c.exec('x', { timeoutS: 600 });
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(240);
    expect(res.capped).toBe(true);
    expect(asks).toHaveLength(2);
  });

  it('marks a DEFAULT timeout as capped when, and only when, it was cut', async () => {
    const r = await fakeRelay(ok);
    const short = conn(r.addr, {}, { lifetimeS: 900, leftS: () => 300 });
    expect((await short.c.exec('x')).capped).toBe(true);
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(240);
    const full = conn(r.addr, {}, { lifetimeS: 900 });
    expect((await full.c.exec('x')).capped).toBeUndefined();
    expect(r.seen[1]!.req.exec!.timeoutS).toBe(840);
  });

  it.each([120, 61, 1])(
    'refuses a token lifetime of %is (too short for the 60 s margin), sending nothing',
    async (lifetimeS) => {
      const r = await fakeRelay(ok);
      const { c } = conn(r.addr, {}, { lifetimeS });
      const e = await c.exec('x', { timeoutS: 10 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExecMachineryError);
      expect(e).toMatchObject({
        kind: 'machinery',
        message: `sandbox token lifetime ${lifetimeS}s is too short (minimum 121s)`,
      });
      expect(r.seen).toHaveLength(0);
    },
  );

  it('runs with a cut timeout when the sandbox expiry capped the token, so a pull still works (final review M1)', async () => {
    const r = await fakeRelay(ok);
    // The control plane caps exp at the sandbox's expiresAt: 100 s left of a 900 s TTL. Without
    // the sandbox's expiry this would be refused as a misconfigured lifetime.
    const { c } = conn(r.addr, { sandboxExpiresAt: NOW_S + 100 }, { lifetimeS: 100 });
    const res = await c.exec('git diff', { timeoutS: 300 });
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(40);
    expect(res.capped).toBe(true);
  });

  it('says the sandbox expires soon, not "lifetime too short", once nothing can run (final review M1)', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, { sandboxExpiresAt: NOW_S + 50 }, { lifetimeS: 50 });
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect((e as Error).message).toBe(
      'the sandbox expires in 50 s; pull your work now: `mocactl sbx pull --apply`',
    );
    expect(r.seen).toHaveLength(0);
    // A short token that ends before the sandbox does is still the configuration's fault.
    const early = conn(r.addr, { sandboxExpiresAt: NOW_S + 5000 }, { lifetimeS: 100 });
    await expect(early.c.exec('x')).rejects.toThrow(/lifetime 100s is too short/);
    // And with no sandbox expiry known, as before.
    const unknown = conn(r.addr, {}, { lifetimeS: 100 });
    await expect(unknown.c.exec('x')).rejects.toThrow(/lifetime 100s is too short/);
  });

  it('keeps the learnt lifetime when a later token is capped by the sandbox expiry (final review M1)', async () => {
    const r = await fakeRelay(ok);
    let nowS = NOW_S;
    const sandboxExpiresAt = NOW_S + 1000;
    const grant = () => {
      const exp = Math.min(nowS + 900, sandboxExpiresAt);
      return { token: 't', expiresAt: exp, lifetimeS: exp - nowS };
    };
    const { c } = conn(r.addr, {
      sandboxExpiresAt,
      now: () => nowS * 1000,
      token: async () => grant(),
    });
    await c.exec('x');
    nowS = sandboxExpiresAt - 90; // the next mint is cut to the sandbox's end: 90 s
    expect((await c.exec('y')).capped).toBe(true);
    nowS = sandboxExpiresAt - 30;
    await expect(c.exec('z')).rejects.toThrow(
      'the sandbox expires in 30 s; pull your work now: `mocactl sbx pull --apply`',
    );
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([840, 30]);
  });

  it.each([60, 30, 0])(
    'refuses as expiring, sending nothing, when even a fresh token has %i s left: within the 60 s margin (review #554)',
    async (leftS) => {
      // Clock skew, or a token whose lifetime reads fine but whose exp is all but here.
      const r = await fakeRelay(ok);
      const { c, asks } = conn(r.addr, {}, { lifetimeS: 900, leftS: () => leftS });
      const e = await c.exec('x', { timeoutS: 30 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExecMachineryError);
      expect(e).toMatchObject({ kind: 'expiring', mayHaveRun: false });
      expect((e as Error).message).toMatch(/^the sandbox token has \d+ s left/);
      expect(r.seen).toHaveLength(0);
      // Only after a fresh mint was asked for: one covering the timeout and its margin.
      expect(asks.at(-1)).toEqual({ force: false, minValidS: 90 });
    },
  );

  it('still runs with a 1 s timeout when the token has 61 s left (the margin plus one)', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, {}, { lifetimeS: 900, leftS: () => 61 });
    expect((await c.exec('x', { timeoutS: 30 })).capped).toBe(true);
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(1);
  });

  it('refuses as expiring when the lifetime is unreadable and the token has no time left', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, {}, { lifetimeS: 0, leftS: () => 20 });
    await expect(c.exec('x')).rejects.toMatchObject({ kind: 'expiring' });
    expect(r.seen).toHaveLength(0);
  });

  it('accepts the shortest usable lifetime, 121 s, with a 61 s default timeout', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, {}, { lifetimeS: 121 });
    expect((await c.exec('x')).capped).toBeUndefined();
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(61);
  });

  it('fits the timeout again to a fresh token shorter than the first, on the UNAUTHENTICATED retry', async () => {
    const r = await fakeRelay((call, n) =>
      n === 1 ? fail(status.UNAUTHENTICATED, 'exec authentication failed')(call, n) : ok(call, n),
    );
    // The first token covers 600 + 60; the fresh one, minted near the sandbox's expiry, has 200 s.
    const { c, asks } = conn(r.addr, {}, { lifetimeS: 900, leftS: (force) => (force ? 200 : 900) });
    const res = await c.exec('x', { timeoutS: 600 });
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([600, 140]);
    expect(r.seen[1]!.req.exec!.reqId).toBe(r.seen[0]!.req.exec!.reqId);
    expect(r.seen[1]!.auth).toBe('Bearer fresh');
    expect(res.capped).toBe(true);
    expect(asks.at(-1)).toEqual({ force: true, minValidS: 660 });
  });

  it('applies the lifetime cap of a fresh token with a shorter lifetime on the retry', async () => {
    const r = await fakeRelay((call, n) =>
      n === 1 ? fail(status.UNAUTHENTICATED, 'exec authentication failed')(call, n) : ok(call, n),
    );
    let lifetime = 900;
    const { c } = conn(r.addr, {
      token: async (o) => {
        if (o.force) lifetime = 300;
        return {
          token: o.force ? 'fresh' : 'stale',
          expiresAt: NOW_S + lifetime,
          lifetimeS: lifetime,
        };
      },
    });
    // A defaulted timeout is that token's own default, lifetime - 60: not a cut.
    expect((await c.exec('x')).capped).toBeUndefined();
    // A requested one over the new cap is cut, and says so (no retry this time: n > 1).
    expect((await c.exec('y', { timeoutS: 600 })).capped).toBe(true);
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([840, 240, 240]);
  });

  it('uses 120 s by default when no lifetime can be read, and still cuts to the life left', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, {}, { lifetimeS: 0, leftS: () => 900 });
    expect((await c.exec('x')).capped).toBeUndefined();
    expect((await c.exec('y', { timeoutS: 3000 })).capped).toBe(true);
    expect(r.seen.map((s) => s.req.exec!.timeoutS)).toEqual([120, 840]);
  });

  it('sends the timeout as asked when neither lifetime nor expiry can be read', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr, {}, { lifetimeS: 0, leftS: () => -NOW_S });
    await c.exec('x', { timeoutS: 3000 });
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(3000);
  });

  it('rounds a fractional timeout up and refuses a non-positive one, sending nothing', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr);
    await c.exec('x', { timeoutS: 1.5 });
    expect(r.seen[0]!.req.exec!.timeoutS).toBe(2);
    await expect(c.exec('x', { timeoutS: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(c.exec('x', { timeoutS: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    expect(r.seen).toHaveLength(1);
  });

  it('propagates a token source failure unchanged, sending nothing', async () => {
    const r = await fakeRelay(ok);
    const boom = new Error('sandbox sbx_x was deleted');
    const { c } = conn(r.addr, {
      token: async () => {
        throw boom;
      },
    });
    await expect(c.exec('x')).rejects.toBe(boom);
    expect(r.seen).toHaveLength(0);
  });
});

describe('SandboxExecConn lease mode (plan 4, spec §5, §8.3)', () => {
  const T = 1_800_000_000_000;
  const leaseEv = (over: Partial<LeaseEvent>) =>
    LeaseEvent.fromPartial({ atUnixMs: T, mode: SandboxMode.SANDBOX_MODE_LEASE, ...over });
  const end = leaseEv({ state: 'end', reason: 'idle', ageMs: 5000 });
  const start = leaseEv({ state: 'start', atUnixMs: T + 1 });

  it("collects the lease events an Exec's response carried, in order, before its End", async () => {
    const r = await fakeRelay((call) => {
      call.write(chunk('out'));
      call.write({ lease: end } as ExecEvent);
      call.write({ lease: start } as ExecEvent);
      call.write({ end: { reqId: 0, exitCode: 0, truncated: false } } as ExecEvent);
      call.end();
    });
    const res = await conn(r.addr).c.exec('x');
    expect(res.lease).toEqual([end, start]);
    expect(res.stdout).toEqual(Buffer.from('out'));
    expect(res.exitCode).toBe(0);
  });

  it('keeps the lease events on a timeout result too', async () => {
    const r = await fakeRelay((call, n) => {
      call.write({ lease: start } as ExecEvent);
      execError('timeout:5')(call, n);
    });
    const res = await conn(r.addr).c.exec('x');
    expect(res).toMatchObject({ timedOutS: 5, lease: [start] });
  });

  it('carries the lease events on a failed Exec: lease_ended( may have run', async () => {
    const r = await fakeRelay((call, n) => {
      call.write({ lease: end } as ExecEvent);
      execError('lease_ended(grace_limit)')(call, n);
    });
    const e = await conn(r.addr)
      .c.exec('x')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ kind: 'machinery', mayHaveRun: true, lease: [end] });
    const none = await fakeRelay(fail(status.UNKNOWN, 'no live worker'));
    await expect(conn(none.addr).c.exec('x')).rejects.toMatchObject({ lease: [] });
  });

  it('classifies stale_mode: and lease_unsupported: as refused before the start', async () => {
    // stale_mode is retried once under a forced fresh token (P4-R21); lease_unsupported is not.
    for (const [m, attempts] of [
      ['stale_mode: x', 2],
      ['lease_unsupported: this worker has no lease mode', 1],
    ] as const) {
      const r = await fakeRelay(execError(m));
      await expect(conn(r.addr).c.exec('x')).rejects.toMatchObject({
        kind: 'machinery',
        mayHaveRun: false,
        message: `sandbox failure: ${m}`,
      });
      expect(r.seen).toHaveLength(attempts);
    }
  });

  it('retries a stale_mode: refusal once under a forced fresh token, a new req_id (P4-R21)', async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1) return ok(call, n);
      // The worker sends a pending lease event before its refusal, too.
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: workspace_key sbx-aaaa Exec mode_epoch 3 is below the stored 4')(
        call,
        n,
      );
    });
    const { c, asks } = conn(r.addr);
    const res = await c.exec('cat f', { timeoutS: 60 });
    expect(res).toMatchObject({ exitCode: 3, stdout: Buffer.from('out'), lease: [end] });
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: true, minValidS: 120 },
    ]);
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(r.seen.map((s) => s.req.exec!.command)).toEqual(['cat f', 'cat f']);
    // A new id: the worker fingerprints the epoch, so the old id would read as a collision.
    expect(r.seen[1]!.req.exec!.reqId).not.toBe(r.seen[0]!.req.exec!.reqId);
    // A second stale_mode is surfaced, carrying the first refusal's lease events too.
    const twice = await fakeRelay((call, n) => {
      call.write({ lease: n === 1 ? end : start } as ExecEvent);
      execError('stale_mode: again')(call, n);
    });
    const e = await conn(twice.addr)
      .c.exec('x')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({
      kind: 'machinery',
      mayHaveRun: false,
      message: 'sandbox failure: stale_mode: again',
      lease: [end, start],
    });
    expect(twice.seen).toHaveLength(2);
  });

  it('carries the lease events that arrived before an abort on its AbortError (review #4569829023)', async () => {
    const r = await fakeRelay((call) => {
      call.write({ lease: end } as ExecEvent);
      call.write(chunk('started'));
    });
    const ac = new AbortController();
    const p = conn(r.addr).c.exec('sleep 600', { timeoutS: 60, signal: ac.signal });
    await new Promise((res) => setTimeout(res, 50));
    ac.abort();
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecAbortedError);
    expect(e).toMatchObject({ name: 'AbortError', lease: [end] });
    // An abort during the stale_mode retry carries the first attempt's events too.
    const ac2 = new AbortController();
    const twice = await fakeRelay((call, n) => {
      if (n === 1) {
        call.write({ lease: end } as ExecEvent);
        return execError('stale_mode: x')(call, n);
      }
      call.write({ lease: start } as ExecEvent);
      setTimeout(() => ac2.abort(), 20);
    });
    const e2 = await conn(twice.addr)
      .c.exec('x', { signal: ac2.signal })
      .catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(ExecAbortedError);
    expect(e2).toMatchObject({ lease: [end, start] });
  });

  it("keeps a stale_mode refusal's lease events when the retry is refused as unauthenticated (review #4569829028)", async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1) return fail(status.UNAUTHENTICATED, 'token rejected')(call, n);
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const e = await conn(r.addr)
      .c.exec('x')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecRefusedError);
    expect(e).toMatchObject({ grpcCode: status.UNAUTHENTICATED, lease: [end] });
    expect((e as Error).message).toBe(
      'token rejected (after a stale_mode refusal and a fresh token)',
    );
    expect((e as Error).message).not.toContain('token refresh');
    expect(r.seen).toHaveLength(2);
  });

  it('sets Exec.keepalive from the keepalive option, false by default', async () => {
    const r = await fakeRelay(ok);
    await conn(r.addr).c.exec('x');
    await conn(r.addr, { keepalive: true }).c.exec('y');
    expect(r.seen.map((s) => s.req.exec!.keepalive)).toEqual([false, true]);
  });

  it('reads a keepalive function at each Exec (P4-R6)', async () => {
    const r = await fakeRelay(ok);
    let on = true;
    const c = conn(r.addr, { keepalive: () => on }).c;
    await c.exec('x');
    on = false;
    await c.exec('y');
    expect(r.seen.map((s) => s.req.exec!.keepalive)).toEqual([true, false]);
  });

  it("round-trips leaseControl('status') under the sandbox token", async () => {
    const r = await fakeRelay(ok, undefined, {
      control: () => ({
        status: LeaseStatus.fromPartial({
          mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
          epochKnown: true,
          state: 'active',
          ageMs: 1234,
          idleTimeoutS: 900,
          pending: end,
        }),
      }),
    });
    const { c, asks } = conn(r.addr);
    expect(await c.leaseControl('status')).toEqual({
      mode: 'lease+processes',
      epochKnown: true,
      state: 'active',
      ageMs: 1234,
      idleTimeoutS: 900,
      pending: end,
    });
    expect(asks).toEqual([{ force: false, minValidS: 60 }]);
    expect(r.controls).toEqual([
      {
        req: { sandboxId: 'sbx_default', op: LeaseOp.LEASE_OP_STATUS, setModeToken: '' },
        auth: 'Bearer stale',
      },
    ]);
  });

  it('sends each op, the set-mode token only with set_mode, and reads a bare status as per-exec', async () => {
    const r = await fakeRelay(ok, undefined, { control: () => ({ status: undefined }) });
    const { c } = conn(r.addr);
    const bare = {
      mode: 'per-exec',
      epochKnown: false,
      state: 'none',
      ageMs: 0,
      idleTimeoutS: 0,
    };
    expect(await c.leaseControl('reset')).toEqual(bare);
    expect(await c.leaseControl('set_mode', 'mode.jwt')).toEqual(bare);
    expect(await c.leaseControl('sandbox_deleted', 'ignored')).toEqual(bare);
    expect(r.controls.map((x) => [x.req.op, x.req.setModeToken])).toEqual([
      [LeaseOp.LEASE_OP_RESET, ''],
      [LeaseOp.LEASE_OP_SET_MODE, 'mode.jwt'],
      [LeaseOp.LEASE_OP_SANDBOX_DELETED, ''],
    ]);
    for (const [mode, name] of [
      [SandboxMode.SANDBOX_MODE_UNSPECIFIED, 'per-exec'],
      [SandboxMode.SANDBOX_MODE_PER_EXEC, 'per-exec'],
      [SandboxMode.SANDBOX_MODE_LEASE, 'lease'],
    ] as const) {
      const m = await fakeRelay(ok, undefined, {
        control: () => ({ status: LeaseStatus.fromPartial({ mode, state: 'expiring' }) }),
      });
      expect(await conn(m.addr).c.leaseControl('status')).toMatchObject({
        mode: name,
        state: 'expiring',
      });
    }
  });

  it('maps each §8.3 status to a LeaseControlError code; failed carries the wire string', async () => {
    const table = [
      [status.UNAUTHENTICATED, 'unauthenticated'],
      [status.PERMISSION_DENIED, 'denied'],
      [status.INVALID_ARGUMENT, 'invalid'],
      [status.RESOURCE_EXHAUSTED, 'busy'],
      [status.DEADLINE_EXCEEDED, 'timeout'],
      [status.UNAVAILABLE, 'unavailable'],
      [status.CANCELLED, 'cancelled'],
      [status.FAILED_PRECONDITION, 'failed'],
    ] as const;
    for (const [code, name] of table) {
      const details = code === status.FAILED_PRECONDITION ? 'stale_mode: epoch 3 < 4' : 'nope';
      const r = await fakeRelay(ok, undefined, { control: () => ({ code, details }) });
      const e = await conn(r.addr)
        .c.leaseControl('status')
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LeaseControlError);
      expect(e).toMatchObject({ code: name, grpcCode: code, message: details });
      expect((e as LeaseControlError).wire).toBe(
        code === status.FAILED_PRECONDITION ? details : undefined,
      );
      // Only a token refusal is retried, once (P4-R7).
      expect(r.controls).toHaveLength(code === status.UNAUTHENTICATED ? 2 : 1);
    }
    // Any other status is a failure with no wire string.
    const r = await fakeRelay(ok, undefined, {
      control: () => ({ code: status.INTERNAL, details: 'boom' }),
    });
    const e = await conn(r.addr)
      .c.leaseControl('reset')
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'failed', grpcCode: status.INTERNAL, wire: undefined });
  });

  it('sends leaseKeepalive under the sandbox token, and maps its errors', async () => {
    const r = await fakeRelay(ok);
    const { c } = conn(r.addr);
    await expect(c.leaseKeepalive()).resolves.toBeUndefined();
    expect(r.keepalives).toEqual([{ req: { sandboxId: 'sbx_default' }, auth: 'Bearer stale' }]);
    const denied = await fakeRelay(ok, undefined, {
      keepalive: () => ({ code: status.PERMISSION_DENIED, details: 'not permitted' }),
    });
    await expect(conn(denied.addr).c.leaseKeepalive()).rejects.toMatchObject({
      name: 'LeaseControlError',
      code: 'denied',
    });
  });

  it('retries a lease call once with a forced fresh token after UNAUTHENTICATED (P4-R7)', async () => {
    const refuseFirst = <R>(answer: R) => {
      let n = 0;
      return () =>
        n++ === 0
          ? { code: status.UNAUTHENTICATED, details: 'lease authentication failed' }
          : answer;
    };
    const r = await fakeRelay(ok, undefined, {
      control: refuseFirst({
        status: LeaseStatus.fromPartial({ mode: SandboxMode.SANDBOX_MODE_LEASE, state: 'active' }),
      }),
      keepalive: refuseFirst({}),
    });
    const { c, asks } = conn(r.addr);
    await expect(c.leaseControl('set_mode', 'mode.jwt')).resolves.toMatchObject({
      mode: 'lease',
      state: 'active',
    });
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: true, minValidS: 60 },
    ]);
    // The same set-mode token both times: the relay refused the bearer before routing.
    expect(r.controls.map((x) => [x.auth, x.req.op, x.req.setModeToken])).toEqual([
      ['Bearer stale', LeaseOp.LEASE_OP_SET_MODE, 'mode.jwt'],
      ['Bearer fresh', LeaseOp.LEASE_OP_SET_MODE, 'mode.jwt'],
    ]);
    asks.length = 0;
    await expect(c.leaseKeepalive()).resolves.toBeUndefined();
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: true, minValidS: 60 },
    ]);
    expect(r.keepalives.map((x) => x.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('surfaces a second UNAUTHENTICATED as unauthenticated, after exactly two requests', async () => {
    const refused = { code: status.UNAUTHENTICATED, details: 'lease authentication failed' };
    const r = await fakeRelay(ok, undefined, { control: () => refused, keepalive: () => refused });
    const { c } = conn(r.addr);
    for (const op of ['status', 'reset', 'set_mode', 'sandbox_deleted'] as const) {
      r.controls.length = 0;
      const e = await c.leaseControl(op, 'mode.jwt').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LeaseControlError);
      expect(e).toMatchObject({ code: 'unauthenticated', grpcCode: status.UNAUTHENTICATED });
      expect(r.controls.map((x) => x.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    }
    await expect(c.leaseKeepalive()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(r.keepalives).toHaveLength(2);
  });

  it("retries only the relay's token refusal: a failing token source is not retried", async () => {
    const r = await fakeRelay(ok);
    const asks: TokenRequest[] = [];
    const { c } = conn(r.addr, {
      token: async (o) => {
        asks.push(o);
        throw new LeaseControlError('unauthenticated', 'the token source says no');
      },
    });
    await expect(c.leaseControl('status')).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'the token source says no',
    });
    await expect(c.leaseKeepalive()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(asks).toEqual([
      { force: false, minValidS: 60 },
      { force: false, minValidS: 60 },
    ]);
    expect(r.controls).toHaveLength(0);
    expect(r.keepalives).toHaveLength(0);
  });

  it('does not retry any other refusal', async () => {
    const r = await fakeRelay(ok, undefined, {
      control: () => ({ code: status.PERMISSION_DENIED, details: 'set_mode not permitted' }),
    });
    const { c, asks } = conn(r.addr);
    await expect(c.leaseControl('set_mode', 'mode.jwt')).rejects.toMatchObject({ code: 'denied' });
    expect(r.controls).toHaveLength(1);
    expect(asks).toEqual([{ force: false, minValidS: 60 }]);
  });

  it('an abort cancels a lease call: LeaseControlError cancelled (P4-R12)', async () => {
    const r = await fakeRelay(ok, undefined, { control: () => HANG });
    const { c } = conn(r.addr);
    const ac = new AbortController();
    const p = c.leaseControl('set_mode', 'mode.jwt', { signal: ac.signal });
    await vi.waitFor(() => expect(r.controls).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'LeaseControlError', code: 'cancelled' });
    // Already aborted: nothing is sent.
    await expect(c.leaseControl('reset', undefined, { signal: ac.signal })).rejects.toMatchObject({
      name: 'LeaseControlError',
      code: 'cancelled',
    });
    expect(r.controls).toHaveLength(1);
  });

  it('propagates a token source failure from a lease call unchanged, sending nothing', async () => {
    const r = await fakeRelay(ok);
    const boom = new Error('sandbox sbx_x was deleted');
    const { c } = conn(r.addr, {
      token: async () => {
        throw boom;
      },
    });
    await expect(c.leaseControl('status')).rejects.toBe(boom);
    await expect(c.leaseKeepalive()).rejects.toBe(boom);
    expect(r.controls).toHaveLength(0);
    expect(r.keepalives).toHaveLength(0);
  });
});

describe('SandboxExecConn process calls (plan 5, spec §7)', () => {
  const T = 1_800_000_000_000;
  const end = LeaseEvent.fromPartial({
    state: 'end',
    reason: 'idle',
    atUnixMs: T,
    mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
  });
  const start = LeaseEvent.fromPartial({
    state: 'start',
    atUnixMs: T + 1,
    mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES,
  });
  /** The guest's answer on stdout, as the worker passes it through, then an End. */
  const answers =
    (stdout: string, lease: LeaseEvent[] = []): Behaviour =>
    (call) => {
      for (const ev of lease) call.write({ lease: ev } as ExecEvent);
      if (stdout) call.write(chunk(stdout));
      call.write({ end: { reqId: 0, exitCode: 0, truncated: false } } as ExecEvent);
      call.end();
    };
  const row = (over: Record<string, unknown> = {}) => ({
    id: '3',
    name: 'web',
    pid: 412,
    state: 'running',
    code: 0,
    started_unix_ms: NOW_S * 1000 - 130_000,
    memory_bytes: 4096,
    ...over,
  });

  it('start sends a PROCESS_START Exec with the command and its args, and reads {id, name, pid}', async () => {
    const r = await fakeRelay(answers('{"id":"3","name":"web","pid":412}', [end]));
    const { c } = conn(r.addr);
    const got = await c.process('start', {
      command: 'python3 -m http.server 8080',
      name: 'web',
      cwd: 'app',
    });
    expect(got).toEqual({ result: { id: '3', name: 'web', pid: 412 }, lease: [end] });
    const e = r.seen[0]!.req.exec!;
    expect(e).toMatchObject({
      kind: ExecKind.EXEC_KIND_PROCESS_START,
      command: 'python3 -m http.server 8080',
      process: { name: 'web', cwd: 'app', id: '', tail: 0, signal: '' },
      workspaceKey: 'sbx-aaaa',
      streaming: true,
    });
    // A short timeout of its own, so it fits the held token rather than minting a fresh one.
    expect(e.timeoutS).toBe(60);
    expect(r.seen[0]!.req.sandboxId).toBe('sbx_default');
  });

  it('list sends PROCESS_LIST with no command and reads the table, oldest first, ages by this clock', async () => {
    const r = await fakeRelay(
      answers(
        JSON.stringify([
          row(),
          row({ id: '4', name: 'p4', pid: 9, state: 'exited', code: 1, memory_bytes: 0 }),
        ]),
      ),
    );
    const { c } = conn(r.addr);
    const got = await c.process('list', {});
    expect(got.result).toEqual([
      {
        id: '3',
        name: 'web',
        pid: 412,
        state: 'running',
        code: 0,
        ageMs: 130_000,
        memoryBytes: 4096,
      },
      { id: '4', name: 'p4', pid: 9, state: 'exited', code: 1, ageMs: 130_000, memoryBytes: 0 },
    ]);
    expect(r.seen[0]!.req.exec).toMatchObject({
      kind: ExecKind.EXEC_KIND_PROCESS_LIST,
      command: '',
    });
    // An empty table is an empty array; a started time ahead of this clock is age 0.
    const none = await fakeRelay(answers('[]'));
    expect((await conn(none.addr).c.process('list', {})).result).toEqual([]);
    const ahead = await fakeRelay(
      answers(JSON.stringify([row({ started_unix_ms: NOW_S * 1000 + 5_000 })])),
    );
    expect((await conn(ahead.addr).c.process('list', {})).result[0]!.ageMs).toBe(0);
  });

  it('logs sends PROCESS_LOGS with the id or name and the tail, and returns stdout as text', async () => {
    const r = await fakeRelay(answers('line 1\nline 2\n'));
    const { c } = conn(r.addr);
    expect((await c.process('logs', { name: 'web', tail: 50 })).result).toBe('line 1\nline 2\n');
    expect(r.seen[0]!.req.exec).toMatchObject({
      kind: ExecKind.EXEC_KIND_PROCESS_LOGS,
      command: '',
      process: { name: 'web', id: '', tail: 50 },
    });
    // No output is an empty log, not an error.
    const quiet = await fakeRelay(answers(''));
    expect((await conn(quiet.addr).c.process('logs', { id: '3' })).result).toBe('');
  });

  it('stop sends PROCESS_STOP with the id or name and the signal, and reads the final state', async () => {
    const r = await fakeRelay(answers(JSON.stringify(row({ state: 'killed', code: 15 }))));
    const { c } = conn(r.addr);
    const got = await c.process('stop', { id: '3', signal: 'INT' });
    expect(got.result).toMatchObject({ id: '3', state: 'killed', code: 15, ageMs: 130_000 });
    expect(r.seen[0]!.req.exec).toMatchObject({
      kind: ExecKind.EXEC_KIND_PROCESS_STOP,
      process: { id: '3', name: '', signal: 'INT' },
    });
  });

  it('retries a token refusal once under a fresh token, as exec does', async () => {
    const r = await fakeRelay((call, n) =>
      n === 1 ? fail(status.UNAUTHENTICATED, 'token rejected')(call, n) : answers('[]')(call, n),
    );
    const { c } = conn(r.addr);
    expect((await c.process('list', {})).result).toEqual([]);
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(r.seen[1]!.req.exec!.reqId).toBe(r.seen[0]!.req.exec!.reqId);
  });

  it('re-mints on a stale_mode refusal under a new req_id, carrying its events, as exec does', async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1) return answers('[]', [start])(call, n);
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const { c } = conn(r.addr);
    expect(await c.process('list', {})).toEqual({ result: [], lease: [end, start] });
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(r.seen[1]!.req.exec!.reqId).not.toBe(r.seen[0]!.req.exec!.reqId);
    expect(r.seen[1]!.req.exec!.kind).toBe(ExecKind.EXEC_KIND_PROCESS_LIST);
  });

  it("maps the worker's process wire errors to a ProcessError carrying the code, detail and events", async () => {
    for (const [wire, code, detail] of [
      ['process_not_found: web', 'process_not_found', 'web'],
      [
        'process_limit: 4 running (SH_LEASE_MAX_PROCESSES)',
        'process_limit',
        '4 running (SH_LEASE_MAX_PROCESSES)',
      ],
      ['process_name_taken: web', 'process_name_taken', 'web'],
      ['process_cwd: ../x: outside the workspace', 'process_cwd', '../x: outside the workspace'],
      [
        'process_name_invalid: "a b": want 1-64 characters of [A-Za-z0-9._-]',
        'process_name_invalid',
        '"a b": want 1-64 characters of [A-Za-z0-9._-]',
      ],
      ['process_signal: unknown signal FOO', 'process_signal', 'unknown signal FOO'],
      [
        'processes_not_enabled: the lease is at lease',
        'processes_not_enabled',
        'the lease is at lease',
      ],
      [
        'lease_unsupported: the snapshot has no lease-processes-v1',
        'lease_unsupported',
        'the snapshot has no lease-processes-v1',
      ],
    ] as const) {
      const r = await fakeRelay((call, n) => {
        call.write({ lease: end } as ExecEvent);
        execError(wire)(call, n);
      });
      const e = await conn(r.addr)
        .c.process('logs', { name: 'web' })
        .catch((x: unknown) => x);
      expect(e, wire).toBeInstanceOf(ProcessError);
      expect(e, wire).toMatchObject({ code, detail, wire, lease: [end] });
      expect(r.seen, wire).toHaveLength(1); // a refusal is never retried
    }
  });

  it("maps the relay's processes_not_enabled refusal (FAILED_PRECONDITION, no event), refused again after the re-mint, to a ProcessError", async () => {
    const r = await fakeRelay(
      fail(status.FAILED_PRECONDITION, "processes_not_enabled: this sandbox's mode is lease"),
    );
    const { c, asks } = conn(r.addr);
    const e = await c.process('start', { command: 'sleep 9' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProcessError);
    expect(e).toMatchObject({
      code: 'processes_not_enabled',
      detail: "this sandbox's mode is lease",
      lease: [],
    });
    // One forced re-mint and one retry (P5-R29), then the refusal is surfaced.
    expect(r.seen).toHaveLength(2);
    expect(asks.map((a) => a.force)).toEqual([false, true]);
  });

  it("maps the relay's worker-capability refusal (FAILED_PRECONDITION lease_unsupported, P5-R37) to a ProcessError, never retried", async () => {
    const r = await fakeRelay(
      fail(
        status.FAILED_PRECONDITION,
        "lease_unsupported: this sandbox's worker does not support tracked processes",
      ),
    );
    const { c, asks } = conn(r.addr);
    const e = await c.process('start', { command: 'sleep 9' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProcessError);
    expect(e).toMatchObject({
      code: 'lease_unsupported',
      detail: "this sandbox's worker does not support tracked processes",
      lease: [],
    });
    // Nothing ran, and a fresh token would not change the worker: one Exec, no re-mint.
    expect(r.seen).toHaveLength(1);
    expect(asks.map((a) => a.force)).toEqual([false]);
  });

  it("re-mints once on the relay's processes_not_enabled and retries under a new req_id: an upgrade since the held token (P5-R29)", async () => {
    const r = await fakeRelay((call, n) =>
      n === 1
        ? fail(status.FAILED_PRECONDITION, "processes_not_enabled: this sandbox's mode is lease")(
            call,
            n,
          )
        : answers('{"id":"1","name":"web","pid":7}', [start])(call, n),
    );
    const { c, asks } = conn(r.addr);
    expect(await c.process('start', { command: 'serve', name: 'web' })).toEqual({
      result: { id: '1', name: 'web', pid: 7 },
      lease: [start],
    });
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(asks.map((a) => a.force)).toEqual([false, true]);
    expect(r.seen[1]!.req.exec!.reqId).not.toBe(r.seen[0]!.req.exec!.reqId);
    expect(r.seen[1]!.req.exec).toMatchObject({
      kind: ExecKind.EXEC_KIND_PROCESS_START,
      command: 'serve',
    });
  });

  it('a stale_mode first attempt keeps its events on a ProcessError retry (the M3 follow-up)', async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1)
        return fail(
          status.FAILED_PRECONDITION,
          "processes_not_enabled: this sandbox's mode is lease",
        )(call, n);
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const e = await conn(r.addr)
      .c.process('list', {})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProcessError);
    expect(e).toMatchObject({ code: 'processes_not_enabled', lease: [end] });
  });

  it('reads an answer that is not the expected JSON as a machinery failure, never as a result', async () => {
    for (const [op, out] of [
      ['list', 'not json'],
      ['list', '{"id":"3"}'],
      ['start', '[]'],
      ['stop', ''],
    ] as const) {
      const r = await fakeRelay(answers(out));
      const e = await conn(r.addr)
        .c.process(op as 'list', op === 'start' ? ({ command: 'x' } as never) : {})
        .catch((x: unknown) => x);
      expect(e, `${op} ${out}`).toBeInstanceOf(ExecMachineryError);
      expect((e as Error).message, `${op} ${out}`).toMatch(
        new RegExp(`^sandbox failure: unreadable process_${op} answer`),
      );
    }
  });

  // Final review M4: a process call queues on the sandbox's one run gate, so its timeout means
  // another command held the sandbox all along, and the text says so.
  it('a process call that timed out says it waited for the sandbox', async () => {
    const r = await fakeRelay(execError('timeout:60'));
    const e = await conn(r.addr)
      .c.process('stop', { name: 'web' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect((e as Error).message).toBe(
      'sandbox failure: process_stop timed out waiting for the sandbox (another command may still be running)',
    );
    expect(execFailureText(e, { audience: 'cli' })).toBe(
      'sandbox failure: process_stop timed out waiting for the sandbox (another command may still be running); the command may have partly run',
    );
  });

  it('sends nothing for a signal that is already aborted', async () => {
    const r = await fakeRelay(answers('[]'));
    const ac = new AbortController();
    ac.abort();
    await expect(conn(r.addr).c.process('list', {}, { signal: ac.signal })).rejects.toBeInstanceOf(
      ExecAbortedError,
    );
    expect(r.seen).toHaveLength(0);
  });
});

describe('SandboxExecConn: a refused first attempt keeps its events on a failed retry (the M3 follow-up)', () => {
  const end = LeaseEvent.fromPartial({
    state: 'end',
    reason: 'idle',
    atUnixMs: 1_800_000_000_000,
    mode: SandboxMode.SANDBOX_MODE_LEASE,
  });

  it('a stale_mode refusal, then a retry refused PERMISSION_DENIED', async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1) return fail(status.PERMISSION_DENIED, 'exec not permitted')(call, n);
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const e = await conn(r.addr)
      .c.exec('x')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecRefusedError);
    expect(e).toMatchObject({ grpcCode: status.PERMISSION_DENIED, lease: [end] });
  });

  it('a stale_mode refusal, then a retry that fails as machinery', async () => {
    const r = await fakeRelay((call, n) => {
      if (n > 1) return fail(status.UNAVAILABLE, 'worker gone')(call, n);
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const e = await conn(r.addr)
      .c.exec('x')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecMachineryError);
    expect(e).toMatchObject({ lease: [end] });
  });
});

describe("SandboxExecConn: a failed re-mint keeps the first attempt's events (fix round 1, Minor 1)", () => {
  const end = LeaseEvent.fromPartial({
    state: 'end',
    reason: 'idle',
    atUnixMs: 1_800_000_000_000,
    mode: SandboxMode.SANDBOX_MODE_LEASE,
  });

  it('attaches them to the token source error, which is thrown unchanged otherwise', async () => {
    const r = await fakeRelay((call, n) => {
      call.write({ lease: end } as ExecEvent);
      execError('stale_mode: Exec mode_epoch 3 is below the stored 4')(call, n);
    });
    const boom = new Error('control plane unreachable');
    const { c } = conn(r.addr, {
      token: async (o) => {
        if (o.force) throw boom;
        return { token: 'stale', expiresAt: NOW_S + 900, lifetimeS: 900 };
      },
    });
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(e).toMatchObject({ lease: [end] });
    expect(r.seen).toHaveLength(1);
  });

  it('leaves a token source error with nothing carried as it was', async () => {
    const r = await fakeRelay(fail(status.UNAUTHENTICATED, 'token rejected'));
    const boom = new Error('control plane unreachable');
    const { c } = conn(r.addr, {
      token: async (o) => {
        if (o.force) throw boom;
        return { token: 'stale', expiresAt: NOW_S + 900, lifetimeS: 900 };
      },
    });
    const e = await c.exec('x').catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(e).not.toHaveProperty('lease');
  });
});
