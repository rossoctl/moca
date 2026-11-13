import { describe, it, expect } from 'vitest';
import { configRefValid, isPromptEnvelope, isRunEnvelope } from '../src/server.js';

describe('isPromptEnvelope', () => {
  const ok = { sessionId: 's', kind: 'prompt', prompt: 'summarize the repo' };
  it('accepts a well-formed prompt envelope', () => {
    expect(isPromptEnvelope(ok)).toBe(true);
  });
  it('rejects a missing/empty prompt', () => {
    expect(isPromptEnvelope({ sessionId: 's', kind: 'prompt' })).toBe(false);
    expect(isPromptEnvelope({ sessionId: 's', kind: 'prompt', prompt: 123 })).toBe(false);
  });
  it('rejects the wrong kind', () => {
    expect(isPromptEnvelope({ sessionId: 's', kind: 'solve', prompt: 'x' })).toBe(false);
  });
  it('rejects a missing sessionId', () => {
    expect(isPromptEnvelope({ kind: 'prompt', prompt: 'x' })).toBe(false);
  });
});

describe('isRunEnvelope accepts a prompt envelope', () => {
  it('accepts a well-formed prompt envelope', () => {
    expect(isRunEnvelope({ sessionId: 's', kind: 'prompt', prompt: 'x' })).toBe(true);
  });
  it('still rejects junk', () => {
    expect(isRunEnvelope({ foo: 1 })).toBe(false);
  });
  // Issue #222 (1): an empty configRef is a WELL-FORMED envelope making an unsatisfiable request.
  // It is rejected separately, with its own error code, so the operator is not sent looking for a
  // malformed body — and so `isRunEnvelope` keeps meaning exactly "shaped like a run".
  it('is not the place an empty configRef is caught', () => {
    expect(isRunEnvelope({ sessionId: 's', kind: 'prompt', prompt: 'x', configRef: '' })).toBe(
      true,
    );
  });
});

describe('configRefValid', () => {
  const ok = { sessionId: 's', kind: 'prompt', prompt: 'x' };
  it('accepts an absent configRef — promotion is opt-in', () => {
    expect(configRefValid(ok)).toBe(true);
    expect(configRefValid({ ...ok, configRef: undefined })).toBe(true);
    expect(configRefValid({ ...ok, configRef: null })).toBe(true);
  });
  it('accepts a digest', () => {
    expect(configRefValid({ ...ok, configRef: 'sha256:' + 'a'.repeat(64) })).toBe(true);
  });
  it('rejects present-but-empty, whitespace-only, and non-string', () => {
    expect(configRefValid({ ...ok, configRef: '' })).toBe(false);
    expect(configRefValid({ ...ok, configRef: '   ' })).toBe(false);
    expect(configRefValid({ ...ok, configRef: 42 })).toBe(false);
  });
});
