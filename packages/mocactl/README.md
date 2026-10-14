# mocactl

> **Preview.** `mocactl` is implemented but not yet declared Stable. The command reference is in
> [`docs/reference/cli-mocactl.md`](../../docs/reference/cli-mocactl.md); the change policy in
> [`docs/reference/change-policy.md`](../../docs/reference/change-policy.md).

A terminal client for the harness: log in, manage sessions and inference credentials, and watch
turns stream live. It talks only to the control plane's `/v1` API and the harness's `/v1/turn`,
so it works the same whatever runs behind those URLs. Design:
[`docs/specs/2026-09-25-mocactl-control-plane-client-design.md`](../../docs/specs/2026-09-25-mocactl-control-plane-client-design.md).

## Run it

**New here?** [QUICKSTART.md](QUICKSTART.md) goes from a fresh checkout to a streamed reply on a
local kind cluster, with one script doing the cluster wiring.

**Install** (macOS or Linux, Node.js 22 or later):

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
export SH_CONTROL_PLANE_URL=https://moca.example.com   # your MOCA server; the only URL mocactl needs
mocactl            # interactive; the first run walks you through setup
mocactl --setup    # re-run setup on a configured machine
```

It installs `~/.local/bin/mocactl` (a symlink to `mocactl.mjs` beside it) from the latest release, after checking its SHA-256, and prints
the `PATH` line to add if that directory isn't on your `PATH` yet. Re-run it to upgrade.
`MOCACTL_VERSION=edge` installs the build of `main`, `MOCACTL_VERSION=v0.6.0` a given release, and
`MOCACTL_INSTALL_DIR` sets another directory. `mocactl --version` says which one you have. To
uninstall, `rm ~/.local/bin/mocactl ~/.local/bin/mocactl.mjs` (and `~/.config/mocactl` for its config and login).

**From a checkout** (contributors): `pnpm install`, then `node packages/mocactl/bin/mocactl.mjs`,
which runs the TypeScript sources directly. `pnpm --filter @moca/mocactl build` writes the
release bundle to `packages/mocactl/dist/mocactl.mjs`.

`mocactl` needs one URL: the server's (the control plane). It comes from `--control-plane-url`, then
`SH_CONTROL_PLANE_URL`, then the saved config. The control plane says where the harness is
(`GET /v1/discovery`, set by its operator with `SH_PUBLIC_HARNESS_URL`), so there is nothing else to
configure. Onboarding checks the control plane and the harness it points at before saving the URL —
nothing is written to disk until both answer.

`--harness-url` / `SH_HARNESS_URL` override discovery (e.g. a harness behind a local port-forward);
onboarding never saves a discovered harness URL, so a harness the operator moves is followed.

## Keys

| Action                               | Slash                   | Keys                   |
| ------------------------------------ | ----------------------- | ---------------------- |
| Command palette                      | —                       | `ctrl+p`               |
| Sessions (resume, rename, delete)    | `/sessions`, `/resume`  | `ctrl+x l`             |
| New session                          | `/new`                  | `ctrl+x n`             |
| Rename session                       | `/rename <title>`       | `ctrl+x r`             |
| Promote skills for the next session  | `/promote DIR`          | —                      |
| Drop the pending promoted bundle     | `/promote --clear`      | —                      |
| Credentials                          | `/credentials`          | `ctrl+x k`             |
| Toggle tool details / thinking       | `/details`, `/thinking` | `ctrl+x d`, `ctrl+x t` |
| Copy last reply / export to Markdown | `/copy`, `/export`      | `ctrl+x y`, `ctrl+x x` |
| Compose in `$EDITOR`                 | `/editor`               | `ctrl+x e`             |
| Theme, diagnostics                   | `/theme`, `/doctor`     | —                      |
| Help                                 | `/help`                 | `?` on an empty input  |
| Quit                                 | `/quit`                 | `ctrl+x q`, `ctrl+c`   |

`Enter` sends, `alt+enter` adds a newline, `↑`/`↓` walk your prompt history. `Esc` closes any
overlay (including a loading or error screen) and, on the chat view, cancels the running turn; a
second `Esc` within a second also clears queued messages (after a cancel, the next queued message
waits that second before it is sent). `$EDITOR` (or `$VISUAL`) runs with the
terminal suspended — if it cannot start, a toast says so and your draft is unchanged. It runs
without a shell: the value is split into words (quotes work, e.g. `code --wait` or
`"/path/with spaces/subl" -w`), but nothing is expanded, so write `$HOME/bin/ed` out in full, and
on Windows name an `.exe`. Override
keys in `config.json` under `keybinds`, e.g. `{ "session.new": "ctrl+x s" }`.

## Headless

```bash
mocactl login                               # device-flow login, prints the code
mocactl logout [--all]                      # end this login on the server (--all: all of yours)
mocactl auth token [--json]                 # a valid API token for scripts and the Claude Code hook
mocactl doctor [--json]                     # seven checks, one fix per failure; exit 1 on failure
mocactl run "prompt" [--session ID | --new] [--option inferenceCredential=NAME] [--json]
mocactl promote DIR [--dry-run] [--json]    # upload DIR's .claude/skills and .claude/commands
mocactl run "prompt" --config DIGEST        # start the new session with that config bundle
mocactl bundles delete DIGEST [--json]      # delete a bundle you promoted; frees your budget
```

```bash
mocactl sessions [--json]                   # every session you own, all pages
mocactl sessions delete ID [--json]         # also drops its local history, even if already gone
mocactl credentials [--json]                # names, kinds, hosts and endpoints; never secrets
printf %s "$KEY" | mocactl credentials add NAME --host HOST [--host HOST ...] \
  [--kind KIND] [--consumer CONSUMER] [--endpoint URL] [--json]
mocactl credentials delete NAME [--json]    # exit 1 if you own no credential of that name
```

> **Preview.** `mocactl spawn`, `mocactl subagents`, and `mocactl get` are implemented but not
> yet declared Stable; flags, ledger format, and output shapes may change. Follow-ups tracked
> under the subagent commands issue: `watch`, `approve`/`reject`, `follow-up`, and a
> configurable concurrency cap.

```bash
mocactl spawn "prompt" [--config sha256:…] --kind prompt|solve \
  [--repo URL --ref REF] [--tag T] [--json]  # fork a detached subagent; prints its sessionId
mocactl subagents [--tag T] [--json]        # list spawned subagents + current honest state
mocactl get SESSIONID [--out DIR] [--json]  # write result files + bounded summary
```

`mocactl spawn` creates a session (pinned to the bundle if `--config` is given), writes a record
to `$XDG_STATE_HOME/mocactl/subagents.jsonl`, then forks a detached worker that holds the sync
`POST /v1/runs` call outside this process group. Quitting `mocactl` does not kill the worker; the
sessionId is printed on stdout immediately so a script can capture it. `--kind solve` requires
both `--repo URL` and `--ref REF`; `--kind prompt` refuses them. The optional `--tag T` groups
related spawns (e.g. a parent agent's own subagents under one tag) so `mocactl subagents --tag T`
can list them in isolation.

`mocactl subagents` reads the ledger and joins it with `/runs/status`, resolving the server's
`queued` ambiguity with child-pid liveness and a 60-second grace: a `queued` row with a live
child is `running`; past the grace with a dead child it is `unknown`. Without `--tag`, every
spawn you own is listed, oldest first by dispatch time. A client-side fetch cutoff on the
worker _after the request landed_ (undici's 5-min `headersTimeout` is the common one) is
reconciled on the next poll instead of reported as failed; a connect-phase failure
(`ECONNREFUSED`, DNS, TLS) is still terminal, since the server never saw the request.

`mocactl get SESSIONID` fetches a terminal result and writes files to `--out DIR` (default: cwd):
`<sid>.text` for a prompt response, `<sid>.patch` for a solve result (with a trailing newline
normalized so `git apply` does not reject it), and `<sid>.verdict.json` if the server returned a
verdict. A session that has not finished yet exits `1` with a hint; a `failed` body exits `1`
with the status, reason, and detail on stderr.

`mocactl run` continues the session `--session` names, or starts a new one (`--new`, the default).

`mocactl promote` prints what it built and the preflight report (warnings on stderr) BEFORE
uploading, then the bundle digest to pass to `run --config`. `--dry-run` builds and prints without
uploading, and needs no login. It exits `2` when refused before upload (a usage error, not logged
in, or preflight errors), `3` on a structural credential match, and `1` for anything else. In the
TUI, `/promote DIR` attaches it to the next session you create; its toast counts skills, commands
and warnings. With exactly one inference credential and no presets, the new-session overlay creates
the session as soon as it opens, so `/promote DIR` starts the session right away. A session's
bundle is fixed when it is created, so
`--config` cannot be combined with `--session`.

Stored bundles count against a per-account and a deployment-wide byte budget (`429` when full).
`mocactl bundles delete DIGEST` deletes a bundle you promoted and frees its share; an admin may
delete anyone's. Sessions created on it then fail their next turn as for an expired bundle.
`mocactl promote DIR --dry-run` prints a directory's digest without uploading. Rollout order: upgrade the harness before the
control plane — an older harness ignores `configRef`, so turns would run without the skills and
report no error.

`mocactl credentials add` reads the secret from stdin, never from the command line, so it stays
out of shell history and `ps`; it refuses a terminal on stdin (`read -rs KEY` first, or use
`/credentials` in the TUI). For a kind with one secret field (`bearer`, `api-key`,
`oauth2-token`) stdin is the secret itself, one line, its trailing newline dropped, with no
`field=` prefix and no surrounding whitespace; for any other kind it is one `field=value` per line
(`basic`, which is not for inference: `--consumer sandbox-egress`, then `username=…` and
`password=…`). `--kind` defaults to `bearer` and `--consumer` to `inference`, as in the TUI form;
`--host` takes a comma-separated list too and is required, and `--endpoint` is for `inference`
only. The TUI form's checks apply, all but the secret's before stdin is read, and a problem names
fields, never values. It says on stderr when it starts reading stdin.

Exit codes, for every command: `0` it worked, `1` it failed (the turn, or the control plane
refused), `2` a usage or setup problem (bad flags, not logged in, no destination for the turn),
`130` cancelled (Ctrl-C, which also stops a listing or a stdin read that is waiting).

### Output

stdout carries only the result; every message goes to stderr, including "no sessions" for an
empty list. Without `--json` a listing is an aligned table with a header row, made terminal-safe.
Times are UTC. With `--json` stdout is one JSON document and one line; `run` and `doctor` keep
their own shapes. These shapes are stable: fields may be added, but none is renamed or removed.

| Command              | `--json` on stdout                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `sessions`           | `{"sessions":[{"sessionId","title","state","createdAt","lastTurnAt"}]}`                            |
| `sessions delete`    | `{"sessionId","status"}`, `status` being `deleted`, or `accepted` while the control plane finishes |
| `credentials`        | `{"credentials":[{"name","kind","consumer","hosts","endpoint"}]}`                                  |
| `credentials add`    | `{"name","status":"stored"}`                                                                       |
| `credentials delete` | `{"name","status":"deleted"}`                                                                      |
| `spawn`              | `{"type":"session","sessionId","pid"}`                                                             |
| `subagents`          | `{"subagents":[{"sessionId","tag","kind","state","detail","bundle","submittedAt"}]}`               |
| `get`                | `{"sessionId","status","files":["<path>",…],"reason"?,"message"?}`                                 |

`createdAt` and `lastTurnAt` are epoch milliseconds as the control plane sends them (`lastTurnAt`
is `null` before the first turn); `endpoint` is `null` when the deployment default applies.
`title` is this machine's: the first prompt, or a TUI rename, and `null` for a session with no
local history (the control plane stores no titles).

## Files

- `$XDG_CONFIG_HOME/mocactl/config.json` — endpoints, theme, toggles, keybinds, presets.
- `$XDG_CONFIG_HOME/mocactl/auth.json` — the 15-minute API token and the refresh token that renews
  it (mode 0600). A login renews itself for 30 days after its last use and 90 days at most; every
  renewal replaces the refresh token, so a copied file stops working the next time either copy is
  used. `mocactl logout` ends it. No provider key is ever stored.
- `$XDG_STATE_HOME/mocactl/subagents.jsonl` — ledger of subagents spawned on this machine (mode
  0600). Append-only JSONL; `mocactl subagents` reads from it. Includes the dispatch envelope so
  a future gate-decision command can resume the subagent. Compaction is not automatic yet; the
  file grows one line per spawn plus one per state transition.
- `$XDG_STATE_HOME/mocactl/transcripts/` — local session history, per subject and per control plane
  (mode 0600). A session resumed from another machine shows no history — it belongs to a
  different transcript store.

Falls back to `~/.config/mocactl/` and `~/.local/state/mocactl/` when the `XDG_*` variables are unset.

## Troubleshooting

Run `mocactl doctor`. Its "harness located" line says where the harness was found and how. If the
control plane advertises none, its operator sets `SH_PUBLIC_HARNESS_URL` to the harness as clients
reach it (not the in-cluster address; behind a port-forward, the local one), e.g.
`kubectl set env deploy/sh-control-plane SH_PUBLIC_HARNESS_URL=http://localhost:18081`. A control
plane older than `/v1/discovery` needs upgrading, or `--harness-url` in the meantime.

If it reports that the harness does not trust this control plane, the harness is missing the
control plane's public keyset, the exchange token, or `SH_CONTROL_PLANE_URL`/`SH_REQUIRE_AUTH`. On
the VM/P6 path, re-run `sudo ./deploy/vm/setup-vm.sh`, which installs the control plane beside the
supervisor and wires all four (`deploy/vm/README.md`, "The control plane"). There the exchange token
is a systemd credential, not a `supervisor.env` line. On the Knative path they are set in
`deploy/knative/service.yaml`.

Resuming a session started on another machine shows no history: the control plane has no route
that returns a session's messages yet, so history is kept locally.

Creating a credential requires at least one destination host — the control plane rejects an empty
list.
