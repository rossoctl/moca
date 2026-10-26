import { describe, expect, it, vi } from 'vitest';

const { selectPoolSandboxMock } = vi.hoisted(() => ({ selectPoolSandboxMock: vi.fn() }));
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return { ...actual, selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args) };
});

import { contextNote, runLeaf, type LeafEnvelope } from '../src/run-leaf.js';

type ExecuteTurnDep = NonNullable<NonNullable<Parameters<typeof runLeaf>[2]>['executeTurn']>;

const REVISION = 'd'.repeat(64);
const SCOPE = 'e'.repeat(32);

const okTurn = () =>
  vi.fn<ExecuteTurnDep>(async () => ({
    sessionId: 'run-1',
    response: 'text',
    stopReason: 'end_turn',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  }));

const relayLease = () => {
  const transport = {
    exec: vi.fn(async (..._args: unknown[]) => ({
      stdout: Buffer.from(''),
      exitCode: 0,
      truncated: false,
    })),
    close: vi.fn(async () => {}),
  };
  return {
    lease: {
      config: { pod: 'sbx-0', namespace: 'moca', podCwd: '/workspace/run-1', headCwd: '/tmp' },
      transport,
      leased: true,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    },
    transport,
  };
};

const env = (loadBundle: () => Promise<Buffer>, writable?: unknown): LeafEnvelope =>
  ({
    sessionId: 'run-1',
    item: { item_id: 'i1', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Inspect.',
    internalContext: {
      revision: REVISION,
      cacheScope: SCOPE,
      loadBundle,
      ...(writable !== undefined ? { writable } : {}),
    },
  }) as LeafEnvelope;

describe('frozen context on a prompt leaf', () => {
  it('overlays through the relay transport, points the prompt at it, and cleans up', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const loadBundle = vi.fn();
    const overlayContext = vi.fn(async () => '/workspace/.moca-context/runs/run-1');
    const executeTurn = okTurn();
    const r = await runLeaf(env(loadBundle), undefined, { executeTurn, overlayContext });

    expect(r.status).toBe('responded');
    expect(overlayContext).toHaveBeenCalledWith(
      transport,
      `${SCOPE}-${REVISION}`,
      'run-1',
      loadBundle,
      { writable: false },
    );
    const turn = executeTurn.mock.calls[0]![0];
    expect(turn.prompt).toBe(
      "Inspect.\n\nYour working directory, /workspace/.moca-context/runs/run-1, is the workload's " +
        'read-only context. Use /workspace/run-1 as writable scratch space.',
    );
    // The run starts in its context; the rest of the lease's config is passed through unchanged.
    expect(turn.sandbox).toEqual({
      config: { ...lease.config, podCwd: '/workspace/.moca-context/runs/run-1' },
      transport,
    });
    expect(lease.config.podCwd).toBe('/workspace/run-1');
    expect(
      transport.exec.mock.calls.some(([script]) => String(script).includes('CONTEXT_CLEANUP')),
    ).toBe(true);
    expect(lease.release).toHaveBeenCalled();
  });

  it('fails without running a turn when the sandbox is not a P6 relay sandbox', async () => {
    const { lease } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue({ ...lease, transport: undefined });
    const executeTurn = okTurn();
    const r = await runLeaf(env(vi.fn()), undefined, { executeTurn, overlayContext: vi.fn() });
    expect(r).toMatchObject({ status: 'failed', message: expect.stringContaining('P6 relay') });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalled();
  });

  it('reports an overlay failure as a run failure and still releases the ref', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    const overlayContext = vi.fn(async () => {
      throw new Error('Context Service is unreachable');
    });
    const r = await runLeaf(env(vi.fn()), undefined, { executeTurn, overlayContext });
    expect(r).toMatchObject({
      status: 'failed',
      message: 'context overlay failed: Context Service is unreachable',
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(
      transport.exec.mock.calls.some(([script]) => String(script).includes('CONTEXT_CLEANUP')),
    ).toBe(true);
  });

  it('asks for a writable copy and tells the agent it is discarded with the run', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const loadBundle = vi.fn();
    const overlayContext = vi.fn(async () => '/workspace/.moca-context/runs/run-1');
    const executeTurn = okTurn();
    const r = await runLeaf(env(loadBundle, true), undefined, { executeTurn, overlayContext });

    expect(r.status).toBe('responded');
    expect(overlayContext).toHaveBeenCalledWith(
      transport,
      `${SCOPE}-${REVISION}`,
      'run-1',
      loadBundle,
      { writable: true },
    );
    const prompt = executeTurn.mock.calls[0]![0].prompt;
    expect(prompt).toBe(
      `Inspect.\n\n${contextNote('/workspace/.moca-context/runs/run-1', 'copy', '/workspace/run-1')}`,
    );
    expect(executeTurn.mock.calls[0]![0].sandbox?.config?.podCwd).toBe(
      '/workspace/.moca-context/runs/run-1',
    );
    expect(prompt).toContain('working directory');
    expect(prompt).toContain('writable');
    expect(prompt).toContain('discarded when the run ends');
    expect(prompt).toContain('diff or test output');
    expect(prompt).not.toContain('read-only');
    expect(
      transport.exec.mock.calls.some(([script]) => String(script).includes('CONTEXT_CLEANUP')),
    ).toBe(true);
  });

  it('refuses a non-boolean writable flag before touching the sandbox', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    const overlayContext = vi.fn();
    const r = await runLeaf(env(vi.fn(), 'yes'), undefined, { executeTurn, overlayContext });
    expect(r).toMatchObject({ status: 'failed', message: 'invalid internal context reference' });
    expect(overlayContext).not.toHaveBeenCalled();
    expect(executeTurn).not.toHaveBeenCalled();
    expect(transport.exec).not.toHaveBeenCalled();
  });

  it('selects with the workload key when the context names one, and without it otherwise', async () => {
    const WL = `w-${'a'.repeat(32)}`;
    const { lease } = relayLease();
    const overlayContext = vi.fn(async () => '/workspace/.moca-context/runs/run-1');
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const withWl = env(vi.fn());
    withWl.internalContext!.workload = WL;
    withWl.internalContext!.ownerScope = 'b'.repeat(32);
    await runLeaf(withWl, undefined, { executeTurn: okTurn(), overlayContext });
    expect(selectPoolSandboxMock.mock.calls[0]![3]).toMatchObject({
      workload: WL,
      ownerScope: 'b'.repeat(32),
    });
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    await runLeaf(env(vi.fn()), undefined, { executeTurn: okTurn(), overlayContext });
    expect(selectPoolSandboxMock.mock.calls[0]![3]).not.toHaveProperty('workload');
    expect(selectPoolSandboxMock.mock.calls[0]![3]).not.toHaveProperty('ownerScope');
  });

  it('sets agentWritesInContext iff the context is a copy or a writable mount', async () => {
    const WL = `w-${'a'.repeat(32)}`;
    const OWN = 'b'.repeat(32);
    const { lease } = relayLease();
    const overlayContext = vi.fn(async () => '/workspace/.moca-context/runs/run-1');
    type Mod = { writable?: boolean; mount?: 'read-only' | 'writable' };
    const cases: { label: string; patch: Mod; expected: boolean }[] = [
      { label: 'overlay read-only', patch: {}, expected: false },
      { label: 'overlay copy', patch: { writable: true }, expected: true },
      { label: 'mounted read-only, no writable', patch: { mount: 'read-only' }, expected: false },
      {
        label: 'mounted read-only, writable copy',
        patch: { mount: 'read-only', writable: true },
        expected: true,
      },
      { label: 'mounted persistent', patch: { mount: 'writable' }, expected: true },
    ];
    for (const { label, patch, expected } of cases) {
      selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
      const e = env(vi.fn());
      e.internalContext!.workload = WL;
      e.internalContext!.ownerScope = OWN;
      Object.assign(e.internalContext as Record<string, unknown>, patch);
      await runLeaf(e, undefined, { executeTurn: okTurn(), overlayContext });
      expect(selectPoolSandboxMock.mock.calls[0]![3], label).toMatchObject({
        agentWritesInContext: expected,
      });
    }
  });

  it('reports no attached workload sandbox as its own reason, never as a terminal error', async () => {
    const { WorkloadSandboxUnavailableError } = await import('../src/select-sandbox.js');
    const WL = `w-${'a'.repeat(32)}`;
    selectPoolSandboxMock.mockReset().mockRejectedValue(new WorkloadSandboxUnavailableError(WL));
    const e = env(vi.fn());
    e.internalContext!.workload = WL;
    e.internalContext!.ownerScope = 'b'.repeat(32);
    const r = await runLeaf(e, undefined, { executeTurn: okTurn(), overlayContext: vi.fn() });
    expect(r).toMatchObject({ status: 'failed', reason: 'workload_sandbox_unavailable' });
  });

  it('reports a deployment that can never serve a workload run as a terminal error, not retryable', async () => {
    const { WorkloadSandboxMisconfiguredError } = await import('../src/select-sandbox.js');
    const WL = `w-${'a'.repeat(32)}`;
    selectPoolSandboxMock
      .mockReset()
      .mockRejectedValue(
        new WorkloadSandboxMisconfiguredError(WL, 'workload sandboxes need the relay sandbox pool'),
      );
    const e = env(vi.fn());
    e.internalContext!.workload = WL;
    e.internalContext!.ownerScope = 'b'.repeat(32);
    const r = await runLeaf(e, undefined, { executeTurn: okTurn(), overlayContext: vi.fn() });
    expect(r).toMatchObject({ status: 'failed', reason: 'error' });
    expect((r as { message: string }).message).toContain('relay sandbox pool');
  });

  it('refuses a malformed workload key or owner scope, or one without the other, before selecting', async () => {
    selectPoolSandboxMock.mockReset();
    const WL = `w-${'a'.repeat(32)}`;
    const OWN = 'b'.repeat(32);
    for (const bad of [
      { workload: 'moca-sandbox', ownerScope: OWN },
      { workload: `w-${'A'.repeat(32)}`, ownerScope: OWN },
      { workload: 42, ownerScope: OWN },
      { workload: WL, ownerScope: 'B'.repeat(32) },
      { workload: WL, ownerScope: 'short' },
      { workload: WL },
      { ownerScope: OWN },
    ]) {
      const e = env(vi.fn());
      Object.assign(e.internalContext as Record<string, unknown>, bad);
      const r = await runLeaf(e, undefined, { executeTurn: okTurn(), overlayContext: vi.fn() });
      expect(r).toMatchObject({ status: 'failed', message: 'invalid internal context reference' });
    }
    expect(selectPoolSandboxMock).not.toHaveBeenCalled();
  });
});

describe('a workload on a non-prompt leaf', () => {
  it.each([
    [
      'solve',
      { kind: 'solve', problemStatement: 'Fix it.', repoUrl: 'https://x/r.git', ref: 'main' },
    ],
    ['verdict', { kind: undefined }],
    ['converge', { kind: 'converge' }],
  ] as const)(
    'refuses a %s leaf naming a workload before selecting, never falling back to the shared pool',
    async (_name, over) => {
      selectPoolSandboxMock.mockReset();
      const produceSolve = vi.fn();
      const produceVerdict = vi.fn();
      const e = { ...env(vi.fn()), ...over } as LeafEnvelope;
      e.internalContext!.workload = `w-${'a'.repeat(32)}`;
      e.internalContext!.ownerScope = 'b'.repeat(32);
      const r = await runLeaf(e, undefined, { produceSolve, produceVerdict });
      expect(r).toEqual({
        status: 'failed',
        reason: 'error',
        message: 'a workload sandbox runs prompt leaves only',
      });
      expect(produceSolve).not.toHaveBeenCalled();
      expect(produceVerdict).not.toHaveBeenCalled();
      expect(selectPoolSandboxMock).not.toHaveBeenCalled();
    },
  );

  it('still runs a solve leaf whose context names no workload', async () => {
    const produceSolve = vi.fn(async () => {});
    const e = {
      ...env(vi.fn()),
      kind: 'solve',
      problemStatement: 'Fix it.',
      repoUrl: 'https://x/r.git',
      ref: 'main',
    } as LeafEnvelope;
    expect(await runLeaf(e, undefined, { produceSolve })).toMatchObject({ status: 'solved' });
    expect(produceSolve).toHaveBeenCalledOnce();
  });
});

describe('a run on a mounted workload (workload sandboxes spec §5.3)', () => {
  const WL = `w-${'a'.repeat(32)}`;
  const mountedEnv = (mount: unknown, writable?: boolean) => {
    const e = env(vi.fn(), writable);
    Object.assign(e.internalContext!, { workload: WL, ownerScope: 'b'.repeat(32), mount });
    return e;
  };
  const scripts = (transport: ReturnType<typeof relayLease>['transport']) =>
    transport.exec.mock.calls.map(([script]) => String(script));

  it('starts in the mount, rooted at workspace/, and never copies or downloads the bundle', async () => {
    const { lease, transport } = relayLease();
    transport.exec.mockResolvedValueOnce({
      stdout: Buffer.from('/workspace/context/workspace'),
      exitCode: 0,
      truncated: false,
    });
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const overlayContext = vi.fn();
    const executeTurn = okTurn();
    const e = mountedEnv('read-only');
    const r = await runLeaf(e, undefined, { executeTurn, overlayContext });
    expect(r.status).toBe('responded');
    expect(overlayContext).not.toHaveBeenCalled();
    expect(e.internalContext!.loadBundle).not.toHaveBeenCalled();
    const [first] = scripts(transport);
    expect(first).toContain('# CONTEXT_MOUNTED');
    expect(first).toContain("CACHE='/workspace/context'");
    // The same root rule as a copied revision.
    expect(first).toContain('SRC="$CACHE/workspace"');
    const turn = executeTurn.mock.calls[0]![0];
    expect(turn.sandbox?.config?.podCwd).toBe('/workspace/context/workspace');
    expect(turn.prompt).toContain("is the workload's read-only context");
    // Nothing to clean up: no copy was made, and no cache ref taken.
    expect(scripts(transport).some((s) => /CONTEXT_(CLEANUP|MOUNTED_CLEANUP)/.test(s))).toBe(false);
  });

  it("a writable mount is the workload's own tree, and the run-level writable is a no-op on it", async () => {
    const { lease, transport } = relayLease();
    transport.exec.mockResolvedValueOnce({
      stdout: Buffer.from('/workspace/context'),
      exitCode: 0,
      truncated: false,
    });
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    await runLeaf(mountedEnv('writable', true), undefined, {
      executeTurn,
      overlayContext: vi.fn(),
    });
    expect(scripts(transport)[0]).not.toContain('cp -a');
    const prompt = executeTurn.mock.calls[0]![0].prompt;
    expect(prompt).toContain("the workload's own writable tree");
    expect(prompt).not.toContain('discarded');
  });

  it('the run-level writable on a read-only mount gives the run its own copy, removed at the end', async () => {
    const { lease, transport } = relayLease();
    transport.exec.mockResolvedValueOnce({
      stdout: Buffer.from('/workspace/.moca-context/runs/run-1'),
      exitCode: 0,
      truncated: false,
    });
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    await runLeaf(mountedEnv('read-only', true), undefined, {
      executeTurn,
      overlayContext: vi.fn(),
    });
    expect(scripts(transport)[0]).toContain('cp -a "$SRC" "$STAGE"');
    expect(executeTurn.mock.calls[0]![0].prompt).toContain('discarded when the run ends');
    expect(scripts(transport).some((s) => s.includes('# CONTEXT_MOUNTED_CLEANUP'))).toBe(true);
  });

  it('refuses a mount without a workload, or an unknown mode, before touching the sandbox', async () => {
    const noWorkload = env(vi.fn());
    Object.assign(noWorkload.internalContext!, { mount: 'read-only' });
    for (const e of [noWorkload, mountedEnv('rw')]) {
      const { lease, transport } = relayLease();
      selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
      const r = await runLeaf(e, undefined, { executeTurn: okTurn(), overlayContext: vi.fn() });
      expect(r).toMatchObject({ status: 'failed', message: 'invalid internal context reference' });
      expect(transport.exec).not.toHaveBeenCalled();
    }
  });

  it('a missing mount fails the run as an overlay failure', async () => {
    const { lease, transport } = relayLease();
    transport.exec.mockResolvedValueOnce({
      stdout: Buffer.from(''),
      exitCode: 1,
      truncated: false,
    });
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    const r = await runLeaf(mountedEnv('read-only'), undefined, {
      executeTurn,
      overlayContext: vi.fn(),
    });
    expect(r).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('context overlay failed'),
    });
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
