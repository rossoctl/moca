---
title: Get started
sidebar_label: Get started
sidebar_position: 1
description: Pick the right first page for what you want to do with moca, and see what each path needs.
doc_type: navigation
audience: [evaluator, sandbox-user, harness-user, operator]
capability: both
---

# Get started

Pick the row that matches what you want to do.

| I want to…                                       | Capability                        | First page                                      | You need                                                                                       |
| ------------------------------------------------ | --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Point my coding agent at the sandbox service     | Sandbox service                   | [Sandbox quickstart](../sandbox/quickstart.md)  | Node.js 22+, `git`, a sandbox service deployment, its URL, and a GitHub account enrolled in it |
| Try moca on my laptop in about five minutes      | Harness                           | [Harness quickstart](../harness/quickstart.md)  | Docker (or podman's `docker` CLI) with Compose, `curl`, and a model credential                 |
| Use `mocactl` against a moca server someone runs | Harness                           | [Use mocactl](../harness/how-to/use-mocactl.md) | Node.js 22+ and the server's control-plane URL                                                 |
| Deploy moca for a team                           | Harness, sandbox service, or both | [Deploy and operate](../operate/index.md)       | Depends on the path. The chooser lists each one                                                |

## Install the client

The sandbox service and the harness share one client, `mocactl`:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
```

What the installer does:

- It needs Node.js 22 or later and `curl`.
- It installs into `~/.local/bin`, never edits your shell's rc files, and checks the download's
  SHA-256.
- To choose a build, set `MOCACTL_VERSION`: `latest` (the default), `edge` (the newest build of
  `main`) or a release tag such as `v0.10.0`.
- To install somewhere else, set `MOCACTL_INSTALL_DIR`.

```bash
mocactl --version     # a release tag, edge-<sha>, or dev-<sha> from a checkout
```

Commands:

- `mocactl sbx …` drives the **sandbox service**. It has its own login (`mocactl sbx login`).
- The rest of `mocactl` (`login`, `run`, `sessions`, …) drives the **harness**.
- `mocactl COMMAND --help` prints the syntax of one command.

## What you cannot do locally (yet)

There is no local way to run the **sandbox service**. It deploys to an OpenShift cluster plus
one or more KVM hosts ([install](../../deploy/sbx/README.md)). To try it, deploy
it, or use your team's deployment: you need its URL and a GitHub account enrolled in it. The **harness** runs locally under
Docker Compose, as a trial.

## Next

- New to the ideas? Read [Brain and hands](../harness/concepts/brain-and-hands.md) and
  [What the sandbox service gives you](../sandbox/user-guide.md#what-you-get).
- Checking maturity before you commit? Read
  [Maturity and lifecycle](../reference/maturity-and-lifecycle.md).
