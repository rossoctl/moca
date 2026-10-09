import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLeaf, enqueue } = vi.hoisted(() => ({
  runLeaf: vi.fn(),
  enqueue: vi.fn(async () => '1-0'),
}));
vi.mock('@moca/work-queue', () => ({
  RedisWorkQueue: class {
    ensureGroup = async () => {};
    enqueue = enqueue;
  },
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
  enqueue.mockClear();
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

describe('workloads are unavailable until Moca provisions them', () => {
  it.each([
    ['POST', '/workloads'],
    ['GET', '/workloads/demo'],
    ['DELETE', '/workloads/demo'],
  ])('%s %s answers 501 without contacting Context Service', async (method, path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await json(method, path, method === 'POST' ? { name: 'demo' } : undefined);
    expect(res).toEqual({ status: 501, body: { error: 'workloads_unavailable' } });
    // The only fetch is this test's own request to the server.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('refuses a sync run that names a workload rather than running it on the default pool', async () => {
    const res = await json('POST', '/runs', { ...envelope, workloadId: 'demo' });
    expect(res).toEqual({ status: 501, body: { error: 'workloads_unavailable' } });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('refuses an async run that names a workload rather than queueing it', async () => {
    const res = await json('POST', '/runs', { ...envelope, async: true, workloadId: 'demo' });
    expect(res).toEqual({ status: 501, body: { error: 'workloads_unavailable' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('runs a request without a workload as before', async () => {
    runLeaf.mockResolvedValue({ status: 'responded', text: 'ok' });
    const res = await json('POST', '/runs', envelope);
    expect(res.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledOnce();
  });
});
