# E8 two-arm re-run on hardware — 2026-09-15

Same rig as the 2026-09-14 runs (target `c6i.2xlarge` 8 vCPU / 16 GiB, generator `c6i.xlarge` 4 vCPU,
off-box, us-east-1d), with the amended driver and the new telemetry deployed. Every number below was
measured. Four runs: realism at W=4, capacity at W=4 (twice, the second after an attribution fix), and
capacity at W=8.

## 1. Three instrument corrections, confirmed on the rig

| Correction                  | Before                                              | After                                                                                   |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Loop-lag resolution floor   | idle workers read **11.12 ms** at load average 0.00 | same workers read **1.07 ms** idle, **1.70 ms** under load, **20.5 ms** at the top rung |
| Target vs generator cores   | one figure, the generator's 4                       | driver prints both: generator 4, **target 8** (from the supervisor itself)              |
| Sandbox CPU as a percentage | differenced instantaneous percent                   | cumulative `{{.CPUNano}}`: 372.09 s → 393.46 s across one ladder                        |

The lag correction is the decisive one. At the shipped resolution the metric could not distinguish an
idle tier from a loaded one; it now moves 1.07 → 20.5 ms across a ladder, an 11× range that was
previously compressed into "11-ish milliseconds" at every rung of every published run.

## 2. Realism arm — reproduces the published run, and now attributes it

`E8_RESULT arm=realism knee_floor=32 saturated=no bound=not-observed` (W=4, S=8, duty 0.0735)

| c   | ok/att  | p50 ms | p95 ms | turns/s | wcpu ms/turn | worker util % | sandbox util % |
| --- | ------- | ------ | ------ | ------- | ------------ | ------------- | -------------- |
| 1   | 30/30   | 1523   | 1533   | 0.652   | 90.7         | 0.7           | 2.6            |
| 8   | 240/240 | 1523   | 1970   | 5.036   | 31.5         | 2.0           | 20.4           |
| 16  | 480/480 | 1525   | 1977   | 9.770   | 29.7         | 3.6           | 40.6           |
| 32  | 960/960 | 1535   | 2454   | 16.651  | 29.6         | **6.2**       | **75.6**       |

Same verdict and shape as 2026-09-14 (p95 1533 → 2454 against 1546 → 2457), so the driver changes did
not move the deployable number.

**The free check, finally performed.** That run _predicted_ 78% sandbox utilisation at c=32 from
`32 × 0.0735 = 2.35` of 3 containers. Measured independently from cumulative container CPU: **75.6%**.
The duty arithmetic holds. And the worker tier ran at **0.7–6.2%** across the whole ladder — the number
published as a VM density result was taken with the harness tier at under a fifteenth of the box.

## 3. Capacity arm — and a duty-model error worth provisioning around

Fast stub (10 ms / 1 ms), trivial exec, **measured duty 0.0098**, exactly **1.0 execs per turn**
(counted). Caps cleared the c=128 top rung by 2× before the ladder was allowed to run.

**The ceiling refused the first attempt at c=32**: 28.6% measured sandbox utilisation against the 25%
limit, with only 3 containers. Duty predicted `0.0098 × 32 = 0.31` of 3 ≈ 10%. The gap is per-exec
**plumbing**: **3.8 ms of container CPU per exec against a 1 ms command**. Duty prices the command, so

> **`K ≥ ceil(W × S × duty)` under-provisions the sandbox tier for fast workloads**, by roughly the
> ratio of plumbing to command cost — negligible at the realism arm's 113 ms exec, a factor of ~4 at 1 ms.

Scaled to 16 containers (utilisation at c=32 fell 28.6% → 5.5%) and re-ran:

| c         | turns/s | host CPU % | worker tier % (of 8) | sandbox % | p95 ms | lag p99 |
| --------- | ------- | ---------- | -------------------- | --------- | ------ | ------- |
| 16        | 122.7   | 48.5       | 32.8                 | 3.1       | —      | —       |
| 32 (knee) | 205.6   | 66.5       | 47.4                 | 5.5       | ~190   | ~4      |
| 64        | 291.8   | 89.6       | 62.5                 | 8.5       | 279    | 5.1     |
| 128       | 350.4   | **95.1**   | 62.1                 | 11.2      | 574    | 20.5    |

`E8_RESULT arm=capacity knee_floor=32 saturated=yes bound=host-cpu` — the first run on this rig ever to
find a knee. **~350–400 turns/s** against the realism arm's 16.7 at the same rung: 21× more once the
stub's sleep and the sandbox cost are removed.

## 4. The prediction that failed, and what it changed

Having seen W=4 saturate at 102% of four cores, the obvious explanation was per-worker event loops: each
Node worker is one loop and cannot exceed one core, so W=4 caps at 4 cores. That predicts **W=8 should
roughly double the ceiling**. It was tested:

|       | W=4           | W=8           |
| ----- | ------------- | ------------- |
| c=64  | 317.0 turns/s | 303.0 turns/s |
| c=128 | 395.3 turns/s | 371.4 turns/s |

**Doubling the workers changed the ceiling by −6%.** The explanation was wrong. `top` on the target
during the same rung showed the answer: **0.9% idle** — 74.6% user, 21.2% system, 3.3% softirq. The
machine was already full, and the worker processes were only about two thirds of it; the rest was the
supervisor hand-off loop, the relay, Redis, the stub, sixteen sandbox leaves, and the kernel handling
400 connections a second.

That is why the driver now measures **whole-host non-idle CPU** and attributes to it ahead of any tier.
Without it the run reported `bound=unattributed` for the most basic bound there is, and the natural
reading of the worker-tier figure ("52% — half the box spare") pointed at a lever that measurably does
nothing.

**Provisioning consequence:** on this host class the harness saturates the box at roughly 350–400
turns/s with a ~100 ms turn, and about a third of that CPU is not the workers. Sizing from worker CPU
alone will overestimate headroom by ~1.5×.

## 5. What is still not known

- **The harness tier's own ceiling.** Every capacity figure here is bounded by the host, not by the
  harness: at 95% host CPU the answer is "this box", and a larger instance would move it. The number to
  quote is a floor.
- **Whether the generator contributed.** Its `load1` peaked at 1.05 of 4 cores, but that is a 1-minute
  average over a ~10-second rung, so it understates. One `curl` process per turn at 350/s is not free;
  a non-forking load generator would settle it.
- **Soak.** The longest run here was ~2 minutes. The published record's caveat stands: no run has
  demonstrated stability over hours, and the Redis-connection defect that once killed all four workers
  needed ~13 minutes to appear.
- `file_op_p95_ms` remains `NaN`; the relay tier is unattributed, not exonerated — though it is now
  visibly _inside_ the host-CPU figure that bound this run.

## 6. Rig state as left

- Supervisor restored to the realism baseline: **W=4, S=8, `KAGENTI_SANDBOX_CAP=13`**, one
  `SH_WORKERS` line (the W=8 edit had left a duplicate).
- **16 sandbox containers left running** (was 3), all registered, workspaces seeded. Deliberate: the
  realism floor needs 3, a larger pool makes the tier less likely to be a confound, and tearing them
  down would discard the seeded repos.
- Ephemeral SSH key removed from both hosts; both security groups restored to `129.41.87.1/32` only.
- Helper hooks left on the generator for the next run: `~/sandbox-cpu.sh`, `~/host-cpu.sh`,
  `~/summarise.sh`. Pre-deploy backups of every replaced file are in `/tmp/p6-predeploy-backup` on each
  host (`/tmp`, so they do not survive a reboot).
- Both instances still **running** — ~$0.51/hour on-demand.
