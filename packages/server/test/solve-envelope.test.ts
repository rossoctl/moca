import { describe, it, expect } from 'vitest';
import { isSolveEnvelope, isRunEnvelope } from '../src/server.js';

describe('isSolveEnvelope', () => {
  const ok = {
    sessionId: 's',
    kind: 'solve',
    problemStatement: 'fix it',
    repoUrl: 'git://x/r.git',
    ref: 'work',
  };
  it('accepts a well-formed solve envelope', () => {
    expect(isSolveEnvelope(ok)).toBe(true);
  });
  it('rejects a solve envelope missing repoUrl/ref/problemStatement', () => {
    expect(isSolveEnvelope({ sessionId: 's', kind: 'solve' })).toBe(false);
  });
  it('rejects a converge envelope (no kind:solve)', () => {
    expect(
      isSolveEnvelope({ sessionId: 's', item: { item_id: 'i', file: 'f', pattern: 'p' } }),
    ).toBe(false);
  });
});

describe('isRunEnvelope', () => {
  it('accepts either a converge or a solve envelope', () => {
    expect(isRunEnvelope({ sessionId: 's', item: { item_id: 'i', file: 'f', pattern: 'p' } })).toBe(
      true,
    );
    expect(
      isRunEnvelope({
        sessionId: 's',
        kind: 'solve',
        problemStatement: 'x',
        repoUrl: 'g',
        ref: 'r',
      }),
    ).toBe(true);
  });
  it('rejects junk', () => {
    expect(isRunEnvelope({ foo: 1 })).toBe(false);
  });
});
