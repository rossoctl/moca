import { describe, expect, it } from 'vitest';
import { SubjectCounter, turnsPerSubjectCap } from '../src/subject-quota.js';

describe('turnsPerSubjectCap', () => {
  it('an operator-set SH_TURNS_PER_SUBJECT wins over the derived default', () => {
    expect(turnsPerSubjectCap({ SH_TURNS_PER_SUBJECT: '3', SH_TURNS_PER_WORKER: '8' })).toBe(3);
  });

  it('unset, the cap is half the per-worker slots', () => {
    expect(turnsPerSubjectCap({ SH_TURNS_PER_WORKER: '8' })).toBe(4);
  });

  it('half of an odd S rounds down, and S=1 still leaves the subject one slot', () => {
    expect(turnsPerSubjectCap({ SH_TURNS_PER_WORKER: '3' })).toBe(1);
    expect(turnsPerSubjectCap({ SH_TURNS_PER_WORKER: '1' })).toBe(1);
  });

  it('neither variable set means no quota (the supervisor tier always sets S)', () => {
    expect(turnsPerSubjectCap({})).toBeUndefined();
  });

  it('a non-integer or non-positive SH_TURNS_PER_SUBJECT falls back to the derived default', () => {
    expect(turnsPerSubjectCap({ SH_TURNS_PER_SUBJECT: 'abc', SH_TURNS_PER_WORKER: '8' })).toBe(4);
    expect(turnsPerSubjectCap({ SH_TURNS_PER_SUBJECT: '0', SH_TURNS_PER_WORKER: '8' })).toBe(4);
    expect(turnsPerSubjectCap({ SH_TURNS_PER_SUBJECT: '0' })).toBeUndefined();
  });
});

describe('SubjectCounter', () => {
  it('admits up to the cap, then refuses', () => {
    const c = new SubjectCounter();
    expect(c.acquire('a', 2)).toBeTypeOf('function');
    expect(c.acquire('a', 2)).toBeTypeOf('function');
    expect(c.acquire('a', 2)).toBeNull();
  });

  it('a release frees exactly one slot', () => {
    const c = new SubjectCounter();
    const end = c.acquire('a', 1);
    expect(end).toBeTypeOf('function');
    expect(c.acquire('a', 1)).toBeNull();
    end!();
    expect(c.acquire('a', 1)).toBeTypeOf('function');
  });

  it('a release is idempotent: a second call must not free another subject slot', () => {
    const c = new SubjectCounter();
    const first = c.acquire('a', 1);
    expect(first).toBeTypeOf('function');
    const second = c.acquire('a', 1); // refused at cap
    expect(second).toBeNull();
    first!();
    first!(); // the bug this pins: a double decrement would read as a free slot
    const after = c.acquire('a', 1); // takes the slot the single release freed
    expect(after).toBeTypeOf('function');
    expect(c.acquire('a', 1)).toBeNull(); // a double decrement would have admitted this too
  });

  it('one subject at its cap does not bind another', () => {
    const c = new SubjectCounter();
    expect(c.acquire('subject-a', 1)).toBeTypeOf('function');
    expect(c.acquire('subject-b', 1)).toBeTypeOf('function');
  });

  it("drops a subject's entry once it holds nothing, so the map cannot grow without bound", () => {
    const c = new SubjectCounter();
    const end = c.acquire('a', 1);
    expect(c.size).toBe(1);
    end!();
    expect(c.size).toBe(0);
    expect(c.inFlight('a')).toBe(0);
  });
});
