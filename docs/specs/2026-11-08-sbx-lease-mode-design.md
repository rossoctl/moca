# SBX0.3 — Lease mode for `mocactl sbx` sandboxes — Design

Version: 0.1 — November 8, 2026 (draft for review)
Status: Design. Not approved. Nothing is built.
Milestone: **SBX0.3**, an increment of [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md),
to be registered in [the milestone registry](README.md).
Decision record: a new ADR (ADR-0048, to be written) that revises
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
   process survives the end of its Exec.** Files outside the workspace survive until the lease ends.
4. In `lease+processes` mode, a process started through `process_start` survives between Execs. A
   process started any other way (`&`, `nohup`, `setsid`, a daemon that forks itself) dies at the end
   of its Exec, exactly as in level 1.
5. A lease ends on an idle timeout, at the maximum duration (when the sandbox is idle, or at the hard
   grace limit), on `reset`, on a mode downgrade, on memory reclaim, on heartbeat loss, or on a worker
   restart. After any end, the next Exec starts a cold guest on the same workspace.
6. **No lease end is silent.** The next tool result and `sandbox_info` give the reason. At level 2
   they also list the tracked processes that were stopped. Every lease end has an audit record.
7. Lease VMs are admitted on measured memory. Reclaim keeps the host above a headroom target, and the
   existing physical guards never trip in E17's memory-squeeze point.
8. E17 meets its pass criteria (§10).

## 2. Decision summary

| Topic | Decision | Source |
|---|---|---|
| Levels | Two opt-in levels over per-`Exec`: `lease` (warm guest, processes killed at the end of each Exec) and `lease+processes` (tracked processes survive) | user |
| Level 1 | Processes are killed at the end of each Exec. Keeping processes is an explicit property, never a side effect | user |
| Level 2 survivors | Only processes started through `process_start` (strict rule) | user |
| Idle | Measured from the last Exec end. A keepalive never resets it | our call |
| Idle timeout | Default 300 s, owner-settable up to an operator ceiling | our call (E15 resident-300) |
| Keepalive | The MCP server sends one while the harness runs. Loss for 120 s ends the lease | our call |
| Maximum duration | Reaching it marks the lease **expiring**. It ends at the next idle, or at the hard grace limit | user |
| Memory pressure | Reclaim the lease idle longest, level 1 or 2 alike, and notify | user |
| Admission | Lease VMs are charged measured memory. Reclaim is the safety net | user |
| Balloon | Not in v1. Measured in E17 | user |
| Mode switch | On a live sandbox, by the owner, through `mocactl` only. The agent gets no tool for it | user |
| Default mode | `per-exec` | user (assessment Phase 1) |
| Experiment | E17, a separate spec in moca-experiments | user |

## 3. Modes

| | `per-exec` | `lease` (level 1) | `lease+processes` (level 2) |
|---|---|---|---|
| Guest across Execs | fresh each time | the same guest until the lease ends | same as level 1 |
| Page cache, CPU caches | cold | warm | warm |
| `/tmp`, files outside the workspace, system-wide installs | lost | kept until the lease ends | kept until the lease ends |
| Shell state (env, cwd, functions) | n/a | **not kept**: each Exec gets a fresh shell | not kept |
| Processes after an Exec | none | none: killed at the end of the Exec | only `process_start` processes |
| Workspace | persists | persists | persists |
| `process_*` tools | refused | refused | available |

**One lease VM serves one sandbox, for its whole life.** A lease VM is never handed to another
sandbox, another workspace key or another owner. When a lease ends its VM is destroyed. It never goes
back to the standby pool.

**Execs stay serial for each sandbox**, as today. `process_*` calls are Execs for that rule.

### 3.1 Killing processes at the end of an Exec

**Prerequisite (guest image).** This needs cgroup v2 with `cgroup.kill` in the guest: kernel 5.14 or
later with cgroup v2 enabled, and a `cgroup2` mount in init. The current init mounts none
(`build-snapshot.sh:604-610`). See §16.

The guest agent runs each Exec in its own cgroup v2 inside the guest. At the end of the Exec, whether
it exits, times out or is aborted, the agent writes `cgroup.kill` for that cgroup and waits until it is
empty before it sends `End`. `setsid`, double forks and re-parenting to init cannot escape a cgroup,
which is why a process group is not enough. A `process_start` process gets its own cgroup under a
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

| Setting | Meaning | Default | Who sets it |
|---|---|---|---|
| `idle_timeout` | No Exec in flight and none ended for this long → end | 300 s | owner, ≤ operator ceiling (default ceiling 1800 s) |
| `max_duration` | From lease start → **expiring** | level 1: 8 h; level 2: 4 h | operator |
| `grace_limit` | From expiring → end even if busy | 30 min | operator |
| `keepalive_loss` | No keepalive for this long → end | 120 s | operator |

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

### 4.1 End reasons

`idle`, `max_duration`, `grace_limit`, `keepalive_lost`, `reset`, `mode_change`, `memory_reclaim`,
`worker_restart`, `teardown_failed`, `agent_dead`, `sandbox_deleted`. Every end writes an audit record
with the reason, the mode, the lease age and, at level 2, the tracked processes (id, name, exit state).
Like every SBX record, it has no command text.

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

On the wire, `sandbox/v1` gets an additive `LeaseEvent {state, reason, at, processes[]}`. It rides on
the first `ExecEvent` of the response and on a new status call (§8). The worker keeps the last end
event for each sandbox until a client has seen it.

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
- **Headroom target.** `SH_LEASE_RECLAIM_FREE_MB` (default: 2 × `PerVMBytes` + 2 GiB, about
  4 GiB at 1 GiB guests, so that two per-`Exec` VMs always fit). When MemAvailable falls below it, or an admission
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
- **No balloon in v1.** A guest gives back no memory it has touched. A lease VM that fills its page
  cache grows toward its guest RAM (1 GiB) and stays there until its lease ends. Reclaim handles it.
  E17 measures how common this is. A Firecracker balloon with free-page reporting is the follow-up if
  E17 says so.

## 7. Level 2: tracked processes

New MCP tools, offered only when the mode is `lease+processes` (at other modes a call fails with
`processes not enabled for this sandbox; ask the user to run: mocactl sbx mode <id> lease+processes`):

| Tool | Arguments | Result |
|---|---|---|
| `process_start` | `command`, `cwd` (in the workspace, default `/workspace`), `name` (optional, unique) | `id`, `name`, `pid` |
| `process_list` | — | id, name, pid, state (`running | exited(code) | killed(signal)`), age, memory |
| `process_logs` | `id` or `name`, `tail` (default 200 lines) | the last lines of combined stdout and stderr |
| `process_stop` | `id` or `name`, `signal` (default TERM, then KILL after 10 s) | final state |

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
  (`SH_SANDBOX_MODES_ALLOWED`, default `per-exec,lease`) decides which modes a user may pick, so level 2
  can stay off until the security review (§11) passes.
- Every change writes an audit record: who, old mode, new mode, epoch.

### 8.2 The mode reaches the worker in the token

- The sandbox token gains two claims, `mode` and `mode_epoch`. The relay already verifies the token.
  It **sets** `Exec.mode` and `Exec.mode_epoch` from the claims on every frame it routes, overwriting
  whatever the client sent. This is new: today the relay only compares client fields to claims
  (`sandbox-caller.ts:256-261`). The worker trusts only relay-set values.
- The worker keeps the highest `mode_epoch` it has seen for each sandbox. It **refuses an Exec with a
  lower epoch** (`stale_mode`). Then a token minted before a downgrade cannot keep using a higher mode
  for its remaining 15 minutes.
- **The epoch survives a worker restart.** The worker writes it next to the workspace on the host
  disk (the workspace already survives a restart) and reads it back before serving. A missing or
  unreadable file fails closed: the sandbox runs `per-exec` until an Exec arrives with a higher epoch.
  To make that happen without user action, every mode change raises the epoch, and `mocactl sbx get`
  re-sends `LeaseControl set_mode` with a fresh token when the worker reports an unknown epoch.
- **A downgrade takes effect right away.** After the `PUT`, `mocactl` mints a fresh token and sends a
  `LeaseControl {set_mode}` call through the relay with it. The worker applies the new epoch: from
  `lease+processes` to `lease` it stops every tracked process (notice, audit), and to `per-exec` it
  ends the lease (`mode_change`). An Exec in flight finishes first, bounded by `grace_limit`.
- **An upgrade** takes effect from the next Exec that carries the new epoch.
- If `LeaseControl` cannot reach the worker, the downgrade still lands at the next Exec, and the lease
  idles out at worst. `mocactl` reports that the change is pending.

### 8.3 New calls on `sandbox/v1` (additive)

| Call | Sent by | Purpose |
|---|---|---|
| `LeaseKeepalive {sandbox_id}` | the MCP server, every 30 s while the harness runs (opt-in, §4) | §4 keepalive |
| `LeaseControl {sandbox_id, op: set_mode \| reset \| status}` | `mocactl` (`set_mode`, `reset`, `status`), the MCP server (`status` for `sandbox_info`, `reset` for the `reset` tool) | §8.2, §4, §5 |
| `Exec.kind` = `command \| process_start \| process_list \| process_logs \| process_stop` | the MCP server | §7, keeping one authorization and audit path |

All of them carry the sandbox token, and the relay routes them like `Exec`. No new kind of token.

- **`reset`** is both an MCP tool and `mocactl sbx reset <id>`. It ends the lease (`reset`). The
  agent may call it: it can only lower what survives.
- **`mocactl sbx get`** shows the stored mode, and the live lease state from `LeaseControl status`.

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

| Gate | Property |
|---|---|
| `TestGateLeaseOneSandbox` | A lease VM never serves a second sandbox, workspace key or owner, and never goes back to the standby pool |
| `TestGateLeaseExecKillsProcesses` | After each Exec at both levels, nothing it started is alive: `&`, `nohup`, `setsid`, double fork, a daemon. `process_start` processes at level 2 are the only survivors |
| `TestGateLeaseFreshShell` | `export`, `cd`, `alias` and shell functions from one Exec are not visible in the next |
| `TestGateLeaseTeardown` | Each end reason destroys the VM and leaks no cgroup, tap, vsock or jail on the host (the lease variant of `TestGateLeakFreeTeardown`) |
| `TestGateLeaseStaleEpoch` | An Exec with an older `mode_epoch` is refused, and a downgrade stops tracked processes |
| `TestGateLeaseNotice` | Every end reason produces exactly one notice, on the next response and in `sandbox_info` |
| `TestGateLeaseReclaim` | Under a budget squeeze the idle-longest lease goes first, busy leases are never reclaimed for memory, and a lease VM that does not fit falls back to per-`Exec` |
| `TestGateLeaseSecrets` | Nothing secret is written into a lease guest (the lease variant of `TestGateSnapshotHoldsNoSecrets`: the snapshot gate assumed per-call teardown) |

## 10. Validation: E17

E17 is a separate spec in moca-experiments (`e17/SPEC.md`). In summary:

- **E17a, before the build:** the E15/E16 rig with the E15 resident patch and short idle timeouts,
  plus a cache-heavy Python workload. It answers early whether level 1 pays.
- **E17b, after the build:** the shipped lease mode with measured admission, reclaim and notices, at
  the default and low-duty points and a memory-squeeze point.

Pass criteria (proposals; E17 seals the numbers):

1. **Capacity.** Lease (300 s) `N_max` ≥ per-`Exec` `N_max` at both the default and the low-duty point.
2. **Latency.** On the cache-heavy workload the median warm command is at least 20% faster than per-`Exec`.
3. **Reclaim.** At the squeeze point, no memory guard trips, no OOM kill, no refused Exec while an idle
   lease existed, and every reclaim has its notice.
4. **Notices.** Every lease end in every E17b rung reaches the client with the right reason.

## 11. Security

What changes against per-`Exec`, and what bounds it:

| Change | Bound |
|---|---|
| Files outside the workspace (`/tmp`, `~`, system installs) last for the lease, so an injected command can leave a file that a later command uses | `idle_timeout`, `max_duration`, `reset`; the guest has no network; the same owner and the same sandbox only (`TestGateLeaseOneSandbox`) |
| At level 2 a process can survive and keep working between Execs | Only through `process_start`, which is visible in the tool call, in `process_list` and in the audit. Level 2 is off by operator policy until the review. Tighter `max_duration` (4 h). `grace_limit`. `SH_LEASE_MAX_PROCESSES` |
| An agent could try to raise the mode | No MCP tool changes the mode. A change needs the user API token, which the MCP server does not expose to the harness. **Residual:** if the user lets the harness run local shell commands, the agent could run `mocactl sbx mode` itself. `mocactl sbx mode` therefore refuses an upgrade without a TTY |
| Memory charged by measurement, not reserved | Reclaim, the host-memory floor, cgroup limits, swap off; E17's squeeze point |
| Clock drift in a long-lived guest | Clock correction on every Exec |

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
- **Worker and guest agent (Go):** the gates in §9; the lease state machine with the fake clock (every
  transition and every end reason); measured charge and reclaim order; fallback to per-`Exec`; the
  per-Exec cgroup kill, including `D`-state handling and `teardown_failed`.
- **Live (`SBX_LIVE_SMOKE=1`, KVM):** create in `lease`, run two commands and see a warm second run,
  idle out and see the notice; switch to `lease+processes`, `process_start` an HTTP server, reach it with
  `curl localhost` in a later Exec, downgrade and see it stopped.

## 14. Scope — explicitly not building

- Memory snapshot, suspend or resume of a lease. A lease that ends loses its memory.
- A Firecracker balloon or free-page reporting (follow-up, if E17 says so).
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

1. **Guest kernel and image.** The E15/E16 rig pins Firecracker's CI kernel `vmlinux-6.18.44`
   (moca-experiments `e15/rig/pins.sh:46`), new enough for `cgroup.kill`. Whether its config enables
   cgroup v2, and which kernel the SBX0 host's snapshot uses, is unverified (the release is in each
   snapshot's manifest, not in this repository). If either lacks cgroup v2, the per-Exec kill
   (§3.1) needs a new guest kernel, a workstream that lands before E17b. Mounting `cgroup2` in init
   changes the snapshot manifest hash for per-`Exec` too. Per-`Exec` behaviour does not change, but every
   host rebuilds its snapshot.
