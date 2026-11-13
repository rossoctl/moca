import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { SseParser } from '../api/sse-parser.js';

/**
 * `--record F`: one NDJSON line per HTTP attempt a command makes, so a script that drives mocactl
 * can keep a record of every call without an HTTP client of its own. Each line: the command and an
 * invocation id, `seq` (the line's number in this invocation) and `try` (1, 2, … for the same
 * method and path in a row: a retry), the method, the path (never the base URL or host), the status
 * or the transport error, the request and answer bodies, their times (UTC, ms) and the Retry-After.
 *
 * NO SECRET reaches the file: a token-named field and a gate record are replaced by their sha256,
 * and so is any string value, under any name, that looks like a JWT or a refresh token, so a token
 * field the API adds later is caught here. Host identifiers and free text (execEndpoint, execCa, a
 * proxy's dial_addr, a log, a reason's message) are replaced by their length.
 *
 * A streamed answer (SSE or NDJSON: a turn, an export) is never held back: its line is written
 * when the headers arrive (`stream: true`), the body passes through unchanged, and a `stream_end`
 * line for the same seq gives its bytes, their sha256 and the frames counted, never a frame's
 * contents.
 *
 * `mocactl run --record F` adds `endpoint` (control-plane or harness: one record spans both) and
 * RUN_LENGTH_FIELDS: a session's prompt, the model's reply and the workspace patch are free text.
 *
 * The file is created 0600 and opened O_APPEND; an existing one with wider permissions is refused.
 * Each line is one write(2): under PIPE_BUF it needs nothing more; past it the write takes a lock
 * file beside F, so concurrent processes (a script's parallel commands) can share one record.
 */

/** The refresh token's prefix (control-plane refresh-store.ts REFRESH_TOKEN_PREFIX). */
export const REFRESH_TOKEN_PREFIX = 'mrt_';
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
/** Fields whose value is a secret, whatever it looks like. */
const SECRET_FIELDS = new Set([
  'token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'apiToken',
  'accessToken',
  'gateRecord',
  // A credential's value (`sbx credentials add` refuses --record; this is the backstop).
  'secret',
]);
/** Fields that name a host or carry free text: kept as their length only. */
const LENGTH_FIELDS = new Set(['execEndpoint', 'execCa', 'dial_addr', 'log', 'harnessUrl']);
/**
 * `mocactl run`'s free text, kept as its length: the prompt (a turn's, a leaf run's problem), the
 * reply (a sync turn's `response`, a frame's `text`, `delta`, `thinking`, `preview`, a tool call's
 * `args`, an `errorMessage`, any `message`, `content`, `summary`, `title`, `verdict`, `reason`), the
 * patch (`patch`, `patchBase64`; `patchSha256` and `patchBytes` stay) and a capture's failure
 * (`workspace.error`), a transcript (`messages`, `entries`, `history`, `transcript`), output
 * (`output`, `stdout`, `stderr`), a person's `displayName`, a template's `description`, and what
 * names a host (a credential's `hosts` and `endpoint`). Ids, codes, statuses, times, usage and the
 * sandbox placement stay. A set of its own, so the `sbx` commands' records keep these fields.
 */
export const RUN_LENGTH_FIELDS: ReadonlySet<string> = new Set([
  'prompt',
  'problemStatement',
  'response',
  'text',
  'delta',
  'thinking',
  'preview',
  'args',
  'errorMessage',
  'message',
  'content',
  'summary',
  'proposed_action',
  'title',
  'verdict',
  'reason',
  'patch',
  'patchBase64',
  'messages',
  'entries',
  'history',
  'transcript',
  'output',
  'stdout',
  'stderr',
  'description',
  'displayName',
  'hosts',
  'endpoint',
  // `parent.field`: a workspace capture's `error` is its failure's text; a top-level `error` is a code.
  'workspace.error',
]);
/** A refresh token anywhere in a string (its shape: `mrt_` + 43 base64url characters). */
const REFRESH_RE = new RegExp(`${REFRESH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}`);
/** An absolute URL names a host: kept as its length, whatever field it sits under. */
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/]/i;
/** PIPE_BUF on Linux and macOS is at least 512; 4096 on both. */
const PIPE_BUF = 4096;
const LOCK_STALE_MS = 10_000;

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const lengthOf = (v: unknown) => ({
  length: typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length,
});
const secretLooking = (s: string) =>
  JWT_RE.test(s) || s.startsWith(REFRESH_TOKEN_PREFIX) || REFRESH_RE.test(s);

/**
 * A body as the record keeps it. `parent` is the field this value sits under: a `message` in a
 * build's `reason` (or a log entry) is free text; a request's string `reason` is the caller's.
 */
export function redact(
  v: unknown,
  field?: string,
  parent?: string,
  request = false,
  more: ReadonlySet<string> = NONE,
): unknown {
  if (field !== undefined && SECRET_FIELDS.has(field) && v !== null && v !== undefined)
    return typeof v === 'string' ? sha256(v) : sha256(JSON.stringify(v));
  if (
    field !== undefined &&
    (LENGTH_FIELDS.has(field) || more.has(field) || more.has(`${parent}.${field}`)) &&
    v !== null &&
    v !== undefined
  )
    return lengthOf(v);
  if (field === 'message' && parent === 'reason') return lengthOf(v);
  if (request && field === 'reason' && typeof v === 'string') return lengthOf(v);
  if (typeof v === 'string') return secretLooking(v) ? sha256(v) : URL_RE.test(v) ? lengthOf(v) : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, undefined, field, request, more));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        redact(x, k, field, request, more),
      ]),
    );
  return v;
}
const NONE: ReadonlySet<string> = new Set();

/** A body as text: JSON when it parses (then redacted), else its length (NDJSON, a proxy's page). */
function bodyOf(text: string | undefined, request: boolean, more: ReadonlySet<string>): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return redact(JSON.parse(text), undefined, undefined, request, more);
  } catch {
    return { length: text.length };
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A streamed answer: Server-Sent Events (a turn) or NDJSON (an egress export). */
const STREAM_TYPE_RE = /^\s*(text\/event-stream|application\/(x-)?ndjson)\b/i;

/** A transport error as the record names it: its code or class, never its message (a host). */
const errorName = (err: unknown) =>
  (err as { cause?: { code?: unknown } } | undefined)?.cause?.code ??
  (err as Error | undefined)?.name;

/** One endpoint a record spans: its name on the line and its base URL (never written). */
export interface RecordEndpoint {
  endpoint: string;
  url: string | undefined;
}

export interface CallRecorder {
  /** `fetch`, recording each call; the path is relative to `baseUrl`'s path. */
  wrap(fetchImpl: typeof fetch, baseUrl: string): typeof fetch;
  /**
   * `fetch` over several endpoints (`mocactl run`: the control plane and the harness): each line
   * names the endpoint whose base URL (same origin, longest path prefix) the request is under, and
   * its path is relative to that base. `endpoints` is read per request, so a harness URL discovered
   * later counts. A request under none is `endpoint: 'other'`, its path whole, its host unwritten.
   */
  wrapEndpoints(fetchImpl: typeof fetch, endpoints: () => readonly RecordEndpoint[]): typeof fetch;
  close(): void;
}

export interface CallRecordOptions {
  /** Fields kept as their length beside the shared ones (`run`: RUN_LENGTH_FIELDS). */
  lengthFields?: ReadonlySet<string>;
}

/**
 * Opens F for appending, or says why not (the caller refuses the command, exit 2). An existing F
 * readable or writable by anyone but its owner is refused; a new one is created 0600.
 */
export function openCallRecord(
  path: string,
  command: string,
  now: () => number = Date.now,
  opts: CallRecordOptions = {},
): CallRecorder | { error: string } {
  const more = opts.lengthFields ?? NONE;
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    return { error: `cannot open the record ${path}: ${(err as Error).message}` };
  }
  const st = fstatSync(fd);
  if (!st.isFile() || (st.mode & 0o077) !== 0) {
    closeSync(fd);
    return {
      error: `the record ${path} is ${st.isFile() ? `mode ${(st.mode & 0o777).toString(8)}` : 'not a regular file'}: it must be 0600 (or new), as it records your calls`,
    };
  }
  const invocation = randomUUID();
  let seq = 0;
  let last = '';
  let tries = 0;
  // The whole line, or the command fails: a short write (a full disk) never leaves part of a line.
  const writeAll = (line: Buffer) => {
    for (let off = 0; off < line.length;) {
      const n = writeSync(fd, line, off, line.length - off);
      if (n <= 0) throw new Error(`the record ${path}: a write wrote nothing`);
      off += n;
    }
  };
  let closed = false;
  const write = (rec: Record<string, unknown>) => {
    // A stream's end may come after the command closed the record (a body nobody read to the end).
    if (closed) return;
    const line = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
    if (line.length <= PIPE_BUF) {
      writeAll(line);
      return;
    }
    const release = lock(`${path}.lock`);
    try {
      writeAll(line);
    } finally {
      release();
    }
  };
  const wrapWith = (
    fetchImpl: typeof fetch,
    locate: (u: URL) => { path: string; endpoint?: string },
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      const { path: p, endpoint } = locate(u);
      const rec: Record<string, unknown> = {
        command,
        invocation,
        seq: ++seq,
        try: (() => {
          const key = `${endpoint ?? ''} ${init?.method ?? 'GET'} ${p || '/'}`;
          tries = key === last ? tries + 1 : 1;
          last = key;
          return tries;
        })(),
        ...(endpoint !== undefined ? { endpoint } : {}),
        method: init?.method ?? 'GET',
        path: (p || '/') + u.search,
        request: bodyOf(typeof init?.body === 'string' ? init.body : undefined, true, more),
        requestAt: iso(now()),
      };
      let res: Response;
      try {
        res = await fetchImpl(input, init);
      } catch (err) {
        write({ ...rec, error: errorName(err), answerAt: iso(now()) });
        throw err;
      }
      const retryAfter = res.headers.get('retry-after');
      if (res.body && STREAM_TYPE_RE.test(res.headers.get('content-type') ?? '')) {
        write({
          ...rec,
          status: res.status,
          stream: true,
          answerAt: iso(now()),
          ...(retryAfter !== null ? { retryAfter } : {}),
        });
        return passThrough(res, init?.signal ?? undefined, (end) =>
          write({ command, invocation, seq: rec.seq, event: 'stream_end', ...end }),
        );
      }
      const text = await res
        .clone()
        .text()
        .catch(() => undefined);
      write({
        ...rec,
        status: res.status,
        answer: bodyOf(text, false, more),
        answerAt: iso(now()),
        ...(retryAfter !== null ? { retryAfter } : {}),
      });
      return res;
    }) as typeof fetch;

  /**
   * The answer with its body passed through as it arrives, counted: bytes, their sha256, frames
   * (SSE events as the turn reader parses them, or NDJSON lines). `done` runs once: at the end, on a
   * failure (`error`), or when the reader stops early (`closedBy: 'reader'`, as a turn does after its
   * terminal frame; `error` instead when the request's signal aborted).
   */
  const passThrough = (
    res: Response,
    signal: AbortSignal | undefined,
    done: (end: Record<string, unknown>) => void,
  ): Response => {
    const sse = /event-stream/i.test(res.headers.get('content-type') ?? '');
    const reader = res.body!.getReader();
    const hash: Hash = createHash('sha256');
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let bytes = 0;
    let frames = 0;
    let partial = false; // NDJSON: the current line has bytes
    let ended = false;
    let cancelled = false;
    const count = (chunk: Uint8Array) => {
      if (sse) {
        frames += parser.push(decoder.decode(chunk, { stream: true })).length;
        return;
      }
      for (const b of chunk) {
        if (b === 0x0a) {
          if (partial) frames++;
          partial = false;
        } else if (b !== 0x0d) partial = true;
      }
    };
    const end = (extra: Record<string, unknown>) => {
      if (ended) return;
      ended = true;
      if (sse) frames += parser.push(decoder.decode()).length + parser.end().length;
      else if (partial) frames++;
      done({
        bytes,
        sha256: `sha256:${hash.digest('hex')}`,
        frames,
        endedAt: iso(now()),
        ...extra,
      });
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (err) {
          end({ error: signal?.aborted ? 'AbortError' : errorName(err) });
          if (!cancelled) controller.error(err);
          return;
        }
        if (cancelled) return;
        if (r.done) {
          end({});
          controller.close();
          return;
        }
        bytes += r.value.byteLength;
        hash.update(r.value);
        count(r.value);
        controller.enqueue(r.value);
      },
      async cancel(reason) {
        cancelled = true;
        end(signal?.aborted ? { error: 'AbortError' } : { closedBy: 'reader' });
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  return {
    wrap(fetchImpl, baseUrl) {
      const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
      return wrapWith(fetchImpl, (u) => ({
        path: u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname,
      }));
    },
    wrapEndpoints(fetchImpl, endpoints) {
      return wrapWith(fetchImpl, (u) => {
        let best: { endpoint: string; base: string } | undefined;
        for (const e of endpoints()) {
          if (!e.url) continue;
          let b: URL;
          try {
            b = new URL(e.url);
          } catch {
            continue;
          }
          const base = b.pathname.replace(/\/+$/, '');
          const under =
            u.origin === b.origin &&
            (u.pathname === base || u.pathname.startsWith(`${base}/`) || base === '');
          if (under && (!best || base.length > best.base.length))
            best = { endpoint: e.endpoint, base };
        }
        return best
          ? { endpoint: best.endpoint, path: u.pathname.slice(best.base.length) }
          : { endpoint: 'other', path: u.pathname };
      });
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/** An O_EXCL lock file, waited on (a busy wait: lines this long are rare), broken once stale. */
function lock(path: string): () => void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
    } catch {
      // released meanwhile
    }
    Atomics.wait(wait, 0, 0, 5);
  }
}
