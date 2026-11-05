# Context workflows

> **Preview.** This is a planning list, not a description of shipped behavior: the Status column
> says which workflows work today. Known limits of what has shipped: [Runs](../context-service.md#runs).

Moca runs agent tasks remotely. Many of those tasks need context: files, repositories, memory or
data that the task works from. This page lists the ways we expect people to move context into and
out of moca, and what each one needs. It is a living list; propose changes in a PR.

A **workload** is an environment for delegated tasks: where they run and the context they work from
([Context Service and workloads](../context-service.md)). Today a workload belongs to the user who created
it. Context is stored by [Context Service](https://github.com/rossoctl/context-service).

## Workflows

Arrows show where the context starts and where the work happens. `laptop` is any local agent
harness, `moca` is where the delegated tasks run, and `Context Service` is where context is
stored.

### Delegate work from a laptop

| #   | Workflow                         | Flow                      | When to use it                                   | Sandbox      | Storage                          | Status                   |
| --- | -------------------------------- | ------------------------- | ------------------------------------------------ | ------------ | -------------------------------- | ------------------------ |
| 1   | Delegate one local task          | `laptop → moca`           | Offload one bounded task                         | Shared       | Context PVC, copied in read-only | Server done; client next |
| 2   | Fan out local tasks              | `laptop → moca ⇉ N tasks` | Run many independent tasks in parallel           | Shared       | Context PVC, copied in read-only | Server done; client next |
| 3   | Delegate tasks as separate users | `A → moca ← B`            | Several users delegate without seeing each other | Per-workload | Each user's Context PVC, mounted | Planned (#476)           |

### Keep context in moca

| #   | Workflow                        | Flow                             | When to use it                                   | Sandbox      | Storage                         | Status                        |
| --- | ------------------------------- | -------------------------------- | ------------------------------------------------ | ------------ | ------------------------------- | ----------------------------- |
| 4   | Share an always-on workspace    | `git → moca ← users`             | Many users' agents work on the same loaded repos | Per-workload | Durable PVC, mounted read-write | Planned (#476); sharing to do |
| 5   | Reuse a remote dataset          | `stored Context → new workloads` | Avoid uploading the same data again              | Either       | Existing Context PVC            | Planned (#358)                |
| 6   | Share trusted reference data    | `one read-only Context ⇉ agents` | Give many tasks the same source material safely  | Per-workload | Existing Context PVC, read-only | Planned (#358); sharing to do |
| 7   | Share a collaboration workspace | `agents ⇄ moca (read-write)`     | Combine intermediate results across tasks        | Per-workload | Durable PVC, mounted read-write | Planned (#476); sharing to do |

### Move context between places

| #   | Workflow                   | Flow                                  | When to use it                                       | Sandbox | Storage                      | Status                                                     |
| --- | -------------------------- | ------------------------------------- | ---------------------------------------------------- | ------- | ---------------------------- | ---------------------------------------------------------- |
| 8   | Return remote artifacts    | `moca → laptop`                       | Continue remote work locally                         | Either  | Sandbox output → local files | No design yet                                              |
| 9   | Hand work to another agent | `agent A → Context Service → agent B` | Move work across harnesses                           | —       | Context PVC                  | Capture and restore exist; cross-harness translation to do |
| 10  | Replicate local context    | `laptop → Context Service`            | Keep local work ready to delegate (feeds workflow 5) | —       | Local files → Context PVC    | Exists (`contextctl` backup)                               |

## Sandbox and storage types

Sandboxes:

- **Shared:** the operator's shared, statically provisioned sandboxes. Tasks from many workloads
  run on them. They are not a security boundary between users: tasks from different users can run on
  the same sandbox, as the same Linux user, one after another, and read-only is enforced only by
  file permissions.
- **Per-workload:** sandboxes moca creates for one workload and deletes with it.
- **Either:** the workflow works with both.

Storage:

- **Context PVC:** the PVC Context Service keeps for a workload's Context.
  - **Copied in read-only:** shared sandboxes can't mount a new PVC, so moca copies the frozen
    context into the sandbox for each task and removes it afterwards.
  - **Mounted:** a per-workload sandbox mounts the PVC directly. In per-workload sandboxes
    ([#476](https://github.com/rossoctl/moca/issues/476)), delegated tasks mount it rather than
    copying from it.
- **Durable PVC:** a PVC that lives as long as the workload, mounted read-write, for state the
  tasks build up, such as cloned repositories.
- **Existing Context PVC:** a Context that already exists, used instead of a new upload, and
  authorized by Context Service's per-user permissions rather than a PVC name.

## Status

- **Server done; client next:** the routes exist —
  [#482](https://github.com/rossoctl/moca/pull/482) (`/workloads` phase 1) and
  [#494](https://github.com/rossoctl/moca/pull/494) (run tasks on a workload's context). The
  command-line client and delegate skill are designed in
  [#495](https://github.com/rossoctl/moca/issues/495) (one CLI for delegating subagent tasks).
  Today's limits: workload runs are synchronous only, they need a logged-in user, and the routes are
  off unless the operator enables them (see [Runs](../context-service.md#runs)).
- **Planned (#476):** [#476](https://github.com/rossoctl/moca/issues/476) (phase 2: per-workload
  sandboxes and storage).
- **Planned (#358):** [#358](https://github.com/rossoctl/moca/issues/358) (per-user PVC
  authorization).
- **Sharing to do:** more than one user using the same workload or Context. Not designed yet.
- **Capture and restore exist:** Context Service already captures and restores native agent-harness
  state for Claude Code, Codex, OpenCode and Pi
  ([harness attachments](https://github.com/rossoctl/context-service/blob/main/docs/harness-attachments.md),
  [portability](https://github.com/rossoctl/context-service/blob/main/docs/context-portability.md)).
  What's missing is translating one harness's state into another's.

## Workflow notes

**3. Delegate tasks as separate users.** User A and user B each delegate tasks. Each user's tasks run in
that user's own sandboxes with that user's context, and neither can see the other's.

**4. Share an always-on workspace.** Someone creates a workload with a durable PVC once and keeps it
running. Instead of uploading files, a moca task populates the PVC from inside the sandbox, for
example by cloning repositories, and later tasks refresh it with `git pull`. One or many users'
agents then work in the same loaded workspace. The motivating case is BugStone, a pipeline project
whose repositories stay loaded in its sandboxes.

**5. Reuse a remote dataset.** Upload the context once and keep it. Later workloads, in other
batches or days later, point at the same Context instead of uploading again. Unlike workflow 2, the
Context outlives the workload that first used it.

**9. Hand work to another agent.** Context Service already captures an agent harness's native state
(for example a Claude Code session) and restores it into the same kind of harness. Continuing the
work in a different harness (for example Codex or Pi) needs translation between their formats. Moca
is not involved.

**10. Replicate local context.** `contextctl` backs a local context up to Context Service
continuously, so it is already remote when you delegate; the delegation then reuses it as in workflow 5.
