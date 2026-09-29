# mocactl

A terminal client for the harness: log in, manage sessions and inference credentials, and watch
turns stream live. It talks only to the control plane's `/v1` API and the harness's `/v1/turn`,
so it works the same whatever runs behind those URLs. Design:
[`docs/specs/2026-09-25-mocactl-control-plane-client-design.md`](../../docs/specs/2026-09-25-mocactl-control-plane-client-design.md).

## Run it

**New here?** [QUICKSTART.md](QUICKSTART.md) goes from a fresh checkout to a streamed reply on a
local kind cluster, with one script doing the cluster wiring.

```bash
pnpm install
node packages/mocactl/bin/mocactl.mjs            # interactive; the first run walks you through setup
node packages/mocactl/bin/mocactl.mjs --setup    # re-run setup on a configured machine
```

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
mocactl doctor [--json]                     # seven checks, one fix per failure; exit 1 on failure
mocactl run "prompt" [--session ID | --new] [--option inferenceCredential=NAME] [--json]
```

`mocactl run` continues the session `--session` names, or starts a new one (`--new`, the default).

`mocactl run` exit codes: `0` the turn completed, `1` it failed, `2` a usage or setup problem (bad
flags, not logged in, no destination for the turn), `130` cancelled (Ctrl-C).

## Files

- `$XDG_CONFIG_HOME/mocactl/config.json` — endpoints, theme, toggles, keybinds, presets.
- `$XDG_CONFIG_HOME/mocactl/auth.json` — the 1-hour API token (mode 0600). No provider key is ever stored.
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

If it reports that the harness does not trust this control plane, the harness
must be given `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CONTROL_PLANE_URL`, `SH_EXCHANGE_TOKEN` and
`SH_REQUIRE_AUTH`: on the VM/P6 path, add them to `/etc/moca/supervisor.env` (the
`EnvironmentFile` of `deploy/vm/systemd/sh-supervisor.service` — the shipped
`supervisor.env.example` doesn't include them yet); on the Knative path they're set in
`deploy/knative/service.yaml`.

Resuming a session started on another machine shows no history: the control plane has no route
that returns a session's messages yet, so history is kept locally.

Creating a credential requires at least one destination host — the control plane rejects an empty
list.
