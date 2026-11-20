---
sidebar_position: 4
---

# What `sbx up` changes in your repository

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

`up` **merges** into these files and never overwrites what you have. If a value already there
conflicts (say, a `sandbox` MCP server of your own), it stops before doing anything and names the
file and key.

| File                                  | What `up` adds                                                                                                                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.mcp.json`                           | `mcpServers.sandbox`: `mocactl sbx mcp`, the sandbox's tools over stdio                                                                                                                                                                                                                       |
| `.claude/settings.json`               | `permissions.allow`: `mcp__sandbox__*`; `permissions.deny`: Claude Code's local tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`, …); `enabledMcpjsonServers`: `sandbox`; `autoMemoryEnabled`: `false` (below)                |
| `opencode.json`                       | `mcp.sandbox`: `mocactl sbx mcp`; `tools.<name>: false` for OpenCode's local tools (`bash`, `read`, `edit`, `write`, `patch`, `apply_patch`, `glob`, `grep`, `list`, `lsp`, `webfetch`, `websearch`, `task`, `multiedit`, `skill`)                                                            |
| `.bob/settings.json`, `.bob/mcp.json` | `mcpServers.sandbox`: `mocactl sbx mcp`, the same entry `.mcp.json` gets, in both files — which one Bob reads depends on its version (2.0.9 reads `mcp.json`). Bob has no deny list, so its local tools are **not** denied, and it prefers them unless the prompt names the sandbox's (below) |
| `CLAUDE.md`, `AGENTS.md`              | A block between `<!-- sbx:begin -->` and `<!-- sbx:end -->` telling the agent how the sandbox works (below)                                                                                                                                                                                   |
| `.sbx/`                               | `sandbox.json`, the binding (your sandbox's id and the service URL), and `agent-config.json`, the record of what `up` added. `.sbx/` is listed in `.git/info/exclude`, never in your `.gitignore`                                                                                             |

An older mocactl also denied `MultiEdit`, `LS` and `NotebookRead`, which current Claude Code does
not know: it warns about each one at every start. Re-running `mocactl sbx up` takes those three
back out — the ones its own record says it added. One you wrote yourself is not in that record, so
it stays.

`autoMemoryEnabled: false` keeps Claude Code from loading your machine's auto-memory
(`~/.claude/projects/*/memory`): with `Read`, `Edit` and `Write` denied, the agent could see the
notes but not correct them. `mocactl sbx rm` takes it back. A `true` in `.claude/settings.json` or
`.claude/settings.local.json` stops `up`. A `CLAUDE_CODE_DISABLE_AUTO_MEMORY` of `0`, `false`,
`no` or `off` in your shell turns auto-memory back on for a plain `claude`, and `mocactl sbx
doctor` fails on it; `mocactl sbx claude` sets it to `1`.

They are ordinary files in your working tree, so `git status` shows them. Leave them uncommitted:
committed, they would point every teammate's agents at a sandbox and deny their local tools.
`mocactl sbx up --no-agent-config` creates and pushes without touching them.

**Whether they reach the sandbox is up to your `.gitignore`.** `up` writes them after its push, so
the first push never carries them. From then on, `up` and `push` treat them like any other file:
one that is tracked, or untracked and not ignored, is pushed; an untracked one your ignore rules
match is left out. `.sbx/` is never pushed. The sandbox needs none of them, since the agent there
gets its instructions from the MCP server, so ignoring them (as the Moca repository's own
`.gitignore` does for `.mcp.json`, `opencode.json`, `.bob/` and `AGENTS.md`) only keeps them on
your machine. The decision is recorded in
[ADR-0049](../../adrs/0049-sbx-push-agent-config-follows-gitignore.md).

## Loading your project's `CLAUDE.md`: `sbx up --cortex`

The `Read` deny in `.claude/settings.json` also stops Claude Code loading your project's own
`CLAUDE.md`. With [Cortex](https://github.com/rossoctl/cortex) v0.9.3 or later installed,
`mocactl sbx up --cortex` leaves the deny list out and has Cortex keep the agent off local tools
instead:

- `up` runs `agentop script install moca-sandbox` before it creates anything, and stops if that
  fails.
- `.claude/settings.json` gets the allow rule, `enabledMcpjsonServers` and `autoMemoryEnabled`,
  but no `permissions.deny`.
- Later `up` runs keep the mode. `mocactl sbx doctor` checks the script is installed and loaded.

Claude Code must reach the model through Cortex (`agentop configure claude-code`). Without it,
nothing blocks the local tools.

## The first `claude` asks about the sandbox server

Start Claude Code from the repository root, where `up` wrote `.mcp.json` and
`.claude/settings.json`. On a fresh clone the first session asks about the server `up` wired
up, despite the `enabledMcpjsonServers` entry above:

```
New MCP server found in this project: sandbox

  Use this MCP server
  Use this and all future MCP servers in this project
❯ Continue without using this MCP server
```

Choose **"Use this MCP server"**. The highlighted default is the last line, so pressing Enter
declines, and declining writes `disabledMcpjsonServers: ["sandbox"]` into
`.claude/settings.local.json`. Together with the local tools denied in `.claude/settings.json`
that leaves the agent with no tools at all — and the marker suppresses the question on the next
run, so the state is easy to mistake for a broken sandbox. `mocactl sbx doctor` reports it, with
the recovery:

```
Claude Code: .claude/settings.local.json disabledMcpjsonServers rejects the sandbox MCP server,
so the agent has neither the sandbox's tools nor its own; delete .claude/settings.local.json
(mocactl sbx up never writes it) and answer "Use this MCP server" the next time Claude Code asks
```

`enabledMcpjsonServers` is necessary but not sufficient: Claude Code also asks you to trust the
folder, and it suppresses the MCP question only once **both** hold. That trust lives in
`~/.claude.json`, outside your working tree, and only your answer to the prompt puts it there —
so a first session asks, whatever `up` writes. Accept the folder trust and the server once, and
neither returns.

Both answers are recorded against the directory you started `claude` **in**, while `.mcp.json` is
found by searching upwards. Start Claude Code from the repository root, where `up` wrote the two
files: from a subdirectory the server is still found and still asks, every session, because the
approval you gave at the root does not apply there. Tracked as
[#577](https://github.com/rossoctl/moca/issues/577).

**`mocactl sbx claude` asks none of this but the folder trust.** It passes the server with
`--mcp-config` — flag-scoped, so Claude Code asks no approval and nothing is written anywhere,
not even the `disabledMcpjsonServers` rejection a past decline left (the flag-scoped server is
not the project-scoped one that key turns away) — and `--strict-mcp-config` keeps the
project-scoped copy in `.mcp.json` from asking as well (Claude Code 2.1.246 or later skips that
question; verified against 2.1.308, at the root, from a subdirectory, and over a past decline).
The one question the flags cannot take away is the folder trust: a folder Claude Code has never
trusted gets "Is this a project you created or one you trust?" once, whatever is passed, and
its highlighted default exits — answer yes, nothing was lost, and it never returns (trust is
recorded for the folder, so subdirectories inherit it, which is also why the launcher works
from any directory). The trade: the session loads no MCP
server but the sandbox's. Run `claude` yourself, answer the two questions once, and every later
session started in the root has your own servers too and asks nothing. Neither flag affects
the local tools: the launcher denies those with `--disallowed-tools`
([First run](set-up.md)), so they stay off wherever it is started.

**To undo it**, delete the sandbox:

```bash
mocactl sbx rm
```

```
deleted sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a; tokens already issued stop working within one token lifetime plus 30 s (15.5 minutes by default)
removed the agent configuration sbx up added: .mcp.json, .claude/settings.json, opencode.json, CLAUDE.md, AGENTS.md
removed .sbx/ (the binding)
```

`rm` takes back exactly what `up` added (a value you had before stays), then removes `.sbx/`.
`mocactl sbx rm --keep-config` deletes the sandbox and leaves the configuration. **Pull first:**
the sandbox's files go with it. `rm` checks, and refuses to delete a sandbox that holds work you
have not pulled:

```
sbx: the sandbox has changes not yet pulled, so sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a was not deleted: run mocactl sbx pull --apply to keep them, or mocactl sbx rm --force to delete it with them
```

An expired sandbox is deleted without the check: no command can reach its files any more, so
there is nothing left to pull. When the check cannot run for another reason (its template's
worker is down), `rm` says so, deletes nothing, and needs `--force`:

```
sbx: cannot check sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a for changes not yet pulled: sandbox failure: UNKNOWN: no live worker for sandbox 'sbx_default'; nothing was deleted. Pull them first if you can, or delete it anyway with mocactl sbx rm --force
```

`mocactl sbx rm --force` deletes without checking. The same check applies to `rm ID` for a sandbox
that is not bound here.
