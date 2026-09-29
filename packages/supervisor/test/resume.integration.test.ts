import { describe, it, expect } from 'vitest';
import { RedisSessionBackend } from '@moca/session-backend';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * Gated on REDIS_URL being SET, not on probing for a server.
 *
 * vitest.config.ts includes `test/**\/*.test.ts`, so without a guard this ran unconditionally and
 * `pnpm test` in packages/supervisor FAILED rather than skipped on any machine without a live Redis.
 * CI hides that because CI has Redis -- which is exactly why it is worth guarding: the person who
 * hits it is someone cloning the repo for the first time, and what they see is a red suite with a
 * connection error rather than "1 skipped".
 *
 * Gating on the variable rather than probing keeps it deterministic, and makes the requirement
 * explicit instead of implicit in the `??` default above. SH_TEST_REDIS=1 is the escape hatch for a
 * Redis on the default URL. The convention is handoff.integration.test.ts's, which skips on
 * `process.platform !== 'linux'` for its /proc/self/fd dependency with the same reasoning: the case
 * would FAIL rather than skip without it.
 *
 * The property here -- a session outliving the worker that wrote it -- is worth keeping. It just
 * should not be the reason a fresh checkout looks broken.
 */
const hasRedis = process.env.REDIS_URL !== undefined || process.env.SH_TEST_REDIS === '1';

describe.skipIf(!hasRedis)('session survives the worker that started it', () => {
  it('a second worker reads the state the first one wrote', async () => {
    // The supervisor is process-level, and §6 accepts that a worker crash kills its in-flight
    // turns. What must NOT be lost is the session: it lives in Redis, exactly as it does when
    // a pod is evicted. Same property, new failure mode.
    const a = new RedisSessionBackend<{ role: string; content: string }>(REDIS_URL);
    const b = new RedisSessionBackend<{ role: string; content: string }>(REDIS_URL);
    const sid = `p6-resume-${process.pid}-${Date.now()}`;
    try {
      await a.append(sid, { role: 'user', content: 'first turn' }, 'message');
      // "Worker A dies here." Nothing about the state is worker-local.
      await a.close();
      const restored = await b.read(sid);
      expect(restored.map((m) => m.entry.content)).toContain('first turn');
      await b.append(sid, { role: 'user', content: 'second turn' }, 'message');
      expect((await b.read(sid)).length).toBe(2);
    } finally {
      // reset() needs a live client, so it must run before close() tears the connection down.
      await b.reset(sid).catch(() => {});
      await b.close().catch(() => {});
    }
  });
});
