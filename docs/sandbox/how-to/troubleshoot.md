---
sidebar_position: 10
---

# Troubleshoot

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

Start with `mocactl sbx doctor` in the repository:

```bash
mocactl sbx doctor
```

```
ok - login: logged in to https://<api host> as <your GitHub login>
ok - sandbox: sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default) is ready; expires 2026-10-26T09:00:00.000Z, in 6 d 23 h, after 7 d without use
ok - agent config: Claude Code, OpenCode and IBM Bob use the sandbox MCP server, with every local tool denied in this repository's project config except Bob's, which has no deny list, so its own tools stay available; user-level and managed settings are not checked
ok - exec: one `true` in a fresh VM: 412 ms
ok - changes: nothing to pull
ok - recent calls: 42 calls in the last 24 h: p50 380 ms, p95 1210 ms, 1 error (0 not the command's own)
```

It exits 0 when every check passes, else 1, and each failure prints its fix. What they mean:

| Check          | A failure means                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`        | Not logged in (run `mocactl sbx login`), not enrolled (send your operator the `github:<id>` it names), or the service is unreachable (check the URL and your network)                                                                                                                                                                                                                                                               |
| `sandbox`      | No sandbox is bound here, it no longer exists, or it is terminated (deleted or expired): `mocactl sbx up` creates a new one. "less than 24 h left": pull its work now                                                                                                                                                                                                                                                               |
| `agent config` | A local tool or auto-memory is enabled again, or the `sandbox` server is missing, in this repository's project files: `mocactl sbx up` merges it again, except over a value you set, which the failure names. For IBM Bob it checks only that the server is there, since Bob has no deny list. It checks the project's files only, not your user-level or managed settings; a local tool you enable there still acts on your laptop |
| `claude code`  | Shown only when it fails: the Claude Code on your `PATH` is older than 2.0.0, so its `MultiEdit`, `LS` and `NotebookRead` tools read or edit files on your laptop and are not denied. Run `claude update`                                                                                                                                                                                                                           |
| `auto-memory`  | Shown only when it fails: your shell's `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is `0`, `false`, `no` or `off`, which turns auto-memory back on for a plain `claude`. Unset it, or start Claude Code with `mocactl sbx claude`                                                                                                                                                                                                             |
| `exec`         | The sandbox does not answer. Retry in a minute; if it persists, tell your operator (`mocactl sbx doctor --json` is what to send)                                                                                                                                                                                                                                                                                                    |
| `changes`      | A warning, not a failure: the sandbox holds work you have not pulled (`mocactl sbx pull --apply`), or the last push did not finish (`mocactl sbx push`)                                                                                                                                                                                                                                                                             |

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
  always act on your laptop when the model asks — see [IBM Bob](connect-agents.md#ibm-bob).
- **Bob says `too many arguments`**: Bob 2.0.9 takes no bare prompt. Use `bob -p "…"`,
  `bob run "…"`, or `bob chat`.
- **Bob says `Bob API key is required`**: that is Bob's own account, not your sandbox login — set
  `BOB_API_KEY`, or start `bob chat` and log in there.
- **Bob says a folder `is not a trusted folder`**: choose a trust level in `bob chat`, or pass
  `--trust`. Prefer the former: `--trust` takes the default grant without showing you what it is.
- **Bob reports a missing compiler** (`go: command not found` and the like): the templates carry
  only the Pi toolchain, and anything more installs only on a template with egress, from a host on
  the allowlist. See `mocactl sbx templates ls`, and [IBM Bob](connect-agents.md#ibm-bob).
- **Codex edits files on your laptop instead of in the sandbox**: check you started it with
  `mocactl sbx codex` (or the `-c mcp_servers.sandbox=…` line), and that `/mcp` in the TUI lists
  the `sandbox` tools. Note `mocactl sbx doctor`'s `agent config` check covers Claude Code,
  OpenCode and IBM Bob (for Bob, only that the server is there), but not Codex: Codex has nothing
  in your repository for it to check, and its `unified_exec` tool cannot be disabled, so add
  `-c sandbox_mode="read-only"` if you want its own confinement too.

**Logging out.** `mocactl sbx logout` ends this login and deletes `sbx-auth.json` (in
`~/.config/mocactl/`). It is kept apart from `mocactl login`'s moca login: you can have both, and
logging out of one leaves the other.
