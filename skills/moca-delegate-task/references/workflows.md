# MOCA context workflows

Choose a workflow based on where your context and agent run. Also consider who needs access.

The `moca-delegate-task` skill currently supports the first two workflows.

| Workflow                        | Status    | Context flow                                            | When to use it                         |
| ------------------------------- | --------- | ------------------------------------------------------- | -------------------------------------- |
| Delegate one local task         | Available | Local context → one MOCA sandbox                        | Offload one bounded task               |
| Fan out local tasks             | Available | Local context → shared remote context → many MOCA tasks | Run independent tasks in parallel      |
| Reuse a remote dataset          | Proposed  | Preloaded remote context → later MOCA tasks             | Avoid repeated uploads                 |
| Share trusted reference data    | Proposed  | Read-only remote context → many agents                  | Protect common source material         |
| Share a collaboration workspace | Proposed  | Writable remote context ↔ many agents                   | Combine files and intermediate results |
| Return remote results           | Proposed  | MOCA outputs → local context                            | Continue remote work locally           |
| Hand work to another agent      | Proposed  | One agent’s context → another agent                     | Move work across harnesses or clusters |
| Replicate local context         | Proposed  | Changed local context → remote context                  | Back up work before delegation         |
