# Architecture Decision Records (ADRs)

This directory is the **permanent decision spine** of the harness. An ADR captures **one
significant decision** — the context that forced it, the choice made, and the consequences
we accepted — in a form that stays true even as the code around it changes.

## Index

Reconstructed from the design specs in [`../specs/`](../specs/) (each ADR links back to its
spec). Chronological by the spec's date; numbers are permanent.

| #                                                         | Decision                                                                                        | Status      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| [0001](0001-redis-session-backend.md)                     | Persist Pi session state through a pluggable Redis backend                                      | Implemented |
| [0002](0002-k8s-sandbox-client-remote-exec.md)            | Route Pi tool execution to a remote pod via `kubectl exec`                                      | Implemented |
| [0003](0003-persistent-in-pod-channel.md)                 | Reuse a long-lived in-pod bash session for fast tool ops                                        | Implemented |
| [0004](0004-knative-serverless-wrapper.md)                | Expose the harness as a scale-to-zero Knative HTTP service                                      | Implemented |
| [0005](0005-mcp-code-mode.md)                             | Originate MCP calls as code the model runs in the sandbox                                       | Accepted    |
| [0006](0006-generalized-credentialed-egress.md)           | Placeholder-swap over a forward proxy for all credentialed egress                               | Accepted    |
| [0007](0007-compaction-checkpoint-fast-path.md)           | Ride Pi's native compaction entry as the resume checkpoint                                      | Implemented |
| [0008](0008-experiments-harness.md)                       | Measure the loader as in-process reconstruction cost, not end-to-end latency                    | Implemented |
| [0009](0009-cluster-experiments.md)                       | Drive cluster experiments with bash extending `smoke.sh`                                        | Implemented |
| [0010](0010-identity-spine.md)                            | Per-session SPIFFE identity, user in the attested path, minted by the orchestrator              | Accepted    |
| [0011](0011-harness-lockdown.md)                          | Defend the harness by defanging local execution, not by mediating egress                        | Accepted    |
| [0012](0012-inference-injector.md)                        | A separate injector pod holds the provider key and owns public LLM egress                       | Accepted    |
| [0013](0013-leaf-session-backend-reprioritization.md)     | Reprioritize the harness as a leaf-session backend; defer the heavy credential plane            | Accepted    |
| [0014](0014-mvp-leaf-session-contract.md)                 | Prove the backend with a run-to-completion `/runs` invocation contract                          | Implemented |
| [0015](0015-async-leaf-completion.md)                     | KEDA ScaledJob over a Redis Streams queue for background leaf execution                         | Implemented |
| [0016](0016-human-gate.md)                                | Human-gate as a structured terminal plus externally-triggered continuation                      | Implemented |
| [0017](0017-registry-securitycontext-hardening.md)        | Apply the non-root least-privilege securityContext baseline to agent pods                       | Implemented |
| [0018](0018-scheduled-leaf-dispatch.md)                   | Native Kubernetes CronJob as the scheduled dispatch start signal                                | Implemented |
| [0019](0019-ocp-fs-free-deployment.md)                    | Durable RWO EBS Sandbox CR, non-root under nonroot-v2, for the OCP deployment                   | Implemented |
| [0020](0020-fs-free-harness.md)                           | Filesystem-free harness (envelope inline + Redis, working set on Sandbox CR)                    | Implemented |
| [0021](0021-shared-sandbox-pool.md)                       | Shared sandbox pool via N Sandbox CRs with harness-side Redis-lease routing                     | Implemented |
| [0022](0022-workload-parameterized-sandbox-load.md)       | Report the sharing ratio as an N-vs-workload curve, not a single number                         | Implemented |
| [0023](0023-sandbox-sharing-ratio-experiments.md)         | Measure sandbox sharing capacity on runc; split Kata isolation into P4                          | Implemented |
| [0024](0024-sandbox-transport-remote-exec.md)             | Remote sandbox exec over a worker-dialed gRPC stream, contract as language-neutral Protobuf     | Accepted    |
| [0025](0025-authbridge-deployment-topology.md)            | AuthBridge topology: shared LLM-egress gateway (AB1) + per-sandbox egress proxy (AB2)           | Accepted    |
| [0026](0026-rc1-static-inject-plugin.md)                  | RC1 credential injection via a dedicated `static-inject` plugin (not a broker service)          | Accepted    |
| [0027](0027-rc1-control-gate-and-hop2-realization.md)     | RC1 control gate as IBAC-only; Hop-2 egress interception over plain HTTP                        | Accepted    |
| [0028](0028-async-prompt-dispatch.md)                     | Async prompt dispatch as a `kind:"prompt"` leaf sharing the `/turn` core                        | Proposed    |
| [0029](0029-turn-sse-streaming.md)                        | Streaming `/turn` responses as an SSE representation via content negotiation                    | Proposed    |
| [0030](0030-claude-code-workflow-promotion.md)            | Promote local Claude Code workflows as a content-addressed config bundle                        | Proposed    |
| [0031](0031-promoted-memory-read-only.md)                 | Promoted memory travels read-only; discoveries return in the leaf result                        | Proposed    |
| [0032](0032-per-request-subject-no-ambient-credential.md) | Multi-session isolation via per-request subject + no ambient credential, not a `SessionContext` | Proposed    |
| [0033](0033-multi-user-control-plane.md)                  | An always-on control plane owns multi-user identity and credentials                             | Proposed    |
| [0034](0034-vm-process-manager-socket-handoff.md)         | Density off Kubernetes via a socket-handing-off supervisor over a fixed worker pool             | Proposed    |
| [0035](0035-per-exec-microvm-warm-standby.md)             | Sandbox isolation becomes a per-`Exec` microVM, made affordable by warm standby                 | Proposed    |
| [0036](0036-tui-decoupled-http-client.md)                 | `mocactl` is a standalone HTTP client of MU1, not a harness/control-plane feature               | Proposed    |
| [0037](0037-p6-on-kubernetes-substrate.md)                | P6 on Kubernetes is a substrate, not the deprecated Knative path                                | Proposed    |
| [0038](0038-mocactl-config-bundle-promotion.md)           | Promote config bundles through the control plane, not a direct Redis tunnel                     | Proposed    |
| [0039](0039-rotating-refresh-tokens.md)                   | Long-lived client authentication via rotating refresh tokens, with 15-minute API tokens         | Proposed    |
| [0040](0040-detachable-turns.md)                          | Detachable turns: a per-turn Redis Stream log, re-attach by `Last-Event-ID`, explicit cancel    | Proposed    |

## What an ADR is (and isn't)

|           | ADR                                 | Spec (`../specs/`)                                          | Plan (`../plans/`)        |
| --------- | ----------------------------------- | ----------------------------------------------------------- | ------------------------- |
| Answers   | _what we decided & why_             | _what & why, in depth_ (alternatives, trade-offs, deferred) | _how, in what order_      |
| Size      | short (one decision)                | long (a whole design)                                       | a checklist               |
| Retention | **permanent, immutable**            | committed, point-in-time                                    | **local-only, ephemeral** |
| On change | write a **new** ADR that supersedes | add a `Status:` header, don't rewrite                       | delete once coded         |

An ADR is deliberately small: it records the _decision_, not the _design_. The full design
lives in a dated spec under [`../specs/`](../specs/); the ADR links to it. Use an ADR when a
choice is (a) hard to reverse, (b) cross-cutting, or (c) likely to be questioned later ("why
Connect instead of raw gRPC?", "why is the harness filesystem-free?").

## Rules

1. **Immutable.** Once accepted, an ADR is never edited except to change its `Status` line
   (e.g. to `Superseded by ADR-0007`). To change a decision, write a **new** ADR that
   references and supersedes the old one. The record of _why we once thought otherwise_ has
   value.
2. **Numbered, monotonic.** Files are `NNNN-kebab-title.md`, zero-padded, next free number.
   Numbers are never reused.
3. **One decision per ADR.** If you're recording two, write two.
4. **Link to the spec.** The ADR states the decision; the spec carries the reasoning.

## Status vocabulary

`Proposed` → `Accepted` → `Superseded by ADR-NNNN` (or `Deprecated`). Same vocabulary as
specs (see [`../specs/README.md`](../specs/README.md#documentation-lifecycle)).

## Creating one

```sh
cp docs/adrs/0000-adr-template.md docs/adrs/NNNN-your-decision.md
# fill in Context / Decision / Consequences; set Status: Accepted; link the spec
```

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
