// packages/knative-server/test/run-leaf-async-route.test.ts
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

const enqueue = vi.fn(async () => '1-0');
const ensureGroup = vi.fn(async () => {});
vi.mock('@moca/work-queue', () => ({
  RedisWorkQueue: class {
    ensureGroup = ensureGroup;
    enqueue = enqueue;
    close = async () => {};
  },
}));

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
beforeEach(() => {
  enqueue.mockClear();
});
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('async /runs', () => {
  beforeEach(() => {
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  it('202 + enqueues on async:true with a valid envelope', async () => {
    const r = await req('POST', '/runs', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      async: true,
    });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: 'accepted', sessionId: 'run/i1' });
    expect(r.json).not.toHaveProperty('doneMarker');
    expect(r.json).not.toHaveProperty('resultRef');
    expect(enqueue).toHaveBeenCalledOnce();
    server.close();
  });

  it('400 and no enqueue on a malformed async envelope', async () => {
    const r = await req('POST', '/runs', { sessionId: 's', async: true });
    expect(r.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    server.close();
  });

  // Issue #222 (1): an empty configRef used to be silently "no config requested". Catching it here
  // as well as in the leaf matters for the async path specifically — the enqueue is where the
  // operator is still watching, whereas the leaf's failure surfaces later, via /runs/status.
  it('400 and no enqueue when configRef is present but empty', async () => {
    const r = await req('POST', '/runs', {
      sessionId: 'run/i1',
      kind: 'prompt',
      prompt: 'Write the ship note.',
      configRef: '',
      async: true,
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'configRef_invalid' });
    expect(enqueue).not.toHaveBeenCalled();
    server.close();
  });

  it('still enqueues when configRef names a digest', async () => {
    const r = await req('POST', '/runs', {
      sessionId: 'run/i1',
      kind: 'prompt',
      prompt: 'Write the ship note.',
      configRef: 'sha256:' + 'a'.repeat(64),
      async: true,
    });
    expect(r.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    server.close();
  });

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

// Regression: the pre-rename async paths must keep working as deprecated aliases (issue #37).
describe('deprecated /run-leaf aliases', () => {
  beforeEach(() => {
    server = startServer(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  it('POST /run-leaf still enqueues async work and warns about deprecation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await req('POST', '/run-leaf', {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      async: true,
    });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: 'accepted', sessionId: 'run/i1' });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('/run-leaf');
    warn.mockRestore();
    server.close();
  });

  it('GET /run-leaf/status warns about deprecation and returns queued for unknown session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await req('GET', '/run-leaf/status?sessionId=run/i1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'queued' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('/run-leaf/status');
    warn.mockRestore();
    server.close();
  });
});
