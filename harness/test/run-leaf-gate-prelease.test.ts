import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { RedisSessionBackend } from '@moca/session-backend';
import { BufferedRedisBackend } from '../src/buffered-redis-backend';
import { GATE_REQUEST_ENTRY_TYPE } from '../src/gate';

/**
 * #393 §1: a converge leaf that is parked at a gate -- or aborted -- must answer before it leases a
 * sandbox. The lease is the thing under test, so it is observed where it is taken.
 */
const { selectPoolSandbox } = vi.hoisted(() => ({ selectPoolSandbox: vi.fn() }));
vi.mock('../src/select-sandbox.js', async (orig) => ({
  ...((await orig()) as object),
  selectPoolSandbox,
}));

const { runLeaf } = await import('../src/run-leaf.js');

const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

beforeEach(() => {
  selectPoolSandbox.mockReset();
  // A call would mean the short-circuit missed; returning null keeps the failure legible rather
  // than exploding on a mock with no return value.
  selectPoolSandbox.mockResolvedValue(null);
});

/** Seed a session whose newest gate request is unanswered, the way request_approval leaves it. */
async function pendingGate(sid: string): Promise<void> {
  sids.push(sid);
  const backend = new BufferedRedisBackend(store);
  const sm = SessionManager.create(process.cwd(), undefined, { id: sid }, backend);
  sm.appendCustomEntry(GATE_REQUEST_ENTRY_TYPE, {
    gateId: 0,
    summary: 's',
    proposed_action: 'p',
  });
  await backend.flush();
}

const env = (sessionId: string, decision?: unknown) =>
  ({
    sessionId,
    item: { item_id: 'a', file: 'x.py', pattern: 'p', require_approval: true },
    repoUrl: 'https://example.invalid/r.git',
    ref: 'main',
    ...(decision ? { decision } : {}),
  }) as never;

describe('a parked converge leaf leases nothing', () => {
  it('returns paused without calling selectPoolSandbox', async () => {
    const sid = 'gate-prelease-paused';
    await pendingGate(sid);
    const res = await runLeaf(env(sid), { redisUrl: REDIS });
    expect(res).toEqual({
      status: 'paused',
      gateId: 0,
      gate: { summary: 's', proposed_action: 'p' },
    });
    expect(selectPoolSandbox).not.toHaveBeenCalled();
  });

  it('returns aborted without calling selectPoolSandbox', async () => {
    const sid = 'gate-prelease-aborted';
    await pendingGate(sid);
    const res = await runLeaf(env(sid, { gateId: 0, action: 'abort' }), { redisUrl: REDIS });
    expect(res).toEqual({ status: 'aborted' });
    expect(selectPoolSandbox).not.toHaveBeenCalled();
    // The decision is durable: a redelivery of this leaf must abort again rather than re-run.
    const entries = (await store.read(sid)).map((r) => r.entry as { customType?: string });
    expect(entries.some((e) => e.customType === 'gate-decision')).toBe(true);
  });
});
