import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  selectPoolSandbox,
  SandboxAffinityPendingError,
  SandboxPoolEmptyError,
  SandboxPoolSaturatedError,
  resetTierWarnings,
  type SelectDeps,
} from '../src/select-sandbox.js';
import type { LeaseStore } from '../src/sandbox-lease.js';
import type { SandboxRecord } from '../src/pool-records.js';
import type { AffinityEntry, AffinityStore } from '../src/sandbox-affinity.js';

export const rec = (id: string, tier?: string): SandboxRecord => ({
  sandboxId: id,
  labels: tier === undefined ? {} : { 'moca.dev/tier': tier },
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc',
});

export function fakeLease(loads: Record<string, number> = {}) {
  const counts = { ...loads };
  const acquired: string[] = [];
  const released: string[] = [];
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
      released.push(p);
    },
  };
  return { lease, acquired, released, counts };
}

export function fakeAffinity(
  init: Record<string, AffinityEntry> = {},
  marks: Record<string, number> = {},
) {
  const entries = new Map(Object.entries(init));
  const detached = new Map(Object.entries(marks));
  const calls: string[] = [];
  const store: AffinityStore = {
    get: async (s) => {
      calls.push(`get:${s}`);
      return entries.get(s) ?? null;
    },
    claim: async (s, e) => {
      calls.push(`claim:${s}:${e.sandboxId}`);
      const cur = entries.get(s);
      if (cur) return cur;
      entries.set(s, e);
      return e;
    },
    replace: async (s, e) => {
      calls.push(`replace:${s}:${e.sandboxId}`);
      entries.set(s, e);
    },
    detachedSince: async (id, now) => {
      calls.push(`detachedSince:${id}`);
      // Mirrors DETACHED_SINCE_LUA: only a finite mark at or before now stands.
      const m = detached.get(id);
      if (m !== undefined && Number.isFinite(m) && m <= now) return m;
      detached.set(id, now);
      return now;
    },
  };
  return { store, entries, detached, calls };
}

const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
};

export const env = (extra: Record<string, string> = {}) =>
  ({
    KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
    SH_SANDBOX_DISCOVERY: 'records',
    ...extra,
  }) as NodeJS.ProcessEnv;
export const TIERS = {
  SH_SANDBOX_TIERS: 'container,microvm',
  SH_SANDBOX_DEFAULT_TIER: 'container',
};
export const opts = (o: Record<string, unknown> = {}) => ({
  cap: 2,
  ttlMs: 60_000,
  remoteSandbox: true,
  ...o,
});

/** Every test builds deps here, so Task 5 adds its affinity fake in ONE place. */
export function deps(
  recs: SandboxRecord[],
  lease: LeaseStore,
  extra: Partial<SelectDeps> = {},
): SelectDeps {
  return {
    records: { put: async () => {}, remove: async () => {}, list: async () => recs },
    lease,
    makeExecClient: () => ({}) as never,
    makeTransport: () => fakeTransport,
    affinity: fakeAffinity().store,
    ...extra,
  };
}

describe('selectPoolSandbox: tier filter (P6.3 spec §4 step 1)', () => {
  // The unlabelled-record warning is once per id per PROCESS; forget it so no test depends on order.
  beforeEach(() => resetTierWarnings());

  it('no tiers declared: nothing is filtered, an unlabelled record is selected', async () => {
    const { lease } = fakeLease();
    const sel = await selectPoolSandbox(env(), '/h', 's-1', opts(), deps([rec('a')], lease));
    expect(sel?.sandboxId).toBe('a');
    expect(sel?.tier).toBe('');
  });

  it('tiers declared: only the session tier is a candidate, however loaded the others are', async () => {
    const { lease } = fakeLease({ 'c-1': 1 }); // the container sandbox is the more loaded one
    const recs = [rec('c-1', 'container'), rec('m-1', 'microvm')];
    for (const tier of ['container', 'microvm'] as const) {
      const sel = await selectPoolSandbox(
        env(TIERS),
        '/h',
        `s-${tier}`,
        opts({ tier }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe(tier === 'container' ? 'c-1' : 'm-1');
      expect(sel?.tier).toBe(tier);
    }
  });

  it('an undefined or empty requested tier is the deployment default (Review Focus 2)', async () => {
    const recs = [rec('c-1', 'container'), rec('m-1', 'microvm')];
    for (const tier of [undefined, '']) {
      const { lease } = fakeLease({ 'c-1': 1 });
      const sel = await selectPoolSandbox(
        env(TIERS),
        '/h',
        's-x',
        opts({ tier }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe('c-1');
      expect(sel?.tier).toBe('container');
    }
  });

  it('an unlabelled record is excluded while tiers are declared, with ONE log line per id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recs = [rec('bare-1'), rec('c-1', 'container')];
    for (let i = 0; i < 3; i++) {
      const { lease } = fakeLease();
      const sel = await selectPoolSandbox(env(TIERS), '/h', `s-${i}`, opts(), deps(recs, lease));
      expect(sel?.sandboxId).toBe('c-1');
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("'bare-1'"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain('moca.dev/tier');
    warn.mockRestore();
  });

  // Final review item 2: spec §5 promises the log for a MISLABELLED worker too.
  it('a record labelled with an undeclared tier is excluded, with ONE log line naming it and the label', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recs = [rec('typo-1', 'microvn'), rec('m-1', 'microvm')];
    for (let i = 0; i < 3; i++) {
      const { lease } = fakeLease();
      const sel = await selectPoolSandbox(
        env(TIERS),
        '/h',
        `s-${i}`,
        opts({ tier: 'microvm' }),
        deps(recs, lease),
      );
      expect(sel?.sandboxId).toBe('m-1');
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("'typo-1'"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain('microvn');
    warn.mockRestore();
  });

  it('a tier with no attached sandbox is SandboxPoolEmptyError naming the tier', async () => {
    const { lease } = fakeLease();
    const p = selectPoolSandbox(
      env(TIERS),
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('c-1', 'container')], lease),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    await expect(p).rejects.toThrow("sandbox tier 'microvm'");
    // Neither inventory wording is true of a tier: pods are not its candidates, and other-tier
    // records may be attached.
    await expect(p).rejects.not.toThrow('pool selector');
  });

  it('a bad SH_SANDBOX_TIERS fails the selection naming the variable', async () => {
    const { lease } = fakeLease();
    const p = selectPoolSandbox(
      env({ SH_SANDBOX_TIERS: 'a,b' }),
      '/h',
      's',
      opts(),
      deps([rec('a', 'a')], lease),
    );
    await expect(p).rejects.toThrow('SH_SANDBOX_DEFAULT_TIER is required');
  });
});

describe('SandboxAffinityPendingError', () => {
  it('is a SandboxPoolSaturatedError, so every leaf path classifies it saturated (retryable)', () => {
    const e = new SandboxAffinityPendingError('m-0', 12_300);
    expect(e).toBeInstanceOf(SandboxPoolSaturatedError);
    expect(e.name).toBe('SandboxAffinityPendingError');
    expect(e.sandboxId).toBe('m-0');
    expect(e.retryInMs).toBe(12_300);
    expect(e.message).toContain("'m-0'");
    expect(e.message).toContain('13s');
  });
});

describe('selectPoolSandbox: affinity (P6.3 spec §4 steps 2–6, §5)', () => {
  const NOW = 1_000_000;
  const at = { now: () => NOW };
  const tiered = env(TIERS);
  const m = (id: string) => rec(id, 'microvm');

  // A pending or moved selection logs by design; keep the output pristine. The tests that ASSERT a
  // warning install their own spy on top of this one.
  let quiet: MockInstance;
  beforeEach(() => {
    quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => quiet.mockRestore());

  it('a first turn takes the least-loaded sandbox and claims it', async () => {
    const { lease } = fakeLease({ 'm-0': 1 });
    const aff = fakeAffinity();
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-1');
    expect(aff.entries.get('s')).toEqual({ sandboxId: 'm-1', tier: 'microvm' });
    expect(sel?.workspaceReset).toBeUndefined();
  });

  it('a later turn returns to the affine sandbox even when another is idler', async () => {
    const { lease } = fakeLease({ 'm-0': 1 });
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-0');
  });

  it('an affine sandbox at the cap is a 503 naming it, and no other sandbox is tried', async () => {
    const { lease, acquired } = fakeLease({ 'm-0': 2 });
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxPoolSaturatedError);
    await expect(p).rejects.not.toBeInstanceOf(SandboxAffinityPendingError);
    await expect(p).rejects.toThrow("'m-0'");
    expect(acquired).toEqual([]);
  });

  it('an absent affine sandbox with no mark starts the grace clock and is pending', async () => {
    const { lease, acquired } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    expect(aff.detached.get('m-0')).toBe(NOW);
    expect(acquired).toEqual([]);
  });

  it('within the grace: pending, with the time left', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } }, { 'm-0': NOW - 30_000 });
    const err = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1')], lease, { affinity: aff.store, ...at }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxAffinityPendingError);
    expect((err as SandboxAffinityPendingError).retryInMs).toBe(30_000);
  });

  it('past the grace: falls back within the tier, replaces the entry, and reports the reset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } }, { 'm-0': NOW - 61_000 });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1'), rec('c-0', 'container')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-1');
    expect(sel?.workspaceReset).toEqual({ from: 'm-0', reason: 'detached' });
    expect(aff.entries.get('s')).toEqual({ sandboxId: 'm-1', tier: 'microvm' });
    expect(aff.calls).toContain('replace:s:m-1');
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("'m-0'") && String(c[0]).includes("'m-1'")),
    ).toBe(true);
    warn.mockRestore();
  });

  it('a zero grace falls back as soon as the sandbox is gone', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    const sel = await selectPoolSandbox(
      env({ ...TIERS, SH_SANDBOX_AFFINITY_GRACE_SECONDS: '0' }),
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.workspaceReset?.reason).toBe('detached');
  });

  // Review Focus 4; final review item 3: the store replaces a future mark with now.
  it('a detach mark in the future (clock skew) is treated as just detached: pending', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } }, { 'm-0': NOW + 10_000 });
    const err = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1')], lease, { affinity: aff.store, ...at }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxAffinityPendingError);
    // The skew is not time the client should be told to wait: the reported wait is the grace.
    expect((err as SandboxAffinityPendingError).retryInMs).toBe(60_000);
    // And the grace runs from now, not from the skewed mark.
    expect(aff.detached.get('m-0')).toBe(NOW);
  });

  // Review Focus 3.
  it('an affine sandbox now advertising ANOTHER tier falls back at once, reason retiered', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'x-0', tier: 'microvm' } });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('x-0', 'container'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-1');
    expect(sel?.workspaceReset).toEqual({ from: 'x-0', reason: 'retiered' });
    expect(aff.calls.some((c) => c.startsWith('detachedSince'))).toBe(false);
  });

  // Final review item 1: an entry recorded under another tier is honoured, never dropped silently.
  // Every entry PR 1 writes has tier '' (tiers unset); switching tiers on must not cost those
  // sessions their workspace.
  it('an entry recorded under another tier, whose sandbox IS in the session tier, is honoured and re-recorded', async () => {
    const { lease } = fakeLease({ 'c-0': 1 }); // c-1 is the idler
    const aff = fakeAffinity({ s: { sandboxId: 'c-0', tier: '' } });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'container' }),
      deps([rec('c-0', 'container'), rec('c-1', 'container')], lease, {
        affinity: aff.store,
        ...at,
      }),
    );
    expect(sel?.sandboxId).toBe('c-0');
    expect(sel?.workspaceReset).toBeUndefined();
    expect(aff.entries.get('s')).toEqual({ sandboxId: 'c-0', tier: 'container' });
    // A replace, not a claim: a claim would keep the old '' entry in force.
    expect(aff.calls).toContain('replace:s:c-0');
    expect(aff.calls.some((c) => c.startsWith('claim'))).toBe(false);
  });

  it('an entry recorded under another tier, whose sandbox is in another DECLARED tier, is retiered', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'c-0', tier: 'container' } });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('c-0', 'container'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-1');
    expect(sel?.workspaceReset).toEqual({ from: 'c-0', reason: 'retiered' });
    expect(aff.calls.some((c) => c.startsWith('detachedSince'))).toBe(false);
    expect(aff.entries.get('s')).toEqual({ sandboxId: 'm-1', tier: 'microvm' });
  });

  it('an entry recorded under another tier, whose sandbox is absent, takes the grace path', async () => {
    const { lease, acquired } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-gone', tier: '' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    expect(aff.detached.get('m-gone')).toBe(NOW);
    expect(acquired).toEqual([]);
  });

  it('a first turn that loses the claim race releases its lease and joins the winner', async () => {
    const { lease, released } = fakeLease({ 'm-1': 1 });
    const aff = fakeAffinity();
    // Another turn of the same session claims m-1 between our get and our claim.
    const realClaim = aff.store.claim;
    aff.store.claim = async (s, e, ttl) => {
      if (!aff.entries.has(s)) aff.entries.set(s, { sandboxId: 'm-1', tier: 'microvm' });
      return realClaim(s, e, ttl);
    };
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(released).toEqual(['m-0']);
    expect(sel?.sandboxId).toBe('m-1');
  });

  it('losing the race twice is pending, never a third attempt', async () => {
    const { lease, released } = fakeLease();
    const aff = fakeAffinity();
    let claims = 0;
    aff.store.get = async () => null; // the winner's entry never becomes visible
    aff.store.claim = async () => {
      claims++;
      return { sandboxId: 'm-9', tier: 'microvm' };
    };
    await expect(
      selectPoolSandbox(
        tiered,
        '/h',
        's',
        opts({ tier: 'microvm' }),
        deps([m('m-0')], lease, { affinity: aff.store, ...at }),
      ),
    ).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    // Each losing pass gave its lease back, and there were exactly two passes.
    expect(released).toEqual(['m-0', 'm-0']);
    expect(claims).toBe(2);
  });

  it('a failed affinity READ fails the turn, and takes no lease (§5)', async () => {
    const { lease, acquired } = fakeLease();
    const aff = fakeAffinity();
    aff.store.get = async () => {
      throw new Error('redis down');
    };
    await expect(
      selectPoolSandbox(
        tiered,
        '/h',
        's',
        opts({ tier: 'microvm' }),
        deps([m('m-0')], lease, { affinity: aff.store, ...at }),
      ),
    ).rejects.toThrow('redis down');
    expect(acquired).toEqual([]);
  });

  it('a failed detach READ fails the turn too', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    aff.store.detachedSince = async () => {
      throw new Error('redis down');
    };
    await expect(
      selectPoolSandbox(
        tiered,
        '/h',
        's',
        opts({ tier: 'microvm' }),
        deps([m('m-1')], lease, { affinity: aff.store, ...at }),
      ),
    ).rejects.toThrow('redis down');
  });

  it('a failed affinity WRITE after the lease still returns the sandbox, with a warning (§5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lease, released } = fakeLease();
    const aff = fakeAffinity();
    aff.store.claim = async () => {
      throw new Error('redis down');
    };
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([m('m-0')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-0');
    expect(released).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('could not record'))).toBe(true);
    warn.mockRestore();
  });

  it('no tiers declared: affinity still holds a session on its sandbox (the container hop fix)', async () => {
    const { lease } = fakeLease({ 'c-0': 1 });
    const aff = fakeAffinity({ s: { sandboxId: 'c-0', tier: '' } });
    const sel = await selectPoolSandbox(
      env(),
      '/h',
      's',
      opts(),
      deps([rec('c-0'), rec('c-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('c-0');
  });

  // Fix round 1: an UNLABELLED record is not "another tier" (spec §4 step 4).
  it('a present but UNLABELLED affine record takes the grace path, not retiered', async () => {
    const { lease, acquired } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'x-0', tier: 'microvm' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('x-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    expect(aff.calls).toContain('detachedSince:x-0');
    expect(aff.detached.get('x-0')).toBe(NOW);
    expect(acquired).toEqual([]);
  });

  // Final review item 2: a label that is not a DECLARED tier is a typo, not a re-tiering.
  it('a present affine record labelled with an UNDECLARED tier takes the grace path, not retiered', async () => {
    const { lease, acquired } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'x-0', tier: 'microvm' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('x-0', 'microvn'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    expect(aff.calls).toContain('detachedSince:x-0');
    expect(acquired).toEqual([]);
  });

  it('a present but UNLABELLED affine record past the grace falls back, reason detached', async () => {
    const { lease } = fakeLease();
    const aff = fakeAffinity({ s: { sandboxId: 'x-0', tier: 'microvm' } }, { 'x-0': NOW - 61_000 });
    const sel = await selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('x-0'), m('m-1')], lease, { affinity: aff.store, ...at }),
    );
    expect(sel?.sandboxId).toBe('m-1');
    expect(sel?.workspaceReset).toEqual({ from: 'x-0', reason: 'detached' });
    expect(aff.calls).toContain('detachedSince:x-0');
  });

  // Fix round 1: spec §5, "Relay restart" -- the tier has no records at all for a moment.
  it('no records in the tier, with affinity and no mark: pending (not empty), and the mark is written', async () => {
    const { lease, acquired } = fakeLease();
    const load = vi.spyOn(lease, 'load');
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([rec('c-0', 'container')], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxAffinityPendingError);
    expect(aff.detached.get('m-0')).toBe(NOW);
    expect(load).not.toHaveBeenCalled();
    expect(acquired).toEqual([]);
  });

  it('no records in the tier and no affinity entry: SandboxPoolEmptyError naming the tier', async () => {
    const { lease, acquired } = fakeLease();
    const load = vi.spyOn(lease, 'load');
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([], lease, { affinity: fakeAffinity().store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    await expect(p).rejects.toThrow("sandbox tier 'microvm'");
    expect(load).not.toHaveBeenCalled();
    expect(acquired).toEqual([]);
  });

  it('no records in the tier, with affinity past the grace: SandboxPoolEmptyError, not saturated', async () => {
    const { lease, acquired } = fakeLease();
    const load = vi.spyOn(lease, 'load');
    const aff = fakeAffinity({ s: { sandboxId: 'm-0', tier: 'microvm' } }, { 'm-0': NOW - 61_000 });
    const p = selectPoolSandbox(
      tiered,
      '/h',
      's',
      opts({ tier: 'microvm' }),
      deps([], lease, { affinity: aff.store, ...at }),
    );
    await expect(p).rejects.toBeInstanceOf(SandboxPoolEmptyError);
    await expect(p).rejects.not.toBeInstanceOf(SandboxPoolSaturatedError);
    await expect(p).rejects.toThrow("sandbox tier 'microvm'");
    expect(load).not.toHaveBeenCalled();
    expect(acquired).toEqual([]);
  });

  it('never touches affinity when the selection fails before it (remote off, or a removed discovery mode)', async () => {
    // ADR-0041: a selector without the remote flag, or a stale pods/both discovery mode, is
    // refused before any store is consulted — affinity included.
    const explode = new Proxy(
      {},
      { get: () => () => Promise.reject(new Error('affinity touched')) },
    );
    for (const [e, o] of [
      [env(), opts({ remoteSandbox: false })],
      [env({ SH_SANDBOX_DISCOVERY: 'pods' }), opts()],
    ] as const) {
      const { lease } = fakeLease();
      await expect(
        selectPoolSandbox(e, '/h', 's', o, deps([], lease, { affinity: explode as never })),
      ).rejects.toThrow();
    }
  });

  // CodeQL js/log-injection: a session id / sandbox id containing "\n" must not inject newlines into the log.
  it('strips control characters from session/sandbox ids in pending warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { lease } = fakeLease();
      const sessionIdWithNewline = 's\nmalicious';
      const aff = fakeAffinity(
        { [sessionIdWithNewline]: { sandboxId: 'm-0', tier: 'microvm' } },
        { 'm-0': NOW - 1_000 }, // 1 second before now, within the grace
      );
      const err = await selectPoolSandbox(
        tiered,
        '/h',
        sessionIdWithNewline,
        opts({ tier: 'microvm' }),
        deps([m('m-1')], lease, { affinity: aff.store, ...at }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(SandboxAffinityPendingError);
      const logLine = warn.mock.calls.find((c) => String(c[0]).includes('waits for'));
      expect(logLine).toBeDefined();
      const logText = String(logLine?.[0] ?? '');
      expect(logText).not.toContain('\n');
      expect(logText).toContain('smalicious'); // newline stripped
    } finally {
      warn.mockRestore();
    }
  });
});
