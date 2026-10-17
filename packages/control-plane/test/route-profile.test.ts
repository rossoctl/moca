import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, matchRoute, type RouteSpec } from '../src/routes.js';
import { buildHandler } from '../src/server.js';
import type { CpConfig } from '../src/handlers.js';
import { makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// SBX0 §4.1: the sandbox control plane mounts the login routes and its own, NOTHING else -- by an
// allow list per profile, so a route added later is unmounted under `sandbox` until someone lists it.
const SHARED = [
  'GET /healthz',
  'GET /readyz',
  'GET /v1/discovery',
  'POST /v1/auth/device',
  'POST /v1/auth/device/token',
  'POST /v1/auth/token',
  'POST /v1/auth/revoke',
  'POST /v1/auth/revoke-all',
  'GET /v1/me',
];

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serveWith(d: TestDeps): Promise<string> {
  const server = createServer(buildHandler(d));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const serve = (profile: 'harness' | 'sandbox') =>
  serveWith(makeDeps({ config: { routeProfile: profile } }));

const SANDBOX_ONLY = [
  'createSandbox',
  'deleteSandbox',
  'getSandbox',
  'janitorSandboxes',
  'listSandboxes',
  'listTemplates',
  'mintSandboxToken',
];

const JANITOR_TOKEN = 'j'.repeat(40); // notsecret

function sandboxDeps(over: Partial<CpConfig['sandbox']> = {}): TestDeps {
  const base = makeDeps().config.sandbox!;
  return makeDeps({ config: { routeProfile: 'sandbox', sandbox: { ...base, ...over } } });
}

/** An API token, as the device flow would issue it, for `sub` with `roles`. */
const apiToken = (d: TestDeps, sub: string, roles: string[]) =>
  d.signer.mint({
    sub,
    tenant: sub,
    roles,
    scope: ['api'],
    ttlSeconds: 3600,
    now: Math.floor(NOW_MS / 1000),
  });

const concrete = (path: string) => path.replace(/\{[^}]+\}/g, 'x');

/** Every route in `routes` answers exactly as an unknown path does: an unmounted route is invisible. */
async function expectUnknownPath(base: string, routes: readonly RouteSpec[]): Promise<void> {
  const unknownBody = await (await fetch(`${base}/no/such/path`)).json();
  for (const r of routes) {
    const res = await fetch(base + concrete(r.path), {
      method: r.method,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}',
    });
    expect(res.status, `${r.method} ${r.path}`).toBe(404);
    expect(await res.json(), `${r.method} ${r.path}`).toEqual(unknownBody);
  }
}

describe('route profiles (SBX0 §4.1)', () => {
  it('declares a non-empty profile list on every route', () => {
    expect(ROUTES.filter((r) => !r.profiles || r.profiles.length === 0).map((r) => r.path)).toEqual(
      [],
    );
  });

  it('shares exactly the probe, discovery and login routes between the two profiles', () => {
    const both = ROUTES.filter(
      (r) => r.profiles.includes('harness') && r.profiles.includes('sandbox'),
    );
    expect(both.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...SHARED].sort());
  });

  it('matches a route only under a profile that lists it', () => {
    expect(matchRoute('POST', '/v1/sessions', 'harness')?.route.operationId).toBe('createSession');
    expect(matchRoute('POST', '/v1/sessions', 'sandbox')).toBeNull();
    expect(matchRoute('GET', '/v1/me', 'sandbox')?.route.operationId).toBe('getMe');
    expect(matchRoute('POST', '/v1/sessions')?.route.operationId).toBe('createSession'); // default: harness
  });

  it('answers every harness-only route with the unknown-path 404 under the sandbox profile', async () => {
    const base = await serve('sandbox');
    const harnessOnly = ROUTES.filter((r) => !r.profiles.includes('sandbox'));
    expect(harnessOnly.length).toBeGreaterThan(10); // guards the guard
    await expectUnknownPath(base, harnessOnly);
  });

  it('mounts the sandbox routes on the sandbox profile only', () => {
    const sandboxOnly = ROUTES.filter(
      (r) => r.profiles.length === 1 && r.profiles[0] === 'sandbox',
    );
    expect(sandboxOnly.map((r) => r.operationId).sort()).toEqual(SANDBOX_ONLY);
  });

  it('answers every sandbox-only route with the unknown-path 404 under the harness profile', async () => {
    const base = await serve('harness');
    const sandboxOnly = ROUTES.filter((r) => !r.profiles.includes('harness'));
    expect(sandboxOnly.map((r) => r.operationId).sort()).toEqual(SANDBOX_ONLY);
    await expectUnknownPath(base, sandboxOnly);
  });

  it('serves the janitor read only with the janitor bearer (SBX0 §8.3)', async () => {
    const d = sandboxDeps({ janitorToken: JANITOR_TOKEN });
    const base = await serveWith(d);
    const get = (authorization?: string) =>
      fetch(`${base}/v1/janitor/sandboxes`, {
        headers: authorization ? { authorization } : {},
      });
    const refusals: [string, string | undefined][] = [
      ['no token', undefined],
      ["a user's API token", `Bearer ${apiToken(d, 'github:1234', [])}`],
      ["an admin's API token", `Bearer ${apiToken(d, 'github:1', ['admin'])}`],
      ['a wrong bearer of the same length', `Bearer ${'k'.repeat(40)}`],
    ];
    for (const [what, authorization] of refusals) {
      const res = await get(authorization);
      expect(res.status, what).toBe(401);
      const body = await res.json();
      expect(body, what).toMatchObject({ error: 'unauthorized' });
      expect(JSON.stringify(body), what).not.toContain('kkkk');
    }
    const ok = await get(`Bearer ${JANITOR_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ live: [], terminated: [] });
  });

  it('refuses the janitor read to everyone when SH_JANITOR_TOKEN is unset', async () => {
    const d = sandboxDeps();
    expect(d.config.sandbox!.janitorToken).toBeUndefined();
    const base = await serveWith(d);
    for (const authorization of [
      undefined,
      'Bearer ',
      `Bearer ${JANITOR_TOKEN}`,
      `Bearer ${apiToken(d, 'github:1', ['admin'])}`,
    ]) {
      const res = await fetch(`${base}/v1/janitor/sandboxes`, {
        headers: authorization ? { authorization } : {},
      });
      expect(res.status, String(authorization)).toBe(401);
    }
  });

  it('never takes the janitor bearer as a user token', async () => {
    const base = await serveWith(sandboxDeps({ janitorToken: JANITOR_TOKEN }));
    const res = await fetch(`${base}/v1/sandboxes`, {
      headers: { authorization: `Bearer ${JANITOR_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('still serves the harness routes under the default profile', async () => {
    const base = await serve('harness');
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401); // matched, then refused: no token
  });
});
