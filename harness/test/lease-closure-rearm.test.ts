import { describe, it, expect, vi } from 'vitest';
import { selectPoolSandbox, resetSharedStores } from '../src/select-sandbox.js';

/**
 * A lease handle held as a CLOSURE must survive the shared store being dropped.
 *
 * `selectPoolSandbox` returns `heartbeat`/`release` closures, and every caller keeps them for the
 * life of the turn or leaf — `run-leaf.ts`'s three `setInterval`s and `run-turn.ts`'s renewal all
 * tick on them long after `selectPoolSandbox` returned. `sharedLease`'s wrapper used to bind one
 * store instance at construction, so those closures could not benefit from the memo's own recovery:
 *
 *  1. a command rejects (a Redis blip, or `ClientClosedError` past `resilientClientOptions`' bound),
 *  2. `guard` runs `dropMemo`, which CLOSES that store and nulls the memo,
 *  3. the next `selectPoolSandbox` builds a healthy store — but the closure still points at the
 *     closed one, whose every command now rejects `ClientClosedError` for good, and whose further
 *     drops are no-ops because `dropMemo`'s identity check sees a different memoised store.
 *
 * So a blip lasting one command cost the lease for the whole turn: heartbeats stop, the TTL lapses,
 * and the pod returns to the pool while the turn is still executing inside it — over-subscribing the
 * soft cap `ACQUIRE_LUA` exists to enforce. It also made every later tick a fresh rejection, which
 * is what turned an unguarded `void lease.heartbeat()` from a one-off into a process-killer.
 *
 * The fix is that the wrapper resolves the memo PER CALL, so a captured closure re-enters exactly as
 * a fresh `sharedLease()` caller would. Giving `RedisLeaseStore` the `arm()`/`open()` re-arm its
 * siblings have would NOT achieve this: `dropMemo` deliberately closed that client, and node-redis
 * lets `connect()` reopen a closed one (probed on the pinned redis 6.2.1 — `close()` then
 * `connect()` returns `isOpen: true` and PINGs), so the closure would resurrect a store no memo
 * references and nothing will ever close. This suite pins both halves: the closure recovers, and the
 * dropped store stays dropped.
 */
const { createdLeaseStores } = vi.hoisted(() => ({
  createdLeaseStores: [] as {
    closed: () => boolean;
    load: ReturnType<typeof vi.fn>;
    acquire: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('../src/sandbox-lease.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox-lease.js')>();
  return {
    ...actual,
    // Models the one property that makes the bug reachable: once closed, every command rejects
    // `ClientClosedError` for good — node-redis's real behaviour past a close or the reconnect bound.
    RedisLeaseStore: vi.fn().mockImplementation(() => {
      let isClosed = false;
      const rejectIfClosed = async () => {
        if (isClosed)
          throw Object.assign(new Error('The client is closed'), { name: 'ClientClosedError' });
      };
      const store = {
        closed: () => isClosed,
        load: vi.fn(async () => {
          await rejectIfClosed();
          return 0;
        }),
        acquire: vi.fn(async () => {
          await rejectIfClosed();
          return true;
        }),
        heartbeat: vi.fn(async () => {
          await rejectIfClosed();
        }),
        release: vi.fn(async () => {
          await rejectIfClosed();
        }),
        close: vi.fn(async () => {
          isClosed = true;
        }),
      };
      createdLeaseStores.push(store);
      return store;
    }),
  };
});

describe('a lease handle held as a closure recovers from a dropped shared store', () => {
  const env = () =>
    ({ KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx', SH_REMOTE_SANDBOX: '1' }) as NodeJS.ProcessEnv;
  const opts = { cap: 4, ttlMs: 60_000, remoteSandbox: true };
  // One relay record whose id matches the pod name these tests' assertions always used; the
  // LEASE store is the (mocked) memo under test, so the record store and affinity are inert
  // stand-ins and the transport a stub (ADR-0041: candidates are records only).
  const deps = {
    records: {
      put: async () => {},
      remove: async () => {},
      list: async () => [
        {
          sandboxId: 'sandbox-0-0',
          labels: {},
          capabilities: [],
          capacityMax: 4,
          transport: 'grpc' as const,
        },
      ],
    },
    affinity: {
      get: async () => null,
      claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
      replace: async () => {},
      detachedSince: async (_id: string, now: number) => now,
    },
    makeExecClient: () => ({}) as never,
    makeTransport: () => ({
      exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    }),
  };

  it('heartbeats through a drop onto the fresh store, with the same pod and runId', async () => {
    resetSharedStores();
    createdLeaseStores.length = 0;

    const selected = await selectPoolSandbox(env(), '/head', 'run-1', opts, deps);
    expect(createdLeaseStores).toHaveLength(1);
    const first = createdLeaseStores[0]!;

    // One heartbeat rejects — a blip, or the permanent ClientClosedError past the reconnect bound.
    first.heartbeat.mockRejectedValueOnce(new Error('ERR max number of clients reached'));
    await expect(selected!.heartbeat()).rejects.toThrow(/max number of clients/);

    // That drop closed the store and cleared the memo (dropMemo's documented job).
    expect(first.close).toHaveBeenCalledTimes(1);

    // The next tick of the SAME captured closure must succeed, against a fresh store.
    await expect(selected!.heartbeat()).resolves.toBeUndefined();
    expect(createdLeaseStores).toHaveLength(2);
    const second = createdLeaseStores[1]!;
    expect(second.heartbeat).toHaveBeenCalledTimes(1);
    // A lease is identified by pod + runId, which are values rather than connection state, so the
    // renewal must land on the same member it would have without the blip.
    expect(second.heartbeat.mock.calls[0]?.slice(0, 2)).toEqual(['sandbox-0-0', 'run-1']);
  });

  it('releases through a drop, so a blip cannot strand pool capacity', async () => {
    resetSharedStores();
    createdLeaseStores.length = 0;

    const selected = await selectPoolSandbox(env(), '/head', 'run-2', opts, deps);
    const first = createdLeaseStores[0]!;
    first.heartbeat.mockRejectedValueOnce(new Error('blip'));
    await expect(selected!.heartbeat()).rejects.toThrow('blip');

    // release() frees the soft-cap slot; losing it strands that slot until the TTL lapses.
    await expect(selected!.release()).resolves.toBeUndefined();
    const second = createdLeaseStores[1]!;
    expect(second.release.mock.calls[0]?.slice(0, 2)).toEqual(['sandbox-0-0', 'run-2']);
  });

  it('does not resurrect the store it dropped', async () => {
    // The alternative fix — an arm()/open() re-arm inside RedisLeaseStore — would make the closure
    // work by RECONNECTING the client dropMemo just closed. That client is in no memo, so nothing
    // would ever close it again: one orphaned connection per outage, in the code whose whole purpose
    // is keeping connections off the maxclients ceiling. Recovery must come from the memo instead.
    resetSharedStores();
    createdLeaseStores.length = 0;

    const selected = await selectPoolSandbox(env(), '/head', 'run-3', opts, deps);
    const first = createdLeaseStores[0]!;
    first.heartbeat.mockRejectedValueOnce(new Error('blip'));
    await expect(selected!.heartbeat()).rejects.toThrow('blip');
    expect(first.closed()).toBe(true);

    const callsAtDrop = first.heartbeat.mock.calls.length;
    await selected!.heartbeat();
    await selected!.heartbeat();

    // Nothing further may be issued on the dropped store, and it stays closed.
    expect(first.heartbeat.mock.calls.length).toBe(callsAtDrop);
    expect(first.closed()).toBe(true);
    // Exactly one replacement, reused across both ticks.
    expect(createdLeaseStores).toHaveLength(2);
  });
});
