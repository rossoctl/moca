# Z1 — Identity Spine: per-session workload identity bound to the user

Version: 1.0 — June 26, 2026
Status: Design (approved for implementation planning)
Scope: The **identity plane** the whole credential track stands on — how every session acquires a
**per-session SPIFFE identity bound to its human user**, who mints it, how that binding stays
trustworthy across scale-to-zero, and the abstract `CredentialInjector` interface that the
credential-using milestones (Z2/Z3/Z4/Z5) consume. This spec delivers **identity**, not the
credential stores themselves (those are Z5 / a separate dependency, §12).
Milestone: **Z1** (Phase 2). **Reframes the parent's M7** ("egress/identity spine"): the harness
gets a SPIFFE identity but **no egress waypoint** (Z2 §2.4 — its egress is fixed-destination); the
per-user egress plane is the sandbox's (Z5).
Source of truth for numbering: [Milestone Registry](README.md).
Parent design: [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2.1 principle, §2.3 portable-core/kagenti-binding, §3.2/§3.4 identities for sandbox & subagents, §4.1 log invariants (refined here, §6).
Consumed by: [Z2 Harness Lock-Down](2026-06-26-harness-lockdown-design.md) (harness SPIFFE id for mTLS to the injector; `pods/exec`-only RBAC), [Z3 Inference Injector](2026-06-26-inference-injector-design.md) (mTLS peer authz), [Z4 MCP code-mode](2026-06-18-m10-mcp-code-mode-design.md) + [Z5 Generalized Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) (per-user `(actor SVID ⊕ subject)` resolution).

> **The one-sentence thesis.** Per-user isolation in a shared namespace, under scale-to-zero,
> reduces to: _a trusted orchestrator mints a per-session SPIFFE identity with the user in the
> attested path, derived from a durable binding it alone can write, and reconstructs it on every
> wake_ — and everything else (harness, sandbox) is built untrusted around that.

---

## 1. Goal & scope

### Goal

Give every session a **per-session, mesh-verifiable identity bound to its human user**, such that
the egress planes (Z3 inference, Z5 sandbox) can resolve credentials per-user **without** any
workload being able to assert or spoof _who it is_ — including when **many users share one
namespace** and when sessions **scale to zero** between turns.

### In scope

- The **trust-tier model** (orchestrator / harness / sandbox) — §2.
- The **per-session identity model**: SPIFFE id with the user in the attested path; why
  per-namespace identity is insufficient — §3.
- The portable **`CredentialInjector` interface** + the **kagenti binding** (SPIRE + Istio ambient
  - waypoint + AuthBridge) — §4.
- The **orchestrator**: responsibilities, lifecycle, and the integrity invariant that only it can
  mint identity — §5.
- The **authoritative binding store**, integrity-protected and **separate from the model-influenced
  log** (a refinement of parent §4.1) — §6.
- **Scale-to-zero**: reconstruct identity from the durable binding on wake; nothing per-session
  persists in the mesh while idle — §7.

### Out of scope (Z5 / separate)

- **The per-user external-credential store** (linking/consent/rotation/revocation of GitHub PATs,
  OAuth grants, etc.). Z1 issues _identity_; Z5 resolves _credentials_ keyed by that identity. Z1
  records the dependency's shape (§12) but does not build it.
- **The egress proxies themselves** — the inference injector (Z3) and the sandbox waypoint/forward
  proxy (Z5). Z1 defines the interface they implement.
- **Sandbox filesystem/state persistence across scale-to-zero** — a separate track (parent §7).
- **Subagent fan-out mechanics** (Z6) — they reuse this plane (each subagent = its own session
  identity); no new identity mechanism is added there.

---

## 2. Trust tiers

Per-user isolation requires a control tier **above** both the brain and the hands. The identity
plane introduces it explicitly:

| Tier        | Component        | Trust                             | `pods/create`? | Mints identity? | Holds secrets?             |
| ----------- | ---------------- | --------------------------------- | -------------- | --------------- | -------------------------- |
| **Control** | **Orchestrator** | trusted; **not** model-influenced | **yes (sole)** | **yes (sole)**  | no                         |
| **Brain**   | Harness          | semi-trusted (untrusted _data_)   | **no**         | no              | no (Z2)                    |
| **Hands**   | Sandbox          | untrusted (model code)            | no             | no              | no (Z5; uses, never reads) |

The orchestrator is the new element. It is shared, long-lived control-plane infrastructure (in
kagenti: the operator extended with a **Session controller**), not a per-session pod and **not**
scale-to-zero. It provisions _identity_; it never touches per-user secrets, which keeps it out of
the credential blast radius even though it is the identity-side crown jewel (§9).

---

## 3. Identity model

### 3.1 Per-session SPIFFE id, user in the attested path

Each session's **sandbox** pod (egress originates in the hands, not the brain) receives a unique
SPIFFE id whose path carries the **attested** user, e.g.:

```
spiffe://<trust-domain>/ns/team1/user/alice/session/<session-id>
```

The egress planes resolve credentials by reading this id at the proxy — no separate lookup, no
asserted header. The id is issued by the trusted identity provider (SPIRE) **only** to a pod whose
node-attested selectors match the registration the orchestrator created; the workload cannot choose
its own path.

### 3.2 Why per-namespace identity is insufficient (the multi-user case)

Mesh workload identity is per-**ServiceAccount** by default (`…/ns/<ns>/sa/<sa>`). If many users'
sessions share one namespace **and one SA**, the mesh sees a **single identity** for all of them —
and any per-user signal degrades to a **spoofable header**, letting a compromised session claim
another user and steal their credentials. **The namespace is not the isolation boundary; the
per-session identity is.** Therefore identity must be minted **per session**, finer than the
namespace/SA.

### 3.3 Issuance mechanism

- **Recommended: SPIRE per-pod registration.** kagenti already runs SPIRE and injects a
  `spiffe-helper` sidecar, so per-pod SVIDs are native and avoid per-session ServiceAccount/RBAC
  churn; the SPIFFE path can encode the user. The orchestrator creates a registration entry (via the
  SPIRE controller-manager `ClusterSPIFFEID`/CRs or the SPIRE API) at provisioning.
- **Fallback: per-session ServiceAccount** (identity from the SA token) if ambient/ztunnel ↔ SPIRE
  identity integration proves rough. Same result, more K8s object churn.
- **Verify before building:** which layer carries the trusted per-session identity to the resolver —
  ztunnel's L4 mTLS principal vs. AuthBridge's SPIFFE **JWT-SVID** actor assertion (kagenti's
  AuthBridge already uses the latter for RFC 8693). The resolver keys on whichever is authoritative;
  this choice gates the SPIRE-vs-SA decision above.

---

## 4. The `CredentialInjector` interface & kagenti binding

### 4.1 Portable core (technology-neutral)

The spine is one abstract contract: **`identity → egress credential injection`.**

```
interface CredentialInjector:
  # at egress, given the verified workload identity and the destination,
  # resolve and inject the credential. The caller never sees the secret.
  inject(verifiedIdentity, destination, request) -> request'   # secret added downstream of any log
  # identity is a verified reference (SPIFFE id); resolution of identity→secret
  # happens ONLY here, never in the harness, sandbox, prompt, or log.
```

The interface does not depend on SPIRE, Envoy, or Keycloak — a non-kagenti cluster can implement it
with a minimal secret-holding sidecar behind the same contract. This is what keeps moca
portable (parent §2.3) and what makes Z3 (provider key) and Z5 (per-user egress) two _implementations_
of one idea rather than two designs.

### 4.2 kagenti reference binding

| Concern            | Binding                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity issuance  | **SPIRE** issues per-session SVIDs (§3.3); `spiffe-helper` delivers them in-pod.                                                                                                                                                           |
| Transport identity | **Istio ambient ztunnel** — L4 mTLS, verified `source.principal` per pod.                                                                                                                                                                  |
| L7 injection point | **waypoint** (Envoy) — the only place headers/credentials are set. ztunnel (L4) cannot inject. **One shared waypoint per namespace** serves many per-session identities; it keys on `source.principal`, so it does **not** churn per user. |
| Resolution         | **AuthBridge** ext-proc reads the verified identity → `(actor SVID ⊕ subject)` → mint (RFC 8693) or fetch stored grant (Z5) → inject.                                                                                                      |

The harness path (Z3) is the _trivial_ implementation: identity gates mTLS to the injector; the
credential is a non-per-user provider key. The sandbox path (Z5) is the _full_ implementation:
identity → user → that user's grant.

---

## 5. The orchestrator

### 5.1 Responsibilities (lifecycle)

- **Create:** authenticate the user (or accept the gateway/Keycloak assertion) → allocate
  `session-id` → write the **authoritative `session-id → user` binding** (§6) → mint the per-session
  SPIRE registration with the user in the attested path → provision the identity-bearing sandbox pod.
  _This is the one point a live user identity is required._
- **Wake:** receive the wake signal for `session-id` → read the binding from the durable store →
  reconstruct the SPIRE entry + sandbox pod with the correct identity → hand the harness a _reference_
  to connect to. **No live user re-auth** — wake is unattended (§7).
- **Idle (scale-to-zero):** tear down the sandbox pod and reap the SPIRE entry; **keep** the binding.
- **End / GC:** delete binding + entry; TTL-reap abandoned sessions.

### 5.2 The integrity invariant

> **Only the orchestrator can (a) create session pods and (b) create SPIRE entries.** Nothing else
> has the RBAC.

This is the single rule that makes per-user isolation real. Consequences enforced elsewhere:

- The **harness has no `pods/create`** (Z2 L5 scopes it to `pods/exec` on sandbox pods only) → a
  compromised harness **cannot** mint a pod bearing another user's identity; it can only connect to a
  sandbox the orchestrator already provisioned.
- **Selectors key on attested, orchestrator-set attributes** (SA / namespace / node-attested fields),
  never a workload-settable free-form label.
- **Optional admission policy** (Kyverno / validating webhook): reject any pod carrying identity
  labels unless created by the orchestrator's ServiceAccount — belt-and-suspenders.

---

## 6. Authoritative binding store (refinement of parent §4.1)

The durable session record holds **two kinds of data that must not share a writer**:

1. the **append-only, model-influenced log** — the spine; **the harness writes it**; and
2. the **authoritative `session → user` binding** — used for credential resolution.

If these share one harness-writable structure, a compromised harness could rewrite
`user: bob → alice` and escalate. Therefore:

- The binding lives in an **orchestrator-owned, integrity-protected store** (Redis ACL-scoped key / a
  Session CR / Keycloak) that the **harness cannot write**.
- The log may still _reference_ identity for **audit** (§4.1 holds for audit), but it is **not
  authoritative** for resolution.

This sharpens parent §4.1 ("identity referenced by SPIFFE string only"): a SPIFFE string in the log is
fine _as audit_, but the **resolution-authoritative** binding is orchestrator-owned and write-isolated
from the log.

---

## 7. Scale-to-zero: reconstruct, don't persist

Identity follows the harness's core philosophy — **reconstructed from the durable record on wake,
never kept alive while idle.**

```
turn for session X arrives
  → orchestrator reads X → user=alice from the AUTHORITATIVE binding store (§6)
  → reconstruct SPIRE entry (path …/user/alice/session/X) + sandbox pod (attested selectors)
  → spiffe-helper fetches a FRESH SVID  (same identity, new cert)
  → model code egresses → waypoint → AuthBridge reads SVID(user=alice)
       → fetch/refresh alice's STORED grant (Z5)  → placeholder-swap → egress AS alice
  → idle again → pod torn down, SPIRE entry reaped; binding persists
```

Two properties make this clean:

- **No credential is ever cached in-pod** — resolution fetches the grant fresh at egress every time,
  so teardown loses nothing credential-related.
- **Stored-grant resolution (Z5 §4.2) means the user may be offline** at wake. Scale-to-zero is the
  _payoff case_ for choosing stored grants over live user tokens: a session can act as Alice while
  Alice is offline. A live-token design would break here.

A long-idle wake may find the stored grant expired/revoked → egress returns a clean auth error (Z5:
**no silent fallback**).

---

## 8. Key decisions

| #   | Decision             | Choice                                                                                                                                                            |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID1 | Identity granularity | **Per-session**, finer than namespace/SA. The namespace is not the isolation boundary (§3.2).                                                                     |
| ID2 | User binding         | **User in the attested SVID path**, set by the orchestrator at mint time; the resolver reads it — no asserted header (§3.1).                                      |
| ID3 | Issuance             | **SPIRE per-pod registration** (kagenti-native; `spiffe-helper` already present); per-session SA as fallback (§3.3).                                              |
| ID4 | Interface            | **Abstract `CredentialInjector`** (`identity → egress injection`); kagenti binding = SPIRE + ambient + waypoint + AuthBridge (§4). Z3 and Z5 are implementations. |
| ID5 | Minting authority    | **Orchestrator only** creates session pods and SPIRE entries; harness has no `pods/create` (§5.2).                                                                |
| ID6 | Binding store        | **Orchestrator-owned, integrity-protected, separate from the harness-writable log** (§6).                                                                         |
| ID7 | Scale-to-zero        | **Reconstruct identity on wake from the durable binding; reap on idle.** No per-session mesh state while sleeping (§7).                                           |
| ID8 | Live user auth       | **At session creation only.** Wake is unattended, trusting the durable binding + stored grant (§7).                                                               |
| ID9 | Harness reframing    | Harness gets a SPIFFE id but **no egress waypoint** (parent M7 reframed; Z2 §2.4). The per-user egress plane is the sandbox's (Z5).                               |

---

## 9. Threat model & blast radius (honest)

- **The orchestrator is the identity-side crown jewel.** If compromised, it can mint an SVID bound to
  _any_ user and drive egress to **use** that user's stored grant — i.e. impersonate any user. It
  never holds the raw secrets (those stay in the cred store, injected at the waypoint), but it can
  cause their use. This mirrors the injector's role on the provider-key side (Z3): the trust core is
  two small, non-model-influenced concentration points.
- **Mitigations:** minimal non-model-influenced surface; strong RBAC; an **audit trail of every
  identity-minting action** (who minted `…/user/alice/session/X`, from which authenticated request);
  and ideally **separation of duties** — the component that _authenticates the user_ distinct from the
  one that _mints entries_, so neither alone can impersonate.
- **The fatal anti-pattern (explicitly forbidden):** shared namespace SA + a `subject` header for
  per-user routing → any session spoofs any user → cross-user credential theft (§3.2).
- **Spoofing the SVID:** a workload cannot obtain another session's SVID without compromising SPIRE or
  the node; ztunnel enforces identity at the node. The invariant "one session = one pod = one
  identity" (fresh sandbox per session) keeps identities from collapsing.
- **Binding tampering:** prevented by §6 (binding is not harness-writable).

---

## 10. Verification gate

Z1 passes when, on a Kind cluster with SPIRE + Istio ambient + the orchestrator + a stub egress
resolver, in **one shared namespace**:

1. **Per-user isolation:** two sessions for distinct users (alice, bob) in the same namespace receive
   **distinct** SVIDs with their user in the attested path; the stub resolver, keying only on the
   verified identity, attributes each correctly.
2. **No spoof:** a session cannot acquire another user's identity — it has no `pods/create`, and a pod
   that tries to carry a foreign identity label (created out-of-band) is rejected by admission and/or
   fails SPIRE attestation.
3. **Binding integrity:** the harness cannot modify the authoritative `session → user` binding (write
   attempt denied); tampering the log does not change resolution.
4. **Reconstruct-on-wake:** scale a session to zero and wake it; it comes back with the **same**
   identity (path), minted fresh from the durable binding, with no per-session SPIRE state having
   persisted during idle.
5. **Minting audit:** every identity mint produced an audit record tying the SVID to an authenticated
   creating request; no secret appears in it.

---

## 11. Consequences & trade-offs

1. **A new trusted tier to operate.** The orchestrator (Session controller) is real control-plane
   surface with powerful RBAC. Justified: per-user isolation has no cheaper root.
2. **Identity churn per session.** Mint on create/wake, reap on idle/end — SPIRE entry/pod lifecycle
   work, plus a TTL reaper for abandoned sessions. Cold-start now includes SVID issuance (seconds).
3. **Two concentration points** (orchestrator for identity, injector for provider key). Accepted; both
   are small, non-model-influenced, and the focus of hardening.
4. **Ambient + SPIRE integration is a verification risk** (§3.3) — confirm the trusted identity layer
   before committing to SPIRE-per-pod vs per-session SA.
5. **Live user only at creation.** Good for unattended wake (§7), but means the create-time
   authentication + binding write is a critical, audited step.

---

## 12. Dependencies & what Z1 does NOT build

- **Per-user external-credential store (Z5 / parent M7–M9).** Z1 issues identity; Z5 resolves
  credentials keyed by it. Recorded shape (from M13 §4.2): keyed `(user, destination)`; consent,
  rotation, revocation first-class; at rest in the identity plane (Keycloak + proxy-sidecar memory),
  **never** in harness/sandbox; on expiry/revoke, a clean auth error with no silent fallback.
- **The egress proxies** (Z3 injector, Z5 waypoint/forward proxy) — implementations of §4's interface.
- **Sandbox FS persistence across scale-to-zero** — separate track.

---

## 13. References

- [Milestone Registry](README.md) — Phase 2 numbering; Z1 supersedes parent M7.
- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2.1 principle, §2.3 portable-core/kagenti-binding, §3.2/§3.4 identities, §4.1 log invariants (refined §6 here).
- [Z2 Harness Lock-Down](2026-06-26-harness-lockdown-design.md) — `pods/exec`-only RBAC (the integrity invariant's enforcement), harness SPIFFE id.
- [Z3 Inference Injector](2026-06-26-inference-injector-design.md) — the trivial (non-per-user) implementation of §4; mTLS peer authz.
- [Z4 MCP code-mode](2026-06-18-m10-mcp-code-mode-design.md) / [Z5 Generalized Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — the full per-user `(actor SVID ⊕ subject)` implementation; the credential store Z1 depends on.
- kagenti: SPIRE/SPIFFE (`spiffe-helper`, controller-manager `ClusterSPIFFEID`), Istio ambient (ztunnel L4 mTLS, waypoint L7), AuthBridge (RFC 8693, SPIFFE JWT-SVID actor assertion).
- RFC 8693 — OAuth 2.0 Token Exchange (`subject_token`, `actor_token`, `audience`).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
