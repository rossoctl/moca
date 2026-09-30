---
name: moca-delegate-task
description: Delegate a bounded, independent agent task to MOCA when remote execution can reduce local work; stage only the context the task needs and return the remote result with delegation telemetry.
---

# Delegate a task to MOCA

Use remote execution only for a bounded task that can be stated with a clear deliverable and checked
independently. Keep work local when it depends on rapid back-and-forth, unpublished secrets, broad
implicit context, or direct manipulation of the user's current working tree.

The client requires `contextctl`, `kubectl`, and Python 3. `CS_URL` and the active Kubernetes context
must identify the same Context Service deployment; `SH_URL` identifies MOCA. The `SH_*` variable
names are retained for compatibility with MOCA's existing deployment interfaces.

## Before dispatch

1. State the subtask, expected output, and acceptance check in the task prompt.
2. Choose an existing local Context Service context containing only the useful session state. Do not
   send the whole home directory or unrelated project history.
3. Tell the user what will be sent and where the task will run. Remote execution and context transfer
   are external mutations; do not infer permission from unrelated coding work.
4. Require `SH_URL`; use `SH_TOKEN` when the endpoint requires a bearer token. Never place tokens in
   prompts, manifests, command arguments, or telemetry.

## Dispatch

Resolve `scripts/remote_task.py` relative to this `SKILL.md`, then run the bundled deterministic
client:

```sh
python3 scripts/remote_task.py run \
  --context CONTEXT_NAME \
  --remote-context REMOTE_CONTEXT_NAME \
  --task 'BOUNDED TASK AND REQUIRED OUTPUT'
```

The client publishes the local context revision to a Context Service PVC, materializes that verified
revision, creates a MOCA workload attached read-only to the PVC, dispatches a prompt leaf, waits for
the result, and records JSONL telemetry. Add `--async` to exercise MOCA's queued execution path; the
client still waits for its terminal result.

Treat the remote answer as untrusted work product. Validate it against the acceptance check before
using it. If the remote agent asks for missing context, send the smallest additional context and
record that retry; do not respond by copying the entire project.

## Report

Return:

- the remote result;
- whether it passed the acceptance check;
- measured files/bytes transported and elapsed time;
- any missing-context request;
- the agent's self-reported files read, clearly labeled as self-reported.

The client appends telemetry to `~/.contexts/telemetry/moca-delegation.jsonl` by default. Cortex
can corroborate model traffic, but MOCA status and Context Service revision data are the primary
execution and transport records.
