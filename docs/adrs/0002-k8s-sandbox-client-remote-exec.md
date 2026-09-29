# ADR-0002: Route Pi tool execution to a remote pod via `kubectl exec`

- **Status:** Implemented
- **Date:** 2026-06-17
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-17-m2-k8s-sandbox-client-design.md`](../specs/2026-06-17-m2-k8s-sandbox-client-design.md)

## Context

For MOCA, the agent's "hands" (file and shell tools) must run in an isolated remote sandbox, not on the harness head. Pi exposes pluggable `Operations` interfaces and a shipped SSH example demonstrates delegating them over a transport, so no Pi fork is needed — only a new transport and wiring.

## Decision

We will ship a `@moca/k8s-sandbox` package that routes all seven Pi Operations (read/write/edit/bash/ls/grep/find) to an existing pod through an injectable `execInPod` seam whose default implementation shells out to `kubectl exec`, gated on by the `KAGENTI_SANDBOX_POD` env var.

### Alternatives considered

- **Route only read/write/edit/bash (as the SSH example does)** — leaves ls/grep/find on the head's filesystem, so the model sees a mixed view; M2 routes all seven.
- **In-cluster API exec / ServiceAccount auth** — deferred; M2 uses the developer's local kubeconfig.
- **Dynamic pod provisioning** — out of scope; the client targets an already-running pod fixture.

## Consequences

- Positive: Every filesystem view the model sees is the pod's; zero new runtime deps; no pi-fork change; env-gated so default local behavior is unchanged.
- Negative / accepted cost: Each op is a fresh `kubectl exec` (per-op latency); naive `path.replace` cwd mapping; aborted commands may linger in-pod.
- Follow-up owed: Persistent in-pod channel (M3); pod lifecycle and in-cluster auth deferred.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
