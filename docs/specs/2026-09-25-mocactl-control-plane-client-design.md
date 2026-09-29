# `mocactl` — A Terminal Client for the MU1 Control Plane — Design

Version: 1.2 — September 26, 2026 (v1.1: a UX/extensibility review; v1.2: one URL — see §0)
Status: Proposed
Naming: MOCA is the new name of moca, so the client is `mocactl` (it was drafted as `sh-tui`).
Scope: A new, standalone terminal UI — `packages/mocactl` (`@moca/mocactl`), binary `mocactl` — that logs a user
in against the MU1 control plane, lets them manage their own sessions and inference credentials, and
drives interactive turns against the harness over SSE. It talks **exclusively** over the `/v1` HTTP
contract already shipped in `packages/control-plane` and `packages/knative-server`, plus **one small
backend addition** (v1.2): a public `GET /v1/discovery` on the control plane that says where the
harness is, so a user configures one URL. UX is modeled on OpenCode's TUI conventions: one
persistent chat view, secondary functions as dismissable overlays, a leader-key + slash-command +
fuzzy-palette input model, per-tool rich rendering, and a themeable color-token layer.
Milestone: unassigned — see §13.
Builds on (reuse, no redesign): [MU1](2026-09-08-multi-user-control-plane-design.md)'s `/v1` API
surface and its [OpenAPI contract](../api/openapi.yaml); the SSE turn-stream design
([turn-sse-streaming](2026-08-26-turn-sse-streaming-design.md)); the substrate-agnosticism established
by [P6](2026-09-08-p6-vm-process-manager-design.md) — the harness's request `handler` is exported once
and reused, byte-identical, whether fronted by Knative or by the VM/supervisor path;
[RA1](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) for naming context only.
Decision record: [ADR-0036](../adrs/0036-tui-decoupled-http-client.md).

> **The one-sentence thesis.** Everything this TUI needs already exists over HTTP — login, owned
> sessions, credential management, streaming turns — so the whole of this design is a terminal
> client and nothing else: one discovery route as the only backend change, zero runtime dependency on
> any `@moca/*` package, zero assumption about what runs behind the one URL it is given, and a first
> streamed token within a minute of first launch.

---

## 0. Revisions — what changed and why

**Revision 1.2 — one URL.** Two URLs for one service was the setup step users found confusing. The
control plane now advertises the harness's client-facing base URL at a public
`GET /v1/discovery` → `{ "harnessUrl": string | null }`, set by the operator with
`SH_PUBLIC_HARNESS_URL` (validated at startup). `mocactl` asks for one URL — the control plane's
(§3.2) — and finds the harness through it on first use. `--harness-url` / `SH_HARNESS_URL` remain as
a local override, which is never persisted by onboarding and which disables discovery. A 404 (a
control plane that predates the route) and `null` (one whose operator set nothing) fail with
different one-line fixes; the advertised value is used only as the URL parser serialises it. Doctor
gains a "harness located" check (§6.9). Discovery is also the seam for P6 fan-out: the same
answer can later come back per session.

**Revision 1.1.**

A review of v1.0 against the code found one gap that would have made the client feel broken, one
claim that was wrong, and a set of UX and extensibility improvements. All are incorporated:

- **Resume would have shown an empty screen.** No route anywhere returns a session's messages
  (verified against `packages/control-plane/src/routes.ts` and `packages/knative-server/src/server.ts`).
  Fixed client-side with a local transcript store (§6.6); the server endpoint becomes the top backend
  follow-up (§13).
- **§10's "cannot detect a harness without auth" was wrong.** A harness missing
  `SH_SESSION_TOKEN_PUBLIC_KEYS` rejects a freshly minted token with `token_invalid`, which _is_
  distinguishable from an expired login. v1.0 would have looped the user through re-login forever;
  §8.2 and `mocactl doctor` (§6.9) now diagnose it.
- **Concurrent turns on one session are not serialized by the server** (`harness/src/run-turn.ts`
  documents N concurrent turns of one session). The client enforces one in-flight turn per session and
  queues the rest (§6.1).
- Added: session titles (§6.2), first-run onboarding (§6.8), `doctor` (§6.9), per-tool rich rendering
  (§5.5), markdown and syntax highlighting (§5.6), latency and backpressure feedback (§5.7), usage
  accounting (§5.8), input ergonomics (§6.1), a native-looking default theme and accessibility (§5.4),
  `<Static>`-based rendering for long transcripts (§6.1), a data-driven command registry (§7.1),
  renderer registries with forward-compatible fallbacks (§7.2), schema-driven session options
  replacing the fixed profile type (§7.3), a contract-drift test (§7.4), and a non-interactive mode
  (§7.5).
- Fixed an editing artifact in §3.2's cross-reference.

---

## 1. Goal & scope

### Goal

Give a user a fast, OpenCode-quality terminal experience for the harness: log in once, create or
resume sessions with their history intact, watch turns stream live with readable tool activity, and
manage the named inference credentials a session runs on — without ever touching `kubectl`, a YAML
manifest, or a `curl` command. **Success is measurable**: a new user with one URL reaches their first
streamed token in under a minute, and every setup failure ends in a one-line instruction rather than
an opaque error.

### In scope

- GitHub OAuth **device-flow login**, with local caching of the API token (§4).
- **Guided first run** and a **`doctor`** command that turns every setup failure into a fix (§6.8, §6.9).
- **Session lifecycle** — list (with titles), create, resume (with history), rename, delete (§6.2–§6.3, §6.6).
- **Interactive turns** over SSE with per-tool rich rendering, markdown, syntax highlighting, live
  latency, and usage accounting (§5, §6.1).
- **Credential management** — list/add/delete named inference credentials (§6.4).
- **Extensibility seams**: a command registry, renderer registries, schema-driven session options, a
  contract-drift test, and a non-interactive mode on the same API layer (§7).
- OpenCode-inspired interaction model and theming (§5).

### Out of scope (deliberately — see §11 for the reasoning)

- **Any backend change.** If a future need requires a new field on `/v1/sessions` or `/turn`, or a new
  route, that is a separate spec; this one documents the seams that will receive it (§7) and lists the
  owed backend work (§13).
- **Per-session model selection.** `SH_MODEL`/`SH_MODEL_API` are deployment-time env vars on the
  harness process ([multi-protocol-model-provider](2026-08-20-multi-protocol-model-provider-design.md)).
- **Per-session sandbox pool / resource / tool-set selection.** MU1 §8.2: `/turn` "does not lease from
  the pool at all." CPU/memory and installed tools are pod-spec / image concerns with no HTTP surface.
- **Unauthenticated / ambient mode.** `harness/src/cli.ts` and the unauthenticated deploy scripts
  remain the no-auth path.
- **A user-authored theme-file loader.** Tokens plus two shipped themes; the file format is later (§5.4).
- **Anything that assumes a local working tree**: `@`-file fuzzy search, `!`-shell passthrough,
  git-backed undo/redo. This client has no local project context; its sandbox is remote and is reached
  only through the harness's own tool loop, which the transcript renders.

---

## 2. Current state — what already exists and where this client anchors to it

### 2.1 The control plane is implemented and merged

`POST /v1/auth/device`, `POST /v1/auth/device/token`, `GET /v1/me`, `POST|GET /v1/sessions`,
`GET|DELETE /v1/sessions/{id}`, `GET /v1/sessions/{id}/resources`, `POST /v1/sessions/{id}/token`,
`GET /v1/credentials`, `PUT|DELETE /v1/credentials/{name}` are live, pinned by `docs/api/openapi.yaml`
and `packages/control-plane/test/openapi-contract.test.ts`. There is **no** route returning a
session's messages — the reason §6.6 exists.

### 2.2 Two services, two token kinds

The control plane and the harness are separate deployables, and the SSE stream never passes through
the control plane (MU1 §5.3.1).

|           | Control plane                                               | Harness (data plane)                                                    |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Routes    | `/v1/auth/*`, `/v1/me`, `/v1/sessions*`, `/v1/credentials*` | `POST /v1/turn` (alias `/turn`)                                         |
| Token     | **API token** — `scope:["api"]`, 1 hour, no refresh         | **Session token** — `scope:["turn:write"]` + `sid`, 5 minutes           |
| Minted by | `POST /v1/auth/device/token`                                | `POST /v1/sessions` (create) or `POST /v1/sessions/{id}/token` (remint) |

### 2.3 Turn streaming exists, with a fixed frame vocabulary

`harness/src/turn-stream.ts`'s `TurnStreamFrame` — `text` / `thinking` / `tool_use` / `tool_result` /
`done` / `error` — is what `POST /turn` emits under `Accept: text/event-stream`. `tool_use` carries
the tool `name` and its `args` **verbatim**; `tool_result` carries `isError` and a server-truncated
`preview` (`SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES`, default 2048). `done`/`error` carry `usage`
(`input`, `output`, `cacheRead`, `cacheWrite`, `total`). A heartbeat comment
(`SH_TURN_STREAM_KEEPALIVE_MS`, default 20000) keeps idle connections alive.

### 2.4 The tool set, and why rich rendering is possible

Pi's coding tools (`pi-fork/packages/coding-agent/src/core/tools/`) have stable argument shapes, which
arrive verbatim in `tool_use.args`:

| Tool                 | Args                                      |
| -------------------- | ----------------------------------------- |
| `bash`               | `{ command, timeout? }`                   |
| `read`               | `{ path, offset?, limit? }`               |
| `edit`               | `{ path, edits: [{ oldText, newText }] }` |
| `write`              | `{ path, content }`                       |
| `grep`, `find`, `ls` | search/list parameters                    |

`edit` carries both sides of every change, so a diff is renderable entirely client-side (§5.5).

### 2.5 The credential kind registry is real but not queryable

`packages/control-plane/src/credential-store.ts` defines four kinds — `bearer` (`token`), `basic`
(`username`+`password`), `api-key` (`key`), `oauth2-token` (`accessToken`) — in an extensible
in-process registry with no listing endpoint. A `PUT` with the wrong secret fields fails `400` with a
message naming the required fields. An `inference` credential must use a single-secret-field kind.

### 2.6 Concurrent turns on one session are not serialized

The server accepts, and `harness/src/run-turn.ts` explicitly accounts for, N concurrent turns of one
session. Nothing orders them. For an interactive user, two interleaved turns on one conversation are a
bug, not a feature — so ordering is the client's job (§6.1).

### 2.7 The substrate behind either URL is none of this client's business

`packages/knative-server/src/server.ts` exports `handler`, and P6's `packages/supervisor` reuses it as
its worker entry point ("Knative request handling is byte-identical", P6 spec). The supervisor holds
no HTTP or auth logic. So `/turn`'s auth path does not fork between Knative and P6.

**One currently-true gap:** `deploy/vm/env/supervisor.env.example` sets none of `SH_REQUIRE_AUTH`,
`SH_CONTROL_PLANE_URL`, `SH_EXCHANGE_TOKEN`, or `SH_SESSION_TOKEN_PUBLIC_KEYS`, matching the P6 spec's
scope note that its experiments ran without the control plane. A P6/VM harness without those rejects
this client's tokens. That is an operator prerequisite (§12) — but unlike v1.0 claimed, the client
**can** detect it and say so precisely (§8.2, §6.9).

---

## 3. Architecture

### 3.1 Package

```
packages/mocactl/                        @moca/mocactl, binary `mocactl`
  src/
    cli.ts                           entrypoint: interactive (default), `run`, `doctor`
    config.ts                        XDG paths, config + auth cache
    api/
      control-plane.ts               typed client for /v1/auth, /v1/me, /v1/sessions, /v1/credentials
      harness.ts                     typed client for POST /turn (sync + SSE)
      sse-parser.ts                  text/event-stream -> frames, chunk-boundary safe
      errors.ts                      error type + the taxonomy in §8
    core/                            UI-free: shared by the TUI, `run`, and `doctor`
      session-manager.ts             token lifecycle, remint, one-in-flight queue (§4, §6.1)
      transcripts.ts                 local transcript store (§6.6)
      session-options.ts             schema-driven creation options (§7.3)
      diagnostics.ts                 the doctor checks (§6.9)
    commands/
      registry.ts                    the command table (§7.1)
      builtin.ts                     built-in command entries
    render/
      frames.ts                      frame-renderer registry (§7.2)
      tools/                         per-tool renderers: bash, read, edit, write, generic (§5.5)
      markdown.ts                    markdown + syntax highlighting (§5.6)
    theme/
      tokens.ts                      ThemeTokens type
      system.ts, dark.ts             shipped themes (§5.4)
    views/
      Chat.tsx                       the persistent home view
      overlays/                      Sessions, Credentials, Login, NewSession, Onboarding, Palette, Help
      StatusLine.tsx
    app.tsx                          overlay stack + input dispatch
  test/                              mirrors src/, vitest
```

**Hard constraint, checkable rather than assumed:** `packages/mocactl/package.json` declares **no**
`workspace:*` dependency. It imports nothing from `@moca/harness`, `@moca/control-plane`,
`@moca/session-backend`, or `@moca/k8s-sandbox`. Frame and API types are redeclared locally and held
honest by the contract test (§7.4), not by sharing a module.

**Layering rule:** `api/` and `core/` never import from `views/`, `render/`, or `ink`. That is what lets
`run` and `doctor` (§7.5, §6.9) reuse the whole session/auth/transcript stack with no terminal UI.

### 3.2 Configuration

One URL, generically named — nothing names Knative or Kubernetes, per §2.7. The control plane is
the only address a user gives; it says where the harness is (`GET /v1/discovery`, v1.2):

| Flag                  | Env                    | Meaning                                                    |
| --------------------- | ---------------------- | ---------------------------------------------------------- |
| `--control-plane-url` | `SH_CONTROL_PLANE_URL` | the server: auth, sessions, credentials, and discovery     |
| `--harness-url`       | `SH_HARNESS_URL`       | optional override of the discovered harness (`POST /turn`) |

Precedence: flag > env > `config.json` (§6.7). A discovered harness URL is never written to
`config.json`, so a harness the operator moves is followed on the next launch. Onboarding (§6.8) writes `config.json` on first run, so
day-to-day invocation is plain `mocactl`.

---

## 4. Auth flow

1. **No cached API token, or a control-plane call returns `token_required` / `token_invalid` /
   `token_expired`**: open the Login overlay. `POST /v1/auth/device` returns a user code and
   verification URL, rendered large, with `c` to copy the code and `o` to open the URL in the browser
   where the platform allows. Poll `POST /v1/auth/device/token` at the server's `interval`; `428
authorization_pending` means keep polling; show the remaining `expiresIn` as a countdown.
2. On success, cache `{ apiToken, subject, displayName, roles, expiresAt }` (§6.7) and return to where
   the user was.
3. **Resuming** mints a session token via `POST /v1/sessions/{id}/token`; **creating** gets one
   directly from `POST /v1/sessions`.
4. Before every turn, remint if the session token is within a safety margin of `expiresAt`. Invisible
   in normal use.
5. When the API token nears expiry (1h, no refresh), the status line shows a subtle "login expires in
   Nm" in the last five minutes, so re-login is never a surprise mid-task. Expiry only blocks
   control-plane calls; an in-flight turn is unaffected.
6. Changing `controlPlaneUrl` clears the cached token — never send one control plane's token to another.

A `token_invalid` returned by the **harness** is not handled here; see §8.2.

---

## 5. UX — modeled on OpenCode's TUI

Drawn from `opencode.ai/docs/tui/` and `opencode.ai/docs/themes/`. What is not mirrored is listed in §1.

### 5.1 One persistent view, overlays for everything else

Chat is home. Sessions, Credentials, Login, New Session, Help, and the palette are overlays that
render over Chat and dismiss back into it with `Esc`. No full-screen navigation.

### 5.2 Three paths to every command

Typed as `/command`, a leader-key chord (`ctrl+x` then a mnemonic), or the fuzzy palette (`ctrl+p`).
All three are generated from one command table (§7.1), so they cannot drift.

| Command                 | Keybind           | Action                                                     |
| ----------------------- | ----------------- | ---------------------------------------------------------- |
| `/sessions` (`/resume`) | `ctrl+x l`        | Sessions overlay                                           |
| `/new`                  | `ctrl+x n`        | new session (§6.3)                                         |
| `/rename <title>`       | `ctrl+x r`        | rename the current session (§6.2)                          |
| `/credentials`          | `ctrl+x k`        | Credentials overlay                                        |
| `/details`              | `ctrl+x d`        | toggle collapsed vs. full tool rendering                   |
| `/thinking`             | `ctrl+x t`        | toggle whether `thinking` frames render                    |
| `/copy`                 | `ctrl+x y`        | copy the last assistant reply to the clipboard             |
| `/export`               | `ctrl+x x`        | export the transcript to Markdown and open it in `$EDITOR` |
| `/editor`               | `ctrl+x e`        | compose the next prompt in `$EDITOR`                       |
| `/theme`                | —                 | switch between shipped themes                              |
| `/doctor`               | —                 | run the diagnostics of §6.9 in an overlay                  |
| `/help`                 | `?` (empty input) | all commands and keybinds, generated from the registry     |
| `/quit`                 | `ctrl+x q`        | exit                                                       |

`/login` is not user-invoked; it opens on demand (§4).

### 5.3 Two toggles over the frame vocabulary

`/details` and `/thinking` are exactly the two rendering choices §2.3's vocabulary needs, exposed as
toggles the way OpenCode exposes them. Both persist in `config.json`.

### 5.4 Theming, native by default

Every color in `views/` and `render/` goes through one `ThemeTokens` type: `primary`, `accent`,
`text`, `muted`, `border`, `error`, `warning`, `success`, `info`, `diffAdd`, `diffRemove`, plus syntax
slots. No component uses a literal color.

Two shipped themes:

- **`system` (default)** — maps tokens onto the terminal's own ANSI palette (colors 0–15) and uses the
  terminal's default foreground and background, like OpenCode's `system` theme. It looks native in
  light and dark terminals with no detection logic.
- **`dark`** — a fixed truecolor palette for users who want OpenCode's look.

Accessibility: honour `NO_COLOR` (tokens collapse to bold/dim/underline only); `--no-animation` (or
`reducedMotion` in config) replaces spinners with static indicators; below 60 columns the status line
collapses to its essential field and tool lines truncate rather than wrap.

### 5.5 Per-tool rich rendering

A `tool_use` + `tool_result` pair renders as one block, dispatched by tool name through the tool
renderer registry (§7.2):

| Tool               | Collapsed (default)               | Expanded (`/details`)                                         |
| ------------------ | --------------------------------- | ------------------------------------------------------------- |
| `bash`             | `$ <command>` + exit status       | + the result preview                                          |
| `read`             | `read <path>` (+ `:offset-limit`) | + preview                                                     |
| `edit`             | `edit <path>` · `+N −M`           | colored unified diff built from each `oldText`/`newText` pair |
| `write`            | `write <path>` · N lines          | + head of `content`                                           |
| `grep`/`find`/`ls` | one line with the query           | + preview                                                     |
| anything else      | `name(args…)` truncated           | pretty-printed JSON args + preview                            |

A block shows a spinner while running, then turns into a success mark or, if `isError`, an error mark
in the error color. The `edit` diff is the single highest-value rendering — it is what makes the agent's
work reviewable at a glance — and it is buildable purely from arguments already on the wire.

### 5.6 Markdown and syntax highlighting

Assistant text is rendered as Markdown (headings, emphasis, lists, block quotes, links, inline code)
with fenced code blocks syntax-highlighted using the theme's syntax tokens. To avoid mid-token reflow,
the **streaming** message renders as lightly-styled plain text; on `done` it is re-rendered once as full
Markdown and moved into the static region (§6.1). Library choice (`marked` + a terminal renderer,
`cli-highlight`) is an implementation detail behind `render/markdown.ts`.

### 5.7 Latency and backpressure are always visible

Silence reads as a hang, especially on a Knative cold start. While a turn is in flight the status line
shows an elapsed timer, and before the first frame a "waiting for harness… 3.2s" indicator. After the
turn it records time-to-first-token. A `503` with `Retry-After` shows a countdown — "no capacity —
retrying in 4s" — and retries automatically, cancellable with `Esc`.

### 5.8 Usage accounting

The status line shows the last turn's `input`/`output` tokens and a running session total, with cache
reads shown when non-zero. Totals are persisted with the local transcript (§6.6), so they survive a
resume on the same machine. No cost is computed — the client does not know model pricing.

### 5.9 Status line

`subject · session title · turn state (idle / waiting 3.2s / streaming 12s / queued: 1) · usage ·
login-expiry warning when relevant`. Degrades by dropping fields right to left on narrow terminals.

---

## 6. Views and flows

### 6.1 Chat (home view)

Transcript + input box + status line. Frame mapping:

- `text` — appended live to the current assistant message (plain styling while streaming, §5.6).
- `thinking` — dim/italic above the answer, subject to `/thinking`.
- `tool_use` / `tool_result` — one block per call via §5.5.
- `done` — finalize, full Markdown render, update usage, re-enable input, dequeue the next message.
- `error` — inline banner; a pre-first-frame HTTP error and a mid-stream `error` frame render
  distinctly, and both keep any partial text already shown.
- unknown frame types — the generic fallback renderer (§7.2), never dropped or fatal.

**One turn in flight per session.** `core/session-manager.ts` owns a per-session queue. Submitting
while a turn is streaming appends to the queue; queued messages show in the transcript as "queued" and
the status line counts them; each is sent on the previous turn's terminal frame. `Esc` cancels the
current turn; `Esc` again (within a second) also clears the queue.

**Sending**: remint if needed (§4) → `POST /turn`, `Accept: text/event-stream`, session token as
`Bearer`. `api/sse-parser.ts` is a small hand-rolled parser: split on blank lines, parse `event:` /
`data:`, ignore `:` comments, and buffer across chunk boundaries — a frame is not guaranteed to arrive
in one read.

**Canceling**: `Esc` aborts via `AbortController`; the server treats a dropped connection as abort
(`res.on('close')` → `session.abort()`).

**Input ergonomics**: `Enter` sends; `shift+enter` (or `alt+enter` where the terminal cannot report
shift) inserts a newline; `↑`/`↓` on an empty input walks this session's prompt history; `/editor`
composes in `$EDITOR`; pasting a multi-line block inserts it as a single input.

**Rendering performance**: finalized messages live in Ink's `<Static>` region and are never
re-rendered; only the in-flight message and the input are dynamic. `text` deltas are coalesced on a
~30–50 ms timer. Together these keep a long transcript as smooth as a short one — without them, every
token re-renders the whole history.

### 6.2 Sessions overlay

`GET /v1/sessions` (paged, newest first), fuzzy-filterable as you type. Each row: **title**, relative
`lastTurnAt` ("3h ago"), turn count, and a marker when the transcript is local (resumable with history).

**Titles** are client-side: the first prompt of a session, trimmed to ~50 characters on a word
boundary, stored in its local transcript (§6.6). `/rename` overrides it. A session with no local
transcript shows its creation time plus a short id prefix. When the server grows a title field (§13),
the server value wins.

Keys: `Enter` resume, `r` rename, `d` delete with confirmation (`202` in-flight / `204` idle; both
dismiss), `n` new, `/` focus filter.

### 6.3 New session

Built from the session-options schema (§7.3), so today it asks only for an inference credential:

- **Zero** inference credentials → route to the Credentials overlay's add form with "add an inference
  credential to start".
- **One** → selected silently; creation takes a single keypress.
- **Several** → a picker, defaulting to the last one used, pre-empting `credential_ambiguous`.

Saved presets (§7.3) skip the form entirely.

### 6.4 Credentials overlay

`GET /v1/credentials` (metadata only). Add form: name (validated against the server's pattern), kind
(suggesting the four known kinds; default `bearer`), consumer (default `inference`), destination hosts,
endpoint (shown for `inference`), then secret fields — labeled for known kinds, a generic key/value
editor otherwise. Secret inputs are masked. When consumer is `inference` and the kind has more than one
secret field, the form refuses locally with the same rule the server enforces (§2.5), rather than
round-tripping. Any server `400` is shown verbatim, anchored to the form. Delete confirms, then
`DELETE` (always `204`).

### 6.5 Login overlay

§4, step 1. On success it closes itself and replays whatever action triggered it.

### 6.6 Local transcripts — resume with history

The server stores the conversation but exposes no way to read it (§2.1). The client therefore keeps
its own copy:

- `$XDG_STATE_HOME/mocactl/transcripts/<sessionId>.jsonl` (fallback `~/.local/state/mocactl/…`), one
  record per user prompt and per received frame, appended as they arrive, plus a small header record
  `{ title, createdAt, controlPlaneUrl, subject, usageTotals }`.
- Files are mode `0600`, and a transcript is only loaded when its `subject` and `controlPlaneUrl`
  match the current login — a shared machine never shows one user another user's history.
- Resuming a session with a local transcript replays it into the static region instantly, then
  continues live. Resuming one without — started on another machine — shows a single dim line, "history
  for this session isn't available on this device", and continues normally: the model still has its
  full context server-side; only the display is missing.
- Deleting a session deletes its transcript. `mocactl` never uploads a transcript anywhere.

This is deliberately a display cache, not a source of truth: when `GET /v1/sessions/{id}/messages`
exists (§13), the transcript store becomes a fast-path cache in front of it and the "not available"
case disappears.

### 6.7 Local state

- `$XDG_CONFIG_HOME/mocactl/config.json` — `{ controlPlaneUrl, harnessUrl, theme, details, thinking,
reducedMotion, keybinds, presets }`.
- `$XDG_CONFIG_HOME/mocactl/auth.json`, mode `0600` — `{ apiToken, subject, displayName, roles,
expiresAt }`. The only secret-shaped data stored, and a 1-hour capability, never a provider key.
- `$XDG_STATE_HOME/mocactl/transcripts/` — §6.6.

### 6.8 First run — guided onboarding

When no `config.json` exists, `mocactl` opens an onboarding overlay rather than an error:

1. **Server** — ask for the one server (control-plane) URL (prefilled from env if set); probe
   `GET /healthz` on it and, through discovery (or an existing override), the harness's health route,
   with a one-line reason for each failure. Discovery is public, so this runs before login.
2. **Login** — the device flow (§4).
3. **Credential** — if `GET /v1/credentials` has no inference credential, the add form (§6.4), with
   copy explaining what an inference credential is and where its endpoint comes from.
4. **First session** — create it and land in Chat with the input focused, and a hint line: "type a
   message · ctrl+p for commands · ? for help".

Each step is skippable when already satisfied, so re-running onboarding (`mocactl --setup`) on a
configured machine just confirms state. Target: first streamed token in under a minute.

### 6.9 `mocactl doctor`

A command (and `/doctor` overlay) that runs checks **in dependency order** and stops explaining at the
first failure, each with a single fix line:

| #   | Check                                                                                  | Failure message (abridged)                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | control plane reachable (`/healthz`)                                                   | "cannot reach control plane at URL — check `--control-plane-url`"                                                                                          |
| 2   | control plane ready (`/readyz`)                                                        | "control plane is up but its session store is down"                                                                                                        |
| 3   | logged in (`GET /v1/me`)                                                               | "not logged in — run `mocactl` to log in"                                                                                                                  |
| 4   | inference credential present                                                           | "no inference credential — add one with /credentials"                                                                                                      |
| 5   | harness located (`GET /v1/discovery`, or the local override)                           | "the control plane advertises no harness URL — its operator must set `SH_PUBLIC_HARNESS_URL`, or pass `--harness-url`"                                     |
| 6   | harness reachable (health route)                                                       | "cannot reach harness at URL — check `SH_PUBLIC_HARNESS_URL` on the control plane" (or `--harness-url` when overridden)                                    |
| 7   | harness accepts a freshly minted session token (a scratch session, deleted afterwards) | "harness does not trust this control plane's tokens — the harness needs `SH_SESSION_TOKEN_PUBLIC_KEYS` (and, on the VM path, the other MU1 auth settings)" |

Check 7 is what turns §2.7's P6 gap from a silent login loop into a precise operator instruction.
`doctor` exits non-zero on failure and supports `--json`, so it doubles as a scripted health gate.

---

## 7. Extensibility seams

### 7.1 A data-driven command registry

Every command is one entry:

```ts
interface Command {
  id: string; // 'session.new'
  title: string; // palette + help text
  slash?: string[]; // ['new']
  keybind?: string; // 'ctrl+x n'
  when?: (ctx: AppContext) => boolean; // e.g. only with an active session
  run: (ctx: AppContext, arg?: string) => void | Promise<void>;
}
```

Slash parsing, leader-key dispatch, the palette, and `/help` are all derived from this table, so they
cannot disagree. User keybinding overrides in `config.json` are merged over defaults (OpenCode's
behaviour — custom binds extend, not replace), and conflicts are reported at startup. Adding a feature
is adding an entry; nothing in `app.tsx` changes.

### 7.2 Renderer registries with forward-compatible fallbacks

Two registries: **frame renderers** keyed by frame `type`, and **tool renderers** keyed by tool name
(§5.5). Both have a generic fallback. The client never throws on an unknown frame type, an unknown
tool, or an unknown JSON field — a server that adds, say, a human-gate `paused` frame renders as a
generic event on an older client instead of breaking it. A new frame kind or tool gets a dedicated
look by registering one renderer.

### 7.3 Schema-driven session options (replaces v1.0's fixed `SessionProfile`)

Session creation is described as data:

```ts
interface SessionOptionField<T = unknown> {
  key: string; // 'inferenceCredential'
  label: string;
  source: (api: Api) => Promise<Choice<T>[]>; // where the choices come from
  autoPick?: 'single' | 'lastUsed'; // §6.3's zero/one/many behaviour
  toRequest: (value: T, req: CreateSessionRequest) => CreateSessionRequest;
}
```

Today the list has one field, `inferenceCredential`, whose `toRequest` sets
`credentials.inference`. The New Session form, presets, and the `run --option` flags (§7.5) are all
generated from this list. When the backend grows a session-time `model` or sandbox selector (§13),
supporting it is **one new field entry** — its choices source, its request mapping — and the form,
presets, and CLI flags all gain it with no other change.

**Presets** are named, saved values for these fields (`config.json` → `presets`). Picking a preset
skips the form; a preset that names a field the server no longer accepts is shown as stale, not
silently dropped.

### 7.4 A contract-drift test against `openapi.yaml`

Because the client redeclares types rather than importing server modules (§3.1), a test parses
`docs/api/openapi.yaml` and asserts that every route, method, request field, and error code the client
uses exists there with the shape it expects — the same discipline as
`packages/control-plane/test/openapi-contract.test.ts`. The `/turn` frame vocabulary, which is not in
the OpenAPI document, is pinned by a fixture test against recorded SSE streams. A server change breaks
CI, not a user's session.

### 7.5 Non-interactive mode on the same core

```
mocactl run "prompt" [--session <id> | --new] [--option key=value …] [--json]
```

It streams text to stdout (or newline-delimited frames with `--json`), exits with the turn's status,
and uses exactly the `api/` + `core/` stack the TUI uses — auth, remint, queueing, transcripts. Three
payoffs: scripting and CI use; the live smoke test (§10) drives the real stack without a
pseudo-terminal; and the layering rule of §3.1 is exercised continuously rather than asserted.

---

## 8. Error handling

### 8.1 The taxonomy map

One table from the API's error codes (`docs/api/openapi.yaml`, `Error.error`) to UI action:

| Code(s)                                                           | Source        | UI action                                                                |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `token_required` / `token_invalid` / `token_expired`              | control plane | Login overlay (§4); replay the action after                              |
| `token_invalid` / `token_required`                                | **harness**   | see §8.2 — never a blind re-login                                        |
| `session_mismatch`                                                | harness       | remint once and retry; if it recurs, report a client bug                 |
| `session_not_found` (404)                                         | either        | dismiss to home with a toast — not yours, or gone                        |
| `credential_required` / `credential_ambiguous`                    | control plane | handled proactively in §6.3                                              |
| `endpoint_unresolved`                                             | either        | "credential NAME has no gateway endpoint — edit it in /credentials"      |
| `authorization_pending` (428)                                     | control plane | expected while polling                                                   |
| `redis_unavailable` / `credential_unavailable` / `internal_error` | either        | "service unavailable — retry"; server-side, not the user's fault         |
| `503` + `Retry-After` on `/turn`                                  | harness       | countdown and automatic retry (§5.7)                                     |
| network / DNS failure                                             | either        | a connection banner naming which endpoint; harness down blocks only Chat |

Unknown codes render their `message` (or the code) without crashing.

### 8.2 A harness that rejects a fresh token

If the harness returns `token_invalid` or `token_required` for a session token minted seconds earlier,
logging in again cannot help — the harness does not trust this control plane's signing key, or is not
configured for auth at all. The client does **not** open Login. It shows: "the harness at URL rejected
a valid session token — it is likely missing MU1 auth configuration. Run /doctor for details." One
remint-and-retry happens first, to rule out a clock-skew edge; after that, the diagnostic.

---

## 9. Testing

- **Unit (vitest)** — the SSE parser (split frames, multi-line data, comments, a frame straddling
  reads); session-manager (remint margins with a fake clock, the one-in-flight queue, cancel semantics);
  the taxonomy map including §8.2; transcript store (append/replay, subject/URL isolation, file mode);
  session-options field resolution; the command registry (slash/keybind/palette derivation, override
  merge, conflict detection); the `edit` diff builder.
- **Component** — Ink's `render()` + `lastFrame()` per view and overlay against fixed state, including
  narrow widths and `NO_COLOR`.
- **Contract** — §7.4, plus recorded-SSE fixtures for every frame type and the unknown-type fallback.
- **Live smoke** — env-gated (`MOCACTL_LIVE_SMOKE=1`, following the repo's `*_LIVE_SMOKE` convention):
  `mocactl doctor --json`, then `mocactl run --new "…" --json` against a real control plane and harness,
  asserting at least one `text` frame and a `done`. Not part of default `make test`.

---

## 10. Delivery order

Everything in this spec is in scope. The order below is how it should land so each step is usable on
its own; it is not a scope cut:

1. `api/` + `core/` + `sse-parser` + `run` + contract tests — the whole protocol, proven headless.
2. Chat, Login, Sessions, New Session, Credentials overlays; command registry; status line; `<Static>`
   rendering; one-in-flight queue; local transcripts and titles.
3. Onboarding and `doctor`.
4. Per-tool renderers including the `edit` diff; latency and usage display; `system` theme and
   accessibility.
5. Markdown and syntax highlighting; `/copy`, `/export`, `/editor`; the `dark` theme; keybind
   overrides; presets.

---

## 11. Scope / YAGNI — not built, and why

- **No sandbox tools/mem/cpu UI and no model picker.** Nothing to submit them to (§1). The
  session-options seam (§7.3) is where they land once the backend exposes them.
- **No theme-file loader.** Tokens plus two shipped themes (§5.4).
- **No dual auth mode** (§1).
- **No local-tree features** — `@`-file search, `!`-shell, git undo/redo (§1).
- **No cost estimation** — the client does not know model pricing (§5.8).
- **No desktop notifications** — they need an OS-level dependency; a terminal bell on turn completion
  while the input is idle for more than 10 seconds covers the need without one (configurable).

Each has a concrete blocker or a cheaper substitute; none is missing by oversight.

---

## 12. Assumptions & external dependencies

1. Both services are reachable over HTTP from where the client runs. Nothing is assumed about what
   fronts either (§2.7).
2. A P6/VM harness needs MU1's auth settings added before this client can use it (§2.7). The client
   cannot fix that, but detects and names it (§8.2, §6.9).
3. The four documented credential kinds are stable enough for dedicated forms; anything else falls back
   to a generic editor plus the server's own validation (§6.4).
4. Pi's tool argument shapes (§2.4) are stable enough for dedicated renderers; a change degrades that
   tool to the generic renderer rather than breaking it (§7.2).

---

## 13. Open decisions / owed backend work

In priority order for the client's experience:

1. **`GET /v1/sessions/{id}/messages`** — cross-device history. Removes §6.6's "not available on this
   device" case; the local store becomes a cache.
2. **A session `title` field** on `/v1/sessions` — server-side titles that follow the user across
   devices; the client already prefers a server value (§6.2).
3. **Per-session model selection** and **per-session sandbox selection on `/turn`** (the latter owed to
   MU2 per MU1 §8.2). Each lands in the client as one session-options field (§7.3).
4. **Server-side turn serialization per session** — makes §6.1's client-side queue a convenience
   rather than the only guard, and protects other clients.
5. **A kind-registry listing endpoint** — would let §6.4 render forms for new kinds without a client
   release.
6. **Milestone/track assignment** — this spec claims no track prefix; left to whoever accepts it.

---

## 14. References

- [MU1 — Multi-User Control Plane](2026-09-08-multi-user-control-plane-design.md) and
  [ADR-0033](../adrs/0033-multi-user-control-plane.md) — the API this client is written against.
- [`docs/api/openapi.yaml`](../api/openapi.yaml) — the pinned contract (§7.4).
- [Streaming `/turn` Responses (SSE)](2026-08-26-turn-sse-streaming-design.md) and
  [ADR-0029](../adrs/0029-turn-sse-streaming.md) — the frame vocabulary.
- [P6 — VM Process Manager](2026-09-08-p6-vm-process-manager-design.md) — the `handler` reuse behind §2.7.
- [RA1](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) — naming context only.
- [Multi-Protocol Model Provider](2026-08-20-multi-protocol-model-provider-design.md) — why model
  selection is deployment-time today.
- OpenCode TUI docs (`opencode.ai/docs/tui/`, `opencode.ai/docs/themes/`) — the conventions §5 adopts.

---

## 15. Spec self-review notes

- **Placeholders:** none.
- **Internal consistency:** §0 lists every v1.1 change and each maps to a section; §1's out-of-scope,
  §11's YAGNI, and §13's owed work agree; §8.2, §6.9 and §12.2 agree that the P6 auth gap is
  detectable.
- **Scope:** one new package and one public discovery route (v1.2); §10 orders delivery without
  cutting scope.
- **Ambiguity:** library choices for Markdown and highlighting are deliberately left to implementation
  behind `render/markdown.ts`; the only open non-technical call is track assignment (§13.6).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
