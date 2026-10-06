# Delegate tasks to MOCA

`moca-delegate-task` sends one bounded task—or many independent tasks—to MOCA with a selected
local context. Context Service stores the upload. MOCA then creates isolated Sandboxes, mounts the
Context read-only, and returns the results.

Use it to:

- Run independent work in parallel.
- Demonstrate hundreds of small serverless tasks from one shared context.
- Use remote capacity or services without giving the remote agent your local environment.

The main README stays intentionally high level. The complete local walkthrough lives in the
[Kind demo](references/demo.md).

## Requirements

- A reachable MOCA deployment with workload context uploads enabled
- [`contextctl`](https://github.com/rossoctl/context-service#install)
- Python 3
- `SH_URL`, plus `SH_TOKEN` when MOCA authentication is enabled

Users do not need cluster credentials or a direct Context Service endpoint. MOCA issues a
short-lived capability for each upload.

## Install

From a MOCA checkout:

### Claude Code

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/moca-delegate-task" ~/.claude/skills/moca-delegate-task
```

Invoke the skill with `/moca-delegate-task`.

### Codex

```sh
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/moca-delegate-task" ~/.agents/skills/moca-delegate-task
```

Invoke the skill with `$moca-delegate-task`.

### OpenCode

```sh
mkdir -p ~/.config/opencode/skills
cp -R "$PWD/skills/moca-delegate-task" ~/.config/opencode/skills/
```

## Configure

```sh
export SH_URL=https://moca.example.com
export SH_TOKEN=<bearer-token> # omit when authentication is disabled
```

Keep credentials outside prompts and committed files. The helper does not perform MOCA login.

## Use

Ask your agent to delegate a bounded task:

```text
Use the moca-delegate-task skill with local context CONTEXT_NAME. Analyze the failing tests and
return the likely cause with file references.
```

For fan-out, provide a JSONL task file. The helper exports the context once, uploads it to one
shared workload, submits every task, and removes the workload when the batch finishes.

The [Kind demo](references/demo.md) includes synthetic incident triage with 12 tasks and an
intentional 100-task option. See [workflow patterns](references/workflows.md) for other uses.

See [how context delegation works](references/internal-flow.md) for the internal request, upload,
storage, and execution flow.
