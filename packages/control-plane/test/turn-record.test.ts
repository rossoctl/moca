import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultNewId } from '../src/handler-util.js';
import {
  isMintedTurnId,
  isTerminalState,
  ownerTurnsKey,
  parseTurnSubmission,
  resolveGateDeadline,
  resultTtlSeconds,
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

describe('isMintedTurnId', () => {
  // The ONLY minter is turn-handlers.submitTurn's `t-${deps.newId()}`, and in production newId is
  // `defaultNewId` (main.ts). So the shape is knowable, and the dequeue exchange refuses anything
  // else before it builds a Redis key from caller input (handlers.exchangeTurnCredential).
  it('accepts exactly what submitTurn mints', () => {
    // `defaultNewId`, not a restatement of it: this is the same binding main.ts wires, so changing
    // the production generator fails here too rather than only at the handler and e2e layers.
    expect(isMintedTurnId(`t-${defaultNewId()}`)).toBe(true);
  });

  it('refuses everything else, key-structure characters included', () => {
    for (const bad of [
      '',
      't-',
      't-1',
      't-nobody',
      randomUUID(), // the UUID without the prefix
      `T-${randomUUID()}`, // uppercase prefix
      `t-${randomUUID()}`.toUpperCase(),
      `t-${randomUUID()}x`, // trailing junk
      ` t-${randomUUID()}`, // leading space
      `t-${randomUUID()}\n`,
      // `:` is the key separator and TurnStore.tag appends `:${keyTag}`, so a caller-supplied `:`
      // would address a key shape the control plane never wrote. These two are the only entries the
      // length and prefix checks above do not already cover.
      `t-${randomUUID()}:tag`,
      'sh:cp:turn:t-1',
    ]) {
      expect(isMintedTurnId(bad), JSON.stringify(bad)).toBe(false);
    }
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

  it('carries requireApproval onto a prompt envelope', () => {
    const p = parseTurnSubmission({
      async: true,
      kind: 'prompt',
      prompt: 'hi',
      requireApproval: true,
    });
    expect(p.envelope).toEqual({ kind: 'prompt', prompt: 'hi', requireApproval: true });
  });

  it('carries requireApproval onto a solve envelope', () => {
    const p = parseTurnSubmission({
      async: true,
      kind: 'solve',
      problemStatement: 'fix it',
      repoUrl: 'https://example.invalid/r.git',
      ref: 'main',
      requireApproval: true,
    });
    expect(p.envelope).toMatchObject({ requireApproval: true });
  });

  it('omits the flag rather than storing false', () => {
    // One representation per meaning, as the `converge` kind normalisation does.
    const p = parseTurnSubmission({
      async: true,
      kind: 'prompt',
      prompt: 'hi',
      requireApproval: false,
    });
    expect(p.envelope).toEqual({ kind: 'prompt', prompt: 'hi' });
  });

  it('refuses a non-boolean requireApproval', () => {
    expect(
      codeOf(() =>
        parseTurnSubmission({ async: true, kind: 'prompt', prompt: 'hi', requireApproval: 'yes' }),
      ),
    ).toBe('invalid_request');
  });

  it('ignores it on a converge leaf, which has item.require_approval', () => {
    const p = parseTurnSubmission({
      async: true,
      item: { ...item, require_approval: true },
      requireApproval: true,
    });
    expect(p.envelope).toEqual({ item: { ...item, require_approval: true } });
  });

  it('parses gateDeadlineS and onTimeout', () => {
    const p = parseTurnSubmission({
      async: true,
      kind: 'prompt',
      prompt: 'hi',
      gateDeadlineS: 60,
      onTimeout: 'reject',
    });
    expect(p).toMatchObject({ gateDeadlineS: 60, onTimeout: 'reject' });
    // CP-side scheduling, not model input: they must NOT reach the harness.
    expect(p.envelope.gateDeadlineS).toBeUndefined();
    expect(p.envelope.onTimeout).toBeUndefined();
  });

  it('refuses a non-positive or non-integer gateDeadlineS and an unknown onTimeout', () => {
    const bad = (extra: object) => () =>
      parseTurnSubmission({ async: true, kind: 'prompt', prompt: 'hi', ...extra });
    expect(bad({ gateDeadlineS: 0 })).toThrow(/gateDeadlineS/);
    expect(bad({ gateDeadlineS: -1 })).toThrow(/gateDeadlineS/);
    expect(bad({ gateDeadlineS: 1.5 })).toThrow(/gateDeadlineS/);
    // Never 'approve': an unanswered gate must not be read as consent.
    expect(bad({ onTimeout: 'approve' })).toThrow(/onTimeout/);
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
      caps: { tokens: 1000, wallClock: 600 },
      workloadId: 'w-0123456789abcdef0123456789abcdef',
    });
    expect(p.idempotencyKey).toBe('k1');
    expect(p.caps).toEqual({ tokens: 1000, wallClock: 600 });
    // The 501 is the HANDLER's (§4.2: before admission, before enqueue). Refusing it here would
    // put a route-shaped decision in a pure parser.
    expect(p.workloadId).toBe('w-0123456789abcdef0123456789abcdef');
  });

  // #391: the field was accepted and stored, and nothing anywhere can price a token, so the cap
  // was silently ignored. Refusing is the honest answer -- a caller wanting a spend bound has
  // `caps.tokens`, which the worker now enforces.
  it('refuses caps.costUsd, naming the cap that is enforceable', () => {
    expect(codeOf(() => parseTurnSubmission({ item, async: true, caps: { costUsd: 1 } }))).toBe(
      'invalid_request',
    );
    expect(() => parseTurnSubmission({ item, async: true, caps: { costUsd: 1 } })).toThrow(
      /caps\.tokens/,
    );
  });

  it('refuses a cap that is not a positive integer rather than storing it', () => {
    expect(codeOf(() => parseTurnSubmission({ item, async: true, caps: { tokens: 0 } }))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(() => parseTurnSubmission({ item, async: true, caps: { wallClock: 'ten' } })),
    ).toBe('invalid_request');
    // `type: integer` in the contract, so these two are refused at the edge rather than stored as a
    // cap no enforcer can act on.
    expect(codeOf(() => parseTurnSubmission({ item, async: true, caps: { wallClock: 0.5 } }))).toBe(
      'invalid_request',
    );
    expect(codeOf(() => parseTurnSubmission({ item, async: true, caps: { tokens: 1e300 } }))).toBe(
      'invalid_request',
    );
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

describe('resolveGateDeadline', () => {
  it('is undefined when neither side asks for one', () => {
    expect(resolveGateDeadline(0, undefined)).toBeUndefined();
  });
  it('takes the deployment ceiling when the submission is silent', () => {
    expect(resolveGateDeadline(600, undefined)).toBe(600);
  });
  it('takes the submission when it is tighter', () => {
    expect(resolveGateDeadline(600, 60)).toBe(60);
  });
  it('clamps a submission that asks for longer than the ceiling', () => {
    expect(resolveGateDeadline(600, 9000)).toBe(600);
  });
  it('honours a submission deadline with no ceiling configured', () => {
    expect(resolveGateDeadline(0, 60)).toBe(60);
  });
  it('takes the tightest of three', () => {
    expect(resolveGateDeadline(600, 60, 30)).toBe(30);
  });
});

describe('resultTtlSeconds', () => {
  // Seven days (#390): an async turn is submitted because nobody is waiting, so a Friday
  // afternoon result must still be readable on Monday -- B5's own 72 h acceptance criterion.
  it('defaults to seven days when unset or blank', () => {
    expect(resultTtlSeconds({})).toBe(604_800);
    expect(resultTtlSeconds({ LEAF_RESULT_TTL_SECONDS: '' })).toBe(604_800);
    expect(resultTtlSeconds({ LEAF_RESULT_TTL_SECONDS: '  ' })).toBe(604_800);
  });

  it('reads a positive integer', () => {
    expect(resultTtlSeconds({ LEAF_RESULT_TTL_SECONDS: '600' })).toBe(600);
  });

  // An env file's trailing space, or a CRLF one's \r. This parse runs at module load in the worker
  // too, so taking the value literally would crash a tier over whitespace nobody can see.
  it.each([' 600', '600 ', '\t600\r\n'])('trims %j', (v) => {
    expect(resultTtlSeconds({ LEAF_RESULT_TTL_SECONDS: v })).toBe(600);
  });

  // The whole point of the shared parse: `writeResult` hands this to Redis as `EX`, and `EX NaN`
  // (or `EX 0`) is an error on every single write. A bad TTL must stop the boot, not the writes.
  it.each(['abc', '12x', '1.5', '-1', '0', '6 00'])('refuses %j rather than returning NaN', (v) => {
    expect(() => resultTtlSeconds({ LEAF_RESULT_TTL_SECONDS: v })).toThrow(
      'LEAF_RESULT_TTL_SECONDS',
    );
  });
});
