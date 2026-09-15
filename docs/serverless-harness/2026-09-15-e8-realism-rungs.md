### E8 run 2026-09-15T11:52:45Z

- **Arm: realism.**
  - This is the **deployable** figure: sandbox-shaped by construction, measured against the
    calibrated duty, and gated on the sandbox-pool floor that duty implies. It answers
    "does the density survive a real tool cost", not "how many turns can the harness
    tier push" — the capacity arm answers that one and its number is higher by
    construction.
- **Concurrent in-flight turns sustained (floor): 32** at W=4, S=8.
  - Top rung (32) was still healthy: this is the ladder's limit, **not the machine's**.
    Extend `V_LADDER` to find the machine's.
- Criterion: p95 within 2x its own c=1 baseline, patience 2. Sanity floor 4: true.
- **This is a turn-concurrency number, not a session count.** Sessions addressable is a
  Redis capacity statement and is not measured here (§5.1).
- duty_basis: e6-ocp (E6 / OCP — real Archetype-A code review (L0/L1/L2) on OpenShift): duty 0.061-0.079, implied 12.6-16.5 sessions/sandbox [deploy/knative/EXPERIMENTS.md:88-94]
- conns_per_turn: 1. Each vm_turn call is its own connection; harmless under
  SH_ROUTING_POLICY=leastInFlight (the only policy either driver sets — routing decides
  per request, not per session, so there is no session affinity here to preserve).
- Sandbox pool: 3 leasable sandboxes (floor 3), as reported by the
  supervisor's own /metrics — presence records the selection path can actually lease, not a
  container count on whichever box the driver happened to run on.
- **Per-turn worker CPU** is recorded per rung (`worker_cpu_ms_per_turn`, with
  `worker_cpu_util` as its fraction of the **target's** 8 cores, as the supervisor
  itself reports them — not the 4 cores this driver's own box has, which describes the
  generator and is the denominator for `contention_load1` alone). This is what attributes a
  knee to "the worker tier is actually full" as distinct from "the stub is slow" — with
  only loop lag and RSS the two are indistinguishable, which is why the first published
  density record could not tell them apart.
- **Throughput must not be quoted as a fraction of an "ideal" figure derived from
  concurrency ÷ mean turn.** When most of a turn is the stub's programmed wait, that
  denominator is mostly sleep, so the ratio measures how well the harness hides a fixed
  wait — a concurrency-plumbing check, not a capacity ceiling. The capacity arm exists
  precisely because that ratio was being read as one.
- `loop_lag_p99` must be read against `lag_resolution_ms`, recorded beside it. A
  `monitorEventLoopDelay` histogram reports its own resolution as a floor: at the
  previously shipped resolution of 10ms an IDLE loop reads ~11-21ms, which is why three
  earlier runs read ~11ms at every rung including c=1 and the column looked inert. It does
  discriminate a starved loop (~50-57ms under a deliberately blocked one); it cannot
  discriminate anything below its own floor.
- Model stub profile (fetched from http://127.0.0.1:18081/profile, as resolved at the stub's own boot — not this driver's environment): ttft=300ms tokenDelay=12ms tokens=64 toolRate=0.5
- Generator placement: **undetermined** (derived from `$BASE=http://172.31.8.97:8080`, not
  declared). An **on-box** run is a caveated result, not an equivalent one — see
  EXPERIMENTS.md's "Where the generator ran" section for why and for the off-box/pinning
  guidance.
- Cores on this box: **4** — normalise per-rung `contention_load1` against this
  (load1 / cores, a rough utilization fraction), not against a raw load-average number
  alone.
- Bound observed at: **not observed — the top rung was still healthy, so this ladder found no limit to attribute (extend V_LADDER, or raise W/S, to look further)**
- `lease_saturation` is now sourced: a worker reports the leases it holds and the pool its
  own selection last saw, so the sandbox-pool tier is attributable. **Read its scale with
  care** — it is leases per SANDBOX (held ÷ pool size), so it saturates at the per-sandbox
  lease cap (`KAGENTI_SANDBOX_CAP=13`), not at 1.0. A reader who assumes a 0–1
  ratio will overstate how full the pool was, and the attribution threshold fires at 0.95 —
  around one lease per sandbox, well under real lease capacity. Corroborate a sandbox-pool
  verdict against the arithmetic (3 sandboxes × 13 = concurrent
  leases available) before quoting it.
- `file_op_ms` still reads `NaN`: no file-op-p95 counter exists anywhere in
  `harness/src` or `packages/k8s-sandbox/src` for a worker to report (plan 1 Task 11's
  note). That is a known gap in the shipped surface, not a defect in this driver — the
  relay tier is therefore **unattributed** by this run rather than given a fabricated
  reading.

**§5.7 claim, as measured.** Quote this sentence; do not rewrite it from the numbers above:

> On a single VM, 4 workers each admitting up to 8 in-flight turns
> sustained **32 concurrent turns** with p95 within 2x the single-session
> baseline, with the model tier modelled at ttft=300ms
> tokenDelay=12ms tokens=64
> toolRate=0.5 (as reported by the stub's own /profile route, not this
> driver's environment), and the bound observed at not observed — the top rung was still healthy, so this ladder found no limit to attribute (extend V_LADDER, or raise W/S, to look further).
>
> _Ladder-limited: 32 was the top rung, so the sentence understates the machine._

§5.7's sentence has a second half — what the Knative pod-per-session arm sustained against
this same stub — and E9 produces it. A P6 claim quoting only the half above is incomplete:
a density figure with nothing to compare it to is not an argument for either architecture.

Per-rung records (§5.2 attribution: loop_lag_p99 -> worker CPU/mux; rss_bytes -> memory per
live session; file_op_ms -> relay round trip; sandbox_cpu -> `bash -c` churn;
lease_saturation -> pool provisioning; over_admission -> IPC staleness; spurious_429 -> a
knee read early rather than a real ceiling; contention_load1 -> 1-minute load average, a
contention PROXY not a generator-specific measurement — see EXPERIMENTS.md):

```json
[
  {
    "c": 1,
    "arm": "realism",
    "throughput": 0.652,
    "p50Ms": 1523,
    "p95Ms": 1533,
    "loop_lag_p99": [1.478655, 1.069055, 1.073151, 1.077247],
    "lag_resolution_ms": "1",
    "rss_bytes": [196968448, 171315200, 170508288, 170889216],
    "file_op_ms": "NaN",
    "sandbox_cpu": "3.60",
    "sandbox_util": "2.6",
    "worker_cpu_s": "2.72",
    "worker_cpu_util": "0.7",
    "worker_cpu_ms_per_turn": "90.7",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "0",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 30,
    "ok_n": 30,
    "contention_load1": "0.00"
  },
  {
    "c": 2,
    "arm": "realism",
    "throughput": 1.297,
    "p50Ms": 1522,
    "p95Ms": 1531,
    "loop_lag_p99": [1.476607, 1.505279, 1.074175, 1.071103],
    "lag_resolution_ms": "1",
    "rss_bytes": [214532096, 192356352, 170639360, 170889216],
    "file_op_ms": "NaN",
    "sandbox_cpu": "7.23",
    "sandbox_util": "5.2",
    "worker_cpu_s": "3.56",
    "worker_cpu_util": "1.0",
    "worker_cpu_ms_per_turn": "59.3",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "0",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 60,
    "ok_n": 60,
    "contention_load1": "0.00"
  },
  {
    "c": 4,
    "arm": "realism",
    "throughput": 2.555,
    "p50Ms": 1523,
    "p95Ms": 1968,
    "loop_lag_p99": [1.474559, 1.076223, 1.078271, 1.482751],
    "lag_resolution_ms": "1",
    "rss_bytes": [216891392, 209920000, 195567616, 193384448],
    "file_op_ms": "NaN",
    "sandbox_cpu": "14.51",
    "sandbox_util": "10.3",
    "worker_cpu_s": "5.94",
    "worker_cpu_util": "1.6",
    "worker_cpu_ms_per_turn": "49.5",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "0",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 120,
    "ok_n": 120,
    "contention_load1": "0.00"
  },
  {
    "c": 8,
    "arm": "realism",
    "throughput": 5.036,
    "p50Ms": 1523,
    "p95Ms": 1970,
    "loop_lag_p99": [1.080319, 1.538047, 1.080319, 1.561599],
    "lag_resolution_ms": "1",
    "rss_bytes": [220340224, 217518080, 215441408, 214065152],
    "file_op_ms": "NaN",
    "sandbox_cpu": "29.16",
    "sandbox_util": "20.4",
    "worker_cpu_s": "7.55",
    "worker_cpu_util": "2.0",
    "worker_cpu_ms_per_turn": "31.5",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "1",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 240,
    "ok_n": 240,
    "contention_load1": "0.00"
  },
  {
    "c": 16,
    "arm": "realism",
    "throughput": 9.77,
    "p50Ms": 1525,
    "p95Ms": 1977,
    "loop_lag_p99": [1.517567, 1.483775, 1.083391, 1.075199],
    "lag_resolution_ms": "1",
    "rss_bytes": [196403200, 189419520, 203137024, 184905728],
    "file_op_ms": "NaN",
    "sandbox_cpu": "59.79",
    "sandbox_util": "40.6",
    "worker_cpu_s": "14.26",
    "worker_cpu_util": "3.6",
    "worker_cpu_ms_per_turn": "29.7",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "6",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 480,
    "ok_n": 480,
    "contention_load1": "0.00"
  },
  {
    "c": 32,
    "arm": "realism",
    "throughput": 16.651,
    "p50Ms": 1535,
    "p95Ms": 2454,
    "loop_lag_p99": [1.477631, 1.080319, 1.076223, 1.072127],
    "lag_resolution_ms": "1",
    "rss_bytes": [231559168, 186703872, 188346368, 185241600],
    "file_op_ms": "NaN",
    "sandbox_cpu": "130.77",
    "sandbox_util": "75.6",
    "worker_cpu_s": "28.42",
    "worker_cpu_util": "6.2",
    "worker_cpu_ms_per_turn": "29.6",
    "lease_saturation": "0.3333333333333333",
    "over_admission": "16",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "e6-ocp",
    "attempts": 960,
    "ok_n": 960,
    "contention_load1": "0.05"
  }
]
```
