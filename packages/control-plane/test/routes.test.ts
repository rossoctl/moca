import { describe, expect, it } from 'vitest';
import { ROUTES, matchRoute, bodyLimitFor, DEFAULT_MAX_BODY_BYTES } from '../src/routes.js';

describe('the route table', () => {
  it('declares every slice-1 route from spec §4.2', () => {
    const declared = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(declared).toEqual(
      [
        'POST /v1/auth/device',
        'POST /v1/auth/device/token',
        'POST /v1/auth/token',
        'POST /v1/auth/revoke',
        'POST /v1/auth/revoke-all',
        'GET /v1/me',
        'GET /v1/models',
        'POST /v1/sessions',
        'GET /v1/sessions',
        'GET /v1/sessions/{id}',
        'DELETE /v1/sessions/{id}',
        'PATCH /v1/sessions/{id}',
        'GET /v1/sessions/{id}/resources',
        'GET /v1/sessions/{id}/models',
        'POST /v1/sessions/{id}/token',
        'GET /v1/credentials',
        'PUT /v1/credentials/{name}',
        'DELETE /v1/credentials/{name}',
        'POST /v1/config-bundles',
        'DELETE /v1/config-bundles/{digest}',
        'POST /internal/credentials',
        'GET /healthz',
        'GET /readyz',
        'GET /v1/discovery',
        // SBX0 §5.1: the sandbox profile's own.
        'GET /v1/templates',
        'POST /v1/sandboxes',
        'GET /v1/sandboxes',
        'GET /v1/sandboxes/{id}',
        'DELETE /v1/sandboxes/{id}',
        'POST /v1/sandboxes/{id}/token',
        'GET /v1/janitor/sandboxes',
      ].sort(),
    );
  });

  it('marks every {id}-taking session route as session-scoped', () => {
    // This is the structural half of §9.3 test 2: a sixth session endpoint added without the flag
    // fails here, and the runtime half (Task 13) then proves the flag actually gates assertOwner.
    const unflagged = ROUTES.filter(
      (r) => r.path.startsWith('/v1/sessions/{id}') && !r.sessionScoped,
    );
    expect(unflagged, 'a session-scoped route that bypasses assertOwner').toEqual([]);
  });

  it('requires no auth on the probes and the device flow, and exchange auth on the exchange', () => {
    const auth = (m: string, p: string) => ROUTES.find((r) => r.method === m && r.path === p)!.auth;
    expect(auth('GET', '/healthz')).toBe('none');
    expect(auth('GET', '/readyz')).toBe('none');
    expect(auth('POST', '/v1/auth/device')).toBe('none');
    expect(auth('POST', '/v1/auth/device/token')).toBe('none');
    expect(auth('POST', '/v1/auth/token')).toBe('none');
    expect(auth('POST', '/v1/auth/revoke')).toBe('none');
    expect(auth('POST', '/v1/auth/revoke-all')).toBe('api');
    expect(auth('POST', '/internal/credentials')).toBe('exchange');
    // A client reads it before it has logged in; it carries no per-subject data.
    expect(auth('GET', '/v1/discovery')).toBe('none');
    // The host janitor's read takes its own bearer and never a user's token (SBX0 §8.3).
    expect(auth('GET', '/v1/janitor/sandboxes')).toBe('janitor');
    expect(ROUTES.filter((r) => r.auth === 'janitor').map((r) => r.operationId)).toEqual([
      'janitorSandboxes',
    ]);
  });

  it('requires an api-scoped token on every other /v1 route', () => {
    // A session token must not be able to rewrite credentials or create a second session, so
    // nothing under /v1 accepts scope `turn:write` (plan gap #7).
    // The named exceptions: discovery (public config, read before login, GET-only), and the host
    // janitor's read, which takes the janitor's bearer instead (SBX0 §8.3).
    const EXEMPT = new Map([
      ['GET /v1/discovery', 'none'],
      ['GET /v1/janitor/sandboxes', 'janitor'],
    ]);
    const wrong = ROUTES.filter(
      (r) =>
        r.path.startsWith('/v1/') &&
        !r.path.startsWith('/v1/auth/') &&
        r.auth !== (EXEMPT.get(`${r.method} ${r.path}`) ?? 'api'),
    );
    expect(wrong.map((r) => r.path)).toEqual([]);
  });

  it('gates ?owner= and ?all= on an admin role, on the two list routes only', () => {
    const list = ROUTES.find((r) => r.method === 'GET' && r.path === '/v1/sessions')!;
    expect(list.adminOnlyQuery).toBe('owner');
    const sandboxes = ROUTES.find((r) => r.operationId === 'listSandboxes')!;
    expect(sandboxes.adminOnlyQuery).toBe('all');
    expect(ROUTES.filter((r) => r.adminOnlyQuery).length).toBe(2);
  });
});

describe('matchRoute', () => {
  it('extracts a path parameter', () => {
    const m = matchRoute('GET', '/v1/sessions/019ed8eb-4757');
    expect(m?.route.path).toBe('/v1/sessions/{id}');
    expect(m?.params).toEqual({ id: '019ed8eb-4757' });
  });

  it('ignores the query string when matching', () => {
    const m = matchRoute('GET', '/v1/sessions?limit=10&cursor=5');
    expect(m?.route.path).toBe('/v1/sessions');
    expect(m?.params).toEqual({});
  });

  it('url-decodes a parameter', () => {
    const m = matchRoute('PUT', '/v1/credentials/github%2Dwork');
    expect(m?.params).toEqual({ name: 'github-work' });
  });

  it('does not let a parameter swallow a path segment', () => {
    // Without an anchored per-segment pattern, `/v1/sessions/{id}` would match
    // `/v1/sessions/a/resources` with id="a/resources" and route it to the wrong handler.
    expect(matchRoute('GET', '/v1/sessions/a/resources')?.route.path).toBe(
      '/v1/sessions/{id}/resources',
    );
    expect(matchRoute('GET', '/v1/sessions/a/b/c')).toBeNull();
  });

  it('distinguishes methods on one path', () => {
    expect(matchRoute('DELETE', '/v1/sessions/x')?.route.method).toBe('DELETE');
    expect(matchRoute('PATCH', '/v1/sessions/x')?.route.method).toBe('PATCH');
    expect(matchRoute('PUT', '/v1/sessions/x')).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('GET', '/v1/nope')).toBeNull();
    expect(matchRoute('GET', '/')).toBeNull();
  });
});

describe('bodyLimitFor', () => {
  it('keeps 64 KiB as the default', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024);
    const putCredential = ROUTES.find((r) => r.operationId === 'putCredential')!;
    expect(bodyLimitFor(putCredential)).toBe(64 * 1024);
  });

  it('uses a route-declared limit', () => {
    expect(
      bodyLimitFor({
        method: 'POST',
        path: '/x',
        auth: 'api',
        sessionScoped: false,
        profiles: ['harness'],
        operationId: 'x',
        maxBodyBytes: 1234,
      }),
    ).toBe(1234);
  });
});
