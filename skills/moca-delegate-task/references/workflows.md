# MOCA context workflows

Choose a workflow based on the task shape and who should access the context.

The `moca-delegate-task` skill currently supports the first two workflows.

| Workflow                        | Status    | Context flow                              | When to use it                    |
| ------------------------------- | --------- | ----------------------------------------- | --------------------------------- |
| Delegate one local task         | Available | Local context → managed MOCA workload     | Offload one bounded task          |
| Fan out local tasks             | Available | One upload → shared workload → many tasks | Run independent tasks in parallel |
| Reuse a remote dataset          | Proposed  | Stored remote context → later workloads   | Avoid repeated uploads            |
| Share trusted reference data    | Proposed  | Read-only remote context → many agents    | Protect common source material    |
| Share a collaboration workspace | Proposed  | Writable workspace ↔ many agents          | Combine intermediate results      |
| Return remote artifacts         | Proposed  | MOCA outputs → local context              | Continue remote work locally      |
| Hand work to another agent      | Proposed  | One agent's context → another agent       | Move work across harnesses        |
| Replicate local context         | Proposed  | Changed local context → remote context    | Back up work before delegation    |

The current helper intentionally creates a fresh MOCA-managed workload for each invocation. Single
tasks use a private read-only workspace. Batches use one shared read-only workspace and upload the
portable context only once.
