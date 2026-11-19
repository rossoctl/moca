---
sidebar_position: 8
---

# Keep a guest between commands (lease mode)

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

By default a sandbox runs **per-exec**: every command gets a fresh VM, and only `/workspace` carries
over. A **lease mode** keeps the guest between commands instead, so the page cache stays warm, and
`/tmp`, `/var` and installs outside `/workspace` survive until the lease ends.

| Mode              | What survives between commands                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `per-exec`        | `/workspace` only (the default)                                                                                                                    |
| `lease`           | the guest: `/tmp`, `/var`, installs outside `/workspace`. Every process still dies at the end of each command, and each command gets a fresh shell |
| `lease+processes` | as `lease`, plus **tracked processes** you start with `mocactl sbx proc start`, which outlive the command that started them                        |

**The deployment decides which modes you may pick.** `per-exec` is always allowed; a deployment
allows only `per-exec` unless its operator lists more (`SBX_MODES_ALLOWED`, in
[the install reference](../../operate/sandbox-service/install.md)). Picking a mode it does not allow is refused (`mode_not_allowed`).

## Create a sandbox in a lease mode

```bash
mocactl sbx create --mode lease
mocactl sbx create --mode lease+processes --idle-timeout 900
```

`create` prints the new sandbox's id; pass it as the `ID` of the commands below. Without an `ID`, they
use the sandbox in the nearest `.sbx/sandbox.json`, the one `sbx up` bound. Moving to a lease mode is an upgrade, so it is
accepted only from a terminal.

**The lease ends after `--idle-timeout` seconds without a command.** Without the flag, the worker's
default applies (300 s); a deployment caps what you may set (1800 s unless its operator changed
`SBX_IDLE_CEILING_S`). When the lease ends, the next command starts a new guest: `/workspace` is
kept, everything else in the guest is gone.

## Check and change the mode

```bash
mocactl sbx get [ID]                    # the mode, epoch and idle timeout, and the lease's state
mocactl sbx mode lease [ID]             # change the mode (keeps the idle timeout unless given)
mocactl sbx mode per-exec [ID]          # a downgrade to per-exec ends the lease
mocactl sbx reset [ID]                  # end the lease now: the next command starts a new guest
```

- A worker that cannot be reached takes a mode change at its next command.
- Going from `lease+processes` to `lease` keeps the lease and stops the tracked processes;
  `mocactl sbx mode` prints the ones it stopped.
- `mocactl sbx` and its MCP server show each lease event as one line, for example
  `[sandbox] guest restarted (idle, 14:02): ...` when a lease ended because it was idle.

## Run a process that outlives the command (`lease+processes`)

Only a tracked process survives the command that started it. Anything else a command starts in the
background (`&`, `nohup`, `setsid`) still dies when the command ends.

```bash
mocactl sbx proc start --name web -- python3 -m http.server 8000   # prints its id, name and pid
mocactl sbx proc ls                                                # id, name, pid, state, age and memory
mocactl sbx proc logs web --tail 50                                # the last lines of its stdout and stderr
mocactl sbx proc stop web                                          # TERM, then a kill after 10 s
```

- `--cwd D` starts it in a directory inside `/workspace`; a name must be unique among the running
  processes.
- A process's state is `running`, `exited(code)` or `killed(signal)`. An exited process stays listed
  until the lease ends.
- On a terminal, `proc logs` removes control sequences; `--raw` keeps them, and piped output is
  always as written.
- When the lease ends, its tracked processes end with it.

## From your own code

A direct `sandbox/v1` client sees the same modes: the mode reaches the worker in the sandbox token,
and `LeaseControl` reads, resets or changes the lease. See
[Lease mode](direct-api.md#lease-mode) and
[Tracked processes](direct-api.md#tracked-processes-leaseprocesses) in the API guide.

All the flags: [`mocactl sbx` reference](../reference/cli-sbx.md).
