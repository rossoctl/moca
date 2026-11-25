---
sidebar_position: 2
---

# Run your coding agent

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

**Run your agent** in a repository you have brought up
([Install, log in and bring a repository up](set-up.md)). The supported agents differ in how they are wired and in how
much `up` can take away:

| Agent                       | How it gets the server                                                              | Its local tools                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude Code**             | `up` writes `.mcp.json` + `.claude/settings.json`; or `mocactl sbx claude`, per run | Denied (`permissions.deny`), or left to Cortex with `--cortex`       |
| **OpenCode**                | `up` writes `opencode.json`                                                         | Denied (`tools.<name>: false`)                                       |
| **[Codex CLI](#codex-cli)** | `mocactl sbx codex`, per run — it reads no project config                           | Shell tool off; `unified_exec` cannot be disabled                    |
| **[IBM Bob](#ibm-bob)**     | `up` writes `.bob/mcp.json` + `.bob/settings.json`                                  | **Not denied, and preferred** — name the sandbox tools in the prompt |
| **Pi**                      | `up` writes `.pi/mcp.json` + `.pi/settings.json`                                    | Denied (`defaultTools` selects none), once the project is trusted    |

Claude Code, OpenCode and Pi need nothing beyond `up`, so start them as you normally do:

```bash
claude
```

or

```bash
opencode
```

or

```bash
pi
```

Start it in the repository root, not a subdirectory. Claude Code asks once to approve the
project's `sandbox` MCP server: choose **"Use this MCP server"** — the highlighted default
declines and leaves the agent with no tools at all
([The first `claude` asks about the sandbox server](agent-configuration.md#the-first-claude-asks-about-the-sandbox-server)). If it asks whether you trust the
folder, accept that too. Pi likewise asks whether to trust the project, and records the answer
per folder (`~/.pi/agent/trust.json`), so a fresh clone or worktree — a new directory — asks its
one question again. Then ask for work as usual ("the tests fail, fix them"). The agent's tools are now `sandbox`'s
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
`mocactl sbx claude --sandbox SANDBOX` outside a repository. `--strict-mcp-config` alone limits only
the MCP servers, not the built-in tools. In a repository `up --cortex` set up, the launcher
leaves the local tools to Cortex, as `up` does, and says so when it starts.

It also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for the run, so your machine's auto-memory stays
out of the session in every mode, with or without `up`'s settings.

Headless use (scripts, CI) works the same way, without the prompts:

```bash
claude -p "Fix the failing test and run the suite" --mcp-config .mcp.json --strict-mcp-config
opencode run "Fix the failing test and run the suite"
```

## Codex CLI

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

## IBM Bob

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
#    Check `mocactl sbx templates ls` carries your language before asking for a build or test run.
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
`curl` — and the VM reaches only the hosts on the egress allowlist, and none on a template without
egress, so a toolchain the template lacks can be fetched only from an allowlisted host. Reading,
grepping and editing work; compiling does not, for a language the template does not carry. Check `mocactl sbx templates ls` before asking Bob for a build or a test run, and expect it to report a
missing compiler rather than produce one. (If it silently succeeds instead, check the tool names: it
may have used your laptop's.)
