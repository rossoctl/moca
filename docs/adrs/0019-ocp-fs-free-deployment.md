# ADR-0019: Durable RWO EBS Sandbox CR, non-root under nonroot-v2, for the OCP FS-free deployment

- **Status:** Implemented
- **Date:** 2026-07-02
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-07-02-p0prime-ocp-fs-free-deployment-design.md`](../specs/2026-07-02-p0prime-ocp-fs-free-deployment-design.md)

## Context

The FS-free harness (P1) is merged and Kind-verified but has never run on OpenShift. The live OCP
4.20.8 cluster offers only RWO EBS storage (no RWX) and enforces SCCs, and the pre-P1 OCP overlay was
speculative and broken in four ways. We must deploy the harness durably and non-root on OCP without
weakening the P1 threat model (harness has zero FS/exec surface; sandbox is a passive exec target).

## Decision

We will realize P1 on OCP by backing the sandbox `/workspace` with a durable RWO EBS PVC from the
agent-sandbox `Sandbox` CR's `volumeClaimTemplates`, and run both harness and sandbox tiers non-root
(UID 65532, `fsGroup: 65532`) bound under the `nonroot-v2` SCC.

### Alternatives considered

- **`emptyDir` for `/workspace`** — the broken overlay's behavior; defeats durable storage and silently breaks the crash/resume smoke claim.
- **`restricted-v2` with SCC-injected UID** — SCC UID injection was unreliable; pinning `runAsUser: 65532` under `nonroot-v2` sidesteps it. No `anyuid`/privileged.
- **Pull the GHCR sandbox image** — GHCR `:latest` only rebuilds on merge, so the ripgrep fix cannot reach it pre-merge; keep the in-cluster BuildConfig for P0′.

## Consequences

- Positive: a real, durable, non-root end-to-end OCP deployment proven by the full leaf smoke; a Stage-1 walking skeleton de-risks CR propagation before harness wiring.
- Negative / accepted cost: RWO limits the sandbox to single durable storage (no shared pool here); patching a container inside a CRD podTemplate needs a JSON6902 kustomize workaround; the sandbox image lacked ripgrep (fixed in the Dockerfile).
- Follow-up owed: switch the OCP overlay to the GHCR sandbox image post-merge; shared pool/RWX/Kata deferred to P2/P3.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
