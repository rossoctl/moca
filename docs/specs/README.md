# MOCA — Milestone Registry

**This document is the source of truth for milestone numbering and status.** It supersedes the
milestone table in the parent research doc
([Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §5, "M7–M12"),
whose numbering collided with the built work and was partly reframed by the June-26
credential-plane re-examination.

## Why a registry

Two work streams accreted overlapping `M`-numbers:

- The **built** harness work ran `M1–M7`.
- The **design-only** zero-trust credential plane (parent research doc) _also_ started at `M7`, and
  later specs (`m10-mcp-code-mode`, `m13-…-egress`) reused/diverged from the parent's numbers.

Net effect: `M7` meant two different things, `M10` meant two different things (the parent's MCP
_gateway_ vs. the spec that _superseded_ it with code-mode), `M13` was self-labeled "provisional,"
and the June-26 harness specs had no number at all.

**Resolution:** freeze the built track as **Phase 1 (`M1–M7`)**; give the credential plane its own
**Phase 2 (`Z`-prefix)**. No spec files are renamed — dated, descriptive filenames stay, so existing
cross-references keep working. Pre-existing `M10`/`M13` labels are recorded here as **aliases**.

---

## Phase 1 — Decoupled Harness (BUILT, frozen)

The decoupled scale-to-zero pattern. These are done and referenced across commits, memory, and
`EXPERIMENTS.md`. **Frozen — do not renumber.**

| ID  | Title                                           | Spec                                                                                                       |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M1  | Redis session backend                           | [`2026-06-16-m1-redis-session-backend-design.md`](2026-06-16-m1-redis-session-backend-design.md)           |
| M2  | `K8sSandboxClient` (Pi Operations → remote pod) | [`2026-06-17-m2-k8s-sandbox-client-design.md`](2026-06-17-m2-k8s-sandbox-client-design.md)                 |
| M3  | Persistent in-pod channel                       | [`2026-06-17-m3-persistent-channel-design.md`](2026-06-17-m3-persistent-channel-design.md)                 |
| M4  | Knative serverless wrapper (`runTurn`)          | [`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md) |
| M5  | Compaction-checkpoint fast path + budget voter  | [`2026-06-23-m5-compaction-checkpoint-design.md`](2026-06-23-m5-compaction-checkpoint-design.md)           |
| M6  | Experiments E2/E5 (`@sh/experiments`)           | [`2026-06-24-m6-experiments-design.md`](2026-06-24-m6-experiments-design.md)                               |
| M7  | Cluster experiments E1/E3/E4                    | [`2026-06-25-m7-cluster-experiments-design.md`](2026-06-25-m7-cluster-experiments-design.md)               |

> **Collision note:** Phase-1 `M7` (_cluster experiments_, built) is **not** the parent doc's `M7`
> (_egress/identity spine_, design). The latter is now **Z1** below.

---

## Leaf-Session Backend (BUILT)

The MVP leaf-session contract and the three pipeline archetypes it was tested against
([Pipeline Archetypes](2026-06-26-pipeline-archetypes-requirements.md)) — all shipped. These realize
the [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) §5 MVP core and §8
promote-post-MVP (human-gate, cron trigger). They are the **MVP/charter track**, distinct from the
`M`-numbered built harness (Phase 1) and the `Z`-numbered credential plane (Phase 2).

| Slice                                                                                                                | Spec                                                                                               | PR(s)    |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| MVP leaf-session invocation contract (run-to-completion, structured output, volume envelope) + gate-7 durable resume | [`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md) | #10, #11 |
| Async leaf completion (KEDA `ScaledJob` + Redis Streams queue, done-marker)                                          | [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md)         | #12      |
| Scheduled leaf dispatch (cron trigger on-ramp, Archetype C)                                                          | [`2026-06-28-scheduled-leaf-dispatch-design.md`](2026-06-28-scheduled-leaf-dispatch-design.md)     | #13      |
| Human-gate (gate-while-idle, Archetype B)                                                                            | [`2026-06-28-human-gate-design.md`](2026-06-28-human-gate-design.md)                               | #14      |

All three archetypes (A parallel-fan-out, B human-gate, C scheduled) from the evidence base are now
built. Hardening hygiene across these is tracked in
[`2026-06-28-registry-hardening-hygiene-design.md`](2026-06-28-registry-hardening-hygiene-design.md).

---

## Two-tier Rearchitecture (`P`-prefix)

The [two-tier FS-free harness epic](https://github.com/rossoctl/moca/issues/49): split
the fleet into an FS-free **harness** (agent brain — credentials, model loop, network I/O only) and a
durable **sandbox** (sole filesystem/syscall surface). Started as "run Archetype-A on OpenShift"; the
OCP RWX pain turned out to be a _symptom_ of harness filesystem I/O, not the problem. Distinct from
the `M`-numbered built harness (Phase 1) and the `Z`-numbered credential plane (Phase 2): this is an
**architecture** track, dependency-ordered `P1 → P2 → P0′ → P3`.

| ID       | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                             | Spec / issue                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**   | **FS-free harness** — leaf envelope + human-gate off the filesystem (inline + Redis); sandbox working set `emptyDir` → agent-sandbox `Sandbox` CR durable PVC                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **design ✅**                      | [`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md) (#45)                                                                             |
| **P2**   | **Shared sandbox pool + routing** — N distinct `Sandbox` CRs (per-sandbox RWO copy, no RWX), harness-side pick + Redis leases, ref-pinned lazy converge, static-N config knob                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **design ✅**                      | [`2026-07-02-p2-shared-sandbox-pool-design.md`](2026-07-02-p2-shared-sandbox-pool-design.md) (#46)                                                                     |
| **P0′**  | OpenShift deployment of the FS-free harness — **P1 slice** (single durable RWO sandbox on OCP 4.20.8, full leaf smoke via Route)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **design ✅**                      | [`2026-07-02-p0prime-ocp-fs-free-deployment-design.md`](2026-07-02-p0prime-ocp-fs-free-deployment-design.md) (#47)                                                     |
| **P3**   | **Sandbox sharing-ratio experiments** — measure the per-sandbox concurrency knee (→ `KAGENTI_SANDBOX_CAP`) and derived provisioning ratio N on runc; E6 saturation curve + E7 converge contention (delivers the deferred P2 live mixed-ref validation); in-cluster git-daemon substrate; Kind-dev → OCP-authoritative                                                                                                                                                                                                                                                                                                                     | **built ✅** (PR #58, OCP PR #61)  | [`2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`](2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md) (#48)                                         |
| **P3.1** | **E6 workload-parameterized sandbox-load** — replace the trivial marker-check leaf with real Archetype-A code-review variants (L0/L1/L2); report N as a curve over per-leaf sandbox work (not one optimistic number); raise `max-scale`, warm baseline, multi-sample, sustained-decline `detectKnee`                                                                                                                                                                                                                                                                                                                                      | **design ✅**                      | [`2026-07-03-e6-workload-parameterized-sandbox-load-design.md`](2026-07-03-e6-workload-parameterized-sandbox-load-design.md) (#62)                                     |
| **P4**   | **MicroVM sandbox tier** — one ephemeral microVM per `Exec` behind the unchanged `Attach` wire contract, warm-standby-provisioned so VM creation never sits inside a request; `microvm-worker` + `vmpool`, one additive `workspace_key` proto field. Delivers **E10** lifecycle primitives + **E11** density/replenishment ceiling. The "no nested KVM" infra gate is retired by EC2 nested virt (Feb 2026) + P6's VM substrate. gVisor/Kata arms still deferred                                                                                                                                                                          | **design ✅ (infra gate retired)** | [`2026-09-09-p4-microvm-sandbox-design.md`](2026-09-09-p4-microvm-sandbox-design.md); [ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md) (#57)                  |
| **P4.1** | **MicroVM egress transport** — reaching **Z5**'s credentialed-egress proxy from a Firecracker guest that has **no network device**: vsock hop (`CID 2:1025` → `<jail>/run/v.sock_1025`), one **shared** host proxy replacing RC1 Profile B's per-sandbox sidecar (density: Σ PSS 0.41 GB for 128 VMs), caller identity behind an interface whose first implementation is the jail socket path — a scoped, tier-local discharge of **Z1** for this one hop. Queried KB and long-term memory become Z5 allowlist destinations, so **no host filesystem mount** is needed. Gated by **E12** (guest-initiated vsock across restore, unproven) | **design (proposed)**              | [`2026-09-15-p4-1-microvm-egress-transport-design.md`](2026-09-15-p4-1-microvm-egress-transport-design.md)                                                             |
| **P5**   | **Multi-session harness isolation** — N concurrent Pi sessions per process made provably isolated: per-request subject (`X-SH-Subject`) → inert placeholder, no ambient credential in server mode, fail-closed; the other four #220 globals **pinned by reachability tests, not refactored** (no `pi-fork` change)                                                                                                                                                                                                                                                                                                                        | **design ✅**                      | [`2026-09-06-p5-session-isolation-design.md`](2026-09-06-p5-session-isolation-design.md) (#220); [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md) |
| **P6**   | **VM process manager + session mux** — the deferred deployment-model slice, off Kubernetes: `sh-supervisor` hands accepted **sockets** to a pool of multiplexing `sh-worker` processes, never touching a response byte; #55 overload as admission control. Delivers **E8** density + **E9** deployment comparison                                                                                                                                                                                                                                                                                                                         | **design (proposed)**              | [`2026-09-08-p6-vm-process-manager-design.md`](2026-09-08-p6-vm-process-manager-design.md); [ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md)              |
| **P6.1** | **P6 on Kubernetes** — the P6 process model (supervisor + forked workers, relay, Redis, MU1 control plane, `remote-worker` container sandboxes) as Kubernetes workloads on Kind and OpenShift: namespaces + NetworkPolicy replace `isolate=strict`/nftables, L4-only supervisor ingress (ghostunnel + passthrough Route on OCP). A substrate, **not** the Knative path RA1 deprecates. Slice 1 of epic #426; P4 attach (#424) and tier/affinity (#425) follow                                                                                                                                                                             | **design (proposed)**              | [`2026-10-02-p6-on-kubernetes-slice1-design.md`](2026-10-02-p6-on-kubernetes-slice1-design.md) (#423)                                                                  |
| **P6.2** | **P6 on Kubernetes, slice 2: external P4 hosts.** A KVM host outside the cluster runs `microvm-worker` against the in-cluster relay through an L4 TLS sidecar behind a passthrough Route. The cluster issues the host's token, which the relay reloads from a mounted Secret without a restart. `RELAY_CA_FILE` in the workers. `setup-microvm.sh --remote`. Mixed tiers and several P4 hosts: P6.3. Slice 2 of epic #426                                                                                                                                                                                                                 | **implemented**                    | [`2026-10-04-p6-on-kubernetes-slice2-design.md`](2026-10-04-p6-on-kubernetes-slice2-design.md) (#424)                                                                  |
| **P6.3** | **P6 on Kubernetes, slice 3: sandbox tiers and session-to-sandbox affinity.** A session picks an operator-defined tier (`moca.dev/tier`) at creation; every turn stays in that tier and on the sandbox that served the previous turn (data-plane Redis affinity), waiting 503 for an absent sandbox for a grace period before a recorded in-tier fallback. Lifts the one-tier and one-P4-host limits on both the VM and Kubernetes paths. Slice 3 of epic #426                                                                                                                                                                            | **implemented**                    | [`2026-10-04-p6-on-kubernetes-slice3-design.md`](2026-10-04-p6-on-kubernetes-slice3-design.md) (#425)                                                                  |

> **Supersedes** the local un-pushed `docs/archetype-a-ocp-support` branch (NFS-RWX-for-harness):
> after P1 the harness mounts nothing, so the harness never co-mounts `/work`. Reference only.

> **P5 covers only the concurrency-safety half of #220.** The deployment-model change (KEDA
> `ScaledJob` → elastic pod pool, the pod-count/activation numbers, and #55's overload shift from
> pod-level to session-level) is a **separate slice** — now **P6**, on a non-Kubernetes substrate.
> End-to-end multi-tenancy additionally needs **per-subject resolution at the injector** — Z5's
> deferred per-user / RFC 8693 half, in `kagenti-extensions`. P5 is the strict prerequisite for that
> work (the injector cannot key on a subject the harness never sends) and claims no more.

---

## SandboxTransport (`ST`-prefix)

Make the sandbox reachable from **anywhere** by inverting connectivity: the sandbox worker dials
_out_ over one gRPC bidi stream (HTTP/2 on `:443`), a single-replica in-cluster relay bridges it to
the harness, and both paths land behind the existing `SandboxTransport` seam
(`KubectlTransport` local + `GrpcRelayTransport` remote). Extends the shared-sandbox model (P2) to
untrusted bring-your-own / NAT / on-prem / other-cloud sandboxes without touching the Pi loop,
session backend, or leaf queue. Contract is a **language-neutral Protobuf IDL** (`sandbox/v1`), not
a TypeScript interface.

| ID     | Title                                                                                                                                                                                                                                                                                   | Status        | Spec / issue                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ST** | **SandboxTransport — language-neutral remote sandbox exec over gRPC** — worker-dialed `Attach` stream, single-replica presence-only relay mirroring into the existing pool, `SandboxTransport` seam, Go reference worker; per-sandbox bearer token day-one (SPIFFE/mTLS additive later) | **design ✅** | [`2026-07-08-sandbox-transport-grpc-design.md`](2026-07-08-sandbox-transport-grpc-design.md) (#78); [ADR-0024](../adrs/0024-sandbox-transport-remote-exec.md); epic #89 |

> **Two build tracks, separate contributors.** The **backend** (TypeScript / in-cluster — proto,
> `SandboxTransport` seam + `KubectlTransport` rename, relay + `GrpcRelayTransport` + presence mirror:
> issues #84–#86) and the **worker** (Go / sandbox side — reference worker: #87) build in parallel
> off the shared `sandbox/v1` contract, joined by the integration + live gate (#88). This mirrors the
> Z2/Z3 (harness) vs. Z4/Z5 (sandbox) split. Implementation **plans are local-only** (`../plans/`,
> gitignored) and authored per contributor.

---

## Phase 2 — Zero-Trust Credential Plane (`Z`-prefix)

> **Roadmap anchor:** [Leaf-Session Backend Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) (evidence base: [Pipeline Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md)) tests the design against three independent agentic-pipeline archetypes and **reprioritizes** this track: the harness's core role is a **leaf-session backend for external orchestrators**. **Z1 (per-user identity) defers** until multi-tenant hosting; **Z6 _extras_ defer** — the core clean-context-subagent need (one archetype plans it) is met by a **re-entrant leaf-session contract**, not new machinery. Z3/Z5 stay "keep-light."
>
> **First buildable milestone:** [MVP Thin Slice — Leaf-Session Invocation Contract](2026-06-26-mvp-leaf-session-contract-design.md) (Archetype A) — proves an external orchestrator can dispatch N parallel, parameterized, run-to-completion leaf sessions with structured (volume-envelope) results, retry, and coverage audit, on scale-to-zero. Reuses M2–M6; defers the whole credential plane.

Principle (parent §2): _no component influenced by model output ever holds a raw secret._ Secrets
live only in identity-keyed egress points. Dependency-ordered:

| ID     | Title                                                                                                                                                              | Status                                      | Spec / source                                                                                                          | Alias                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Z1** | Identity spine — per-session SPIFFE bound to user; `CredentialInjector` interface; orchestrator + reconstruct-on-wake                                              | **design ✅**                               | [`2026-06-26-identity-spine-design.md`](2026-06-26-identity-spine-design.md)                                           | parent M7 (reframed)                |
| **Z2** | **Harness lock-down** — fail-closed redirection, secret-free container, default-deny egress, distroless, scoped RBAC; argues the harness needs **no** egress proxy | **design ✅**                               | [`2026-06-26-harness-lockdown-design.md`](2026-06-26-harness-lockdown-design.md)                                       | —                                   |
| **Z3** | **Inference injector** — shared provider-key chokepoint; multi-provider table, `x-sh-provider` routing, strip-then-set, mTLS, streaming, audit-only                | **design ✅** · mechanism superseded by RC1 | [`2026-06-26-inference-injector-design.md`](2026-06-26-inference-injector-design.md)                                   | parent M8                           |
| **Z4** | MCP code-mode in the sandbox (placeholder-swap; **supersedes** the parent's MCP _gateway_)                                                                         | design ✅                                   | [`2026-06-18-m10-mcp-code-mode-design.md`](2026-06-18-m10-mcp-code-mode-design.md)                                     | M10 (spec); parent M10 (superseded) |
| **Z5** | Generalized credentialed egress (sandbox forward proxy + baked CA; subsumes the parent's sandbox-credential milestone; generalizes Z4's mechanism)                 | design ✅ · static slice implemented by RC1 | [`2026-06-19-m13-generalized-credentialed-egress-design.md`](2026-06-19-m13-generalized-credentialed-egress-design.md) | M13; parent M9                      |
| **Z6** | Subagents — first-class child sessions; fresh-isolated default + `SandboxPolicy`; CoW workspace seed; `mail`/`subagent_*` log types                                | design (no spec yet)                        | parent research doc §3.4, §M11                                                                                         | parent M11                          |
| **Z7** | Validation — secret-leak red-team across all paths; multi-agent fan-out; blast-radius containment                                                                  | design (no spec yet)                        | parent research doc §M12                                                                                               | parent M12                          |

### Dependencies (Phase 2)

- **Z1** underlies everything (SPIFFE identities enable Z3's mTLS and Z4/Z5's per-workload scope).
- **Z2 ⇄ Z3** are a pair: the harness lock-down's "secret-free harness" (Z2 H4) depends on the
  injector (Z3) holding the provider key; Z3's enforceable network boundary depends on Z2's
  default-deny egress.
- **Z5 builds on Z4** (the sandbox egress generalizes MCP code-mode's placeholder-swap).
- **Z2/Z3** are the **harness** side; **Z4/Z5** are the **sandbox** side. They share the spine (Z1)
  but are independent to build.
- **Z6** composes on the same plane (each subagent = own identity/sandbox). **Z7** validates Z1–Z6.

---

## Multi-User Service (`MU`-prefix)

Turning the harness from a single-tenant deployment into a **multi-user service**: an authenticated
API, sessions owned by the user who created them, and per-user credentials. Its own track rather than
a Phase-2 `Z` id, because Phase 2 is the **zero-trust credential plane** — a security architecture —
while this is a **product surface** with its own consumers and compatibility obligations. The two
meet at the credential: `MU` needs per-user credentials today, and Phase 2 is how they eventually
stop being held by anything model-influenced.

| ID        | Title                                                                                                                                                                                                                                                | Status                  | Spec / decision                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MU1**   | **Multi-user control plane** — always-on trusted tier owning the authenticated `/v1` API, session-ownership index, per-user credential store, resource introspection; Ed25519 session token; per-turn credential exchange; composes with `P5` (§3.5) | **slice 1 implemented** | [`2026-09-08-multi-user-control-plane-design.md`](2026-09-08-multi-user-control-plane-design.md); [ADR-0033](../adrs/0033-multi-user-control-plane.md)    |
| **MU2**   | Tenant-labelled sandbox pool partition (request-scoped selector on the `/turn` path); `sandbox-egress` credential delivery; quotas and cost attribution; generic OIDC; owned schedules and runs                                                      | planned                 | MU1 §10, §8.2                                                                                                                                             |
| **MU3**   | Injector-resolved per-user credentials — retires MU1's ADR-0033 divergence                                                                                                                                                                           | planned                 | MU1 §10; needs Z3/Z5 per-subject resolution in `rossoctl/cortex`                                                                                          |
| **MU1.1** | Long-lived client authentication (#395): rotating refresh tokens with reuse detection, 30-day idle / 90-day absolute login, 15-minute stateless API tokens, `mocactl auth token` / `logout [--all]`                                                  | implemented             | [`2026-10-08-b14-long-lived-client-auth-design.md`](2026-10-08-b14-long-lived-client-auth-design.md); [ADR-0039](../adrs/0039-rotating-refresh-tokens.md) |
| **MU1.2** | One-line `mocactl` install: a bundled `mocactl.mjs` release asset (per release, plus a rolling `mocactl-edge` prerelease) and `scripts/install-mocactl.sh`                                                                                           | implemented             | [`2026-10-08-mocactl-installer-design.md`](2026-10-08-mocactl-installer-design.md)                                                                        |

### Dependencies (MU)

- **MU1 composes with `P5`**, which is merged as a design
  ([ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md)) with implementation on a
  separate contributor's track. P5 reserved `Authorization` for "may this caller use the harness" —
  which is exactly MU1 — and carries _whose work it is_ in `X-SH-Subject`. MU1 supplies the tier that
  makes that subject **trustworthy** rather than asserted. MU1 §3.5 records the split and what MU1
  does if P5's implementation has not landed.
- **MU1 diverges from Z1 §2** by holding identity and credentials in one tier
  ([ADR-0033](../adrs/0033-multi-user-control-plane.md)); **Z3/Z5 retire that divergence** as MU3.
- **MU2 is _not_ gated on [#237](https://github.com/rossoctl/moca/issues/237).** That
  issue governs the **workload-addressed** pool selector; MU2's partition uses the **envelope**
  selector, which prompt leaves already honour (`run-leaf.ts:124-128`, reached at `:390`). MU2's real
  work is that the `/turn` path resolves a single pod (`run-turn.ts:57`) rather than leasing from the
  pool — see MU1 §8.2.

---

## Rosso Cortex Integration (`RC`-prefix)

Reframes the Phase-2 credential plane around **Rosso Cortex / AuthBridge** as the concrete injection
**and** control mechanism, and around the `#89` SandboxTransport seam — for a single-tenant, Kind-first
PoC. AuthBridge sits on both harness HTTP egress hops as one "egress control-plane, two deployment
profiles" pattern: a **shared** LLM gateway and a **per-sandbox** egress forward-proxy. This
**supersedes the mechanism** of Z3 and implements a **static single-tenant slice** of Z5 (per-user /
RFC 8693 deferred). Distinct from the `Z`-numbered plane it reframes — this is an **integration** track,
so it takes its own prefix rather than a linear `Z` id.

| ID      | Title                                                                                                                                                                                                                                                   | Status                                                                                            | Spec / decision                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RC1** | **AuthBridge egress control-plane PoC** — shared LLM gateway (Profile A) + per-sandbox egress forward-proxy (Profile B); real static-cred `token-broker` injection + stubbed-judge SPARC/IBAC control; BYO sandbox stretch on the `ST` seam (ST5-gated) | **accepted ✅** (2026-07-14) · RC1-0/1/2/4 implemented (Kind + OCP); RC1-3 stretch deferred (ST5) | [`2026-07-10-authbridge-egress-control-plane-poc-design.md`](2026-07-10-authbridge-egress-control-plane-poc-design.md); [ADR-0025](../adrs/0025-authbridge-deployment-topology.md) |

---

## Repository Re-architecture (`RA`-prefix)

Planning for a phased migration onto the P4/P6 high-density substrate: rename,
split out an experiments repo, make P4/P6 primary, then **deprecate** (not remove) Kubernetes/
Knative/KEDA. Its own prefix rather than a `P`-numbered continuation, because — like `RC` and
`MU` — this is a different _kind_ of track (repository/product structure) than the `P`-track's
technical density work it depends on and packages for shipment.

| ID      | Title                                                                                                                                                                                                                                                                                                                            | Status                                                                                                                                                        | Spec / issue                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **RA1** | **Density cutover & repository re-architecture** — repo rename to **MOCA** (Micro Orchestrator for Cloud Agents), split-out `moca-experiments` repo, P4/P6 made the primary deployment model, then K8s/Knative/KEDA **deprecated in place** (not deleted), elevated sandbox-transport adapter, design-only agent-runtime adapter | **Phase 2 (moca-experiments split) executed 2026-09-25; Phases 1/3/4 remain plan only — execution gated** (§2 of the spec: blocked on #336, #337, #338, #274) | [`2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md`](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) |

## Multi-user Isolation (`MI`-prefix)

Making a P6 worker safe to hold sessions of **different users at once** on the Kubernetes-free
substrate, for the two things that are per-session: promoted config bundles (skills) and credentials.
Its own prefix because it cuts across three tracks at once — the `P` density track (P4, P4.1, P6), the
`MU` product track (MU1, MU2) and the `Z` credential plane (Z1, Z5) — and packages them into one
reviewable isolation claim rather than continuing any one of them.

| ID      | Title                                                                                                                                                                                                                                                                                                                                                      | Status                | Spec / decision                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **MI1** | **Multi-user isolation on the density substrate** — control-plane-signed per-session grants the worker carries but cannot mint; RFC 8693-shaped token endpoint; `moca-egress` (connection-bound credential injection, microVM and container tiers); bundle ownership, session binding and in-memory loading; per-subject container sandboxes; slices S1–S5 | **design — proposed** | [`2026-09-28-moca-multi-user-isolation-design.md`](2026-09-28-moca-multi-user-isolation-design.md); ADR-0037 (with S2) |

### Dependencies (MI)

- **MI1 S2 needs #348's Kubernetes-free `CredentialStore`**, and #348 must land with or after MI1 S1's
  environment allowlist (MI1 §10.3).
- **MI1 S4 absorbs P4.1's implementation (#277)** and amends P4.1 §12.2's proxy choice.
- **MI1 delivers part of MU2's scope** — `sandbox-egress` credential delivery and a subject-bound
  sandbox partition for the container tier — on the Kubernetes-free path; MU2 keeps quotas, OIDC and
  owned asynchronous runs.
- **Cortex replaces `moca-egress` only via MI1's conformance suite** (cortex#905, rescoped).

---

## Lineage & supersessions (explicit)

- The parent research doc's **M7–M12** table is **superseded by this registry.** Its M-numbers are
  retained only as the "Alias" column.
- The parent's **MCP gateway (M10)** is **superseded** by **Z4** (MCP code-mode in the sandbox): MCP
  is code the model runs in the sandbox, not a harness-forwarded gateway call.
- The parent's **sandbox credential injection (M9)** is **subsumed** by **Z5** (generalized
  credentialed egress), of which MCP-over-HTTP is one interception case.
- The parent's **inference broker (M8)** is realized concretely as **Z3** (inference injector),
  and its sidecar placement is refined to a **separate pod** (Z2 H6 — NetworkPolicy granularity).
- The June-26 re-examination **reframed Z1's harness portion**: the harness gets a SPIFFE identity
  but **no egress waypoint** (its egress is fixed-destination; see Z2 §2.4).
- **RC1** (own `RC` track) reframes the plane around **AuthBridge (Rosso Cortex)** as the mechanism, plus the `#89`
  SandboxTransport seam. It **supersedes the _mechanism_ of Z3** (the plain Go injector becomes an
  AuthBridge shared gateway once control plugins share the hop) and **implements a static single-tenant
  slice of Z5** (per-user / RFC 8693 token-exchange deferred), unifying both under one "egress
  control-plane, two deployment profiles" pattern. Z3/Z5 are retained as the deployment-profile detail
  and the home of the deferred per-user work. Topology decision: [ADR-0025](../adrs/0025-authbridge-deployment-topology.md).

---

## Documentation lifecycle

Three artifact types, three lifecycles. Code is the source of truth for _how_; the durable
value of docs is the _why_ — decisions and the alternatives we rejected.

| Artifact              | Answers                                                | Retention                                                      | Home                                    |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------- |
| **Spec** (design doc) | _what & why_ — alternatives, trade-offs, deferred work | committed, point-in-time; mark `Superseded by …`, don't delete | `docs/specs/` (here)                    |
| **ADR**               | one significant decision + context + consequences      | committed, **permanent & immutable**, supersession-aware       | [`docs/adrs/`](../adrs/)                |
| **Plan** (impl steps) | _how, in what order_                                   | **local-only, ephemeral** — delete once coded; never committed | [`docs/plans/`](../plans/) (gitignored) |

- A **spec** is a dated deep-dive. It's never retro-edited — a superseded spec gets a
  `Status:` header pointing at its successor and stays in git as the point-in-time record.
- An **ADR** is the permanent spine: a short, immutable record of a single decision that links
  out to the spec for the full reasoning. See [`docs/adrs/README.md`](../adrs/README.md).
- A **plan** is a throwaway checklist, obsolete the moment the code merges — so plans are
  local-only work artifacts (gitignored). See [`docs/plans/README.md`](../plans/README.md).

### Status vocabulary (specs & ADRs)

Every spec and ADR carries a `Status:` line in its header, drawn from:

> `Proposed` → `Accepted` → `Implemented` → `Superseded by <link>` (or `Deprecated`)

When a design is replaced, set the old spec's status to `Superseded by <link to successor>`
rather than deleting it — the record of what we once thought, and why we changed, has value.
(For example, the removed Redis-transport remote-exec design is marked superseded by the
gRPC/Connect sandbox-transport spec, which records the supersession in its own §12.)

## Conventions going forward

- **New Phase-2 specs** take the next free **`Zx`** id and record it in this table.
- **Filenames stay dated + descriptive** (`YYYY-MM-DD-<topic>-design.md`); the canonical `Zx` id
  lives here, not in the filename, to avoid rename churn.
- Each spec keeps the existing header block (Version / Status / Scope / Builds-on); cross-reference
  by **canonical id** (e.g. "Z3") with the filename in parentheses on first mention.
- Implementation plans live in [`docs/plans/`](../plans/) (local-only, gitignored), named for the
  spec they implement, and are deleted once the work is coded and merged.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
