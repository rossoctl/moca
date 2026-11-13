import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the result store hermetic — no live Redis in unit tests. `resultSet` records every
// `leaf:result:` write so tests can assert whether a result record was persisted (it must NOT be
// on 503); the run-lease marker writes to `sh:run:*` keys land in the same Map but are not
// result records, so they do not count. `__mem` exposes the Map for the lease-lifecycle tests.
const resultSet = vi.fn();
vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  const mem = new Map<string, string>();
  class FakeStore {
    async set(k: string, v: string) {
      if (k.startsWith('leaf:result:')) resultSet(k, v);
      mem.set(k, v);
    }
    async get(k: string) {
      return mem.get(k) ?? null;
    }
    async del(k: string) {
      mem.delete(k);
    }
    async close() {}
  }
  return { ...actual, RedisResultStore: FakeStore, __mem: mem };
});

// The reaper is mocked so the arming tests observe the sweep without a Redis; beginRunLease stays
// real because the lease-lifecycle tests below exercise it through the route.
const reapRuns = vi.fn();
vi.mock('@moca/harness/run-lease', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/run-lease')>();
  return { ...actual, reapOrphanedRuns: (...a: any[]) => reapRuns(...a) };
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

import { startServer, armRunReaper } from '../src/server';
import * as leafResultStore from '@moca/harness/leaf-result-store';

/** The mocked store's shared Map — see the vi.mock factory above. */
const memOf = () => (leafResultStore as unknown as { __mem: Map<string, string> }).__mem;

let base: string;
let server: any;
beforeEach(() => {
  runLeaf.mockReset();
  resultSet.mockReset();
  reapRuns.mockReset();
  reapRuns.mockResolvedValue([]);
  memOf().clear();
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

  // #558: a sync run must be visible in Redis for exactly as long as it executes, so a worker
  // that dies mid-run leaves a marker a surviving worker's reaper can finalize.
  it('holds a run lease while the run executes and releases it after', async () => {
    runLeaf.mockImplementation(async () => {
      // The lease is recorded fire-and-forget before runLeaf, so let it land before looking.
      await new Promise((r) => setTimeout(r, 0));
      expect(memOf().get('sh:run:run-i1')).toBeDefined();
      expect(JSON.parse(memOf().get('sh:run:run-i1')!)).toMatchObject({
        owner: expect.any(String),
        rawSessionId: 'run/i1',
      });
      expect(memOf().get('sh:run:run-i1:hb')).toBe('1');
      return {
        status: 'done',
        verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
      };
    });
    const r = await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);
    expect(memOf().get('sh:run:run-i1')).toBeUndefined();
    expect(memOf().get('sh:run:run-i1:hb')).toBeUndefined();
  });

  it('releases the run lease on a thrown runLeaf too', async () => {
    runLeaf.mockRejectedValue(new Error('boom'));
    await post('/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(memOf().get('sh:run:run-i1')).toBeUndefined();
    expect(memOf().get('sh:run:run-i1:hb')).toBeUndefined();
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

describe('run reaper (#558)', () => {
  // The reaper's audit emission goes through defaultAuditLog's JSON console line, the same
  // surface run-leaf-audit-log.test.ts captures.
  let captured: string[];
  let origConsoleLog: typeof console.log;

  beforeEach(() => {
    captured = [];
    origConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      const s = String(args[0]);
      if (s.startsWith('{')) captured.push(s);
    };
  });
  afterEach(() => {
    console.log = origConsoleLog;
  });

  it('sweeps once on arm, audits one run_finalized per reaped run, and stops on demand', async () => {
    const reaped = [{ sid: 'run-1-i1', rawSessionId: 'run/1/i1', owner: 'pod-1:42' }];
    reapRuns.mockImplementation(
      async (_store: unknown, opts: { onReap?: (run: (typeof reaped)[0]) => void }) => {
        opts.onReap?.(reaped[0]!);
        return reaped;
      },
    );
    const stop = armRunReaper();
    await new Promise((r) => setTimeout(r, 0)); // let the immediate sweep land
    stop();
    expect(reapRuns).toHaveBeenCalledTimes(1);
    const audits = captured
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((o) => o.event === 'audit');
    expect(audits).toContainEqual(
      expect.objectContaining({
        decision: 'run_finalized',
        sessionId: 'run/1/i1',
        status: 'failed',
        reason: 'owner_lost',
        reaper: true,
      }),
    );
  });

  it('warns and stays armed when a sweep fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reapRuns.mockRejectedValue(new Error('redis down'));
    const stop = armRunReaper();
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
