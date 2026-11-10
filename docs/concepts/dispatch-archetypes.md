# Dispatch archetypes

> **Preview.** Describes the P6 runtime on `main` as of 2026-11-06.

An orchestrator can hand work to moca in three patterns. Which of them work depends on the deployment.

| Archetype            | Pattern                                                           | On P6 today                                                                                                          |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **A. Async fan-out** | Dispatch many leaves with `async: true`, collect results later    | **Submission implemented; drain loop not yet built** (ADR-0047, [#389](https://github.com/rossoctl/moca/issues/389)) |
| **B. Human gate**    | A leaf pauses for an external verdict, then resumes or terminates | **Works** (verdict leaves, `POST /v1/runs`)                                                                          |
| **C. Scheduled**     | A cron trigger dispatches async leaves                            | **Removed.** No P6 equivalent; design owed ([#536](https://github.com/rossoctl/moca/issues/536))                     |

Interactive turns (`POST /v1/turn`) and synchronous leaves (`POST /v1/runs`) work on P6 and on the
deprecated path alike.

## What the orchestrator relies on

- **Interactive:** `POST /v1/turn` with a session id, optionally streaming and detachable. See the
  [HTTP API guide](../reference/http-api.md).
- **Run-to-completion:** `POST /v1/runs` with a leaf envelope (a verdict, a `solve` or a `prompt` leaf)
  returns a result in the response body, which is also stored for polling at `GET /runs/status`. See
  [Leaf envelope and result](../reference/leaf-and-envelope.md). A failed leaf is a 200 with
  `status: "failed"`, so check the status field, not only the HTTP code.
- **Retry:** re-send the same `sessionId`. A verdict leaf returns its recorded verdict; the others run
  again.
- **Back-pressure:** a 503 with `Retry-After` means no sandbox is available right now (the pool is
  saturated, or the session's sandbox is busy or briefly absent), and a 429 from the supervisor means no
  worker has a free slot. Retry after the delay. A detachable turn can also return 503 `redis_unavailable`.

## Archetype B, the human gate

A verdict leaf marked `require_approval` stops and returns `status: "paused"` with a `gateId` and the
proposed action. The orchestrator (or a person behind it) re-sends the same envelope with an inline
`decision` of `approve`, `reject` or `abort`. Nothing is held in memory while paused: the state is the
session log in Redis, and there is no harness-side timeout. There is no gate on `/turn`.

## Archetypes A and C

Archetype A's drainer (a Redis-Streams consumer run as a KEDA `ScaledJob`) and archetype C's
`CronJob` on-ramp were removed with the Knative/KEDA deployment path
([ADR-0041](../adrs/0041-deprecate-knative-keda-deployment.md)). Neither runs on P6 today: the
supervisor only runs `--role=turn` workers (a `--role=leaf` role is reserved and not implemented), and
a data-plane request with `async: true` is answered 400 `async_removed`, naming the removal, rather
than accepted and left undrained.

**Archetype A's replacement is designed, and its submission half is implemented.**
[ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md) and its
[design spec](../specs/2026-11-05-p6-async-fan-out-design.md) put the consumer in the ordinary turn
worker as a drain loop sharing the same admission budget as interactive turns, rather than in a
separate process or a `--role=leaf` worker. `POST /v1/sessions/{id}/turns` accepts and records turns
today; the drain loop that runs them is [#389](https://github.com/rossoctl/moca/issues/389), so a
submitted turn stays `queued` until it ships. Two consequences matter to an orchestrator planning
against it:

- **The submission route changes.** The unauthenticated data-plane `POST /runs {async:true}` is not
  coming back — it stays removed permanently, because an unauthenticated enqueue is a second trust
  model for the same queue. Its replacement is authenticated and owner-scoped:
  `POST /v1/sessions/{id}/turns` with `async: true`, answering `202 {turnId}`. A controller with no
  interactive user behind it holds a service-account credential like any other caller.
- **Scale-to-zero and queue-depth-driven capacity are dropped, deliberately.** ADR-0041 already
  accepted the first as a cost of leaving Knative; P6 admission is slot-driven, so queue depth
  becomes an operational metric rather than a scaling input. The design's §10 lists every KEDA-era
  behaviour with a kept/dropped verdict, so what changed is on the record rather than inferred.

Tracking is [#686](https://github.com/rossoctl/moca/issues/686) (the epic), which closes when a
fan-out pipeline runs end to end on `deploy/k8s` and on `deploy/vm` or compose; [#389](https://github.com/rossoctl/moca/issues/389)
tracks the drain loop specifically. Until it ships this row stays "submission implemented; drain
loop not yet built". **Archetype C** has no design yet;
[#536](https://github.com/rossoctl/moca/issues/536) owns it, and it is expected to build on
archetype A's consumer rather than a second one.
