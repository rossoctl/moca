import { describe, it, expect, vi } from 'vitest';
import { turnLeaseHolder } from '../src/run-turn.js';

/**
 * TWO identities, and they must not be the same value.
 *
 * The lease HOLDER id is the ZSET member in `ACQUIRE_LUA` and must be unique per TURN. The session id
 * is what keys the microVM workspace (`workspace_key`, spec §3.4) and must be STABLE across the turns
 * of a session. Deriving one from the other breaks whichever end it is derived towards, so
 * `selectPoolSandbox` now takes both and this file pins both directions.
 *
 * The holder id must be unique per TURN. It used to be `input.sessionId ?? randomUUID()`, which is
 * the negation of that: a session id is stable across every turn of a session, so the `??` reached
 * `randomUUID()` only for ANONYMOUS turns while every turn carrying a session id — the resume path —
 * ran under a runId shared with every other turn of that session.
 *
 * Sharing it is not benign, because the runId is the ZSET member in ACQUIRE_LUA rather than a
 * payload. `ZADD` on an existing member refreshes its score and leaves `ZCARD` unchanged, so N
 * concurrent turns of one session occupy ONE lease slot: the cap undercounts (deflating the
 * saturation accounting this PR's 503 is computed from) and the first turn to finish `zRem`s the
 * member its siblings are still executing under.
 *
 * `run-turn-sandbox.test.ts` covers `acquireTurnSandbox` at its own seam, so it could not see this —
 * the defect was in the ONE expression feeding that seam, inside `executeTurn`, which no test drove.
 * Hence the wiring cases below. `acquireTurnSandbox` now derives the holder itself from the session
 * id, so no caller can hand it a shared value.
 */
const { seen, seenSessionIds, FakeRedisSessionBackend } = vi.hoisted(() => {
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
  return { seen: [] as string[], seenSessionIds: [] as string[], FakeRedisSessionBackend };
});

// The session is opened BEFORE the sandbox is acquired (so a missing session 404s ahead of any pool
// work — turn-session-before-lease.test.ts pins that ordering), which is why this test has to stand a
// session up at all: it is on the path to the seam being observed here. Both fakes are inert; no Redis.
vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  DefaultResourceLoader: class {},
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: (_cwd: string, _snapshot: unknown, opts?: { id: string }) => ({
      getSessionId: () => opts?.id ?? 'sess-created',
    }),
    openFromCheckpoint: async (sid: string) => ({ getSessionId: () => sid }),
  },
  SettingsManager: { create: () => ({}) },
}));

// Intercept at selectPoolSandbox so executeTurn's real derivation runs and is observable, while the
// turn stops before executeTurnCore — no model, no prompt.
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: async (
      _env: NodeJS.ProcessEnv,
      _headCwd: string,
      sessionId: string,
      opts: { holderId?: string },
    ): Promise<never> => {
      seenSessionIds.push(sessionId);
      seen.push(opts.holderId ?? sessionId);
      throw new Error('stop: the two ids are all this test needs');
    },
  };
});

describe('turnLeaseHolder', () => {
  it('is distinct for two turns of the SAME session', () => {
    expect(turnLeaseHolder('sess-1')).not.toBe(turnLeaseHolder('sess-1'));
  });

  it('is distinct for two anonymous turns', () => {
    expect(turnLeaseHolder()).not.toBe(turnLeaseHolder());
  });

  it('prefixes the session id so a held lease can be traced back to a conversation', () => {
    expect(turnLeaseHolder('sess-1')).toMatch(/^sess-1:[0-9a-f-]{36}$/);
    expect(turnLeaseHolder()).toMatch(/^anon:[0-9a-f-]{36}$/);
  });
});

describe('executeTurn lease holder id', () => {
  it('leases under a distinct holder id on every turn of one session', async () => {
    const { executeTurn } = await import('../src/run-turn.js');
    const turn = () =>
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: false,
      }).catch(() => {});

    await turn();
    await turn();

    // This is the assertion that failed on the old expression: both turns arrived as 'sess-1'.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((id) => id.startsWith('sess-1:'))).toBe(true);
  });

  it('passes the SESSION id unchanged, so both turns key one workspace', async () => {
    // The other direction, and the one the #279 rebase exposed. `selectPoolSandbox` feeds its third
    // argument to `workspaceKey`, so handing it the per-turn holder gave every turn of a session a
    // fresh `WorkspaceRoot/<key>` on the microVM tier: turn 2 opens an empty workspace and allocates
    // its own standby pool, which is cross-turn continuity lost and standby VMs multiplied per turn.
    seen.length = 0;
    seenSessionIds.length = 0;
    const { executeTurn } = await import('../src/run-turn.js');
    const turn = () =>
      executeTurn({ prompt: 'hi', sessionId: 'sess-2', createIfAbsent: false }).catch(() => {});

    await turn();
    await turn();

    expect(seenSessionIds).toEqual(['sess-2', 'sess-2']);
    // ...while the holders under which those two turns hold their leases stay distinct.
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('falls back to the unique holder as the workspace key for an ANONYMOUS turn', async () => {
    // With no session there is no continuity to preserve, and sharing one 'anon' workspace across
    // unrelated turns would be the cross-contamination §2.3 is about. An empty key is worse still:
    // microvm-worker REFUSES it (§3.4). So the per-turn holder is the right key here.
    seen.length = 0;
    seenSessionIds.length = 0;
    const { executeTurn } = await import('../src/run-turn.js');
    await executeTurn({ prompt: 'hi', createIfAbsent: true }).catch(() => {});

    expect(seenSessionIds).toHaveLength(1);
    expect(seenSessionIds[0]).toMatch(/^anon:[0-9a-f-]{36}$/);
    expect(seenSessionIds[0]).toBe(seen[0]);
  });
});
