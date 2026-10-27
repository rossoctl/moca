# `mocactl` subagent commands — spawn, subagents, get

Status: Proposed — 2026-10-12
Issue: [#381](https://github.com/rossoctl/moca/issues/381)

## 1. Problem

`mocactl` today only drives `/v1/turn`: a prompt, streamed, foreground, one session at a
time. Fire-and-forget work that outlives the parent `mocactl` process has no client
surface, so demos and scripts need their own wrappers.

The sync leaf endpoints are already in place (`POST /v1/runs` +
`GET /runs/status`,
[`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md)),
and `/v1/runs` resolves `configRef` from the request body
([`2026-10-06-mocactl-config-bundle-promotion-design.md`](2026-10-06-mocactl-config-bundle-promotion-design.md)) —
so a client that wants its leaves to run under a promoted bundle must send `configRef`
on every envelope. What's missing is the client that builds the envelope, forks a worker
that survives its own exit, and later re-joins the result.

## 2. Decision — three commands, one transport, one ledger

The three commands and their flags are documented in
[`packages/mocactl/README.md`](../../packages/mocactl/README.md) and
[`docs/reference/cli-mocactl.md`](../reference/cli-mocactl.md); this section covers the
decisions behind them.

### 2.1 `mocactl spawn` — fork a detached leaf-turn worker

- `--config DIGEST` (not `--bundle`) matches the `mocactl run` vocabulary so the two
  commands share one flag name for the same digest.
- Flow: create session → append a `record` line to the ledger (§2.5) → fork a detached
  worker (§2.6) that holds the sync `POST /v1/runs`. The sessionId is printed on stdout
  once the worker has started, so a shell pipeline can capture it even if the worker
  exits immediately afterwards.
- The envelope carries `configRef` on every leaf: `/v1/runs` resolves the bundle from the
  body, not from the session record (§1).
- `--kind solve` requires `--repo` + `--ref` because the server's solve envelope requires
  `problemStatement` + `repoUrl` + `ref`. The user's text goes to `problemStatement`; the
  harness builds the agent's prompt itself. `--kind prompt` sends `env.prompt`.
- The 64 KiB prompt cap keeps a `record` ledger line within one atomic `write(2)` on a
  local filesystem (§2.5).
- `--prompt-file FILE` reads the prompt from a regular file (UTF-8, trimmed) instead of
  positional argv — mutually exclusive with an inline prompt, subject to the same 64 KiB
  cap. The envelope and ledger shape are unchanged. Motivation is operator-side: parent
  coding agents (Claude Code's Bash tool, in particular) run a static safety check that
  refuses argv containing `#`, `$(…)`, heredocs, or multi-line quoted content independent
  of the user's permission allow-list, so chained-subagent flows that inline a prior
  leaf's final message as the next prompt otherwise chain-break at the parent-agent layer
  ([#637](https://github.com/rossoctl/moca/issues/637)).
- `--label STRING` names one dispatch within a `--tag` group (e.g. `diagnose` / `fix`
  inside a parent agent's leaves). mocactl-local — never sent to the server — stored on
  the ledger record and surfaced on `mocactl subagents` as a `LABEL` column and on
  `--json` as `label` (on rows that have one). Alphabet is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`:
  stricter than `--tag` so a downstream `jq` filter by label value doesn't need
  shell-quote defensiveness.

### 2.2 `mocactl subagents` — join ledger with `/runs/status`

- Resolves the server's three-way `queued` (still running / never recorded / aged out)
  with child-pid liveness and a 60-second grace window (§2.7).
- Terminal rows are not re-queried: `/runs/status` has a 24-hour TTL, so a day after a
  run `queued` would otherwise regress a durable `done` row to `unknown`.

### 2.3 `mocactl get SESSIONID` — write terminal result files

- `paused` is terminal but exits `1`: the gate decision is still pending, so the caller
  should not treat the row as a finished result.
- `failed` echoes `status`/`reason`/`message` on stderr sanitized through the same filter
  the listing uses, since every string comes from the server.
- Patch output has its trailing newline normalized so `git apply` does not reject it.

### 2.4 Leaf-turn transport

A single module (`packages/mocactl/src/transport/leaf-turn.ts`) owns the `POST /v1/runs`
and `GET /runs/status` wire shapes and the honest-state mapping. The three commands
depend on this module, not on `fetch` directly, so a later async-turn transport
([`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md))
can replace the backend without touching the commands.

### 2.5 Subagent ledger

`$XDG_STATE_HOME/mocactl/subagents.jsonl`, mode 0600, append-only JSONL. Two line types
folded by sessionId on read: `record` (one per spawn, full dispatch envelope so a future
`approve`/`reject` can resend with a decision) and `update` (one per state change).

- **Atomicity without locks.** Each line is a single `O_APPEND` `write(2)` on a local
  filesystem; the 64 KiB prompt cap in §2.1 keeps every line within one syscall.
- **TOCTOU-free create.** `openSync` with `O_CREAT | O_NOFOLLOW` and the 0600 mode on
  the syscall itself; a symlinked state file ELOOPs.
- **Authoritative past terminal.** `/runs/status`'s 24-hour TTL would otherwise regress
  a durable `done` row to `unknown`, so §2.2 skips the re-query for terminal rows.

### 2.6 Detached-child mechanism

`child_process.spawn` with `detached: true` + `unref()`, re-execing `mocactl.mjs` into a
hidden `__spawn-worker` subcommand. Design choices:

- **Token on stdin, not argv/env.** Keeps it out of `ps` and `/proc/<pid>/environ`.
- **Endpoints forwarded on stdin.** The parent's resolved URLs (post-discovery when
  applicable) are the child's single source of truth, overriding anything the child's own
  env/config would otherwise wire up.
- **Fork completion awaited on `'spawn'`/`'error'`.** Without this, an async ENOENT /
  EACCES after `spawn()` returned would be reported as a successful spawn.
- **Every exit with a sessionId writes a terminal ledger line.** Malformed stdin (no
  sessionId) is the one exception; the parent's row stays authoritative there.
- **Bounded retry on 503 `saturated`.** The server's saturation handler calls out that
  _"a 503 is 'retry', not a terminal failure, and `/runs/status` must not report it as
  one"_ (`packages/knative-server/src/server.ts`), and runs its own in-band retry first.
  The worker then retries up to three times honoring `Retry-After` within a five-minute
  wall budget; on exhaustion the ledger row becomes `failed` with
  `stateDetail: 'saturated — exhausted retries'`.

### 2.7 Honest states

User-facing states: `running | done | paused | failed | unknown`. The mapping from
(server body, child liveness, grace) is in `transport/leaf-turn.ts`:

| Server                      | Child alive | Within grace | Honest state |
| --------------------------- | ----------- | ------------ | ------------ |
| `queued`                    | yes         | —            | `running`    |
| `queued`                    | no          | yes          | `running`    |
| `queued`                    | no          | no           | `unknown`    |
| `responded`/`done`/`solved` | —           | —            | `done`       |
| `paused`                    | —           | —            | `paused`     |
| `failed`                    | —           | —            | `failed`     |
| `aborted`                   | —           | —            | `failed`     |

The 60 s grace covers a just-exited child's result-write race; within it the row carries
a `child exited; waiting for result` detail. `/runs/status` returns `200 {status:
'queued'}` for a missing record, so there is no 404 row.

## 3. Error handling

See [`docs/reference/cli-mocactl.md`](../reference/cli-mocactl.md) for validation exit
codes. Behavioral notes:

- `createSession` failure: no ledger row written, exit `1`. Fork failure (sync throw or
  async `'error'`) after a successful `createSession`: ledger row marked `failed` with
  the fork error as `stateDetail`, exit `1`.
- Per-row `/runs/status` failure in `subagents` reports that row as `unknown` with the
  error as detail; other rows still render.
- Worker exits are covered under §2.6 (every exit with a sessionId writes a terminal
  ledger line; malformed stdin is the one exception).

## 4. Alternatives considered

- **SQLite ledger.** Rejected: adds a native dep, and the append-only JSONL atomicity
  model (one `O_APPEND` `write(2)` per line) is simpler to reason about on paper.
- **Parent process stays attached.** Rejected: the parent must be able to exit without
  killing its children, which is the whole point of the detached-worker shape.
- **Token via env or argv.** Rejected: argv leaks via `ps`; env leaks via
  `/proc/<pid>/environ`.
- **Trust `/runs/status` alone for state.** Rejected: §2.5 — a 24-hour TTL would
  silently regress `done` rows.
- **`--kind converge`.** The server's converge path takes a scanned `item`
  (file/pattern) and returns a verdict, with the agent prompt built from the item itself.
  This slice ships `prompt` and `solve`, which are the two kinds a user supplies with a
  single string of text; `converge` lands with a command that supplies the item.

## 5. Scope — explicitly not building

- `watch`, `approve`/`reject`, `follow-up` commands.
- Client-side concurrency cap on fan-out.
- `--workload <id>` for workload-context lane; this only carries `--config` (config
  bundles).
- A `converge` kind (see §4).
- Automatic ledger compaction. `compact` exists as a `tmp` + `rename` method on the
  ledger, but has no trigger; adding one needs real-world size data.
- Pid-reuse-safe liveness. `subagents` probes with `kill(pid, 0)`, which can read as
  alive if the OS has recycled a dead worker's pid. A pid+start-time pair, or a
  harness-side deadline on the status response, is the follow-up.
