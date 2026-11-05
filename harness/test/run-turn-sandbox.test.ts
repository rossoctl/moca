import { describe, it, expect, vi } from 'vitest';
import { acquireTurnSandbox } from '../src/run-turn.js';
import type { LeaseStore } from '../src/sandbox-lease.js';

// executeTurn resolved its sandbox from process.env unconditionally (ADR 0028: prompt leaves
// "inherit /turn's sandbox routing"), which left a leased pool sandbox — and the whole remote
// relay transport — unreachable from a prompt leaf. That was fixed for leaves by injection.
//
// It was NOT fixed for /turn, which is what acquireTurnSandbox now closes: /turn used to call
// resolveSandboxConfig alone, so a deployment configuring a POOL had its turn's tool calls run in
// the harness process. Proven on hardware — the tool's file landed in the supervisor unit's own
// PrivateTmp namespace, never in a sandbox container.
//
// Since ADR-0041 removed the pod-exec path, every pool selection leases a relay transport, and
// the no-pool path resolves to null (tools run local) rather than to a single pod.

/** Records every call, so a test can assert on the lease store rather than on a spy's count. */
function fakeLeaseStore(): LeaseStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async () => {
      calls.push('load');
      return 0;
    },
    acquire: async (pod, _cap, runId) => {
      calls.push(`acquire:${pod}:${runId}`);
      return true;
    },
    heartbeat: async (pod, runId) => {
      calls.push(`heartbeat:${pod}:${runId}`);
    },
    release: async (pod, runId) => {
      calls.push(`release:${pod}:${runId}`);
    },
  };
}

const fakeTransport = () => ({
  exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
});

/** One relay presence record the pool can lease. */
const record = (sandboxId: string, labels: Record<string, string> = {}) => ({
  sandboxId,
  labels,
  capabilities: [],
  capacityMax: 4,
  transport: 'grpc' as const,
});

/** The deps a records-only pool needs to lease without a live relay. */
const poolDeps = (lease: LeaseStore, recs = [record('sandbox-a')]) => ({
  lease,
  records: { put: async () => {}, remove: async () => {}, list: async () => recs },
  affinity: {
    get: async () => null,
    claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
    replace: async () => {},
    detachedSince: async (_id: string, now: number) => now,
  },
  makeExecClient: () => ({}) as never,
  makeTransport: () => fakeTransport(),
});

describe('acquireTurnSandbox', () => {
  it('returns the injected sandbox verbatim, including its transport, and never leases', async () => {
    const transport = fakeTransport();
    const injected = {
      transport,
      podCwd: '/workspace',
      sandboxId: 'sbx-laptop',
    };

    const got = await acquireTurnSandbox(injected, {}, '/head', 'run-1');

    expect(got.sandbox).toEqual(injected);
    expect(got.sandbox?.transport).toBe(transport);
    // The injecting caller owns the lease. Renewing or returning it from here would let one turn
    // release the sandbox another turn is still executing in.
    expect(got.leased).toBe(false);
  });

  it('ignores env resolution entirely when a sandbox is injected', async () => {
    // A leased remote sandbox must win over a stale KAGENTI_SANDBOX_POD: honouring the env
    // here would silently route a remote prompt leaf back to an in-cluster pod.
    const injected = {
      transport: fakeTransport(),
      podCwd: '/workspace',
      sandboxId: 'sbx-leased',
    };

    const got = await acquireTurnSandbox(
      injected,
      { KAGENTI_SANDBOX_POD: 'sandbox-0' },
      '/head',
      'run-1',
    );

    expect(got.sandbox?.sandboxId).toBe('sbx-leased');
  });

  it('throws naming KAGENTI_SANDBOX_POD when the removed single-pod env is all that is set', async () => {
    // ADR-0041: there is no single-pod path to fall back to, and quietly running tools in the
    // harness process is MI1 §5 R3's hazard.
    await expect(
      acquireTurnSandbox(undefined, { KAGENTI_SANDBOX_POD: 'sandbox-0' }, '/head', 'run-1'),
    ).rejects.toThrow(/KAGENTI_SANDBOX_POD was removed/);
  });

  it('resolves to a null sandbox when neither injected nor configured (tools run local)', async () => {
    const got = await acquireTurnSandbox(undefined, {}, '/head', 'run-1');

    expect(got.sandbox).toBeNull();
    expect(got.leased).toBe(false);
  });

  it('leases from the pool when a selector is configured — the /turn behaviour this fixes', async () => {
    const lease = fakeLeaseStore();

    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox', SH_REMOTE_SANDBOX: '1' },
      '/head',
      'sess-42',
      poolDeps(lease),
    );

    expect(got.sandbox?.sandboxId).toBe('sandbox-a');
    expect(got.leased).toBe(true);
    // The member is the per-turn HOLDER, derived here from the session id -- not the session id
    // itself, which would make N concurrent turns of one session share one lease slot
    // (turn-lease-holder.test.ts covers why). Prefixed by it for greppability.
    const acquire = lease.calls.find((c) => c.startsWith('acquire:'));
    expect(acquire).toMatch(/^acquire:sandbox-a:sess-42:[0-9a-f-]{36}$/);
    expect(lease.calls).not.toContain('acquire:sandbox-a:sess-42');
  });

  it('drives the real lease store on heartbeat and release', async () => {
    const lease = fakeLeaseStore();

    const got = await acquireTurnSandbox(
      undefined,
      { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox', SH_REMOTE_SANDBOX: '1' },
      '/head',
      'sess-42',
      poolDeps(lease),
    );
    await got.heartbeat();
    await got.release();

    // Asserted against the store's own recorded calls: a fake that merely agreed with a spy count
    // would pass even if heartbeat/release were wired to the wrong pod or holder. Renewal and release
    // must name the SAME member acquire took, or a turn renews nothing and releases someone else's
    // lease -- so this reads the holder off the acquire rather than hard-coding it.
    const holder = lease.calls
      .find((c) => c.startsWith('acquire:sandbox-a:'))!
      .slice('acquire:sandbox-a:'.length);
    expect(holder).toMatch(/^sess-42:[0-9a-f-]{36}$/);
    expect(lease.calls).toContain(`heartbeat:sandbox-a:${holder}`);
    expect(lease.calls).toContain(`release:sandbox-a:${holder}`);
  });

  it('treats an empty-string selector as no pool, and a stale pod env still throws', async () => {
    // selectPoolSandbox branches on `if (!selector)`, so '' takes its no-lease path — and a
    // KAGENTI_SANDBOX_POD alongside it is still a stale deployment that must fail loudly.
    await expect(
      acquireTurnSandbox(
        undefined,
        { KAGENTI_SANDBOX_POOL_SELECTOR: '', KAGENTI_SANDBOX_POD: 'sandbox-0' },
        '/head',
        'run-1',
      ),
    ).rejects.toThrow(/KAGENTI_SANDBOX_POD was removed/);
  });

  it('throws rather than silently running local when a configured pool has no candidates', async () => {
    // The previous /turn behaviour for this case was to run tools in the harness process, which is
    // the failure spec §5.4 exists to prevent: a turn that cannot reach its configured sandbox is
    // not a turn that should quietly succeed.
    await expect(
      acquireTurnSandbox(
        undefined,
        { KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox', SH_REMOTE_SANDBOX: '1' },
        '/head',
        'r',
        poolDeps(fakeLeaseStore(), []),
      ),
    ).rejects.toThrow(/no sandbox presence records/);
  });

  it('passes the tier to the selection and reports where the turn landed (P6.3)', async () => {
    const lease = fakeLeaseStore();
    const records = {
      put: async () => {},
      remove: async () => {},
      list: async () => [
        record('c-0', { 'moca.dev/tier': 'container' }),
        record('m-0', { 'moca.dev/tier': 'microvm' }),
      ],
    };
    const affinity = {
      get: async () => ({ sandboxId: 'm-gone', tier: 'microvm' }),
      claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
      replace: async () => {},
      detachedSince: async () => 0, // long gone: past any grace
    };
    // The fallback logs one line by design; silenced here so the suite's output stays clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await acquireTurnSandbox(
        undefined,
        {
          KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sandbox',
          SH_REMOTE_SANDBOX: '1',
          SH_SANDBOX_DISCOVERY: 'records',
          SH_SANDBOX_TIERS: 'container,microvm',
          SH_SANDBOX_DEFAULT_TIER: 'container',
        },
        '/head',
        'sess-7',
        {
          lease,
          records,
          affinity,
          makeExecClient: () => ({}) as never,
          makeTransport: () => fakeTransport(),
        },
        'microvm',
      );
      expect(got.placement).toEqual({
        sandboxId: 'm-0',
        tier: 'microvm',
        workspaceReset: { from: 'm-gone', reason: 'detached' },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("moved from 'm-gone' to 'm-0'"));
    } finally {
      warn.mockRestore();
    }
  });

  it('reports no placement when nothing was leased', async () => {
    const got = await acquireTurnSandbox(undefined, {}, '/head', 'sess-8');
    expect(got.placement).toBeUndefined();
  });
});
