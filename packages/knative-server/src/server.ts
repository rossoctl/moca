import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runTurn, executeTurn, type TurnConfig, type TurnResult } from '@moca/harness/run-turn';
import { terminalFrame, type TurnStreamFrame } from '@moca/harness/turn-stream';
import {
  runLeaf,
  leafSessionId,
  validateItem,
  type LeafEnvelope,
  type LeafResult,
} from '@moca/harness/run-leaf';
import { RedisWorkQueue } from '@moca/work-queue';
import {
  RedisResultStore,
  toResultRecord,
  writeResult,
  readResult,
} from '@moca/harness/leaf-result-store';
import { CpError, statusFor } from '@moca/control-plane';
import {
  authorizeRunRead,
  resolveTurnAuth,
  runtimeFieldsForTurn,
  turnAuthDepsFromEnv,
  type TurnAuth,
  type TurnAuthDeps,
} from './turn-auth.js';
import { prepareServerProcess } from './server-process.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no', // belt-and-suspenders for any nginx fronting Kourier (Envoy ignores it)
};
const RESULT_TTL_SECONDS = parseInt(process.env.LEAF_RESULT_TTL_SECONDS ?? '86400', 10);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Parse an integer env knob, falling back to `def` when unset or malformed. Without the finite
// guard a typo (e.g. WAIT_MS=abc) yields NaN, which poisons `Date.now() < deadline` (always false,
// skipping the bounded wait) and emits "Retry-After: NaN"; negatives are rejected for the same reason.
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Spec §4.3 sync-path saturation handling: how long to bound-wait (re-attempting pool acquisition
// with exponential backoff) before returning 503, and what Retry-After to advertise. Read per
// request so overrides take effect without a restart (and so tests can shrink the budget).
function saturationWaitConfig() {
  return {
    waitMs: intEnv('KAGENTI_SYNC_SATURATION_WAIT_MS', 30000),
    backoffMs: intEnv('KAGENTI_SYNC_SATURATION_BACKOFF_MS', 250),
    maxBackoffMs: intEnv('KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS', 5000),
    retryAfterS: intEnv('KAGENTI_SYNC_SATURATION_RETRY_AFTER_S', 5),
  };
}

const isSaturated = (r: LeafResult): boolean => r.status === 'failed' && r.reason === 'saturated';

/**
 * When `auth` is present the credential comes from the control plane and the ambient
 * ANTHROPIC_AUTH_TOKEN is NOT passed through at all -- so pi is never even offered the deployment's
 * identity for an authenticated turn (MU1 spec §3.4). When it is absent, this is byte-for-byte
 * today's behaviour, which is what keeps the 14 unauthenticated deploy scripts working (§4.3.1).
 */
export function buildConfig(auth?: TurnAuth | null): TurnConfig {
  // Every config built here is for a SERVER turn: tools must run in a sandbox and the loader is
  // locked down (MI1 §5 R3/R4). SH_LOCAL_TOOLS=1 is a single-tenant development opt-in;
  // prepareServerProcess refuses it under MOCA_TENANCY=multi at boot.
  const server = { serverMode: true, allowLocalTools: process.env.SH_LOCAL_TOOLS === '1' };
  if (auth) {
    return {
      redisUrl: process.env.REDIS_URL,
      cwd: process.env.HARNESS_CWD || process.cwd(),
      anthropicBaseUrl: auth.anthropicBaseUrl,
      upstreamCredential: auth.credential,
      ...(auth.sandboxTier ? { sandboxTier: auth.sandboxTier } : {}),
      ...server,
    };
  }
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
    ...server,
  };
}

// Read per request so a Knative env change takes effect on the next request without a code path that
// caches a stale keyset, matching how saturationWaitConfig() already behaves.
const turnAuthDeps = () => turnAuthDepsFromEnv(process.env);

/** One mapping for control-plane codes, reusing @moca/control-plane's table so the tiers agree. */
function writeAuthError(res: ServerResponse, err: unknown, sessionId?: string): void {
  if (!(err instanceof CpError)) throw err;
  const status = statusFor(err.code);
  // credential_unavailable is this tier's other 503, and the document promises EVERY 503 on the
  // client surface carries Retry-After — so the auth path advertises the same knob the saturation
  // path does, rather than leaving an auth-503 client to guess its own backoff.
  const headers =
    status === 503
      ? { ...JSON_HEADERS, 'Retry-After': String(saturationWaitConfig().retryAfterS) }
      : JSON_HEADERS;
  res.writeHead(status, headers).end(
    JSON.stringify({
      error: err.code,
      ...(err.message && err.message !== err.code ? { message: err.message } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  );
}

/**
 * The route-level catch-all: an error nothing between the route and here classified. The body
 * carries the stable `internal_error` code and never the error's own text — an arbitrary error's
 * message can carry a Redis connection string or a presented token, and this body reaches an
 * arbitrary caller (the control-plane document's rule for its `internal_error`). The text exists
 * only in the server log.
 */
function internalError(res: ServerResponse, err: unknown): void {
  console.error('[http] unclassified error:', err);
  if (!res.headersSent)
    res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: 'internal_error' }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'read_error' }));
    return;
  }

  let parsed: { sessionId?: string; prompt?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }

  const { sessionId, prompt } = parsed;
  if (!prompt) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'prompt_required' }));
    return;
  }

  // INSIDE the try: turnAuthDeps() parses the keyset, so it can throw. Built outside, that throw
  // skipped writeAuthError entirely and surfaced through the route's catch as a 500 carrying the
  // error's own text -- on the unauthenticated path too, since it happens before anything reads
  // requireAuth. Both halves of that are fixed: typed here, and refused at boot in startServer.
  let deps: TurnAuthDeps;
  let auth: TurnAuth | null;
  try {
    deps = turnAuthDeps();
    auth = await resolveTurnAuth(req.headers, parsed, deps);
  } catch (err) {
    writeAuthError(res, err, sessionId);
    return;
  }

  const wantsStream = /text\/event-stream/i.test(req.headers.accept ?? '');
  if (wantsStream) return handleTurnStream(prompt, sessionId, auth, deps, req, res);

  try {
    if (auth) {
      // Best-effort pod-identity reporting (spec §7.4). Never gates the turn on Redis.
      void deps.reportRuntime?.(auth.sessionId, runtimeFieldsForTurn(process.env, 'start'));
      let result: TurnResult | undefined;
      // Where the turn ran, captured as soon as it is leased: a turn that throws has no result to read
      // it from, and the report must still show a session that lost its workspace (P6.3 spec §6).
      let placement: TurnResult['sandbox'];
      try {
        result = await executeTurn({
          prompt,
          sessionId: auth.sessionId,
          config: buildConfig(auth),
          // A control-plane-minted session id must not 404 its first turn (plan gap #1).
          createIfAbsent: true,
          configRef: auth.configRef,
          onPlacement: (p) => (placement = p),
        });
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
      } finally {
        void deps.reportRuntime?.(
          auth.sessionId,
          runtimeFieldsForTurn(process.env, 'end', result?.sandbox ?? placement),
        );
      }
      return;
    }
    const result = await runTurn(prompt, sessionId, buildConfig());
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
  } catch (err) {
    const status = turnErrorStatus(err);
    // Only the UNCLASSIFIED case is logged: 503s are expected capacity signals, and 404/410 name
    // the caller's own mistake. A 500's text never reaches the body (see turnErrorCode), so the
    // server log is the only place it exists.
    if (status === 500) console.error('[turn] unclassified error:', err);
    res.writeHead(status, turnErrorHeaders(status, err)).end(
      JSON.stringify({
        error: turnErrorCode(status),
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  }
}

/**
 * HTTP status for a failed turn. Shared by the sync path and the SSE pre-first-frame window
 * because §3.4 regime 2 requires the two to be byte-identical, and they were two duplicated
 * blocks — which is exactly how such a pair drifts the moment one of them grows a case.
 *
 * 503 for a pool with no capacity, not 500: whether every candidate sandbox is at its cap
 * (`SandboxPoolSaturatedError`) or there is no candidate yet (`SandboxPoolEmptyError` — pods
 * rolling, an HPA scaling from zero, presence records not re-mirrored after a restart), the turn can
 * succeed on a retry, and a 500 tells the caller it never can. `/runs` already treats saturation this
 * way (it bounded-waits then 503s) and `classifyOutcome` keeps BOTH retryable for the async queue, so
 * returning 500 here would make one signal mean two different things depending on the route.
 *
 * The two are deliberately not distinguished: from the caller's side "no capacity right now, retry"
 * is one fact, and splitting it would only invite a client to treat one as fatal.
 *
 * Matched on the error's own `name` marker rather than `instanceof`, and rather than another
 * message substring. `name` is set in each class's constructor, so it is class identity and not
 * prose — a reworded message cannot change an HTTP status, which is the trap the
 * `no session in backend` line below already sits in and which is not worth extending.
 *
 * `instanceof` would be the idiom (run-leaf.ts uses it for this very class) but it is only sound
 * WITHIN the harness package. Reaching across the workspace boundary makes the status depend on
 * both packages resolving the identical module instance — which is false whenever a test mocks
 * `@moca/harness/run-turn` wholesale, as server.test.ts does: the import then yields vitest's
 * "no export" stub and `instanceof` throws, turning three unrelated turn errors into 500s. That
 * was observed, not hypothesised. The paired test constructs the REAL class, so this string stays
 * pinned to the class rather than drifting from it.
 */
const NO_CAPACITY = new Set([
  'SandboxPoolSaturatedError',
  'SandboxPoolEmptyError',
  // P6.3: the session's own sandbox is briefly absent. Same advice: retry after Retry-After.
  'SandboxAffinityPendingError',
]);

export function turnErrorStatus(err: unknown): number {
  if (err instanceof Error && err.name === 'BundleNotFoundError') return 410;
  if (err instanceof Error && NO_CAPACITY.has(err.name)) return 503;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('no session in backend') ? 404 : 500;
}

/**
 * The `error` field of a failed turn, shared by the sync path and the SSE pre-first-frame window.
 *
 * A stable code, NEVER the exception's own text: an arbitrary error's message can carry a Redis
 * connection string or a presented token, and this body reaches an arbitrary caller — the same
 * rule the control-plane document states for its `internal_error`. The text goes to the server
 * log (see the catch above), not the wire.
 */
export function turnErrorCode(status: number): string {
  if (status === 404) return 'session_not_found';
  if (status === 410) return 'config_bundle_not_found';
  if (status === 503) return 'sandbox_unavailable';
  return 'internal_error';
}

/**
 * Response headers for a failed turn — i.e. `Retry-After` on the 503s, from the same knob `/runs`
 * advertises (`KAGENTI_SYNC_SATURATION_RETRY_AFTER_S`).
 *
 * The 503 above takes `/runs` as its precedent, and `/runs` does two things with saturation: it
 * bounded-waits, and it tells the client when to come back. Adopting the status without the header
 * left a client that honours `Retry-After` with no hint from the one route whose answer is "retry" —
 * so the reasoning about not letting one signal mean two things by route argued for carrying it.
 *
 * The bounded wait is deliberately NOT carried over. On `/runs` it is sound because
 * `selectPoolSandbox` throws before taking a lease or doing agent work, so re-running `runLeaf` only
 * re-attempts acquisition (see §4.3 above); on `/turn` the session is already open by the time the
 * acquire runs, and re-entering `executeTurn` to retry would re-open it. That asymmetry is real and
 * E8 reads the region it shows up in, so it is worth stating rather than quietly matching.
 *
 * When `err` is a SandboxAffinityPendingError carrying a grace-relative retry interval, use its
 * `retryInMs` instead — proportional backoff, capped at 10 s so a sandbox returning early is still
 * noticed quickly.
 */
export function turnErrorHeaders(status: number, err?: unknown): Record<string, string> {
  if (status !== 503) return JSON_HEADERS;
  if (
    err &&
    typeof err === 'object' &&
    'name' in err &&
    err.name === 'SandboxAffinityPendingError' &&
    'retryInMs' in err &&
    typeof err.retryInMs === 'number' &&
    Number.isFinite(err.retryInMs)
  ) {
    const seconds = Math.min(10, Math.max(1, Math.ceil(err.retryInMs / 1000)));
    return { ...JSON_HEADERS, 'Retry-After': String(seconds) };
  }
  return { ...JSON_HEADERS, 'Retry-After': String(saturationWaitConfig().retryAfterS) };
}

// Serialize frames to the SSE wire form, flushing SSE headers on the FIRST frame (lazy flush →
// pre-first-frame failures keep sync status-code parity, §3.4). The heartbeat is armed only inside
// writeFrame, so it never fires before the first real frame.
function makeFrameWriter(res: ServerResponse, keepaliveMs: number) {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const arm = () => {
    if (keepaliveMs <= 0) return;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n'); // SSE comment — invisible to EventSource
    }, keepaliveMs);
  };
  const writeFrame = (frame: TurnStreamFrame) => {
    if (!res.headersSent) res.writeHead(200, SSE_HEADERS);
    res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    arm(); // reset the idle timer on every real frame
  };
  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
  };
  return { writeFrame, stop };
}

// SSE representation of /turn. Same executeTurn core as the sync path (called directly with the
// additive onEvent/signal inputs); the server owns transport, lazy flush, heartbeat, and abort.
async function handleTurnStream(
  prompt: string,
  sessionId: string | undefined,
  auth: TurnAuth | null,
  deps: ReturnType<typeof turnAuthDeps>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ac = new AbortController();
  let clientGone = false;
  // Client disconnect → abort the in-flight turn (§3.6). The !res.writableEnded guard means a
  // normal completion (res.end() already called) is a no-op; only a premature close aborts. On
  // Node 22 the reliable disconnect signal for a half-consumed streaming request is the RESPONSE's
  // 'close' (the request's own 'close' fires with request-body end, not on socket teardown here).
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  const { writeFrame, stop } = makeFrameWriter(res, intEnv('SH_TURN_STREAM_KEEPALIVE_MS', 20000));
  const effectiveSessionId = auth?.sessionId ?? sessionId;
  if (auth) void deps.reportRuntime?.(auth.sessionId, runtimeFieldsForTurn(process.env, 'start'));
  let result: TurnResult | undefined;
  // As in the JSON path: a turn that throws after its lease still reports where it ran (P6.3 spec §6).
  let placement: TurnResult['sandbox'];
  try {
    result = await executeTurn({
      prompt,
      sessionId: effectiveSessionId,
      config: buildConfig(auth),
      // Unauthenticated: preserve /turn's 404-on-missing-session contract. Authenticated: the id was
      // minted by the trusted control-plane tier, so it may create-or-resume (plan gap #1).
      createIfAbsent: auth !== null,
      ...(auth?.configRef ? { configRef: auth.configRef } : {}),
      onEvent: (f) => writeFrame(f),
      signal: ac.signal,
      onPlacement: (p) => (placement = p),
    });
    // Terminal frame derived from TurnResult — same facts a sync caller reads (§3.4). Not attempted
    // after a disconnect (socket is gone; would EPIPE).
    if (!clientGone && !res.writableEnded) writeFrame(terminalFrame(result));
  } catch (err) {
    if (!res.headersSent) {
      // Pre-first-frame: nothing streamed yet, so reuse the EXACT sync mapping — a bad sessionId
      // still returns real 404 JSON, byte-identical to the sync path (§3.4 regime 2).
      const status = turnErrorStatus(err);
      if (status === 500) console.error('[turn:sse] unclassified error:', err);
      res.writeHead(status, turnErrorHeaders(status, err)).end(
        JSON.stringify({
          error: turnErrorCode(status),
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      stop();
      return;
    }
    // Post-first-frame: status codes are spent; degrade to a terminal error frame (§3.4 regime 3).
    // Guarded so a concurrent disconnect can't double-write / EPIPE.
    if (!clientGone && !res.writableEnded) {
      const message = err instanceof Error ? err.message : String(err);
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          sessionId: sessionId ?? '',
          stopReason: 'error',
          errorMessage: message,
        })}\n\n`,
      );
    }
  } finally {
    stop();
    if (auth)
      void deps.reportRuntime?.(
        auth.sessionId,
        runtimeFieldsForTurn(process.env, 'end', result?.sandbox ?? placement),
      );
    if (!res.writableEnded) res.end();
  }
}

export function isLeafEnvelope(o: any): o is LeafEnvelope {
  return o && typeof o.sessionId === 'string' && validateItem(o.item) !== null;
}

export function isSolveEnvelope(o: any): boolean {
  return (
    o &&
    typeof o.sessionId === 'string' &&
    o.kind === 'solve' &&
    typeof o.problemStatement === 'string' &&
    typeof o.repoUrl === 'string' &&
    typeof o.ref === 'string'
  );
}

export function isPromptEnvelope(o: any): boolean {
  return (
    o && typeof o.sessionId === 'string' && o.kind === 'prompt' && typeof o.prompt === 'string'
  );
}

export function isRunEnvelope(o: any): boolean {
  return isLeafEnvelope(o) || isSolveEnvelope(o) || isPromptEnvelope(o);
}

/**
 * `configRef`, if present, must name a bundle digest (issue #222).
 *
 * Deliberately NOT folded into isRunEnvelope: an empty configRef is a well-formed envelope making
 * an unsatisfiable request, and `envelope_invalid` would send an operator hunting for a malformed
 * body. The usual cause is a dispatch built from an unset shell variable — `jq --arg c "$DIGEST"`
 * happily sends `""` — so the error has to name the field.
 */
export function configRefValid(o: any): boolean {
  if (o?.configRef === undefined || o.configRef === null) return true;
  return typeof o.configRef === 'string' && o.configRef.trim() !== '';
}

/** Writes the 400 and returns true when the request must not proceed. */
function rejectInvalidConfigRef(body: any, res: ServerResponse): boolean {
  if (configRefValid(body)) return false;
  res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'configRef_invalid' }));
  return true;
}

let queue: RedisWorkQueue | undefined;
function getQueue(): RedisWorkQueue {
  if (!queue) queue = new RedisWorkQueue(process.env.REDIS_URL);
  return queue;
}

let resultStore: RedisResultStore | undefined;
function getResultStore(): RedisResultStore {
  if (!resultStore) resultStore = new RedisResultStore(process.env.REDIS_URL);
  return resultStore;
}

/**
 * Workloads are unavailable until Moca provisions them itself: Context Service no longer allocates
 * sandbox pools for Moca (rossoctl/moca#455). Answer every workload route, and any run that names a
 * workload, plainly rather than running it on the default pool.
 */
function rejectWorkloads(res: ServerResponse): void {
  res.writeHead(501, JSON_HEADERS).end(JSON.stringify({ error: 'workloads_unavailable' }));
}

async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isRunEnvelope(body)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'envelope_invalid' }));
    return;
  }
  if (rejectInvalidConfigRef(body, res)) return;
  if (body.workloadId !== undefined) return rejectWorkloads(res);
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res
    .writeHead(202, JSON_HEADERS)
    .end(JSON.stringify({ status: 'accepted', sessionId: body.sessionId }));
}

async function handleRunLeafParsed(
  body: any,
  _raw: string,
  res: ServerResponse,
  auth: TurnAuth | null = null,
): Promise<void> {
  if (!isRunEnvelope(body)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'envelope_invalid' }));
    return;
  }
  if (rejectInvalidConfigRef(body, res)) return;
  if (body.workloadId !== undefined) return rejectWorkloads(res);

  // Spec §4.3: on pool saturation the sync path bounded-waits with backoff, then 503 Retry-After.
  // selectPoolSandbox throws before taking any lease or doing agent work, so re-running runLeaf on a
  // "saturated" result only re-attempts acquisition — the preceding steps (validate, model resolve,
  // Redis verdict fast-path) are idempotent. The async path is untouched (queue drains as leases free).
  const cfg = saturationWaitConfig();
  const deadline = Date.now() + cfg.waitMs;
  let delay = cfg.backoffMs;
  let result = await runLeaf(body, buildConfig(auth));
  while (isSaturated(result) && Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, cfg.maxBackoffMs);
    result = await runLeaf(body, buildConfig(auth));
  }

  if (isSaturated(result)) {
    // Still saturated after the budget: tell the client to retry. Do NOT persist a result record —
    // a 503 is "retry", not a terminal failure, and /runs/status must not report it as one.
    res
      .writeHead(503, { ...JSON_HEADERS, 'Retry-After': String(cfg.retryAfterS) })
      .end(JSON.stringify({ status: 'failed', reason: 'saturated' }));
    return;
  }

  await writeResult(
    getResultStore(),
    leafSessionId(body),
    toResultRecord(result, body.sessionId, new Date().toISOString()),
    RESULT_TTL_SECONDS,
  );
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}

async function handleLeafStatus(url: URL, res: ServerResponse): Promise<void> {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'sessionId_required' }));
    return;
  }
  const tenant = url.searchParams.get('tenant') ?? undefined;
  const record = await readResult(getResultStore(), leafSessionId({ sessionId, tenant }));
  if (!record) {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: 'queued' }));
    return;
  }
  if (record.status === 'done') {
    res
      .writeHead(200, JSON_HEADERS)
      .end(JSON.stringify({ status: 'done', verdict: record.verdict }));
    return;
  }
  if (record.status === 'solved') {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: 'solved', patch: record.patch }));
    return;
  }
  if (record.status === 'paused') {
    res
      .writeHead(200, JSON_HEADERS)
      .end(JSON.stringify({ status: 'paused', gateId: record.gate?.gateId, gate: record.gate }));
    return;
  }
  if (record.status === 'failed') {
    res
      .writeHead(200, JSON_HEADERS)
      .end(JSON.stringify({ status: 'failed', reason: record.reason ?? undefined }));
    return;
  }
  if (record.status === 'responded') {
    res
      .writeHead(200, JSON_HEADERS)
      .end(JSON.stringify({ status: 'responded', text: record.text }));
    return;
  }
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: record.status }));
}

// Pre-rename wire paths kept as aliases (issue #37). The public execution route is now the
// industry-standard "run" noun (`/runs`); the internal `runLeaf`/`LeafEnvelope` vocabulary is
// unchanged. Aliases warn once per path and are removed in a later release.
const DEPRECATED_ROUTE_ALIASES: Record<string, string> = {
  '/run-leaf': '/runs',
  '/run-leaf/status': '/runs/status',
};
const warnedDeprecatedRoutes = new Set<string>();
function warnDeprecatedRoute(oldPath: string): void {
  if (warnedDeprecatedRoutes.has(oldPath)) return;
  warnedDeprecatedRoutes.add(oldPath);
  console.warn(
    `[deprecation] ${oldPath} is deprecated and will be removed in a future release; use ${DEPRECATED_ROUTE_ALIASES[oldPath]} instead`,
  );
}

export function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (/^\/workloads(?:\/[^/?]+)?$/.test(url)) {
    rejectWorkloads(res);
    return;
  }

  // Run-status endpoint: canonical `/runs/status`, plus the deprecated `/run-leaf/status` alias.
  if (
    req.method === 'GET' &&
    (url.startsWith('/runs/status') || url.startsWith('/run-leaf/status'))
  ) {
    if (url.startsWith('/run-leaf/status')) warnDeprecatedRoute('/run-leaf/status');
    // The authorization check runs inside an async function whose promise is caught, like every
    // sibling route's: a throw that is not a CpError (writeAuthError rethrows those) becomes a 500
    // for this request rather than an unhandled exception.
    const statusRoute = async () => {
      const statusUrl = new URL(url, 'http://localhost');
      const sessionId = statusUrl.searchParams.get('sessionId');
      // A status read always names its session, and is always authorized before anything is read:
      // a request without one is refused here rather than left to the handler (MI1 R7). This order
      // exists for CodeQL's "user-controlled bypass" check and changes no response: handleLeafStatus
      // refuses a missing sessionId the same way. So no test can tell the two orders apart -- keep
      // this one because it makes the authorization unconditional in the code, not only in effect.
      if (!sessionId) {
        res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'sessionId_required' }));
        return;
      }
      let authenticated: boolean;
      try {
        authenticated = authorizeRunRead(req.headers, sessionId, turnAuthDeps());
      } catch (err) {
        writeAuthError(res, err, sessionId);
        return;
      }
      // An authenticated read may not name a tenant: the session token alone scopes it (MI1 R7).
      // Unauthenticated callers (SH_REQUIRE_AUTH off, no token) keep the tenant parameter.
      if (authenticated && statusUrl.searchParams.has('tenant')) {
        res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'tenant_not_allowed' }));
        return;
      }
      await handleLeafStatus(statusUrl, res);
    };
    statusRoute().catch((err) => internalError(res, err));
    return;
  }

  // Run endpoint: canonical `POST /runs`, plus the deprecated `POST /run-leaf` alias.
  if (req.method === 'POST' && (url === '/runs' || url === '/run-leaf' || url === '/v1/runs')) {
    if (url === '/run-leaf') warnDeprecatedRoute('/run-leaf');
    const route = async () => {
      const raw = await readBody(req);
      let parsed: any = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      // Pool selection is internal routing state. Never accept a Kubernetes selector directly
      // from an external run request.
      if (parsed && typeof parsed === 'object') delete parsed.sandboxPoolSelector;

      // The same caller rules as /turn (MI1 §5 R7): required under SH_REQUIRE_AUTH, a bad token
      // refused in either mode, and the token must name this run's session.
      let deps: TurnAuthDeps;
      let auth: TurnAuth | null;
      try {
        deps = turnAuthDeps();
        auth = await resolveTurnAuth(req.headers, parsed ?? {}, deps);
      } catch (err) {
        writeAuthError(res, err, parsed?.sessionId);
        return;
      }

      // An authenticated request may not name a tenant: the session token alone scopes the run
      // (MI1 R7). An unauthenticated caller (SH_REQUIRE_AUTH off, no token) keeps the tenant field.
      if (auth && parsed && parsed.tenant !== undefined) {
        res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'tenant_not_allowed' }));
        return;
      }

      if (parsed && parsed.async === true) {
        if (deps.requireAuth || auth) {
          // Running it later on its caller's credential would mean storing a bearer in the queue
          // (MI1 §6.5); running it on the ambient credential would spend the operator's key for a
          // user. Owned asynchronous runs are MU2's.
          res.writeHead(501, JSON_HEADERS).end(
            JSON.stringify({
              error: 'async_runs_unavailable',
              message: 'asynchronous runs are not available when callers authenticate',
            }),
          );
          return;
        }
        return handleEnqueueLeafParsed(parsed, res);
      }
      return handleRunLeafParsed(parsed, raw, res, auth);
    };
    route().catch((err) => internalError(res, err));
    return;
  }

  if (req.method === 'POST' && (url === '/turn' || url === '/v1/turn')) {
    handleTurn(req, res).catch((err) => internalError(res, err));
    return;
  }

  res.writeHead(404).end();
}

export function startServer(port = PORT): ReturnType<typeof createServer> {
  // Before anything binds: the shared boot function refuses a malformed keyset and an inconsistent
  // tenancy configuration, and scrubs ambient credentials under multi tenancy (MI1 §5 R2).
  prepareServerProcess(process.env);

  const server = createServer(handler);

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });

  server.listen(port, () => {
    console.log(`moca listening on :${port}`);
  });

  return server;
}

// Exact entrypoint match (matches cron-dispatch.ts) — avoids a fragile substring
// match that would misfire for any argv path containing "knative-server".
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer();
}
