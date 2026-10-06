import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runTurn, executeTurn, type TurnConfig } from '@moca/harness/run-turn';
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
import {
  contextServiceConfigured,
  ContextServiceRequestError,
  contextNamespace,
  createContext,
  deleteContext,
  freezeContext,
  createWorkloadContextUpload,
  sharedContextAccessMode,
  type WorkloadRecord,
  type WorkloadRequest,
} from './context-service.js';
import {
  createWorkloadRuntime,
  deleteWorkloadRuntime,
  getWorkloadRuntime,
} from './workload-runtime.js';
import { CpError, statusFor } from '@moca/control-plane';
import {
  authenticateSubject,
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
const WORKLOAD_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
// Context Service requires an uploaded bundle's type to match its Context.
const CONTEXT_TYPES = new Set(['workspace', 'state', 'memory', 'knowledge', 'artifacts']);

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
  res.writeHead(statusFor(err.code), JSON_HEADERS).end(
    JSON.stringify({
      error: err.code,
      ...(err.message && err.message !== err.code ? { message: err.message } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  );
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
      try {
        const result = await executeTurn({
          prompt,
          sessionId: auth.sessionId,
          config: buildConfig(auth),
          // A control-plane-minted session id must not 404 its first turn (plan gap #1).
          createIfAbsent: true,
        });
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
      } finally {
        void deps.reportRuntime?.(auth.sessionId, runtimeFieldsForTurn(process.env, 'end'));
      }
      return;
    }
    const result = await runTurn(prompt, sessionId, buildConfig());
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = turnErrorStatus(err);
    res.writeHead(status, turnErrorHeaders(status)).end(
      JSON.stringify({
        error: status === 404 ? 'session_not_found' : message,
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
const NO_CAPACITY = new Set(['SandboxPoolSaturatedError', 'SandboxPoolEmptyError']);

export function turnErrorStatus(err: unknown): number {
  if (err instanceof Error && NO_CAPACITY.has(err.name)) return 503;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('no session in backend') ? 404 : 500;
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
 */
export function turnErrorHeaders(status: number): Record<string, string> {
  if (status !== 503) return JSON_HEADERS;
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
  try {
    const result = await executeTurn({
      prompt,
      sessionId: effectiveSessionId,
      config: buildConfig(auth),
      // Unauthenticated: preserve /turn's 404-on-missing-session contract. Authenticated: the id was
      // minted by the trusted control-plane tier, so it may create-or-resume (plan gap #1).
      createIfAbsent: auth !== null,
      onEvent: (f) => writeFrame(f),
      signal: ac.signal,
    });
    // Terminal frame derived from TurnResult — same facts a sync caller reads (§3.4). Not attempted
    // after a disconnect (socket is gone; would EPIPE).
    if (!clientGone && !res.writableEnded) writeFrame(terminalFrame(result));
  } catch (err) {
    if (!res.headersSent) {
      // Pre-first-frame: nothing streamed yet, so reuse the EXACT sync mapping — a bad sessionId
      // still returns real 404 JSON, byte-identical to the sync path (§3.4 regime 2).
      const message = err instanceof Error ? err.message : String(err);
      const status = turnErrorStatus(err);
      res.writeHead(status, turnErrorHeaders(status)).end(
        JSON.stringify({
          error: status === 404 ? 'session_not_found' : message,
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
    if (auth) void deps.reportRuntime?.(auth.sessionId, runtimeFieldsForTurn(process.env, 'end'));
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

const workloadKey = (id: string) => `sh:workload:${id}`;

const withOwner = (record: WorkloadRecord, subject: string | null): WorkloadRecord => {
  const { owner: _ignored, ...rest } = record;
  return subject === null ? rest : { ...rest, owner: subject };
};

async function saveWorkload(record: WorkloadRecord): Promise<void> {
  await getResultStore().set(workloadKey(record.workloadId), JSON.stringify(record));
}

async function findWorkload(id: string): Promise<WorkloadRecord | null> {
  const raw = await getResultStore().get(workloadKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkloadRecord;
  } catch {
    return null;
  }
}

function publicWorkload(
  record: WorkloadRecord,
): Omit<WorkloadRecord, 'attachment' | 'contextId' | 'contextName' | 'revision'> {
  const {
    attachment: _attachment,
    contextId: _contextId,
    contextName: _contextName,
    revision: _revision,
    ...visible
  } = record;
  return visible;
}

function requireContextService(res: ServerResponse): boolean {
  if (contextServiceConfigured()) return true;
  res.writeHead(501, JSON_HEADERS).end(JSON.stringify({ error: 'context_service_not_configured' }));
  return false;
}

function contextServiceFailure(operation: string, err: unknown, res: ServerResponse): void {
  console.error(`Context Service ${operation} failed:`, err);
  if (err instanceof ContextServiceRequestError && err.status === 409) {
    res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: err.code }));
    return;
  }
  res.writeHead(502, JSON_HEADERS).end(JSON.stringify({ error: 'context_service_error' }));
}

function workloadRuntimeFailure(operation: string, err: unknown, res: ServerResponse): void {
  console.error(`Moca workload runtime ${operation} failed:`, err);
  res.writeHead(502, JSON_HEADERS).end(JSON.stringify({ error: 'workload_runtime_error' }));
}

/**
 * A workload belongs to the subject that created it. A caller may read or run on one only with the
 * same subject — an unowned workload (created unauthenticated) only without one. A mismatch reads as
 * `workload_not_found` there. Names are still one namespace, though: re-creating another subject's
 * live name answers `409`, and deleting an unowned one answers `204`, so a name's existence is
 * probeable — only its contents and its pool are not.
 */
const ownedBy = (record: WorkloadRecord, subject: string | null): boolean =>
  (record.owner ?? null) === subject;

/**
 * Who may DELETE a workload: its owner, and ANY caller for an unowned one. A record written before
 * workloads had owners carries none, and under SH_REQUIRE_AUTH=true no caller is unauthenticated --
 * so without this it could be neither read, deleted nor re-created, and its pool and volume would
 * leak with no API path to reclaim them. Deleting is the only thing a non-owner may do: an unowned
 * workload was reachable by every caller before, so reclaiming it grants nothing new, while
 * reading or running on it would.
 */
const mayDelete = (record: WorkloadRecord, subject: string | null): boolean =>
  ownedBy(record, subject);

/**
 * The one place a run acquires a sandbox pool selector. `/runs` strips any caller-supplied selector
 * as internal routing state, so this lookup must not re-admit another subject's pool: the workload
 * has to be owned by the run's caller (MI1 R7).
 */
async function resolveRunWorkload(
  body: any,
  subject: string | null,
  res: ServerResponse,
): Promise<any | null> {
  if (!body?.workloadId) return body;
  const record = await findWorkload(body.workloadId);
  if (!record || record.status === 'deleted' || !ownedBy(record, subject)) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return null;
  }
  if (record.status !== 'ready') {
    res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_ready' }));
    return null;
  }
  return { ...body, sandboxPoolSelector: record.sandboxSelector };
}

/**
 * Authenticate a `/workloads` request, writing the refusal itself. Resolves to the caller's subject,
 * `null` for an allowed unauthenticated caller, or `undefined` when the request was refused.
 */
function workloadCaller(req: IncomingMessage, res: ServerResponse): string | null | undefined {
  try {
    return authenticateSubject(req.headers, turnAuthDeps());
  } catch (err) {
    writeAuthError(res, err);
    return undefined;
  }
}

async function handleCreateWorkload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const subject = workloadCaller(req, res);
  if (subject === undefined) return;
  let spec: WorkloadRequest;
  try {
    spec = JSON.parse(await readBody(req)) as WorkloadRequest;
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }
  const workloadId = spec.name ?? `wl-${randomUUID().slice(0, 8)}`;
  if (workloadId.length > 50 || !WORKLOAD_NAME.test(workloadId)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'workload_name_invalid' }));
    return;
  }
  if (spec.workspace && 'claimName' in spec.workspace) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'claim_name_not_allowed' }));
    return;
  }
  if (
    spec.sandboxes !== undefined &&
    (!Number.isInteger(spec.sandboxes) || spec.sandboxes < 1 || spec.sandboxes > 100)
  ) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'sandbox_count_invalid' }));
    return;
  }
  if (spec.contextUpload !== undefined && typeof spec.contextUpload !== 'boolean') {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'context_upload_invalid' }));
    return;
  }
  const shared = spec.workspace?.shared === true;
  const replicas = spec.sandboxes ?? (shared ? 2 : 1);
  const usesContext = spec.contextUpload === true;
  if (
    spec.contextType !== undefined &&
    (typeof spec.contextType !== 'string' || !CONTEXT_TYPES.has(spec.contextType))
  ) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'context_type_invalid' }));
    return;
  }
  if (spec.contextType !== undefined && !usesContext) {
    res
      .writeHead(400, JSON_HEADERS)
      .end(JSON.stringify({ error: 'context_upload_required_for_context_type' }));
    return;
  }
  if (usesContext && replicas > 1 && !shared) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'shared_workspace_required' }));
    return;
  }
  if (!usesContext && shared && replicas > 1) {
    res
      .writeHead(400, JSON_HEADERS)
      .end(JSON.stringify({ error: 'context_upload_required_for_shared_workspace' }));
    return;
  }
  // A live workload of another subject's cannot be claimed by re-creating its name. Check-then-act:
  // two subjects creating one NEW name at the same moment can both pass this, and the later
  // saveWorkload's owner wins. Accepted for S1 -- the window is one Context Service round trip, and
  // the store offers no set-if-absent -- and tracked in rossoctl/moca#356.
  const existing = await findWorkload(workloadId);
  if (existing && existing.status !== 'deleted' && !ownedBy(existing, subject)) {
    res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'workload_name_taken' }));
    return;
  }
  if (!usesContext) {
    let createdRuntime = false;
    try {
      const runtime = await createWorkloadRuntime({
        workloadId,
        replicas,
        workspace: {
          kind: 'native',
          size: spec.workspace?.size ?? '1Gi',
          ...(spec.workspace?.storageClass ? { storageClass: spec.workspace.storageClass } : {}),
        },
      });
      createdRuntime = true;
      const record: WorkloadRecord = withOwner(
        {
          workloadId,
          ...runtime,
          replicas,
          workspace: {
            size: spec.workspace?.size ?? '1Gi',
            accessMode: 'ReadWriteOnce',
            ...(spec.workspace?.storageClass ? { storageClass: spec.workspace.storageClass } : {}),
            readOnly: false,
          },
        },
        subject,
      );
      await saveWorkload(record);
      res.writeHead(201, JSON_HEADERS).end(JSON.stringify(publicWorkload(record)));
    } catch (err) {
      if (createdRuntime) {
        await deleteWorkloadRuntime(workloadId, replicas, true).catch((cleanupError) =>
          console.error('Moca workload runtime create rollback failed:', cleanupError),
        );
      }
      workloadRuntimeFailure('create', err, res);
    }
    return;
  }
  if (!requireContextService(res)) return;
  let createdContext = false;
  try {
    const context = await createContext(workloadId, spec, subject);
    createdContext = true;
    if (context.namespace !== contextNamespace()) {
      throw new Error(`Context Service answered for namespace '${context.namespace}'`);
    }
    if (context.attachment?.kind !== 'pvc' || !context.attachment.claimName) {
      throw new Error('Context Service did not return a PVC attachment');
    }
    const record: WorkloadRecord = withOwner(
      {
        workloadId,
        contextName: workloadId,
        contextId: context.contextId,
        status: 'awaiting_upload',
        replicas,
        readyReplicas: 0,
        sandboxSelector: '',
        workspace: {
          size: spec.workspace?.size ?? '1Gi',
          accessMode: shared ? sharedContextAccessMode() : 'ReadWriteOnce',
          ...(spec.workspace?.storageClass ? { storageClass: spec.workspace.storageClass } : {}),
          readOnly: true,
        },
        attachment: { kind: 'pvc', claimName: context.attachment.claimName },
      },
      subject,
    );
    const upload = spec.contextUpload
      ? await createWorkloadContextUpload(workloadId, subject)
      : undefined;
    await saveWorkload(record);
    res
      .writeHead(201, JSON_HEADERS)
      .end(JSON.stringify({ ...publicWorkload(record), ...(upload ? { upload } : {}) }));
  } catch (err) {
    if (createdContext) {
      await deleteContext(workloadId, subject).catch((cleanupError) =>
        console.error('Context Service create rollback failed:', cleanupError),
      );
    }
    contextServiceFailure('create', err, res);
  }
}

async function handleGetWorkload(
  req: IncomingMessage,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const subject = workloadCaller(req, res);
  if (subject === undefined) return;
  const stored = await findWorkload(id);
  if (!stored || !ownedBy(stored, subject)) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  try {
    if (
      stored.status === 'awaiting_upload' ||
      stored.status === 'deleting' ||
      stored.status === 'deleted'
    ) {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify(publicWorkload(stored)));
      return;
    }
    const runtime = await getWorkloadRuntime(stored.workloadId, stored.replicas);
    const record: WorkloadRecord = { ...stored, ...runtime };
    await saveWorkload(record);
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(publicWorkload(record)));
  } catch (err) {
    workloadRuntimeFailure('get', err, res);
  }
}

async function handleCreateWorkloadUpload(
  req: IncomingMessage,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const subject = workloadCaller(req, res);
  if (subject === undefined) return;
  if (!requireContextService(res)) return;
  const record = await findWorkload(id);
  if (!record || record.status === 'deleted' || !ownedBy(record, subject)) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  if (!record.contextName || !record.contextId || !record.attachment) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  if (record.status !== 'awaiting_upload') {
    res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_awaiting_upload' }));
    return;
  }
  try {
    const capability = await createWorkloadContextUpload(record.contextName, subject);
    res.writeHead(201, JSON_HEADERS).end(JSON.stringify(capability));
  } catch (err) {
    contextServiceFailure('create upload', err, res);
  }
}

async function handleActivateWorkload(
  req: IncomingMessage,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const subject = workloadCaller(req, res);
  if (subject === undefined) return;
  if (!requireContextService(res)) return;
  const record = await findWorkload(id);
  if (!record || record.status === 'deleted' || !ownedBy(record, subject)) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  if (!record.contextName || !record.contextId || !record.attachment) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  if (record.status === 'ready') {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(publicWorkload(record)));
    return;
  }
  if (record.status !== 'awaiting_upload' && record.status !== 'provisioning') {
    res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_activatable' }));
    return;
  }
  try {
    let body: { revision?: string };
    try {
      body = JSON.parse(await readBody(req)) as { revision?: string };
    } catch {
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) {
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'revision_invalid' }));
      return;
    }
    if (record.revision && record.revision !== body.revision) {
      res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'context_revision_mismatch' }));
      return;
    }
    const context = await freezeContext(record.contextName, body.revision, subject);
    if (context.contextId !== record.contextId) {
      throw new Error('Context Service returned a different Context identity');
    }
    if (context.currentRevision !== body.revision) {
      res.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: 'context_not_uploaded' }));
      return;
    }
    if (
      record.attachment &&
      (record.attachment.kind !== context.attachment.kind ||
        record.attachment.claimName !== context.attachment.claimName)
    ) {
      throw new Error('Context Service returned changed attachment metadata');
    }
    const attachment = context.attachment;
    if (attachment?.kind !== 'pvc' || !attachment.claimName) {
      throw new Error('Context Service did not return a PVC attachment');
    }
    const activating: WorkloadRecord = {
      ...record,
      status: 'provisioning',
      revision: body.revision,
      readyReplicas: 0,
    };
    await saveWorkload(activating);
    const runtime = await createWorkloadRuntime({
      workloadId: id,
      replicas: record.replicas,
      workspace: {
        kind: 'context',
        claimName: attachment.claimName,
        revision: body.revision,
      },
    });
    const activated: WorkloadRecord = { ...activating, ...runtime };
    await saveWorkload(activated);
    res.writeHead(202, JSON_HEADERS).end(JSON.stringify(publicWorkload(activated)));
  } catch (err) {
    contextServiceFailure('activate workload', err, res);
  }
}

async function handleDeleteWorkload(
  req: IncomingMessage,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const subject = workloadCaller(req, res);
  if (subject === undefined) return;
  const record = await findWorkload(id);
  if (!record || record.status === 'deleted' || !mayDelete(record, subject)) {
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'workload_not_found' }));
    return;
  }
  if (record.contextName && !requireContextService(res)) return;
  try {
    const deleting: WorkloadRecord =
      record.status === 'deleting' ? record : { ...record, status: 'deleting', readyReplicas: 0 };
    if (record.status !== 'deleting') await saveWorkload(deleting);
    await deleteWorkloadRuntime(record.workloadId, record.replicas, !record.contextName);
    if (record.contextName) await deleteContext(record.contextName, subject);
    await saveWorkload({ ...deleting, status: 'deleted', readyReplicas: 0 });
    res.writeHead(204).end();
  } catch (err) {
    contextServiceFailure('delete', err, res);
  }
}

async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isRunEnvelope(body)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'envelope_invalid' }));
    return;
  }
  if (rejectInvalidConfigRef(body, res)) return;
  // Only an unauthenticated caller reaches the queue (an authenticated async run is a 501).
  body = await resolveRunWorkload(body, null, res);
  if (!body) return;
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
  body = await resolveRunWorkload(body, auth?.subject ?? null, res);
  if (!body) return;

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
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method === 'POST' && url === '/workloads') {
    handleCreateWorkload(req, res).catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  const workloadUploadMatch = url.match(/^\/workloads\/([^/?]+)\/uploads$/);
  if (workloadUploadMatch && req.method === 'POST') {
    handleCreateWorkloadUpload(req, decodeURIComponent(workloadUploadMatch[1]), res).catch(
      (err) => {
        if (!res.headersSent)
          res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
      },
    );
    return;
  }

  const workloadActivateMatch = url.match(/^\/workloads\/([^/?]+)\/activate$/);
  if (workloadActivateMatch && req.method === 'POST') {
    handleActivateWorkload(req, decodeURIComponent(workloadActivateMatch[1]), res).catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  const workloadMatch = url.match(/^\/workloads\/([^/?]+)$/);
  if (workloadMatch && req.method === 'GET') {
    handleGetWorkload(req, decodeURIComponent(workloadMatch[1]), res).catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }
  if (workloadMatch && req.method === 'DELETE') {
    handleDeleteWorkload(req, decodeURIComponent(workloadMatch[1]), res).catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
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
    statusRoute().catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
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
      // from an external run request; a workload resolver may add one after this boundary.
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
    route().catch((err) => {
      if (!res.headersSent)
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (req.method === 'POST' && (url === '/turn' || url === '/v1/turn')) {
    handleTurn(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
      }
    });
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
