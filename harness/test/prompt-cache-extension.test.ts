import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bypassGatewayCache,
  promptCacheExtension,
  readCacheSwitches,
  stripCacheControl,
} from '../src/prompt-cache-extension';

type Handler = (e: { payload?: unknown }) => unknown;

// Minimal fake `pi` that captures the before_provider_request handler the extension registers.
function makePi(): { pi: unknown; getHandler: () => Handler | undefined } {
  let handler: Handler | undefined;
  const pi = {
    on: (_event: string, h: Handler) => {
      handler = h;
    },
  };
  return { pi, getHandler: () => handler };
}

const EPHEMERAL = { type: 'ephemeral' };

// The shape pi-ai's Anthropic buildParams produces: a marked system block, a marked last tool,
// and a marked last block of the final user message (here a tool_result with nested content).
function anthropicPayload() {
  return {
    model: 'claude-test',
    system: [{ type: 'text', text: 'You are…', cache_control: EPHEMERAL }],
    tools: [
      {
        name: 'read',
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
      { name: 'bash', input_schema: { type: 'object' }, cache_control: EPHEMERAL },
    ],
    messages: [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'ok', cache_control: EPHEMERAL }],
            cache_control: EPHEMERAL,
          },
        ],
      },
    ],
  };
}

// The OpenAI-compatible provider's shape when its compat flags ask for Anthropic-style markers:
// a marked last tool and a marked text part.
function openaiPayload() {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: EPHEMERAL }] },
    ],
    tools: [{ type: 'function', function: { name: 'bash' }, cache_control: EPHEMERAL }],
  };
}

const NAMES = ['SH_PROMPT_CACHE', 'SH_GATEWAY_CACHE'] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES)
    saved[n] === undefined ? delete process.env[n] : (process.env[n] = saved[n]);
  vi.restoreAllMocks();
});

describe('readCacheSwitches', () => {
  it('reads unset, blank and "on" as today (caching on), and "off" as off', () => {
    expect(readCacheSwitches({})).toEqual({ promptOff: false, gatewayOff: false });
    expect(readCacheSwitches({ SH_PROMPT_CACHE: '', SH_GATEWAY_CACHE: 'on' })).toEqual({
      promptOff: false,
      gatewayOff: false,
    });
    expect(readCacheSwitches({ SH_PROMPT_CACHE: 'off' })).toEqual({
      promptOff: true,
      gatewayOff: false,
    });
    expect(readCacheSwitches({ SH_GATEWAY_CACHE: 'off' })).toEqual({
      promptOff: false,
      gatewayOff: true,
    });
  });

  it('refuses any other value, naming the switch', () => {
    for (const v of ['OFF', 'Off', ' off', 'false', '0', 'none', 'disabled']) {
      expect(() => readCacheSwitches({ SH_PROMPT_CACHE: v }), v).toThrow(
        /^SH_PROMPT_CACHE must be "off", "on" or unset/,
      );
      expect(() => readCacheSwitches({ SH_GATEWAY_CACHE: v }), v).toThrow(
        /^SH_GATEWAY_CACHE must be "off", "on" or unset/,
      );
    }
  });
});

describe('promptCacheExtension', () => {
  it('is inert (registers no handler) with both switches unset, blank or "on"', () => {
    for (const v of [undefined, '', 'on']) {
      for (const n of NAMES) v === undefined ? delete process.env[n] : (process.env[n] = v);
      const { pi, getHandler } = makePi();
      promptCacheExtension()(pi as never);
      expect(getHandler(), `both=${v}`).toBeUndefined();
    }
  });

  it('throws when it is built, not when pi runs it, on a refused value', () => {
    // pi records a factory's throw as a load error and carries on; building it must be what fails.
    process.env.SH_PROMPT_CACHE = 'OFF';
    expect(() => promptCacheExtension()).toThrow(/SH_PROMPT_CACHE/);
  });

  it('removes every cache_control marker from an Anthropic payload', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    const out = getHandler()!({ payload: anthropicPayload() }) as Record<string, unknown>;
    // The marker's own shape: the schema property `cache_control: {type: "string"}` is kept on
    // purpose.
    expect(JSON.stringify(out)).not.toMatch(/"cache_control":\{"type":"ephemeral"/);
    expect(out).not.toHaveProperty('cache');
  });

  it('removes the markers from an OpenAI-compatible payload too', () => {
    const p = openaiPayload();
    expect(stripCacheControl(p)).toBe(2);
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('keeps a tool schema property named cache_control', () => {
    const p = anthropicPayload();
    stripCacheControl(p);
    expect(p.tools[0].input_schema.properties).toHaveProperty('cache_control');
  });

  it('counts the markers it removed, and leaves everything else as it was', () => {
    const p = anthropicPayload();
    expect(stripCacheControl(p)).toBe(4); // system, last tool, tool_result, its nested text block
    expect(p.messages[0].content).toBe('fix the bug');
    expect(p.system[0]).toEqual({ type: 'text', text: 'You are…' });
    expect(stripCacheControl(p)).toBe(0);
  });

  it('ignores a payload without messages, system or tools', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    expect(getHandler()!({ payload: { model: 'm' } })).toEqual({ model: 'm' });
    expect(getHandler()!({})).toBeUndefined();
  });

  it('logs once, on the first request', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    getHandler()!({ payload: anthropicPayload() });
    getHandler()!({ payload: anthropicPayload() });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/removed 4 cache_control marker/);
  });

  it('SH_GATEWAY_CACHE=off adds cache.no-cache and leaves the prompt-cache markers alone', () => {
    process.env.SH_GATEWAY_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    const out = getHandler()!({ payload: anthropicPayload() }) as Record<string, unknown>;
    expect(out.cache).toEqual({ 'no-cache': true });
    const { cache: _cache, ...rest } = out;
    expect(rest).toEqual(anthropicPayload());
  });

  it('both switches together strip the markers and add no-cache', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    process.env.SH_GATEWAY_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    const out = getHandler()!({ payload: anthropicPayload() }) as Record<string, unknown>;
    expect(out.cache).toEqual({ 'no-cache': true });
    expect(JSON.stringify(out)).not.toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('reads an explicit env when one is given, not process.env', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension({})(pi as never);
    expect(getHandler()).toBeUndefined();
  });
});

describe('bypassGatewayCache', () => {
  it('keeps an existing cache object and only adds no-cache', () => {
    const p: Record<string, unknown> = { cache: { ttl: 60 } };
    bypassGatewayCache(p);
    expect(p.cache).toEqual({ ttl: 60, 'no-cache': true });
  });
  it('overrides an existing no-cache: false', () => {
    const p: Record<string, unknown> = { cache: { 'no-cache': false, ttl: 60 } };
    bypassGatewayCache(p);
    expect(p.cache).toEqual({ ttl: 60, 'no-cache': true });
  });
  it('replaces a non-object cache value', () => {
    for (const v of ['x', 1, null, ['a']]) {
      const p: Record<string, unknown> = { cache: v };
      bypassGatewayCache(p);
      expect(p.cache, JSON.stringify(v)).toEqual({ 'no-cache': true });
    }
  });
});
