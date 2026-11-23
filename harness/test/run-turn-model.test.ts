import { describe, it, expect } from 'vitest';
import {
  resolveModelSelection,
  requireModel,
  sessionModelFor,
  ModelConfigError,
} from '../src/run-turn';

describe('resolveModelSelection', () => {
  it('defaults to anthropic / claude-opus-4-8 when nothing is set', () => {
    expect(resolveModelSelection(undefined, {})).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });

  it('reads env when config is absent', () => {
    expect(
      resolveModelSelection(undefined, { SH_MODEL_PROVIDER: 'openai', SH_MODEL: 'gpt-x' }),
    ).toEqual({ provider: 'openai', modelId: 'gpt-x' });
  });

  it('config overrides env and defaults', () => {
    expect(
      resolveModelSelection(
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { SH_MODEL_PROVIDER: 'openai', SH_MODEL: 'gpt-x' },
      ),
    ).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
  });

  it('mixes config and env per-field', () => {
    expect(resolveModelSelection({ model: 'm1' }, { SH_MODEL_PROVIDER: 'p1' })).toEqual({
      provider: 'p1',
      modelId: 'm1',
    });
  });
});

describe('requireModel', () => {
  it('returns the model for a known anthropic id', () => {
    const m = requireModel('anthropic', 'claude-opus-4-8');
    expect((m as { id: string }).id).toBe('claude-opus-4-8');
  });

  it('throws a clear error for a known provider but unknown model id (dot-vs-dash trap)', () => {
    // 'claude-sonnet-4.6' (dot) is a github-copilot key, not anthropic; the anthropic id is the dash form.
    expect(() => requireModel('anthropic', 'claude-sonnet-4.6')).toThrowError(
      /Unknown model "anthropic\/claude-sonnet-4\.6".*claude-sonnet-4-6/s,
    );
  });

  it('throws naming valid providers when the provider is unknown', () => {
    expect(() => requireModel('litellm', 'whatever')).toThrowError(
      /Unknown model provider "litellm".*anthropic/s,
    );
  });

  it('classifies the sibling config mistakes as ModelConfigError too', () => {
    // An unknown provider or SH_MODEL_API is the same operator mistake as an unknown id; before
    // they were plain Errors and /turn answered a bare 500 internal_error for each.
    expect(() => requireModel('litellm', 'whatever')).toThrowError(ModelConfigError);
    expect(() =>
      requireModel('anthropic', 'm', { SH_MODEL_CUSTOM: '1', SH_MODEL_API: 'openai-responses' }),
    ).toThrowError(ModelConfigError);
    expect(() =>
      requireModel('anthropic', 'm', { SH_MODEL_CUSTOM: '1', SH_MODEL_API: 'bogus' }),
    ).toThrowError(ModelConfigError);
  });

  it('suggests SH_MODEL_CUSTOM when a custom endpoint is configured', () => {
    // A gateway id the registry has never heard of is the common case behind this throw; the
    // hint is the one-line fix (set SH_MODEL_CUSTOM=1), or the detour is a code read.
    expect(() =>
      requireModel('anthropic', 'claude-sonnet-9-9', {
        ANTHROPIC_BASE_URL: 'https://gateway.example',
      }),
    ).toThrowError(/set SH_MODEL_CUSTOM=1 to send this id to it as-is/);
  });

  it('omits the SH_MODEL_CUSTOM hint when no custom endpoint is configured', () => {
    // Anchored past the registry sentence: the hint (Known ids / Did you mean) follows directly,
    // with no custom-endpoint sentence in between.
    expect(() => requireModel('anthropic', 'claude-sonnet-9-9', {})).toThrowError(
      /^Unknown model "anthropic\/claude-sonnet-9-9" — not in the pi-ai registry\. (Known|Did you mean)/,
    );
  });

  it('suppresses the hint when the caller pins the lookup to no custom endpoint', () => {
    // The api.anthropic.com session path: env names a gateway, but that branch deletes
    // SH_MODEL_CUSTOM, so suggesting it there suggests a knob that cannot fix the failure.
    expect(() =>
      requireModel('anthropic', 'claude-sonnet-9-9', { ANTHROPIC_BASE_URL: 'https://gw' }, false),
    ).toThrowError(
      /^Unknown model "anthropic\/claude-sonnet-9-9" — not in the pi-ai registry\. (Known|Did you mean)/,
    );
  });

  it('caps the id so the remedy stays inside the 500-char body budget', () => {
    // SH_MODEL has no length validation; an unbounded id would push the remedy past /turn's
    // 500-char slice of the message.
    expect(() =>
      requireModel('anthropic', 'x'.repeat(400), { ANTHROPIC_BASE_URL: 'https://g.example' }),
    ).toThrowError(/set SH_MODEL_CUSTOM=1 to send this id to it as-is/);
  });
});

describe('requireModel with SH_MODEL_CUSTOM (self-hosted endpoint)', () => {
  it('requires a base URL (SH_MODEL_BASE_URL or ANTHROPIC_BASE_URL) when SH_MODEL_CUSTOM=1', () => {
    expect(() =>
      requireModel('anthropic', 'meta-llama/Llama-3.3-70B-Instruct', { SH_MODEL_CUSTOM: '1' }),
    ).toThrowError(
      /SH_MODEL_CUSTOM=1 \(anthropic\) requires SH_MODEL_BASE_URL or ANTHROPIC_BASE_URL/,
    );
  });

  it('synthesizes an anthropic-messages model from SH_MODEL + ANTHROPIC_BASE_URL', () => {
    const m = requireModel('anthropic', 'meta-llama/Llama-3.3-70B-Instruct', {
      SH_MODEL_CUSTOM: '1',
      ANTHROPIC_BASE_URL: 'http://vllm.my-ns.svc:8000',
    }) as {
      id: string;
      name: string;
      api: string;
      provider: string;
      baseUrl: string;
      contextWindow: number;
      maxTokens: number;
    };
    expect(m.id).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(m.name).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(m.api).toBe('anthropic-messages');
    expect(m.baseUrl).toBe('http://vllm.my-ns.svc:8000');
    // provider defaults to "anthropic" so pi's key lookup resolves ANTHROPIC_API_KEY.
    expect(m.provider).toBe('anthropic');
    // Conservative defaults when overrides are unset.
    expect(m.contextWindow).toBe(131072);
    expect(m.maxTokens).toBe(8192);
  });

  it('honors SH_MODEL_PROVIDER / SH_MODEL_CONTEXT_WINDOW / SH_MODEL_MAX_TOKENS overrides', () => {
    const m = requireModel('anthropic', 'some/model', {
      SH_MODEL_CUSTOM: '1',
      ANTHROPIC_BASE_URL: 'http://endpoint:8000',
      SH_MODEL_PROVIDER: 'vllm',
      SH_MODEL_CONTEXT_WINDOW: '65536',
      SH_MODEL_MAX_TOKENS: '4096',
    }) as { provider: string; contextWindow: number; maxTokens: number };
    expect(m.provider).toBe('vllm');
    expect(m.contextWindow).toBe(65536);
    expect(m.maxTokens).toBe(4096);
  });

  it('defaults to the anthropic protocol when SH_MODEL_API is unset (back-compat)', () => {
    const m = requireModel('anthropic', 'some/model', {
      SH_MODEL_CUSTOM: '1',
      ANTHROPIC_BASE_URL: 'http://endpoint:8000',
    }) as { api: string; provider: string };
    expect(m.api).toBe('anthropic-messages');
    expect(m.provider).toBe('anthropic');
  });
});

describe('requireModel with SH_MODEL_API=openai-completions (OpenAI-compatible endpoints)', () => {
  it('synthesizes an openai-completions model from SH_MODEL + SH_MODEL_BASE_URL + headers', () => {
    const m = requireModel('openai', 'moonshotai/Kimi-K2.7-Code', {
      SH_MODEL_CUSTOM: '1',
      SH_MODEL_API: 'openai-completions',
      SH_MODEL_BASE_URL: 'https://rits.example/kimi/v1',
      SH_MODEL_HEADERS: '{"RITS_API_KEY":"abc123"}',
      OPENAI_API_KEY: 'present', // avoid the placeholder seed for bearer default
    }) as {
      id: string;
      api: string;
      provider: string;
      baseUrl: string;
      headers: Record<string, string | null>;
    };
    expect(m.id).toBe('moonshotai/Kimi-K2.7-Code');
    expect(m.api).toBe('openai-completions');
    // provider defaults to "openai" so pi's key lookup resolves OPENAI_API_KEY.
    expect(m.provider).toBe('openai');
    expect(m.baseUrl).toBe('https://rits.example/kimi/v1');
    expect(m.headers.RITS_API_KEY).toBe('abc123');
  });

  it('falls back to OPENAI_BASE_URL when SH_MODEL_BASE_URL is unset', () => {
    const m = requireModel('openai', 'm', {
      SH_MODEL_CUSTOM: '1',
      SH_MODEL_API: 'openai-completions',
      OPENAI_BASE_URL: 'https://vllm.svc/v1',
      OPENAI_API_KEY: 'present',
    }) as { baseUrl: string };
    expect(m.baseUrl).toBe('https://vllm.svc/v1');
  });

  it('custom-header auth strips the default Authorization Bearer, keeping the custom header', () => {
    const m = requireModel('openai', 'm', {
      SH_MODEL_CUSTOM: '1',
      SH_MODEL_API: 'openai-completions',
      SH_MODEL_BASE_URL: 'https://rits.example/v1',
      SH_MODEL_AUTH: 'custom-header',
      SH_MODEL_HEADERS: '{"RITS_API_KEY":"abc123"}',
      OPENAI_API_KEY: 'present', // present ⇒ no global process.env seed side-effect in this test
    }) as { headers: Record<string, string | null> };
    expect(m.headers.Authorization).toBeNull();
    expect(m.headers.RITS_API_KEY).toBe('abc123');
  });

  it('interpolates ${VAR} in header values from env (secretKeyRef indirection)', () => {
    const m = requireModel('openai', 'm', {
      SH_MODEL_CUSTOM: '1',
      SH_MODEL_API: 'openai-completions',
      SH_MODEL_BASE_URL: 'https://rits.example/v1',
      SH_MODEL_AUTH: 'custom-header',
      SH_MODEL_HEADERS: '{"RITS_API_KEY":"${RITS_API_KEY}"}',
      RITS_API_KEY: 'secret-from-secretkeyref',
      OPENAI_API_KEY: 'present',
    }) as { headers: Record<string, string | null> };
    expect(m.headers.RITS_API_KEY).toBe('secret-from-secretkeyref');
    expect(m.headers.Authorization).toBeNull();
  });

  it('requires SH_MODEL_BASE_URL or OPENAI_BASE_URL', () => {
    expect(() =>
      requireModel('openai', 'm', { SH_MODEL_CUSTOM: '1', SH_MODEL_API: 'openai-completions' }),
    ).toThrowError(/requires SH_MODEL_BASE_URL or OPENAI_BASE_URL/);
  });

  it('rejects malformed SH_MODEL_HEADERS', () => {
    expect(() =>
      requireModel('openai', 'm', {
        SH_MODEL_CUSTOM: '1',
        SH_MODEL_API: 'openai-completions',
        SH_MODEL_BASE_URL: 'https://x/v1',
        SH_MODEL_HEADERS: 'not-json',
        OPENAI_API_KEY: 'present',
      }),
    ).toThrowError(/SH_MODEL_HEADERS must be a JSON object/);
  });
});

describe('requireModel SH_MODEL_API validation', () => {
  it("throws 'not yet implemented' for openai-responses (deferred)", () => {
    expect(() =>
      requireModel('openai', 'm', {
        SH_MODEL_CUSTOM: '1',
        SH_MODEL_API: 'openai-responses',
        SH_MODEL_BASE_URL: 'https://x/v1',
      }),
    ).toThrowError(/openai-responses is not yet implemented/);
  });

  it('throws a clear error for an unknown SH_MODEL_API', () => {
    expect(() =>
      requireModel('openai', 'm', {
        SH_MODEL_CUSTOM: '1',
        SH_MODEL_API: 'grpc-magic',
        SH_MODEL_BASE_URL: 'https://x/v1',
      }),
    ).toThrowError(/Unknown SH_MODEL_API "grpc-magic"/);
  });
});

describe('sessionModelFor (per-session model spec §5.2)', () => {
  const lite = 'https://litellm.internal';

  it('takes a direct Anthropic model from the registry, ignoring the limits and SH_MODEL_CUSTOM', () => {
    const m = sessionModelFor(
      { id: 'claude-opus-4-8', contextWindow: 1000 },
      'https://api.anthropic.com',
      { SH_MODEL_CUSTOM: '1' },
    ) as { id: string; contextWindow: number; baseUrl: string };
    const registry = requireModel('anthropic', 'claude-opus-4-8', {}) as { contextWindow: number };
    expect(m.id).toBe('claude-opus-4-8');
    expect(m.contextWindow).toBe(registry.contextWindow);
  });

  it('synthesizes a gateway model from the limits, without SH_MODEL_CUSTOM', () => {
    const m = sessionModelFor(
      {
        id: 'meta-llama/Llama-3.1-8B-Instruct',
        contextWindow: 32000,
        maxTokens: 4096,
        reasoning: true,
        vision: true,
      },
      lite,
      {},
    ) as {
      id: string;
      api: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      input: string[];
    };
    expect(m).toMatchObject({
      id: 'meta-llama/Llama-3.1-8B-Instruct',
      api: 'anthropic-messages',
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: true,
    });
    expect(m.input).toEqual(['text', 'image']);
  });

  it('falls back to the environment limits, then the defaults, field by field', () => {
    const m = sessionModelFor({ id: 'x', maxTokens: 2048 }, lite, {
      SH_MODEL_CONTEXT_WINDOW: '64000',
    }) as { contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] };
    expect(m.contextWindow).toBe(64000);
    expect(m.maxTokens).toBe(2048);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(['text']);
    const d = sessionModelFor({ id: 'x' }, lite, {}) as {
      contextWindow: number;
      maxTokens: number;
    };
    expect(d.contextWindow).toBe(131072);
    expect(d.maxTokens).toBe(8192);
  });

  it('honours a deployment-wide SH_MODEL_API', () => {
    const m = sessionModelFor({ id: 'x' }, lite, {
      SH_MODEL_API: 'openai-completions',
      OPENAI_API_KEY: 'k', // notsecret
    }) as { api: string };
    expect(m.api).toBe('openai-completions');
  });

  it('names the unknown id for a direct Anthropic model pi does not know', () => {
    expect(() => sessionModelFor({ id: 'claude-nope' }, 'https://api.anthropic.com', {})).toThrow(
      /Unknown model "anthropic\/claude-nope"/,
    );
  });
});
