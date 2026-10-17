# ADR-0042: Offer the P4 tier to an internal cohort on `sandbox/v1` as it is, behind per-sandbox tokens from a control-plane `sandbox` profile

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-15
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md)

## Context

The P4 tier runs every command in a fresh Firecracker microVM over a persistent workspace
(ADR-0035). A prototype pointed stock Claude Code and OpenCode at it from a laptop: they ran with no
fork, with their local tools denied, through an MCP server (rossoctl/moca#504) or a thin CLI over
`sandbox/v1`. On a 10-issue SWE-bench Verified subset they resolved the same issues as when run
locally, and the sandbox took 2–6% of wall-clock time. An exec review then asked for a service that
a small internal cohort can use, and decided that it should **not** adopt a standardized data-plane
API (agent-sandbox's sandboxd was the candidate) while those APIs are still evolving. What MOCA
already supports over gRPC is enough.

Five gaps separate the prototype from that service:

- **Reachability.** The relay's exec port is plain-text and bound to loopback, reached through an
  SSH tunnel.
- **Identity.** Callers hold static client tokens that an operator issues by hand, scoped to a
  `workspace_key` prefix.
- **Lifecycle.** None. A workspace exists from its first `Exec`, and idle reclaim deletes it without
  notice (#338).
- **Network.** The guest has none, so no package installs.
- **Operations.** No quotas, no audit and no disk control. Workspace disk is not admission-controlled
  on the worker; only VM memory is.

The MOCA control plane already has a reviewed GitHub device-flow login, rotating refresh tokens
(ADR-0039), an Ed25519 signer whose public half can be handed to verifiers, and per-subject
ownership. P6.2 already lets a KVM host outside a cluster attach its worker to an in-cluster relay
over TLS through a ghostunnel sidecar and a passthrough Route.

## Decision

We will offer the P4 tier to an internal cohort as **SBX0**, a deliberately minimal service built
from what already runs:

- **Data plane:** `sandbox/v1` (`SandboxExec.Exec` / `Abort`) **as it is**, with no proto change and
  no worker change. Changes stay additive under ADR-0024's rules. No sandboxd adapter.
- **Front door:** the relay in its own namespace on a shared cluster. Its exec and attach listeners
  sit behind ghostunnel and passthrough Routes (P6.2's pattern), and the KVM host's workers dial
  out to it.
- **Identity and lifecycle:** a **second control-plane instance in a `sandbox` route profile**. It
  serves the existing login routes plus an explicit sandbox resource (create, list, get, delete,
  with a fixed absolute lifetime). It mints a short-lived Ed25519 **sandbox token**
  (`typ: moca-sandbox+jwt`, `aud: moca-sandbox`) naming exactly one worker (`wrk`) and one workspace
  key (`wsk`). The relay verifies it with public keys only and requires an exact match on both.
  Because every sandbox of a template shares one worker, the relay also:
  - namespaces each sandbox's `req_id`s before they reach the worker, so dedup and Abort never
    cross sandboxes;
  - cancels an Exec when its token expires;
  - caps in-flight Execs per sandbox.
- **Clients:** `mocactl sbx`, which pushes the working tree in, pulls a patch out, runs commands, and
  serves seven sandbox tools as a **local stdio MCP server**. There is no hosted MCP server or OAuth
  authorization server. The gRPC client, the tools (Pi's names and schemas, reimplemented without
  Pi) and the MCP server live in a new package, `@moca/sandbox-client`. It is the **second named
  exception** to ADR-0036's rule against `workspace:*` dependencies, after ADR-0038's `@moca/config-bundle`,
  and is justified the same way, in ADR-0038's words: no Pi, no server internals, no substrate
  assumptions. The one-entry
  allow-list in `mocactl`'s `layering.test.ts` becomes a two-entry list naming this ADR.
- **No silent reset**, held by invariants rather than worker changes:
  - the control plane owns the lifetime;
  - the worker's idle reclaim is set longer than any sandbox can live;
  - a janitor on the host frees the disk of terminated sandboxes.

Templates are one `microvm-worker` per golden snapshot. The guest has no network until allowlisted
egress, the next increment.

### Alternatives considered

- **Adopt sandboxd as the data plane** (the exploratory SBX1 design). Rejected at the exec review:
  the standard is young and still moving, and an adapter adds a layer the cohort does not need.
- **A new standalone lifecycle and auth service.** It re-implements device flow, refresh families
  and their stores for no gain at this scale. A route profile can be split out later if the
  products diverge.
- **Sandboxes as MOCA sessions.** Almost no new code, but the relay would accept `aud: harness`
  tokens, which blurs the token separation MI1 depends on.
- **Keep static, operator-issued client tokens** (the prototype's). No login code, but revoking one
  means editing a Secret and restarting the relay. Used only in the first, team-only increment, from
  the prototype branch, and never merged.
- **Embedding Pi's tools in `mocactl`** (depending on `pi-coding-agent` and `@moca/k8s-sandbox`).
  One tool implementation, but it would break the condition ADR-0038 sets for an exception ("no
  Pi") and bundle Pi's TUI and AI packages into the client.
- **A separate MCP binary** built on Pi. It keeps ADR-0036 absolute, but users install two things,
  and the binary needs its own release channel and login code.
- **A hosted MCP server.** It would be a new internet-facing surface that holds user tokens, while
  `mocactl` is already needed on the laptop for push and pull.

## Consequences

- **Positive:** the cohort gets a usable service without waiting for a standard. Developers code
  against a contract that already has a conformance battery and six revisions of hardening
  (ADR-0024).
- **Positive:** a user reaches only their own sandboxes. Exact `wrk`/`wsk` binding replaces prefix
  matching, and the relay holds no signing key, so a compromised relay cannot mint.
- **Positive:** #338's silent reset is gone for SBX0 sandboxes. Expiry and deletion are visible
  states with a reason, never an empty workspace.
- **Positive:** the security-critical code (login, signing, refresh) is the control plane's existing,
  reviewed code. The new code is a route profile, a small resource and one more verifier caller kind.
- **Negative / accepted cost:**
  - `sandbox/v1` carries Pi-shaped conventions (bash-pipeline file operations; a `workspace_key`
    the client must echo) to clients that never knew Pi.
  - The `uint64` `req_id` must stay below 2^53, a known wire wart.
  - If a standard data plane is adopted later, this cohort's clients must migrate.
- **Negative / accepted cost:** delete takes effect only when the last minted token expires (≤ 15
  minutes, plus 30 s of clock leeway), and an Exec still running then is cancelled. The worker does
  not re-verify tokens, so it trusts the relay.
- **Negative / accepted cost:** the longest single command is one token lifetime (15 minutes by
  default). A longer lifetime allows longer commands, at the cost of a slower delete.
- **Negative / accepted cost:** one shared KVM host. Losing it ends every sandbox on it. The laptop
  keeps the original tree.
- **Negative / accepted cost:** the control plane's codebase now serves two products, selected by a
  route profile. An allow list per profile and a test that enumerates every route guard against a
  harness route leaking into the `sandbox` profile.
- **Negative / accepted cost:** ADR-0036's dependency rule gets a second exception. Two
  implementations of the seven tools exist (Pi's in the harness, `@moca/sandbox-client`'s for SBX0)
  until a shared transport-neutral tool layer is extracted. A contract test pins the client's tool
  names and schemas to Pi's.
- **Negative / accepted cost:** no network in the guest, so repositories whose dependencies the
  curated templates lack do not work yet.
- **Follow-up owed:** allowlisted egress (experiment E12, then P4.1's vsock transport), started in
  parallel with the first increment.
- **Follow-up owed:** the hardening increment:
  - a `Release` frame, so delete frees disk at once;
  - worker-side token re-verification, through MI1 S4's grant with a configurable signer;
  - immediate revocation;
  - per-host mTLS;
  - a second KVM host.
- **Follow-up owed:** retiring the prototype relay branch (`feat/relay-client-tokens`) once
  per-sandbox tokens land on `main`. Its static client tokens run only in the first, team-only
  increment and are never merged.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
