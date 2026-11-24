import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDecide, cmdGet, type DecideOptions } from '../src/subagent.js';
import { openLedger, type Ledger, type LedgerRecord } from '../src/core/subagent-ledger.js';
import { GATE_FEEDBACK_BYTES } from '../src/api/types.js';
import { ApiError } from '../src/api/errors.js';
import type { LeafEnvelope, LeafResultBody } from '../src/transport/leaf-turn.js';

/* --- harness --- */

const PAUSED: LeafResultBody = {
  status: 'paused',
  gateId: 3,
  gate: { summary: 'wants to push', proposed_action: 'git push origin main' },
};

function makeRt(scratch: string) {
  const cp = {
    decideGate: vi.fn(async () => ({ sessionId: 'sess-abc', turnId: 't-resume' })),
    mintSessionToken: vi.fn(async () => ({ token: 'tok-xyz', expiresAt: 4_000_000_000 })),
  };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  return {
    rt: {
      cp,
      harness,
      auth: { subject: 'alice', apiToken: 'api-tok', expiresAt: 999 },
      endpoints: { harnessUrl: 'https://harness.test' },
      paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
      now: () => 1000,
      sleep: vi.fn(async () => {}),
      fetchImpl: fetch,
    } as any,
    cp,
  };
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

/** The async reader `readLeafResult` uses when the row has a turnId. */
function fakeTurns(body: LeafResultBody | 'queued') {
  return {
    readTurnState: vi.fn(async () => body),
    collect: vi.fn(async (_s: string, _t: string, b: LeafResultBody) => b),
  };
}

/** The sync reader, for a row with no turnId. */
function fakeTransport(body: LeafResultBody | 'queued') {
  return { readLeafState: vi.fn(async () => body) } as any;
}

function row(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    sessionId: 'sess-abc',
    envelope: { kind: 'prompt', prompt: 'do the thing' },
    submittedAt: 1,
    lastKnownState: 'paused',
    stateObservedAt: 1,
    ...over,
  };
}

let scratch: string;
let ledger: Ledger;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'decide-'));
  ledger = openLedger(join(scratch, 'subagents.jsonl'), () => 1000);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const opts = (over: Partial<DecideOptions> = {}): DecideOptions => ({
  sessionId: 'sess-abc',
  action: 'approve',
  json: false,
  ledger,
  ...over,
});

/* --- local validation --- */

describe('cmdDecide — refused before any network call', () => {
  it('refuses an illegal sessionId', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    expect(await cmdDecide(rt, io, opts({ sessionId: 'has/slash' }))).toBe(2);
    expect(cp.decideGate).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('invalid sessionId');
  });

  it('refuses feedback over the control plane’s byte bound', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    const r = await cmdDecide(
      rt,
      io,
      opts({ action: 'reject', gateId: 3, feedback: 'x'.repeat(GATE_FEEDBACK_BYTES + 1) }),
    );
    expect(r).toBe(2);
    expect(cp.decideGate).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('--feedback is too large');
  });

  it('accepts feedback exactly at the bound', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io } = makeIo();
    ledger.append(row({ turnId: 't-1' }));
    const feedback = 'x'.repeat(GATE_FEEDBACK_BYTES);
    expect(await cmdDecide(rt, io, opts({ gateId: 3, feedback }))).toBe(0);
    expect(cp.decideGate).toHaveBeenCalledWith('sess-abc', {
      gateId: 3,
      action: 'approve',
      feedback,
    });
  });
});

/* --- the async path: the decision route --- */

describe('cmdDecide — async row', () => {
  it('answers the gate, re-points the ledger row at the resume turn, and prints it', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, out, err } = makeIo();
    ledger.append(row({ turnId: 't-1' }));
    const r = await cmdDecide(rt, io, opts({ gateId: 3, json: true }));
    expect(r).toBe(0);
    expect(cp.decideGate).toHaveBeenCalledWith('sess-abc', { gateId: 3, action: 'approve' });
    expect(JSON.parse(out.join(''))).toEqual({
      sessionId: 'sess-abc',
      gateId: 3,
      action: 'approve',
      turnId: 't-resume',
    });
    expect(err.join('\n')).toContain('approved gate 3');
    // The answered turn stays `paused` for good, so the row must name the resume instead.
    const after = ledger.find('sess-abc');
    expect(after?.turnId).toBe('t-resume');
    expect(after?.lastKnownState).toBe('running');
  });

  it('reads the pending gate id off the paused result when --gate is omitted', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io } = makeIo();
    ledger.append(row({ turnId: 't-1' }));
    const turns = fakeTurns(PAUSED);
    expect(await cmdDecide(rt, io, opts({ action: 'reject', turns }))).toBe(0);
    expect(turns.readTurnState).toHaveBeenCalled();
    expect(cp.decideGate).toHaveBeenCalledWith('sess-abc', { gateId: 3, action: 'reject' });
  });

  it('refuses without --gate when the session is not paused', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    ledger.append(row({ turnId: 't-1', lastKnownState: 'running' }));
    const r = await cmdDecide(rt, io, opts({ turns: fakeTurns('queued') }));
    expect(r).toBe(1);
    expect(cp.decideGate).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('not paused at a gate');
  });

  it('reports a gate_not_pending refusal and leaves the row alone', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    ledger.append(row({ turnId: 't-1' }));
    cp.decideGate.mockRejectedValueOnce(
      new ApiError('control-plane', 409, 'gate_not_pending', 'gate 3 is not pending'),
    );
    expect(await cmdDecide(rt, io, opts({ gateId: 3 }))).toBe(1);
    expect(err.join('\n')).toContain('gate 3 is not pending');
    const after = ledger.find('sess-abc');
    expect(after?.turnId).toBe('t-1');
    expect(after?.lastKnownState).toBe('paused');
  });

  it('points a 409 with no local row at the machine that spawned it', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    cp.decideGate.mockRejectedValueOnce(
      new ApiError('control-plane', 409, 'gate_not_pending', 'no turn is paused'),
    );
    expect(await cmdDecide(rt, io, opts({ gateId: 3 }))).toBe(1);
    expect(err.join('\n')).toContain('spawned without --async');
  });
});

/* --- the sync path: re-send the envelope --- */

describe('cmdDecide — sync row', () => {
  it('re-sends the stored envelope with the decision inline, in a detached worker', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, out, err } = makeIo();
    ledger.append(
      row({ envelope: { kind: 'prompt', prompt: 'do the thing', configRef: 'sha256:a' } }),
    );
    const sent: LeafEnvelope[] = [];
    const forkFn = vi.fn(async (_s: string, _t: string, env: LeafEnvelope) => {
      sent.push(env);
      return 4242;
    });
    const r = await cmdDecide(
      rt,
      io,
      opts({ action: 'reject', gateId: 3, feedback: 'try the other branch', json: true, forkFn }),
    );
    expect(r).toBe(0);
    // The decision route cannot resolve a sync leaf, so it must not be called for one.
    expect(cp.decideGate).not.toHaveBeenCalled();
    expect(cp.mintSessionToken).toHaveBeenCalledWith('sess-abc');
    expect(sent[0]).toEqual({
      sessionId: 'sess-abc',
      kind: 'prompt',
      prompt: 'do the thing',
      configRef: 'sha256:a',
      decision: { gateId: 3, action: 'reject', feedback: 'try the other branch' },
    });
    expect(JSON.parse(out.join(''))).toEqual({
      sessionId: 'sess-abc',
      gateId: 3,
      action: 'reject',
      pid: 4242,
    });
    expect(err.join('\n')).toContain('rejected gate 3');
    const after = ledger.find('sess-abc');
    expect(after?.childPid).toBe(4242);
    expect(after?.lastKnownState).toBe('running');
  });

  it('infers the gate id from the sync reader', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    ledger.append(row());
    const sent: LeafEnvelope[] = [];
    const r = await cmdDecide(
      rt,
      io,
      opts({
        transport: fakeTransport(PAUSED),
        forkFn: async (_s: string, _t: string, env: LeafEnvelope) => {
          sent.push(env);
          return 7;
        },
      }),
    );
    expect(r).toBe(0);
    expect(sent[0]?.decision).toEqual({ gateId: 3, action: 'approve' });
  });

  it('refuses a row whose envelope it cannot rebuild, before forking anything', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    ledger.append(row({ envelope: { kind: 'converge', prompt: 'legacy' } }));
    const forkFn = vi.fn(async () => 1);
    expect(await cmdDecide(rt, io, opts({ gateId: 3, forkFn }))).toBe(1);
    expect(forkFn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('cannot resume');
  });

  it('leaves the row paused when the fork fails, so the decision can be made again', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    ledger.append(row());
    const r = await cmdDecide(
      rt,
      io,
      opts({
        gateId: 3,
        forkFn: async () => {
          throw new Error('no fork for you');
        },
      }),
    );
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('no fork for you');
    expect(ledger.find('sess-abc')?.lastKnownState).toBe('paused');
  });
});

/* --- the read side: `get` must show what a decision has to name --- */

describe('cmdGet — the pending gate', () => {
  it('reports the gate id and what was proposed', async () => {
    const { rt } = makeRt(scratch);
    const { io, out, err } = makeIo();
    ledger.append(row({ turnId: 't-1' }));
    const r = await cmdGet(rt, io, {
      sessionId: 'sess-abc',
      json: true,
      outDir: scratch,
      ledger,
      turns: fakeTurns(PAUSED),
    } as any);
    expect(r).toBe(1); // paused is not a completed run
    expect(JSON.parse(out.join('')).gate).toEqual({
      gateId: 3,
      summary: 'wants to push',
      proposed_action: 'git push origin main',
    });
    const { io: io2, err: err2 } = makeIo();
    await cmdGet(rt, io2, {
      sessionId: 'sess-abc',
      json: false,
      outDir: scratch,
      ledger,
      turns: fakeTurns(PAUSED),
    } as any);
    expect(err2.join('\n')).toContain('mocactl approve sess-abc');
    expect(err.join('\n')).not.toContain('mocactl approve'); // --json keeps stdout a lone object
  });
});
