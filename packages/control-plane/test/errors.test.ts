import { describe, expect, it } from 'vitest';
import { CP_ERROR_CODES, CpError, statusFor, writeError, type CpErrorCode } from '../src/errors.js';

/**
 * The expected status for EVERY code, transcribed independently of the STATUS map in errors.ts.
 *
 * Two properties, and they need each other. The KEYS are checked against CP_ERROR_CODES rather than
 * hand-listed, so adding a code without deciding its status fails here instead of passing silently --
 * which is what the old partial hand-list allowed: it asserted exact statuses for most codes and left
 * credential_not_found, invalid_json, invalid_request and internal_error to a `>= 400` loop that four
 * different wrong answers would satisfy. The VALUES stay written out rather than derived from STATUS,
 * because a test that reads its expectation from the thing under test shrinks along with it.
 */
const EXPECTED: Record<CpErrorCode, number> = {
  invalid_json: 400,
  invalid_request: 400,
  token_required: 401,
  token_invalid: 401,
  token_expired: 401,
  // 400, as RFC 6749 §5.2 answers a refused grant: the refresh token is unknown, revoked, expired
  // or a replayed predecessor. One code for all four, so a client's only move is "log in again".
  invalid_grant: 400,
  subject_conflict: 400,
  unauthorized: 401,
  forbidden: 403,
  // 404, not 403, for another user's session: a 403 is an existence oracle (spec §8.1).
  session_not_found: 404,
  session_mismatch: 400,
  digest_mismatch: 400,
  bundle_quota_exceeded: 429,
  config_bundle_not_found: 404,
  configRef_invalid: 400,
  credential_required: 400,
  credential_ambiguous: 400,
  credential_not_found: 404,
  credential_unavailable: 503,
  endpoint_unresolved: 400,
  // 428 Precondition Required: a polling client tells "not yet" from "denied" without a body read.
  authorization_pending: 428,
  // 410 Gone: the device code itself is spent; a client starts a new one rather than polling on.
  device_code_expired: 410,
  // 502: GitHub refused the control plane's own OAuth-app configuration; no caller input fixes it.
  identity_provider_misconfigured: 502,
  redis_unavailable: 503,
  internal_error: 500,
};

describe('statusFor', () => {
  it('maps EVERY code in CP_ERROR_CODES to the exact status spec §9.1 fixes', () => {
    for (const code of CP_ERROR_CODES) {
      expect(EXPECTED[code], `${code} has no expected status in this test`).toBeDefined();
      expect(statusFor(code), code).toBe(EXPECTED[code]);
    }
  });

  it('has an expectation for every code and no code left over on either side', () => {
    // Catches the other direction too: a code deleted from CP_ERROR_CODES but still expected here.
    expect([...CP_ERROR_CODES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('never answers with a non-error status', () => {
    for (const code of CP_ERROR_CODES) {
      expect(statusFor(code), code).toBeGreaterThanOrEqual(400);
      expect(statusFor(code), code).toBeLessThan(600);
    }
  });
});

/** Minimal ServerResponse stand-in: records the status and the single written body. */
function fakeRes() {
  const calls: { status?: number; headers?: unknown; body?: string } = {};
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: unknown) {
      calls.status = status;
      calls.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body?: string) {
      calls.body = body;
      return res;
    },
  };
  return { res, calls };
}

describe('writeError', () => {
  it('writes the repo-standard body shape', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new CpError('credential_required', 'no inference credential'));
    expect(calls.status).toBe(400);
    expect(calls.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(calls.body!)).toEqual({
      error: 'credential_required',
      message: 'no inference credential',
    });
  });

  it('includes sessionId only when the error carries one', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new CpError('session_not_found', undefined, 'sid-1'));
    expect(JSON.parse(calls.body!)).toEqual({ error: 'session_not_found', sessionId: 'sid-1' });
  });

  it('maps an unknown throwable to internal_error without leaking its message', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new Error('ECONNREFUSED redis://10.0.0.1:6379 password=hunter2'));
    expect(calls.status).toBe(500);
    // The message is deliberately dropped: an arbitrary throwable's text can carry connection
    // strings or a presented token, and this body goes to an arbitrary caller.
    expect(JSON.parse(calls.body!)).toEqual({ error: 'internal_error' });
  });

  it('does nothing once headers are already sent', () => {
    const { res, calls } = fakeRes();
    res.headersSent = true;
    writeError(res as never, new CpError('forbidden'));
    expect(calls.status).toBeUndefined();
  });
});
