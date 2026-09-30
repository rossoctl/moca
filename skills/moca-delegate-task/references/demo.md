# Fan out local context to MOCA

This demo gives 12 MOCA agents one shared set of incident reports. Claude delegates the tasks and
Context Service transports the required local context. Each agent reads the same remote context
from a read-only volume.

> **Claim:** You transport local context once. Many agents use the resulting remote context without
> adding files to every prompt.

Complete the [one-time Kind setup](./kind-setup.md) before you start this demo.

## 1. Prepare local context

Generate 12 incident reports. Publish them as local context.

```sh
python3 skills/moca-delegate-task/scripts/generate_incident_demo.py
sed -n '1,20p' /tmp/moca-context-fanout/incidents/incident-001.txt

contextctl ctx create moca-fanout-source --type workspace --backend filesystem
contextctl ctx artifact publish moca-fanout-corpus \
  /tmp/moca-context-fanout/incidents \
  --from moca-fanout-source \
  --producer demo
```

## 2. Ask Claude to delegate

Start Claude Code from the MOCA checkout.

```sh
claude
```

Enter this prompt:

```text
/moca-delegate-task Use local context moca-fanout-corpus and remote context moca-fanout-remote.
Run the tasks in /tmp/moca-context-fanout/tasks.jsonl as one batch with 3 sandboxes. Save the batch
JSON result to /tmp/moca-context-fanout/results.json. Do not change cluster configuration.
```

Claude transports the local context once. MOCA then runs all 12 tasks against the shared remote
context.

## 3. Watch the workers

Run this command in another terminal:

```sh
kubectl get pods -w -l scaledjob.keda.sh/name=leaf-worker
```

Watch worker pods appear, process the queue, and disappear. The tasks use three sandbox replicas.
Press Ctrl-C after the workers stop.

## 4. Verify the results

Compare the remote answers with values that the task prompts did not contain.

```sh
python3 skills/moca-delegate-task/scripts/validate_incident_demo.py \
  --results /tmp/moca-context-fanout/results.json \
  --expected /tmp/moca-context-fanout/expected.json
```

Expected output:

```text
PASS: 12 of 12 incident results matched
```

All 12 answers came from the same remote context.

## Optional: run 100 tasks

Each task makes one model call. Run this option only when you intend to make 100 calls.

```sh
python3 skills/moca-delegate-task/scripts/generate_incident_demo.py --count 100
contextctl ctx artifact publish moca-fanout-corpus \
  /tmp/moca-context-fanout/incidents \
  --from moca-fanout-source \
  --producer demo
```

Ask Claude to run the larger batch:

```text
/moca-delegate-task Run all 100 tasks in /tmp/moca-context-fanout/tasks.jsonl as one MOCA batch.
Use local context moca-fanout-corpus, remote context moca-fanout-remote, and 3 sandboxes. Save the
batch JSON result to /tmp/moca-context-fanout/results.json, pass --allow-large-batch, and validate
it against expected.json.
```

## Clean up the demo

Delete the remote context and the two local contexts.

```sh
contextctl ctx delete moca-fanout-remote --namespace default
rm -r "${CS_CONTEXT_HOME:-$HOME/.contexts}/moca-fanout-corpus" \
  "${CS_CONTEXT_HOME:-$HOME/.contexts}/moca-fanout-source"
```

The setup guide contains the cluster cleanup steps.

## Limits

- The skill transports selected local context, not your full home directory.
- The remote context remains available until you delete it.
- MOCA deletes transient workloads after each batch.
- The 100-task option demonstrates fan-out. It does not measure production capacity.
