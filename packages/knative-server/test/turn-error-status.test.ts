import { describe, it, expect } from 'vitest';
import {
  SandboxPoolSaturatedError,
  SandboxPoolEmptyError,
  SandboxAffinityPendingError,
  BundleNotFoundError,
} from '@moca/harness/run-turn';
import { turnErrorStatus, turnErrorHeaders, turnErrorCode } from '../src/server.js';

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

  it('maps a pending affine sandbox to 503 too: the session is waiting for ITS sandbox', () => {
    expect(turnErrorStatus(new SandboxAffinityPendingError('m-0', 5_000))).toBe(503);
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

  it("uses a pending affine sandbox's retryInMs, capped at 10 s", () => {
    const pending30s = new SandboxAffinityPendingError('m-0', 30_000);
    expect(turnErrorHeaders(503, pending30s)).toMatchObject({ 'Retry-After': '10' });
  });

  it("rounds up a pending sandbox's retryInMs to the next second", () => {
    const pending7_2s = new SandboxAffinityPendingError('m-0', 7_200);
    expect(turnErrorHeaders(503, pending7_2s)).toMatchObject({ 'Retry-After': '8' });
  });

  it('enforces a 1 s minimum for pending sandbox retryInMs', () => {
    const pending0 = new SandboxAffinityPendingError('m-0', 0);
    expect(turnErrorHeaders(503, pending0)).toMatchObject({ 'Retry-After': '1' });
  });

  it('uses the config default Retry-After for a plain saturation error (no retryInMs)', () => {
    const saturated = new SandboxPoolSaturatedError('app=sandbox');
    expect(turnErrorHeaders(503, saturated)).toMatchObject({ 'Retry-After': '5' });
  });

  it('adds no Retry-After to a non-503, even with a pending error', () => {
    const pending = new SandboxAffinityPendingError('m-0', 30_000);
    expect(turnErrorHeaders(500, pending)).not.toHaveProperty('Retry-After');
  });

  it('falls back to configured value when pending error has NaN retryInMs', () => {
    const pendingNaN = new SandboxAffinityPendingError('m-0', NaN);
    expect(turnErrorHeaders(503, pendingNaN)).toMatchObject({ 'Retry-After': '5' });
  });
});

describe('an expired config bundle', () => {
  it('is 410 config_bundle_not_found, not a 500', () => {
    const err = new BundleNotFoundError('sha256:' + 'a'.repeat(64));
    expect(turnErrorStatus(err)).toBe(410);
    expect(turnErrorCode(410)).toBe('config_bundle_not_found');
  });

  it('answers a stable code for every status, never the exception text', () => {
    expect(turnErrorCode(404)).toBe('session_not_found');
    expect(turnErrorCode(503)).toBe('sandbox_unavailable');
    expect(turnErrorCode(500)).toBe('internal_error');
  });
});
