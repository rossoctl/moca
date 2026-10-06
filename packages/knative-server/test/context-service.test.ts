import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  contextServiceConfigured,
  createContext,
  createWorkloadContextUpload,
  deleteContext,
  freezeContext,
} from '../src/context-service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Context Service client', () => {
  it('is disabled unless CONTEXT_SERVICE_URL is explicitly set', () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', '');
    expect(contextServiceConfigured()).toBe(false);
  });

  it('creates managed shared storage through the configured service', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example/');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubEnv('CONTEXT_SERVICE_NAMESPACE', 'moca');
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contextId: 'pvc-uid-123',
          namespace: 'moca',
          status: 'provisioning',
          attachment: { kind: 'pvc', claimName: 'context-demo' },
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    await createContext(
      'demo',
      {
        sandboxes: 3,
        workspace: { shared: true, size: '5Gi', storageClass: 'ibm-scale-csi' },
      },
      'github:alice',
    );

    expect(fetch.mock.calls[0][0]).toBe('http://context.example/internal/v1/contexts');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'demo',
      namespace: 'moca',
      type: 'workspace',
      storage: {
        backend: 'pvc',
        size: '5Gi',
        accessMode: 'ReadWriteMany',
        storageClass: 'ibm-scale-csi',
      },
    });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer service-secret');
    expect(new Headers(init.headers).get('x-context-subject')).toBe('user:github:alice');
  });

  it('uses the configured access mode for shared storage on single-node clusters', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubEnv('CONTEXT_SERVICE_SHARED_ACCESS_MODE', 'ReadWriteOnce');
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contextId: 'pvc-uid-123', namespace: 'default' }), {
        status: 201,
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await createContext('demo', { sandboxes: 3, workspace: { shared: true } }, null);

    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).storage.accessMode).toBe('ReadWriteOnce');
  });

  it('creates the Context with the declared bundle type', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contextId: 'pvc-uid-123', namespace: 'default' }), {
        status: 201,
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await createContext('demo', { contextType: 'artifacts' }, null);

    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).type).toBe('artifacts');
  });

  it('rejects an unsupported shared access mode', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_SHARED_ACCESS_MODE', 'ReadOnlyMany');
    vi.stubGlobal('fetch', vi.fn());

    await expect(createContext('demo', { workspace: { shared: true } }, null)).rejects.toThrow(
      'CONTEXT_SERVICE_SHARED_ACCESS_MODE',
    );
  });

  it('requests a one-time upload capability without handling the bundle bytes', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', 'https://gateway.example/context-service');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    const capability = {
      uploadUrl: '/v1/uploads/once',
      token: 'one-time-token',
      expiresAt: '2026-09-30T21:00:00Z',
      method: 'PUT',
      contentType: 'application/vnd.rossoctl.context',
      maxBytes: 268435456,
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(capability), { status: 201 }));
    vi.stubGlobal('fetch', fetch);

    await expect(createWorkloadContextUpload('demo', 'github:alice')).resolves.toEqual({
      ...capability,
      uploadUrl: 'https://gateway.example/context-service/v1/uploads/once',
    });
    expect(fetch.mock.calls[0][0]).toBe(
      'http://context.example/v1/namespaces/default/contexts/demo/upload-capabilities',
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer service-secret',
        'x-context-subject': 'user:github:alice',
      },
    });
  });

  it('uses a workload-scoped identity when Moca authentication is disabled', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            contextId: 'pvc-uid-123',
            namespace: 'default',
            status: 'provisioning',
            attachment: { kind: 'pvc', claimName: 'context-demo' },
          }),
          { status: 201 },
        ),
      ),
    );

    await createContext('demo', {}, null);

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('x-context-subject')).toBe('workload:demo');
  });

  it('freezes the uploaded revision before Moca creates a Sandbox', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubEnv('CONTEXT_SERVICE_NAMESPACE', 'moca');
    const resolved = {
      contextId: 'pvc-uid-123',
      namespace: 'moca',
      status: 'ready',
      currentRevision: 'a'.repeat(64),
      attachment: { kind: 'pvc', claimName: 'context-demo' },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(resolved), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(freezeContext('demo', 'a'.repeat(64), 'github:alice')).resolves.toEqual(resolved);
    expect(fetch.mock.calls[0][0]).toBe(
      'http://context.example/internal/v1/namespaces/moca/contexts/demo/freeze',
    );
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({
      revision: 'a'.repeat(64),
    });
  });

  it('treats an already deleted Context as a successful cleanup', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);

    await expect(deleteContext('demo', 'github:alice')).resolves.toBeUndefined();
  });

  it('rejects an upload capability with an untrusted URL', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', 'https://gateway.example/context-service');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            uploadUrl: 'https://attacker.example/upload',
            token: 'one-time-token',
            expiresAt: '2026-09-30T21:00:00Z',
            method: 'PUT',
            contentType: 'application/vnd.rossoctl.context',
            maxBytes: 268435456,
          }),
          { status: 201 },
        ),
      ),
    );

    await expect(createWorkloadContextUpload('demo', 'github:alice')).rejects.toThrow(
      'invalid upload capability',
    );
  });

  it('requires an explicit client-facing Context Service URL for uploads', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context-service.cluster.local');
    vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', '');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            uploadUrl: '/v1/uploads/once',
            token: 'one-time-token',
            expiresAt: '2026-09-30T21:00:00Z',
            method: 'PUT',
            contentType: 'application/vnd.rossoctl.context',
            maxBytes: 268435456,
          }),
          { status: 201 },
        ),
      ),
    );

    await expect(createWorkloadContextUpload('demo', 'github:alice')).rejects.toThrow(
      'CONTEXT_SERVICE_PUBLIC_URL is required',
    );
  });

  it('aborts a Context Service request after the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'service-secret');
    vi.stubEnv('CONTEXT_SERVICE_TIMEOUT_MS', '25');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const request = createContext('demo', {}, 'github:alice');
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});
