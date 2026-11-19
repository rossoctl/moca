/** `mocactl spawn | subagents | get`, built on the leaf-turn transport and subagent ledger. */
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiError } from './api/errors.js';
import { validWorkloadId, WorkloadsClient } from './api/workloads.js';
import type { ControlPlaneApi, CreateSessionRequest, SessionToken } from './api/types.js';
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
import {
  DEFAULT_UNKNOWN_GRACE_MS,
  LeafTransport,
  isTerminalState,
  mapHonestState,
  terminalFromBody,
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
  const running = ledger
    .readAll()
    .filter((r) => !isTerminalState(r.lastKnownState) && r.childPid !== undefined)
    .filter((r) => isAlive(r.childPid!));
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
  // Record before fork so a crash in between leaves a durable row to recover from.
  const record: LedgerRecord = {
    sessionId: session.sessionId,
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
}

export async function cmdSubagents(rt: Runtime, io: Io, opts: SubagentsOptions): Promise<number> {
  if (!requireReady(rt, io)) return 2;
  initLedger(rt.paths.subagentsFile);
  const ledger = opts.ledger ?? openLedger(rt.paths.subagentsFile);
  const transport = opts.transport ?? new LeafTransport(rt.harness, rt.fetchImpl);
  const records = ledger.readAll().filter((r) => (opts.tag ? r.tag === opts.tag : true));
  if (records.length === 0) {
    io.err('no subagents' + (opts.tag ? ` with tag '${sanitizeRemote(opts.tag)}'` : ''));
    if (opts.json) io.out(JSON.stringify({ subagents: [] }) + '\n');
    return 0;
  }
  const now = rt.now();
  const views: Array<{ record: LedgerRecord; view: StateView }> = [];
  for (const r of records) {
    // Ledger is authoritative past terminal: /runs/status's 24h TTL would otherwise regress
    // `done` to `unknown` once the server-side record ages out.
    if (isTerminalState(r.lastKnownState)) {
      views.push({ record: r, view: { state: r.lastKnownState, detail: r.stateDetail } });
      continue;
    }
    const alive = r.childPid !== undefined && isAlive(r.childPid);
    const observedAt = alive ? now : r.stateObservedAt;
    let raw: LeafResultBody | 'queued';
    try {
      const token = await rt.cp.mintSessionToken(r.sessionId);
      raw = await transport.readLeafState(r.sessionId, token.token, opts.signal);
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
  // Persist any state changes so the next `subagents` call starts closer to the truth.
  for (const { record, view } of views) {
    if (view.state !== record.lastKnownState || view.detail !== record.stateDetail) {
      ledger.updateState(record.sessionId, view.state, { detail: view.detail, now });
    }
  }
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
  /** Test seam; otherwise the on-disk ledger, consulted only under `--wait`. */
  ledger?: Ledger;
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
  if (opts.json) {
    io.out(
      JSON.stringify({
        sessionId: opts.sessionId,
        status,
        files: written,
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
      }) + '\n',
    );
    return completed ? 0 : 1;
  }
  io.err(`status  ${status}`);
  if (reason) io.err(`reason  ${reason}`);
  if (message && message !== reason) io.err(`detail  ${message}`);
  for (const p of written) io.err(`wrote   ${p}`);
  const summaryBody = raw.text ?? raw.patch ?? '';
  if (summaryBody) {
    const head = summaryBody.split('\n').slice(0, GET_SUMMARY_LINES).join('\n');
    io.out(sanitizeRemote(head) + (head.includes('\n') ? '\n' : ''));
  }
  return completed ? 0 : 1;
}

/**
 * One `/runs/status` read, or — under `--wait` — polls until the session has a record, the ledger
 * says no record is coming, or the timeout runs out. Returns the body, `'queued'` (nothing to
 * collect, which `cmdGet` reports as it always has) or an exit code for a reported failure.
 */
async function readLeafResult(
  rt: Runtime & Required<Pick<Runtime, 'cp' | 'harness'>>,
  io: Io,
  opts: GetOptions,
  transport: LeafTransport,
): Promise<LeafResultBody | 'queued' | number> {
  const deadline = rt.now() + (opts.timeoutS ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
  // The sessionId may well not be ours (another machine spawned it), in which case there is no row
  // and `--wait` just polls to the deadline.
  const record = opts.wait
    ? (opts.ledger ?? openLedger(rt.paths.subagentsFile)).find(opts.sessionId)
    : undefined;
  let token: SessionToken | undefined;
  for (;;) {
    let raw: LeafResultBody | 'queued';
    try {
      // Session tokens default to a 300 s TTL (SH_SESSION_TOKEN_TTL_SECONDS) — the same as
      // `--wait`'s default budget — so one mint up front would expire mid-wait.
      if (token === undefined || rt.now() / 1000 >= token.expiresAt - 30) {
        token = await rt.cp.mintSessionToken(opts.sessionId);
      }
      raw = await transport.readLeafState(opts.sessionId, token.token, opts.signal);
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
    if (raw !== 'queued' || !opts.wait) return raw;
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
  if (record.childPid === undefined || isAlive(record.childPid)) return undefined;
  // Same liveness + grace mapping `cmdSubagents` applies, so both commands agree on `unknown`.
  const view = mapHonestState('queued', { alive: false, observedAt: record.stateObservedAt }, now);
  return view.state === 'unknown' ? (view.detail ?? 'child exited with no result') : undefined;
}
