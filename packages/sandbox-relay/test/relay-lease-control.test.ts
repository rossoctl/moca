import { EventEmitter } from 'node:events';
import { status } from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import { LeaseOp, SandboxMode } from '@moca/k8s-sandbox';
import type { RecordStore } from '@moca/harness';
import { createRelay } from '../src/relay.js';

// Relay.routeLeaseControl's bookkeeping against a hand-driven attach stream: every way a call
// settles removes its pending entry at once, so nothing waits for the per-op timeout to be cleaned.

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };

function fakeAttach(write: (f: any) => void = () => {}) {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: () => string[] };
    write: (f: any) => void;
    end: () => void;
    written: any[];
  };
  s.metadata = { get: () => [] };
  s.written = [];
  s.write = (f) => {
    s.written.push(f);
    write(f);
  };
  s.end = () => s.emit('end');
  return s;
}

/** Timers that never fire on their own, so a test sees what settles without the timeout. */
function heldTimers() {
  const live = new Set<object>();
  return {
    live,
    timers: {
      setTimeout: () => {
        const h = {};
        live.add(h);
        return h;
      },
      clearTimeout: (h: unknown) => void live.delete(h as object),
    },
  };
}

function parked(write?: (f: any) => void, now?: () => number) {
  const t = heldTimers();
  const relay = createRelay({
    records,
    validateToken: () => true,
    timers: t.timers,
    ...(now ? { now } : {}),
  } as never);
  const s = fakeAttach(write);
  relay.onAttach(s as never);
  s.emit('data', {
    hello: {
      sandboxId: 'sbx-1',
      labels: {},
      capabilities: [],
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  });
  return { relay, s, live: t.live };
}

const STATUS = {
  workspaceKey: 'wsk',
  op: LeaseOp.LEASE_OP_STATUS,
  mode: SandboxMode.SANDBOX_MODE_UNSPECIFIED,
  modeEpoch: 0,
};

describe('relay routeLeaseControl bookkeeping', () => {
  it('a write that throws rejects at once and leaves no pending entry or timer', async () => {
    const { relay, live } = parked((f) => {
      if (f.leaseControl) throw new Error('write after end');
    });
    await expect(relay.routeLeaseControl('sbx-1', STATUS, 60_000)).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
    expect(live.size).toBe(0);
  });

  it('an aborted signal rejects CANCELLED at once and drops the late answer', async () => {
    const { relay, s, live } = parked();
    const ac = new AbortController();
    const p = relay.routeLeaseControl('sbx-1', STATUS, 60_000, ac.signal);
    const ctlId = s.written.at(-1).leaseControl.ctlId;
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: status.CANCELLED });
    expect(live.size).toBe(0);
    // The worker's answer for the withdrawn id finds no waiter.
    expect(() => s.emit('data', { leaseResult: { ctlId, error: '' } })).not.toThrow();
  });

  it('an already-aborted signal sends nothing', async () => {
    const { relay, s } = parked();
    const ac = new AbortController();
    ac.abort();
    const before = s.written.length;
    await expect(relay.routeLeaseControl('sbx-1', STATUS, 60_000, ac.signal)).rejects.toMatchObject(
      { code: status.CANCELLED },
    );
    expect(s.written.length).toBe(before);
  });

  it('a duplicate answer is dropped and does not touch a later call', async () => {
    const { relay, s, live } = parked();
    const first = relay.routeLeaseControl('sbx-1', STATUS, 60_000);
    const a = s.written.at(-1).leaseControl.ctlId;
    s.emit('data', { leaseResult: { ctlId: a, error: '' } });
    await expect(first).resolves.toMatchObject({ ctlId: a });
    const second = relay.routeLeaseControl('sbx-1', STATUS, 60_000);
    const b = s.written.at(-1).leaseControl.ctlId;
    s.emit('data', { leaseResult: { ctlId: a, error: 'duplicate' } });
    s.emit('data', { leaseResult: { ctlId: b, error: '' } });
    await expect(second).resolves.toMatchObject({ ctlId: b, error: '' });
    expect(live.size).toBe(0);
  });
});

/**
 * sbx-1's keepalive coalescing map (Parked.keepaliveAtMs), caught as the Map that a first, written
 * keepalive for key sets the key on: routeKeepalive's only Map writes are to that map, so the relay
 * needs no test hook for it to be watched.
 */
function keepaliveMap(relay: ReturnType<typeof createRelay>, key: string): Map<string, number> {
  const set = vi.spyOn(Map.prototype, 'set');
  let map: Map<string, number> | undefined;
  try {
    relay.routeKeepalive('sbx-1', key);
    const i = set.mock.calls.findIndex(([k]) => k === key);
    map = set.mock.contexts[i] as unknown as Map<string, number> | undefined;
  } finally {
    set.mockRestore();
  }
  if (!map) throw new Error(`routeKeepalive set no Map entry for ${key}`);
  return map;
}

describe('relay routeKeepalive', () => {
  it('a failed write opens no coalescing window: the next keepalive within 1 s is written (review #4569829045)', () => {
    let t = 10_000;
    let failNext = true;
    const { relay, s } = parked(
      (f) => {
        if (f.keepalive && failNext) {
          failNext = false;
          throw new Error('write after end');
        }
      },
      () => t,
    );
    const keepalives = () => s.written.filter((f) => f.keepalive).length;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      relay.routeKeepalive('sbx-1', 'wsk'); // tried, and failed
      expect(keepalives()).toBe(1);
      t += 300;
      relay.routeKeepalive('sbx-1', 'wsk'); // within 1 s of the failure: written
      expect(keepalives()).toBe(2);
      expect(err).toHaveBeenCalledTimes(1);
      t += 300;
      relay.routeKeepalive('sbx-1', 'wsk'); // within 1 s of the written one: coalesced
      expect(keepalives()).toBe(2);
      t += 1_000;
      relay.routeKeepalive('sbx-1', 'wsk'); // its window is over
      expect(keepalives()).toBe(3);
    } finally {
      err.mockRestore();
    }
  });

  it('the coalescing map prunes: a written keepalive drops every entry past its window', () => {
    let t = 10_000;
    const { relay } = parked(undefined, () => t);
    const map = keepaliveMap(relay, 'ws-a');
    expect([...map]).toEqual([['ws-a', 10_000]]);

    t += 500;
    relay.routeKeepalive('sbx-1', 'ws-b');
    expect([...map.keys()]).toEqual(['ws-a', 'ws-b']); // ws-a is 500 ms old: inside its window
    t += 200;
    relay.routeKeepalive('sbx-1', 'ws-a'); // coalesced: nothing written, so nothing pruned or moved
    expect([...map]).toEqual([
      ['ws-a', 10_000],
      ['ws-b', 10_500],
    ]);
    t += 300;
    relay.routeKeepalive('sbx-1', 'ws-c'); // ws-a is 1 000 ms old, past its window; ws-b is not
    expect([...map]).toEqual([
      ['ws-b', 10_500],
      ['ws-c', 11_000],
    ]);
    t += 5_000;
    relay.routeKeepalive('sbx-1', 'ws-d'); // both left long ago: the map holds only the last
    expect([...map]).toEqual([['ws-d', 16_000]]);
  });

  it('a failed write puts no entry in the coalescing map: it opens no window', () => {
    let t = 10_000;
    let fail = false;
    const { relay } = parked(
      (f) => {
        if (f.keepalive && fail) throw new Error('write after end');
      },
      () => t,
    );
    const map = keepaliveMap(relay, 'ws-a');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fail = true;
      t += 2_000;
      relay.routeKeepalive('sbx-1', 'ws-b'); // tried, and failed
      expect(err).toHaveBeenCalledTimes(1);
      expect(map.has('ws-b')).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it('a write that throws is caught: fire-and-forget, the caller still answers OK', () => {
    const { relay, s } = parked((f) => {
      if (f.keepalive) throw new Error('write after end');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => relay.routeKeepalive('sbx-1', 'wsk')).not.toThrow();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
    // The stream is left as it was: the next frame still goes out.
    const p = relay.routeLeaseControl('sbx-1', STATUS, 60_000);
    const ctlId = s.written.at(-1).leaseControl.ctlId;
    s.emit('data', { leaseResult: { ctlId, error: '' } });
    return expect(p).resolves.toMatchObject({ ctlId });
  });
});
