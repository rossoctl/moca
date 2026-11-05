import { describe, expect, it, vi, beforeEach } from 'vitest';

const { attachMock, detachMock, FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read() {
      return [];
    }
    async latestWhere() {
      return null;
    }
    async append() {
      return {};
    }
    async list() {
      return [];
    }
    async close() {}
  }
  const detachMock = vi.fn(async () => {});
  const attachMock = vi.fn(async (..._args: unknown[]) => ({
    promotedConfig: { digest: 'd' },
    detach: detachMock,
  }));
  return { attachMock, detachMock, FakeRedisSessionBackend };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
  resilientClientOptions: (url: string) => ({ url }),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  // No reload(): the core fails right after the attach point, which is all these tests need.
  DefaultResourceLoader: class {},
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 'opened-1' }),
    openFromCheckpoint: async () => ({ getSessionId: () => 'opened-1' }),
  },
  SettingsManager: { create: () => ({}) },
}));
vi.mock('../src/promoted-config.js', () => ({
  attachPromotedConfig: (...args: unknown[]) => attachMock(...args),
}));
const { loaderOptionsSpy, selectMock } = vi.hoisted(() => ({
  loaderOptionsSpy: vi.fn(),
  selectMock: vi.fn(),
}));
vi.mock('../src/config-resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config-resolver.js')>();
  return {
    ...real,
    promotedLoaderOptions: (...args: Parameters<typeof real.promotedLoaderOptions>) => {
      loaderOptionsSpy(...args);
      return real.promotedLoaderOptions(...args);
    },
  };
});
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return {
    ...real,
    selectPoolSandbox: (...args: unknown[]) =>
      selectMock.getMockImplementation()
        ? selectMock(...args)
        : real.selectPoolSandbox(...(args as Parameters<typeof real.selectPoolSandbox>)),
  };
});

const { executeTurn } = await import('../src/run-turn.js');
const digest = 'sha256:' + 'c'.repeat(64);
const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
};
const sandbox = { transport: fakeTransport, podCwd: '/workspace', sandboxId: 'sb-1' };

beforeEach(() => {
  attachMock.mockClear();
  detachMock.mockReset();
  detachMock.mockImplementation(async () => {});
  loaderOptionsSpy.mockClear();
  selectMock.mockReset();
});

describe('executeTurn configRef', () => {
  it('attaches the bundle to the turn sandbox and detaches even when the turn throws', async () => {
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
      }),
    ).rejects.toThrow();
    expect(attachMock).toHaveBeenCalledWith(
      expect.objectContaining({
        digest,
        sessionId: 'opened-1',
        sandbox: expect.objectContaining({ transport: sandbox.transport }),
      }),
    );
    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  it('gives every turn its own ref on the digest, distinct from the session id', async () => {
    const turn = () =>
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
      }).catch(() => {});
    await turn();
    await turn();
    const refIds = attachMock.mock.calls.map((c) => (c[0] as { refId?: string }).refId);
    expect(refIds).toHaveLength(2);
    for (const refId of refIds) expect(refId).toMatch(/^opened-1\.[0-9a-f]{32}$/);
    expect(refIds[0]).not.toBe(refIds[1]);
  });

  it('a failing detach does not replace the turn outcome', async () => {
    detachMock.mockRejectedValueOnce(new Error('detach boom'));
    const err = await executeTurn({
      prompt: 'hi',
      sessionId: 'sess-1',
      createIfAbsent: true,
      sandbox,
      configRef: digest,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe('detach boom');
  });

  it('does nothing without a configRef', async () => {
    await expect(
      executeTurn({ prompt: 'hi', sessionId: 'sess-1', createIfAbsent: true, sandbox }),
    ).rejects.toThrow();
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('leaves a pre-resolved promotedConfig (the /runs path) alone', async () => {
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        configRef: digest,
        promotedConfig: { digest } as never,
      }),
    ).rejects.toThrow();
    expect(attachMock).not.toHaveBeenCalled();
  });
});

describe('executeTurn hands the attached bundle to the turn core', () => {
  it('builds the resource loader from attached.promotedConfig', async () => {
    await executeTurn({
      prompt: 'hi',
      sessionId: 'sess-1',
      createIfAbsent: true,
      sandbox,
      configRef: digest,
    }).catch(() => {});
    expect(loaderOptionsSpy).toHaveBeenCalledWith({ digest: 'd' });
  });

  it('builds it with no promoted config when there is no configRef', async () => {
    await executeTurn({ prompt: 'hi', sessionId: 'sess-1', createIfAbsent: true, sandbox }).catch(
      () => {},
    );
    expect(loaderOptionsSpy).toHaveBeenCalledWith(undefined);
  });
});

describe('executeTurn lease renewal around detach', () => {
  it('keeps renewing the lease until the remote detach has finished, then releases', async () => {
    const order: string[] = [];
    selectMock.mockImplementation(async () => ({
      transport: fakeTransport,
      podCwd: '/workspace',
      sandboxId: 'sb-1',
      heartbeat: async () => {},
      release: async () => void order.push('release'),
    }));
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      detachMock.mockImplementation(async () => {
        const handle = setSpy.mock.results.at(-1)?.value;
        order.push(
          clearSpy.mock.calls.some(([h]) => h === handle) ? 'detach:cleared' : 'detach:armed',
        );
      });
      await executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        configRef: digest,
        config: { cwd: process.cwd() } as never,
      }).catch(() => {});
      expect(setSpy).toHaveBeenCalled();
      expect(order).toEqual(['detach:armed', 'release']);
      expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results.at(-1)?.value);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
