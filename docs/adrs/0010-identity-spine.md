# ADR-0010: Per-session SPIFFE identity, user in the attested path, minted solely by the orchestrator

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-06-26-identity-spine-design.md`](../specs/2026-06-26-identity-spine-design.md)

## Context

The credential track needs per-user isolation in a shared namespace under scale-to-zero, such that egress planes can resolve credentials per-user without any workload being able to assert or spoof who it is. Mesh workload identity is per-ServiceAccount by default: if many users' sessions share one namespace and SA, the mesh sees one identity and any per-user signal degrades to a spoofable header — letting a compromised session steal another user's credentials.

## Decision

We will mint a **per-session** SPIFFE identity with the attested user encoded in its path (e.g. `…/user/alice/session/<id>`), issued solely by a trusted, non-model-influenced orchestrator that alone holds `pods/create` and SPIRE-registration RBAC, and reconstructed on every wake from an orchestrator-owned binding store the harness cannot write.

### Alternatives considered

- **Per-namespace / per-SA identity** — rejected: collapses many users to one mesh identity; per-user routing becomes a spoofable header (the explicitly forbidden anti-pattern).
- **A `subject` header for per-user routing** — rejected: any session could spoof any user → cross-user credential theft.
- **Per-session ServiceAccount** — kept as fallback if ambient↔SPIRE integration proves rough; more K8s object churn.

## Consequences

- Positive: the resolver keys on a verified, unspoofable identity; scale-to-zero works with offline users via stored grants; binding tampering is prevented by write-isolation from the log.
- Negative / accepted cost: a new trusted control tier (the orchestrator, an identity-side crown jewel) with powerful RBAC; identity churn and SVID issuance latency per session/wake.
- Follow-up owed: the per-user credential store (Z5) and egress proxies (Z3/Z5) are separate; confirm the SPIRE-vs-SA identity layer before committing.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
