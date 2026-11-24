import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCancel } from '../src/subagent.js';
import { openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { ApiError } from '../src/api/errors.js';

function makeRt(scratch: string, cancelTurn: unknown = vi.fn()) {
  return {
    cp: { cancelTurn },
    harness: { baseUrl: vi.fn(async () => 'https://harness.test') },
    auth: { subject: 'alice', apiToken: 'x', expiresAt: 999 },
    paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
    now: () => 10_000,
    fetchImpl: fetch,
  } as any;
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const seed = (rt: any, over: Partial<LedgerRecord> = {}): void => {
  openLedger(rt.paths.subagentsFile, rt.now).append({
    sessionId: 's1',
    envelope: { kind: 'prompt', prompt: 'p' },
    submittedAt: 1,
    lastKnownState: 'running',
    stateObservedAt: 1,
    ...over,
  });
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cancel-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('cmdCancel', () => {
  it('a queued turn is cancelled, and says so', async () => {
    const cancelTurn = vi.fn(async () => ({ turnId: 't1', state: 'cancelled' }));
    const rt = makeRt(scratch, cancelTurn);
    seed(rt, { turnId: 't1' });
    const { io, out } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: 's1', json: true })).toBe(0);
    expect(cancelTurn).toHaveBeenCalledWith('s1', 't1');
    expect(JSON.parse(out[0]!)).toEqual({ sessionId: 's1', turnId: 't1', state: 'cancelled' });
  });

  it('a running turn is only asked to stop, and the answer carries cancelRequested', async () => {
    const rt = makeRt(
      scratch,
      vi.fn(async () => ({ turnId: 't1', state: 'running', cancelRequested: true })),
    );
    seed(rt, { turnId: 't1' });
    const { io, out, err } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: 's1', json: true })).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      sessionId: 's1',
      turnId: 't1',
      state: 'running',
      cancelRequested: true,
    });
    expect(err.join('\n')).toContain('mocactl get s1');
  });

  it('refuses a sync row: it has no turn record to cancel', async () => {
    const cancelTurn = vi.fn();
    const rt = makeRt(scratch, cancelTurn);
    seed(rt, { childPid: process.pid });
    const { io, out, err } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: 's1', json: true })).toBe(1);
    expect(cancelTurn).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('without --async');
  });

  it("refuses a session this machine's ledger does not hold", async () => {
    const rt = makeRt(scratch);
    const { io, err } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: 'elsewhere', json: true })).toBe(1);
    expect(err.join('\n')).toContain('no ledger row');
  });

  it('reports a refused cancel and leaves the ledger row alone', async () => {
    const rt = makeRt(
      scratch,
      vi.fn(async () => {
        throw new ApiError('control-plane', 409, 'turn_not_cancellable', 'turn t1 is already done');
      }),
    );
    seed(rt, { turnId: 't1' });
    const { io, out, err } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: 's1', json: true })).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('already done');
    expect(openLedger(rt.paths.subagentsFile, rt.now).find('s1')?.lastKnownState).toBe('running');
  });

  it('refuses an unusable session id before any call', async () => {
    const cancelTurn = vi.fn();
    const rt = makeRt(scratch, cancelTurn);
    const { io } = makeIo();
    expect(await cmdCancel(rt, io, { sessionId: '../etc', json: true })).toBe(2);
    expect(cancelTurn).not.toHaveBeenCalled();
  });
});
