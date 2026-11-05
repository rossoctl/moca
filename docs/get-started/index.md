# Get started

Pick the path that matches what you are doing. All backends run the same processes (supervisor,
workers, relay, Redis) and speak the same wire; they differ in the process manager and in how
isolation is enforced. Labels are explained in the [documentation map](../index.md#maturity-labels).

## 1. Install the CLI

`mocactl` is the terminal client for the control plane.

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
```

It needs Node 22+ and installs to `~/.local/bin`. `MOCACTL_VERSION` (`latest`, the default; `edge`; or `vX.Y.Z`) and
`MOCACTL_INSTALL_DIR` override the defaults; `mocactl --version` says which build you have. See
[`packages/mocactl/README.md`](../../packages/mocactl/README.md) for login and commands.

## 2. Choose a backend

| I want to...                                 | Path                                                | Label   | You need                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Try MOCA in about five minutes, no root      | [Docker Compose](../../deploy/compose/README.md)    | Preview | Docker (or podman's `docker` CLI) with Compose, `curl`, a model credential. A trial, not production.                                                                                                                          |
| Run it for real on one machine               | [Single VM](../../deploy/vm/README.md)              | Preview | A Linux VM with systemd 247+, podman (netavark `isolate=strict`), `nft`, Node 22+ and pnpm 9+, the workspace built (the units run `node --import tsx`), and root to install the systemd units. Verified on Amazon Linux 2023. |
| Run it on a cluster (Kind or OpenShift)      | [P6 on Kubernetes](../../deploy/k8s/README.md)      | Preview | A NetworkPolicy-enforcing CNI (Kind 0.24+); accepted on OpenShift 4.20.8.                                                                                                                                                     |
| Add per-`Exec` Firecracker microVM sandboxes | [P4 microVM tier](../../deploy/microvm/P4-ON-P6.md) | Preview | A KVM host (`/dev/kvm`, cgroups v2, no swap, Firecracker and jailer), attached to a P6 VM host or, with `--remote`, to the in-cluster relay. See the limits section of that page.                                             |

Each linked README is the authority on its own prerequisites, verification and teardown; the
"you need" column is a summary, not a substitute.

## What is not supported yet

- **MicroVM sandboxes inside a Kubernetes cluster.** The KVM host stays outside the cluster and
  attaches to the relay over TLS. Kata and gVisor arms are deferred.
- **MicroVM or P6 on macOS or Windows.** On a dev machine use Docker Compose or Kind, which use
  container sandboxes.
- **Async fan-out (`async: true`) and the scheduled CronJob.** Both were removed with the
  Knative/KEDA path and have no P6 equivalent yet (ADR-0034 tracks the debt).

## After the install

- Run your first turns on the Compose trial: [First run](first-run.md).
- Walk through a full multi-user session on one VM:
  [`demos/vm-multi-user-demo.md`](../demos/vm-multi-user-demo.md).
- Look up a term: [glossary](../glossary.md).
- Call the API directly: [`api/openapi.yaml`](../api/openapi.yaml).
