import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the result store hermetic — no live Redis in unit tests. `resultSet` records every
// write so tests can assert whether a result record was persisted (it must NOT be on 503).
const resultSet = vi.fn();
vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  const mem = new Map<string, string>();
  class FakeStore {
    async set(k: string, v: string) {
      resultSet(k, v);
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

import { startServer } from '../src/server';

let base: string;
let server: any;
beforeEach(() => {
  runLeaf.mockReset();
  resultSet.mockReset();
});

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
}

describe('POST /runs', () => {
  beforeEach(() => {
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => {
    server.close();
  });

  it('400s on a malformed envelope (missing item)', async () => {
    const r = await post('/runs', { sessionId: 's' });
    expect(r.status).toBe(400);
  });

  it('returns the verdict inline on a valid envelope', async () => {
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    expect(runLeaf).toHaveBeenCalledOnce();
  });

  // Issue #222 (1): `configRef: ""` used to reach the leaf, which read it as "no config requested"
  // and answered 200 as if nothing had been promoted. The leaf now fails it too; rejecting here as
  // well costs the operator nothing and spends no model tokens.
  it('400s on a present-but-empty configRef without running the leaf', async () => {
    const r = await post('/runs', {
      sessionId: 'run/i1',
      kind: 'prompt',
      prompt: 'Write the ship note.',
      configRef: '',
    });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'configRef_invalid' });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('400s on a non-string configRef', async () => {
    const r = await post('/runs', {
      sessionId: 'run/i1',
      kind: 'prompt',
      prompt: 'Write the ship note.',
      configRef: 42,
    });
    expect(r.status).toBe(400);
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it('does not accept a sandbox selector from the run request', async () => {
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    await post('/runs', {
      sessionId: 'run/i1',
      sandboxPoolSelector: 'attacker.example/pool=other',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });

    expect(runLeaf).toHaveBeenCalledWith(
      expect.not.objectContaining({ sandboxPoolSelector: expect.anything() }),
      expect.any(Object),
    );
  });
});

// Spec §4.3: the sync path must bound-wait with backoff on pool saturation, then 503 Retry-After.
describe('POST /runs saturation (spec §4.3)', () => {
  beforeEach(() => {
    // Tiny budget keeps the test fast; the loop re-attempts pool acquisition every few ms.
    process.env.KAGENTI_SYNC_SATURATION_WAIT_MS = '60';
    process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS = '5';
    process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS = '10';
    process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S = '7';
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => {
    server.close();
    delete process.env.KAGENTI_SYNC_SATURATION_WAIT_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S;
  });

  it('returns 503 with Retry-After after the wait budget is exhausted', async () => {
    runLeaf.mockResolvedValue({ status: 'failed', reason: 'saturated' });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('7');
    // Bounded WAIT with BACKOFF means the pool was re-attempted at least once before giving up.
    expect(runLeaf.mock.calls.length).toBeGreaterThan(1);
    // A 503 means "retry", not a terminal failure — no result record must be persisted.
    expect(resultSet).not.toHaveBeenCalled();
  });

  it('retries pool acquisition and returns the verdict once a pod frees', async () => {
    runLeaf.mockResolvedValueOnce({ status: 'failed', reason: 'saturated' }).mockResolvedValueOnce({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(resultSet).toHaveBeenCalledOnce();
  });
});

// A malformed operator knob must not silently disable the bounded wait or emit "Retry-After: NaN".
// Each *_MS/*_S value falls back to its default when it is not a finite, non-negative number.
describe('POST /runs saturation env hardening', () => {
  afterEach(() => {
    server.close();
    delete process.env.KAGENTI_SYNC_SATURATION_WAIT_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S;
  });

  it('falls back to the default budget on a malformed wait value (still bound-waits)', async () => {
    // Bug being guarded: "abc" → NaN → `Date.now() < NaN` is false → the loop is skipped and a
    // saturated first result becomes an immediate 503. With the fallback, WAIT_MS reverts to its
    // (ample) default, so a pod that frees on the second attempt is served a 200.
    process.env.KAGENTI_SYNC_SATURATION_WAIT_MS = 'abc';
    process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS = '5';
    process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS = '10';
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
    runLeaf.mockResolvedValueOnce({ status: 'failed', reason: 'saturated' }).mockResolvedValueOnce({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);
    expect(runLeaf).toHaveBeenCalledTimes(2);
  });

  it('advertises the default Retry-After when the env value is malformed (never NaN)', async () => {
    process.env.KAGENTI_SYNC_SATURATION_WAIT_MS = '30';
    process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS = '5';
    process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS = '10';
    process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S = 'abc';
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
    runLeaf.mockResolvedValue({ status: 'failed', reason: 'saturated' });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('5');
  });
});

// Regression: the pre-rename path must keep working as a deprecated alias (issue #37).
describe('POST /run-leaf (deprecated alias)', () => {
  beforeEach(() => {
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => {
    server.close();
  });

  it('still dispatches to runLeaf and warns about deprecation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    const r = await post('/run-leaf', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });
    expect(runLeaf).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('/run-leaf');
    expect(msg).toContain('/runs');
    warn.mockRestore();
  });
});
