# ADR-0003: Reuse a long-lived in-pod bash session for fast tool ops

- **Status:** Implemented
- **Date:** 2026-06-17
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-17-m3-persistent-channel-design.md`](../specs/2026-06-17-m3-persistent-channel-design.md)

## Context

M2 routes every tool op through a fresh `kubectl exec`, so each read/test/mkdir pays a full apiserver TLS handshake plus pod-exec plus bash startup. A burst of small file ops in one turn incurs N handshakes. The upgrade must stay harness-side (pi-fork untouched) and preserve M2's plain-Deployment, no-new-deps posture.

## Decision

We will add a `persistentExecInPod` transport — a single long-lived `kubectl exec -i … -- bash` session with a sentinel-bracketed, base64-framed protocol and a one-in-flight queue — behind the existing M2 `ExecInPod` seam, routing the fast request/response ops to it while streaming ops (bash/grep) keep per-call exec.

### Alternatives considered

- **Pod-side RPC server + port-forward** — breaks the plain-Deployment posture; needs a server in the image.
- **SPDY via `@kubernetes/client-node`** — heavy dependency and the same framing problem.
- **Route bash/grep over the channel too** — deferred; they stream, honor abort, and already amortize exec cost.

## Consequences

- Positive: A burst of fast ops costs one reused `kubectl` process instead of N; transparent fallback to one-shot exec keeps a dead channel from hard-failing; no new env vars.
- Negative / accepted cost: A custom framing protocol to unit-test; `rg --files` re-including an individually-gitignored file diverges slightly from Pi's `fd`.
- Follow-up owed: Streaming bash/grep over the channel (S-all) if profiling warrants.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
