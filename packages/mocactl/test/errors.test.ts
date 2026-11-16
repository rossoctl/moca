import { describe, expect, it } from 'vitest';
import { ApiError, classify, errorFromResponse, networkError } from '../src/api/errors.js';
import { describeError } from '../src/core/messages.js';
import { json } from './helpers/fake-fetch.js';

describe('errorFromResponse', () => {
  it('reads the error code, message and Retry-After', async () => {
    const e = await errorFromResponse(
      'harness',
      json({ error: 'saturated', message: 'no capacity' }, 503, { 'retry-after': '4' }),
    );
    expect(e).toMatchObject({
      source: 'harness',
      status: 503,
      code: 'saturated',
      message: 'no capacity',
      retryAfterS: 4,
    });
  });

  it('falls back to http_<status> for a non-JSON body', async () => {
    const e = await errorFromResponse('control-plane', new Response('oops', { status: 502 }));
    expect(e.code).toBe('http_502');
    expect(e.retryAfterS).toBeUndefined();
  });

  it("reads body.reason when body.error is absent so {status:'failed', reason:'saturated'} maps to code=saturated", async () => {
    // /runs reports failures as {status:'failed', reason:'<code>'}; the client's err.code check
    // (e.g. the worker's saturated-retry guard) needs the semantic code regardless of body shape.
    const e = await errorFromResponse(
      'harness',
      json({ status: 'failed', reason: 'saturated' }, 503, { 'retry-after': '2' }),
    );
    expect(e.code).toBe('saturated');
    expect(e.retryAfterS).toBe(2);
  });
});

describe('errorFromResponse: a reason beside the error code', () => {
  it("carries the body's reason onto the error (SBX0 sandbox_terminated)", async () => {
    const e = await errorFromResponse(
      'control-plane',
      json({ error: 'sandbox_terminated', message: 'sandbox was deleted', reason: 'deleted' }, 409),
    );
    expect(e).toMatchObject({ code: 'sandbox_terminated', reason: 'deleted', status: 409 });
  });

  it('has no reason when the body has none, or when the reason is the code', async () => {
    expect(
      (await errorFromResponse('control-plane', json({ error: 'x' }, 400))).reason,
    ).toBeUndefined();
    const runs = await errorFromResponse(
      'harness',
      json({ status: 'failed', reason: 'saturated' }, 503),
    );
    expect(runs.code).toBe('saturated');
    expect(runs.reason).toBeUndefined();
  });
});

describe('classify', () => {
  const err = (
    source: 'control-plane' | 'harness',
    status: number,
    code: string,
    retryAfterS?: number,
  ) => new ApiError(source, status, code, undefined, retryAfterS);

  it.each([
    [err('control-plane', 401, 'token_expired'), { kind: 'login' }],
    [err('control-plane', 401, 'token_invalid'), { kind: 'login' }],
    [err('harness', 401, 'token_invalid'), { kind: 'harness-token-rejected' }],
    [err('harness', 401, 'token_required'), { kind: 'harness-token-rejected' }],
    [err('control-plane', 404, 'session_not_found'), { kind: 'session-gone' }],
    [err('harness', 503, 'saturated', 4), { kind: 'retry-after', seconds: 4 }],
    [
      err('control-plane', 503, 'redis_unavailable'),
      { kind: 'unavailable', source: 'control-plane' },
    ],
    [err('harness', 503, 'credential_unavailable'), { kind: 'unavailable', source: 'harness' }],
    [err('control-plane', 500, 'internal_error'), { kind: 'unavailable', source: 'control-plane' }],
  ])('%s -> %j', (e, action) => {
    expect(classify(e)).toEqual(action);
  });

  it('names the failing endpoint for a network error', () => {
    expect(classify(networkError('harness', new Error('ECONNREFUSED')))).toEqual({
      kind: 'connection',
      source: 'harness',
      message: 'ECONNREFUSED',
    });
  });

  it('tells a connection closed under the request from one that was never made', () => {
    const closed = (code: string) =>
      networkError('harness', new TypeError('fetch failed', { cause: { code } }));
    expect(closed('UND_ERR_SOCKET').code).toBe('connection_dropped');
    expect(closed('ECONNRESET').code).toBe('connection_dropped');
    expect(closed('ECONNREFUSED').code).toBe('network_error');
    expect(closed('ENOTFOUND').code).toBe('network_error');
    expect(networkError('harness', new TypeError('fetch failed')).code).toBe('network_error');
  });

  it("folds in the cause's message when the cause has no code (#700)", () => {
    const err = networkError(
      'control-plane',
      new TypeError('fetch failed', { cause: new Error('unknown scheme') }),
    );
    expect(err.message).toBe('fetch failed: unknown scheme');
  });

  it('classifies identity_provider_misconfigured as the operator\'s fix, not as "unavailable"', () => {
    // A 502, so without its own branch it would fall into the >= 500 "try again shortly" (#405).
    expect(
      classify(new ApiError('control-plane', 502, 'identity_provider_misconfigured', 'tick it')),
    ).toEqual({ kind: 'operator-misconfigured', message: 'tick it' });
  });

  it('shows endpoint_unresolved and unknown codes with their message', () => {
    expect(classify(new ApiError('harness', 400, 'endpoint_unresolved', 'no gateway'))).toEqual({
      kind: 'endpoint-unresolved',
      message: 'no gateway',
    });
    expect(classify(new ApiError('control-plane', 400, 'brand_new_code', 'hi'))).toEqual({
      kind: 'show',
      message: 'hi',
    });
  });
});

it('maps a missing config bundle, at turn time or at creation, to one action and message', () => {
  for (const err of [
    new ApiError('harness', 410, 'config_bundle_not_found'),
    new ApiError('control-plane', 404, 'config_bundle_not_found', 'no config bundle'),
  ]) {
    expect(classify(err)).toEqual({ kind: 'bundle-expired' });
    expect(describeError(err)).toBe(
      "this session's config bundle is gone (expired or never uploaded) — promote the same directory again; if it changed, start a new session",
    );
  }
});

it('maps a full config-bundle budget to its own action and one-line message', () => {
  const err = new ApiError('control-plane', 429, 'bundle_quota_exceeded', 'over budget');
  expect(classify(err)).toEqual({ kind: 'bundle-quota' });
  expect(describeError(err)).toBe(
    "the control plane's config-bundle storage is full for your account or the deployment — free yours with `mocactl bundles delete DIGEST`, or ask the operator",
  );
});
