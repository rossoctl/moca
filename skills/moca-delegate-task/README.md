# Delegate tasks to MOCA

`moca-delegate-task` sends one task or many independent tasks from a local agent to MOCA. MOCA uses
Context Service to transport the required local context. MOCA mounts the remote context read-only
and returns the results.

Use remote delegation to:

- Run independent tasks in parallel.
- Use cloud compute, hardware, capacity, data, services, or private networks.
- Isolate remote work from your local environment.

```text
MOCA delegation: local agent → remote context (Context Service) → MOCA sandbox → result
```

The skill supports one remote task and batch fan-out from a shared remote context.

## Requirements

- A reachable MOCA deployment
- [`contextctl`](https://github.com/rossoctl/context-service#install)
- A reachable [Context Service](https://github.com/rossoctl/context-service/blob/main/docs/getting-started.md)
- `kubectl` access to the cluster that runs MOCA and Context Service
- Python 3

You can capture local context without Kubernetes. Delegation requires MOCA and Context Service.

## Install the skill

Clone the experimental branch:

```sh
git clone --branch experiment/moca-context-delegation https://github.com/moonlight16/moca.git
cd moca
```

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

Ask OpenCode to use the `moca-delegate-task` skill.

## Configure access

Set the connection details for MOCA and Context Service:

```sh
export CS_URL=https://context-service.example.com
export CS_NAMESPACE=moca
export SH_URL=https://moca.example.com
export SH_TOKEN=<bearer-token> # omit when authentication is disabled
```

Keep credentials outside prompts and committed files. Configure `CS_URL` and your active Kubernetes
context for the same cluster.

Protected MOCA routes require `SH_TOKEN`. Without it, a route can return `403 RBAC: access denied`.
Ask the MOCA operator for a token. The helper does not perform the MOCA login flow.

## Delegate a task

Create or select local context. Then ask your agent to use the skill:

```text
Use the moca-delegate-task skill to run this bounded task remotely using local context CONTEXT_NAME.
Publish it as REMOTE_CONTEXT_NAME. Analyze the failing tests and return the likely cause with file
references.
```

The skill reports results, transported files, bytes, elapsed time, and self-reported files read. It
stores telemetry in `~/.contexts/telemetry/moca-delegation.jsonl`.

## Run the demo

The [Kind demo](references/demo.md) fans one local context out to 12 Claude tasks. The demo includes
an explicit 100-task option.

## Explore other workflows

See [Context and execution workflows](references/workflows.md) for more workflow patterns.

## References

- [Install `contextctl`](https://github.com/rossoctl/context-service#install)
- [Run Context Service on Kind](https://github.com/rossoctl/context-service/blob/main/docs/getting-started.md#guided-kind-quickstart)
- [Deploy Context Service to Kubernetes](https://github.com/rossoctl/context-service/blob/main/docs/getting-started.md#deploy-to-kubernetes)
- [Configure Context Service clients](https://github.com/rossoctl/context-service/blob/main/docs/getting-started.md#cli)
