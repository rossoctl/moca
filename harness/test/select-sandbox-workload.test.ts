import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  selectPoolSandbox,
  SandboxAffinityPendingError,
  SandboxPoolEmptyError,
  WorkloadSandboxMisconfiguredError,
  WorkloadSandboxUnavailableError,
  resetTierWarnings,
} from '../src/select-sandbox.js';
import type { SandboxRecord } from '../src/pool-records.js';
import type { LeaseStore } from '../src/sandbox-lease.js';
import type { AffinityEntry, AffinityStore } from '../src/sandbox-affinity.js';
import type { SelectDeps } from '../src/select-sandbox.js';

// Fakes in the shape select-sandbox-tiers.test.ts uses; copied rather than imported, because
// importing a test file makes vitest run its tests a second time.
function fakeLease(loads: Record<string, number> = {}) {
  const counts = { ...loads };
  const acquired: string[] = [];
  const lease: LeaseStore = {
    load: async (p) => counts[p] ?? 0,
    acquire: async (p, cap) => {
      if ((counts[p] ?? 0) >= cap) return false;
      counts[p] = (counts[p] ?? 0) + 1;
      acquired.push(p);
      return true;
    },
    heartbeat: async () => {},
    release: async (p) => {
      counts[p] = Math.max(0, (counts[p] ?? 0) - 1);
    },
  };
  return { lease, acquired };
}

function fakeAffinity(init: Record<string, AffinityEntry> = {}) {
  const entries = new Map(Object.entries(init));
  const detached = new Map<string, number>();
  const store: AffinityStore = {
    get: async (s) => entries.get(s) ?? null,
    claim: async (s, e) => entries.get(s) ?? (entries.set(s, e), e),
    replace: async (s, e) => void entries.set(s, e),
    detachedSince: async (id, now) => detached.get(id) ?? (detached.set(id, now), now),
  };
  return { store };
}

const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
};
const env = (extra: Record<string, string> = {}) =>
  ({
    KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
    SH_SANDBOX_DISCOVERY: 'records',
    ...extra,
  }) as NodeJS.ProcessEnv;
const TIERS = { SH_SANDBOX_TIERS: 'container,microvm', SH_SANDBOX_DEFAULT_TIER: 'container' };
const opts = (o: Record<string, unknown> = {}) => ({
  cap: 2,
  ttlMs: 60_000,
  remoteSandbox: true,
  ...o,
});
function deps(recs: SandboxRecord[], lease: LeaseStore, extra: Partial<SelectDeps> = {}) {
  return {
    records: { put: async () => {}, remove: async () => {}, list: async () => recs },
    lease,
    makeExecClient: () => ({}) as never,
    makeTransport: () => fakeTransport,
    affinity: fakeAffinity().store,
    ...extra,
  } satisfies SelectDeps;
}

/** The workload filter (workload sandboxes spec §3.3, #476 phase 2 PR 1). */

const WL = `w-${'a'.repeat(32)}`;
const OTHER = `w-${'f'.repeat(32)}`;
const OWN = 'b'.repeat(32);
const OTHER_OWN = 'c'.repeat(32);

const rec = (id: string, labels: Record<string, string> = {}): SandboxRecord => ({
  sandboxId: id,
  labels,
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
});
const wlRec = (id: string, wl: string, tier = 'container', own = OWN) =>
  rec(id, { 'moca.dev/workload': wl, 'moca.dev/owner': own, 'moca.dev/tier': tier });

describe('selectPoolSandbox: workload filter (spec §3.3)', () => {
  beforeEach(() => resetTierWarnings());

  it("a workload run selects only its own workload's sandboxes, however loaded the others are", async () => {
    const { lease } = fakeLease({ [`${WL}-0`]: 1 });
    const recs = [rec('shared-0'), wlRec(`${OTHER}-0`, OTHER), wlRec(`${WL}-0`, WL)];
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe(`${WL}-0`);
  });

  it('a run with no workload never selects a workload sandbox, even when the shared pool is busier', async () => {
    const recs = [wlRec(`${WL}-0`, WL), rec('shared-0')];
    for (const workload of [undefined, '']) {
      const { lease } = fakeLease({ 'shared-0': 1 });
      const sel = await selectPoolSandbox(
        env(),
        '/h',
        `s-${workload}`,
        opts({ workload }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe('shared-0');
    }
  });

  it('a run with no workload and only workload sandboxes attached gets the ordinary empty-pool error', async () => {
    const { lease } = fakeLease();
    const p = selectPoolSandbox(env(), '/h', 's-1', opts(), deps([wlRec(`${WL}-0`, WL)], lease));
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    await expect(p).rejects.not.toBeInstanceOf(WorkloadSandboxUnavailableError);
  });

  it('no live sandbox of the workload: workload_sandbox_unavailable, never the shared pool', async () => {
    const { lease, acquired } = fakeLease();
    const p = selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN }),
      deps([rec('shared-0'), wlRec(`${OTHER}-0`, OTHER)], lease),
    );
    await expect(p).rejects.toBeInstanceOf(WorkloadSandboxUnavailableError);
    await expect(p).rejects.toMatchObject({ code: 'workload_sandbox_unavailable', workload: WL });
    // Still a SandboxPoolEmptyError, so every path that retries an empty pool treats it alike.
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    expect(acquired).toEqual([]);
  });

  it('composes with tiers: a workload sandbox stamped container serves the container tier', async () => {
    const { lease } = fakeLease();
    const recs = [wlRec(`${WL}-0`, WL, 'container'), rec('c-1', { 'moca.dev/tier': 'container' })];
    const sel = await selectPoolSandbox(
      env(TIERS),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe(`${WL}-0`);
  });

  it('composes with tiers: an explicit container-tier workload run still selects its sandbox', async () => {
    const { lease } = fakeLease();
    const recs = [wlRec(`${WL}-0`, WL, 'container'), rec('c-1', { 'moca.dev/tier': 'container' })];
    const sel = await selectPoolSandbox(
      env(TIERS),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN, tier: 'container' }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe(`${WL}-0`);
  });

  it('a microvm-tier workload run is misconfigured, not unavailable, even if a workload sandbox is attached', async () => {
    // Workload sandboxes are container-only, so this combination can never be served. Failing as
    // WorkloadSandboxMisconfiguredError keeps the client from retrying a 503 indefinitely.
    const { lease, acquired } = fakeLease();
    const recs = [wlRec(`${WL}-0`, WL, 'container')];
    const p = selectPoolSandbox(
      env(TIERS),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN, tier: 'microvm' }),
      deps(recs, lease),
    );
    await expect(p).rejects.toBeInstanceOf(WorkloadSandboxMisconfiguredError);
    await expect(p).rejects.not.toBeInstanceOf(WorkloadSandboxUnavailableError);
    await expect(p).rejects.toThrow(/container-only|microvm/);
    expect(acquired).toEqual([]);
  });

  it('sends the workload on the Exec, and nothing for a shared-pool run', async () => {
    const seen: Array<{ workspaceKey?: string; workload?: string } | undefined> = [];
    const recs = [wlRec(`${WL}-0`, WL), rec('shared-0')];
    const transport = {
      exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    for (const workload of [WL, undefined]) {
      const { lease } = fakeLease();
      await selectPoolSandbox(
        env(),
        '/h',
        's-1',
        opts({ workload, ownerScope: OWN }),
        deps(recs, lease, {
          makeTransport: (_id, _c, o) => {
            seen.push(o);
            return transport;
          },
        }),
      );
    }
    expect(seen).toEqual([{ workspaceKey: 's-1', workload: WL }, { workspaceKey: 's-1' }]);
  });

  it('a workload run waits for its own absent sandbox within the grace, as any affine session', async () => {
    const { lease } = fakeLease();
    const affinity = fakeAffinity({ 's-1': { sandboxId: `${WL}-0`, tier: '' } });
    const p = selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN }),
      deps([rec('shared-0')], lease, { affinity: affinity.store, now: () => 1_000 }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
  });

  it('a session moved off a workload sandbox resets at once rather than waiting for it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lease } = fakeLease();
    const affinity = fakeAffinity({ 's-1': { sandboxId: `${WL}-0`, tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts(),
      deps([wlRec(`${WL}-0`, WL), rec('shared-0')], lease, { affinity: affinity.store }),
    );
    expect(sel?.sandboxId).toBe('shared-0');
    expect(sel?.workspaceReset).toEqual({ from: `${WL}-0`, reason: 'retiered' });
    warn.mockRestore();
  });

  it('a workload run is refused outright where no relay records can serve it', async () => {
    const { lease } = fakeLease();
    const recs = [wlRec(`${WL}-0`, WL)];
    // No pool selector: a deployment that can never serve the run — not "none attached right now".
    await expect(
      selectPoolSandbox(
        env({ KAGENTI_SANDBOX_POOL_SELECTOR: '' }),
        '/h',
        's-1',
        opts({ workload: WL, ownerScope: OWN }),
        deps(recs, lease),
      ),
    ).rejects.toBeInstanceOf(WorkloadSandboxMisconfiguredError);
    // A stale pods/both discovery mode (ADR-0041) or a missing remote flag is refused loudly
    // before any record is read — also never "none attached right now".
    for (const [e, o] of [
      [{ SH_SANDBOX_DISCOVERY: 'both' }, { remoteSandbox: false }],
      [{ SH_SANDBOX_DISCOVERY: 'pods' }, {}],
    ] as const) {
      await expect(
        selectPoolSandbox(
          env(e),
          '/h',
          's-1',
          opts({ ...o, workload: WL, ownerScope: OWN }),
          deps(recs, lease),
        ),
        JSON.stringify(e),
      ).rejects.toThrow(/SH_SANDBOX_DISCOVERY|SH_REMOTE_SANDBOX/);
    }
  });

  it('a record with the right workload but another owner is never selected', async () => {
    const { lease, acquired } = fakeLease({ [`${WL}-1`]: 1 });
    // The foreign-owner record is the least loaded: it would win on load if the owner were ignored.
    const recs = [wlRec(`${WL}-0`, WL, 'container', OTHER_OWN), wlRec(`${WL}-1`, WL)];
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's-1',
      opts({ workload: WL, ownerScope: OWN }),
      deps(recs, lease),
    );
    expect(sel?.sandboxId).toBe(`${WL}-1`);
    // And with only the foreign-owner record attached: unavailable, nothing leased.
    const only = fakeLease();
    await expect(
      selectPoolSandbox(
        env(),
        '/h',
        's-2',
        opts({ workload: WL, ownerScope: OWN }),
        deps([wlRec(`${WL}-0`, WL, 'container', OTHER_OWN)], only.lease),
      ),
    ).rejects.toBeInstanceOf(WorkloadSandboxUnavailableError);
    expect(only.acquired).toEqual([]);
    expect(acquired).toEqual([`${WL}-1`]);
  });

  it('a record with the right workload and no owner label is never selected', async () => {
    const { lease } = fakeLease();
    const recs = [rec(`${WL}-0`, { 'moca.dev/workload': WL })];
    await expect(
      selectPoolSandbox(
        env(),
        '/h',
        's-1',
        opts({ workload: WL, ownerScope: OWN }),
        deps(recs, lease),
      ),
    ).rejects.toBeInstanceOf(WorkloadSandboxUnavailableError);
  });

  it('a workload run without an owner scope is refused, never matched on the workload alone', async () => {
    const { lease, acquired } = fakeLease();
    await expect(
      selectPoolSandbox(
        env(),
        '/h',
        's-1',
        opts({ workload: WL }),
        deps([wlRec(`${WL}-0`, WL)], lease),
      ),
    ).rejects.toBeInstanceOf(WorkloadSandboxMisconfiguredError);
    expect(acquired).toEqual([]);
  });
});
