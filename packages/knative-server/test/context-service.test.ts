import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContextServiceError,
  createUploadGrant,
  deleteContext,
  publicBaseUrl,
} from '../src/context-service.js';

const grant = {
  uploadUrl: '/v1/uploads/abc_DEF-1',
  token: 'one-time', // notsecret
  expiresAt: '2026-10-09T12:00:00Z',
  method: 'PUT',
  contentType: 'application/vnd.rossoctl.context',
  maxBytes: 268435456,
};

beforeEach(() => {
  vi.stubEnv('CONTEXT_SERVICE_URL', 'http://cs.internal/');
  vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'svc'); // notsecret
  vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', 'https://gw.example/cs');
  vi.stubEnv('CONTEXT_SERVICE_NAMESPACE', 'moca');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CONTEXT_SERVICE_PUBLIC_URL', () => {
  it.each(['https://gw.example', 'http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:9'])(
    'accepts %s',
    (url) => {
      vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', url);
      expect(() => publicBaseUrl()).not.toThrow();
    },
  );

  it.each(['', 'http://gw.example', 'https://user:pw@gw.example', 'ftp://gw.example'])(
    'refuses %j',
    (url) => {
      vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', url);
      expect(() => publicBaseUrl()).toThrow(/CONTEXT_SERVICE_PUBLIC_URL/);
    },
  );
});

describe('Context Service client', () => {
  it('requests a grant as the user and rebases its URL onto the public address', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(grant), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createUploadGrant('w-1', 'github:alice')).resolves.toEqual({
      ...grant,
      uploadUrl: 'https://gw.example/cs/v1/uploads/abc_DEF-1',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://cs.internal/v1/namespaces/moca/contexts/w-1/upload-capabilities');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer svc',
      'x-context-subject': 'user:github:alice',
    });
  });

  it.each([
    { ...grant, uploadUrl: 'https://evil.example/v1/uploads/x' },
    { ...grant, uploadUrl: '/v1/uploads/../../admin' },
    { ...grant, method: 'POST' },
    { ...grant, maxBytes: 0 },
    { ...grant, token: '' },
  ])('refuses an invalid grant %#', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 201 })),
    );
    await expect(createUploadGrant('w-1', 'github:alice')).rejects.toBeInstanceOf(
      ContextServiceError,
    );
  });

  it('reports an error status with its code, and an unreachable service as ContextServiceError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'in_use', message: 'x' }), { status: 409 }),
        )
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    );
    await expect(deleteContext('w-1', 'github:alice')).rejects.toMatchObject({
      status: 409,
      code: 'in_use',
    });
    await expect(deleteContext('w-1', 'github:alice')).rejects.toBeInstanceOf(ContextServiceError);
  });

  it('treats an already-deleted Context as deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(deleteContext('w-1', 'github:alice')).resolves.toBeUndefined();
  });
});
