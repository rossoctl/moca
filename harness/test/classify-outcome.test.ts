import { describe, it, expect } from 'vitest';
import { classifyOutcome } from '../src/classify-outcome';
import type { LeafResult } from '../src/run-leaf';

describe('classifyOutcome', () => {
  it('acks a done result (non-retryable)', () => {
    expect(
      classifyOutcome({ status: 'done', verdict: { item_id: 'i', verdict: 'CLEAR', reason: 'r' } }),
    ).toEqual({ ack: true, retryable: false });
  });
  it('acks a paused result (resume is a fresh invocation)', () => {
    expect(
      classifyOutcome({
        status: 'paused',
        gateId: 1,
        gate: { summary: 's', proposed_action: 'a' },
      }),
    ).toEqual({ ack: true, retryable: false });
  });
  it('acks an aborted result', () => {
    expect(classifyOutcome({ status: 'aborted' })).toEqual({ ack: true, retryable: false });
  });
  it('acks a deterministic failure', () => {
    expect(classifyOutcome({ status: 'failed', reason: 'no_verdict' })).toEqual({
      ack: true,
      retryable: false,
    });
  });
  // #391: a turn that ran out of tokens or wall clock is DONE, not transient. Retrying it would
  // re-run the whole leaf against a cap it has already spent.
  it('acks a budget failure without retrying', () => {
    expect(classifyOutcome({ status: 'failed', reason: 'budget' })).toEqual({
      ack: true,
      retryable: false,
    });
  });
  it('retries a transient error without acking', () => {
    expect(classifyOutcome({ status: 'failed', reason: 'error' })).toEqual({
      ack: false,
      retryable: true,
    });
  });
  it('retries a saturated result without acking (async drains as leases free, spec §4.3)', () => {
    expect(classifyOutcome({ status: 'failed', reason: 'saturated' })).toEqual({
      ack: false,
      retryable: true,
    });
  });
});
