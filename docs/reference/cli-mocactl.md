# `mocactl` command reference

> **Preview.** Reflects `packages/mocactl` on `main` as of 2026-10-12. Install it with the
> [one-line installer](../get-started/index.md#1-install-the-cli); the narrative guide, key bindings and
> troubleshooting are in [`packages/mocactl/README.md`](../../packages/mocactl/README.md). `mocactl`
> talks to the multi-user control plane, which tells it where the harness is.

## Usage

```text
mocactl                      the interactive UI (needs a terminal)
mocactl <command> [flags]    a headless command
```

Run `mocactl --help` for the usage text. `--help` is not per command: `mocactl run --help` prints the
same global usage. `mocactl --version` prints a release tag, `edge-<sha>` or `dev`.

All flags are accepted by one parser. An unknown flag, or a missing flag value, prints the usage and
exits 2. Some flags are always rejected (exit 2) outside their command: `--consumer`, `--host` and
`--endpoint` outside `credentials add`; `--kind` outside `credentials add` and `spawn`; `--config`
outside `run` and `spawn`; `--repo` and `--ref` outside `spawn`; `--tag` outside `spawn` and
`subagents`; `--label` outside `spawn`; `--out` outside `get`; `--workload` outside `spawn`;
`--context` and `--name` outside `workloads create`; and `--all` outside `logout`. Other flags a
command does not use are not rejected and may be ignored.

## Endpoints

For both URLs the order is: flag, then environment variable, then `config.json`. Trailing slashes are
trimmed and blank values count as unset.

| URL           | Flag                  | Environment            | Config key        |
| ------------- | --------------------- | ---------------------- | ----------------- |
| Control plane | `--control-plane-url` | `SH_CONTROL_PLANE_URL` | `controlPlaneUrl` |
| Harness       | `--harness-url`       | `SH_HARNESS_URL`       | `harnessUrl`      |

With no harness URL, `mocactl` asks the control plane (`GET /v1/discovery`), which advertises the
`SH_PUBLIC_HARNESS_URL` its operator set. Every command that talks to the control plane exits 2 with
`missing control-plane URL` if none is set.

## Exit codes

| Code  | Meaning                                                                          |
| ----- | -------------------------------------------------------------------------------- |
| `0`   | It worked                                                                        |
| `1`   | It failed (the turn, or the control plane refused)                               |
| `2`   | Usage or setup problem: bad flags, not logged in, no destination for the turn    |
| `130` | Cancelled (Ctrl-C)                                                               |
| `3`   | `auth token`: login required. `promote`: a credential would reach a shared store |
| `4`   | `auth token`: the control plane is unreachable                                   |

Output convention: stdout carries only the result, and all messages go to stderr. Times in tables are
UTC. Most commands that need a login print ``not logged in — run `mocactl login` first`` and exit 2, with
exceptions: a login that cannot be refreshed prints `the login could not be refreshed — is the control plane
reachable?` instead; `auth token` exits 3 (login required) or 4; `logout` while logged out exits 0; and
`promote --dry-run` skips the check.

## Commands

| Command                                                                                                                           | What it does and calls                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mocactl [--setup] [--no-animation]`                                                                                              | The interactive UI. `--setup` re-runs onboarding. Exits 2 when stdin is not a terminal                                                                                                                                                                                      |
| `mocactl login`                                                                                                                   | GitHub device-flow login (`POST /v1/auth/device`, then polls `/v1/auth/device/token`). Prints the code to stderr                                                                                                                                                            |
| `mocactl logout [--all]`                                                                                                          | Ends this login on the server (`POST /v1/auth/revoke`); `--all` ends all of yours (`/v1/auth/revoke-all`). The local file is cleared anyway                                                                                                                                 |
| `mocactl auth token [--json]`                                                                                                     | Prints a valid API token for scripts, refreshing if needed. `--json`: `{"token","expiresAt","subject"}`                                                                                                                                                                     |
| `mocactl doctor [--json]`                                                                                                         | Seven ordered checks that stop at the first failure (below). Exit 1 if any fails                                                                                                                                                                                            |
| `mocactl run "prompt" [--session ID \| --new] [--option k=v ...] [--config DIGEST] [--json]`                                      | Runs a turn. Continues `--session`, or starts a new session (`--new`, the default)                                                                                                                                                                                          |
| `mocactl promote DIR [--dry-run] [--json]`                                                                                        | Builds a config bundle from `DIR/.claude` and uploads it (`POST /v1/config-bundles`). See [Promoting](../guides/promote-claude-workflow.md)                                                                                                                                 |
| `mocactl bundles delete DIGEST [--json]`                                                                                          | Deletes a bundle you promoted (`DELETE /v1/config-bundles/{digest}`). `DIGEST` must be `sha256:` plus 64 hex characters                                                                                                                                                     |
| `mocactl sessions [--json]`                                                                                                       | Lists every session you own (all pages of `GET /v1/sessions`)                                                                                                                                                                                                               |
| `mocactl sessions delete ID [--json]`                                                                                             | Deletes a session and its local transcript. `status` is `deleted`, or `accepted` when a turn was in flight                                                                                                                                                                  |
| `mocactl credentials [--json]`                                                                                                    | Lists names, kinds, consumers, hosts and endpoints; never secrets                                                                                                                                                                                                           |
| `printf %s "$KEY" \| mocactl credentials add NAME --host HOST [--host H ...] [--kind K] [--consumer C] [--endpoint URL] [--json]` | Stores a credential (`PUT /v1/credentials/{name}`). The secret is read from stdin and a terminal on stdin is refused                                                                                                                                                        |
| `mocactl credentials delete NAME [--json]`                                                                                        | Deletes a credential; exit 1 if you own none of that name                                                                                                                                                                                                                   |
| `mocactl spawn "prompt" [--config DIGEST] --kind prompt\|solve [--repo URL --ref REF] [--tag T] [--label L] [--json]`             | Creates a session, writes a ledger record, forks a detached worker that holds a `POST /v1/runs`. Prints the sessionId on stdout. `--label` names one dispatch within a `--tag` group (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`), surfaced on `mocactl subagents --json` as `label` |
| `mocactl subagents [--tag T] [--json]`                                                                                            | Lists spawned subagents from the ledger joined with `GET /runs/status`                                                                                                                                                                                                      |
| `mocactl get SESSIONID [--out DIR] [--json]`                                                                                      | Fetches a terminal result from `GET /runs/status` and writes `<sid>.text` / `<sid>.verdict.json` / `<sid>.patch`                                                                                                                                                            |
| `mocactl workloads create --context FILE [--name NAME] [--json]`                                                                  | `POST /workloads`, uploads `FILE` to the returned grant, then `POST /workloads/{id}/activate`. Prints the workload id                                                                                                                                                       |
| `mocactl workloads get ID [--json]`                                                                                               | Reads a workload (`GET /workloads/{id}`)                                                                                                                                                                                                                                    |
| `mocactl workloads delete ID [--json]`                                                                                            | Deletes a workload and its context (`DELETE /workloads/{id}`)                                                                                                                                                                                                               |

### `run`

- The prompt is the positionals joined with spaces. Exit 2 for an empty prompt, `--new` with
  `--session`, `--config` with `--session` (a session's bundle is fixed at creation), a blank
  `--config`, or an `--option` without `=`.
- `--option` keys: `inferenceCredential=NAME`, `model=ID` and `sandboxTier=NAME`. `model` is listed from the chosen credential's endpoint, with the deployment default as the first choice; `mocactl run` never asks: with none given, the session runs on the deployment default (only the TUI's New Session form asks, even for a single listed model, the deployment default preselected unless a model was used last); `model=` (empty) also means the deployment default; an id the catalog does not list exits 2 (`unknown model 'X'; declared: …`), including an id a LiteLLM wildcard route such as `anthropic/*` would accept, because `GET /v1/models` lists only concrete models (switch to such an id with `/model X` in the TUI); when the endpoint cannot list its models, the id is sent as given and checked by the gateway at the first turn. An ambiguous or unknown choice for
  `inferenceCredential` exits 2 with the declared values. With several `sandboxTier` choices and none given,
  the tier is left unset for the server default; a value for a field that has no choices exits 2. Unknown
  keys are silently ignored, and `=x` (no key) exits 2. `--option` is ignored when resuming a session.
- Text mode streams the reply to stdout, and reports a `workspace_reset` to stderr.
- `--json` emits NDJSON: a first line `{"type":"session","sessionId":...}`, then one raw
  [turn frame](http-api.md#streaming-frames) per line.

### `credentials add`

`--host` is required and repeatable (a comma list also works). Defaults: `--kind bearer`,
`--consumer inference`. `--endpoint` is for the `inference` consumer only. Everything except the secret
is validated before stdin is read.

| Kind           | stdin                                       |
| -------------- | ------------------------------------------- |
| `bearer`       | The token, one line                         |
| `api-key`      | The key, one line                           |
| `oauth2-token` | The access token, one line                  |
| `basic`        | `username=…` and `password=…`, one per line |

Consumers are `inference`, `sandbox-egress` and `control-plane`. `basic` is not for inference; use it
with `--consumer sandbox-egress`. For the `inference` consumer, Anthropic `sk-ant-oat…` OAuth tokens are
rejected, as is an `sk-ant-api…` key under a bearer kind (`bearer` or `oauth2-token`), and an
`api.anthropic.com` endpoint with a bearer kind is rejected before stdin is read.

### `spawn`, `subagents`, `get`

See [`packages/mocactl/README.md`](../../packages/mocactl/README.md) and
[`docs/specs/2026-10-12-mocactl-subagent-commands-design.md`](../specs/2026-10-12-mocactl-subagent-commands-design.md)
for behavior; this section covers only CLI-reference details.

- `spawn` exit 2: empty prompt, prompt over 64 KiB, bundle digest not matching `sha256:<64 lowercase
hex>`, `--kind` other than `prompt`/`solve`, `--kind solve` without both `--repo` and `--ref`, or
  `--repo`/`--ref` on `--kind prompt`, `--workload` without `--kind prompt`, a workload id that
  is not a lowercase Kubernetes name of at most 50 characters, or a `--label` outside
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- `spawn` on a sync 503 `saturated`: the worker retries up to 3 times honoring `Retry-After`,
  bounded by a 5-minute wall budget; after that the ledger row is `failed` with
  `stateDetail: 'saturated — exhausted retries'`.
- `get` exit 2: sessionId outside `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`. Exit 0 only on
  `responded`/`done`/`solved`; `queued`/`paused`/`failed` exit 1.
- `--json`:
  - `spawn` → `{"type":"session","sessionId","pid"}`.
  - `subagents` → `{"subagents":[{"sessionId","tag","label"?,"kind","state","detail","bundle","workload","writable"?,"submittedAt"}]}` (`label` and `writable` are present only on rows dispatched with them). The non-`--json` table columns are `SESSION TAG LABEL KIND STATE BUNDLE` (`-` on unlabeled rows).
  - `get` → `{"sessionId","status","files":[…],"reason"?,"message"?}`.

### `workloads`

See "Delegate with context" in [`packages/mocactl/README.md`](../../packages/mocactl/README.md) and
[`docs/context-service.md`](../context-service.md). The routes are on the harness and take the API
token. There is no list command: the harness has no list route.

- `create` exit 2: no `--context`, a missing, empty or non-regular file, or an invalid `--name`; all
  before any request. Exit 1 for a refusal, including a file larger than the grant's `maxBytes` or an
  upload URL that is neither HTTPS nor loopback HTTP; a workload created before the failure is deleted.
- `get`/`delete` exit 2 for an invalid id, exit 1 for `404 workload_not_found` or another refusal.
- `--json`:
  - `create` → `{"workloadId","status","contextType","revision","files","bytes"}`.
  - `get` → `{"workloadId","status","contextType","workspace","revision"}` (`null` when unset).
  - `delete` → `{"workloadId","status":"deleted"}`.

### `promote` exit codes

| Code | Cause                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | Success, or a dry run                                                                              |
| `1`  | No `.claude/skills` or `.claude/commands` under `DIR`; nothing to promote; bundle too large; other |
| `2`  | Wrong argument count; not logged in (not checked with `--dry-run`); preflight errors               |
| `3`  | A structural credential match; nothing was uploaded                                                |

`--json` prints the whole result: `{digest, configRoot, skills, dropped, prompts, report, warnings, uploaded}`,
plus `dryRun: true` for a dry run.
`~` is expanded in `DIR`.

### `doctor`

| #   | Check                             | Calls                                      |
| --- | --------------------------------- | ------------------------------------------ |
| 1   | Control plane reachable           | `GET /healthz`                             |
| 2   | Control plane ready               | `GET /readyz`                              |
| 3   | Logged in                         | `GET /v1/me`                               |
| 4   | Inference credential present      | `GET /v1/credentials`                      |
| 5   | Harness located                   | `GET /v1/discovery`, or the local override |
| 6   | Harness reachable                 | The harness `GET /health`                  |
| 7   | Harness trusts this control plane | See below                                  |

Check 7 is not read-only: it creates a scratch session, probes the harness with a mismatched session
id, and deletes the session. `--json` is an array of `{id,name,status,fix?,detail?}`.

## Environment and files

| Name                    | Use                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `XDG_CONFIG_HOME`       | Default `~/.config`. Holds `mocactl/config.json` and `auth.json` (tokens, mode 0600) |
| `XDG_STATE_HOME`        | Default `~/.local/state`. Holds `mocactl/transcripts/` and `mocactl/exports/`        |
| `NO_COLOR`              | Any non-empty value turns colour off                                                 |
| `VISUAL`, then `EDITOR` | External editor for `/editor` and `/export`; `vi` if neither is set                  |

`config.json` keys: `controlPlaneUrl`, `harnessUrl`, `theme` (`system` or `dark`), `details`,
`thinking`, `reducedMotion`, `bell`, `keybinds` (command id to chord), `presets`, `lastUsed`. A field of
the wrong type falls back to its default with a warning on stderr; unknown keys are preserved.

## Interactive slash commands and keys

The leader key is `ctrl+x`, followed by a letter. Override a binding in `config.json` under `keybinds`
using the command id.

| Command id          | Slash                              | Default key           |
| ------------------- | ---------------------------------- | --------------------- |
| `session.list`      | `/sessions`, `/resume`             | `ctrl+x l`            |
| `session.new`       | `/new`                             | `ctrl+x n`            |
| `session.promote`   | `/promote DIR`, `/promote --clear` | none                  |
| `session.rename`    | `/rename <title>`                  | `ctrl+x r`            |
| `session.model`     | `/model [id\|default]`             | `ctrl+x m`            |
| `credentials`       | `/credentials`                     | `ctrl+x k`            |
| `view.details`      | `/details`                         | `ctrl+x d`            |
| `view.thinking`     | `/thinking`                        | `ctrl+x t`            |
| `reply.copy`        | `/copy`                            | `ctrl+x y`            |
| `transcript.export` | `/export`                          | `ctrl+x x`            |
| `input.editor`      | `/editor`                          | `ctrl+x e`            |
| `view.theme`        | `/theme`                           | none                  |
| `doctor`            | `/doctor`                          | none                  |
| `help`              | `/help`                            | `?` on an empty input |
| `palette`           | none                               | `ctrl+p`              |
| `quit`              | `/quit`, `/exit`, `/q`             | `ctrl+x q`            |

`Esc` cancels the running turn (twice within a second also clears the queue); `Enter` sends;
`alt+enter` or `shift+enter` adds a newline; `ctrl+c` quits, asking first if a detachable turn would be
left behind. `/promote DIR` uploads the bundle and attaches it to the next session you create.

## Known gaps

- The keys inside the Sessions, Credentials and Palette overlays are not listed here.
- `packages/mocactl/README.md` states exit codes as `0, 1, 2, 130` for every command and documents
  `promote`'s exit 3, but not `auth token`'s exits 3 and 4 (only `auth token` uses 4).
