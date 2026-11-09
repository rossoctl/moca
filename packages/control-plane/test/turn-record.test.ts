import { describe, expect, it } from 'vitest';
import {
  isTerminalState,
  ownerTurnsKey,
  parseTurnSubmission,
  TURN_STATES,
  turnKey,
  type TurnState,
} from '../src/turn-record.js';
import { CpError } from '../src/errors.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'no-throw';
  } catch (err) {
    return err instanceof CpError ? err.code : 'not-a-CpError';
  }
};

describe('turn states (spec §5.1)', () => {
  it('lists exactly the nine states in the spec', () => {
    expect([...TURN_STATES].sort()).toEqual(
      [
        'cancelled',
        'done',
        'failed',
        'lost',
        'paused',
        'queued',
        'responded',
        'running',
        'solved',
      ].sort(),
    );
  });

  it('treats queued and running as non-terminal and everything else as terminal', () => {
    // The claim at dequeue (§5.4) refuses only `cancelled` and terminal, so "non-terminal" is the
    // set a redelivery may still run. `running` counted as terminal here would drop exactly the
    // entries crash recovery exists for.
    const nonTerminal = TURN_STATES.filter((s: TurnState) => !isTerminalState(s));
    expect([...nonTerminal].sort()).toEqual(['queued', 'running']);
  });
});

describe('keys', () => {
  it('namespaces the record and the owner index under the control plane prefix', () => {
    expect(turnKey('t-1')).toBe('sh:cp:turn:t-1');
    // A HASH of the subject, as the session owner index does: a raw `github:1234` in a key leaks
    // the subject into Redis key listings (ownership.ts).
    expect(ownerTurnsKey('github:1234')).toMatch(/^sh:cp:owner:[0-9a-f]{8,}:turns$/);
    expect(ownerTurnsKey('github:1234')).not.toBe(ownerTurnsKey('github:9999'));
  });
});

describe('parseTurnSubmission (spec §4.1)', () => {
  const item = { item_id: 'i1', file: 'f.ts', pattern: 'p' };

  it('accepts a verdict leaf and carries the item into the envelope', () => {
    const p = parseTurnSubmission({ item, async: true });
    expect(p.kind).toBe('verdict');
    expect(p.envelope).toMatchObject({ item });
  });

  it('accepts an explicit kind:converge as the same verdict leaf as an absent kind', () => {
    const withConverge = parseTurnSubmission({ kind: 'converge', item, async: true });
    const withoutKind = parseTurnSubmission({ item, async: true });
    expect(withConverge.kind).toBe('verdict');
    expect(withConverge.envelope).toEqual({ item });
    expect(withConverge.envelope).toEqual(withoutKind.envelope);
  });

  it('refuses kind:verdict -- "verdict" is the internal discriminant, not a wire value', () => {
    expect(codeOf(() => parseTurnSubmission({ kind: 'verdict', item, async: true }))).toBe(
      'envelope_invalid',
    );
  });

  it('accepts a prompt leaf', () => {
    expect(parseTurnSubmission({ kind: 'prompt', prompt: 'hi', async: true }).kind).toBe('prompt');
  });

  it('accepts a solve leaf with its repo coordinates', () => {
    const p = parseTurnSubmission({
      kind: 'solve',
      problemStatement: 'fix it',
      repoUrl: 'https://example.invalid/r.git',
      ref: 'main',
      async: true,
    });
    expect(p.kind).toBe('solve');
    expect(p.envelope).toMatchObject({ repoUrl: 'https://example.invalid/r.git', ref: 'main' });
  });

  it('refuses a body that is not one of the three kinds', () => {
    expect(codeOf(() => parseTurnSubmission({ async: true }))).toBe('envelope_invalid');
    expect(codeOf(() => parseTurnSubmission({ kind: 'prompt', async: true }))).toBe(
      'envelope_invalid',
    );
    expect(
      codeOf(() => parseTurnSubmission({ kind: 'solve', problemStatement: 'x', async: true })),
    ).toBe('envelope_invalid');
  });

  it('requires async:true -- the synchronous turn path is not this route', () => {
    expect(codeOf(() => parseTurnSubmission({ item }))).toBe('invalid_request');
    expect(codeOf(() => parseTurnSubmission({ item, async: false }))).toBe('invalid_request');
  });

  it('refuses a caller-supplied tenant (MI1 R7), as POST /v1/runs does', () => {
    expect(codeOf(() => parseTurnSubmission({ item, async: true, tenant: 'other' }))).toBe(
      'invalid_request',
    );
  });

  it('reads caps and the idempotency key, and REPORTS a workloadId rather than refusing it here', () => {
    const p = parseTurnSubmission({
      item,
      async: true,
      idempotencyKey: 'k1',
      caps: { tokens: 1000, costUsd: 0.5, wallClock: 600 },
      workloadId: 'w-0123456789abcdef0123456789abcdef',
    });
    expect(p.idempotencyKey).toBe('k1');
    expect(p.caps).toEqual({ tokens: 1000, costUsd: 0.5, wallClock: 600 });
    // The 501 is the HANDLER's (§4.2: before admission, before enqueue). Refusing it here would
    // put a route-shaped decision in a pure parser.
    expect(p.workloadId).toBe('w-0123456789abcdef0123456789abcdef');
  });

  it('refuses a non-positive or non-numeric cap rather than storing it', () => {
    expect(codeOf(() => parseTurnSubmission({ item, async: true, caps: { tokens: 0 } }))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(() => parseTurnSubmission({ item, async: true, caps: { wallClock: 'ten' } })),
    ).toBe('invalid_request');
  });

  it('refuses an idempotency key that is not a short printable string', () => {
    expect(codeOf(() => parseTurnSubmission({ item, async: true, idempotencyKey: '' }))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(() => parseTurnSubmission({ item, async: true, idempotencyKey: 'a'.repeat(129) })),
    ).toBe('invalid_request');
    expect(codeOf(() => parseTurnSubmission({ item, async: true, idempotencyKey: 'a b' }))).toBe(
      'invalid_request',
    );
  });
});
