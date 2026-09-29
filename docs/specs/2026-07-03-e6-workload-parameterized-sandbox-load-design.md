# E6 Workload-Parameterized Sandbox-Load Characterization — Design

Version: 1.0 — July 3, 2026
Status: Design (approved for implementation planning)
Scope: Hardens the **P3** sandbox sharing-ratio experiment
([`2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`](2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md),
merged PR #58). Resolves [#62](https://github.com/rossoctl/moca/issues/62) (noise-sensitive
knee) **and** a deeper validity gap surfaced in review: the E6/E7 leaf workload is a trivial
`marker.txt` check, so the reported ratio N ≈ 29–48:1 is an optimistic _upper bound_, not a
representative Archetype-A figure. Builds on the two-tier epic
([#49](https://github.com/rossoctl/moca/issues/49)).

---

## 1. Goal & motivation

P3 measured the harness→sandbox sharing ratio as N ≈ 1/duty, where duty = per-leaf sandbox-busy time
÷ leaf wall-clock. Two problems limit the result:

1. **The workload is not representative (primary).** Each E6/E7 leaf converges a ref and reviews a
   single `marker.txt` (containing exactly `branch-i`) for the pattern `branch-i` — ~2 sandbox execs
   (converge + one read). Archetype A is parallel fan-out of **run-to-completion code-review leaves**
   (the BugStone Phase-B shape): a realistic leaf reads multiple files, runs several greps/finds, and
   emits a structured verdict — **many more sandbox execs**. Since N ≈ 1/duty and duty rises with
   sandbox work, the trivial leaf yields a near-best-case N; a realistic leaf yields a **lower** N. The
   single recorded number answers "best case with a near-empty leaf," not "what Archetype A sustains."

2. **The concurrency knee is unreliable (#62).** `detectKnee` breaks the moment a rung's throughput
   fails to strictly exceed the previous rung's; per-leaf model-latency and Knative cold-start variance
   make a single rung dip, tripping the break early (observed on OCP: c=4 0.213 < c=2 0.245 → knee=2,
   floor=fail — a noise artifact, not saturation). Compounding it, the harness ksvc is
   `max-scale: 5` + `containerConcurrency: 1`, so **at most 5 leaves ever reach the pinned sandbox
   concurrently** — any knee above 5 measures the _harness_ tier's cap, not the sandbox's.

This spec makes the headline output an **N-vs-workload curve** (confound-free, measured at C=1 across
real Archetype-A leaves of increasing intensity) and fixes the concurrency-sweep confounds so the knee,
where reported, is the sandbox's and is noise-robust.

## 2. Decisions locked (brainstorm 2026-07-03)

| #   | Decision                                                                                                                                                                                                                                                                                                 | Rationale                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Headline = N-vs-workload curve, measured at C=1.** Report N ≈ 1/duty across a range of workload intensities, each point tagged with the per-leaf sandbox exec count/ms.                                                                                                                                | The C=1 duty measurement has no concurrency confounds (max-scale/noise are irrelevant at one leaf); the curve answers "what ratio does Archetype A get" honestly, as a range tied to leaf intensity.                |
| D2  | **Real Archetype-A workload variants L0/L1/L2 by review scope.** L0 light (one small file, one finding) → L1 (larger file) → L2 heavy (multi-file / multi-pattern review). Genuine structured code-review leaves over real fixtures, not marker checks.                                                  | Review scope is the intensity axis the user chose; it maps directly to how many sandbox tool calls a leaf makes, which is what drives duty. Reuses the canonical Archetype-A code-review shape already in the repo. |
| D3  | **Fix the concurrency sweep (the original #62 knee):** raise harness `max-scale` for the sweep so the sandbox is the concurrency limiter; warm `min-scale` baseline; multi-sample rungs (median); smooth `detectKnee` to break only on a _sustained_ decline. Run the sweep at the **heaviest** variant. | Removes the three knee confounds (harness cap, cold-start, single-dip). The heaviest leaf stresses the sandbox most, so a real knee (if any) is most visible there.                                                 |
| D4  | **Report N always with its workload intensity; knee as a floor with its max-scale bound.** Supersede P3's single-N claim (the light-workload upper bound).                                                                                                                                               | A ratio without a stated workload is misleading; the review that prompted this made exactly that point.                                                                                                             |
| D5  | **No harness/leaf code changes to inject synthetic work.** Intensity comes from the _item_ (which file, how many patterns) and the emergent tool calls; measure the _actual_ exec count per leaf.                                                                                                        | Keeps the FS-free harness and leaf contract untouched; the timing hook already records real sandbox work, so measured (not assumed) intensity anchors each curve point.                                             |

## 3. Workload variants (real Archetype-A code review)

Seed the git-daemon repo (`deploy/knative/gitd.yaml`) with a small real fixture set on a stable ref:
the existing [`deploy/knative/fixtures/repo/risky.py`](../../deploy/knative/fixtures/repo/risky.py) and
`safe.py`, plus **1–2 larger source files** (e.g. a ~200-line module with several plausible findings)
added under `fixtures/repo/`. The gitd seed copies `fixtures/repo/` onto the served ref (replacing the
per-branch `marker.txt` scheme for the workload refs; E7's mixed-ref refs stay marker-based — see §6).

Three ordered leaf **items** of increasing review scope, each a `LeafItem {item_id, file, pattern}`
run through the unchanged review prompt:

| Variant         | Item                                                                                   | Expected sandbox work                                   |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **L0** (light)  | one small file (`safe.py`), one pattern                                                | converge + ~1 read → lightest duty, highest N           |
| **L1** (medium) | a larger file, one pattern                                                             | converge + read + a grep or two                         |
| **L2** (heavy)  | the larger file, a pattern that induces broader scanning (multi-match / context reads) | converge + several reads/greps → highest duty, lowest N |

Intensity is **emergent** (model-driven tool use), so it is **measured, not assumed** (§4): each point
on the curve is tagged with the leaf's actual exec count. The variants only need to reliably span
light→heavy, which increasing file size + review breadth achieves.

## 4. Instrumentation & C=1 duty measurement

The `KAGENTI_EXEC_TIMING` hook already emits one `[exec-timing] … ms=<n> …` line per sandbox exec. For
each variant, at **C=1 on a warm pod** (`min-scale=1`, so no cold-start in the wall time), run the leaf
**R times** (`E6_SAMPLES`, default 3) and take the **median** of:

- `execCount` — number of `[exec-timing]` lines for that leaf's harness pod,
- `execMs` — summed exec ms,
- `wallMs` — leaf request wall time.

A fresh pod per measurement (drain first, per P3's C=1 fix) keeps the log scoped to the one leaf.
`duty = execMs / wallMs`; `N = 1/duty` (via the tested `dutyCycle`/`derivedRatio`). The curve is the set
`{(variant, execCount, execMs, duty, N)}` for L0/L1/L2.

## 5. Analysis functions (`experiments/src/sharing.ts`)

- **New pure fn** `buildRatioCurve(points: WorkloadPoint[]): RatioCurvePoint[]` where
  `WorkloadPoint = { label: string; execMs: number; execCount: number; wallMs: number }` and each
  output carries `{ label, execCount, duty, n }`. Pure, unit-tested (monotonicity sanity: heavier
  execMs at equal wall → higher duty → lower N).
- **Change `detectKnee` to break on a _sustained_ decline.** New signature
  `detectKnee(points, degradeX, patience = 2)`: track the running-max throughput; a rung is "healthy"
  if `p95 ≤ degradeX·baseline` **and** its throughput ≥ the running max (i.e. still at or above the best
  seen). Advance the knee on healthy rungs; only **break after `patience` consecutive unhealthy rungs**,
  so a single noisy dip no longer collapses the knee. Existing tests updated; add tests for
  single-dip-tolerated and sustained-decline-breaks. (Backward note: the P3 tests that asserted an
  immediate break move to the new sustained semantics.)

## 6. Concurrency sweep (the #62 knee), run at the heaviest variant

- **Raise `max-scale`** on the harness ksvc for the sweep (via `set_ksvc_env`, e.g. to ≥ the ladder max)
  so the sandbox — not the 5-pod harness cap — bounds concurrency; restore on exit (the existing
  `trap restore_ksvc_env`, extended to reset `max-scale`).
- **Warm** the harness (`min-scale`) during the sweep to remove cold-start latency noise.
- **Multi-sample** each rung (`E6_SAMPLES`) and use the **median** throughput/p95 before feeding
  `detectKnee`.
- Run the sweep with the **L2 (heavy)** item so the sandbox is maximally stressed.
- Report the knee as a **floor** ("no saturation below c=N") with the `max-scale` value stated, since at
  ~few-percent duty the sandbox may not saturate within a feasible ladder.

E7 (mixed-ref correctness) is unchanged in intent; it keeps the per-branch `marker.txt` refs (its gate
is "each worktree pinned its own ref", for which marker-per-branch is the clean signal). Only E6's
workload refs switch to the code fixtures.

## 7. Reporting

`deploy/knative/EXPERIMENTS.md` P3 section is updated so the **headline is the N-vs-workload curve**
(L0→L2: N ranges from ~light-upper-bound down to the heavy-realistic figure), each point tagged with its
measured exec count; the concurrency knee is reported as a floor with its `max-scale` bound. A short note
supersedes the prior single-N claim, framing it explicitly as the L0 (near-empty-leaf) upper bound.

## 8. Testing

- **Unit (CI):** `buildRatioCurve` (duty/N math + monotonicity); `detectKnee` sustained-decline
  (single-dip tolerated, K-consecutive breaks, baseline-throw preserved).
- **Integration (Kind, dev):** the three variants produce increasing execCount and correspondingly
  decreasing N; the smoothed knee survives an injected single-rung dip.
- **Gated live (OCP 4.20.8, standing stack):** authoritative N-vs-workload curve + knee-as-floor
  recorded in `EXPERIMENTS.md`, reusing the `E6_LIVE` gate and `SH_MODEL=claude-haiku-4-5`.

## 9. Non-goals

- **Synthetic sandbox-work injection** (a harness/leaf knob) — intensity stays emergent + measured (D5).
- **Chasing a true sandbox saturation knee at very high concurrency** — at few-percent duty this needs
  concurrency in the tens–hundreds and large `max-scale`; out of scope. The knee stays a reported floor.
- **P4 (Kata/isolation, #57)** and the converge self-heal (#59) — separate.
- **E7 workload changes** — E7 keeps marker-per-branch refs (§6).

## 10. Doc updates

- Registers in [`docs/specs/README.md`](README.md) under the P-track as a P3 hardening follow-up
  (resolves #62 + workload realism).
- Updates the P3 `EXPERIMENTS.md` results per §7; does not alter P1/P2/P0′ or the epic's locked
  decisions.

---

_Assisted-By: Claude (Anthropic AI) — brainstorming + spec authoring for the E6 workload-parameterization hardening._
