# Context transport and remote-agent workflows

Context Service and MOCA can support several workflows depending on where context begins, where an
agent runs, and whether the context is private or shared. The current delegation skill implements
only the first workflow.

| Workflow | Context and execution flow | Typical use |
| --- | --- | --- |
| **Single-user local-to-remote task delegation** *(implemented)* | Select local context → copy a point-in-time revision to a remote PVC → run one bounded task in an isolated MOCA sandbox → return the result | Offload a test, investigation, or other independent subtask while continuing local work |
| **Preloaded remote dataset for repeated tasks** | Load a dataset into a remote PVC once → attach it to multiple sandboxes over time | Avoid repeatedly uploading a large corpus, repository, benchmark, or test dataset |
| **Shared read-only reference context** | Maintain one remote context → mount it read-only into multiple agents' sandboxes | Let many agents analyze the same trusted source without allowing them to modify it |
| **Shared read-write collaboration workspace** | Attach several agents or users to one writable remote context | Let agents contribute files, intermediate results, or coordinated work to a common workspace |
| **Remote-result return for local continuation** | Run remotely → capture the resulting context revision → sync selected results back to the local harness | Continue locally after cloud compute, hardware access, or remote validation |
| **Agent-to-agent context handoff** | Capture context from one agent → transport it to another local or remote agent | Move work between harnesses, specialized agents, clusters, or execution environments |
| **Parallel analysis with result aggregation** | Fan one base context out to several remote agents → collect their outputs into a result context | Compare approaches, divide a large investigation, or run independent reviews in parallel |
| **Continuous local-to-remote context replication** | Periodically copy changed context to remote storage instead of waiting for task dispatch | Maintain a recoverable remote copy and reduce staging time when delegation is needed |

## Current skill

`moca-delegate-task` is a **single-user local-to-remote task delegation** workflow. It:

1. Selects an existing local Context Service context.
2. Publishes a point-in-time revision to a remote PVC.
3. Creates an isolated MOCA workload with that PVC mounted read-only.
4. Runs a bounded task and returns its result.
5. Records transport and execution telemetry.

The other workflows are design possibilities, not behavior implemented by this skill.

## Install the skill

Clone the experimental branch, then link the skill into the shared agent configuration:

```sh
git clone --branch experiment/moca-context-delegation \
  https://github.com/moonlight16/moca.git
cd moca
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/moca-delegate-task" ~/.agents/skills/moca-delegate-task
```

Restart the agent application after adding the skill. The helper requires Python 3, `contextctl`,
and `kubectl` configured for the cluster where MOCA and Context Service run.

## Configure access

Set the Context Service and MOCA connection details for the target environment:

```sh
export CS_URL=https://context-service.example.com
export CS_NAMESPACE=moca
export SH_URL=https://moca.example.com
export SH_TOKEN=<bearer-token> # omit when the endpoint does not require one
```

For the agentic-node test environment, `SH_URL` is
`https://12c73248-ca-tor.lb.appdomain.cloud/moca`. Keep credentials outside prompts and committed
files.

The skill delegates from an existing local filesystem context. Confirm that the intended context
exists and contains only the files the remote task needs:

```sh
contextctl ctx get CONTEXT_NAME --backend filesystem
```

## Use it from an agent

Invoke the skill explicitly and provide a bounded task with a checkable result:

```text
Use $moca-delegate-task to run this task remotely using local context CONTEXT_NAME.
Publish it as remote context REMOTE_CONTEXT_NAME. Analyze the failing tests and return
the likely cause with supporting file references.
```

The agent should state what context it will transport before dispatching. It then runs the bundled
helper, checks the remote result, and reports the files and bytes transported, elapsed time, and
self-reported files read.

The helper can also be exercised directly:

```sh
python3 ~/.agents/skills/moca-delegate-task/scripts/remote_task.py run \
  --context CONTEXT_NAME \
  --remote-context REMOTE_CONTEXT_NAME \
  --namespace "$CS_NAMESPACE" \
  --task 'Analyze the failing tests and identify the likely cause.'
```

Telemetry is appended to `~/.contexts/telemetry/moca-delegation.jsonl`.
