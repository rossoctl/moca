import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, matchRoute, type RouteSpec } from '../src/routes.js';
import { buildHandler } from '../src/server.js';
import { apiIssuer, type CpConfig } from '../src/handlers.js';
import { makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

// SBX0 §4.1: the sandbox control plane mounts the login routes and its own, NOTHING else -- by an
// allow list per profile, so a route added later is unmounted under `sandbox` until someone lists it.
const SHARED = [
  'GET /healthz',
  'GET /readyz',
  'GET /v1/discovery',
  'POST /v1/auth/device',
  'POST /v1/auth/device/token',
  'GET /v1/auth/oidc/callback',
  'POST /v1/auth/oidc/callback',
  'POST /v1/auth/token',
  'POST /v1/auth/revoke',
  'POST /v1/auth/revoke-all',
  'GET /v1/me',
  // Template lifecycle spec §4.1: one catalog for sessions and sandboxes.
  'GET /v1/templates',
  'GET /v1/templates/{id}',
  'GET /v1/templates/{id}/builds',
  'GET /v1/templates/{id}/builds/{build}',
  'GET /v1/templates/{id}/tags',
  'POST /v1/templates',
  'POST /v1/templates/{id}/builds',
  'POST /v1/templates/{id}/builds/{build}/cancel',
  'POST /v1/templates/{id}/tags',
  'DELETE /v1/templates/{id}/tags/{tag}',
  'PATCH /v1/templates/{id}',
  'PUT /v1/templates/{id}/owner',
  'POST /v1/templates/{id}/retire',
  'DELETE /v1/templates/{id}/builds/{build}',
  'POST /v1/templates/{id}/activate',
  'POST /v1/templates/{id}/deactivate',
  'GET /v1/policy',
  'PUT /v1/policy',
  'GET /v1/quota',
  'POST /v1/hosts/{host}/inventory',
  'POST /v1/hosts/{host}/builds/claim',
  'GET /v1/hosts/{host}/blobs/{digest}',
  'POST /v1/hosts/{host}/builds/{build}/log',
  'POST /v1/hosts/{host}/builds/{build}/report',
  'GET /v1/hosts/{host}/wanted',
  'POST /v1/hosts/{host}/workers/report',
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
  'lookupEgressCredential',
  'mintSandboxModeToken',
  'mintSandboxToken',
  'setSandboxMode',
];

// SBX0.2b: mounted on `sandbox` only when egress is configured (RouteSpec.requiresEgress).
const EGRESS = [
  'GET /v1/credentials',
  'PUT /v1/credentials/{name}',
  'DELETE /v1/credentials/{name}',
  'POST /v1/egress/credential',
];
// Egress-gated AND sandbox-only: the one route harness never mounts.
const EGRESS_SANDBOX_ONLY = 'POST /v1/egress/credential';
const EGRESS_CONFIG = {
  hosts: [{ id: 'kvm', workers: ['sbx_default'], token: 'a'.repeat(64) }], // notsecret
  ttlSeconds: 60,
};
const key = (r: RouteSpec) => `${r.method} ${r.path}`;

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

  it('shares exactly the probe, discovery, login and egress-gated credential routes between the two profiles', () => {
    const both = ROUTES.filter(
      (r) => r.profiles.includes('harness') && r.profiles.includes('sandbox'),
    );
    expect(both.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...SHARED, ...EGRESS.filter((k) => k !== EGRESS_SANDBOX_ONLY)].sort(),
    );
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

  it('mounts the egress routes on sandbox only when egress is configured', async () => {
    const off = ROUTES.filter((r) => EGRESS.includes(key(r)));
    expect(off.map(key).sort()).toEqual([...EGRESS].sort());
    expect(
      ROUTES.filter((r) => r.requiresEgress)
        .map(key)
        .sort(),
    ).toEqual([...EGRESS].sort());
    await expectUnknownPath(await serveWith(sandboxDeps()), off);
    for (const r of off) {
      expect(matchRoute(r.method, concrete(r.path), 'sandbox')).toBeNull();
      expect(matchRoute(r.method, concrete(r.path), 'sandbox', { egress: true })?.route).toBe(r);
      if (key(r) === EGRESS_SANDBOX_ONLY) {
        expect(matchRoute(r.method, concrete(r.path), 'harness')).toBeNull();
      } else {
        expect(matchRoute(r.method, concrete(r.path), 'harness')?.route).toBe(r);
      }
    }
    // with egress: reachable (matched, then refused for want of a token)
    const base = await serveWith(sandboxDeps({ egress: EGRESS_CONFIG }));
    for (const r of off) {
      const res = await fetch(base + concrete(r.path), {
        method: r.method,
        body: r.method === 'PUT' ? '{}' : undefined,
      });
      expect(res.status, key(r)).toBe(401);
    }
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

  it('takes only a user API token on the mode routes: a sandbox or set-mode token is a 401', async () => {
    const d = { ...sandboxDeps(), newId: () => 'b'.repeat(26) };
    const base = await serveWith(d);
    const user = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      ttlSeconds: 3600,
      iss: apiIssuer(d.config),
      now: Math.floor(NOW_MS / 1000),
    });
    const call = (method: string, path: string, token: string, body?: object) =>
      fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    const created = await call('POST', '/v1/sandboxes', user, { template: 'default' });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const sbxToken = (
      (await (await call('POST', `/v1/sandboxes/${id}/token`, user)).json()) as {
        token: string;
      }
    ).token;
    const put = await call('PUT', `/v1/sandboxes/${id}/mode`, user, { mode: 'lease' });
    expect(put.status).toBe(200);
    const { setModeToken } = (await put.json()) as { setModeToken: string };
    const minted = await call('POST', `/v1/sandboxes/${id}/mode-token`, user);
    expect(minted.status).toBe(200);
    for (const [what, token] of [
      ['a sandbox token', sbxToken],
      ['a set-mode token', setModeToken],
    ] as const) {
      const p = await call('PUT', `/v1/sandboxes/${id}/mode`, token, { mode: 'per-exec' });
      expect(p.status, `PUT mode with ${what}`).toBe(401);
      const m = await call('POST', `/v1/sandboxes/${id}/mode-token`, token);
      expect(m.status, `mode-token with ${what}`).toBe(401);
    }
    // Neither refusal changed anything: the one accepted PUT is epoch 1.
    expect((await d.sandboxes!.get(id, Math.floor(NOW_MS / 1000)))!.modeEpoch).toBe(1);
  });

  it('still serves the harness routes under the default profile', async () => {
    const base = await serve('harness');
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401); // matched, then refused: no token
  });
});

describe('API token issuers per profile (SBX0 §4.1)', () => {
  // One signing key, two stacks: what an SBX namespace that reused a MOCA moca-mu1 would run.
  const apiToken = (d: TestDeps, iss: string) =>
    d.signer.mint({
      sub: 'github:1',
      tenant: 'github:1',
      roles: [],
      scope: ['api'],
      ttlSeconds: 3600,
      iss,
      now: Math.floor(NOW_MS / 1000),
    });

  it('refuses the other profile’s API token on the same key, both ways', async () => {
    const harness = makeDeps({ config: { routeProfile: 'harness' } });
    const sandbox = makeDeps({
      config: { routeProfile: 'sandbox' },
      signer: harness.signer,
      verifyKeys: harness.verifyKeys,
    });
    const hBase = await serveWith(harness);
    const sBase = await serveWith(sandbox);
    const me = (base: string, token: string) =>
      fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect((await me(hBase, apiToken(harness, apiIssuer(harness.config)))).status).toBe(200);
    expect((await me(sBase, apiToken(sandbox, apiIssuer(sandbox.config)))).status).toBe(200);
    expect((await me(hBase, apiToken(sandbox, apiIssuer(sandbox.config)))).status).toBe(401);
    expect((await me(sBase, apiToken(harness, apiIssuer(harness.config)))).status).toBe(401);
  });
});
