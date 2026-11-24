/**
 * `mocactl spawn | subagents | watch | get | approve | reject`, built on the leaf-turn transport
 * and the subagent ledger.
 */
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiError } from './api/errors.js';
import { validWorkloadId, WorkloadsClient } from './api/workloads.js';
import {
  GATE_FEEDBACK_BYTES,
  type ControlPlaneApi,
  type CreateSessionRequest,
  type SessionToken,
  type TurnEvent,
} from './api/types.js';
import { describeError } from './core/messages.js';
import { sanitizeRemote } from './core/sanitize.js';
import {
  initLedger,
  openLedger,
  type Ledger,
  type LedgerEnvelope,
  type LedgerRecord,
} from './core/subagent-ledger.js';
import type { Io } from './headless.js';
import type { Runtime } from './runtime.js';
import { describeWorkloadError } from './workloads.js';
import { AsyncTurnTransport, viewFromTurnEvent } from './transport/async-turn.js';
import {
  DEFAULT_UNKNOWN_GRACE_MS,
  LeafTransport,
  isTerminalState,
  mapHonestState,
  terminalFromBody,
  type HonestState,
  type LeafEnvelope,
  type LeafResultBody,
  type StateView,
} from './transport/leaf-turn.js';

const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** Keeps a ledger append within one atomic `O_APPEND write(2)` on a local filesystem. */
export const MAX_PROMPT_BYTES = 64 * 1024;
/** Harness-side session-id alphabet (mirrors `leafSessionId` in run-leaf.ts). */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;
/**
 * `--label` alphabet: starts alphanumeric, up to 64 characters of `[A-Za-z0-9._-]`.
 * Stricter than `--tag` (which is free-form) because `label` is a per-dispatch
 * disambiguator surfaced on `--json` output where downstream `jq` filters pick it
 * up by key value, so shell meta or whitespace would make callers quote defensively.
 */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `spawn --max-concurrent`'s default. Matches the VM pool cap (`deploy/vm` supervisor). */
export const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnedSession {
  sessionId: string;
  token: string;
}

/** Payload passed on stdin from `spawn` to the detached `__spawn-worker` process. */
export interface SpawnWorkerPayload {
  sessionId: string;
  token: string;
  envelope: LeafEnvelope;
  /** Resolved control-plane and harness URLs, so a child without flag/env access can rebuild them. */
  controlPlaneUrl?: string;
  harnessUrl?: string;
}

function requireReady(
  rt: Runtime,
  io: Io,
): rt is Runtime & Required<Pick<Runtime, 'cp' | 'harness'>> {
  if (!rt.cp || !rt.harness) {
    io.err('missing control-plane URL — pass --control-plane-url or set SH_CONTROL_PLANE_URL');
    return false;
  }
  if (!rt.auth) {
    io.err('not logged in — run `mocactl login` first');
    return false;
  }
  return true;
}

// --- spawn ---

export interface SpawnOptions {
  prompt: string;
  kind: 'prompt' | 'solve';
  /** The promoted config-bundle digest (`sha256:…`), passed through as the session's `configRef`. */
  configRef?: string;
  repoUrl?: string;
  ref?: string;
  tag?: string;
  /** A caller label for this one dispatch, surfaced on `subagents --json` as `label`. */
  label?: string;
  /** A ready workload whose context the run sees; prompt runs only (the harness refuses others). */
  workloadId?: string;
  /** Give the run its own writable copy of the workload's context (`--writable`). */
  writable?: boolean;
  /** Refuse the dispatch when this many of this user's subagents are still running. */
  maxConcurrent?: number;
  /** Dispatch as an async turn (cancellable, no local worker) instead of the sync `/runs` path. */
  async?: boolean;
  /** Park the subagent at a gate before it acts; answered with `mocactl approve`/`reject` (#393). */
  requireApproval?: boolean;
  json: boolean;
  /** Test seams: fork + ledger injection. */
  forkFn?: (
    sessionId: string,
    token: string,
    envelope: LeafEnvelope,
    cwd: string,
  ) => number | Promise<number>;
  ledger?: Ledger;
  /** Test seam for the `--workload` preflight; otherwise built from the runtime. */
  workloads?: Pick<WorkloadsClient, 'get'>;
  /** Test seam for `--async`; otherwise built from the runtime's control-plane client. */
  turns?: Pick<AsyncTurnTransport, 'submit'>;
}

/** Create session, record it, fork a detached worker, return. Worker survives mocactl exit. */
export async function cmdSpawn(rt: Runtime, io: Io, opts: SpawnOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!opts.prompt.trim()) {
    io.err('spawn needs a non-empty prompt');
    return 2;
  }
  if (Buffer.byteLength(opts.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    io.err(`prompt is too large (max ${MAX_PROMPT_BYTES} bytes); shorten it or split the task`);
    return 2;
  }
  if (opts.configRef && !BUNDLE_DIGEST.test(opts.configRef)) {
    io.err('a bundle digest is sha256:<64 lowercase hex>, as `mocactl promote` prints it');
    return 2;
  }
  if (opts.label !== undefined && !LABEL_RE.test(opts.label)) {
    io.err('--label must start with [A-Za-z0-9] and be up to 64 characters of [A-Za-z0-9._-]');
    return 2;
  }
  if (opts.kind === 'solve') {
    if (!opts.repoUrl || !opts.ref) {
      io.err('--kind solve needs both --repo URL and --ref REF');
      return 2;
    }
  } else if (opts.repoUrl || opts.ref) {
    io.err('--repo and --ref are only meaningful with --kind solve');
    return 2;
  }
  if (opts.writable && opts.workloadId === undefined) {
    io.err(
      "--writable needs --workload ID: it gives the run a writable copy of a workload's context",
    );
    return 2;
  }
  if (opts.workloadId !== undefined) {
    if (opts.kind !== 'prompt') {
      io.err('--workload needs --kind prompt: the harness runs only prompts on a workload');
      return 2;
    }
    if (!validWorkloadId(opts.workloadId)) {
      io.err(`invalid workload id '${sanitizeRemote(opts.workloadId)}'`);
      return 2;
    }
    if (opts.async) {
      // The control plane refuses a workload on the async path with 501 rather than queueing a turn
      // that could only dead-letter. Refused here so the session is never created.
      io.err('--async and --workload are exclusive: an async turn cannot run on a workload');
      return 2;
    }
  }

  // The cap is checked first because it is the only preflight that costs nothing: no session, no
  // worker and not even a round trip for a dispatch that is refused.
  // shortcut: counts this user's ledger on this machine; the server's own pool is the real bound
  // (503 saturated, already retried in runSpawnWorker). Revisit if the cap needs to be global.
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const cap = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  // Liveness-gated, not a bare non-terminal count: a stale `running` or `unknown` row — exactly
  // what an unreconciled crash leaves behind — would otherwise hold a slot for good and wedge
  // `spawn` permanently. A child that is gone holds nothing.
  // shortcut: an async row has no child to probe, so it holds its slot until `subagents` or `get`
  // reads the turn and writes a terminal state — both do. Revisit if the turn state is worth
  // reading here too: it costs a round trip per row, which is what this preflight exists to avoid.
  const running = ledger
    .readAll()
    .filter((r) => !isTerminalState(r.lastKnownState))
    .filter((r) =>
      r.turnId !== undefined ? true : r.childPid !== undefined && isAlive(r.childPid),
    );
  if (running.length >= cap) {
    io.err(
      `${running.length} subagents are already running and --max-concurrent is ${cap}; ` +
        '`mocactl subagents` shows them, `mocactl get` collects one',
    );
    return 1;
  }

  // Preflight, before a session or a worker exists: a run on a workload that is missing or not
  // ready would only fail later, in the detached worker.
  if (opts.workloadId !== undefined) {
    const id = sanitizeRemote(opts.workloadId);
    try {
      // `main` has already refreshed the API token for this command.
      const client =
        opts.workloads ??
        new WorkloadsClient(rt.harness, async () => rt.auth?.apiToken, rt.fetchImpl);
      const workload = await client.get(opts.workloadId);
      if (workload.status !== 'ready') {
        io.err(
          `workload ${id} is ${sanitizeRemote(workload.status)}, not ready; ` +
            `\`mocactl workloads get ${id}\` shows it`,
        );
        return 1;
      }
    } catch (err) {
      io.err(describeWorkloadError(err, opts.workloadId));
      return 1;
    }
  }

  let session: SpawnedSession;
  try {
    session = await createSession(rt.cp, opts.configRef);
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  // Defense-in-depth before this sessionId reaches `join()` for the worker log.
  if (!SAFE_ID_RE.test(session.sessionId)) {
    io.err(`control plane returned an unexpected sessionId '${sanitizeRemote(session.sessionId)}'`);
    return 1;
  }

  const envelope: LeafEnvelope = buildEnvelope(session.sessionId, opts);

  // The async path queues the turn BEFORE the ledger row, the sync path records before forking: the
  // turn id is part of the row and cannot be written later (`append` is the only writer of it).
  // The window is one call wide, and what it leaks is an orphan turn the control plane will run to
  // completion — visible as a session, just not as a subagent. The sync path's own window leaks the
  // same session, so neither is the one to close first.
  let turnId: string | undefined;
  if (opts.async) {
    try {
      const turns = opts.turns ?? new AsyncTurnTransport(rt.cp);
      turnId = await turns.submit(envelope);
    } catch (err) {
      io.err(describeError(err));
      return 1;
    }
  }

  const record: LedgerRecord = {
    sessionId: session.sessionId,
    ...(turnId ? { turnId } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    envelope: envelopeForLedger(opts),
    ...(opts.configRef ? { bundle: opts.configRef } : {}),
    ...(opts.workloadId ? { workloadId: opts.workloadId } : {}),
    ...(opts.writable ? { writable: true } : {}),
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    submittedAt: rt.now(),
    lastKnownState: 'running',
    stateObservedAt: rt.now(),
  };
  ledger.append(record);

  if (turnId) {
    // No fork: the turn record is the subagent, so there is nothing local to keep alive. The
    // session token goes unused here — `get` mints its own when it needs one.
    io.err(`spawned ${session.sessionId}  (turn ${turnId})`);
    if (opts.json) {
      io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId, turnId }) + '\n');
    } else {
      io.out(`${session.sessionId}\n`);
    }
    return 0;
  }

  // Resolve the harness URL in the parent so the child never re-discovers.
  let resolvedHarnessUrl: string | undefined;
  try {
    resolvedHarnessUrl = await rt.harness.baseUrl();
  } catch {
    resolvedHarnessUrl = rt.endpoints.harnessUrl;
  }
  const forkFn =
    opts.forkFn ??
    ((sid, tok, env, cwd) => defaultFork(sid, tok, env, cwd, rt, resolvedHarnessUrl));
  let pid: number;
  try {
    pid = await forkFn(session.sessionId, session.token, envelope, rt.paths.stateDir);
  } catch (err) {
    // Fork failed after session was created — mark the ledger row failed with the fork error.
    ledger.updateState(session.sessionId, 'failed', {
      detail: err instanceof Error ? err.message : String(err),
      now: rt.now(),
    });
    io.err(describeError(err));
    return 1;
  }
  ledger.updateState(session.sessionId, 'running', { childPid: pid, now: rt.now() });

  io.err(`spawned ${session.sessionId}  (pid ${pid})`);
  if (opts.json) {
    io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId, pid }) + '\n');
  } else {
    io.out(`${session.sessionId}\n`);
  }
  return 0;
}

async function createSession(cp: ControlPlaneApi, configRef?: string): Promise<SpawnedSession> {
  const req: CreateSessionRequest = configRef ? { configRef } : {};
  const created = await cp.createSession(req);
  return { sessionId: created.sessionId, token: created.token };
}

function buildEnvelope(sessionId: string, opts: SpawnOptions): LeafEnvelope {
  const base: LeafEnvelope = { sessionId, kind: opts.kind };
  // `/runs` reads configRef from the body (not the session); the harness builds the solve prompt
  // itself from `problemStatement`.
  if (opts.configRef) base.configRef = opts.configRef;
  if (opts.requireApproval) base.requireApproval = true;
  if (opts.kind === 'prompt') {
    return {
      ...base,
      prompt: opts.prompt,
      ...(opts.workloadId ? { workloadId: opts.workloadId } : {}),
      ...(opts.writable ? { contextWritable: true } : {}),
    };
  }
  return { ...base, problemStatement: opts.prompt, repoUrl: opts.repoUrl!, ref: opts.ref! };
}

function envelopeForLedger(opts: SpawnOptions): LedgerEnvelope {
  return {
    kind: opts.kind,
    prompt: opts.prompt,
    ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.configRef ? { configRef: opts.configRef } : {}),
    ...(opts.workloadId ? { workloadId: opts.workloadId } : {}),
    ...(opts.writable ? { contextWritable: true } : {}),
  };
}

/** Fork a detached worker (body: `mocactl __spawn-worker`) holding the sync POST /v1/runs. */
async function defaultFork(
  sessionId: string,
  token: string,
  envelope: LeafEnvelope,
  stateDir: string,
  rt: Runtime,
  harnessUrl?: string,
): Promise<number> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = join(stateDir, `spawn-${sessionId}.log`);
  const logFd = openSync(logPath, 'a', 0o600);
  const spawned = spawnChild(process.execPath, [process.argv[1]!, '__spawn-worker'], {
    detached: true,
    stdio: ['pipe', logFd, logFd],
    env: { ...process.env },
  });
  try {
    // ENOENT/EACCES surface as an async 'error' event, not a sync throw — await either event
    // before trusting `spawned.pid`, and detach the loser so no stray listener remains.
    await new Promise<void>((resolveStart, rejectStart) => {
      const onSpawn = () => {
        spawned.off('error', onError);
        resolveStart();
      };
      const onError = (err: Error) => {
        spawned.off('spawn', onSpawn);
        rejectStart(err);
      };
      spawned.once('spawn', onSpawn);
      spawned.once('error', onError);
    });
    // Token on stdin so it stays out of argv (visible via `ps`); endpoints alongside so the
    // child doesn't need its own flags/env.
    const payload: SpawnWorkerPayload = {
      sessionId,
      token,
      envelope,
      ...(rt.endpoints.controlPlaneUrl ? { controlPlaneUrl: rt.endpoints.controlPlaneUrl } : {}),
      ...(harnessUrl ? { harnessUrl } : {}),
    };
    spawned.stdin!.on('error', () => {}); // swallow EPIPE if the child exits before reading
    spawned.stdin!.end(JSON.stringify(payload) + '\n');
    spawned.unref();
    if (spawned.pid === undefined) throw new Error('spawn produced no pid');
    return spawned.pid;
  } catch (err) {
    closeSync(logFd);
    try {
      spawned.kill(); // defense-in-depth; no-op if the child never started
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Fetch-level errors where the request is known to have reached the server. undici's
 * `headersTimeout` and `bodyTimeout` only fire after the request is on the wire.
 * `UND_ERR_SOCKET` is deliberately excluded: it also fires when the server resets before
 * reading the request. Connect-phase codes (`ECONNREFUSED`, `ENOTFOUND`,
 * `UND_ERR_CONNECT_TIMEOUT`, TLS errors) are not here either, so they stay terminal.
 * Verified against Node 24 with a dispatcher probe (see PR #518 for the shapes).
 */
const AFTER_SEND_CAUSE_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
function isAfterSendError(causeCode: string | undefined): boolean {
  return causeCode !== undefined && AFTER_SEND_CAUSE_CODES.has(causeCode);
}

export interface SpawnWorkerDeps {
  /** Overrides stdin reading; the real binary routes `process.stdin` through main.ts. */
  readStdin?: () => Promise<string>;
  /** Overrides the ledger; the real binary opens the on-disk ledger. */
  ledger?: Ledger;
  /** Overrides the leaf-turn transport; the real binary builds one from `rt.harness`. */
  transport?: LeafTransport;
}

/**
 * Detached-worker entry: read payload from stdin, POST /v1/runs, record outcome, exit.
 * Every exit path with a sessionId writes a ledger line — terminal for server replies and
 * connect-phase failures, non-terminal `running` for after-send disconnects so `subagents`
 * reconciles via `/runs/status`. The malformed-stdin branch has no sessionId to anchor on;
 * the parent's row stays authoritative there.
 */
export async function runSpawnWorker(rt: Runtime, deps: SpawnWorkerDeps = {}): Promise<number> {
  const ledger = deps.ledger ?? openLedger(rt.paths.subagentsFile, rt.now);
  const readStdinFn = deps.readStdin ?? readStdin;
  let payload: SpawnWorkerPayload;
  try {
    const parsed = JSON.parse(await readStdinFn()) as Partial<SpawnWorkerPayload>;
    if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.token !== 'string') {
      return 2;
    }
    payload = parsed as SpawnWorkerPayload;
  } catch {
    // Malformed stdin — no sessionId to anchor on. The parent's row stays authoritative.
    return 2;
  }
  // Payload is the parent's resolved endpoints; apply unconditionally so a child-side
  // DiscoveringHarness built from stale env/config doesn't override it.
  if (payload.harnessUrl || payload.controlPlaneUrl) {
    const { applyEndpoints } = await import('./runtime.js');
    applyEndpoints(rt, {
      controlPlaneUrl: payload.controlPlaneUrl,
      harnessUrl: payload.harnessUrl,
    });
  }
  if (!rt.harness) {
    ledger.updateState(payload.sessionId, 'failed', {
      detail: 'worker has no harness URL (missing --harness-url or SH_HARNESS_URL)',
      now: rt.now(),
    });
    return 2;
  }
  const transport = deps.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  // 503 saturated is a retry-later signal; the server retries in-band first, so this is a
  // bounded second burst beyond that window. Capped by attempts AND wall time to defend
  // against a hostile `Retry-After`.
  const MAX_SATURATED_ATTEMPTS = 3;
  const MAX_RETRY_WALL_MS = 5 * 60_000;
  const DEFAULT_RETRY_AFTER_S = 5;
  const retryStart = rt.now();
  for (let attempt = 1; attempt <= MAX_SATURATED_ATTEMPTS; attempt++) {
    try {
      const body = await transport.submitLeafTurn(payload.envelope, payload.token);
      const view = terminalFromBody(body);
      ledger.updateState(payload.sessionId, view.state, {
        detail: view.detail,
        now: rt.now(),
      });
      return view.state === 'done' ? 0 : 1;
    } catch (err) {
      // `errorFromResponse` folds body.reason into code, so saturated is ApiError(503, 'saturated').
      const saturated = err instanceof ApiError && err.status === 503 && err.code === 'saturated';
      if (saturated) {
        if (attempt >= MAX_SATURATED_ATTEMPTS) break;
        const remainingMs = MAX_RETRY_WALL_MS - (rt.now() - retryStart);
        if (remainingMs <= 0) break;
        const requestedMs = (err.retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000;
        await rt.sleep(Math.max(0, Math.min(requestedMs, remainingMs)));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Three cases: server replied (terminal), fetch died after send (reconcile — server may
      // have the record), fetch died before send (terminal — request never left).
      if (err instanceof ApiError && err.status > 0) {
        ledger.updateState(payload.sessionId, 'failed', { detail: message, now: rt.now() });
      } else if (err instanceof ApiError && err.status === 0 && isAfterSendError(err.causeCode)) {
        ledger.updateState(payload.sessionId, 'running', {
          detail: `client disconnected (${message}); reconciling`,
          now: rt.now(),
        });
      } else {
        ledger.updateState(payload.sessionId, 'failed', { detail: message, now: rt.now() });
      }
      return 1;
    }
  }
  ledger.updateState(payload.sessionId, 'failed', {
    detail: 'saturated — exhausted retries',
    now: rt.now(),
  });
  return 1;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- subagents ---

export interface SubagentsOptions {
  tag?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seams. */
  ledger?: Ledger;
  transport?: LeafTransport;
  /** Test seam for the async rows (those with a `turnId`). */
  turns?: Pick<AsyncTurnTransport, 'readTurnState'>;
}

export async function cmdSubagents(rt: Runtime, io: Io, opts: SubagentsOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  initLedger(rt.paths.subagentsFile);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  const turns = opts.turns ?? new AsyncTurnTransport(rt.cp);
  const records = ledger.readAll().filter((r) => (opts.tag ? r.tag === opts.tag : true));
  if (records.length === 0) {
    io.err('no subagents' + (opts.tag ? ` with tag '${sanitizeRemote(opts.tag)}'` : ''));
    if (opts.json) io.out(JSON.stringify({ subagents: [] }) + '\n');
    return 0;
  }
  const views = await sweepStates(rt, { ledger, transport, turns, records, signal: opts.signal });
  if (opts.json) {
    io.out(
      JSON.stringify({
        subagents: views.map(({ record, view }) => ({
          sessionId: record.sessionId,
          tag: record.tag ?? null,
          // Only on `spawn --label` rows, so the shape of every other row is unchanged.
          ...(record.label ? { label: record.label } : {}),
          kind: record.envelope.kind,
          state: view.state,
          detail: view.detail ?? null,
          bundle: record.bundle ?? null,
          workload: record.workloadId ?? null,
          // Only on `spawn --writable` rows, so the shape of every other row is unchanged.
          ...(record.writable ? { writable: true } : {}),
          submittedAt: record.submittedAt,
        })),
      }) + '\n',
    );
    return 0;
  }
  const header = ['SESSION', 'TAG', 'LABEL', 'KIND', 'STATE', 'BUNDLE'];
  const rows = views.map(({ record, view }) => [
    sanitizeRemote(record.sessionId),
    sanitizeRemote(record.tag ?? '-'),
    sanitizeRemote(record.label ?? '-'),
    sanitizeRemote(record.envelope.kind),
    view.state + (view.detail ? ` (${sanitizeRemote(view.detail)})` : ''),
    sanitizeRemote(record.bundle ?? '-'),
  ]);
  io.out(renderTable([header, ...rows]));
  return 0;
}

// --- watch ---

export interface WatchOptions {
  tag?: string;
  json: boolean;
  /** `--since`: resume the event stream after this cursor instead of starting from now. */
  since?: string;
  signal?: AbortSignal;
  /** Test seams, as on `subagents`. */
  ledger?: Ledger;
  transport?: LeafTransport;
  turns?: Pick<AsyncTurnTransport, 'readTurnState'>;
}

/**
 * The safety-net sweep, 60 s (was 5 s, #381): the event stream reports a transition in milliseconds,
 * so the sweep is no longer how `watch` learns anything promptly. It stays because it is the only
 * thing that covers a SYNCHRONOUS row — a `spawn` without `--async` has no turn and therefore no
 * events at all — a stream the deployment does not have, and a best-effort emit the server lost.
 */
const WATCH_SWEEP_MS = 60_000;

/** Behind a call so a second check further down the loop isn't narrowed away as unreachable. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/**
 * `p`, or `undefined` once `ms` has passed or the signal fired. The timer is cleared either way: a
 * `watch` that ends on an event must not hold the process open for the rest of the sweep interval.
 */
async function within<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  // An ALREADY-aborted signal never fires `abort`, so without this the race would sit out the whole
  // interval before anyone noticed the Ctrl-C.
  if (aborted(signal)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        onAbort = () => resolve(undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Final for watching: nothing further is coming, so there is nothing left to report on this row. */
function isFinalForWatch(state: HonestState): boolean {
  // `unknown` is not `isTerminalState` — a later read could still find a result — but it is the
  // client's "no result is coming": a child that exited without writing one past the 60 s grace, or
  // a status read that failed. `watch` has to end, so it ends on the line that says so, and a
  // monitor that wants another look re-runs it.
  return isTerminalState(state) || state === 'unknown';
}

/**
 * One line per state change until every watched subagent is final. Written for a coding agent's
 * background monitor (Claude Code's Monitor tool), where each stdout line becomes one event.
 */
export async function cmdWatch(rt: Runtime, io: Io, opts: WatchOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  initLedger(rt.paths.subagentsFile);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  const turns = opts.turns ?? new AsyncTurnTransport(rt.cp);
  const match = (r: LedgerRecord): boolean => (opts.tag ? r.tag === opts.tag : true);
  if (!ledger.readAll().some(match)) {
    io.err('no subagents' + (opts.tag ? ` with tag '${sanitizeRemote(opts.tag)}'` : ''));
    return 0;
  }
  // What was last printed per session, so only changes produce a line, from EITHER source: the
  // stream and the sweep that follows it see the same transition, and that must be one line. The
  // first sweep therefore reports every row: watching a batch that is already over should say so.
  const printed = new Map<string, string>();
  const report = (record: LedgerRecord, view: StateView, cursor?: string): void => {
    const line = view.state + ' ' + (view.detail ?? '');
    if (printed.get(record.sessionId) === line) return;
    printed.set(record.sessionId, line);
    io.out(watchLine(record, view, rt.now(), opts.json, cursor));
  };

  // The stream is the primary source: one frame per transition, so a turn that starts and finishes
  // between two sweeps still gets its `running` line. A deployment without the route, or any stream
  // failure, drops `events` and `watch` behaves exactly as it did on the poll alone.
  let cursor = opts.since;
  // One opener for both the first stream and every reopen: a reopen is where a gap is LIKELIEST
  // (the cursor has been sitting out sweeps, or a whole retention window), so the note must not be
  // wired to the first open only.
  const open = (): AsyncGenerator<TurnEvent> =>
    rt.cp.streamEvents({
      ...(cursor === undefined ? {} : { since: cursor }),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onGap: (since) =>
        io.err(
          `missed events before cursor ${sanitizeRemote(since)}; state below is from a read\n`,
        ),
    });
  let events: AsyncGenerator<TurnEvent> | undefined = open();
  let pending: Promise<IteratorResult<TurnEvent>> | undefined;
  for (;;) {
    // Re-read each tick so a `spawn --tag T` from another terminal joins a running `watch --tag T`,
    // which is how a coding agent fans out: spawn some, watch, spawn more.
    const records = ledger.readAll().filter(match);
    const views = await sweepStates(rt, { ledger, transport, turns, records, signal: opts.signal });
    // A Ctrl-C lands in the in-flight read, which the sweep reports as `unknown` — final, so the
    // loop below would print it and exit 0. The signal, not the aborted read, is the answer.
    if (aborted(opts.signal)) return 130;
    for (const { record, view } of views) report(record, view);
    if (views.every(({ view }) => isFinalForWatch(view.state))) return 0;

    // Then transitions as they arrive, until the sweep interval is up.
    const byId = new Map(
      records.filter((r) => r.turnId !== undefined).map((r) => [r.sessionId, r]),
    );
    const deadline = rt.now() + WATCH_SWEEP_MS;
    while (events && rt.now() < deadline) {
      pending ??= events.next();
      let got: IteratorResult<TurnEvent> | undefined;
      try {
        got = await within(pending, deadline - rt.now(), opts.signal);
      } catch {
        // Any stream failure — an older control plane's 404, a dropped connection — is not fatal:
        // the sweep below is a complete, if slower, answer.
        events = undefined;
        pending = undefined;
        break;
      }
      if (aborted(opts.signal)) return 130;
      if (got === undefined) break; // the interval elapsed; sweep
      pending = undefined;
      if (got.done) {
        // The server caps a stream at an hour. Reopen from the last cursor on the next pass, which
        // the sweep's own pacing rate-limits; until then the sweep carries it.
        events = undefined;
        break;
      }
      // Advanced for EVERY event, including the ones skipped below: this subject's other work
      // shares the log, and a cursor that only moved over our own rows would make each reopen
      // replay up to the log's whole length of foreign events.
      cursor = got.value.cursor;
      const row = byId.get(got.value.sessionId);
      // An event for a session this `watch` does not hold, or for a different turn of a session it
      // does (a follow-up turn on the same session), is not this row's transition.
      if (!row || row.turnId !== got.value.turnId) continue;
      const view = viewFromTurnEvent(got.value);
      report(row, view, got.value.cursor);
      // Persist it, so a later `subagents` starts from what the stream already said.
      if (view.state !== row.lastKnownState || view.detail !== row.stateDetail) {
        ledger.updateState(row.sessionId, view.state, { detail: view.detail, now: rt.now() });
      }
      // This may have been the last row: sweep now rather than sit out the interval.
      if (isFinalForWatch(view.state)) break;
    }
    if (!events) {
      await rt.sleep(WATCH_SWEEP_MS, opts.signal);
      // `sleep` resolves on abort rather than rejecting, so without this the loop would go round once
      // more and turn a Ctrl-C into a full sweep of failed reads.
      if (aborted(opts.signal)) return 130;
      events = open();
    }
  }
}

/** One event: NDJSON under `--json` (same field names as `subagents --json`), else one text line. */
function watchLine(
  record: LedgerRecord,
  view: StateView,
  at: number,
  json: boolean,
  cursor?: string,
): string {
  if (json) {
    return (
      JSON.stringify({
        sessionId: record.sessionId,
        tag: record.tag ?? null,
        ...(record.label ? { label: record.label } : {}),
        kind: record.envelope.kind,
        state: view.state,
        detail: view.detail ?? null,
        // The event this line came from, for a caller that stores a cursor and resumes with
        // `--since` (#392). Null on a line the safety-net sweep produced: a read has no cursor.
        cursor: cursor ?? null,
        at,
      }) + '\n'
    );
  }
  const name = record.label ?? record.tag;
  // Padded to the longest state ('running') so the session ids line up in a terminal.
  return (
    [
      view.state.padEnd(7),
      sanitizeRemote(record.sessionId),
      name ? sanitizeRemote(name) : undefined,
      view.detail ? `(${sanitizeRemote(view.detail)})` : undefined,
    ]
      .filter((p) => p !== undefined)
      .join('  ') + '\n'
  );
}

/** A ledger row joined with the state just read for it. */
interface RowView {
  record: LedgerRecord;
  view: StateView;
}

/**
 * One state read per row — routed to whichever backend holds that leaf — mapped to an honest
 * state and persisted, so the next call starts closer to the truth. Shared by `subagents` (one
 * sweep, then render) and `watch` (a sweep per tick).
 */
async function sweepStates(
  rt: Runtime & Required<Pick<Runtime, 'cp' | 'harness'>>,
  deps: {
    ledger: Ledger;
    transport: LeafTransport;
    turns: Pick<AsyncTurnTransport, 'readTurnState'>;
    records: LedgerRecord[];
    signal?: AbortSignal;
  },
): Promise<RowView[]> {
  const now = rt.now();
  const views: RowView[] = [];
  for (const r of deps.records) {
    // Ledger is authoritative past terminal: /runs/status's 24h TTL would otherwise regress
    // `done` to `unknown` once the server-side record ages out.
    if (isTerminalState(r.lastKnownState)) {
      views.push({ record: r, view: { state: r.lastKnownState, detail: r.stateDetail } });
      continue;
    }
    // An async row counts as alive while the turn is non-terminal: the turn record IS its liveness,
    // so the 60 s child-exit grace — which exists to cover a dead child's result write — never
    // applies to one.
    const alive = r.turnId !== undefined || (r.childPid !== undefined && isAlive(r.childPid));
    const observedAt = alive ? now : r.stateObservedAt;
    let raw: LeafResultBody | 'queued';
    try {
      if (r.turnId !== undefined) {
        raw = await deps.turns.readTurnState(r.sessionId, r.turnId, deps.signal);
      } else {
        const token = await rt.cp.mintSessionToken(r.sessionId);
        raw = await deps.transport.readLeafState(r.sessionId, token.token, deps.signal);
      }
    } catch (err) {
      // One row's failure doesn't fail the list.
      views.push({ record: r, view: { state: 'unknown', detail: describeError(err) } });
      continue;
    }
    views.push({
      record: r,
      view: mapHonestState(raw, { alive, observedAt }, now, DEFAULT_UNKNOWN_GRACE_MS),
    });
  }
  // An interrupted sweep records nothing: the abort arrives in the catch above as `unknown`, and a
  // read that never finished is not an observation to persist.
  if (deps.signal?.aborted === true) return views;
  for (const { record, view } of views) {
    if (view.state !== record.lastKnownState || view.detail !== record.stateDetail) {
      deps.ledger.updateState(record.sessionId, view.state, { detail: view.detail, now });
    }
  }
  return views;
}

/** `kill(pid, 0)` liveness probe. OS pid-reuse is the known blind spot — see spec §5. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return (
    rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ')).join('\n') + '\n'
  );
}

// --- get ---

export interface GetOptions {
  sessionId: string;
  outDir?: string;
  json: boolean;
  /** `--wait`: block until the result is collectable instead of reading once. */
  wait?: boolean;
  /** How long `--wait` blocks, in whole seconds. */
  timeoutS?: number;
  signal?: AbortSignal;
  transport?: LeafTransport;
  /** Test seam; otherwise the on-disk ledger, which says which backend holds this leaf. */
  ledger?: Ledger;
  /** Test seam for an async row (one with a `turnId`). */
  turns?: Pick<AsyncTurnTransport, 'readTurnState' | 'collect'>;
}

const GET_SUMMARY_LINES = 10;
/** `--wait`'s default budget, in seconds. */
export const DEFAULT_WAIT_TIMEOUT_S = 300;
/** shortcut: fixed interval, no backoff — `--wait` exists for collect latency. Revisit if
 *  server-side run events (#392) land and the poll can become a subscription. */
const WAIT_POLL_MS = 2_000;

export async function cmdGet(rt: Runtime, io: Io, opts: GetOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!SAFE_ID_RE.test(opts.sessionId)) {
    io.err(`invalid sessionId '${sanitizeRemote(opts.sessionId)}'`);
    return 2;
  }
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  const read = await readLeafResult(rt, io, opts, transport);
  // A number is an exit code for a failure `readLeafResult` has already reported.
  if (typeof read === 'number') return read;
  const raw = read;
  if (raw === 'queued') {
    io.err(`session '${sanitizeRemote(opts.sessionId)}' has not finished yet`);
    if (opts.json) io.out(JSON.stringify({ sessionId: opts.sessionId, status: 'queued' }) + '\n');
    return 1;
  }
  const outDir = resolve(opts.outDir ?? '.');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  if (raw.text) {
    const p = join(outDir, `${opts.sessionId}.text`);
    writeFileSync(p, raw.text, { mode: 0o644 });
    written.push(p);
  }
  if (raw.verdict !== undefined) {
    const p = join(outDir, `${opts.sessionId}.verdict.json`);
    writeFileSync(p, JSON.stringify(raw.verdict, null, 2) + '\n', { mode: 0o644 });
    written.push(p);
  }
  if (raw.patch) {
    const p = join(outDir, `${opts.sessionId}.patch`);
    writeFileSync(p, raw.patch.endsWith('\n') ? raw.patch : raw.patch + '\n', { mode: 0o644 });
    written.push(p);
  }
  // `paused` is terminal but still awaiting a gate decision — exit 1.
  const completed = raw.status === 'responded' || raw.status === 'done' || raw.status === 'solved';
  const status = sanitizeRemote(raw.status);
  const reason = raw.reason ? sanitizeRemote(raw.reason) : undefined;
  const message = raw.message ? sanitizeRemote(raw.message) : undefined;
  // The gate, when it is parked at one: a caller that cannot see what was asked, and under which
  // id, cannot answer it (`mocactl approve --gate N`). Written to neither a file nor the summary --
  // two short strings and a number belong in the status, beside the status they explain.
  const gate =
    raw.gate && typeof raw.gateId === 'number'
      ? {
          gateId: raw.gateId,
          // Both strings can be absent: at `MOCA_TURN_SUMMARY_BYTES=0` the control plane drops them
          // and keeps the id. The id is the part a decision needs, so report the gate either way
          // rather than hide it -- and never hand `sanitizeRemote` an undefined.
          summary: sanitizeRemote(raw.gate.summary ?? ''),
          proposed_action: sanitizeRemote(raw.gate.proposed_action ?? ''),
        }
      : undefined;
  if (opts.json) {
    io.out(
      JSON.stringify({
        sessionId: opts.sessionId,
        status,
        files: written,
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
        ...(gate ? { gate } : {}),
      }) + '\n',
    );
    return completed ? 0 : 1;
  }
  io.err(`status  ${status}`);
  if (reason) io.err(`reason  ${reason}`);
  if (message && message !== reason) io.err(`detail  ${message}`);
  if (gate) {
    io.err(`gate    ${gate.gateId}${gate.summary ? `  ${gate.summary}` : ''}`);
    if (gate.proposed_action) io.err(`propose ${gate.proposed_action}`);
    io.err(`answer  mocactl approve ${opts.sessionId}  (or reject, with --feedback)`);
  }
  for (const p of written) io.err(`wrote   ${p}`);
  const summaryBody = raw.text ?? raw.patch ?? '';
  if (summaryBody) {
    const head = summaryBody.split('\n').slice(0, GET_SUMMARY_LINES).join('\n');
    io.out(sanitizeRemote(head) + (head.includes('\n') ? '\n' : ''));
  }
  return completed ? 0 : 1;
}

/**
 * One status read, or — under `--wait` — polls until the session has a record, the ledger says no
 * record is coming, or the timeout runs out. Returns the body, `'queued'` (nothing to collect,
 * which `cmdGet` reports as it always has) or an exit code for a reported failure.
 */
async function readLeafResult(
  rt: Runtime & Required<Pick<Runtime, 'cp' | 'harness'>>,
  io: Io,
  opts: GetOptions,
  transport: LeafTransport,
): Promise<LeafResultBody | 'queued' | number> {
  const deadline = rt.now() + (opts.timeoutS ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
  // The row says which backend holds this leaf, so it is read whether or not we are waiting.
  // shortcut: the sessionId may well not be ours (another machine spawned it), in which case there
  // is no row and this reads the sync path — an async turn spawned elsewhere is invisible to `get`.
  // Revisit with `get --turn ID`, or by asking the control plane for the session's turns.
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const record = ledger.find(opts.sessionId);
  const turnId = record?.turnId;
  let token: SessionToken | undefined;
  const read = async (): Promise<LeafResultBody | 'queued'> => {
    if (turnId !== undefined) {
      const turns = opts.turns ?? new AsyncTurnTransport(rt.cp);
      const body = await turns.readTurnState(opts.sessionId, turnId, opts.signal);
      // The bytes are fetched once, on the read that found a result: `get` writes them to files,
      // and a poll that is still `queued` has nothing to fetch.
      return body === 'queued' ? body : turns.collect(opts.sessionId, turnId, body, opts.signal);
    }
    // Session tokens default to a 300 s TTL (SH_SESSION_TOKEN_TTL_SECONDS) — the same as
    // `--wait`'s default budget — so one mint up front would expire mid-wait.
    if (token === undefined || rt.now() / 1000 >= token.expiresAt - 30) {
      token = await rt.cp.mintSessionToken(opts.sessionId);
    }
    return transport.readLeafState(opts.sessionId, token.token, opts.signal);
  };
  for (;;) {
    let raw: LeafResultBody | 'queued';
    try {
      raw = await read();
    } catch (err) {
      // Ctrl-C mid-read: the transport wraps the abort as a network error, which is not worth
      // printing when the user is the one who stopped it.
      if (opts.signal?.aborted === true) return 130;
      // Match on code, not bare status: a route/auth 404 should surface its real error.
      if (err instanceof ApiError && err.status === 404 && err.code === 'session_not_found') {
        io.err(`no session '${sanitizeRemote(opts.sessionId)}'`);
        return 1;
      }
      io.err(describeError(err));
      return 1;
    }
    if (raw !== 'queued') {
      // Record what we just read, for an async row. `cmdSubagents`'s persist loop is otherwise the
      // only writer of a turn's state, so a subagent collected with `get` would go on holding its
      // `--max-concurrent` slot — the `spawn --async` ×N, `get` each, spawn more workflow would
      // refuse at the cap with every one of those subagents already done (#922 review). The sync
      // path needs none of this: the detached worker records its own outcome.
      if (record?.turnId !== undefined) {
        const view = terminalFromBody(raw);
        if (view.state !== record.lastKnownState || view.detail !== record.stateDetail) {
          ledger.updateState(opts.sessionId, view.state, { detail: view.detail, now: rt.now() });
        }
      }
      return raw;
    }
    if (!opts.wait) return raw;
    const hopeless = record && noResultComing(record, rt.now());
    if (hopeless) {
      const detail = sanitizeRemote(hopeless);
      io.err(`session '${sanitizeRemote(opts.sessionId)}' will not produce a result — ${detail}`);
      if (opts.json) {
        io.out(JSON.stringify({ sessionId: opts.sessionId, status: 'unknown', detail }) + '\n');
      }
      return 1;
    }
    // Checked before sleeping so the wait never overruns the budget.
    if (rt.now() + WAIT_POLL_MS > deadline) return 'queued';
    await rt.sleep(WAIT_POLL_MS, opts.signal);
    // `sleep` resolves on abort rather than rejecting, so without this the loop would go round
    // once more and turn a Ctrl-C into a mint plus a failed read.
    if (opts.signal?.aborted === true) return 130;
  }
}

// --- approve / reject ---

const past = (action: 'approve' | 'reject'): string =>
  action === 'approve' ? 'approved' : 'rejected';

export interface DecideOptions {
  sessionId: string;
  /** `abort` is deliberately absent: ending a subagent is `mocactl cancel`'s job, not a decision's. */
  action: 'approve' | 'reject';
  /** `--gate N`. Omitted means "read the pending gate's id off the paused result". */
  gateId?: number;
  /** Reaches the model verbatim as part of the resumed turn's prompt. */
  feedback?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seams, as `cmdGet`'s. */
  ledger?: Ledger;
  transport?: LeafTransport;
  turns?: Pick<AsyncTurnTransport, 'readTurnState' | 'collect'>;
  /** Test seam for the sync path's resume worker; the same contract as `spawn`'s. */
  forkFn?: (
    sessionId: string,
    token: string,
    envelope: LeafEnvelope,
    cwd: string,
  ) => number | Promise<number>;
}

/**
 * `mocactl approve|reject SESSIONID`: answer the gate a subagent is parked at, so it carries on
 * (#393). The two words are one command: the action is the only thing that differs.
 *
 * Two resume paths, chosen by the ledger row, because the two dispatch backends park a gate in
 * different places and neither route can resolve the other's:
 * - an async row (`spawn --async`) has a turn record, so `POST /v1/sessions/{id}/decision` resolves
 *   it: the control plane copies the envelope and queues the resume, and no session token is needed;
 * - a sync row re-sends its stored envelope with the decision inline (ADR-0020) from the same
 *   detached worker `spawn` uses, so the resumed leaf outlives this command as the first one did.
 */
export async function cmdDecide(rt: Runtime, io: Io, opts: DecideOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  if (!SAFE_ID_RE.test(opts.sessionId)) {
    io.err(`invalid sessionId '${sanitizeRemote(opts.sessionId)}'`);
    return 2;
  }
  // Checked here, not only server-side: the sync path's harness does not bound it at all, and the
  // same text must be refused on both backends or `--feedback` means two different things.
  if (
    opts.feedback !== undefined &&
    Buffer.byteLength(opts.feedback, 'utf8') > GATE_FEEDBACK_BYTES
  ) {
    io.err(
      `--feedback is too large (max ${GATE_FEEDBACK_BYTES} bytes); it goes to the model as part ` +
        'of the resumed turn, so say less',
    );
    return 2;
  }
  initLedger(rt.paths.subagentsFile);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile, rt.now);
  const record = ledger.find(opts.sessionId);

  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  // A row with no turn record was dispatched synchronously, and resumes by re-sending its envelope.
  const syncRow = record !== undefined && record.turnId === undefined ? record : undefined;
  // A live child means the leaf has not parked: either it has not reached its first gate, or a
  // decision already answered this one and its resume is still running. The read below cannot tell
  // the second case apart on its own -- `/runs/status` serves the PAUSED record for the whole life
  // of the resume, because the sync worker writes its result only when the leaf returns (#1010
  // review). Gated on a live child rather than on the row's state alone, so a worker that died
  // before writing a result still falls through and leaves the gate answerable.
  // shortcut: this is a read-then-act on a lock-free ledger, so two decisions started at once
  // (`mocactl approve S & mocactl approve S`) can both pass it and both resume the leaf -- the row
  // only turns `running` inside `resumeSyncRow`, after the fork. It closes the sequential case,
  // which is the one a human hits. Upgrade when the harness makes a gate decision idempotent on the
  // sync path too (the async path already keys on `${sessionId}:gate:${gateId}`); moving the row
  // write earlier narrows the window without closing it.
  if (
    syncRow !== undefined &&
    syncRow.lastKnownState !== 'paused' &&
    syncRow.childPid !== undefined &&
    isAlive(syncRow.childPid)
  ) {
    io.err(
      `session '${sanitizeRemote(opts.sessionId)}' has a run in flight (pid ${syncRow.childPid}); ` +
        'a gate can only be answered while the subagent is parked at it',
    );
    return 1;
  }
  let gateId = opts.gateId;
  // Read it rather than ask for it: at most one gate of a session is pending at a time, so the
  // paused result names it exactly. `--gate N` is for the session whose result cannot be read --
  // one spawned on another machine, or already aged out of the result store.
  //
  // The sync path reads even when `--gate` names the gate, because nothing downstream checks it:
  // the harness answers a decision for an already-answered gate by re-running the STORED
  // decision's continuation (`gate.ts` `decideSeed`), so a repeat or a contradiction would act
  // without a human's answer. The async path needs no read -- the control plane compares the id
  // with the pending one itself and 409s on a mismatch.
  // shortcut: a sync row whose result aged out of the store can no longer be answered with
  // --gate N, because this read is what makes the id trustworthy. Upgrade by carrying the pending
  // gate id in the ledger row if the result store's TTL turns out to be shorter than a gate's life.
  if (gateId === undefined || syncRow !== undefined) {
    const read = await readLeafResult(
      rt,
      io,
      {
        sessionId: opts.sessionId,
        json: false,
        signal: opts.signal,
        ledger,
        transport,
        turns: opts.turns,
      },
      transport,
    );
    if (typeof read === 'number') return read;
    const status = read === 'queued' ? 'queued' : read.status;
    const pending = read === 'queued' ? undefined : read.gateId;
    if (status !== 'paused' || typeof pending !== 'number') {
      io.err(
        `session '${sanitizeRemote(opts.sessionId)}' is ${sanitizeRemote(status)}, not paused at ` +
          'a gate' +
          (syncRow !== undefined ? '' : '; pass --gate N to answer a gate this client cannot read'),
      );
      return 1;
    }
    // Same wording as the control plane's 409, so the two backends refuse a stale --gate alike.
    if (gateId !== undefined && gateId !== pending) {
      io.err(`gate ${gateId} is not pending; this session is paused at gate ${pending}`);
      return 1;
    }
    gateId = pending;
  }
  const decision = {
    gateId,
    action: opts.action,
    ...(opts.feedback !== undefined ? { feedback: opts.feedback } : {}),
  };

  if (syncRow !== undefined) {
    return resumeSyncRow(rt, io, opts, ledger, syncRow, decision);
  }
  try {
    const { turnId } = await rt.cp.decideGate(opts.sessionId, decision);
    // Re-point the row at the resume: the answered turn stays `paused` for good, so a row still
    // naming it would report `paused` to `subagents` and `get` after a decision that worked.
    if (record) {
      ledger.updateState(opts.sessionId, 'running', {
        detail: `${past(opts.action)} gate ${gateId}`,
        turnId,
        now: rt.now(),
      });
    }
    report(io, opts, gateId, { turnId });
    return 0;
  } catch (err) {
    io.err(describeError(err));
    // The commonest cause by far: a sync-dispatched subagent has no turn record for the route to
    // find, and its envelope lives only in the ledger of the machine that spawned it.
    if (err instanceof ApiError && err.code === 'gate_not_pending' && record === undefined) {
      io.err(
        'a subagent spawned without --async is resumed from the machine that spawned it, which ' +
          'holds its envelope',
      );
    }
    return 1;
  }
}

/** The sync path's resume: the stored envelope plus the decision, in a fresh detached worker. */
async function resumeSyncRow(
  rt: Runtime & Required<Pick<Runtime, 'cp' | 'harness'>>,
  io: Io,
  opts: DecideOptions,
  ledger: Ledger,
  record: LedgerRecord,
  decision: NonNullable<LeafEnvelope['decision']>,
): Promise<number> {
  const envelope = resumeEnvelope(opts.sessionId, record.envelope, decision);
  if (envelope === undefined) {
    io.err(
      `the ledger row for '${sanitizeRemote(opts.sessionId)}' has kind ` +
        `'${sanitizeRemote(record.envelope.kind)}', which this client cannot resume`,
    );
    return 1;
  }
  let token: string;
  try {
    token = (await rt.cp.mintSessionToken(opts.sessionId)).token;
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
  // Resolved in the parent so the child never re-discovers, exactly as `spawn` does.
  let resolvedHarnessUrl: string | undefined;
  try {
    resolvedHarnessUrl = await rt.harness.baseUrl();
  } catch {
    resolvedHarnessUrl = rt.endpoints.harnessUrl;
  }
  const forkFn =
    opts.forkFn ??
    ((sid, tok, env, cwd) => defaultFork(sid, tok, env, cwd, rt, resolvedHarnessUrl));
  let pid: number;
  try {
    pid = await forkFn(opts.sessionId, token, envelope, rt.paths.stateDir);
  } catch (err) {
    // The gate is still pending — nothing was sent — so the row stays `paused` and the decision can
    // be made again once whatever stopped the fork is fixed.
    io.err(describeError(err));
    return 1;
  }
  ledger.updateState(opts.sessionId, 'running', {
    detail: `${past(opts.action)} gate ${decision.gateId}`,
    childPid: pid,
    now: rt.now(),
  });
  report(io, opts, decision.gateId, { pid });
  return 0;
}

/**
 * The stored envelope as a resume submission. `requireApproval` is not re-sent: `decision` alone
 * arms the harness's gate path and registers `request_approval`, so a rejected leaf can park again.
 */
function resumeEnvelope(
  sessionId: string,
  stored: LedgerEnvelope,
  decision: NonNullable<LeafEnvelope['decision']>,
): LeafEnvelope | undefined {
  const base = {
    sessionId,
    decision,
    ...(stored.configRef ? { configRef: stored.configRef } : {}),
  };
  if (stored.kind === 'prompt') {
    return {
      ...base,
      kind: 'prompt',
      prompt: stored.prompt ?? '',
      ...(stored.workloadId ? { workloadId: stored.workloadId } : {}),
      ...(stored.contextWritable ? { contextWritable: true } : {}),
    };
  }
  if (stored.kind === 'solve' && stored.repoUrl && stored.ref) {
    return {
      ...base,
      kind: 'solve',
      problemStatement: stored.prompt ?? '',
      repoUrl: stored.repoUrl,
      ref: stored.ref,
    };
  }
  // A legacy `converge` row, or a solve row missing its repo: the harness would refuse the
  // submission, so say so here rather than fork a worker that only fails.
  return undefined;
}

function report(
  io: Io,
  opts: DecideOptions,
  gateId: number,
  how: { turnId: string } | { pid: number },
): void {
  const where = 'turnId' in how ? `turn ${how.turnId}` : `pid ${how.pid}`;
  io.err(`${past(opts.action)} gate ${gateId} on ${opts.sessionId}  (${where})`);
  if (opts.json) {
    io.out(
      JSON.stringify({ sessionId: opts.sessionId, gateId, action: opts.action, ...how }) + '\n',
    );
  } else {
    io.out(`${opts.sessionId}\n`);
  }
}

/**
 * Why no record will ever arrive for this ledger row, or undefined if one still might. Keeps
 * `--wait` from sitting out its whole budget on a subagent that is already over — the two cases
 * being a row that went terminal client-side (a fork failure, say) and a child that exited
 * without writing a result. The ledger is authoritative past terminal for the same reason it is
 * in `cmdSubagents`: the server's record ages out, the row does not.
 */
function noResultComing(record: LedgerRecord, now: number): string | undefined {
  if (isTerminalState(record.lastKnownState)) {
    const detail = record.stateDetail ? ` (${record.stateDetail})` : '';
    return `the ledger has it ${record.lastKnownState}${detail}`;
  }
  // An async row has no child: the turn state the caller just read is its liveness, and a turn that
  // is going nowhere ends as `lost` rather than as a dead pid.
  if (record.turnId !== undefined) return undefined;
  if (record.childPid === undefined || isAlive(record.childPid)) return undefined;
  // Same liveness + grace mapping `cmdSubagents` applies, so both commands agree on `unknown`.
  const view = mapHonestState('queued', { alive: false, observedAt: record.stateObservedAt }, now);
  return view.state === 'unknown' ? (view.detail ?? 'child exited with no result') : undefined;
}
