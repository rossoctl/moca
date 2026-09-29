# Pooled VM cgroups — design note for #258

Version: 0.1 — September 22, 2026
Status: **Proposed. §4's open decision is RESOLVED by measurement (2026-09-22); ready to implement.**
Scope: stop creating and destroying one cgroup per microVM. Reuse a small set of long-lived
cgroups instead, to remove what is now the largest single cost in an `Exec`.
Issue: [#258](https://github.com/rossoctl/moca/issues/258). Depends on nothing;
supersedes two measured dead ends recorded there.

## 1. Why: the measurements that point here

`Destroy` is the largest phase of an `Exec`, and its sub-phases say why
([#258 Task 3.1](https://github.com/rossoctl/moca/issues/258)):

| slots | kill | wait  | removeall | cgroupwait | **cgrouprmdir** | total  |
| ----- | ---- | ----- | --------- | ---------- | --------------- | ------ |
| 4     | 0.01 | 33.91 | 1.08      | 0.04       | 2.15            | 37.19  |
| 16    | 0.01 | 48.30 | 1.47      | 0.05       | 15.53           | 65.36  |
| 64    | 0.03 | 55.65 | 1.75      | 0.07       | **195.52**      | 253.02 |

The rmdir grows **91x** across a 16x concurrency range and is 77% of `Destroy` at 64 slots,
because cgroup removal is kernel-serialised. Two cheaper fixes were built, measured and rejected:

- **Deferring the rmdir** to background workers conserves the time into `Acquire` (16 slots:
  -14.76 ms Destroy, +14.41 ms Acquire) and makes 64 slots _worse_ (-79/+101, net +24 ms). The
  bound is the total rate of cgroup operations, not where they sit.
- **Reclaiming charges before rmdir** does stop the dying-cgroup growth (-64/rung vs +64..73) and
  **hung worker startup** -- two ON rungs failed, two OFF rungs passed. It was attributed to ~1.2 s
  of synchronous writeback per VM, but §4's measurement shows a real VM cgroup holds only ~1 MiB, so
  that mechanism does not transfer and the cause is now open. The failure is reproducible; the
  explanation is withdrawn.

There is also a second, compounding problem the same churn causes. `rmdir` does not free a cgroup
while pages are charged to it, so the kernel parks it as _dying_: **12,454 dying descendants under
the VM slice with zero live children**, rising to 13,863 over a later session. Cgroup cost grows
with that population, and the host measured **~24% slower at 64 slots** (232.63 → ~176 Exec/s)
than it had two hours and ~100,000 VM lifecycles earlier, with a clean directory count both times.

So per-VM cgroup churn costs throughput directly _and_ degrades the host over its uptime. Not
creating the cgroups addresses both at once, with no reclaim work: a long-lived cgroup that never
dies cannot accumulate.

## 2. The mechanism that makes this possible

`firecrackerCgroupArgs` already records it:

> `--cgroup memory.max=<bytes>` (D1: **the flag that actually creates the per-VM cgroup at all**;
> `--parent-cgroup` alone only relocates the process into the shared parent).

So passing `--parent-cgroup=<an existing cgroup we own>` and **omitting `--cgroup`** places the
jailed VMM into a cgroup we created, and jailer creates nothing. Nothing else about the jail, the
snapshot, or the workspace changes.

## 3. Design: a free list, not a fixed pool

**Do not size a pool in advance.** There is no slot concept in `vmpool` to size it from:
`nextIDLocked` mints ids from a monotonic counter, and concurrent VM count is bounded by
`admitLocked` — `MaxRuns` (a backstop on concurrent workspace keys) and, really, the memory budget
`MaxCommittedBytes - MemoryReserveBytes` over `PerVMBytes`.

Instead keep a **free list of cgroup directories**:

- acquire: pop a free cgroup, or create one on miss;
- release (in `Destroy`, where the rmdir is today): **check `cgroup.procs` is empty**, then push it
  back. No rmdir, no reclaim.

**The emptiness check is load-bearing** (raised in review). `kill` + `cmd.Wait` reaps the jailer,
but a stray child that escaped the process group would otherwise be handed to the next tenant --
inside its memory bound, and inside a cgroup a later `SweepOrphans` would attribute to whoever is
using it then. If `cgroup.procs` is non-empty: **do not reuse it** -- leak it, log it, and count it.
Leaking one cgroup is the old behaviour; handing a live stranger's process to the next VM is not.

The high-water mark is then exactly the peak concurrent VM count — ~68 at 64 slots — against
~26,000 create/destroy cycles per rung today. Nothing needs to predict it.

Expected effect, stated as arithmetic from the table above rather than as a promise: `Destroy` at 64
slots 253 → ~58 ms (`wait` + `removeall`). `sockwait` should fall too, since jailer's cgroup
creation happens inside it, but by how much is unknown — that is the measurement, not the claim.

## 4. RESOLVED by measurement: reuse and per-VM `memory.max` are compatible

**This section previously claimed they were incompatible and asked for a decision between three
options. That claim was wrong.** Review of #318 asked for the question to be settled by reading
`memory.events` on live `vm-N` cgroups before any code; the measurement contradicts the premise,
so no decision is needed and D1 stays intact.

Sampled during a c=64 rung, 306 samples across 40 distinct live VM cgroups:

| signal                                                          | result                                 |
| --------------------------------------------------------------- | -------------------------------------- |
| `memory.events` `max`                                           | **non-zero in 0 of 306 samples**       |
| `memory.events` `high` / `oom` / `oom_kill`                     | 0 of 306                               |
| `memory.current`                                                | mean **0.9 MiB**, p50 1, max **2 MiB** |
| `memory.stat` `file` / `anon` / `file_dirty` / `file_writeback` | all ~0                                 |
| samples within 8 MiB of the 288 MiB limit                       | **0 of 306**                           |

So a VM's cgroup charges about **1 MiB**, against a `memory.max` of 288 MiB. Two consequences:

1. **The per-VM limit never binds.** My earlier speculation that it might already be forcing
   reclaim of the guest's own working set is **false** — nothing is hit, nothing is reclaimed,
   no OOM. It is a bound that has never come near engaging.
2. **A reused cgroup inherits ~1 MiB, not ~400 MiB.** The "incompatible" argument rested on
   pooled cgroups accumulating the snapshot's page cache. They do not hold it now, so they would
   not hold it after reuse either.

**Why nothing is charged**, which is what makes this a property of the design rather than luck:

- `memfile` (257 MiB) is **mlocked by the worker at startup** — `PinMemoryFile` in
  `cmd/microvm-worker/main.go` — so its pages are charged to the _worker's_ cgroup, not a VM's.
  This is exactly the "pre-read at startup from its own cgroup" the review proposed as a
  precondition for option D; it already exists.
- The snapshot components are **hardlinked** into each jail, not copied, specifically so
  `memfile` stays "a single page-cache object shared across every VM restored from this snapshot"
  (spec §7.3, Task 14). A guest's RAM is a `MAP_SHARED` mapping of pages that are already resident
  and already charged, so faulting them adds no charge to the VM.

**Decision: option D — keep `CgroupMemoryMaxBytes = PerVMBytes` on pooled cgroups.** Reuse needs no
change to the memory bound, D1 is preserved exactly, and neither option A (drop the per-VM ceiling)
nor B (move it to the parent slice) is required. The review's reasoning for A/B was sound given the
premise; the premise did not survive measurement.

The review's check-1 instinct was right and the data goes further than it proposed: shared pages are
charged not merely "once, to one cgroup" but to the **worker**, because of the existing mlock.

### One thing this leaves open

If each VM cgroup holds only ~1 MiB, what pins **12,000-13,000** of them as dying? That is ~12 GiB
of charges in aggregate, which is plausible, but the per-cgroup residue is small enough that the
mechanism is not obvious. This design does not need the answer — pooling stops creating the cgroups,
so nothing accumulates either way — but it is the one loose end, and it also **undermines the stated
mechanism for why the reclaim experiment hung** (see §1): that was attributed to ~1.2 s of writeback
per VM, measured on a synthetic cgroup deliberately charged with 617 MiB of dirty cache. A real VM
cgroup holds ~1 MiB, so that explanation does not transfer. The reclaim flag's _observed_ failure
stands — two ON rungs failed, two OFF rungs passed, reproducibly — but its cause is now unexplained
and recorded as such rather than left as a wrong mechanism.

## 5. Naming, and `SweepOrphans`

`isPoolVMCgroupDirName` is documented as _"the single authority on what a VM's cgroup DIRECTORY is
called"_, and already recognises two forms: `vm-<digits>` (jailer's `--id`, verbatim) and
`sh-vm-<digits>.scope` (Cloud Hypervisor).

**Name pooled cgroups distinctly** — e.g. `pool-<n>` — rather than reusing `vm-<n>`. Jailer's
`--id` must stay monotonic (a live VMM holding a jail id is what the collision guard refuses on),
so a pooled cgroup named `vm-3` would not correspond to VM `vm-3`, and the two namespaces would
silently diverge. Extend `isPoolVMCgroupDirName` for the new form — it is built for exactly this,
and a third case is a small, explicit change.

**`SweepOrphans` still matters, for a different reason.** Today it reclaims cgroup directories a
crashed worker left behind. With pooled cgroups the directories are _expected_ to persist across a
restart; what must not persist is a **dead VMM's process** inside one. So the sweep should still
kill members of `pool-<n>` cgroups at startup, and may then either remove them or leave them for
reuse — leaving them is simpler and loses nothing, since the next start will use them.

This is worth stating explicitly because it inverts the current invariant: a `vm-N` cgroup at
startup is an orphan to be removed, whereas a `pool-N` cgroup at startup is normal.

## 6. What this does not change

- The jail, `--id` minting, and the id-collision guard: untouched.
- `execGate` and the workspace-mount correctness constraint (spec §4.3): untouched. This changes
  only where the VMM's cgroup comes from.
- `Destroy`'s `kill` and `cmd.Wait`: untouched, and they remain the floor at ~34 ms — a SIGKILLed
  Firecracker holding a 256 MiB `MAP_SHARED` mapping must have that address space torn down before
  it is reaped. This change does not approach that.
- The Cloud Hypervisor arm, whose cgroup is a systemd transient scope. Out of scope here; see
  [#316](https://github.com/rossoctl/moca/issues/316) for the other CHV question.

## 7. How it would be verified

1. Unit: a cgroup is reused rather than recreated (free list depth, and no rmdir on `Destroy`);
   `SweepOrphans` kills members of a `pool-<n>` cgroup and tolerates its continued existence.
2. On metal, c=64, 400 iters/slot, `SH_DIAG_PHASES=1`, cgroups cleared and `nr_dying_descendants`
   recorded per rung: `cgrouprmdir_us` → 0, `Destroy` → ~58 ms, and
   **`nr_dying_descendants` must stop growing** — that is the second half of the win and the one
   that makes future measurements stable.
3. A repeat of the cheapest rung LAST in the session. If the host no longer degrades over a
   session, the accumulation is genuinely gone rather than merely slowed.
4. Then re-run the full slot sweep descending, and see whether the knee that vanished at 64 slots
   reappears anywhere below the CPU ceiling (35% at 64 slots today).
