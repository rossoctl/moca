# Leaf-Session Backend — Executive Overview

**Status:** MVP complete (Phase 1 + Leaf-Session shipped). Zero-trust deferred to Phase 2.
**Repo:** `rossoctl/moca` (private)
**Date:** 2026-06-28

---

## 1. The Three Archetypes

The leaf-session backend supports three dispatch patterns for running AI agent "leaves" — isolated units of work invoked by an external orchestrator via a shared volume-envelope contract (`POST /runs`; the pre-rename `POST /run-leaf` remains as a deprecated alias).

### Archetype A — Async Fan-Out (PR #12)

**Pattern:** Orchestrator posts `{async: true}` → enqueued to Redis Streams → KEDA ScaledJob drains items → each leaf runs to completion → done-marker written to shared PVC.

**Use case:** Batch workloads, parallel fan-out (e.g. "research 10 topics concurrently"). Work items queue when load exceeds capacity; pods scale 0→10 based on queue depth and auto-reclaim crashed entries.

### Archetype B — Human Gate (PR #14)

**Pattern:** Leaf session PAUSES mid-execution at a decision point → writes a gate-marker → status endpoint reports `awaiting_approval` → external actor submits verdict (approve/reject/abort) → leaf RESUMES or terminates.

**Use case:** Approval workflows, human-in-the-loop review (e.g. "draft a contract clause, pause for legal sign-off, then finalize"). The harness scales to zero while waiting; resume is instant via Redis session persistence.

### Archetype C — Scheduled Dispatch (PR #13)

**Pattern:** K8s CronJob fires on schedule → `cron-dispatch` pod reads a static config list (ConfigMap) → posts each item as `{async: true}` to `/runs` → items flow through the async queue.

**Use case:** Periodic batch jobs (e.g. "summarize yesterday's tickets at 02:00 daily"). Fire-ID = Job name ensures idempotency across retry storms.

---

## 2. Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│  External           │  POST   │  Knative Service         │
│  Orchestrator       │────────▶│  /runs                   │
│  (leaf-orchestrator)│         │  (moca)    │
└─────────────────────┘         │  scale 0-5, concurrency=1│
        │                       └───────────┬──────────────┘
        │ {async:true}                      │ kubectl exec
        ▼                                   ▼
┌───────────────┐           ┌───────────────────────────┐
│ Redis Streams │           │ sandbox-0 pod             │
│ (work queue + │◀─────────▶│ (tool execution, code)    │
│  session state)│           └───────────────────────────┘
└───────┬───────┘
        │ drain                    Shared PVC (/work)
        ▼                          ├── inputs/<sessionId>/
┌───────────────────┐              ├── results/<sessionId>/
│ KEDA ScaledJob    │              ├── done/<sessionId>
│ (leaf-worker)     │              └── gate/<gateId>
│ 0-10 replicas     │
└───────────────────┘
        ▲
        │ schedule
┌───────────────────┐
│ CronJob           │
│ (cron-dispatch)   │
└───────────────────┘
```

### Key Components

| Component           | Role                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| **Knative Service** | Scale-to-zero HTTP endpoint; handles sync `/runs` and enqueues async work                     |
| **Redis**           | Session persistence (durable resume by `sessionId`), work queue (Streams), gate state         |
| **KEDA ScaledJob**  | Autoscales worker pods 0→10 based on `lagCount` + `pendingEntriesCount`                       |
| **sandbox-0**       | Isolated execution pod; harness routes tool calls here via `kubectl exec` (brain/hands split) |
| **Shared PVC**      | Volume-envelope contract — inputs, results, and markers travel as files, not HTTP bodies      |
| **CronJob**         | Archetype C scheduler; fires `cron-dispatch` on cron schedule                                 |

### Single Image, Two Entry Points

The Knative Service and leaf-worker are the **same container image** (`moca`) with different entry points:

|                              | Knative Service                                        | leaf-worker (KEDA ScaledJob)     |
| ---------------------------- | ------------------------------------------------------ | -------------------------------- |
| **Entry point**              | `server.ts` — HTTP server                              | `leaf-job.ts` — queue drain loop |
| **Triggered by**             | HTTP request (`POST /runs`)                            | Redis Streams queue depth        |
| **Calls**                    | `runLeaf()` inline (sync) or enqueues to Redis (async) | `processOne()` → `runLeaf()`     |
| **kubectl exec → sandbox-0** | Yes                                                    | Yes                              |

Both paths converge on `runLeaf()`, which uses `K8sSandboxClient` to route all tool execution into sandbox-0. The "brain" (model inference + session logic) runs in whichever pod called `runLeaf()`; the "hands" (actual code/tool execution) always run in sandbox-0.

### Invocation Contract

Same endpoint, one flag flips the mode:

```
POST /runs { sessionId, inputsRef, resultRef }               → sync  (200 with result)
POST /runs { sessionId, inputsRef, resultRef, async: true }   → async (202 Accepted)
```

> The pre-rename paths `POST /run-leaf` and `GET /run-leaf/status` remain as **deprecated aliases**
> (they log a deprecation warning and will be removed in a later release).

- **Sync** — the Knative pod calls `runLeaf()` itself, waits for completion, returns the result. Pod stays alive for the duration.
- **Async** — the Knative pod pushes the envelope onto Redis Streams, returns 202 immediately, goes idle (scales to zero). A leaf-worker pod later drains the queue.

### Cluster Footprint at Rest

| Always on                            | Scales to zero                                             |
| ------------------------------------ | ---------------------------------------------------------- |
| **Redis** (session state + queue)    | Knative Service (cold-starts on first request, sub-second) |
| **sandbox-0** (persistent workspace) | leaf-worker (KEDA, zero when queue empty)                  |
|                                      | cron-dispatch (exists only during CronJob fire)            |

**2 pods at idle.** All compute (Knative Service, leaf-workers) scales to zero when no work is pending. Even the async enqueue path cold-starts from zero — the Knative activator intercepts the first request, spins up a pod, the pod enqueues and returns 202, then idles back to zero after 30s. sandbox-0 stays up because it holds the persistent working directory (files, packages, git state) that must survive across leaf invocations.

### Security Posture (PR #16)

All workload pods run hardened:

- Non-root UID 65532, `fsGroup: 65532` for PVC group-write
- `readOnlyRootFilesystem: true` + `/tmp` emptyDir for scratch
- `capabilities: { drop: [ALL] }`, seccomp `RuntimeDefault`
- No service account token automount

### Durable Resume (PR #11)

`runLeaf()` is Redis-backed: sessions survive pod eviction and cold-start. Resume by `sessionId` (slash→dash mapping via `toSessionId()`). Custom-entry recovery replays the durable verdict on restart — the leaf never loses a decision, even if the pod dies between verdict write and completion.

---

## 3. Plan to Run the MVP

The following plan operationalizes what is already built. Zero-trust (Z2/Z3), MCP code-mode (Z4), and multi-agent isolation (Z6) are explicitly **deferred to Phase 2**.

### 3.1 End-to-End Demo Scenario

A single demonstration exercising all three archetypes in sequence:

1. **Sync interactive** — User triggers a leaf via UI → Knative cold-starts → executes a single-turn agent task → returns result (proves scale-to-zero + instant resume).
2. **Async batch** — Orchestrator fans out 5 research sub-tasks `{async: true}` → queue fills → KEDA scales workers → done-markers appear → orchestrator aggregates results.
3. **Human gate** — One sub-task encounters an approval point → pauses → UI polls status (`awaiting_approval`) → human approves → leaf resumes → completes.
4. **Scheduled** — A CronJob fires nightly, dispatching a "daily digest" leaf that summarizes the day's completed work.

### 3.2 MVP Boundary

**What works today (no zero-trust required):**

- All three dispatch archetypes on Kind and OpenShift
- Scale-to-zero with sub-second cold-start resume
- Durable sessions surviving pod eviction
- Human-gate pause/approve/reject/abort with idempotency
- Hardened security posture (non-root, read-only rootfs, drop caps)

**Known limitations (deferred to Phase 2):**

- No credential injection — `ANTHROPIC_API_KEY` is a pre-provisioned K8s Secret (trust-the-operator)
- No egress policy — sandbox can reach any endpoint (no NetworkPolicy enforcement)
- No per-session identity — all leaves share the service account's SPIFFE identity
- Trust-the-orchestrator model — the orchestrator is assumed honest (no signed envelopes or audit trail)

---

## Phase 2 Preview (Z-track, design complete)

| Milestone              | Adds                                                        |
| ---------------------- | ----------------------------------------------------------- |
| Z1 Identity Spine      | Per-session SPIFFE SVID via SPIRE                           |
| Z2 Harness Lock-Down   | Secret-free distroless container, default-deny egress       |
| Z3 Inference Injector  | Provider-key chokepoint, mTLS to LLM gateway                |
| Z4 MCP Code-Mode       | Model-authored code runs in sandbox, transparent AuthBridge |
| Z5 Credentialed Egress | Forward proxy + baked CA for sandbox outbound               |
| Z6 Subagents           | Isolated child sessions with scoped credentials             |
| Z7 Validation          | Red-team + formal verification of the credential plane      |

---

_Assisted-By: Claude Code_
