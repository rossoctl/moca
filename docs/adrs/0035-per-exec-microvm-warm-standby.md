# ADR-0035: The sandbox isolation boundary becomes a per-`Exec` microVM, made affordable by warm standby rather than by a faster restore

- **Status:** Proposed
- **Date:** 2026-09-09
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-09-p4-microvm-sandbox-design.md`](../specs/2026-09-09-p4-microvm-sandbox-design.md)

## Context

The sandbox tier's isolation boundary is a container: `remote-worker` runs every command it receives in
a local `bash -c` (`remote-worker/DESIGN.md:1-5`). Agent-authored code — the output of a model that repo
content, tool output or the task itself may have prompt-injected — executes behind namespaces and
seccomp. [P4](https://github.com/rossoctl/moca/issues/57) has always been the slice that
changes this, and [P6](../specs/2026-09-08-p6-vm-process-manager-design.md) §8 explicitly defers
Firecracker/gVisor/Kata to it.

**P4's own stated blocker has expired.** At `45a218d`, `docs/specs/README.md:84` **recorded** it as
"infra-gated … **no nested KVM on the m6i cluster**" — pinned, because the slice this ADR records rewrites
that row. AWS
[enabled nested virtualization on virtual EC2 instances in February 2026](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual/)
(C8i/M8i/R8i, all commercial regions), and P6 establishes a non-Kubernetes VM substrate where a
bare-metal host needs no cluster. So the gate is now a cheap nested instance for iteration plus a
`*.metal` run for the authoritative number.

Three facts from the tree decide the shape. First, **the wire contract already fits**: the worker dials
out, holds one `Attach` stream, receives `ServerFrame{Exec}`, and answers with `Chunk` then
`End`/`ExecError`, with `Abort` and `timeout_s` both meaning "kill it" — so replacing the `bash -c` body
needs no new `SandboxTransport` and owes no new entry in the conformance battery
(`packages/k8s-sandbox/src/transport.ts:57-73`). Second, **the isolation actually missing today is
concrete, not theoretical**: `paths.ts`'s `mapPath` returns paths outside the head cwd _unchanged_ ("mirrors
the SSH example's naive prefix replace"), `config.ts:26` gives every run one process-wide `/workspace`,
one sandbox is leased to 12–24 runs, and `SANDBOX_TOKEN` is read from the environment
(`remote-worker/cmd/worker/main.go:95`) and so sits in `/proc/<pid>/environ` — composing into a
cross-tenant read of a sibling run's workspace _and_ of the relay bearer token. Third, **Firecracker has
no virtio-fs** ([urunc's VMM matrix](https://urunc.io/hypervisor-support/)); block devices are its only
host-sharing mechanism, which is why Cloud Hypervisor is in scope at all.

Firecracker's [snapshot documentation](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
supplies the rest, and two entries are load-bearing: **listening vsock sockets survive restore** (so a
guest agent parked in `accept()` is documented behaviour rather than a trick), and **resuming one
snapshot more than once is documented as insecure** because IDs, RNG seeds and tokens are duplicated —
VMGenID reseeds the kernel PRNG on Linux ≥ 5.18, but non-kernel state is replicated regardless.

## Decision

We will make the sandbox isolation boundary **one ephemeral microVM per `Exec`** — created for that
command, destroyed after it, never reused — served by a new `microvm-worker` binary speaking the
existing `Attach` contract, with lifecycle in a new `remote-worker/internal/vmpool` package. We will
**measure** what one host sustains (E10 lifecycle primitives, E11 density and the replenishment
ceiling).

**Warm standby is the load-bearing choice.** Replenishment costs ~10–25ms, which cannot sit inside a
15ms request. It does not have to: within one leaf run, `Exec`s are separated by model round trips of
hundreds of milliseconds. So `vmpool` holds **D standby VMs per active run**, restored and _paused_
(zero CPU), and the request path is only `pop → vsock write → run → SIGKILL → (async) replenish`. **The
`<15ms` target is met by relocating VM creation, not by making restore faster**, and the design's real
constraint becomes replenishment throughput — which is what E11 measures and nothing else. D defaults to
2 because `createPodEditOps` composes read + write (`operations.ts:78-79`), so one tool call can be two
back-to-back `Exec`s with no model in between.

**Uniform, not split.** Every `Exec` enters a microVM, including the five fixed-verb file-op families,
even though `Exec.streaming` (`sandbox.proto:54`) already classifies them and routing only
`streaming=true` into VMs would cut churn by roughly the file-op:bash ratio. Splitting keeps two
execution substrates forever, cannot delete the container tier that uniform makes redundant, and would
put agent-influenced execution inside the **privileged** process. It stays available as a one-line
branch if E11's churn numbers demand it.

**One additive wire change, for correctness.** `ExecRequest` gains `workspace_key`, populated from the
lease's run id. Leases are keyed by run id (`sandbox-lease.ts:3`) and nothing on the wire carries it, so
without this field consecutive leaseholders of one `sandbox_id` inherit the previous run's workspace —
today's leak exactly. Preserving a "zero harness change" headline here would be buying a talking point
with a security bug.

**The VMM stays a seam that E10 prices, but the constraint is correctness, not latency.** ext4 is not a
shared-disk filesystem, so pre-mounting a per-run block image in D standbys corrupts it with _zero_
concurrent `Exec`s. The Firecracker arm is therefore measurable only with **mount-at-acquire** (mount on
the hot path, `Exec`s serialized per run). Cloud Hypervisor + virtio-fs has neither problem — but it
makes `virtiofsd` the host-side path resolver and therefore the confinement boundary for the whole
design, which is a real cost on the other side of the ledger.

**Lifecycle is a library with a CLI** (`vmpoolctl`), not a function inside the worker, so E10 measures
the production code path with no relay, harness or protocol in it.

**We claim a boundary change and a density number, not an unbreakable boundary.** The claim is that
agent-influenced execution moved from namespaces+seccomp to KVM at per-call granularity — not that KVM
cannot be escaped.

## Alternatives considered

- **Per-session (or per-run) resident microVM** — conventional, cheaper to build, and it re-creates
  precisely the property this slice removes: state, and any compromise, persisting across a run's tool
  calls. Per-call teardown also reclaims guest memory immediately, which is what makes the density
  arithmetic work. Retained as the fallback if E10 shows the warm hot path ≥ 15ms on metal.
- **Per-session VM snapshot-suspended between turns** — attractive for density, but a snapshot captures
  guest FS metadata cache, so restoring it repeatedly against a workspace later `Exec`s have mutated is
  unsound. Would force a mount per resume anyway.
- **Restore on the request path** (the pattern the sub-15ms literature describes) — needs ~10–25ms
  inside a 15ms budget, and it charges every `Exec` for a VMM spawn plus a `virtiofsd` spawn plus a
  restore. Warm standby is the same work at a better time.
- **Splitting at `Exec.streaming`, file ops on the container path** — cuts churn by ~the file-op:bash
  ratio, and rejected above: two substrates forever, no container tier deleted, and agent-influenced
  commands running inside the privileged process. Kept as a priced one-line fallback.
- **File ops as confined host syscalls, only agent-authored code in a VM** — faster file ops _and_
  stronger `bash` isolation, but it trades a real container boundary for a hand-written path-confinement
  routine where a bug is host compromise. Wrong direction for a slice whose point is stronger isolation.
- **Modifying `remote-worker` behind a flag** instead of a sibling binary — one less binary, but the
  container arm could then regress, and E11's A/B stops being an image swap.
- **A fourth `SandboxTransport` dialing the VM directly** — saves the relay hop and owes a
  conformance-battery entry with its own declared truncation mechanism, for a hop that both E11 arms pay
  identically anyway.
- **Hyperlight** — quoted at "<5ms" in the same comparisons as Firecracker, but it has no guest kernel
  and cannot run `bash -c`. Disqualified by the workload, not by performance.
- **macOS / libkrun for local parity** — Hypervisor.framework has no snapshot-restore equivalent, so the
  quoted 7–12ms is cold boot with ballooning, not resume. A Mac cannot produce this measurement.
- **gVisor or Kata arms alongside** — P4's registry row lists them; adding a second isolation technology
  before the first has a number produces two half-measured arms.

## Consequences

- Positive: the harness is unchanged apart from **one additive proto field** — no new transport, no new
  seam, and everything above `select-sandbox` untouched.
- Positive: `remote-worker` is untouched, so the container arm **cannot regress** structurally rather
  than by test, and E11's A/B is an image swap — P6 §5.3's constant-everything-else discipline one tier
  down.
- Positive: §2.3's cross-tenant reads — sibling workspaces and the relay token in `/proc` — are closed on
  this path, and the cross-run-bleed test is what proves it.
- Positive: the guest gets the persistent fast channel [#245](https://github.com/rossoctl/moca/issues/245)
  wants (a parked `bash`), and safely, because a VM serves exactly one command in its life — the
  multi-tenancy problem that makes it delicate on the container path does not exist.
- Negative / accepted cost: **`microvm-worker` is privileged** (`/dev/kvm`, spawning VMMs) where
  `remote-worker` is not. Tolerable only because nothing agent-influenced executes outside a VM, which
  is a property the tests must pin rather than assume.
- Negative / accepted cost: with virtio-fs, **`virtiofsd` becomes the confinement boundary** for the
  whole design, since it resolves guest paths on the host. It must run unprivileged and sandboxed, and a
  compromise there is host-level.
- Negative / accepted cost: **D standby VMs per active run** are held for the run's whole duration,
  including the gaps where it is parked on the model — D × 2 processes on Cloud Hypervisor, D × 1 on
  Firecracker — **plus a tail after the run's last `Exec`**, since the worker never sees lease release and
  reclamation is therefore driven by idle thresholds, swept on every `Exec` **and** on a ticker — because
  the run needing reclamation is the one issuing no requests, so the tier-above "swept by the next acquire"
  discipline supplies the shape but not the trigger. `ReplenishDelay` narrows the tail but cannot close it:
  a dispatch's last wire event is `cleanupWorkspace`, which `vmpool` cannot distinguish from work, so it
  pops a standby and triggers a refill for a run that is over (spec §4.4). ~15 GiB at the stated defaults.
- Negative / accepted cost: **two idle thresholds, not one** — `StandbyIdle` (90s) drops paused VMs,
  `WorkspaceIdle` (30m, interim) removes the workspace. They are the **mechanism**, not a backstop: "is the
  run finished?" is unanswerable when a session may sit on a human gate indefinitely, and the harness's own
  `cleanupWorkspace` is an in-guest `Exec` that cannot reach the host directory, so nothing else ever
  deletes one. Safe to fire early nonetheless, because the tree is a detached worktree at a pinned commit
  and continuity lives in the Redis session log — re-deriving costs a fetch, never data. A `Release` frame
  would remove both the standby tail and the retained trees; deferred as a second wire change with a stated
  trigger (spec §9).
- Follow-up owed, found while specifying the above: **the per-run workspace defeats converge's repo
  cache.** `/workspace/repo` is shared across leaves on a pooled pod today; inside a per-run mount every run
  pays a full fetch. Three candidate shapes and the requirement to time converge separately are recorded in
  spec §4.5 — undecided, because the choice wants E10's numbers, and it also sets `WorkspaceIdle`, since
  retained workspaces hold whatever that choice leaves in them.
- Negative / accepted cost: **`microvm-worker` refuses an empty `workspace_key`** (spec §3.4), so the
  additive-field compatibility pin covers the container arm only. Without the refusal, one empty string
  would collapse every run into one workspace directory and one standby pool while the cross-run-bleed test
  still passed. Consequence: **`/turn` cannot use the VM tier this slice** — it never leases, so it has no
  run id to send.
- Negative / accepted cost: **one golden snapshot per sandbox image**, each `mlock`ed by `vmtouch -dl`,
  so the warm image set is bounded by `Σ(memfile)` in RAM rather than by VM count.
- Negative / accepted cost: we knowingly resume one snapshot many times, which Firecracker documents as
  insecure. Mitigated by the invariant that **nothing secret or unique exists in the golden snapshot**,
  plus a guest kernel ≥ 5.18 so VMGenID actually reseeds — both testable, and tested.
- Negative / accepted cost: **swap must be off** and `mlock` is in play, so memory pressure does not
  degrade gracefully. Admission is gated on a computed memory budget with a per-VM `memory.max`, because
  the alternative is letting the OOM killer choose between an in-flight VM, the worker, and a co-located
  Redis.
- Negative / accepted cost: the headline number depends on a **stub model tier** (P6 §5.4), so it is a
  statement about sandbox-tier capacity at a stated profile. An `MV_LIVE=1` real-model run validates the
  path without producing the number.
- Risk, not yet retired: **Cloud Hypervisor's snapshot caveats are unverified.** Every platform fact we
  rely on comes from Firecracker's docs, while the correctness argument prefers Cloud Hypervisor.
  Verifying them is step 0 of the build order, ahead of writing any code.
- Follow-up owed: path confinement and `SANDBOX_TOKEN` delivery on the container path (real, and a
  `remote-worker` change this slice deliberately does not couple to); gVisor/Kata arms; multi-host;
  cost/resource-seconds accounting.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
