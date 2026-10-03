import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact-url.js';

describe('redactUrl', () => {
  it('replaces a password-only userinfo', () => {
    expect(redactUrl('redis://:s3cret@redis.moca.svc:6379')).toBe(
      'redis://***@redis.moca.svc:6379',
    );
  });
  it('replaces user and password, keeping scheme, host, port and path', () => {
    expect(redactUrl('rediss://default:pw@[::1]:6380/0')).toBe('rediss://***@[::1]:6380/0');
  });
  it('replaces a username-only userinfo (an ACL user name is still an identifier)', () => {
    expect(redactUrl('redis://alice@h:6379')).toBe('redis://***@h:6379');
  });
  it('leaves a URL without credentials unchanged', () => {
    expect(redactUrl('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379');
  });
  it('leaves an unparseable string unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
