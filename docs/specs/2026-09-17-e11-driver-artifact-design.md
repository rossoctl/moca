# E11 density: repairing the instrument (issue #291)

Date: 2026-09-17
Issue: [rossoctl/moca#291](https://github.com/rossoctl/moca/issues/291)
Status: approved for implementation

## Problem

`deploy/microvm/e11-density.sh` reports a concurrency knee at `c=8` on both the microVM
arm and the container baseline, with nearly identical curve shape. `EXPERIMENTS.md` §E11
concludes from this that the bound is _replenishment_ on both arms and that "nothing
resembling a CPU or memory ceiling was reached."

Two structurally different backends saturating at the same `c` with the same shape is the
tell. Issue #291 identifies three mechanical defects in the driver, each affecting both
arms identically by construction (`run_density_rung` is invoked the same way for both, per
its own comment at `e11-density.sh:872-875`), and any of which is sufficient to produce the
observed shape with no contribution from the backend:

1. **Host resource signals are sampled on an idle host.** `host_signals_snapshot` is called
   at line 1051 — after every slot subshell has exited (lines 957-959) and after the
   throughput window closed (line 962). `host_cpu_fraction 1` then _sleeps one second_ and
   diffs `/proc/stat` across that window, so `hostCpuFraction`, `memAvailableBytes` and
   `pssBytes` all describe a quiesced machine.

   The recorded values contain their own falsification: `hostCpuFraction` of `0.0006` on a
   72-cpu host is 0.043 cores busy, while the same rung sustained ~41 Exec/sec at ~9
   process spawns each — on the order of 370 process creations per second. That cannot
   happen on 4% of one core.

2. **~9 process spawns per Exec, two of them Python interpreters, inside the timed window.**
   `grpc_exec_record` (lines 586-615) runs `mktemp`, `date`, `json_escape` ×2, `grpcurl`,
   `date`, `rm`, plus `wc -l` ×2 in the caller's loop guard. `json_escape` is
   `python3 -c ...` (line 536), and `t0` is stamped at line 590 _before_ the compound whose
   argument list contains both command substitutions — so both interpreter startups fall
   inside the measured latency. At `c=64` that is ~64 slots × ~9 spawns continuously.

3. **Converge sits in the throughput denominator.** `wall_t0` is stamped at line 901, each
   slot runs `converge_slot` at line 927 inside the timed window, and `wall_t1` closes at
   line 962. The header's claim that converge is separated "so a slow fetch cannot misread
   as a throughput ceiling" (lines 51-56) only ever applied to p50/p95, never to throughput.

### Additional finding, beyond the issue

`hostCpuFraction` is consumed by `crosses('cpu')` in `experiments/src/microvm-density.ts:126`
as `cur.hostCpuFraction >= CPU_SATURATION_FRACTION` where the constant is `0.9`. A
post-load `0.0006` does not merely weaken the CPU claim — it makes the `cpu` bound
**structurally unable to fire at any rung**. `EXPERIMENTS.md`'s "no CPU ceiling was
reached" is therefore not a finding but a restatement of the sampling bug.

## Non-goals

- **Item 3 of the issue (a persistent-connection Go client) is deferred.** The control arm
  added here measures how much per-Exec cost `grpcurl` still contributes, and that number
  decides whether item 3 is needed before an authoritative metal run. Committing to it now
  would be a guess.
- **Item 5 (relay instrumentation) is deferred** for the same reason: the relay is the
  leading candidate for the _next_ bottleneck, which is only worth instrumenting once the
  driver has stopped being one.
- **`e10-lifecycle.sh` is not changed.** Its `json_escape` is inside its timed window too,
  but rung 1 is sequential — no fork storm, no concurrency artifact. Fixing it would move
  the 41 ms container baseline that every §7.2 ratio is priced against, which is a separate
  decision with its own write-up consequences.
- **The driver stays closed-loop.** `drivingModel="closed-loop-per-slot"` and its declared
  coordinated-omission bias are unchanged. An open-loop rate-based driver becomes cheap
  only if item 3 is built; in bash it is not.
- **The driver stays co-resident with the relay, worker and VMMs.** Moving the load
  generator to a second host would decouple driver cost from the thing under test, but
  needs a second machine and adds a network hop to every sample. Recorded, not fixed.
- **`deploy/microvm/predictions.json` is not touched.** It is SHA-256 pinned and enforced
  by `pnpm -C experiments exec vitest run microvm-predictions`, sealed so that predictions
  cannot be adjusted to fit results. Re-scoring happens by producing better rung records
  for the existing scorer.

## Design

### 1. Payload construction leaves the timed window

Per-Exec spawns go from 9 to 1. Everything except `grpcurl` itself is removable without
changing what is measured:

| current spawn                | replacement                                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json_escape` ×2 (`python3`) | pre-escape the 7 mix commands and the slot's `workspace_key` once per slot, before timing starts; build the payload in-loop by pure bash interpolation. `req_id` is a number and needs no escaping. |
| `date +%s%N` ×2              | `$EPOCHREALTIME`, a shell variable. Resolution drops from ns to µs, which is immaterial for millisecond latencies.                                                                                  |
| `mktemp` + `rm`              | one fixed `err_log` path per slot; `2>"$err_log"` truncates on each call anyway.                                                                                                                    |
| `wc -l` ×2                   | a shell counter. The timed loop is the file's only writer.                                                                                                                                          |

`grpcurl` remains, and with it its per-call proto re-parse and fresh connection. That
residue is what §4's control arm exists to quantify.

`LC_ALL=C` is pinned for the driver: `EPOCHREALTIME` renders with the locale's decimal
separator, so under e.g. `LC_NUMERIC=de_DE` it yields `1789672470,123935` and the
arithmetic silently breaks.

### 2. Host signals are sampled during the timed window

A background sampler brackets exactly `wall_t0`..`wall_t1`, appending one line per tick to
a per-rung file. It is reaped before aggregation; mean, peak, min and sample count are
computed from the file.

**The sampler must not become the next artifact.** Reading 128 `smaps_rollup` files per
second while measuring a density ceiling perturbs the thing under test. Two cadences:

- **Every tick (1 Hz default), zero subprocesses.** CPU comes from a bash builtin `read`
  of `/proc/stat`, keeping the previous reading and diffing against it — so there is no
  `sleep`-inside-a-sample and no `awk` per tick. MemAvailable likewise from a builtin
  `read` loop over `/proc/meminfo`.
- **Every Nth tick (default 5), with subprocesses.** `pssBytes` and `processCount` need
  `pgrep` plus an N-file walk. This is defensible because `crosses('memory')` reads
  `memAvailableBytes`, not `pssBytes` — PSS feeds the narrative, not the bound
  classification, so it does not need 1 Hz. The reduced cadence is recorded in
  `proxyLimitations` and its own sample count is written to the record.

The existing post-load snapshot is **kept**, under explicitly different field names, so an
idle reading can never again pass as an under-load one.

#### Which statistic is scored

`hostCpuFraction` — the field `classifyBound` already reads — becomes the **mean** over the
timed window. Peak, min and sample count go to new sibling fields.

The reason is narrower than "mean is more representative". `scorePrediction1`
(`microvm-density.ts:180-192`) computes:

```
cpuAt       = firstCrossing('cpu')            // hostCpuFraction >= 0.9
memOrProcAt = min(firstCrossing('memory'), firstCrossing('process-count'))
verdict     = memOrProcAt <= cpuAt ? 'supported' : 'falsified'
```

With today's idle samples both are `Infinity` and the verdict is `inconclusive`. If CPU
crosses 0.9 anywhere while memory and process-count never do, `memOrProcAt <= cpuAt` is
false and sealed prediction 1 flips straight to **falsified**. Scoring that off a single
one-second peak — a GC pause, a `drop_caches`, an unrelated process on a shared box —
would be the same class of error as the artifact being fixed, pointed the other way. The
mean matches what `crosses('cpu')` asserts: _this rung was CPU-saturated_, not _this rung
once touched saturation_.

Nothing is lost, because peak is still recorded. "Mean 0.41, peak 0.97" is a legible
result a human can act on; it just does not get to silently rescore a seal.

### 3. A converge barrier precedes the timed window

`run_density_rung` splits into two phases.

**Phase 1** spawns `c` subshells that each converge and exit. All are waited on; a
non-zero exit still refuses the rung, preserving the existing guarantee that a rung whose
slots were not all measuring the same thing is never recorded.

**Phase 2** stamps `wall_t0`, starts the sampler, and spawns `c` subshells running only
the timed Exec loop.

Each slot's `run_id`, `workspace_key` and `req_base` are deterministic in
`(arm, d, ram_mb, c, i)`, so phase 2 recomputes the same values and lands on the workspace
phase 1 prepared. `req_id` spaces stay disjoint per slot, and phase 1 drains fully before
phase 2 issues anything, so the req_id collision documented at length in `run_density_rung`
cannot recur across the barrier.

This interlocks with §2: if the sampled window still contained converge, the git fetch's
CPU would land in the Exec window's mean and a fresh artifact would have been built.

### 4. A driver-overhead control arm

`remote-worker/cmd/null-responder/main.go`, roughly 40 lines against the existing
`gen/go/sandbox/v1` stubs (no new codegen): serve `SandboxExec`, where `Exec` sends one
`End{req_id, exit_code: 0}` and returns, and `Abort` returns an empty response. Loopback
only.

A third arm, `driver-control`, drives the identical `run_density_rung` against it with no
relay, no Redis and no worker — so `start_null_stack` is just that binary. It follows the
container path (`require_vmm=0`, no standby-residency poll, swept dimensions recorded as
`null`). Converge hits the responder too, which is correct: the control measures the
driver's cost for both phases.

It runs **by default** (`SH_E11_ARMS="container microvm driver-control"`, opt-out). The
control whose absence let this artifact through should not be opt-in. `analyze_slice` is
skipped for it, since a ladder with no cold acquires is not what `analyzeLadder` scores.

Subtracting the control arm at each `c` gives the driver's own contribution, which is the
number open question 1 needs: if it is a large share of observed latency at high `c`, a
fixed-but-still-`grpcurl` driver would show a knee that is _still_ an artifact, and item 3
is required before the authoritative run.

### 5. Record schema

Added to each rung record:

| field                                                                                              | meaning                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hostCpuFractionPeak`, `hostCpuFractionMin`                                                        | extremes over the timed window                                                                                                                                           |
| `hostCpuSamples`                                                                                   | tick count. Exposes thin rungs — a fast `c=1` rung may yield only 2-3 samples, and a mean of 2 samples deserves a visible caveat.                                        |
| `coresBusy`                                                                                        | mean × nproc. `0.043 cores` is far more legible than `0.0006`.                                                                                                           |
| `pssSamples`, `processCountSamples`                                                                | low-cadence sample counts from §2                                                                                                                                        |
| `pssBytesPeak`, `processCountPeak`                                                                 | extremes for the low-cadence signals                                                                                                                                     |
| `postLoadHostCpuFraction`, `postLoadMemAvailableBytes`, `postLoadPssBytes`, `postLoadProcessCount` | the retained post-load snapshot, explicitly named                                                                                                                        |
| `samplingMode`                                                                                     | `"in-rung-1hz-mean"`. Old and new records both carry `hostCpuFraction` meaning different things; without a marker someone compares them later and is misled by this fix. |

`hostCpuFraction`, `memAvailableBytes`, `pssBytes` and `processCount` keep their names and
their place in the `RungSample` contract, but now carry under-load values. `RungSample` in
`experiments/src/microvm-density.ts` gains doc comments recording that, and optional
declarations for the new fields; no scorer logic changes.

`proxyLimitations` gains an entry for the PSS/processCount cadence.

## Testing

Tests are added to `deploy/microvm/tests/e11-density.test.sh` using its existing
`extract_fn` idiom, which greps the function out of the real script text and sources it in
isolation — so they drive the real artifact, never a rewritten substitute.

- Sampler arithmetic: mean, peak, min and count over a fixed synthetic sample file.
- CPU diff correctness against two hand-written `/proc/stat` snapshots. `SH_E11_PROC_ROOT`
  already exists for exactly this kind of faking.
- MemAvailable parsing from a fake `/proc/meminfo`.
- Payload construction: byte-identical JSON to what `json_escape` produced, including a
  command containing double quotes and a backslash. This is the correctness risk in §1.
- The barrier: a converge failure in phase 1 still refuses the rung.
- Spawn-count assertion: the timed loop body contains no `json_escape`, `date`, `mktemp` or
  `wc`. This is the regression that would silently undo §1, and it is the kind of thing
  that rots without a test.
- The `driver-control` arm records a rung with `null` swept dimensions and does not trip
  the microvm arm's `require_vmm` refusal.

### What cannot be verified here

A real sweep needs `/dev/kvm`, Docker, `grpcurl` and real worker binaries. The instrument
will not have been executed since these changes. That will be stated plainly in the PR
rather than implied away — E10's first real execution found three defects and a fourth at
full `ITERS`, and E11 is the larger driver, so an unexecuted fix is a known risk, not a
clean bill of health.

## Documentation

`deploy/microvm/EXPERIMENTS.md` §E11 gets a dated caveat marking the "bound is
replenishment on both arms" claim, the "no CPU or memory ceiling was reached" claim, and
the knee position as under repair, pointing at #291. Sealed prediction 3's SUPPORTED score
is flagged as derived from `coldAcquireRate`'s shape and pending re-examination.

The numbers **stay**. They are the record of what the broken instrument produced, and the
re-run is defined by comparison against them.

## Expected outcomes, stated in advance

The falsifiable question for the eventual re-run: **does the knee stay at `c=8`?** If it
moves or vanishes, the published E11 conclusion is an artifact and needs retraction. If it
holds with real under-load CPU data behind it, the conclusion was right and only its
evidence was wrong.

Two outcomes of _this_ work that are not failures of it:

- **The control arm may show the driver still dominates.** Then the re-run still cannot
  separate backend from driver, and item 3 becomes mandatory. That is the control doing its
  job.
- **`analyzeLadder` may now reach `falsified` where it read `inconclusive`.** Real CPU data
  can cross 0.9. No scorer logic changes; the verdict it produces can.
