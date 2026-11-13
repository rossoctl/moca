import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLeaf } = vi.hoisted(() => ({
  runLeaf: vi.fn(),
}));
vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  class FakeStore {
    async set() {}
    async get() {
      return null;
    }
  }
  return { ...actual, RedisResultStore: FakeStore };
});
vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...args: any[]) => runLeaf(...args),
  validateItem: (item: any) => item,
  leafSessionId: (env: any) => env.sessionId,
}));

import { startServer } from '../src/server.js';

let server: ReturnType<typeof startServer>;
let base: string;

beforeEach(() => {
  runLeaf.mockReset();
  server = startServer(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => server.close());

async function json(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const envelope = { sessionId: 'run-1', kind: 'prompt', prompt: 'hi' };

describe('workloads are off unless enabled and Context Service is configured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['POST', '/workloads', {}],
    ['GET', '/workloads/demo', {}],
    ['DELETE', '/workloads/demo', {}],
    ['POST', '/workloads/demo/uploads', {}],
    ['POST', '/workloads/demo/activate', {}],
    // The flag alone is not enough: Context Service must be configured too.
    ['POST', '/workloads', { MOCA_CONTEXT_WORKLOADS_ENABLED: '1' }],
    // A Context Service URL alone does not turn the routes on.
    ['POST', '/workloads', { CONTEXT_SERVICE_URL: 'http://cs.example' }],
  ])('%s %s answers 501 without contacting Context Service (%o)', async (method, path, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await json(method, path, method === 'POST' ? { name: 'demo' } : undefined);
    expect(res).toEqual({ status: 501, body: { error: 'workloads_unavailable' } });
    // The only fetch is this test's own request to the server.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('refuses a sync run that names a workload rather than running it on the default pool', async () => {
    const res = await json('POST', '/runs', { ...envelope, workloadId: 'demo' });
    expect(res).toEqual({ status: 501, body: { error: 'workload_runs_unavailable' } });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('refuses an async run that names a workload with the ADR-0041 removal error', async () => {
    const res = await json('POST', '/runs', { ...envelope, async: true, workloadId: 'demo' });
    expect(res).toMatchObject({ status: 400, body: { error: 'async_removed' } });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('refuses an anonymous run that names a workload when workloads are enabled', async () => {
    vi.stubEnv('MOCA_CONTEXT_WORKLOADS_ENABLED', '1');
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://cs.example');
    const res = await json('POST', '/runs', { ...envelope, workloadId: 'demo' });
    expect(res).toMatchObject({ status: 401, body: { error: 'token_required' } });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('strips a caller-supplied internalContext from a run', async () => {
    runLeaf.mockResolvedValue({ status: 'responded', text: 'ok' });
    await json('POST', '/runs', {
      ...envelope,
      internalContext: { revision: 'a'.repeat(64), loadBundle: 'x' },
    });
    expect(runLeaf.mock.calls[0]![0]).not.toHaveProperty('internalContext');
  });

  it('runs a request without a workload as before', async () => {
    runLeaf.mockResolvedValue({ status: 'responded', text: 'ok' });
    const res = await json('POST', '/runs', envelope);
    expect(res.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledOnce();
  });
});
