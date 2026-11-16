import { createServer, request, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startInferenceProxy } from '../src/inference-proxy.js';
import { seedCredential, type TestDeps } from './helpers/deps.js';
import { grantDeps, mint, seedSession, tombstone } from './helpers/grants.js';

interface Seen {
  method: string;
  url: string;
  auth?: string;
  apiKey?: string;
  body: string;
}

/** A fake upstream that records each request and answers two SSE chunks. */
async function upstream(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        body,
        auth: req.headers.authorization as string | undefined,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 10);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

async function proxyOn(d: TestDeps) {
  const s: Server = startInferenceProxy(d, 0, '127.0.0.1');
  await new Promise<void>((r) => s.once('listening', () => r()));
  const port = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

/**
 * `fetch` normalises `..` out of a path before it reaches the wire, so it cannot exercise the
 * listener's own guard. `node:http` sends the path it is given, which is what a hostile client on
 * the sandbox network would do.
 */
function rawPost(base: string, path: string, auth: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        method: 'POST',
        path,
        headers: { authorization: auth },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('the inference listener (MI1 §6.3, §8.6; decision D1)', () => {
  let d: TestDeps;
  let up: Awaited<ReturnType<typeof upstream>>;
  let px: Awaited<ReturnType<typeof proxyOn>>;

  beforeEach(async () => {
    d = grantDeps();
    up = await upstream();
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      endpoint: up.url,
      destination: { hosts: ['127.0.0.1'] },
    });
    await seedSession(d);
    px = await proxyOn(d);
  });
  afterEach(async () => {
    await px.close();
    await up.close();
  });

  it('swaps the grant for the credential and streams the answer back', async () => {
    const res = await fetch(`${px.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mint(d).inferenceGrant}`,
        'content-type': 'application/json',
      },
      body: '{"model":"x"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n');
    expect(up.seen[0]!.url).toBe('/v1/messages'); // the path is forwarded verbatim
    expect(up.seen[0]!.body).toBe('{"model":"x"}');
    expect(up.seen[0]!.auth).toBe('Bearer sk-fake'); // the real credential, in its own header
    expect(up.seen[0]!.apiKey).toBeUndefined();
  });

  it('sends an api-key credential in x-api-key and no Authorization at all', async () => {
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      kind: 'api-key',
      endpoint: up.url,
      destination: { hosts: ['127.0.0.1'] },
      secret: { key: 'key-fake' }, // notsecret
    });
    const res = await fetch(`${px.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(d).inferenceGrant}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(up.seen[0]!.apiKey).toBe('key-fake');
    expect(up.seen[0]!.auth).toBeUndefined();
  });

  it('drops content-encoding, which fetch has already decoded, so no answer is gunzipped twice', async () => {
    // A provider that honours gzip answers every non-streamed request compressed. `fetch` decodes
    // it for us but leaves the header, so forwarding the header hands the worker plain text labelled
    // gzip -- which is exactly what this test's own `fetch` would then fail to decode.
    const gz = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('{"ok":true}')));
    });
    await new Promise<void>((r) => gz.listen(0, '127.0.0.1', () => r()));
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      endpoint: `http://127.0.0.1:${(gz.address() as { port: number }).port}`,
      destination: { hosts: ['127.0.0.1'] },
    });
    try {
      const res = await fetch(`${px.url}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${mint(d).inferenceGrant}` },
        body: '{}',
      });
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      await new Promise<void>((r) => gz.close(() => r()));
    }
  });

  it('keeps a path prefix on the credential endpoint instead of discarding it', async () => {
    // `new URL(path, base)` would aim the secret at the gateway root; concatenation is what makes
    // the listener transparent -- the upstream sees the path pi would have sent in direct mode.
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      endpoint: `${up.url}/anthropic`,
      destination: { hosts: ['127.0.0.1'] },
    });
    await fetch(`${px.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(d).inferenceGrant}` },
      body: '{}',
    });
    expect(up.seen[0]!.url).toBe('/anthropic/v1/messages');
  });

  it('refuses a missing, malformed and unverifiable bearer with 401, reaching no upstream', async () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer nope' },
    ];
    for (const headers of cases) {
      const res = await fetch(`${px.url}/v1/messages`, { method: 'POST', headers, body: '{}' });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('grant_invalid');
    }
    expect(up.seen).toHaveLength(0);
  });

  it('refuses a tombstoned session with 404, and no secret is in the body', async () => {
    const g = mint(d).inferenceGrant;
    await tombstone(d, 'sid-fixed');
    const res = await fetch(`${px.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${g}` },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('sk-fake');
    expect(up.seen).toHaveLength(0);
  });

  it('refuses a literal .. in the path, so nothing climbs out of the endpoint prefix', async () => {
    expect(await rawPost(px.url, '/v1/../../admin', `Bearer ${mint(d).inferenceGrant}`)).toBe(400);
    expect(up.seen).toHaveLength(0);
  });

  it('lets nothing outside the endpoint`s own prefix reach the upstream', async () => {
    await seedCredential(d, 'github:1234', 'my-anthropic', {
      endpoint: `${up.url}/anthropic`,
      destination: { hosts: ['127.0.0.1'] },
    });
    // Node's fetch normalises `..` away before sending, so assert on what ARRIVES rather than on a
    // code: whichever layer stops it, the upstream must not see a path outside the prefix.
    await fetch(`${px.url}/v1/../../admin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(d).inferenceGrant}` },
      body: '{}',
    });
    expect(up.seen[0]?.url ?? '/anthropic/').toMatch(/^\/anthropic\//);
  });

  it('binds a bracketed IPv6 address, which listen would otherwise resolve as a hostname', async () => {
    // `MOCA_INFERENCE_ADDR=[::1]:9100` is the documented way to write a v6 address, and
    // `inferenceAddrFromEnv` hands the brackets through. Not every CI box has loopback v6, so this
    // asserts on what must NOT happen: a DNS lookup of the literal `[::1]`.
    const s = startInferenceProxy(d, 0, '[::1]');
    const code = await new Promise<string>((r) => {
      s.once('listening', () => r('listening'));
      s.once('error', (e: NodeJS.ErrnoException) => r(e.code ?? 'error'));
    });
    s.close();
    expect(['listening', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']).toContain(code);
  });

  it('answers 503 when the endpoint is unreachable, naming no secret', async () => {
    await up.close();
    const res = await fetch(`${px.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(d).inferenceGrant}` },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('sk-fake');
  });
});
