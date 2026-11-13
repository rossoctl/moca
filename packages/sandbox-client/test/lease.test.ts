import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseEvent, SandboxMode } from '../src/gen/sandbox/v1/sandbox.js';
import { NoticeDedupe, leaseNotice } from '../src/lease.js';

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
  it('drops a repeat at_unix_ms, across calls and within one batch', () => {
    const d = new NoticeDedupe();
    const end = ev({ state: 'end', reason: 'idle' });
    const start = ev({ state: 'start', atUnixMs: AT + 1 });
    expect(d.take([end, end, start])).toEqual([end, start]);
    expect(d.take([{ ...end }, start])).toEqual([]);
    const later = ev({ state: 'end', reason: 'reset', atUnixMs: AT + 2 });
    expect(d.take([later])).toEqual([later]);
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
