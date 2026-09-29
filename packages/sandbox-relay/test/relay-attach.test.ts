import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createRelay } from '../src/relay.js';
import type { SandboxRecord, RecordStore } from '@moca/harness';

function fakeRecords() {
  const map = new Map<string, SandboxRecord>();
  const store: RecordStore = {
    put: vi.fn(async (r) => void map.set(r.sandboxId, r)),
    remove: vi.fn(async (id) => void map.delete(id)),
    list: async () => [...map.values()],
  };
  return { store, map };
}

/** Fake bidi Attach stream. Worker writes via emitData; relay writes via .write. */
function fakeAttach(token?: string) {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    written: unknown[];
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: (k) => (k === 'authorization' && token ? [`Bearer ${token}`] : []) };
  s.written = [];
  s.write = (f) => s.written.push(f);
  s.end = () => s.emit('end');
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const hello = (sandboxId: string) => ({
  hello: {
    sandboxId,
    labels: { team: 't1' },
    capabilities: ['python3'],
    image: 'img',
    arch: 'amd64',
    capacityMax: 4,
    trust: 'trusted',
  },
});

describe('relay Attach + presence', () => {
  it('parks the stream and mirrors presence on Hello', async () => {
    const { store, map } = fakeRecords();
    const relay = createRelay({ records: store, validateToken: () => true } as never);
    const s = fakeAttach('good');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeTruthy());
    expect(map.get('sbx-1')!.transport).toBe('grpc');
    expect(relay.parked()).toContain('sbx-1');
  });

  it('removes presence when the stream closes', async () => {
    const { store, map } = fakeRecords();
    const relay = createRelay({ records: store, validateToken: () => true } as never);
    const s = fakeAttach('good');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeTruthy());
    s.end();
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeUndefined());
    expect(relay.parked()).not.toContain('sbx-1');
  });

  it('rejects a bad token before parking (no presence written)', async () => {
    const { store, map } = fakeRecords();
    const relay = createRelay({ records: store, validateToken: () => false } as never);
    const s = fakeAttach('bad');
    relay.onAttach(s as never);
    s.emitData(hello('sbx-1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(map.get('sbx-1')).toBeUndefined();
    expect(relay.parked()).not.toContain('sbx-1');
  });

  it('rejects a duplicate Attach for an already-parked sandboxId without evicting the first session', async () => {
    const { store, map } = fakeRecords();
    const relay = createRelay({ records: store, validateToken: () => true } as never);

    const s1 = fakeAttach('good');
    relay.onAttach(s1 as never);
    s1.emitData(hello('sbx-1'));
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeTruthy());
    const presenceAfterFirst = map.get('sbx-1');

    // A second worker tries to claim the same sandboxId while worker-1 is still live.
    const s2 = fakeAttach('good');
    let s2Ended = false;
    s2.end = () => {
      s2Ended = true;
      s2.emit('end');
    };
    relay.onAttach(s2 as never);
    s2.emitData(hello('sbx-1'));

    // The duplicate is rejected: its stream is ended, no session replacement, presence untouched.
    expect(s2Ended).toBe(true);
    expect(relay.parked()).toContain('sbx-1');
    expect(map.get('sbx-1')).toBe(presenceAfterFirst);

    // Worker-1's teardown (its own "end") still removes the (only, original) session —
    // proof that worker-2's Hello never replaced it.
    s1.end();
    await vi.waitFor(() => expect(map.get('sbx-1')).toBeUndefined());
    expect(relay.parked()).not.toContain('sbx-1');
  });
});
