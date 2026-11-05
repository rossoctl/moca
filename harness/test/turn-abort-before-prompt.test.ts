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
    createAgentSession: vi.fn(async () => ({
      session: {
        prompt: vi.fn(async () => {}),
        abort: vi.fn(() => {}),
        state: { messages: [] },
        model: { contextWindow: 100000 },
        settingsManager: {
          getCompactionSettings: () => ({
            enabled: true,
            reserveTokens: 1000,
            keepRecentTokens: 500,
          }),
        },
        compact: vi.fn(async () => ({})),
        abortCompaction: vi.fn(() => {}),
      },
    })),
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

vi.mock('../src/pre-prompt-compaction.js', () => ({
  compactIfOverflowing: vi.fn(async () => false),
}));

// The fake SessionManager above has no entries API; model-switch-record has its own test.
vi.mock('../src/model-switch-record.js', () => ({
  recordModelSwitch: vi.fn(() => false),
}));

const { executeTurn } = await import('../src/run-turn.js');

const nullSandbox = undefined;

beforeEach(() => {
  createAgentSession.mockClear();
});

describe('turn abort before prompt', () => {
  it('when signal is already aborted, skips prompt and returns aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeTurn({
      prompt: 'hello',
      sessionId: 's1',
      createIfAbsent: true,
      config: { allowLocalTools: true },
      sandbox: nullSandbox,
      signal: controller.signal,
    });

    const sessionCall = createAgentSession.mock.results[0];
    const session = (await sessionCall.value).session as any;

    expect(session.prompt).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).toBe('Request aborted');
  });

  it('when no signal, calls prompt normally (control)', async () => {
    const result = await executeTurn({
      prompt: 'hello',
      sessionId: 's1',
      createIfAbsent: true,
      config: { allowLocalTools: true },
      sandbox: nullSandbox,
    });

    const sessionCall = createAgentSession.mock.results[0];
    const session = (await sessionCall.value).session as any;

    expect(session.prompt).toHaveBeenCalledOnce();
  });
});
