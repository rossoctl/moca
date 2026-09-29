# P3 — Sandbox Sharing-Ratio Experiments — Design

Version: 1.0 — July 3, 2026
Status: Design (approved for implementation planning)
Scope: **Phase 3 (P3)** of the [two-tier FS-free harness epic](https://github.com/rossoctl/moca/issues/49)
([P3 issue #48](https://github.com/rossoctl/moca/issues/48)). Depends on **P2** (shared sandbox
pool + routing, [#46](https://github.com/rossoctl/moca/issues/46)) and **P0′** (OCP deploy,
[#47](https://github.com/rossoctl/moca/issues/47)), both merged. Measures the harness→sandbox
**sharing ratio** on the runc runtime to set the pool's capacity knobs. **Kata/VM isolation and intra-pod
hardening are split out to a new [P4 (#57)](https://github.com/rossoctl/moca/issues/57)** and are
_not_ in scope here.

---

## 1. Goal & motivation

P2 delivered the _mechanism_ for many leaf harnesses to share a small pool of sandbox pods (N distinct `Sandbox`
CRs, harness-side Redis-lease routing, ref-pinned lazy converge, per-leaf worktrees). It deliberately left the
**capacity numbers** unmeasured: `KAGENTI_SANDBOX_CAP` defaults to a _soft_ 20 and pool size N is a static config
knob, both tagged "tune empirically in P3."

P3 produces those numbers. It answers, with evidence on a representative cluster:

- **How many concurrent leaves can one sandbox pod serve** before per-leaf latency or aggregate throughput
  degrades? — this knee sets **`KAGENTI_SANDBOX_CAP`**.
- **What is the harness→sandbox provisioning ratio** (the "~20:1" hypothesis) for a given fleet size? — derived
  from the per-leaf **duty cycle** (fraction of wall-clock a leaf actually keeps the sandbox busy), so N can be
  provisioned for an expected harness fleet.
- **What is the bottleneck** at the knee — the flock-serialized shared object-store `git fetch`, or sandbox
  CPU/exec? — this tells us whether the CAP is raised by a converge optimization or is a genuine compute ceiling.

Along the way P3 discharges the **live mixed-ref converge validation** that P2 deferred (Task 7): proving on a
real cluster that two leaves at different refs on the same pod stay commit-consistent.

## 2. Why this is a pure experiments phase (the P3/P4 split)

The original #48 bundled Kata isolation with the ratio experiments and asserted the experiments depend on Kata.
The 2026-07-03 brainstorm reversed that dependency and split the phase:

- **The ratio baseline does not need Kata.** Concurrency knee, converge contention, CPU/mem per leaf, and CAP/N
  tuning are all properties of the workload on whatever runtime the pods use. They are measured on **runc** (what
  we have). Kata only adds a **startup/overhead delta** that P4 measures _on top of_ this baseline — so the
  baseline is a prerequisite for the Kata work, not the other way round.
- **Kata cannot run on the live cluster as-is.** The OCP 4.20.8 cluster is all `m6i.xlarge` — standard EC2 with
  **no `/dev/kvm`** (nested virtualization is not exposed on non-`.metal` instances), so default Kata (QEMU/KVM)
  will not start. The isolation work therefore needs an infra decision (bare-metal machine pool vs Kata
  peer-pods vs gVisor) that is out of band from measurement.

Consequently P3 is **experiments only** and **runs on runc**; all VM-isolation and intra-pod trust-boundary work
moves to **P4 (#57)**, gated on the infra spike. §8 hands P4 a clean starting point.

## 3. Decisions locked (brainstorm 2026-07-03)

These were settled during brainstorming and are not relitigated in planning:

| #   | Decision                                                                                                                                                                                                                                | Rationale                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Split P3 (experiments) from P4 (Kata/isolation).** P3 measures the ratio on runc; P4 owns VM isolation + intra-pod hardening.                                                                                                         | Ratio baseline is runtime-independent and unblocked; Kata is infra-blocked on this cluster. Decouples shippable work from a spike.                                                                                        |
| D2  | **Ratio meaning: concurrency cap is primary; N is derived.** Measure the per-sandbox concurrency knee (→ `CAP`); compute the provisioning ratio N from the observed per-leaf duty cycle in the **same** run.                            | One load experiment yields both knobs; avoids a second time-averaged fleet workload.                                                                                                                                      |
| D3  | **Experiment set: E6 (saturation curve) + E7 (converge contention + mixed-ref correctness) + a light feed-back check.** No standalone fleet/CAP experiment.                                                                             | E6+E7 yield CAP, N, the bottleneck, and the deferred mixed-ref validation. P2 already proved pool spread / never-over-cap / self-heal, so the feed-back check re-runs that at the derived CAP rather than re-deriving it. |
| D4  | **Load substrate: in-cluster git-daemon pod** serving a seeded bare repo with multiple refs over `git://`.                                                                                                                              | Reachable by all pool pods, hermetic (no GitHub egress/auth), repeatable, and the only option that supports mixed-ref converge _across_ the pool. `file://` is local to one pod's RWO PVC and cannot be shared.           |
| D5  | **Cluster strategy: develop on Kind, authoritative numbers on OCP.** Iterate drivers on the standing Kind `sh-knative` 3-pod pool; take the reported ratio/CAP on live OCP 4.20.                                                        | Kind is fast/deterministic but laptop-bound (absolute leaves/sec unrepresentative); OCP gives representative CPU/mem + real EBS RWO + API-server exec. Mirrors the P2 Kind-integration → gated-OCP-live pattern.          |
| D6  | **Gates: hard correctness gates + reported ratio with a sanity floor.** Correctness (mixed-ref consistency, never-over-cap) fails the build; the ratio/CAP is a reported deliverable guarded by a documented minimum-concurrency floor. | A measurement experiment has no honest binary threshold; the floor still catches a silent capacity collapse in CI.                                                                                                        |

## 4. What is measured (metrics & definitions)

| Metric                      | Definition                                                                                                                                                                              | Feeds                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Concurrency knee**        | The concurrent-leaf count `C*` beyond which aggregate throughput (leaves/sec) stops rising and/or per-leaf p95 latency crosses a documented degradation multiple of the `C=1` baseline. | Recommended **`KAGENTI_SANDBOX_CAP`** (`≈ C*`, with a safety margin below the hard-degradation point).      |
| **Per-leaf duty cycle** `d` | Sandbox-busy time (sum of exec durations attributable to a leaf: converge + worktree + tool ops) ÷ leaf wall-clock.                                                                     | **Provisioning ratio** `N_harness : N_sandbox ≈ 1/d` at the knee; guides pool size N for an expected fleet. |
| **Converge wait**           | Time a leaf's `git fetch` spends blocked on the per-pod `flock` vs. executing, as concurrency rises.                                                                                    | Whether the object-store lock (fixable) or CPU/exec (a real ceiling) caps E6.                               |
| **Sandbox pod CPU/mem**     | `kubectl top pod` (and/or cgroup readings) for the sandbox pod at each concurrency level.                                                                                               | Confirms the knee's physical cause; sizing guidance for sandbox pod resources.                              |

**The "~20:1" hypothesis** is an output to confirm or refine, never an input. The deliverable is the measured
curve + a recommended CAP + a derived N, recorded with the raw numbers.

## 5. Experiments

Next free experiment number is **E6** (E1–E5 are taken). Both follow the repo's split convention: a **structural**
vitest (no model key, real Redis where needed) that gates in CI, and a **live** driver (key-gated) that produces
the representative numbers.

### 5.1 E6 — Sandbox saturation curve (→ CAP + derived N)

Pin the workload to **one** sandbox pod (`N=1`, or `KAGENTI_SANDBOX_POD` set; `CAP` forced high so it is not the
limiter) and sweep concurrent leaves over a configured ladder `C ∈ {1, 2, 4, 8, 16, 24, …}` (`E6_LADDER`). At each
level:

- launch `C` leaves against the same pod, each converging a ref from the git-daemon and running a small fixed
  Archetype-A leaf (`SH_MODEL=claude-haiku-4-5`);
- record per-leaf wall-clock (p50/p95), aggregate leaves/sec, sandbox pod CPU/mem, and per-leaf duty cycle.

**Output:** the knee `C*` (recommended CAP) and, from the mean duty cycle at the knee, the derived provisioning
ratio N. Emitted to `EXPERIMENTS.md` (verdict + gate) and `RESULTS.md` (per-`C` table + narrative).

**Gate (D6):** reported ratio, guarded by a **sanity floor** — one sandbox must sustain at least
`E6_MIN_CONCURRENCY` (documented default, e.g. 4) concurrent leaves within the latency-degradation bound, else
FAIL (capacity has collapsed). The knee value itself is reported, not thresholded.

### 5.2 E7 — Converge/fetch contention + mixed-ref correctness

Launch `C` leaves that converge **distinct** refs simultaneously on **one** pod (the git-daemon seeds several
refs). Two outputs from one experiment:

- **Contention (measurement):** converge wait vs. execute time per leaf as `C` rises, isolating the per-pod
  `flock /workspace/repo/.sh-fetch.lock` serialization from model-loop cost. Answers "is the object-store lock the
  ceiling?".
- **Mixed-ref correctness (hard gate):** assert each leaf's worktree `/workspace/leaves/<runId>` is checked out at
  **its own** resolved commit and its file contents match that ref — proving batch-wide commit consistency on a
  shared pod. This is the **live validation deferred from P2 Task 7**. FAIL on any cross-contamination.

**Gate (D6):** mixed-ref consistency is a hard gate; the contention profile is reported.

### 5.3 Feed-back check (close the loop)

Re-run P2's existing pool-spread smoke on the multi-pod pool with `KAGENTI_SANDBOX_CAP` set to E6's **derived
CAP**, asserting the pool still spreads leaves and never exceeds the cap at that value. This validates the
recommendation on the real routing path **without** a new standalone fleet experiment (P2 already proved even
spread, never-over-cap, and pod-kill self-heal).

## 6. Load substrate — in-cluster git-daemon (`deploy/knative/gitd.yaml`)

A single small pod runs `git daemon` over a seeded bare repo containing **several distinct refs/commits**
(enough to give every concurrent leaf in the largest ladder step its own ref in E7). Served at a stable
in-cluster address (`git://gitd.<ns>.svc/repo.git` or a Service DNS name); the experiment envelopes set
`repoUrl`/`ref` to it. Properties:

- **Hermetic:** no GitHub egress, no credentials, no auth — the experiments run identically on Kind and OCP and
  in restricted-network clusters.
- **Reachable by the whole pool:** unlike `file://` (which lives on a single pod's RWO PVC), a `git://` daemon is
  reachable by every sandbox pod, which is required to exercise mixed-ref converge across the pool.
- **Seeded deterministically:** an init step (image build or an init container) creates the bare repo and its
  refs so runs are reproducible.

Read-only and disposable; it holds no state the experiments depend on beyond the seeded refs.

## 7. Artifacts & conventions

Matches the existing experiments framework (see `@moca/experiments` and `deploy/knative/`):

- **Structural vitest:** `experiments/test/e6-saturation-structural.test.ts`, `experiments/test/e7-converge-contention-structural.test.ts` — CI-gated, no model key; exercise the lease/duty-cycle accounting and mixed-ref worktree assertions against a local/mocked or real-Redis harness where feasible.
- **Live drivers:** `deploy/knative/e6-saturation.sh`, `deploy/knative/e7-converge-contention.sh` — key-gated (`SH_RUN_LIVE=1` + `ANTHROPIC_AUTH_TOKEN`), reuse `lib.sh` helpers (`start_sampler`/`stop_sampler`/`pod_seconds_from`, `turn`, `set_min_scale`, `ensure_port_forward`, `wait_ksvc_ready`). New helpers as needed: a **concurrent-leaf launcher** (fire `C` leaves and join), a **duty-cycle sampler** (attribute exec time per leaf), and a **git-daemon deploy/seed** step.
- **Env knobs:** `E6_LADDER` (concurrency steps), `E6_MIN_CONCURRENCY` (sanity floor), `E6_LATENCY_DEGRADE_X` (p95 degradation multiple defining the knee), `E7_REFS` (distinct-ref count), plus the inherited `SH_MODEL`, `KAGENTI_SANDBOX_CAP`, `KAGENTI_SANDBOX_POD`, `KSVC_URL`, `REDIS_URL`.
- **Results:** a new **"P3 — sandbox sharing"** section in `deploy/knative/EXPERIMENTS.md` (per-experiment verdict + gate + narrative) and matching tables in `experiments/RESULTS.md` (per-`C` rows, recommended CAP, derived N).
- **Live-run lessons carried from P2/P0′:** pace in-pod `redis-cli` samplers with `sleep` (ms-fast loops finish before leases form); `min-scale` pre-warm the harness ksvc to force burst overlap; a mutable `:local` image tag needs a config change to force a new ksvc revision; on OCP, dispatch curls need `$CURL_OPTS`/`-k` for the Route cert; wait on process exit for flushed logs (macOS `stdbuf` is ineffective on nohup'd logs); provision `llm-credentials` with an api-key only (the IBM litellm base-url is unreachable from the AWS cluster and drifts back in).

## 8. P4 handoff (documented, not built here)

P3 records the isolation starting point so P4 (#57) opens cleanly:

- **Kata reality on this cluster:** nested KVM unavailable on `m6i.xlarge`. Paths, in ascending fidelity/cost:
  **gVisor (runsc)** — runs today, addresses kernel-exploit containment, but not OCP-productized and departs from
  "Kata"; **Kata peer-pods** (OpenShift sandboxed containers + cloud-api-adaptor) — faithful VM isolation on
  standard EC2 workers via a separate per-peer EC2 instance, its own build (podvm AMI, adaptor, IAM, extra
  \$/cold-start); **bare-metal machine pool** (`.metal`) — faithful nested Kata, most expensive.
- **P4 sequence:** spike-then-decide the infra path (may legitimately conclude "defer with a documented plan") →
  run sandboxes under the chosen RuntimeClass (`runtimeClassName` on the `Sandbox` CR podTemplate; verify
  agent-sandbox v0.5.0 compatibility) → **intra-pod cross-leaf isolation hardening** (Kata-at-pod-level = one pod
  is one trust domain; optionally per-leaf UID/namespace) reconciled with the shared object store + per-leaf
  worktrees → measure the **Kata-overhead delta** on top of E6's baseline.
- **RWX revisited (conditional):** only pursued if E6 shows one sandbox is insufficient **and** a fleet-wide
  single repo is wanted. Per-sandbox RWO stays otherwise (the EBS-only cluster has no RWX). This remains a
  documented alternative, consistent with P2 D1.

## 9. Failure modes & risks

| Event                                                                           | Behavior / mitigation                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knee is above the largest ladder step                                           | Report "no knee observed below `C_max`"; extend `E6_LADDER` and re-run. CAP recommendation is then a floor, not the true ceiling — noted explicitly in RESULTS.        |
| Kind resource limits dominate the curve                                         | Expected; that is why the _authoritative_ run is on OCP (D5). Kind results are reported as shape/relative only.                                                        |
| git-daemon becomes the bottleneck instead of the sandbox                        | Detected by E7 (converge wait would rise with git-daemon load, not pod concurrency); seed refs locally and keep the daemon read-only/cheap; note if observed.          |
| Duty-cycle attribution is noisy                                                 | Report N as a range with the measured duty-cycle spread rather than a single figure; the CAP (primary) does not depend on it.                                          |
| Model/network latency inflates leaf wall-clock and deflates apparent duty cycle | Use the small fixed Archetype-A leaf and `claude-haiku-4-5`; report duty cycle from exec-time accounting, not just wall-clock, so provider latency does not distort N. |
| `llm-credentials` drift on OCP                                                  | Re-provision api-key-only before the authoritative run (P0′ lesson).                                                                                                   |

## 10. Testing

- **Structural (CI, no key):** lease/duty-cycle accounting math; mixed-ref worktree assertion logic; ladder/knee
  detection on synthetic latency series; sanity-floor gate triggers on a collapsed series.
- **Integration (live Kind, N=1 and N=3):** E6 ladder produces a monotone-then-knee curve; E7 mixed-ref batch
  stays commit-consistent and surfaces the converge-wait profile; feed-back check spreads at the derived CAP.
- **Gated live (OCP 4.20.8):** authoritative E6/E7 numbers with `SH_MODEL=claude-haiku-4-5`, per-sandbox RWO
  pool, reusing the `SH_RUN_LIVE` / `*_LIVE_SMOKE` gate; recommended CAP + derived N recorded in `EXPERIMENTS.md`.

## 11. Scope: prerequisites & non-goals

**Folded in (P3 setup prerequisite):**

- **#54** — `setup-kind.sh` currently applies a single `sandbox.yaml`, incoherent with `KAGENTI_SANDBOX_POOL_SELECTOR`
  on a fresh Kind bring-up. P3's Kind experiments need the pool deployed by setup, so this is fixed as a P3 setup
  task.

**Left separate (not P3):**

- **#55** (sync-path bounded-wait `503`/`Retry-After`) and **#56** (empty-pod-list unit test) — unrelated to
  measurement; remain standalone follow-ups.

**Non-goals (this phase):**

- **Kata/VM isolation, intra-pod hardening, Kata-overhead measurement** — P4 (#57).
- **Autoscaling the pool** — future; P3 measures static-N capacity.
- **RWX / fleet-wide single repo** — conditional P4 item (§8), only if E6 shows one sandbox insufficient.
- **A standalone fleet/CAP-tuning experiment** — replaced by the §5.3 feed-back check (D3).

## 12. Doc updates

- Updates the **P3 row** in [`docs/specs/README.md`](README.md): status `planned` → `design ✅`, description set to
  the sharing-ratio experiments scope; and **adds a P4 row** (`planned`, #57) for Kata/VM isolation + intra-pod
  hardening.
- Does **not** alter P1, P2, P0′, or the epic's locked decisions. Reflects the #48 retitle (experiments) and the
  new #57 (Kata/isolation).

---

_Assisted-By: Claude (Anthropic AI) — brainstorming + spec authoring for P3._
