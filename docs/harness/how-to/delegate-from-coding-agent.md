---
sidebar_position: 5
---

# Delegate from a coding agent

> **Preview.** The `moca-delegate-task` skill is implemented but not yet declared Stable;
> interfaces and limits may change.

The [`moca-delegate-task`](../../../skills/moca-delegate-task/README.md) skill teaches a local agent
harness, such as Claude Code or Codex, to hand bounded tasks to moca. The agent packs a local
directory with `contextctl`, uploads it once as a moca workload, runs one task or many on it with
`mocactl spawn`, and brings the answers back with `mocactl get`. Each task runs in its own moca
session on a shared sandbox, with the context read-only or as a writable copy for that task.

Use it for a bounded task with a deliverable you can check (a review, an analysis, a fix with its
diff), for fan-out (many independent tasks on the same context), or for work that needs moca's
sandboxes rather than your machine. Keep the work local when it needs interactive local state,
secrets, or durable writes to your working tree.

## Before you start

- `mocactl`, logged in to a moca deployment that has workloads turned on
  ([Context Service and workloads](workloads.md)): see [Use mocactl](use-mocactl.md).
- [`contextctl`](https://github.com/rossoctl/context-service#install) with `ctx pack`
  ([rossoctl/context-service#56](https://github.com/rossoctl/context-service/pull/56), workspace
  bundles).

## Install the skill

From a moca checkout, link the skill into your harness's skills directory.

Claude Code, for every project (or use the project's `.claude/skills/` instead):

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/moca-delegate-task" ~/.claude/skills/moca-delegate-task
```

Codex:

```bash
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/moca-delegate-task" ~/.agents/skills/moca-delegate-task
```

For Claude Code's permissions, see the skill's
[README](../../../skills/moca-delegate-task/README.md#install).

## Use it

Invoke it with `/moca-delegate-task` in Claude Code or `$moca-delegate-task` in Codex, and give it
the task and the directory:

```text
Use moca-delegate-task with ./repo as context. Review each package under packages/ for unchecked
errors, one task per package, and summarize the findings with file references.
```

## More

- [`SKILL.md`](../../../skills/moca-delegate-task/SKILL.md): the instructions the agent follows.
- [Context workflows](../concepts/context-workflows.md): this skill covers workflows 1 and 2.
