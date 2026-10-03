import { describe, expect, it, vi } from 'vitest';
import { RedisWorkQueue } from '../src/queue.js';

/**
 * A Redis credential must never appear in an error message or console output, even on connection failure.
 */
describe('RedisWorkQueue credential redaction', () => {
  it('never puts the Redis password into the unreachable error or the error log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    try {
      const queue = new RedisWorkQueue('redis://:topsecret@127.0.0.1:6399');
      const err = await queue.pending().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/unreachable/);
      expect(String(err)).not.toContain('topsecret');
      expect(logged.join('\n')).not.toContain('topsecret');
      await queue.close().catch(() => {});
    } finally {
      spy.mockRestore();
    }
  }, 20_000);
});
