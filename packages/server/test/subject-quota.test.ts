import { describe, expect, it } from 'vitest';
import { runningPerOwnerCap, SubjectCounter, turnsPerSubjectCap } from '../src/subject-quota.js';

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

describe('runningPerOwnerCap (#391)', () => {
  it('is OFF unless the operator sets it, deriving nothing from the worker size', () => {
    // Deliberately unlike turnsPerSubjectCap: the value is deployment-wide and every worker must
    // agree on it, so S cannot imply it -- and a cap appearing on upgrade would start pacing a
    // single-owner deployment's own fan-out.
    expect(runningPerOwnerCap({})).toBeUndefined();
    expect(
      runningPerOwnerCap({ SH_TURNS_PER_WORKER: '8', SH_TURNS_PER_SUBJECT: '4' }),
    ).toBeUndefined();
  });

  it('takes a positive integer, and reads anything else as unset', () => {
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: '4' })).toBe(4);
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: ' 1 ' })).toBe(1);
    // `0` honoured would defer every async turn in the deployment forever, with nothing to report it.
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: '0' })).toBeUndefined();
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: '-2' })).toBeUndefined();
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: '2.5' })).toBeUndefined();
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: 'lots' })).toBeUndefined();
    expect(runningPerOwnerCap({ MOCA_ASYNC_RUNNING_PER_OWNER: '' })).toBeUndefined();
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
