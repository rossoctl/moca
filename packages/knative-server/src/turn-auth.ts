import type { KeyObject } from 'node:crypto';
import { createClient } from 'redis';
import {
  CpError,
  OwnershipIndex,
  credentialValue,
  parseKeyset,
  verifyToken,
  type CpRedisLike,
  type ExchangeResponse,
} from '@moca/control-plane';
import type { TurnResult, UpstreamCredential } from '@moca/harness/run-turn';

/**
 * Caller authentication on the `/turn` path (MU1 spec §4.3, §4.3.1, §5.3).
 *
 * `POST /turn` enforces exactly ONE rule: token.sid === body.sessionId. It performs no ownership
 * lookup -- it holds no ownership data and should not.
 *
 * The subject is `token.sub`, never an inbound header. P5 reads `X-SH-Subject`, which is correct for a
 * trusted orchestrator but is exactly the spoofable-header pattern Z1 §3.2 warns about once arbitrary
 * users can call the API. So when a token is present the token wins, and a request carrying both a
 * token and a CONFLICTING header is rejected rather than resolved by precedence -- a silent winner
 * there is a cross-tenant bug waiting to be written (spec §3.5).
 */
export interface TurnAuth {
  subject: string;
  sessionId: string;
  credential: UpstreamCredential;
  /** Never undefined: an unresolvable endpoint is refused upstream, not defaulted (spec §6.2). */
  anthropicBaseUrl: string;
  /** The session's config bundle, from the control plane -- never from the request (ADR-0038). */
  configRef?: string;
  /** The session's sandbox tier from the exchange (P6.3); absent ⇒ the data plane's default. */
  sandboxTier?: string;
}

export interface TurnAuthDeps {
  keys: Map<string, KeyObject>;
  requireAuth: boolean;
  controlPlaneUrl?: string;
  exchangeToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  reportRuntime?: (sessionId: string, fields: Record<string, string>) => Promise<void>;
}

const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const bearer = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const raw = header(headers, 'authorization');
  if (!raw) return undefined;
  const [scheme, ...rest] = raw.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : undefined;
};

/**
 * Parse the published keyset, converting an operator error into a TYPED refusal.
 *
 * `parseKeyset` throws a plain `Error` whose text names the offending entry. This function is reached
 * per request, and its caller's failure path returns the message to an arbitrary caller -- so the raw
 * throw would both disclose internal error text and, because it happens before anything reads
 * `requireAuth`, break the unauthenticated path that MU1's opt-in design promises to leave alone.
 *
 * `assertKeysetUsable` runs this at boot on this tier, so in practice a bad keyset is a crashloop with
 * the real reason in the container log. This conversion covers the remaining case the per-request read
 * exists for: the env changing under a pod that is already serving. Fail closed, with a code.
 */
function keysFromEnv(raw: string | undefined): Map<string, KeyObject> {
  try {
    return parseKeyset(raw);
  } catch {
    throw new CpError('credential_unavailable', 'the token keyset is not usable');
  }
}

/**
 * Boot-time keyset check. Call before serving: `parseKeyset`'s own message names the bad entry, and a
 * crashloop naming it beats a Ready pod that refuses every turn.
 *
 * This is what makes `token.ts`'s "parseKeyset runs at startup on both tiers" -- the stated rationale
 * for asserting the curve at parse time -- true on the data plane. `/healthz` and `/readyz` never
 * touch the keyset, so without this there is no boot-time signal at all.
 */
export function assertKeysetUsable(env: NodeJS.ProcessEnv): void {
  parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
}

export function turnAuthDepsFromEnv(env: NodeJS.ProcessEnv): TurnAuthDeps {
  return {
    // Empty when nothing is published, so a deployment that has never heard of MU1 -- i.e. every
    // existing one -- still boots. A MALFORMED keyset is an operator error: it throws, as a typed
    // CpError so the refusal carries a code instead of a stringified Error (see keysFromEnv).
    keys: keysFromEnv(env.SH_SESSION_TOKEN_PUBLIC_KEYS),
    // Exactly 'true'. Defaults false because 14 deploy/knative scripts call /turn with no auth today
    // (spec §4.3.1); flipping the default is MU2.
    requireAuth: env.SH_REQUIRE_AUTH === 'true',
    controlPlaneUrl: env.SH_CONTROL_PLANE_URL || undefined,
    // A systemd credential on deploy/vm (LoadCredential=, MI1 §6.7), the env var everywhere else.
    exchangeToken: credentialValue(env, 'SH_EXCHANGE_TOKEN'),
    // Shared, NOT `makeRuntimeReporter(...)` -- see sharedRuntimeReporter for why a fresh
    // closure per request would leak one Redis connection per turn.
    reportRuntime: sharedRuntimeReporter(env.REDIS_URL),
  };
}

/**
 * Codes the control plane may legitimately return that this tier passes through unchanged.
 *
 * THE INVARIANT: every member is attributable to the CALLER, so its status blames the right party and
 * the caller can act on it. `credential_*` is the subject's credential state, `endpoint_unresolved`
 * their credential's endpoint, `session_not_found` their session, `token_*` their token. The weaker
 * test -- "the control plane can return this code" -- is not sufficient, and admitting a code on that
 * basis is how `unauthorized` got in: on `/internal/credentials` it comes only from
 * `checkExchangeAuth`'s shared bearer or `handlers.ts`'s defensive re-check, so it means the HARNESS
 * cannot authenticate to its own control plane. Reported as 401 that read as "your token is bad", so
 * users re-ran the device flow against an outage while 5xx alerting stayed quiet. It now falls through
 * to `credential_unavailable`, alongside the three neighbouring control-plane faults (unreachable,
 * non-JSON body, unknown mode), with the status preserved in the message for the log.
 *
 * EXPORTED so its covering test can iterate it rather than restate it. A typo in one member would make
 * that code fall through to `credential_unavailable` at best, and -- if a mistyped code ever reached
 * `statusFor` -- `res.writeHead(undefined)` throws inside the error path and the caller gets a 500
 * with a stringified error instead of the intended refusal. turn-auth.test.ts asserts every member is
 * in CP_ERROR_CODES, which is what makes a typo unshippable.
 */
export const PASSTHROUGH = new Set([
  'credential_required',
  'credential_ambiguous',
  'credential_not_found',
  'endpoint_unresolved',
  'session_not_found',
  'token_invalid',
  'token_expired',
]);

async function exchange(token: string, deps: TurnAuthDeps): Promise<ExchangeResponse> {
  if (!deps.controlPlaneUrl) {
    throw new CpError('credential_unavailable', 'no control plane configured');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: { status: number; text(): Promise<string> };
  try {
    res = (await fetchImpl(`${deps.controlPlaneUrl}/internal/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(deps.exchangeToken ? { Authorization: `Bearer ${deps.exchangeToken}` } : {}),
      },
      body: JSON.stringify({ token }),
    })) as unknown as { status: number; text(): Promise<string> };
  } catch {
    // Control plane unreachable => THE TURN FAILS. It does not fall back to the environment. This is
    // the single most important behaviour in the design (spec §9.2).
    throw new CpError('credential_unavailable', 'control plane unreachable');
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CpError('credential_unavailable', 'control plane returned a non-JSON body');
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  if (res.status !== 200) {
    const code = typeof body.error === 'string' ? body.error : '';
    if (PASSTHROUGH.has(code)) {
      throw new CpError(code as never, typeof body.message === 'string' ? body.message : undefined);
    }
    throw new CpError('credential_unavailable', `control plane returned ${res.status}`);
  }
  // An UNKNOWN mode must not default to `direct`: that would send a placeholder upstream as though it
  // were a real credential, which is the failure the tag exists to prevent (spec §3.6).
  if (body.mode !== 'direct' && body.mode !== 'placeholder') {
    throw new CpError(
      'credential_unavailable',
      'control plane returned an unknown credential mode',
    );
  }
  if (typeof body.anthropicAuthToken !== 'string' || body.anthropicAuthToken.length === 0) {
    throw new CpError('credential_unavailable', 'control plane returned no credential');
  }
  if (typeof body.anthropicBaseUrl !== 'string' || body.anthropicBaseUrl.length === 0) {
    // Passing undefined into TurnConfig would let run-turn.ts:313's `||` fall through to the
    // environment and send this subject's gateway token to the wrong endpoint (spec §6.2).
    throw new CpError('endpoint_unresolved', 'control plane returned no gateway endpoint');
  }
  // Absent means Authorization: Bearer (a pre-#368 control plane). An unknown value must not default
  // to either header: guessing wrong sends the secret where its binding never said (#368).
  if (
    body.authHeader !== undefined &&
    body.authHeader !== 'authorization' &&
    body.authHeader !== 'x-api-key'
  ) {
    throw new CpError(
      'credential_unavailable',
      'control plane returned an unknown credential header',
    );
  }
  // A present configRef that is not a digest would be dropped and the turn run without its bundle.
  if (
    body.configRef !== undefined &&
    (typeof body.configRef !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body.configRef))
  ) {
    throw new CpError('credential_unavailable', 'control plane returned a malformed configRef');
  }
  return body as unknown as ExchangeResponse;
}

/**
 * Returns `null` for "unauthenticated, and that is allowed here" -- the caller then behaves exactly as
 * today. Every other outcome is either a TurnAuth or a thrown CpError; there is no path that
 * downgrades a bad token to ambient behaviour.
 */
export async function resolveTurnAuth(
  headers: Record<string, string | string[] | undefined>,
  body: { sessionId?: string },
  deps: TurnAuthDeps,
): Promise<TurnAuth | null> {
  const presented = bearer(headers);
  if (!presented) {
    if (deps.requireAuth) throw new CpError('token_required', 'this deployment requires a token');
    // The operator-driven and leaf paths keep P5's inbound-header behaviour; not user-facing (§3.5).
    return null;
  }

  // A present-but-bad token fails in EITHER mode. requiredScope keeps an api token, and the shared
  // exchange bearer, from driving a turn.
  const claims = verifyToken(presented, deps.keys, {
    now: Math.floor((deps.now?.() ?? Date.now()) / 1000),
    requiredScope: 'turn:write',
  });
  if (!claims.sid) throw new CpError('token_invalid', 'token names no session');

  // The one rule this route enforces (spec §4.3).
  if (body.sessionId !== undefined && body.sessionId !== claims.sid) {
    throw new CpError('session_mismatch', 'token does not name this session', body.sessionId);
  }

  const asserted = header(headers, 'x-sh-subject');
  if (asserted !== undefined && asserted !== claims.sub) {
    throw new CpError('subject_conflict', 'X-SH-Subject conflicts with the token subject');
  }

  const resolved = await exchange(presented, deps);
  return {
    subject: claims.sub,
    sessionId: claims.sid,
    credential: {
      mode: resolved.mode,
      value: resolved.anthropicAuthToken,
      ...(resolved.authHeader === 'x-api-key' ? { header: resolved.authHeader } : {}),
    },
    anthropicBaseUrl: resolved.anthropicBaseUrl,
    ...(resolved.configRef ? { configRef: resolved.configRef } : {}),
    // Only a non-empty string is trusted; anything else is "no tier", never an odd value in a filter.
    ...(typeof resolved.sandboxTier === 'string' && resolved.sandboxTier
      ? { sandboxTier: resolved.sandboxTier }
      : {}),
  };
}

/**
 * Authorization for READING a run (MI1 §5 R7): the same token rules as a turn — required under
 * SH_REQUIRE_AUTH, and a present-but-bad token refused in either mode — but no credential exchange,
 * since a status read spends nothing upstream. A valid token for another session is refused.
 *
 * Returns whether the caller authenticated: `true` when a token was presented and verified, `false`
 * when none was presented and none was required. The caller uses this to refuse a caller-supplied
 * `tenant` on an authenticated read — that decision does not belong here, because this function's
 * job is `sessionId` authorization, not key-derivation shape.
 */
export function authorizeRunRead(
  headers: Record<string, string | string[] | undefined>,
  sessionId: string,
  deps: TurnAuthDeps,
): boolean {
  const presented = bearer(headers);
  if (!presented) {
    if (deps.requireAuth) throw new CpError('token_required', 'this deployment requires a token');
    return false;
  }
  const claims = verifyToken(presented, deps.keys, {
    now: Math.floor((deps.now?.() ?? Date.now()) / 1000),
    requiredScope: 'turn:write',
  });
  if (claims.sid !== sessionId) {
    throw new CpError('session_mismatch', 'token does not name this session', sessionId);
  }
  return true;
}

/**
 * Authentication for the `/workloads` routes, which name no session. They take the user's
 * control-plane API token (scope `api`), not a session token: one workload can serve many sessions.
 * A token is required even when SH_REQUIRE_AUTH is off, because every workload has an owner.
 *
 * Returns the token's subject.
 */
export function authenticateApiCaller(
  headers: Record<string, string | string[] | undefined>,
  deps: TurnAuthDeps,
): string {
  const presented = bearer(headers);
  if (!presented) throw new CpError('token_required', 'workloads require an API token');
  return verifyToken(presented, deps.keys, {
    now: Math.floor((deps.now?.() ?? Date.now()) / 1000),
    requiredScope: 'api',
  }).sub;
}

/**
 * What the harness self-reports for /resources (spec §7.4, plan gap #5). Everything here is already in
 * this process's environment, so nothing in run-turn.ts has to change to produce it.
 */
export function runtimeFieldsForTurn(
  env: NodeJS.ProcessEnv,
  phase: 'start' | 'end',
  sandbox?: TurnResult['sandbox'],
): Record<string, string> {
  const now = String(Date.now());
  const fields: Record<string, string> = {};
  if (env.HOSTNAME) fields.harnessPod = env.HOSTNAME;
  if (env.K_REVISION) fields.revision = env.K_REVISION;
  if (env.KAGENTI_SANDBOX_POD) fields.sandboxPod = env.KAGENTI_SANDBOX_POD;
  else if (env.KAGENTI_SANDBOX_POOL_SELECTOR)
    fields.sandboxSelector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  if (phase === 'start') fields.turnStartedAt = now;
  else {
    fields.turnEndedAt = now;
    fields.lastTurnAt = now;
  }
  // P6.3 spec §6: where the turn actually ran, known only once it has (hence 'end', from the result).
  if (sandbox) {
    fields.sandboxId = sandbox.id;
    // Written even as '' (no tiers declared), unlike the fields above: the runtime hash write
    // merges, so leaving it out would keep a previous turn's tier beside this turn's sandboxId.
    // The resources view shows '' as null.
    fields.sandboxTier = sandbox.tier;
    if (sandbox.workspaceReset) {
      fields.workspaceResetAt = now;
      fields.workspaceResetFrom = sandbox.workspaceReset.from;
    }
  }
  return fields;
}

/**
 * One reporter per Redis URL, for the whole process.
 *
 * `turnAuthDepsFromEnv` is called PER REQUEST (so an env change takes effect without a restart), and
 * `makeRuntimeReporter` memoises its client inside the closure it returns -- so building a fresh
 * closure per request would open a new Redis connection on every authenticated turn and never close
 * any of them. Caching by URL keeps the per-request env read while bounding connections to one.
 */
const runtimeReporters = new Map<
  string,
  (sessionId: string, fields: Record<string, string>) => Promise<void>
>();

export function sharedRuntimeReporter(
  redisUrl: string | undefined,
): (sessionId: string, fields: Record<string, string>) => Promise<void> {
  const key = redisUrl ?? '';
  let reporter = runtimeReporters.get(key);
  if (!reporter) {
    reporter = makeRuntimeReporter(redisUrl);
    runtimeReporters.set(key, reporter);
  }
  return reporter;
}

/**
 * Best-effort writer for the runtime hash. Lazily connects, swallows every failure, and never blocks a
 * turn: this data is display-only, so losing it must cost nothing. A rejected promise here would
 * otherwise become an unhandled rejection in the middle of a stream.
 */
export function makeRuntimeReporter(
  redisUrl: string | undefined,
  // A seam for tests, as in RedisRecordStore: lets a refused connect give up in milliseconds.
  maxReconnectAttempts = 10,
): (sessionId: string, fields: Record<string, string>) => Promise<void> {
  if (!redisUrl) return async () => undefined;
  // HOISTED out of the `if (!ready)` block so the catch can close what it discards. Block-scoped, the
  // discarded client had no remaining reference and nobody closed it.
  let client: ReturnType<typeof createClient> | undefined;
  let index: OwnershipIndex | undefined;
  let ready: Promise<void> | undefined;
  return async (sessionId, fields) => {
    try {
      if (!ready) {
        // The 'error' listener and the bounded reconnect travel together (#423, Task 16b; the full
        // rationale is on `resilientClientOptions` in @moca/session-backend, which this package does
        // not depend on). Without the listener, node-redis re-emitting a dropped socket as 'error' is
        // an uncaught exception: every worker that had served a turn crashed on a Redis restart, and
        // took its in-flight turns with it. With the listener but the default unbounded strategy, a
        // refused connect() would never settle, so the catch below could never re-arm. Past the
        // bound the client gives up for good; its next command rejects ClientClosedError, which
        // lands in the same catch and rebuilds it.
        client = createClient({
          url: redisUrl,
          socket: {
            reconnectStrategy: (retries: number) =>
              retries > maxReconnectAttempts
                ? new Error(`runtime reporter: redis unreachable after ${retries} attempts`)
                : Math.min(retries * 100, 1000),
          },
        });
        // Display-only data: log one line and carry on. The message only, never the error object or
        // the URL (node-redis socket errors name host:port, not userinfo; the give-up error above
        // names neither).
        client.on('error', (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[redis] runtime reporter: ${message} (display-only; will retry)`);
        });
        // Captured, because `client` is now mutable and the catch may have cleared it by the time a
        // slow connect() resolves -- in which case `index` would silently never be built.
        const c = client;
        ready = c.connect().then(() => {
          index = new OwnershipIndex(c as unknown as CpRedisLike);
        });
      }
      await ready;
      await index?.putRuntime(sessionId, fields);
    } catch {
      // A transient failure (e.g. a Redis restart mid-rollout) must not permanently disable this
      // reporter for the rest of the process's life: clear the memoised state so the NEXT call
      // retries from scratch, rather than forever awaiting an already-rejected `ready` (fix round 1,
      // Important 2). Display-only data, so the turn itself must never fail because this did.
      const orphan = client;
      client = undefined;
      ready = undefined;
      index = undefined;
      // Close it, or a flapping Redis accumulates one connected, still-reconnecting client per
      // failure, each retrying on its own timer. destroy() rather than the deprecated quit(), and
      // rather than close() which waits for pending commands against a server that may be gone.
      // It throws on a client that never opened, and that must neither fail the turn nor -- since the
      // clearing above already happened -- be able to skip the retry.
      try {
        orphan?.destroy();
      } catch {
        // Nothing to do: the reference is dropped either way.
      }
    }
  };
}
