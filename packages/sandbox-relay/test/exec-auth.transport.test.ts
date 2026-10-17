import {
  Metadata,
  ServerCredentials,
  credentials,
  makeGenericClientConstructor,
  status,
  type Client,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SandboxExecClient,
  SandboxWorkerService,
  type ServerFrame,
  type WorkerFrame,
} from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';
import { buildServer, makeExecTokenValidator, startRelay } from '../src/main.js';

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

// The REAL validator, so the guards below exercise the comparison and not a stub of it.
// 'wrong-token' is the same length as 'right-token', so it reaches timingSafeEqual.
const deps = {
  records,
  validateToken: () => true,
  validateExecToken: makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: 'right-token' }), // notsecret
};

// What an authorized Exec with no worker attached ends with: a routing failure, not an auth one.
// Matching the detail (not just "not UNAUTHENTICATED") rules out UNIMPLEMENTED -- a relay with no
// exec service registered at all.
const NO_WORKER = /no live worker for sandbox/;

async function bindOne(): Promise<string> {
  const { server } = buildServer(deps);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  closers.push(() => server.forceShutdown());
  return `127.0.0.1:${port}`;
}

function execCode(addr: string, token?: string): Promise<number> {
  return execResult(addr, token).then((r) => r.code);
}

function execResult(addr: string, token?: string): Promise<{ code: number; details: string }> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (token) md.set('authorization', `Bearer ${token}`);
  const call = client.exec(
    {
      sandboxId: 'sbx-x',
      exec: {
        reqId: 1,
        command: 'true',
        stdin: new Uint8Array(),
        timeoutS: 5,
        streaming: true,
        workspaceKey: 'k',
      },
    },
    md,
  );
  return new Promise<{ code: number; details: string }>((resolve) => {
    call.on('data', () => {});
    call.on('error', (err: { code: number; details: string }) =>
      resolve({ code: err.code, details: err.details }),
    );
    call.on('end', () => resolve({ code: status.OK, details: '' }));
  }).finally(() => client.close());
}

function abortCode(addr: string, token?: string): Promise<number> {
  const client = new SandboxExecClient(addr, credentials.createInsecure());
  const md = new Metadata();
  if (token) md.set('authorization', `Bearer ${token}`);
  return new Promise<number>((resolve) =>
    client.abort({ sandboxId: 'sbx-x', reqId: 1 }, md, (err: { code: number } | null) =>
      resolve(err ? err.code : status.OK),
    ),
  ).finally(() => client.close());
}

const WorkerClient = makeGenericClientConstructor(SandboxWorkerService, 'SandboxWorker');

/**
 * Terminal code of an Attach stream opened against `addr` (a Hello is sent, then we wait). A stream
 * still open after 3s -- the listener serves Attach and parked the session -- resolves to -1.
 */
function attachCode(addr: string): Promise<number> {
  const client = new WorkerClient(addr, credentials.createInsecure()) as unknown as Client & {
    attach: () => ClientDuplexStream<WorkerFrame, ServerFrame>;
  };
  const stream = client.attach();
  stream.write({
    hello: {
      sandboxId: 'sbx-x',
      labels: {},
      capabilities: [],
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  } as WorkerFrame);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(-1), 3000);
    stream.on('data', () => {});
    stream.on('error', (err: { code: number }) => resolve(err.code));
    stream.on('status', (s: { code: number }) => resolve(s.code));
  }).finally(() => {
    clearTimeout(timer);
    stream.cancel();
    client.close();
  });
}

describe('SandboxExec requires the worker credential (MI1 R5)', () => {
  it('refuses an Exec with no token', async () => {
    expect(await execCode(await bindOne())).toBe(status.UNAUTHENTICATED);
  });

  it('refuses an Exec with the wrong token', async () => {
    expect(await execCode(await bindOne(), 'wrong-token')).toBe(status.UNAUTHENTICATED);
  });

  it('admits the right token (then fails for the ordinary reason: no worker attached)', async () => {
    const r = await execResult(await bindOne(), 'right-token');
    expect(r.code).not.toBe(status.UNAUTHENTICATED);
    expect(r.details).toMatch(NO_WORKER);
  });

  it('refuses an Abort with no token', async () => {
    expect(await abortCode(await bindOne())).toBe(status.UNAUTHENTICATED);
  });

  it('refuses an Abort with a wrong token, of equal and of differing length', async () => {
    const addr = await bindOne();
    expect(await abortCode(addr, 'wrong-token')).toBe(status.UNAUTHENTICATED);
    expect(await abortCode(addr, 'right-token-2')).toBe(status.UNAUTHENTICATED);
  });

  it('admits an Abort with the right token', async () => {
    // Positive control: a relay that refused every Abort would pass the two tests above.
    expect(await abortCode(await bindOne(), 'right-token')).toBe(status.OK);
  });
});

describe('makeExecTokenValidator', () => {
  it('refuses to build without MOCA_RELAY_EXEC_TOKEN', () => {
    expect(() => makeExecTokenValidator({})).toThrow(/MOCA_RELAY_EXEC_TOKEN/);
    expect(() => makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: '' })).toThrow(
      /MOCA_RELAY_EXEC_TOKEN/,
    );
  });

  it('refuses to build when the exec token equals SH_RELAY_TOKEN, naming the variables but not the value', () => {
    const shared = 'shared-value-1234'; // notsecret
    let err: unknown;
    try {
      makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: shared, SH_RELAY_TOKEN: shared });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/MOCA_RELAY_EXEC_TOKEN/);
    expect((err as Error).message).toMatch(/SH_RELAY_TOKEN\b/);
    expect((err as Error).message).not.toContain(shared);
  });

  it('refuses to build when the exec token equals a per-sandbox SH_RELAY_TOKEN_<id>', () => {
    const shared = 'shared-value-5678'; // notsecret
    let err: unknown;
    try {
      makeExecTokenValidator({
        MOCA_RELAY_EXEC_TOKEN: shared,
        SH_RELAY_TOKEN: 'sandbox-global', // notsecret
        SH_RELAY_TOKEN_sbx1: 'sandbox-one', // notsecret
        SH_RELAY_TOKEN_sbx2: shared,
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/SH_RELAY_TOKEN_sbx2/);
    expect((err as Error).message).not.toMatch(/SH_RELAY_TOKEN_sbx1/);
    expect((err as Error).message).not.toContain(shared);
  });

  it('builds when the exec token is distinct from every sandbox token', () => {
    const v = makeExecTokenValidator({
      MOCA_RELAY_EXEC_TOKEN: 'exec-only', // notsecret
      // The same length as the exec token, so refusing it takes the comparison, not the length check.
      SH_RELAY_TOKEN: 'sandbox-9', // notsecret
      SH_RELAY_TOKEN_sbx1: 'sandbox-one', // notsecret
    });
    expect(v('exec-only')).toBe(true);
    expect(v('sandbox-9')).toBe(false);
    expect(v('sandbox-one')).toBe(false);
  });

  it('accepts exactly the configured token', () => {
    const v = makeExecTokenValidator({ MOCA_RELAY_EXEC_TOKEN: 'abc123' }); // notsecret
    expect(v('abc123')).toBe(true);
    expect(v('abc124')).toBe(false);
    expect(v('abc1234')).toBe(false);
    expect(v(undefined)).toBe(false);
  });
});

describe('startRelay with MOCA_RELAY_EXEC_ADDR serves the two services apart', () => {
  it('the attach listener does not serve Exec, and the exec listener does not serve Attach', async () => {
    const relay = await startRelay({ port: 0, execAddr: '127.0.0.1:0', deps });
    closers.push(relay.shutdown);
    expect(relay.execPort).toBeGreaterThan(0);
    expect(await execCode(`127.0.0.1:${relay.port}`, 'right-token')).toBe(status.UNIMPLEMENTED);
    const execOnExecPort = await execResult(`127.0.0.1:${relay.execPort}`, 'right-token');
    expect(execOnExecPort.details).toMatch(NO_WORKER);
    expect(await attachCode(`127.0.0.1:${relay.execPort}`)).toBe(status.UNIMPLEMENTED);
  });

  it('without an exec address, one listener serves both (the Kubernetes shape)', async () => {
    const relay = await startRelay({ port: 0, deps });
    closers.push(relay.shutdown);
    expect(relay.execPort).toBeUndefined();
    expect(await execCode(`127.0.0.1:${relay.port}`)).toBe(status.UNAUTHENTICATED);
  });

  it('refuses to start when no deps are injected and MOCA_RELAY_EXEC_TOKEN is unset', async () => {
    await expect(startRelay({ port: 0, env: { SH_RELAY_TOKEN: 't' } })).rejects.toThrow(
      /MOCA_RELAY_EXEC_TOKEN/,
    );
  });
});

describe('the relay bootstrap', () => {
  const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

  it('turns a boot refusal into a one-line error and exit 1, not an unhandled rejection', () => {
    const r = spawnSync(TSX, [MAIN], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SH_RELAY_TOKEN: 't',
        SH_RELAY_PORT: '0',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^sandbox-relay: refusing to start: MOCA_RELAY_EXEC_TOKEN or SH_SANDBOX_TOKEN_PUBLIC_KEYS is required/m,
    );
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
  }, 30_000);
});
