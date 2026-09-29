# P2 — Shared Sandbox Pool + Harness→Sandbox Routing — Design

Version: 1.0 — July 2, 2026
Status: Design (approved for implementation planning)
Scope: **Phase 2 (P2)** of the [two-tier FS-free harness epic](https://github.com/rossoctl/moca/issues/49)
([P2 issue #46](https://github.com/rossoctl/moca/issues/46)). Depends on **P1** (FS-free harness,
[#45](https://github.com/rossoctl/moca/issues/45)), which is merged. Scales Archetype A from one
sandbox to **many leaf harnesses sharing a smaller pool of sandboxes** (N:M), with the repo distributed as
per-sandbox copies and no RWX on the deployable path.

---

## 1. Goal & motivation

After P1, the sandbox tier is a **single** agent-sandbox `Sandbox` CR (`sandbox-0`) with one RWO PVC, serving one
harness consumer. The harness resolves its exec target by reading `KAGENTI_SANDBOX_NAME` → the CR's
`.status.selector` → **the first Running pod** ([`packages/k8s-sandbox/src/resolve-pod.ts`](../../packages/k8s-sandbox/src/resolve-pod.ts)).
That is 1:1.

P2 makes it **N:M**: many short-lived, fresh-context leaf harnesses load-balance across a **static pool of N
sandbox pods**, so the dense, cheap harness tier is decoupled from the smaller, durable sandbox tier. The exact
sharing ratio (~20:1) is **not** fixed here — it is an empirical P3 experiment. P2 delivers the _mechanism_: pod
discovery, lease-based assignment, per-sandbox repo distribution, and per-leaf worktree isolation.

`kubectl exec` targets a **concrete pod name**, so "pick the first Running pod" must become deliberate,
load-aware pod selection. That is the heart of P2.

## 2. Decisions locked (brainstorm 2026-07-02)

These were settled during brainstorming and are not relitigated here:

| #   | Decision                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Storage topology: per-sandbox RWO copy.** Each sandbox pod holds its own repo copy on its own RWO PVC. **No RWX** on the deployable path. RWX (fleet-wide single repo) is documented as the alternative only.                                           | Runs on the EBS-only OCP 4.20 cluster today; matches "the harness mounts nothing"; RWX is heavier infra (EFS/CSI), slower networked FS, cross-pod contention. |
| D2  | **Routing: harness-side pick + Redis leases.** Selection logic stays in the harness/`@moca/k8s-sandbox` layer; Redis holds per-pod lease counters for least-loaded + capacity backpressure. **No new deployable component.**                              | Reuses the existing hard Redis dependency; crash-safe lease reclaim via TTL mirrors the existing leaf-resume model.                                           |
| D3  | **Repo seeding: ref-pinned lazy converge.** The envelope carries a git ref; on leaf start the leased pod's repo is fetched/converged to that ref, then a worktree is created. Idempotent (pod already at ref = no-op). **Eager pre-warm deferred to P3.** | Guarantees batch-wide commit consistency regardless of which pod a leaf lands on; amortizes clone cost across the sharing ratio; survives pod churn for free. |
| D4  | **Pool scaling: static N, config knob.** N `Sandbox` CRs declared in kustomize; N and per-pod cap are values tuned empirically in P3. **Autoscaling is future work only.**                                                                                | Deterministic, no new controller; saturation backpressures through the existing async Redis/KEDA queue and a bounded sync wait.                               |
| D5  | **Soft capacity cap.** ~20 is an empirical figure, not a safety bound; rare concurrent overshoot is acceptable.                                                                                                                                           | Avoids a hard-CAS hot path; the true safety boundary is Kata at the pod level (P3).                                                                           |

**Threat model (locked — from epic #49, not relitigated):** there is **no agent in the sandbox** — it is a
passive `kubectl exec` target. The threat is a **compromised/injected harness** and **kernel exploits**. Blast
radius is contained by giving the harness zero FS/exec surface (P1) and Kata-isolating only the sandboxes (P3).
Intra-pod cross-leaf isolation is therefore an explicit **non-goal** for the no-Kata P2 PoC (see §9).

## 3. Pool topology — N single-instance `Sandbox` CRs

agent-sandbox `v1beta1` **removed `spec.replicas`** (the `Sandbox` is a single-instance primitive; a warm pool is
an open upstream feature request, [kubernetes-sigs/agent-sandbox#34](https://github.com/kubernetes-sigs/agent-sandbox/issues/34)).
So the P2 pool primitive is **N distinct `Sandbox` CRs** `sandbox-0 … sandbox-{N-1}`:

- **Own RWO PVC each** via the existing `volumeClaimTemplates` — this _is_ the per-sandbox repo copy (D1). No
  shared volume, no RWX.
- **Distinct names** deliberately sidestep the agent-sandbox v0.5.0 **bare-pod name-collision / adopt-error**
  gotcha observed in P0′.
- **Common pod label** stamped via each CR's `podTemplate.metadata.labels` (e.g.
  `sh.kagenti.io/sandbox-pool: default`). Discovery selects on **this label across all N CRs' pods**, decoupling
  pool membership from any single CR's `.status.selector`.

```
                 label: sh.kagenti.io/sandbox-pool=default
   ┌───────────────┬───────────────┬─────── … ────────┐
 sandbox-0-0     sandbox-1-0     sandbox-2-0        sandbox-{N-1}-0
 PVC ws-0        PVC ws-1        PVC ws-2           PVC ws-{N-1}   (all RWO)
```

## 4. Routing & lease protocol

**Discovery is authoritative from Kubernetes; load is authoritative from Redis.** At leaf start the harness lists
**Running** pods matching `KAGENTI_SANDBOX_POOL_SELECTOR` (this naturally handles pods added, removed, or crashed),
then consults Redis for per-pod load and leases the least-loaded pod under the cap.

### 4.1 Lease as an expiry-scored set (crash-reclaim is implicit)

- Per-pod sorted set **`sh:sandbox:<pod>:leases`**, member = `runId`, score = **expiry timestamp** (ms).
- **Active load** = count of members with `score > now`.
- **Crash reclaim is implicit:** a crashed leaf's lease member simply ages past its expiry. Every acquire lazily
  sweeps expired members (`ZREMRANGEBYSCORE sh:sandbox:<pod>:leases -inf <now>`) — **no separate reaper process**.
  This mirrors the existing crash-safe leaf-resume model.
- A running leaf **heartbeats** (re-`ZADD`s its member with `expiry = now + TTL`) on an interval well below the
  TTL, so long-running leaves are never reclaimed mid-run. TTL and heartbeat interval are config values.

### 4.2 Acquire / release (atomic via Lua)

`ACQUIRE(pod, cap, runId, expiry)` — evaluated as a single Redis Lua script:

1. `ZREMRANGEBYSCORE` the pod's set to drop expired members.
2. If `ZCARD < cap`: `ZADD` `{runId → expiry}`, return `OK`.
3. Else return `FULL`.

The harness orders candidate pods by last-known load (cheap `ZCARD` reads, best-effort) and calls `ACQUIRE`
against them in order until one returns `OK`. `RELEASE(pod, runId)` = `ZREM`. Concurrency between two harnesses
racing the same pod can momentarily overshoot the soft cap by a small margin — accepted per D5.

### 4.3 Saturation (all pods FULL)

Bounded wait with backoff, up to a timeout:

- **Async leaves** overflow naturally: they already sit behind the Redis Streams queue drained by the KEDA
  ScaledJob, so work that cannot acquire stays queued and drains as leases free — no special handling.
- **Sync leaves** return **`503` with `Retry-After`** on timeout.

## 5. Repo lifecycle & workspace layout

The unit shared across leaves on a pod is the **git object store**, _not_ a working tree — so two leaves at
different commits never contend over a checkout.

- **`/workspace/repo`** — the canonical clone; its object store accumulates every ref ever fetched on that pod.
  **Converge = `git fetch origin <ref>`** (additive, idempotent; a pod already holding the ref is a no-op).
  Concurrent converges on one pod are serialized with a per-pod advisory lock
  (`flock /workspace/repo/.sh-fetch.lock`).
- **`/workspace/leaves/<runId>`** — the leaf's own `git worktree add <path> <commit>`, pinned to the exact commit
  resolved from the envelope ref. **This path is the leaf's `workspaceRef`.**
- **Cleanup:** `git worktree remove` on leaf end; orphaned worktrees from crashed leaves are reclaimed by
  `git worktree prune` plus a dir-age sweep performed opportunistically on acquire.

This yields **batch-wide consistency** (each leaf pins its own commit regardless of pod) _and_ lets a single pod
serve many refs concurrently.

## 6. FS-free contract & leaf-flow interaction

The credentialed harness continues to **touch no filesystem** (P1 contract preserved). Every FS mutation —
converge, `worktree add`, `worktree remove` — is issued as a **sandbox `exec`**; the bytes land in the sandbox,
never in the harness process.

Sequence added to [`harness/src/run-leaf.ts`](../../harness/src/run-leaf.ts) around the existing model loop:

```
runLeaf(envelope):
  pod        = poolSelect()                       # §4: list-by-label + ACQUIRE lease
  exec(pod, convergeAndWorktree(repoUrl, ref, runId))   # §5: fetch + worktree add
  workspaceRef = /workspace/leaves/<runId>
  … existing model loop, all tool exec routed to `pod` …   # unchanged (P1)
  exec(pod, worktreeRemove(runId))                # §5 cleanup
  RELEASE(pod, runId)                             # §4.2
  … existing verdict write (inline sync / Redis async) …   # unchanged (P1)
```

Lease heartbeat (§4.1) runs for the duration of the model loop. On crash before `RELEASE`, the lease TTL-expires
and the existing Redis-backed resume re-runs the leaf, which **re-acquires** (likely a different pod) and
**re-converges** — idempotent by construction.

## 7. Envelope changes (`LeafEnvelope`)

Additive to the P1 wire contract:

| Field     | Type   | Meaning                                                                                                  |
| --------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `repoUrl` | string | Git remote to converge from.                                                                             |
| `ref`     | string | Commit SHA (preferred) or branch/tag; the pod converges to it and the worktree pins the resolved commit. |

`workspaceRef` becomes **derived** (`/workspace/leaves/<runId>`) rather than a caller-supplied absolute pod path.
Callers we own (leaf-orchestrator, dispatch scripts) are updated in the same cut to send `repoUrl`/`ref` and to
stop supplying `workspaceRef`.

## 8. Deploy changes (`deploy/knative/`)

- **`sandbox.yaml`** → generate **N** `Sandbox` CRs (`sandbox-0..{N-1}`) with the common pool label; N is a
  kustomize config value. Each retains its own `volumeClaimTemplates` (RWO).
- **`service.yaml`** — replace `KAGENTI_SANDBOX_NAME=sandbox-0` with **`KAGENTI_SANDBOX_POOL_SELECTOR`**
  (label selector). Retain `KAGENTI_SANDBOX_POD` as a single-pod **test/override** that bypasses pool selection.
- **RBAC** — unchanged surface (`get/list pods`, `create pods/exec`, `get/list Sandboxes`); it already spans all
  pods in the namespace.
- **OCP overlay** — GHCR image + UID 65532 as in P0′, applied across all N CRs. Operational note: the
  agent-sandbox **StatefulSet PVC is not GC'd on CR delete** (P0′) — pool-shrink requires a manual PVC sweep.

## 9. Isolation (explicit non-goal for P2)

Leaves sharing a pod run in **separate worktree directories under the same UID 65532** — soft, directory-level
isolation only. A compromised leaf could read sibling worktrees and the shared object store. This is **acceptable
for P2** per the epic threat model: the sandbox is a passive exec target and the real blast-radius control is
**Kata at the pod level**, delivered in **P3** (possibly with per-leaf UID/namespace). Leaves sharing a pod are
one trust domain in P2. Documented here as the known limitation P3 resolves.

## 10. Failure modes

| Event                      | Behavior                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod crashes mid-leaf       | Lease TTL-expires → reclaimed on next acquire; worktree orphaned then age-pruned; leaf resumes (existing Redis resume) and re-acquires + re-converges (likely a different pod). |
| Pod removed from pool      | K8s list stops returning it → never picked. In-flight leaf on it fails through the existing verdict-error path and resumes elsewhere.                                           |
| All pods FULL              | §4.3 — async stays queued; sync gets `503 Retry-After`.                                                                                                                         |
| `git fetch`/converge fails | Leaf errors out via the existing verdict-error path; lease released; resume retries.                                                                                            |
| Two harnesses race one pod | Soft-cap overshoot by a small margin (D5) — accepted.                                                                                                                           |

## 11. Testing

- **Unit:** lease Lua (`ACQUIRE` OK/FULL, expiry sweep, heartbeat re-add, `RELEASE`); candidate-pod ordering by
  load; converge idempotency (already-at-ref = no-op); worktree path derivation.
- **Integration (live Kind, N=2–3):** concurrent leaves land on distinct pods; a mixed-ref batch stays
  commit-consistent per leaf; crash → lease reclaim → re-acquire on a surviving pod; saturation backpressure
  (sync `503`, async drains).
- **Gated live smoke (OCP 4.20.8):** per-sandbox RWO pool, `SH_MODEL=claude-haiku-4-5`, reusing the existing
  `*_LIVE_SMOKE` env-gate pattern; assert N:M fan-out completes with correct verdicts.

## 12. Acceptance mapping (issue #46)

| Issue #46 scope item                                                                                  | Addressed by                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Replace fixed `KAGENTI_SANDBOX_POD` with pool assignment (pod-selection logic)                        | §4 routing + §8 `KAGENTI_SANDBOX_POOL_SELECTOR`         |
| Within a sandbox: shared repo (read-mostly), per-leaf isolated worktrees, `/workspace/<run>/…` layout | §5 shared object store + per-leaf worktree              |
| Across sandboxes: storage topology — RWX vs per-sandbox copy (design both)                            | D1 + §3 (per-sandbox RWO chosen; RWX = §13 alternative) |
| Sandbox tier as a managed set with durable storage                                                    | §3 N `Sandbox` CRs, per-CR RWO PVC                      |
| Open Q — routing mechanism                                                                            | §4 (harness-side pick + Redis leases)                   |
| Open Q — repo distribution                                                                            | D3 + §5 (ref-pinned lazy converge)                      |
| Open Q — sandbox lifecycle/scaling                                                                    | D4 + §8 (static N config knob)                          |
| Open Q — isolation between shared leaves                                                              | §9 (worktree/dir, Kata → P3)                            |

## 13. Non-goals (this phase)

- **Kata isolation and the ~20:1 ratio experiments** — P3 ([#48](https://github.com/rossoctl/moca/issues/48)).
- **Eager pod-start pre-warm** — P3 optimization layered on the §5 converge contract.
- **Autoscaling the pool** — future; P2 is static N.
- **RWX / fleet-wide single repo** — documented alternative below, not implemented. Would require an RWX
  provisioner (EFS/CSI) on AWS OCP, a single ReadWriteMany PVC mounted by all pods, and cross-pod fetch/worktree
  serialization. Chosen against for the deployable PoC (D1).

## 14. Superseded / doc updates

- Updates the **P2 row** in [`docs/specs/README.md`](README.md): status `planned` → `design ✅`, and corrects the
  description (the prior placeholder referenced `SandboxWarmPool`/`SandboxClaim` and "RWX relocates here" — the
  brainstorm instead landed on **N distinct `Sandbox` CRs + per-sandbox RWO copy**, with RWX as a documented
  alternative only).
- Does **not** alter P1, P0′, or the epic's locked decisions.

---

_Assisted-By: Claude (Anthropic AI) — brainstorming + spec authoring for P2._
