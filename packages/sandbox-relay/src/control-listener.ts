import { timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { status } from '@grpc/grpc-js';
import { ReleaseOutcome, type ReleaseResult } from '@moca/k8s-sandbox';
import { credentialValue } from '@moca/control-plane';
import type { Relay } from './relay.js';
import {
  RELEASE_TIMEOUT_MS,
  makeAudit,
  releaseErrorStatus,
  type ReleaseAuditOutcome,
} from './sandbox-caller.js';

/**
 * The relay's control listener (#338): a small HTTP server, off unless MOCA_RELAY_CONTROL_ADDR is
 * set, with ONE route, `POST /v1/release {worker, workspaceKey}`, for the control plane to release
 * an ended sandbox's (or session's) workspace on its worker. It is the control plane's only way to
 * reach a worker: the exec listener admits only the supervisor (and on the sandbox profile is bound
 * to loopback behind its TLS sidecar), and the control plane holds no gRPC client.
 *
 * Authorized by MOCA_RELAY_RELEASE_TOKEN alone, a bearer that can do nothing else: it is no exec,
 * attach or sandbox token, and every other route answers 404 whoever asks. The release goes through
 * the same routing a sandbox's own Release takes (Relay.routeRelease), so the worker check, the
 * capability check and the timeout are the same. The answer names the worker's ack, or
 * `release_unsupported` for a worker that predates release, so the control plane can record the
 * outcome; anything else is a status the caller treats as "not answered" and may retry.
 */

/** The release-only bearer's name: a credential file under CREDENTIALS_DIRECTORY, else the env. */
export const RELEASE_TOKEN_VAR = 'MOCA_RELAY_RELEASE_TOKEN';
/** A bearer in an HTTP header, as the control plane's janitor token: at least 32 characters. */
export const MIN_RELEASE_TOKEN_LENGTH = 32;
/** The one route. */
export const RELEASE_PATH = '/v1/release';
/** The request body's ceiling: two short strings. */
export const MAX_CONTROL_BODY_BYTES = 4096;
/** Releases in flight on the control listener: a sweep's batch is bounded on the control plane's side too. */
export const CONTROL_RELEASE_MAX_INFLIGHT = 16;

/** The terminal answers (the worker's acks and `release_unsupported`), as the response body names them. */
export type ControlReleaseOutcome =
  'released' | 'kept_busy' | 'unknown_key' | 'release_unsupported';

/** Sandbox ids the token directory holds: the shell-variable rule main.ts's validator uses. */
const SANDBOX_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The release bearer's check, built at boot when the control listener is on. FAIL-CLOSED: without
 * MOCA_RELAY_RELEASE_TOKEN, or with one under MIN_RELEASE_TOKEN_LENGTH, it throws and the relay does
 * not boot. It must differ from every other bearer the relay holds -- MOCA_RELAY_EXEC_TOKEN,
 * SH_RELAY_TOKEN, every SH_RELAY_TOKEN_<id> and every file in SH_RELAY_TOKEN_DIR -- or the relay
 * refuses to boot, naming the variables (or the directory entries), never the value: a worker's
 * attach token or the harness's exec token that also released workspaces would break the
 * separation this bearer exists for. Constant-time, length-checked first. Returns the value too,
 * so the attach validator can refuse a directory token added after boot that equals it.
 */
export function makeReleaseTokenValidator(
  env: NodeJS.ProcessEnv,
  deps: { readDir?: (path: string) => string[]; readFile?: (path: string) => string } = {},
): { token: string; validate: (presented: string | undefined) => boolean } {
  const token = credentialValue(env, RELEASE_TOKEN_VAR);
  if (!token) {
    throw new Error(
      `${RELEASE_TOKEN_VAR} is required with MOCA_RELAY_CONTROL_ADDR: the control listener refuses unauthenticated releases`,
    );
  }
  if (token.length < MIN_RELEASE_TOKEN_LENGTH) {
    throw new Error(`${RELEASE_TOKEN_VAR} must be at least ${MIN_RELEASE_TOKEN_LENGTH} characters`);
  }
  const clashes = Object.keys(env)
    .filter(
      (k) =>
        (k === 'MOCA_RELAY_EXEC_TOKEN' ||
          k === 'SH_RELAY_TOKEN' ||
          k.startsWith('SH_RELAY_TOKEN_')) &&
        k !== 'SH_RELAY_TOKEN_DIR' &&
        env[k] === token,
    )
    .sort();
  const dir = env.SH_RELAY_TOKEN_DIR;
  if (dir) {
    const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
    const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    let ids: string[] = [];
    try {
      ids = readDir(dir).filter((id) => SANDBOX_ID_RE.test(id));
    } catch (e) {
      // No directory is no tokens (the mount is optional); anything else is a boot error.
      if ((e as { code?: string }).code !== 'ENOENT') {
        throw new Error(
          `SH_RELAY_TOKEN_DIR is unreadable, so ${RELEASE_TOKEN_VAR} cannot be checked against it`,
        );
      }
    }
    for (const id of ids.sort()) {
      let v: string;
      try {
        v = readFile(`${dir}/${id}`).replace(/\n$/, '');
      } catch {
        continue; // removed since the listing, or unreadable: the attach validator refuses it anyway
      }
      if (v === token) clashes.push(`SH_RELAY_TOKEN_DIR/${id}`);
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      `${RELEASE_TOKEN_VAR} must differ from every other relay bearer, but equals ${clashes.join(', ')}`,
    );
  }
  const want = Buffer.from(token);
  return {
    token,
    validate: (presented) => {
      if (!presented) return false;
      const got = Buffer.from(presented);
      return got.length === want.length && timingSafeEqual(got, want);
    },
  };
}

export interface ControlListenerOpts {
  validate: (presented: string | undefined) => boolean;
  /** How long a release waits for the worker. Defaults to RELEASE_TIMEOUT_MS; tests set a short one. */
  timeoutMs?: number;
  /** Where the audit lines go. Defaults to stdout. */
  log?: (line: string) => void;
  /** At most one refused-bearer line per this many ms. Defaults to REFUSED_LOG_INTERVAL_MS. */
  refusedLogIntervalMs?: number;
}

/**
 * Refused-bearer lines, at most one per minute: anyone who can reach the port can send bad bearers
 * as fast as it likes, and each would otherwise be a line. The next line counts the refusals it
 * stood for (`suppressed`), so none goes unrecorded; the bearer itself is never logged.
 */
export const REFUSED_LOG_INTERVAL_MS = 60_000;

/** One answer: the HTTP status, the JSON body, and the audit line's outcome and reason. */
interface Answer {
  code: number;
  body: Record<string, unknown>;
  outcome: ReleaseAuditOutcome;
  reason?: string;
}

const OUTCOMES: Partial<Record<ReleaseOutcome, 'released' | 'kept_busy' | 'unknown_key'>> = {
  [ReleaseOutcome.RELEASE_OUTCOME_RELEASED]: 'released',
  [ReleaseOutcome.RELEASE_OUTCOME_KEPT_BUSY]: 'kept_busy',
  [ReleaseOutcome.RELEASE_OUTCOME_UNKNOWN_KEY]: 'unknown_key',
};

const unsupported = (reason: string): Answer => ({
  code: 200,
  body: { outcome: 'release_unsupported' },
  outcome: 'unsupported',
  reason,
});

/** The worker's ReleaseResult as an answer: an ack is 200, an error the status its prefix names. */
function answerOf(r: ReleaseResult): Answer {
  if (r.error) {
    const code = releaseErrorStatus(r.error);
    if (code === status.FAILED_PRECONDITION) return unsupported(r.error);
    // Busy is the worker's to retry later; a refused key or anything else is a failed release.
    return code === status.RESOURCE_EXHAUSTED
      ? { code: 503, body: { error: 'busy', message: r.error }, outcome: 'busy', reason: r.error }
      : {
          code: 502,
          body: { error: 'failed', message: r.error },
          outcome: 'failed',
          reason: r.error,
        };
  }
  const outcome = OUTCOMES[r.outcome];
  if (!outcome) {
    const message = `the worker answered an unknown release outcome (${r.outcome})`;
    return { code: 502, body: { error: 'failed', message }, outcome: 'failed', reason: message };
  }
  return { code: 200, body: { outcome }, outcome };
}

/** routeRelease's rejection as an answer, by its gRPC code (Relay.routeRelease). */
function refusalOf(err: unknown): Answer {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case status.FAILED_PRECONDITION: // a worker without RELEASE_CAPABILITY
      return unsupported(message);
    case status.DEADLINE_EXCEEDED:
      return {
        code: 504,
        body: { error: 'timeout', message },
        outcome: 'timeout',
        reason: message,
      };
    case status.CANCELLED:
      return {
        code: 499,
        body: { error: 'cancelled', message },
        outcome: 'cancelled',
        reason: message,
      };
    case status.PERMISSION_DENIED: // the relay's workload check
      return {
        code: 403,
        body: { error: 'refused', message },
        outcome: 'refused',
        reason: message,
      };
    default: // no live worker, a disconnect, a write that failed
      return {
        code: 503,
        body: { error: 'unavailable', message },
        outcome: 'error',
        reason: message,
      };
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const v = req.headers.authorization;
  return typeof v === 'string' && v.startsWith('Bearer ') ? v.slice('Bearer '.length) : undefined;
}

function send(
  res: ServerResponse,
  code: number,
  body: Record<string, unknown>,
  headers = {},
): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * The body, at most MAX_CONTROL_BODY_BYTES; `too_large` past that (the rest is not kept, and the
 * caller answers 413 before closing), `broken` on a request that broke off.
 */
function readBody(req: IncomingMessage): Promise<string | 'too_large' | 'broken'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      n += c.length;
      if (n > MAX_CONTROL_BODY_BYTES) {
        over = true;
        resolve('too_large');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve('broken'));
  });
}

/** `{worker, workspaceKey}`, both non-empty strings, or the reason it is not. */
function parseRelease(text: string): { worker: string; workspaceKey: string } | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return 'the body is not JSON';
  }
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.worker !== 'string' || o.worker === '') return 'worker must be a non-empty string';
  if (typeof o.workspaceKey !== 'string' || o.workspaceKey === '') {
    return 'workspaceKey must be a non-empty string';
  }
  return { worker: o.worker, workspaceKey: o.workspaceKey };
}

/**
 * The control listener over `relay`. Answers, all JSON: 200 `{outcome}` with `released`,
 * `kept_busy`, `unknown_key` or `release_unsupported` (terminal: the control plane records it);
 * 401 a missing or wrong bearer; 400 a malformed body; 413 a body over the ceiling; 404 any other
 * path; 405 another method; 503 `busy` (the in-flight cap, or the worker's own) or `unavailable`
 * (no live worker, a disconnect); 504 the worker's silence past the timeout; 403 a workload
 * sandbox's worker; 502 a worker that refused the release. One audit line per authorized call;
 * refused bearers at most one line per REFUSED_LOG_INTERVAL_MS, counting the rest; the bearer
 * itself is never logged.
 */
export function buildControlServer(relay: Relay, opts: ControlListenerOpts): HttpServer {
  const audit = makeAudit(opts.log ?? ((l: string) => console.log(l)), false);
  const timeoutMs = opts.timeoutMs ?? RELEASE_TIMEOUT_MS;
  let inflight = 0;
  const refusedEveryMs = opts.refusedLogIntervalMs ?? REFUSED_LOG_INTERVAL_MS;
  let refusedLoggedAt = -Infinity;
  let refusedSuppressed = 0;
  return createServer((req, res) => {
    const t0 = Date.now();
    const path = (req.url ?? '').split('?')[0];
    if (path !== RELEASE_PATH) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    if (!opts.validate(bearer(req))) {
      if (t0 - refusedLoggedAt >= refusedEveryMs) {
        audit.release(t0, {
          via: 'control',
          wrk: '',
          outcome: 'refused',
          reason: 'release authentication failed',
          ...(refusedSuppressed > 0 ? { suppressed: refusedSuppressed } : {}),
        });
        refusedLoggedAt = t0;
        refusedSuppressed = 0;
      } else {
        refusedSuppressed++;
      }
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    void (async () => {
      const text = await readBody(req);
      if (text === 'broken') return;
      if (text === 'too_large') {
        // Answered first, then the connection closed: destroyed before the answer, the caller
        // would see a reset rather than the 413.
        res.on('finish', () => req.destroy());
        send(
          res,
          413,
          { error: 'invalid_request', message: 'the body is too large' },
          { connection: 'close' },
        );
        return;
      }
      const parsed = parseRelease(text);
      if (typeof parsed === 'string') {
        send(res, 400, { error: 'invalid_request', message: parsed });
        return;
      }
      const line = (a: Answer) =>
        audit.release(t0, {
          via: 'control',
          wrk: parsed.worker,
          outcome: a.outcome,
          ...(a.reason !== undefined ? { reason: a.reason } : {}),
        });
      if (inflight >= CONTROL_RELEASE_MAX_INFLIGHT) {
        const message = `busy: ${inflight} releases already in flight`;
        line({ code: 503, body: {}, outcome: 'busy', reason: message });
        send(res, 503, { error: 'busy', message });
        return;
      }
      inflight++;
      // A caller that goes away withdraws its release, as a cancelled gRPC call does.
      const gone = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) gone.abort();
      };
      res.on('close', onClose);
      let a: Answer;
      try {
        a = answerOf(
          await relay.routeRelease(parsed.worker, parsed.workspaceKey, timeoutMs, gone.signal),
        );
      } catch (err) {
        a = refusalOf(err);
      } finally {
        inflight--;
      }
      line(a);
      send(res, a.code, a.body);
    })();
  });
}

/** `host:port` (an IPv6 host in brackets) for listen(), or a boot error naming the variable. */
export function parseControlAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(':');
  const host = addr.slice(0, i).replace(/^\[(.*)\]$/, '$1');
  const raw = addr.slice(i + 1);
  const port = Number(raw);
  if (i <= 0 || !host || !/^[0-9]+$/.test(raw) || !Number.isInteger(port) || port > 65535) {
    throw new Error('MOCA_RELAY_CONTROL_ADDR must be host:port');
  }
  return { host, port };
}

/** Listen on `addr`; resolves with the bound port. */
export function listenControl(server: HttpServer, addr: string): Promise<number> {
  const { host, port } = parseControlAddr(addr);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    });
  });
}
