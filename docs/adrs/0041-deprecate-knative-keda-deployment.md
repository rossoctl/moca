# ADR-0041: Deprecate the Knative/KEDA deployment path; P6 is the primary runtime

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md`](../specs/2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) (Phase 4; its §8 item 4 called for this record)

## Context

RA1 (2026-09-24) settled the disposition: once P4/P6 is genuinely primary, the
Kubernetes/Knative/KEDA path is **deprecated, not deleted** — kept functional and clearly labeled,
never removed by RA1 itself. Its §2 execution gate for Phases 3–4 has since cleared in substance:
#336 and #337 merged 2026-09-24, #274 was decided 2026-10-08 (per-`Exec` only, ADR-0035's
2026-10-08 revision), #348 delivered the Kubernetes-free `CredentialStore`, and the
P6-on-Kubernetes epic #426 (slices 1–3) is implemented — `deploy/k8s/` runs the P6 process model
on Kind and OpenShift as a first-class deployment (ADR-0037). What never happened is RA1 Phase 3's
docs flip: the README still leads with the Knative story, and the `sandbox-transport` extraction
(§9.1) was never done — `packages/k8s-sandbox` still holds the shared transport code P6 runs on.

#338 (HITL workspace-TTL silent data loss) remains open. It is a P4 microVM-tier correctness bug,
not a Knative-path concern; the deciders chose to proceed with the deprecation on 2026-10-11 with
it flagged. It is tracked there, not here.

A few users still run sessions on the Knative path.

## Decision

As of **2026-10-11** the Knative + KEDA deployment model is **deprecated**: the Knative Service,
KEDA ScaledJobs, `KubectlTransport` and pod-exec sandboxes, and `deploy/knative/` — ADR-0037's
scope, a deployment model, not Kubernetes as a substrate and not containers as a sandbox
technology. **P6 — the process-manager runtime — is the primary way to run MOCA sessions.**
Capacity scales by **adding process-manager pods or sizing them up**, not by scale-to-zero
autoscaling.

- **Support during the window:** security and breakage fixes only; no new features on the
  deprecated path.
- **Removal:** no earlier than **end of October 2026**, and only once the remaining Knative users
  have confirmed migration — the "removal tracked separately" RA1 §1 asked for, made concrete where
  its §5 tree sketch said "no removal date set."
- **What is not deprecated:** `deploy/k8s/` (P6 on Kubernetes, ADR-0037), a migration destination;
  the container sandbox tier; and the shared code in `packages/knative-server` and the non-K8s
  half of `packages/k8s-sandbox` — the supervisor forks `knative-server/src/worker.ts`
  (`supervisor/src/main.ts`), so that code is P6-load-bearing, whatever its package name says.

At the design level this supersedes ADR-0002, 0003, 0004, 0009, 0015, 0018, 0019 and 0023, and —
with wording that keeps the underlying concerns alive while the deprecated path remains in-tree —
0017, 0025 and 0027. The user-facing record is
`../migrating-from-knative.md` (since removed with the path).

### Alternatives considered

- **Remove now** — strands the few remaining users; rejected in RA1 §0.3.
- **Support both paths indefinitely** — two deployment models to document, test and secure
  forever; rejected.
- **Open-ended deprecation, no removal policy** — leaves users unable to plan; rejected in favor
  of a dated floor plus a migration-complete condition.

## Consequences

- Positive: one primary runtime to document, test and harden; the README, demos and CI defaults
  can finally match reality.
- Positive: the deprecation window has an explicit policy — fixes-only, removal floor plus
  condition — rather than one users must infer from absence of evidence (RA1 §8.4's stated reason
  for this record).
- Negative / accepted cost: scale-to-zero — ADR-0004's original headline — is gone from the
  recommended path, traded for warm process-manager pods and the loss of the Knative/KEDA operator
  dependency; idle capacity now costs memory continuously.
- Negative / accepted cost: the repo carries a frozen deployment path until removal — manifests,
  smoke scripts, the OCP image build and the demo automation stay in-tree, unmaintained beyond
  fixes.
- Negative / accepted cost: async leaf dispatch (the KEDA drainer) and the CronJob scheduled
  on-ramp have no P6 equivalent yet — ADR-0034 flagged both as owed, and they still are. Users
  depending on them cannot finish migrating until that lands. _Update 2026-11-12:_ **async fan-out
  (archetype A) is discharged for `MOCA_TENANCY=single`** — designed in
  [ADR-0047](0047-p6-async-fan-out-in-worker-drain.md) and shipped as a drain loop in the ordinary
  turn worker, opt-in behind `SH_ASYNC_DRAIN`, tracked by
  [#686](https://github.com/rossoctl/moca/issues/686). It replaces the capability rather than the
  deployment, so a migrating user has a route to move to. The scheduled on-ramp (archetype C) is
  [#536](https://github.com/rossoctl/moca/issues/536) and still has no design. See the revisions
  below for what remains owed on archetype A.
- Follow-up owed: the rollout this record authorizes — a runtime startup warning on the deprecated
  path, `deploy/knative/` banners, setup-script notices, README/CLAUDE.md/Makefile/Dockerfile/
  `build.yaml` relabeling, demo rewrites — lands in follow-up PRs on this branch.
- Follow-up owed: RA1 §10.3's diff of `knative-server/src/worker.ts` against the supervisor's
  `pool.ts` (468 vs 356 lines, ~775 diff lines at the time of this decision) must be reviewed
  before `knative-server` is individually labeled, so "deprecated" means "safe to stop
  recommending," not "silently missing a feature no one checked for."
- Follow-up owed: `packages/knative-server`'s name is now a misnomer — its code is P6-load-bearing.
  Renaming is a separate decision, not part of this deprecation. Likewise the `sandbox-transport`
  extraction RA1 §9.1 planned never happened; absent it, deprecation labels target the
  K8s-specific halves of `k8s-sandbox`, never the package.
- Follow-up owed: #248's namespace-collocation risk persists for anyone still running the control
  plane on the deprecated path during the window; the migration guide says so.

## Revisions

### 2026-10-11 — RA1 §10.3 diff audit recorded (rollout PR2)

The follow-up owed above — the diff of `knative-server/src/worker.ts` against the supervisor's
`pool.ts`, to be reviewed "before `knative-server` is individually labeled" — is discharged.
`worker.ts` (356 lines) was compared hunk-by-hunk against `pool.ts` (468 lines; 423 insertions /
311 deletions between them). Findings:

- **Duplicated protocol — the only literal duplication:** the two IPC unions, `SupervisorToWorker`
  (2 rows) and `WorkerToSupervisor` (4 rows: `ready`/`load`/`draining`/`stats`). The duplication is
  deliberate — `pool.ts`'s header cites its spec §9: the supervisor forks the worker as a process,
  and a shared type module would advertise an in-process coupling that does not exist — and drift
  is caught by `supervisor/test/real-worker.integration.test.ts`, which forks the real worker and
  drives all four rows across the boundary.
- **Worker-side behavior with no `pool.ts` counterpart:** every `worker.ts` export was checked —
  the two protocol unions above, plus `isTurnRequest`, `TurnCounter`, `WorkerRuntime`/
  `createWorkerRuntime`, `statsIntervalMs`, `DETACHED_DRAIN_MS`/`armDetachedDrain`,
  `startStatsReporter`, `parseRole`, and the main-module boot block. None is Knative-specific, and
  none is missing from the supervisor by accident: each is the child half of a deliberate
  parent/child split whose other half lives in `pool.ts` (`handOff`'s optimistic increment,
  `reconcile`, the `stats` receiving handler, `drainAll`) or elsewhere in the supervisor (`readInt`
  in `config.ts`, which `statsIntervalMs` mirrors; `SHUTDOWN_GRACE_MS` in `main.ts`, which
  `DETACHED_DRAIN_MS` must stay under). The supervisor estimates turn counts and reconciles from
  `load` by design; it has no need of the worker's counting machinery.
- **`pool.ts` additions:** `WorkerTelemetry`, `TelemetryAggregates`, `WorkerHandle`, `PoolOptions`,
  `PoolCounters`, `Slot` and `WorkerPool` (routing, restart backoff, refusal accounting,
  `awaitIdle`) — supervisor-side concerns with no worker counterpart required.

Neither file imports or detects anything Knative-specific (no `K_SERVICE`/`K_CONFIGURATION`/
`K_REVISION`, no KEDA, no kubectl). The ~775-line diff RA1 §10.3 flagged is the two complementary
halves of one deliberately-duplicated protocol, not a fork with silent drift.

**Labeling decision:** no missing behavior was found, so `knative-server` keeps entry-point
deprecation labels only — `leaf-job.ts` carries the `@deprecated` header; `worker.ts` and
`pool.ts` carry none — and the package itself stays unlabeled, consistent with this ADR's rule
that the shared code is P6-load-bearing, whatever its package name says.

### 2026-11-05 — removal executed

The Decision's removal conditions were met and the removal PR landed:

- The **end-of-October-2026 floor** passed.
- **Migration was confirmed** on the tracking issue (#490): every respondent had moved to P6
  or never used the path, and none depended on async fan-out or the CronJob on-ramp.

Removed with the path: `deploy/knative/` in full (manifests, setup/smoke/demo scripts,
overlays, Shipwright builds, shell suites), the KEDA drainer (`leaf-job.ts`), the CronJob
on-ramp (`cron-dispatch.ts`), the async-enqueue route (`async: true` now answers 400
`async_removed`), `@moca/work-queue` (whose only consumers were that path), and the kubectl
half of `packages/k8s-sandbox` (`KubectlTransport`, pod listing, single-pod config) — sandbox
selection is records-only, and `SelectedSandbox` always carries the leased relay transport.

Not removed, per the Decision: `deploy/k8s/` (ADR-0037), the container and microVM sandbox
tiers, and the shared code in `packages/knative-server` and the relay half of
`packages/k8s-sandbox` — all P6-load-bearing. The runtime image keeps `kubectl` for the
control plane's `K8sSecretStore` on Kubernetes.

Still owed, now open rather than gated: the P6 equivalents of async fan-out (archetype A) and
the scheduled on-ramp (archetype C), flagged in ADR-0034; the `knative-server` rename decision;
the `sandbox-transport` extraction (RA1 §9.1). _Archetype A shipped on 2026-11-12 under
`MOCA_TENANCY=single`; see the second revision below._

### 2026-11-06 — archetype A's replacement decided (design only)

The first of the two owed capabilities above has a decision record:
[ADR-0047](0047-p6-async-fan-out-in-worker-drain.md), with its design spec
[`2026-11-05-p6-async-fan-out-design.md`](../specs/2026-11-05-p6-async-fan-out-design.md), tracked
by [#686](https://github.com/rossoctl/moca/issues/686). At the time of this revision it was a
**design** with nothing implemented, so the owed note above narrowed rather than cleared; the
revision below records the implementation landing.

What it settles that bears on this record:

- The consumer is a drain loop **inside the ordinary `--role=turn` worker**, sharing one admission
  budget with interactive turns — not a `--role=leaf` worker and not a separate process. So the
  capability returns without reviving the per-workload-pod scaling model this ADR deprecated.
- **Scale-to-zero stays gone**, as does queue-depth-driven capacity. This ADR accepted the first
  cost explicitly; ADR-0047 §10 records the second, with a kept-or-dropped verdict for every other
  KEDA-era behaviour (the `XAUTOCLAIM` reaper, dead-lettering, `LEAF_RESULT_TTL_SECONDS`,
  at-least-once delivery and the `classifyOutcome` retry classes are all kept). Nothing is lost by
  omission.
- The unauthenticated data-plane `POST /runs {async:true}` route this revision removed is **not
  restored** (#687, closed as "replaced"). The replacement is authenticated and owner-scoped,
  `POST /v1/sessions/{id}/turns`, so the path comes back with one trust model rather than two.
- Archetype A's first milestone ships under `MOCA_TENANCY=single` only, a dated conditional
  refusal in the shape this record used for its own deprecation window.

**Archetype C** (#536) remains owed in full — no design. It is expected to build on archetype A's
consumer rather than a second one.

### 2026-11-12 — archetype A's replacement ships (single tenancy)

The design above is implemented and on `main`: a drain loop inside the `--role=turn` worker, the
restored Redis Streams queue, submission and status on `POST`/`GET /v1/sessions/{id}/turns`, crash
redelivery from the pending-entries list, and the `async_*` counters. It is **opt-in** behind
`SH_ASYNC_DRAIN` (off by default, one knob), runs on `deploy/vm` and `deploy/compose`, and is wired
on `deploy/k8s`. So the first of this record's two owed capabilities is discharged for the
deployments it covers, and the "no P6 equivalent" line above no longer describes archetype A.

Two limits keep it short of a full clear: the path is `MOCA_TENANCY=single` only — lifting that gate
needs the grant and token-endpoint slice, ADR-0047 §9's M2 — and `deploy/k8s` is wired but not yet
proven end to end, which is [#688](https://github.com/rossoctl/moca/issues/688). Both are a dated
conditional refusal in the shape this record used for its own deprecation window, and
[dispatch archetypes](../concepts/dispatch-archetypes.md) carries them with the operator detail, so
they are stated once rather than three times.

Nothing here changes this record's accepted costs. Scale-to-zero and queue-depth-driven capacity stay
gone: fan-out width is one leaf per worker process, sized ahead of the load, and queue depth is an
operational metric (`async_queue_depth`, `async_oldest_age_ms`) rather than a scaling input.
