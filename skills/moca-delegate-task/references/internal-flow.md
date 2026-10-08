# How context delegation works

The local agent harness reads the `moca-delegate-task` skill and runs its helper,
`scripts/remote_task.py`. The helper packs the selected local context, asks MOCA for
a workload, uploads the context straight to Context Service, and runs the task
remotely. MOCA authorizes every step, but the context bytes never pass through MOCA.

![Context delegation flow](internal-flow.svg)

1. **Export**: the helper runs `contextctl ctx export` to pack the selected files into
   a `.context` bundle.
2. **Create and grant**: `POST /workloads` with `contextUpload: true`. MOCA creates an owned
   workload record. Context Service provisions the Context PVC. MOCA returns a one-time upload URL
   and bearer token that expire after five minutes. No Sandbox exists yet.
3. **Upload**: `PUT` the bundle to the upload URL with the token. Context Service
   expands it into the PVC. Without step 2 there is no upload URL or token, so the
   upload cannot happen. Context Service rejects any PUT with `401` if its token is
   missing, wrong, expired, or already used.
4. **Activate**: `POST /workloads/{id}/activate` with the uploaded revision. MOCA asks Context
   Service to freeze that revision and resolve its attachment. MOCA then creates the Sandboxes.
   Each Sandbox mounts only that revision read-only at `/workspace`.
5. **Run**: `POST /runs` with the workload ID. The remote agent runs in the Sandbox
   with the PVC mounted read-only and reports which context files it used.
6. **Clean up**: `DELETE /workloads/{id}`, unless `--keep-workload` is set. MOCA deletes the
   Sandboxes, then asks Context Service to delete the Context. The helper records telemetry throughout.

## Fan-out

`batch` uses the same flow with one shared PVC and several Sandboxes. The context is
uploaded once. Each task is then submitted asynchronously as its own session, and the
helper waits for all of them to finish.
