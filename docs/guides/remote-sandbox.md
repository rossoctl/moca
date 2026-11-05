# Attach a remote sandbox

> **Preview.** A sandbox is a `remote-worker` that **dials out** to the relay, so it can live on another host with no
> inbound route ([Brain and hands](../concepts/brain-and-hands.md)). Only two remote arrangements are documented for
> P6: extra container sandboxes on the same host or cluster, and a microVM host attached to an OpenShift relay. Running
> a container sandbox on an unrelated host against a P6 relay is not documented anywhere; the recipe in step 2 is
> assembled from the pieces and **has not been run**. Read [Sandboxes and tiers](../concepts/sandboxes-and-tiers.md) and
> the [security model](../reference/security-model.md#isolation-by-tier) and the
> [multi-user isolation notes](../concepts/multi-user.md#isolation-between-users-today) first: a sandbox you attach joins the
> shared pool and is not bound to any user.

## What the worker needs

The image is `ghcr.io/rossoctl/moca-remote-worker:latest`. Its settings, with the full list in the
[configuration reference](../reference/configuration.md#sandbox-workers-go):

| Variable                     | Notes                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `RELAY_ADDR`                 | The relay's **attach** address and port (9443 on the VM and in Compose), **not** the exec port   |
| `SANDBOX_ID`                 | Unique per sandbox: one live attach per id. Two sandboxes with one id collide on one pool record |
| `SANDBOX_TOKEN`              | Must match the relay's token for this id (below). Pass it by name so it stays out of `ps`        |
| `SANDBOX_TIER`               | Advertised as the `moca.dev/tier` label; defaults to `container`                                 |
| `SH_WORKSPACE_ROOT`          | Must equal the harness's `KAGENTI_SANDBOX_CWD` (default `/workspace`)                            |
| `RELAY_TLS`, `RELAY_CA_FILE` | TLS to the relay; see step 4                                                                     |

The only network requirement is **outbound TCP to the relay attach port**.

## 1. Choose the id and the relay token

The relay looks up a token per id in this order: a file `$SH_RELAY_TOKEN_DIR/<id>` (read on every attach), then
`SH_RELAY_TOKEN_<id>`, then the global `SH_RELAY_TOKEN`. Attach is fail-closed: with no token configured, every attach is
rejected.

- **Underscore ids** (`^[A-Za-z_][A-Za-z0-9_]*$`, for example `byo_1`) can have their own token, because the id becomes an
  environment variable name.
- **Dashed ids** (such as `sh-sandbox-0`) are never looked up in the token directory. They use
  `SH_RELAY_TOKEN_<id>` where the environment can carry a dashed name (not under systemd, which drops such names, so
  not on the VM or a microVM host), otherwise the global `SH_RELAY_TOKEN`.
- The exec token (`MOCA_RELAY_EXEC_TOKEN`) is a different secret, must differ from every sandbox token, and must never be
  given to a sandbox. The name `DIR` is reserved.

On the VM, put the token in `/etc/serverless-harness/relay.env` and restart the relay.

## 2. Start the worker

This pattern is the VM installer's own (`deploy/vm/setup-vm.sh`) adapted to a separate host; it has not been run against
a remote P6 relay. The token goes by name so it stays out of the command line:

```bash
SANDBOX_TOKEN='<token>' docker run -d --name my-sandbox --restart=always \
  -e SANDBOX_ID=byo_1 -e RELAY_ADDR=<relay-host>:9443 -e SANDBOX_TIER=container \
  -e SANDBOX_TOKEN ghcr.io/rossoctl/moca-remote-worker:latest
```

No `-p` is needed. To add a sandbox to a **Compose** trial instead, copy the `sandbox` service in
`deploy/compose/docker-compose.yml` under a new `SANDBOX_ID`. On the **VM**, `SH_SANDBOX_COUNT` sets how many container
sandboxes `setup-vm.sh` starts.

## 3. Verify it attached

The worker logs its settings at start and, once connected, `worker: attached, serving execs`. A wrong token shows as that
line followed at once by `stream ended (...); reconnecting`.

A pool record exists only while the stream is open:

```bash
sudo podman exec sh-redis redis-cli HKEYS sh:sandbox:records            # VM; use your Redis container on Compose
sudo podman exec sh-redis redis-cli HGET sh:sandbox:records byo_1
```

A tiered record carries the label `moca.dev/tier`. The label only narrows placement when the tier is declared in
`SH_SANDBOX_TIERS` on both the supervisor and the control plane and the session picks it (`--option sandboxTier=...`);
with no tiers declared, labels are ignored. See [choosing a tier](manage-multi-user-sessions.md#4-choose-a-sandbox-tier). Stopping the worker clears the record without any manual deletion.
Relay-side, the relay logs presence-write retries and token problems (`relay token for <id> unreadable`); see
[Observability](../operations/observability.md#logs).

## 4. Network and TLS

- The relay's own listeners are **plaintext** gRPC. Attach tokens therefore cross the network in clear unless something
  terminates TLS for you. Do not expose the attach port on an untrusted network.
- The only documented TLS terminator is the OpenShift deployment's sidecar behind a passthrough Route, with workers set
  to `RELAY_TLS=true` (and `RELAY_CA_FILE` for a private CA) and `RELAY_ADDR=<route host>:443`. A TLS terminator for a VM
  or Compose relay is not documented.
- Keep the relay's **exec** listener unreachable from sandboxes: it is on loopback on the VM, and on a separate network in
  Compose.
- mTLS and SPIFFE identities are not implemented; the worker authenticates with a bearer token only.

## 5. Prove a command ran in that sandbox

Do not trust that a command ran where you meant: a pool can contain several sandboxes. The demo technique, adapted:

1. **Plant a marker that exists only in that sandbox,** then ask the agent to read it back:

   ```bash
   MARK="tuscan-lentils-$RANDOM"; echo "$MARK"
   docker exec my-sandbox sh -c "echo 'secret marker: $MARK' > /tmp/proof.txt"
   mocactl run "Read /tmp/proof.txt and tell me exactly what it says."
   ```

   The reply must contain `$MARK`. A file that exists nowhere else cannot have come from another sandbox.

2. **Make the answer unambiguous.** With several sandboxes in the tier, either use a tier only that sandbox advertises, or
   attach it alone while testing, so `HKEYS sh:sandbox:records` shows one entry. The original demo used a pool selector
   that matched no other pod; that mechanism went with the removed Knative path.
3. **On the microVM tier,** the host journal records each execution:
   `journalctl -u microvm-worker | grep 'vmpool: exec' | grep 'workspace_key="<session id>"'`. The container worker logs no
   individual executions.

## Attaching a microVM host (OpenShift only)

The documented remote arrangement is a KVM host attached to an OpenShift relay. `setup.sh` generates a bundle, you
copy it to the host and install with:

```bash
sudo deploy/microvm/setup-microvm.sh --remote ~/moca-p4-<id>
```

The host needs outbound TCP 443 to the relay Route. `setup.sh` refuses this on Kind and on the single-namespace OpenShift
target. To revoke a host, remove its id from `SH_P4_SANDBOX_IDS`; restarting the relay drops attached hosts. See
[`deploy/k8s/README.md`](../../deploy/k8s/README.md) and [P4 on P6](../../deploy/microvm/P4-ON-P6.md).

## Not supported

- Any **inbound** path to a worker.
- MicroVMs **inside** a Kubernetes cluster (the KVM host stays outside it), and a remote microVM host on Kubernetes
  targets other than OpenShift.
- A **per-user** sandbox: an attached sandbox joins the shared pool.
- The `SANDBOX_TRUST` label has no effect on placement; it is informational.
- Workspace durability: a container sandbox's workspace is lost on restart, and an idle workspace is reclaimed silently
  (#338).
