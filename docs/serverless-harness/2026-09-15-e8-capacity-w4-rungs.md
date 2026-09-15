### E8 run 2026-09-15T12:08:55Z

- **Arm: capacity.**
  - This number is an **UPPER BOUND on the supervisor + worker tier**, not a deployable
    density. The sandbox tier was held deliberately non-binding and non-competing (a
    trivial exec, measured utilisation 25% ceiling enforced per rung), so a real
    tool cost will bring it down. The deployable figure is the **realism** arm's, and
    neither arm's number may be quoted as the other's.
  - The sandbox tier's OWN capacity is not this experiment's subject: that is P4 §7.2
    (E10) and §7.3 (E11). E11 records "lease saturation one tier up" for the mirror-image
    hazard — a harness-side refusal misread as a VM-tier limit.
- **Concurrent in-flight turns sustained (floor): 32** at W=4, S=64.
- Criterion: p95 within 2x its own c=1 baseline, patience 2. Sanity floor 4: true.
- **This is a turn-concurrency number, not a session count.** Sessions addressable is a
  Redis capacity statement and is not measured here (§5.1).
- duty_basis: none (capacity arm: sandbox tier held non-binding; no §2.3 row applies)
- conns_per_turn: 1. Each vm_turn call is its own connection; harmless under
  SH_ROUTING_POLICY=leastInFlight (the only policy either driver sets — routing decides
  per request, not per session, so there is no session affinity here to preserve).
- Sandbox pool: 16 leasable sandboxes, as reported by the supervisor's own
  /metrics — presence records the selection path can actually lease, not a container count
  on whichever box the driver happened to run on. **No pool floor applies to this arm**
  (it takes no §2.3 row); the precondition is the opposite one, a measured utilisation
  ceiling of 25%, checked at EVERY rung against the `sandbox_util` column below.
- Admission and lease caps were both required to clear the top rung (128) by
  2x before this ran: W×S=256 admitted, 16×86 concurrent leases.
  A ladder whose top rung is its own cap can only report `not-observed`, which is what
  two earlier zero-duty runs did at c=64.
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
- Model stub profile (fetched from http://127.0.0.1:18081/profile, as resolved at the stub's own boot — not this driver's environment): ttft=10ms tokenDelay=1ms tokens=64 toolRate=0.5
- Generator placement: **undetermined** (derived from `$BASE=http://172.31.8.97:8080`, not
  declared). An **on-box** run is a caveated result, not an equivalent one — see
  EXPERIMENTS.md's "Where the generator ran" section for why and for the off-box/pinning
  guidance.
- Cores on this box: **4** — normalise per-rung `contention_load1` against this
  (load1 / cores, a rough utilization fraction), not against a raw load-average number
  alone.
- Bound observed at: **unattributed — no tier crossed its threshold at the knee, so the bound is not identified by this run**
- `lease_saturation` is now sourced: a worker reports the leases it holds and the pool its
  own selection last saw, so the sandbox-pool tier is attributable. **Read its scale with
  care** — it is leases per SANDBOX (held ÷ pool size), so it saturates at the per-sandbox
  lease cap (`KAGENTI_SANDBOX_CAP=86`), not at 1.0. A reader who assumes a 0–1
  ratio will overstate how full the pool was, and the attribution threshold fires at 0.95 —
  around one lease per sandbox, well under real lease capacity. Corroborate a sandbox-pool
  verdict against the arithmetic (16 sandboxes × 86 = concurrent
  leases available) before quoting it.
- `file_op_ms` still reads `NaN`: no file-op-p95 counter exists anywhere in
  `harness/src` or `packages/k8s-sandbox/src` for a worker to report (plan 1 Task 11's
  note). That is a known gap in the shipped surface, not a defect in this driver — the
  relay tier is therefore **unattributed** by this run rather than given a fabricated
  reading.

**§5.7 claim, as measured.** Quote this sentence; do not rewrite it from the numbers above:

> On a single VM, 4 workers each admitting up to 64 in-flight turns
> sustained **32 concurrent turns** with p95 within 2x the single-session
> baseline, with the model tier modelled at ttft=10ms
> tokenDelay=1ms tokens=64
> toolRate=0.5 (as reported by the stub's own /profile route, not this
> driver's environment), and the bound observed at unattributed — no tier crossed its threshold at the knee, so the bound is not identified by this run.

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
    "arm": "capacity",
    "throughput": 9.422,
    "p50Ms": 100,
    "p95Ms": 106,
    "loop_lag_p99": [2.000895, 1.077247, 1.076223, 1.075199],
    "lag_resolution_ms": "1",
    "rss_bytes": [296853504, 239894528, 275193856, 233181184],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.12",
    "sandbox_util": "0.2",
    "worker_cpu_s": "0.78",
    "worker_cpu_util": "6.1",
    "worker_cpu_ms_per_turn": "26.0",
    "worker_cpu_util_box": "3.1",
    "worker_tier_cores": "4",
    "lease_saturation": "0.0625",
    "over_admission": "3517",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 30,
    "ok_n": 30,
    "contention_load1": "0.00"
  },
  {
    "c": 2,
    "arm": "capacity",
    "throughput": 18.844,
    "p50Ms": 100,
    "p95Ms": 118,
    "loop_lag_p99": [1.985535, 1.890303, 1.079295, 1.077247],
    "lag_resolution_ms": "1",
    "rss_bytes": [308310016, 255569920, 275193856, 233312256],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.20",
    "sandbox_util": "0.4",
    "worker_cpu_s": "1.20",
    "worker_cpu_util": "9.4",
    "worker_cpu_ms_per_turn": "20.0",
    "worker_cpu_util_box": "4.7",
    "worker_tier_cores": "4",
    "lease_saturation": "0.125",
    "over_admission": "3517",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 60,
    "ok_n": 60,
    "contention_load1": "0.08"
  },
  {
    "c": 4,
    "arm": "capacity",
    "throughput": 36.485,
    "p50Ms": 102,
    "p95Ms": 154,
    "loop_lag_p99": [2.140159, 2.057215, 1.921023, 1.969151],
    "lag_resolution_ms": "1",
    "rss_bytes": [310730752, 269160448, 292888576, 251006976],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.41",
    "sandbox_util": "0.8",
    "worker_cpu_s": "2.97",
    "worker_cpu_util": "22.6",
    "worker_cpu_ms_per_turn": "24.8",
    "worker_cpu_util_box": "11.3",
    "worker_tier_cores": "4",
    "lease_saturation": "0.1875",
    "over_admission": "3517",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 120,
    "ok_n": 120,
    "contention_load1": "0.08"
  },
  {
    "c": 8,
    "arm": "capacity",
    "throughput": 68.886,
    "p50Ms": 105,
    "p95Ms": 129,
    "loop_lag_p99": [2.158591, 2.187263, 2.089983, 2.314239],
    "lag_resolution_ms": "1",
    "rss_bytes": [311648256, 270548992, 305733632, 270422016],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.85",
    "sandbox_util": "1.5",
    "worker_cpu_s": "4.04",
    "worker_cpu_util": "29.0",
    "worker_cpu_ms_per_turn": "16.8",
    "worker_cpu_util_box": "14.5",
    "worker_tier_cores": "4",
    "lease_saturation": "0.4375",
    "over_admission": "3518",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 240,
    "ok_n": 240,
    "contention_load1": "0.15"
  },
  {
    "c": 16,
    "arm": "capacity",
    "throughput": 129.032,
    "p50Ms": 111,
    "p95Ms": 149,
    "loop_lag_p99": [2.312191, 2.605055, 2.246655, 2.543615],
    "lag_resolution_ms": "1",
    "rss_bytes": [315568128, 282476544, 312029184, 286674944],
    "file_op_ms": "NaN",
    "sandbox_cpu": "1.77",
    "sandbox_util": "3.0",
    "worker_cpu_s": "7.18",
    "worker_cpu_util": "48.3",
    "worker_cpu_ms_per_turn": "15.0",
    "worker_cpu_util_box": "24.1",
    "worker_tier_cores": "4",
    "lease_saturation": "0.9375",
    "over_admission": "3529",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 480,
    "ok_n": 480,
    "contention_load1": "0.14"
  },
  {
    "c": 32,
    "arm": "capacity",
    "throughput": 211.967,
    "p50Ms": 122,
    "p95Ms": 192,
    "loop_lag_p99": [3.995647, 3.661823, 3.229695, 4.028415],
    "lag_resolution_ms": "1",
    "rss_bytes": [328282112, 331497472, 319762432, 333205504],
    "file_op_ms": "NaN",
    "sandbox_cpu": "3.85",
    "sandbox_util": "5.3",
    "worker_cpu_s": "14.42",
    "worker_cpu_util": "79.6",
    "worker_cpu_ms_per_turn": "15.0",
    "worker_cpu_util_box": "39.8",
    "worker_tier_cores": "4",
    "lease_saturation": "1.75",
    "over_admission": "3644",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 960,
    "ok_n": 960,
    "contention_load1": "0.29"
  },
  {
    "c": 64,
    "arm": "capacity",
    "throughput": 316.989,
    "p50Ms": 164,
    "p95Ms": 272,
    "loop_lag_p99": [5.296127, 5.926911, 6.852607, 4.956159],
    "lag_resolution_ms": "1",
    "rss_bytes": [336404480, 436355072, 337494016, 410476544],
    "file_op_ms": "NaN",
    "sandbox_cpu": "8.47",
    "sandbox_util": "8.7",
    "worker_cpu_s": "24.79",
    "worker_cpu_util": "102.3",
    "worker_cpu_ms_per_turn": "12.9",
    "worker_cpu_util_box": "51.2",
    "worker_tier_cores": "4",
    "lease_saturation": "2.4375",
    "over_admission": "4443",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 1920,
    "ok_n": 1920,
    "contention_load1": "0.59"
  },
  {
    "c": 128,
    "arm": "capacity",
    "throughput": 395.265,
    "p50Ms": 270,
    "p95Ms": 466,
    "loop_lag_p99": [13.737983, 12.574719, 15.310847, 10.633215],
    "lag_resolution_ms": "1",
    "rss_bytes": [347021312, 590766080, 343916544, 629460992],
    "file_op_ms": "NaN",
    "sandbox_cpu": "17.48",
    "sandbox_util": "11.2",
    "worker_cpu_s": "40.86",
    "worker_cpu_util": "105.1",
    "worker_cpu_ms_per_turn": "10.6",
    "worker_cpu_util_box": "52.6",
    "worker_tier_cores": "4",
    "lease_saturation": "5.5625",
    "over_admission": "6906",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 3840,
    "ok_n": 3840,
    "contention_load1": "1.05"
  }
]
```
