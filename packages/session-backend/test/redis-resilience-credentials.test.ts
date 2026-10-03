import { describe, expect, it, vi } from 'vitest';
import { RedisSessionBackend } from '../src/redis-backend.js';

/**
 * A Redis credential must never appear in an error message or console output, even on connection failure.
 */
describe('RedisSessionBackend credential redaction', () => {
  it('never puts the Redis password into the unreachable error or the error log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    try {
      const store = new RedisSessionBackend('redis://:topsecret@127.0.0.1:6399');
      const err = await store.list().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/unreachable/);
      expect(String(err)).not.toContain('topsecret');
      expect(logged.join('\n')).not.toContain('topsecret');
      await store.close().catch(() => {});
    } finally {
      spy.mockRestore();
    }
  }, 20_000);
});
