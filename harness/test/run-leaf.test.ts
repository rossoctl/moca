import { describe, it, expect, vi } from 'vitest';

// realProduceVerdict (exercised via the exported runLeaf() below, with no `deps.produceVerdict`
// override) drives real Redis/Pi/model machinery in production. Mock those module boundaries so
// the transport-wiring tests stay hermetic — mirrors the whole-module vi.mock style already used
// for @moca/harness/run-leaf in packages/knative-server/test/run-leaf-route.test.ts.
// vi.mock factories are hoisted above the rest of this module, so any value a factory returns
// DIRECTLY (as opposed to referencing lazily inside a closure) must already be initialized by
// the time the hoisted factory runs. vi.hoisted() runs its callback as part of that same hoisted
// block, in declaration order, so classes/spies built there are safe to return directly below.
const { selectPoolSandboxMock, FakeSandboxPoolSaturatedError } = vi.hoisted(() => {
  class FakeSandboxPoolSaturatedError extends Error {
    constructor(selector: string) {
      super(`sandbox pool '${selector}' saturated: all pods at capacity`);
      this.name = 'SandboxPoolSaturatedError';
    }
  }
  return { selectPoolSandboxMock: vi.fn(), FakeSandboxPoolSaturatedError };
});
// Spread the real module first: run-leaf.ts also imports assertServerSandbox (and, transitively,
// SandboxRequiredError) from this module, and a factory that returns only the two names below would
// leave that a real function elsewhere in this file — a TypeError, not a test failure — the moment
// any test here reaches the real realProduceSolve/realProduceVerdict.
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...actual,
    selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
    SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
  };
});

// The `(..._args: unknown[])` params are load-bearing, not decoration: the vi.mock factories
// below forward their arguments with a spread, and a mock whose implementation declares no
// parameters is typed as taking none -- so neither the forwarding call nor the `call[0]`
// assertions further down would typecheck.
const { k8sSandboxExtensionMock } = vi.hoisted(() => ({
  k8sSandboxExtensionMock: vi.fn((..._args: unknown[]) => () => {}),
}));
// Spread the real module first, for the same reason the select-sandbox mock above does:
// run-leaf.ts also imports createCapacityLatch and SandboxCapacityRefusedError from here
// (#452), and a factory returning only the two overrides below leaves those undefined —
// `instanceof undefined` is a TypeError inside the catch block, which surfaces as ten
// unrelated tests failing rather than as a missing mock.
vi.mock('@moca/k8s-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moca/k8s-sandbox')>();
  return {
    ...actual,
    k8sSandboxExtension: (...args: unknown[]) => k8sSandboxExtensionMock(...args),
  };
});

const { FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read(_sid: string) {
      return [];
    }
    async latestWhere(_sid: string, _pred: unknown) {
      return null;
    }
    async append(_sid: string, _entry: unknown, _piType: string) {
      return {};
    }
    async list() {
      return [];
    }
    async close() {}
  }
  return { FakeRedisSessionBackend };
});
vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
}));

const {
  FakeSessionManager,
  FakeResourceLoader,
  createAgentSessionMock,
  settingsManagerCreateMock,
} = vi.hoisted(() => {
  class FakeSessionManager {
    constructor(private sid: string) {}
    getSessionId() {
      return this.sid;
    }
    appendCustomEntry(_type: string, _data?: unknown) {
      return 'entry-id';
    }
  }
  class FakeResourceLoader {
    constructor(public opts: unknown) {}
    async reload() {}
  }
  return {
    FakeSessionManager,
    FakeResourceLoader,
    createAgentSessionMock: vi.fn(async (..._args: unknown[]) => ({
      session: { prompt: async () => {} },
    })),
    // A spy (not just a stub) so MI1 R4 tests can assert the third argument
    // (`{ projectTrusted: false }` in server mode, `{}` otherwise) that turnLoaderInputs passes.
    settingsManagerCreateMock: vi.fn((..._args: unknown[]) => ({})),
  };
});
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => createAgentSessionMock(...args),
  DefaultResourceLoader: FakeResourceLoader,
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: (_cwd: string, _snapshot: unknown, opts: { id: string }) =>
      new FakeSessionManager(opts.id),
    openFromCheckpoint: async (sid: string) => new FakeSessionManager(sid),
  },
  SettingsManager: { create: (...args: unknown[]) => settingsManagerCreateMock(...args) },
}));

import {
  runLeaf,
  buildLeafPrompt,
  buildSolvePrompt,
  leafSessionId,
  validateItem,
  realProduceSolve,
  realProduceVerdict,
} from '../src/run-leaf.js';
import type { LeafEnvelope } from '../src/run-leaf.js';
import { SandboxPoolSaturatedError, SandboxRequiredError } from '../src/select-sandbox.js';
// The REAL class, reaching this file through the importOriginal spread in the
// @moca/k8s-sandbox mock above — which is what makes run-leaf's `instanceof` check against
// it meaningful here rather than a comparison between two unrelated constructors (#452).
import { SandboxCapacityRefusedError } from '@moca/k8s-sandbox';

describe('LeafEnvelope repo ref fields', () => {
  it('accepts optional repoUrl and ref', () => {
    const env: LeafEnvelope = {
      sessionId: 'run-a/item-1',
      item: { item_id: 'item-1', file: 'a.ts', pattern: 'x' },
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    expect(env.repoUrl).toBe('https://git.example/r.git');
    expect(env.ref).toBe('abc123');
  });
});

describe('LeafEnvelope prompt fields', () => {
  it('accepts kind:prompt with a prompt string', () => {
    const env: LeafEnvelope = {
      sessionId: 'run-a/item-1',
      item: { item_id: 'item-1', file: 'a.ts', pattern: 'x' },
      kind: 'prompt',
      prompt: 'Summarize the repo.',
    };
    expect(env.kind).toBe('prompt');
    expect(env.prompt).toBe('Summarize the repo.');
  });
});

describe('validateItem', () => {
  it('accepts a well-formed item', () => {
    expect(validateItem({ item_id: 'i', file: 'f', pattern: 'p' })).toEqual({
      item_id: 'i',
      file: 'f',
      pattern: 'p',
      require_approval: false,
    });
  });
  it('rejects a missing field and non-objects', () => {
    expect(validateItem({ item_id: 'i', file: 'f' })).toBeNull();
    expect(validateItem(null)).toBeNull();
  });
});

describe('buildLeafPrompt', () => {
  it('includes the file, pattern, and submit_verdict instruction', () => {
    const p = buildLeafPrompt({ item_id: 'i1', file: 'a.py', pattern: 'eval(' });
    expect(p).toContain('a.py');
    expect(p).toContain('eval(');
    expect(p).toContain('submit_verdict');
  });
});

// The prompt builders strip trailing "/" from workspaceRef with a linear scan rather than
// `/\/+$/`, which CodeQL flags as polynomial (js/polynomial-redos). workspaceRef arrives on the
// LeafEnvelope -- i.e. straight off the request body, with no normalisation in between -- so the
// input is caller-controlled. These cases pin the rewrite to the old regex's exact behaviour; the
// last is the regression guard: the regex burns ~15s of CPU on 100k slashes, the scan ~0.005ms.
describe('prompt builders: trailing-slash strip on workspaceRef', () => {
  const item = { item_id: 'i1', file: 'a.py', pattern: 'eval(' };
  // prettier-ignore
  const refs = [
    "/w", "/w/", "/w//", "/w/////////", "/", "////", "/w/x", "/w ", "/w /", "/wörk/", "/w/./",
  ];

  for (const ref of refs) {
    it(`buildLeafPrompt matches the old strip for ${JSON.stringify(ref)}`, () => {
      expect(buildLeafPrompt(item, ref)).toContain(`${ref.replace(/\/+$/, '')}/a.py`);
    });

    it(`buildSolvePrompt matches the old strip for ${JSON.stringify(ref)}`, () => {
      expect(buildSolvePrompt('stmt', ref)).toContain(
        `root (an absolute path in your sandbox): ${ref.replace(/\/+$/, '')}`,
      );
    });
  }

  it('leaves the bare file name alone when workspaceRef is empty', () => {
    expect(buildLeafPrompt(item, '')).toContain('read tool): a.py');
  });

  it('handles a pathological run of slashes in linear time (js/polynomial-redos guard)', () => {
    // Many slashes then a non-slash: nothing to strip, but `/\/+$/` retries from every position.
    const evil = `/w${'/'.repeat(100_000)}x`;
    const started = performance.now();
    const prompt = buildLeafPrompt(item, evil);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(prompt).toContain(`${evil}/a.py`);
  });
});

describe('buildSolvePrompt', () => {
  it('embeds the problem statement and the absolute worktree root', () => {
    const p = buildSolvePrompt('Fix the off-by-one in paginate().', '/workspace/leaves/run-1/');
    expect(p).toContain('Fix the off-by-one in paginate().');
    // trailing slash trimmed; root given as an absolute path
    expect(p).toContain('/workspace/leaves/run-1');
    expect(p).not.toContain('/workspace/leaves/run-1/\n');
    // solve prompt must NOT instruct submit_verdict (that is the converge path)
    expect(p).not.toContain('submit_verdict');
  });
});

describe('runLeaf', () => {
  it('fails with bad_inputs when item is missing', async () => {
    const r = await runLeaf({ sessionId: 's' } as any, undefined, {
      produceVerdict: async () => {},
    });
    expect(r).toEqual({ status: 'failed', reason: 'bad_inputs' });
  });

  it('returns the verdict inline on success', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => {
        cap.verdict = { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' };
      },
    });
    expect(r).toEqual({
      status: 'done',
      verdict: { item_id: 'i1', verdict: 'FLAGGED', reason: 'x' },
    });
  });

  it('returns the gate inline when paused', async () => {
    const env = {
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p', require_approval: true },
    };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => {
        cap.gate = { gateId: 2, summary: 's', proposed_action: 'a' };
      },
    });
    expect(r).toEqual({
      status: 'paused',
      gateId: 2,
      gate: { summary: 's', proposed_action: 'a' },
    });
  });

  it('returns aborted when the capture is aborted', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => {
        cap.aborted = true;
      },
    });
    expect(r).toEqual({ status: 'aborted' });
  });

  it('fails with no_verdict when nothing is captured', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const r = await runLeaf(env, undefined, { produceVerdict: async () => {} });
    expect(r).toEqual({ status: 'failed', reason: 'no_verdict' });
  });

  it('fails with invalid_verdict when the captured verdict is off-shape', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => {
        cap.verdict = { item_id: 'i1', verdict: 'MAYBE', reason: 'x' } as any;
      },
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('invalid_verdict');
  });

  it('returns failed:error when produceVerdict throws', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const produceVerdict = async () => {
      throw new Error('boom');
    };
    const r = await runLeaf(env, undefined, { produceVerdict });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('error');
  });

  it('returns failed:saturated (not error) when the pool is saturated', async () => {
    // Distinguishing saturation from a generic error lets the sync /runs path implement the
    // spec §4.3 bounded-wait + 503 Retry-After behavior without touching the async path.
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const produceVerdict = async () => {
      throw new SandboxPoolSaturatedError('pool=x');
    };
    const r = await runLeaf(env, undefined, { produceVerdict });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('saturated');
  });

  // #452. The OTHER no-capacity throw, and the one the original report hit. It cannot reach
  // the catch above by the same route: SandboxPoolSaturatedError is raised at lease time,
  // before any exec, while this arrives mid-turn from a sandbox that was leased successfully
  // and whose host then refused the work. Same reason, because the caller's remedy is the
  // same — wait and retry — and `reason: 'error'` would spend the run permanently on a
  // condition that clears by itself.
  it('returns failed:saturated for a mid-turn host capacity refusal, not failed:error', async () => {
    const env = { sessionId: 'run/i1', item: { item_id: 'i1', file: 'f', pattern: 'p' } };
    const produceVerdict = async () => {
      throw new SandboxCapacityRefusedError(
        'memory-budget: committing 301989888 more bytes would reach 4328521728 against a budget of 4294967296',
      );
    };
    const r = await runLeaf(env, undefined, { produceVerdict });
    expect(r).toMatchObject({ status: 'failed', reason: 'saturated' });
    // The host's arithmetic survives into the result: it is what a human reading the 503's
    // log needs to tell "size MICROVM_MAX_COMMITTED_MB higher" from "the host is just busy".
    if (r.status === 'failed') expect(r.message).toContain('memory-budget:');
  });

  it('returns failed:saturated for a capacity refusal on a solve leaf too', async () => {
    const env: LeafEnvelope = {
      kind: 'solve',
      sessionId: 'run/i1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      problemStatement: 'fix the thing',
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    const produceSolve = async () => {
      throw new SandboxCapacityRefusedError('max-runs: 8 runs already resident, MaxRuns is 8');
    };
    const r = await runLeaf(env, undefined, { produceSolve });
    expect(r).toMatchObject({ status: 'failed', reason: 'saturated' });
  });
});

describe('leafSessionId', () => {
  it('sanitizes the bare sessionId when no tenant is set', () => {
    expect(leafSessionId({ sessionId: 'run-1/i1' })).toBe('run-1-i1');
  });
  it('prefixes and sanitizes with the tenant for per-tenant id isolation', () => {
    expect(leafSessionId({ sessionId: 'run-1/i1', tenant: 'acme' })).toBe('acme-run-1-i1');
  });
});

describe('realProduceVerdict transport wiring (Task 9)', () => {
  const lease = (transport: { exec: unknown; close: unknown }) => ({
    transport,
    podCwd: '/workspace',
    sandboxId: 'sandbox-0',
    heartbeat: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  });

  it('uses a request-scoped sandbox pool selector', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(
      lease({
        exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
        close: vi.fn(async () => {}),
      }),
    );

    await runLeaf({
      sessionId: 'run/workload-1',
      sandboxPoolSelector: 'sh.kagenti.io/sandbox-pool=workload-1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    });

    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        KAGENTI_SANDBOX_POOL_SELECTOR: 'sh.kagenti.io/sandbox-pool=workload-1',
      }),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('reuses the leased transport for converge + cleanup and closes it exactly once', async () => {
    // ADR-0041: every selection leases a relay transport, so converge, the agent extension and
    // cleanup share ONE transport — closed exactly once, in the outer finally.
    const close = vi.fn(async () => {});
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
      close,
    };
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease(transport));
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/grpc-1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    await runLeaf(env);

    // The shared transport serves both converge and cleanup.
    expect(transport.exec).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(k8sSandboxExtensionMock).toHaveBeenCalledWith(
      expect.objectContaining({ transport, podCwd: '/workspace', sandboxId: 'sandbox-0' }),
    );
  });
});

describe('realProduceSolve / realProduceVerdict: no resolvable sandbox in server mode (MI1 R3)', () => {
  // The reachable shape: selectPoolSandbox resolves to null when no sandbox is configured at all.
  it('realProduceVerdict: refuses with SandboxRequiredError and never builds an agent session', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    createAgentSessionMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const item = { item_id: 'i1', file: 'f', pattern: 'p' };
    const env: LeafEnvelope = { sessionId: 'run/verdict-none', item };

    const err = await realProduceVerdict(item, env, { serverMode: true }, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SandboxRequiredError);
    // No agent session means no tool of any kind -- local or sandboxed -- was registered.
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(k8sSandboxExtensionMock).not.toHaveBeenCalled();
  });

  it('realProduceVerdict: outside server mode the same null sandbox still runs the leaf (control)', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    createAgentSessionMock.mockClear();

    const item = { item_id: 'i1', file: 'f', pattern: 'p' };
    const env: LeafEnvelope = { sessionId: 'run/verdict-none-local', item };

    await realProduceVerdict(item, env, {}, {}).catch(() => {});
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it('realProduceSolve: refuses a null sandbox and never builds an agent session', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    createAgentSessionMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/solve-none',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
    };

    // A solve leaf needs a sandbox worktree in every mode, so it refuses a null sandbox before the
    // server-mode gate is reached.
    const err = await realProduceSolve(env, { serverMode: true }, {}).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/solve leaf requires a configured sandbox pool/);
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(k8sSandboxExtensionMock).not.toHaveBeenCalled();
  });
});

describe('realProduceSolve / realProduceVerdict: resource-loader lockdown (MI1 R4)', () => {
  // A real (non-null) lease, so both leaves run past the R3 sandbox gate into the resource-loader
  // construction this test targets.
  const lease = () => ({
    transport: {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
      close: vi.fn(async () => {}),
    },
    podCwd: '/workspace',
    sandboxId: 'sandbox-0',
    heartbeat: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  });

  // The resourceLoader instance is passed to createAgentSession untransformed (see run-leaf.ts), so
  // its constructor options — the FakeResourceLoader records them as `.opts` — are recovered from
  // the last createAgentSession call rather than from a separate spy on DefaultResourceLoader.
  function lastLoaderOptions(): Record<string, unknown> {
    const call = createAgentSessionMock.mock.calls.at(-1)!;
    const { resourceLoader } = call[0] as { resourceLoader: { opts: Record<string, unknown> } };
    return resourceLoader.opts;
  }
  function lastSettingsManagerThirdArg(): unknown {
    return settingsManagerCreateMock.mock.calls.at(-1)![2];
  }

  it('realProduceSolve in server mode: noExtensions, noContextFiles, and an untrusted project', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease());
    createAgentSessionMock.mockClear();
    settingsManagerCreateMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/solve-lockdown-on',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      problemStatement: 'do the thing',
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    await realProduceSolve(env, { serverMode: true }, {});

    expect(lastLoaderOptions()).toMatchObject({ noExtensions: true, noContextFiles: true });
    expect(lastSettingsManagerThirdArg()).toEqual({ projectTrusted: false });
  });

  it('realProduceSolve outside server mode: no lockdown options are set', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease());
    createAgentSessionMock.mockClear();
    settingsManagerCreateMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/solve-lockdown-off',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      problemStatement: 'do the thing',
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    await realProduceSolve(env, {}, {});

    const opts = lastLoaderOptions();
    expect(opts).not.toHaveProperty('noExtensions');
    expect(opts).not.toHaveProperty('noContextFiles');
    expect(lastSettingsManagerThirdArg()).toEqual({});
  });

  it('realProduceVerdict in server mode: noExtensions, noContextFiles, and an untrusted project', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease());
    createAgentSessionMock.mockClear();
    settingsManagerCreateMock.mockClear();

    const item = { item_id: 'i1', file: 'f', pattern: 'p' };
    const env: LeafEnvelope = { sessionId: 'run/verdict-lockdown-on', item };
    await realProduceVerdict(item, env, { serverMode: true }, {});

    expect(lastLoaderOptions()).toMatchObject({ noExtensions: true, noContextFiles: true });
    expect(lastSettingsManagerThirdArg()).toEqual({ projectTrusted: false });
  });

  it('realProduceVerdict outside server mode: no lockdown options are set', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease());
    createAgentSessionMock.mockClear();
    settingsManagerCreateMock.mockClear();

    const item = { item_id: 'i1', file: 'f', pattern: 'p' };
    const env: LeafEnvelope = { sessionId: 'run/verdict-lockdown-off', item };
    await realProduceVerdict(item, env, {}, {});

    const opts = lastLoaderOptions();
    expect(opts).not.toHaveProperty('noExtensions');
    expect(opts).not.toHaveProperty('noContextFiles');
    expect(lastSettingsManagerThirdArg()).toEqual({});
  });
});

describe('buildLeafPrompt with require_approval', () => {
  it('adds a request_approval instruction when the item requires approval', () => {
    const p = buildLeafPrompt({
      item_id: 'i1',
      file: 'a.py',
      pattern: 'eval(',
      require_approval: true,
    });
    expect(p).toContain('request_approval');
  });
  it('withholds the submit_verdict instruction in the gated turn (verdict comes after approval)', () => {
    const p = buildLeafPrompt({
      item_id: 'i1',
      file: 'a.py',
      pattern: 'eval(',
      require_approval: true,
    });
    expect(p).not.toContain('submit_verdict');
  });
  it('omits the gate instruction by default', () => {
    const p = buildLeafPrompt({ item_id: 'i1', file: 'a.py', pattern: 'eval(' });
    expect(p).not.toContain('request_approval');
  });
});

describe('runLeaf — solve routing', () => {
  const base: LeafEnvelope = {
    sessionId: 'run-1',
    item: { item_id: 'x', file: 'f', pattern: 'p' },
    kind: 'solve',
    problemStatement: 'do the thing',
    repoUrl: 'git://x/repo.git',
    ref: 'work',
  };
  it('maps a captured patch to status solved', async () => {
    const r = await runLeaf(base, undefined, {
      produceSolve: async (_e, _c, cap) => {
        cap.patch = 'PATCH';
      },
    });
    expect(r).toEqual({ status: 'solved', patch: 'PATCH' });
  });
  it('treats an unset patch as an empty (still solved) patch', async () => {
    const r = await runLeaf(base, undefined, {
      produceSolve: async () => {
        /* no edits */
      },
    });
    expect(r).toEqual({ status: 'solved', patch: '' });
  });
  it('fails bad_inputs when problemStatement/repoUrl/ref are missing', async () => {
    const r = await runLeaf({ sessionId: 's', item: base.item, kind: 'solve' });
    expect(r).toEqual({ status: 'failed', reason: 'bad_inputs' });
  });
  it('maps pool saturation to a saturated failure', async () => {
    const r = await runLeaf(base, undefined, {
      produceSolve: async () => {
        throw new SandboxPoolSaturatedError('full');
      },
    });
    expect(r.status).toBe('failed');
    expect((r as { reason?: string }).reason).toBe('saturated');
  });
});

describe('runLeaf — prompt routing', () => {
  const base: LeafEnvelope = {
    sessionId: 'run-1/i1',
    item: { item_id: 'x', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Summarize the repo.',
  };

  it('maps end_turn → responded with the assistant text and usage', async () => {
    const executeTurn = vi.fn(async () => ({
      sessionId: 'run-1-i1',
      response: 'here is a summary',
      stopReason: 'end_turn',
      usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, total: 10 },
    }));
    const r = await runLeaf(base, undefined, { executeTurn });
    expect(r).toEqual({
      status: 'responded',
      text: 'here is a summary',
      usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, total: 10 },
    });
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Summarize the repo.',
        sessionId: 'run-1/i1',
        createIfAbsent: true,
      }),
    );
  });

  it('maps a non-terminal stopReason (max_tokens) → responded', async () => {
    const executeTurn = vi.fn(async () => ({
      sessionId: 'run-1-i1',
      response: 'capped answer',
      stopReason: 'max_tokens',
      usage: { input: 5, output: 9, cacheRead: 0, cacheWrite: 0, total: 14 },
    }));
    const r = await runLeaf(base, undefined, { executeTurn });
    expect(r).toEqual({
      status: 'responded',
      text: 'capped answer',
      usage: { input: 5, output: 9, cacheRead: 0, cacheWrite: 0, total: 14 },
    });
  });

  it('maps stopReason error → failed/error carrying the message', async () => {
    const executeTurn = vi.fn(async () => ({
      sessionId: 'run-1-i1',
      response: '',
      stopReason: 'error',
      errorMessage: 'model exploded',
    }));
    const r = await runLeaf(base, undefined, { executeTurn });
    expect(r).toEqual({ status: 'failed', reason: 'error', message: 'model exploded' });
  });

  it('maps stopReason aborted → aborted', async () => {
    const executeTurn = vi.fn(async () => ({
      sessionId: 'run-1-i1',
      response: '',
      stopReason: 'aborted',
    }));
    const r = await runLeaf(base, undefined, { executeTurn });
    expect(r).toEqual({ status: 'aborted' });
  });

  it('refuses a server-mode prompt leaf with no sandbox itself, even with executeTurn injected (MI1 R3)', async () => {
    // The injected executeTurn replaces the real one's own R3 check, so only the leaf's check can
    // stop this. It must fail before the turn runs. (A truthy lease without a sandbox is no
    // longer constructible: every selection carries a transport, ADR-0041.)
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    const executeTurn = vi.fn();
    const r = await runLeaf(base, { serverMode: true }, { executeTurn });
    expect(r).toMatchObject({ status: 'failed', reason: 'error' });
    expect((r as { message?: string }).message).toMatch(/sandbox/i);
    expect(executeTurn).not.toHaveBeenCalled();
    selectPoolSandboxMock.mockReset();
  });

  it('fails bad_inputs when prompt is missing', async () => {
    const r = await runLeaf({ sessionId: 's', item: base.item, kind: 'prompt' }, undefined, {
      executeTurn: vi.fn(),
    });
    expect(r).toEqual({ status: 'failed', reason: 'bad_inputs' });
  });
});

it('solve without env_key uses convergeWorkspace, not swebench setup', async () => {
  // produceSolve is injectable; assert the swebench branch is NOT taken when env_key is absent.
  // (Structural: import isSwebenchEnvelope and check the predicate.)
  const { isSwebenchEnvelope } = await import('../src/run-leaf.js');
  // isSwebenchEnvelope's parameter is the narrow structural subset it actually reads
  // ({ kind, env_key }), so these otherwise-realistic solve envelopes are excess properties
  // when handed to it as fresh literals. Typing them as Partial<LeafEnvelope> keeps the
  // realism -- and still catches a misspelled field -- without that clash.
  const noEnvKey: Partial<LeafEnvelope> = {
    kind: 'solve',
    problemStatement: 'x',
    repoUrl: 'git://h/r.git',
    ref: 'main',
  };
  const withEnvKey: Partial<LeafEnvelope> = {
    kind: 'solve',
    problemStatement: 'x',
    repoUrl: '/repos/a/b.git',
    ref: 'c',
    env_key: 'k:latest',
  };
  expect(isSwebenchEnvelope(noEnvKey)).toBe(false);
  expect(isSwebenchEnvelope(withEnvKey)).toBe(true);
});

describe('runPromptLeaf sandbox leasing', () => {
  const base: LeafEnvelope = {
    sessionId: 'run-1/i1',
    item: { item_id: 'x', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Read /etc/os-release and name the distro.',
  };
  const okTurn = () =>
    vi.fn(async () => ({ sessionId: 'run-1-i1', response: 'RHEL 9.8', stopReason: 'end_turn' }));

  // A leased sandbox reaches the turn only if runPromptLeaf hands it over: before this, a prompt
  // leaf resolved its own sandbox from process.env and the lease was never consulted.
  it('hands the leased grpc transport to the turn so tool calls reach the remote sandbox', async () => {
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
      close: vi.fn(async () => {}),
    };
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport,
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    const executeTurn = okTurn();

    await runLeaf(base, undefined, { executeTurn });

    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: { transport, podCwd: '/workspace', sandboxId: 'sandbox-0' },
      }),
    );
  });

  it('asks for remote candidates when SH_REMOTE_SANDBOX=1', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close: vi.fn(async () => {}) },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    const prev = process.env.SH_REMOTE_SANDBOX;
    process.env.SH_REMOTE_SANDBOX = '1';
    try {
      await runLeaf(base, undefined, { executeTurn: okTurn() });
    } finally {
      if (prev === undefined) delete process.env.SH_REMOTE_SANDBOX;
      else process.env.SH_REMOTE_SANDBOX = prev;
    }

    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ remoteSandbox: true }),
    );
  });

  it('uses a request-scoped sandbox pool selector', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close: vi.fn(async () => {}) },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });

    await runLeaf(
      { ...base, sandboxPoolSelector: 'sh.kagenti.io/sandbox-pool=demo-remote-only' },
      undefined,
      { executeTurn: okTurn() },
    );

    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        KAGENTI_SANDBOX_POOL_SELECTOR: 'sh.kagenti.io/sandbox-pool=demo-remote-only',
      }),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('maps pool saturation to failed/saturated rather than throwing', async () => {
    selectPoolSandboxMock.mockReset().mockRejectedValue(new SandboxPoolSaturatedError('pool=x'));
    const executeTurn = okTurn();

    const r = await runLeaf(base, undefined, { executeTurn });

    expect(r).toMatchObject({ status: 'failed', reason: 'saturated' });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('releases the lease and closes the leased transport after the turn', async () => {
    const release = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release,
    });

    await runLeaf(base, undefined, { executeTurn: okTurn() });

    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // A lease held past a crashed turn shrinks pool capacity until its TTL expires.
  it('releases the lease even when the turn throws', async () => {
    const release = vi.fn(async () => {});
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close: vi.fn(async () => {}) },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release,
    });
    const executeTurn = vi.fn(async () => {
      throw new Error('turn exploded');
    });

    const r = await runLeaf(base, undefined, { executeTurn });

    expect(r).toMatchObject({ status: 'failed', reason: 'error', message: 'turn exploded' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  // #452, on the path where it was reported. The lease SUCCEEDS here — the throw comes from
  // inside the turn, after `executeTurn` has started — so it cannot be caught by the
  // lease-time branch above, and before this it fell through to `reason: 'error'`: a 200 or
  // a permanent failure for a host that just needed a moment.
  it('maps a mid-turn host capacity refusal to failed/saturated and still releases the lease', async () => {
    const release = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release,
    });
    const executeTurn = vi.fn(async () => {
      throw new SandboxCapacityRefusedError('memory-budget: committing 301989888 more bytes');
    });

    const r = await runLeaf(base, undefined, { executeTurn });

    expect(r).toMatchObject({ status: 'failed', reason: 'saturated' });
    // Releasing matters MORE here than on a generic error: the condition clears as hosts
    // free up, and a lease held past this turn is capacity withheld from the very pool the
    // retry will come back to.
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// agentic-node-cluster#62: /v1/runs put the session's sandbox tier in the TurnConfig (buildConfig),
// but run-leaf never passed it to selectPoolSandbox, so every leaf ran in the default tier while
// /v1/turn honoured it. Each leaf kind must now forward config.sandboxTier as the selection tier.
describe('runLeaf: the session sandbox tier reaches sandbox selection', () => {
  const tierOf = () => (selectPoolSandboxMock.mock.calls[0]?.[3] as { tier?: string })?.tier;
  const promptEnv: LeafEnvelope = {
    sessionId: 'run-tier/i1',
    item: { item_id: 'x', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'hello',
  };
  const leasePrompt = () =>
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport: { exec: vi.fn(), close: vi.fn(async () => {}) },
      podCwd: '/workspace',
      sandboxId: 'sandbox-0',
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
  const okTurn = () =>
    vi.fn(async () => ({ sessionId: 'run-tier-i1', response: 'ok', stopReason: 'end_turn' }));
  const item = { item_id: 'i1', file: 'f', pattern: 'p' };

  it('prompt leaf: passes the session tier', async () => {
    leasePrompt();
    await runLeaf(promptEnv, { sandboxTier: 'microvm' }, { executeTurn: okTurn() });
    expect(tierOf()).toBe('microvm');
  });

  it('prompt leaf: passes no tier when the config has none', async () => {
    leasePrompt();
    await runLeaf(promptEnv, {}, { executeTurn: okTurn() });
    expect(selectPoolSandboxMock).toHaveBeenCalledTimes(1);
    expect(tierOf()).toBeUndefined();
  });

  // A null selection makes both producers stop right after selecting, before any agent work.
  it('solve leaf: passes the session tier', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    await realProduceSolve(
      { sessionId: 'run-tier/solve', item },
      { sandboxTier: 'microvm' },
      {},
    ).catch(() => {});
    expect(tierOf()).toBe('microvm');
  });

  it('solve leaf: passes no tier when the config has none', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    await realProduceSolve({ sessionId: 'run-tier/solve-none', item }, {}, {}).catch(() => {});
    expect(selectPoolSandboxMock).toHaveBeenCalledTimes(1);
    expect(tierOf()).toBeUndefined();
  });

  it('verdict leaf: passes the session tier', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    await realProduceVerdict(
      item,
      { sessionId: 'run-tier/verdict', item },
      { serverMode: true, sandboxTier: 'microvm' },
      {},
    ).catch(() => {});
    expect(tierOf()).toBe('microvm');
  });

  it('verdict leaf: passes no tier when the config has none', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null);
    await realProduceVerdict(
      item,
      { sessionId: 'run-tier/verdict-none', item },
      { serverMode: true },
      {},
    ).catch(() => {});
    expect(selectPoolSandboxMock).toHaveBeenCalledTimes(1);
    expect(tierOf()).toBeUndefined();
  });
});

// A queued turn of a templated session is a prompt leaf whose config carries the session's
// template, seed and build (the dequeue exchange): it runs on the hands an interactive turn would.
describe("runPromptLeaf on a templated session's hands (session-templates spec §4, §5, §5.1)", () => {
  const base: LeafEnvelope = {
    sessionId: 'sess-1',
    item: { item_id: 'x', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Fix the bug.',
  };
  const B = 'sha256:' + 'b'.repeat(64);
  const okTurn = () =>
    vi.fn(async () => ({ sessionId: 'sess-1', response: 'fixed', stopReason: 'end_turn' }));
  function leased(captureOut = 'abc\ndiff --git a/f b/f\n', seedExit = 0) {
    const commands: string[] = [];
    const transport = {
      exec: vi.fn(async (c: string) => {
        commands.push(c);
        if (c.includes('.moca-seeded'))
          return { stdout: Buffer.alloc(0), exitCode: seedExit, truncated: false };
        return { stdout: Buffer.from(captureOut), exitCode: 0, truncated: false };
      }),
      close: vi.fn(async () => {}),
    };
    const release = vi.fn(async () => {});
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      transport,
      podCwd: '/workspace',
      sandboxId: 'sbx-1',
      heartbeat: vi.fn(async () => {}),
      release,
    });
    return { commands, release };
  }

  it("selects the template's workers pinned to the build, seeds, and returns the patch", async () => {
    const { commands, release } = leased();
    const executeTurn = okTurn();
    const r = await runLeaf(
      base,
      {
        sandboxTemplate: 'example-repo',
        sandboxSeed: 'cp -a /opt/src/. .',
        sandboxSeedSource: 'build',
        sandboxBuildId: B,
      },
      { executeTurn },
    );
    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ template: 'example-repo', build: B }),
    );
    // The seed ran before the turn, in the leased workspace; the capture after it.
    expect(commands[0]).toContain('.moca-seeded');
    expect(commands[0]).toContain("'/workspace'");
    expect(commands.at(-1)).toContain('diff --cached --binary');
    expect(r).toMatchObject({
      status: 'responded',
      text: 'fixed',
      seed: { source: 'build', buildId: B },
      workspace: { baseline: 'abc', patch: 'diff --git a/f b/f\n' },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a failed seed fails the leaf before the turn, and returns the lease', async () => {
    const { release } = leased('', 3);
    const executeTurn = okTurn();
    const r = await runLeaf(
      base,
      { sandboxTemplate: 'example-repo', sandboxSeed: 'false' },
      { executeTurn },
    );
    expect(r).toMatchObject({ status: 'failed', reason: 'error' });
    expect((r as { message?: string }).message).toContain("'example-repo'");
    expect(executeTurn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a template without a seed: its workers, no seed, still a patch', async () => {
    const { commands } = leased();
    const r = await runLeaf(base, { sandboxTemplate: 'py312' }, { executeTurn: okTurn() });
    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ template: 'py312' }),
    );
    expect(commands.some((c) => c.includes('.moca-seeded'))).toBe(false);
    expect(r).not.toHaveProperty('seed');
    expect(r).toHaveProperty('workspace');
  });

  it('an untemplated session: no template asked for, nothing run, no patch', async () => {
    const { commands } = leased();
    const r = await runLeaf(base, { sandboxBuildId: B }, { executeTurn: okTurn() });
    const opts = selectPoolSandboxMock.mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('template');
    expect(opts).not.toHaveProperty('build');
    expect(commands).toEqual([]);
    expect(r).toEqual({ status: 'responded', text: 'fixed', usage: undefined });
  });
});
