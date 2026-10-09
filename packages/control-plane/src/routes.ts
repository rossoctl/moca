/**
 * The control plane's route table, declared once and read three times: by the router (src/server.ts),
 * by the authz enumeration test (spec §9.3 test 2), and by the OpenAPI drift test (test 3). The
 * failure mode designed against is authz scattered per-handler, where the fifth endpoint someone
 * adds forgets the ownership check (spec §5.4) -- so "is this session-scoped" is data here, not a
 * line inside a handler that a test cannot enumerate.
 */
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** OpenAPI-style template. `{name}` segments become params. */
  path: string;
  /**
   * `none`     -- unauthenticated (probes, device flow).
   * `api`      -- Ed25519 token with scope `api` (plan gap #7).
   * `exchange` -- the shared SH_EXCHANGE_TOKEN bearer (spec §5.3.1).
   */
  auth: 'none' | 'api' | 'exchange';
  /** Goes through assertOwner(params.id, principal) before the handler body runs. */
  sessionScoped: boolean;
  /** A query parameter that requires `roles` to include `admin` (spec §4.1). */
  adminOnlyQuery?: string;
  /**
   * Whether a POST/PUT route needs a request body. Defaults to true (most do); a route whose
   * handler takes everything from the path param and the caller's own principal -- startDeviceAuth,
   * mintSessionToken -- sets this false so the router's generic empty-body guard doesn't 400 a
   * client that correctly sends nothing. Ignored for GET/DELETE, which never read a body.
   */
  bodyRequired?: boolean;
  /** Request body cap in bytes; absent means DEFAULT_MAX_BODY_BYTES. Raise it per route, never globally. */
  maxBodyBytes?: number;
  /** Stable key the router and the OpenAPI drift test both use to name the operation. */
  operationId: string;
}

export const ROUTES: readonly RouteSpec[] = [
  { method: 'GET', path: '/healthz', auth: 'none', sessionScoped: false, operationId: 'healthz' },
  { method: 'GET', path: '/readyz', auth: 'none', sessionScoped: false, operationId: 'readyz' },
  // Public by design: a client asks it BEFORE logging in, to learn where the harness is.
  {
    method: 'GET',
    path: '/v1/discovery',
    auth: 'none',
    sessionScoped: false,
    operationId: 'getDiscovery',
  },
  {
    method: 'POST',
    path: '/v1/auth/device',
    auth: 'none',
    sessionScoped: false,
    bodyRequired: false,
    operationId: 'startDeviceAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/device/token',
    auth: 'none',
    sessionScoped: false,
    operationId: 'completeDeviceAuth',
  },
  // B14: the refresh token is the credential on the first two, so they take no API token.
  {
    method: 'POST',
    path: '/v1/auth/token',
    auth: 'none',
    sessionScoped: false,
    operationId: 'refreshAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/revoke',
    auth: 'none',
    sessionScoped: false,
    operationId: 'revokeAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/revoke-all',
    auth: 'api',
    sessionScoped: false,
    bodyRequired: false,
    operationId: 'revokeAllAuth',
  },
  { method: 'GET', path: '/v1/me', auth: 'api', sessionScoped: false, operationId: 'getMe' },
  {
    method: 'POST',
    path: '/v1/sessions',
    auth: 'api',
    sessionScoped: false,
    operationId: 'createSession',
  },
  {
    method: 'GET',
    path: '/v1/sessions',
    auth: 'api',
    sessionScoped: false,
    adminOnlyQuery: 'owner',
    operationId: 'listSessions',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}',
    auth: 'api',
    sessionScoped: true,
    operationId: 'getSession',
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/{id}',
    auth: 'api',
    sessionScoped: true,
    operationId: 'deleteSession',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}/resources',
    auth: 'api',
    sessionScoped: true,
    operationId: 'getSessionResources',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{id}/token',
    auth: 'api',
    sessionScoped: true,
    bodyRequired: false,
    operationId: 'mintSessionToken',
  },
  {
    method: 'GET',
    path: '/v1/credentials',
    auth: 'api',
    sessionScoped: false,
    operationId: 'listCredentials',
  },
  {
    method: 'PUT',
    path: '/v1/credentials/{name}',
    auth: 'api',
    sessionScoped: false,
    operationId: 'putCredential',
  },
  {
    method: 'DELETE',
    path: '/v1/credentials/{name}',
    auth: 'api',
    sessionScoped: false,
    operationId: 'deleteCredential',
  },
  {
    method: 'POST',
    path: '/v1/config-bundles',
    auth: 'api',
    sessionScoped: false,
    // Holds the base64 of a MAX_BUNDLE_BYTES tar (~10.7 MiB) plus the JSON wrapper.
    maxBodyBytes: 12 * 1024 * 1024,
    operationId: 'putConfigBundle',
  },
  {
    method: 'DELETE',
    path: '/v1/config-bundles/{digest}',
    auth: 'api',
    sessionScoped: false,
    operationId: 'deleteConfigBundle',
  },
  {
    method: 'POST',
    path: '/internal/credentials',
    auth: 'exchange',
    sessionScoped: false,
    operationId: 'exchangeCredential',
  },
];

/** A credential body is a few hundred bytes; 64 KiB is generous and bounds a hostile caller. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function bodyLimitFor(route: RouteSpec): number {
  return route.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}

/**
 * Compile a template to an ANCHORED regex whose parameters match a SINGLE segment (`[^/]+`).
 * Unanchored or `.+` params would let `/v1/sessions/{id}` swallow `/v1/sessions/a/resources` with
 * `id="a/resources"`, silently routing a resources read to the session handler.
 */
function compile(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      const m = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]!);
      return '([^/]+)';
    })
    .join('/');
  return { re: new RegExp(`^${source}$`), names };
}

const COMPILED = ROUTES.map((route) => ({ route, ...compile(route.path) }));

export function matchRoute(
  method: string,
  url: string,
): { route: RouteSpec; params: Record<string, string> } | null {
  const pathname = url.split('?')[0] ?? '';
  for (const { route, re, names } of COMPILED) {
    if (route.method !== method) continue;
    const m = re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    return { route, params };
  }
  return null;
}
