# Leaf envelope and result

> **Preview.** Describes `POST /v1/runs` on `main` as of 2026-10-12 (`harness/src/run-leaf.ts`). A
> **leaf** is one unit of agent work an orchestrator dispatches ([glossary](../glossary.md#leaf)). This
> page replaces the file-based "volume envelope" of the early specs, which no longer exists in the code.

## What changed from the volume envelope

The first leaf contract passed inputs and results as files on a shared volume (`inputsRef`,
`resultRef`, `doneMarkerRef`, `gateRef`, `decisionRef`, a `/work` PVC). The FS-free redesign
([P1 spec](../specs/2026-07-02-p1-fs-free-harness-design.md), ADR-0020) replaced it: inputs and the
gate decision are **inline** in the request, the result is the **response body**, and a copy is stored
in Redis for polling. The harness does no filesystem I/O of its own.

Nothing checks for the old fields by name. An envelope without the inline fields (the old file-ref shape
has no `item`, `problemStatement` or `prompt`) is rejected with 400 `envelope_invalid`; an envelope that has
the old fields **plus** a valid inline shape is accepted and the old fields are ignored. A leaf's tools
still run in a sandbox with its own filesystem, and `workspaceRef` is a path inside that sandbox.

## Request

`POST /v1/runs` with a JSON envelope of one of three kinds, chosen by `kind`:

| Kind                                  | Required fields                                   | Behavior                                                                                     |
| ------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Verdict (`kind` absent or `converge`) | `sessionId`, `item`                               | Produces a structured verdict with a `submit_verdict` tool; resumable; supports a human gate |
| `solve`                               | `sessionId`, `problemStatement`, `repoUrl`, `ref` | Works a problem in a fresh per-session workspace and returns a patch. Needs a sandbox pool   |
| `prompt`                              | `sessionId`, `prompt`                             | Leases a sandbox and runs the prompt as a turn on the session                                |

`item` is `{item_id: string, file: string, pattern: string, require_approval?: boolean}`.

Optional fields on any envelope: `decision`, `model`, `provider`, `workspaceRef`, `repoUrl`, `ref`,
`maxTurns` (verdict leaf only), `async`, `tenant`, `configRef`, `problemStatement`, `prompt`, `env_key`.

**`configRef`** names a [config bundle](../guides/promote-claude-workflow.md) (`sha256:` plus 64 lowercase hex
characters). It applies to **prompt and solve leaves only**; a verdict leaf never reads it and runs without the
bundle's skills, with no warning. It must be in the envelope: `/runs` does not use the session's bound
bundle (unlike `/turn`). At request time only a non-blank string is required (`null` counts as absent; a
blank or non-string value is 400 `configRef_invalid`); the digest format is checked when the bundle is
resolved, and a bad digest comes back as a 200 `failed` result with reason `error`, not a 400.

**`tenant`** is accepted only from unauthenticated callers: an authenticated `/runs` that sends it gets
400 `tenant_not_allowed`.

`workloadId` runs a synchronous prompt on that workload's frozen context (see
[Context Service and workloads](../context-service.md#runs)). An async run that names one, and any
run while workloads are off, returns 501 `workload_runs_unavailable`, unless the deployment requires
a token and none was sent (401 `token_required` first). `contextWritable: true` gives that run its
own writable copy of the context, discarded when the run ends. It must be a boolean (400
`context_writable_invalid`), and `true` needs a `workloadId` (400
`context_writable_requires_workload`); `false` is ignored.

`sessionId` is mapped to a safe internal id: a `tenant/` prefix if any, every character outside
`[A-Za-z0-9._-]` becomes `-`, and leading and trailing non-alphanumerics are trimmed.

## Result

The 200 body is a `LeafResult`:

| `status`    | Other fields                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `done`      | `verdict: {item_id, verdict: "FLAGGED" or "CLEAR", reason}`                                                                           |
| `paused`    | `gateId` (number), `gate: {summary, proposed_action}`                                                                                 |
| `aborted`   |                                                                                                                                       |
| `solved`    | `patch`, `usage?`                                                                                                                     |
| `responded` | `text`, `usage?`                                                                                                                      |
| `failed`    | `reason`: `no_verdict`, `invalid_verdict`, `bad_inputs`, `error`, `saturated` or `owner_lost` (reaper-written only, #558); `message?` |

A `failed` result is returned as HTTP 200 on the sync path, not as a 4xx or 5xx, except `saturated`,
which becomes 503 with `Retry-After`. Every non-saturated outcome is stored at `leaf:result:<id>` with
a TTL of `LEAF_RESULT_TTL_SECONDS` (default 86400); the last write wins. `GET /runs/status?sessionId=`
returns a **reduced view** of that record, not the whole result: no `message` on `failed` (the stored
record keeps none either), no `usage` on `solved` and `responded`, and `paused` repeats `gateId` at the top
level and inside `gate`. A session with no record yet, or none at all, answers `200 {status: "queued"}`,
and the lookup takes `tenant` as a query parameter (unauthenticated callers only).

## Idempotency and resume

- **Verdict leaf:** resumable. If a session exists, it is reopened from its checkpoint; if a verdict was
  already recorded it is returned without running the agent or leasing a sandbox. To retry, re-invoke
  the same `sessionId`.
- **Prompt leaf:** there is no fast path; re-invoking runs the prompt again as a new turn on the
  existing session.
- **Solve leaf:** reopens an existing session but re-prompts; the workspace is created fresh and cleaned
  up afterwards.

## The human gate

A verdict leaf whose `item.require_approval` is `true` is told to call `request_approval` once and stop.
`submit_verdict` is withheld until a decision exists. The run then returns
`{status: "paused", gateId, gate: {summary, proposed_action}}` (also stored, and shown by
`/runs/status` in its reduced view). There is no `awaiting_approval` status in the current code.

To resolve it, re-POST the **same envelope** to `/v1/runs` with an inline decision:

```json
{
  "sessionId": "run-1/item-1",
  "item": { "item_id": "a", "file": "x.py", "pattern": "p", "require_approval": true },
  "decision": { "gateId": 0, "action": "approve", "feedback": "ok" }
}
```

| Field      | Notes                                                      |
| ---------- | ---------------------------------------------------------- |
| `gateId`   | Non-negative integer, 0-based; must match the pending gate |
| `action`   | `approve`, `reject` or `abort`                             |
| `feedback` | Optional string                                            |

- A decision that is invalid is ignored, and the run stays paused. A decision for the wrong `gateId`
  also leaves it paused; repeating an already-recorded decision appends nothing.
- `abort` returns `{status: "aborted"}`. `approve` or `reject` continues the agent with a prompt that
  carries the decision.
- There is no harness-side timeout while paused; the result record's TTL is the only bound.
- Gates exist only on the verdict leaf, not on solve or prompt leaves and not on `/turn`.

## Async and scheduled dispatch

`async: true` and the cron on-ramp were removed with the Knative/KEDA path (ADR-0041): a request with
`async: true` returns 400 `async_removed`. Neither has a P6 equivalent yet.

## Spec drift

- The [human-gate design](../specs/2026-06-28-human-gate-design.md) still describes the file-based
  design (`decisionRef`, `gateRef`, an `awaiting_approval` marker). This page follows the code.
- The P1 spec lists failure reasons without `saturated`, and statuses without `solved` and `responded`.
- **Prompt-leaf session ids are inconsistent.** The turn is opened under the **raw** `sessionId` (no tenant
  prefix, no sanitising), while the sandbox lease, the promoted config and the result record use the
  sanitized id (`harness/src/run-leaf.ts`, `server.ts`). Verdict and solve leaves use the sanitized id
  throughout. Treat the two as different keys for a prompt leaf until the code is aligned.
