import { describe, it, expect } from 'vitest';
import {
  resultKey,
  toResultRecord,
  writeResult,
  readResult,
  type RedisLike,
  type LeafResultRecord,
} from '../src/leaf-result-store';
import type { LeafResult } from '../src/run-leaf';

function fakeRedis(): RedisLike & { store: Map<string, string>; ttl: Map<string, number> } {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    async set(key, value, opts) {
      store.set(key, value);
      if (opts?.EX) ttl.set(key, opts.EX);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
  };
}

describe('resultKey', () => {
  it('namespaces by leaf session id', () => {
    expect(resultKey('run-1-i1')).toBe('leaf:result:run-1-i1');
  });

  it('adds the turn id when given one, so sibling async turns do not share a key', () => {
    expect(resultKey('sess-1', 't-1')).toBe('leaf:result:sess-1:t-1');
    expect(resultKey('sess-1', 't-1')).not.toBe(resultKey('sess-1', 't-2'));
  });
});

describe('toResultRecord', () => {
  it('maps done → verdict-bearing record', () => {
    const r: LeafResult = {
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' },
    };
    expect(toResultRecord(r, 'run-1/i1', 'T')).toEqual({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' },
      gate: null,
      reason: null,
      patch: null,
      text: null,
      usage: null,
      sessionId: 'run-1/i1',
      ts: 'T',
    });
  });
  it('maps paused → gate-bearing record', () => {
    const r: LeafResult = {
      status: 'paused',
      gateId: 1,
      gate: { summary: 's', proposed_action: 'a' },
    };
    expect(toResultRecord(r, 'run-1/i1', 'T')).toMatchObject({
      status: 'paused',
      gate: { gateId: 1, summary: 's', proposed_action: 'a' },
      verdict: null,
      patch: null,
    });
  });
  it('maps failed → reason-bearing record', () => {
    const r: LeafResult = { status: 'failed', reason: 'no_verdict' };
    expect(toResultRecord(r, 's', 'T')).toMatchObject({
      status: 'failed',
      reason: 'no_verdict',
      patch: null,
    });
  });
});

describe('toResultRecord — solved', () => {
  it('carries the patch and sets status solved', () => {
    const rec = toResultRecord(
      { status: 'solved', patch: 'diff --git a/x b/x\n' },
      'run-1',
      '2026-07-14T00:00:00Z',
    );
    expect(rec.status).toBe('solved');
    expect(rec.patch).toBe('diff --git a/x b/x\n');
    expect(rec.verdict).toBeNull();
    expect(rec.sessionId).toBe('run-1');
  });
  it('carries token usage when the solved result has it', () => {
    const rec = toResultRecord(
      {
        status: 'solved',
        patch: 'd',
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
      },
      'run-1',
      't',
    );
    expect(rec.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 });
  });
  it('defaults usage to null when the solved result has none', () => {
    expect(toResultRecord({ status: 'solved', patch: 'd' }, 'run-1', 't').usage).toBeNull();
  });
  it('defaults patch to null for non-solve results', () => {
    const rec = toResultRecord({ status: 'aborted' }, 'run-1', 't');
    expect(rec.patch).toBeNull();
  });
});

describe('toResultRecord — responded', () => {
  it('carries the text and sets status responded, leaving other payloads null', () => {
    const rec = toResultRecord({ status: 'responded', text: 'hello world' }, 'run-1/i1', 'T');
    expect(rec.status).toBe('responded');
    expect(rec.text).toBe('hello world');
    expect(rec.verdict).toBeNull();
    expect(rec.gate).toBeNull();
    expect(rec.reason).toBeNull();
    expect(rec.patch).toBeNull();
    expect(rec.usage).toBeNull();
    expect(rec.sessionId).toBe('run-1/i1');
  });
  it('carries token usage when the responded result has it', () => {
    const rec = toResultRecord(
      {
        status: 'responded',
        text: 't',
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
      },
      'run-1',
      't',
    );
    expect(rec.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 });
  });
  it("carries a templated session's seed origin and workspace patch, and nothing for others", () => {
    const seed = { source: 'build' as const, buildId: 'sha256:' + 'b'.repeat(64) };
    const workspace = { baseline: 'abc', patch: 'diff\n', patchSha256: 'sha256:x', patchBytes: 5 };
    const rec = toResultRecord({ status: 'responded', text: 't', seed, workspace }, 'run-1', 't');
    expect(rec).toMatchObject({ seed, workspace });
    const plain = toResultRecord({ status: 'responded', text: 't' }, 'run-1', 't');
    expect(plain).not.toHaveProperty('seed');
    expect(plain).not.toHaveProperty('workspace');
  });
  it('defaults text to null for non-prompt results', () => {
    expect(toResultRecord({ status: 'aborted' }, 'run-1', 't').text).toBeNull();
  });
});

describe('writeResult / readResult', () => {
  it('round-trips a record and sets the TTL', async () => {
    const redis = fakeRedis();
    const rec: LeafResultRecord = {
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' },
      gate: null,
      reason: null,
      patch: null,
      text: null,
      usage: null, // required on LeafResultRecord; omitted here until #190, so the
      // round-trip assertion below never actually covered it
      sessionId: 'run-1/i1',
      ts: 'T',
    };
    await writeResult(redis, 'run-1-i1', rec, 3600);
    expect(redis.ttl.get('leaf:result:run-1-i1')).toBe(3600);
    expect(await readResult(redis, 'run-1-i1')).toEqual(rec);
  });
  it('returns null for a missing key', async () => {
    expect(await readResult(fakeRedis(), 'nope')).toBeNull();
  });
  it('returns null for a garbled value', async () => {
    const redis = fakeRedis();
    await redis.set('leaf:result:x', '{not json', {});
    expect(await readResult(redis, 'x')).toBeNull();
  });
});
