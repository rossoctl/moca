# ADR-0028: Async prompt dispatch as a `kind:"prompt"` leaf sharing the `/turn` core

- **Status:** Accepted (2026-09-25; implemented by #170, #201, #340), amended 2026-09-01 (see [Amendment](#amendment-2026-09-01-prompt-leaves-lease-a-pool-sandbox)); its KEDA async transport was removed by [ADR-0041](0041-deprecate-knative-keda-deployment.md), and async dispatch is now [ADR-0047](0047-p6-async-fan-out-in-worker-drain.md) <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-08-25
- **Deciders:** Serverless Harness team
- **Spec:** [`../specs/2026-08-25-async-prompt-dispatch-design.md`](../specs/2026-08-25-async-prompt-dispatch-design.md)

## Context

`POST /turn` runs a free-form prompt to completion synchronously, holding an HTTP connection open
for the whole turn. An orchestrator that wants to fire a long-running prompt and collect the answer
later has no path to do so — the exact problem [ADR-0015](0015-async-leaf-completion.md) already
solved for review (`converge`) and patch (`solve`) leaves via the async KEDA queue and `GET
/runs/status`. Issue [#168](https://github.com/rossoctl/serverless-harness/issues/168) asks for a
prompt to ride that same substrate. The maintainer's governing constraint was **cleanest design
over fewest changes**: the answer must reuse existing seams rather than fork the turn path or grow a
parallel one.

## Decision

We will add a third leaf kind, `prompt`, that dispatches a free-form prompt over the **existing**
run-envelope / KEDA / result-record substrate — no new queue, worker, scaler, route, or status
endpoint. Its result is a **dedicated** `LeafResult` discriminant `{ status:"responded"; text }`
(mirroring `solved`/`patch`), not an overload of `done`. To give the leaf **full `/turn` parity**,
we will factor `runTurn`'s middle into a shared internal `executeTurn(...)` core that both `/turn`
and `runPromptLeaf` call, parameterized only by session-open policy (`createIfAbsent`) — `false`
preserves `/turn`'s 404-on-missing-session contract, `true` gives the leaf create-or-resume. The
leaf resolves the model with the leaf-family precedence (`env.model ?? config?.model → SH_MODEL →
default`) and inherits `/turn`'s `resolveSandboxConfig` sandbox routing.

### Alternatives considered

- **Reuse `done` + a text field for the result** — breaks the union's one-discriminant→one-payload invariant and forces every `done` consumer to disambiguate a verdict from text; `responded`/`text` is the clean fit.
- **A restricted / tool-gated prompt variant** — diverges from `/turn` behavior; parity via a shared core is simpler and drift-free.
- **A second copy of `runTurn`'s wiring for the leaf** — two extension stacks that inevitably drift; extract-and-share keeps one source of truth.
- **Solve's `selectPoolSandbox` lease for prompt leaves** — imports the saturation/503 path and breaks the "identical sync or async" promise; prompt leaves use `/turn`'s sandbox resolution instead.

## Consequences

- Positive: a prompt behaves identically sync (`/turn`, `async:false`) or async (`async:true`) because it runs the _same_ code; the `/runs` route, job runner, and KEDA `ScaledJob` are unchanged; prompt leaves inherit async resumability for free from the durable session log.
- Negative / accepted cost: prompt leaves get no per-leaf pool isolation (they share `/turn`'s sandbox model), so a fleet of async prompts is not lease-bounded the way solve leaves are; `runTurn` is refactored, so its behavior is now pinned by a regression test rather than by being the only caller. A prompt leaf may still be addressed to a `workloadId` (the workload gates existence and returns 404 if absent), but its pool selector is intentionally ignored — the API boundary logs a warning rather than injecting a selector that `executeTurn` would silently drop.
- Follow-up owed: pool-based isolation (a `selectPoolSandbox` lease) for prompt leaves, deferred until a driver needs it; extend `deploy/knative/leaf-async-smoke.sh` with a `responded` claim.

## Amendment (2026-09-01): prompt leaves lease a pool sandbox

The deferred follow-up above now has its driver, and the deferral turned out to cost more than
"no per-leaf isolation". The remote-sandbox demo
(`docs/demos/remote-sandbox-demo.md`, removed with the Knative path) needs a free-form prompt to
run its tool calls on a laptop container reached over the sandbox relay, and
`SH_REMOTE_SANDBOX`/`SH_RELAY_ADDR` are read only on the lease path — so a prompt leaf could not
reach a remote sandbox at all. Worse, on any deployment that configures a pool the way
`deploy/knative/service.yaml` does (a `KAGENTI_SANDBOX_POOL_SELECTOR`, no `KAGENTI_SANDBOX_POD`),
`resolveSandboxConfig` returned null and a prompt leaf's tool calls ran **in the harness container's
own filesystem** — silently, and indistinguishably from a sandbox that happened to answer.

**Amended decision.** `runPromptLeaf` leases through `selectPoolSandbox` exactly as the converge and
solve paths do — heartbeat while the turn runs, release in a `finally` — and hands the leased
sandbox to the turn. `executeTurn` gains an optional pre-leased `sandbox`; `resolveTurnSandbox`
returns it verbatim when present and otherwise falls back to `resolveSandboxConfig`, so **`/turn`
is unchanged**. This is a superset rather than a swap: with no pool selector configured
`selectPoolSandbox` performs that same single-pod resolution itself.

The alternative rejected above ("imports the saturation/503 path") is accepted as a consequence
rather than avoided: saturation propagates as `{status:"failed", reason:"saturated"}`, which the
sync `/runs` path bounded-waits then 503s on, and which `classifyOutcome` already keeps retryable
for the async queue. Suppressing it would have taken extra code to be less consistent. The
"identical sync or async" promise is preserved — both paths run the same `runPromptLeaf` — but a
prompt leaf can now 503 on a saturated pool, where before it could not.

A second, smaller contract change falls out of the `finally` that releases the lease: a throw from
the turn is now caught and returned as `{status:"failed", reason:"error"}` instead of propagating
out of `runLeaf` (which the sync route turned into a `500`). That matches what the converge and
solve paths have always done, and `classifyOutcome` already treats `error` as retryable, so the
async queue behaves the same as before.

- **Amended 2026-09-18:** a workload-addressed prompt leaf now uses the workload's
  `sandboxSelector`, just like other leaf kinds. This makes `workloadId` sufficient to route a
  delegated prompt into the sandbox and workspace allocated for that workload; callers do not need
  to know or supply a Kubernetes selector.

## Amendment (2026-11-17): a client disconnect does not cancel a sync `/runs` run, permanently

`POST /runs` and `/v1/runs` keep running after the client's socket goes away, and write the result
record when they finish; `GET /runs/status` serves it afterwards. `/turn` does the opposite — it
aborts the in-flight turn on disconnect (`packages/server/src/server.ts`, ADR-0029 §3.6). The
asymmetry was accidental, and #380 filed it as an **interim** contract to be retired once async
leaf turns on P6 (#389) gave detached work a better home.

Async turns have now shipped (ADR-0047, M1–M3), and the retirement goes the other way: **the
behaviour stays and stops being interim.**

- **Submit-then-poll depends on it.** `mocactl`'s subagent path posts `/v1/runs` and then reads
  `/runs/status` (`packages/mocactl/src/transport/leaf-turn.ts`), so it is deliberately not holding
  the socket when the run ends. Aborting on disconnect would strand every subagent.
- **Flipping it is breaking** under the [change policy](../reference/change-policy.md) ("changing a
  default so that behaviour … changes"), on a route that policy keeps as a frozen, supported alias.
- **What the interim framing was actually about** — a sync run lost on a worker restart with no
  retry — is answered by async turns, which have crash redelivery. The gap closes by offering an
  alternative, not by changing this route.

Once #391 lands, `runLeaf` takes an optional `AbortSignal` and `handleRunLeafParsed` still passes
none, so the regression #380 feared — copying `/turn`'s abort wiring here — becomes a one-line
edit. `packages/server/test/server.test.ts` pins both halves: the disconnect test asserts the
record is still written **and** that no signal reaches `runLeaf`, alongside the existing `/turn`
test asserting the opposite.

This closes #380, whose remaining scope was this amendment and that test. Its third item (a live
disconnect check in `smoke.sh` "mirroring `deploy/vm`'s") refers to a file that does not exist:
`deploy/vm` has `research-smoke.sh` and `setup-vm.sh`, and neither it nor `deploy/k8s/smoke.sh`
has such a check.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
