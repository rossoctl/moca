import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A missing session must 404 BEFORE the turn touches the pool.
 *
 * Hoisting the lease into `executeTurn` put `acquireTurnSandbox` ahead of the session open, which
 * inverted the base order (open store → `openFromCheckpoint` → resolve sandbox, which took no lease).
 * Two things followed, and the second is the reason this is pinned rather than tidied:
 *
 *  - A `/turn` for a session that does not exist — a first-class documented outcome, and exactly what
 *    a client resuming after Redis expiry hits — did a pod list, an `n`-way `lease.load()` and an
 *    acquire/release against the lease ZSET before returning 404. Real pool work for a request that
 *    cannot succeed.
 *  - Worse, with the pool saturated or empty that request answered **503 (retryable)** instead of
 *    **404 `session_not_found` (permanent)**: the capacity error is thrown before the 404 can be
 *    raised, so `turnErrorStatus` never gets to prefer the 404 it tests for first. The caller is told
 *    to retry a session that will never exist — and in `records` mode with nothing attached yet, that
 *    is EVERY `/turn`.
 *
 * It also silently falsified two claims this same change makes: server.ts's "preserve /turn's
 * 404-on-missing-session contract", and the SSE path's "a bad sessionId still returns real 404 JSON,
 * byte-identical to the sync path (§3.4 regime 2)" — parity that held only because both paths were
 * equally wrong.
 *
 * The lease still lives in `executeTurn`, so its `finally` still covers every exit path; only the
 * session open moved ahead of it.
 */
const { selectCalls, FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read() {
      return [];
    }
    async latestWhere() {
      return null;
    }
    async append() {
      return {};
    }
    async list() {
      return [];
    }
    async close() {}
  }
  return { selectCalls: [] as string[], FakeRedisSessionBackend };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  DefaultResourceLoader: class {},
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 'sess-created' }),
    // What a `/turn` for an expired or never-created session gets.
    openFromCheckpoint: async () => {
      throw new Error('no session in backend');
    },
  },
  SettingsManager: { create: () => ({}) },
}));

// Intercept at the selection seam so the pool error is deterministic and, more importantly, so the
// test can assert the seam was never REACHED.
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: async (): Promise<never> => {
      selectCalls.push('selectPoolSandbox');
      throw new actual.SandboxPoolEmptyError('app=sandbox');
    },
  };
});

const { executeTurn } = await import('../src/run-turn.js');

beforeEach(() => {
  selectCalls.length = 0;
  process.env.KAGENTI_SANDBOX_POOL_SELECTOR = 'app=sandbox';
});

describe('executeTurn ordering: session existence before pool capacity', () => {
  it('reports the missing session, not the empty pool', async () => {
    // Both failures are armed. The one that surfaces is the contract.
    await expect(
      executeTurn({ prompt: 'hi', sessionId: 'gone', createIfAbsent: false }),
    ).rejects.toThrow('no session in backend');
  });

  it('does no pool work at all for a session that does not exist', async () => {
    await executeTurn({ prompt: 'hi', sessionId: 'gone', createIfAbsent: false }).catch(() => {});

    expect(selectCalls).toEqual([]);
  });
});
