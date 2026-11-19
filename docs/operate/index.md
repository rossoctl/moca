---
title: Deploy and operate
sidebar_label: Deploy and operate
sidebar_position: 4
description: Choose which moca deployment to run for the harness, the sandbox service or both, and what each one needs.
doc_type: navigation
audience: [operator]
capability: both
---

# Deploy and operate

This section is for **platform and operations engineers** who install, upgrade and run moca. If
you only _use_ moca, start at [Get started](../get-started/index.md) instead.

Moca has two capabilities, each with its own deployment paths. You can deploy the sandbox service
without the harness, and the harness without the sandbox service. The `combined` profile runs both
on one control plane.

## Choose a deployment

| Deployment                                                                                            | Delivers                           | Label                            | Runs on                                                           | You need                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Docker Compose](harness/compose.md)                                                                  | Harness (trial)                    | Preview, trial only              | A dev machine                                                     | Docker or podman's `docker` CLI with Compose, `curl`, a model credential                                                                 |
| [Single VM](harness/single-vm.md)                                                                     | Harness                            | Preview                          | One Linux VM                                                      | systemd 247+, podman with netavark `isolate=strict`, `nft`, Node.js 22+, pnpm 9+, a built workspace, root. Verified on Amazon Linux 2023 |
| [Kubernetes and OpenShift](../../deploy/k8s/README.md)                                                | Harness                            | Preview, first target for Stable | Kind 0.24+ or OpenShift (accepted on 4.20.8)                      | A NetworkPolicy-enforcing CNI. Kind also needs Docker, `kubectl`, `jq`, `openssl` and `sha256sum` or `shasum`                            |
| [MicroVM tier (P4)](../../deploy/microvm/P4-ON-P6.md)                                                 | The harness's microVM sandbox tier | Preview                          | A KVM host attached to a VM deployment, or to an in-cluster relay | `/dev/kvm`, cgroups v2, no swap, Firecracker and jailer                                                                                  |
| [Sandbox service](../../deploy/sbx/README.md)                                                         | Sandbox service                    | Preview                          | A dedicated OpenShift namespace plus KVM hosts                    | `kubectl` with edit rights in the namespace, `jq`, OpenSSL 1.1.1+, three distinct route hosts, a GitHub OAuth app (device flow)          |
| [One control plane for both](../../deploy/sbx/README.md#one-control-plane-for-sessions-and-sandboxes) | Harness and sandbox service        | Preview                          | An OpenShift namespace of its own, plus KVM hosts                 | Everything the sandbox service needs, a fourth route host, and images pinned by digest. Egress credentials aren't supported here yet     |

Some deployments are not supported:

- **MicroVMs inside a Kubernetes cluster.** The KVM host always stays outside the cluster.
- **MicroVMs or the P6 runtime on macOS or Windows.** On a dev machine, use Docker Compose or Kind,
  which use container sandboxes.
- **The sandbox service on Compose or Kind.** Only the OpenShift overlays set the `sandbox` route
  profile.

## The pieces you are running

| Component                                                               | Harness                                                                                                    | Sandbox service                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Supervisor and warm workers (`@moca/supervisor`, `@moca/server`)        | yes                                                                                                        | `combined` only                                                                               |
| Control plane (`@moca/control-plane`), route profile `SH_ROUTE_PROFILE` | `harness` (the default)                                                                                    | `sandbox` (or `combined`)                                                                     |
| Sandbox relay (`@moca/sandbox-relay`)                                   | yes                                                                                                        | yes                                                                                           |
| Redis                                                                   | sessions                                                                                                   | the sandbox service's state                                                                   |
| Sandbox workers (Go, `remote-worker/`)                                  | container `remote-worker` (image `ghcr.io/rossoctl/moca-remote-worker`), or `microvm-worker` on a KVM host | a host build of `microvm-worker` on each KVM host (`SBX_WORKER_BIN`), one worker per template |

Default ports for the harness:

| Port | Service                                                                                    |
| ---- | ------------------------------------------------------------------------------------------ |
| 8080 | Supervisor (data plane)                                                                    |
| 8081 | Supervisor admin (`/metrics`, `/healthz`, `/readyz`)                                       |
| 9443 | Relay attach (sandboxes dial in). The code default is 8443; the shipped templates use 9443 |
| 9444 | Relay `SandboxExec` (workers)                                                              |
| 6379 | Redis (never published)                                                                    |

Compose publishes the control plane on 8090. The sandbox service is reached through three
OpenShift Routes:

- **api**: edge TLS;
- **attach**: passthrough;
- **exec**: passthrough.

## After install

- [Day-2 operations](../operations/index.md): observability, sizing and scaling, upgrades,
  Redis backup, hardening, troubleshooting.
- [Security model](../reference/security-model.md): what each deployment isolates, and what it doesn't.
- [Sandbox service runbook](../../deploy/sbx/RUNBOOK.md): users, templates, key rotation, outages.
- [Configuration reference](../reference/configuration.md): every environment variable.
