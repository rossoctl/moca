# Sandboxes and tiers

> **Preview.** Describes the P6 runtime on `main` as of 2026-10-12. The microVM tier is implemented with
> documented limits; see [`deploy/microvm/P4-ON-P6.md`](../../deploy/microvm/P4-ON-P6.md).

A **sandbox** is where a session's tools run ([Brain and hands](brain-and-hands.md)). A **tier** is an
operator-defined class of sandbox. A deployment can offer one tier or several, and each session picks one
when it is created.

## The two tiers

|               | Container tier                                  | MicroVM tier (P4)                                                                                                    |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| What it is    | A container running a `remote-worker`           | A `microvm-worker` that runs each `Exec` in its own Firecracker microVM, behind the same `Attach` contract           |
| Typical host  | Any Docker, podman or Kubernetes host           | A Linux host with `/dev/kvm` (verified on an AWS `m8i.xlarge` with nested virtualization)                            |
| Workspace     | Container-local; lost if the container restarts | Persists between turns in a per-workspace disk image; a fresh VM per tool call                                       |
| Network       | See below                                       | **None**: the guest has no NIC, so `curl` and `git` to the internet fail                                             |
| Where it runs | VM, Compose, Kubernetes                         | On a P6 VM host, or on an external KVM host attached to an in-cluster relay over TLS (documented for OpenShift only) |

MicroVMs inside a Kubernetes cluster are not supported; the KVM host stays outside the cluster.

### Container isolation, as shipped

- **Kubernetes:** non-root, no privilege escalation, all capabilities dropped, the default seccomp profile.
  The root filesystem is **not** read-only, on purpose. A NetworkPolicy lets the sandbox reach the relay and
  the public internet, excluding private ranges and link-local addresses. A NetworkPolicy-enforcing CNI is
  required.
- **Single VM:** the sandbox sits on a dedicated podman network (`isolate=strict`) and an nftables table
  drops container-to-host traffic except the relay attach port and DNS. Traffic forwarded to the internet
  is untouched.
- **Compose:** sandboxes sit only on their own network, which is still routed to the internet.
- A container sandbox has no per-user binding: whoever shares the container shares its Unix user. Treat a
  container tier as isolation from the harness, not between sessions on the same sandbox.

### MicroVM limits

From the verified install notes: the guest has no network (#277); each tool call starts a fresh VM, and
destroying it dominates latency (#274, #307); an idle workspace is silently reset after its idle time,
which the turn is not told about (#338, open); and nothing binds a `workspace_key` to a user, so any holder
of the relay exec token can target any workspace. Warm standby VMs, the design that keeps VM creation off the
request path, are in [ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md); the install notes do not
verify them, and no published density or latency figures exist in this repository.

## How a sandbox joins

A sandbox worker dials the relay with a bearer token (`SANDBOX_TOKEN`, which must match the relay's
`SH_RELAY_TOKEN` or its per-sandbox token). Attach is fail-closed: with no token configured, every attach is
rejected. The relay records presence in Redis and removes it when the stream closes. The harness's exec
token is a different secret and is never given to a sandbox.

## Leases and capacity

Before a turn uses a sandbox it takes a **lease**: a short-lived entry in Redis, renewed by heartbeat while
the turn runs, released at the end, and expiring after 60 seconds if the holder dies. A sandbox accepts up
to `KAGENTI_SANDBOX_CAP` concurrent leases (20 by default; the shipped manifests set 4). When the pool is
saturated the turn gets 503 `sandbox_unavailable` with `Retry-After`.

## Tiers and affinity

- The deployment declares tiers with `SH_SANDBOX_TIERS` and a default with `SH_SANDBOX_DEFAULT_TIER`
  (required when there is more than one). A sandbox worker advertises its tier as the label
  `moca.dev/tier`. The harness and the control plane must be configured with the same names.
- A user picks a tier once, at session creation (`mocactl run --option sandboxTier=NAME`). It is fixed for
  the life of the session, and every turn lands in that tier.
- **Affinity** keeps a session on the sandbox that served its previous turn, so its workspace is still
  there. If that sandbox is busy, the turn gets a 503 and the session does not move. If it is absent, the
  turn gets 503 for a grace period (`SH_SANDBOX_AFFINITY_GRACE_SECONDS`, 60 by default), then the session
  moves to another sandbox in the same tier on a fresh workspace, and the turn reports `workspace_reset`
  with reason `detached`. If the sandbox has been relabelled to another declared tier, the session falls
  back immediately with reason `retiered`.

## Templates

- A **template** is a sandbox image a session can name, such as one SWE-bench instance's environment. A
  worker serves one template's snapshot and advertises it as the label `moca.dev/template`
  (`SANDBOX_TEMPLATE` in its environment). The control plane declares the templates in
  `SH_SANDBOX_TEMPLATES`, a JSON list of `{id, worker, description, tools, seed?}`.
- A user picks a template once, at session creation (`mocactl run --option sandboxTemplate=ID`), beside the
  tier. A value that is not among the declared templates is passed through for the control plane to
  judge. Every turn then runs on a worker of that template. A session that names none runs only on
  workers with no template, so it never gets a benchmark image by accident.
- Leaves (`/runs`) and unauthenticated turns name no template either: keep at least one untemplated
  worker for them. If every worker is templated they fail with `sandbox_unavailable`.
- A session's template is fixed. If the operator drops it from `SH_SANDBOX_TEMPLATES`, its turns fail
  (no worker of it) rather than move to an untemplated worker on an empty workspace.
- If the template has a `seed` (say, `cp -a /opt/repo/. /workspace/` for an image that carries its
  repository there), the harness runs it once, on the session's first turn, before the agent's first
  tool call. A marker in the workspace
  (`.moca-seeded`) keeps it from running again; after a workspace reset it runs again. Its output is in
  the workspace's `.moca-seed.log`. A seed must be safe to re-run: a failed one leaves no marker.
- An affine sandbox that now serves another template (or none) moves the session at once, with reason
  `retiered`. The design is
  [`docs/specs/2026-10-30-session-sandbox-templates-design.md`](../specs/2026-10-30-session-sandbox-templates-design.md);
  installing a templated P4 worker is in
  [`deploy/microvm/P4-ON-P6.md`](../../deploy/microvm/P4-ON-P6.md#a-templated-p4-worker-session-templates).

An affinity move never loses a workspace silently: the session either waits or is told it was reset. Idle
reclaim (`SH_WORKSPACE_IDLE`) is still silent on both tiers (#338).
