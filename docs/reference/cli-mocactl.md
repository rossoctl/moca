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
same global usage. `mocactl --version` prints a release tag or `edge-<sha>`; run from a source checkout it prints
`dev-<sha>` (the checkout's commit, `-dirty` if tracked files differ from it), or `dev` where git can't say.

All flags are accepted by one parser. An unknown flag, or a missing flag value, prints the usage and
exits 2. Some flags are always rejected (exit 2) outside their command: `--consumer`, `--host` and
`--endpoint` outside `credentials add`; `--kind` outside `credentials add` and `spawn`; `--config`
outside `run` and `spawn`; `--repo` and `--ref` outside `spawn`; `--tag` outside `spawn` and
`subagents`; `--label` outside `spawn`; `--out` outside `get`; `--workload` outside `spawn`;
`--prompt-file` outside `spawn`; `--record` outside `run`;
`--context`, `--name`, `--sandboxes` and `--mount` outside `workloads create`; and `--all` outside `logout`. Other flags a
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

The cached login belongs to one control plane, and is matched by endpoint rather than by spelling:
host case, an explicit `:80`/`:443` and a trailing slash all name the same control plane, so moving
between the flag, the environment variable and `config.json` keeps you logged in. A different
scheme, host, port or **path prefix** is a different control plane — its login is not used, and the
message (and `mocactl doctor`) then names the control plane the login on this machine is for.

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

| Command                                                                                                                           | What it does and calls                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mocactl [--setup] [--no-animation]`                                                                                              | The interactive UI. `--setup` re-runs onboarding. Exits 2 when stdin is not a terminal                                                                                                                                                                                                                                                                                                                                   |
| `mocactl login`                                                                                                                   | GitHub device-flow login (`POST /v1/auth/device`, then polls `/v1/auth/device/token`). Prints the code to stderr                                                                                                                                                                                                                                                                                                         |
| `mocactl logout [--all]`                                                                                                          | Ends this login on the server (`POST /v1/auth/revoke`); `--all` ends all of yours (`/v1/auth/revoke-all`). The local file is cleared anyway                                                                                                                                                                                                                                                                              |
| `mocactl auth token [--json]`                                                                                                     | Prints a valid API token for scripts, refreshing if needed. `--json`: `{"token","expiresAt","subject"}`                                                                                                                                                                                                                                                                                                                  |
| `mocactl doctor [--json]`                                                                                                         | Seven ordered checks that stop at the first failure (below). Exit 1 if any fails                                                                                                                                                                                                                                                                                                                                         |
| `mocactl run "prompt" [--session ID \| --new] [--option k=v ...] [--config DIGEST] [--json] [--record F]`                         | Runs a turn. Continues `--session`, or starts a new session (`--new`, the default)                                                                                                                                                                                                                                                                                                                                       |
| `mocactl promote DIR [--dry-run] [--json]`                                                                                        | Builds a config bundle from `DIR/.claude` and uploads it (`POST /v1/config-bundles`). See [Promoting](../guides/promote-claude-workflow.md)                                                                                                                                                                                                                                                                              |
| `mocactl bundles list [--json]`                                                                                                   | Lists the bundles you own, newest first (`GET /v1/config-bundles`). See below                                                                                                                                                                                                                                                                                                                                            |
| `mocactl bundles delete DIGEST [--json]`                                                                                          | Deletes a bundle you promoted (`DELETE /v1/config-bundles/{digest}`). `DIGEST` must be `sha256:` plus 64 hex characters                                                                                                                                                                                                                                                                                                  |
| `mocactl sessions [--json]`                                                                                                       | Lists every session you own (all pages of `GET /v1/sessions`)                                                                                                                                                                                                                                                                                                                                                            |
| `mocactl sessions delete ID [--json]`                                                                                             | Deletes a session and its local transcript. `status` is `deleted`, or `accepted` when a turn was in flight                                                                                                                                                                                                                                                                                                               |
| `mocactl credentials [--json]`                                                                                                    | Lists names, kinds, consumers, hosts and endpoints; never secrets                                                                                                                                                                                                                                                                                                                                                        |
| `printf %s "$KEY" \| mocactl credentials add NAME --host HOST [--host H ...] [--kind K] [--consumer C] [--endpoint URL] [--json]` | Stores a credential (`PUT /v1/credentials/{name}`). The secret is read from stdin and a terminal on stdin is refused                                                                                                                                                                                                                                                                                                     |
| `mocactl credentials delete NAME [--json]`                                                                                        | Deletes a credential; exit 1 if you own none of that name                                                                                                                                                                                                                                                                                                                                                                |
| `mocactl spawn "prompt" [--config DIGEST] --kind prompt\|solve [--repo URL --ref REF] [--tag T] [--label L] [--json]`             | Creates a session, writes a ledger record, forks a detached worker that holds a `POST /v1/runs`. Prints the sessionId on stdout. `--label` names one dispatch within a `--tag` group (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`), surfaced on `mocactl subagents --json` as `label`. Pass `--prompt-file FILE` (regular file, no symlinks, UTF-8, trimmed) instead of an inline prompt when the content would be awkward on argv |
| `mocactl subagents [--tag T] [--json]`                                                                                            | Lists spawned subagents from the ledger joined with `GET /runs/status`                                                                                                                                                                                                                                                                                                                                                   |
| `mocactl get SESSIONID [--out DIR] [--json]`                                                                                      | Fetches a terminal result from `GET /runs/status` and writes `<sid>.text` / `<sid>.verdict.json` / `<sid>.patch`                                                                                                                                                                                                                                                                                                         |
| `mocactl workloads create --context FILE [--name NAME] [--sandboxes N [--mount read-only\|writable]] [--json]`                    | `POST /workloads` (with `sandboxes: {count: N}` and `workspace: {mount}` when given), uploads `FILE` to the returned grant, then `POST /workloads/{id}/activate`, and with `--sandboxes` waits until the workload is `ready`. Prints the workload id                                                                                                                                                                     |
| `mocactl workloads list [--json]`                                                                                                 | Lists your own live workloads, newest first (`GET /workloads`, following its cursor to the end). See [`workloads list`](#workloads-list)                                                                                                                                                                                                                                                                                 |
| `mocactl workloads get ID [--json]`                                                                                               | Reads a workload (`GET /workloads/{id}`)                                                                                                                                                                                                                                                                                                                                                                                 |
| `mocactl workloads delete ID [--json]`                                                                                            | Deletes a workload and its context (`DELETE /workloads/{id}`)                                                                                                                                                                                                                                                                                                                                                            |

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
- `--record F` appends one NDJSON line per HTTP attempt, to the control plane and to the harness
  (the login's refresh included), in the format below, with `command: "run"` and `endpoint`
  (`control-plane` or `harness`; `other` for a request under neither, its host unwritten). Kept:
  the path below that endpoint's base URL, the status, the session's id, model and times, the
  sandbox placement, `patchSha256` and `patchBytes`. Kept as their length: the prompt, the reply, a
  frame's text, the patch, a transcript, a message and other free text, a person's display name, a
  credential's hosts and endpoint. `--record` on any other top-level command exits 2.

### `--record F`

`mocactl run` and every `mocactl sbx` command that calls the API, except `sbx token`, `sbx login`,
`sbx logout` and `sbx credentials` (they handle a secret on purpose, and exit 2), take `--record F`.
It appends one JSON line per HTTP attempt to `F`:

| Field                                 | What it holds                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`, `invocation`               | The command (`run`, `sbx create`, …) and a UUID for this run of it                                                                                                                                                                                           |
| `seq`, `try`                          | The line's number in this invocation; 1, 2, … for the same method and path in a row (a retry)                                                                                                                                                                |
| `method`, `path`                      | The path relative to the endpoint's base URL, with its query; never the scheme or host                                                                                                                                                                       |
| `status` or `error`                   | The HTTP status, or a transport error's code or class (never its message)                                                                                                                                                                                    |
| `request`, `answer`                   | The JSON bodies, redacted (below); a body that is not JSON as its `length`                                                                                                                                                                                   |
| `requestAt`, `answerAt`, `retryAfter` | UTC times with milliseconds, and the `Retry-After` header when there is one                                                                                                                                                                                  |
| `stream`, `event: "stream_end"`       | A streamed answer (SSE or NDJSON) passes through live: its line has `stream: true` at the headers, and a `stream_end` line for the same `seq` gives `bytes`, `sha256`, `frames`, `endedAt`, and `error` or `closedBy: "reader"` when it did not end normally |

Never written: a token, a host or a URL. Token fields (`token`, `refreshToken`, `refresh_token`,
`sessionToken`, `apiToken`, `accessToken`), a gate record, a credential's `secret`, and any string
shaped like a JWT or a refresh token, under any field, are replaced by their `sha256:`; `execEndpoint`,
`execCa`, `harnessUrl`, a reason's `message`, a log, and any string that is an absolute URL by
`{"length": N}`. `F` is created `0600` and opened for appending; an existing `F` readable or
writable by anyone else, or not a regular file, exits 2 before any request. Each line is written
whole in one write; a line longer than `PIPE_BUF` takes a lock file `F.lock`, so several processes
can append to one record. `sbx run`, `put`, `push` and `pull` reach the sandbox over gRPC, which is
not recorded: the record holds their control-plane calls (the sandbox read, the token mint).
`sbx claude` and `sbx codex` record their own calls only, not those of the `mocactl sbx mcp`
server the agent starts.

### `workloads list`

Your own live workloads, newest first; nobody else's, and there is no route that lists another
user's ([#552](https://github.com/rossoctl/moca/issues/552)). Takes no id: finding one without
already holding its id is the point, so `workloads list ID` exits 2.

- A table of `WORKLOAD STATUS TYPE SIZE SANDBOXES CREATED REVISION`. `CREATED` is relative
  (`4m ago`), `REVISION` is the first 12 characters, and `-` means unset — `CREATED` is `-` for a
  workload created before the harness recorded the field, which is also absent from the listing
  (see "Upgrading" in [`../context-service.md`](../context-service.md)).
- `--json` prints one document, `{"workloads": [...]}`, with `null` for what a workload lacks and
  `createdAt` in ISO 8601.
- With no workloads it says `no workloads` on stderr and prints no table, so
  `mocactl workloads list | wc -l` counts workloads; `--json` prints `{"workloads": []}`.
- A `deleting` workload is listed, because it still holds a quota unit; a `deleted` one is not,
  though `workloads get` still reads it for a day.
- `SANDBOXES` can lag: the listing never settles a `provisioning` workload (so listing N makes no
  provisioner calls). `workloads get ID` settles one.

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
with `--consumer sandbox-egress`. For the `inference` consumer, an Anthropic `sk-ant-api…` key under
a bearer kind (`bearer` or `oauth2-token`) is rejected, as is an `api.anthropic.com` endpoint with a
bearer kind holding anything but an Anthropic OAuth token. A Claude Pro/Max `sk-ant-oat…` OAuth token
works with kind `oauth2-token` (or `bearer`) and endpoint `https://api.anthropic.com` — and only
there: aimed at a gateway it is rejected before the credential is sent. That check needs the secret,
so it runs after stdin is read.

A subscription OAuth token is a per-caller credential: it runs the session under the Claude Code
identity (the `claude-code-20250219` beta and its system prompt), and consumer tokens are meant for
Anthropic's own apps — storing one here is your call about your own account's terms. The deployment's
shared operator fallback refuses them for exactly that reason: one subscription must not serve every
caller.

### `spawn`, `subagents`, `get`

See [`packages/mocactl/README.md`](../../packages/mocactl/README.md) and
[`docs/specs/2026-10-12-mocactl-subagent-commands-design.md`](../specs/2026-10-12-mocactl-subagent-commands-design.md)
for behavior; this section covers only CLI-reference details.

- `spawn` exit 2: empty prompt, prompt over 64 KiB, bundle digest not matching `sha256:<64 lowercase
hex>`, `--kind` other than `prompt`/`solve`, `--kind solve` without both `--repo` and `--ref`, or
  `--repo`/`--ref` on `--kind prompt`, `--workload` without `--kind prompt`, a workload id that
  is not a lowercase Kubernetes name of at most 50 characters, a `--label` outside
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, or `--prompt-file` combined with an inline prompt, pointing at
  a missing/unreadable path, a symlink, a non-regular file (FIFO, socket, device, directory), a
  file over 64 KiB, or an empty/whitespace-only file.
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

- `create` exit 2: no `--context`, a missing, empty or non-regular file, an invalid `--name`, a
  `--sandboxes` that is not a whole number of at least 1, a `--mount` other than `read-only` or
  `writable`, or `--mount` without `--sandboxes`; all before any request.
- `create` exit 1 for a refusal, including a file larger than the grant's `maxBytes` or an upload
  URL that is neither HTTPS nor loopback HTTP; a workload created before the failure is deleted.
- `create --sandboxes`: activation answers `provisioning` while the workload's own sandboxes start;
  `create` polls `GET /workloads/{id}` every 2 s for up to 5 minutes. On `seed_bundle_missing` (the
  provisioner lost the bundle) it activates once more. Any other recorded `error`, the same error
  again, or the timeout exits 1 and deletes the workload.
- `get`/`delete` exit 2 for an invalid id, exit 1 for `404 workload_not_found` or another refusal.
- `delete` on a workload that is already deleted exits 0: the workload is gone, which is what was
  asked for, so a cleanup script can delete every id it knows without telling "already done" from a
  real failure ([#602](https://github.com/rossoctl/moca/issues/602)). Only `404
workload_already_deleted` is treated this way — `workload_not_found` still exits 1, because there
  the id may simply be wrong.
- `--json`:
  - `create` → `{"workloadId","status","contextType","revision","files","bytes"}`, plus
    `"sandboxes":{"count","tier","ready"}` and `"mount"` for a workload with sandboxes of its own.
  - `get` → `{"workloadId","status","contextType","workspace","revision","sandboxes"}` (`null` when
    unset; `workspace.mount` on a mounted workload), plus `"error"` while provisioning has failed.
    The table adds `SANDBOXES` (`ready/count`) and `MOUNT` columns.
  - `delete` → `{"workloadId","status":"deleted"}`, plus `"alreadyDeleted":true` when the workload
    was deleted before this call (absent otherwise, so the document reads the same either way).

### `bundles list`

Answers "which config bundles do I own?", so a digest lost between `promote` returning and whatever
stored it is recoverable instead of holding your byte budget until it expires.

- Only your own bundles. Another subject's is indistinguishable from one that does not exist, and an
  admin sees their own listing like anyone else — this is not an audit command.
- Takes no `DIGEST` (exit 2 if given): finding one is the point.
- Newest first, by when it was promoted. A bundle from before the control plane recorded that time
  prints `-` and sorts last.
- Columns `DIGEST BYTES PROMOTED (UTC) EXPIRES (UTC)`. The digest is printed in full because
  `bundles delete` takes exactly that string.
- `BYTES` is what the bundle is **charged**, not the size of your directory: the compressed upload,
  or a 4 KiB minimum if it is smaller.
- `EXPIRES` moves: each session that uses a bundle extends its 30-day life. `PROMOTED` does not.
- With no bundles, stdout stays empty — the message goes to stderr — so `| wc -l` answers 0.
  `--json` prints `{"bundles":[]}`.
- One unpaged response. No cursor: the index is ordered by expiry, which a concurrent use can move,
  so a cursor could skip or repeat a bundle. Your 16 MiB subject budget bounds the count.
- A bundle promoted by the harness's own `promote` tool writes storage directly and keeps no budget
  entry, so it does not appear here (the same population only an admin can delete).
- A charge whose stored bytes were already reaped is still listed: that charge is exactly what you
  need `bundles delete` for.
- `--json` → `{"bundles":[{"digest","bytes","promotedAt","expiresAt"}]}`, epoch milliseconds,
  `promotedAt` `null` when unrecorded. Exit 1 if the control plane refuses, 2 if not logged in.

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
