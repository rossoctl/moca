import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { buildHandler, startControlPlane } from '../src/server.js';
import { makeDeps, seedCredential, type TestDeps } from './helpers/deps.js';

let server: ReturnType<typeof startControlPlane>;
let base: string;
let d: TestDeps;

function request(
  method: string,
  path: string,
  opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; json(): unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode ?? 0,
          body,
          json: () => (body ? JSON.parse(body) : undefined),
        });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(opts.body));
    } else if (opts.rawBody !== undefined) {
      // Bytes as given, so a test can send something JSON.parse will reject.
      req.setHeader('Content-Type', 'application/json');
      req.write(opts.rawBody);
    }
    req.end();
  });
}

beforeEach(async () => {
  d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
  await seedCredential(d);
  server = startControlPlane(d, 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  server.close();
});

async function apiToken(): Promise<string> {
  const res = await request('POST', '/v1/auth/device/token', { body: { deviceCode: 'dc-1' } });
  return (res.json() as { token: string }).token;
}

describe('probes', () => {
  it('serves /healthz and /readyz unauthenticated', async () => {
    expect((await request('GET', '/healthz')).status).toBe(200);
    expect((await request('GET', '/readyz')).status).toBe(200);
  });

  it('serves /v1/discovery unauthenticated, advertising no harness by default', async () => {
    const res = await request('GET', '/v1/discovery');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ harnessUrl: null, sandboxTiers: null, version: null });
  });
});

describe('SIGTERM', () => {
  it('closes the server, then releases the deps (Redis), then exits 0 (#434)', async () => {
    const order: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit ${code}`);
    }) as never);
    try {
      d.close = vi.fn(async () => void order.push('close'));
      server.once('close', () => order.push('server closed'));
      process.emit('SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 2000 });
      expect(order).toEqual(['server closed', 'close', 'exit 0']);
    } finally {
      exit.mockRestore();
    }
  });

  it('does not wait out keep-alive on a connection whose request was in flight at SIGTERM (#436)', async () => {
    // server.close() reaps the connections that are idle when it is called, but not one that goes
    // idle afterwards: the ingress's keep-alive socket would then hold the exit (and the Redis
    // release) for keepAliveTimeout. The agent reuses the socket /healthz left idle for /readyz.
    server.keepAliveTimeout = 60_000;
    vi.spyOn(d.index, 'get').mockImplementation(
      () => new Promise((r) => setTimeout(() => r(undefined as never), 300)),
    );
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        http
          .get(new URL(path, base), { agent }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          })
          .on('error', reject);
      });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      expect(await get('/healthz')).toBe(200);
      const slow = get('/readyz');
      await new Promise((r) => setTimeout(r, 50));
      process.emit('SIGTERM');
      expect(await slow).toBe(200);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2000 });
    } finally {
      exit.mockRestore();
      agent.destroy();
    }
  });
});

describe('routing', () => {
  it('404s an unknown path and an unsupported method', async () => {
    expect((await request('GET', '/nope')).status).toBe(404);
    expect((await request('PATCH', '/v1/me')).status).toBe(404);
  });

  it('400s invalid JSON with the repo-standard code', async () => {
    const res = await request('POST', '/v1/auth/device/token', {
      headers: { 'Content-Type': 'application/json' },
    });
    // An empty body is not valid JSON for a route that requires one.
    expect(res.status).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_json');
  });

  it('mints a session token from an empty request body — mocactl sends no body at all', async () => {
    // mintSessionToken's handler never reads ctx.body (it takes everything from the path param and
    // the caller's own principal), so a client that sends no body -- exactly what
    // ControlPlaneApi.mintSessionToken does -- must not be rejected by the router's generic
    // "POST/PUT needs a body" guard the way startDeviceAuth is deliberately exempted from it.
    const token = await apiToken();
    const created = await request('POST', '/v1/sessions', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    const sessionId = (created.json() as { sessionId: string }).sessionId;
    const res = await request('POST', `/v1/sessions/${sessionId}/token`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ token: expect.any(String) });
  });

  it('sends a JSON content type on a JSON body and none on 204', async () => {
    const token = await apiToken();
    const created = await request('POST', '/v1/sessions', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(created.status).toBe(201);
    const del = await request(
      'DELETE',
      `/v1/sessions/${(created.json() as { sessionId: string }).sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(del.status).toBe(204);
    expect(del.body).toBe('');
  });

  it('url-decodes a path parameter', async () => {
    const token = await apiToken();
    const res = await request('PUT', '/v1/credentials/github%2Dwork', {
      body: {
        kind: 'bearer',
        consumer: 'sandbox-egress',
        destination: { hosts: ['api.github.com'] },
        secret: { token: 'ghp-fake' }, // notsecret
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    expect(await d.credentials.get('github:1234', 'github-work')).not.toBeNull();
  });
});

describe('api auth', () => {
  it('401s with no Authorization header', async () => {
    const res = await request('GET', '/v1/me');
    expect(res.status).toBe(401);
    expect((res.json() as { error: string }).error).toBe('token_required');
  });

  it('authenticates BEFORE it parses the body: no token + malformed JSON is 401, not 400', async () => {
    // The body used to be read and JSON.parsed before authorize(), so an anonymous caller got
    // 400 invalid_json and learned something about the route's body handling before it was established
    // that it may talk to the route at all. Nothing of consequence leaked and the 64 KiB cap bounded
    // it, but authentication belongs in front. Every route here is new in MU1, so no existing caller
    // depended on the old codes.
    const res = await request('PUT', '/v1/credentials/github-work', { rawBody: '{not json' });
    expect(res.status).toBe(401);
    expect((res.json() as { error: string }).error).toBe('token_required');
  });

  it('still 400s a malformed body once the caller IS authenticated', async () => {
    // The reorder must not have swallowed the invalid_json path -- only moved it behind the gate.
    const token = await apiToken();
    const res = await request('PUT', '/v1/credentials/github-work', {
      rawBody: '{not json',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_json');
  });

  it('401s a malformed header, a wrong scheme and a garbage token', async () => {
    for (const header of ['Bearer', 'Basic abc', 'Bearer not-a-jwt', 'abc']) {
      const res = await request('GET', '/v1/me', { headers: { Authorization: header } });
      expect(res.status, header).toBe(401);
    }
  });

  it('401s a session token on an /v1 route — scope is enforced, not just signature', async () => {
    const token = await apiToken();
    const created = await request('POST', '/v1/sessions', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    const sessionToken = (created.json() as { token: string }).token;
    const res = await request('GET', '/v1/me', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid api token and returns the principal', async () => {
    const res = await request('GET', '/v1/me', {
      headers: { Authorization: `Bearer ${await apiToken()}` },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ subject: 'github:1234' });
  });
});

describe('the exchange hop', () => {
  it('401s without the shared exchange token', async () => {
    const res = await request('POST', '/internal/credentials', { body: { token: 'x' } });
    expect(res.status).toBe(401);
    expect((res.json() as { error: string }).error).toBe('unauthorized');
  });

  it('401s with the wrong shared token', async () => {
    const res = await request('POST', '/internal/credentials', {
      body: { token: 'x' },
      headers: { Authorization: 'Bearer wrong' }, // notsecret
    });
    expect(res.status).toBe(401);
  });

  it('returns the credential for a valid session token', async () => {
    const token = await apiToken();
    const created = await request('POST', '/v1/sessions', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await request('POST', '/internal/credentials', {
      body: { token: (created.json() as { token: string }).token },
      headers: { Authorization: 'Bearer shared-abc' }, // notsecret
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'direct',
      anthropicBaseUrl: 'https://litellm.internal/v1',
    });
  });

  it('does not accept the exchange token as an /v1 credential', async () => {
    // The exchange token is an opaque shared secret, not a JWT, so it fails verifyToken's structural
    // check before requiredScope is ever evaluated -- this does not exercise scope separation (that is
    // covered by the "401s a session token on an /v1 route" case above). What this guards against is
    // someone later adding an `if (presented === config.exchangeToken) allow` shortcut inside
    // authorize(), which would let the deployment-hop secret stand in for a user's identity.
    const res = await request('GET', '/v1/me', { headers: { Authorization: 'Bearer shared-abc' } }); // notsecret
    expect(res.status).toBe(401);
  });
});

describe('error hygiene', () => {
  it('never returns a stack trace or an internal message on an unexpected throw', async () => {
    const broken = makeDeps({
      identity: {
        startDeviceAuth: async () => {
          throw new Error('redis://user:hunter2@10.0.0.1:6379 exploded'); // notsecret
        },
        completeDeviceAuth: async () => {
          throw new Error('nope');
        },
      } as never,
    });
    const srv = startControlPlane(broken, 0);
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const port = (srv.address() as { port: number }).port;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/auth/device', method: 'POST' },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    srv.close();
    expect(res.status).toBe(500);
    expect(res.body).toBe(JSON.stringify({ error: 'internal_error' }));
    expect(res.body).not.toContain('hunter2'); // notsecret
  });

  it('rejects an over-large body instead of buffering it', async () => {
    const res = await request('PUT', '/v1/credentials/k', {
      body: { pad: 'x'.repeat(200_000) },
      headers: { Authorization: `Bearer ${await apiToken()}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('buildHandler', () => {
  it('is usable without listening, for a caller that owns its own server', () => {
    expect(typeof buildHandler(d)).toBe('function');
  });
});

describe('startControlPlane host', () => {
  it('binds only the given host when one is passed (deploy/vm ships 127.0.0.1)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const srv = startControlPlane(makeDeps(), 0, '127.0.0.1');
      await new Promise<void>((r) => srv.once('listening', () => r()));
      const { address, port } = srv.address() as { address: string; port: number };
      expect(address).toBe('127.0.0.1');
      // The logged address is the socket's own, not the configured string.
      expect(log).toHaveBeenCalledWith(`sh-control-plane listening on 127.0.0.1:${port}`);
      await new Promise<void>((r) => srv.close(() => r()));
    } finally {
      log.mockRestore();
    }
  });

  it('logs `:<port>` when no host is given, as every existing deployment has', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const srv = startControlPlane(makeDeps(), 0);
      await new Promise<void>((r) => srv.once('listening', () => r()));
      const { port } = srv.address() as { port: number };
      expect(log).toHaveBeenCalledWith(`sh-control-plane listening on :${port}`);
      await new Promise<void>((r) => srv.close(() => r()));
    } finally {
      log.mockRestore();
    }
  });
});
