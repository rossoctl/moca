import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { describeError, describeLoginError } from '../src/core/messages.js';
import { HarnessUntrustedError } from '../src/core/session-manager.js';

describe('describeError', () => {
  it.each([
    [
      new ApiError('control-plane', 401, 'token_expired'),
      'your login has expired — run `mocactl login` (or restart mocactl) to log in again',
    ],
    [
      new ApiError('control-plane', 404, 'session_not_found'),
      'that session no longer exists, or is not yours',
    ],
    [
      new ApiError('harness', 0, 'network_error', 'ECONNREFUSED'),
      'cannot reach the harness: ECONNREFUSED',
    ],
    [
      new ApiError('harness', 0, 'connection_dropped', 'fetch failed'),
      'the harness closed the connection (a proxy idle timeout?)',
    ],
    [
      new ApiError('harness', 503, 'saturated', undefined, 4),
      'the harness has no capacity — retry in 4s',
    ],
    [
      new ApiError('control-plane', 503, 'redis_unavailable'),
      'the control plane is unavailable — try again shortly',
    ],
    [
      new ApiError(
        'control-plane',
        502,
        'identity_provider_misconfigured',
        'tick Enable Device Flow',
      ),
      'the control plane cannot log anyone in until its operator fixes it — tick Enable Device Flow',
    ],
    [new HarnessUntrustedError(), new HarnessUntrustedError().message],
    ['plain', 'plain'],
  ])('%#', (err, text) => {
    expect(describeError(err)).toBe(text);
  });
});

// #700: a login failure names the control plane it tried and what came back.
describe('describeLoginError', () => {
  const URL_ = 'https://cp.example.invalid';
  it.each([
    [
      new ApiError('control-plane', 503, 'redis_unavailable', 'redis is down'),
      `the control plane at ${URL_} is unavailable (HTTP 503 redis_unavailable: redis is down) — try again shortly`,
    ],
    [
      new ApiError('control-plane', 503, 'redis_unavailable'),
      `the control plane at ${URL_} is unavailable (HTTP 503 redis_unavailable) — try again shortly`,
    ],
    [
      new ApiError('control-plane', 504, 'http_504'),
      `the control plane at ${URL_} is unavailable (HTTP 504, not an API answer: a proxy?) — try again shortly`,
    ],
    [
      new ApiError('control-plane', 400, 'invalid_request', 'label too long'),
      `label too long (the control plane at ${URL_}: HTTP 400 invalid_request)`,
    ],
    [
      new ApiError('control-plane', 502, 'identity_provider_misconfigured', 'tick it'),
      `the control plane at ${URL_} cannot log anyone in until its operator fixes it — tick it (HTTP 502 identity_provider_misconfigured)`,
    ],
    [
      new ApiError('control-plane', 0, 'network_error', 'fetch failed (ECONNREFUSED)'),
      `cannot reach the control plane at ${URL_}: fetch failed (ECONNREFUSED)`,
    ],
    [
      new ApiError('control-plane', 0, 'connection_dropped', 'fetch failed (ECONNRESET)'),
      `the control plane at ${URL_} closed the connection (a proxy idle timeout?): fetch failed (ECONNRESET)`,
    ],
    [
      new SyntaxError('Unexpected token < in JSON'),
      `Unexpected token < in JSON (from the control plane at ${URL_})`,
    ],
  ])('%#', (err, text) => {
    expect(describeLoginError(err, URL_)).toBe(text);
  });

  it('never prints a password or query the URL was configured with', () => {
    const text = describeLoginError(
      new ApiError('control-plane', 503, 'redis_unavailable'),
      'https://user:hunter2@cp.example.invalid/base/?key=hunter2#x',
    );
    expect(text).toContain('the control plane at https://cp.example.invalid/base is unavailable');
    expect(text).not.toContain('hunter2');
  });

  it('strips escape sequences from the server text', () => {
    const text = describeLoginError(
      new ApiError('control-plane', 503, 'redis_unavailable', 'down\u001b]52;c;ZXZpbA==\u0007'),
      URL_,
    );
    expect(text).not.toContain('\u001b');
  });
});
