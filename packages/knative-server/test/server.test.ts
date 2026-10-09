import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';

// Mock runTurn before importing server
vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(),
  executeTurn: vi.fn(),
}));

// Keep the result store hermetic — no live Redis in unit tests.
vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  const mem = new Map<string, string>();
  class FakeStore {
    async set(k: string, v: string) {
      mem.set(k, v);
    }
    async get(k: string) {
      return mem.get(k) ?? null;
    }
    async close() {}
  }
  return { ...actual, RedisResultStore: FakeStore };
});

const runLeaf = vi.fn();
vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...a: any[]) => runLeaf(...a),
  validateItem: (o: any) =>
    o &&
    typeof o.item_id === 'string' &&
    typeof o.file === 'string' &&
    typeof o.pattern === 'string'
      ? o
      : null,
  leafSessionId: (env: any) =>
    (env.sessionId ?? 'leaf')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || 'leaf',
}));

import { startServer } from '../src/server.js';
import { runTurn, executeTurn } from '@moca/harness/run-turn';

const mockedRunTurn = vi.mocked(runTurn);
const mockedExecuteTurn = vi.mocked(executeTurn);
let server: ReturnType<typeof startServer>;
let baseUrl: string;

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          contentType: res.headers['content-type'],
        }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Raw SSE reader: returns status, content-type, and the FULL raw body once the stream ends.
function sseRequest(
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; contentType: string | undefined; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/turn', baseUrl);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'],
            raw: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  server = startServer(0); // port 0 = random available port
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    // The spec declares text/plain; the handler used to send no Content-Type at all, leaving the
    // wire form to Node's defaults while the document promised a media type.
    expect(res.contentType).toBe('text/plain');
  });
});

describe('POST /turn', () => {
  it('returns 200 with session result on success', async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: 'test-session-1',
      response: 'Hello!',
      stopReason: 'end_turn',
    });

    const res = await request('POST', '/turn', { prompt: 'Hi' });
    expect(res.status).toBe(200);

    const json = JSON.parse(res.body);
    expect(json.sessionId).toBe('test-session-1');
    expect(json.response).toBe('Hello!');
    expect(json.stopReason).toBe('end_turn');
  });

  it('passes sessionId to runTurn when provided', async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: 'existing-session',
      response: 'Resumed!',
      stopReason: 'end_turn',
    });

    const res = await request('POST', '/turn', {
      sessionId: 'existing-session',
      prompt: 'Continue',
    });
    expect(res.status).toBe(200);
    expect(mockedRunTurn).toHaveBeenCalledWith('Continue', 'existing-session', expect.any(Object));
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request('POST', '/turn', { sessionId: 'abc' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('prompt_required');
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL('/turn', baseUrl);
      const req = http.request(url, { method: 'POST' }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          resolve({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      req.on('error', reject);
      req.write('not valid json{{{');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
  });

  it('returns 404 when session not found', async () => {
    mockedRunTurn.mockRejectedValueOnce(
      new Error('Cannot resume: no session in backend for id xyz'),
    );

    const res = await request('POST', '/turn', {
      sessionId: 'xyz',
      prompt: 'hello',
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe('session_not_found');
  });

  it('returns 500 on unexpected errors', async () => {
    mockedRunTurn.mockRejectedValueOnce(new Error('LLM timeout'));

    const res = await request('POST', '/turn', { prompt: 'hello' });
    expect(res.status).toBe(500);
    // The stable code, never the exception's own text — that can carry connection strings or
    // tokens, and this body reaches an arbitrary caller (the control-plane document's rule).
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(JSON.parse(res.body)).not.toHaveProperty('message');
  });
});

describe('GET /runs/status', () => {
  it('GET /runs/status returns queued when no record exists', async () => {
    const r = await (await fetch(`${baseUrl}/runs/status?sessionId=run/none`)).json();
    expect(r).toEqual({ status: 'queued' });
  });
  it('GET /runs/status returns the record after a sync run', async () => {
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' },
    });
    await post('/runs', { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } });
    const r = await (await fetch(`${baseUrl}/runs/status?sessionId=run/i1`)).json();
    expect(r).toMatchObject({ status: 'done', verdict: { item_id: 'i1', verdict: 'FLAGGED' } });
  });
});

describe('POST /turn — back-compat & streaming', () => {
  // Isolate call-count assertions (not.toHaveBeenCalled) from prior tests: this package's vitest
  // config sets no clearMocks, so clear per test. Implementations are set inside each test after this.
  beforeEach(() => {
    mockedExecuteTurn.mockClear();
    mockedRunTurn.mockClear();
  });

  it('no Accept header → golden byte-for-byte sync JSON (the back-compat linchpin)', async () => {
    const result = { sessionId: 'gold-1', response: 'Hi there', stopReason: 'end_turn' };
    mockedRunTurn.mockResolvedValueOnce(result as any);
    const res = await request('POST', '/turn', { prompt: 'Hi' });
    expect(res.status).toBe(200);
    // Frozen wire bytes (not JSON.stringify(result)): pins the server's own sync-response emission,
    // so a future edit to how the JSON path serializes/orders keys fails here (back-compat, ADR-0029).
    // runTurn is mocked, so this does NOT cover the upstream turn engine — only the server boundary.
    expect(res.body).toBe('{"sessionId":"gold-1","response":"Hi there","stopReason":"end_turn"}');
    expect(mockedExecuteTurn).not.toHaveBeenCalled(); // sync path never touches executeTurn
  });

  it('Accept: text/event-stream → SSE content-type, ordered frames, terminal done', async () => {
    mockedExecuteTurn.mockImplementationOnce(async (input: any) => {
      input.onEvent?.({ type: 'text', delta: 'Hel' });
      input.onEvent?.({ type: 'text', delta: 'lo' });
      input.onEvent?.({ type: 'tool_use', id: 't1', name: 'bash', args: { cmd: 'ls' } });
      input.onEvent?.({ type: 'tool_result', id: 't1', isError: false, preview: 'file.txt' });
      return { sessionId: 's-stream', response: 'Hello', stopReason: 'end_turn' };
    });
    const res = await sseRequest({ Accept: 'text/event-stream' }, { prompt: 'Hi' });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/event-stream');
    const events = res.raw.split('\n\n').filter((b) => b.startsWith('event:'));
    expect(events[0]).toBe('event: text\ndata: {"type":"text","delta":"Hel"}');
    expect(res.raw).toContain(
      'event: tool_use\ndata: {"type":"tool_use","id":"t1","name":"bash","args":{"cmd":"ls"}}',
    );
    const last = events.at(-1)!;
    expect(last.startsWith('event: done')).toBe(true);
    expect(last).toContain('"sessionId":"s-stream"');
    expect(last).toContain('"stopReason":"end_turn"');
  });

  it('bad sessionId + streaming Accept → real 404 JSON, not an error frame (pre-first-frame)', async () => {
    mockedExecuteTurn.mockRejectedValueOnce(
      new Error('Cannot resume: no session in backend for id xyz'),
    );
    const res = await sseRequest(
      { Accept: 'text/event-stream' },
      { sessionId: 'xyz', prompt: 'hi' },
    );
    expect(res.status).toBe(404);
    expect(res.contentType).toBe('application/json');
    const parsed = JSON.parse(res.raw);
    expect(parsed.error).toBe('session_not_found');
    expect(parsed.sessionId).toBe('xyz');
  });

  it('missing prompt + streaming Accept → 400 prompt_required (pre-flight, before the branch)', async () => {
    const res = await sseRequest({ Accept: 'text/event-stream' }, { sessionId: 'abc' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.raw).error).toBe('prompt_required');
    expect(mockedExecuteTurn).not.toHaveBeenCalled();
  });

  it('client disconnect mid-stream aborts the executeTurn signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    let sawFirstFrame: (() => void) | undefined;
    const firstFrame = new Promise<void>((r) => {
      sawFirstFrame = r;
    });
    mockedExecuteTurn.mockImplementationOnce((input: any) => {
      capturedSignal = input.signal;
      input.onEvent?.({ type: 'text', delta: 'partial' });
      sawFirstFrame?.();
      // Resolve only once aborted, mimicking session.abort() unwinding the turn.
      return new Promise((resolve) => {
        input.signal?.addEventListener('abort', () =>
          resolve({ sessionId: 's-abort', response: 'partial', stopReason: 'aborted' }),
        );
      });
    });
    const url = new URL('/turn', baseUrl);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    });
    req.on('error', () => {}); // the deliberate req.destroy() below hangs up the socket mid-response
    req.write(JSON.stringify({ sessionId: 's-abort', prompt: 'hi' }));
    req.end();
    await firstFrame; // server-side promise resolved by the mock after the first frame
    req.destroy(); // client disconnect
    await vi.waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  it('executeTurn rejects AFTER a frame flushed → 200 + terminal error frame, not 500 JSON (regime 3)', async () => {
    // The only net-new failure surface in ADR-0029: once ≥1 frame is on the wire the 200 status is
    // spent, so a mid-turn failure can no longer become a 500 JSON body — it must degrade to a
    // terminal `event: error` frame carrying the same facts (§3.4 regime 3).
    mockedExecuteTurn.mockImplementationOnce(async (input: any) => {
      input.onEvent?.({ type: 'text', delta: 'partial' });
      throw new Error('LLM exploded mid-stream');
    });
    const res = await sseRequest({ Accept: 'text/event-stream' }, { prompt: 'hi' });
    expect(res.status).toBe(200); // headers committed by the first frame — never rewritten to 500
    expect(res.contentType).toBe('text/event-stream');
    expect(res.raw).toContain('event: text\ndata: {"type":"text","delta":"partial"}');
    const events = res.raw.split('\n\n').filter((b) => b.startsWith('event:'));
    const last = events.at(-1)!;
    expect(last.startsWith('event: error')).toBe(true);
    const data = JSON.parse(last.slice(last.indexOf('data: ') + 'data: '.length));
    expect(data).toMatchObject({
      type: 'error',
      sessionId: '', // no sessionId on a fresh turn → "" on the wire (server.ts:193)
      stopReason: 'error',
      errorMessage: 'LLM exploded mid-stream',
    });
  });
});

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await request('GET', '/unknown');
    expect(res.status).toBe(404);
  });
});
