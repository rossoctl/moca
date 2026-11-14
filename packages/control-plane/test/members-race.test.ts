import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MembersStore } from '../src/members.js';
import { ProvenanceStore } from '../src/provenance.js';

// A reader of members.json outside the store's serial lock (every request's membershipNow) that
// finishes late must not hand a stale doc to the next change() (enrollment and roles spec §8). The
// interleaving is forced: the opens of members.json can be held at their stat() or close().

interface Hold {
  stat?: Promise<void>;
  close?: Promise<void>;
}
const holds = vi.hoisted(() => ({ next: [] as Hold[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof real.open>) => {
    const fh = await real.open(...args);
    if (!String(args[0]).endsWith('members.json')) return fh;
    const hold = holds.next.shift();
    if (!hold) return fh;
    const stat = fh.stat.bind(fh);
    const close = fh.close.bind(fh);
    Object.assign(fh, {
      stat: async (...a: Parameters<typeof stat>) => {
        await hold.stat;
        return stat(...a);
      },
      close: async () => {
        await hold.close;
        return close();
      },
    });
    return fh;
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const enroll = (subject: string) => (doc: { members: Record<string, unknown> }) => {
  doc.members[subject] = { subject, enrolled: true, roles: [], since: 1, by: 'github:1' };
  return { kind: 'member' as const, subject: 'github:1', body: { subject, enrolled: true } };
};

describe('members.json read outside the lock (spec §8)', () => {
  it('keeps a change that a late reader of the older version would roll back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-members-race-'));
    const provenance = new ProvenanceStore({ dir, now: () => 1_700_000_000_000 });
    const bootstrap = { allowed: [], admins: ['github:1'] };
    const members = new MembersStore({ dir, provenance, bootstrap });
    await members.change(enroll('github:10')); // version N

    // A reader opens version N and is held at its stat().
    const readerStat = gate();
    holds.next.push({ stat: readerStat.wait });
    const reader = members.membershipNow('github:30', 0);
    await tick();

    // A change writes version N+1 meanwhile (its own read isn't held).
    holds.next.push({});
    await members.change(enroll('github:11'));

    // The next change matches N+1's key, and is held at close(); the late reader then finishes.
    const changeClose = gate();
    holds.next.push({ close: changeClose.wait });
    const next = members.change(enroll('github:12'));
    await tick();
    readerStat.open();
    await reader;
    changeClose.open();
    await next;

    // What is on disk, through a store with no cache of its own.
    const fresh = new MembersStore({ dir, provenance, bootstrap });
    for (const s of ['github:10', 'github:11', 'github:12'])
      expect(await fresh.storeEnrolled(s), s).toBe(true);
    expect(holds.next).toEqual([]);
  });
});
