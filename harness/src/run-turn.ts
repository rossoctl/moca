import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import {
  getModel,
  getModels,
  getProviders,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { RedisSessionBackend } from '@moca/session-backend';
import { BufferedRedisBackend } from './buffered-redis-backend.js';
import { flushExtension } from './flush-extension.js';
import { randomUUID } from 'node:crypto';
import {
  k8sSandboxExtension,
  type K8sSandboxConfig,
  type SandboxTransport,
} from '@moca/k8s-sandbox';
// Value import, and safe: select-sandbox.ts imports nothing from run-turn.js, so unlike the
// run-leaf↔run-turn pair below there is no cycle to avoid here.
import {
  selectPoolSandbox,
  SandboxPoolSaturatedError,
  SandboxPoolEmptyError,
  type SelectDeps,
} from './select-sandbox.js';
import { checkpointExtension } from './checkpoint-extension.js';
import { budgetVoterExtension, branchSpend } from './budget-voter.js';
import { toolChoiceExtension } from './tool-choice-extension.js';
// Type-only import (erased at compile time) so it is safe against the run-leaf↔run-turn value
// cycle: run-leaf.ts imports values from run-turn.js, but a `import type` adds no runtime edge.
import type { LeafUsage } from './run-leaf.js';
import { sseExtension, type TurnStreamFrame } from './turn-stream.js';
import { promotedLoaderOptions, type PromotedConfig } from './config-resolver.js';
import { leaseTimings } from './lease-timings.js';

// Re-exported because they are now part of executeTurn's CONTRACT: since /turn leases from the pool,
// every caller of executeTurn can be handed these errors and needs to distinguish them from a generic
// failure (both are transient — a 503, not a 500). harness/package.json exposes no ./select-sandbox
// subpath, and this is the module those callers already import.
export { SandboxPoolSaturatedError, SandboxPoolEmptyError };

/**
 * One session store per process, not per turn.
 *
 * `executeTurnCore` used to `new RedisSessionBackend(...)` on every call and never close it. Its
 * constructor connects eagerly, so each turn leaked one live Redis connection — and this predates
 * the supervisor, but the supervisor is what makes it fatal: before P6 a turn was served by a
 * Knative container that went away afterwards, whereas a supervisor worker is process-lived and
 * admits S concurrent turns for hours. The leak then climbs to `maxclients` (10000), Redis answers
 * `ERR max number of clients reached`, and node-redis raises that as an `'error'` on a client with
 * no listener, so every worker exits at once. Measured: all four died simultaneously ~13 minutes
 * into a sustained ladder.
 *
 * Sharing is safe because the store is stateless per session — the URL is the only construction
 * input and every method takes the session id — and node-redis multiplexes concurrent commands over
 * one connection.
 *
 * Unlike the stores in select-sandbox.ts there is no drop-on-failure wrapper here, and the reason is
 * that the hazard such a wrapper guards against — memoising a client that never connected — is now
 * fixed at its source instead of worked around at each call site. `RedisSessionBackend` used to
 * assign `ready` once in its constructor and never reassign it, so a rejected `connect()` poisoned
 * every later method call on that instance forever; memoising one process-wide would then have
 * traded a bounded per-turn leak for an unbounded outage, and in the very window the leak never
 * mattered in (the first turn after boot). It now RE-ARMS: a failed attempt clears itself so the
 * next call reconnects (packages/session-backend/src/redis-backend.ts, `arm()`), which fixes it for
 * every caller of the class rather than for this memo alone.
 *
 * Worth knowing which failures reach that path: probed on the pinned redis@6.2.1, both shapes do — a
 * REFUSED connect rejects with `ECONNREFUSED`, and a black-holed SYN rejects once the 5s
 * `connectTimeout` raises `ConnectionTimeoutError`. In a cluster the second is the one to expect: a
 * Service with no ready endpoints, or a NetworkPolicy drop, black-holes the SYN instead of refusing
 * it.
 *
 * The re-arm handles the promise channel. A socket lost AFTER connecting is the event channel, and
 * that one is fatal without an `'error'` listener regardless of any memoisation — hence
 * `swallowRedisErrors`, which every long-lived client here now registers.
 */
let sessionStoreMemo: { url: string; store: RedisSessionBackend<FileEntry> } | null = null;

function sharedSessionStore(url: string): RedisSessionBackend<FileEntry> {
  if (!sessionStoreMemo || sessionStoreMemo.url !== url) {
    // A changed REDIS_URL is a different Redis; replace rather than silently address the old one.
    if (sessionStoreMemo) void sessionStoreMemo.store.close().catch(() => {});
    sessionStoreMemo = { url, store: new RedisSessionBackend<FileEntry>(url) };
  }
  return sessionStoreMemo.store;
}

/** Test-only: drop the cached session store. */
export function resetSharedSessionStore(): void {
  if (sessionStoreMemo) void sessionStoreMemo.store.close().catch(() => {});
  sessionStoreMemo = null;
}

/**
 * The sandbox a turn's tool calls run in: a resolved pod/pool config (null ⇒ run tools in the
 * harness process itself) plus, for a leased grpc presence record, the transport that carries
 * exec frames to it.
 */
export interface TurnSandbox {
  config: K8sSandboxConfig | null;
  /** Present ONLY for a leased grpc sandbox; undefined for pods (each exec spawns kubectl). */
  transport?: SandboxTransport;
}

/**
 * A turn's sandbox plus the lease lifecycle that keeps it. `leased` is true ONLY when THIS call
 * took the lease, which is what makes `heartbeat`/`release` safe to drive unconditionally: for an
 * injected sandbox the caller owns the lease, and renewing or returning someone else's would let
 * one turn release the sandbox another turn is still executing in.
 */
export interface AcquiredTurnSandbox {
  sandbox: TurnSandbox;
  leased: boolean;
  /** Renew this call's lease. A no-op unless `leased`. */
  heartbeat: () => Promise<void>;
  /** Return this call's lease. A no-op unless `leased`. */
  release: () => Promise<void>;
}

/**
 * The id a turn holds its sandbox lease under. Unique per TURN — never the session id.
 *
 * Named for what it identifies (the lease's HOLDER) rather than a "run": #279 established that `run`
 * is not a harness concept and that the old lease `runId` was `session_id` under another name. This
 * value is the counter-example that makes the identity real — it MUST differ from the session id, for
 * the two reasons below — so it gets its own descriptive name, as docs/glossary.md prescribes.
 *
 * The holder id is the ZSET *member* in `ACQUIRE_LUA` (sandbox-lease.ts), not a payload, so a repeated
 * value is one lease rather than two: `ZADD` on an existing member updates its score and leaves
 * `ZCARD` unchanged. A session id is stable across every turn of a session by design (that is what
 * lets `:openFromCheckpoint` reopen one), so deriving the holder from it would have made the RESUME
 * path — the one the supervisor exists to serve — the path that shares leases, and broken the pool
 * two ways:
 *
 *  - **The cap undercounts.** N concurrent turns of one session occupy ONE slot, so with
 *    `KAGENTI_SANDBOX_CAP=20` a single session can pile arbitrarily many turns onto one pod while the
 *    pool still reports headroom — deflating the very saturation accounting `SandboxPoolSaturatedError`
 *    and its new 503 are computed from.
 *  - **The first turn to finish releases a sandbox another is still using.** `release` is `zRem`, so
 *    one turn's `finally` removes the shared member while its sibling is mid-execution; the pod then
 *    reads as free for new work, and the sibling's heartbeat (`zAdd`) resurrects the member seconds
 *    later, so `load()` returns a different answer depending on where in the heartbeat interval it is
 *    sampled.
 *
 * The session id is prefixed for greppability only — nothing reads the holder back, and the UUID is
 * what carries the uniqueness. The session id itself still reaches `selectPoolSandbox` separately,
 * because it is what keys the microVM workspace and must stay stable across a session's turns.
 */
export function turnLeaseHolder(sessionId?: string): string {
  return `${sessionId ?? 'anon'}:${randomUUID()}`;
}

/**
 * Decide which sandbox a turn runs its tools in, and lease it when it comes from a pool.
 *
 * A caller that has already leased one (a prompt leaf, which must reach the very sandbox it holds
 * a lease on — including a remote one behind the relay) injects it, and resolution is skipped.
 *
 * `/turn` injects nothing, and this is where its behavior CHANGED. It used to call
 * `resolveSandboxConfig` alone — the single-pod path — so it ignored
 * `KAGENTI_SANDBOX_POOL_SELECTOR`, `SH_SANDBOX_DISCOVERY` and `SH_REMOTE_SANDBOX` entirely, and on
 * a deployment that configured a pool it ran the turn's tool calls in the harness process itself
 * (ADR 0028 deferred this as "prompt leaves inherit /turn's sandbox routing"; run-leaf.ts closed
 * it for leaves only). Proven on hardware: a tool call's file landed in the supervisor unit's own
 * PrivateTmp namespace, never in any sandbox container, while a direct probe of the relay's Exec
 * RPC reached the pool fine at the same moment.
 *
 * Going through `selectPoolSandbox` is what makes the no-pool path safe **by construction** rather
 * than by care: its own first branch is `if (!selector) return resolveSandboxConfig(...)`, i.e.
 * exactly the call this function used to make, with a no-op lease. A deployment with no
 * `KAGENTI_SANDBOX_POOL_SELECTOR` therefore resolves identically to before, and no future caller
 * of `executeTurn` can bypass this seam to get the old behavior back.
 *
 * One intended behavior change beyond routing: with a selector set and NO candidates,
 * `selectPoolSandbox` throws rather than falling back. Previously such a deployment silently ran
 * tools locally, which is the failure §5.4 exists to prevent — a turn that cannot reach the
 * sandbox it is configured to use is not a turn that should quietly succeed.
 */
export async function acquireTurnSandbox(
  injected: TurnSandbox | undefined,
  env: NodeJS.ProcessEnv,
  headCwd: string,
  sessionId: string | undefined,
  deps: SelectDeps = {},
): Promise<AcquiredTurnSandbox> {
  const noop = async () => {};
  if (injected) return { sandbox: injected, leased: false, heartbeat: noop, release: noop };

  // Same knobs and defaults as every leaf's call, deliberately: two lease conventions for one lease
  // store is how a cap means different things depending on which path took it. That is now ONE shared
  // reader rather than the same `Number(env.X ?? …)` repeated at each of the four lease-taking paths,
  // so hardening it (an empty or unparseable value no longer becoming 0/NaN) could not harden this
  // path and leave a leaf behind.
  const { cap, ttlMs } = leaseTimings(env);
  // The holder is derived HERE rather than taken from the caller, so a per-turn id cannot be forgotten
  // at one of several call sites — the M1 defect was exactly one such expression.
  const holderId = turnLeaseHolder(sessionId);
  const selected = await selectPoolSandbox(
    env,
    headCwd,
    // An anonymous turn has no session, so there is no continuity to preserve and no shared workspace
    // it should join: keying it by its unique holder gives it its own, which is the correct answer for
    // a one-off. Sharing a literal 'anon' workspace across unrelated turns would be the cross-turn
    // bleed spec §2.3 is about, and an EMPTY key is refused outright by microvm-worker (§3.4).
    sessionId ?? holderId,
    { cap, ttlMs, holderId, remoteSandbox: env.SH_REMOTE_SANDBOX === '1' },
    deps,
  );
  if (!selected)
    return { sandbox: { config: null }, leased: false, heartbeat: noop, release: noop };

  // `leased` comes from the seam rather than from re-reading the environment here. It is false on the
  // single-pod path even though selectPoolSandbox returned a value: that branch has no lease behind
  // its no-op heartbeat/release, and arming a renewal timer for it would add an interval to every turn
  // on every non-pool deployment — which would show up in the very loop_lag_p99 figure E8 reads.
  // Re-deriving it (`Boolean(env.KAGENTI_SANDBOX_POOL_SELECTOR)`, agreeing with selectPoolSandbox's
  // own `if (!selector)`) worked, but duplicated that predicate across two files.
  return {
    sandbox: { config: selected.config, transport: selected.transport },
    leased: selected.leased,
    heartbeat: selected.heartbeat,
    release: selected.release,
  };
}

/**
 * What rides in `Authorization: Bearer …` upstream — TAGGED, because the same field carries two
 * incompatible things (MU1 spec §3.6):
 *
 *   placeholder — an inert, subject-derived stand-in; RC1's `static-inject` rewrites it to the real
 *                 credential from a mounted secret_dir (P5 §3.1-§3.2).
 *   direct      — the real token, resolved per subject by the control plane, with no injector in the
 *                 path. MU1's interim mode; MU3 deletes it.
 *
 * A bare string would make the two indistinguishable, and both failure directions are silent: a
 * placeholder-mode deployment with a misconfigured injector sends the placeholder upstream and gets an
 * opaque auth error, while a direct-mode deployment that later grows an injector has its REAL key
 * rewritten. The tag makes the mode assertable rather than inferred.
 */
export type UpstreamCredential =
  { mode: 'placeholder'; value: string } | { mode: 'direct'; value: string };

export interface TurnConfig {
  redisUrl?: string;
  cwd?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  /**
   * The per-request credential the control plane resolved for THIS turn's subject (MU1 spec §3.4).
   * Takes precedence over `anthropicAuthToken` and the environment. Absent for every existing caller
   * (leaf, CLI, unauthenticated `/turn`), which is what keeps this change additive.
   */
  upstreamCredential?: UpstreamCredential;
  model?: string;
  provider?: string;
}

export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** Resolve model + provider as runtime inputs: config > env > default. */
export function resolveModelSelection(
  config?: { model?: string; provider?: string },
  env: NodeJS.ProcessEnv = process.env,
): ModelSelection {
  return {
    provider: config?.provider ?? env.SH_MODEL_PROVIDER ?? 'anthropic',
    modelId: config?.model ?? env.SH_MODEL ?? 'claude-opus-4-8',
  };
}

/**
 * Synthesize a model object for an endpoint that speaks the Anthropic Messages wire format
 * but serves a model id NOT in pi-ai's built-in registry — e.g. an in-cluster vLLM/llm-d
 * server whose /v1/messages is Anthropic-compatible but which requires its own served model
 * name (meta-llama/Llama-3.1-8B-Instruct) verbatim in the request body.
 *
 * Opt-in via SH_MODEL_CUSTOM=1. SH_MODEL is used as-is (id + name), ANTHROPIC_BASE_URL is the
 * endpoint. applyModelGateway() still layers Bearer auth + the gateway compat flags on top,
 * so this only supplies the pieces requireModel() otherwise reads from the registry. The
 * cost/context numbers are placeholders (self-hosted, not billed); contextWindow/maxTokens are
 * conservative defaults — override via SH_MODEL_CONTEXT_WINDOW / SH_MODEL_MAX_TOKENS if needed.
 */
/**
 * Parse SH_MODEL_HEADERS — a JSON object of extra request headers to send to a custom endpoint
 * (e.g. `{"RITS_API_KEY":"${RITS_API_KEY}"}`) — into a header map. Empty/absent ⇒ {}. Throws on
 * non-object JSON.
 *
 * String values support `${VAR}` interpolation from `env`, so a secret header value can be supplied
 * via a secretKeyRef env var (e.g. RITS_API_KEY) rather than an inline literal in the manifest.
 * An unset `${VAR}` interpolates to the empty string.
 */
function parseModelHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.SH_MODEL_HEADERS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `SH_MODEL_HEADERS must be a JSON object of header name→value pairs (got: ${raw}).`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`SH_MODEL_HEADERS must be a JSON object of header name→value pairs.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] =
      typeof v === 'string'
        ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '')
        : String(v);
  }
  return out;
}

function synthesizeCustomModel(
  modelId: string,
  env: NodeJS.ProcessEnv,
): Model<'anthropic-messages'> {
  // SH_MODEL_BASE_URL is the protocol-neutral knob; ANTHROPIC_BASE_URL is the back-compat fallback.
  const baseUrl = env.SH_MODEL_BASE_URL || env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      `SH_MODEL_CUSTOM=1 (anthropic) requires SH_MODEL_BASE_URL or ANTHROPIC_BASE_URL (the Anthropic-compatible endpoint to send "${modelId}" to).`,
    );
  }
  const contextWindow = Number(env.SH_MODEL_CONTEXT_WINDOW) || 131072;
  const maxTokens = Number(env.SH_MODEL_MAX_TOKENS) || 8192;
  // Typed as Model<"anthropic-messages"> (not `as ReturnType<typeof getModel>`) so tsc checks
  // the shape — if pi-ai's Model type gains a required field, this fails to compile instead of
  // silently omitting it.
  const model: Model<'anthropic-messages'> = {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    // provider MUST be "anthropic" (not a synthetic tag): pi resolves the request API key by
    // provider name — authStorage.getApiKey(provider) maps "anthropic" -> ANTHROPIC_API_KEY
    // (which applyModelGateway seeds from the auth token), whereas an unknown provider like
    // "custom" has no env-key mapping and fails with `No API key found for "custom"`. Request
    // routing is by baseUrl + api, not provider, so tagging it "anthropic" sends traffic to the
    // custom baseUrl while satisfying the key lookup. Overridable via SH_MODEL_PROVIDER.
    provider: (env.SH_MODEL_PROVIDER ?? 'anthropic') as Model<'anthropic-messages'>['provider'],
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return model;
}

/**
 * Synthesize an OpenAI Chat Completions model for an OpenAI-compatible endpoint (RITS / vLLM /
 * OpenAI / Azure / most OSS gateways), reached via SH_MODEL_CUSTOM=1 +
 * SH_MODEL_API=openai-completions. Pi's openai-completions provider reads `model.baseUrl` and
 * spreads `model.headers` into the request; the API key is resolved from OPENAI_API_KEY.
 *
 * Auth (SH_MODEL_AUTH):
 *   - "bearer" (default): pi sends `Authorization: Bearer <OPENAI_API_KEY>` (standard OpenAI/vLLM).
 *   - "custom-header": the endpoint authenticates via a header in SH_MODEL_HEADERS (e.g. RITS's
 *     `RITS_API_KEY`); strip the default Authorization so the SDK Bearer isn't also sent. pi's
 *     client still requires a non-empty OPENAI_API_KEY, so seed a placeholder when unset.
 *   - "none": no auth header.
 */
function synthesizeOpenAICompletionsModel(
  modelId: string,
  env: NodeJS.ProcessEnv,
): Model<'openai-completions'> {
  const baseUrl = env.SH_MODEL_BASE_URL || env.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      `SH_MODEL_CUSTOM=1 with SH_MODEL_API=openai-completions requires SH_MODEL_BASE_URL or OPENAI_BASE_URL (the OpenAI-compatible endpoint to send "${modelId}" to).`,
    );
  }
  const contextWindow = Number(env.SH_MODEL_CONTEXT_WINDOW) || 131072;
  const maxTokens = Number(env.SH_MODEL_MAX_TOKENS) || 8192;
  const auth = env.SH_MODEL_AUTH ?? 'bearer';
  const headers: Record<string, string | null> = { ...parseModelHeaders(env) };
  if (auth === 'custom-header' || auth === 'none') {
    // Endpoint authenticates via a custom header (already in `headers`) or not at all — strip the
    // SDK's default Authorization Bearer so an unknown/empty Bearer isn't sent. pi's openai client
    // still requires a non-empty api key even when the Bearer is unused, so seed a placeholder.
    headers.Authorization = null;
    if (!env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'unused';
  }
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    // provider "openai" so pi resolves the api key from OPENAI_API_KEY (env-api-keys.ts). Request
    // routing is by baseUrl + api; provider only drives the key lookup. Overridable via SH_MODEL_PROVIDER.
    provider: (env.SH_MODEL_PROVIDER ?? 'openai') as Model<'openai-completions'>['provider'],
    baseUrl,
    headers: headers as unknown as Record<string, string>,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return model;
}

/**
 * Resolve a model from the pi-ai registry, throwing a clear error when the id is unknown.
 * getModel() returns undefined for an unknown provider/model (e.g. the dotted
 * "claude-sonnet-4.6" is a github-copilot key, not an anthropic one) — without this guard
 * the caller crashes later on `baseModel.headers`. Returns the model object on success.
 *
 * SH_MODEL_CUSTOM=1 bypasses the registry entirely and synthesizes a model for a custom endpoint.
 * SH_MODEL_API selects the wire protocol (default "anthropic"):
 *   - "anthropic"          → Anthropic Messages via SH_MODEL_BASE_URL/ANTHROPIC_BASE_URL (default;
 *                            covers direct Anthropic + LiteLLM Anthropic-format). synthesizeCustomModel().
 *   - "openai-completions" → OpenAI Chat Completions via SH_MODEL_BASE_URL/OPENAI_BASE_URL + headers/auth
 *                            (RITS/vLLM/OpenAI/Azure). synthesizeOpenAICompletionsModel().
 *   - "openai-responses"   → deferred (see docs/specs/2026-08-20-multi-protocol-model-provider-design.md).
 * See that spec for the config schema.
 */
export function requireModel(
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.SH_MODEL_CUSTOM === '1') {
    const api = env.SH_MODEL_API ?? 'anthropic';
    switch (api) {
      case 'anthropic':
      case 'anthropic-messages':
        return synthesizeCustomModel(modelId, env);
      case 'openai-completions':
        return synthesizeOpenAICompletionsModel(modelId, env);
      case 'openai-responses':
        throw new Error(
          `SH_MODEL_API=openai-responses is not yet implemented (deferred; see docs/specs/2026-08-20-multi-protocol-model-provider-design.md §7). Use openai-completions.`,
        );
      default:
        throw new Error(
          `Unknown SH_MODEL_API "${api}". Expected: anthropic | openai-completions | openai-responses.`,
        );
    }
  }
  const model = getModel(provider as never, modelId as never);
  if (model) return model;
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(
      `Unknown model provider "${provider}". Known providers: ${providers.join(', ')}.`,
    );
  }
  const ids = (getModels(provider as never) as Array<{ id: string }>).map((m) => m.id);
  // Surface the dot-vs-dash (or case) twin if one exists — the common mistake.
  const norm = (s: string) => s.replace(/[.\-]/g, '').toLowerCase();
  const suggestions = ids.filter((id) => norm(id) === norm(modelId));
  const hint = suggestions.length
    ? `Did you mean: ${suggestions.join(', ')}?`
    : `Known "${provider}" ids include: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ', …' : ''}.`;
  throw new Error(`Unknown model "${provider}/${modelId}" — not in the pi-ai registry. ${hint}`);
}

export interface TurnResult {
  sessionId: string;
  response: string;
  stopReason: string;
  errorMessage?: string;
  usage?: LeafUsage;
}

/**
 * Apply the LLM-gateway transform to a pi-ai model object.
 *
 * When a gateway base URL or auth token is in play (config or env), rewrite the model to
 * call the gateway with Bearer auth and strip `x-api-key` (the gateway authenticates via
 * Authorization). Also seeds `ANTHROPIC_API_KEY` from the auth token when unset, since some
 * pi-ai code paths still read the env var. Returns the base model unchanged when neither a
 * gateway base nor a token is configured (direct-key mode).
 *
 * Shared by runTurn (interactive) and runLeaf (job mode) so both honor the same credentials.
 */
export function applyModelGateway<M extends { headers?: Record<string, unknown> }>(
  baseModel: M,
  config?: Pick<TurnConfig, 'anthropicBaseUrl' | 'anthropicAuthToken' | 'upstreamCredential'>,
): M {
  // The Anthropic gateway rewrite (Bearer + strip x-api-key + seed ANTHROPIC_API_KEY, and the
  // litellm compat-flag disables) applies ONLY to the Anthropic-messages path. OpenAI-compatible
  // models carry their own baseUrl/headers/auth from synthesizeOpenAICompletionsModel — leave
  // them untouched (else we'd clobber baseUrl with ANTHROPIC_BASE_URL and inject a wrong Bearer).
  const api = (baseModel as { api?: string }).api;
  if (api && api !== 'anthropic-messages') return baseModel;
  // `||` (not `??`) so an empty-string config value falls back to the env var rather than
  // suppressing it — "" is a "not set" sentinel here, not a meaningful credential.
  const authToken =
    config?.upstreamCredential?.value ||
    config?.anthropicAuthToken ||
    process.env.ANTHROPIC_AUTH_TOKEN;
  // Intentional process.env mutation: some pi-ai code paths read ANTHROPIC_API_KEY at
  // invocation time, so seed it from the auth token. This now runs from two call sites
  // (runTurn and runLeaf via applyModelGateway) — do NOT "clean it up" into a local.
  if (authToken && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = authToken;
  }
  const gatewayBase = config?.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!gatewayBase && !authToken) return baseModel;
  return {
    ...baseModel,
    ...(gatewayBase ? { baseUrl: gatewayBase } : {}),
    ...(gatewayBase
      ? {
          // Anthropic-compatible gateways (e.g. litellm) reject the per-tool extras the
          // direct Anthropic API accepts. Without this, tool-bearing requests fail with
          // "tools.0.custom.eager_input_streaming: Extra inputs are not permitted". Disable
          // the gateway-incompatible compat flags so convertTools() omits those fields.
          compat: {
            ...(baseModel as { compat?: Record<string, unknown> }).compat,
            supportsEagerToolInputStreaming: false,
            supportsCacheControlOnTools: false,
            supportsLongCacheRetention: false,
          },
        }
      : {}),
    ...(authToken
      ? {
          headers: {
            ...baseModel.headers,
            Authorization: `Bearer ${authToken}`,
            'x-api-key': null, // strip x-api-key when using gateway Bearer auth
          } as unknown as Record<string, string>,
        }
      : {}),
  };
}

/**
 * Best-effort cumulative token usage summed off a session's loaded branch.
 * Mirrors the defensive pattern budget-voter.ts uses: pi's getSessionStats()
 * reads message.usage non-defensively and throws on this build, so we walk
 * getBranch() directly. Always returns a LeafUsage (zeros for an empty branch);
 * callers wrap the call in try/catch so a usage hiccup never fails the turn.
 */
export function sumBranchUsage(sm: unknown): LeafUsage {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const branch = (sm as { getBranch?: () => unknown[] }).getBranch?.() ?? [];
  for (const entry of branch as Array<{
    type?: string;
    message?: {
      role?: string;
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
  }>) {
    if (entry?.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
      const m = entry.message.usage;
      u.input += m.input;
      u.output += m.output;
      u.cacheRead += m.cacheRead;
      u.cacheWrite += m.cacheWrite;
    }
  }
  return { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite };
}

export interface BaseLoaderInputs {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  extensionFactories: unknown[];
}

/**
 * Assemble DefaultResourceLoader's options.
 *
 * Extracted as a pure function so the back-compat guarantee is assertable: with no promoted
 * bundle the result has EXACTLY the four base keys, which is what makes an absent `configRef`
 * byte-identical to today rather than merely intended to be.
 */
export function resourceLoaderOptionsFor(
  base: BaseLoaderInputs,
  promoted?: PromotedConfig,
): Record<string, unknown> {
  return { ...base, ...promotedLoaderOptions(promoted) };
}

export interface ExecuteTurnInput {
  prompt: string;
  sessionId?: string;
  config?: TurnConfig;
  createIfAbsent: boolean; // session-open policy: false = /turn 404 contract; true = create-or-resume
  selection?: ModelSelection; // pre-resolved model/provider; default: resolveModelSelection(config)
  onEvent?: (frame: TurnStreamFrame) => void; // present ⇒ append sseExtension(onEvent) to the stack
  signal?: AbortSignal; // present ⇒ signal → session.abort() (client disconnect)
  sandbox?: TurnSandbox; // pre-leased sandbox; absent ⇒ resolve from the environment (/turn)
  /** Resolved promoted Claude Code config; absent ⇒ the loader is built exactly as before. */
  promotedConfig?: PromotedConfig;
}

/**
 * Shared turn entry point: opens (or, when createIfAbsent, creates) a session, leases a sandbox for
 * the turn's tool calls, then hands both to the core, which wires the extension stack, resolves the
 * model, runs one Pi turn, and extracts text + best-effort usage.
 *
 * runTurn (`/turn`) binds createIfAbsent:false — a missing session id 404s ("no session in
 * backend"). A prompt leaf binds createIfAbsent:true — a fresh id creates, a re-dispatched id
 * resumes — and may pass a pre-resolved `selection` (leaf precedence over /turn's config default).
 *
 * The two steps are in that order on purpose, and the order is pinned: see the note below.
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<TurnResult> {
  const cwd = input.config?.cwd ?? process.cwd();

  // Open the session BEFORE acquiring, because the two failures are not equal: a missing session is
  // permanent (404 `session_not_found`) and no capacity is transient (503). Acquiring first threw the
  // capacity error before the 404 could be raised, so a `/turn` for a session that will never exist
  // was told to retry — every such request, in `records` mode with nothing attached yet — and it did
  // a pod list, N `lease.load()`s and an acquire/release on the way to failing. Ordering is the whole
  // fix; `turnErrorStatus` already prefers the 404, it just never got the chance to.
  const opened = await openTurnSession(input, cwd);

  // The lease lifecycle stays HERE rather than in executeTurnCore so that every exit path returns it:
  // a normal return, a throw, and an abort (input.signal → session.abort(), which resolves the prompt
  // and unwinds through this finally). A leaked lease would hold a pool slot for its full TTL and, at
  // E8's concurrency, starve the pool it is meant to measure.
  const acquired = await acquireTurnSandbox(input.sandbox, process.env, cwd, input.sessionId);

  let leaseRenewal: ReturnType<typeof setInterval> | undefined;
  if (acquired.leased) {
    // leaseTimings, not Number(env.X ?? …): an empty or unparseable KAGENTI_SANDBOX_HEARTBEAT_MS
    // yielded 0/NaN, which setInterval clamps to 1 ms — ~1000 renewals a second per in-flight turn,
    // against the Redis this change exists to relieve. It also clamps the interval inside the TTL.
    leaseRenewal = setInterval(() => {
      // Best-effort: a failed renewal must not reject into an unhandled rejection and kill the
      // worker. The lease's TTL expiring is the safe outcome — the sandbox returns to the pool.
      void acquired.heartbeat().catch(() => {});
    }, leaseTimings(process.env).heartbeatMs);
  }

  try {
    return await executeTurnCore(input, acquired.sandbox, opened);
  } finally {
    // Clear first, then release: if release throws, the interval is already gone rather than
    // left running against a lease nobody holds.
    if (leaseRenewal) clearInterval(leaseRenewal);
    await acquired.release().catch(() => {});
  }
}

/** The session a turn runs in, plus the store and buffered backend its extensions are wired to. */
interface OpenedTurnSession {
  store: RedisSessionBackend<FileEntry>;
  backend: BufferedRedisBackend;
  sessionManager: Awaited<ReturnType<typeof SessionManager.openFromCheckpoint>>;
}

/**
 * Open (or, when createIfAbsent, create) the turn's session.
 *
 * Split out of executeTurnCore so `executeTurn` can run it ahead of the pool acquire — see the note
 * there. Everything it builds is handed on, so the split adds no second store or backend.
 */
async function openTurnSession(input: ExecuteTurnInput, cwd: string): Promise<OpenedTurnSession> {
  const { sessionId, config, createIfAbsent } = input;
  const redisUrl = config?.redisUrl ?? 'redis://localhost:6379';

  // Shared per process, not per turn — see sharedSessionStore's note. One connection per turn leaked
  // to maxclients and killed every worker simultaneously on a sustained run.
  const store = sharedSessionStore(redisUrl);
  const backend = new BufferedRedisBackend(store);

  let sessionManager;
  if (sessionId) {
    if (createIfAbsent) {
      // create-or-resume: resume the durable session if present, else create a fresh one under the
      // supplied id. openFromCheckpoint throws "no session in backend" for a missing checkpoint;
      // fall back to create in that case, but re-throw any other error.
      try {
        sessionManager = await SessionManager.openFromCheckpoint(sessionId, backend, cwd);
      } catch (err) {
        if (err instanceof Error && err.message.includes('no session in backend')) {
          sessionManager = SessionManager.create(cwd, undefined, { id: sessionId }, backend);
        } else {
          throw err;
        }
      }
    } else {
      // /turn contract: a supplied id MUST already exist — openFromCheckpoint 404s otherwise.
      sessionManager = await SessionManager.openFromCheckpoint(sessionId, backend, cwd);
    }
  } else {
    sessionManager = SessionManager.create(cwd, undefined, undefined, backend);
  }

  return { store, backend, sessionManager };
}

async function executeTurnCore(
  input: ExecuteTurnInput,
  turnSandbox: TurnSandbox,
  opened: OpenedTurnSession,
): Promise<TurnResult> {
  const { prompt, config } = input;
  const cwd = config?.cwd ?? process.cwd();
  // Opened by executeTurn ahead of the pool acquire, so a missing session 404s before any lease work.
  const { store, backend, sessionManager } = opened;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const budgetLimit = Number(process.env.SH_BUDGET_TOKENS);
  const budgetMargin = Number(process.env.SH_BUDGET_MARGIN);
  // acquireTurnSandbox (called by executeTurn, which owns the lease lifecycle) hands back exactly
  // k8sSandboxExtension's argument, and it is passed on untransformed below — so a leased
  // transport cannot be dropped by a field-by-field rebuild here.
  const sandbox = turnSandbox;
  // Surface whether sandbox routing actually resolved: a null config means tool calls run in
  // the harness pod's own filesystem (local), not a sandbox pod — a common cause of "the file
  // never appeared in the sandbox". Cheap one-line signal in container logs.
  if (process.env.SH_MODEL_CUSTOM === '1') {
    const how = sandbox.config
      ? `${input.sandbox ? 'leased' : 'pod/pool'}${sandbox.transport ? ' (grpc transport)' : ''}`
      : 'NULL (tools run LOCAL)';
    console.error(`[sandbox] resolved config: ${how}`);
  }
  const extensionFactories = [
    flushExtension(backend),
    k8sSandboxExtension(sandbox),
    checkpointExtension(store, sessionManager),
    toolChoiceExtension(),
  ];
  if (Number.isFinite(budgetLimit) && budgetLimit > 0) {
    // session_start is not emitted in the headless path, so compute the pre-turn baseline
    // (cumulative spend already on the loaded branch) here and inject it into the voter.
    const budgetBaseline = branchSpend(sessionManager) ?? 0;
    extensionFactories.push(
      budgetVoterExtension(sessionManager, {
        limit: budgetLimit,
        baseline: budgetBaseline,
        ...(Number.isFinite(budgetMargin) && budgetMargin > 0 ? { margin: budgetMargin } : {}),
      }),
    );
  }

  if (input.onEvent) {
    // Streaming sink: same factory seam as flushExtension. Appended only when a caller wants
    // live frames; absent ⇒ /turn behaves exactly as today.
    extensionFactories.push(sseExtension(input.onEvent));
  }

  const resourceLoader = new DefaultResourceLoader(
    resourceLoaderOptionsFor(
      { cwd, agentDir, settingsManager, extensionFactories },
      input.promotedConfig,
    ) as never,
  );
  await resourceLoader.reload();

  const { provider, modelId } = input.selection ?? resolveModelSelection(config);
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel, config);

  const { session } = await createAgentSession({
    sessionManager,
    model,
    resourceLoader,
    settingsManager,
  });

  if (input.signal) wireAbort(input.signal, session);

  await session.prompt(prompt);

  const lastMessage = session.state.messages.at(-1) as AssistantMessage | undefined;
  let response = '';
  let stopReason = 'end_turn';
  let errorMessage: string | undefined;

  if (lastMessage?.role === 'assistant') {
    stopReason = lastMessage.stopReason ?? 'end_turn';
    if (stopReason === 'error' || stopReason === 'aborted') {
      errorMessage = lastMessage.errorMessage || `Request ${stopReason}`;
    } else {
      for (const content of lastMessage.content) {
        if (content.type === 'text') {
          response += content.text;
        }
      }
    }
  }

  await backend.flush();

  // Best-effort per-turn cumulative token usage; a usage hiccup must never fail a completed turn.
  let usage: LeafUsage | undefined;
  try {
    usage = sumBranchUsage(sessionManager);
  } catch {
    usage = undefined;
  }

  return {
    sessionId: sessionManager.getSessionId(),
    response,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Bridge an AbortSignal to a session's abort(): fire immediately if already aborted, else once on
 * the abort event. Pure and unit-testable — the server owns creating the signal (client disconnect
 * → AbortController), the core just bridges it to Pi's abort. (§3.2, §3.6)
 */
export function wireAbort(signal: AbortSignal, session: { abort: () => void }): void {
  if (signal.aborted) {
    session.abort();
    return;
  }
  signal.addEventListener('abort', () => session.abort(), { once: true });
}

/**
 * Thin wrapper preserving the `/turn` public signature and its 404-on-missing-session contract:
 * createIfAbsent:false makes a supplied-but-absent sessionId throw "no session in backend".
 */
export async function runTurn(
  prompt: string,
  sessionId?: string,
  config?: TurnConfig,
): Promise<TurnResult> {
  return executeTurn({ prompt, sessionId, config, createIfAbsent: false });
}
