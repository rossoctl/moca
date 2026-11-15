import { generateKeyPairSync } from 'node:crypto';
import {
  Metadata,
  credentials,
  makeGenericClientConstructor,
  status,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import {
  SandboxExecClient,
  SandboxWorkerService,
  Stream,
  Exec,
  LeaseEvent,
  LeaseControlResult,
  type ExecEvent,
  type LeaseControlFrame,
  type LeaseKeepaliveFrame,
  type ServerFrame,
  type WorkerFrame,
} from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';
import {
  SANDBOX_TOKEN_AUDIENCE,
  SANDBOX_SCOPE_EXEC,
  makeSigner,
  mintSandboxToken,
  mintSetModeToken,
} from '@moca/control-plane';
import { makeExecAuth, startRelay, type RelayServerDeps } from '../../src/main.js';
import { workerReqId } from '../../src/sandbox-auth.js';

// The sandbox relay's transport test kit: a real grpc-js relay, a fake worker attached to it and a
// SandboxExec client, over loopback. Shared by sandbox-token.transport.test.ts and
// audit.transport.test.ts. A test file registers `afterEach(closeAll)`.

export const records: RecordStore = {
  put: async () => {},
  remove: async () => {},
  list: async () => [],
};
export const ISS = 'sbx-control-plane';
/** The relay's req_id key, pinned so a test can name the worker id an Exec will get. */
export const REQ_ID_KEY = Buffer.alloc(32, 7);
export const wid = (sbx: string, reqId: number) => workerReqId(REQ_ID_KEY, sbx, reqId);
export const HARNESS = 'harness-exec-token-for-tests'; // notsecret
export const closers: Array<() => unknown> = [];
/** Closes every relay, worker and client the kit opened, newest first. */
export async function closeAll(): Promise<void> {
  for (const c of closers.splice(0).reverse()) await c();
}

export function keypair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  return { signer, keyset: `${signer.kid}:${signer.publicKeyBase64}` };
}
export const K = keypair();
export const now = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MintOver = Partial<Parameters<typeof mintSandboxToken>[1]>;
export const token = (over: MintOver = {}, signer = K.signer) =>
  mintSandboxToken(signer, {
    sub: 'github:1',
    tenant: 'github:1',
    sbx: 'sbx-aaaa',
    wrk: 'sbx_default',
    wsk: 'sbx-aaaa',
    ttlSeconds: 900,
    notAfter: now() + 3600,
    iss: ISS,
    now: now(),
    ...over,
  }).token;
export const tokenB = (over: MintOver = {}) =>
  token({ sub: 'github:2', tenant: 'github:2', sbx: 'sbx-bbbb', wsk: 'sbx-bbbb', ...over });

export type SetModeOver = Partial<Parameters<typeof mintSetModeToken>[1]>;
/** A set-mode token (`moca-sandbox-mode+jwt`) for the same sandbox as `token()`. */
export const setModeToken = (over: SetModeOver = {}, signer = K.signer) =>
  mintSetModeToken(signer, {
    sub: 'github:1',
    sbx: 'sbx-aaaa',
    wrk: 'sbx_default',
    wsk: 'sbx-aaaa',
    mode: 'lease',
    modeEpoch: 2,
    idleTimeoutS: 0,
    notAfter: now() + 3600,
    iss: ISS,
    now: now(),
    ...over,
  });

/** Hand-signed sandbox claims, for the cases mintSandboxToken cannot produce. */
export const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: SANDBOX_TOKEN_AUDIENCE,
  sub: 'github:1',
  tenant: 'github:1',
  sbx: 'sbx-aaaa',
  wrk: 'sbx_default',
  wsk: 'sbx-aaaa',
  scope: [SANDBOX_SCOPE_EXEC],
  iat: now(),
  exp: now() + 900,
  jti: 'jti-1',
  ...over,
});
export const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/** The frames a fake worker answers one Exec with, each without its req_id. */
export type Reply = Array<
  | { chunk: { data: string; stream?: Stream } }
  | { end: { exitCode: number; truncated?: boolean } }
  | { error: { message: string } }
  | { lease: Omit<Partial<LeaseEvent>, 'reqId'> }
>;

/** How a fake worker answers one LeaseControlFrame: a result without its ctl_id, or silence. */
export type LeaseReply = (
  f: LeaseControlFrame,
) => Omit<Partial<LeaseControlResult>, 'ctlId'> | undefined;

/**
 * A fake worker. `auto`: answers each Exec with a chunk (its workspace key, so each caller's frames
 * are recognisable) and an End after `delayMs`, or with `reply(exec)` when given. `hold`: answers
 * only when released, or with an ExecError when aborted (the Go worker's behaviour). `deaf`: never
 * answers anything. `attachToken` is presented as the attach bearer (a workload sandbox's).
 * Lease frames are recorded; a LeaseControlFrame is answered only through `lease`, and without it
 * never, as a worker on code older than lease mode would.
 */
export async function worker(
  addr: string,
  sandboxId: string,
  mode: 'auto' | 'hold' | 'deaf' = 'auto',
  delayMs = 0,
  reply?: (e: Exec) => Reply,
  attachToken?: string,
  lease?: LeaseReply,
  /** Hello.capabilities; a level-2 microVM worker adds LEASE_PROCESSES_CAPABILITY (P5-R37). */
  capabilities: string[] = [],
) {
  const execs: Exec[] = [];
  const aborts: number[] = [];
  const controls: LeaseControlFrame[] = [];
  const keepalives: LeaseKeepaliveFrame[] = [];
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: (md?: Metadata) => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const md = new Metadata();
  if (attachToken) md.set('authorization', `Bearer ${attachToken}`);
  const stream = client.attach(md);
  stream.on('error', () => {});
  const answer = (e: Exec) => {
    if (reply) {
      for (const f of reply(e)) {
        const reqId = e.reqId;
        if ('chunk' in f)
          stream.write({
            chunk: {
              reqId,
              data: Buffer.from(f.chunk.data),
              stream: f.chunk.stream ?? Stream.STREAM_STDOUT,
            },
          } as WorkerFrame);
        else if ('end' in f)
          stream.write({
            end: { reqId, exitCode: f.end.exitCode, truncated: f.end.truncated ?? false },
          } as WorkerFrame);
        else if ('lease' in f)
          stream.write({ lease: LeaseEvent.fromPartial({ ...f.lease, reqId }) } as WorkerFrame);
        else stream.write({ error: { reqId, message: f.error.message } } as WorkerFrame);
      }
      return;
    }
    stream.write({
      chunk: { reqId: e.reqId, data: Buffer.from(e.workspaceKey), stream: Stream.STREAM_STDOUT },
    } as WorkerFrame);
    stream.write({ end: { reqId: e.reqId, exitCode: 0, truncated: false } } as WorkerFrame);
  };
  const answerControl = (ctlId: number, r: Omit<Partial<LeaseControlResult>, 'ctlId'>) =>
    stream.write({ leaseResult: LeaseControlResult.fromPartial({ ...r, ctlId }) } as WorkerFrame);
  stream.on('data', (f: ServerFrame) => {
    if (f.leaseControl) {
      const ctl = f.leaseControl;
      controls.push(ctl);
      const r = lease?.(ctl);
      if (r) answerControl(ctl.ctlId, r);
      return;
    }
    if (f.keepalive) {
      keepalives.push(f.keepalive);
      return;
    }
    if (f.abort) {
      aborts.push(f.abort.reqId);
      if (mode === 'hold')
        stream.write({ error: { reqId: f.abort.reqId, message: 'aborted' } } as WorkerFrame);
      return;
    }
    if (!f.exec) return;
    const e = f.exec;
    execs.push(e);
    if (mode === 'auto') setTimeout(() => answer(e), delayMs);
  });
  stream.write({
    hello: {
      sandboxId,
      labels: {},
      capabilities,
      image: '',
      arch: 'amd64',
      capacityMax: 4,
      trust: 'trusted',
    },
  } as WorkerFrame);
  const close = () => {
    stream.cancel();
    client.close();
  };
  closers.push(close);
  await sleep(150);
  return {
    execs,
    aborts,
    controls,
    keepalives,
    close,
    /** Answer a LeaseControlFrame by its ctl_id, whenever the test chooses. */
    answerControl,
    /** Answer a held Exec by its WORKER req_id. */
    release: (wid: number) => {
      const e = execs.find((x) => x.reqId === wid);
      if (!e) throw new Error(`worker never saw ${wid}`);
      answer(e);
    },
  };
}

export async function relay(env: NodeJS.ProcessEnv = {}, over: Partial<RelayServerDeps> = {}) {
  const lines: string[] = [];
  const r = await startRelay({
    port: 0,
    execAddr: '127.0.0.1:0',
    deps: {
      records,
      validateToken: () => true,
      ...makeExecAuth({
        SH_SANDBOX_TOKEN_PUBLIC_KEYS: K.keyset,
        SH_SANDBOX_TOKEN_ISSUER: ISS,
        ...env,
      }),
      log: (l: string) => lines.push(l),
      sandboxReqIdKey: REQ_ID_KEY,
      ...over,
    },
  });
  closers.push(r.shutdown);
  return { attach: `127.0.0.1:${r.port}`, exec: `127.0.0.1:${r.execPort}`, lines };
}

/** The refusal-log reasons, parsed from the relay's JSON lines. */
export const reasons = (lines: string[]) =>
  lines.map(
    (l) => JSON.parse(l) as { outcome: string; reason: string; audit: string; sbx?: string },
  );

let req = 100;
export interface Result {
  code: number;
  details: string;
  events: ExecEvent[];
}
export function exec(
  addr: string,
  opts: {
    token?: string;
    sandboxId?: string;
    wsk?: string;
    reqId?: number;
    command?: string;
    workload?: string;
    /** Exec fields the client sets beyond the defaults (the mode fields, keepalive). */
    fields?: Partial<Exec>;
  },
) {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (opts.token !== undefined) md.set('authorization', `Bearer ${opts.token}`);
  const call = client.exec(
    {
      sandboxId: opts.sandboxId ?? 'sbx_default',
      workload: opts.workload ?? '',
      exec: Exec.fromPartial({
        reqId: opts.reqId ?? ++req,
        command: opts.command ?? 'true',
        stdin: new Uint8Array(),
        timeoutS: 5,
        streaming: true,
        workspaceKey: opts.wsk ?? 'sbx-aaaa',
        ...opts.fields,
      }),
    },
    md,
  );
  const events: ExecEvent[] = [];
  call.on('data', (ev: ExecEvent) => events.push(ev));
  call.on('error', () => {});
  const done = new Promise<Result>((resolve) =>
    call.on('status', (s: { code: number; details: string }) =>
      resolve({ code: s.code, details: s.details, events }),
    ),
  ).finally(() => client.close());
  return { done, cancel: () => call.cancel(), events };
}

export function abort(
  addr: string,
  t: string | undefined,
  reqId: number,
  sandboxId = 'sbx_default',
) {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (t !== undefined) md.set('authorization', `Bearer ${t}`);
  return new Promise<{ code: number; details: string }>((resolve) =>
    client.abort({ sandboxId, reqId }, md, (err) =>
      resolve(err ? { code: err.code, details: err.details } : { code: status.OK, details: '' }),
    ),
  ).finally(() => client.close());
}

/** Every req_id an event carries, whichever oneof it is. */
export const idsOf = (events: ExecEvent[]) =>
  events.map((ev) => ev.chunk?.reqId ?? ev.end?.reqId ?? ev.error?.reqId ?? ev.lease?.reqId);
export const stdoutOf = (events: ExecEvent[]) =>
  events.map((ev) => (ev.chunk ? Buffer.from(ev.chunk.data).toString() : '')).join('');
