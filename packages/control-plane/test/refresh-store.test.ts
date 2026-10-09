import { describe, expect, it } from 'vitest';
import {
  hashRefreshToken,
  isRefreshTokenShape,
  MemoryRefreshStore,
  newRefreshToken,
} from '../src/refresh-store.js';
import { refreshStoreContract } from './helpers/refresh-store-contract.js';

describe('refresh token helpers', () => {
  it('mints mrt_ + 43 base64url characters, distinct each time', () => {
    const a = newRefreshToken();
    expect(a).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
    expect(newRefreshToken()).not.toBe(a);
  });

  it('accepts only the exact shape, so junk never reaches a Redis lookup', () => {
    expect(isRefreshTokenShape(newRefreshToken())).toBe(true);
    for (const bad of [
      '',
      'mrt_',
      'mrt_short',
      'xrt_' + 'A'.repeat(43),
      'mrt_' + 'A'.repeat(10_000),
      42,
      null,
    ]) {
      expect(isRefreshTokenShape(bad)).toBe(false);
    }
  });

  it('hashes to lowercase hex sha256', () => {
    expect(hashRefreshToken('mrt_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken('mrt_x')).toBe(hashRefreshToken('mrt_x'));
  });
});

refreshStoreContract('memory', async (policy) => {
  const store = new MemoryRefreshStore(policy);
  return {
    store,
    audit: async () => store.audit,
    anonAudit: async () => store.anonAudit,
    done: async () => undefined,
  };
});
