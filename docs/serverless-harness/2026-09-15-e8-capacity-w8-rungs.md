### E8 run 2026-09-15T12:21:52Z

- **Arm: capacity.**
  - This number is an **UPPER BOUND on the supervisor + worker tier**, not a deployable
    density. The sandbox tier was held deliberately non-binding and non-competing (a
    trivial exec, measured utilisation 25% ceiling enforced per rung), so a real
    tool cost will bring it down. The deployable figure is the **realism** arm's, and
    neither arm's number may be quoted as the other's.
  - The sandbox tier's OWN capacity is not this experiment's subject: that is P4 §7.2
    (E10) and §7.3 (E11). E11 records "lease saturation one tier up" for the mirror-image
    hazard — a harness-side refusal misread as a VM-tier limit.
- **Concurrent in-flight turns sustained (floor): 32** at W=8, S=64.
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
  2x before this ran: W×S=512 admitted, 16×86 concurrent leases.
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
- Bound observed at: **the target host ran out of CPU — 66.5% of 8 cores non-idle at the knee (worker processes only 47.4% of it, the rest being the supervisor hand-off, relay, Redis, stub, sandbox leaves and kernel time), so this is the machine and not one tier. More workers will not help; a larger host or a cheaper turn will**
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

> On a single VM, 8 workers each admitting up to 64 in-flight turns
> sustained **32 concurrent turns** with p95 within 2x the single-session
> baseline, with the model tier modelled at ttft=10ms
> tokenDelay=1ms tokens=64
> toolRate=0.5 (as reported by the stub's own /profile route, not this
> driver's environment), and the bound observed at the target host ran out of CPU — 66.5% of 8 cores non-idle at the knee (worker processes only 47.4% of it, the rest being the supervisor hand-off, relay, Redis, stub, sandbox leaves and kernel time), so this is the machine and not one tier. More workers will not help; a larger host or a cheaper turn will.

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
    "throughput": 9.2,
    "p50Ms": 103,
    "p95Ms": 107,
    "loop_lag_p99": [
      2.142207, 1.072127, 1.079295, 1.075199, 1.078271, 1.074175, 1.078271, 1.077247
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      317558784, 289341440, 280444928, 282001408, 282742784, 266784768, 277147648, 278499328
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.11",
    "sandbox_util": "0.2",
    "worker_cpu_s": "1.15",
    "worker_cpu_util": "4.4",
    "worker_cpu_ms_per_turn": "38.3",
    "worker_cpu_util_box": "4.4",
    "worker_tier_cores": "8",
    "host_cpu_s": "1.53",
    "host_cpu_util": "5.9",
    "lease_saturation": "0.0625",
    "over_admission": "17959",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 30,
    "ok_n": 30,
    "contention_load1": "0.44"
  },
  {
    "c": 2,
    "arm": "capacity",
    "throughput": 18.439,
    "p50Ms": 103,
    "p95Ms": 123,
    "loop_lag_p99": [
      2.172927, 2.289663, 1.076223, 1.078271, 1.077247, 1.076223, 1.078271, 1.077247
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      325423104, 303181824, 280444928, 282001408, 282742784, 266784768, 277147648, 278499328
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.23",
    "sandbox_util": "0.4",
    "worker_cpu_s": "1.54",
    "worker_cpu_util": "5.9",
    "worker_cpu_ms_per_turn": "25.7",
    "worker_cpu_util_box": "5.9",
    "worker_tier_cores": "8",
    "host_cpu_s": "2.23",
    "host_cpu_util": "8.6",
    "lease_saturation": "0.125",
    "over_admission": "17959",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 60,
    "ok_n": 60,
    "contention_load1": "0.41"
  },
  {
    "c": 4,
    "arm": "capacity",
    "throughput": 35.864,
    "p50Ms": 104,
    "p95Ms": 126,
    "loop_lag_p99": [
      2.172927, 2.498559, 2.668543, 2.461695, 1.210367, 1.116159, 1.102847, 1.101823
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      327913472, 311832576, 295800832, 298254336, 282742784, 266784768, 277147648, 278499328
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.47",
    "sandbox_util": "0.9",
    "worker_cpu_s": "3.23",
    "worker_cpu_util": "12.1",
    "worker_cpu_ms_per_turn": "26.9",
    "worker_cpu_util_box": "12.1",
    "worker_tier_cores": "8",
    "host_cpu_s": "4.31",
    "host_cpu_util": "16.1",
    "lease_saturation": "0.1875",
    "over_admission": "17959",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 120,
    "ok_n": 120,
    "contention_load1": "0.38"
  },
  {
    "c": 8,
    "arm": "capacity",
    "throughput": 67.568,
    "p50Ms": 108,
    "p95Ms": 132,
    "loop_lag_p99": [
      2.232319, 2.248703, 2.211839, 2.105343, 2.519039, 2.014207, 2.463743, 2.256895
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      327651328, 315109376, 304369664, 307822592, 298864640, 283037696, 292057088, 295669760
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "0.93",
    "sandbox_util": "1.6",
    "worker_cpu_s": "6.37",
    "worker_cpu_util": "22.4",
    "worker_cpu_ms_per_turn": "26.5",
    "worker_cpu_util_box": "22.4",
    "worker_tier_cores": "8",
    "host_cpu_s": "8.51",
    "host_cpu_util": "29.9",
    "lease_saturation": "0.5",
    "over_admission": "17959",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 240,
    "ok_n": 240,
    "contention_load1": "0.35"
  },
  {
    "c": 16,
    "arm": "capacity",
    "throughput": 122.699,
    "p50Ms": 115,
    "p95Ms": 173,
    "loop_lag_p99": [
      2.992127, 2.863103, 2.852863, 2.932735, 3.151871, 3.231743, 4.116479, 3.293183
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      325267456, 311980032, 304902144, 310988800, 310661120, 300539904, 304377856, 306708480
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "1.92",
    "sandbox_util": "3.1",
    "worker_cpu_s": "10.26",
    "worker_cpu_util": "32.8",
    "worker_cpu_ms_per_turn": "21.4",
    "worker_cpu_util_box": "32.8",
    "worker_tier_cores": "8",
    "host_cpu_s": "15.18",
    "host_cpu_util": "48.5",
    "lease_saturation": "1",
    "over_admission": "17963",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 480,
    "ok_n": 480,
    "contention_load1": "0.32"
  },
  {
    "c": 32,
    "arm": "capacity",
    "throughput": 205.567,
    "p50Ms": 129,
    "p95Ms": 198,
    "loop_lag_p99": [
      3.977215, 4.202495, 4.268031, 4.386815, 4.325375, 4.073471, 4.759551, 4.173823
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      330903552, 319713280, 311062528, 318722048, 323411968, 316268544, 317730816, 313786368
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "4.10",
    "sandbox_util": "5.5",
    "worker_cpu_s": "17.71",
    "worker_cpu_util": "47.4",
    "worker_cpu_ms_per_turn": "18.4",
    "worker_cpu_util_box": "47.4",
    "worker_tier_cores": "8",
    "host_cpu_s": "24.84",
    "host_cpu_util": "66.5",
    "lease_saturation": "0.25",
    "over_admission": "18030",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 960,
    "ok_n": 960,
    "contention_load1": "0.37"
  },
  {
    "c": 64,
    "arm": "capacity",
    "throughput": 291.793,
    "p50Ms": 178,
    "p95Ms": 314,
    "loop_lag_p99": [
      6.078463, 6.565887, 15.704063, 5.328895, 5.447679, 6.057983, 7.725055, 4.599807
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      346107904, 331640832, 330199040, 335020032, 331800576, 342089728, 328347648, 328134656
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "8.94",
    "sandbox_util": "8.5",
    "worker_cpu_s": "32.92",
    "worker_cpu_util": "62.5",
    "worker_cpu_ms_per_turn": "17.1",
    "worker_cpu_util_box": "62.5",
    "worker_tier_cores": "8",
    "host_cpu_s": "47.14",
    "host_cpu_util": "89.6",
    "lease_saturation": "0.5625",
    "over_admission": "18614",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 1920,
    "ok_n": 1920,
    "contention_load1": "0.42"
  },
  {
    "c": 128,
    "arm": "capacity",
    "throughput": 350.365,
    "p50Ms": 297,
    "p95Ms": 574,
    "loop_lag_p99": [
      6.901759, 6.844415, 18.661375, 5.455871, 6.610943, 6.709247, 6.995967, 20.463615
    ],
    "lag_resolution_ms": "1",
    "rss_bytes": [
      360263680, 347893760, 348016640, 350617600, 348839936, 508944384, 358412288, 344649728
    ],
    "file_op_ms": "NaN",
    "sandbox_cpu": "18.07",
    "sandbox_util": "10.3",
    "worker_cpu_s": "54.47",
    "worker_cpu_util": "62.1",
    "worker_cpu_ms_per_turn": "14.2",
    "worker_cpu_util_box": "62.1",
    "worker_tier_cores": "8",
    "host_cpu_s": "83.35",
    "host_cpu_util": "95.1",
    "lease_saturation": "1.4375",
    "over_admission": "20937",
    "spurious_refusals": "0",
    "spurious_429": 0,
    "conns_per_turn": 1,
    "duty_basis": "none (capacity arm)",
    "attempts": 3840,
    "ok_n": 3840,
    "contention_load1": "0.48"
  }
]
```
