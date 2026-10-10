import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../src/api/control-plane.js';
import { ApiError } from '../src/api/errors.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';

const client = (f: typeof fetch, token = 'api-tok') =>
  new ControlPlaneClient('http://cp', () => token, f);

describe('ControlPlaneClient', () => {
  it('sends the API token as a bearer on /v1 calls', async () => {
    const { fetch, calls } = scriptedFetch(json({ subject: 'github:1', tenant: 't', roles: [] }));
    await client(fetch).me();
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/me', method: 'GET' });
    expect(calls[0].headers.authorization).toBe('Bearer api-tok');
  });

  it('sends no bearer on the unauthenticated device-flow calls', async () => {
    const { fetch, calls } = scriptedFetch(
      json({
        deviceCode: 'd',
        userCode: 'U',
        verificationUri: 'https://gh',
        interval: 5,
        expiresIn: 900,
      }),
    );
    await client(fetch).startDeviceAuth();
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/auth/device', method: 'POST' });
  });

  it('keeps a path prefix and drops a trailing slash', async () => {
    const { fetch, calls } = scriptedFetch(json({ subject: 's', tenant: 't', roles: [] }));
    await new ControlPlaneClient('https://gw.example/cp/', () => 't', fetch).me();
    expect(calls[0].url).toBe('https://gw.example/cp/v1/me');
  });

  it('passes an abort signal through to the fetch on discovery', async () => {
    const { fetch, calls } = scriptedFetch(json({ harnessUrl: null }));
    const controller = new AbortController();
    await client(fetch).discovery({ signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('maps 428 on the device poll to "pending"', async () => {
    const { fetch, calls } = scriptedFetch(json({ error: 'authorization_pending' }, 428));
    expect(await client(fetch).pollDeviceAuth('d')).toBe('pending');
    expect(calls[0].body).toEqual({ deviceCode: 'd' });
  });

  it('maps 410 device_code_expired on the device poll to "expired"', async () => {
    const { fetch } = scriptedFetch(json({ error: 'device_code_expired' }, 410));
    expect(await client(fetch).pollDeviceAuth('d')).toBe('expired');
  });

  it('passes list paging as query parameters', async () => {
    const { fetch, calls } = scriptedFetch(json({ sessions: [], nextCursor: null }));
    await client(fetch).listSessions({ limit: 20, cursor: 123 });
    expect(calls[0].url).toBe('http://cp/v1/sessions?limit=20&cursor=123');
  });

  it('encodes ids in paths', async () => {
    const { fetch, calls } = scriptedFetch(json({ token: 'st', expiresAt: 10 }));
    await client(fetch).mintSessionToken('a/b');
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/sessions/a%2Fb/token', method: 'POST' });
  });

  it('distinguishes a 202 delete from a 204 delete', async () => {
    const { fetch } = scriptedFetch(
      new Response(null, { status: 202 }),
      new Response(null, { status: 204 }),
    );
    const c = client(fetch);
    expect(await c.deleteSession('s1')).toBe('accepted');
    expect(await c.deleteSession('s2')).toBe('deleted');
  });

  it('unwraps the credentials list and PUTs a credential body', async () => {
    const cred = {
      name: 'a',
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      binding: { header: 'Authorization', format: 'Bearer {token}' },
      endpoint: 'https://gw',
    };
    const { fetch, calls } = scriptedFetch(
      json({ credentials: [cred] }),
      new Response(null, { status: 204 }),
    );
    const c = client(fetch);
    expect(await c.listCredentials()).toEqual([cred]);
    await c.putCredential('a', {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      secret: { token: 'x' },
    });
    expect(calls[1]).toMatchObject({ url: 'http://cp/v1/credentials/a', method: 'PUT' });
    expect(calls[1].body.secret).toEqual({ token: 'x' });
  });

  it('throws a typed ApiError for an error response', async () => {
    const { fetch } = scriptedFetch(
      json({ error: 'credential_ambiguous', message: 'pick one' }, 400),
    );
    const err = await client(fetch)
      .createSession({})
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      source: 'control-plane',
      status: 400,
      code: 'credential_ambiguous',
    });
  });

  it('turns a fetch rejection into a network ApiError', async () => {
    const { fetch } = scriptedFetch(new TypeError('fetch failed'));
    const err = await client(fetch)
      .healthz()
      .catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error', source: 'control-plane' });
  });

  it('refreshes with the RFC 6749 body and no bearer', async () => {
    const login = {
      token: 'api2',
      subject: 'github:1',
      expiresAt: 9,
      refreshToken: 'mrt_n',
      refreshExpiresAt: 99,
    };
    const { fetch, calls } = scriptedFetch(json(login));
    expect(await client(fetch).refreshAuth('mrt_o')).toEqual(login);
    expect(calls[0]).toMatchObject({
      url: 'http://cp/v1/auth/token',
      method: 'POST',
      body: { grant_type: 'refresh_token', refresh_token: 'mrt_o' },
    });
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('revokes one login without a bearer, and all of them with one', async () => {
    const { fetch, calls } = scriptedFetch(json({}), json({ revoked: 3 }));
    await client(fetch).revokeAuth('mrt_o');
    expect(await client(fetch).revokeAllAuth()).toBe(3);
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/auth/revoke', body: { token: 'mrt_o' } });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1]).toMatchObject({ url: 'http://cp/v1/auth/revoke-all', method: 'POST' });
    expect(calls[1].headers.authorization).toBe('Bearer api-tok');
  });

  it('sends the label with the device-flow poll', async () => {
    const { fetch, calls } = scriptedFetch(json({ token: 't', subject: 's', expiresAt: 1 }));
    await new ControlPlaneClient('http://cp', () => undefined, fetch, {
      label: 'ada-laptop',
    }).pollDeviceAuth('d');
    expect(calls[0].body).toEqual({ deviceCode: 'd', label: 'ada-laptop' });
  });

  describe('a rejected API token', () => {
    const withRetry = (f: typeof fetch, onTokenRejected: () => Promise<boolean>) => {
      let token = 'old';
      return {
        c: new ControlPlaneClient('http://cp', () => token, f, {
          onTokenRejected: async () => {
            token = 'new';
            return onTokenRejected();
          },
        }),
      };
    };

    it('asks for a refresh once and retries the request with the new token', async () => {
      const { fetch, calls } = scriptedFetch(
        json({ error: 'token_expired' }, 401),
        json({ subject: 'github:1', tenant: 't', roles: [] }),
      );
      const asked = vi.fn(async () => true);
      expect((await withRetry(fetch, asked).c.me()).subject).toBe('github:1');
      expect(asked).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
    });

    it('retries at most once', async () => {
      const { fetch, calls } = scriptedFetch(
        json({ error: 'token_expired' }, 401),
        json({ error: 'token_invalid' }, 401),
      );
      const asked = vi.fn(async () => true);
      await expect(withRetry(fetch, asked).c.me()).rejects.toMatchObject({ code: 'token_invalid' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
    });

    it('surfaces the original error when the refresh fails', async () => {
      const { fetch, calls } = scriptedFetch(json({ error: 'token_expired' }, 401));
      await expect(withRetry(fetch, async () => false).c.me()).rejects.toMatchObject({
        code: 'token_expired',
      });
      expect(calls).toHaveLength(1);
    });

    it('never retries an unauthenticated route or a non-token 401', async () => {
      const asked = vi.fn(async () => true);
      const a = scriptedFetch(json({ error: 'invalid_grant' }, 400));
      await expect(withRetry(a.fetch, asked).c.refreshAuth('mrt_x')).rejects.toMatchObject({
        code: 'invalid_grant',
      });
      const b = scriptedFetch(json({ error: 'unauthorized' }, 401));
      await expect(withRetry(b.fetch, asked).c.me()).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(asked).not.toHaveBeenCalled();
    });
  });
});

it('deleteConfigBundle DELETEs the percent-encoded digest', async () => {
  const { fetch, calls } = scriptedFetch(() => new Response(null, { status: 204 }));
  await client(fetch).deleteConfigBundle('sha256:ab');
  expect(calls[0]).toMatchObject({
    method: 'DELETE',
    url: 'http://cp/v1/config-bundles/sha256%3Aab',
  });
});

it('putConfigBundle POSTs digest and tar to /v1/config-bundles', async () => {
  const { fetch, calls } = scriptedFetch(json({ digest: 'sha256:x', uploaded: true }, 201));
  expect(await client(fetch).putConfigBundle({ digest: 'sha256:x', tar: 'AAAA' })).toEqual({
    digest: 'sha256:x',
    uploaded: true,
  });
  expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://cp/v1/config-bundles' });
  expect(calls[0].body).toEqual({ digest: 'sha256:x', tar: 'AAAA' });
});
