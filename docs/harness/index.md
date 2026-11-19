---
sidebar_position: 0
sidebar_label: Overview
---

# Harness

> **Preview.** Every harness deployment path is Preview: interfaces and limits may still change
> ([Maturity and lifecycle](../reference/maturity-and-lifecycle.md)).

The moca harness runs the agent itself. A supervisor hands each connection to a pool of warm
workers, sessions are durable in Redis and resume by id, and the agent's tools run in a remote
sandbox (a container, or a Firecracker microVM per command). You drive it over HTTP (`/turn`,
`/v1/runs`) or with `mocactl`. It is not the [sandbox service](../sandbox/user-guide.md): a harness
session's tools run in the harness's own sandbox, which `mocactl sbx` neither sees nor manages.

New here? The [quickstart](quickstart.md) runs it on your laptop in about five minutes.

## Tasks

| Page                                                                 | What it covers                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Set up mocactl against the Compose trial](how-to/set-up-mocactl.md) | from nothing to a streamed reply in `mocactl`                                       |
| [Use mocactl](how-to/use-mocactl.md)                                 | install, keys, headless commands, `spawn`/`subagents`/`get`, files, troubleshooting |
| [Promote a Claude Code workflow](how-to/promote-claude-workflow.md)  | `mocactl promote`: a local workflow as a config bundle                              |
| [Context Service and workloads](how-to/workloads.md)                 | what a workload is, its lifecycle, and the context it holds                         |
| [Delegate from a coding agent](how-to/delegate-from-coding-agent.md) | the `moca-delegate-task` skill for Claude Code and Codex                            |

## Concepts and reference

- [Concepts](concepts/index.md): sessions and turns, brain and hands, session multiplexing,
  sandboxes and tiers, multi-user, dispatch archetypes, context workflows.
- Reference: the [`mocactl` command reference](reference/cli-mocactl.md) (generated from the CLI),
  the [HTTP API](reference/http-api.md) and the [leaf and envelope](reference/leaf-and-envelope.md).
- Deploying it: [Deploy and operate](../operate/index.md).
