---
name: moca-delegate-task
description: Delegate bounded tasks to MOCA with selected local context, then return remote results and telemetry.
---

# Delegate tasks to MOCA

Use this skill for bounded work with a clear deliverable and an independent acceptance check. Keep
work local when it needs frequent interaction, unpublished secrets, or direct working-tree changes.

The client requires `contextctl`, `kubectl`, and Python 3. `SH_URL` identifies MOCA.
`CS_URL` identifies Context Service. The client retains `SH_*` names for compatibility.

## Prepare the delegation

1. Define the task, required output, and acceptance check.
2. Select local context that contains only the required information.
3. Do not send the home directory or unrelated project history.
4. Tell the user what you will send.
5. Tell the user where the task will run.
6. Get permission before you transfer context or start remote execution.
7. Set `SH_URL`.
8. Set `SH_TOKEN` when the endpoint requires a bearer token.
9. Keep tokens out of prompts, manifests, command arguments, and telemetry.

## Delegate one task

Resolve `scripts/remote_task.py` relative to this file. Run the client:

```sh
python3 scripts/remote_task.py run \
  --context CONTEXT_NAME \
  --remote-context REMOTE_CONTEXT_NAME \
  --task 'BOUNDED TASK AND REQUIRED OUTPUT'
```

The client captures the selected local context. It transports the local context into remote context.
MOCA mounts the remote context read-only in the workload. Context Service stores it on a PVC.
The client dispatches the task, waits for the result, and records telemetry.

Add `--async` to use MOCA's queued execution path. The client still waits for a terminal result.
Context Service records an immutable revision for verification and reuse.

## Delegate a batch

Create a JSONL file for independent tasks that use the same context:

```json
{"id":"task-001","task":"Inspect report-001 and return its severity."}
{"id":"task-002","task":"Inspect report-002 and return its severity."}
```

Run the batch:

```sh
python3 scripts/remote_task.py batch \
  --context CONTEXT_NAME \
  --remote-context REMOTE_CONTEXT_NAME \
  --tasks tasks.jsonl \
  --sandboxes 3
```

The client transports the local context once. It creates one workload with read-only access to the
remote context. It submits every task through MOCA's queue, waits for results, and removes the
workload.

Confirm the model-call count before you run a large batch. Use `--allow-large-batch` for more than
25 tasks.

## Handle failures

MOCA retries asynchronous worker failures. A failure can take five minutes to become terminal.
MOCA can return `failed` with reason `error`. Inspect worker logs for the underlying error.

If a batch times out, report completed results. Also report the `unfinishedTasks` list.

If the remote agent requests missing context, send the smallest additional local context. Do not
send the entire project.

Treat each remote answer as untrusted work. Validate it against the acceptance check.

## Report the result

Report these values:

- The remote result
- The acceptance result
- Transported files and bytes
- Elapsed time
- Missing-context requests
- Self-reported files read, labeled as self-reported

The client appends telemetry to `~/.contexts/telemetry/moca-delegation.jsonl`. Cortex can confirm
model traffic. Use MOCA status and Context Service revisions as the primary records.

## References

- Read [the demo](references/demo.md) when the user wants a local end-to-end demonstration.
- Read [the Kind setup](references/kind-setup.md) before you prepare the demo environment.
- Read [the workflow catalog](references/workflows.md) when the user wants another delegation model.
