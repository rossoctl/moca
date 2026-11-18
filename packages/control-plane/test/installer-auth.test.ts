import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startControlPlane } from '../src/server.js';
import { makeSigner } from '../src/token.js';
import { makeDeps, type TestDeps } from './helpers/deps.js';

/**
 * The installer bearer (SH_INSTALLER_TOKEN, server.ts authorize()): a static operator credential
 * for the members routes, and nowhere else. Every case is driven through the real HTTP server,
 * because authorize() is the piece under test -- a handler-level test would skip it.
 *
 * The members store is absent in these deps, so an AUTHORIZED caller of /v1/subjects gets the
 * handler's 400 "does not store members" and an unauthorized one authorize()'s 401: the status
 * code is the auth verdict, which is exactly what each case asserts.
 */
const TOKEN = 'installer-token-0123456789abcdef0123456789abcdef'; // notsecret

let server: ReturnType<typeof startControlPlane>;
let base: string;
let d: TestDeps;

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  d = makeDeps({ config: { installerToken: TOKEN, routeProfile: 'sandbox' } });
  // The sandbox profile needs a signing key on the deps the harness did not set: reuse the one
  // makeDeps built (makeDeps' own signer), which startControlPlane verifies against.
  void signer;
  server = startControlPlane(d, 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  server.close();
});

describe('the installer bearer (SH_INSTALLER_TOKEN)', () => {
  it('authorizes the members routes: the handler answers, not authorize()', async () => {
    const res = await request('GET', '/v1/subjects', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400); // no members store: the handler's refusal, past the auth gate
    expect(res.body).toContain('does not store members');
  });

  it('refuses a wrong bearer on the members routes', async () => {
    const res = await request('GET', '/v1/subjects', {
      authorization: 'Bearer installer-token-wrong-wrong-wrong-wrong',
    });
    // A non-matching bearer falls through to API-token verification, which refuses a non-token.
    expect(res.status).toBe(401);
  });

  it('refuses a missing bearer on the members routes', async () => {
    const res = await request('GET', '/v1/subjects');
    expect(res.status).toBe(401);
  });

  it('is refused on every other api route: it is not an API token', async () => {
    // The sandbox profile mounts no plain-api route, so this case runs the default (harness)
    // profile, where POST /v1/sessions is auth 'api': the installer bearer must be refused there
    // exactly as any other non-token is.
    server.close();
    d = makeDeps({ config: { installerToken: TOKEN, exchangeToken: 'shared-abc' } }); // notsecret
    server = startControlPlane(d, 0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    const res = await request('POST', '/v1/sessions', {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('matches nothing when no token is configured (fail-closed)', async () => {
    server.close();
    d = makeDeps({ config: { routeProfile: 'sandbox' } });
    server = startControlPlane(d, 0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    const res = await request('GET', '/v1/subjects', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
  });
});
