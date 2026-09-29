import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { records, runLeaf, enqueue, configured, createWorkload, getWorkload, deleteWorkload } =
  vi.hoisted(() => ({
    records: new Map<string, string>(),
    runLeaf: vi.fn(),
    enqueue: vi.fn(async () => '1-0'),
    configured: vi.fn(),
    createWorkload: vi.fn(),
    getWorkload: vi.fn(),
    deleteWorkload: vi.fn(),
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
    async set(key: string, value: string) {
      records.set(key, value);
    }
    async get(key: string) {
      return records.get(key) ?? null;
    }
  }
  return { ...actual, RedisResultStore: FakeStore };
});

vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...args: any[]) => runLeaf(...args),
  validateItem: (item: any) => item,
  leafSessionId: (env: any) => env.sessionId,
}));

vi.mock('../src/context-service.js', () => ({
  contextServiceConfigured: configured,
  createWorkload,
  getWorkload,
  deleteWorkload,
}));

import { startServer } from '../src/server.js';

const record = {
  workloadId: 'demo-workload',
  status: 'ready',
  replicas: 2,
  readyReplicas: 2,
  sandboxSelector: 'context.rossoctl.io/pool=demo-workload',
  workspace: { size: '1Gi', accessMode: 'ReadWriteMany', storageClass: 'ibm-scale-csi' },
};

let server: ReturnType<typeof startServer>;
let base: string;

beforeEach(() => {
  records.clear();
  runLeaf.mockReset();
  enqueue.mockClear();
  configured.mockReset().mockReturnValue(true);
  createWorkload.mockReset().mockResolvedValue(record);
  getWorkload.mockReset().mockResolvedValue(record);
  deleteWorkload.mockReset().mockResolvedValue(undefined);
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

describe('optional workload lifecycle', () => {
  it('leaves ordinary runs unchanged when Context Service is disabled', async () => {
    configured.mockReturnValue(false);
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i', verdict: 'CLEAR', reason: 'ok' },
    });

    const response = await json('POST', '/runs', {
      sessionId: 'run/i',
      item: { item_id: 'i', file: 'f', pattern: 'p' },
    });

    expect(response.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledWith(
      expect.not.objectContaining({ workloadId: expect.anything() }),
      expect.any(Object),
    );
  });

  it('reports that workload allocation is disabled when Context Service is not configured', async () => {
    configured.mockReturnValue(false);
    expect(await json('POST', '/workloads', { name: 'demo-workload' })).toEqual({
      status: 501,
      body: { error: 'context_service_not_configured' },
    });
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('creates a workload through Context Service', async () => {
    const response = await json('POST', '/workloads', {
      name: 'demo-workload',
      sandboxes: 2,
      workspace: { shared: true, storageClass: 'ibm-scale-csi' },
    });
    expect(response).toEqual({ status: 201, body: record });
    expect(createWorkload).toHaveBeenCalledWith(
      'demo-workload',
      expect.objectContaining({ sandboxes: 2 }),
    );
  });

  it('does not expose Context Service errors to callers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createWorkload.mockRejectedValueOnce(new Error('internal upstream detail'));

    expect(await json('POST', '/workloads', { name: 'demo-workload' })).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect(log).toHaveBeenCalledWith('Context Service create failed:', expect.any(Error));
    log.mockRestore();
  });

  it('routes a run through its workload pool', async () => {
    await json('POST', '/workloads', { name: 'demo-workload' });
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i', verdict: 'CLEAR', reason: 'ok' },
    });
    const response = await json('POST', '/runs', {
      workloadId: 'demo-workload',
      sessionId: 'run/i',
      item: { item_id: 'i', file: 'f', pattern: 'p' },
    });
    expect(response.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPoolSelector: 'context.rossoctl.io/pool=demo-workload' }),
      expect.any(Object),
    );
  });

  it('routes a prompt leaf through its workload pool', async () => {
    await json('POST', '/workloads', { name: 'demo-workload' });
    runLeaf.mockResolvedValue({ status: 'responded', text: 'a summary' });
    const response = await json('POST', '/runs', {
      workloadId: 'demo-workload',
      sessionId: 'run/p1',
      kind: 'prompt',
      prompt: 'Summarize the repo.',
      item: { item_id: 'i', file: 'f', pattern: 'p' },
    });
    expect(response.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPoolSelector: 'context.rossoctl.io/pool=demo-workload' }),
      expect.any(Object),
    );
  });

  it('queues a prompt leaf with its workload pool selector', async () => {
    await json('POST', '/workloads', { name: 'demo-workload' });
    const response = await json('POST', '/runs', {
      workloadId: 'demo-workload',
      sessionId: 'run/p1',
      kind: 'prompt',
      prompt: 'Summarize the repo.',
      async: true,
    });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPoolSelector: 'context.rossoctl.io/pool=demo-workload' }),
    );
  });

  it('deletes the workload through Context Service', async () => {
    await json('POST', '/workloads', { name: 'demo-workload' });
    const response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(deleteWorkload).toHaveBeenCalledWith('demo-workload');
  });

  it('rejects a run for an unknown workload', async () => {
    const response = await json('POST', '/runs', {
      workloadId: 'missing',
      sessionId: 'run/i',
      item: { item_id: 'i', file: 'f', pattern: 'p' },
    });
    expect(response).toEqual({ status: 404, body: { error: 'workload_not_found' } });
    expect(runLeaf).not.toHaveBeenCalled();
  });
});
