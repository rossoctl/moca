---
sidebar_position: 3
---

# Take the work back, and send more

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

**Take the work back** when the agent is done:

```bash
mocactl sbx pull            # look at the patch first, if you like
mocactl sbx pull --apply
```

```
applied the sandbox's changes to 3 files (2814 bytes of patch)
```

`pull --apply` applies the patch to your working tree (not your index: review it with `git diff`,
then commit as usual) and records in the sandbox that you have it, so the next pull shows only newer
changes. When there is nothing new it says `nothing to pull`.

`pull --apply` never writes your local agent configuration or hooks: a patch that touches
`.mcp.json`, anything under `.claude/`, `opencode.json`, `opencode.jsonc`, `.opencode/`, anything
under `.codex/`, `.agents/`, `.pi/` or `.bob/`, `.vscode/tasks.json`, `.vscode/settings.json`,
`.husky/` or `.envrc` (at any depth, in any case), `.git` and `.sbx/`, the `core.hooksPath`
directory, git directory or git config files when they are in the tree, or anything inside a
submodule or nested repository, is refused whole, naming each file and why, and nothing is applied.
These files can make your laptop run a command the next time an agent, an editor, git or direnv
starts, and they are often uncommitted, so `git diff` would not show the change. To take such a
change, save the patch with `mocactl sbx pull -o FILE`, read it, and apply what you want by hand
(`git apply --exclude=.claude/settings.json FILE` leaves a file out). A change to an agent's
steering file — `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md` or Bob's `.bobrules` — outside the
`sbx` block is applied, with a warning on stderr: review it before your next agent session.
