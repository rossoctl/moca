import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateDecision,
  isGateRequestEntry,
  isGateDecisionEntry,
  gateRequestFromEntry,
  gateDecisionFromEntry,
  GATE_REQUEST_ENTRY_TYPE,
  GATE_DECISION_ENTRY_TYPE,
} from '../src/gate';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateDecision', () => {
  it('accepts approve/reject/abort with a numeric gateId', () => {
    expect(validateDecision({ gateId: 0, action: 'approve' })).toEqual({
      ok: true,
      value: { gateId: 0, action: 'approve', feedback: undefined },
    });
    expect(validateDecision({ gateId: 2, action: 'reject', feedback: 'do X' })).toEqual({
      ok: true,
      value: { gateId: 2, action: 'reject', feedback: 'do X' },
    });
    expect(validateDecision({ gateId: 1, action: 'abort' }).ok).toBe(true);
  });
  it('rejects a bad action, missing gateId, or non-object', () => {
    expect(validateDecision({ gateId: 0, action: 'maybe' }).ok).toBe(false);
    expect(validateDecision({ action: 'approve' }).ok).toBe(false);
    expect(validateDecision(null).ok).toBe(false);
  });
});

describe('entry helpers', () => {
  const req = {
    type: 'custom',
    customType: GATE_REQUEST_ENTRY_TYPE,
    data: { gateId: 0, summary: 's', proposed_action: 'a' },
  };
  const dec = {
    type: 'custom',
    customType: GATE_DECISION_ENTRY_TYPE,
    data: { gateId: 0, action: 'approve' },
  };
  it('recognizes and extracts gate-request entries', () => {
    expect(isGateRequestEntry(req)).toBe(true);
    expect(isGateRequestEntry(dec)).toBe(false);
    expect(gateRequestFromEntry(req)).toEqual({ gateId: 0, summary: 's', proposed_action: 'a' });
    expect(gateRequestFromEntry(dec)).toBeNull();
  });
  it('recognizes and extracts gate-decision entries', () => {
    expect(isGateDecisionEntry(dec)).toBe(true);
    expect(gateDecisionFromEntry(dec)).toEqual({
      gateId: 0,
      action: 'approve',
      feedback: undefined,
    });
    expect(gateDecisionFromEntry(req)).toBeNull();
  });
});

import { computeGateState, continuationPrompt } from '../src/gate';

function reqEntry(gateId: number) {
  return {
    type: 'custom',
    customType: 'gate-request',
    data: { gateId, summary: `s${gateId}`, proposed_action: `a${gateId}` },
  };
}
function decEntry(gateId: number, action = 'approve', feedback?: string) {
  return { type: 'custom', customType: 'gate-decision', data: { gateId, action, feedback } };
}

describe('computeGateState', () => {
  it('no gates → no pending, nextGateId 0', () => {
    const s = computeGateState([{ type: 'user' }]);
    expect(s.pendingGate).toBeNull();
    expect(s.lastDecision).toBeNull();
    expect(s.nextGateId).toBe(0);
  });
  it('one undecided request → it is pending, nextGateId 1', () => {
    const s = computeGateState([reqEntry(0)]);
    expect(s.pendingGate).toEqual({ gateId: 0, summary: 's0', proposed_action: 'a0' });
    expect(s.nextGateId).toBe(1);
  });
  it('decided request → no pending, lastDecision set', () => {
    const s = computeGateState([reqEntry(0), decEntry(0, 'approve')]);
    expect(s.pendingGate).toBeNull();
    expect(s.lastDecision).toEqual({ gateId: 0, action: 'approve', feedback: undefined });
  });
  it('second request after a decided first → second is pending, nextGateId 2', () => {
    const s = computeGateState([reqEntry(0), decEntry(0), reqEntry(1)]);
    expect(s.pendingGate?.gateId).toBe(1);
    expect(s.nextGateId).toBe(2);
  });
});

describe('continuationPrompt', () => {
  it('approve mentions APPROVED and submit_verdict', () => {
    const p = continuationPrompt('approve', 'looks good');
    expect(p).toContain('APPROVED');
    expect(p).toContain('looks good');
    expect(p).toContain('submit_verdict');
  });
  it('reject mentions REJECTED and revise', () => {
    const p = continuationPrompt('reject', 'fix the query');
    expect(p).toContain('REJECTED');
    expect(p).toContain('fix the query');
    expect(p.toLowerCase()).toContain('revise');
  });
});

import { decideSeed, gateShortCircuit, type Decision } from '../src/gate';

const FRESH = 'FRESH_PROMPT';
function state(entries: unknown[]) {
  return computeGateState(entries);
}

describe('decideSeed', () => {
  it('fresh (no gates) → seed the fresh prompt, no record', () => {
    expect(decideSeed(state([]), null, FRESH)).toEqual({
      kind: 'seed',
      prompt: FRESH,
      record: null,
    });
  });
  it('pending gate + matching approve → seed continuation + record decision', () => {
    const r = decideSeed(state([reqEntry(0)]), { gateId: 0, action: 'approve' }, FRESH);
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') {
      expect(r.prompt).toContain('APPROVED');
      expect(r.record).toEqual({ gateId: 0, action: 'approve', feedback: undefined });
    }
  });
  it('pending gate + matching reject → seed continuation with feedback', () => {
    const r = decideSeed(
      state([reqEntry(0)]),
      { gateId: 0, action: 'reject', feedback: 'redo' },
      FRESH,
    );
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') expect(r.prompt).toContain('redo');
  });
  it('pending gate + matching abort → abort + record', () => {
    expect(decideSeed(state([reqEntry(0)]), { gateId: 0, action: 'abort' }, FRESH)).toEqual({
      kind: 'abort',
      record: { gateId: 0, action: 'abort', feedback: undefined },
    });
  });
  it('pending gate + no decision → paused', () => {
    expect(decideSeed(state([reqEntry(0)]), null, FRESH)).toEqual({
      kind: 'paused',
      gate: { gateId: 0, summary: 's0', proposed_action: 'a0' },
    });
  });
  it('pending gate + gateId mismatch → paused (stale decision ignored)', () => {
    expect(decideSeed(state([reqEntry(1)]), { gateId: 0, action: 'approve' }, FRESH).kind).toBe(
      'paused',
    );
  });
  it('already-decided this gate (double resume) → seed continuation, record null (no re-record)', () => {
    // The decision entry for gate 0 already exists, so the gate is no longer pending.
    const r = decideSeed(
      state([reqEntry(0), decEntry(0, 'approve')]),
      { gateId: 0, action: 'approve' },
      FRESH,
    );
    expect(r.kind).toBe('seed');
    if (r.kind === 'seed') {
      expect(r.prompt).toContain('APPROVED');
      expect(r.record).toBeNull();
    }
  });
  it('already-aborted session (no pending, last decision abort) → terminal abort, record null', () => {
    expect(decideSeed(state([reqEntry(0), decEntry(0, 'abort')]), null, FRESH)).toEqual({
      kind: 'abort',
      record: null,
    });
  });
});

describe('gateShortCircuit', () => {
  it('pending gate + no decision → paused', () => {
    expect(gateShortCircuit(state([reqEntry(0)]), null)).toEqual({
      kind: 'paused',
      gate: { gateId: 0, summary: 's0', proposed_action: 'a0' },
    });
  });
  it('pending gate + gateId mismatch → paused', () => {
    expect(gateShortCircuit(state([reqEntry(1)]), { gateId: 0, action: 'approve' })?.kind).toBe(
      'paused',
    );
  });
  it('pending gate + matching abort → abort, carrying the entry to append', () => {
    expect(
      gateShortCircuit(state([reqEntry(0)]), { gateId: 0, action: 'abort', feedback: 'no' }),
    ).toEqual({ kind: 'abort', record: { gateId: 0, action: 'abort', feedback: 'no' } });
  });
  it('approve or reject → null, the caller runs the turn', () => {
    expect(gateShortCircuit(state([reqEntry(0)]), { gateId: 0, action: 'approve' })).toBeNull();
    expect(gateShortCircuit(state([reqEntry(0)]), { gateId: 0, action: 'reject' })).toBeNull();
  });
  it('no gate at all → null', () => {
    expect(gateShortCircuit(state([]), null)).toBeNull();
  });
  it('already-aborted session → abort, record null', () => {
    expect(gateShortCircuit(state([reqEntry(0), decEntry(0, 'abort')]), null)).toEqual({
      kind: 'abort',
      record: null,
    });
  });
  it('already-decided gate (double resume) → null, so the caller seeds the continuation', () => {
    expect(
      gateShortCircuit(state([reqEntry(0), decEntry(0, 'approve')]), {
        gateId: 0,
        action: 'approve',
      }),
    ).toBeNull();
  });
  it('gives the same answer decideSeed does', () => {
    // The refactor's whole contract: decideSeed delegates, so the two can never disagree.
    const pending = state([reqEntry(0)]);
    expect(decideSeed(pending, null, FRESH)).toEqual(gateShortCircuit(pending, null));
    const abort: Decision = { gateId: 0, action: 'abort' };
    expect(decideSeed(pending, abort, FRESH)).toEqual(gateShortCircuit(pending, abort));
    const aborted = state([reqEntry(0), decEntry(0, 'abort')]);
    expect(decideSeed(aborted, null, FRESH)).toEqual(gateShortCircuit(aborted, null));
  });
});
