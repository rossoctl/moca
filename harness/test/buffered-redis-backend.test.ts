import { describe, it, expect } from 'vitest';
import { makeStoredEntry, type LogStore, type StoredEntry } from '@moca/session-backend';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { BufferedRedisBackend } from '../src/buffered-redis-backend';

// The decorator only reads `.type` / `.customType` at runtime, so minimal cast objects
// stand in for full FileEntry values. Helpers keep the casts in one place.
const msg = (): FileEntry => ({ type: 'message' }) as unknown as FileEntry;
const custom = (customType: string): FileEntry =>
  ({ type: 'custom', customType }) as unknown as FileEntry;
const ct = (e: FileEntry): string | undefined => (e as { customType?: string }).customType;

/** In-memory LogStore<FileEntry> with a per-append delay to test ordering/async. */
class FakeStore implements LogStore<FileEntry> {
  rows: StoredEntry<FileEntry>[] = [];
  failNext = false;
  async append(sid: string, entry: FileEntry, piType: string): Promise<StoredEntry<FileEntry>> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    await new Promise((r) => setTimeout(r, 1));
    const stored = makeStoredEntry({
      position: this.rows.length + 1,
      session_id: sid,
      piType,
      entry,
    });
    this.rows.push(stored);
    return stored;
  }
  async read(_sid: string, from = 1): Promise<StoredEntry<FileEntry>[]> {
    return this.rows.filter((r) => r.position >= from);
  }
  async latestWhere(
    _sid: string,
    p: (e: FileEntry) => boolean,
  ): Promise<StoredEntry<FileEntry> | null> {
    const m = this.rows.filter((r) => p(r.entry));
    return m.length ? m[m.length - 1] : null;
  }
  async nextPosition(): Promise<number> {
    return this.rows.length + 1;
  }
  // BufferedRedisBackend never calls this, but LogStore requires it and checkpoint-extension.ts
  // uses it against the real store -- so the fake implements it the same way rather than
  // narrowing what it claims to be. It was missing entirely until harness/test came under the
  // typechecker (#190).
  async positionOfId(_sid: string, id: string): Promise<number | null> {
    for (const r of this.rows) {
      if ((r.entry as { id?: unknown } | null)?.id === id) return r.position;
    }
    return null;
  }
  async list(): Promise<string[]> {
    return ['s'];
  }
}

describe('BufferedRedisBackend', () => {
  it('append is fire-and-forget (resolves before the write completes) and preserves order on flush', async () => {
    const store = new FakeStore();
    const b = new BufferedRedisBackend(store);
    b.append('s', custom('a'));
    b.append('s', custom('b'));
    b.append('s', custom('c'));
    expect(store.rows.length).toBe(0); // nothing drained yet — writes are async
    await b.flush();
    expect(store.rows.map((r) => ct(r.entry))).toEqual(['a', 'b', 'c']);
  });

  it('flush surfaces a write error from the queue', async () => {
    const store = new FakeStore();
    store.failNext = true;
    const b = new BufferedRedisBackend(store);
    b.append('s', msg());
    await expect(b.flush()).rejects.toThrow('boom');
  });

  it('read unwraps stored entries; latestCheckpoint finds the checkpoint custom entry', async () => {
    const store = new FakeStore();
    const b = new BufferedRedisBackend(store);
    b.append('s', msg());
    b.append('s', custom('checkpoint'));
    await b.flush();
    const entries = await b.read('s');
    expect(entries.map((e) => e.type)).toEqual(['message', 'custom']);
    const cp = await b.latestCheckpoint('s');
    expect(ct(cp as FileEntry)).toBe('checkpoint');
  });
});
