import { describe, it, expect, vi } from 'vitest';

// `runSolveLeaf` → `realProduceSolve` leases a sandbox via selectPoolSandbox. Mock it the same
// way run-leaf.test.ts and run-leaf-promoted.test.ts do, so the attach/detach lifecycle can be
// exercised without a real cluster. The companion sandbox-env mock keeps the lease path hermetic.
const { selectPoolSandboxMock, FakeSandboxPoolSaturatedError } = vi.hoisted(() => {
  class FakeSandboxPoolSaturatedError extends Error {
    constructor(selector: string) {
      super(`sandbox pool '${selector}' saturated: all pods at capacity`);
      this.name = 'SandboxPoolSaturatedError';
    }
  }
  return { selectPoolSandboxMock: vi.fn(), FakeSandboxPoolSaturatedError };
});
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
    SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
  };
});

const { kubectlTransportMock } = vi.hoisted(() => ({
  kubectlTransportMock: vi.fn((..._args: unknown[]) => ({
    exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('@moca/k8s-sandbox', () => ({
  k8sSandboxExtension: () => () => {},
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

import {
  runSolveLeaf,
  type LeafEnvelope,
  type ProduceSolve,
  type ProduceSolveDeps,
} from '../src/run-leaf.js';

const digest = 'sha256:' + 'd'.repeat(64);

const solveEnv = (extra: Partial<LeafEnvelope> = {}): LeafEnvelope =>
  ({
    sessionId: 'run-1/solve',
    kind: 'solve',
    problemStatement: 'make the failing test pass',
    repoUrl: 'https://example.test/repo.git',
    ref: 'main',
    ...extra,
  }) as LeafEnvelope;

// A `ProduceSolve` fake that records what was handed to it and returns a staged patch, so each
// case can assert on the exact deps the dispatcher threaded through to produce.
type ProduceCall = {
  env: LeafEnvelope;
  deps: ProduceSolveDeps | undefined;
};
const recordingProduce = () => {
  const calls: ProduceCall[] = [];
  const produce: ProduceSolve = async (env, _config, capture, deps) => {
    calls.push({ env, deps });
    capture.patch = 'diff --git a b\n';
  };
  return { produce, calls };
};

describe('configRef on a solve leaf', () => {
  it('fails up-front with configRef empty, without leasing a sandbox or calling produce', async () => {
    // Regression guard parallel to run-leaf-promoted.test.ts's empty-configRef case: a
    // dispatcher-level reject keeps empty strings from reaching the resolver, so this must fire
    // BEFORE the pool lease (which costs real time and capacity in production).
    selectPoolSandboxMock.mockReset();
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(solveEnv({ configRef: '' }), undefined, { produceSolve: produce });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.reason).toBe('error');
      expect(r.message).toContain('configRef');
    }
    expect(selectPoolSandboxMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects a whitespace-only configRef the same way (no partial trimming)', async () => {
    // trim() reduces '  ' to '', so this routes through the same guard; the test pins that
    // behavior at the dispatcher level and keeps whitespace-only out of attachPromotedConfig,
    // which has its own stricter digest validation downstream.
    selectPoolSandboxMock.mockReset();
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(solveEnv({ configRef: '   ' }), undefined, {
      produceSolve: produce,
    });
    expect(r.status).toBe('failed');
    expect(selectPoolSandboxMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('treats null configRef as absent — no promoted-config deps are forwarded to produce', async () => {
    // Matches the leaf-boundary pin on the prompt path (run-leaf.ts:411): `null` is present but
    // means "no value" to producers that emit it. If this flipped to "treat as a digest" the
    // produce fake below would see non-empty deps or a thrown resolver error.
    selectPoolSandboxMock.mockReset();
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(solveEnv({ configRef: null as unknown as string }), undefined, {
      produceSolve: produce,
    });
    expect(r.status).toBe('solved');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.configRef).toBeNull();
  });

  it('still rejects bad_inputs when problemStatement/repoUrl/ref are missing — before the configRef guard', async () => {
    // Pin the ordering: the inputs check runs first, so a request that is BOTH ill-formed AND
    // sends an empty configRef fails as bad_inputs (not as the configRef error). Without this
    // ordering an operator debugging a shell-template issue would see the wrong message.
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(
      { sessionId: 'run-1/solve', kind: 'solve', configRef: '' } as unknown as LeafEnvelope,
      undefined,
      { produceSolve: produce },
    );
    expect(r).toEqual({ status: 'failed', reason: 'bad_inputs' });
    expect(calls).toHaveLength(0);
  });

  it('forwards promoted-config injection deps to produce when any are set', async () => {
    // Verifies the thread-through: when the caller injects resolvePromotedConfig / overlayConfig
    // / bundleRedis on runSolveLeaf, those SAME functions reach produce — which is how
    // run-leaf-promoted-style tests of the real attach lifecycle will reach the resolver.
    selectPoolSandboxMock.mockReset();
    const resolvePromotedConfig = vi.fn();
    const overlayConfig = vi.fn();
    const bundleRedis = { peek: vi.fn() } as never;
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(solveEnv({ configRef: digest }), undefined, {
      produceSolve: produce,
      resolvePromotedConfig,
      overlayConfig,
      bundleRedis,
    });
    expect(r.status).toBe('solved');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.deps).toEqual({ resolvePromotedConfig, overlayConfig, bundleRedis });
  });

  it('omits produceDeps entirely when no promoted-config deps are set, so existing fakes stay 3-arg', async () => {
    // Existing ProduceSolve fakes (callers in run-leaf.test.ts) read only (env, config, capture).
    // Forwarding `undefined` for the fourth arg must not become a plain object with undefined
    // fields: a strict equality check on `deps === undefined` is cheaper than N `deps?.x`
    // reads inside produce, and the dispatcher is the one place to keep that invariant.
    selectPoolSandboxMock.mockReset();
    const { produce, calls } = recordingProduce();
    const r = await runSolveLeaf(solveEnv(), undefined, { produceSolve: produce });
    expect(r.status).toBe('solved');
    expect(calls[0]!.deps).toBeUndefined();
  });

  it('surfaces a produce-time attach failure as failed:error (not saturated, not solved)', async () => {
    // The real attach lives inside realProduceSolve; a fake produce throwing is the test seam
    // for "attachPromotedConfig rejected" (e.g. bundle_not_found, overlay failure). Must
    // route through the catch at the dispatcher as `error`, not swallow into `solved` with an
    // empty patch — fail-closed is the whole point of attaching before the worktree.
    selectPoolSandboxMock.mockReset();
    const produce: ProduceSolve = async () => {
      throw new Error('config_bundle_not_found: sha256:aa');
    };
    const r = await runSolveLeaf(solveEnv({ configRef: digest }), undefined, {
      produceSolve: produce,
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.reason).toBe('error');
      expect(r.message).toContain('config_bundle_not_found');
    }
  });
});
