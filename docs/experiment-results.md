# MOCA — Experiment Results (E1–E5)

_Consolidated findings, June 2026. Source data:
[`moca-experiments/experiments/RESULTS.md`](https://github.com/rossoctl/moca-experiments/blob/main/experiments/RESULTS.md)
(E2, E5),
[`moca-experiments/knative/EXPERIMENTS.md`](https://github.com/rossoctl/moca-experiments/blob/main/knative/EXPERIMENTS.md)
(E1, E3, E4) — both moved to a separate repo 2026-09-25, see
`docs/specs/2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md`. Designs:
`docs/specs/2026-06-{23,24,25}-*.md`._

## The thesis under test

MOCA runs a [Pi](https://github.com/earendil-works) coding agent as a
**scale-to-zero** Knative service over an **externalized session log** (Redis Streams) and a
**remote sandbox**, so a session is durable infrastructure rather than a long-lived process.
The five experiments test whether that architecture pays off without breaking correctness:

| #      | Claim                                                                                | Verdict | Headline result                                                                   |
| ------ | ------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------- |
| **E1** | Scale-to-zero is cheaper than always-on for idle-heavy use                           | ✅ PASS | serverless **0.25×** the pod-seconds (~75% cheaper)                               |
| **E2** | Compaction-checkpoint keeps cold-start reconstruction O(tail), not O(total)          | ✅ PASS | checkpoint reads **constant 6 entries** vs backend's 53→5003; ratio **8.8→833.8** |
| **E3** | A session is portable: a fresh instance reconstructs equivalent context from the log | ✅ PASS | fidelity (≡ full replay) + mobility (fresh pod recalled the planted token)        |
| **E4** | Crash recovery is a byproduct of the externalized log                                | ✅ PASS | pod force-killed mid-session → next turn recovered all completed turns            |
| **E5** | Per-turn token spend can be capped and enforced                                      | ✅ PASS | tool call blocked + exactly one `abort` past the cap; inert when unset            |

All five pass. Together they validate the economic case (E1), the optimization that makes
scale-to-zero practical at length (E2), the correctness guarantees that make it safe (E3, E4),
and an operational guardrail (E5).

---

## E1 — Scale-to-zero economics

**Claim.** For an idle-heavy workload, a scale-to-zero deployment consumes materially less
compute than an always-warm one.

**Setup (cluster, Kind `sh-knative`).** The same workload — turns separated by a long idle gap —
runs twice against the deployed ksvc: `min-scale=1` (persistent) vs `min-scale=0` (serverless).
A sampler polls running pods every 5s; **pod-seconds = Σ(running pods × 5s)** is the cost proxy.

**Result.** `persistent=380s`, `serverless=95s`, **ratio 0.25** — serverless used a quarter of
the pod-runtime (~75% cheaper). Gate: serverless ≤ 0.6 × persistent. **PASS.**

**Caveat / methodology.** Serverless pod-seconds are roughly _constant per turn_ (cold-start +
work + ~30s scale-to-zero retention), independent of idle length, while persistent grows with the
window — so the saving widens with idle time. A short idle (≈120s) does **not** clear the gate
(ratio ~0.78); the result reflects a genuinely idle-heavy pattern. pod-seconds is a runtime proxy,
not a billing model. _Reproduce:_ `knative/e1-economics.sh` in `moca-experiments`.

## E2 — Local reconstruction cost (the compaction-checkpoint fast path)

**Claim.** On cold start, the M5 `openFromCheckpoint` loader reconstructs a session in **O(tail)**
(read only the latest-compaction-forward slice) rather than **O(total)** (full-log replay).

**Honest framing.** Pi's native compaction already bounds the _LLM_ context, so this is **not** an
LLM-latency win — it is a **local** cost win (Redis read volume, indexing, the leaf→root walk).
E2 measures exactly that, in-process, with a counting backend.

**Result.** Across synthetic sessions of length N ∈ {50, 200, 1000, 5000}, `openFromCheckpoint`
reads a **constant 6 entries / ~900 bytes**, while `openFromBackend` reads the whole log
(53→5003 entries, 7.5KB→707KB). The backend/checkpoint ratio rises **8.8 → 33.8 → 167.2 → 833.8**,
and `buildSessionContext()` is byte-identical under both loaders at every N (correctness preserved).
**PASS.** _Reproduce:_ `pnpm -C experiments test e2-reconstruction-cost` from a pre-split
checkout (see caveat below) -- preserved as a historical record in
[`moca-experiments/experiments/`](https://github.com/rossoctl/moca-experiments/tree/main/experiments),
not standalone-runnable there.

## E3 — Session fidelity + mobility

**Claim.** A session's state lives in the log, so any fresh instance can reconstruct _equivalent_
context — the basis for scale-to-zero and for moving a session between pods.

**Two halves.**

- **Fidelity** (M5): the checkpoint-reconstructed `buildSessionContext()` deep-equals a full
  replay — proven by the M5 parity gate (`checkpoint.test.ts`) and re-confirmed at every N in E2.
- **Mobility** (M7, cluster): plant a fact, force the pod to zero (confirmed gone), then a
  follow-up on a **fresh** pod recalled the planted token (`ZEBRA42`) from the Redis log.

**Result.** Both hold. **PASS.** _Reproduce:_ `knative/e3-mobility.sh` in `moca-experiments` (mobility);
`harness/test/checkpoint.test.ts` (fidelity).

## E4 — Crash recovery as a byproduct

**Claim.** Because completed turns are flushed to the log, force-killing the harness pod
mid-session loses no committed work.

**Setup (cluster).** Complete three turns (each flushed via `turn_end`), `kubectl delete pod
--force` mid-session, then issue a recovery turn on the freshly-started pod.

**Result.** The post-crash turn recalled all three planted facts (APPLE/BANANA/CHERRY) — zero
completed-turn loss. **PASS.** _Reproduce:_ `knative/e4-recovery.sh` in `moca-experiments`.

## E5 — Budget-voter enforcement

**Claim.** A per-turn token budget can be enforced — blocking further tool calls once breached.

**Setup.** With `SH_BUDGET_TOKENS` set, the voter meters per-turn spend (delta from the pre-turn
baseline) and blocks the next `tool_call` once over cap, appending one `abort` log entry.

**Result.** Over cap → tool call blocked and **exactly one** `abort` persisted to real Redis;
cap unset → inert (no block, no `abort`). A key-gated live run confirms the same end-to-end with a
real model. **PASS.** _Reproduce:_ `pnpm -C experiments test e5-budget-structural` from a
pre-split checkout (gate);
`e5-budget-live.test.ts` (live, `SH_RUN_LIVE=1`).

---

## Methodology & credibility notes

- **Measure the right thing.** E2 deliberately measures local reconstruction cost, not end-to-end
  latency (which Pi's compaction already bounds) — the latter would mislead with "no effect."
- **The gates are deterministic where it matters.** E2's entries/bytes ratio and E5's exactly-one-
  `abort` assertion are deterministic; wall-clock columns are illustrative only.
- **Live runs earned their keep.** Running the cluster experiments against a real model + Kind
  surfaced three real defects that static review missed and that were then fixed at root cause:
  a `start_sampler` command-substitution hang, an E3 scale-to-zero fall-through (false-pass risk),
  and an orchestrator `set -e` abort that skipped result-writing. The passing results below were
  produced _after_ those fixes, on green re-runs.

## Other experiment tracks

E1–E5 above are the pi-track (scale-to-zero harness) experiments and this file is their
consolidated home; it does not cover later tracks. Later tracks follow the same
driver-local / consolidated split E1/E3/E4 and E2/E5 already use here, but publish their
own consolidated results file rather than extending this one:

- **P4 — MicroVM sandbox tier (E10 lifecycle primitives, E11 density/replenishment
  ceiling):** drivers live in `microvm/` in
  [`moca-experiments`](https://github.com/rossoctl/moca-experiments); results are consolidated in
  [`moca-experiments/microvm/EXPERIMENTS.md`](https://github.com/rossoctl/moca-experiments/blob/main/microvm/EXPERIMENTS.md). As of this writing,
  E11's driver and its cluster-free test are built and green, but the density sweep has
  only been exercised for shape (no run against real hardware) — see that file's E11
  section for exactly which numbers are filled in and which are still named blanks.

## How to reproduce everything

E2/E5 (`experiments/`) and the E1/E3/E4 cluster drivers (`deploy/knative/`) moved to
[rossoctl/moca-experiments](https://github.com/rossoctl/moca-experiments) on 2026-09-25, with git
history preserved.

**Caveat on `experiments/` (E2/E5) specifically:** it depends on `@moca/harness` and
`@moca/session-backend` as `workspace:*` packages and on `pi-fork` via a `link:` path — none of
which exist standalone in `moca-experiments`. `pnpm -C experiments test` only actually runs from
_inside this monorepo's workspace, before the split_ (i.e. checked out at or before
commit `3057c5f`, the last commit before the split). The code in `moca-experiments/experiments/`
is preserved as a historical record of what
E2/E5 measured, not as a standalone-runnable package — same caveat the E1/E3/E4/E6/E7 Kind/OCP
drivers already carry for needing a live cluster.

```bash
# In-process (no LLM key): E2 + E5 structural -- requires a PRE-SPLIT checkout of this
# repo (at or before 3057c5f); experiments/ moved to moca-experiments and is not
# standalone-runnable there. See the caveat above.
git checkout 3057c5f   # or skip this block on a current checkout
docker run -d --rm --name sh-redis -p 6379:6379 redis:7-alpine
pnpm -C experiments test           # E2, E5 structural, fixtures

# checkpoint parity (E3 fidelity), budget unit, etc. -- in this repo
pnpm -C harness test

# Cluster (needs Kind+Knative deploy + gateway creds): E1, E3-mobility, E4 -- in moca-experiments,
# also needs this repo's deploy/knative/*.yaml manifests + setup-ocp.sh/lib.sh (not moved --
# see this repo's deploy/knative/EXPERIMENTS-MOVED.md, and moca-experiments' own README for
# the full split rationale)
knative/run-experiments.sh         # setup + E1 + E3 + E4, writes knative/EXPERIMENTS.md
```

## Conclusion

MOCA delivers its thesis: **~75% lower idle cost (E1)** with **O(tail)
cold-start reconstruction (E2)**, while **preserving session fidelity and mobility (E3)**,
**recovering from crashes for free (E4)**, and **enforcing a token budget (E5)** — with no change
to the agent's own logic (Pi is forked only for the pluggable storage backend). This completes the
pi-track plan's E1–E5 experiment set.

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
