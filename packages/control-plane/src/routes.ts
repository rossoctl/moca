/**
 * The control plane's route table, declared once and read three times: by the router (src/server.ts),
 * by the authz enumeration test (spec §9.3 test 2), and by the OpenAPI drift test (test 3). The
 * failure mode designed against is authz scattered per-handler, where the fifth endpoint someone
 * adds forgets the ownership check (spec §5.4) -- so "is this session-scoped" is data here, not a
 * line inside a handler that a test cannot enumerate.
 */
/**
 * Which control plane serves a route (SBX0 spec §4.1). `harness` is the MOCA control plane;
 * `sandbox` is the sandbox service's (SH_ROUTE_PROFILE=sandbox). An ALLOW list per route: a route
 * that does not name a profile is not mounted there, so one added later is invisible to the
 * sandbox profile until someone deliberately lists it (route-profile.test.ts enumerates this).
 * `combined` (combined control plane spec §3.1) is both in one process: it mounts every route that
 * names `harness` or `sandbox`. A route lists only `harness` and `sandbox`, never `combined`.
 */
export type RouteProfile = 'harness' | 'sandbox' | 'combined';

/** Whether a route's allow list mounts it on `profile`: `combined` takes either list. */
export function mountsOn(profiles: readonly RouteProfile[], profile: RouteProfile): boolean {
  return profile === 'combined'
    ? profiles.includes('harness') || profiles.includes('sandbox')
    : profiles.includes(profile);
}

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI-style template. `{name}` segments become params. */
  path: string;
  /**
   * `none`     -- unauthenticated (probes, device flow).
   * `api`      -- Ed25519 token with scope `api` (plan gap #7).
   * `exchange` -- the shared SH_EXCHANGE_TOKEN bearer (spec §5.3.1).
   * `janitor`  -- the sandbox host janitor's SH_JANITOR_TOKEN bearer (SBX0 §8.3).
   * `egress`   -- one configured KVM host's egress token (SBX0.2b §4.2); names the host.
   * `host`     -- one template host agent's SH_HOST_TOKEN_<ID> (template lifecycle spec §6.1); names the host.
   */
  auth: 'none' | 'api' | 'exchange' | 'janitor' | 'egress' | 'host';
  /** The profiles that mount this route (see RouteProfile). */
  profiles: readonly RouteProfile[];
  /**
   * On the `sandbox` profile the route is mounted only when egress is configured
   * (`config.sandbox.egress` defined); otherwise it is unmounted like any unlisted route. Ignored on
   * the `harness` profile, which mounts the route as it always did.
   */
  requiresEgress?: boolean;
  /** A `/v1/sandboxes/{id}` route: its handler goes through assertSandboxOwner (SBX0 §5.1). */
  sandboxScoped?: boolean;
  /** Goes through assertOwner(params.id, principal) before the handler body runs. */
  sessionScoped: boolean;
  /** A query parameter that requires `roles` to include `admin` (spec §4.1). */
  adminOnlyQuery?: string;
  /**
   * Whether a POST/PUT/PATCH route needs a request body. Defaults to true (most do); a route whose
   * handler takes everything from the path param and the caller's own principal -- startDeviceAuth,
   * mintSessionToken -- sets this false so the router's generic empty-body guard doesn't 400 a
   * client that correctly sends nothing. Ignored for GET/DELETE, which never read a body.
   */
  bodyRequired?: boolean;
  /** Request body cap in bytes; absent means DEFAULT_MAX_BODY_BYTES. Raise it per route, never globally. */
  maxBodyBytes?: number;
  /**
   * This route accepts an `application/x-www-form-urlencoded` body (an HTML form a browser
   * submits). Off everywhere else: a JSON route that also parsed forms would be reachable by a
   * plain cross-origin <form> (a CORS "simple" request), for no gain.
   */
  formBody?: boolean;
  /** Stable key the router and the OpenAPI drift test both use to name the operation. */
  operationId: string;
  /**
   * Mounted only when this feature is on (see RouteFeatures). Absent means always mounted.
   * `requiresEgress` above is the same idea, kept separate because it applies per profile.
   */
  feature?: 'testUsers' | 'grants';
}

const BOTH: readonly RouteProfile[] = ['harness', 'sandbox'];
const HARNESS: readonly RouteProfile[] = ['harness'];
const SANDBOX: readonly RouteProfile[] = ['sandbox'];

export const ROUTES: readonly RouteSpec[] = [
  {
    method: 'GET',
    path: '/healthz',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'healthz',
  },
  {
    method: 'GET',
    path: '/readyz',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'readyz',
  },
  // §7's `async_quota_refusals`: the one async metric a worker cannot report, because §4.3 refuses
  // the submission here and nothing is ever enqueued. HARNESS only -- the sandbox profile runs no
  // turns, so the number is structurally zero there. Unversioned like the probes above: an operator
  // surface, not client API, and the same path the supervisor's admin port serves.
  //
  // `auth: 'api'` with an admin check inside the handler, NOT `auth: 'none'` like the probes: this
  // answers how often tenants hit their quota, on the public port. A small activity side channel,
  // but free to close. The check is in the handler because RouteSpec has no whole-route admin field
  // and one route does not justify adding one (`listSessions` gates its privileged branch the same
  // way); a second admin-only route is the moment to lift it into the router.
  {
    method: 'GET',
    path: '/metrics',
    auth: 'api',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'getMetrics',
  },
  // Public by design: a client asks it BEFORE logging in, to learn where the harness is.
  {
    method: 'GET',
    path: '/v1/discovery',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getDiscovery',
  },
  {
    method: 'POST',
    path: '/v1/auth/device',
    auth: 'none',
    sessionScoped: false,
    bodyRequired: false,
    profiles: BOTH,
    operationId: 'startDeviceAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/device/token',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'completeDeviceAuth',
  },
  // ADR-0045: a test-user login. `auth: 'none'` because the caller has no API token yet -- exactly
  // like the device-flow routes above. It is NOT unauthenticated: the handler requires the
  // SH_TEST_USER_SECRET, and 404s when SH_TEST_USERS is unset so the path is invisible by default.
  {
    method: 'POST',
    path: '/v1/auth/test-token',
    auth: 'none',
    sessionScoped: false,
    // Unmounted unless SH_TEST_USERS > 0, so the path is genuinely unrouted when the feature is
    // off -- not merely 404'd by the handler after the body has already been validated.
    feature: 'testUsers',
    // HARNESS, not BOTH: main.ts refuses to boot test users on the sandbox profile (it admits only
    // enrolled subjects, SBX0 §4.2), so the route is not mounted there at all. One fewer
    // place for the invariant to be broken later.
    profiles: HARNESS,
    operationId: 'testUserToken',
  },
  // The OIDC provider's browser redirect target (oidc.ts): the URL registered with the provider,
  // typically this control plane's own Route. Unauthenticated by design, like the device-flow
  // routes -- the `state` in the query is the capability, and it is single-use and TTL-bound.
  {
    method: 'GET',
    path: '/v1/auth/oidc/callback',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'oidcCallback',
  },
  // The confirmation form's submission: POST so the user code and the browser token stay out of
  // URLs, access logs and browser history. Same path, same handler logic, urlencoded body.
  {
    method: 'POST',
    path: '/v1/auth/oidc/callback',
    auth: 'none',
    sessionScoped: false,
    bodyRequired: false,
    formBody: true,
    profiles: BOTH,
    operationId: 'oidcCallbackSubmit',
  },
  // B14: the refresh token is the credential on the first two, so they take no API token.
  {
    method: 'POST',
    path: '/v1/auth/token',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'refreshAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/revoke',
    auth: 'none',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'revokeAuth',
  },
  {
    method: 'POST',
    path: '/v1/auth/revoke-all',
    auth: 'api',
    sessionScoped: false,
    bodyRequired: false,
    profiles: BOTH,
    operationId: 'revokeAllAuth',
  },
  {
    method: 'GET',
    path: '/v1/me',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getMe',
  },
  {
    method: 'GET',
    path: '/v1/models',
    auth: 'api',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'listModels',
  },
  {
    method: 'POST',
    path: '/v1/sessions',
    auth: 'api',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'createSession',
  },
  {
    method: 'GET',
    path: '/v1/sessions',
    auth: 'api',
    sessionScoped: false,
    adminOnlyQuery: 'owner',
    profiles: HARNESS,
    operationId: 'listSessions',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'getSession',
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/{id}',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'deleteSession',
  },
  {
    method: 'PATCH',
    path: '/v1/sessions/{id}',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'updateSession',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}/resources',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'getSessionResources',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}/models',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'listSessionModels',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{id}/token',
    auth: 'api',
    sessionScoped: true,
    bodyRequired: false,
    profiles: HARNESS,
    operationId: 'mintSessionToken',
  },
  // The async turn routes (async fan-out spec §4.1, §4.4, §4.5). No `bodyRequired: false` on the
  // POST -- the body IS the envelope, so the router's generic empty-body guard is correct here.
  {
    method: 'POST',
    path: '/v1/sessions/{id}/turns',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'submitTurn',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{id}/turns/{turnId}',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'getTurn',
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/{id}/turns/{turnId}',
    auth: 'api',
    sessionScoped: true,
    profiles: HARNESS,
    operationId: 'cancelTurn',
  },
  {
    method: 'GET',
    path: '/v1/credentials',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    requiresEgress: true,
    operationId: 'listCredentials',
  },
  {
    method: 'PUT',
    path: '/v1/credentials/{name}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    requiresEgress: true,
    operationId: 'putCredential',
  },
  {
    method: 'DELETE',
    path: '/v1/credentials/{name}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    requiresEgress: true,
    operationId: 'deleteCredential',
  },
  {
    method: 'POST',
    path: '/v1/egress/credential',
    auth: 'egress',
    sessionScoped: false,
    profiles: SANDBOX,
    requiresEgress: true,
    operationId: 'lookupEgressCredential',
  },
  {
    method: 'POST',
    path: '/v1/config-bundles',
    auth: 'api',
    sessionScoped: false,
    // Holds the base64 of a MAX_BUNDLE_BYTES tar (~10.7 MiB) plus the JSON wrapper.
    maxBodyBytes: 12 * 1024 * 1024,
    profiles: HARNESS,
    operationId: 'putConfigBundle',
  },
  {
    method: 'GET',
    path: '/v1/config-bundles',
    auth: 'api',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'listConfigBundles',
  },
  {
    method: 'DELETE',
    path: '/v1/config-bundles/{digest}',
    auth: 'api',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'deleteConfigBundle',
  },
  {
    method: 'POST',
    path: '/internal/credentials',
    auth: 'exchange',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'exchangeCredential',
  },
  /**
   * The DEQUEUE-time credential exchange (async fan-out spec §5.4). Beside `/internal/credentials`
   * and on the same shared bearer, because it is the same hop: the data plane asking the control
   * plane for the credential a turn spends. It differs in what it presents -- a turn id rather than a
   * session token -- because at dequeue there is no session token, and putting one in the queue is
   * what MI1 §6.5 forbids.
   */
  {
    method: 'POST',
    path: '/internal/turn-credentials',
    auth: 'exchange',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'exchangeTurnCredential',
  },
  /**
   * MI1 §6.2's grant lifecycle, on the same shared bearer as the two exchanges above because it is
   * the same hop. Unmounted unless `MOCA_GRANT_SIGNING_KEY` is set, so a deployment that has not
   * generated the grant ring 404s both paths rather than 500ing on a missing key -- and 404s them
   * BEFORE the body is parsed, which is the whole reason ADR-0045 puts the gate here.
   *
   * §6.2 says `/internal/turn-grants` "replaces `/internal/credentials`". It does not here: nothing
   * redeems a grant until the `moca-egress` inference listener exists (§8.6), so retiring the
   * credential exchange now would break every worker for no gain. Both stay; the replacement ships
   * with the redeemer.
   */
  {
    method: 'POST',
    path: '/internal/turn-grants',
    auth: 'exchange',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'issueTurnGrants',
    feature: 'grants',
  },
  {
    method: 'POST',
    path: '/internal/grants/refresh',
    auth: 'exchange',
    sessionScoped: false,
    profiles: HARNESS,
    operationId: 'refreshTurnGrants',
    feature: 'grants',
  },
  // Template lifecycle spec §4: the templates, one template, its builds, one build, its tags. On
  // BOTH profiles (§4.1), so a session's brain and a sandbox client read the same templates.
  {
    method: 'GET',
    path: '/v1/templates',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'listTemplates',
  },
  {
    method: 'GET',
    path: '/v1/templates/{id}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getTemplate',
  },
  {
    method: 'GET',
    path: '/v1/templates/{id}/builds',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'listTemplateBuilds',
  },
  {
    method: 'GET',
    path: '/v1/templates/{id}/builds/{build}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getTemplateBuild',
  },
  {
    method: 'GET',
    path: '/v1/templates/{id}/tags',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'listTemplateTags',
  },
  // Template lifecycle spec §4, §5.1, §8.1: self-serve create, a new build, cancel, the policy and
  // the caller's quota. On BOTH profiles (§4.1), as the reads.
  {
    method: 'POST',
    path: '/v1/templates',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    maxBodyBytes: 1024 * 1024,
    operationId: 'createTemplate',
  },
  {
    method: 'POST',
    path: '/v1/templates/{id}/builds',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    maxBodyBytes: 1024 * 1024,
    operationId: 'createTemplateBuild',
  },
  {
    method: 'POST',
    path: '/v1/templates/{id}/builds/{build}/cancel',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'cancelTemplateBuild',
  },
  // Template lifecycle spec §5.1-§5.2: the owner moves and removes tags and edits the template; an
  // admin transfers it. On BOTH profiles (§4.1), as the reads.
  {
    method: 'POST',
    path: '/v1/templates/{id}/tags',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'moveTemplateTags',
  },
  {
    method: 'DELETE',
    path: '/v1/templates/{id}/tags/{tag}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'removeTemplateTag',
  },
  {
    method: 'PATCH',
    path: '/v1/templates/{id}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'updateTemplate',
  },
  {
    method: 'PUT',
    path: '/v1/templates/{id}/owner',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'transferTemplateOwner',
  },
  // Template lifecycle spec §5.1: retire a whole template, or one build of it.
  {
    method: 'POST',
    path: '/v1/templates/{id}/retire',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'retireTemplate',
  },
  {
    method: 'DELETE',
    path: '/v1/templates/{id}/builds/{build}',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'retireTemplateBuild',
  },
  // Template lifecycle spec §6.3: take, renew or release the caller's activation lease.
  {
    method: 'POST',
    path: '/v1/templates/{id}/activate',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'activateTemplate',
  },
  {
    method: 'POST',
    path: '/v1/templates/{id}/deactivate',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    bodyRequired: false,
    operationId: 'deactivateTemplate',
  },
  {
    method: 'GET',
    path: '/v1/policy',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getPolicy',
  },
  {
    method: 'PUT',
    path: '/v1/policy',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'putPolicy',
  },
  {
    method: 'GET',
    path: '/v1/quota',
    auth: 'api',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'getQuota',
  },
  // Template lifecycle spec §6.1: a KVM host's sbx-host-agent, with its own bearer, for itself only.
  {
    method: 'POST',
    path: '/v1/hosts/{host}/inventory',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostInventory',
  },
  {
    method: 'POST',
    path: '/v1/hosts/{host}/builds/claim',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostClaimBuilds',
  },
  {
    method: 'GET',
    path: '/v1/hosts/{host}/blobs/{digest}',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostBlob',
  },
  {
    method: 'POST',
    path: '/v1/hosts/{host}/builds/{build}/log',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostBuildLog',
  },
  {
    method: 'POST',
    path: '/v1/hosts/{host}/builds/{build}/report',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    maxBodyBytes: 1024 * 1024,
    operationId: 'hostBuildReport',
  },
  // Template lifecycle spec §6.3: the host's wanted state, and its workers' starts and stops.
  {
    method: 'GET',
    path: '/v1/hosts/{host}/wanted',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostWanted',
  },
  {
    method: 'POST',
    path: '/v1/hosts/{host}/workers/report',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    operationId: 'hostWorkerReport',
  },
  // The egress proxy's audit events from the host's journal, into sandboxes' logs.
  {
    method: 'POST',
    path: '/v1/hosts/{host}/egress',
    auth: 'host',
    sessionScoped: false,
    profiles: BOTH,
    // 1000 events of at most 8 KiB each (the agent keeps longer ones back), with room for JSON.
    maxBodyBytes: 9 * 1024 * 1024,
    operationId: 'hostEgress',
  },
  // SBX0 §5.1: the sandbox resource, on the sandbox profile only (sandbox-handlers.ts).
  {
    method: 'POST',
    path: '/v1/sandboxes',
    auth: 'api',
    sessionScoped: false,
    profiles: SANDBOX,
    operationId: 'createSandbox',
  },
  {
    method: 'GET',
    path: '/v1/sandboxes',
    auth: 'api',
    sessionScoped: false,
    adminOnlyQuery: 'all',
    profiles: SANDBOX,
    operationId: 'listSandboxes',
  },
  {
    method: 'GET',
    path: '/v1/sandboxes/{id}',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    profiles: SANDBOX,
    operationId: 'getSandbox',
  },
  {
    method: 'DELETE',
    path: '/v1/sandboxes/{id}',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    profiles: SANDBOX,
    operationId: 'deleteSandbox',
  },
  {
    method: 'POST',
    path: '/v1/sandboxes/{id}/token',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    bodyRequired: false,
    profiles: SANDBOX,
    operationId: 'mintSandboxToken',
  },
  // A sandbox's egress log, for its owner or an admin, as GET /v1/sandboxes/{id}.
  {
    method: 'GET',
    path: '/v1/sandboxes/{id}/egress',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    profiles: SANDBOX,
    operationId: 'getSandboxEgress',
  },
  // Lease-mode spec §8.1-§8.2: the owner's user API token only; a sandbox token is refused by typ.
  {
    method: 'PUT',
    path: '/v1/sandboxes/{id}/mode',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    profiles: SANDBOX,
    operationId: 'setSandboxMode',
  },
  {
    method: 'POST',
    path: '/v1/sandboxes/{id}/mode-token',
    auth: 'api',
    sessionScoped: false,
    sandboxScoped: true,
    bodyRequired: false,
    profiles: SANDBOX,
    operationId: 'mintSandboxModeToken',
  },
  // The host janitor's read (SBX0 §8.3): what to keep and what to free, nothing else.
  {
    method: 'GET',
    path: '/v1/janitor/sandboxes',
    auth: 'janitor',
    sessionScoped: false,
    profiles: SANDBOX,
    operationId: 'janitorSandboxes',
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

/**
 * ADR-0045: routes that exist only when a feature is switched on. Unmounting here -- rather than
 * 404ing inside the handler -- is what makes the path truly indistinguishable from an unrouted one:
 * server.ts parses and validates the body BEFORE calling the handler, so a mounted route answers
 * `400 invalid_json` to an empty or malformed body and thereby reveals that it exists.
 */
export interface RouteFeatures {
  /** `config.sandbox.egress` is configured: mounts the credential routes on the sandbox profile. */
  egress?: boolean;
  /** SH_TEST_USERS > 0: mounts POST /v1/auth/test-token. */
  testUsers?: boolean;
  /** MOCA_GRANT_SIGNING_KEY is set: mounts the two MI1 §6.2 grant routes. */
  grants?: boolean;
}

export function matchRoute(
  method: string,
  url: string,
  profile: RouteProfile = 'harness',
  opts: RouteFeatures = {},
): { route: RouteSpec; params: Record<string, string> } | null {
  const pathname = url.split('?')[0] ?? '';
  for (const { route, re, names } of COMPILED) {
    if (route.method !== method || !mountsOn(route.profiles, profile)) continue;
    // Egress gates a route on `sandbox`; on `combined` only the sandbox-only one (the credential
    // routes stay mounted for its harness users, as on `harness`).
    const gated =
      profile === 'sandbox' || (profile === 'combined' && !route.profiles.includes('harness'));
    if (gated && route.requiresEgress && !opts.egress) continue;
    if (route.feature && !opts[route.feature]) continue;
    const m = re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    return { route, params };
  }
  return null;
}
