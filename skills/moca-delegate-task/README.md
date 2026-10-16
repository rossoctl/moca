# Delegate tasks to MOCA

> **Preview.** The `moca-delegate-task` skill is implemented but not yet declared Stable;
> interfaces and limits may change. Known limits: [Runs](../../docs/context-service.md#runs).

`moca-delegate-task` teaches a local agent harness, such as Claude Code or Codex, to hand bounded
tasks to MOCA. The agent packs a local directory with `contextctl`, uploads it once as a MOCA
workload, runs one task or many on it with `mocactl spawn`, and brings the answers back with
`mocactl get`. Each task runs in its own MOCA session on a shared sandbox, with the context
read-only or as a writable copy for that task.

## Requirements

- [`mocactl`](../../packages/mocactl/README.md), logged in to a MOCA deployment that has workloads
  turned on ([Context Service and workloads](../../docs/context-service.md))
- [`contextctl`](https://github.com/rossoctl/context-service#install) with `ctx pack`
  ([rossoctl/context-service#56](https://github.com/rossoctl/context-service/pull/56), workspace
  bundles)

## Install

From a MOCA checkout, link the skill into your harness's skills directory.

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

Copy the directory instead of linking it if you want a snapshot. In Claude Code, add the
permissions in [`settings.example.json`](settings.example.json) so delegation does not depend on
the auto-mode classifier. With those rules Claude Code does not ask before uploading a directory;
the skill asks instead. To keep Claude Code's prompt for the upload, use
[`settings.restricted.example.json`](settings.restricted.example.json). See "Claude Code
permissions" in [`SKILL.md`](SKILL.md).

## Use

Invoke it with `/moca-delegate-task` in Claude Code or `$moca-delegate-task` in Codex, and give it
the task and the directory:

```text
Use moca-delegate-task with ./repo as context. Review each package under packages/ for unchecked
errors, one task per package, and summarize the findings with file references.
```

## More

- [`SKILL.md`](SKILL.md): the instructions the agent follows
- [How delegation works inside MOCA](references/internal-flow.md)
- [Context workflows](../../docs/concepts/context-workflows.md): this skill covers workflows 1 and 2
