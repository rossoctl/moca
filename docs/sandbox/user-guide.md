---
sidebar_position: 0
sidebar_label: Overview
---

# Sandbox service user guide

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change. Known limits: [Limits](concepts/limits.md).

This guide takes you from nothing installed to an agent's work applied in your own repository. You
need no moca background. New here? The [quickstart](quickstart.md) is the five-step version.
Operators should read [the runbook](../operate/sandbox-service/runbook.md) instead; to look into a member's
problem, its [Reproducing a member's issue](../operate/sandbox-service/runbook.md#reproducing-a-members-issue).

## What you get

Your coding agent (Claude Code, OpenCode, Codex, IBM Bob or Pi) still runs on your laptop, but **every
command it runs runs in the sandbox service**, each one in a fresh virtual machine (VM). It reads,
edits and tests your code there, in a copy of your repository at `/workspace`. (IBM Bob has no
deny list, so its local tools stay available: see [IBM Bob](how-to/connect-agents.md#ibm-bob).) **Your laptop's source
files are untouched**, apart from the agent configuration `mocactl sbx up` adds, until you take the
agent's work back as a patch and apply it (`mocactl sbx pull --apply`).
The copy is not kept in sync: edits you make locally after `mocactl sbx up` reach the sandbox only
when you send them with `mocactl sbx push`. `/workspace` is kept between commands, and the sandbox
ends after a period without use (7 days by default).

This sandbox is not the one a bare `mocactl` session (moca's own server, `SH_CONTROL_PLANE_URL`)
runs its tools in: the `mocactl sbx` commands neither see nor manage that one.

Why this is safer than letting the agent run on your laptop: [Isolation and data
handling](concepts/isolation.md).

## Tasks

| Page                                                                      | What it covers                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Install, log in and bring a repository up](how-to/set-up.md)             | `mocactl` and `sbx` versions, login, `sbx up`, templates, lifetime, worktrees |
| [Run your coding agent](how-to/connect-agents.md)                         | Claude Code, OpenCode, Codex CLI, IBM Bob and Pi against the sandbox          |
| [Take the work back, and send more](how-to/push-and-pull.md)              | `sbx pull`, `pull --apply`, and what a patch may not touch                    |
| [What `sbx up` changes in your repository](how-to/agent-configuration.md) | the agent configuration it writes, `--cortex`, and undoing it with `sbx rm`   |
| [Work with a sandbox](how-to/work-with-a-sandbox.md)                      | `push`, `run`, `put`, `ls`, the shell, and what persists between calls        |
| [Use credentials](how-to/egress-credentials.md)                           | egress credentials for GitHub and other allowlisted services                  |
| [Make a template from a container image](how-to/template-from-image.md)   | a first template, step by step, from `python:3.12-slim`                       |
| [Make your own templates](how-to/templates.md)                            | a template from an image pinned by digest                                     |
| [Keep a guest between commands (lease mode)](how-to/lease-mode.md)        | `--mode lease` and `lease+processes`, `sbx reset`, tracked processes          |
| [Call the sandbox API from your own code](how-to/direct-api.md)           | `sbx env`, `sbx token`, and the `sandbox/v1` gRPC API                         |
| [Troubleshoot](how-to/troubleshoot.md)                                    | `sbx doctor` and the common errors                                            |

## Concepts and reference

- [Isolation and data handling](concepts/isolation.md) and [Limits](concepts/limits.md).
- [Templates, builds and activation](concepts/templates.md): what a build, a tag and an activation
  lease are, and the states a build goes through.
- [`mocactl sbx` reference](reference/cli-sbx.md): every command, environment variable and exit
  code, generated from the CLI.
- [Template API](reference/templates-api.md): the template routes, error codes, policy rule ids and
  quotas.
