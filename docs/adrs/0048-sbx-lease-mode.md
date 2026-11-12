# ADR-0048: An opt-in lease mode for SBX sandboxes — a warm guest between Execs, with process survival as a separate, explicit level

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-11-08
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-11-08-sbx-lease-mode-design.md`](../specs/2026-11-08-sbx-lease-mode-design.md)
- **Experiment:** E17, rossoctl/moca-experiments `e17/SPEC.md`
- **Revises:** [ADR-0035](0035-per-exec-microvm-warm-standby.md)'s 2026-10-08 revision ("per-`Exec`
  is the tier's only mode"), for SBX sandboxes only. ADR-0035's per-`Exec` guarantees, its gates and
  its read-coalescing exception are unchanged.
- **Refines:** [ADR-0042](0042-sbx0-sandbox-service-on-sandbox-v1.md) (the SBX0 sandbox resource and
  token).

## Context

ADR-0035 (2026-10-08) made per-`Exec` the tier's only mode, for product reasons. Resident sandboxes
are what hosted providers (E2B, Daytona, Modal) already sell, so users who need a living environment
were pointed at them. Two inputs to that decision have changed:

- **The organization must run its own sandbox service.** The 2026-11-05 build-vs-adopt assessment
  requires self-operation, the organization's identity provider, and no vendor control plane. A hosted
  resident provider is no longer an option for internal users. It recommends extending SBX with an
  opt-in lease mode.
- **Measurements.** In E15, on AWS m7i.metal-24xl at the trace corpus's 9.5% duty, per-`Exec` held 80
  sessions. Resident ∞ held 128, and resident with a 300 s idle timeout also held 128. Every arm failed
  on the p95 tail of long CPU-heavy calls, far below host limits. Per-`Exec` long calls ran slower at
  equal host CPU, which fits per-VM cold state. In E16, at about 1.5% duty (in progress), per-`Exec`
  held ≥ 1024 and resident ∞ held 896, on a failure that may be a rig artefact. Resident VM memory
  levelled off near a 150 MiB median. What binds resident density is the admission policy (a full
  guest-RAM charge per running VM), not physical memory.

The workload that hurts under per-`Exec` is repeated cache-heavy or CPU-heavy work in one project: a
coding agent rerunning Python that re-reads data, re-imports heavy libraries or reruns a test suite.
Each run starts in a cold guest. Many such users do not need processes to survive between commands.
They need the guest to stay warm.

## Decision

We will add an **opt-in lease mode** to SBX sandboxes. Per-`Exec` stays the default. A sandbox has one
of three modes:

| Mode                        | Guest across Execs                  | Processes after an Exec                        |
| --------------------------- | ----------------------------------- | ---------------------------------------------- |
| `per-exec` (default)        | fresh each time                     | none                                           |
| `lease` (level 1)           | the same guest until the lease ends | **none**: all killed at the end of each Exec   |
| `lease+processes` (level 2) | same as level 1                     | only processes started through `process_start` |

Decisions taken during design, each recorded in the spec with its section:

1. **Two levels. Process survival is an explicit property, never a side effect.** Level 1 keeps the
   page cache, CPU caches and the guest's tmpfs files (`/tmp`, `/var`) for the lease. The rootfs stays
   read-only. It kills every process at the end of each Exec, using a guest cgroup and `cgroup.kill`,
   and starts each Exec in a fresh shell. `setsid` cannot escape the cgroup **because the Exec cannot
   write the cgroup tree** (decision 15). _(user)_
2. **Level 2 strict rule:** only processes started through the `process_start` MCP tool survive.
   `&`, `nohup`, `setsid` and self-daemonizing processes from `bash` still die. Tracked processes are
   visible in `process_list` and in the audit. _(user)_
3. **Idle is measured from the last Exec end**, default 300 s, settable by the owner up to an operator
   ceiling. A client keepalive never resets idle. The MCP server sends keepalives, and their loss ends
   the lease early. Clients that send none are governed by the idle timeout alone. _(our call, from
   E15's resident-300 result; the keepalive opt-in came from the builder review)_
4. **Maximum lease duration** marks a lease _expiring_. The lease ends at its next idle, or at a hard
   grace limit even when busy. Default 8 h for level 1 and 4 h for level 2, with a 30 min grace limit.
   _(user: wait for idle with a hard grace limit; values: our call)_
5. **Memory pressure reclaims the idle-longest lease, level 1 or level 2 alike**, and the user is
   told. A lease with an Exec in flight is never reclaimed for memory. _(user)_
6. **Lease VMs are admitted on measured memory**, as a third accounting class beside standbys and
   per-`Exec` VMs. The start estimate is 192 MiB, then measured `memory.current` × 1.25, also while an
   Exec runs. An idle lease VM holds no concurrency slot. Reclaim, the host-memory floor and cgroup
   limits are the safety net. There is no per-`Exec` fallback when a lease VM does not fit: the worker
   reclaims, then refuses. _(user: measured charge; accounting details: our call after the builder
   review)_
7. **No balloon in v1.** A lease VM can grow toward its guest RAM and stay there until its lease
   ends. E17 measures how often. _(user)_
8. **The mode can change on a live sandbox, by its owner only, through `mocactl`**, with the user API
   token. The agent gets no tool to change the mode. An upgrade needs a TTY. Operator policy decides
   which modes users may choose. Level 2 stays off until its security review. _(user: live switch,
   user-only; TTY and policy gate: our call)_
9. **The mode reaches the worker in the sandbox token.** The `mode` and `mode_epoch` claims are set
   on every frame by the relay, which overwrites client values. The worker refuses a stale epoch,
   keeps the epoch on disk across restarts, and fails closed to `per-exec`. A downgrade takes effect
   right away through `LeaseControl`. _(our call; relay injection and epoch persistence came from the
   builder review)_
10. **No lease end is silent.** Every end reason (idle, maximum duration, grace limit, keepalive lost,
    reset, mode change, memory reclaim, worker restart, teardown failed, agent dead, sandbox deleted)
    produces one notice on the next tool result and in `sandbox_info`, and one audit record. At
    level 2 these list the stopped processes. _(user: notify; mechanism: our call)_
11. **A lease VM serves one sandbox for its whole life**, is never returned to the standby pool, and
    is destroyed when the lease ends. The workspace persists as today. _(our call)_
12. **Per-`Exec` gates stay as written.** Lease mode gets its own gates (spec §9). _(our call)_
13. **Validation is E17, a separate experiment spec.** E17a runs on the E15 resident patch before the
    build. E17b runs on the shipped lease mode. The pass criteria are stated before any rung runs.
    _(user: separate spec; stages and criteria: our call)_
14. **The target workload is cache-heavy Python.** Level 1 serves on-disk caches re-read through a
    warm page cache. Level 2 serves in-memory process state. _(user)_
15. **In lease mode, Execs and tracked processes run as an unprivileged uid with no capabilities**
    (`no_new_privs`, setuid bits stripped, user namespaces disabled). The guest agent stays root as
    PID 1, non-dumpable, and owns a cgroup tree that is not delegated. An Exec therefore cannot migrate
    out of its cgroup, reach the agent, or forge what the agent reports. Without this, decisions 1, 2
    and 10 hold only against a cooperative Exec. **Each tracked process gets its own uid** from a
    reserved range, and Execs run under a seccomp filter against `ptrace` and `process_vm_*`, so a
    later Exec cannot inject code into a running tracked process. The workspace is shared through a
    common group with `umask 0002`. Per-`Exec` stays root in v1. The security review decides whether
    it moves to the same uid. _(our call, from the PR #698 review)_
16. **Workspace ownership is normalised at the start of every lease that follows root writes.** A
    `root_wrote` flag is set by any per-`Exec` Exec on the workspace, and cleared by a walk that never
    follows symlinks and stays on the workspace mount. A lease after a lease skips the walk.
    _(our call, from the PR #698 review)_
17. **An unknown epoch never restores a higher mode.** After the worker loses its stored epoch, the
    sandbox runs `per-exec` until a control-plane-signed `LeaseControl set_mode` arrives. A stale
    token's epoch is not trusted as "higher". _(our call, from the PR #698 review)_

### Revision 2026-11-12: E17a calibration

E17a (moca-experiments `e17/`, predictions sealed 2026-11-12) measured the E15 resident patch against
per-`Exec` on a cache-heavy Python session at N = 1 on the E15 metal host. A warm guest saved 89% on
short commands and 40% on a stack import, and 0–8% on the dataset analysis and the test suite. A
`grep -r` over the venv gained nothing in realistic turns. Per-`Exec` already reads the workspace
through the host page cache, and a lease guest keeps a file set warm only when it lives through a
whole turn. Every lease VM filled its 1024 MiB cgroup after one heavy command (spec §17). This
revision changes four decisions and adds two:

- **Decision 7 is replaced.** Lease VMs run with virtio-balloon free-page reporting in v1, so the guest
  returns memory it has freed and the measured charge (decision 6) follows the working set. A
  target-driven balloon stays out of v1. The balloon is in the one golden snapshot, so per-`Exec` VMs report too (user, 2026-11-12). _(E17a: without it, measured charge equals the full charge on
  the target workload)_
- **Decision 14 is narrowed.** Level 1 serves short and import-bound commands and capacity at mid duty
  (E15). It is not a page-cache accelerator for long compute, and it gains little where per-`Exec`
  already has the host's cache. The cache-heavy, in-memory case is level 2's. _(E17a)_
- **Decision 3's default (300 s) is kept and re-examined in E17b**, together with the memory model: a
  longer timeout keeps more file sets warm and holds each idle lease's working set longer. _(E17a)_
- **Decision 13's criteria are the sealed E17 ones** (`e17/predictions.json`): criterion 2 is per command
  class at 50%. E17a predicts that it fails on the import and the grep. That miss goes to the user
  before the build of plans 2–5. _(user, 2026-11-11 and 2026-11-12)_
- **New decision 18: page-cache headroom for lease VMs.** A lease VM's cgroup gets `memory.max` =
  `PerVMBytes` + `SH_LEASE_PAGECACHE_MB` (default 256 MiB), so a full guest does not leave the
  workspace uncached on the host for the VM that follows it. Lease cgroups are created per lease and
  never come from or go back to the per-`Exec` cgroup pool, and the reclaim headroom target is sized
  against the larger lease charge bound (spec §6). _(E17a: about 2 s against 388 ms for the
  same grep)_
- **New decision 19: level 2 is the latency case, sized before its security review.** A persistent
  interpreter on E17a's workspace answered a re-query in 0.25 s against 6.5 s per-`Exec` (5.4 s at
  level 1) and a recompute in 11.2 s against 17.4 s, holding about 500 MB of a 1 GiB guest (spec §16
  item 6). _(spike, 2026-11-12)_

### Alternatives considered

- **Keep per-`Exec` only (ADR-0035 as it stands):** leaves internal users with no warm environment
  and no self-hosted provider that meets the assessment's requirements.
- **Resident for the sandbox's whole life:** holds memory through long idle periods. In E15 it showed
  no gain over a 300 s idle timeout.
- **One lease level where detached processes survive:** an injected command could leave a process
  running unnoticed. Survival must be asked for.
- **Adopt Agent Substrate or SPACE for leases:** still open as the assessment's Phase 3b, behind the
  MCP client's backend interface. Not a blocker for this decision.
- Each design-time alternative is listed in the spec, §15.

## Consequences

- **Positive:** users can opt into a warm guest for cache-heavy work without giving up the "no process
  survives a command" property (level 1). Process survival is available when needed, and visible
  (level 2). Measured admission lets one host hold many more idle leases than a full guest-RAM charge
  would allow. One API and one token model cover all three modes.
- **Negative / accepted cost:** in lease mode, files in the guest's tmpfs persist for the lease (and
  count as guest RAM), so an injected command can leave a file that a later command uses. This is bounded by the idle timeout,
  maximum duration, `reset`, no guest network, and one sandbox per lease VM. At level 2 a process can
  keep working between Execs, but only through `process_start`, under tighter limits. Measured
  admission trades a reservation for reclaim, so a lease VM's growth during a long Exec is caught after
  the fact. The guest image must mount `cgroup2`, add the Exec uid and strip setuid bits, which
  changes every host's snapshot once, per-`Exec` included. Lease workspaces are owned by the Exec uid.
- **Follow-up owed:** E17 (a and b); a lease section and a level-2 section in the SBX security review;
  the implementation plan; a Firecracker balloon if E17 shows lease VMs pinned near guest RAM.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
