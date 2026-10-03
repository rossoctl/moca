import { CpError } from './errors.js';
import {
  resolveInferenceName,
  parseCredentialBody,
  validateCredentialName,
  type CredentialStore,
  type InferenceAuthHeader,
} from './credential-store.js';
import { exchangeCredential, OPERATOR_FALLBACK_NAME } from './exchange.js';
import type { RunKubectl } from './kubectl.js';
import { DEFAULT_PAGE_SIZE, type OwnershipIndex, type SessionRecord } from './ownership.js';
import type { IdentityProvider } from './identity.js';
import type { KeyObject } from 'node:crypto';
import type { MintInput, TokenClaims } from './token.js';
import { projectResources, resolveSandbox } from './resources.js';

export interface CpConfig {
  apiTokenTtlSeconds: number;
  sessionTokenTtlSeconds: number;
  /** The shared bearer the data plane presents to /internal/credentials (spec §5.3.1). */
  exchangeToken?: string;
  /** Deployment-level gateway origin, used when a credential carries no `endpoint` (spec §6.2). */
  defaultInferenceEndpoint?: string;
  /** The operator's own key, resolved at EXCHANGE time behind allowOperatorFallback (spec §6.4). */
  operatorInferenceToken?: string;
  /**
   * The header the operator's token travels in, in direct mode (#368): `authorization` (Bearer, a
   * gateway token) or `x-api-key` (a raw Anthropic key). Absent means `authorization`.
   */
  operatorInferenceHeader?: InferenceAuthHeader;
  allowOperatorFallback: boolean;
  /** Placeholder mode wins whenever the deployment has an injector (spec §3.6). */
  injectorConfigured: boolean;
  sandboxNamespace: string;
  /**
   * The harness base URL as a CLIENT reaches it, advertised by GET /v1/discovery so a client needs
   * only this control plane's URL. Unset means the deployment advertises none.
   */
  publicHarnessUrl?: string;
}

export interface CpDeps {
  index: OwnershipIndex;
  credentials: CredentialStore;
  identity: IdentityProvider;
  signer: { kid: string; mint(input: MintInput): string };
  /**
   * The public halves used to VERIFY a presented token at the exchange (Task 12). Normally just the
   * signer's own public key; a list during a rotation window.
   */
  verifyKeys: Map<string, KeyObject>;
  config: CpConfig;
  /** Epoch MILLISECONDS. Injectable so no test depends on the wall clock. */
  now(): number;
  /** randomUUID by default. A control-plane-minted id is always its own leafSessionId (gap #10). */
  newId(): string;
  runKubectl?: RunKubectl;
  /**
   * Whether the Redis client is connected and ready (main.ts: `client.isReady`). A command issued
   * while it is not ready waits in node-redis's offline queue for as long as the outage lasts, so
   * readyz consults this first rather than awaiting a probe that cannot fail (#423, spike F2).
   * Absent means "do not know", and readyz falls back to asking the index.
   */
  redisReady?: () => boolean;
  /** Release the Redis client. A test that builds deps through depsFromEnv must call it. */
  close?: () => Promise<void>;
}

export interface RequestCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Set by the router for `auth: 'api'` routes. */
  principal?: TokenClaims;
  /** Set by the router for `auth: 'exchange'` routes. */
  exchangeAuthorized?: boolean;
}

export type Handler = (ctx: RequestCtx, deps: CpDeps) => Promise<{ status: number; body: unknown }>;

export function requirePrincipal(ctx: RequestCtx): TokenClaims {
  if (!ctx.principal) throw new CpError('token_required', 'this route requires a token');
  return ctx.principal;
}

/**
 * The single ownership choke point (spec §5.4). Every session-scoped handler goes through it, and
 * Task 13's enumeration test proves that claim rather than trusting it.
 *
 * A non-owner gets 404, NOT 403: a 403 is an existence oracle. Session ids are unguessable UUIDs so
 * the leak is small, but 404 is the standard answer and the one we would otherwise have to change
 * later (spec §8.1). An unknown session and someone else's session are therefore indistinguishable.
 *
 * `admin` deliberately does NOT bypass this. The role gates `?owner=` on the LIST route only; the
 * privilege to read another user's session body is a separate one MU1 does not grant, and folding it
 * in here would make every later authz rule ambiguous.
 */
export async function assertOwner(
  sessionId: string,
  principal: TokenClaims | undefined,
  deps: CpDeps,
): Promise<SessionRecord> {
  if (!principal) throw new CpError('token_required', 'this route requires a token');
  const rec = await deps.index.get(sessionId);
  if (!rec || rec.owner !== principal.sub) {
    throw new CpError('session_not_found', undefined, sessionId);
  }
  return rec;
}

const asRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

/** A query integer must be rejected, not coerced: `parseInt('abc')` is NaN and pages by nothing. */
function intQuery(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CpError('invalid_request', `${name} must be a number`);
  return n;
}

const seconds = (deps: CpDeps): number => Math.floor(deps.now() / 1000);

async function turnInFlight(sessionId: string, deps: CpDeps): Promise<boolean> {
  const runtime = await deps.index.getRuntime(sessionId);
  const started = Number(runtime.turnStartedAt ?? 0);
  const ended = Number(runtime.turnEndedAt ?? 0);
  return started > 0 && started > ended;
}

/**
 * Audit a CREDENTIAL route without letting the audit's own failure change the caller's status.
 *
 * Spec §9.2 promises "Redis down => session routes 503, while /v1/credentials stays up, because §7.1
 * put them in different stores". The credential store is Kubernetes Secrets and knows nothing about
 * Redis -- but `index.audit()` is a Redis write, and `OwnershipIndex.guard` turns any transport
 * failure into `redis_unavailable` (503). Awaiting it after a successful Secret patch therefore
 * reported 503 for a write that HAD happened: the status lied, and a user could not repair their
 * credential during a Redis outage. Availability of the repair path is worth more than the audit
 * record, so the audit is what gives way.
 *
 * Deliberately NOT applied to `audit` globally, and never to the session routes: their 503 is correct
 * and spec-mandated, because those routes' own state lives in the very Redis that is down.
 *
 * The swallow is loud. An audit gap must be discoverable, so it logs the route and the credential
 * NAME -- never the value, which this function is never given in the first place.
 */
async function auditBestEffort(
  deps: CpDeps,
  route: string,
  name: string,
  entry: Parameters<OwnershipIndex['audit']>[0],
): Promise<void> {
  try {
    await deps.index.audit(entry);
  } catch (err) {
    console.error(
      `[control-plane] audit write failed for ${route} credential=${name}: ` +
        `${(err as Error).message} -- the credential write itself SUCCEEDED`,
    );
  }
}

/** Public view of a session record. `turns` comes from the display-only runtime hash. */
async function sessionView(rec: SessionRecord, deps: CpDeps) {
  const runtime = await deps.index.getRuntime(rec.sessionId);
  return {
    sessionId: rec.sessionId,
    owner: rec.owner,
    tenant: rec.tenant,
    createdAt: rec.createdAt,
    state: rec.state,
    lastTurnAt: runtime.lastTurnAt ? Number(runtime.lastTurnAt) : null,
    turns: runtime.turns ? Number(runtime.turns) : 0,
  };
}

export const HANDLERS: Record<string, Handler> = {
  healthz: async () => ({ status: 200, body: 'ok' }),

  // `null`, not a 404, when unset: the client can tell "this deployment advertises no harness" from
  // "this control plane predates discovery" and name the right fix for each.
  getDiscovery: async (_ctx, deps) => ({
    status: 200,
    body: { harnessUrl: deps.config.publicHarnessUrl ?? null },
  }),

  startDeviceAuth: async (_ctx, deps) => ({
    status: 200,
    body: await deps.identity.startDeviceAuth(),
  }),

  completeDeviceAuth: async (ctx, deps) => {
    const deviceCode = asRecord(ctx.body).deviceCode;
    if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
      throw new CpError('invalid_request', 'deviceCode is required');
    }
    // A pending authorization propagates as authorization_pending (428) -- the client polls.
    const principal = await deps.identity.completeDeviceAuth(deviceCode);
    const iat = seconds(deps);
    return {
      status: 200,
      body: {
        token: deps.signer.mint({
          sub: principal.subject,
          tenant: principal.subject, // one subject is one tenant in MU1 (spec §11.2)
          roles: principal.roles,
          scope: ['api'],
          ttlSeconds: deps.config.apiTokenTtlSeconds,
          now: iat,
        }),
        subject: principal.subject,
        displayName: principal.displayName,
        roles: principal.roles,
        expiresAt: iat + deps.config.apiTokenTtlSeconds,
      },
    };
  },

  getMe: async (ctx) => {
    const p = requirePrincipal(ctx);
    return { status: 200, body: { subject: p.sub, tenant: p.tenant, roles: p.roles ?? [] } };
  },

  createSession: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const body = asRecord(ctx.body);
    const requested = asRecord(body.credentials).inference;
    if (requested !== undefined && typeof requested !== 'string') {
      throw new CpError('invalid_request', 'credentials.inference must be a string');
    }
    // Resolved HERE, at creation, and recorded -- so a missing key fails now rather than three turns
    // in, and a credential added later cannot turn a running session ambiguous (spec §6.4, gap #4).
    // This is also the first of the two policy points that make MU1 fail closed before P5's sentinel
    // exists (spec §3.5): the deployment's own ANTHROPIC_AUTH_TOKEN is not consulted, so a
    // credential-less subject gets a session only through the operator fallback below.
    const descriptors = await deps.credentials.list(p.sub);
    // The operator fallback (spec §6.4) is for a subject with no inference credential of its own: such
    // a session records NO credential name, and the exchange resolves the operator's key per turn,
    // attributably. A session that names a credential never falls back, here or at exchange: a typo
    // must 400, and a credential deleted mid-session ends its turns (exchange.ts).
    const fallback =
      requested === undefined &&
      deps.config.allowOperatorFallback &&
      !!deps.config.operatorInferenceToken &&
      !descriptors.some((d) => d.consumer === 'inference');
    const credentialName = fallback ? '' : resolveInferenceName(descriptors, requested);

    const sessionId = deps.newId();
    const rec: SessionRecord = {
      sessionId,
      owner: p.sub,
      tenant: p.tenant ?? p.sub,
      createdAt: deps.now(),
      state: 'active',
      poolSelector: null, // MU2's tenant-labelled partition fills this (spec §8.2)
      credentialName,
      tombstone: false,
    };
    await deps.index.create(rec);
    await deps.index.audit({
      subject: p.sub,
      sessionId,
      credential: credentialName || OPERATOR_FALLBACK_NAME,
      decision: 'session_created',
    });
    const iat = seconds(deps);
    return {
      status: 201,
      body: {
        sessionId,
        token: deps.signer.mint({
          sub: p.sub,
          tenant: rec.tenant,
          roles: p.roles ?? [],
          scope: ['turn:write'],
          ttlSeconds: deps.config.sessionTokenTtlSeconds,
          sid: sessionId,
          now: iat,
        }),
        expiresAt: iat + deps.config.sessionTokenTtlSeconds,
      },
    };
  },

  listSessions: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const requestedOwner = ctx.query.get('owner');
    let owner = p.sub;
    if (requestedOwner !== null && requestedOwner !== p.sub) {
      // 403, not 404: "authenticated but insufficiently privileged on a resource you may know
      // exists" is exactly what 403 is reserved for (spec §8.1).
      if (!(p.roles ?? []).includes('admin')) {
        throw new CpError('forbidden', '?owner= requires the admin role');
      }
      owner = requestedOwner;
    }
    const page = await deps.index.listByOwner(owner, {
      limit: intQuery(ctx.query, 'limit') ?? DEFAULT_PAGE_SIZE,
      cursor: intQuery(ctx.query, 'cursor'),
    });
    return {
      status: 200,
      body: {
        sessions: await Promise.all(page.sessions.map((rec) => sessionView(rec, deps))),
        nextCursor: page.nextCursor,
      },
    };
  },

  getSession: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    return { status: 200, body: await sessionView(rec, deps) };
  },

  mintSessionToken: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    // A tombstoned session must not be handed a fresh capability: the exchange would refuse it
    // anyway, but issuing one invites a client to retry a turn that can never run.
    if (rec.tombstone) throw new CpError('session_not_found', undefined, rec.sessionId);
    const iat = seconds(deps);
    return {
      status: 200,
      body: {
        token: deps.signer.mint({
          sub: rec.owner,
          tenant: rec.tenant,
          roles: ctx.principal!.roles ?? [],
          scope: ['turn:write'],
          ttlSeconds: deps.config.sessionTokenTtlSeconds,
          sid: rec.sessionId,
          now: iat,
        }),
        expiresAt: iat + deps.config.sessionTokenTtlSeconds,
      },
    };
  },

  deleteSession: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const inFlight = await turnInFlight(rec.sessionId, deps);
    await deps.index.cascadeDelete(rec);
    await deps.index.audit({
      subject: rec.owner,
      sessionId: rec.sessionId,
      decision: inFlight ? 'session_deleted_in_flight' : 'session_deleted',
    });
    // 202 rather than pretending a synchronous delete happened; a sweeper reaps what the in-flight
    // turn writes on its way out (spec §7.3).
    return { status: inFlight ? 202 : 204, body: undefined };
  },

  /**
   * Write-only. There is deliberately no read-back path anywhere in /v1 (spec §4.2): the value goes
   * in and is never returned, so a compromised api token cannot exfiltrate a stored provider key.
   * The subject comes from the TOKEN, never from the path or the body -- the principal is never in a
   * path (spec §4.1), which is what stops the URL and the token being two sources of truth for one
   * fact.
   */
  putCredential: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const name = validateCredentialName(ctx.params.name ?? '');
    if (name === OPERATOR_FALLBACK_NAME) {
      // The audit names the operator's key this way (exchange.ts, createSession): a subject's own
      // credential under the same name would make the two indistinguishable in the audit.
      throw new CpError('invalid_request', `credential name '${name}' is reserved`);
    }
    const cred = parseCredentialBody(name, ctx.body);
    await deps.credentials.put(p.sub, cred);
    await auditBestEffort(deps, 'putCredential', name, {
      subject: p.sub,
      credential: name,
      decision: 'credential_written',
    });
    return { status: 204, body: undefined };
  },

  /** Metadata only, and it decrypts nothing: the descriptor lives in annotations (spec §6.2). */
  listCredentials: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    // No ?owner= is read here. Listing another user's credential NAMES is not a privilege MU1
    // grants, and not reading the parameter is what stops it becoming one by accident.
    const descriptors = await deps.credentials.list(p.sub);
    return {
      status: 200,
      body: {
        credentials: descriptors.map((d) => ({
          name: d.name,
          kind: d.kind,
          consumer: d.consumer,
          destination: d.destination,
          binding: d.binding,
          endpoint: d.endpoint,
        })),
      },
    };
  },

  deleteCredential: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const name = validateCredentialName(ctx.params.name ?? '');
    await deps.credentials.delete(p.sub, name);
    await auditBestEffort(deps, 'deleteCredential', name, {
      subject: p.sub,
      credential: name,
      decision: 'credential_deleted',
    });
    // 204 whether or not it existed: a 404 here would be an existence oracle over credential names.
    return { status: 204, body: undefined };
  },

  getSessionResources: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const runtime = await deps.index.getRuntime(rec.sessionId);
    const sandbox = await resolveSandbox(
      runtime,
      deps.config.sandboxNamespace,
      deps.runKubectl,
      rec.tenant,
    );
    return { status: 200, body: projectResources(rec, runtime, sandbox) };
  },

  exchangeCredential: async (ctx, deps) => {
    // The router performs the shared-bearer check (it is the only layer that sees headers) and marks
    // the request. A handler reached without that mark is a routing bug, and 401 is the safe answer.
    if (!ctx.exchangeAuthorized) {
      throw new CpError('unauthorized', 'exchange authentication failed');
    }
    const token = asRecord(ctx.body).token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new CpError('invalid_request', 'token is required');
    }
    return { status: 200, body: await exchangeCredential(token, deps) };
  },

  /**
   * Readiness is "can I serve session routes", i.e. is Redis answering. Credentials live in
   * Kubernetes Secrets, so they stay up while Redis is down (spec §7.1, §9.2) -- which is why this
   * probe checks only the index. A client that is not ready fails at once: awaiting the index then
   * would park the probe in the offline queue until Redis came back, a timeout rather than a 503.
   */
  readyz: async (_ctx, deps) => {
    if (deps.redisReady?.() === false) {
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
    try {
      await deps.index.get('__readyz__');
    } catch {
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
    return { status: 200, body: 'ok' };
  },
};
