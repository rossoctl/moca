# moca documentation

Moca runs stateful AI coding-agent sessions as a backend service: sessions are durable and
resumable, the agent's reasoning (the _brain_) is isolated from the sandboxes that execute its
tools (the _hands_), many users share one deployment, and sandboxes are disposable. The README has
the pitch; this page is the map.

## Maturity labels

Every install path, guide and reference page should carry one of these. The label is a claim about
the path, not about the project as a whole.

| Label                                                                                                   | Meaning                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Stable**                                                                                              | Supported, no planned removal.                                                                            |
| **Preview**                                                                                             | Implemented and the recommended direction, but not yet declared Stable. Interfaces and limits may change. |
| Today every deployment path is **Preview**. The first path to be promoted to Stable is P6 on            |
| Kubernetes; the criteria, the status of each path and the support policy are in                         |
| [Maturity and lifecycle](reference/maturity-and-lifecycle.md). The Knative + KEDA path this map         |
| once carried was removed in November 2026 ([ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md)). |

## Start here

| I want to...                        | Go to                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pick an install path and run moca   | [Get started](get-started/index.md)                                                                                                                                                       |
| Run moca for the first time         | [First run](get-started/first-run.md)                                                                                                                                                     |
| Understand the security model       | [Security model](reference/security-model.md); [hardening checklist](operations/hardening.md)                                                                                             |
| Run a deployment for several users  | [Manage multi-user sessions](guides/manage-multi-user-sessions.md)                                                                                                                        |
| Attach a sandbox on another host    | [Attach a remote sandbox](guides/remote-sandbox.md)                                                                                                                                       |
| Run a coding agent in a sandbox     | [Sandbox service (SBX0) user guide](sbx/user-guide.md) — **Preview**                                                                                                                      |
| Use Codex or IBM Bob with a sandbox | [Codex CLI](sbx/user-guide.md#codex-cli); [IBM Bob](sbx/user-guide.md#ibm-bob)                                                                                                            |
| Promote a Claude Code workflow      | [Promote a workflow](guides/promote-claude-workflow.md)                                                                                                                                   |
| Operate P6 on Kubernetes            | [Operations](operations/index.md)                                                                                                                                                         |
| Understand how it works             | [Concepts](concepts/index.md)                                                                                                                                                             |
| See the terms moca uses             | [Glossary](glossary.md)                                                                                                                                                                   |
| Know what changes need notice       | [Change policy](reference/change-policy.md)                                                                                                                                               |
| Know what Stable requires           | [Maturity and lifecycle](reference/maturity-and-lifecycle.md)                                                                                                                             |
| Look up an environment variable     | [Configuration reference](reference/configuration.md)                                                                                                                                     |
| Look up a `mocactl` command         | [`mocactl` reference](reference/cli-mocactl.md)                                                                                                                                           |
| Call the HTTP API                   | [HTTP API guide](reference/http-api.md); contracts: [`api/openapi.yaml`](api/openapi.yaml), [`api/harness-openapi.yaml`](api/harness-openapi.yaml), [Context service](context-service.md) |
| Dispatch a leaf, use the human gate | [Leaf envelope and result](reference/leaf-and-envelope.md)                                                                                                                                |
| Watch a guided walkthrough          | [Demos](demos/README.md)                                                                                                                                                                  |
| Understand why a decision was made  | [ADRs](adrs/README.md) and the [spec registry](specs/README.md)                                                                                                                           |
| Work on moca itself                 | [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`CONTRIBUTING-DOCS.md`](CONTRIBUTING-DOCS.md)                                                                                                   |

## What is in `docs/`

| Location                                    | What it is                                                                             | Audience                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| `get-started/`                              | Install-path chooser                                                                   | New users                 |
| `guides/`                                   | Task guides: multi-user sessions, remote sandbox, promoting a workflow                 | Operators and users       |
| `operations/`                               | Upgrades, Redis backup, observability, sizing, troubleshooting                         | Operators                 |
| `concepts/`                                 | How sessions, sandboxes, multiplexing, multi-user, dispatch and context workflows work | Everyone                  |
| `reference/`                                | Configuration, `mocactl` commands, HTTP API guide, leaf envelope                       | Operators and integrators |
| `glossary.md`, `context-service.md`, `api/` | Terms and API reference                                                                | Integrators               |
| `demos/`                                    | Guided, hand-driven walkthroughs                                                       | Evaluators                |
| `specs/` (registry: `specs/README.md`)      | Design specs; the milestone registry is the source of truth for status                 | Maintainers               |
| `adrs/`                                     | Immutable decision records                                                             | Maintainers               |
| `notes/`                                    | Working notes, runbooks and result write-ups                                           | Maintainers               |
| `archive/`                                  | Dated historical write-ups                                                             | Background                |
| `REORG-PLAN.md`                             | The plan this structure follows, with the audit and open questions                     | Maintainers               |

Install guides live next to the scripts they describe: `deploy/compose/`, `deploy/vm/`, `deploy/k8s/` and
`deploy/microvm/`. Day-two operations for P6 on Kubernetes are in [`operations/`](operations/index.md); the
[security model](reference/security-model.md) and [hardening checklist](operations/hardening.md) cover the rest.
