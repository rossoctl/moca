import { describe, it, expect, vi } from 'vitest';

/**
 * Integration-level test for realProduceSolve: pins the ordering (converge → attach). The attach
 * cannot run first — `leafConfigDir(sid)` is a child of `leafWorkspaceRef(sid)`, and the overlay's
 * `mkdir -p` on the parent would make `buildConvergeScript`'s `[ -d "$LEAF" ] || git worktree add`
 * skip the worktree entirely.
 *
 * To stay hermetic the test short-circuits inside the attach's resolver so neither Pi nor the
 * agent model needs to run. The transport-mock records every script passed to `exec`, so the
 * fact that the convergeScript landed BEFORE the resolver was invoked is directly observable.
 */

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

// Record every exec() the leaf makes against the pod — this is where the ordering proof lives.
const { kubectlTransportMock, execMock } = vi.hoisted(() => {
  const execMock = vi.fn();
  return {
    execMock,
    kubectlTransportMock: vi.fn((..._args: unknown[]) => ({
      exec: execMock,
      close: vi.fn(async () => {}),
    })),
  };
});
vi.mock('@moca/k8s-sandbox', () => ({
  k8sSandboxExtension: () => () => {},
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

// Keep RedisSessionBackend construction cheap and side-effect free; the body of realProduceSolve
// won't reach any read/write path once attachPromotedConfig throws.
vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: class {
    async read() {
      return [];
    }
  },
}));
vi.mock('../src/buffered-redis-backend.js', () => ({
  BufferedRedisBackend: class {
    constructor(_s: unknown) {}
    async append() {}
    async flush() {}
  },
}));
// Stop the SessionManager/agent factories from reaching real Pi code. `createAgentSession` is a
// vi.fn so individual tests can override it — the opt-in-branch test (below) uses that to halt
// the leaf after the configRef check instead of before convergeWorkspace returns.
const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(async () => ({ session: { prompt: async () => {} } })),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    create: () => ({}),
    openFromCheckpoint: async () => ({}),
  },
  DefaultResourceLoader: class {
    async reload() {}
  },
  createAgentSession: (...args: unknown[]) => createAgentSessionMock(...(args as [])),
}));

import { realProduceSolve, type LeafEnvelope, type SolveCapture } from '../src/run-leaf.js';
import { buildConvergeScript } from '../src/converge.js';

const digest = 'sha256:' + 'e'.repeat(64);

const solveEnv = (): LeafEnvelope =>
  ({
    sessionId: 'run-1/solve',
    kind: 'solve',
    problemStatement: 'make the failing test pass',
    repoUrl: 'https://example.test/repo.git',
    ref: 'main',
    configRef: digest,
  }) as LeafEnvelope;

const FAKE_CONFIG = { podName: 'sbx-0', namespace: 'team1' } as never;
const podLease = () => ({
  config: FAKE_CONFIG,
  heartbeat: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
});

describe('realProduceSolve ordering (converge before attach)', () => {
  it('runs convergeWorkspace before invoking the promoted-config resolver', async () => {
    // Record exec() script arguments and respond with a leaf path for the convergeScript. We
    // make the resolver throw AFTER convergeWorkspace has returned, so the test asserts
    // (a) the convergeScript was executed, and (b) attachPromotedConfig ran after it.
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const expectedConverge = buildConvergeScript(
      'https://example.test/repo.git',
      'main',
      'run-1-solve',
    );
    execMock.mockReset().mockImplementation(async (script: string) => {
      // convergeWorkspace returns stdout as the leaf path; everything else (cleanup) gets empty.
      if (script === expectedConverge)
        return {
          stdout: Buffer.from('/workspace/leaves/run-1-solve'),
          exitCode: 0,
          truncated: false,
        };
      return { stdout: Buffer.from(''), exitCode: 0, truncated: false };
    });

    // Any truthy value satisfies the overlay dep check; the resolver below is where we assert.
    const bundleRedis = {} as never;
    const resolvePromotedConfig = vi.fn(async () => {
      // By the time this fires, convergeWorkspace must have already executed its script — the
      // ordering invariant this test exists to pin.
      const scriptsSoFar = execMock.mock.calls.map((c) => c[0] as string);
      expect(scriptsSoFar).toContain(expectedConverge);
      throw new Error('resolver halts the test here, after the ordering check');
    });

    const capture: SolveCapture = {};
    const err = await realProduceSolve(solveEnv(), undefined, capture, {
      resolvePromotedConfig,
      overlayConfig: vi.fn(),
      bundleRedis,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/resolver halts/);
    // Resolver fired exactly once — ruling out a retry path that could have run attach first.
    expect(resolvePromotedConfig).toHaveBeenCalledTimes(1);
    // The convergeScript appeared in the recorded exec sequence BEFORE the resolver threw.
    const scripts = execMock.mock.calls.map((c) => c[0] as string);
    expect(scripts[0]).toBe(expectedConverge);
    // No patch should have been captured — the leaf aborted before buildDiffCaptureScript.
    expect(capture.patch).toBeUndefined();
  });

  it('does not call the resolver at all when configRef is absent (regression guard for the opt-in path)', async () => {
    // Pairs with the dispatcher-level test suite: realProduceSolve without configRef must leave
    // the resolver untouched, so an existing solve caller sees no change in behaviour.
    //
    // Convergescript MUST succeed so the leaf reaches the configRef check — otherwise the
    // resolver is never called whether or not the opt-in guard is in place, and the test can't
    // actually fail. Halt later from createAgentSession, which runs after converge AND after the
    // configRef branch.
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const expectedConverge = buildConvergeScript(
      'https://example.test/repo.git',
      'main',
      'run-1-solve',
    );
    execMock.mockReset().mockImplementation(async (script: string) => {
      if (script === expectedConverge)
        return {
          stdout: Buffer.from('/workspace/leaves/run-1-solve'),
          exitCode: 0,
          truncated: false,
        };
      return { stdout: Buffer.from(''), exitCode: 0, truncated: false };
    });
    createAgentSessionMock.mockReset().mockImplementationOnce(async () => {
      throw new Error('halt after configRef branch');
    });
    const resolvePromotedConfig = vi.fn();
    const envNoConfig = { ...solveEnv(), configRef: undefined };
    const capture: SolveCapture = {};
    await realProduceSolve(envNoConfig, undefined, capture, {
      resolvePromotedConfig,
      overlayConfig: vi.fn(),
      bundleRedis: {} as never,
    }).catch(() => {});
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
    // Convergescript did execute (otherwise we never reached the configRef branch) — sanity.
    const scripts = execMock.mock.calls.map((c) => c[0] as string);
    expect(scripts).toContain(expectedConverge);
  });
});
