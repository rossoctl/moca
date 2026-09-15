# P6 VM experiments — E8 (density) and E9 (tier comparison)

Results appended by `e8-density.sh` and `e9-tiers.sh`. Newest last.

## What these numbers are, and are not

**Two axes, never conflated (spec §5.1):**

- **Concurrent in-flight turns** — the resource-consuming quantity. This is the only thing a
  knee applies to, and the only thing E8 measures.
- **Sessions addressable** — a Redis capacity statement. Not a density claim, not measured here.

**Every knee is a floor.** `detectKnee` reports the highest rung that was still healthy among
the rungs that were run. If the top rung was healthy, the number is the ladder's limit, not the
machine's. No record here says "maximum".

**Healthy** means p95 within `DEGRADE_X` (default 2) of that arm's own `c=1` baseline, with
patience 2 — the same criterion `experiments/src/sharing.ts` applies to E6, so E6, E8, and E9
records are in the same units.

## E8 has two arms, and their numbers are not interchangeable (§5.2)

| Arm          | Sandbox tier                                | Stub profile        | Precondition                                       | What its number is                     |
| ------------ | ------------------------------------------- | ------------------- | -------------------------------------------------- | -------------------------------------- |
| **realism**  | calibrated duty, one §2.3 row (`e6-ocp`)    | 300/12/64           | pool **floor** `K ≥ ceil(W × S × duty)`            | the **deployable** density             |
| **capacity** | trivial exec, non-binding and non-competing | fast (ttft ≤ 25 ms) | measured utilisation **ceiling** ≤ 25%, every rung | an **upper bound on the harness tier** |

Run them as:

```bash
# realism: calibrate against the e6-ocp band, then run with the shipped caps
./prepare-workload.sh
V_ARM=realism ./e8-density.sh

# capacity: trivial exec and a fast stub, with BOTH caps moved out of the ladder's way. The
# supervisor must have been STARTED with these -- S and the lease cap are restart-time constants.
#   SH_WORKERS=4 SH_TURNS_PER_WORKER=64   -> 256 admitted, clears a c=128 top rung by 2x
#   KAGENTI_SANDBOX_CAP=86 (3 sandboxes)  -> 258 concurrent leases, likewise
# Both are refused rather than warned about if they do not clear it, so a run that starts is a run
# whose knee cannot be either cap.
ARM=capacity ./prepare-workload.sh
V_ARM=capacity V_LADDER='1 2 4 8 16 32 64 128' ./e8-density.sh
```

The capacity arm's caps are **enforced, and you have to provide them**: `deploy/vm/env/supervisor.env.example`
ships the realism arm's values (`KAGENTI_SANDBOX_CAP=13`, `SH_TURNS_PER_WORKER` deliberately empty) and
documents the capacity arm's beside them. A lease is held per **session**, not per exec — the cap-of-4
run proved it, 12 leases yielding exactly 12 × 30 successes — so `pool × cap` is what must clear the
ladder, and 86 is only safe in this arm because its tool call is trivial and the utilisation ceiling
independently refuses a sandbox tier that is actually busy.

**A capacity-arm figure quoted as a density is a wrong number, not a rounded one.** The sandbox tier is
held out of the way there on purpose, so a real tool cost brings the figure down; the realism arm is the
deployable one. The driver labels both in `E8_RESULT` (`arm=`) and in every per-rung record, and the
capacity arm additionally requires that `W × S` and `pool × KAGENTI_SANDBOX_CAP` each clear the
ladder's top rung by 2× — otherwise a knee it finds is one of the two caps, which is what
`bound=not-observed` meant in the earlier runs.

The sandbox tier's **own** capacity is not E8's subject at all: that is P4 §7.2 (E10) and §7.3 (E11).

## What every E8 run record must carry (§5.2, §5.7)

This shape describes **E8's** records only — see the note at the end of this
section for what an E9 record actually contains. A missing E8 field is not a result:

| Field                    | Why it is load-bearing                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `arm`                    | Which question this rung answers. Without it the two arms' numbers are one copy-paste apart.                                   |
| `duty_basis`             | One §2.3 row, taken whole. A blend implies a wrong sandbox count. `none (capacity arm)` is a VALUE — distinct from blank.      |
| `worker_cpu_ms_per_turn` | Worker CPU-seconds ÷ turns served. Tells "the worker tier is full" from "the stub is slow"; nothing else does.                 |
| `worker_cpu_util`        | The same figure as a fraction of this box's cores — the threshold `bound=worker-cpu` fires on.                                 |
| `sandbox_util`           | Measured sandbox utilisation. The capacity arm's precondition; a realism-arm diagnostic.                                       |
| `lag_resolution_ms`      | The floor `loop_lag_p99` sits on. A lag reading without it is unreadable (see below).                                          |
| `conns_per_turn`         | What the driver actually does (one connection per turn) — see the note below.                                                  |
| stub profile             | Half the claim. ttft, token delay, output tokens, tool-call rate.                                                              |
| `loop_lag_p99`           | Attributes a knee to worker CPU / socket multiplexing.                                                                         |
| `rss_bytes`              | Memory per live session.                                                                                                       |
| `file_op_ms`             | The relay round trip.                                                                                                          |
| `sandbox_cpu`            | `bash -c` churn across the pool. **Cumulative CPU seconds** (`{{.CPUNano}}`), differenced per rung — see the correction below. |
| `lease_saturation`       | An under-provisioned pool, which reads exactly like worker saturation.                                                         |
| `over_admission`         | Bounds IPC staleness; self-correcting, so it is a diagnostic not a failure.                                                    |
| `spurious_refusals`      | Refusals the next `load` convicted. Attributes a `spurious_429` to staleness.                                                  |
| `spurious_429`           | **The dangerous one.** Refusals truncate a rung, so the knee reads early.                                                      |
| `attempts`               | Total requests issued at this rung — the denominator for the success rate.                                                     |
| `ok_n`                   | 200-coded requests at this rung — the numerator, and what `p50`/`p95` are computed over.                                       |
| `contention_load1`       | 1-minute load average, a contention PROXY (not a generator-specific measurement) — see "Where the generator ran" below.        |

`generator_placement` (on-box/undetermined — round 2, item 4a renamed the non-loopback case from
"off-box"; see below for why) is recorded once **per run**, not per rung, in the run-summary prose
rather than this per-rung JSON shape — see "Where the generator ran" below. So is `core_count`
(round 2, item 4b), the denominator `contention_load1` needs normalising against — also once per
run, in the run-summary prose, never per rung, because core count does not change mid-ladder either.

### `p50`/`p95` are computed over successes only, and there is a floor below which a rung is not a result

A latency sample that mixes fast failures (a refused or timed-out request returns in a fraction
of a real response's time) with genuine responses is not a latency distribution. Sorted
ascending, the failures pile up at the bottom of the sample, so the **naive** p95 taken over
every row — successes and failures together — is really the successes' own
`(0.95 - f) / (1 - f)` quantile, where `f` is the failure fraction. At `f = 0.05` the shift is
negligible (the effective quantile is ~0.947). At `f = 0.5` the naive "p95" is actually the
successes' own **p90** wearing a p95 label — a materially different number reported under the
wrong name. See `task-3-report.md`'s "Final review fix — part 2" section for the worked
numeric example. Both drivers now filter to `ok_n`/200-coded rows before computing `p50`/`p95`;
`attempts` and `ok_n` (E8) or `attempts` and `non200` (E9, §below) are recorded precisely so this
filtering is auditable from the record itself, not merely asserted by the driver's prose.

**Success-rate floor: 0.95.** Below a 95% success rate at a rung, that rung is not a capacity
result and must not be quoted as one, even though the (now-filtered) p95 and the throughput
figure will both still look healthy — throughput saturates at whatever the arm actually
completed, and the filtered p95 by construction excludes every failure, so neither number is
sensitive to a failure storm. 0.95 is chosen, not derived, from the quantile-shift arithmetic
above: at `f = 0.05` the p95 shift is negligible (~0.3 points of quantile), so a rung just at the
floor still reports an honest p95; the floor exists to catch rungs well past that, where `f` is
large enough to materially relabel a lower quantile as p95. Both drivers WARN (not `ko`) when a
rung falls below this floor — a WARN, not a hard failure, because a low success rate at one rung
of a ladder is informative (it is itself part of what the ladder is measuring, e.g. an
admission-control knee) and should not abort a run that would otherwise produce useful rungs
above or below it; the existing `spurious_429`/`non200` WARNs already cover the mechanism, this
floor generalizes the same signal to any failure mode (a 500/503/000 storm, not only 429s) and
gives it an explicit, comparable numeric line rather than leaving "some failures happened" as
the only signal.

`conns_per_turn` records an observation, not a knob: both drivers leave `SH_ROUTING_POLICY` at
its `leastInFlight` default (`deploy/vm/env/supervisor.env.example:7`), under which routing
decides per request, not per session, so there is no session affinity for a per-turn connection
to defeat — one connection per turn is simply what `vm_turn` (`lib-vm.sh`) does. Exercising
`stickyBySession`'s session affinity is a separate, not-yet-covered gap, not something this field
or either driver's rung loop measures.

### Three corrections to the instrumentation itself, each of which produced a plausible number

Found while building the two arms. Recorded here because in every case the field kept its name while
measuring something else, so no reader had reason to doubt it.

**1. `sandbox_cpu` was a percentage, not CPU-seconds — and it summed the whole box.** It read
`podman stats --format '{{.CPU}}'`, an _instantaneous percent_, and the driver differenced two samples
per rung: a quantity with no time base, which can come out negative. Verified against podman:

| template       | value           | meaning                                                            |
| -------------- | --------------- | ------------------------------------------------------------------ |
| `{{.CPU}}`     | `1.0714`        | percent, right now                                                 |
| `{{.CPUNano}}` | `4596421884000` | cumulative ns — matches that container's `cpu_time` of 1h16m36.42s |

It also summed **every** container on the box (Redis, the relay, the stub) under a name that says
"sandbox". Both are fixed: the helper reads `{{.CPUNano}}` and filters to `sh-sandbox-*`. This matters
beyond tidiness — the capacity arm's utilisation ceiling is computed from that delta, and could not have
been built on the old field.

**2. Event-loop lag was reporting its own resolution floor.** All three earlier runs read 10.3–11.6 ms
at every rung, _including c=1_ on a nearly idle tier, moving with neither concurrency nor turn duration
nor worker count. Measured against the same sampler shape (p99 read once a second, reset each read):

| `resolution` | idle p99     | loop blocked in 50 ms chunks |
| ------------ | ------------ | ---------------------------- |
| 10 (shipped) | 15.7–21.6 ms | 56.1–57.0 ms                 |
| 1 (now)      | 1.9–6.4 ms   | 50.4 ms                      |

So the sampler does discriminate a starved loop; what it could not do was see anything below its own
floor, and the attribution threshold (`lag / lag0 ≥ 4`) needed ~44 ms of real delay before it could
fire. `SH_LAG_RESOLUTION_MS` now defaults to 1, and the resolution ships in the record as
`lag_resolution_ms`. **Read a lag column against its own floor, never as an absolute.**

**3. An unmeasurable metric now reads `NaN` where it used to read `0`.** `sandbox_cpu_seconds` summed
empty input to `"0.00"`, so a driver that could not see a container runtime at all — the **off-box
generator this file's own guidance requires** — produced a confident zero. Under the capacity arm's
_ceiling_ that is the one reading that passes the gate vacuously, on exactly the run the gate exists to
refuse. The capacity arm now refuses an unmeasured sandbox tier, and `V_SANDBOX_CPU_CMD` exists so an
off-box run can supply the target's own figure (e.g. via `ssh`).

### Throughput is not a percentage of an "ideal", and the earlier records' version of it was not capacity

An earlier record reported "88% of ideal throughput", with the ideal taken as `32 ÷ 1.537 s`. At the
300/12/64 profile ~1.42 s of that 1.537 s turn is the stub's own programmed wait, so the denominator is
mostly sleep: the ratio measures **how well the harness hides a fixed wait** — a concurrency-plumbing
check — and not how much work the box can do. Do not report such a ratio as a capacity figure in either
arm. The capacity arm exists because that ratio was being read as one.

### The free check that preceded this work, and what it found

Before any of the above was written, the intent was to confirm the sandbox tier's CPU share
quantitatively out of the **existing** calibrated run record, which needs no new run. Result, recorded
because it is a negative one:

- The run's per-rung JSON — the block that does carry `sandbox_cpu` and `rss_bytes` — was appended to
  this file **on the target VM** and never came back; the distilled findings tables omit both fields. So
  the check could not be performed from any surviving record.
- And it could not have answered the question anyway: `sandbox_cpu` was the percentage described above,
  not CPU-seconds.

The premise it was meant to test survives independently: the ~2.35-of-8-cores figure comes from
`duty × c` (0.0735 × 32), not from `sandbox_cpu`. The instrument was wrong; the arithmetic was not.
**Copy a run's per-rung JSON block off the target before the box goes away** — that is the reason this
check had no data.

### One of these columns is permanently `NaN` — this is not a missing run, it is a missing sensor

Real, load-bearing attribution telemetry every **E8** run record actually carries: `loop_lag_p99`
(read against `lag_resolution_ms`), `rss_bytes`, `worker_cpu_ms_per_turn`, `worker_cpu_util`,
`sandbox_cpu`, `sandbox_util`, `over_admission`, `spurious_refusals`, `spurious_429`, `attempts`,
`ok_n`. `contention_load1` is also real (it is not `NaN`-by-design like `file_op_ms` below), but
round 2, item 4c moved it out of this list deliberately: unlike the others, it is not scoped to any
one of E8's attribution tiers, and — for E9, see "Where the generator ran" below — it does not even
vary per arm the way its own field name's placement in a per-arm record might suggest. Treat it as a
box-level contention proxy alongside this list, not as a member of it.

`lease_saturation` **was** in this permanently-`NaN` list and no longer belongs there: workers now
report the leases they hold and the pool their own selection last saw, so the sandbox-pool tier is
attributable. Read its scale with care — it is leases per **sandbox**, so it saturates at
`KAGENTI_SANDBOX_CAP`, not at 1.0, and the attribution threshold of 0.95 is therefore around one lease
per sandbox rather than a full pool. Corroborate any `bound=sandbox-pool` verdict against the
arithmetic (pool × cap = concurrent leases available) before quoting it.

`file_op_ms` remains the exception, and it will read `NaN` in **every E8 record**, on any VM, no matter
how it is provisioned — not because the run failed to collect it, but because nothing in this
repository computes it. No file-op p95 counter exists anywhere in `harness/src` or
`packages/k8s-sandbox/src` for a worker to report. A future change could add one — this file does not
claim the gap is permanent architecture, only that it is real today — but until one does, `file_op_ms`
is not a measurement this driver declined to make; it is one this codebase cannot yet make.

**`file_op_ms` stays `NaN`, and that is a decision rather than an oversight.** It was left unbuilt
deliberately when the arms were added: the capacity arm keeps exactly one exec per turn, so per-turn
worker CPU plus the measured per-exec cost already bound what the relay hop can be costing, and
instrumenting the relay's own latency spans the harness, the worker stats message and the supervisor's
aggregates — the relay tier's own work, not this experiment's. Whoever needs the relay hop attributed in
its own right should build it there; until then no E8 record may claim the relay was ruled out.

**A different case — an all-failed rung at `c>1` (`ok_n=0`, not a c=1 dead arm, which
`require_live_arm` already hard-fails on) — renders its unmeasurable fields as two different
JSON types, and both are intentional, not a bug to unify (round 2 minor item).** `p50Ms`/`p95Ms`
come from `percentile`, which returns the bash string `"NaN"` over an empty latency file;
`e8-density.sh` passes that string to jq via `--argjson`, which accepts `NaN` as a parser
extension but has no JSON literal to serialize it back out as, so **the record's `p50Ms`/`p95Ms`
come out as JSON `null`**, not the string `"NaN"` — confirmed directly: `jq -n --argjson p50 NaN
'{p50: $p50}'` prints `{"p50": null}`. `lease_saturation`, `file_op_ms`, `over_admission`,
`spurious_refusals`, and `contention_load1`, by contrast, are passed via `--arg`, which always
produces a JSON string — so on the same all-failed rung they come out as the literal three-byte
JSON string `"NaN"`, exactly as the permanently-`NaN` columns above always do. The difference is
not an inconsistency to fix; it tracks each field's own normal type. `p50Ms`/`p95Ms` are genuine
JSON numbers on every healthy rung (so a downstream consumer summing or sorting them does not
have to string-parse first), and `null` is the correct JSON way to say "no number here" for a
field of that type. The `--arg` fields are JSON strings on every rung, healthy or not — quoting
`"NaN"` is consistent with their own type, not a departure from it. Reading a record's raw JSON
for an all-failed rung: expect `null` on `p50Ms`/`p95Ms` and the string `"NaN"` on the rest; a
tool that treats `null` and `"NaN"` as the same "unmeasured" sentinel across all of these fields
will read this record correctly regardless of which one it hits. (`POINTS`' own `p95Ms` — the
array `detectKnee` consumes, distinct from the run-record `RECORDS` documented here — depends on
this exact `null` behaviour for a different reason entirely; see `percentile`'s and
`detectKnee`'s own comments for that load-bearing coupling, which this section does not restate.)

**Read every E8 bound sentence in this file accordingly.** When an E8 run record says "the bound
observed at: worker CPU / event loop / memory / sandbox-pool / admission-control / unattributed", that
verdict is reached by checking only the columns that carry real readings — it is never checked against
`file_op_ms`, because there is nothing there to check. So "unattributed" does **not** mean "no tier is
responsible"; it means "of the tiers we can see, none crossed its threshold." A slow relay round trip
could be the actual cause of a knee in this file and would show up as `unattributed` here,
indistinguishable from a genuinely even, non-bottlenecked run. Do not read `unattributed` as an
exoneration of the relay tier — read it as `unattributed (relay tier unmeasured)`. Every claim sentence
E8 emits should be read with that qualifier whether or not the driver's own prose spells it out at the
point the sentence is written.

Since the arms landed, one verdict is newly available and worth naming: **`bound=worker-cpu`**, fired
from measured `worker_cpu_util` rather than from a ratio of loop-lag readings. It is checked _before_
the loop-lag branch deliberately — measured CPU against the box's cores means what a reader assumes it
means, where a lag ratio is a ratio of two numbers sitting on a sampling floor.

**E9's records do not have the attribution shape above at all — they carry none of E8's
attribution/basis/stub fields, not even as `NaN`.** `e9-tiers.sh` emits one point per rung as
`{c, throughput, p95Ms, attempts, non200, contention_load1}` (`deploy/vm/e9-tiers.sh`'s `run_arm`,
see the `points` assembly near the end of its rung loop) — `attempts` and `non200` (not `ok_n`: E9
records the failure count directly, since its existing non200>0 WARN already worked in those
terms) are carried per-point for the same success-rate-floor auditability as E8's
`attempts`/`ok_n`; `contention_load1` is carried per-point for the same box-level-proxy reason it
is carried in E8's records (see "Where the generator ran" below) — it is not part of the
attribution shape, it is added independently of it. Round 2, item 4c is sharper about what "per
arm" means for it here than the field's own name suggests: `run_arm` calls `load1` with no target,
so both arms' `contention_load1` measure the SAME box (the generator's own, wherever this driver
process runs) — never either arm's own box. Two E9 points from the same run can still show
different `contention_load1` values (each is a fresh read, taken at different times as the two
sequential `run_arm` calls progress), but that difference reflects the generator's box getting
busier or idling over time, not the vm/knative arms being different boxes. The one time `e9-tiers.sh` reads
`$METRICS_BASE/metrics` at all (in its PIN 2
pre-flight check) is to check the VM arm's `.env.ANTHROPIC_BASE_URL` matches the pinned stub, not
to sample any attribution counter — so none of the six real E8 columns, `lease_saturation`, or
`file_op_ms` are sampled, recorded, or NaN'd out for E9; they are simply absent from the JSON.
`conns_per_turn` and
`duty_basis` are still recorded for an E9 run, once in the surrounding run-record prose (§5.2's
other requirement), not per-point in the JSON. Do not read an E9
record's silence on, say, `spurious_429` as "zero refusals were observed and confirmed" — E9
never samples that column, so its absence means "not measured," not "measured and clean." Zero
and absent are opposite claims; only E8 records can make the former.

## Where the generator ran, and how busy the box was (final review fix, part 3, items B2–B4)

The load generator **is** `e8-density.sh`/`e9-tiers.sh` themselves — every `vm_turn` call in the
rung loop originates from wherever the driver process itself is running. Before this item, that
fact was invisible in the record: a run co-located with the supervisor it drives competes with
that supervisor for the same CPU the run is trying to measure, and nothing in the output said so.
Two fields close that gap, and a documentation requirement closes a third.

### `generator_placement` — derived, not declared, once per run per arm

`generator_placement()` (`lib-vm.sh`) classifies a base URL as **on-box** when it is loopback
(`127.0.0.1`, `localhost`, `::1`) and **undetermined** otherwise. This is a derivation, not a flag
someone sets, but only the **on-box** half of it is actually proven: curl can only reach a
loopback address when the caller and the callee share a machine, so the address itself is proof
of on-box, not merely a claim about it. Round 2, item 4a corrected the other half: an earlier
version of this function labelled every non-loopback base **off-box**, on the reasoning that
"this driver could not have reached that base URL without leaving the box." That reasoning does
not hold — a box can also address itself by its own routable interface address (e.g. an E9 VM
arm run with `VM_BASE` set to the VM's own `10.0.0.5` rather than `127.0.0.1` is still on-box),
so a non-loopback base is not proof of anything either way. **`undetermined` is the honest label
for that case** — it costs nothing and claims nothing this driver cannot back up, unlike the
`off-box` label it replaces, which asserted a conclusion the address alone does not establish. A
future resolve-and-compare implementation (matching the base URL's resolved host address against
this machine's own interface addresses) could sharpen `undetermined` into a real `off-box` proof,
but was deliberately not attempted here: doing it unreliably across this repo's Linux production
target and macOS test/dev environment risked introducing a new false-confidence claim of exactly
the kind this item exists to remove. `e8-density.sh` records one `GENERATOR_PLACEMENT` (from
`$BASE`); `e9-tiers.sh` records one per arm (`$VM_BASE`, `$KSVC_URL`), since the same generator
process can be on-box relative to one arm and undetermined relative to the other — a `$VM_BASE`
on loopback is common, a `$KSVC_URL` on loopback essentially never happens (cluster addresses are
not loopback), so the Knative arm's placement is routinely `undetermined`, not proven either way.
Recorded once per run, in the run-summary prose, because placement does not change mid-ladder — a
per-rung field would only repeat the same value.

### `contention_load1` — a proxy, recorded per rung, always for the GENERATOR's own box

Each rung also records `contention_load1`, the 1-minute load average (`uptime`) of the box the
driver PROCESS ITSELF executes on, sampled fresh at the end of that rung — `load1()` (`lib-vm.sh`)
takes no target argument, so this is never a measurement of some other, remote box. This is
**not** scoped to the generator's own curl calls, the supervisor's own process, or any single
tier — it is whatever else is running on the box `load1` is called from, which is exactly the
point for a co-located (`generator_placement: on-box`) run: a co-located generator that drives its
own supervisor's load average up during a high-`c` rung will show it here, so that run cannot
silently masquerade as a clean one just because throughput and the (failure-filtered) `p95` still
look healthy. Label it as a proxy when quoting it, never as a precise attribution — it says "the
box was busy," not "the generator caused it" or "the supervisor caused it." 1-minute load average
was kept as the cheapest honest option available without a new dependency (`uptime` exists on
every platform this repo already targets, Linux and macOS/BSD alike, and needs no counter this
codebase would have to add) rather than argued away in favour of something narrower like a
per-process CPU sample, which would need `/proc` (Linux-only, and this repo's own dev environment
is macOS) or an additional tool.

**Round 2, item 4c: for E9 specifically, "the box `load1` is called from" is the SAME box for
BOTH arms, on every run, with no exception.** An earlier version of this section (and of
`e9-tiers.sh`'s own comment at its `run_arm` call site) claimed `contention_load1` was recorded
"per arm per rung, since the two arms can be on different boxes and can carry different
contention" — that claim does not hold. `e9-tiers.sh` is a single process; every `load1` call it
makes, whether inside the "vm" or the "knative" `run_arm` invocation, reads the 1-minute load
average of that one process's own box, never the VM's box or the Knative pod's box specifically.
For the VM arm this is frequently still a meaningful reading, because a co-located `VM_BASE` run
puts the generator and the VM arm's supervisor on the literal same box (`generator_placement:
on-box` for that arm). For the Knative arm it essentially never is: `KSVC_URL` is a routable
cluster address reached over the network, so this driver's own box contention says nothing about
contention on whichever node the Knative pod actually landed on. Read an E9 record's
`contention_load1` for the "knative" arm as "how busy was the generator's box during this rung",
never as "how busy was the Knative pod's node" — the JSON shape carries the field once per arm's
point, but the underlying measurement is the generator's own box both times. Normalise it against
`core_count()`'s reading (recorded once per run in the run-summary prose — see `e9-tiers.sh`'s
"cores on the generator's own box" line) for the same reason E8's per-run `CORE_COUNT` exists: a
raw load average is not comparable across boxes without knowing how many cores that box has.
Fixing the mechanism itself — sampling the Knative pod's own node, not the generator's — would need
a way to run a command on that node from this driver (an exec into the pod, or a sidecar, or a
metrics-server query), none of which this repository currently wires up; documenting the
limitation, as this paragraph does, is the deliverable for round 2, not a new remote-sampling
mechanism.

### The authoritative run puts the generator off-box, on the same subnet

**An on-box run (`generator_placement: on-box`) is a caveated result, not an equivalent one.**
The authoritative measurement path for both E8 and E9 runs the generator on a separate machine, on
the same subnet as the arm(s) it drives, so the generator's own curl/fork/exec overhead and the
supervisor's/ksvc's own CPU never compete for the same core — B1's `vm_turn` rewrite
(`lib-vm.sh`) already removed the generator's own _process-count_ overhead per turn, but it cannot
remove the fact that an on-box generator still shares a CPU budget with the thing it is measuring.
A run recorded with `generator_placement: on-box` should be read, and cited, with that caveat
attached; it is informative (useful for local iteration, or when no second machine is available)
but is not interchangeable with a genuinely off-box run when the two disagree. Note the asymmetry
introduced by round 2, item 4a: a genuinely off-box run (the authoritative path this section
describes) records `generator_placement: undetermined`, not `off-box` — the code never asserts
`off-box` as a proven label (see the field's own description above), so "this run's generator was
on a separate machine" is established by how the run was actually set up and operated, not by
anything `generator_placement` prints. Only `on-box` is a label the record itself proves.

**If off-box is genuinely impossible, `taskset` (Linux) or an equivalent cpuset/cgroup pin is the
documented fallback** — pin the generator process to CPUs the supervisor's/ksvc's own workers do
not use, so contention becomes bounded and visible (via `contention_load1` above) rather than
silently traded for a faster loopback round trip. This is **not implemented** by either driver:
a correct implementation is not the "genuinely small" case where implementing beats documenting —
it would need to know, per platform and per deployment (systemd unit vs. ad hoc shell, kind vs. a
real VM), which CPUs are already claimed by the supervisor or by Knative's own control-plane pods,
which this repository does not currently expose anywhere a driver could read it, and getting that
wrong (pinning the generator onto a CPU the supervisor also uses) would be worse than not pinning
at all — a false sense of isolation. Documenting the requirement, so a future run configuration
knows to reach for `taskset -c <cpu-list>` or a systemd `CPUAffinity=` setting explicitly, is the
deliverable here.

## Duty bases (spec §2.3) — take a row whole

| Basis     | Workload                                     | Duty          | Implied sessions/sandbox |
| --------- | -------------------------------------------- | ------------- | ------------------------ |
| `e6-ocp`  | real Archetype-A code review (L0/L1/L2), OCP | 0.061–0.079   | 12.6–16.5                |
| `e6-kind` | same workload, kind                          | 0.042–0.051   | 19.7–24.0                |
| `e7`      | `E7_REFS` mixed-ref converge                 | 0.021 / 0.035 | 28.6–47.6                |

`N ≈ 1/duty`. P6 provisions from `e6-ocp`. `experiments/src/basis.ts` throws on a blend, so this
table is enforced rather than merely documented. Sources, cited by line so a future edit to
`deploy/knative/EXPERIMENTS.md` can be checked against these numbers rather than trusted blind:
`e6-ocp` → `deploy/knative/EXPERIMENTS.md:88-94`; `e6-kind` → `deploy/knative/EXPERIMENTS.md:76-80`;
`e7` → `deploy/knative/EXPERIMENTS.md:121,161`. (`deploy/knative/EXPERIMENTS.md` is a different
file from this one — it holds E1/E3/E4/E6/E7 Knative-only results; this file, `deploy/vm/EXPERIMENTS.md`,
holds P6's VM results. Always cite the directory, not just the filename.)

### The workload must cost what the basis assumes — it does not by default

**Read this before quoting a density number against a duty basis.** The table above was measured
against workloads whose git operations cost **~470 ms** on network-attached storage. The stub's tool
call defaults to `ls -la /workspace`, which costs a few milliseconds at most. So a stock run exercises
the hands tier **structurally** — the exec genuinely traverses relay → leaf → container, which is
verifiable by side effect — while it carries almost no load.

Two consequences, both in the optimistic direction:

- The measured duty cycle describes a cheaper workload than the basis it is being compared against,
  so concurrency figures are flattering relative to their own denominator.
- `file_op_p95_ms` stays `NaN` partly because nothing performs file operations, so the relay tier has
  no sensor and no bound can be attributed to it.

`./prepare-workload.sh` closes this. It seeds each sandbox with a deterministic git working copy,
**measures** what a candidate per-turn command actually costs inside the sandbox, and tunes the corpus
size until the cost lands in a band around the basis figure — then prints the `SH_STUB_TOOL_INPUT` to
start the stub with. It measures rather than assumes because the cost is a property of the box's
storage; a hardcoded number would be a fabricated basis of exactly the kind this file's other
conventions exist to refuse. It also verifies **every** sandbox lands in band, not just the one used
to search, since rungs that lease a slower sandbox would carry a different workload from rungs that
lease the others.

Requirements it enforces, each of which was a real failure: every sandbox must exist, must contain
`/workspace` (without it every exec dies on `cd` before running the command), and must have `git` —
the leaf advertises `git` in `cmd/worker/main.go`'s `probed` capability list, so an image lacking it is
advertising falsely, and the workload cannot resemble the basis.

**Record both the file count and the measured cost in the run record.** The stub's `/profile` reports
the tool-call _rate_; it cannot report the tool call's _cost_, so the cost has no other witness, and a
run on different hardware must recalibrate rather than reuse the number.

## Runs

**No live run has been recorded in this file yet.** `e8-density.sh` and `e9-tiers.sh` were
authored and structurally tested (§5.6/§5.7's TDD gates) in an environment with no VM and no
Kubernetes cluster — a macOS development machine cannot host the systemd/podman single-VM
deployment plan 1 sets up, and no such VM or cluster was reachable from the session that wrote
this file. Nothing below this line is a fabricated result: the tables are empty because no run
has happened, not because a run's numbers were omitted.

When a run is recorded, each driver appends its own dated section below this line — `e8-density.sh`
writes a "### E8 run \<timestamp\>" block with a per-rung JSON records array, and `e9-tiers.sh`
writes a "### E9 run \<timestamp\>" block with a VM-vs-Knative floor comparison table — following
exactly the templates already implemented in those two scripts. The empty tables below show the
shape a first run will fill in; they are not a substitute for one.

### E8 — concurrent in-flight turns sustained (floor)

| Run (UTC)         | W (workers) | S (turns/worker) | duty_basis | knee floor | saturated | bound |
| ----------------- | ----------- | ---------------- | ---------- | ---------- | --------- | ----- |
| _(none recorded)_ |             |                  |            |            |           |       |

### E9 — VM-with-supervisor vs Knative-per-session (floors)

| Run (UTC)         | Arm | Sustained in-flight turns (floor) |
| ----------------- | --- | --------------------------------- |
| _(none recorded)_ | —   | —                                 |

### V — real-model live-gate validation (§5.5, informational — not a density result)

`v-live-gate.sh` never appends to this file (by design — see its own header). This section exists
only so a reader looking for "did the VM path ever get validated against a real model" finds an
answer here rather than concluding silently that it was not: as of this writing, no `v-live-gate.sh`
run has been recorded either, for the same reason no E8/E9 run has — no VM was reachable from the
authoring session. A `V_GATE: PASS` line from a real run belongs in whoever's operational log ran
it, not in this results file, but its absence here should not be read as a signal about the VM
path's correctness one way or the other.
