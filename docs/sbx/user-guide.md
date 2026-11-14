# Using the sandbox service (SBX0): a user guide

> **Preview.** The SBX0 sandbox service is implemented for an internal cohort, but not yet
> declared Stable; interfaces and limits may change. Known limits: [Limits](#7-limits).

This guide takes you from nothing installed to an agent's work applied in your own repository. You
need no moca background. The design is
[the SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md). Operators should read
[the runbook](../../deploy/sbx/RUNBOOK.md) instead.

## 1. What you get

Your coding agent (Claude Code, OpenCode, Codex or IBM Bob) still runs on your laptop, but **every
command it runs runs in the sandbox service**, each one in a fresh virtual machine (VM). It reads,
edits and tests your code there, in a copy of your repository at `/workspace`. **Your laptop's tree
is untouched** until you take the agent's work back as a patch and apply it
(`mocactl sbx pull --apply`).

Why this is safer than letting the agent run on your laptop:

- no process survives a call, so nothing the agent starts keeps running;
- the VM has no network, so nothing can be downloaded or sent out;
- the VM holds no secrets: no credentials, no tokens, none of your laptop's files except the ones
  you pushed.

## 2. Install

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
mocactl sbx --help    # the first line: usage (the sandbox service, SBX0):
```

If `mocactl sbx --help` prints mocactl's general `usage:` list instead, with no `mocactl sbx`
lines (and a bare `mocactl sbx` says `unknown command "sbx"`), your `mocactl` predates v0.7.0:
re-run the install line above (or with `MOCACTL_VERSION=edge` for the newest build of `main`).

## 3. First run

Your operator gives you the sandbox service's URL, `https://<api host>`.

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
sandbox sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default), expires 2026-10-26T09:00:00.000Z; bound in .sbx/sandbox.json
```

Without `--template`, `up` uses the `default` template; `mocactl sbx templates` lists the others,
and `mocactl sbx up --template <id>` picks one. Run `up` again at any time: it reuses this
repository's sandbox while it is live.

**Each worktree gets its own sandbox.** A sandbox belongs to one working tree: another clone, or
another `git worktree` of the same repository, gets a sandbox of its own at its first `up`, so
two agents in two worktrees never share, or overwrite, one tree. Each counts toward your quota
of sandboxes ([Limits](#7-limits)): `mocactl sbx rm` the ones you are done with.

**Run your agent** in the repository. The supported agents differ in how they are wired and in how
much `up` can take away:

| Agent                       | How it gets the server                                                              | Its local tools                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude Code**             | `up` writes `.mcp.json` + `.claude/settings.json`; or `mocactl sbx claude`, per run | Denied (`permissions.deny`), or left to Cortex with `--cortex`       |
| **OpenCode**                | `up` writes `opencode.json`                                                         | Denied (`tools.<name>: false`)                                       |
| **[Codex CLI](#codex-cli)** | `mocactl sbx codex`, per run — it reads no project config                           | Shell tool off; `unified_exec` cannot be disabled                    |
| **[IBM Bob](#ibm-bob)**     | `up` writes `.bob/mcp.json` + `.bob/settings.json`                                  | **Not denied, and preferred** — name the sandbox tools in the prompt |

Claude Code and OpenCode need nothing beyond `up`, so start them as you normally do:

```bash
claude
```

or

```bash
opencode
```

Start it in the repository root, not a subdirectory. Claude Code asks once to approve the
project's `sandbox` MCP server: choose **"Use this MCP server"** — the highlighted default
declines and leaves the agent with no tools at all
([below](#the-first-claude-asks-about-the-sandbox-server)). If it asks whether you trust the
folder, accept that too. Then ask for work as usual ("the tests fail, fix them"). The agent's tools are now `sandbox`'s
(`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and `sandbox_info`); its local tools are
denied.

Or start Claude Code through `mocactl` and skip the MCP server question:

```bash
mocactl sbx claude
```

The launcher registers the sandbox's MCP server for that one run (`--mcp-config`, nothing
written, no approval asked), and it works from any directory, not just the root. Claude Code
still asks once whether you trust the folder, if it has not asked there yet — answer yes and
that question never returns either. It is the smaller
session: `--strict-mcp-config` means Claude Code loads no MCP server but the sandbox's, so run
`claude` yourself when you want your own servers.

The launcher denies Claude Code's local tools itself, with `--disallowed-tools` and the same
list `up` writes. That covers directories with no `.claude/settings.json` from `up`, such as
`mocactl sbx claude --sandbox ID` outside a repository. `--strict-mcp-config` alone limits only
the MCP servers, not the built-in tools. In a repository `up --cortex` set up, the launcher
leaves the local tools to Cortex, as `up` does, and says so when it starts.

Headless use (scripts, CI) works the same way, without the prompts:

```bash
claude -p "Fix the failing test and run the suite" --mcp-config .mcp.json --strict-mcp-config
opencode run "Fix the failing test and run the suite"
```

### Codex CLI

Start to finish, in a repository you have already run `mocactl sbx up` in:

```bash
# 1. install Codex (Node.js 22 or later, the same floor as mocactl)
npm install -g @openai/codex

# 2. give it credentials — its own account, not your sandbox login
codex login                      # a ChatGPT plan, in a browser
# or: export OPENAI_API_KEY=...  and skip the login

# 3. check it took
codex doctor | grep -A3 "auth "  # expect: ✓ auth

# 4. run it against the sandbox (mocactl passes the server; nothing is written)
mocactl sbx codex -- "Run the test suite and fix what fails"

# 5. bring the work back
mocactl sbx pull --apply
```

There is no step for configuring Codex, because there is nothing to configure: `mocactl sbx codex`
passes the server on the command line for that one run.

**In detail**, step by step — why each one is there, and what to check when it does not behave.

**Install it** (Node.js 22 or later, the same floor as `mocactl`):

```bash
npm install -g @openai/codex
codex --version
```

`mocactl sbx codex` needs a Codex that takes `-c` and `--disable`, which 0.163.0 and 0.164.0 do
(those are the versions it was tested against). To check your own, pass both and see the server
listed:

```bash
codex -c 'mcp_servers.sandbox={command="mocactl",args=["sbx","mcp"]}' --disable shell_tool mcp list
```

```
Name     Command  Args     Env  Cwd  Status   Auth
sandbox  mocactl  sbx mcp  -    -    enabled  Unsupported
```

If it errors on the flags, upgrade. (`Auth Unsupported` is expected: the sandbox server does not
use MCP's own authentication.)

**Give it credentials.** This is Codex's own account, nothing to do with your sandbox-service
login — `mocactl sbx login` does not authenticate Codex, and Codex never sees your sandbox token.
Either:

```bash
codex login                                   # a ChatGPT plan, in a browser
codex login --device-auth                     # ... on a machine with no browser
printenv OPENAI_API_KEY | codex login --with-api-key   # an API key, stored once
```

or set `OPENAI_API_KEY` (or `CODEX_API_KEY`) in your environment and skip `login` altogether.
Check which it found:

```bash
codex doctor | grep -A3 "auth "
```

```
  ✓ auth         auth is provided by environment
      auth storage mode        File
      auth.json path (file backend/fallback) ~/.codex/auth.json
      auth env vars present    OPENAI_API_KEY
```

`✗ auth no Codex credentials were found` means neither is in place. Credentials live in
`~/.codex/auth.json` (or `$CODEX_HOME`), outside your repository, so they are never pushed to a
sandbox — `up` skips `.env*`, `*.pem`, `*.key` and `id_*` as well.

**Point it at the sandbox.** `up` cannot configure Codex as it does the other two: Codex reads no
project-local configuration, so there is no file in your repository to put the server in. Start it
through `mocactl` instead, which passes the server for that one run and writes nothing:

```bash
mocactl sbx codex                                               # the TUI
mocactl sbx codex -- "Fix the failing test and run the suite"    # one-shot
```

Anything after `--` goes to Codex, so its own flags still work
(`mocactl sbx codex -- -c sandbox_mode="read-only"`, or `--sandbox ID` before the `--` to name a
sandbox other than the bound one). Inside the TUI, `/mcp` lists the server's tools: `bash`, `read`,
`write`, `edit`, `grep`, `find`, `ls` and `sandbox_info`, each as `sandbox.<tool>`. To run it
yourself, that is:

```bash
codex -c 'mcp_servers.sandbox={command="mocactl",args=["sbx","mcp"]}' --disable shell_tool
```

Codex does not give a stdio MCP server its own environment — the server sees only Codex's
allowlist (`HOME`, `PATH`, `SHELL`, `LANG`, `TMPDIR`, the `NODE_EXTRA_CA_CERTS` family, …) and
whatever the server asks for. `mocactl sbx codex` therefore asks for `MOCACTL_SBX_URL`,
`XDG_CONFIG_HOME` and `XDG_STATE_HOME`, so the server reads the same login and talks to the same
control plane as you do, and forwards `--control-plane-url` when you pass one. Anything else you
set in your shell does not reach it; Claude Code and OpenCode pass everything, so this is specific
to Codex.

A session looks like this — every call through the sandbox, your tree untouched until you pull:

```
• Called sandbox.bash   └ Ran 1 test in 0.000s / FAILED (failures=1)
• Called sandbox.edit
• Called sandbox.bash   └ OK
```

**Codex's local tools are restricted, not denied.** `--disable shell_tool` (which
`mocactl sbx codex` passes) turns off its shell tool, but `unified_exec` also runs local commands
and cannot be disabled: both `--disable unified_exec` and `-c features.unified_exec=false` are
ignored. In practice a session with `shell_tool` off uses the sandbox's tools, but that is the
model's choice rather than a guarantee, so unlike Claude Code and OpenCode there is no deny list
behind it. Codex's own sandbox is the protection that remains: add `-c sandbox_mode="read-only"`
if you want its filesystem confinement as well.

### IBM Bob

Start to finish, in a repository you have already run `mocactl sbx up` in. The commands below are
Bob 2.0.9's; it is the version this was tested against, and its CLI differs from earlier Bob's:

```bash
# 1. install Bob-Shell: https://bob.ibm.com/docs/ide/getting-started/install
bob --version

# 2. give it credentials — its own account, not your sandbox login
export BOB_API_KEY=...           # or let `bob chat` log you in interactively

# 3. check up wired it, and that Bob loads the server
bob mcp list                     # expect: sandbox: mocactl sbx mcp | enabled | stdio | workspace

# 4. run it, from the repository root, NAMING the sandbox tools (see below).
#    Check `mocactl sbx templates` carries your language before asking for a build or test run.
bob chat
#    then, in the session, something whose result you can check:
#    "Using the sandbox bash and write tools, add a CHANGES.md at the top of /workspace
#     listing the five files changed most recently, newest first."

# 5. bring the work back
mocactl sbx pull --apply
```

Prefer `bob chat` for the first run: `bob run` is headless, so a task Bob wants to ask about ends
with the question unanswered and nothing written. Give it work whose output you can verify — a file
that was not there before is the clearest signal the round trip worked. Asking it to "fix what
fails" or to tidy something already tidy can legitimately produce no change, and `pull` then says
`nothing to pull`, which looks like a broken round trip but is not one.

**Name the sandbox tools in the prompt.** This is the one thing to get right, and it is not
optional politeness: with the server connected and working, Bob will still reach for its own local
tools for an ordinary request, and run on your laptop instead of in the sandbox. Saying
"using the sandbox bash tool", or naming another of them, routes it correctly. Saying "do not use
any local tool" does **not**: that instruction is ignored. See the warning below for why `up` cannot
enforce this.

The server's tools are `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and `sandbox_info`.
Name the one the job needs — `write` creates a file, `edit` only changes one that already exists.

If step 3 shows no `sandbox` server, run `mocactl sbx up` again — it merges the entry into Bob's
config. If Bob cannot start the server, check that `mocactl` is on the `PATH` Bob inherits, since
that is the command Bob runs: a GUI-launched Bob may not have your shell's `PATH`.

Unlike Codex there is no launcher, because `up` can configure Bob; and unlike Claude Code and
OpenCode, **`up` cannot take Bob's own tools away** — see the warning below before using it
unattended.

**In detail.** Bob 2.0.9 takes a prompt by flag or subcommand, never as a bare argument
(`bob "do the thing"` fails with `too many arguments`):

```bash
bob chat                                          # interactive TUI
bob -p "Using the sandbox bash tool, …"           # prompt flag
bob run "Using the sandbox bash tool, …"          # headless, one task
```

**`up` configures it for you**, unlike Codex. Which file Bob reads depends on its version, so `up`
writes both `.bob/settings.json` and `.bob/mcp.json` with the same `sandbox` entry: Bob 2.0.9 reads
`.bob/mcp.json` (what `bob mcp add` writes, at its default `workspace` scope) and ignores
`.bob/settings.json`, which earlier Bob read. `bob mcp list` shows it:

```
sandbox: mocactl sbx mcp | enabled | stdio | workspace
```

Note that this reports what is **configured**, not a live connection: it does not prove the server
starts. Inside `bob chat`, `/mcp` does — it shows the server, its tool count and `● Connected`.
That is the check worth running when you are not sure.

To add the entry by hand — if `up` could not, or you are on a Bob whose filename is neither of the
two above — note that stdio arguments need a `--` separator:

```bash
bob mcp add sandbox -- mocactl sbx mcp
```

**Bob's local tools are not denied, and it prefers them.** It has no equivalent of Claude Code's
`permissions.deny`: `--allowed-tools` only waives the confirmation prompt, it does not take a tool
away, so Bob can read and write your laptop's files whenever the model asks. Nothing `up` writes can
change that. Two things follow, and the second is the one that surprises people:

- **It will use them by default.** A prompt that does not name the sandbox tools is likely to run
  locally even with the sandbox connected and healthy. The tool name in each call block is the only
  reliable sign of where a command ran: `Bash (sandbox)` and `Edit (sandbox)` are the sandbox's;
  `Execute Command` is your laptop. Watch for the latter.
- **Its own confirmation is the only control you have.** Leave the default approval mode on so each
  call is shown before it runs, and prefer `bob chat` over `bob run` while you are learning what a
  prompt does: the TUI shows each tool call, and `bob run` does not. Anything that auto-approves
  tool calls — `--trust`, and whatever your Bob spells "yolo" — removes that last check: do not
  combine it with a sandbox, or a laptop, you care about. If your Bob offers a sandbox of its own,
  that is the better home for unattended work.

`bob run` refuses an untrusted folder outright
(`"<path>" is not a trusted folder. Pass --trust to run in this folder, or run Bob Shell
interactively and choose a trust level.`). Prefer choosing the level in `bob chat` over passing
`--trust` blind.

**Toolchains.** The sandbox templates carry the Pi toolchain — `bash`, `git`, Python 3, `ripgrep`,
`curl` — and the VM has no network, so nothing more can be fetched into it. Reading, grepping and
editing work; compiling does not, for a language the template does not carry. Check
`mocactl sbx templates` before asking Bob for a build or a test run, and expect it to report a
missing compiler rather than produce one. (If it silently succeeds instead, check the tool names: it
may have used your laptop's.)

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
`.husky/` or `.envrc` (at any depth, in any case), or `.git` and `.sbx/`, is refused whole, naming
each file and why, and nothing is applied. These files can make your laptop run a command the next
time an agent, an editor, git or direnv starts, and they are often uncommitted, so `git diff` would
not show the change. To take such a change, save the patch with `mocactl sbx pull -o FILE`, read
it, and apply what you want by hand (`git apply --exclude=.claude/settings.json FILE` leaves a file
out). A change to an agent's steering file — `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md` or
Bob's `.bobrules` — outside the `sbx` block is applied, with a warning on stderr: review it before
your next agent session.

## 4. What `sbx up` changed in your repository

`up` **merges** into these files and never overwrites what you have. If a value already there
conflicts (say, a `sandbox` MCP server of your own), it stops before doing anything and names the
file and key.

| File                                  | What `up` adds                                                                                                                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.mcp.json`                           | `mcpServers.sandbox`: `mocactl sbx mcp`, the sandbox's tools over stdio                                                                                                                                                                                                                       |
| `.claude/settings.json`               | `permissions.allow`: `mcp__sandbox__*`; `permissions.deny`: Claude Code's local tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`, …); `enabledMcpjsonServers`: `sandbox`                                                      |
| `opencode.json`                       | `mcp.sandbox`: `mocactl sbx mcp`; `tools.<name>: false` for OpenCode's local tools (`bash`, `read`, `edit`, `write`, `patch`, `apply_patch`, `glob`, `grep`, `list`, `lsp`, `webfetch`, `websearch`, `task`, `multiedit`, `skill`)                                                            |
| `.bob/settings.json`, `.bob/mcp.json` | `mcpServers.sandbox`: `mocactl sbx mcp`, the same entry `.mcp.json` gets, in both files — which one Bob reads depends on its version (2.0.9 reads `mcp.json`). Bob has no deny list, so its local tools are **not** denied, and it prefers them unless the prompt names the sandbox's (below) |
| `CLAUDE.md`, `AGENTS.md`              | A block between `<!-- sbx:begin -->` and `<!-- sbx:end -->` telling the agent how the sandbox works (below)                                                                                                                                                                                   |
| `.sbx/`                               | `sandbox.json`, the binding (your sandbox's id and the service URL), and `agent-config.json`, the record of what `up` added. `.sbx/` is listed in `.git/info/exclude`, never in your `.gitignore`                                                                                             |

An older mocactl also denied `MultiEdit`, `LS` and `NotebookRead`, which current Claude Code does
not know: it warns about each one at every start. Re-running `mocactl sbx up` takes those three
back out — the ones its own record says it added. One you wrote yourself is not in that record, so
it stays.

They are ordinary files in your working tree, so `git status` shows them. Leave them uncommitted:
committed, they would point every teammate's agents at a sandbox and deny their local tools.
`mocactl sbx up --no-agent-config` creates and pushes without touching them.

### Loading your project's `CLAUDE.md`: `sbx up --cortex`

The `Read` deny in `.claude/settings.json` also stops Claude Code loading your project's own
`CLAUDE.md`. With [Cortex](https://github.com/rossoctl/cortex) v0.9.3 or later installed,
`mocactl sbx up --cortex` leaves the deny list out and has Cortex keep the agent off local tools
instead:

- `up` runs `agentop script install moca-sandbox` before it creates anything, and stops if that
  fails.
- `.claude/settings.json` gets the allow rule and `enabledMcpjsonServers`, but no
  `permissions.deny`.
- Later `up` runs keep the mode. `mocactl sbx doctor` checks the script is installed and loaded.

Claude Code must reach the model through Cortex (`agentop configure claude-code`). Without it,
nothing blocks the local tools.

### The first `claude` asks about the sandbox server

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
([First run](#3-first-run)), so they stay off wherever it is started.

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

## 5. Working with it

- **Each call is a fresh VM.** Files under `/workspace` persist from one call to the next; nothing
  else does. No process survives a call: a server, a watcher or a background job started in one
  call is gone in the next. Chain the steps into one command instead (`make build && make test`).
- **No network.** Packages cannot be installed from the internet. The templates carry the
  toolchains: `mocactl sbx templates` lists them, with their tools.
- **One command at a time per sandbox.** The sandbox runs one call at a time, so batch the work:
  read several files in one call, run the whole test suite in one call. The agent's tools refuse a
  call that would wait more than 30 s behind another one with `sandbox busy: … retry later`, and
  the service refuses a third call in flight on one sandbox (from another terminal, say) the same
  way. The `CLAUDE.md`/`AGENTS.md` block tells the agent all of this.
- **Your secrets are not pushed.** `up` and `push` leave out `.env*`, `*.pem`, `*.key` and `id_*`
  files, and say so (`--include-secrets` pushes them; don't). Everything else that git would
  commit, plus your untracked files that are not ignored, is pushed.
- **Push again after you change files locally:**

  ```bash
  mocactl sbx push
  ```

  `push` replaces the sandbox's tree with yours. It refuses while the sandbox has changes you have
  not pulled; pull them first, or `mocactl sbx push --force` to discard them. `up` on a sandbox with
  changes not yet pulled leaves it unpushed, with a warning, and still succeeds. What is sent is
  always the **whole work tree**, whatever directory you run `up` or `push` from; run from a
  subdirectory, both say so before pushing.

- **Run a command yourself:**

  ```bash
  mocactl sbx run -- python3 -m unittest
  mocactl sbx run -- sh -c 'cd src && ls | wc -l'
  echo 'make test 2>&1 | tail -20' | mocactl sbx run
  ```

  `run -- CMD…` quotes each argument, so it runs exactly what you typed: use stdin or
  `-- sh -c '…'` for pipes, variables and globs. It exits with the command's own code, 124 when the
  command timed out, and 125 when the sandbox itself failed. A command the sandbox refused before
  starting it, for want of capacity (busy, or the template's worker at its memory budget), is sent
  again after a short backoff, up to `MOCACTL_SBX_BUSY_RETRIES` times (default 4, at most 20, 0 for none):
  nothing ran, so it still runs at most once. Refused every time, `run` (and `put`) exits 75; interrupted while waiting, 130. Like `ssh`, it passes the remote
  side's terminal escape sequences through to your terminal.

- **Write a file into the sandbox** from stdin:

  ```bash
  mocactl sbx put data/fixture.json < fixture.json
  ```

  `put` writes only under `/workspace` (a relative path is taken from there).

## 6. Credentials

The sandbox has no network of its own, but your operator may allow it to reach a few services
(GitHub, say) through a proxy on the host. **Credential injection** lets those calls carry _your_
token without the token ever entering the sandbox. You store the token once with `mocactl sbx
credentials`; the host's proxy adds it to requests for the services you stored it for, and only
for your sandboxes. A second user's sandbox gets none of it.

Inside the sandbox, tools see only the placeholder `moca-placeholder` (in `GH_TOKEN`, for
example). It is not a secret and is useless anywhere else: sent straight to GitHub, it gets a
`401`. The real token is not in the sandbox's environment, its files or its memory.

### GitHub

Create a **fine-grained personal access token** limited to the repositories your sandboxes need,
with only the permissions you want the agent to have. Moca does not narrow it further: the token's
scope is your limit. Then store it, reading it from stdin so it stays out of your shell history:

```bash
mocactl sbx credentials presets          # the available presets
mocactl sbx credentials add github --preset github < token.txt
```

The `github` preset covers `github.com` (git over HTTPS) and `api.github.com` (`gh`). In the
sandbox, `git clone`, `git push` and `gh pr create` then work against those repositories. The
`github-mcp` preset does the same for GitHub's remote MCP server (`api.githubcopilot.com`); the
same PAT works, and `.mcp.json` needs no token. `api.githubcopilot.com` is not on the default
egress allowlist: the operator must add it, or the preset gets `403 destination_denied`.

### List and delete

```bash
mocactl sbx credentials            # names and destinations, never the secret (--json for scripts)
mocactl sbx credentials delete github
```

Injection stops **within about a minute** of a delete (the proxy caches a credential for up to
60 s by default; ask your operator for the exact value). A request already open finishes with the
token it started with; no new request carries it. Also revoke the token on GitHub if you think it
leaked.

### Internal services and MCP servers

Any other service works the same way, if your operator has allowlisted it and made it reachable
from the host (`MOCA_EGRESS_PERMIT_CIDRS` for its address range, `MOCA_EGRESS_UPSTREAM_CA` for a
private CA). Ask them first. Then:

```bash
mocactl sbx credentials add jira --host jira.corp.example:8443/api < token.txt
mocactl sbx credentials add docs-mcp --host mcp.corp.example/docs --kind bearer < token.txt
```

A destination is `host[:port][/prefix]`: the port defaults to 443, and a prefix limits the token
to that path (several MCP servers behind one gateway each get their own). Wildcard hosts are not
supported. Two of your credentials cannot hold the identical destination (`409 destination_conflict`); nested prefixes such as `mcp.corp.example` and `mcp.corp.example/jira` are fine, and the longest matching prefix wins.

### Things to know

- **`this sandbox service does not offer egress credentials`** means your operator has not enabled
  the feature. Nothing is wrong with your setup.
- A service the proxy has no credential of yours for is passed through untouched, so a `curl`
  there sends only what you give it.
- An upstream can send back a cookie it minted from your token, or echo the request's headers in
  a response; either would reach the sandbox. Use narrowly scoped, short-lived tokens, and store
  only services your operator trusts.

## 7. Limits

- **Sandboxes expire after 7 days** by default (your operator may set another lifetime). Then the
  sandbox and its files are gone: pull before. `mocactl sbx ls` shows each sandbox's expiry, and
  `mocactl sbx doctor` fails its sandbox check in the last 24 hours. A sandbox's lifetime cannot be
  extended; for a fresh one, pull, `mocactl sbx rm`, then `mocactl sbx up` (an expired one is
  removed with `mocactl sbx rm --force`, as its files can no longer be checked).
- **3 sandboxes per person** by default, and a total for the whole service. Each worktree or clone
  you run `up` in uses one.
- **Delete and de-enrollment take effect within one token lifetime plus 30 s** (15 minutes by
  default, so 15.5 minutes). A sandbox token already issued keeps working until it expires. A
  command still running at that point is cancelled.
- **The longest single command is one token lifetime** (15 minutes by default). `run`'s
  `--timeout` defaults to, and is capped at, that lifetime minus 60 s. Split longer work into
  several calls.
- **Files over 12 MiB are not pushed** (`push` refuses and names them; `.gitignore` them), and a
  tree over 256 MiB is refused (`--max-push` sets another cap). A pull larger than 8 MiB as a
  patch is refused, never cut.
- **What a pull does not bring back:**
  - new files the agent creates in build output, at any depth: `node_modules/`, `.venv/`,
    `venv/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `*.pyc`, and any `build/`,
    `dist/` or `target/` directory. A `build/`, `dist/` or `target/` below the top level is pulled
    in full only if you pushed a file inside it (a source directory that happens to have such a
    name). The agent's edits to files you pushed in any of these do come back. A rename inside an
    excluded directory comes back as a bare delete, and a `push` replaces the agent's new files
    there without warning, since they never count as unpulled;
  - new files under a directory your own `.gitignore` ignores are not protected: they may not come
    back, and a `push` can replace them.
- **Pull --apply needs a recent git.** When your files have moved on since the push, the patch is
  merged 3-way; that uses `git apply --3way --cached`, which git accepts from version 2.32
  ([git 2.32 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.32.0.adoc)).
  When the patch does not apply as it is, and it touches a file you have uncommitted edits to, or
  conflicts with your local commits, it is refused and nothing is changed.
- **One shared KVM host, best effort.** Every sandbox runs on one shared machine, supported in
  business hours. If it is lost, every sandbox on it ends and its files are gone. Your laptop
  keeps the original tree, so pull often.

## 8. Your own templates

A template is the image a sandbox's VM boots: its tools, and its seed (what fills `/workspace`).
Beyond the ones your operator provides, you can make your own from an image pinned by digest
(`repository@sha256:<64 hex>`) and a spec (`moca-sbx-template-spec/1`; samples in
[the onboarding examples](../../deploy/sbx/template-onboarding/examples/)). A policy, not a person,
admits or refuses each create; the rules it names are in
[the gating rules](../../deploy/sbx/template-onboarding/governance/GATING-RULES.md). Every command
below takes `--json` (the API's answer, never a token).

**What you may do.** `mocactl sbx quota` shows your template quotas and use, and your live-sandbox
cap; `mocactl sbx policy` the profiles a create can name, each with its size envelope, egress and
rules, the registries an image may come from, and the policy's digest; `mocactl sbx hosts` each
KVM host's active slots, start line and memory.

**Create, and follow the build:**

```bash
mocactl sbx templates create --spec my-python.json --dry-run   # the checks needing only the inputs
mocactl sbx templates create --spec my-python.json             # prints: my-python b-<handle> queued
mocactl sbx templates follow my-python                         # exit 0 once registered
```

- `--spec` is a spec file or a gate record (whose `template` block is the spec); the id and image
  are the spec's own (`--id`, `--image` must equal them). `--profile P` names a policy profile,
  `--gate-record F` sends its gate record byte for byte (the `benchmark` profile needs one; at most
  1 MiB, with one `--spec`),
  `--visibility private` keeps a new template to yourself.
- `--dry-run` creates nothing: it reads the policy (`mocactl sbx policy`, so it needs your login
  and the control plane, exit 3 or 4 without them) and names the policy rule a create would fail
  (`M7.id`, `M1`, `X10`, …). Whether the policy trusts a gate record, whether the image's registry
  is allowed, and your quotas, only the server decides: its answer is still the decision.
- Several `--spec` make one create each. When your `buildsQueued` quota is full, the next waits for
  a slot ("N waiting for a queue slot") rather than failing, up to `--timeout` (default 3600 s).
  Ctrl-C stops it with exit 130: the specs not yet posted are not posted.
- A create on an id already yours is a new build of it. The same create again (same image, spec,
  profile and gate record) answers the build it already made (`reused`), not a second one; a
  changed spec, image or profile queues a new build. An id someone else owns is refused with its
  owner's name.
- `follow` polls until the build is `registered` (exit 0), `failed` or `rejected` (exit 1, with
  its reason). `templates show ID` prints it once; `templates cancel ID --build B` withdraws one not
  yet built. `templates build ID --spec F` is a new build of your template.

**Use it:**

```bash
mocactl sbx templates activate my-python --wait     # until active, saying why it waits
mocactl sbx create --template my-python --seed      # the build's seed first, then a clean-tree check
mocactl sbx templates deactivate my-python --stop-now
```

`activate --wait` prints why a start waits (queued at position N, no slot, memory, or a memory
file to rebuild); a refusal other than a full slot fails at once.
`create --template ID@BUILD` pins one build. `create --seed` runs the build's seed as the sandbox's
first command, then checks that `/workspace` is a clean git tree; a failure keeps the sandbox, for
you to look at. The seeded tree becomes the sandbox's baseline, so `sbx pull` returns only what
changed after the seed, and `sbx rm` deletes an unchanged seeded sandbox with no `--force`.
**A probe sandbox you then changed needs `sbx rm --force`:** a sandbox created with `--seed` to try
a template, in which you ran something that wrote to `/workspace` (a test run's caches, a build),
has changes not yet pulled, so a plain `rm` refuses it. Pull what you want to keep, then
`mocactl sbx rm --force <id>`. `deactivate --stop-now` skips the host's idle grace.

**Change and retire it:** `mocactl sbx templates tag ID default --build B` points new creates at
another build; `templates edit ID` changes its description and visibility. `mocactl sbx templates
retire my-python --wait` returns once no host holds it; `--build B` retires one build. A retire is
refused while a sandbox or session still uses the build (`409 build_in_use`): delete those first. A
create after a retire answers `410 template_retired`.

**Waits and their exit.** `follow` waits up to 3600 s, `retire --wait` 300 s; `activate --wait` at
least 1800 s, more for a build queued behind its host's start limit: (position ÷ starts at once,
rounded up, plus 1) × the host's measured start time × 1.25, read at the first poll, and at most
4 h. `--timeout S` sets another. Past it they exit **5**; nothing is undone.

**What your sandbox reached.** For a template with egress, `mocactl sbx egress <sandbox>` lists the
hosts the sandbox connected to, from the KVM host's egress proxy, and the sandbox's end record names
the log's digest.

**A record of every call.** `--record calls.ndjson` on these commands (and every other command that
calls the API, but `token`, `login`, `logout` and `credentials`) appends one JSON line per HTTP
attempt: the command, the path, the status, both bodies and their times. The file is created `0600`.
Tokens and gate records are kept only as their sha256, and hosts and build-log text only as their
length, so a record can be shared. `mocactl run "prompt" --record F` writes the same record for a
Moca Pi session's calls ([CLI reference](../reference/cli-mocactl.md)).

**For admins.** `mocactl sbx admin subjects enroll|unenroll|grant|revoke` reads the current value
first and prints `old -> new` and the record written; if the value changed between that read and
the write (another admin at the same time), it says so and exits 1: check it and write again.
`mocactl sbx templates quota TARGET …` sets a subject's template quotas, and `templates transfer ID
SUBJECT` hands a template to another owner.

## 9. Using the API directly

The sandbox is also reachable from your own code over gRPC (`sandbox/v1`):

```bash
eval "$(mocactl sbx env)"
```

prints, for the bound sandbox, `export` lines for a client: `SBX_ADDR`, `SBX_TLS`,
`SBX_SANDBOX_ID`, `SBX_WORKSPACE_KEY`, `SBX_TOKEN_CMD` and, when the endpoint's certificate is
self-issued, `SBX_CA_FILE`. `mocactl sbx token` prints a fresh token; `mocactl sbx token
--renew-every 600` prints a new one every 600 seconds, one line each, until stopped, for a
long-lived client that reads its next token from a pipe. See
[the direct-client guide](../api/sandbox-v1-direct-client.md) for what a client sends.

## 10. Troubleshooting

Start with `mocactl sbx doctor` in the repository:

```bash
mocactl sbx doctor
```

```
ok - login: logged in to https://<api host> as <your GitHub login>
ok - sandbox: sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default) is ready; expires 2026-10-26T09:00:00.000Z, in 6 d 23 h
ok - agent config: Claude Code, OpenCode and IBM Bob use the sandbox MCP server, with every local tool denied in this repository's project config except Bob's, which has no deny list, so its own tools stay available; user-level and managed settings are not checked
ok - exec: one `true` in a fresh VM: 412 ms
ok - changes: nothing to pull
ok - recent calls: 42 calls in the last 24 h: p50 380 ms, p95 1210 ms, 1 error (0 not the command's own)
```

It exits 0 when every check passes, else 1, and each failure prints its fix. What they mean:

| Check          | A failure means                                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`        | Not logged in (run `mocactl sbx login`), not enrolled (send your operator the `github:<id>` it names), or the service is unreachable (check the URL and your network)                                                                                                                                                                                          |
| `sandbox`      | No sandbox is bound here, it no longer exists, or it is terminated (deleted or expired): `mocactl sbx up` creates a new one. "less than 24 h left": pull its work now                                                                                                                                                                                          |
| `agent config` | A local tool is enabled again, or the `sandbox` server is missing, in this repository's project files: `mocactl sbx up` merges it again. For IBM Bob it checks only that the server is there, since Bob has no deny list. It checks the project's files only, not your user-level or managed settings; a local tool you enable there still acts on your laptop |
| `claude code`  | Shown only when it fails: the Claude Code on your `PATH` is older than 2.0.0, so its `MultiEdit`, `LS` and `NotebookRead` tools read or edit files on your laptop and are not denied. Run `claude update`                                                                                                                                                      |
| `exec`         | The sandbox does not answer. Retry in a minute; if it persists, tell your operator (`mocactl sbx doctor --json` is what to send)                                                                                                                                                                                                                               |
| `changes`      | A warning, not a failure: the sandbox holds work you have not pulled (`mocactl sbx pull --apply`), or the last push did not finish (`mocactl sbx push`)                                                                                                                                                                                                        |

Other messages:

- **"not enrolled"**: your GitHub account is not on the service's list, or was removed. Send your
  operator the `github:<id>` in the message.
- **"sandbox failure: … no live worker for sandbox …"** (this is what "template unavailable" looks
  like today): the template's worker is not attached, usually because the KVM host is down or being
  maintained. Nothing you can fix; tell your operator, and wait.
- **"at most 3 live sandboxes per user"** or **"the sandbox service is at capacity"**: `mocactl sbx ls`
  shows yours; pull and `mocactl sbx rm` one you no longer need.
- **"template busy; retry later"**: too many users on that template at once. Retry in a while.
- **"refused by policy rule …"** (a template create): the rule the create failed and why;
  `mocactl sbx templates create … --dry-run` checks most of them before you send it, and
  `mocactl sbx policy` lists the profiles' envelopes. **"over your … quota"**: `mocactl sbx quota`.
- **Exit 5**: a `templates follow`, or a create waiting for a queue slot, ran out of time, with what
  it was waiting for; nothing was undone. Run it again, or with a longer `--timeout`.
- **Exit 130**: Ctrl-C stopped a `templates follow`, or a create waiting for a queue slot. A build
  already queued goes on (`templates cancel ID --build B` withdraws it); a spec not yet posted was
  not.
- **"sandbox busy: …"**: another call on your sandbox is still running (another terminal, or a
  parallel agent). Wait for it, or retry.
- **"the sandbox expires in N s; pull your work now"**: the sandbox is in its last minute, too
  short for a command to run, so even a pull can no longer reach it. In the minutes before, commands
  still run, with their timeout cut to what is left: pull then.
- **"sandbox has expired"** or **"sandbox was deleted"** (the agent sees "sandbox expired on …; run
  `mocactl sbx up` for a new one"): the sandbox is gone; `up` makes a new one and pushes your
  tree.
- **The agent still uses its local tools** (it edits files on your laptop): re-run
  `mocactl sbx up`, approve the `sandbox` MCP server and accept Claude Code's folder trust once,
  then restart the agent. `mocactl sbx doctor` names what is wrong. Check your user-level settings
  too, which `doctor` does not read.
- **TLS errors at login**: the service's certificate is not publicly trusted. Ask your operator for
  its CA and set `NODE_EXTRA_CA_CERTS=<ca.pem>` in your environment.
- **"sbx: codex is not on PATH"**: install it (`npm install -g @openai/codex`). The message also
  prints the `codex -c …` line to run by hand, if you have it somewhere else.
- **Codex says it has no credentials** (`✗ auth no Codex credentials were found`): that is Codex's
  own account, not your sandbox login — `codex login`, or set `OPENAI_API_KEY`.
  `codex doctor | grep -A3 "auth "` names which one it found.
- **Bob is not using the sandbox tools**: most often the prompt did not name them, and Bob used its
  own — `Execute Command` in the call block means your laptop, `Bash (sandbox)` means the sandbox.
  Re-ask with "using the sandbox bash tool, …"; telling it not to use local tools does not work.
  Failing that, check the server is there: `bob mcp list` should list `sandbox`, and `/mcp` inside
  `bob chat` should show it `● Connected` with a tool count. If it is missing, run `mocactl sbx up`
  again (`mocactl sbx doctor` accepts either of Bob's two filenames); if it will not start,
  `mocactl` is not on the `PATH` Bob inherits. Note Bob's local tools are never denied, so it can
  always act on your laptop when the model asks — see [IBM Bob](#ibm-bob) above.
- **Bob says `too many arguments`**: Bob 2.0.9 takes no bare prompt. Use `bob -p "…"`,
  `bob run "…"`, or `bob chat`.
- **Bob says `Bob API key is required`**: that is Bob's own account, not your sandbox login — set
  `BOB_API_KEY`, or start `bob chat` and log in there.
- **Bob says a folder `is not a trusted folder`**: choose a trust level in `bob chat`, or pass
  `--trust`. Prefer the former: `--trust` takes the default grant without showing you what it is.
- **Bob reports a missing compiler** (`go: command not found` and the like): the templates carry
  only the Pi toolchain and the VM has no network, so nothing more can be installed. See
  `mocactl sbx templates`, and [IBM Bob](#ibm-bob) above.
- **Codex edits files on your laptop instead of in the sandbox**: check you started it with
  `mocactl sbx codex` (or the `-c mcp_servers.sandbox=…` line), and that `/mcp` in the TUI lists
  the `sandbox` tools. Note `mocactl sbx doctor`'s `agent config` check covers Claude Code,
  OpenCode and IBM Bob (for Bob, only that the server is there), but not Codex: Codex has nothing
  in your repository for it to check, and its `unified_exec` tool cannot be disabled, so add
  `-c sandbox_mode="read-only"` if you want its own confinement too.

**Logging out.** `mocactl sbx logout` ends this login and deletes `sbx-auth.json` (in
`~/.config/mocactl/`). It is kept apart from `mocactl login`'s moca login: you can have both, and
logging out of one leaves the other.

## 11. Data handling

Your code sits on one shared KVM host that other users' sandboxes also run on. **Push internal
code only, and no secrets.** `sbx up` and `push` leave out common secret files by default (`.env*`,
`*.pem`, `*.key`, `id_*`), but they cannot know about every secret: keep credentials, tokens and
customer data out of the repositories you push.
