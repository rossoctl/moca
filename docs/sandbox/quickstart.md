---
title: Sandbox service quickstart
sidebar_label: Quickstart
sidebar_position: 1
description: Point Claude Code or OpenCode at the moca sandbox service, let it work in a fresh VM per command, and take its work back as a patch.
doc_type: tutorial
audience: [sandbox-user]
capability: sandbox
---

# Sandbox service quickstart

In this quickstart, a coding agent on your laptop fixes something in one of your repositories.
Every command it runs goes to the moca sandbox service, each one in a fresh VM. At the end you
apply its work to your laptop as a patch.

> **Preview.** The sandbox service is not yet declared Stable. Interfaces and limits may change.

## What happens to your files

- `mocactl sbx up` copies your working tree into the sandbox's `/workspace` and writes your agents'
  configuration.
- The agent reads, edits and tests the copy in `/workspace`.
- Your laptop's source files are untouched until you run `mocactl sbx pull --apply`.
- Nothing syncs on its own. `mocactl sbx push` sends edits you make later.

## Before you start

You need:

- **Node.js 22 or later** and `git`.
- A **sandbox service deployment** and its URL, `https://<api host>`. Moca is self-hosted:
  [deploy one](../../deploy/sbx/README.md), or ask whoever runs yours.
- A GitHub account **enrolled** in that deployment (its allowed subjects).
- Claude Code or OpenCode. (Codex and IBM Bob work too. See
  [the user guide](how-to/connect-agents.md#codex-cli).)

## 1. Install mocactl

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
mocactl --version     # v0.7.0 or later
```

The installer puts `mocactl` in `~/.local/bin`. If that directory isn't on your `PATH`, it prints the
line to add. You can ignore its closing hint about `SH_CONTROL_PLANE_URL`: that's for the harness.

## 2. Log in

Logging in uses GitHub's device flow. The URL is remembered, so this is the only time you pass it:

```bash
mocactl sbx login --control-plane-url https://<api host>
```

```
Open https://github.com/login/device and enter the code ABCD-1234 (valid for 15 minutes)
logged in to the sandbox service as <your GitHub login>
```

If you see `this account (github:<id>) is not enrolled in the sandbox service`, send that
`github:<id>` to whoever runs the deployment, so they can add it to the allowed
subjects.

## 3. Bring your repository up

```bash
cd <your repository>
mocactl sbx up
```

```
sbx: not pushed, as they may hold secrets (--include-secrets pushes them): .env
created sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default)
pushed 214 files (3.2 MiB) to sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a
configured Claude Code, OpenCode and IBM Bob: .mcp.json, .claude/settings.json, opencode.json, .bob/settings.json, .bob/mcp.json, CLAUDE.md, AGENTS.md
…
```

What `up` does:

- It creates the sandbox from the `default` template. `mocactl sbx templates` lists the others, and
  `--template <id>` picks one.
- It pushes your working tree, except files that may hold secrets (`.env*`, `*.pem`, `*.key`,
  `id_*`).
- It writes the agent configuration and records the binding in `.sbx/sandbox.json`.
- You can run `up` again at any time. It reuses this repository's sandbox while that sandbox is live.

## 4. Run your agent

Start Claude Code or OpenCode in the **repository root**:

```bash
claude        # or: opencode
```

Claude Code asks once whether to use the project's `sandbox` MCP server. Choose **"Use this MCP
server"**: the highlighted default declines, and the agent is left with no tools. Then ask for
work as usual, for example "the tests fail, fix them".

The agent's tools are now the sandbox's: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and
`sandbox_info`. Its local tools are denied.

`mocactl sbx claude` is an alternative. It starts Claude Code with the sandbox server for that
one run, so you skip the MCP question.

## 5. Take the work back

```bash
mocactl sbx pull            # look at the patch first, if you like
mocactl sbx pull --apply
```

```
applied the sandbox's changes to 3 files (2814 bytes of patch)
```

The patch goes into your working tree, not your index. Review it with `git diff`, then commit as
usual. `pull --apply` refuses a patch that touches agent configuration or hooks (`.mcp.json`,
`.claude/`, `.husky/`, `.envrc`, and similar), and applies nothing in that case. See
[Take the work back](how-to/push-and-pull.md).

## 6. Check, and clean up

```bash
mocactl sbx doctor    # login, sandbox, agent config, exec, unpulled changes
mocactl sbx rm        # delete the sandbox and the configuration `up` added
```

`rm` refuses to delete a sandbox that holds work you haven't pulled. If you don't remove it, a
sandbox ends after 7 days without use by default, and its files go with it.

## What you just did

- Your agent ran on your laptop, but none of its commands did.
- No process survives a call.
- The VM has no network device. It reaches only the hosts the deployment allowlists, through a proxy on
  the host.
- The VM holds no secrets.

Why this design is safer: [Isolation and data handling](concepts/isolation.md).

## Next

- **Do more:** [Use Codex](how-to/connect-agents.md#codex-cli) or [IBM Bob](how-to/connect-agents.md#ibm-bob),
  [Use egress credentials](how-to/egress-credentials.md),
  [Keep a guest between commands (lease mode)](how-to/lease-mode.md).
- **Understand:** [Limits](concepts/limits.md).
- **Look up:** [`mocactl sbx` reference](reference/cli-sbx.md).
