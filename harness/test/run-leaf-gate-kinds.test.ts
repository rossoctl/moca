import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { BufferedRedisBackend } from '../src/buffered-redis-backend';
import { GATE_REQUEST_ENTRY_TYPE, GATE_DECISION_ENTRY_TYPE, gatePromptNote } from '../src/gate';

/**
 * #393 §1: the gate on a PROMPT leaf -- the kind that had none. Real Redis for the durable session
 * (the gate state lives in session entries, and a fake backend cannot satisfy
 * `SessionManager.openFromCheckpoint`), an injected `executeTurn` for the Pi stack, and a mocked
 * `selectPoolSandbox` so a parked leaf can be observed holding no lease.
 */
const { selectPoolSandbox } = vi.hoisted(() => ({ selectPoolSandbox: vi.fn() }));
vi.mock('../src/select-sandbox.js', async (orig) => ({
  ...((await orig()) as object),
  selectPoolSandbox,
}));

const { runLeaf } = await import('../src/run-leaf.js');
const { sharedSessionStore, resetSharedSessionStore } = await import('../src/run-turn.js');

const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const CONFIG = { redisUrl: REDIS };
// The same memoised instance `planLeafGate` reads through, so `read` can be observed here.
const store = sharedSessionStore(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  resetSharedSessionStore();
});

const spyRead = () => vi.spyOn(store, 'read');
let read: ReturnType<typeof spyRead>;
beforeEach(() => {
  // A call would mean the pre-lease short-circuit missed; null keeps the failure legible.
  selectPoolSandbox.mockReset().mockResolvedValue(null);
  read = spyRead();
});

/** Seed a session whose newest gate request is unanswered, the way request_approval leaves it. */
async function pendingGate(sid: string): Promise<void> {
  sids.push(sid);
  const backend = new BufferedRedisBackend(store);
  const sm = SessionManager.create(process.cwd(), undefined, { id: sid }, backend);
  sm.appendCustomEntry(GATE_REQUEST_ENTRY_TYPE, {
    gateId: 0,
    summary: 'found it',
    proposed_action: 'write the file',
  });
  await backend.flush();
}

const env = (sessionId: string, extra: Record<string, unknown> = {}) => {
  sids.push(sessionId);
  return { sessionId, kind: 'prompt', prompt: 'do the thing', ...extra } as never;
};

async function customTypes(sid: string): Promise<string[]> {
  const rows = await store.read(sid);
  return rows
    .map((r) => (r.entry as { customType?: string }).customType)
    .filter((t): t is string => !!t);
}

describe('a gated prompt leaf', () => {
  it('registers request_approval and reports the gate it captured', async () => {
    // The fake executeTurn stands in for the Pi stack: it uses the seam the leaf wired in.
    const executeTurn = vi.fn(async (input: Record<string, unknown>) => {
      const gate = input.gate as { capture: Record<string, unknown>; nextGateId: number };
      expect(gate.nextGateId).toBe(0);
      expect(String(input.prompt)).toContain(gatePromptNote());
      expect(String(input.prompt)).toContain('do the thing');
      gate.capture.gate = { gateId: 0, summary: 'found it', proposed_action: 'write the file' };
      return { response: 'pre-gate chatter', stopReason: 'end_turn' };
    });
    const res = await runLeaf(env('gate-kinds-fresh', { requireApproval: true }), CONFIG, {
      executeTurn,
    } as never);
    expect(res).toEqual({
      status: 'paused',
      gateId: 0,
      gate: { summary: 'found it', proposed_action: 'write the file' },
    });
  });

  it('parks a re-dispatch with no decision, without running a turn or leasing', async () => {
    const sid = 'gate-kinds-park';
    await pendingGate(sid);
    const executeTurn = vi.fn();
    const res = await runLeaf(env(sid, { requireApproval: true }), CONFIG, {
      executeTurn,
    } as never);
    expect(res).toMatchObject({ status: 'paused', gateId: 0 });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(selectPoolSandbox).not.toHaveBeenCalled();
  });

  it('seeds the approve continuation instead of the original prompt', async () => {
    const sid = 'gate-kinds-approve';
    await pendingGate(sid);
    const executeTurn = vi.fn(async (input: Record<string, unknown>) => {
      expect(String(input.prompt)).toContain('Human decision: APPROVED');
      expect(String(input.prompt)).not.toContain('do the thing');
      return { response: 'done', stopReason: 'end_turn' };
    });
    const res = await runLeaf(
      env(sid, {
        requireApproval: true,
        decision: { gateId: 0, action: 'approve', feedback: 'go' },
      }),
      CONFIG,
      { executeTurn } as never,
    );
    expect(res).toMatchObject({ status: 'responded', text: 'done' });
    // The decision is durable: a redelivery resumes from it rather than re-pausing.
    expect(await customTypes(sid)).toContain(GATE_DECISION_ENTRY_TYPE);
  });

  it('aborts on an abort decision without running a turn or leasing', async () => {
    const sid = 'gate-kinds-abort';
    await pendingGate(sid);
    const executeTurn = vi.fn();
    const res = await runLeaf(
      env(sid, { requireApproval: true, decision: { gateId: 0, action: 'abort' } }),
      CONFIG,
      { executeTurn } as never,
    );
    expect(res).toEqual({ status: 'aborted' });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(selectPoolSandbox).not.toHaveBeenCalled();
    expect(await customTypes(sid)).toContain(GATE_DECISION_ENTRY_TYPE);
  });

  it('wires no gate and reads no session state when requireApproval is absent', async () => {
    const executeTurn = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.gate).toBeUndefined();
      expect(String(input.prompt)).not.toContain(gatePromptNote());
      return { response: 'hi', stopReason: 'end_turn' };
    });
    const res = await runLeaf(env('gate-kinds-ungated'), CONFIG, { executeTurn } as never);
    expect(res).toMatchObject({ status: 'responded', text: 'hi' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a gated solve leaf', () => {
  const solve = (sessionId: string, extra: Record<string, unknown> = {}) => {
    sids.push(sessionId);
    return {
      sessionId,
      kind: 'solve',
      problemStatement: 'fix the bug',
      repoUrl: 'https://example.invalid/r.git',
      ref: 'main',
      requireApproval: true,
      ...extra,
    } as never;
  };

  it('reports the gate its produce captured', async () => {
    const produceSolve = vi.fn(async (_e, _c, capture, _d, _s, gate) => {
      expect(gate).toEqual({ nextGateId: 0 });
      capture.gate = { gateId: 0, summary: 's', proposed_action: 'p' };
    });
    const res = await runLeaf(solve('gate-kinds-solve-fresh'), CONFIG, { produceSolve } as never);
    expect(res).toEqual({
      status: 'paused',
      gateId: 0,
      gate: { summary: 's', proposed_action: 'p' },
    });
  });

  it('parks a re-dispatch with no decision, without producing', async () => {
    const sid = 'gate-kinds-solve-park';
    await pendingGate(sid);
    const produceSolve = vi.fn();
    const res = await runLeaf(solve(sid), CONFIG, { produceSolve } as never);
    expect(res).toMatchObject({ status: 'paused', gateId: 0 });
    expect(produceSolve).not.toHaveBeenCalled();
  });

  it('hands the approve continuation to produce', async () => {
    const sid = 'gate-kinds-solve-approve';
    await pendingGate(sid);
    const produceSolve = vi.fn(async (_e, _c, capture, _d, _s, gate) => {
      expect(String(gate.continuation)).toContain('Human decision: APPROVED');
      capture.patch = 'diff --git a/x b/x\n';
    });
    const res = await runLeaf(solve(sid, { decision: { gateId: 0, action: 'approve' } }), CONFIG, {
      produceSolve,
    } as never);
    expect(res).toMatchObject({ status: 'solved' });
    expect(await customTypes(sid)).toContain(GATE_DECISION_ENTRY_TYPE);
  });

  it('re-converges on a resume: produce gets the repo inputs again (#393 §4)', async () => {
    const sid = 'gate-kinds-solve-reconverge';
    await pendingGate(sid);
    const produceSolve = vi.fn(async (e, _c, capture) => {
      // `realProduceSolve` converges from exactly these two fields, and a resume reaches it by the
      // same path a fresh dispatch does -- which is what makes an hour-long gate survivable: the
      // workspace is REBUILT rather than carried. The script's own self-healing and
      // keep-the-baseline behaviour is pinned in converge.test.ts.
      expect(e).toMatchObject({ repoUrl: 'https://example.invalid/r.git', ref: 'main' });
      // And nothing pins the resume to the sandbox it paused on: no workspaceRef crossed the gate.
      expect((e as { workspaceRef?: string }).workspaceRef).toBeUndefined();
      capture.patch = 'diff --git a/x b/x\n';
    });
    const res = await runLeaf(solve(sid, { decision: { gateId: 0, action: 'approve' } }), CONFIG, {
      produceSolve,
    } as never);
    expect(res).toMatchObject({ status: 'solved' });
    expect(produceSolve).toHaveBeenCalledTimes(1);
  });

  it('aborts without producing', async () => {
    const sid = 'gate-kinds-solve-abort';
    await pendingGate(sid);
    const produceSolve = vi.fn();
    const res = await runLeaf(solve(sid, { decision: { gateId: 0, action: 'abort' } }), CONFIG, {
      produceSolve,
    } as never);
    expect(res).toEqual({ status: 'aborted' });
    expect(produceSolve).not.toHaveBeenCalled();
  });
});
