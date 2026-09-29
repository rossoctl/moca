# Async Prompt Dispatch (`kind:"prompt"`) — Design

Version: 1.0 — August 25, 2026
Status: Proposed
Scope: Add a `kind:"prompt"` leaf envelope that dispatches a **free-form prompt** through the
existing async KEDA queue, so a single sync `/turn` interaction can be **backgrounded** and polled
for completion — mirroring the `kind:"solve"` precedent. Realizes
[issue #168](https://github.com/rossoctl/moca/issues/168).
Builds on (reuse, no redesign): the run-envelope contract + `runLeaf` dispatch (solve slice), the
KEDA `ScaledJob` + Redis Streams queue and Redis result record (async-leaf-completion,
[`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md); P1
[`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md)), and the
`runTurn` session/extension wiring ([`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md)).

> **What this slice is NOT.** Not a new queue, worker, scaler, or status endpoint — a prompt run
> rides the exact substrate a solve run rides. Not a restricted or sandboxed variant of `/turn`: a
> prompt leaf has full `/turn` tool parity. Not multi-tenancy (the existing `tenant?` namespacing is
> inherited unchanged; no new isolation is added). The synchronous `POST /turn` is unchanged.

---

## 1. Goal & motivation

`POST /turn` is the harness's free-form conversational entrypoint: send a prompt (optionally against
an existing `sessionId`), the harness runs one Pi turn to completion with the full tool/sandbox
stack, and returns the assistant's text **synchronously**. That is the right shape for an interactive
caller, but it holds an HTTP connection open for the whole turn — unusable for an orchestrator that
wants to fire a long-running prompt and collect the answer later, exactly the problem
async-leaf-completion already solved for review (`converge`) and patch (`solve`) leaves.

The leaf/run-envelope contract already carries `async?: boolean`: `async:true` `XADD`s the envelope
and returns `202`, KEDA drains it in the background, and the caller polls `GET /runs/status`. Two
leaf **kinds** ride that substrate today — `converge` (produces a `Verdict`) and `solve` (produces a
`patch`). This slice adds a third, `prompt`, whose product is **assistant text** — i.e. the `/turn`
response, delivered asynchronously.

> Dispatch `POST /runs { kind:"prompt", prompt, sessionId, async:true }` → `202`; the leaf runs a
> full `/turn` in the background; the harness writes a Redis result record; the caller polls
> `GET /runs/status?sessionId=…` until `status:"responded"` and reads `.text`.

The design's governing principle (stated by the maintainer) is **cleanest design over fewest
changes**: reuse every seam solve already established, add exactly one new discriminant end-to-end,
and share the turn-execution core with `/turn` rather than forking it.

---

## 2. Current state — the seams we extend

| Seam                                                | Today                                                                             | This slice                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LeafEnvelope` (`harness/src/run-leaf.ts`)          | `kind?: "converge" \| "solve"`, `problemStatement?`                               | `+ "prompt"`, `+ prompt?: string`                                                                                                    |
| `LeafResult` union                                  | `done→verdict`, `paused→gate`, `aborted`, `solved→patch`, `failed→reason`         | `+ { status:"responded"; text; usage? }`                                                                                             |
| `runLeaf` dispatch                                  | `if (env.kind === "solve") return runSolveLeaf(...)`                              | `+ if (env.kind === "prompt") return runPromptLeaf(...)`                                                                             |
| `runTurn` (`harness/src/run-turn.ts`)               | one function: create-or-404, wire extensions, run, extract text                   | factor a shared `executeTurn` core (both callers use it); `TurnResult += usage?`                                                     |
| `LeafResultRecord` (`leaf-result-store.ts`)         | `status ∈ {done,failed,aborted,paused,solved}`, `verdict/gate/reason/patch/usage` | `+ "responded"` status, `+ text: string \| null`                                                                                     |
| `toResultRecord`                                    | branch per status                                                                 | `+ responded` branch                                                                                                                 |
| `isRunEnvelope` (`knative-server/src/server.ts`)    | `isLeafEnvelope(o) \|\| isSolveEnvelope(o)`                                       | `+ \|\| isPromptEnvelope(o)`                                                                                                         |
| `handleLeafStatus`                                  | wire cases for done/solved/paused/failed                                          | `+ responded` case → `{ status:"responded", text }`                                                                                  |
| `classify-outcome`, `/runs` route, KEDA `ScaledJob` | kind-agnostic                                                                     | **no change**                                                                                                                        |
| `leaf-job-runner` (`processOne`)                    | returns the leaf status union                                                     | type-level only: `+ "responded"` in the return union + doc comment; no behavioral change (a terminal `responded` acks like `solved`) |

The invariant that shapes everything below: `LeafResult` is a discriminated union where **each
`status` discriminant maps to exactly one payload field** (`done`→`verdict`, `solved`→`patch`, …).
`prompt` respects it by introducing its own discriminant (`responded`) and its own field (`text`),
never overloading `done`.

---

## 3. Design

### 3.1 Contract additions (backward-compatible)

**Envelope.** `LeafEnvelope` gains the `"prompt"` kind and one optional field. Defaults preserve
today's behavior exactly (an envelope with no `kind` is still a converge leaf):

```ts
kind?: "converge" | "solve" | "prompt";
prompt?: string;   // required when kind === "prompt": the free-form prompt to run
```

**Result.** `LeafResult` gains a dedicated success discriminant:

```ts
| { status: "responded"; text: string; usage?: LeafUsage }
```

`responded` is deliberately **not** a reuse of `done`+text. `done` carries a `Verdict`; folding text
into it would break the one-discriminant→one-payload invariant and force every `done` consumer to
disambiguate two payload shapes. `responded`/`text` mirrors `solved`/`patch` one-for-one — the
cleanest fit with the existing union. (Issue #168's acceptance criterion, written as "`done` +
text", is refined to `responded` here for that reason; the polled field is `.text`.)

`usage?` is carried for parity with `solved` (per-run token accounting for cost pricing) and is
best-effort — a usage hiccup never fails an otherwise-`responded` leaf.

**Type guard.** A new `isPromptEnvelope` folds into the existing disjunction — no route change:

```ts
export function isPromptEnvelope(o: any): boolean {
  return (
    o && typeof o.sessionId === 'string' && o.kind === 'prompt' && typeof o.prompt === 'string'
  );
}
export function isRunEnvelope(o: any): boolean {
  return isLeafEnvelope(o) || isSolveEnvelope(o) || isPromptEnvelope(o);
}
```

**Persisted record.** `LeafResultRecord` gains `"responded"` in its status union and a
`text: string | null` field (null for non-prompt results, exactly as `patch`/`verdict` are null off
their kinds). `toResultRecord` gains one branch:

```ts
if (result.status === 'responded')
  return { ...base, status: 'responded', text: result.text, usage: result.usage ?? null };
```

### 3.2 Runner — share the `/turn` core, don't fork it

The cleanest way to give a prompt leaf **full `/turn` parity** is to run _the same code_ `/turn`
runs. `runTurn` today is a single function that (a) opens-or-404s a session, (b) wires
`flushExtension` + `k8sSandboxExtension(resolveSandboxConfig(...))` + `checkpointExtension` +
`toolChoiceExtension` (+ optional `budgetVoterExtension`), (c) resolves the model, (d) runs one
`session.prompt`, and (e) extracts assistant text and maps `stopReason`.

We factor the middle out into an internal core:

```ts
interface ExecuteTurnInput {
  prompt: string;
  sessionId?: string;
  config?: TurnConfig;
  createIfAbsent: boolean; // session-open policy — see below
  selection?: ModelSelection; // pre-resolved model/provider (leaf precedence); default: resolveModelSelection(config)
}
async function executeTurn(input: ExecuteTurnInput): Promise<TurnResult>;
```

`runTurn(prompt, sessionId, config)` becomes a thin wrapper: `executeTurn({ prompt, sessionId,
config, createIfAbsent: false })`. Every extension, the settings/resource loader, the
`applyModelGateway` call, and the text/`stopReason` extraction move into `executeTurn` **verbatim** —
so a prompt leaf inherits the identical system prompt, settings, tool set, sandbox routing, and
budget voter that `/turn` has. There is no second copy to drift.

`executeTurn` also surfaces best-effort token accounting as one **additive** field on the shared
result — `TurnResult` gains `usage?: LeafUsage`, populated from session spend the same way
`runSolveLeaf` populates its `usage` (via `branchSpend`, already imported by `run-turn.ts`). This is
the only field added to `TurnResult`; `runTurn`'s existing three fields are unchanged, so `/turn`
callers see a superset. A usage hiccup leaves `usage` undefined and never fails the turn.

**The create-or-resume wrinkle.** `runTurn` today throws `"no session in backend"` when a
`sessionId` is given but no checkpoint exists — that is `/turn`'s deliberate `404` contract. But a
_fresh_ prompt leaf's `sessionId` has no prior checkpoint, and must **create**. This is the one
behavioral difference between the two callers, so it is the one parameter:

Session-open policy (design-level; the concrete checkpoint-existence probe follows whatever
`runSolveLeaf` / `realProduceVerdict` already do in `run-leaf.ts`, not a new mechanism):

- **prior checkpoint exists** → `openFromCheckpoint` and **resume** (both callers, unchanged).
- **no checkpoint, `createIfAbsent:false`** → throw `"no session in backend"` → `/turn`'s **404
  contract**, preserved bit-for-bit.
- **no checkpoint, `createIfAbsent:true`** → `SessionManager.create(..., { id: sessionId }, ...)` so
  the leaf's supplied id **creates**; a re-dispatched id then falls into the resume branch above.

So `/turn` keeps its 404, and a prompt leaf gets create-or-resume — the same pattern `runSolveLeaf`
already implements, giving prompt leaves free at-least-once **resumability** on the async queue. This
`createIfAbsent` flag is the _only_ behavioral parameter distinguishing the two callers; everything
else in the core is shared verbatim.

**`runPromptLeaf`.** A thin adapter that resolves the leaf-family model selection, runs the core,
and maps `TurnResult → LeafResult`:

```ts
async function runPromptLeaf(env, config, deps?): Promise<LeafResult> {
  if (!env.prompt) return { status: 'failed', reason: 'bad_inputs' };
  const selection = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const exec = deps?.executeTurn ?? executeTurn; // injectable seam for unit tests
  const r = await exec({
    prompt: env.prompt,
    sessionId: env.sessionId,
    config,
    createIfAbsent: true,
    selection,
  });
  if (r.stopReason === 'aborted') return { status: 'aborted' };
  if (r.stopReason === 'error')
    return { status: 'failed', reason: 'error', message: r.errorMessage };
  return { status: 'responded', text: r.response, usage: r.usage };
}
```

Dispatch in `runLeaf`, alongside the solve line:

```ts
if (env.kind === 'prompt') return runPromptLeaf(env, config, deps);
```

**Model precedence** is the clean superset already used by solve: `env.model ?? config?.model →
SH_MODEL → "claude-opus-4-8"` (and the provider mirror). `/turn` itself has no `env`-envelope, so its
precedence (`config?.model → SH_MODEL → default`) is unchanged; the leaf simply adds the
envelope-override tier in front. System prompt, settings, and extensions are inherited verbatim
through the shared core — nothing to configure per-kind.

**Sandbox model.** A prompt leaf inherits `/turn`'s `resolveSandboxConfig(env, cwd)` (pod/pool or
local), **not** solve's `selectPoolSandbox` lease. So a prompt leaf has **no** pool-lease /
saturation / `503` path — like `/turn`, it runs against the resolved sandbox (or local tools) with no
lease accounting. This keeps the shared-core promise honest (a prompt behaves identically sync or
async) at the cost of not getting solve's per-leaf pool isolation. Pool-based isolation for prompt
leaves is a possible follow-up (§6), deliberately deferred.

### 3.3 Request path & wire — zero route changes

The `POST /runs` route already branches only on `async`, and both branches already validate through
`isRunEnvelope`. Because `isPromptEnvelope` folds into that disjunction, a prompt envelope flows
through the **existing** enqueue (`async:true` → `202`) and inline (`async:false` → run + persist)
paths with **no route edit** — `async:false` runs a prompt inline and returns the `LeafResult`;
`async:true` enqueues it for KEDA. The job runner, `classifyOutcome` (a prompt `error` stays
retryable; `responded`/`aborted` ack), and the KEDA `ScaledJob` are all kind-agnostic and unchanged.

The only wire addition is one status case:

```ts
// handleLeafStatus
if (record.status === 'responded')
  return res
    .writeHead(200, JSON_HEADERS)
    .end(JSON.stringify({ status: 'responded', text: record.text }));
```

Full async lifecycle, end to end:

```
POST /runs { kind:"prompt", prompt, sessionId, async:true }
  → 202 { status:"accepted", sessionId }              (XADD leaf-queue — existing enqueue)
KEDA ScaledJob → leaf-job → runLeaf → runPromptLeaf → executeTurn (full /turn stack)
  → writeResult(leaf:result:<sid>, { status:"responded", text, usage })   (existing runner)
GET /runs/status?sessionId=…
  → { status:"queued" }        while pending
  → { status:"responded", text }   when terminal
```

---

## 4. Backward compatibility

- An envelope with no `kind` (or `kind:"converge"`/`"solve"`) is unaffected — the new guard requires
  `kind === "prompt"` **and** a string `prompt`.
- `/turn`'s `404`-on-missing-session contract is preserved bit-for-bit (`createIfAbsent:false`).
- `LeafResultRecord` gains an additive field (`text`) and status; older records deserialize fine
  (absent `text` reads as `undefined`, treated as null).
- No queue, scaler, route, or entrypoint change — a running cluster picks up prompt dispatch with a
  code roll, no manifest change.

---

## 5. Testing & verification gate

### 5.1 Unit (fast, vitest)

- **`packages/knative-server/test/prompt-envelope.test.ts`** (mirrors `solve-envelope.test.ts`):
  `isPromptEnvelope` accepts a well-formed prompt envelope; rejects missing/empty `prompt`, wrong
  `kind`, missing `sessionId`; `isRunEnvelope` accepts it; a converge/solve envelope is unaffected.
- **`harness/test/leaf-result-store.test.ts`** (extend): `toResultRecord` maps a `responded` result
  to `{ status:"responded", text, usage }` and leaves `verdict/gate/reason/patch` null.
- **`harness/test/run-leaf.test.ts`** (extend): drive `runPromptLeaf` through the injectable
  `deps.executeTurn` seam — assert `end_turn→responded`+text, `error→failed/error`,
  `aborted→aborted`, and missing `prompt`→`bad_inputs`, with no live model.
- **`harness/test/run-turn*.test.ts`** (extend): a regression that `runTurn` still 404s on a
  missing-session id proves the refactor preserved the `createIfAbsent:false` contract.
- **route/server tests** (extend): `handleLeafStatus` returns the `responded` wire shape; `POST /runs`
  with a prompt envelope enqueues (`async:true`) / runs inline (`async:false`).

### 5.2 Live gate — extend `deploy/knative/leaf-async-smoke.sh` (gated `ASYNC_LIVE_SMOKE=1`)

Add one prompt claim to the existing gated smoke: `adispatch` a `kind:"prompt"` envelope with
`async:true`, then `poll_status` until `status=="responded"` with a non-empty `.text`. Reuses the
existing dispatch/poll helpers — no new script.

---

## 6. Scope / YAGNI — explicitly NOT building

- **No per-prompt-leaf pool lease / saturation path.** Prompt leaves use `/turn`'s sandbox
  resolution, not solve's `selectPoolSandbox`. Pool-based isolation for prompt leaves is a possible
  follow-up, deferred until a driver needs it.
- **No new tool-gating or restricted prompt mode.** Full `/turn` parity is the design; a caller who
  wants a narrower tool surface configures the sandbox/settings the same way they would for `/turn`.
- **No new multi-tenancy.** The existing `tenant?` namespacing is inherited; no per-tenant isolation
  is added here.
- **No streaming.** A prompt leaf is run-to-completion, polled — the async contract. Token-streaming
  a backgrounded leaf is out of scope.

---

## 7. References

- Issue [#168 — async prompt dispatch](https://github.com/rossoctl/moca/issues/168)
- [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md) — the KEDA/queue substrate this rides
- [`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md) — Redis result record + `GET /runs/status`
- [`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn` / `/turn`
- [ADR-0028](../adrs/0028-async-prompt-dispatch.md) — the decision record for this design

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
