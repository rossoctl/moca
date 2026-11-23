---
sidebar_position: 1
---

# Install, log in and bring a repository up

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

## Install

You need **Node.js 22 or later**, `git`, and a GitHub account that your operator has enrolled.
Install `mocactl`, the client. Since v0.7.0 the default channel, the latest release, carries
`mocactl sbx`:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
```

It installs `mocactl` into `~/.local/bin`, and prints a line to add to your shell's rc file if that
directory is not on your `PATH`. Re-running it upgrades to the latest release. Its closing hint
about `SH_CONTROL_PLANE_URL` is for moca's own server: ignore it here. Check that `sbx` is there:

```bash
mocactl --version     # v0.7.0 or later
mocactl sbx --help    # what an sbx sandbox is, then: usage (the sandbox service):
```

If `mocactl sbx --help` prints mocactl's general `usage:` list instead, with no `mocactl sbx`
lines (and a bare `mocactl sbx` says `unknown command "sbx"`), your `mocactl` predates v0.7.0:
re-run the install line above (or with `MOCACTL_VERSION=edge` for the newest build of `main`).

## Log in and bring a repository up

You need the URL of your sandbox service deployment, `https://<api host>`: moca is self-hosted,
so it is the deployment you or your team run ([install](../../operate/sandbox-service/install.md)).

**Log in** with GitHub's device flow. The URL is remembered, so this is the only time you pass it:

```bash
mocactl sbx login --control-plane-url https://<api host>
```

```
Open https://github.com/login/device and enter the code ABCD-1234 (valid for 15 minutes)
logged in to the sandbox service as <your GitHub login>
```

If it says `this account (github:<id>) is not enrolled in the sandbox service; ask an operator to
add it`, send that `github:<id>` to your operator.

**Bring a repository up**: create its sandbox, push your working tree to it, and point your agents
at it:

```bash
cd <your repository>
mocactl sbx up
```

```
sbx: not pushed, as they may hold secrets (--include-secrets pushes them): .env
created sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default)
pushed 214 files (3.2 MiB) to sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a
configured Claude Code, OpenCode and IBM Bob: .mcp.json, .claude/settings.json, opencode.json, .bob/settings.json, .bob/mcp.json, CLAUDE.md, AGENTS.md
sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a
sandbox sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default), expires 2026-10-26T09:00:00.000Z, after 7 d without use; bound in .sbx/sandbox.json
```

Without `--template`, `up` uses the `default` template; `mocactl sbx templates ls` lists the others,
and `mocactl sbx up --template <id>` picks one. Run `up` again at any time: it reuses this
repository's sandbox while it is live.

**Moving to another control plane.** The other commands use the bound sandbox's control plane. So
after `mocactl sbx login --control-plane-url <new URL>`, a repository bound on the old one is
refused until you run `up` in it. `up` sees the binding's control plane has no login on this
machine, uses the new URL and rebinds. Work not pulled from the old sandbox stays on the old
control plane. `MOCACTL_SBX_URL` sets the control plane for one shell.

A new sandbox ends after 7 days without use by default; `--lifetime DURATION` (`36h`, `14d`,
`90m`, or whole seconds) picks another: at least 1 h, at most the deployment's maximum (30 days
by default). It applies only to a new sandbox: `up` on an existing one warns that the sandbox
keeps its own lifetime, and goes on.

**Each worktree gets its own sandbox.** A sandbox belongs to one working tree: another clone, or
another `git worktree` of the same repository, gets a sandbox of its own at its first `up`, so
two agents in two worktrees never share, or overwrite, one tree. Each counts toward your quota
of sandboxes ([Limits](../concepts/limits.md)): `mocactl sbx rm` the ones you are done with.
