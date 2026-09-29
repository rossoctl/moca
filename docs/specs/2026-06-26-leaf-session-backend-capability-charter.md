# Capability Charter — MOCA as a Leaf-Session Backend

Version: 1.0 — June 26, 2026
Status: Charter (roadmap anchor; informs Phase-2 priority and the MVP target)
Scope: Answers one question — _does the moca design generalize beyond a single
pipeline?_ — by testing it against three independent agentic-pipeline archetypes, and uses the
answer to **repoint** the Phase-2 roadmap and define the MVP target. This is a positioning/charter
doc, not a milestone implementation spec.
Source of truth for numbering: [Milestone Registry](README.md). This charter **reprioritizes** the
Z-track; it does not renumber it.
Builds on the built base: M1 (Redis session), M2/M3 (sandbox), M4 (Knative scale-to-zero), M5
(checkpoint/resume), M6 (runtime model selection).
Relates to: [Z1 Identity Spine](2026-06-26-identity-spine-design.md), [Z2 Harness Lock-Down](2026-06-26-harness-lockdown-design.md), [Z3 Inference Injector](2026-06-26-inference-injector-design.md), [Z5 Generalized Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — this charter says **which of these the MVP needs and which it defers.**

> **One-line finding.** Three independent agentic pipelines all share the same shape — _a
> deterministic, non-LLM orchestrator dispatching parameterized agent **leaf** sessions, with
> structured artifacts, checkpoint/resume, and human/audit gates_ — and **none uses recursive
> subagents.** So the harness's highest-value role is to be an excellent **leaf-session backend
> invoked by an arbitrary external orchestrator**, not to build an orchestrator or a subagent system.

---

## 1. The question

The credential-plane re-examination produced a coherent Z-track, but the priority order was
unanchored. To anchor it, we tested the harness design against **three independent, real agentic
pipelines** (kept name-free here as archetypes). The test: _can the harness run all three, and what
does each actually need?_

## 2. Evidence — three archetypes

|                          | **Archetype A**: parallel-fan-out analysis              | **Archetype B**: sequential role loop                           | **Archetype C**: scheduled ingestion                 |
| ------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Shape                    | candidate → review → validate, batched                  | hypothesis → design → execute → analyze, iterated               | fetch → dedup → filter → refine, repeated            |
| Orchestrator             | deterministic code (prepare/run/finalize + audit gates) | deterministic state machine (atomic checkpoint/resume)          | **scheduler (cron) + events** + deterministic stages |
| Agent topology           | flat pool of **parallel worker** leaf-sessions          | **two sequential roles**, ~2 LLM calls/iteration                | deterministic stages + **LLM leaf calls**            |
| **Recursive subagents?** | **No**                                                  | **No** (parallelism = isolated workspaces)                      | **No**                                               |
| Model tiering            | per-phase (cheap triage / strong validate)              | per-role (strong plan / cheaper execute)                        | light (filter/refine)                                |
| State / artifacts        | structured JSON, shared volume, resumable               | schema-governed JSON, atomic checkpoint, cross-iteration memory | JSON + cursors, **git-backed**                       |
| Human gates              | minimal (blocker only)                                  | **explicit** approve/reject/abort + auto-mode                   | **issue/comment** gates                              |
| Start signal             | invocation                                              | invocation                                                      | **cron + event**                                     |
| Egress                   | model API, VCS, package registries                      | model API + optional secondary endpoint                         | model API, content/source APIs, VCS push             |
| Sandbox/tools            | indexers, search, build toolchains                      | workspace isolation, build/run, patch apply                     | API clients, containerized filter                    |

### 2.1 The invariants across all three

1. **The orchestrator is deterministic, non-LLM.** A state machine / staged script / scheduler
   drives control flow. The LLM is always a **leaf**, never the controller.
2. **Agents are parameterized leaf invocations** — `(model, inputs) → structured output`.
3. **No recursive subagents in currently-running code.** "Parallel agentic work" is a deterministic
   orchestrator fanning out leaf sessions, or **isolated workspaces** — never agent-spawns-agent.
   _(Verified nuance: A **deliberately rejected** agent-managed subagents for bulk fan-out; B has
   **planned-but-not-yet-merged** clean-context subagents for per-scope exploration and per-arm
   isolation. See [Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md) §6.)_
4. **Per-role / per-phase model tiering**, multi-provider, env-selected.
5. **Structured, schema-governed artifacts** on a durable store, with **audit/coverage/ledger** and
   **checkpoint/resume + incremental memory**.
6. **Human-in-the-loop gates** are a first-class control point (A: light; B, C: central).
7. **Code/tool sandbox with isolated workspaces**; **event/schedule-triggered** start (C).

---

## 3. The generalized contract

> The moca is a **scale-to-zero, durable, sandboxed, model-tiered leaf-session
> backend**, invoked over a stable contract (HTTP/CLI) by an **arbitrary external deterministic
> orchestrator** — a state machine, a staged script, _or a CI/cron scheduler_ — offering optional
> primitives for **checkpoint/resume, human-gates, workspace isolation, and credentialed egress**.

### 3.1 Non-goals (what the harness must NOT impose)

- **It does not host or supply the orchestrator.** All three bring their own; the harness is
  _invoked_, it does not drive. (This resolves the earlier "where does the orchestrator run" fork:
  **workers-only**.)
- **It does not impose a domain artifact store.** A uses a shared volume, C uses a git repo. The
  harness provides **session/turn durability** (its Redis log); the **domain artifacts stay the
  orchestrator's** (file/volume/git). _Session durability ≠ domain artifacts._ (This resolves the
  "artifact exchange" fork: don't force Redis.)
- **It does not provide recursive subagents.** None of the three need them.

---

## 4. Capability set → status

| Capability                                                                                        | Needed by                                  | Status / home                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Sandboxed tool execution                                                                          | A, B, C                                    | ✅ built (M2/M3)                                                      |
| Scale-to-zero session runtime                                                                     | A, B, C                                    | ✅ built (M4)                                                         |
| Durable session + **checkpoint/resume**                                                           | A, B, C                                    | ✅ built (M1/M5) — **promote to a first-class API**                   |
| Per-phase/role **model tiering**                                                                  | A, B, C                                    | ✅ built (M6 runtime model input)                                     |
| **Leaf-session invocation contract** (run-to-completion, parameterized inputs, structured output) | A, B, C                                    | ⭐ **new — the core MVP capability**                                  |
| **Workspace isolation** (per-session worktree / results-dir / CoW)                                | A, B                                       | ⭐ **new — promote**                                                  |
| **Human-gate primitive** (pause → structured summary → approve/reject/abort; auto-mode)           | B, C                                       | ⭐ **new — promote (post-MVP)**                                       |
| **Trigger/start on-ramp** (HTTP/event/cron)                                                       | C                                          | ⭐ **new — promote (post-MVP)**; Knative is already HTTP-triggered    |
| Model-key injection (hide provider key)                                                           | A, B, C                                    | �ðŸ”¹ keep-light (Z3); MVP may keep key in env                        |
| Per-source **credentialed egress** (VCS, content APIs, registries)                                | A, C                                       | 🔹 keep-light (Z5) when sources are authenticated                     |
| Clean-context subtask delegation (a leaf spawns a fresh-context child)                            | B (planned)                                | ⭐ **re-entrant contract** (design property) — core need met for free |
| Recursive-subagent **extras** (lineage, budget, policy, mail)                                     | B (later)                                  | ⏸️ **defer (Z6 extras)** — not the MVP                                |
| Per-user identity / multi-tenant isolation                                                        | **none** (all are per-project automations) | ⏸️ **defer (Z1)** — only if multi-tenant hosting becomes a goal       |

---

## 5. The MVP target

**Prove the leaf-session-backend contract end-to-end, single-tenant, key-in-env.** Concretely, the
MVP demonstrates:

- An **external deterministic orchestrator** (unchanged, brought by the use case) dispatches work to
  the harness over the **leaf-session invocation contract**.
- Each leaf session runs **to completion** in a **tooled sandbox** with an **isolated workspace**,
  using a **per-call model tier**, and returns a **structured result** the orchestrator collects.
- The orchestrator's existing **batching / retry / coverage-audit** logic works unmodified against
  harness-backed workers.
- **Scale-to-zero** between bursts; **checkpoint/resume** survives a mid-run restart.

Explicitly **out of MVP:** recursive subagents (Z6), per-user identity (Z1), the human-gate and
cron-trigger primitives (promote post-MVP), and the full credential plane (key in env; Z3/Z5 later).

The concrete use-case/slice selection (which archetype to build first, and its thin vertical slice)
is the **next step** after this charter — see Open Questions §8.

---

## 6. Explicit deferrals (with rationale)

- **Z6 recursive subagents — extras deferred; core met by a re-entrant contract.** Zero of three
  archetypes spawn subagents in running code, and A _deliberately rejected_ agent-managed subagents
  for **bulk** fan-out (a deterministic pool over leaf sessions is better). **But demand is not
  zero:** B has planned (not-yet-merged) **clean-context subagents** for per-scope exploration and
  per-arm isolation — a leaf agent offloading a focused subtask to a fresh-context child. That need
  is satisfied **for free by a re-entrant leaf-session contract**: a leaf session dispatches a
  **child** leaf session via the same contract, getting clean context + its own sandbox by
  construction. So the MVP contract must be **re-entrancy-friendly**, and only Z6's _extras_ —
  parent/child lineage, budget propagation, sandbox policy, inter-agent messaging — actually defer.
  Bulk fan-out stays deterministic; recursion is opt-in via the same contract.
- **Z1 per-user identity — deferred.** All three are **per-project automations**, not multi-user
  shared-namespace workloads. The whole per-session-SPIFFE-bound-to-user apparatus (Z1) is justified
  only by multi-tenant hosting, which none of these require. Keep the Z1/Z2/Z3/Z5 designs on the
  shelf; pull them in when multi-tenant hosting is an explicit goal.

This is the charter's main service: it prevents over-building the (correct but heavy) credential
plane ahead of demand.

---

## 7. Key decisions

| #   | Decision               | Choice                                                                                                                                                                                                                                             |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Harness role           | **Leaf-session backend**, invoked by an external orchestrator; not an orchestrator itself.                                                                                                                                                         |
| G2  | Orchestrator placement | **External / workers-only.** The harness never hosts the orchestrator.                                                                                                                                                                             |
| G3  | Artifact store         | **Not imposed.** Harness owns session/turn durability; domain artifacts stay the orchestrator's (volume/git).                                                                                                                                      |
| G4  | Subagents              | **Core met by a re-entrant contract; Z6 extras deferred.** Bulk fan-out is deterministic over leaf sessions; clean-context delegation (B, planned) = a leaf dispatching a child leaf via the same contract. Only lineage/budget/policy/mail defer. |
| G5  | Identity               | **Per-user identity deferred (Z1).** Single-tenant MVP; key in env.                                                                                                                                                                                |
| G6  | Core MVP capability    | The **leaf-session invocation contract** (run-to-completion, parameterized, structured output) + **workspace isolation**.                                                                                                                          |
| G7  | Model tiering          | Reuse **runtime model selection (M6)**; injector (Z3) is a later hardening, not MVP.                                                                                                                                                               |
| G8  | Promote post-MVP       | **Human-gate** and **trigger/cron** primitives (needed by B and C, not by the first slice).                                                                                                                                                        |

---

## 8. Open questions / divergences to resolve next

1. **Which archetype + slice is the MVP?** A (parallel fan-out) best exercises the core value
   (parallel leaf sessions + tiering + workspace + structured artifacts); C (scheduled ingestion) is
   simpler but pulls in the trigger primitive early. Pick one and define the thin vertical slice.
2. **Artifact-store span.** The contract says "don't impose," but the harness still needs a
   _convention_ for handing a leaf session its inputs and collecting its structured output. Define
   the minimal envelope (e.g. an inputs dir + a results path on a mounted volume) without owning the
   domain store.
3. **Human-gate vs scale-to-zero.** A gate that waits for human approval implies a session that
   sleeps indefinitely — a natural fit for scale-to-zero + durable resume, but the gate's
   pending-state must live in durable state, not a live pod. Design when promoting the gate.
4. **Trigger placement.** Does the cron/event trigger belong _in_ the harness, or stay the
   orchestrator's (e.g. GitHub Actions) with the harness only exposing the HTTP contract? Leaning:
   keep triggers external; the harness exposes the contract.

---

## 9. References

- [Milestone Registry](README.md) — Phase-2 numbering this charter reprioritizes.
- [Z1 Identity Spine](2026-06-26-identity-spine-design.md), [Z2 Harness Lock-Down](2026-06-26-harness-lockdown-design.md), [Z3 Inference Injector](2026-06-26-inference-injector-design.md), [Z5 Generalized Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — the credential plane this charter defers (except Z3/Z5 keep-light).
- Built base: [M1](2026-06-16-m1-redis-session-backend-design.md) / [M2](2026-06-17-m2-k8s-sandbox-client-design.md) / [M3](2026-06-17-m3-persistent-channel-design.md) / [M4](2026-06-17-m4-knative-serverless-wrapper-design.md) / [M5](2026-06-23-m5-compaction-checkpoint-design.md) / [M6](2026-06-24-m6-experiments-design.md).
- Parent: [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — the subagent/credential agenda this charter reprioritizes against observed demand.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
