import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  records,
  runLeaf,
  enqueue,
  configured,
  createWorkload,
  freezeWorkload,
  deleteWorkload,
  createWorkloadContextUpload,
  createWorkloadRuntime,
  getWorkloadRuntime,
  deleteWorkloadRuntime,
  storeState,
} = vi.hoisted(() => ({
  records: new Map<string, string>(),
  runLeaf: vi.fn(),
  enqueue: vi.fn(async () => '1-0'),
  configured: vi.fn(),
  createWorkload: vi.fn(),
  freezeWorkload: vi.fn(),
  deleteWorkload: vi.fn(),
  createWorkloadContextUpload: vi.fn(),
  createWorkloadRuntime: vi.fn(),
  getWorkloadRuntime: vi.fn(),
  deleteWorkloadRuntime: vi.fn(),
  storeState: { failNextSet: false },
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
      if (storeState.failNextSet) {
        storeState.failNextSet = false;
        throw new Error('store unavailable');
      }
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
  ContextServiceRequestError: class ContextServiceRequestError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  contextServiceConfigured: configured,
  contextNamespace: () => 'default',
  sharedContextAccessMode: () => 'ReadWriteMany',
  createContext: createWorkload,
  freezeContext: freezeWorkload,
  deleteContext: deleteWorkload,
  createWorkloadContextUpload,
}));
vi.mock('../src/workload-runtime.js', () => ({
  createWorkloadRuntime,
  getWorkloadRuntime,
  deleteWorkloadRuntime,
}));

import { startServer } from '../src/server.js';
import { ContextServiceRequestError } from '../src/context-service.js';

const record = {
  workloadId: 'demo-workload',
  contextName: 'demo-workload',
  contextId: 'pvc-uid-123',
  status: 'ready',
  replicas: 2,
  readyReplicas: 2,
  sandboxSelector: 'moca.rossoctl.io/workload=demo-workload',
  workspace: {
    size: '1Gi',
    accessMode: 'ReadWriteMany',
    storageClass: 'ibm-scale-csi',
    readOnly: true,
  },
  attachment: { kind: 'pvc', claimName: 'context-demo-workload' },
};
const context = {
  contextId: 'pvc-uid-123',
  namespace: 'default',
  status: 'ready',
  currentRevision: 'a'.repeat(64),
  attachment: { kind: 'pvc', claimName: 'context-demo-workload' },
};

let server: ReturnType<typeof startServer>;
let base: string;

beforeEach(async () => {
  records.clear();
  storeState.failNextSet = false;
  runLeaf.mockReset();
  enqueue.mockClear();
  configured.mockReset().mockReturnValue(true);
  createWorkload.mockReset().mockResolvedValue(context);
  freezeWorkload.mockReset().mockResolvedValue({
    contextId: 'pvc-uid-123',
    namespace: 'default',
    status: 'ready',
    currentRevision: 'a'.repeat(64),
    attachment: context.attachment,
  });
  deleteWorkload.mockReset().mockResolvedValue(undefined);
  createWorkloadRuntime.mockReset().mockResolvedValue({
    status: 'provisioning',
    readyReplicas: 0,
    sandboxSelector: 'moca.rossoctl.io/workload=demo-workload',
  });
  getWorkloadRuntime.mockReset().mockResolvedValue({
    status: 'ready',
    readyReplicas: 2,
    sandboxSelector: 'moca.rossoctl.io/workload=demo-workload',
  });
  deleteWorkloadRuntime.mockReset().mockResolvedValue(undefined);
  createWorkloadContextUpload.mockReset().mockResolvedValue({
    uploadUrl: 'https://context.example/v1/uploads/once',
    token: 'one-time-token',
    expiresAt: '2026-09-30T21:00:00Z',
    contentType: 'application/vnd.rossoctl.context',
  });
  server = startServer(0);
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve));
  }
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function json(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function createAndActivate(): Promise<void> {
  await json('POST', '/workloads', {
    name: 'demo-workload',
    sandboxes: 2,
    contextUpload: true,
    workspace: { shared: true },
  });
  await json('POST', '/workloads/demo-workload/activate', { revision: 'a'.repeat(64) });
  await json('GET', '/workloads/demo-workload');
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

  it('creates a native workload when Context Service is not configured', async () => {
    configured.mockReturnValue(false);
    expect(await json('POST', '/workloads', { name: 'demo-workload' })).toEqual({
      status: 201,
      body: {
        workloadId: 'demo-workload',
        status: 'provisioning',
        replicas: 1,
        readyReplicas: 0,
        sandboxSelector: 'moca.rossoctl.io/workload=demo-workload',
        workspace: { size: '1Gi', accessMode: 'ReadWriteOnce', readOnly: false },
      },
    });
    expect(createWorkload).not.toHaveBeenCalled();
    expect(createWorkloadRuntime).toHaveBeenCalledWith({
      workloadId: 'demo-workload',
      replicas: 1,
      workspace: { kind: 'native', size: '1Gi' },
    });
  });

  it('requires Context Service only when context upload is requested', async () => {
    configured.mockReturnValue(false);
    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true }),
    ).toEqual({ status: 501, body: { error: 'context_service_not_configured' } });
    expect(createWorkloadRuntime).not.toHaveBeenCalled();
  });

  it('creates a workload through Context Service', async () => {
    const response = await json('POST', '/workloads', {
      name: 'demo-workload',
      sandboxes: 2,
      contextUpload: true,
      workspace: { shared: true, storageClass: 'ibm-scale-csi' },
    });
    expect(response).toMatchObject({
      status: 201,
      body: {
        workloadId: 'demo-workload',
        status: 'awaiting_upload',
        replicas: 2,
        readyReplicas: 0,
        sandboxSelector: '',
        workspace: {
          size: '1Gi',
          accessMode: 'ReadWriteMany',
          storageClass: 'ibm-scale-csi',
          readOnly: true,
        },
      },
    });
    expect(createWorkload).toHaveBeenCalledWith(
      'demo-workload',
      expect.objectContaining({ sandboxes: 2 }),
      null,
    );
    expect(createWorkloadRuntime).not.toHaveBeenCalled();
  });

  it('creates a workload and returns its initial upload capability in one request', async () => {
    const response = await json('POST', '/workloads', {
      name: 'demo-workload',
      contextUpload: true,
    });

    expect(response).toMatchObject({
      status: 201,
      body: {
        workloadId: 'demo-workload',
        status: 'awaiting_upload',
        upload: {
          uploadUrl: 'https://context.example/v1/uploads/once',
          token: 'one-time-token',
        },
      },
    });
    expect(createWorkloadContextUpload).toHaveBeenCalledWith('demo-workload', null);
  });

  it('rejects a non-boolean context upload option', async () => {
    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextUpload: 'yes' }),
    ).toEqual({ status: 400, body: { error: 'context_upload_invalid' } });
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('creates the Context with the declared bundle type', async () => {
    await json('POST', '/workloads', {
      name: 'demo-workload',
      contextUpload: true,
      contextType: 'artifacts',
    });
    expect(createWorkload).toHaveBeenCalledWith(
      'demo-workload',
      expect.objectContaining({ contextType: 'artifacts' }),
      null,
    );
  });

  it('rejects an unknown context type or one without context upload', async () => {
    expect(
      await json('POST', '/workloads', {
        name: 'demo-workload',
        contextUpload: true,
        contextType: 'secrets',
      }),
    ).toEqual({ status: 400, body: { error: 'context_type_invalid' } });
    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextType: 'artifacts' }),
    ).toEqual({ status: 400, body: { error: 'context_upload_required_for_context_type' } });
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('issues an upload capability for a managed workload', async () => {
    await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true });
    const response = await json('POST', '/workloads/demo-workload/uploads');

    expect(response).toEqual({
      status: 201,
      body: {
        uploadUrl: 'https://context.example/v1/uploads/once',
        token: 'one-time-token',
        expiresAt: '2026-09-30T21:00:00Z',
        contentType: 'application/vnd.rossoctl.context',
      },
    });
    expect(createWorkloadContextUpload).toHaveBeenCalledWith('demo-workload', null);
  });

  it('issues upload capabilities only before activation', async () => {
    await createAndActivate();
    createWorkloadContextUpload.mockClear();

    expect(await json('POST', '/workloads/demo-workload/uploads')).toEqual({
      status: 409,
      body: { error: 'workload_not_awaiting_upload' },
    });
    expect(createWorkloadContextUpload).not.toHaveBeenCalled();
  });

  it('requires shared storage when more than one Sandbox is requested', async () => {
    expect(
      await json('POST', '/workloads', {
        name: 'demo-workload',
        sandboxes: 2,
        contextUpload: true,
        workspace: { shared: false },
      }),
    ).toEqual({ status: 400, body: { error: 'shared_workspace_required' } });
    expect(createWorkload).not.toHaveBeenCalled();
  });

  it('creates sandboxes only after the uploaded revision is verified', async () => {
    await json('POST', '/workloads', {
      name: 'demo-workload',
      sandboxes: 2,
      contextUpload: true,
      workspace: { shared: true },
    });
    expect(createWorkloadRuntime).not.toHaveBeenCalled();

    expect(
      await json('POST', '/workloads/demo-workload/activate', { revision: 'a'.repeat(64) }),
    ).toMatchObject({
      status: 202,
      body: { status: 'provisioning' },
    });
    expect(freezeWorkload).toHaveBeenCalledWith('demo-workload', 'a'.repeat(64), null);
    expect(freezeWorkload.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkloadRuntime.mock.invocationCallOrder[0],
    );
    expect(createWorkloadRuntime).toHaveBeenCalledWith({
      workloadId: 'demo-workload',
      replicas: 2,
      workspace: {
        kind: 'context',
        claimName: 'context-demo-workload',
        revision: 'a'.repeat(64),
      },
    });
  });

  it('retries activation after the runtime was created but the final save failed', async () => {
    await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true });
    createWorkloadRuntime.mockImplementationOnce(async () => {
      storeState.failNextSet = true;
      return {
        status: 'provisioning',
        readyReplicas: 0,
        sandboxSelector: 'moca.rossoctl.io/workload=demo-workload',
      };
    });

    expect(
      await json('POST', '/workloads/demo-workload/activate', { revision: 'a'.repeat(64) }),
    ).toEqual({ status: 502, body: { error: 'context_service_error' } });
    expect(JSON.parse(records.get('sh:workload:demo-workload')!)).toMatchObject({
      status: 'provisioning',
      revision: 'a'.repeat(64),
    });

    expect(
      await json('POST', '/workloads/demo-workload/activate', { revision: 'a'.repeat(64) }),
    ).toMatchObject({ status: 202, body: { status: 'provisioning' } });
    expect(createWorkloadRuntime).toHaveBeenCalledTimes(2);
    expect(freezeWorkload).toHaveBeenCalledTimes(2);
  });

  it('maps an upload capability failure to a generic 502', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true });
    createWorkloadContextUpload.mockRejectedValueOnce(new Error('internal upstream detail'));

    expect(await json('POST', '/workloads/demo-workload/uploads')).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect(log).toHaveBeenCalledWith('Context Service create upload failed:', expect.any(Error));
    log.mockRestore();
  });

  it('preserves a Context Service conflict response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true });
    freezeWorkload.mockRejectedValueOnce(
      new ContextServiceRequestError(409, 'upload_in_progress', 'upload is in progress'),
    );

    expect(
      await json('POST', '/workloads/demo-workload/activate', { revision: 'a'.repeat(64) }),
    ).toEqual({ status: 409, body: { error: 'upload_in_progress' } });
    log.mockRestore();
  });

  it('rolls back creation when the initial upload capability fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createWorkloadContextUpload.mockRejectedValueOnce(new Error('internal upstream detail'));

    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true }),
    ).toEqual({ status: 502, body: { error: 'context_service_error' } });
    expect(deleteWorkload).toHaveBeenCalledWith('demo-workload', null);
    expect(records.has('sh:workload:demo-workload')).toBe(false);
    log.mockRestore();
  });

  it('does not expose Context Service errors to callers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createWorkload.mockRejectedValueOnce(new Error('internal upstream detail'));

    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true }),
    ).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect(log).toHaveBeenCalledWith('Context Service create failed:', expect.any(Error));
    log.mockRestore();
  });

  it('deletes a newly created Context when the workload record cannot be saved', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    storeState.failNextSet = true;
    expect(
      await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true }),
    ).toEqual({
      status: 502,
      body: { error: 'context_service_error' },
    });
    expect(deleteWorkload).toHaveBeenCalledWith('demo-workload', null);
    expect(records.has('sh:workload:demo-workload')).toBe(false);
    log.mockRestore();
  });

  it('routes a run through its workload pool', async () => {
    await createAndActivate();
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
      expect.objectContaining({ sandboxPoolSelector: 'moca.rossoctl.io/workload=demo-workload' }),
      expect.any(Object),
    );
  });

  it('routes a prompt leaf through its workload pool', async () => {
    await createAndActivate();
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
      expect.objectContaining({ sandboxPoolSelector: 'moca.rossoctl.io/workload=demo-workload' }),
      expect.any(Object),
    );
  });

  it('queues a prompt leaf with its workload pool selector', async () => {
    await createAndActivate();
    const response = await json('POST', '/runs', {
      workloadId: 'demo-workload',
      sessionId: 'run/p1',
      kind: 'prompt',
      prompt: 'Summarize the repo.',
      async: true,
    });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxPoolSelector: 'moca.rossoctl.io/workload=demo-workload' }),
    );
  });

  it('deletes the workload through Context Service', async () => {
    await json('POST', '/workloads', { name: 'demo-workload', contextUpload: true });
    const response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(deleteWorkload).toHaveBeenCalledWith('demo-workload', null);
  });

  it('deletes a native workload without Context Service', async () => {
    configured.mockReturnValue(false);
    await json('POST', '/workloads', { name: 'native-workload' });
    const response = await fetch(base + '/workloads/native-workload', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(deleteWorkloadRuntime).toHaveBeenCalledWith('native-workload', 1, true);
    expect(deleteWorkload).not.toHaveBeenCalled();
  });

  it('retries deletion after cleanup fails', async () => {
    await createAndActivate();
    deleteWorkloadRuntime.mockRejectedValueOnce(new Error('temporary Kubernetes failure'));

    let response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(502);
    expect(JSON.parse(records.get('sh:workload:demo-workload')!).status).toBe('deleting');

    response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(deleteWorkloadRuntime).toHaveBeenCalledTimes(2);
    expect(deleteWorkload).toHaveBeenCalledTimes(1);
  });

  it('retries deletion after the external cleanup completed but the final save failed', async () => {
    await createAndActivate();
    deleteWorkload.mockImplementationOnce(async () => {
      storeState.failNextSet = true;
    });

    let response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(502);
    expect(JSON.parse(records.get('sh:workload:demo-workload')!).status).toBe('deleting');

    response = await fetch(base + '/workloads/demo-workload', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(deleteWorkloadRuntime).toHaveBeenCalledTimes(2);
    expect(deleteWorkload).toHaveBeenCalledTimes(2);
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
