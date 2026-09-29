import { describe, it, expect, vi } from 'vitest';

// `runPromptLeaf` leases a sandbox via selectPoolSandbox, which reads real process.env — with no
// KAGENTI_SANDBOX_POOL_SELECTOR and no resolvable pod config it returns null, so the `if (selected)`
// overlay branch would never run and any test aiming at it would be unreachable. Mock the module the
// way harness/test/run-leaf.test.ts:11-34 already does, and mock @moca/k8s-sandbox so KubectlTransport
// is a spy rather than a real kubectl invocation.
const { selectPoolSandboxMock, FakeSandboxPoolSaturatedError } = vi.hoisted(() => {
  class FakeSandboxPoolSaturatedError extends Error {
    constructor(selector: string) {
      super(`sandbox pool '${selector}' saturated: all pods at capacity`);
      this.name = 'SandboxPoolSaturatedError';
    }
  }
  return { selectPoolSandboxMock: vi.fn(), FakeSandboxPoolSaturatedError };
});
vi.mock('../src/select-sandbox.js', () => ({
  selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
  SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
}));

// The `(..._args: unknown[])` params are load-bearing, not decoration: the vi.mock factories
// below forward their arguments with a spread, and a mock whose implementation declares no
// parameters is typed as taking none — so the forwarding call does not typecheck.
const { k8sSandboxExtensionMock, kubectlTransportMock } = vi.hoisted(() => ({
  k8sSandboxExtensionMock: vi.fn((..._args: unknown[]) => () => {}),
  kubectlTransportMock: vi.fn((..._args: unknown[]) => ({
    exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('@moca/k8s-sandbox', () => ({
  k8sSandboxExtension: (...args: unknown[]) => k8sSandboxExtensionMock(...args),
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

import { runLeaf, type LeafEnvelope, type LeafResult } from '../src/run-leaf.js';

/** The real `executeTurn` contract, so the fake below cannot drift from what runLeaf calls. */
type ExecuteTurnDep = NonNullable<NonNullable<Parameters<typeof runLeaf>[2]>['executeTurn']>;

/**
 * Assert a LeafResult's status AND narrow it to that union member.
 *
 * `expect(r.status).toBe('failed')` asserts at runtime but tells tsc nothing, so the
 * `r.reason` / `r.message` reads that followed it were themselves unchecked until
 * harness/test came under the typechecker (#190). The cast is sound because the
 * expectation above it throws first on any other status.
 */
function expectStatus<S extends LeafResult['status']>(
  r: LeafResult,
  status: S,
): Extract<LeafResult, { status: S }> {
  expect(r.status).toBe(status);
  return r as Extract<LeafResult, { status: S }>;
}

const FAKE_CONFIG = { podName: 'sbx-0', namespace: 'team1' } as never;
/** A pod-shaped lease: config present, transport ABSENT — the default deployment. */
const podLease = () => ({
  config: FAKE_CONFIG,
  heartbeat: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
});

const digest = 'sha256:' + 'c'.repeat(64);

const env = (extra: Partial<LeafEnvelope> = {}): LeafEnvelope =>
  ({
    sessionId: 'run-1/i1',
    item: { item_id: 'i1', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Summarize the repo.',
    ...extra,
  }) as LeafEnvelope;

const fakePromoted = {
  digest,
  root: '/tmp/sh-config/x',
  skillsDir: '/tmp/sh-config/x/skills',
  promptsDir: '/tmp/sh-config/x/prompts',
  context: [],
  promptFragments: [],
  entries: [{ path: 'skills/k/SKILL.md', content: Buffer.from('b') }],
};

// Typed as the real dep rather than inferred: that is what makes `.mock.calls[0][0]` the
// actual ExecuteTurnInput below, so the promotedConfig assertions are checked against the
// contract instead of against whatever shape this fake happens to have.
const okTurn = () =>
  vi.fn<ExecuteTurnDep>(async () => ({
    sessionId: 'run-1-i1',
    response: 'text',
    stopReason: 'end_turn',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  }));

describe('configRef on a prompt leaf', () => {
  it('does not resolve or overlay anything when configRef is absent', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null); // no lease: keep this case hermetic
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn();
    const overlayConfig = vi.fn();
    const r = await runLeaf(env(), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig,
    });
    expect(r.status).toBe('responded');
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
    expect(overlayConfig).not.toHaveBeenCalled();
    expect(executeTurn.mock.calls[0]![0].promotedConfig).toBeUndefined();
  });

  // REGRESSION TEST — do not delete. Issue #222 (1): a present-but-empty configRef ran BARE.
  //
  // `if (env.configRef)` made `""` indistinguishable from "no config requested": the leaf answered
  // HTTP 200 / status responded, with no bundle, no house rules and an empty workspace — exactly
  // like an unpromoted run. Observed in a demo where the dispatching shell had $DIGEST unset, so
  // `jq --arg c "$DIGEST"` sent `""`. That is the plausible-but-wrong remote failure the comment
  // above this guard says the design exists to prevent, arriving one line before the check that
  // would have caught it.
  it('fails the leaf when configRef is present but empty, instead of silently running bare', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn();
    const r = await runLeaf(env({ configRef: '' }), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig: vi.fn(),
      bundleRedis: {} as never,
    });
    const failed = expectStatus(r, 'failed');
    expect(failed.reason).toBe('error');
    expect(failed.message).toContain('configRef');
    // Never run the turn unconfigured, and never spend a resolve on an empty digest.
    expect(executeTurn).not.toHaveBeenCalled();
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
  });

  it('fails the same way on a whitespace-only configRef', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn();
    const r = await runLeaf(env({ configRef: '  ' }), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig: vi.fn(),
      bundleRedis: {} as never,
    });
    expect(r.status).toBe('failed');
    expect(executeTurn).not.toHaveBeenCalled();
    // Rejected by the guard, not incidentally by assertValidDigest deep inside the resolver: the
    // operator-facing message differs, and only the guard covers it before any Redis round-trip.
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
  });

  it('treats a null configRef as absent — the one deliberate exception to presence-not-truthiness', async () => {
    // `null` is present, so the guard above could have rejected it. It does not: JSON null reads as
    // "no value" for producers that emit it, and `""` is the failure actually observed. This is the
    // leaf half of the pin — `configRefValid` in knative-server has the boundary half — so that the
    // exception cannot be quietly reversed in one layer only.
    selectPoolSandboxMock.mockReset().mockResolvedValue(null); // no lease: keep this case hermetic
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn();
    const r = await runLeaf(env({ configRef: null as unknown as string }), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig: vi.fn(),
    });
    expect(r.status).toBe('responded');
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
    expect(executeTurn.mock.calls[0]![0].promotedConfig).toBeUndefined();
  });

  it('resolves the bundle and passes it to executeTurn when configRef is present', async () => {
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn(async () => fakePromoted);
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease()); // pod path: no grpc transport
    const overlayConfig = vi.fn(async () => ({
      skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
      memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
    }));
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig,
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    expect(resolvePromotedConfig).toHaveBeenCalledWith(expect.anything(), digest);
    // Assert on fields, NOT object identity: when a lease exists the overlay appends a prompt
    // fragment and rebuilds promotedConfig, so `.toBe(fakePromoted)` would only pass in the
    // no-lease case and would silently break the moment the overlay ran.
    expect(executeTurn.mock.calls[0]![0].promotedConfig).toMatchObject({
      digest: fakePromoted.digest,
    });
  });

  it('fails the leaf with reason error when the bundle cannot be resolved', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null); // no lease: keep this case hermetic
    const executeTurn = okTurn();
    const r = await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => {
        throw new Error('config bundle not found: ' + digest);
      }),
      overlayConfig: vi.fn(),
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    const failed = expectStatus(r, 'failed');
    expect(failed.reason).toBe('error');
    expect(failed.message).toContain(digest);
    // It must NOT have run the turn unconfigured.
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('overlays even when the lease has NO grpc transport (the default pod deployment)', async () => {
    // Regression guard for a real plan defect: guarding on `selected.transport` skipped the overlay
    // on pods, so the sandbox half of the bundle silently never arrived. A fake-transport test
    // cannot catch that, so this asserts the overlay is invoked at all.
    kubectlTransportMock.mockClear();
    const executeTurn = okTurn();
    const overlayConfig = vi.fn(async () => ({
      skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
      memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
    }));
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease()); // pod path: no grpc transport
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig,
      bundleRedis: {} as never,
    });
    expect(overlayConfig).toHaveBeenCalledTimes(1);
    // promotedConfig is optional on ExecuteTurnInput, so assert it arrived before reading
    // through it: "the overlay ran but passed nothing on" is the failure this test is for,
    // and it would otherwise surface as a TypeError rather than a clean expectation.
    const promoted = executeTurn.mock.calls[0]![0].promotedConfig;
    expect(promoted).toBeDefined();
    expect(promoted!.promptFragments.some((f) => f.includes('/.sh-config/skills'))).toBe(true);
    // Issue #222 (2): the overlay's path is also what the skill registry must advertise, so the
    // one path the model is handed for a skill is the one `read` can reach. Without this the
    // prompt names the pod-side /tmp/sh-config/<digest> copy, which is dead in the sandbox.
    expect(promoted!.sandboxSkillsDir).toBe('/workspace/leaves/run-1-i1/.sh-config/skills');
    // Pin the fallback itself, not just that the overlay ran: with a transport-less (pod) lease,
    // the code must genuinely build a KubectlTransport for the overlay call, and — since it built
    // one rather than reusing a leased one — must close it afterward. A second KubectlTransport is
    // built (and closed) after the turn for the post-turn config-overlay teardown -- see the
    // dedicated teardown test below for that half in isolation.
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2);
    const builtTransport = kubectlTransportMock.mock.results[0]!.value;
    expect(builtTransport.close).toHaveBeenCalledTimes(1);
  });

  it('tears down the per-leaf config-overlay link after the turn -- runPromptLeaf never converges a workspace, so nothing else would ever remove it', async () => {
    // Regression guard for the config-overlay-never-cleaned-up defect: config-overlay creates
    // /workspace/leaves/<sid>/.sh-config on every promoted prompt leaf, but this leaf kind never
    // calls convergeWorkspace/cleanupWorkspace (it has no repoUrl/ref), so without an explicit
    // teardown call the per-leaf link leaks forever on a long-lived pooled pod. If the teardown
    // call in run-leaf.ts's `finally` is removed, kubectlTransportMock drops back to 1 call and
    // the cleanup transport's `exec` below is never invoked.
    kubectlTransportMock.mockClear();
    const executeTurn = okTurn();
    const overlayConfig = vi.fn(async () => ({
      skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
      memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
    }));
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease()); // pod path: no grpc transport
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig,
      bundleRedis: {} as never,
    });
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2);
    const cleanupTransport = kubectlTransportMock.mock.results[1]!.value;
    expect(cleanupTransport.exec).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/leaves/run-1-i1/.sh-config'),
      expect.objectContaining({ timeout: 60 }),
    );
    expect(cleanupTransport.close).toHaveBeenCalledTimes(1);
  });

  it('does not build or run a cleanup transport when the overlay never ran (no configRef)', async () => {
    // Contrast case: nothing was ever created, so nothing should be torn down.
    kubectlTransportMock.mockClear();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    await runLeaf(env(), undefined, { executeTurn: okTurn() });
    expect(kubectlTransportMock).not.toHaveBeenCalled();
  });

  it('releases the digest ref even when the overlay failed partway (#216)', async () => {
    // This case used to assert the OPPOSITE -- "nothing was created to clean up" -- and that was
    // true only while the cache was never reclaimed at all. It is now false: overlayConfig's FIRST
    // exec registers this leaf's ref under the digest, before it can push any bytes. So an overlay
    // that throws after that point (a truncated transfer, a populate failure) has already left a
    // ref behind, and skipping cleanup would pin that digest's cache forever on this pod -- which
    // is #216 restored for that digest, by the very code meant to fix it. Hence the teardown flag
    // records the overlay having been ATTEMPTED, not having succeeded. Cleanup is idempotent, so
    // running it after a failure costs nothing.
    kubectlTransportMock.mockClear();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn: okTurn(),
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig: vi.fn(async () => {
        throw new Error('config overlay failed (exit 1)');
      }),
      bundleRedis: {} as never,
    });
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2); // the overlay attempt, then the release
    const cleanupTransport = kubectlTransportMock.mock.results[1]!.value;
    expect(cleanupTransport.exec).toHaveBeenCalledWith(
      expect.stringContaining(`.refs/sha256-${'c'.repeat(64)}`),
      expect.objectContaining({ timeout: 60 }),
    );
  });

  it('does not run cleanup when the resolve failed before the overlay was ever attempted', async () => {
    // The contrast case that keeps the flag honest: a resolve failure happens before any sandbox
    // exec, so no ref exists and there is genuinely nothing to release.
    kubectlTransportMock.mockClear();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const overlayConfig = vi.fn();
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn: okTurn(),
      resolvePromotedConfig: vi.fn(async () => {
        throw new Error('config bundle not found: ' + digest);
      }),
      overlayConfig,
      bundleRedis: {} as never,
    });
    expect(overlayConfig).not.toHaveBeenCalled();
    expect(kubectlTransportMock).not.toHaveBeenCalled();
  });

  it('names the digest in the release script, so the right cache is reclaimed', async () => {
    kubectlTransportMock.mockClear();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn: okTurn(),
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig: vi.fn(async () => ({
        skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
        memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
      })),
      bundleRedis: {} as never,
    });
    const script = kubectlTransportMock.mock.results[1]!.value.exec.mock.calls[0]![0] as string;
    // The digest comes from the ENVELOPE, not from the resolved bundle: passing the wrong one would
    // drop a ref that no leaf holds and leave this leaf's own cache pinned.
    expect(script).toContain(`DIR='/workspace/.sh-config/sha256-${'c'.repeat(64)}'`);
    expect(script).toContain(`REFS='/workspace/.sh-config/.refs/sha256-${'c'.repeat(64)}'`);
    // and the ref it drops is this leaf's, named by the leaf session id
    expect(script).toContain('rm -f "$REFS/run-1-i1"');
  });

  it('fails the leaf when the sandbox overlay fails', async () => {
    kubectlTransportMock.mockClear();
    const executeTurn = okTurn();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const r = await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig: vi.fn(async () => {
        throw new Error('config overlay failed (exit 1)');
      }),
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    expect(expectStatus(r, 'failed').reason).toBe('error');
    expect(executeTurn).not.toHaveBeenCalled();
    // Both fallback transports built on this path must be closed: the overlay's own (created inside
    // the try, torn down by its local `finally`) and the release's (created in the leaf-level
    // `finally`, which now runs because the overlay was attempted).
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2);
    for (const r of kubectlTransportMock.mock.results)
      expect(r.value.close).toHaveBeenCalledTimes(1);
  });
});
