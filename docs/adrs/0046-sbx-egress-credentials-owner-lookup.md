# ADR-0046: Inject user-scoped credentials at `moca-egress` for SBX microVMs, resolved by sandbox owner (phase 1), then by the user's sandbox token (phase 2)

- **Status:** Accepted (2026-10-28; phase 1 implemented by #630, #641, #646, live acceptance recorded in [docs/notes/sandbox-security-review.md](../notes/sandbox-security-review.md) §2.1; phase 2 owed) <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-26
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-26-sbx-egress-credentials-design.md`](../specs/2026-10-26-sbx-egress-credentials-design.md)
- **Refines:** [ADR-0042](0042-sbx0-sandbox-service-on-sandbox-v1.md) (the `sandbox` profile
  serves no credentials) and [ADR-0006](0006-generalized-credentialed-egress.md) (placeholder swap),
  for the SBX path only.

## Context

v0.8.0 gives `mocactl sbx` microVMs allowlisted egress through `moca-egress`, but the proxy has no
credentials, and the guest's `GH_TOKEN` and git helper send an inert placeholder. Users need to
reach GitHub (and later internal services) **as themselves** from a sandbox. The token must never
enter the guest, because the guest runs model-authored code and a compromised agent must not be able
to read or exfiltrate it.

The pieces exist but are not connected. The control plane has a per-user, envelope-encrypted
`CredentialStore` with a `sandbox-egress` consumer and host-scoped descriptors. `moca-egress` knows
which sandbox each connection comes from, from the listener that accepted it, and has a credential
seam that fails closed. MI1's designed route between them, session grants signed per turn (S2),
exists because a P6 worker multiplexes users and is only semi-trusted. The SBX path has no such
worker: the relay already verifies the user's sandbox token, and the worker is host glue.

## Decision

We will swap the placeholder at `moca-egress`: TLS interception with a per-host CA, **only** for
destinations the sandbox owner has a `sandbox-egress` credential for, with the credential's headers set
(overwriting whatever the guest sent).
Users manage these credentials with `mocactl sbx credentials` on the sandbox control plane, stored in
the `FileCredentialStore` on a PVC (Vault later, configuration only).

**Phase 1 (this decision's first implementation):** `moca-egress` resolves the credential by sending
`(sandbox id, host)` to the control plane, authenticated with a **per-KVM-host** egress token. The
control plane answers only for live sandboxes running on that host's workers and returns the owner's
matching credentials. The proxy caches them for at most the configured TTL (default 60 s; capped
by any credential's expiry).

**Phase 2 (owed, the more secure approach):** the user's sandbox token rides each `Exec` (the
`Exec.grant` field MI1 reserves) through the relay and worker to `moca-egress` (`Register`/`Rebind`),
and the control plane releases a credential only against a valid token for that sandbox, in addition
to the host token. Phase 2 does not change what users see, and it is the SBX path's version of MI1's
sandbox grant.

The lookup does not depend on the credential's type. A credential is selected by `(owner,
destination)`, where a destination is `host[:port][/path-prefix]`. It renders to one or more
headers. How its value is produced is a control-plane **resolver** behind the same contract:
static in phase 1, refreshed (OAuth 2.1) or exchanged (RFC 8693) later. Adding a resolver changes
neither the lookup wire nor `moca-egress`. GitHub is the first preset, and presets are reviewed data
(a catalog `mocactl` reads), so MCP servers and internal APIs are data additions.

The proxy enforces no repository- or path-level **policy**: users scope their tokens, for example
with a fine-grained PAT. Path-scoped credential **selection** (which credential a request carries,
for example one token per MCP server behind a single gateway host) is part of the destination above,
and is not ruled out by that.

### Alternatives considered

- **Token in the guest** (env or file): defeats the requirement. A compromised agent exfiltrates it.
- **Phase 2 from day one:** stronger, but it touches the proto, relay, worker, control protocol and
  token refresh. It was deferred in design review and kept as the named next step.
- **MI1 S2 grants for SBX:** a second signed token type and exchange that protect against a
  semi-trusted multiplexing worker SBX does not have. Phase 2 reuses the sandbox token instead.
- **Kubernetes Secret store:** it would give the sandbox control plane Kubernetes API access, which is
  a tested absence.
- **Vault now:** none is deployed. Standing one up would dominate the slice. **Amended 2026-11-20
  (moca#823):** still true of this slice's decision, but no longer true of the tree. The Vault store
  (`vault-store.ts`, `SH_CREDENTIAL_STORE=vault`) and a deploy Component that wires it
  (`deploy/k8s/overlays/ocp-sbx/egress-credentials-vault`, `SBX_CREDENTIAL_STORE=vault`) both exist;
  what is still absent is a Vault to point at, its policy and token supply, and a migration of what
  the file store already holds. The "Vault later, configuration only" framing above was right.
- **Secrets on the KVM host:** it concentrates every user's secrets where phase 2 aims to reduce
  exposure.

## Consequences

- Positive: `git`, `gh`, `curl` and Streamable-HTTP MCP clients work unmodified in a sandbox as the
  user, while the token stays out of the guest. Delivering it needs no proto, relay or worker change. MI1's interception design
  (§8.5, §8.7) gets its first implementation, which the harness's own microVM sessions can reuse.
- **Amended 2026-11-20 (moca#823):** the `Recreate`/one-replica cost below followed from the PVC, so
  the Vault Component does not impose it — KV v2 check-and-set makes concurrent writers safe, and that
  Component renders neither a PVC nor `Recreate`. It still leaves `replicas` at the base's 1: lifting
  the count needs the other single-replica assumptions checked, which Vault alone does not settle.
- Negative / accepted cost (phase 1): **a stolen host egress token yields the `sandbox-egress`
  credentials of every owner with a live sandbox on that host, usable from off the host, without
  any user's sandbox token**, for those sandboxes' lifetime. It is bounded per host, every issuance
  is audited, and root on the host already reaches in-flight credentials. Phase 2 removes it.
- Negative / accepted cost: TLS interception and a per-host CA baked into that host's snapshot (a
  CA rotation means a snapshot rebuild). A one-replica control plane with `Recreate` until Vault.
  A control-plane round trip per `(sandbox, host)` per TTL, failing closed (`503`) when the control
  plane is unreachable. Clients are offered HTTP/1.1 only.
- Follow-up owed: phase 2 (spec §9); an `oauth2-refresh` resolver for MCP servers with short-lived
  tokens (spec E11, §6.3); Vault as the store, with a one-off migration from the file
  store; egress wiring in `deploy/sbx/install-host.sh` (#623), a prerequisite. MI1's decision record
  must not use the number 0037, which ADR-0037 already holds.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
