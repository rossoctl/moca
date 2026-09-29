# Scheduled Leaf Dispatch (Archetype C trigger on-ramp) — Design

Version: 1.0 — June 28, 2026
Status: Design (approved for implementation planning)
Scope: The **cron trigger on-ramp** for Archetype C (scheduled ingestion): a Kubernetes `CronJob`
becomes the **start signal** that dispatches a static, config-defined list of leaf sessions onto the
existing async path. Purely additive; the async contract, work queue, KEDA `ScaledJob`, and `runLeaf`
are all **unchanged**.
Builds on (reuse, no redesign): async leaf completion (`POST /runs {async:true}` + `leaf-queue` +
KEDA `ScaledJob`, [async design](2026-06-27-async-leaf-completion-design.md)), the leaf-session
contract + `runLeaf` (MVP/PR #10), gate-7 resume (PR #11).

> **What this slice is NOT.** Not dynamic ingestion (no "scan a directory → one leaf per new file" —
> that batch-selection is the external orchestrator's job, charter G1/G2; deferred). Not event
> triggers (cron only). Not the KEDA `cron` scaler (wrong primitive — it is window-based, not a
> discrete fire-once-at-time-T scheduler; see §4). No multi-tenant schedules, no missed-fire
> backfill. The synchronous and manual-async `POST /runs` paths are unchanged.

---

## 1. Goal & motivation

Archetypes A (parallel fan-out) and B (iterative loop) start from an _invocation_ — an external
orchestrator dispatches work. **Archetype C — scheduled ingestion** starts from a _clock_: "every
night at 02:00, process the standing batch." The harness already accepts background work via
`POST /runs {async:true}`; this slice adds the missing **start signal** so a schedule — with no
external orchestrator process running — can dispatch that work.

The capability catalog ([archetypes §7.1](2026-06-26-pipeline-archetypes-requirements.md)) lists
"scheduler (cron) + event triggers as the start signal" as the ⭐ trigger on-ramp to promote
post-MVP. This realizes the **cron** half of it.

### Charter fit (why this respects "harness is invoked, not orchestrator")

The harness charter (G1/G2) is that the harness is _invoked_, never the orchestrator. A cron schedule
that dispatches a **fixed, config-defined list** does not violate this: the schedule and the list are
**operator-supplied configuration**, not a decision the harness computes. The CronJob is a thin
_client_ of the unchanged async contract — equivalent to an external caller that happens to be driven
by a clock. Dynamic work-selection (deciding _what_ to process at fire time) would be orchestration
and is explicitly out of scope (§8).

---

## 2. Architecture & request path

Additive. The CronJob is an in-cluster client of `POST /runs {async:true}`; everything
downstream of the enqueue is the async path, unchanged.

```
K8s CronJob   (.spec.schedule, concurrencyPolicy: Forbid)
  │  fires → creates Job "leaf-cron-<unix-sched-time>"   ← the FIRE ID
  ▼
cron-dispatch pod   (harness image; node --import tsx src/cron-dispatch.ts)
  │  reads: schedule config (ConfigMap mount) + own Job name (downward API)
  │  for each envelope in the config list:
  │     substitute __FIRE__ → <job-name> in sessionId + resultRef (+ any string field)
  │     POST {…envelope, async:true}  → expect 202 { accepted }
  ▼
Knative Service  (control plane)  → XADD leaf-queue            [UNCHANGED]
  ▼
leaf-queue (Redis Stream) ◄── KEDA ScaledJob → leaf-job → runLeaf → result_ref + done-marker  [UNCHANGED]
  ▲
operator/orchestrator reads markers under the fire-stamped resultRef dir
```

**Components** (each independently testable):

| Unit                 | Responsibility                                                                                                                                                                                                                                                             | Lives in                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `cron-dispatch`      | read config + fire id → POST each templated envelope async; aggregate result → exit code                                                                                                                                                                                   | `packages/knative-server/src/cron-dispatch.ts` |
| schedule + item list | **one manifest, two YAML docs:** a ConfigMap (envelope list + `sessionId`/`resultRef` templates with `__FIRE__`) and the CronJob (schedule, `concurrencyPolicy: Forbid`, downward-API Job-name env, ConfigMap mount, harness image, `moca` SA). Single `kubectl apply -f`. | `deploy/knative/leaf-cron.yaml`                |
| live gate            | gated smoke: a fire dispatches the list → leaves complete; dispatcher-retry is idempotent                                                                                                                                                                                  | `deploy/knative/leaf-cron-smoke.sh`            |

**Key properties:** no new harness logic on the enqueue path (the dispatcher is a client of the
existing contract); no Job RBAC beyond the existing `moca` ServiceAccount; the schedule
lives in `CronJob.spec.schedule` so Kubernetes owns cron semantics.

---

## 3. The dispatch contract

### 3.1 Config (a ConfigMap-mounted JSON document, co-located with the CronJob)

The config ships as a ConfigMap defined **in the same `deploy/knative/leaf-cron.yaml`** as the
CronJob (two `---`-separated documents). The operator workflow is plain declarative Kubernetes: edit
the manifest and `kubectl apply -f deploy/knative/leaf-cron.yaml` to create or change the batch and
its cadence; `kubectl create job --from=cronjob/leaf-cron <name>` to fire one on demand. There is no
schedule-submission API — registering schedules is the operator's `kubectl` (or the external
orchestrator's), not a harness control plane (charter G1/G2).

```json
{
  "items": [
    {
      "sessionId": "nightly/__FIRE__/i1",
      "inputsRef": "/work/nightly/inputs/i1.json",
      "resultRef": "/work/nightly/__FIRE__/results/i1.json",
      "workspaceRef": "/workspace/nightly/repo",
      "model": "claude-haiku-4-5"
    },
    {
      "sessionId": "nightly/__FIRE__/i2",
      "inputsRef": "…/i2.json",
      "resultRef": "/work/nightly/__FIRE__/results/i2.json",
      "workspaceRef": "/workspace/nightly/repo"
    }
  ]
}
```

- `__FIRE__` is the only template token; the dispatcher replaces it (every occurrence, in every
  string field) with the fire id. Fields without `__FIRE__` are passed through verbatim.
- `inputsRef`/`workspaceRef` point at operator-provisioned data — the design does **not** fabricate
  inputs, exactly as today's manual async dispatch does not.
- `model` optional (defaults to the harness/env default), consistent with the envelope.

### 3.2 Fire identity & substitution

The **fire id** is the dispatcher pod's owning **Job name**, read via the downward API
(`metadata.labels['job-name']`). Properties that make it the correct idempotency key:

- **Unique per scheduled fire:** the CronJob names each Job `…-<unix-scheduled-time>`.
- **Stable across a Job's pod retries:** if the dispatcher pod fails and `backoffLimit` restarts it,
  the new pod is under the _same_ Job → same fire id → re-POSTs the _same_ `sessionId`s.

### 3.3 Idempotency & delivery semantics

- Each scheduled fire is a **fresh run** (new Job name → new `sessionId`s → distinct from prior
  nights). `resultRef` is fire-stamped so runs do not overwrite each other.
- A **retried dispatcher** (same fire) re-POSTs identical `sessionId`s. Because `runLeaf` is
  idempotent by `sessionId` (gate-7 resume + overwrite), a partially-dispatched fire that retries
  **resumes/overwrites** rather than duplicating — at-least-once dispatch with effectively-once
  outcome, consistent with [async §3.5](2026-06-27-async-leaf-completion-design.md) and MVP §2.4.
- `concurrencyPolicy: Forbid` prevents two dispatcher Jobs for the same CronJob overlapping (a slow
  fire won't be double-started by the next tick). Leaf executions across _different_ fires may
  overlap freely — they are distinct `sessionId`s.

### 3.4 Dispatcher result → exit code

For each item: POST `{…envelope, async:true}` to the service; treat HTTP `202` with
`status:"accepted"` as success. Any non-`202`, missing `accepted`, or network error is logged and the
dispatcher **continues** the remaining items, then **exits non-zero** so the CronJob records the fire
as failed (and `backoffLimit` retries the whole fire — safe because the fire id is stable). All items
accepted → exit `0`. The dispatcher adds **no** validation; the server already returns `400` for a
malformed envelope, which the dispatcher surfaces as a failed fire.

---

## 4. Why a CronJob, not the KEDA cron scaler

The async design noted "KEDA's cron scaler is the on-ramp." On implementation that is the wrong
primitive: KEDA's `cron` scaler is **window-based** — it scales a workload's replicas _up between_ a
`start`/`end` cron pair and back down after, intended for "keep N replicas warm during business
hours." It does not model a **discrete fire at time T**, and on a `ScaledJob` it would spawn jobs
continuously across the active window. The native Kubernetes **`CronJob`** is the correct discrete
scheduler. KEDA remains the right tool for the _queue_ half (already in use for the `ScaledJob`); the
_schedule_ half is a `CronJob`. This supersedes the async spec's passing note.

---

## 5. In-cluster invocation

The dispatcher POSTs to the Knative service over cluster-internal networking:

- URL: `SH_SERVICE_URL` (default `http://kourier-internal.kourier-system.svc.cluster.local`), with
  `Host: moca.default.example.com` so Kourier routes to the ksvc. (Knative also exposes
  `moca.default.svc.cluster.local`; the exact address is pinned in the plan against the
  live cluster.)
- The service cold-starts from zero on the request (scale-from-zero), so no always-on cost between
  fires.
- The dispatcher needs only network egress to the in-cluster service; it reuses the
  `moca` ServiceAccount (no new RBAC).

---

## 6. Testing & verification gate

### 6.1 Unit (vitest, pure — injected `fetch`, no cluster)

`cron-dispatch`:

- each config item is POSTed exactly once to `/runs` with `async:true`;
- `__FIRE__` is substituted with the fire id in `sessionId` **and** `resultRef` (and any other field
  containing it); non-templated fields pass through verbatim;
- all `202` → exit code 0; any non-`202`/error → non-zero exit (and remaining items still attempted);
- empty `items` → no POST, exit 0.

### 6.2 Live gate — `deploy/knative/leaf-cron-smoke.sh` (gated `CRON_LIVE_SMOKE=1`)

Deterministic (no waiting on a real cron tick): trigger a fire with
`kubectl create job --from=cronjob/leaf-cron <name>`. Prereq: async path deployed (KEDA + ScaledJob),
fixtures seeded (inputs on `/work`, repo in `sandbox-0`), `leaf-cron.yaml` applied (its ConfigMap + CronJob).

1. **Schedule validity:** `leaf-cron.yaml` applies clean (the cron expression is accepted by the API
   server).
2. **Dispatch:** a manual fire → all N entries enqueued → leaves complete; each done-marker present
   under the **fire-stamped** `resultRef` dir with the correct verdict (i1=FLAGGED, i2/i3=CLEAR).
3. **Idempotent retry:** re-run the dispatcher with the **same** fire id (`JOB_NAME`) → the same
   `sessionId`s → no new/duplicate leaf runs for that fire (marker set identical; no extra results).

Verbose `kubectl`/build output redirects to logs, analyzed in subagents (CLAUDE.md context-budget).

---

## 7. Multi-tenancy / extension — non-precluding (not built)

The config is a flat list today. The same `cron-dispatch` + ConfigMap shape extends to per-tenant
schedules (one CronJob + ConfigMap per tenant) and to **event** triggers (a different start signal
invoking the same dispatcher) without changing the contract. Dynamic ingestion (compute the item
list at fire time) would replace the static list with a manifest/listing step — a future slice, kept
out here so the harness performs no work-selection.

---

## 8. Scope / YAGNI — explicitly NOT building

- Dynamic fan-out / ingestion (scan-a-dir, manifest expansion) — the external orchestrator's job.
- Event triggers (cron only this slice).
- KEDA `cron` scaler (wrong primitive — §4).
- Per-tenant schedules; missed-fire backfill/catch-up (`startingDeadlineSeconds` left at default).
- Any change to the async contract, `leaf-queue`, KEDA `ScaledJob`, or `runLeaf` (all unchanged).
- A new container image — the dispatcher reuses the harness image.

---

## 9. Cluster prerequisites

- Everything async already needs (KEDA, `leaf-queue`/group, the `leaf-work` PVC, `sandbox-0`,
  `llm-credentials`, the Knative service).
- The new `deploy/knative/leaf-cron.yaml` — the ConfigMap and the CronJob in one manifest, a single
  `kubectl apply -f`. `CronJob` is core Kubernetes — `setup-kind.sh` needs nothing new.

---

## 10. References

- [Async Leaf Completion](2026-06-27-async-leaf-completion-design.md) — the substrate this reuses (queue, ScaledJob, async contract, idempotency §3.5).
- [Pipeline Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md) — §7.1 trigger on-ramp (C), §8 "promote post-MVP".
- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — G1/G2 (harness is invoked, not orchestrator).
- [MVP Thin Slice](2026-06-26-mvp-leaf-session-contract-design.md) — §2.4 idempotency (new sessionId = fresh run).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
