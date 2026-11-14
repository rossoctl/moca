# SBX0.3 — Lease mode for `mocactl sbx` sandboxes — Design

Version: 0.4 — November 13, 2026 (draft for review)
Status: Design. Not approved. Built: plan 1 (guest agent and image, #706), plan 2 (the worker's
leases, #763), plan 3 (the wire: the control plane, the relay and the worker's frames, #802) and
plan 4 (the clients: `mocactl sbx`, the MCP server and the static `sbx` client). Lease mode stays
off by default (`SH_SANDBOX_MODES_ALLOWED=per-exec`, §8.1). Level 2 (plan 5) is not built.
v0.2 folds in E17a's calibration (§1.1, §17): level 1 is re-scoped (§2), free-page reporting moves
into v1 (§6, §14), lease VMs get page-cache headroom in their cgroup (§6), and the idle timeout and
the memory model are set together (§4).
v0.3 records what plan 3 decided on the wire: a lease event rides before the Exec's `End`, as a
best-effort notice (§5); the `mode-token` route, the epoch a create starts at and the idle
timeout's bounds (§8.1); the third claim and the set-mode token (§8.2); the relay's limits and
status codes for the new calls (§8.3).
v0.4 records what plan 4 built in the clients: the notice copy and where each client shows it (§5),
the mode commands and the deploy inputs (§8.2), and `sandbox_deleted`, keepalive coalescing and the
worker's status cap (§8.3).
Milestone: **SBX0.3**, an increment of [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md),
registered in [the milestone registry](README.md).
Decision record: [ADR-0048](../adrs/0048-sbx-lease-mode.md), which revises
[ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md)'s 2026-10-08 decision "per-`Exec` is the
tier's only mode" (§12).
Experiment: **E17** in `rossoctl/moca-experiments` (`e17/SPEC.md`), a separate spec (§10).
Background: the assessment "Remote sandbox for coding agents: extend MOCA SBX or adopt an open-source
platform" (revision 2, 2026-11-05, outside this repository), its recommendation 1 and Phase 1.

Builds on these, reusing them without redesign:

- [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md): the `sandbox` route profile, the
  sandbox record (`owner`, `worker`, `wsk`), the per-sandbox Ed25519 token, the relay, `mocactl sbx`
  and its local stdio MCP server.
- [P4 / ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md): the microVM pool, standbys, the
  persistent workspace, and per-`Exec` mode, which stays the default and keeps every guarantee it has
  today.
- #644: the measured standby charge (`standbyFootprinter`, `SH_STANDBY_HEADROOM`,
  `remote-worker/internal/vmpool/budget.go`). Lease VMs are charged the same way (§6).
- [SBX0.2b](2026-10-26-sbx-egress-credentials-design.md): egress through `moca-egress`, credentials
  outside the guest. Unchanged. A lease VM has no network interface, the same as a per-`Exec` VM.

## 1. Problem

Every SBX command runs in a fresh Firecracker microVM over a persistent workspace. Files survive
between commands. Nothing else does: the guest's page cache, CPU caches, `/tmp`, and every process.

For most coding-agent work that costs little. On bare metal per-`Exec` adds about 34 ms per call.
It costs more when the agent runs the same CPU-heavy or data-heavy command again and again in one
project. A typical case is Python code that re-reads a dataset, re-imports heavy libraries or reruns a
test suite. Each run starts with a cold guest, and the slowdown grows with host load.

### 1.1 Evidence (moca-experiments, E15 metal run and E16)

- **E15, default point (9.5% duty), AWS m7i.metal-24xl.** Sealed `N_max`: per-`Exec` 80, resident ∞
  128, resident with a 300 s idle timeout 128 (`e15/results/metal/RESULTS-METAL.md`). Every arm failed
  on the p95 tail of minutes-long CPU-heavy calls running a few percent slow, at 9–13% host CPU. At
  equal N and equal host CPU, per-`Exec` long calls ran slower (long-call median 1.047 against 1.019
  at N=160). That fits per-VM cold state, not host contention.
- **Resident with a 300 s idle timeout matched resident ∞** on every sealed and supplementary reading.
  That arm is what this spec calls lease level 1, without the per-`Exec` process kill. A short idle
  timeout keeps the benefit and gives memory back.
- **E16, low duty (about 1.5%), in progress.** Per-`Exec` held every rung to 1024 (censored).
  Resident ∞ held 896. It failed at 1024 on 14 `exit_mismatch` calls that line up with a worker
  "egress wedged" relay reconnect, a suspected rig artefact (a no-wedge re-judge is pending). Memory
  did not bind. Resident VM memory flattens at a median of about 150 MiB after about 2 h (p95 about
  230 MiB). 256 live VMs used 36.5 GiB (`e16/results/vm-age/long-rung.md`).
- **E17a calibration, cache-heavy Python (`pycache`, N = 1, 2026-11-11).** Warm lease (E15 resident
  patch, 300 s) against per-`Exec`, median per command class: short commands (`grep`, `sed`, `head` on
  project files) 53 → 6 ms (−89%); `import numpy, pandas, scipy, sklearn` 755 → 454 ms (−40%);
  `analyze.py` (dataset parse plus a KMeans fit) 15.6 → 14.4 s (−8%); `pytest` 61.2 → 61.0 s (0%);
  `grep -r` over the venv's sources: 1.96 → 2.00 s in realistic turns, 388 → 112 ms back to back.
  Every lease VM reached its 1024 MiB cgroup ceiling after its first `analyze.py` (§17).
- **What binds resident density is policy, not memory.** Admission charges every VM that is executing
  or restoring its full guest RAM plus overhead, about 1 GiB (`runningCommittedLocked`,
  `remote-worker/internal/vmpool/budget.go:418-425`, against `SH_MAX_COMMITTED_MB`).

### 1.2 Current state (`rossoctl/main` @ `316056a7`)

- **One VM, one command.** `pool.Exec` acquires a standby, resumes it, runs one command and destroys
  it (`remote-worker/internal/vmpool/pool.go:206`). `TestGateNoVMReuse` enforces this
  (`remote-worker/internal/vmpool/gates_kvm_test.go:178`).
- **The guest agent is one-shot.** It serves the command from a `bash` that was parked before the
  snapshot. It is "safe here … because the VM serves exactly one command in its life"
  (`remote-worker/internal/guestagent/agent.go:28-35`). After a timeout it refuses all work (`:51-56`).
  It has no process tracking and no way to kill a process tree other than destroying the VM.
- **Run lifecycle.** `RunAbsent → RunWarming → RunActive → (idle > StandbyIdle, 90 s) → RunParked →
(idle > WorkspaceIdle, 30 min) → RunReclaiming` (`remote-worker/internal/vmpool/runpool.go:7-9`,
  `config.go:39-40`). Standbys are charged their measured `memory.current` times
  `SH_STANDBY_HEADROOM` (`budget.go`). VMs executing or restoring (`rp.inFlight + rp.warming`) are
  charged full `PerVMBytes` (`budget.go:418-425`), and `inFlight` also counts against the worker's
  concurrency slots (`WORKER_MAX_CONCURRENT`).
- **Sandbox record.** `id, owner, tenant, name, template, worker, wsk, labels, createdAt, expiresAt,
deletedAt?` (`packages/control-plane/src/sandbox-store.ts:9-23`). It has no mode.
- **Relay.** The client sends `workspace_key`. The relay refuses an Exec whose `sandbox_id` or
  `workspace_key` differs from the token's `wrk`/`wsk` claims
  (`packages/sandbox-relay/src/sandbox-caller.ts:256-261`). It injects nothing from the token today.
- **Guest init** mounts `proc`, `sysfs` and two `tmpfs`, and no `cgroup2`
  (`deploy/microvm/build-snapshot.sh:604-610`).
- **Protocol.** `sandbox/v1` has `Exec` and `Abort`. `Heartbeat {}` is worker liveness only
  (`proto/sandbox/v1/sandbox.proto:47`).
- **MCP tools.** `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `sandbox_info`
  (`packages/sandbox-client/src/mcp-server.ts`, wired by `packages/mocactl/src/sbx/mcp.ts`).

### 1.3 Acceptance

1. A sandbox has a **mode**: `per-exec` (default), `lease` (level 1) or `lease+processes` (level 2).
   Only the sandbox owner can change it, from `mocactl`, on a live sandbox.
2. In `per-exec` mode nothing changes. Every current gate still passes.
3. In `lease` mode, consecutive Execs of one sandbox run in the same guest until the lease ends. **No
   process survives the end of its Exec.** Files in the guest's tmpfs mounts (`/tmp`, `/var`)
   survive until the lease ends. The rootfs is read-only in every mode.
4. In `lease+processes` mode, a process started through `process_start` survives between Execs. A
   process started any other way (`&`, `nohup`, `setsid`, a daemon that forks itself) dies at the end
   of its Exec, exactly as in level 1.
5. A lease ends on an idle timeout, at the maximum duration (when the sandbox is idle, or at the hard
   grace limit), on `reset`, on a mode downgrade, on memory reclaim, on keepalive loss, on a worker
   restart, on a failed teardown, on a dead guest agent, or on sandbox deletion (§4.1). After any end, the next Exec starts a cold guest on the same workspace.
6. **No lease end is silent.** The next tool result and `sandbox_info` give the reason. At level 2
   they also list the tracked processes that were stopped. Every lease end has an audit record.
7. Lease VMs are admitted on measured memory. Reclaim keeps the host above a headroom target, and the
   existing physical guards never trip in E17's memory-squeeze point.
8. E17 meets its pass criteria (§10).
9. In lease mode an Exec cannot defeat its own teardown: it runs unprivileged, and it cannot move
   into another cgroup, create one, or signal, trace or write the guest agent (§3.3).

## 2. Decision summary

| Topic               | Decision                                                                                                                                                     | Source                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Levels              | Two opt-in levels over per-`Exec`: `lease` (warm guest, processes killed at the end of each Exec) and `lease+processes` (tracked processes survive)          | user                         |
| Level 1             | Processes are killed at the end of each Exec. Keeping processes is an explicit property, never a side effect                                                 | user                         |
| Level 2 survivors   | Only processes started through `process_start` (strict rule)                                                                                                 | user                         |
| Exec privilege      | In lease mode, Execs and tracked processes run as an unprivileged uid with no capabilities; the agent stays root (§3.3)                                      | our call (PR #698 review)    |
| Idle                | Measured from the last Exec end. A keepalive never resets it                                                                                                 | our call                     |
| Idle timeout        | Default 300 s, owner-settable up to an operator ceiling                                                                                                      | our call (E15 resident-300)  |
| Keepalive           | The MCP server sends one while the harness runs. Loss for 120 s ends the lease                                                                               | our call                     |
| Maximum duration    | Reaching it marks the lease **expiring**. It ends at the next idle, or at the hard grace limit                                                               | user                         |
| Memory pressure     | Reclaim the lease idle longest, level 1 or 2 alike, and notify                                                                                               | user                         |
| Admission           | Lease VMs are charged measured memory. Reclaim is the safety net                                                                                             | user                         |
| Level 1 target      | Short and import-bound commands, and capacity at mid duty (E15). Not long compute, and not page-cache reuse that per-`Exec` already gets from the host (§17) | E17a (v0.2)                  |
| Free-page reporting | In v1 for lease VMs: the guest returns freed pages, so an idle lease is charged its working set, not its peak (§6). No target-driven balloon                 | E17a (v0.2), was "not in v1" |
| Lease cgroup        | `memory.max` = `PerVMBytes` + `SH_LEASE_PAGECACHE_MB` (default 256 MiB), so a full guest leaves room for the host to cache the workspace (§6)                | E17a (v0.2)                  |
| Balloon             | No target-driven balloon (inflate on demand) in v1                                                                                                           | user                         |
| Mode switch         | On a live sandbox, by the owner, through `mocactl` only. The agent gets no tool for it                                                                       | user                         |
| Default mode        | `per-exec`                                                                                                                                                   | user (assessment Phase 1)    |
| Experiment          | E17, a separate spec in moca-experiments                                                                                                                     | user                         |

## 3. Modes

|                                                 | `per-exec`      | `lease` (level 1)                          | `lease+processes` (level 2)    |
| ----------------------------------------------- | --------------- | ------------------------------------------ | ------------------------------ |
| Guest across Execs                              | fresh each time | the same guest until the lease ends        | same as level 1                |
| Page cache, CPU caches                          | cold            | warm                                       | warm                           |
| `/tmp` and `/var` (tmpfs, counted in guest RAM) | lost            | kept until the lease ends                  | kept until the lease ends      |
| Rootfs (system paths, system-wide installs)     | read-only       | read-only                                  | read-only                      |
| Shell state (env, cwd, functions)               | n/a             | **not kept**: each Exec gets a fresh shell | not kept                       |
| Processes after an Exec                         | none            | none: killed at the end of the Exec        | only `process_start` processes |
| Workspace                                       | persists        | persists                                   | persists                       |
| Exec user                                       | root (today)    | unprivileged uid (§3.3)                    | unprivileged uid (§3.3)        |
| `process_*` tools                               | refused         | refused                                    | available                      |

**One lease VM serves one sandbox, for its whole life.** A lease VM is never handed to another
sandbox, another workspace key or another owner. When a lease ends its VM is destroyed. It never goes
back to the standby pool.

The rootfs is mounted read-only in every mode (`build-snapshot.sh:1530` boot argument `ro`, `:1545`
`is_read_only: true`). Outside `/workspace`, only the tmpfs mounts `/tmp` and `/var` are writable.
Package installs survive a lease only if they target one of those or the workspace (for example
`pip install --target /tmp/deps`). The tmpfs files are guest RAM. They raise the VM's
`memory.current` and are not freed until the lease ends, so §6 and E17 count them. They also count
against the cap on the agent's cgroup tree, so later Execs of the lease run out of memory sooner
until the files are deleted. An Exec killed for memory while the lease still holds a quarter or more
of that cap gets a line on its stderr from the agent, saying how much the lease holds and that files
in `/tmp` and `/var` count.

**Execs stay serial for each sandbox**, as today. `process_*` calls are Execs for that rule.

### 3.1 Killing processes at the end of an Exec

**Prerequisite (guest image).** This needs cgroup v2 with `cgroup.kill` in the guest: kernel 5.14 or
later with cgroup v2 enabled, and a `cgroup2` mount in init. The current init mounts none
(`build-snapshot.sh:604-610`). See §16.

The guest agent runs each Exec in its own cgroup v2 inside the guest. At the end of the Exec, whether
it exits, times out or is aborted, the agent writes `cgroup.kill` for that cgroup and waits until it is
empty before it sends `End`. On a timeout the agent kills the Exec's cgroup and reports the timeout
as a `timeout:<n>` error frame instead of `End`; the host keeps the lease only for that frame (§4.1).
`setsid`, double forks and re-parenting to init cannot escape a cgroup,
which is why a process group is not enough. This holds only for an Exec that cannot write the cgroup
tree or reach the agent, so it depends on the privilege model in §3.3. A `process_start` process gets its own cgroup under a
`tracked/` parent that the end-of-Exec kill does not touch.

An Exec whose cgroup does not empty within a bound (for example 5 s, which covers `D`-state
processes) ends the lease with reason `teardown_failed`. The guest is no longer known to be clean, so
it is destroyed.

### 3.2 A fresh shell for each Exec

Today's parked `bash` is safe only because the VM serves one command. In lease mode the agent starts a
new shell for each Exec (forked from a parked template process, or exec'd new; the builder chooses).
Then `export`, `cd` and shell functions from one Exec cannot affect the next. The snapshot-time parked
shell is kept for the first Exec of a lease if that saves measurable time.

The agent's "dead after one timeout" latch (`agent.go:51-56`) becomes a lease end with reason
`agent_dead` instead of a refusal of every later command.

### 3.3 Guest privilege model

Today every Exec runs as root. Init `exec`s the agent as PID 1 (`build-snapshot.sh:658`), and the
agent starts `bash` with no credential drop (`guestagent/agent.go:97`, `:433`). Under per-`Exec` that
does not matter, because the VM is destroyed after the command. In a lease it does. A root Exec could
move itself into `tracked/` (`echo $$ > …/cgroup.procs`), create its own cgroup, or trace or write
`/proc/1/mem` of the agent. Then it could hide processes from `process_list`, skip `cgroup.kill`, or
forge the stopped-process list in later notices. That defeats acceptance items 3, 4 and 6. So, in
both lease levels:

- **The agent stays root (PID 1). Execs run as an unprivileged uid** (`sbx`, for example 1000) with
  an empty capability set: bounding set dropped, `no_new_privs` set. The agent starts each Exec
  through `SysProcAttr.Credential` and an explicit capability drop.
- **Each tracked process runs under its own uid**, taken fresh from a reserved range (for example
  20000 up to 20000 + `SH_LEASE_MAX_PROCESSES` − 1) and not reused while any process of it is alive in
  the lease. It has the same empty capability set and `no_new_privs`. Without this, a later and possibly
  injected Exec under the same uid could `ptrace`, `process_vm_writev` or write `/proc/<pid>/mem` of a
  running tracked process: same-uid ptrace is allowed by default, and the guest has no Yama. Its code
  would then outlive the Exec while `process_list` still showed the original command, a side door
  around the strict rule. A different uid fails the kernel's ptrace-mode access check for all three
  routes, and signals too. As defence in depth, Execs also run under a seccomp filter that denies
  `ptrace`, `process_vm_readv` and `process_vm_writev`. The filter cannot cover `/proc/<pid>/mem`,
  which is an `open()` with a permission check, so the uid split is the protection there.
  `PR_SET_DUMPABLE 0` is no substitute: `execve` resets it, and only the process itself can set it.
- **The workspace is shared through a group.** The Exec uid and every tracked uid share a primary
  group (`sbx-ws`). Workspace directories are group-writable and setgid, and the agent starts every
  Exec and tracked process with `umask 0002`. Then a dev server can write build output, and a later
  Exec can edit what the dev server wrote. Files created with an explicit mode that drops group write
  (for example `0644` from a tool that ignores umask) stay writable only by their creator. That is an
  accepted residual, because the agent can always `process_stop` and restart the process.
- **The cgroup tree is root-owned and not delegated.** `cgroup.procs` and `cgroup.subtree_control`
  under `/sys/fs/cgroup` are writable by root only. The Exec uid can neither migrate a process nor
  create a cgroup.
- **The agent is out of the Exec uid's reach.** A different uid already rules out `kill`, `ptrace` and
  `/proc/1/mem` writes without `CAP_KILL` and `CAP_SYS_PTRACE`. The guest kernel has no Yama
  (`CONFIG_SECURITY_YAMA` is not set on SBX0's `6.18.51+`), so `kernel.yama.ptrace_scope` is not
  available. The uid boundary and the empty capability set are the protection. The agent also sets
  itself non-dumpable (`PR_SET_DUMPABLE 0`).
- **No route back to root.** The rootfs carries setuid binaries today: `su`, `mount`, `umount`,
  `newgrp`, `gpasswd`, `chage`, `unix_chkpwd` and `pam_timestamp_check` in SBX0's build tree.
  `no_new_privs` neutralises them for the Exec's process tree. The image work also strips the setuid
  bit, so the rule does not rest on one flag. User namespaces (`CONFIG_USER_NS=y`) are disabled
  (`user.max_user_namespaces = 0` in the guest), because a user namespace gives an unprivileged
  process capabilities inside it.
- **Workspace ownership.** In a lease the workspace is owned by the Exec uid and the `sbx-ws` group.
  `mocactl sbx push` already extracts with `--no-same-owner` (`packages/mocactl/src/sbx/push.ts:502`),
  so pushed files take the extracting uid. Per-`Exec` runs as root (next bullet), so files written
  during a per-`Exec` period are root-owned. The rule is therefore **per lease, not once**:
  - The worker sets a `root_wrote` flag in the sandbox's state file (next to the epoch, §8.2) whenever
    it runs a per-`Exec` Exec on that workspace. A workspace that predates lease mode starts with the
    flag set.
  - At the start of every lease whose flag is set, the agent normalises ownership before the first
    Exec runs: owner the Exec uid, group `sbx-ws`, setgid on directories, group write added. Then it
    clears the flag. A lease that follows another lease, with no per-`Exec` period between them, skips
    the walk.
  - The walk never follows a symlink. It uses `lchown`/`fchownat(AT_SYMLINK_NOFOLLOW)` and does not
    cross out of the workspace mount. A root `chown -R` that dereferenced a symlink planted in the
    workspace would otherwise change the owner of its target, for example a file in `/tmp` or `/var`.
  - The walk is a step of the lease's start, like the restore and the resume: the worker sends the
    agent a request of its own (`true` with the normalise flag, a 10 min timeout) before the first
    Exec. The first request's one-time hardening runs in it too. The step is not charged to the
    Exec's timeout. The flag clears only when the step exits 0; a step that fails fails the lease
    start, and the next lease Exec takes it again.
  - The walk's time is part of the first Exec's latency. E17 measures it against workspace size.
    Moving per-`Exec` to the Exec uid (§16 item 4) would remove the walk.
- **Per-`Exec` mode** runs as root today and stays so in v1. It destroys the VM, so root there has no
  lease-specific effect. Moving per-`Exec` to the same uid would give one guest model and one
  workspace ownership. Then a mode switch needs no `chown`, and tools see the same environment in every
  mode. The security review decides (§16 item 4). Tools that need root, such as `apt` or writes to
  system paths, already fail on the read-only rootfs in every mode.

`TestGateLeasePrivilege` and `TestGateLeaseOwnership` (§9) check this.

## 4. Lease lifecycle

```
              first Exec (mode lease*)                      idle timeout / keepalive loss /
 [no lease] ───────────────────────────▶ [active] ────────▶ reclaim / reset / downgrade /
     ▲                                     │                 worker restart / teardown_failed
     │                                     │ maximum duration reached
     │                                     ▼
     │                                 [expiring] ── next idle (normal idle rule) ──▶ ended
     │                                     │
     │                                     └── hard grace limit, even mid-Exec ─────▶ ended
     └────────────────────── ended: VM destroyed, workspace kept ◀─────────────────────
```

| Setting          | Meaning                                              | Default                        | Who sets it                                        |
| ---------------- | ---------------------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `idle_timeout`   | No Exec in flight and none ended for this long → end | 300 s (revisited in E17b, §17) | owner, ≤ operator ceiling (default ceiling 1800 s) |
| `max_duration`   | From lease start → **expiring**                      | level 1: 8 h; level 2: 4 h     | operator                                           |
| `grace_limit`    | From expiring → end even if busy                     | 30 min                         | operator                                           |
| `keepalive_loss` | No keepalive for this long → end                     | 120 s                          | operator                                           |

- **Idle is measured from the last Exec end.** A keepalive proves that the harness runs. It never
  proves that anyone is working, so it never resets idle. With a user away and the harness open, the
  lease ends at `idle_timeout`.
- **Keepalive loss ends the lease right away.** Examples are a harness exit, a laptop going to sleep
  or a network loss.
- **Keepalive is opt-in per client.** A lease starts in `keepalive` state only when its first Exec
  comes from a client that sends keepalives (the MCP server; it sets `Exec.keepalive = true`). A lease
  started by any other client (`mocactl sbx exec`, `run`, a `sandbox/v1` program, the E17 driver) has
  no keepalive rule and ends by the idle timeout only. Once a keepalive arrives, the rule applies until
  the lease ends.
- **Expiring.** Execs are served as usual. Each result carries a warning that the guest will restart
  soon. The lease ends at the first normal idle. At `grace_limit` it ends anyway. An Exec in flight then
  fails with a `lease_ended(grace_limit)` error, not a generic failure.
- **Tracked processes are not activity.** A dev server serving requests inside the guest does not reset
  idle. Only Execs do.
- **The next Exec after any end** runs in a fresh guest, with a lease-start notice. The first Exec pays
  one cold start.
- **Idle timeout and memory are one setting (v0.2).** A lease keeps a file set warm only if it
  survives from one use of that set to the next, which in an agent session is a whole turn, not one
  gap. On E17a's corpus a 300 s timeout kept 91% of calls in a live guest, but only 32% of greps found
  the guest that ran the previous grep (§17). A longer timeout raises that share and holds each idle
  lease's memory longer. With free-page reporting (§6) an idle lease holds its working set, so the
  trade-off is priced in working-set memory, not in guest RAM. E17b measures both at 300 s and at a
  longer timeout before the default changes.

### 4.1 End reasons

`idle`, `max_duration`, `grace_limit`, `keepalive_lost`, `reset`, `mode_change`, `memory_reclaim`,
`worker_restart`, `teardown_failed`, `agent_dead`, `sandbox_deleted`. Every end writes an audit record
with the reason, the mode, the lease age and, at level 2, the tracked processes (id, name, exit state).
Like every SBX record, it has no command text.

A lease Exec's timeout keeps the lease: the guest kills the Exec's cgroup and reports the timeout,
and the next Exec runs in the same guest. In v1 an abort (the caller cancels the Exec) ends the lease
with `agent_dead`, as does a guest that has not answered a few seconds after the Exec's timeout.
The budget counts from the Exec's arrival, so a wait behind another Exec of the sandbox and a lease
start are charged to it. An Exec whose budget is spent before its command starts fails with the
timeout without running, and the lease is kept.

## 5. Notices

The MCP server cannot push into the harness, so a notice travels with the next response:

- **The next tool result** after a lease end starts with one line, for example
  `[sandbox] guest restarted (memory_reclaim, 14:02): /tmp, installs outside /workspace and background
processes are gone; stopped: devserver (pid 412)`.
- **Expiring:** each tool result carries `[sandbox] guest restarts within 30 min (max_duration)`.
- **`sandbox_info`** shows the mode, the lease state (`none | active | expiring`), its age, the idle
  timeout, the last end reason and the tracked processes.
- **`mocactl sbx`** prints an unseen notice on the user's next command, so that a user whose harness
  had exited still learns of it.

On the wire, `sandbox/v1` gets an additive
`LeaseEvent {req_id, state, reason, at_unix_ms, mode, age_ms, processes[]}`. `state` is `start`,
`end` or `expiring`; `reason` is an end reason (§4.1), set on an `end`, and on an `expiring` as
`max_duration` (plan 4); `processes` stays empty until level 2 (§7).

- **It rides on a lease Exec's response, before its `End`.** The worker sends it under the Exec's
  `req_id` after the command's output and before the terminal frame. It does the same before an
  `error` (`stale_mode`, `lease_ended(<reason>)`, a timeout), so a client learns that the lease ended
  even when that Exec failed. `LeaseControl status` also returns it, as `LeaseStatus.pending` (§8.3).
- **The worker keeps one pending event for each sandbox,** the last start or end, until a lease
  Exec's response has carried it. It is acknowledged by its `at_unix_ms` (milliseconds) as soon as it
  is queued on the worker's stream to the relay. An event that could not be queued (the connection
  had ended) stays pending, and the next lease Exec carries it.
- **A lease event is a best-effort notice.** It is delivered once, on the next lease Exec's response,
  and acknowledged when it is queued, not when the client reads it. If the stream breaks between the
  two, the event is lost; `LeaseControl status` still shows the lease's state. In rare cases the same
  event arrives twice (the acknowledgement could not be written to the host disk, or the sandbox's
  next Exec finished before the previous one's response acknowledged it), so a client dedupes on
  `at_unix_ms`.
- **`expiring`** rides on every lease Exec while the lease is past its maximum duration. It is not
  acknowledged.
- **A per-exec Exec carries no lease event,** so a client that never asked for a lease never sees
  one. A downgrade's `mode_change` end is therefore reported through the `set_mode` result's status
  (`LeaseStatus.pending`), not on an Exec. The event stays pending, and the first lease Exec after a
  later upgrade carries it. Plan 4's notice work decides whether `set_mode` acknowledges it instead.

**As built (plan 4).** The copy, in `packages/sandbox-client/src/lease.ts` (`leaseNotice`), with a Go
port in the static client (`remote-worker/cmd/sbx/notice.go`):

| Event      | Line                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `end`      | `[sandbox] guest restarted (<reason>, <HH:MM>): /tmp, installs outside /workspace and background processes are gone` |
| `expiring` | `[sandbox] guest restarts within <N> min (max_duration)`, N = max(1, ceil((`ends_by_unix_ms` − now) / 60 000))       |
| `start`    | `[sandbox] new guest (<mode>, <HH:MM>)`, shown only when no end is shown in the same result                          |

- **`<HH:MM>`** is the event's `at_unix_ms` in local 24-hour time. An end with `processes` adds
  `; stopped: <name> (pid <n>)` for each (plan 5 fills it). One result shows only its last
  `expiring` line.
- **`expiring` carries its deadline.** `LeaseEvent` gains `ends_by_unix_ms = 8`, set on `expiring`
  only: the lease's hard end, its `at_unix_ms` plus `grace_limit`. Its `at_unix_ms` is the lease's
  start plus `max_duration`, the instant the worker's deadline counts from, so every repeat carries
  the same value (ruling P4-R2); its `reason` is `max_duration`. A worker that predates the field
  sends 0, and the line reads `[sandbox] guest restarts soon (max_duration)` (P4-R8).
- **The MCP server** puts the lines first in each tool result, a failed Exec's events included
  (P4-R5), deduped on `state` and `at_unix_ms` for the server's life (so an end and the next
  lease's start in the same millisecond are both shown). The events of a call that was cancelled,
  whose result nobody reads, are held for the next result: an aborted Exec's rejection carries the
  events it had received, as a failed one's does. The `reset` tool takes its text from the reset's
  own answer, and marks the reset's pending end seen without a notice line, as `mocactl sbx reset`
  does (P4-R17). `sandbox_info` adds `mode`, `lease`
  (`none`, `active` or `expiring`), `age`, `idle timeout`, `last end` and `tracked processes: none`
  (until plan 5). A `per-exec` sandbox makes no lease call and shows `lease: none (per-exec)`
  (P4-R9); a failed status shows `lease: unknown (<code>)`.
- **`mocactl sbx`** prints the lines on stderr. `run`, `get`, `mode` and `reset` print each event
  the user has not seen. What was seen is kept per sandbox in `<state dir>/sbx/notices.json`, as the
  newest `at_unix_ms` shown (P4-R14); `rm` forgets the sandbox. An `expiring` line is shown every
  time and marks nothing seen.
- **The static `sbx` client** prints the same lines on stderr, each event (`state` and
  `at_unix_ms`) once per run, an `expiring` one included: its `at_unix_ms` is constant per lease
  (P4-R2), so a retried attempt's repeat prints nothing. The MCP server, unlike it, shows `expiring`
  on every result.
- **`set_mode` does not acknowledge the `mode_change` end.** The event stays pending at the worker
  until a lease Exec carries it, and the clients dedupe it. `mocactl sbx mode` reports it on stdout,
  as `lease ended (mode_change)`, and `mocactl sbx reset` reports its own end as
  `lease ended (reset)`; each marks that event seen without a notice line (P4-R17), so it is said
  once.

## 6. Admission and reclaim

- **A third accounting class.** A lease VM is neither a standby nor an `inFlight` per-`Exec` VM. It
  is a `leased` VM on its run, counted apart from `inFlight` and `warming`.
  - **Slots:** an idle lease VM holds **no concurrency slot**. An Exec running in it takes a slot for
    the Exec's duration, like any Exec. `WORKER_MAX_CONCURRENT` therefore bounds concurrent Execs, not
    leases.
  - **Memory, idle or busy:** a new lease VM is charged a starting estimate (`SH_LEASE_START_MB`,
    default 192 MiB, near E16's p95 at age 0) until its first sample. After that it is charged its
    measured `memory.current` × `SH_LEASE_HEADROOM` (default 1.25), **also while an Exec runs in it**.
    It is never re-priced to `PerVMBytes`. This reuses #644's footprinter and its cache. A lease VM's
    growth during a long Exec is caught by the next sample and by reclaim, not by a reservation.
  - Per-`Exec` VMs keep the full `PerVMBytes` charge.
- **Free-page reporting (v0.2).** Lease VMs run with the virtio-balloon device in free-page reporting
  mode only (Firecracker v1.17.0: `"free_page_reporting": true`; Cloud Hypervisor:
  `free_page_reporting=on`; §16 item 5): the guest reports pages it has freed, and the host drops them. Nothing inflates
  the balloon. Without it, E17a's lease VMs stayed at their 1024 MiB ceiling for the whole lease after
  one `analyze.py` (pandas frames and a KMeans fit that the guest had already freed), so measured charge
  came out equal to the full charge on the workload this mode targets. Reported pages leave
  `memory.current`, so the measured charge above follows the working set. Free page _hinting_ and a
  deflate-on-OOM policy are not needed. Firecracker and both guest kernels support it, and a restored VM
  returned 650 of 734 MiB within 15 s in a test (§16 item 5).
- **Page-cache headroom in the lease cgroup (v0.2).** Each VM's cgroup has `memory.max` =
  `PerVMBytes` (guest RAM + VMM overhead, `remote-worker/internal/vmpool/cgroup.go` `writeMemoryMax`).
  Host page cache for a VM's own disk reads is charged to that cgroup. A lease VM whose guest is full
  therefore has no room for the host to cache its workspace, and the VM that follows it when the lease
  ends reads from disk: in E17a a grep in such a VM took about 2 s, where a per-`Exec` VM, whose short
  life left the host cache in place, took 388 ms (§17). Lease VMs get `memory.max` =
  `PerVMBytes` + `SH_LEASE_PAGECACHE_MB` (default 256 MiB). Free-page reporting removes most of the
  pressure; the headroom covers the time before the guest frees.
  - **Charge bound.** The measured charge counts the headroom only when the host uses it
    (`memory.current`), but at `SH_LEASE_HEADROOM` it can reach 1.25 × (`PerVMBytes` +
    `SH_LEASE_PAGECACHE_MB`): about 1.6 GiB at 1 GiB guests (1.25 × (1056 + 256) MiB) and about
    680 MiB at SBX0's 256 MiB guests (1.25 × (288 + 256) MiB). That is above a per-`Exec` VM's
    `PerVMBytes`. Reclaim covers it, and the headroom target below is sized against it.
  - **Not from the cgroup pool.** Per-`Exec` VMs reuse cgroups from a free list written once with
    `memMax` = `PerVMBytes` (`remote-worker/internal/vmpool/cgroup_pool.go`). That is safe because a
    reused per-`Exec` cgroup inherits about 1 MiB of charge. A lease cgroup has a different
    `memory.max`, and host page cache charged to it stays charged after its VM exits, so handing it
    back would give a per-`Exec` VM up to about 256 MiB of inherited charge under a `PerVMBytes`
    bound. A lease VM therefore takes its cgroup out of the pool. It starts as a pooled standby, so
    when it becomes a lease VM the worker raises its `memory.max`, and when the lease ends the worker
    removes the cgroup instead of returning it. After removal, page cache still charged to it counts
    only against the parent slice until the host reclaims it, never against another VM's cgroup.
    Leases are few and long-lived (the pool exists for per-`Exec`'s create/destroy rate), so the cost
    is one `rmdir` and one fresh `mkdir` per lease. The plan that builds lease VMs (plan 2) carries
    this, with a test that a per-`Exec` VM after a lease starts with the pool's usual charge.
- **Headroom target.** `SH_LEASE_RECLAIM_FREE_MB` (default, v0.2: 2 × `PerVMBytes` + max(2 GiB,
  2 × (the lease charge bound above − `SH_LEASE_START_MB`)); about 4.9 GiB at 1 GiB guests
  (2 × 1056 MiB + 2 × (1640 − 192) MiB) and about 2.6 GiB at 256 MiB guests). Two per-`Exec` VMs always
  fit, and so does the growth of two busy lease VMs from their start estimate to their bound between
  samples, which reclaim cannot catch because a busy lease is never reclaimed. When MemAvailable falls below it, or an admission
  would go over the budget, the worker ends the lease **idle longest** (level 1 or 2 alike) with
  reason `memory_reclaim`. It repeats until it is back above the target. A lease with an Exec in flight
  is never reclaimed for memory.
- **Order when a lease Exec needs a VM** (no lease VM yet, or it just ended):
  1. admit a new lease VM at `SH_LEASE_START_MB`;
  2. if that does not fit, reclaim idle leases (idle-longest first) until it fits;
  3. if nothing idle is left, refuse with today's `memory-budget` error.

  There is no per-`Exec` fallback: a per-`Exec` VM is charged `PerVMBytes`, so it cannot fit where a
  192 MiB lease VM did not.

- **Guards unchanged.** `SH_HOST_MEM_FLOOR_MB`, the worker's cgroup `MemoryHigh`/`MemoryMax` and
  swap-off stay as the hard stops below reclaim.
- **No target-driven balloon in v1.** Free-page reporting (above) returns memory the guest freed. Memory
  the guest still holds, its own page cache included, stays until the lease ends or reclaim takes the
  lease. E17a found the guest cache small next to the freed peak (about 470 MiB cached against a
  1024 MiB peak after `analyze.py` and `pytest`). E17b measures what reporting leaves.

## 7. Level 2: tracked processes

New MCP tools, offered only when the mode is `lease+processes` (at other modes a call fails with
`processes not enabled for this sandbox; ask the user to run: mocactl sbx mode <id> lease+processes`):

| Tool            | Arguments                                                                            | Result                                                                          |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `process_start` | `command`, `cwd` (in the workspace, default `/workspace`), `name` (optional, unique) | `id`, `name`, `pid`                                                             |
| `process_list`  | —                                                                                    | id, name, pid, state (`running \| exited(code) \| killed(signal)`), age, memory |
| `process_logs`  | `id` or `name`, `tail` (default 200 lines)                                           | the last lines of combined stdout and stderr                                    |
| `process_stop`  | `id` or `name`, `signal` (default TERM, then KILL after 10 s)                        | final state                                                                     |

- A tracked process runs in its own guest cgroup under `tracked/`, in its own session, with stdin from
  `/dev/null`. Output goes to a ring log in the guest, capped per process (default 4 MiB).
- `SH_LEASE_MAX_PROCESSES` (default 4) caps the tracked processes of a sandbox, counting the running
  ones only.
- Later Execs reach a tracked process inside the guest: localhost ports, or sockets and files in the
  workspace. The guest still has no network interface, so nothing is reachable from outside. No port
  forwarding in v1.
- An exited process stays in `process_list` with its exit state until the lease ends, so the agent can
  read why it died.
- The `bash` tool description says that `&`, `nohup` and `setsid` do not survive the call, and that
  `process_start` does when the sandbox allows it.
- Audit: one record each for start, stop and exit, with id, name and the mode. No command text.

## 8. Control plane, tokens, relay and worker

### 8.1 Mode on the sandbox record

- `SandboxRecord` gains `mode: 'per-exec' | 'lease' | 'lease+processes'`, `idleTimeoutS` and
  `modeEpoch` (a counter, raised on each change).
- `POST /v1/sandboxes` accepts `mode` and `idleTimeoutS`. `PUT /v1/sandboxes/{id}/mode` changes
  them. Both need the owner's **user API token**. A sandbox token is never enough. Operator policy
  (`SH_SANDBOX_MODES_ALLOWED`) decides which modes a user may pick. Its default is `per-exec` until
  `docs/sbx/security-review.md` has its lease section (§11) and plan 4's live smoke test passes;
  then `per-exec,lease`. Level 2 stays off until the security review covers it. The worker has no
  opt-in of its own, so this list is the switch.
- Every change writes an audit record: who, old mode, new mode, epoch.

The routes, as built (plan 3; `docs/api/openapi.yaml`):

| Route                                | Takes                                                  | Answers                                                                      |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `POST /v1/sandboxes`                 | `mode` (default `per-exec`), `idleTimeoutS` (optional) | the sandbox, at epoch 0 for `per-exec` and epoch 1 for a lease mode          |
| `PUT /v1/sandboxes/{id}/mode`        | `mode` (required), `idleTimeoutS` (optional)           | `{sandbox, setModeToken}`: the sandbox at its new epoch, and a token for it  |
| `POST /v1/sandboxes/{id}/mode-token` | no body                                                | `{setModeToken}` for the mode and epoch the record holds now; raises nothing |

- **Owner only.** An admin calling either mode route on another user's sandbox gets the same 404 as
  anyone else, as with minting a sandbox token: a mode is what the owner's Execs may do. A sandbox
  token or a set-mode token is refused (401).
- **Every accepted `PUT` raises `modeEpoch` by 1,** the same mode included.
- **A lease create starts at epoch 1, a per-exec one at 0.** The worker serves every epoch-0 Exec as
  unversioned per-`Exec` (plan 2), so a lease at 0 could never be served. At 1, the worker serves it
  per-`Exec` until the first `set_mode` makes the workspace's epoch known (§8.2). The client sends
  that `set_mode` right after the create, with a token from `mode-token` (plan 4).
- **`per-exec` is always allowed,** whatever `SH_SANDBOX_MODES_ALLOWED` lists, so going back to it is
  never refused by policy. The list governs the lease modes. A mode it does not list is refused with
  403 `mode_not_allowed`.
- **`idleTimeoutS`** must be at least 30 and at most `SH_SANDBOX_IDLE_CEILING_S` (default 1800; a
  ceiling below 30 refuses to boot). Omitted, it is stored as 0, which means the worker's default
  (300 s, §4); a `PUT` that omits it stores 0, not the previous value. An explicit 0 is refused (400).
  It is accepted with `per-exec` too, where it has no effect.
- **The audit record** is `sandbox_mode_changed` with `fromMode`, `toMode` and `modeEpoch`. The old
  mode comes from the atomic update, not from an earlier read, so it is right under concurrent `PUT`s.
- **Narrowing the policy downgrades existing sandboxes at their next token mint.** Create and `PUT`
  check the policy, and so does every mint (a sandbox token, or `mode-token`), so the list stays the
  switch for sandboxes created before the change. A sandbox whose lease mode the list no longer
  names is set to `per-exec` through the same atomic update a `PUT` uses, which raises the epoch: the
  next Exec, carrying the new token, ends the live lease (a same-epoch re-issue would read to the
  worker as a retry, §8.2). It is audited as `sandbox_mode_changed` with `reason: mode_not_allowed`.
  Two mints racing may both downgrade, raising the epoch twice. An owner's `PUT` to a mode that is
  still allowed, landing between a mint's read and its downgrade, can be overwritten with
  `per-exec`; the owner sends it again. Both races are accepted, since the store has no
  conditional update. A lowered `SH_SANDBOX_IDLE_CEILING_S` clamps the `idle_timeout_s` claim of
  every token minted after it; the record and the epoch are unchanged, since the idle timeout
  travels on every Exec (ruling R12).

### 8.2 The mode reaches the worker in the token

- The sandbox token gains three claims, `mode`, `mode_epoch` and `idle_timeout_s` (the record's
  `idleTimeoutS`; 0 = the worker's default). The relay already verifies the token. It **sets**
  `Exec.mode`, `Exec.mode_epoch` and `Exec.idle_timeout_s` from the claims on every frame it routes,
  overwriting whatever the client sent. This is new: before plan 3 the relay only compared client
  fields to claims. The worker trusts only relay-set values.
  - A token without the claims (minted before them) reads as `per-exec`, epoch 0, idle 0. A malformed
    claim is refused, never read as the default.
  - The claim `per-exec` goes out as `SANDBOX_MODE_PER_EXEC` (1). Only the harness path sends
    `SANDBOX_MODE_UNSPECIFIED` (0): the relay zeroes all four lease fields on an Exec that carries the
    harness exec token, because the harness never uses leases. The worker serves both as per-`Exec`.
  - `Exec.keepalive` is the client's own opt-in (§4) and passes through.
  - A mode value a microVM worker does not know is refused as `lease_unsupported`, never served as
    per-`Exec`. The container tier, which has no lease mode, ignores the mode and serves every Exec
    per-`Exec`, an unknown value included; that direction never gives an Exec more than per-`Exec`.
  - The idle timeout reaches the worker only on an Exec: it is a setting of the lease the Exec starts
    or joins, and `set_mode` does not carry it.
- The worker keeps the highest `mode_epoch` it has seen for each sandbox. It **refuses an Exec with a
  lower epoch** (`stale_mode: <detail>`). Then a token minted before a downgrade cannot keep using a
  higher mode for its remaining 15 minutes. A `set_mode` at the stored epoch is a retry and succeeds;
  only a lower one is `stale_mode`.
- **The epoch survives a worker restart.** The worker writes it next to the workspace on the host
  disk (the workspace already survives a restart) and reads it back before serving. A missing or
  unreadable file fails closed. The sandbox runs `per-exec`, and **no Exec epoch can restore a higher
  mode**: with the file lost, a token minted before a downgrade would otherwise count as higher. Only
  a `LeaseControl set_mode` restores the mode. The control plane signs that call's mode and epoch
  (the record's current `modeEpoch`) under the sandbox token key with a distinct `typ`, so an Exec
  token cannot stand in for it. `mocactl` sends it on every mode change, and `mocactl sbx get` re-sends
  it when the worker reports an unknown epoch.
- **The set-mode token,** as built (plan 3):
  - `typ` `moca-sandbox-mode+jwt`, `aud` `moca-sandbox`, the sandbox token's issuer and signing key;
  - claims `sub`, `sbx`, `wrk`, `wsk`, `mode`, `mode_epoch`, `idle_timeout_s`, `iat`, `exp` and `jti`,
    every one required;
  - valid 300 s, and never past the sandbox's own expiry: it is sent once, right after it is minted;
  - minted by `PUT .../mode` (for the new epoch) and by `POST .../mode-token` (for the current one);
  - the relay verifies it against the same keyset as sandbox tokens, with the same 30 s clock
    leeway, and requires its `sbx`, `wrk` and `wsk` to equal the sandbox token's on the call. The
    `LeaseControlFrame`'s mode and epoch come from it alone. Every failure answers the same
    `PERMISSION_DENIED` message, so a client learns nothing about the token it holds; the reason goes
    to the audit line only.
- **A downgrade takes effect right away.** The `PUT` returns a set-mode token for the new epoch, and
  `mocactl` sends a `LeaseControl {set_mode}` call through the relay with it (authorized by any valid
  sandbox token for the sandbox). The worker applies the new epoch: from
  `lease+processes` to `lease` it stops every tracked process (notice, audit), and to `per-exec` it
  ends the lease (`mode_change`). An Exec in flight finishes first, bounded by `grace_limit`. The
  call returns once the lease has ended, and its status carries the `mode_change` end (§5).
- **An upgrade** takes effect from the next Exec that carries the new epoch.
- If `LeaseControl` cannot reach the worker, the downgrade still lands at the next Exec, and the lease
  idles out at worst. `mocactl` reports that the change is pending.

**As built (plan 4), `mocactl sbx`.** Result lines go to stdout, and notices and diagnostics to stderr
(P4-R15).

- **`create --mode M [--idle-timeout S]`.** A lease mode is an upgrade, so it needs a terminal on
  stdin: without one, `sbx: an upgrade needs a terminal: run it yourself`, exit 2, and nothing is
  created. After the create, `mocactl` mints a set-mode token from `POST .../mode-token` and sends
  `set_mode` once; on `PERMISSION_DENIED` it mints one more and retries once (ruling R11). It prints
  `mode <m> (epoch <n>)` on stderr. `UNAVAILABLE` or `DEADLINE_EXCEEDED` is pending, exit 0, with
  the warning
  `sbx: lease pending (<code>): the sandbox runs per-Exec until "mocactl sbx get <id>" re-sends the mode`.
  `--json` adds `setMode`: `{outcome: applied}`, `{outcome: pending, code}` or `{error}`. Ctrl-C
  during the `set_mode` is pending too (`cancelled`), exit 130 (P4-R12). A control plane that
  ignored the mode is named (P4-R13):
  `sbx: <id> is per-exec, not <m>: the control plane did not take the mode`.
- **`mode <mode> [ID] [--idle-timeout S]`.** It reads the record first, and refuses an upgrade
  without a terminal (exit 2) before the `PUT`. The `PUT` keeps the record's `idleTimeoutS` unless
  `--idle-timeout` is given. If that kept value is refused (400 `invalid_request`, a lowered
  ceiling), it retries once without it and says so on stderr (P4-R18). Then it sends the `PUT`'s
  set-mode token. Applied, it prints `mode <m> (epoch <n>)`, and `lease ended (mode_change)` when a
  downgrade ended a live lease. Pending, it exits 0 and prints
  `mode <m> stored (epoch <n>); the worker could not be reached (<code>): it applies at the next command`.
  Ctrl-C prints the same with `cancelled` and exits 130. In a repository bound to the sandbox
  (`.sbx/sandbox.json`), a change of the agent rules (per-exec to a lease mode, or back) adds
  `run "mocactl sbx up" to update the agent rules` on stderr: nothing rewrites the block `up`
  wrote, and `sbx doctor` checks it against the record's mode.
- **`get [ID] [--json]`** shows the record's mode, epoch and idle timeout, and the lease from
  `LeaseControl status` (a `per-exec` record makes no call: `none (per-exec)`). When the worker
  answers `epoch_known: false`, it mints a fresh set-mode token, sends it, and says
  `re-sent mode <m>: applied` on stderr, or `create`'s pending line. `--json` adds `setMode`, as
  `create --json` does: the outcome, or `{error}` when the send failed (exit 1).
- **`ls`** shows each sandbox's mode.

**As built (plan 4), the worker's state files.** Every worker writes `.lease-state/.boot`
(`lease=on` or `lease=off`) under its workspace root, a lease-off one too. A lease-on boot after
`lease=off`, or with no marker, sets `root_wrote` on every known state before it serves, because a
lease-off worker records no per-`Exec` root writes (§3.3; P4-R4). The janitor removes
`.lease-state/<wsk>.json` with a deleted sandbox's workspace, and also when the worker already
reclaimed that workspace (P4-R3). A kept state is written back only while its file exists, so a file
the janitor removed is not recreated, by the workspace's removal or by a lease's end.
`deploy/sbx/install-host.sh` deletes `.lease-state/.boot` at every worker install, before the
worker restarts (symlink-safe: a symlinked `.lease-state` is refused). A worker from before this
marker never writes `lease=off`, so after a rollback past plan 4 the marker could still say
`lease=on`; the forward install clears it, and the first new boot marks every known state
`root_wrote`, conservatively. So a rollback followed by a forward install is safe. A rollback alone,
done with an older `install-host.sh`, leaves the marker, and the next forward install clears it
(RUNBOOK §2).

**As built (plan 4), the deploy inputs.** `deploy/sbx/setup.sh` takes `SBX_MODES_ALLOWED` (default
`per-exec`: lease stays off) and `SBX_IDLE_CEILING_S` (default 1800). They become the control
plane's `SH_SANDBOX_MODES_ALLOWED` and `SH_SANDBOX_IDLE_CEILING_S`, and the ceiling also goes into
every worker bundle as `SH_LEASE_IDLE_CEILING_S`, so the control plane and the workers clamp alike.
The ceiling's minimum there is 300 s, not the control plane's 30, because the worker refuses to boot
with a ceiling below its 300 s default idle timeout (P4-R19); its maximum is 86400 s. When
`SBX_MODES_ALLOWED` names a lease mode, the janitor's wait must exceed the token lifetime plus 30 s
plus the ceiling: a token minted just before a delete reaches the sandbox that long, and each of its
Execs restarts the idle clock, so the sandbox's last lease ends before the janitor frees its
workspace.

### 8.3 New calls on `sandbox/v1` (additive)

| Call                                                                                     | Sent by                                                                                                               | Purpose                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `LeaseKeepalive {sandbox_id}`                                                            | the MCP server, every 30 s while the harness runs (opt-in, §4)                                                        | §4 keepalive                                 |
| `LeaseControl {sandbox_id, op: set_mode \| reset \| status, set_mode_token}`             | `mocactl` (`set_mode`, `reset`, `status`), the MCP server (`status` for `sandbox_info`, `reset` for the `reset` tool) | §8.2, §4, §5                                 |
| `Exec.kind` = `command \| process_start \| process_list \| process_logs \| process_stop` | the MCP server                                                                                                        | §7, keeping one authorization and audit path |

All of them carry the sandbox token, and the relay routes them like `Exec`. `set_mode` also carries
the set-mode token (§8.2), which the relay checks before anything reaches the worker.

- **`reset`** is both an MCP tool and `mocactl sbx reset <id>`. It ends the lease (`reset`). The
  agent may call it: it can only lower what survives.
- **`mocactl sbx get`** shows the stored mode, and the live lease state from `LeaseControl status`.

**On the wire (plan 3).** `LeaseControl` answers a `LeaseStatus {mode, epoch_known, state, age_ms,
idle_timeout_s, pending}`, read after the op; `pending` is the unacknowledged event (§5). The relay
sends the worker a `ServerFrame.lease_control` with a `ctl_id`, the token's workspace and, for
`set_mode`, the set-mode token's mode and epoch, and the worker answers a `WorkerFrame.lease_result`
under that `ctl_id`. `LeaseKeepalive` becomes a `ServerFrame.keepalive` with no answer.

- **Who may call them:** a sandbox-token caller only, on its own worker (`sandbox_id` equal to the
  token's `wrk`) and its own workspace (the token's `wsk`, which the relay fills in). The harness
  exec token is refused: the harness never uses leases. A workload sandbox refuses both, as it
  refuses an Exec that names no workload (SBX0 §3.3).
- **At most 4 `LeaseControl` calls in flight per sandbox** at the relay. A fifth is refused at once.
  A client that cancels its call frees its place at once; the worker's late answer is then dropped.
- **Per-op timeouts at the relay:** 15 s for `status`, and 31 minutes for `reset` and `set_mode`
  (the worker's 30-minute `grace_limit`, for which ending a lease can block, plus 60 s). A worker on
  code older than lease mode ignores the frame, so its silence ends at this timeout, never in a hung
  call.
- **`LeaseKeepalive` is fire-and-forget.** The relay answers OK once the caller checks pass, even
  with no worker attached or when the frame cannot be written to it; on the worker it is a no-op
  without a live lease. It is not audited, since a client may send one every few seconds.
- **The worker** runs lease calls off its receive loop and its Exec slots. It runs at most 16
  `reset` and `set_mode` calls at once across every sandbox it serves, and at most 2 per workspace;
  past either cap it answers `busy: too many lease calls in flight`. A `status` counts against
  neither cap, so one sandbox's blocked calls cannot deny another's `status`. The container tier
  has no lease mode and answers every `LeaseControl` with
  `lease_unsupported: this worker has no lease mode`.
- **One audit line per `LeaseControl`,** marker `sandbox_lease_control`, refusals included (a call
  with no bearer token is a `refused` line with the reason `no bearer token`): `wrk`, `op`, `ms`,
  `outcome`, a `reason` when there is one, `sub` and `sbx` once the sandbox token verified, and for
  `set_mode`, once its set-mode token verified, `mode` and `modeEpoch`. Like every SBX record, it has
  no command text. A relay with no sandbox keyset, which can verify no sandbox token, answers
  `UNAUTHENTICATED` without a line, as it does for `Exec` and `Abort`.

| `LeaseControl` ends with | When                                                                                                    | Audit `outcome` |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------- |
| OK                       | the worker answered without an error                                                                    | `ok`            |
| `FAILED_PRECONDITION`    | the worker answered with an error; the message is its wire string                                       | `failed`        |
| `UNAUTHENTICATED`        | no sandbox token, or one that did not verify                                                            | `refused`       |
| `PERMISSION_DENIED`      | `sandbox_id` is not the token's worker; the harness token; a set-mode token refused; a workload sandbox | `refused`       |
| `INVALID_ARGUMENT`       | no `op`, or one this relay does not know                                                                | `refused`       |
| `RESOURCE_EXHAUSTED`     | `sandbox busy: <n> lease controls already in flight`, checked before the set-mode token                 | `busy`          |
| `DEADLINE_EXCEEDED`      | only the per-op timeout: the worker did not answer in time                                              | `timeout`       |
| `UNAVAILABLE`            | no live worker, the frame could not be written, or the worker disconnected first                        | `error`         |
| `CANCELLED`              | the client cancelled the call before the worker answered                                                | `cancelled`     |

The worker's wire strings, on an Exec's `ExecError.message` or in `LeaseControlResult.error`:
`lease_ended(<reason>)` for an Exec cut by a lease end (§4, §4.1), `stale_mode: <detail>` for an
older epoch (§8.2), `lease_unsupported: <detail>` for a worker or a mode without leases, and `busy:`
for a refusal at the worker's own cap.

**As built (plan 4).**

- **`LEASE_OP_SANDBOX_DELETED = 4`** ends the lease with `sandbox_deleted`. It takes no mode and no
  epoch; the relay ignores a set-mode token sent with it. At the relay it is a mutate op like
  `reset`: the 31-minute timeout, the same cap of 4 in flight, and a `sandbox_lease_control` line
  with `op` `sandbox_deleted`. `mocactl sbx rm` reads the record first (P4-R16) and, for a lease
  mode, sends it before the `DELETE`. It is best-effort: any failure, or 15 s without an answer,
  and the `DELETE` goes ahead. The 15 s bound covers the whole step: the record read, the token
  mint and the call. Ctrl-C during it deletes nothing (exit 130).
- **Keepalives are coalesced.** The relay writes at most one keepalive frame per workspace to each
  worker per second (`LEASE_KEEPALIVE_COALESCE_MS`). The others are answered OK and not written.
- **`mocactl sbx mcp` sends the keepalive.** While its current sandbox token's `mode` claim is a
  lease mode, it sets `Exec.keepalive` and calls `LeaseKeepalive` every 30 s. A token minted for
  `per-exec` stops both (ruling P4-R6). `mocactl sbx run` and the static client send no keepalive.
- **`reset`.** `mocactl sbx reset [ID]` asks for the status first, and prints `no lease` when there
  is none; with a `per-exec` token it makes no call and prints the same. Otherwise it prints
  `lease ended (reset)`. The MCP `reset` tool answers `no lease to reset`, or
  `lease ended (reset): the next command starts a new guest`.
- **The worker caps `status` too:** at most 32 in flight per worker, apart from the two mutating
  caps, refused `busy:` at once past it. A `status` still takes no mutating slot, so blocked
  `reset` and `set_mode` calls cannot deny it.
- **`SH_LEASE_GRACE_S` above 1800 refuses to boot.** A `reset` or a downgrade can block for the
  grace limit, and the relay times them out at 31 minutes.
- **The static client** (`remote-worker/cmd/sbx`) exits 125 on `stale_mode:` and
  `lease_unsupported:`, with the wire string, and never retries them.
- **The TS exec client** (`@moca/sandbox-client`, which `mocactl` and its MCP server use) retries a
  `stale_mode:` refusal once, under a forced fresh token and a new `req_id`, as it retries a token
  refusal: nothing ran, and the fresh token carries the new epoch. A second `stale_mode:` is
  surfaced. `lease_unsupported:` is never retried.

### 8.4 Worker

- A **lease** is a new state of a run, beside standbys: `RunActive` with a held VM. The idle sweep
  (`runpool.go`) ends leases at `idle_timeout`. The sweep interval has to be short enough for that
  (for example `min(StandbyIdle, idle_timeout)/4`). The builder reconciles lease timeouts with
  `StandbyIdle` and `WorkspaceIdle`. A lease must never outlive its workspace.
- `pool.Exec` gets a lease path: when the forwarded mode is `lease*` and the sandbox has a lease VM,
  it runs the Exec in that VM. Otherwise it acquires a standby as today and, in a lease mode, keeps the
  VM as the lease after the command instead of destroying it.
- Clock correction runs on every Exec in a lease, as the guest agent already allows
  (`shouldSetClock`). A guest that idles for minutes drifts.
- A worker restart ends every lease (`worker_restart`). The workspace survives a restart as it does
  today, but not the loss of the host.

### 8.5 Naming

`harness/src/sandbox-lease.ts` already uses "lease" for the harness's run lease. In code, this
feature is the **VM lease** (`vmLease`, `LeaseEvent`, `SH_LEASE_*`). The builder keeps the two
apart.

## 9. Gates

`TestGateNoVMReuse` and the other per-`Exec` gates stay as written and run in `per-exec` mode. Lease
mode gets its own gates, real-launcher halves on KVM, fake-launcher halves in CI:

| Gate                              | Property                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestGateLeaseOneSandbox`         | A lease VM never serves a second sandbox, workspace key or owner, and never goes back to the standby pool                                                                                                                                                                                                                                                                                                                                                                        |
| `TestGateLeaseExecKillsProcesses` | After each Exec at both levels, nothing it started is alive: `&`, `nohup`, `setsid`, double fork, a daemon. `process_start` processes at level 2 are the only survivors                                                                                                                                                                                                                                                                                                          |
| `TestGateLeaseFreshShell`         | `export`, `cd`, `alias` and shell functions from one Exec are not visible in the next                                                                                                                                                                                                                                                                                                                                                                                            |
| `TestGateLeaseTeardown`           | Each end reason destroys the VM and leaks no cgroup, tap, vsock or jail on the host (the lease variant of `TestGateLeakFreeTeardown`)                                                                                                                                                                                                                                                                                                                                            |
| `TestGateLeaseStaleEpoch`         | An Exec with an older `mode_epoch` is refused, and a downgrade stops tracked processes. After the epoch file is lost, an Exec on a stale `lease+processes` token runs `per-exec`, and only a signed `set_mode` restores the mode                                                                                                                                                                                                                                                 |
| `TestGateLeasePrivilege`          | In a lease, an Exec that tries to write another cgroup's `cgroup.procs`, create a cgroup, signal or ptrace PID 1, write `/proc/1/mem`, regain root through a setuid binary, or create a user namespace fails, and every process it started still dies at the end of the Exec. At level 2, an Exec that tries to `ptrace`, `process_vm_writev`, write `/proc/<pid>/mem` of, or signal a running tracked process fails, and the tracked process's memory and command are unchanged |
| `TestGateLeaseOwnership`          | After `lease` → `per-exec` (root writes a file and a directory) → `lease`, the first lease Exec can modify both. A symlink in the workspace pointing at a file in `/tmp` leaves that file's owner unchanged. A lease after a lease with no per-`Exec` period between them does not walk the workspace                                                                                                                                                                            |
| `TestGateLeaseNotice`             | Every end reason produces exactly one notice, on the next response and in `sandbox_info`                                                                                                                                                                                                                                                                                                                                                                                         |
| `TestGateLeaseReclaim`            | Under a budget squeeze the idle-longest lease goes first, and busy leases are never reclaimed for memory. When a new lease VM does not fit, the worker reclaims idle-longest leases, then refuses with `memory-budget`                                                                                                                                                                                                                                                           |
| `TestGateLeaseSecrets`            | Nothing secret is written into a lease guest (the lease variant of `TestGateSnapshotHoldsNoSecrets`: the snapshot gate assumed per-call teardown)                                                                                                                                                                                                                                                                                                                                |

## 10. Validation: E17

E17 is a separate spec in moca-experiments (`e17/SPEC.md`). In summary:

- **E17a, before the build:** the E15/E16 rig with the E15 resident patch and short idle timeouts,
  plus a cache-heavy Python workload. It answers early whether level 1 pays.
- **E17b, after the build:** the shipped lease mode with measured admission, reclaim and notices, at
  the default and low-duty points and a memory-squeeze point.

Pass criteria (sealed in `e17/predictions.json`, 2026-11-12; E17 v0.5):

1. **Capacity.** Lease (300 s) `N_max` ≥ per-`Exec` `N_max` at the default point (E15 metal: 128
   against 80, reused). At low duty E16 stands (a tie).
2. **Latency (per class, E17 v0.4).** At `pycache` N = 1 and N = 128, the median warm short command,
   stack import and venv grep are each at least 50% faster than per-`Exec`; compute is reported. E17a
   predicts this fails on the import (40%) and the grep (§17). An E17a miss goes to the user before
   the build.
3. **Reclaim.** At the squeeze point, no memory guard trips, no OOM kill, no refused Exec while an idle
   lease existed, and every reclaim has its notice.
4. **Notices.** Every lease end in every E17b rung reaches the client with the right reason.

## 11. Security

What changes against per-`Exec`, and what bounds it:

| Change                                                                                                                                                     | Bound                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files in the guest's tmpfs (`/tmp`, `/var`) last for the lease, so an injected command can leave a file that a later command uses. The rootfs is read-only | `idle_timeout`, `max_duration`, `reset`; the guest has no network; the same owner and the same sandbox only (`TestGateLeaseOneSandbox`)                                                                                                                                                                 |
| At level 2 a process can survive and keep working between Execs                                                                                            | Only through `process_start`, which is visible in the tool call, in `process_list` and in the audit. Level 2 is off by operator policy until the review. Tighter `max_duration` (4 h). `grace_limit`. `SH_LEASE_MAX_PROCESSES`                                                                          |
| An agent could try to raise the mode                                                                                                                       | No MCP tool changes the mode. A change needs the user API token, which the MCP server does not expose to the harness. **Residual:** if the user lets the harness run local shell commands, the agent could run `mocactl sbx mode` itself. `mocactl sbx mode` therefore refuses an upgrade without a TTY |
| Memory charged by measurement, not reserved                                                                                                                | Reclaim, the host-memory floor, cgroup limits, swap off; E17's squeeze point                                                                                                                                                                                                                            |
| Clock drift in a long-lived guest                                                                                                                          | Clock correction on every Exec                                                                                                                                                                                                                                                                          |
| An Exec could tamper with its own teardown (cgroup migration, the agent) or inject into a tracked process                                                  | Unprivileged Exec uid, a separate uid per tracked process, no capabilities, `no_new_privs`, a seccomp filter on `ptrace` and `process_vm_*`, root-owned cgroup tree, non-dumpable agent, setuid bits stripped, no user namespaces (§3.3, `TestGateLeasePrivilege`)                                      |
| A tracked process runs code it loads from the workspace (a dev server with hot reload), so a later Exec can change what it runs by editing files           | Accepted. The workspace is the channel the agent works through. The strict rule bounds which _processes_ exist and are visible, not what code a visible process loads. `process_list` shows each tracked process; `process_stop` and `reset` end it                                                     |

The security review of SBX0 (`docs/sbx/security-review.md`) gets a lease section before level 1
reaches the cohort, and a level-2 section before level 2 is allowed by policy.

## 12. ADR

ADR-0035's 2026-10-08 revision decided that per-`Exec` is the tier's only mode, for product reasons
(resident sandboxes are what hosted providers already sell), and decided #274 against VM reuse. The
2026-11-05 assessment and E15/E16 change two of its inputs:

- the organization must run its own sandbox service, so a hosted resident provider is not an option for
  internal users;
- at normal duty, resident with an idle timeout holds more sessions than per-`Exec` (E15 metal).

ADR-0048 records: per-`Exec` stays the default and keeps all its guarantees. Lease mode is a separate,
opt-in mode with the gates of §9, chosen per sandbox by its owner. ADR-0035 gets a 2026-11 revision
that points to ADR-0048. The read-coalescing exception in ADR-0035 is unaffected.

## 13. Testing

- **Control plane (vitest):** mode on create and `PUT`; owner-only; user token required (a sandbox
  token is refused); policy refuses disallowed modes; `modeEpoch` raised on each change; token claims;
  audit records.
- **`sandbox-client` / `mocactl` (vitest):** `process_*` tools offered by mode; the refusal text; the
  notice line on the next result; `sandbox_info` fields; keepalive start and stop with the MCP server;
  `mocactl sbx mode` (TTY rule for upgrades), `reset` and `get`; the pending-downgrade message.
- **Relay (vitest):** `mode` and `mode_epoch` set from the token's claims, a client-sent value overwritten; `LeaseKeepalive` and `LeaseControl`
  routing; token checks the same as `Exec`.
- **Across components (vitest, `lease-wire.transport.test.ts`):** the control plane's own handlers
  create the sandbox, change its mode and mint both tokens; the relay carries them to a fake worker.
  A lease create's claims reach the Exec at epoch 1, a mode change raises the epoch, `set_mode`
  carries the new one, and a token minted before the change still reaches the worker at its old
  epoch, whose `stale_mode` refusal reaches the client.
- **Worker and guest agent (Go):** the gates in §9; the lease state machine with the fake clock (every
  transition and every end reason); measured charge and reclaim order; reclaim, then refuse with `memory-budget`; the
  per-Exec cgroup kill, including `D`-state handling and `teardown_failed`; the privilege drop (Exec uid,
  per-tracked-process uids, capabilities, `no_new_privs`, the seccomp filter, non-dumpable agent); the
  ownership walk (the `root_wrote` flag, no symlink following, staying on the workspace mount).
- **Live (`SBX_LIVE_SMOKE=1`, KVM):** create in `lease`, run two commands and see a warm second run,
  idle out and see the notice; switch to `lease+processes`, `process_start` an HTTP server, reach it with
  `curl localhost` in a later Exec, downgrade and see it stopped.

## 14. Scope — explicitly not building

- Memory snapshot, suspend or resume of a lease. A lease that ends loses its memory.
- A target-driven Firecracker balloon (inflating it to take memory back). Free-page reporting is in
  v1 (§6).
- Port forwarding to the laptop, PTYs, interactive processes, stdin to a tracked process.
- Concurrent Execs in one sandbox.
- Lease mode for the MOCA harness's own P4 path (`harness/src/sandbox-lease.ts`). SBX sandboxes only.
- Multi-host placement or moving a lease between workers.
- Leases on the container tier.
- Making lease mode the default. A later decision, after E17 and cohort use.

## 15. Alternatives considered

- **Resident for the sandbox's life, no idle timeout.** Holds memory through 98% idle time at real
  duty cycles, with no gain over a 300 s timeout in E15. Rejected.
- **Keepalive resets idle.** An open harness with the user away would hold a VM indefinitely. Rejected
  (§4).
- **Level 2 keeps anything the agent detaches.** Matches agent habits (`npm run dev &`), but an
  injected `bash` command could then leave a process running unnoticed. Rejected for the strict
  `process_start` rule (user decision).
- **End an expiring lease at the deadline.** Kills a dev server mid-use. Rejected for "next idle, with
  a hard grace limit" (user decision).
- **Protect idle level-2 leases from reclaim.** Lets a few long-lived leases starve the host. Rejected
  (user decision).
- **Full guest RAM charge for lease VMs.** Safe, but caps lease VMs near 350 per host against a
  measured 150 MiB median. Rejected for measured charge with reclaim (user decision).
- **The mode fixed at create.** Simpler for audit, but forces users to choose level 2 up front.
  Rejected (user decision).
- **An agent tool to change the mode.** Lets a prompt injection raise the mode. Rejected (user decision).
- **Adopt Agent Substrate or SPACE for leases.** Still open as the assessment's Phase 3b. The backend
  interface in the MCP client (assessment recommendation 6) keeps that path open. Not a blocker for
  this spec.

## 16. Open items

1. **Guest image: a `cgroup2` mount in init (kernel already sufficient).** Checked 2026-11-08 on the
   SBX0 KVM host (worker `sbx_default`, snapshot `default-p41-ca-gh`, built 2026-10-29). The guest
   kernel is `6.18.51+`, and its embedded config has `CONFIG_CGROUPS`, `CONFIG_MEMCG`,
   `CONFIG_CGROUP_PIDS` and `CONFIG_CGROUP_FREEZER`. It carries the `cgroup2` filesystem and
   `cgroup.kill` (kernel ≥ 5.14). The E15/E16 rig pins `vmlinux-6.18.44` (moca-experiments
   `e15/rig/pins.sh:46`). No kernel change is needed. What remains is mounting `cgroup2` in the guest
   init (`build-snapshot.sh:604-610`). That changes the rootfs and so the snapshot hash for per-`Exec`
   too. Per-`Exec` behaviour does not change, but each host rebuilds its snapshot once. User
   namespaces are not disabled in init: the agent disables them at the first lease request, so a
   per-`Exec` VM keeps them.
2. **Done (plan 1).** **The snapshot manifest's `kernel_release` is the host's, not the guest's.** `build-snapshot.sh:1803`
   writes `$(uname -r)` of the build host (`6.8.0-1061-nvidia` on SBX0). The guest kernel is
   identified only by `kernel_sha256`. Recording the guest's release is a small fix that the image work
   in item 1 can carry.
3. **SBX0 guests have 256 MiB of RAM**, not E15/E16's 1024 MiB (`guest_ram_mb` in the same
   manifest). There, `PerVMBytes` is already small, so measured admission gains less than E17 shows at
   1 GiB, and a cache-heavy lease VM reaches its guest RAM sooner. E17 reports its memory results at
   both sizes (E17 §6).
4. **Per-`Exec` under the same unprivileged uid.** §3.3 keeps per-`Exec` as root in v1. Moving it to
   the Exec uid would give one guest model and one workspace ownership. The security review decides.
5. **Free-page reporting support (v0.2; checked 2026-11-12).**
   - **Firecracker v1.17.0** (pinned by P4 and by the E15 rig; also what the SBX0 host runs) has it:
     `"free_page_reporting": true` on `PUT /balloon`. Reported ranges are `madvise(MADV_DONTNEED)`d.
     It carries no preview label. Free-page _hinting_ is a developer preview with a documented
     memory-corruption race, and v1 does not use it (`docs/ballooning.md` at v1.17.0).
   - **Guest kernels:** the SBX0 kernel (6.18.51, the `default-p41-ca-gh` snapshot) and the E15 rig's
     (`vmlinux-6.18.44`) both build in `CONFIG_VIRTIO_BALLOON`, `CONFIG_MEMORY_BALLOON`,
     `CONFIG_PAGE_REPORTING` and `CONFIG_BALLOON_COMPACTION` (embedded config read on both hosts). No
     kernel change.
   - **It can only be enabled before boot.** A restored VM has the devices of its snapshot, so the
     balloon has to be in the golden snapshot. That changes `vmstate` for every VM, per-`Exec` included.
     Per-`Exec` VMs would then report too: that frees their memory sooner, and a reused free page faults
     back in from the memory file. **Decided (user, 2026-11-12): one golden snapshot with the balloon,** for every mode. Per-`Exec` VMs report too, and their latency was checked against a snapshot without the balloon (2026-11-12, `sbx` worker, rounds A B A B): `true` 83 → 85 ms median (n = 80), `python3 -c pass` 103 → 103 ms, touching 256 MiB 403 → 403 ms. No measurable cost.
   - **Restore backend.** VMs restore with the `File` backend (`build-snapshot.sh:2092`): a
     `MAP_PRIVATE` mapping of the memory file, with written pages copy-on-write anonymous memory. A
     reported range then drops its private copy and falls back to the shared memory file. The host gets
     the memory back, and the free page's contents are of no concern to the guest (no page poisoning:
     `CONFIG_INIT_ON_FREE_DEFAULT_ON` is not set).
   - **Restored VMs keep reporting (tested 2026-11-12, E15 rig).** A test snapshot was built with
     `PUT /balloon {"amount_mib":0,"deflate_on_oom":false,"free_page_reporting":true}` before
     `InstanceStart` (one added line in `build-snapshot.sh`). It was restored by the worker with the
     `File` backend, beside a control snapshot without the balloon. In each, a guest process touched
     700 MiB and exited, and the VM cgroup's `memory.current` was read:

     | After the process exited | Control (no balloon) | Free-page reporting |
     | ------------------------ | -------------------- | ------------------- |
     | before the allocation    | 13 MiB               | 13 MiB              |
     | at exit                  | 734 MiB              | 734 MiB             |
     | +5 s                     | 734 MiB              | 227 MiB             |
     | +15 s, +30 s, +60 s      | 734 MiB              | 81 MiB              |

     The guest saw the balloon (`virtio_balloon` bound, `page_reporting_order` 9, that is 2 MiB
     blocks). Both guests showed about 890 MB free afterwards, so only the host side differed. Nothing
     is open for plan 2 here.
6. **Level 2 is the latency case (v0.2; sized 2026-11-12).** E17a shows what a warm guest saves without
   process state: the VM start and the interpreter start-up, not the work. A spike on the E15 rig
   sized level 2 with one persistent Python server, standing in for `process_start` because the
   resident patch kills nothing. It ran on E17a's workspace (256 MiB of CSV, 6.0 M rows), and the
   same queries ran per-`Exec` and at level 1:

   | Query                                            | Per-`Exec` | Level 1      | Level 2           |
   | ------------------------------------------------ | ---------- | ------------ | ----------------- |
   | Re-query: group means + one median over all rows | 6.5 s      | 5.4 s (−17%) | **0.25 s (−96%)** |
   | Recompute: KMeans on the 200k-row sample         | 17.4 s     | 16.5 s (−5%) | **11.2 s (−36%)** |

   The server paid the import and parse once (5.4 s to ready) and held about 500 MB of a 1 GiB guest.
   That memory is live, so free-page reporting cannot return it: a level-2 lease is charged its working
   set, and guest RAM bounds how much state a tracked process can keep. A first run that took
   quantiles over all six columns was OOM-killed in the guest, the server included. Level 2's
   `memory_reclaim` and OOM notices (§5) are therefore not corner cases. Results: moca-experiments
   `e17/results/followups/`.

## 17. E17a findings (v0.2)

From moca-experiments `e17/` (spec v0.5, predictions sealed 2026-11-12, results in
`e17/results/calibration/v0.4/`). E17a uses the E15 resident patch as the lease stand-in, at N = 1 on
the E15 metal host (m7i.metal-24xl, 1024 MiB guests), on a synthetic cache-heavy Python session: per
turn `analyze.py` (256 MiB CSV, KMeans), `pytest` (~60 s of numeric tests), a stack import, a `grep -r`
over the venv, two to five short commands and `analyze.py` again, at 9.5% duty.

| Command class           | Per-`Exec` median | Warm lease median | Gain | Why                                                                         |
| ----------------------- | ----------------- | ----------------- | ---- | --------------------------------------------------------------------------- |
| Short (`grep`, `sed`)   | 53 ms             | 6 ms              | 89%  | A VM start is most of its cost                                              |
| Stack import            | 755 ms            | 454 ms            | 40%  | ~450 ms is Python unpacking and initialising the stack; no cache removes it |
| `grep -r` over the venv | 1960 ms           | 2000 ms           | −2%  | See below                                                                   |
| `analyze.py`            | 15.6 s            | 14.4 s            | 8%   | Compute                                                                     |
| `pytest`                | 61.2 s            | 61.0 s            | 0%   | Compute                                                                     |

- **Per-`Exec` already gets a warm cache from the host.** A per-`Exec` VM reads the workspace through
  the host page cache, so its later greps took 388 ms against 2.2 s for the first touch of a fresh
  workspace. A warm lease guest took 112 ms (medians of the 20-call class probes, E17 calibration). The lease's cache gain is that difference, not the cold
  read.
- **A lease keeps a file set warm only across a whole turn.** On the corpus's think gaps (median
  18 s, p90 234 s), 32% of greps ran in the guest that ran the previous grep. 25% were the first grep
  of the workspace (2 s in both modes), and 43% ran in a guest that replaced one ended by the idle
  timeout.
- **Those 43% paid the cold read again.** The ended guest had filled its 1024 MiB cgroup, which left no
  room for the host's cache of its workspace (§6). In a check where the ended guest had run only two
  greps, its successor's grep took 0.49 s.
- **Lease VMs filled guest RAM after one heavy command.** Every lease VM peaked at 1023.98 MiB; the
  guest still had about 800 MiB available, because the peak was memory the guest had freed. That is
  what free-page reporting returns (§6).
- **Capacity at the default point is unchanged:** E15 metal, per-`Exec` 80, lease (300 s) 128. That
  workload's VMs stay near 150 MiB; on cache-heavy workloads without free-page reporting, a lease is
  charged about its full guest RAM.

**At N = 128 (2026-11-12) the picture holds:** short commands 0.91, import 0.42, grep 0.01, `analyze.py`
0.09, `pytest` 0.02. Neither arm's rung holds: heavy calls ran 10–20% slower than at N = 1 in both
modes at about 15% host CPU. 79% of lease VMs peaked above 900 MiB. Criterion 2 therefore fails at
both N, as E17a predicted, and E17a misses (moca-experiments `e17/results/E17A-REPORT.md`). The
revisions in v0.2 follow from these findings and are tested in E17b.
