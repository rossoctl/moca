# Async Leaf Completion (spec §9.1) — Design

Version: 1.0 — June 27, 2026
Status: Design (approved for implementation planning)
Scope: The first **post-MVP scale increment** — true **background** (asynchronous) execution of
leaf sessions, so an external orchestrator can dispatch work that runs for minutes without holding a
blocking HTTP connection. Realizes MVP spec [§9.1 Async completion](2026-06-26-mvp-leaf-session-contract-design.md).
Builds on (reuse, no redesign): the leaf-session contract + `runLeaf` (MVP/PR #10), gate-7 durable
resume (PR #11), M2/M3 sandbox, M4 Knative, M6 model selection.
Substrate: **KEDA `ScaledJob` consuming a Redis Streams work queue.** Single-tenant, key-in-env.

> **What this slice is NOT.** Not multi-tenancy (Z1 identity, Z3/Z5 per-user credentials, per-tenant
> sandbox/data isolation are all deferred — see §8). Not the cron/event trigger on-ramp (Archetype C)
> nor the human-gate (Archetype B); the substrate is designed not to preclude them (§7), but they are
> not built here. The synchronous `POST /runs` is unchanged.

> **Superseded in part by P1 (July 2, 2026).** The **done-marker + `result_ref` file** on the shared
> `/work` PVC is replaced by a single **Redis result record** (`leaf:result:<sessionId>`) read via
> `GET /runs/status?sessionId=…`, in
> [`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md) §3.4–§4. The
> KEDA `ScaledJob` + Redis Streams queue and the claim/ack/retry/dead-letter mechanics are unchanged;
> only the verdict/marker transport moves off the filesystem.

---

## 1. Goal & motivation

The MVP `POST /runs` **blocks** until the leaf reaches a terminal state. That is fine for the
short stub task, but real Archetype-A validation leaves (builds, proofs) run for minutes, and an
orchestrator fanning out tens–hundreds of them cannot hold that many long-lived connections. Async
completion decouples the orchestrator from task duration:

> Invoke returns **immediately** with a handle; the leaf runs to completion **in the background**;
> the harness writes `result_ref` + a **done-marker**; the orchestrator **polls** the marker (or a
> status endpoint) and reads the result when terminal.

### Archetype fit (why this increment, and why this substrate)

- **A — parallel fan-out** (the immediate driver): bursty, queue-fed fan-out with a concurrency cap;
  served directly.
- **B — iterative role-based loop**: "gate-while-idle" (a session sleeps awaiting approval) is the
  canonical async + scale-to-zero + durable-resume case (archetypes §7.6). Not built here, but the
  substrate (scale-from-queue-to-zero + resume) is exactly what B will reuse.
- **C — scheduled ingestion**: needs cron/event triggers as the _start signal_. KEDA's scaler
  catalog (cron, queue/stream) is precisely that on-ramp — adopting KEDA now is the production trigger
  substrate C will extend, without bespoke trigger code.

KEDA is CNCF-graduated, the de-facto event-driven autoscaling layer, coexists with Knative (Serving
for sync request/response; KEDA for async/queue/cron), keeps triggering/scaling **declarative and out
of the harness**, and reuses the Redis we already operate (its session log already uses Redis
Streams). The cost — KEDA as a cluster prerequisite + a work queue + a job-mode entrypoint — is
justified by the A-now / B-and-C-future fit.

---

## 2. Architecture & request path

The async path is **additive**: synchronous `POST /runs` is unchanged. Async splits the harness
into a thin **control plane** (the Knative Service) and an ephemeral **data plane** (KEDA-spawned
Jobs).

```
orchestrator
  │  POST /runs  { ...envelope, async: true }
  ▼
Knative Service (control plane)
  │  validate envelope → XADD leaf-queue (Redis Stream) → 202 { accepted, sessionId, resultRef, doneMarker }
  ▼
Redis Stream "leaf-queue" (consumer group "leaf-workers")   ◄── KEDA redis-streams scaler watches pending count
  │                                                              (0 pending ⇒ scale to zero; cap = maxReplicaCount)
  ▼  KEDA spawns one Job per pending entry
leaf-job  (same image, job-mode entrypoint)
  │  claim one entry → runLeaf(envelope)        (reuses sandbox routing, gateway, gate-7 resume — unchanged)
  │  → write result_ref → write done-marker → XACK → exit
  ▼
shared /work PVC:  results/<item>.json  +  <result_ref>.status (done-marker)
  ▲
orchestrator polls the done-marker on its own volume   (or GET /runs/status?sessionId=… for queue visibility)
```

**Components** (each independently testable):

| Unit              | Responsibility                                                                   | Lives in                                   |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| enqueue handler   | validate envelope, `XADD` to `leaf-queue`, return `202` + handle                 | `knative-server/src/server.ts`             |
| status handler    | report `queued\|running\|done\|failed` from the marker (+ queue state)           | `knative-server/src/server.ts`             |
| `WorkQueue`       | Redis Streams primitive: `ensureGroup`/`enqueue`/`claim`/`ack`/`touch`/`pending` | `packages/work-queue` (`@moca/work-queue`) |
| `leaf-job-runner` | wrapper loop: claim → `runLeaf` → classify → marker → ack/reclaim                | `harness/src/leaf-job-runner.ts`           |
| `classifyOutcome` | pure ack-vs-reclaim decision (see §6)                                            | `harness/src/classify-outcome.ts`          |
| done-marker       | atomic write/read of `<result_ref>.status`                                       | `harness/src/done-marker.ts`               |
| job entrypoint    | thin `main`: real queue + backend → `leaf-job-runner`                            | `knative-server/src/leaf-job.ts`           |
| KEDA `ScaledJob`  | redis-streams trigger → Job per pending entry, scale-to-zero, cap                | `deploy/knative/leaf-scaledjob.yaml`       |

**Key properties:** true background (Jobs outlive the request); scale-to-zero (no always-on worker);
**at-least-once** delivery, where a crashed leaf re-runs the same `sessionId` → **gate-7 resume**; the
orchestrator owns the result store (charter G3 — the marker travels on its volume, the harness is not
on the completion critical path).

**RBAC note:** the harness Service does **not** create Jobs — **KEDA** does, from the `ScaledJob`. So
no Job-management RBAC is added to the harness; the Job pod reuses the existing `moca`
ServiceAccount (sandbox `pods/exec`).

---

## 3. The async contract

### 3.1 Envelope additions (backward-compatible)

`LeafEnvelope` gains three optional fields; defaults preserve today's behavior exactly:

- `async?: boolean` (default `false`) — `false`/omitted ⇒ synchronous as today (`200` + terminal
  status); `true` ⇒ enqueue, return `202`.
- `doneMarkerRef?: string` — overrides the derived marker path (default `<resultRef>.status`, kept in
  the orchestrator-owned directory).
- `tenant?: string` — namespaces the queue stream and the session id (non-precluding; see §7).
  Default: the single shared queue.

### 3.2 Enqueue — `POST /runs` with `async: true`

```
POST /runs  { sessionId, model?, inputsRef, resultRef, workspaceRef?, maxTurns?, async: true }
→ 202 { status: "accepted", sessionId, resultRef, doneMarker }     // XADD'd to leaf-queue
→ 400 { error: "envelope_invalid" }                                 // not enqueued
```

### 3.3 Done-marker — the completion signal (§9.1)

A small JSON file the leaf-job writes **last, atomically** (temp file + rename):

```json
{ "status": "done" | "failed", "sessionId": "...",
  "reason": null | "no_verdict" | "invalid_verdict" | "bad_inputs" | "error",
  "ts": "<iso8601>" }
```

Written _after_ `result_ref` on success, or _instead of_ it on failure — so a single file
unambiguously signals terminal state for both outcomes (`result_ref` alone cannot: failures write
none, and a result mid-write looks "present").

### 3.4 Completion is observed two ways

- **Primary (canonical):** the orchestrator polls the **done-marker on its own volume**; the harness
  is not on the completion critical path.
- **Secondary (convenience):** `GET /runs/status?sessionId=…` → `{ status: queued | running |
done | failed, reason? }`, where `done|failed` come from the marker and `queued|running` from the
  queue/consumer-group state.

### 3.5 Idempotency & delivery semantics

Delivery is **at-least-once**. A crashed leaf re-runs the same `sessionId` → gate-7 resume →
idempotent overwrite of `result_ref` + marker. The orchestrator only observes the marker once it is
terminally written. A true retry with fresh state uses a **new** `sessionId` (consistent with MVP
spec §2.4).

---

## 4. Work queue + KEDA ScaledJob

### 4.1 The queue

A dedicated Redis Stream `leaf-queue` (separate from the `session:*` session streams), with a
consumer group `leaf-workers` created idempotently (`XGROUP CREATE … MKSTREAM`, ignore `BUSYGROUP`).
Enqueue is `XADD leaf-queue * envelope <json>` (the whole envelope as one field). With a `tenant`,
the stream is `leaf-queue:<tenant>` (§7).

### 4.2 Delivery lifecycle (at-least-once)

- `XADD` → entry _pending_ (unconsumed).
- A leaf-job claims via `XREADGROUP … COUNT 1` → entry enters the group's **PEL**
  (delivered-but-unacked).
- Terminal completion (`done` or a deterministic `failed`) → write `result_ref`/marker → **`XACK`** →
  entry leaves the PEL.
- **Crash before ack** (OOM, eviction, node death) → entry stays in the PEL → a later job
  **`XAUTOCLAIM`**s it after `min-idle` → re-runs the same `sessionId` → **gate-7 resume**.

### 4.3 Avoiding false reclaims of healthy long runs

A long leaf would otherwise look "idle" in the PEL and be reclaimed while still running. The leaf-job
runs a lightweight **heartbeat** (`XCLAIM … JUSTID` on its own entry every ~30 s) that resets the
idle timer, so `min-idle` (~90 s) reclaims only genuinely-dead consumers.

### 4.4 Bounded retry / dead-letter

`XPENDING` exposes a per-entry **delivery count**. When it exceeds `maxAttempts` (e.g. 3), the
reclaiming job writes a `failed` marker (reason `error`) and `XACK`s — a dead-letter — so a poison
entry cannot loop forever. (No separate DLQ stream in this slice.)

### 4.5 KEDA ScaledJob

```yaml
triggers:
  - type: redis-streams
    metadata:
      address: redis.default.svc:6379
      stream: leaf-queue
      consumerGroup: leaf-workers
      pendingEntriesCount: "1"        # ~one Job per pending entry
maxReplicaCount: 10                   # the concurrency cap (Archetype A per-class cap analog)
jobTargetRef:
  template:                           # same image, job-mode entrypoint
    # command: node --import tsx src/leaf-job.ts
    # env: REDIS_URL, SH_MODEL, KAGENTI_SANDBOX_POD, ANTHROPIC_* (llm-credentials)
    # volumeMounts: /work (leaf-work PVC);  serviceAccountName: moca
ttlSecondsAfterFinished + history limits   # GC finished Jobs
```

KEDA scales on the consumer group's **outstanding entries** — undelivered backlog (lag) plus stuck
PEL entries (the redis-streams scaler exposes `pendingEntriesCount`/lag for this). New work spawns
jobs; a crashed entry sitting in the PEL keeps a reclaimer scheduled (a freshly-spawned job
`XAUTOCLAIM`s it on startup, §5); and when the group fully drains the `ScaledJob` **scales to zero**.
Bursty fan-out drains up to `maxReplicaCount` then back to zero. (The exact scaler metadata is pinned
in the implementation plan.)

---

## 5. Leaf-job entrypoint + failure classification

`runLeaf` is reused **unchanged**; the job is a thin queue wrapper around it.

```
ensureGroup()
claimed = queue.claim(consumerId, { minIdle, block })   // XAUTOCLAIM a stale entry first, else XREADGROUP >
if !claimed: exit 0                                       // queue drained (benign race)
if claimed.deliveryCount > maxAttempts:                   // dead-letter bound
   writeDoneMarker(failed, "error"); queue.ack(id); exit 0
hb = every 30s → queue.touch(id, consumerId)              // heartbeat vs false reclaim
result = await runLeaf(envelope, buildConfig())           // resume by sessionId (gate 7)
{ ack, marker } = classifyOutcome(result)
if marker: writeDoneMarker(marker)
if ack: queue.ack(id)        else: throw (leave pending → reclaim)
clearInterval(hb)
```

`consumerId` = pod name (`HOSTNAME`); `buildConfig()` mirrors the server's (REDIS_URL + gateway creds
from env).

**`classifyOutcome` — the ack-vs-reclaim crux:**

| Outcome                                                           | done-marker       | Queue action         | Rationale                                                                                                 |
| ----------------------------------------------------------------- | ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `runLeaf` → `done`                                                | `done`            | **XACK**             | success; `result_ref` written                                                                             |
| `runLeaf` → `failed: bad_inputs \| no_verdict \| invalid_verdict` | `failed` + reason | **XACK**             | deterministic; re-running won't help (orchestrator re-dispatches with a _new_ sessionId for a true retry) |
| `runLeaf` → `failed: error` (model/gateway blip)                  | none yet          | **no ack → reclaim** | possibly transient; bounded retry via delivery count → on exhaustion, `failed` marker + ack               |
| process **crash** (OOM/evict/SIGKILL, no return)                  | none              | **no ack → reclaim** | entry stays in PEL → `XAUTOCLAIM` after `min-idle` → **gate-7 resume**; bounded by `maxAttempts`          |

**Effectively-once outcome:** at-least-once delivery × idempotent `runLeaf` (resume + overwrite) =
the same verdict regardless of redelivery. A rare double-process (partition after the heartbeat
lapses) has both writers produce the same `sessionId` result — last-writer-wins, identical. Accepted;
noted as an honest caveat.

---

## 6. Testing & verification gate

### 6.1 Unit (fast, vitest)

| Unit              | Coverage                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkQueue`       | `XADD`→`XREADGROUP` returns the entry; `XACK` clears the PEL; `XAUTOCLAIM` reclaims past `min-idle`; delivery-count increments; `pending`. Against a real Redis, **gated** like the existing `redis-backend` tests (skip when no `REDIS_URL`). |
| `classifyOutcome` | pure §5 table: `done`→ack+done; `bad_inputs/no_verdict/invalid_verdict`→ack+failed; `error`→no-ack/retryable; exhausted→failed+ack.                                                                                                            |
| enqueue handler   | `vi.mock` queue → `202`+`XADD` once on valid async envelope; `400` no-`XADD` on malformed; **async omitted/false still runs the sync path** (no regression).                                                                                   |
| status handler    | marker present→done/failed; absent+pending→queued/running (injected marker-reader + queue-state).                                                                                                                                              |
| `leaf-job-runner` | injected fakes (queue, `runLeaf`, marker writer, clock): autoclaim-preferred-over-read; dead-letter when delivery>max; heartbeat scheduled+cleared; ack-on-terminal; no-ack+rethrow on retryable.                                              |
| done-marker       | atomic temp+rename; correct JSON for `done` and `failed`.                                                                                                                                                                                      |

### 6.2 Live gate — `deploy/knative/leaf-async-smoke.sh` (gated `ASYNC_LIVE_SMOKE=1`)

Prereq: KEDA + `ScaledJob` applied; fixtures seeded (repo → `sandbox-0`, inputs → `/work`).

1. **Async accept:** N × `POST {async:true}` → each `202` + handle, returns fast (no blocking).
2. **KEDA scale-out:** Jobs/pods for the `ScaledJob` reach ≥2 concurrently — true background from the queue.
3. **Completion via done-marker:** poll markers on `/work` until all N present; each `status:done` +
   `result_ref` holds the correct verdict (i1=FLAGGED, i2/i3=CLEAR).
4. **Crash-resume (async):** kill a running leaf-job pod mid-run → entry reclaimed (new Job) → leaf
   still completes (marker `done` + verdict) — at-least-once × gate-7 resume.
5. **Scale-to-zero:** after drain, the `ScaledJob` scales to **zero** leaf-job pods within a timeout (PEL empty).
6. **Deterministic failure:** bad `inputsRef` → marker `failed`/`bad_inputs`, no `result_ref`, entry
   acked (Job count does not grow — no reprocess).

`setup-kind.sh` gains an idempotent KEDA install (like the PVC feature flags) so the gate is
reproducible. Verbose `kubectl`/build output redirects to logs, analyzed in subagents (CLAUDE.md
context-budget).

---

## 7. Multi-tenancy — non-precluding design property (not built)

The queue substrate adapts to **per-user queues** without redesign: an optional `tenant` field
namespaces the stream (`leaf-queue:<tenant>` + its own consumer group) and the `sessionId` (prefixed,
then `toSessionId`-sanitized). This yields separate backlogs, fairness, and scaling per tenant.

**KEDA caveat:** a `ScaledJob` watches _one_ stream. A small, known tenant set → one `ScaledJob` per
tenant (true per-user queues). Dynamic/many users → either provision a `ScaledJob` per tenant at
onboarding, or run a single `ScaledJob` over a shared stream with tenant-tagged entries + app-level
per-tenant caps (workload separation, not separate queues).

**Separate queues ≠ multi-tenant.** They give workload separation + per-tenant scaling, **not**
security isolation. Real multi-user additionally needs, all deferred to the Z-track:

- **Identity / authn (Z1)** — the enqueue API is trusted/unauthenticated today; `tenant` is a label,
  not a security boundary.
- **Per-user credentials (Z3/Z5)** — one shared env provider key today.
- **Per-tenant sandbox + data isolation** — `sandbox-0` and `/work` are shared today.

This slice keeps `tenant` as an opt-in label that defaults to the single shared queue; the
stream-per-tenant + `ScaledJob`-per-tenant wiring is **not** built.

---

## 8. Scope / YAGNI — explicitly NOT building

- Authn/identity (Z1); per-user credentials (Z3/Z5); per-tenant sandbox/data isolation.
- Cron/event triggers for Archetype C (KEDA's cron scaler is the on-ramp — noted, not built).
- Human-gate for Archetype B (the substrate enables gate-while-idle — noted, not built).
- Priority / fairness classes (the external orchestrator's concern, per Archetype A).
- A separate dead-letter queue stream (dead-letter = `failed` marker + ack).
- Changes to synchronous `POST /runs` (unchanged).

**Substrate-agnostic seam:** the async _contract_ (enqueue envelope → background execution →
`result_ref` + done-marker + status) depends only on the `WorkQueue` interface + `leaf-job-runner`,
not KEDA. A KEDA-less cluster could drive the same queue with harness-created Jobs or an always-on
worker without changing `runLeaf` / done-marker / status — the documented fallback.

---

## 9. Cluster prerequisites

- **KEDA** (new) — installed idempotently by `setup-kind.sh`; a prod manifest/Helm release elsewhere.
- Redis, the `leaf-work` `/work` PVC, `sandbox-0`, the `llm-credentials` secret — all existing.
- The `leaf-queue` consumer group — auto-ensured at first enqueue.

---

## 10. References

- [MVP Thin Slice](2026-06-26-mvp-leaf-session-contract-design.md) — §9.1 (this increment), §2.4 (idempotency), §5 (volume), §7 (gate this extends).
- [Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md) — §7.1 trigger on-ramp (C), §7.6 gate-while-idle (B), §7.3 parallelism/idempotent re-invocation (A).
- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — G1/G2 (harness is invoked, not orchestrator), G3 (orchestrator owns the store).
- Built base reused: leaf-session contract + `runLeaf` (PR #10), gate-7 resume (PR #11), M2/M3/M4/M5/M6.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
