import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_UNKNOWN_GRACE_MS,
  LeafTransport,
  mapHonestState,
  type LeafEnvelope,
  type LeafResultBody,
} from '../src/transport/leaf-turn.js';

/* ------------------------------------------------------------------------ *
 * mapHonestState: the state-resolution rules the whole slice depends on.   *
 * ------------------------------------------------------------------------ */

describe('mapHonestState — server-terminal records', () => {
  const live = { alive: false, observedAt: 0 };
  it('maps responded/done/solved → done and carries the body', () => {
    for (const status of ['responded', 'done', 'solved'] as const) {
      const r: LeafResultBody = { status, text: 'x', patch: 'y', verdict: { v: 1 } };
      const v = mapHonestState(r, live, 1_000_000);
      expect(v.state).toBe('done');
      expect(v.result).toBe(r);
    }
  });
  it('maps paused → paused and surfaces that a gate was requested', () => {
    const r: LeafResultBody = {
      status: 'paused',
      gateId: 1,
      gate: { summary: 's', proposed_action: 'a' },
    };
    const v = mapHonestState(r, live, 1_000_000);
    expect(v).toEqual({ state: 'paused', detail: 'gate requested', result: r });
  });
  it('maps failed → failed and prefers reason over message for the detail', () => {
    const withReason: LeafResultBody = {
      status: 'failed',
      reason: 'saturated',
      message: 'ignored',
    };
    expect(mapHonestState(withReason, live, 1).detail).toBe('saturated');
    const noReason: LeafResultBody = { status: 'failed', message: 'boom' };
    expect(mapHonestState(noReason, live, 1).detail).toBe('boom');
  });
  it('maps an unknown status honestly to unknown, not silently to done', () => {
    const r = { status: 'future-shape' } as unknown as LeafResultBody;
    const v = mapHonestState(r, live, 1);
    expect(v.state).toBe('unknown');
    expect(v.detail).toContain("'future-shape'");
  });
});

describe("mapHonestState — the 'queued' ambiguity", () => {
  // The server's 'queued' means three different things (server.ts:678-680); the ambiguity is
  // this slice's reason to exist. Pin every branch of the resolution rule.
  it('live child + queued → running', () => {
    expect(mapHonestState('queued', { alive: true, observedAt: 0 }, 1_000_000)).toEqual({
      state: 'running',
    });
  });
  it("dead child inside the grace window → running with a 'waiting for result' hint", () => {
    const v = mapHonestState(
      'queued',
      { alive: false, observedAt: 500 },
      500 + DEFAULT_UNKNOWN_GRACE_MS - 1,
    );
    expect(v.state).toBe('running');
    expect(v.detail).toContain('waiting for result');
  });
  it('dead child past the grace window → unknown (honest; no result recorded)', () => {
    const v = mapHonestState(
      'queued',
      { alive: false, observedAt: 0 },
      DEFAULT_UNKNOWN_GRACE_MS + 1,
    );
    expect(v).toEqual({ state: 'unknown', detail: 'child exited and no result recorded' });
  });
  it('respects a caller-supplied grace window (so tests and operators can tighten it)', () => {
    const v = mapHonestState('queued', { alive: false, observedAt: 0 }, 10, 100);
    expect(v.state).toBe('running');
    const w = mapHonestState('queued', { alive: false, observedAt: 0 }, 101, 100);
    expect(w.state).toBe('unknown');
  });
});

describe('mapHonestState — terminal aborted', () => {
  it('maps aborted → failed with detail "aborted" so the row has a clear reason', () => {
    const r = { status: 'aborted' } as const;
    const v = mapHonestState(r, { alive: false, observedAt: 0 }, 1_000_000);
    expect(v).toEqual({ state: 'failed', detail: 'aborted', result: r });
  });
});

/* ------------------------------------------------------------------------ *
 * LeafTransport.submitLeafTurn + readLeafState: wire-shape round trips.    *
 * ------------------------------------------------------------------------ */

const harness = { baseUrl: async () => 'https://harness.test' };
const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('LeafTransport.submitLeafTurn', () => {
  it('POSTs /v1/runs with the session token, envelope body, and content-type', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okJson({ status: 'responded', text: 'ok' }),
    );
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    const env: LeafEnvelope = {
      sessionId: 's1',
      kind: 'prompt',
      prompt: 'hi',
      configRef: 'sha256:aaa',
    };
    const r = await t.submitLeafTurn(env, 'tok-xyz');
    expect(r).toEqual({ status: 'responded', text: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://harness.test/v1/runs');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-xyz');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual(env);
  });
  it('surfaces a non-200 as an ApiError with the harness error code', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'config_bundle_not_found' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    await expect(
      t.submitLeafTurn({ sessionId: 's', kind: 'prompt', prompt: 'p' }, 'tok'),
    ).rejects.toThrow(/config_bundle_not_found/);
  });
  it('preserves undici cause codes on networkError and folds them into the message', async () => {
    const { networkError } = await import('../src/api/errors.js');
    // Real undici shape: top-level message is bare "fetch failed"; the code lives on .cause.
    const headersTimeout = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
    const e1 = networkError('harness', headersTimeout);
    expect(e1.causeCode).toBe('UND_ERR_HEADERS_TIMEOUT');
    expect(e1.message).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)');

    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const e2 = networkError('harness', refused);
    expect(e2.causeCode).toBe('ECONNREFUSED');
    expect(e2.message).toBe('fetch failed (ECONNREFUSED)');

    // No cause: leave the message alone.
    const e3 = networkError('harness', new Error('bare'));
    expect(e3.causeCode).toBeUndefined();
    expect(e3.message).toBe('bare');
  });

  it('rejects when the harness returns non-JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    await expect(
      t.submitLeafTurn({ sessionId: 's', kind: 'prompt', prompt: 'p' }, 'tok'),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe('LeafTransport.readLeafState', () => {
  it('url-encodes the sessionId', async () => {
    const fetchImpl = vi.fn(async (_url: string) => okJson({ status: 'responded', text: 'hi' }));
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    await t.readLeafState('run.1', 'tok');
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://harness.test/runs/status?sessionId=run.1');
  });
  it('surfaces a 404 as an ApiError (distinguishable from queued)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    await expect(t.readLeafState('s', 'tok')).rejects.toMatchObject({ status: 404 });
  });
  it("returns 'queued' as the sentinel for mapHonestState to resolve with liveness", async () => {
    const fetchImpl = vi.fn(async () => okJson({ status: 'queued' }));
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    expect(await t.readLeafState('s', 'tok')).toBe('queued');
  });
  it('passes through a terminal body unchanged', async () => {
    const body: LeafResultBody = {
      status: 'solved',
      patch: 'diff --git a b',
      usage: { total: 42 },
    };
    const fetchImpl = vi.fn(async () => okJson(body));
    const t = new LeafTransport(harness, fetchImpl as unknown as typeof fetch);
    expect(await t.readLeafState('s', 'tok')).toEqual(body);
  });
});
