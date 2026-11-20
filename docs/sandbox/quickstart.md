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

In this quickstart, a coding agent on your laptop corrects a fault in one of your repositories.
The agent sends every command to the moca sandbox service, which runs each command in a new VM.
At the end, you apply the agent's work to your laptop as a patch.

> **Preview.** The sandbox service is implemented but not yet declared Stable; interfaces and
> limits may change.

## What happens to your files

- `mocactl sbx up` copies your working tree into the sandbox's `/workspace`. It also writes your
  agents' configuration.
- The agent reads, edits and tests the copy in `/workspace`.
- The source files on your laptop do not change until you run `mocactl sbx pull --apply`.
- The service does not copy files automatically. To send later edits, run `mocactl sbx push`.

## Before you start

You need:

- **Node.js 22 or later** and `git`.
- **A git repository to work on.** This is your own project. Mocactl is a client, so you do not
  need a clone of moca. `up`, `push` and `pull` run in a git repository, and fail outside one.
- A **sandbox service deployment** and its API host. Moca is self-hosted:
  [deploy one](../operate/sandbox-service/install.md), or ask whoever runs yours.
- A GitHub account that whoever runs the deployment has **added to its access list**. If your
  account is not on the list, step 2 shows the ID to send them.
- Claude Code or OpenCode. (Codex and IBM Bob work too. See
  [the user guide](how-to/connect-agents.md#codex-cli).)

## Set your variables

This page uses two values that you supply. Set them in the shell you use for the steps below. You
can then copy each later command without an edit.

```bash
# The API host of your sandbox service deployment, without the scheme.
export API_HOST=sbx.example.com

# The git repository you want the agent to work on. This is your own project,
# not a clone of moca. Use the repository root.
export REPO_DIR=~/src/my-project
```

Open a new shell, and set the two variables again. To keep them, add the two lines to your shell's
startup file (`~/.bashrc` or `~/.zshrc`).

## 1. Install mocactl

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
mocactl --version     # v0.7.0 or later
```

The installer puts `mocactl` in `~/.local/bin`. If that directory is not on your `PATH`, the
installer prints the line to add. Ignore the closing hint about `SH_CONTROL_PLANE_URL`, which
applies to the harness.

## 2. Log in

Log in with GitHub's device flow. Mocactl remembers the URL, so this is the only step that uses
`$API_HOST`:

```bash
mocactl sbx login --control-plane-url https://$API_HOST
```

```
Open https://github.com/login/device and enter the code ABCD-1234 (valid for 15 minutes)
logged in to the sandbox service as <your GitHub login>
```

The message `this account (github:<id>) is not enrolled in the sandbox service` shows that your
account is not on the deployment's access list. Send the `github:<id>` from the message to whoever
runs the deployment. The `<id>` is your numeric GitHub user ID. The operator calls this list the
_allowed subjects_.

## 3. Bring your repository up

Go to the root of your repository, then create its sandbox:

```bash
cd $REPO_DIR
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

- It creates the sandbox from the `default` template. To list the other templates, run
  `mocactl sbx templates`. To select one, add `--template <id>`.
- It pushes your working tree. It does not push files that can hold secrets (`.env*`, `*.pem`,
  `*.key`, `id_*`).
- It writes the agent configuration. It also records the binding in `.sbx/sandbox.json`.
- You can run `up` again at any time. It uses this repository's sandbox again while that sandbox
  is live.
- Each clone and each git worktree gets its own sandbox. Two worktrees of one repository do not
  share one.

`up` checks your repository before it creates anything. A check that fails stops `up` with no
sandbox created, so you correct the cause and run `up` again. The two checks below stop `up` most
often in a repository that is already in use.

### If `up` stops at a large file

`up` pushes no file over 12 MiB, and no tree over 256 MiB. A file over the limit stops `up`, and
it creates no sandbox:

```
sbx: files over 12 MiB (12582912 bytes) are not pushed; remove them, or .gitignore them: usage.ndjson (16.4 MiB, 17176795 bytes)
```

The agent almost never needs such a file. Exclude it, then run `up` again. For a file only you
have, use `.git/info/exclude`, which stays on your laptop:

```bash
echo usage.ndjson >> .git/info/exclude
mocactl sbx up
```

To exclude the file for everybody, add the same line to `.gitignore`.

Both files work for an untracked file. A **tracked** file is pushed even when a rule ignores it,
so first run `git rm --cached <file>`. For a tree over 256 MiB, `--max-push` raises the limit. No
flag raises the 12 MiB limit for one file.

### If `up` stops at your Claude Code permissions

`up` denies the local built-in tools (`Bash`, `Read`, `Edit`, `Write`, and 13 more) in
`.claude/settings.json`, so that the agent can use only the sandbox's tools. A repository that
**allows** one of those tools contradicts the deny, and `up` stops:

```
sbx: .claude/settings.json: permissions.allow lists local built-in tools (Bash(git status:*), …),
which would act on this machine; edit it by hand, or run mocactl sbx up --no-agent-config
```

This check protects you. In Claude Code an allow rule beats a deny rule, so the listed commands
would run **on your laptop** while you expect the sandbox to run them.

Move the rules to `.claude/settings.local.json`, which `up` does not write and does not check:

```bash
# Add the rules to .claude/settings.local.json, remove them from .claude/settings.json.
echo .claude/settings.local.json >> .gitignore
mocactl sbx up
```

Add the file to `.gitignore` in the same step, or git reports it as a new file.

**This passes the check, and the allow rules still apply.** Claude Code merges
`settings.local.json` over `settings.json`, and an allow rule still beats a deny rule, so those
commands can still run on your laptop. `up` does not report it, because it reads
`permissions.allow` only in `settings.json`. For a sandbox you can depend on, delete the rules
instead, or move the file aside while you use the sandbox:

```bash
mv .claude/settings.local.json .claude/settings.local.json.off
```

Do not use `--no-agent-config` to get past this check. It writes **no** agent configuration, so
Claude Code gets no sandbox MCP server, keeps its local tools, and runs every command on your
laptop. It is for a setup you configure by hand.

## 4. Run your agent

Start Claude Code or OpenCode in the **repository root**:

```bash
cd $REPO_DIR
claude        # or: opencode
```

Claude Code asks one time whether to use the project's `sandbox` MCP server. Select **"Use this MCP
server"**. The highlighted default refuses the server, and the agent then has no tools.

Then ask for work as usual, for example "the tests fail, fix them".

The agent now uses the sandbox's tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and
`sandbox_info`. The service denies the agent's local tools.

`mocactl sbx claude` is an alternative. It starts Claude Code with the sandbox server for one run,
and does not ask the MCP question.

## 5. Take the work back

First, show the patch:

```bash
mocactl sbx pull
```

Then apply it:

```bash
mocactl sbx pull --apply
```

```
applied the sandbox's changes to 3 files (2814 bytes of patch)
```

`pull --apply` writes the patch to your working tree, not to your index. To examine the patch, run
`git diff`. Then commit as usual.

`pull --apply` refuses a patch that changes agent configuration or hooks (`.mcp.json`, `.claude/`,
`.husky/`, `.envrc`, and similar). It then applies no part of the patch. See
[Take the work back](how-to/push-and-pull.md).

## 6. Check, and clean up

First, check the setup. `doctor` tests your login, the sandbox, the agent configuration, command
execution, and changes you did not pull:

```bash
mocactl sbx doctor
```

Then delete the sandbox and the configuration that `up` added:

```bash
mocactl sbx rm
```

`rm` refuses to delete a sandbox that holds work you did not pull. If you keep the sandbox, it ends
after 7 days without use by default. The service then deletes its files.

## What you just did

- Your agent ran on your laptop. Its commands ran in the sandbox.
- No process continues after a call.
- The VM has no network device. It reaches only the hosts that the deployment allowlists, through a
  proxy on the host.
- The VM holds no secrets.

To read why this design is safer, see [Isolation and data handling](concepts/isolation.md).

## Next

- **Do more:** [Use Codex](how-to/connect-agents.md#codex-cli) or [IBM Bob](how-to/connect-agents.md#ibm-bob),
  [Use egress credentials](how-to/egress-credentials.md),
  [Keep a guest between commands (lease mode)](how-to/lease-mode.md). To set the control plane for
  one shell instead of logging in again, use `MOCACTL_SBX_URL`.
- **Understand:** [Limits](concepts/limits.md).
- **Look up:** [`mocactl sbx` reference](reference/cli-sbx.md).
