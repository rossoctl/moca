import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * SH_PROMPT_CACHE / SH_GATEWAY_CACHE reach a real turn's stack (#754).
 *
 * prompt-cache-extension.test.ts drives the extension on its own; this pins the WIRING: executeTurn
 * builds the resource loader from extensionFactories, the fake loader below records them, and every
 * factory is then run against a fake `pi` so that the before_provider_request handlers the turn
 * would install are applied, in order, to a provider payload -- the same chain pi's onPayload runs.
 * In server mode on purpose: MI1 R4's noExtensions must not switch these off.
 */
const { loaderOpts, FakeRedisSessionBackend } = vi.hoisted(() => {
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
  return { loaderOpts: [] as Array<Record<string, unknown>>, FakeRedisSessionBackend };
});

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
  resilientClientOptions: (url: string) => ({ url }),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({ session: { prompt: async () => {} } }),
  // Records its options, and has no reload(): the turn fails right after the loader is built,
  // which is all this test needs.
  DefaultResourceLoader: class {
    constructor(opts: Record<string, unknown>) {
      loaderOpts.push(opts);
    }
  },
  getAgentDir: () => '/fake/agent-dir',
  SessionManager: {
    create: () => ({ getSessionId: () => 'opened-1' }),
    openFromCheckpoint: async () => ({ getSessionId: () => 'opened-1' }),
  },
  SettingsManager: { create: () => ({}) },
}));

// The sandbox tools need pi's real tool builders, which the mock above leaves out; their
// extension registers no payload handler, so a no-op factory stands in for it. Spread the real
// module: run-turn.ts also imports createCapacityLatch from it (#452).
vi.mock('@moca/k8s-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@moca/k8s-sandbox')>()),
  k8sSandboxExtension: () => () => {},
}));

const { executeTurn } = await import('../src/run-turn.js');

type Handler = (e: { type: string; payload: unknown }) => unknown;

/** Run every factory against a fake pi; collect the before_provider_request handlers in order. */
async function providerRequestHandlers(factories: unknown[]): Promise<Handler[]> {
  const handlers: Handler[] = [];
  const pi = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'on'
          ? (event: string, h: Handler) => {
              if (event === 'before_provider_request') handlers.push(h);
            }
          : () => undefined,
    },
  );
  for (const f of factories) await (f as (pi: unknown) => unknown)(pi);
  return handlers;
}

/** What pi's onPayload does: each handler's non-undefined return replaces the payload. */
async function send(handlers: Handler[], payload: unknown): Promise<unknown> {
  let cur = payload;
  for (const h of handlers) {
    const r = await h({ type: 'before_provider_request', payload: cur });
    if (r !== undefined) cur = r;
  }
  return cur;
}

const EPHEMERAL = { type: 'ephemeral' };
// The shape pi-ai's Anthropic buildParams produces, markers included.
const anthropicPayload = () => ({
  model: 'claude-test',
  max_tokens: 1024,
  stream: true,
  system: [{ type: 'text', text: 'You are a coding agent.', cache_control: EPHEMERAL }],
  tools: [{ name: 'bash', input_schema: { type: 'object' }, cache_control: EPHEMERAL }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'fix the bug', cache_control: EPHEMERAL }] },
  ],
});

const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
};
const sandbox = { transport: fakeTransport, podCwd: '/workspace', sandboxId: 'sb-1' };

/** The payload one model request of a server-mode turn would carry, given the switches. */
async function turnPayload(): Promise<unknown> {
  loaderOpts.length = 0;
  await executeTurn({
    prompt: 'hi',
    sessionId: 'sess-1',
    createIfAbsent: true,
    sandbox,
    config: { serverMode: true },
  }).catch(() => {});
  expect(loaderOpts).toHaveLength(1);
  expect(loaderOpts[0]).toMatchObject({ noExtensions: true });
  const handlers = await providerRequestHandlers(loaderOpts[0].extensionFactories as unknown[]);
  return send(handlers, anthropicPayload());
}

const NAMES = ['SH_PROMPT_CACHE', 'SH_GATEWAY_CACHE', 'SH_MODEL_CUSTOM'] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES)
    saved[n] === undefined ? delete process.env[n] : (process.env[n] = saved[n]);
});

describe('executeTurn: the caching switches (#754)', () => {
  it('both unset: the request payload is exactly what the provider built', async () => {
    const out = await turnPayload();
    expect(JSON.stringify(out)).toBe(JSON.stringify(anthropicPayload()));
  });

  it('SH_PROMPT_CACHE=off: no cache_control marker reaches the request, nothing else changes', async () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const out = (await turnPayload()) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('cache_control');
    expect(out).not.toHaveProperty('cache');
    expect(out.system).toEqual([{ type: 'text', text: 'You are a coding agent.' }]);
  });

  it('SH_GATEWAY_CACHE=off: the request carries cache.no-cache and keeps its markers', async () => {
    process.env.SH_GATEWAY_CACHE = 'off';
    const out = (await turnPayload()) as Record<string, unknown>;
    expect(out.cache).toEqual({ 'no-cache': true });
    const { cache: _cache, ...rest } = out;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(anthropicPayload()));
  });

  it('a refused value fails the turn before any model work', async () => {
    process.env.SH_GATEWAY_CACHE = 'OFF';
    loaderOpts.length = 0;
    await expect(
      executeTurn({
        prompt: 'hi',
        sessionId: 'sess-1',
        createIfAbsent: true,
        sandbox,
        config: { serverMode: true },
      }),
    ).rejects.toThrow(/SH_GATEWAY_CACHE must be "off", "on" or unset/);
    expect(loaderOpts).toHaveLength(0);
  });
});
