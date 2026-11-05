// packages/knative-server/test/run-leaf-async-rejection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: vi.fn(),
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
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ADR-0041 removal: the KEDA drainer and its enqueue route are gone. A body asking for
// async dispatch gets a named refusal, not a hang or a silent sync run.
describe('async /runs rejection', () => {
  beforeEach(() => {
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  it('400 with the removal message on async:true', async () => {
    const r = await req('POST', '/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      async: true,
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({
      error: 'async_removed',
      message:
        'async leaf dispatch was removed with the Knative/KEDA deployment path (ADR-0041); run leaves synchronously',
    });
    server.close();
  });

  it('400 with the removal message on the deprecated /run-leaf alias', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await req('POST', '/run-leaf', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      async: true,
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'async_removed' });
    warn.mockRestore();
    server.close();
  });

  // Moved from run-leaf-async-route.test.ts: the status endpoint outlives the async path —
  // mocactl polls it for synchronous runs.
  it('status returns queued when no record exists', async () => {
    const r = await req('GET', '/runs/status?sessionId=run/none');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'queued' });
    server.close();
  });

  it('status returns 400 when sessionId is missing', async () => {
    const r = await req('GET', '/runs/status');
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'sessionId_required' });
    server.close();
  });
});
