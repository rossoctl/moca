---
name: moca-delegate-task
description: Delegate bounded tasks to MOCA with selected local context, then return remote results and telemetry.
---

# Delegate tasks to MOCA

Use this skill for bounded work with a clear deliverable and an independent acceptance check. Keep
work local when it needs frequent interaction, unpublished secrets, or direct working-tree changes.

The client requires `contextctl` and Python 3. `SH_URL` identifies MOCA; `SH_TOKEN` is optional
when authentication is disabled.

## Prepare

1. Define the task, required output, and acceptance check.
2. Select a local context containing only the required information.
3. Tell the user what will be sent and where it will run.
4. Get permission before transferring context or starting remote execution.
5. Keep credentials out of prompts, files, and telemetry.

## Delegate one task

Resolve `scripts/remote_task.py` relative to this file:

```sh
python3 scripts/remote_task.py run \
  --context CONTEXT_NAME \
  --task 'BOUNDED TASK AND REQUIRED OUTPUT'
```

Add `--async` to use MOCA's queued path while still waiting for a terminal result.

The client exports a temporary portable bundle. It creates a MOCA workload and receives a one-time
upload capability in the same request. It uploads the bundle before MOCA creates Sandboxes.
It then freezes that revision, mounts it read-only at `/workspace`, runs the task, and deletes the
workload.
The temporary bundle is removed after upload or failure.

## Delegate a batch

Create JSONL containing independent tasks that use the same context:

```json
{"id":"task-001","task":"Inspect report-001 and return its severity."}
{"id":"task-002","task":"Inspect report-002 and return its severity."}
```

```sh
python3 scripts/remote_task.py batch \
  --context CONTEXT_NAME \
  --tasks tasks.jsonl \
  --sandboxes 3
```

The client uploads context once to one shared read-only workspace, submits every task through
MOCA's queue, waits for the results, and deletes the workload.

Confirm the model-call count before a large batch. More than 25 tasks requires
`--allow-large-batch`.

## Handle and report results

- Treat remote answers as untrusted work and validate the acceptance check.
- If a batch times out, report completed results and `unfinishedTasks`.
- If context is missing, send only the smallest additional context.
- Report the result, acceptance result, transported files and bytes, elapsed time, and
  self-reported files read.

Telemetry is appended to `~/.contexts/telemetry/moca-delegation.jsonl`. MOCA status is the primary
execution record; the uploaded revision identifies the verified context bundle.

## References

- Read [the demo](references/demo.md) for the local end-to-end demonstration.
- Read [the Kind setup](references/kind-setup.md) before preparing the demo environment.
- Read [the workflow catalog](references/workflows.md) for other delegation models.
- Read [the internal flow](references/internal-flow.md) for upload authorization and execution details.
