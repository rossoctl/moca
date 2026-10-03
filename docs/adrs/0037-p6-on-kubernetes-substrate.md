# ADR-0037: P6 on Kubernetes is a substrate, not the deprecated Knative path

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-02
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-02-p6-on-kubernetes-slice1-design.md`](../specs/2026-10-02-p6-on-kubernetes-slice1-design.md)

## Context

RA1 (`docs/specs/2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md` §4) makes P4/P6
the primary deployment model and then deprecates "the Kubernetes/Knative/KEDA path". Epic #426 runs
P6 -- the supervisor and its forked workers, the relay, Redis, the MU1 control plane and container
sandboxes -- as ordinary Kubernetes workloads, leaving only P4 on a VM or bare metal. Without a
recorded distinction, a later "deprecate K8s" sweep would take this with it.

## Decision

1. **What RA1 deprecates is a deployment model, not a substrate:** the Knative Service, KEDA,
   `KubectlTransport` and pod-exec sandboxes (`deploy/knative/`, the K8s half of
   `packages/k8s-sandbox`).
2. **P6 on Kubernetes (`deploy/k8s/`, milestone P6.1) is the P6 process model with Kubernetes as its
   substrate.** It uses `GrpcRelayTransport` and records-based discovery, exactly as `deploy/vm/`
   does. It shares no code and no manifest with `deploy/knative/`, and RA1's deprecation does not
   apply to it.
3. **The supervisor is reached over L4 only.** Its hand-off, routing and admission are per
   connection (ADR-0034). An L7 hop that pools upstream connections -- an Ingress, an edge Route, a
   mesh sidecar, Knative's queue-proxy -- silently defeats them. On OpenShift, TLS is terminated by
   an L4 sidecar behind a passthrough Route.

## Consequences

- `deploy/k8s/` is maintained as a first-class deployment beside `deploy/vm/` and `deploy/compose/`.
- Isolation that the VM gets from podman `isolate=strict` and nftables comes from namespaces and
  NetworkPolicy here, so a CNI that enforces NetworkPolicy is a hard requirement.
- Any proposal to put an L7 proxy in front of the supervisor has to supersede point 3 of this ADR.
