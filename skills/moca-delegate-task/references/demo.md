# Fan out work to local Moca agents

This demo uploads one set of synthetic incident reports. Moca then runs 12 analysis tasks across
three Sandboxes. A deterministic check verifies every answer.

Complete the [local Kind setup](./kind-setup.md) first. The setup selects the dedicated
`kind-moca-delegate-demo` Kubernetes context.

## Run the demo

From the Moca checkout, launch Claude Code:

```sh
claude
```

Ask Claude to run the demo:

```text
Run the local Moca fan-out demo. Read skills/moca-delegate-task/SKILL.md first.
```

Claude runs one wrapper script. The script:

1. Generates 12 synthetic incident reports and an answer key.
2. Captures the reports as one local context.
3. Uploads that context once.
4. Distributes 12 tasks across three Moca Sandboxes.
5. Checks every remote answer against the answer key.
6. Removes the transient workload and local demo contexts.

During the run, a compact live view shows which files are packed into the single upload. It also
shows the revision, Moca workload, Sandbox readiness, and task progress. Use `--quiet` to hide it.

To follow the current run from another terminal, run:

```sh
./skills/moca-delegate-task/scripts/watch_demo.py --latest
```

A successful run ends with:

```text
PASS: 12 of 12 incident results matched
```

## Run directly

Run the same demo without Claude:

```sh
./skills/moca-delegate-task/scripts/run-kind-demo.sh
```

The wrapper refuses to run unless `kind-moca-delegate-demo` is the current Kubernetes context.
It uses the local endpoints created during setup. You do not need to export connection variables.

## Try 100 tasks

Each task makes one model call. Run the larger demo only when 100 calls are intentional:

```sh
./skills/moca-delegate-task/scripts/run-kind-demo.sh \
  --count 100 \
  --sandboxes 10 \
  --allow-large-batch
```

This demonstrates fan-out behavior, not production capacity.

When you finish, follow the [Kind cleanup instructions](./kind-setup.md#clean-up).
