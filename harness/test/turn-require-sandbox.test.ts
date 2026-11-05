import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createAgentSession, FakeRedisSessionBackend } = vi.hoisted(() => {
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
  return {
    createAgentSession: vi.fn(async () => ({ session: { prompt: async () => {} } })),
    FakeRedisSessionBackend,
  };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 's1' }),
    openFromCheckpoint: async () => {
      throw new Error('no session in backend');
    },
  },
  SettingsManager: { create: () => ({}) },
}));

const { executeTurn } = await import('../src/run-turn.js');
const { SandboxRequiredError } = await import('../src/select-sandbox.js');

const nullSandbox = undefined;

beforeEach(() => createAgentSession.mockClear());

describe('a server-mode turn with no resolvable sandbox (MI1 R3)', () => {
  it('fails with SandboxRequiredError and never creates a session', async () => {
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 's1',
        createIfAbsent: true,
        config: { serverMode: true },
        sandbox: nullSandbox,
      }),
    ).rejects.toBeInstanceOf(SandboxRequiredError);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it('the error carries its name marker, so a caller can tell it from any other turn failure', async () => {
    const err = await executeTurn({
      prompt: 'hi',
      sessionId: 's1',
      createIfAbsent: true,
      config: { serverMode: true },
      sandbox: nullSandbox,
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SandboxRequiredError');
  });

  it('with allowLocalTools the turn proceeds (explicit single-tenant development opt-in)', async () => {
    await executeTurn({
      prompt: 'hi',
      sessionId: 's1',
      createIfAbsent: true,
      config: { serverMode: true, allowLocalTools: true },
      sandbox: nullSandbox,
    }).catch(() => {});
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it('outside server mode (the CLI) the turn proceeds, as today', async () => {
    await executeTurn({
      prompt: 'hi',
      sessionId: 's1',
      createIfAbsent: true,
      sandbox: nullSandbox,
    }).catch(() => {});
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });
});
