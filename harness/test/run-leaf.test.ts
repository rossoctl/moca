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
vi.mock('../src/select-sandbox.js', () => ({
  selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
  SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
}));

// The `(..._args: unknown[])` params are load-bearing, not decoration: the vi.mock factories
// below forward their arguments with a spread, and a mock whose implementation declares no
// parameters is typed as taking none -- so neither the forwarding call nor the `call[0]`
// assertions further down would typecheck.
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

const { FakeSessionManager, FakeResourceLoader, createAgentSessionMock } = vi.hoisted(() => {
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
  SettingsManager: { create: () => ({}) },
}));

import {
  runLeaf,
  buildLeafPrompt,
  buildSolvePrompt,
  leafSessionId,
  validateItem,
} from '../src/run-leaf.js';
import type { LeafEnvelope } from '../src/run-leaf.js';
import { SandboxPoolSaturatedError } from '../src/select-sandbox.js';

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
  const FAKE_CONFIG = {
    pod: 'sandbox-0',
    namespace: 'default',
    context: undefined,
    podCwd: '/workspace',
    headCwd: '/head',
  };

  it('pod path: builds a fresh KubectlTransport per phase and passes no transport to the extension', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    kubectlTransportMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/pod-1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    await runLeaf(env);

    // Built once for converge and once for cleanup — the pod path never shares a transport
    // across phases, exactly like the pre-Task-9 code.
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2);
    for (const call of kubectlTransportMock.mock.calls) expect(call[0]).toBe(FAKE_CONFIG);
    // Each per-phase transport is closed once, right after its own phase.
    for (const result of kubectlTransportMock.mock.results) {
      expect(result.value.close).toHaveBeenCalledTimes(1);
    }

    expect(k8sSandboxExtensionMock).toHaveBeenCalledWith({
      config: FAKE_CONFIG,
      transport: undefined,
    });
  });

  it('uses a request-scoped sandbox pool selector', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });

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

  it('grpc path: reuses selected.transport for converge + cleanup and closes it exactly once', async () => {
    const close = vi.fn(async () => {});
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
      close,
    };
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      transport,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    kubectlTransportMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: 'run/grpc-1',
      item: { item_id: 'i1', file: 'f', pattern: 'p' },
      repoUrl: 'https://git.example/r.git',
      ref: 'abc123',
    };
    await runLeaf(env);

    // The shared transport serves both converge and cleanup — KubectlTransport is never built.
    expect(kubectlTransportMock).not.toHaveBeenCalled();
    expect(transport.exec).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(k8sSandboxExtensionMock).toHaveBeenCalledWith({ config: FAKE_CONFIG, transport });
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
  const FAKE_CONFIG = {
    pod: 'sandbox-0',
    namespace: 'default',
    context: undefined,
    podCwd: '/workspace',
    headCwd: '/head',
  };
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
      config: FAKE_CONFIG,
      transport,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    const executeTurn = okTurn();

    await runLeaf(base, undefined, { executeTurn });

    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: { config: FAKE_CONFIG, transport },
      }),
    );
  });

  it('asks for remote candidates when SH_REMOTE_SANDBOX=1', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
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
      config: FAKE_CONFIG,
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
      config: FAKE_CONFIG,
      transport: { exec: vi.fn(), close },
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
      config: FAKE_CONFIG,
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
});
