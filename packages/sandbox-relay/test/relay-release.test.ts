import { EventEmitter } from 'node:events';
import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import type { RecordStore } from '@moca/harness';
import { RELEASE_CAPABILITY, WORKER_WITHOUT_RELEASE, createRelay } from '../src/relay.js';

// Relay.routeRelease's bookkeeping against a hand-driven attach stream, as routeLeaseControl's:
// every way a call settles removes its pending entry at once, and nothing is sent to a worker
// that does not advertise RELEASE_CAPABILITY (one from before #338 drops the frame unread).

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

function parked(capabilities: string[] = [RELEASE_CAPABILITY], write?: (f: any) => void) {
  const t = heldTimers();
  const relay = createRelay({ records, validateToken: () => true, timers: t.timers } as never);
  const s = fakeAttach(write);
  relay.onAttach(s as never);
  s.emit('data', {
    hello: {
      sandboxId: 'sbx-1',
      labels: {},
      capabilities,
      image: '',
      arch: 'amd64',
      capacityMax: 1,
      trust: 'trusted',
    },
  });
  return { relay, s, live: t.live };
}

describe('relay routeRelease bookkeeping', () => {
  it('sends a ReleaseFrame with a fresh ctl_id and resolves with its answer', async () => {
    const { relay, s, live } = parked();
    const p = relay.routeRelease('sbx-1', 'wsk', 60_000);
    const f = s.written.at(-1).release;
    expect(f).toMatchObject({ workspaceKey: 'wsk' });
    s.emit('data', { releaseResult: { ctlId: f.ctlId, outcome: 1, error: '' } });
    await expect(p).resolves.toMatchObject({ ctlId: f.ctlId, outcome: 1 });
    expect(live.size).toBe(0);
  });

  it('refuses a worker without the capability and writes nothing', async () => {
    const { relay, s, live } = parked([]);
    const before = s.written.length;
    await expect(relay.routeRelease('sbx-1', 'wsk', 60_000)).rejects.toMatchObject({
      code: status.FAILED_PRECONDITION,
      details: WORKER_WITHOUT_RELEASE,
    });
    expect(s.written.length).toBe(before);
    expect(live.size).toBe(0);
  });

  it('a write that throws rejects at once and leaves no pending entry or timer', async () => {
    const { relay, live } = parked([RELEASE_CAPABILITY], (f) => {
      if (f.release) throw new Error('write after end');
    });
    await expect(relay.routeRelease('sbx-1', 'wsk', 60_000)).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
    expect(live.size).toBe(0);
  });

  it('an aborted signal rejects CANCELLED and drops the late answer', async () => {
    const { relay, s, live } = parked();
    const ac = new AbortController();
    const p = relay.routeRelease('sbx-1', 'wsk', 60_000, ac.signal);
    const ctlId = s.written.at(-1).release.ctlId;
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: status.CANCELLED });
    expect(live.size).toBe(0);
    expect(() => s.emit('data', { releaseResult: { ctlId, error: '' } })).not.toThrow();
  });

  it('a lease answer with the same ctl_id does not settle a release', async () => {
    const { relay, s } = parked();
    const p = relay.routeRelease('sbx-1', 'wsk', 60_000);
    const ctlId = s.written.at(-1).release.ctlId;
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    s.emit('data', { leaseResult: { ctlId, error: '' } });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    s.emit('data', { releaseResult: { ctlId, outcome: 3, error: '' } });
    await expect(p).resolves.toMatchObject({ outcome: 3 });
  });

  it('a worker that goes away fails its waiting releases', async () => {
    const { relay, s, live } = parked();
    const p = relay.routeRelease('sbx-1', 'wsk', 60_000);
    s.emit('end');
    await expect(p).rejects.toMatchObject({ code: status.UNAVAILABLE });
    expect(live.size).toBe(0);
  });
});
