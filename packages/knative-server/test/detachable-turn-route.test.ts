import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createClient } from 'redis';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';
import { activeKey } from '@moca/harness/turn-registry';

vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
  executeTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
}));

import { resetTurnRegistryForTests, startServer, turnRegistry } from '../src/server.js';
import { executeTurn, runTurn } from '@moca/harness/run-turn';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const mint = (sid: string) =>
  signer.mint({
    sub: 'github:1234',
    tenant: 'github:1234',
    roles: [],
    scope: ['turn:write'],
    sid,
    ttlSeconds: 300,
  });

let server: ReturnType<typeof startServer>;
let base: string;
let cp: http.Server;
// Per test: the lease is per session, so tests must not share one.
let sessionId: string;
const saved: Record<string, string | undefined> = {};
let sigtermBefore: NodeJS.SignalsListener[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
await redis.connect();
afterAll(() => redis.close());

beforeEach(async () => {
  for (const k of [
    'SH_REQUIRE_AUTH',
    'SH_SESSION_TOKEN_PUBLIC_KEYS',
    'SH_CONTROL_PLANE_URL',
    'SH_EXCHANGE_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'REDIS_URL',
    'SH_TURN_DETACH',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sessionId = `sid-${randomUUID()}`;
  const cpBody = {
    mode: 'direct',
    anthropicAuthToken: 'sk-alice', // notsecret
    anthropicBaseUrl: 'https://litellm.internal/v1',
    sessionId,
    subject: 'github:1234',
  };
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cpBody));
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  process.env.SH_TURN_DETACH = '1';
  vi.mocked(runTurn).mockClear();
  vi.mocked(executeTurn).mockClear();
  // startServer adds a SIGTERM listener and logs on listen; one per test would pass Node's
  // ten-listener warning, so afterEach removes the listener and the log is silenced.
  sigtermBefore = process.listeners('SIGTERM');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  server = startServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.close();
  for (const l of process.listeners('SIGTERM')) {
    if (!sigtermBefore.includes(l)) process.off('SIGTERM', l);
  }
  logSpy.mockRestore();
  cp.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await resetTurnRegistryForTests();
});

/** POST an SSE turn and collect the raw body until the server ends it. */
function sse(
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/v1/turn', base),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const blocks = (raw: string) => raw.split('\n\n').filter((b) => b.includes('event:'));
const ids = (raw: string) => blocks(raw).map((b) => /^id: (.+)$/m.exec(b)?.[1]);

describe('POST /v1/turn detachable', () => {
  it('streams a turn frame first and an id on every frame', async () => {
    vi.mocked(executeTurn).mockImplementationOnce(async (input: any) => {
      input.onEvent?.({ type: 'text', delta: 'hi' });
      return { sessionId, response: 'hi', stopReason: 'stop' };
    });
    const res = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(res.status).toBe(200);
    const b = blocks(res.raw);
    expect(b[0]).toMatch(
      /^id: [^\n]+\nevent: turn\ndata: \{"type":"turn","turnId":"[^"]+","sessionId":"/,
    );
    expect(b.map((x) => /event: (\w+)/.exec(x)![1])).toEqual(['turn', 'text', 'done']);
    expect(ids(res.raw).every(Boolean)).toBe(true);
    expect(await redis.get(activeKey(sessionId))).toBeNull(); // lease released at the end
  });

  it('does not abort the turn when the client disconnects', async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    vi.mocked(executeTurn).mockImplementationOnce((input: any) => {
      signal = input.signal;
      input.onEvent?.({ type: 'text', delta: 'before' });
      return new Promise((r) => {
        release = () => r({ sessionId, response: 'x', stopReason: 'stop' } as any);
      });
    });
    const req = http.request(new URL('/v1/turn', base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${mint(sessionId)}`,
      },
    });
    req.on('error', () => {});
    const gotFrame = new Promise<void>((r) =>
      req.on('response', (res) => res.once('data', () => r())),
    );
    req.end(JSON.stringify({ sessionId, prompt: 'p', detachable: true }));
    await gotFrame;
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(signal?.aborted).toBe(false);
    expect(await redis.get(activeKey(sessionId))).not.toBeNull(); // still running
    release();
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).toBeNull());
  });

  it('409 turn_in_progress for a second turn of the session, detachable or not', async () => {
    let release!: () => void;
    vi.mocked(executeTurn).mockImplementationOnce(
      () =>
        new Promise(
          (r) => (release = () => r({ sessionId, response: '', stopReason: 'stop' } as any)),
        ),
    );
    const first = sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).not.toBeNull());
    for (const extra of [{ detachable: true }, {}]) {
      const res = await sse(
        { sessionId, prompt: 'q', ...extra },
        { Authorization: `Bearer ${mint(sessionId)}` },
      );
      expect(res.status).toBe(409);
      expect(JSON.parse(res.raw)).toMatchObject({ error: 'turn_in_progress' });
    }
    // An anonymous caller holds no token for the session: refused, without the running turn's id.
    const anon = await sse({ sessionId, prompt: 'q' }, {});
    expect(anon.status).toBe(409);
    expect(JSON.parse(anon.raw)).toEqual({ error: 'turn_in_progress' });
    release();
    await first;
  });

  it('keeps pre-first-frame status parity: a 404 turn is JSON, and the log ends', async () => {
    vi.mocked(executeTurn).mockRejectedValueOnce(new Error('no session in backend for id x'));
    const res = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.raw).error).toBe('session_not_found');
    expect(await redis.get(activeKey(sessionId))).toBeNull();
  });

  it('ignores detachable without SH_TURN_DETACH, without a token, and without SSE', async () => {
    delete process.env.SH_TURN_DETACH;
    vi.mocked(executeTurn).mockResolvedValueOnce({
      sessionId,
      response: 'x',
      stopReason: 'stop',
    } as any);
    const off = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(off.raw).not.toContain('event: turn');
    expect(off.raw).not.toMatch(/^id: /m);
    process.env.SH_TURN_DETACH = '1';
    // The SSE path runs executeTurn whether or not the caller authenticated.
    vi.mocked(executeTurn).mockResolvedValueOnce({
      sessionId,
      response: 'x',
      stopReason: 'stop',
    } as any);
    const anon = await sse({ sessionId, prompt: 'p', detachable: true }, {});
    expect(anon.raw).not.toContain('event: turn');
    // Authenticated, but not SSE: the sync JSON path, and no lease taken while it runs.
    let leaseDuringTurn: string | null = 'unset';
    vi.mocked(executeTurn).mockImplementationOnce(async () => {
      leaseDuringTurn = await redis.get(activeKey(sessionId));
      return { sessionId, response: 'x', stopReason: 'stop' } as any;
    });
    const sync = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}`, Accept: 'application/json' },
    );
    expect(sync.status).toBe(200);
    expect(sync.raw).not.toContain('event: turn');
    expect(JSON.parse(sync.raw)).toMatchObject({ sessionId, response: 'x' });
    expect(leaseDuringTurn).toBeNull();
  });

  it('a Redis that never answers the one-live-turn check does not stall a non-detachable turn', async () => {
    vi.spyOn(turnRegistry(), 'peek').mockReturnValue(new Promise(() => {}));
    vi.mocked(executeTurn).mockResolvedValueOnce({
      sessionId,
      response: 'x',
      stopReason: 'stop',
    } as any);
    const t0 = Date.now();
    const res = await sse(
      { sessionId, prompt: 'p' },
      { Authorization: `Bearer ${mint(sessionId)}`, Accept: 'application/json' },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.raw)).toMatchObject({ response: 'x' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

function get(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
    });
    req.on('error', reject);
    req.end();
  });
}
function postJson(path: string, body: unknown, headers: Record<string, string>) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('GET /v1/turn (attach)', () => {
  it('replays a finished turn after Last-Event-ID, without repeats', async () => {
    vi.mocked(executeTurn).mockImplementationOnce(async (input: any) => {
      input.onEvent?.({ type: 'text', delta: 'a' });
      input.onEvent?.({ type: 'text', delta: 'b' });
      return { sessionId, response: 'ab', stopReason: 'stop' };
    });
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const first = await sse({ sessionId, prompt: 'p', detachable: true }, auth);
    const cursor = ids(first.raw)[1]!; // after the first text frame
    const res = await get(`/v1/turn?sessionId=${sessionId}`, { ...auth, 'Last-Event-ID': cursor });
    expect(res.status).toBe(200);
    expect(blocks(res.raw).map((x) => /event: (\w+)/.exec(x)![1])).toEqual([
      'turn',
      'text',
      'done',
    ]);
    expect(res.raw).toContain('"delta":"b"');
    expect(res.raw).not.toContain('"delta":"a"');
  });

  it('404 turn_not_found for a session with no turn; 401 without a token', async () => {
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const none = await get(`/v1/turn?sessionId=${sessionId}`, auth);
    expect(none.status).toBe(404);
    expect(JSON.parse(none.raw).error).toBe('turn_not_found');
    const anon = await get(`/v1/turn?sessionId=${sessionId}`, {});
    expect(anon.status).toBe(401);
  });

  it('refuses a token for another session', async () => {
    const res = await get(`/v1/turn?sessionId=${sessionId}`, {
      Authorization: `Bearer ${mint(`sid-${randomUUID()}`)}`,
    });
    // session_mismatch, through writeAuthError's shared table: @moca/control-plane maps it to 400.
    expect(res.status).toBe(400);
    expect(JSON.parse(res.raw).error).toBe('session_mismatch');
  });
});

describe('POST /v1/turn/cancel', () => {
  it('cancels the running turn; its stream ends with abortReason cancelled', async () => {
    vi.mocked(executeTurn).mockImplementationOnce(
      (input: any) =>
        new Promise((resolve) =>
          input.signal.addEventListener('abort', () =>
            resolve({ sessionId, response: '', stopReason: 'aborted' }),
          ),
        ),
    );
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const turn = sse({ sessionId, prompt: 'p', detachable: true }, auth);
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).not.toBeNull());
    const c = await postJson('/v1/turn/cancel', { sessionId }, auth);
    expect(c.status).toBe(202);
    const res = await turn;
    expect(res.raw).toContain('"abortReason":"cancelled"');
  });

  it('409 turn_mismatch for another turn id, 404 with nothing to cancel', async () => {
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    expect((await postJson('/v1/turn/cancel', { sessionId }, auth)).status).toBe(404);
    let release!: () => void;
    vi.mocked(executeTurn).mockImplementationOnce(
      () =>
        new Promise(
          (r) => (release = () => r({ sessionId, response: '', stopReason: 'stop' } as any)),
        ),
    );
    const turn = sse({ sessionId, prompt: 'p', detachable: true }, auth);
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).not.toBeNull());
    const c = await postJson('/v1/turn/cancel', { sessionId, turnId: 'other' }, auth);
    expect(c.status).toBe(409);
    expect(c.json.error).toBe('turn_mismatch');
    release();
    await turn;
  });
});
