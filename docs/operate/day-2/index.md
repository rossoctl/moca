# Day-2 operations

> **Preview.** These pages are for operators of **P6 on Kubernetes** ([Kubernetes and OpenShift](../harness/kubernetes.md)),
> the first path planned for Stable. Facts come from the manifests, `setup.sh` and the code as of 2026-10-13. Where
> something is not documented anywhere in the repository, the page says so rather than guessing. Single-VM and
> Compose notes appear only where they differ.

| Page                                                  | Covers                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Upgrades](upgrades.md)                               | Re-running `setup.sh`, image pinning, rollout behaviour, version skew, rollback               |
| [Redis backup and recovery](redis-backup-recovery.md) | What lives in Redis, what a loss costs, which secrets to back up separately, key rotation     |
| [Observability](observability.md)                     | Health endpoints, the JSON metrics, probes, log lines, the audit stream                       |
| [Sizing and scaling](sizing-and-scaling.md)           | Resource defaults, workers and turns per worker, replicas, sandbox capacity                   |
| [Hardening](hardening.md)                             | A checklist per deployment path, from the [security model](../../reference/security-model.md) |
| [Troubleshooting](troubleshooting.md)                 | Symptom, cause, check and fix                                                                 |

## Other deployment paths

The pages above are written for Kubernetes. For the single VM and the sandbox service, the same
day-2 tasks are on their own pages:

| Task                     | Single VM                                                                                               | Sandbox service                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Upgrade                  | [Upgrading an existing VM](../harness/single-vm.md#upgrading-an-existing-vm)                            | [Upgrading](../sandbox-service/runbook.md#2-upgrading)                                        |
| Check health and status  | [Checking it](../harness/single-vm.md#checking-it)                                                      | [Status and the audit lines](../sandbox-service/runbook.md#8-status-and-the-audit-lines)      |
| Redis and its data       | [Redis persistence](../harness/single-vm.md#redis-persistence)                                          | [Uninstalling](../sandbox-service/runbook.md#12-uninstalling) (what is kept, what is deleted) |
| Reboots and host outages | [Reboots](../harness/single-vm.md#reboots)                                                              | [A KVM-host outage](../sandbox-service/runbook.md#10-a-kvm-host-outage)                       |
| Troubleshooting          | [The units' start failures](../harness/single-vm.md#troubleshooting-start-request-repeated-too-quickly) | [Reproducing a member's issue](../sandbox-service/runbook.md#reproducing-a-members-issue)     |
| Limits                   | [What round one does not claim](../harness/single-vm.md#what-round-one-does-not-claim)                  | [Limits operators must know](../sandbox-service/runbook.md#9-limits-operators-must-know)      |

## Gaps you should know about

These are properties of the current deployment, not documentation omissions:

- **Single points of failure.** Redis, the relay, the control plane and (by default) the supervisor each run one
  replica, and there is no PodDisruptionBudget or anti-affinity, so a node drain can take them all at once.
- **No tested backup or rollback procedure** exists in the repository.
- **Sessions have no TTL** and per-session Redis memory has not been measured, while Redis is limited to 256Mi.
- **`/metrics` is JSON, not Prometheus format**, and the relay and sandboxes have no health endpoints.
- **A drain protects only short turns** (about 15 to 20 seconds), although the pod's grace period is 120 seconds.
- **No capacity numbers are published.** The worker and turn defaults are trial values, not measurements.
