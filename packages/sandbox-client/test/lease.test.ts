import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseEvent, SandboxMode } from '../src/gen/sandbox/v1/sandbox.js';
import { NoticeDedupe, leaseNotice, noticeLines } from '../src/lease.js';

// The notice's HH:MM is local time: pin the zone so the copy is exact.
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

/** 2026-11-13 14:02:30 UTC. */
const AT = Date.UTC(2026, 10, 13, 14, 2, 30);
const ev = (over: Partial<LeaseEvent>): LeaseEvent =>
  LeaseEvent.fromPartial({ atUnixMs: AT, mode: SandboxMode.SANDBOX_MODE_LEASE, ...over });

describe('leaseNotice (spec §5 copy)', () => {
  it('formats an end at local HH:MM', () => {
    expect(leaseNotice(ev({ state: 'end', reason: 'idle' }), AT)).toBe(
      '[sandbox] guest restarted (idle, 14:02): /tmp, installs outside /workspace and background processes are gone',
    );
  });

  it('appends "; stopped: <name> (pid <n>)" per process', () => {
    expect(
      leaseNotice(
        ev({ state: 'end', reason: 'memory_reclaim', processes: ['devserver (pid 412)'] }),
        AT,
      ),
    ).toBe(
      '[sandbox] guest restarted (memory_reclaim, 14:02): /tmp, installs outside /workspace and background processes are gone; stopped: devserver (pid 412)',
    );
    expect(
      leaseNotice(ev({ state: 'end', reason: 'reset', processes: ['a (pid 1)', 'b (pid 2)'] }), AT),
    ).toMatch(/gone; stopped: a \(pid 1\); stopped: b \(pid 2\)$/);
  });

  it('rounds the minutes left of an expiring lease up, to at least 1', () => {
    const expiring = (leftMs: number) =>
      leaseNotice(ev({ state: 'expiring', reason: 'max_duration', endsByUnixMs: AT + leftMs }), AT);
    expect(expiring(29.5 * 60_000)).toBe('[sandbox] guest restarts within 30 min (max_duration)');
    expect(expiring(10_000)).toBe('[sandbox] guest restarts within 1 min (max_duration)');
    expect(expiring(-5_000)).toBe('[sandbox] guest restarts within 1 min (max_duration)');
    expect(expiring(60_000)).toBe('[sandbox] guest restarts within 1 min (max_duration)');
  });

  it('says "soon" for an expiring event with no deadline (a worker before ends_by_unix_ms)', () => {
    for (const endsByUnixMs of [0, -1]) {
      expect(leaseNotice(ev({ state: 'expiring', reason: 'max_duration', endsByUnixMs }), AT)).toBe(
        '[sandbox] guest restarts soon (max_duration)',
      );
    }
  });

  it('names max_duration on every expiring line, whatever the reason field says', () => {
    for (const reason of ['', 'grace_limit']) {
      expect(leaseNotice(ev({ state: 'expiring', reason, endsByUnixMs: AT + 120_000 }), AT)).toBe(
        '[sandbox] guest restarts within 2 min (max_duration)',
      );
      expect(leaseNotice(ev({ state: 'expiring', reason, endsByUnixMs: 0 }), AT)).toBe(
        '[sandbox] guest restarts soon (max_duration)',
      );
    }
  });

  it('formats a start with the mode name', () => {
    expect(leaseNotice(ev({ state: 'start' }), AT)).toBe('[sandbox] new guest (lease, 14:02)');
    expect(
      leaseNotice(ev({ state: 'start', mode: SandboxMode.SANDBOX_MODE_LEASE_PROCESSES }), AT),
    ).toBe('[sandbox] new guest (lease+processes, 14:02)');
  });

  it('pads the hour and minute to two digits, 24-hour', () => {
    const at = Date.UTC(2026, 10, 13, 9, 5);
    expect(leaseNotice(ev({ state: 'start', atUnixMs: at }), at)).toBe(
      '[sandbox] new guest (lease, 09:05)',
    );
    const pm = Date.UTC(2026, 10, 13, 23, 59);
    expect(leaseNotice(ev({ state: 'start', atUnixMs: pm }), pm)).toContain('23:59');
  });

  it('returns undefined for an unknown state', () => {
    expect(leaseNotice(ev({ state: 'resumed' }), AT)).toBeUndefined();
    expect(leaseNotice(ev({ state: '' }), AT)).toBeUndefined();
  });
});

describe('NoticeDedupe (spec §5: events may repeat)', () => {
  it('drops a repeat event, across calls and within one batch', () => {
    const d = new NoticeDedupe();
    const end = ev({ state: 'end', reason: 'idle' });
    const start = ev({ state: 'start', atUnixMs: AT + 1 });
    expect(d.take([end, end, start])).toEqual([end, start]);
    expect(d.take([{ ...end }, start])).toEqual([]);
    const later = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 2 });
    expect(d.take([later])).toEqual([later]);
  });

  it('keys on state and at_unix_ms: an end and the next start in one ms are both shown (review #4569829041)', () => {
    const d = new NoticeDedupe();
    const end = ev({ state: 'end', reason: 'idle' });
    const start = ev({ state: 'start' }); // the same at_unix_ms
    expect(d.take([end, start])).toEqual([end, start]);
    expect(d.take([end, start])).toEqual([]);
  });

  it('claims a reset end not yet seen and newer than every event seen, once (review #4569829039)', () => {
    const d = new NoticeDedupe();
    const reset = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 5 });
    d.take([ev({ state: 'start' })]);
    expect(d.claim(reset)).toBe(true);
    expect(d.claim(reset)).toBe(false); // already seen
    expect(d.take([reset])).toEqual([]);
    const older = ev({ state: 'end', reason: 'reset', atUnixMs: AT - 1 });
    expect(d.claim(older)).toBe(false); // older than an event seen
    expect(d.take([older])).toEqual([older]); // a claim that fails marks nothing
    // claimable asks without marking.
    const later = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 10 });
    expect(d.claimable(later)).toBe(true);
    expect(d.claimable(later)).toBe(true);
    expect(d.take([later])).toEqual([later]);
    expect(d.claimable(later)).toBe(false);
  });

  it('keeps every expiring event, and an expiring does not hide a later end at the same ms', () => {
    const d = new NoticeDedupe();
    const expiring = ev({ state: 'expiring', reason: 'max_duration', endsByUnixMs: AT + 60_000 });
    expect(d.take([expiring])).toEqual([expiring]);
    expect(d.take([expiring, expiring])).toEqual([expiring, expiring]);
    const end = ev({ state: 'end', reason: 'max_duration' });
    expect(d.take([end])).toEqual([end]);
  });
});

describe('noticeLines (spec §5: one result, its lines)', () => {
  const end = ev({ state: 'end', reason: 'idle' });
  const start = ev({ state: 'start', atUnixMs: AT + 1 });
  const expiring = (endsByUnixMs: number) =>
    ev({ state: 'expiring', reason: 'max_duration', endsByUnixMs });

  it('hides a start beside an end, and keeps a start alone', () => {
    expect(noticeLines([end, start], AT)).toEqual([leaseNotice(end, AT)]);
    expect(noticeLines([start, end], AT)).toEqual([leaseNotice(end, AT)]);
    expect(noticeLines([start], AT)).toEqual([leaseNotice(start, AT)]);
  });

  it('keeps only the last expiring event', () => {
    const a = expiring(AT + 5 * 60_000);
    const b = expiring(AT + 4 * 60_000);
    expect(noticeLines([a, b], AT)).toEqual([leaseNotice(b, AT)]);
  });

  it('drops a state it does not know, and is empty for no events', () => {
    expect(noticeLines([ev({ state: 'later' })], AT)).toEqual([]);
    expect(noticeLines([], AT)).toEqual([]);
  });
});
