import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  class FakeStore {
    async set() {}
    async get() {
      return null;
    }
    async close() {}
  }
  return { ...actual, RedisResultStore: FakeStore };
});

const runLeaf = vi.fn(async () => ({ status: 'responded', text: 'ok' }));
vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...a: unknown[]) => runLeaf(...(a as [])),
  validateItem: () => null,
  leafSessionId: (env: { sessionId?: string }) => env.sessionId ?? 'leaf',
}));

import { startServer } from '../src/server.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const tokenFor = (sid: string) =>
  signer.mint({
    sub: 'github:1234',
    tenant: 'github:1234',
    roles: [],
    scope: ['turn:write'],
    sid,
    ttlSeconds: 300,
  });

let server: ReturnType<typeof startServer>;
let base: string;
let cp: http.Server;
const KEYS = [
  'SH_REQUIRE_AUTH',
  'SH_SESSION_TOKEN_PUBLIC_KEYS',
  'SH_CONTROL_PLANE_URL',
  'SH_EXCHANGE_TOKEN',
];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-alice', // notsecret
        anthropicBaseUrl: 'https://litellm.internal/v1',
        sessionId: 'sid-1',
        subject: 'github:1234',
      }),
    );
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  runLeaf.mockClear();
  server = startServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => cp.close(() => r()));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const envelope = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  kind: 'prompt',
  prompt: 'hi',
  ...extra,
});

describe('POST /runs under SH_REQUIRE_AUTH=true (MI1 R7)', () => {
  beforeEach(() => {
    process.env.SH_REQUIRE_AUTH = 'true';
  });

  it('refuses a run with no token, without running it', async () => {
    const r = await call('POST', '/runs', envelope('sid-1'));
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('token_required');
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it("refuses a valid token presented for a different session's run", async () => {
    const r = await call('POST', '/v1/runs', envelope('sid-2'), tokenFor('sid-1'));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('session_mismatch');
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('runs an authenticated run on the exchanged credential, in server mode', async () => {
    const r = await call('POST', '/runs', envelope('sid-1'), tokenFor('sid-1'));
    expect(r.status).toBeLessThan(300);
    expect(runLeaf).toHaveBeenCalledTimes(1);
    const config = (runLeaf.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(config.upstreamCredential).toEqual({ mode: 'direct', value: 'sk-alice' }); // notsecret
    expect(config.serverMode).toBe(true);
    expect(config).not.toHaveProperty('anthropicAuthToken');
  });

  it('refuses an asynchronous run with the ADR-0041 removal error', async () => {
    const r = await call('POST', '/runs', envelope('sid-1', { async: true }), tokenFor('sid-1'));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('async_removed');
  });

  it('refuses a caller-supplied tenant on an authenticated run: the token alone scopes it', async () => {
    const r = await call(
      'POST',
      '/runs',
      envelope('sid-1', { tenant: 'other' }),
      tokenFor('sid-1'),
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tenant_not_allowed');
    expect(runLeaf).not.toHaveBeenCalled();
  });
});

describe('GET /runs/status under SH_REQUIRE_AUTH=true (MI1 R7)', () => {
  beforeEach(() => {
    process.env.SH_REQUIRE_AUTH = 'true';
  });

  it('refuses a status read with no token', async () => {
    expect((await call('GET', '/runs/status?sessionId=sid-1')).status).toBe(401);
  });

  it('refuses a status read that names no session, with or without a token', async () => {
    for (const path of ['/runs/status', '/runs/status?sessionId=', '/run-leaf/status']) {
      const anonymous = await call('GET', path);
      expect(anonymous.status).toBe(400);
      expect(anonymous.json.error).toBe('sessionId_required');
      const withToken = await call('GET', path, undefined, tokenFor('sid-1'));
      expect(withToken.status).toBe(400);
      expect(withToken.json.error).toBe('sessionId_required');
    }
  });

  it("refuses a valid token reading another session's status", async () => {
    const r = await call('GET', '/runs/status?sessionId=sid-2', undefined, tokenFor('sid-1'));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('session_mismatch');
  });

  it("answers the token's own session", async () => {
    const r = await call('GET', '/runs/status?sessionId=sid-1', undefined, tokenFor('sid-1'));
    expect(r.status).toBe(200);
  });

  it('refuses a caller-supplied tenant on an authenticated status read: the token alone scopes it', async () => {
    const r = await call(
      'GET',
      '/runs/status?sessionId=sid-1&tenant=other',
      undefined,
      tokenFor('sid-1'),
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tenant_not_allowed');
  });
});

describe('without SH_REQUIRE_AUTH, /runs behaves as today', () => {
  it('runs an unauthenticated run on the ambient configuration', async () => {
    const r = await call('POST', '/runs', envelope('sid-9'));
    expect(r.status).toBeLessThan(300);
    expect(runLeaf).toHaveBeenCalledTimes(1);
  });

  it('refuses an asynchronous run presented with a session token rather than run it on the ambient credential', async () => {
    const r = await call('POST', '/runs', envelope('sid-1', { async: true }), tokenFor('sid-1'));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('async_removed');
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated asynchronous run with the ADR-0041 removal error', async () => {
    const r = await call('POST', '/runs', envelope('sid-9', { async: true }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('async_removed');
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('still refuses a present-but-bad token', async () => {
    const r = await call('POST', '/runs', envelope('sid-9'), 'not-a-token');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('still accepts a caller-supplied tenant on an unauthenticated run', async () => {
    const r = await call('POST', '/runs', envelope('sid-9', { tenant: 'acme' }));
    expect(r.status).toBeLessThan(300);
    expect(runLeaf).toHaveBeenCalledTimes(1);
  });
});
