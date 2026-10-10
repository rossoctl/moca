import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createClient } from 'redis';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';
import { activeKey, TurnRegistryUnavailableError } from '@moca/harness/turn-registry';

vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
  executeTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
}));

import { handler, resetTurnRegistryForTests, startServer, turnRegistry } from '../src/server.js';
import { attachTurnSlot } from '../src/turn-slot.js';
import { TurnCounter } from '../src/worker.js';
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
// When set, the stubbed control plane holds its credential-exchange reply until this settles.
let cpGate: { reached: () => void; open: Promise<void> } | undefined;
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
  cpGate = undefined;
  cp = http.createServer(async (_req, res) => {
    if (cpGate) {
      cpGate.reached();
      await cpGate.open;
    }
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
  at: string = base,
): Promise<{ status: number; raw: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/v1/turn', at),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw, headers: res.headers }));
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

  it('answers an unclassified pre-first-frame failure with the stable internal_error, not its text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(executeTurn).mockRejectedValueOnce(new Error('redis://user:hunter2@host')); // notsecret
    const res = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.raw)).toEqual({ error: 'internal_error', sessionId });
    expect(res.raw).not.toContain('hunter2');
    // The logged terminal is replayable: an attach must not read the text back either.
    const replay = await get(`/v1/turn?sessionId=${sessionId}`, {
      Authorization: `Bearer ${mint(sessionId)}`,
    });
    expect(replay.status).toBe(200);
    expect(replay.raw).toContain('"errorMessage":"internal_error"');
    expect(replay.raw).not.toContain('hunter2');
    err.mockRestore();
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    // Fail-open is recorded: the overlap §4.4 prevents may now happen, so it must not be silent.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/one-live-turn check.*timed out/));
    warn.mockRestore();
  });
});

function get(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; raw: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
function postJson(path: string, body: unknown, headers: Record<string, string>) {
  return new Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        new URL(path, base),
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
        (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => (raw += c.toString()));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              json: raw ? JSON.parse(raw) : undefined,
              headers: res.headers,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    },
  );
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
    expect(c.json).toEqual({ turnId: expect.any(String), outcome: 'requested' });
    const res = await turn;
    expect(res.raw).toContain('"abortReason":"cancelled"');
  });

  it("with no turn running, the 202 names the last retained turn with outcome 'ended'", async () => {
    vi.mocked(executeTurn).mockResolvedValueOnce({
      sessionId,
      response: 'x',
      stopReason: 'stop',
    } as any);
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const res = await sse({ sessionId, prompt: 'p', detachable: true }, auth);
    const turnId = /"type":"turn"[^}]*"turnId":"([^"]+)"/.exec(res.raw)?.[1];
    expect(turnId).toBeDefined();
    const c = await postJson('/v1/turn/cancel', { sessionId }, auth);
    expect(c.status).toBe(202);
    expect(c.json).toEqual({ turnId, outcome: 'ended' });
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

  it('400 invalid_json for a null or primitive body', async () => {
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    for (const body of [null, 42, 'x', [{ sessionId: 's' }]]) {
      const c = await postJson('/v1/turn/cancel', body, auth);
      expect(c.status).toBe(400);
      expect(c.json.error).toBe('invalid_json');
    }
  });

  it('passes the registry its receipt time, which fences a turnId-less cancel (§6.4)', async () => {
    const spy = vi.spyOn(turnRegistry(), 'cancel');
    const before = Date.now();
    await postJson(
      '/v1/turn/cancel',
      { sessionId },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(spy).toHaveBeenCalledWith(sessionId, undefined, { issuedAt: expect.any(Number) });
    const issuedAt = (spy.mock.calls[0]![2] as { issuedAt: number }).issuedAt;
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(Date.now());
    spy.mockRestore();
  });

  it('logs an unexpected failure before answering 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'cancel').mockRejectedValueOnce(new TypeError('boom'));
    const c = await postJson(
      '/v1/turn/cancel',
      { sessionId },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(c.status).toBe(503);
    expect(c.json.error).toBe('redis_unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });
});

describe('GET /v1/turn (attach), following a running turn', () => {
  it('delivers frames emitted after it connected, and ends with the terminal', async () => {
    let release!: () => void;
    vi.mocked(executeTurn).mockImplementationOnce(async (input: any) => {
      input.onEvent?.({ type: 'text', delta: 'one' });
      await new Promise<void>((r) => (release = r));
      input.onEvent?.({ type: 'text', delta: 'two' });
      return { sessionId, response: 'onetwo', stopReason: 'stop' };
    });
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const turn = sse({ sessionId, prompt: 'p', detachable: true }, auth);
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).not.toBeNull());
    let raw = '';
    let sawOne!: () => void;
    const gotOne = new Promise<void>((r) => (sawOne = r));
    const attached = new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = http.request(
        new URL(`/v1/turn?sessionId=${sessionId}`, base),
        { method: 'GET', headers: auth },
        (res) => {
          res.on('data', (c: Buffer) => {
            raw += c.toString();
            if (raw.includes('"delta":"one"')) sawOne();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    await gotOne;
    expect(raw).not.toContain('"delta":"two"');
    release();
    const res = await attached;
    expect(res.status).toBe(200);
    expect(blocks(res.raw).map((x) => /event: (\w+)/.exec(x)![1])).toEqual([
      'turn',
      'text',
      'text',
      'done',
    ]);
    expect(res.raw).toContain('"delta":"two"');
    await turn;
  });

  it('logs a failure before the first frame and answers 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'attach').mockImplementationOnce(async function* () {
      throw new TypeError('kaput');
    });
    const res = await get(`/v1/turn?sessionId=${sessionId}`, {
      Authorization: `Bearer ${mint(sessionId)}`,
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.raw).error).toBe('redis_unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kaput'));
    warn.mockRestore();
  });
});

/** A server that counts turns the way a P6 worker does: a slot per turn request (worker.ts). */
async function withSlot(endSlot: () => void): Promise<{ at: string; close: () => void }> {
  const wrap = http.createServer((req, res) => {
    attachTurnSlot(res, endSlot);
    handler(req, res);
  });
  await new Promise<void>((r) => wrap.listen(0, () => r()));
  return {
    at: `http://127.0.0.1:${(wrap.address() as { port: number }).port}`,
    close: () => wrap.close(),
  };
}

describe('detachable turn slot (worker accounting, §5.5)', () => {
  it('a client that leaves during begin() does not end the slot of the turn that then runs', async () => {
    const endSlot = vi.fn();
    const w = await withSlot(endSlot);
    const reg = turnRegistry();
    const realBegin = reg.begin.bind(reg);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    let beginCalled!: () => void;
    const inBegin = new Promise<void>((r) => (beginCalled = r));
    vi.spyOn(reg, 'begin').mockImplementationOnce(async (sid, opts) => {
      beginCalled();
      await gate;
      return realBegin(sid, opts);
    });
    let release: (() => void) | undefined;
    vi.mocked(executeTurn).mockImplementationOnce(
      () =>
        new Promise(
          (r) => (release = () => r({ sessionId, response: '', stopReason: 'stop' } as any)),
        ),
    );
    const req = http.request(new URL('/v1/turn', w.at), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${mint(sessionId)}`,
      },
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ sessionId, prompt: 'p', detachable: true }));
    await inBegin;
    req.destroy(); // the client leaves while begin() is still in Redis
    await new Promise((r) => setTimeout(r, 100));
    openGate();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await redis.get(activeKey(sessionId))).not.toBeNull();
    expect(endSlot).not.toHaveBeenCalled(); // the detached turn is still counted
    release!();
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).toBeNull());
    await vi.waitFor(() => expect(endSlot).toHaveBeenCalledTimes(1));
    w.close();
  });

  it('releases the slot, once, when begin() fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const endSlot = vi.fn();
    const w = await withSlot(endSlot);
    vi.spyOn(turnRegistry(), 'begin').mockRejectedValueOnce(
      new TurnRegistryUnavailableError(new Error('down')),
    );
    const res = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
      w.at,
    );
    expect(res.status).toBe(503);
    await vi.waitFor(() => expect(endSlot).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(endSlot).toHaveBeenCalledTimes(1);
    w.close();
    warn.mockRestore();
  });
});

describe('detachable turn: a failing frame write', () => {
  it('still ends the turn and releases the lease when a send throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(executeTurn).mockImplementationOnce(async (input: any) => {
      // A BigInt cannot be serialized: logging it fails (append swallows that), and the SSE
      // write throws inside the frame chain, which then rejects.
      input.onEvent?.({ type: 'text', delta: 1n });
      await new Promise((r) => setTimeout(r, 20));
      return { sessionId, response: 'x', stopReason: 'stop' };
    });
    await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    await vi.waitFor(async () => expect(await redis.get(activeKey(sessionId))).toBeNull(), {
      timeout: 1000,
    });
    err.mockRestore();
  });
});

describe('a Redis that never answers (bounded registry calls)', () => {
  beforeEach(() => {
    process.env.SH_TURN_REGISTRY_TIMEOUT_MS = '200';
  });
  afterEach(() => {
    delete process.env.SH_TURN_REGISTRY_TIMEOUT_MS;
  });
  const auth = () => ({ Authorization: `Bearer ${mint(sessionId)}` });

  it('a begin() that never settles answers 503 redis_unavailable within the bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry() as any, 'beginOnce').mockReturnValue(new Promise(() => {}));
    const t0 = Date.now();
    const res = await sse({ sessionId, prompt: 'p', detachable: true }, auth());
    expect(res.status).toBe(503);
    expect(JSON.parse(res.raw)).toEqual({ error: 'redis_unavailable' });
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(Date.now() - t0).toBeLessThan(2000);
    warn.mockRestore();
  });

  it('an attach whose first read never settles answers 503 within the bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'attach').mockImplementationOnce(async function* () {
      await new Promise(() => {});
    });
    const t0 = Date.now();
    const res = await get(`/v1/turn?sessionId=${sessionId}`, auth());
    expect(res.status).toBe(503);
    expect(JSON.parse(res.raw)).toEqual({ error: 'redis_unavailable' });
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(Date.now() - t0).toBeLessThan(2000);
    warn.mockRestore();
  });

  it('a cancel that never settles answers 503 within the bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'cancel').mockReturnValueOnce(new Promise(() => {}));
    const t0 = Date.now();
    const c = await postJson('/v1/turn/cancel', { sessionId }, auth());
    expect(c.status).toBe(503);
    expect(c.json).toEqual({ error: 'redis_unavailable' });
    expect(c.headers['retry-after']).toMatch(/^\d+$/);
    expect(Date.now() - t0).toBeLessThan(2000);
    warn.mockRestore();
  });

  it('warns when the one-live-turn check errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'peek').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.mocked(executeTurn).mockResolvedValueOnce({
      sessionId,
      response: 'x',
      stopReason: 'stop',
    } as any);
    const res = await sse({ sessionId, prompt: 'p' }, { ...auth(), Accept: 'application/json' });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sessionId));
    warn.mockRestore();
  });
});

describe('route coverage (review note)', () => {
  it('cancel refuses a token for another session', async () => {
    const c = await postJson(
      '/v1/turn/cancel',
      { sessionId },
      { Authorization: `Bearer ${mint(`sid-${randomUUID()}`)}` },
    );
    expect(c.status).toBe(400);
    expect(c.json.error).toBe('session_mismatch');
  });

  it('attach and cancel answer 404 turn_not_found with SH_TURN_DETACH off', async () => {
    delete process.env.SH_TURN_DETACH;
    const auth = { Authorization: `Bearer ${mint(sessionId)}` };
    const a = await get(`/v1/turn?sessionId=${sessionId}`, auth);
    expect(a.status).toBe(404);
    expect(JSON.parse(a.raw)).toEqual({ error: 'turn_not_found' });
    const c = await postJson('/v1/turn/cancel', { sessionId }, auth);
    expect(c.status).toBe(404);
    expect(c.json).toEqual({ error: 'turn_not_found' });
  });

  it('a begin() that fails answers 503 redis_unavailable with Retry-After, no raw text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(turnRegistry(), 'begin').mockRejectedValueOnce(
      new TurnRegistryUnavailableError(new Error('redis://user:hunter2@host')), // notsecret
    );
    const res = await sse(
      { sessionId, prompt: 'p', detachable: true },
      { Authorization: `Bearer ${mint(sessionId)}` },
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.raw)).toEqual({ error: 'redis_unavailable' });
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(res.raw).not.toContain('hunter2');
    warn.mockRestore();
  });
});

describe('a client that left before the detachable turn began', () => {
  it('never begins the turn, and its slot is back to 0, when it leaves during the credential exchange', async () => {
    const counter = new TurnCounter(() => {});
    const wrap = http.createServer((req, res) => {
      attachTurnSlot(res, counter.start());
      handler(req, res);
    });
    await new Promise<void>((r) => wrap.listen(0, () => r()));
    const at = `http://127.0.0.1:${(wrap.address() as { port: number }).port}`;
    let open!: () => void;
    let reached!: () => void;
    const inExchange = new Promise<void>((r) => (reached = r));
    cpGate = { reached, open: new Promise<void>((r) => (open = r)) };
    const begin = vi.spyOn(turnRegistry(), 'begin');
    const req = http.request(new URL('/v1/turn', at), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${mint(sessionId)}`,
      },
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ sessionId, prompt: 'p', detachable: true }));
    await inExchange;
    expect(counter.inFlight).toBe(1);
    req.destroy(); // the client leaves while the control plane is still answering
    await new Promise((r) => setTimeout(r, 100));
    open();
    await new Promise((r) => setTimeout(r, 300));
    expect(begin).not.toHaveBeenCalled();
    expect(executeTurn).not.toHaveBeenCalled();
    expect(await redis.get(activeKey(sessionId))).toBeNull();
    expect(counter.inFlight).toBe(0);
    wrap.close();
  });
});

describe('SH_TURN_REGISTRY_TIMEOUT_MS', () => {
  afterEach(() => {
    delete process.env.SH_TURN_REGISTRY_TIMEOUT_MS;
  });
  it('treats 0 and negative values as the default rather than answering 503', async () => {
    for (const v of ['0', '-5']) {
      process.env.SH_TURN_REGISTRY_TIMEOUT_MS = v;
      // Same session both times: the first turn ends, and releases its lease, before the second.
      vi.mocked(executeTurn).mockResolvedValueOnce({
        sessionId,
        response: 'x',
        stopReason: 'stop',
      } as any);
      const res = await sse(
        { sessionId, prompt: 'p', detachable: true },
        { Authorization: `Bearer ${mint(sessionId)}` },
      );
      expect(res.status, v).toBe(200);
      expect(res.raw).toContain('event: turn');
    }
  });
});
