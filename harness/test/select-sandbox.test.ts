import { describe, it, expect, vi } from 'vitest';
import {
  orderByLoad,
  selectPoolSandbox,
  SandboxPoolSaturatedError,
  resolveDiscoverySource,
  resetSharedStores,
} from '../src/select-sandbox.js';
import type { LeaseStore } from '../src/sandbox-lease.js';
import type { RecordStore, SandboxRecord } from '../src/pool-records.js';
import type { ExecClientLike } from '@moca/k8s-sandbox';

// Spy on the RedisRecordStore constructor select-sandbox.ts falls back to when
// deps.records isn't injected, so we can assert its lifecycle (list + close)
// without ever touching a real Redis connection.
const { createdRecordStores } = vi.hoisted(() => ({
  createdRecordStores: [] as { list: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
}));
vi.mock('../src/pool-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pool-records.js')>();
  return {
    ...actual,
    RedisRecordStore: vi.fn().mockImplementation(() => {
      const store = {
        put: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        list: vi.fn(async () => [] as SandboxRecord[]),
        close: vi.fn(async () => {}),
      };
      createdRecordStores.push(store);
      return store;
    }),
  };
});

describe('orderByLoad', () => {
  it('sorts ascending by active load, stable on ties', () => {
    expect(
      orderByLoad([
        { pod: 'c', active: 2 },
        { pod: 'a', active: 0 },
        { pod: 'b', active: 0 },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
});

function fakeLease(
  loads: Record<string, number>,
  cap: number,
): LeaseStore & { acquired: string[]; acquiredTtl: number[]; acquiredHolders: string[] } {
  const counts = { ...loads };
  const acquired: string[] = [];
  const acquiredTtl: number[] = [];
  const acquiredHolders: string[] = [];
  return {
    acquired,
    acquiredTtl,
    acquiredHolders,
    async load(pod) {
      return counts[pod] ?? 0;
    },
    async acquire(pod, c, holderId, ttlMs) {
      if ((counts[pod] ?? 0) < c) {
        counts[pod] = (counts[pod] ?? 0) + 1;
        acquired.push(pod);
        acquiredTtl.push(ttlMs);
        acquiredHolders.push(holderId);
        return true;
      }
      return false;
    },
    async heartbeat() {},
    async release() {},
  };
}

describe('selectPoolSandbox', () => {
  const opts = { cap: 2, ttlMs: 60000 };

  it('returns null when no sandbox is configured at all', async () => {
    const res = await selectPoolSandbox({} as NodeJS.ProcessEnv, '/head', 'leaf-1', opts, {
      listPods: async () => [],
    });
    expect(res).toBeNull();
  });

  it('falls back to single-pod resolution when no pool selector is set', async () => {
    const env = { KAGENTI_SANDBOX_POD: 'sandbox-x' } as unknown as NodeJS.ProcessEnv;
    const res = await selectPoolSandbox(env, '/head', 'leaf-1', opts, {});
    expect(res?.config.pod).toBe('sandbox-x');
  });

  it('picks the least-loaded pod and acquires a lease', async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ 'sandbox-0-0': 2, 'sandbox-1-0': 0 }, opts.cap);
    const res = await selectPoolSandbox(env, '/head', 'leaf-1', opts, {
      listPods: async () => ['sandbox-0-0', 'sandbox-1-0'],
      lease,
    });
    expect(res?.config.pod).toBe('sandbox-1-0');
    expect(lease.acquired).toEqual(['sandbox-1-0']);
    expect(lease.acquiredTtl).toEqual([opts.ttlMs]);
  });

  it('throws SandboxPoolSaturatedError when every pod is at cap', async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ 'sandbox-0-0': 2, 'sandbox-1-0': 2 }, opts.cap);
    await expect(
      selectPoolSandbox(env, '/head', 'leaf-1', opts, {
        listPods: async () => ['sandbox-0-0', 'sandbox-1-0'],
        lease,
      }),
    ).rejects.toBeInstanceOf(SandboxPoolSaturatedError);
  });

  it('throws a plain Error (not SandboxPoolSaturatedError) when a pool selector is set but no pods are Running', async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox' } as unknown as NodeJS.ProcessEnv;
    // lease is never touched: the empty-list guard throws before any lease call.
    const err = await selectPoolSandbox(env, '/head', 'leaf-1', opts, {
      listPods: async () => [],
      lease: fakeLease({}, opts.cap),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxPoolSaturatedError);
    expect((err as Error).message).toBe("no Running pods for pool selector 'app=sandbox'");
  });
});

const grpcRec: SandboxRecord = {
  sandboxId: 'sbx-remote-1',
  labels: {},
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
};
const fakeRecords = (recs: SandboxRecord[]): RecordStore => ({
  put: async () => {},
  remove: async () => {},
  list: async () => recs,
});
const fakeExecClient: ExecClientLike = {
  exec: () => ({ on: () => ({}), cancel: () => {} }) as never,
  abort: (_r, cb) => {
    cb(null);
    return {};
  },
};

describe('selectPoolSandbox remote dispatch', () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx', ...extra }) as NodeJS.ProcessEnv;
  const opts = { cap: 4, ttlMs: 60000, remoteSandbox: true };

  it('flag OFF: ignores grpc records, transport is undefined, and never calls records.list()', async () => {
    const lease = fakeLease({ 'sandbox-0-0': 0 }, opts.cap);
    const list = vi.fn(async () => [grpcRec]);
    const records: RecordStore = { put: async () => {}, remove: async () => {}, list };
    const sel = await selectPoolSandbox(
      env(),
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000 /* remoteSandbox omitted ⇒ false */ },
      {
        listPods: async () => ['sandbox-0-0'],
        lease,
        records,
      },
    );
    expect(sel?.transport).toBeUndefined();
    expect(sel?.config.pod).toBe('sandbox-0-0');
    // The #1 inertness gate: when remoteSandbox is off, RecordStore.list() must never be invoked.
    expect(list).not.toHaveBeenCalled();
  });

  it('flag ON: a leased grpc record yields a GrpcRelayTransport', async () => {
    // Only the grpc record is available (no pods) so it must be chosen.
    const lease = fakeLease({ 'sbx-remote-1': 0 }, opts.cap);
    const sel = await selectPoolSandbox(env(), '/head', 'run-1', opts, {
      listPods: async () => [],
      lease,
      records: fakeRecords([grpcRec]),
      makeExecClient: () => fakeExecClient,
    });
    expect(sel?.transport).toBeDefined();
    expect(typeof sel?.transport?.exec).toBe('function');
    expect(sel?.config.pod).toBe('sbx-remote-1');
  });

  it('gives the leased transport the SESSION id as its workspace key', async () => {
    const lease = fakeLease({ 'sbx-remote-1': 0 }, opts.cap);
    let seen: { id: string; opts?: { workspaceKey?: string } } | undefined;
    const fakeTransport = {
      exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
      close: async () => {},
    };
    const sel = await selectPoolSandbox(env(), '/head', 'leaf-abc123', opts, {
      listPods: async () => [],
      lease,
      records: fakeRecords([grpcRec]),
      makeExecClient: () => fakeExecClient,
      // capture what the transport was built with
      makeTransport: (id, _client, transportOpts) => {
        seen = { id, opts: transportOpts };
        return fakeTransport;
      },
    });
    expect(sel?.transport).toBeDefined();
    // The SESSION id is the workspace key. A leaf passes no separate holder, so the two ids coincide
    // here — the case that distinguishes them is below.
    expect(seen?.opts?.workspaceKey).toBe('leaf-abc123');
  });

  it('keys the workspace by the session id even when the LEASE holder differs', async () => {
    // The `/turn` shape: many concurrent turns of one session, so each takes its lease under its own
    // per-turn holder while all of them must share the session's workspace. Keying the workspace by
    // the holder instead gave turn 2 an empty `WorkspaceRoot/<key>` and its own standby VM pool
    // (spec §3.4, §4.3, §4.4) — cross-turn continuity lost, standbys multiplied per turn.
    const lease = fakeLease({ 'sbx-remote-1': 0 }, opts.cap);
    let seen: { id: string; opts?: { workspaceKey?: string } } | undefined;
    const fakeTransport = {
      exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
      close: async () => {},
    };
    const sel = await selectPoolSandbox(
      env(),
      '/head',
      'sess-1',
      { ...opts, holderId: 'sess-1:11111111-2222-3333-4444-555555555555' },
      {
        listPods: async () => [],
        lease,
        records: fakeRecords([grpcRec]),
        makeExecClient: () => fakeExecClient,
        makeTransport: (id, _client, transportOpts) => {
          seen = { id, opts: transportOpts };
          return fakeTransport;
        },
      },
    );

    expect(sel?.transport).toBeDefined();
    expect(seen?.opts?.workspaceKey).toBe('sess-1');
    // ...and the lease itself is taken under the holder, not the session id.
    expect(lease.acquired).toEqual(['sbx-remote-1']);
    expect(lease.acquiredHolders).toEqual(['sess-1:11111111-2222-3333-4444-555555555555']);
  });
});

describe('selectPoolSandbox remote dispatch: ad-hoc RedisRecordStore lifecycle', () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx', ...extra }) as NodeJS.ProcessEnv;
  const opts = { cap: 4, ttlMs: 60000, remoteSandbox: true };

  it('REUSES one RedisRecordStore across selections instead of one per call', async () => {
    // This replaces an assertion that the store was constructed and closed per call. That was
    // harmless while only prompt leaves reached this path -- a leaf is a process -- but once /turn
    // began selecting from the pool it meant a Redis connect and disconnect PER TURN. Measured on a
    // real run: ~10k turns produced 35,654 connections, Redis answered
    // `ERR max number of clients reached` (11 rejected against maxclients 10000, closes lagging
    // opens), node-redis raised that as an 'error' on a client with no listener, and all four
    // workers exited code 1 SIMULTANEOUSLY mid-rung, stranding their in-flight turns.
    resetSharedStores();
    createdRecordStores.length = 0;
    const lease = fakeLease({ 'sandbox-0-0': 0, 'sandbox-0-1': 0 }, opts.cap);
    const deps = { listPods: async () => ['sandbox-0-0', 'sandbox-0-1'], lease };

    await selectPoolSandbox(env(), '/head', 'run-1', opts, deps);
    await selectPoolSandbox(env(), '/head', 'run-2', opts, deps);
    await selectPoolSandbox(env(), '/head', 'run-3', opts, deps);

    // One store for three selections is the whole point; three would be the defect.
    expect(createdRecordStores).toHaveLength(1);
    expect(createdRecordStores[0].list).toHaveBeenCalledTimes(3);
    // And it is NOT closed between uses: it is process-lived by design, so closing it after each
    // selection is what forced the reconnect-per-turn in the first place.
    expect(createdRecordStores[0].close).not.toHaveBeenCalled();
  });

  it('drops the cached store when a list fails, so one blip is not permanent', async () => {
    // Memoising a broken client would turn a transient Redis failure into a permanent "no
    // sandboxes" verdict for the life of the process -- selection would then throw
    // `no Running pods for pool selector` forever, which reads as a misconfigured pool.
    resetSharedStores();
    createdRecordStores.length = 0;
    const lease = fakeLease({ 'sandbox-0-0': 0 }, opts.cap);
    const deps = { listPods: async () => ['sandbox-0-0'], lease };

    await selectPoolSandbox(env(), '/head', 'run-1', opts, deps);
    expect(createdRecordStores).toHaveLength(1);
    createdRecordStores[0].list.mockRejectedValueOnce(
      new Error('ERR max number of clients reached'),
    );

    await expect(selectPoolSandbox(env(), '/head', 'run-2', opts, deps)).rejects.toThrow(
      /max number of clients/,
    );
    // The next selection must build a fresh store rather than reuse the poisoned one.
    await selectPoolSandbox(env(), '/head', 'run-3', opts, deps);
    expect(createdRecordStores).toHaveLength(2);
    // And the dropped one must be CLOSED, not merely forgotten: the memo was its last reference, so
    // nulling it alone abandons a live connection -- one per distinct failure, in the code whose
    // whole purpose is keeping connections from reaching maxclients. Safe while concurrent callers
    // still hold it, because redis 6's close() waits for pending commands (destroy() is the abrupt
    // one), and no new caller can reach it once the memo is cleared.
    expect(createdRecordStores[0].close).toHaveBeenCalledTimes(1);
  });

  it('a LATE failure does not evict the store that superseded it', async () => {
    // `drop` used to close over nothing and null the memo unconditionally, so a rejection arriving
    // after the memo had been rebuilt discarded a store that never failed -- orphaning it (connected,
    // unreferenced, never closed) and spending the guard's rebuild on something already healthy.
    resetSharedStores();
    createdRecordStores.length = 0;
    const lease = fakeLease({ 'sandbox-0-0': 0 }, opts.cap);
    const deps = { listPods: async () => ['sandbox-0-0'], lease };
    const other = env({ REDIS_URL: 'redis://other:6379' });

    await selectPoolSandbox(env(), '/head', 'run-1', opts, deps);
    expect(createdRecordStores).toHaveLength(1);

    // Hold store₁'s command open and leave a selection awaiting it.
    let failStore1: (e: Error) => void = () => {};
    createdRecordStores[0].list.mockReturnValueOnce(
      new Promise<SandboxRecord[]>((_resolve, reject) => {
        failStore1 = reject;
      }),
    );
    const inflight = selectPoolSandbox(env(), '/head', 'run-2', opts, deps).catch((e: Error) => e);

    // Meanwhile REDIS_URL changes, so the memo is rebuilt around a healthy store₂.
    await selectPoolSandbox(other, '/head', 'run-3', opts, deps);
    expect(createdRecordStores).toHaveLength(2);

    // store₁'s command now rejects, long after it stopped being the memoised store.
    failStore1(new Error('ERR max number of clients reached'));
    await expect(inflight).resolves.toBeInstanceOf(Error);

    // store₂ never failed, so it must still be the memoised store and must not have been closed.
    // Without the identity check this selection builds a THIRD store and store₂ leaks.
    await selectPoolSandbox(other, '/head', 'run-4', opts, deps);
    expect(createdRecordStores).toHaveLength(2);
    expect(createdRecordStores[1].close).not.toHaveBeenCalled();
  });

  it('does not construct (or close) a RedisRecordStore when deps.records is injected', async () => {
    createdRecordStores.length = 0;
    const lease = fakeLease({ 'sandbox-0-0': 0 }, opts.cap);
    const injected = fakeRecords([]);
    await selectPoolSandbox(env(), '/head', 'run-1', opts, {
      listPods: async () => ['sandbox-0-0'],
      lease,
      records: injected,
    });
    // Caller owns the injected store's lifecycle: we must never construct our
    // own (and therefore never call .close on anything the caller didn't hand us).
    expect(createdRecordStores).toHaveLength(0);
  });
});

describe('resolveDiscoverySource', () => {
  it('defaults to both when SH_SANDBOX_DISCOVERY is unset or blank', () => {
    expect(resolveDiscoverySource({} as NodeJS.ProcessEnv, false)).toBe('both');
    expect(
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: '   ' } as NodeJS.ProcessEnv, false),
    ).toBe('both');
  });

  it('accepts pods|records|both and trims whitespace', () => {
    expect(
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: ' pods ' } as NodeJS.ProcessEnv, false),
    ).toBe('pods');
    expect(
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: 'records' } as NodeJS.ProcessEnv, true),
    ).toBe('records');
    expect(
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: 'both' } as NodeJS.ProcessEnv, true),
    ).toBe('both');
  });

  it('rejects an unknown value naming the variable and the legal set', () => {
    expect(() =>
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: 'grpc' } as NodeJS.ProcessEnv, true),
    ).toThrow(/SH_SANDBOX_DISCOVERY='grpc' is not one of pods\|records\|both/);
  });

  it('records without the remote flag fails loudly naming SH_REMOTE_SANDBOX', () => {
    // Falling through would surface "no Running pods for pool selector '…'", which blames
    // the pool for what is a flag mistake. Blame the flag.
    expect(() =>
      resolveDiscoverySource({ SH_SANDBOX_DISCOVERY: 'records' } as NodeJS.ProcessEnv, false),
    ).toThrow(/SH_REMOTE_SANDBOX=1/);
  });
});

describe('selectPoolSandbox discovery source', () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx', ...extra }) as NodeJS.ProcessEnv;

  it('REGRESSION PIN: unset ⇒ pods are listed exactly as before', async () => {
    // The "changed nothing" gate. If this breaks, the seam is not inert.
    const listPods = vi.fn(async () => ['sandbox-0-0']);
    const lease = fakeLease({ 'sandbox-0-0': 0 }, 4);
    const sel = await selectPoolSandbox(
      env(),
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000 },
      { listPods, lease },
    );
    expect(listPods).toHaveBeenCalledTimes(1);
    expect(sel?.config.pod).toBe('sandbox-0-0');
  });

  it('records: never shells out to kubectl, serves from mirrored records', async () => {
    const listPods = vi.fn(async () => ['sandbox-0-0']);
    const lease = fakeLease({ 'sbx-remote-1': 0 }, 4);
    const sel = await selectPoolSandbox(
      env({ SH_SANDBOX_DISCOVERY: 'records' }),
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000, remoteSandbox: true },
      { listPods, lease, records: fakeRecords([grpcRec]), makeExecClient: () => fakeExecClient },
    );
    // The whole point of step 0: no kubectl on a VM with no cluster.
    expect(listPods).not.toHaveBeenCalled();
    expect(sel?.config.pod).toBe('sbx-remote-1');
    expect(sel?.transport).toBeDefined();
  });

  it('pods: ignores mirrored records even when the remote flag is on', async () => {
    const list = vi.fn(async () => [grpcRec]);
    const lease = fakeLease({ 'sandbox-0-0': 0 }, 4);
    const sel = await selectPoolSandbox(
      env({ SH_SANDBOX_DISCOVERY: 'pods' }),
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000, remoteSandbox: true },
      {
        listPods: async () => ['sandbox-0-0'],
        lease,
        records: { put: async () => {}, remove: async () => {}, list },
      },
    );
    expect(list).not.toHaveBeenCalled();
    expect(sel?.transport).toBeUndefined();
    expect(sel?.config.pod).toBe('sandbox-0-0');
  });

  it('records with an empty record set blames the records, not the pool selector', async () => {
    // `pods` is forced to [] in this mode, so no pod was ever matched against the selector -- naming
    // it sends an operator to debug a healthy pool, which is the same misdirection
    // resolveDiscoverySource's own guard exists to prevent. This is also the likeliest first-run state
    // on the shipped VM default (SH_SANDBOX_DISCOVERY=records), so it is the message operators hit.
    const lease = fakeLease({}, 4);
    await expect(
      selectPoolSandbox(
        env({ SH_SANDBOX_DISCOVERY: 'records' }),
        '/head',
        'run-1',
        { cap: 4, ttlMs: 60000, remoteSandbox: true },
        { listPods: async () => ['sandbox-0-0'], lease, records: fakeRecords([]) },
      ),
    ).rejects.toThrow('no sandbox presence records');
  });

  it('keeps the pods wording for the pod paths, so existing log greps still match', async () => {
    const lease = fakeLease({}, 4);
    for (const discovery of ['pods', 'both'] as const) {
      await expect(
        selectPoolSandbox(
          env({ SH_SANDBOX_DISCOVERY: discovery }),
          '/head',
          'run-1',
          { cap: 4, ttlMs: 60000 },
          { listPods: async () => [], lease },
        ),
      ).rejects.toThrow("no Running pods for pool selector 'app=sbx'");
    }
  });

  it('reports whether a lease was taken, so the caller need not re-read the environment', async () => {
    // acquireTurnSandbox arms its renewal timer off this flag. It used to re-evaluate this function's
    // own `if (!selector)` against the env instead, putting one predicate in two files.
    const lease = fakeLease({}, 4);
    const leasedSel = await selectPoolSandbox(
      env({}),
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000 },
      {
        listPods: async () => ['sandbox-0-0'],
        lease,
      },
    );
    expect(leasedSel?.leased).toBe(true);

    const singlePod = await selectPoolSandbox(
      { KAGENTI_SANDBOX_POOL_SELECTOR: '', KAGENTI_SANDBOX_POD: 'sandbox-0' },
      '/head',
      'run-1',
      { cap: 4, ttlMs: 60000 },
      { lease },
    );
    expect(singlePod?.config.pod).toBe('sandbox-0');
    expect(singlePod?.leased).toBe(false);
  });
});
