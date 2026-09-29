import { describe, it, expect } from 'vitest';
import { SandboxPoolSaturatedError, SandboxPoolEmptyError } from '@moca/harness/run-turn';
import { turnErrorStatus, turnErrorHeaders } from '../src/server.js';

// /turn now leases a sandbox from the pool (it used to run tool calls in the harness process), so
// SandboxPoolSaturatedError became something a turn can fail with. It is TRANSIENT — every
// candidate sandbox is at its cap right now — and the sync /runs path already treats it that way
// (bounded wait, then 503), while classifyOutcome keeps it retryable for the async queue. Mapping
// it to 500 here would make one signal mean "retry me" on one route and "never retry" on another.
//
// The mapping is shared by the sync path and the SSE pre-first-frame window because §3.4 regime 2
// requires them byte-identical; they were duplicated blocks, which is how such a pair drifts the
// first time one grows a case.
describe('turnErrorStatus', () => {
  it('maps pool saturation to 503, not 500', () => {
    expect(turnErrorStatus(new SandboxPoolSaturatedError('app=sandbox'))).toBe(503);
  });

  it('maps an EMPTY pool to 503 too, not 500', () => {
    // The behaviour change that made /turn lease from the pool also made a momentarily empty pool
    // newly fatal on this route: selectPoolSandbox threw a plain Error, so "the sandboxes are still
    // starting" got a code meaning "never retry" while "every sandbox is busy" got Retry-After. Same
    // cause (no capacity yet), so the same advice.
    expect(turnErrorStatus(new SandboxPoolEmptyError('app=sandbox'))).toBe(503);
  });

  it('keeps the legacy 404 for a missing session', () => {
    expect(turnErrorStatus(new Error('no session in backend'))).toBe(404);
  });

  it('maps anything else to 500', () => {
    expect(turnErrorStatus(new Error('boom'))).toBe(500);
    expect(turnErrorStatus('not even an error')).toBe(500);
  });

  it('does not mistake a saturation-shaped MESSAGE for the real error', () => {
    // The check is on the error's `name` (class identity, set in the constructor), not on its
    // message, so prose cannot decide an HTTP status. A plain Error whose text merely reads like
    // saturation is still a 500.
    expect(turnErrorStatus(new Error('sandbox pool saturated for selector app=sandbox'))).toBe(500);
  });

  it('pins the name strings to the real classes', () => {
    // This is the case that makes the `name` comparison safe: turnErrorStatus hard-codes the
    // strings, so if either class ever renamed itself this assertion fails rather than the status
    // silently degrading to 500 in production.
    expect(new SandboxPoolSaturatedError('app=sandbox').name).toBe('SandboxPoolSaturatedError');
    expect(new SandboxPoolEmptyError('app=sandbox').name).toBe('SandboxPoolEmptyError');
  });
});

describe('turnErrorHeaders', () => {
  // 503 took `/runs` as its precedent but originally adopted neither half of what /runs does: it
  // bounded-waits AND advertises Retry-After. A client that honours the header got nothing from the
  // one route whose answer is "come back" — the same "one signal, two meanings by route" the status
  // mapping exists to avoid. The wait is deliberately not carried over (see the doc comment): on
  // /runs a retry only re-attempts acquisition, whereas on /turn the session is already open.
  it('advertises Retry-After on a 503, from the same knob /runs uses', () => {
    expect(turnErrorHeaders(503)).toMatchObject({ 'Retry-After': '5' });
  });

  it('honours KAGENTI_SYNC_SATURATION_RETRY_AFTER_S, read per request', () => {
    process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S = '17';
    try {
      expect(turnErrorHeaders(503)).toMatchObject({ 'Retry-After': '17' });
    } finally {
      delete process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S;
    }
  });

  it('adds no Retry-After to a 404 or a 500 — neither is worth retrying', () => {
    expect(turnErrorHeaders(404)).not.toHaveProperty('Retry-After');
    expect(turnErrorHeaders(500)).not.toHaveProperty('Retry-After');
  });

  it('keeps the JSON content type on every status, so the error body still parses', () => {
    for (const status of [404, 500, 503]) {
      expect(turnErrorHeaders(status)).toMatchObject({ 'Content-Type': 'application/json' });
    }
  });
});
