// Lifecycle events emitted by the P6 run path. Mocks mirror run-leaf-route.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@moca/harness/leaf-result-store', async (orig) => {
  const actual = await orig<typeof import('@moca/harness/leaf-result-store')>();
  class FakeStore {
    private mem = new Map<string, string>();
    async set(k: string, v: string) {
      this.mem.set(k, v);
    }
    async get(k: string) {
      return this.mem.get(k) ?? null;
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

let server: any;
let base: string;
let captured: string[];
let origConsoleLog: typeof console.log;

beforeEach(() => {
  runLeaf.mockReset();
  captured = [];
  origConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    // Record only JSON-shaped lines so test setup noise doesn't contaminate assertions.
    const s = String(args[0]);
    if (s.startsWith('{')) captured.push(s);
  };
  server = startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  console.log = origConsoleLog;
  server.close();
});

async function post(body: unknown) {
  const res = await fetch(base + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function auditLines(): Array<Record<string, unknown>> {
  return captured
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o !== null && o.event === 'audit');
}

describe('POST /runs — audit log mirror', () => {
  it('emits run_started before runLeaf and run_finalized after', async () => {
    runLeaf.mockResolvedValue({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });

    const r = await post({
      sessionId: 'sid-abc',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);

    const audits = auditLines().filter(
      (l) => l.decision === 'run_started' || l.decision === 'run_finalized',
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].decision).toBe('run_started');
    expect(audits[0].sessionId).toBe('sid-abc');
    expect(audits[1].decision).toBe('run_finalized');
    expect(audits[1].sessionId).toBe('sid-abc');
    expect(audits[1].status).toBe('done');
  });

  it('run_started fires once even when saturation makes runLeaf retry', async () => {
    // First call saturated, second call succeeds. The retry loop must NOT re-emit run_started.
    runLeaf.mockResolvedValueOnce({ status: 'failed', reason: 'saturated' }).mockResolvedValueOnce({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
    });

    const r = await post({
      sessionId: 'sid-saturated',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    expect(r.status).toBe(200);

    const starts = auditLines().filter((l) => l.decision === 'run_started');
    const finals = auditLines().filter((l) => l.decision === 'run_finalized');
    expect(starts).toHaveLength(1);
    expect(finals).toHaveLength(1);
  });

  it('still emits run_finalized when runLeaf throws, so an operator grep is never left unterminated', async () => {
    runLeaf.mockRejectedValue(new Error('boom'));
    const r = await post({
      sessionId: 'sid-err',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });
    // route().catch(internalError) answers 500; the lifecycle still pairs.
    expect(r.status).toBe(500);
    const audits = auditLines().filter(
      (l) => l.decision === 'run_started' || l.decision === 'run_finalized',
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ decision: 'run_started', sessionId: 'sid-err' });
    expect(audits[1]).toMatchObject({
      decision: 'run_finalized',
      sessionId: 'sid-err',
      status: 'failed',
      reason: 'error',
    });
  });
});
