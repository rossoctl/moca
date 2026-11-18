# Sessions and turns

> **Preview.** Describes the P6 runtime on `main` as of 2026-10-12.

A **session** is the durable, owned, resumable unit of work; a **turn** is one exchange within it
([glossary](../glossary.md)). The point of the design is that the agent process holds nothing a
restart can lose: the conversation lives in Redis, and any worker can pick a session up.

## Where a session lives

A session is an append-only log in Redis: a stream `session:<sid>` and a counter `session:<sid>:seq`.
Each entry has a position, a timestamp, the Pi entry type, the entry itself and a content hash. The
harness wraps Pi's session storage so appends are queued and written behind the model loop; they are
flushed when a Pi turn ends and once more at the end of every turn. Only entries still queued when a
process dies are lost.

The control plane keeps a separate small record per session (owner, tenant, credential name, config
bundle, sandbox tier), so sessions can be listed, owned and deleted without reading the log.

## Resuming

Send the same `sessionId` and the harness reopens the log and continues from the last compaction
checkpoint. What happens for an unknown id depends on the caller:

| Caller                                                     | Unknown `sessionId`                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Authenticated turn (`/turn` or `/v1/turn`), any `/v1/runs` | The session is created under that id                        |
| Anonymous turn (`/turn` or `/v1/turn`)                     | 404 `session_not_found`; omit the id to start a new session |

Resuming works across workers and across process restarts, because state is in Redis and not in the
worker. Sandbox state is separate: a resumed session finds its workspace in a sandbox, or gets a fresh
one if that sandbox is gone (see [Sandboxes and tiers](sandboxes-and-tiers.md)).

## Compaction and cost

Long sessions are compacted by Pi. The harness records a **checkpoint** entry pointing at the first entry
Pi kept, so a resume reads the tail of the log instead of replaying all of it. A separate, optional
**token budget** (`SH_BUDGET_TOKENS`) blocks tool calls in a turn once its assistant token usage passes
the cap; it is a per-turn spend limit, not a speed-up.

Measured in an early experiment (E2, in-process, with a counting backend; see
[`docs/archive/experiment-results.md`](../archive/experiment-results.md)): resuming read a constant 6 entries and about
900 bytes whatever the session length (50 to 5,000 entries), against 53 to 5,003 entries for a full
replay. Two caveats: it was not an LLM-latency result, and in the production Redis backend finding the
checkpoint marker still scans the whole stream, so total Redis work is not constant.

## What survives what

| Event                    | Result                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A worker dies mid-turn   | The in-flight turn is lost; the committed session survives in Redis and the next request resumes it                                                                                                   |
| The supervisor restarts  | Workers exit and are restarted; in-flight turns end, sessions survive. Turns do not survive a restart                                                                                                 |
| A sandbox goes away      | The session survives; if it is moved the workspace is reset and the turn reports `workspace_reset`                                                                                                    |
| A workspace is reclaimed | The session survives on its sandbox with a fresh workspace; the next turn reports `workspace_reset` with reason `reclaimed`, from a marker file ([Brain and hands](brain-and-hands.md#the-workspace)) |
| **Redis is lost**        | All sessions, ownership records and leases are lost                                                                                                                                                   |

Redis durability depends on the deployment. In the single-VM and Compose deployments Redis has no named
volume (it keeps only the image's default snapshots in an anonymous volume), so a reboot may lose
sessions. Whether the anonymous volume survives removing or replacing the container (re-running
`setup-vm.sh` does the latter) is not established, so assume it does not. The `setup-vm.sh` comments say a reboot loses them, so assume it does. The Kubernetes deployment uses a StatefulSet with a persistent volume
and append-only persistence. Plan backups accordingly; there is no operations guide for this yet.

## Lifetime

There is no session TTL in the code: a session lives until it is deleted (`DELETE /v1/sessions/{id}`,
which also removes the log and the stored leaf result). Other things expire: stored leaf results (default
24 hours), detachable-turn logs (default 24 hours), sandbox affinity (default 24 hours) and config
bundles (30 days, refreshed on use).

## Repeating a request

A normal `/v1/turn` has no idempotency key; sending it twice runs two turns. A verdict leaf is
resumable and returns a recorded verdict without re-running; a prompt leaf runs again
([Leaf envelope and result](../reference/leaf-and-envelope.md#idempotency-and-resume)).
A **detachable** turn (opt-in: `SH_TURN_DETACH=1`, plus an authenticated streaming request that sends
`detachable: true`) allows one live turn per session (409
`turn_in_progress`), keeps running when the client disconnects, and can be re-attached with its
event log ([HTTP API](../reference/http-api.md#detachable-turns-attach-and-cancel)).
