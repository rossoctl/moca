# Multi-Protocol Model Provider (Anthropic + OpenAI-compatible) — Design

Version: 0.1 — August 20, 2026
Status: Accepted (approved for implementation)
Scope: Generalize the harness's model-synthesis wrapper so a leaf/turn can be driven against **any
of the common LLM wire protocols** — Anthropic Messages, OpenAI Chat Completions, OpenAI Responses —
selected per-model, with a configurable base URL, request headers, and auth scheme. Unblocks
OpenAI-compatible endpoints (IBM RITS, vLLM, OpenAI, Azure, most OSS gateways) from `main`.
Builds on (reuse, no redesign): the existing `SH_MODEL_CUSTOM=1` custom-model support and
`requireModel`/`synthesizeCustomModel` (`harness/src/run-turn.ts`), the `toolChoiceExtension`
(`harness/src/tool-choice-extension.ts`), and Pi's provider layer (`pi-fork/packages/ai`, which
already ships `anthropic-messages`, `openai-completions`, and `openai-responses`).
Tracking: rossoctl/moca#157.

> **What this slice is NOT.** Not a new provider implementation — Pi already implements all three
> wire protocols; this is a thin dispatch + config layer in the harness wrapper. Not model-registry
> changes. Not auto-detection of a model's protocol (explicit selector, §4.1). The default path
> (registry model, or `SH_MODEL_CUSTOM=1` with no protocol selector) stays **byte-for-byte the
> Anthropic behavior shipped today**.

---

## 1. Goal & motivation

The harness runs one agent loop per leaf against a single configured model. Today the only
non-registry ("custom endpoint") path is **Anthropic-only**: `requireModel` →
`synthesizeCustomModel` builds a `Model<"anthropic-messages">` pointed at `ANTHROPIC_BASE_URL`
(`harness/src/run-turn.ts`). That covers direct Anthropic and **LiteLLM's Anthropic-format
`/v1/messages`** endpoint.

It does **not** cover **OpenAI Chat Completions** (`/v1/chat/completions`), which is what IBM RITS,
vLLM, OpenAI, Azure and most OSS gateways speak. To run RITS/Granite/Qwen we had to fork the wrapper
(a throwaway `synthesizeCustomOpenAIModel` + a `tool_choice` fix, kept only in a `/tmp` clone and a
baked cluster image). That wiring keeps getting stranded and can't be reproduced from `main`.

The realistic field is **two or three wire protocols**, all already implemented by Pi. The right fix
is a small, bounded generalization of the harness wrapper — not per-model special-casing.

## 2. Current state — the Anthropic-coupled seams

Three places hardcode the Anthropic protocol; each is a dispatch point in the new design.

| Seam                   | File                                                | Coupling                                                                                                                              |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Model synthesis        | `harness/src/run-turn.ts` `synthesizeCustomModel()` | Returns `Model<"anthropic-messages">`, `provider:"anthropic"`, `baseUrl = ANTHROPIC_BASE_URL`                                         |
| Tool-choice nudge      | `harness/src/tool-choice-extension.ts`              | Injects `tool_choice: { type: "auto" }` — the **Anthropic object form**. vLLM/OpenAI reject the object; they want the string `"auto"` |
| Gateway/auth transform | `harness/src/run-turn.ts` `applyModelGateway()`     | Rewrites to Bearer auth + strips `x-api-key`; seeds `ANTHROPIC_API_KEY` — Anthropic-specific                                          |

Pi's substrate already supports the target: `pi-fork/packages/ai/src/providers/openai-completions.ts`
`createClient()` spreads `model.headers` into `defaultHeaders` and uses `model.baseUrl`; and
`env-api-keys.ts` maps provider `openai → OPENAI_API_KEY`. So a synthesized
`Model<"openai-completions">` with `{ provider:"openai", baseUrl, headers }` is the whole seam
(a non-empty `OPENAI_API_KEY` is still required by the client, even when the endpoint authenticates
via a custom header and ignores the Bearer token).

## 3. The protocol landscape

| `SH_MODEL_API`        | Pi `api`             | Endpoint               | Serves                                         |
| --------------------- | -------------------- | ---------------------- | ---------------------------------------------- |
| `anthropic` (default) | `anthropic-messages` | `/v1/messages`         | Direct Anthropic, LiteLLM (Anthropic-format)   |
| `openai-completions`  | `openai-completions` | `/v1/chat/completions` | RITS, vLLM, OpenAI, Azure, most OSS gateways   |
| `openai-responses`    | `openai-responses`   | `/v1/responses`        | OpenAI, some gateways (optional; low priority) |

## 4. Design

A single dispatch layer at `requireModel`, delegating to Pi's providers, plus protocol-aware
versions of the two extensions.

### 4.1 Configuration (backward-compatible)

`SH_MODEL_CUSTOM=1` stays the master "custom endpoint" switch. A new selector chooses the protocol;
absent, it defaults to `anthropic` (today's behavior).

| Env                                                                     | Meaning                                                                                                                                                                                                       | Default                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SH_MODEL_API`                                                          | `anthropic` \| `openai-completions` \| `openai-responses`                                                                                                                                                     | `anthropic`                                                                                   |
| `SH_MODEL`                                                              | served model id (used as `id` + `name`)                                                                                                                                                                       | — (required)                                                                                  |
| `SH_MODEL_BASE_URL`                                                     | endpoint base URL                                                                                                                                                                                             | falls back to `ANTHROPIC_BASE_URL` (anthropic) / `OPENAI_BASE_URL` (openai\*) for back-compat |
| `SH_MODEL_HEADERS`                                                      | JSON object of extra request headers, e.g. `{"RITS_API_KEY":"${RITS_API_KEY}"}`. String values support `${VAR}` interpolation from env, so a secret value flows in via a secretKeyRef env (no inline literal) | `{}`                                                                                          |
| `SH_MODEL_AUTH`                                                         | `bearer` \| `custom-header` \| `none` — how the endpoint authenticates                                                                                                                                        | `bearer`                                                                                      |
| `SH_MODEL_CONTEXT_WINDOW` / `SH_MODEL_MAX_TOKENS` / `SH_MODEL_PROVIDER` | existing knobs, unchanged                                                                                                                                                                                     | 131072 / 8192 / per-protocol                                                                  |

Secrets are **never** inline in `SH_MODEL_HEADERS` in manifests — the header **value** comes from a
`secretKeyRef` env indirection at the deployment layer (same pattern as `RITS_API_KEY` /
`llm-credentials`); the spec only standardizes the header **name→value** plumbing.

### 4.2 `requireModel` dispatch

```
requireModel(provider, modelId, env):
  if env.SH_MODEL_CUSTOM == "1":
     switch (env.SH_MODEL_API ?? "anthropic"):
       "anthropic"          -> synthesizeAnthropicModel(modelId, env)        # today's synthesizeCustomModel
       "openai-completions" -> synthesizeOpenAICompletionsModel(modelId, env)
       "openai-responses"   -> synthesizeOpenAIResponsesModel(modelId, env)
  else: <registry path unchanged>
```

`synthesizeCustomModel` is renamed `synthesizeAnthropicModel` (behavior identical). The OpenAI
synthesizers mirror it, changing only `api`, `provider`, and reading `SH_MODEL_BASE_URL` +
`SH_MODEL_HEADERS`:

```ts
// openai-completions
const model: Model<"openai-completions"> = {
  id: modelId, name: modelId,
  api: "openai-completions",
  provider: (env.SH_MODEL_PROVIDER ?? "openai") as ...,  // "openai" → OPENAI_API_KEY lookup
  baseUrl: requireBaseUrl(env),                           // SH_MODEL_BASE_URL ?? OPENAI_BASE_URL
  headers: parseHeaders(env.SH_MODEL_HEADERS),            // e.g. { RITS_API_KEY: <from secret> }
  reasoning: false, input: ["text"],
  cost: { input:0, output:0, cacheRead:0, cacheWrite:0 },
  contextWindow, maxTokens,
};
```

### 4.3 Protocol-aware `toolChoiceExtension`

The nudge must emit the form the protocol accepts:

- `anthropic` → `tool_choice: { type: "auto" }` (object) — unchanged.
- `openai-*` → `tool_choice: "auto"` (string). vLLM/OpenAI reject the object
  (`Invalid value for 'function': 'None'`).

Select on `SH_MODEL_API` (read once at factory construction). Everything else (the "inject only when
tools present and unset" guard, the first-request log) stays.

### 4.4 Protocol-aware auth / `applyModelGateway`

`applyModelGateway` is Anthropic-gateway-specific (Bearer + strip `x-api-key` + seed
`ANTHROPIC_API_KEY`). For `openai-*` it must **not** apply that rewrite. Behavior by `SH_MODEL_AUTH`:

- `bearer` — Pi sends `Authorization: Bearer <OPENAI_API_KEY>` (standard OpenAI/vLLM).
- `custom-header` — the endpoint authenticates via a header in `SH_MODEL_HEADERS` (e.g. RITS's
  `RITS_API_KEY`); **strip the default `Authorization`** so the SDK Bearer isn't sent, but keep a
  non-empty `OPENAI_API_KEY` present (the client requires it).
- `none` — no auth header.

Implementation: `applyModelGateway` early-returns (no-op) for non-anthropic `api`; the OpenAI auth
shaping lives in the synthesizer (`headers` + an `Authorization: null`-style strip when
`custom-header`).

### 4.5 Optional per-provider quirks hook

Some endpoints need a request-body tweak that isn't part of the wire protocol — e.g. RITS reasoning-
off via `chat_template_kwargs: { enable_thinking: false }`. Handle these with the existing
`before_provider_request` extension mechanism (same hook `toolChoiceExtension` uses), gated by an
opt-in env (e.g. `SH_MODEL_EXTRA_BODY` = JSON merged into the request). Deferred unless a target
needs it; not on the critical path.

## 5. Backward compatibility

- No `SH_MODEL_CUSTOM` → registry path, untouched.
- `SH_MODEL_CUSTOM=1` **without** `SH_MODEL_API` → `anthropic` synthesizer = exactly today's
  `synthesizeCustomModel` output. Existing LiteLLM/self-hosted-Anthropic deployments are unaffected.
- `ANTHROPIC_BASE_URL` remains a valid base-URL source for the anthropic path.

## 6. Testing & verification gate

### 6.1 Unit (fast, vitest) — extend `harness/test/run-turn-model.test.ts`

- `SH_MODEL_API=openai-completions` → synthesized model has `api:"openai-completions"`,
  `provider:"openai"`, `baseUrl` from `SH_MODEL_BASE_URL`, `headers` parsed from `SH_MODEL_HEADERS`.
- `custom-header` auth → default `Authorization` stripped, custom header present.
- `toolChoiceExtension` emits **string** `"auto"` under `openai-*` and the **object** under
  `anthropic` (new `tool-choice-extension.test.ts` cases).
- `anthropic` default (no `SH_MODEL_API`) → identical to current `synthesizeCustomModel`
  (regression lock).
- Invalid `SH_MODEL_API` / missing base URL → clear error.

### 6.2 Live gate (cluster)

- **OpenAI-compat, tool-capable:** point `SH_MODEL_API=openai-completions` at a RITS/vLLM route with
  the tool-call parser (e.g. Qwen2.5-72B-Instruct or Kimi) and run a **tool-requiring** `/turn`
  ("use your bash tool to run `echo PONG`") → assert a **structured** tool call executes in the
  sandbox (empty content + tool ran), not narrated text.
- **Anthropic/LiteLLM regression:** the existing Haiku-via-LiteLLM `/turn` still returns `PONG`.

## 7. Scope / YAGNI — explicitly NOT building

- Auto-detecting a model's protocol (explicit `SH_MODEL_API` only).
- Multiple models per harness / per-request model routing.
- `openai-responses` is defined for completeness but implementation is deferred until a target needs
  it (RITS/vLLM/LiteLLM are all `openai-completions`).
- Server-side tool-call-parser enablement — see §8.
- Registry additions for these endpoints (they are custom-URL, not registry models).

## 8. Operational notes (not solvable in harness code)

**Tool-calling is a per-endpoint capability, not a protocol feature.** On RITS, only certain routes
have the vLLM tool-call parser enabled (Kimi, Qwen-Instruct yes; DeepSeek no → emits tool calls as
plain text). No wrapper code fixes that; it's a server-side deploy flag. Therefore the operational
rule stands: **sniff a new model with a tool-requiring `/turn` and confirm a structured tool call
before committing it to a run.**

## 9. References

- Issue: rossoctl/moca#157.
- Current seams: `harness/src/run-turn.ts` (`requireModel`, `synthesizeCustomModel`,
  `applyModelGateway`), `harness/src/tool-choice-extension.ts`.
- Pi substrate: `pi-fork/packages/ai/src/providers/openai-completions.ts` (`createClient` →
  `model.headers`/`model.baseUrl`), `pi-fork/packages/ai/src/env-api-keys.ts` (provider→env-key map).
- Related: async/KEDA leaf path #158; model-selection lineage in the milestone registry
  (`docs/specs/README.md`).

---

_Assisted-By: Claude Code_
