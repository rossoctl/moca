# Dispatch archetypes

> **Preview.** Describes the P6 runtime on `main` as of 2026-11-12.

An orchestrator can hand work to moca in three patterns. Which of them work depends on the deployment.

| Archetype            | Pattern                                                           | On P6 today                                                                                      |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **A. Async fan-out** | Dispatch many leaves with `async: true`, collect results later    | **Works, opt-in:** `SH_ASYNC_DRAIN=1`, `MOCA_TENANCY=single` (ADR-0047)                          |
| **B. Human gate**    | A leaf pauses for an external verdict, then resumes or terminates | **Works** (verdict leaves, `POST /v1/runs`)                                                      |
| **C. Scheduled**     | A cron trigger dispatches async leaves                            | **Removed.** No P6 equivalent; design owed ([#536](https://github.com/rossoctl/moca/issues/536)) |

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

## Archetype A, async fan-out

Archetype A's drainer — a Redis-Streams consumer run as a KEDA `ScaledJob` — was removed with the
Knative/KEDA deployment path ([ADR-0041](../adrs/0041-deprecate-knative-keda-deployment.md)). Its P6
replacement is [ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md) with its
[design spec](../specs/2026-11-05-p6-async-fan-out-design.md), and it **runs on P6 today**: the
consumer is a drain loop inside the ordinary `--role=turn` worker, sharing one admission budget with
interactive turns, rather than a separate process or a `--role=leaf` worker (that role stays reserved
and unimplemented). A worker claims one queued turn at a time, runs it through the same `runLeaf` the
synchronous route uses, and writes the result under that turn's own key, read back by
`GET /v1/sessions/{id}/turns/{turnId}`. The data plane's `GET /runs/status` is deliberately
untouched (spec §10) and never _reports_ an async turn, which is worse than failing: it reads the
session-wide result key, which an async turn never writes, so it answers `{"status":"queued"}`
forever — or, if that session ever ran a synchronous `/v1/runs` leaf, returns **that** leaf's result,
which looks like a real answer. Poll the turn route, not this one.

**Running it.** Three things, none of them a new service:

1. **Turn the drain on.** `SH_ASYNC_DRAIN=1` on each worker process; it is off by default and needs
   `SH_CONTROL_PLANE_URL` and `SH_EXCHANGE_TOKEN`, which the deployment already sets. A missing
   prerequisite logs one line and leaves the drain off rather than failing the boot. Per deployment:
   `supervisor.env` on [`deploy/vm`](../../deploy/vm/README.md), `.env` on
   [`deploy/compose`](../../deploy/compose/README.md), the `moca-settings` ConfigMap on
   [`deploy/k8s`](../../deploy/k8s/README.md). Every worker that has it drains, so the drain needs no
   concurrency knob of its own: a worker runs **one** queued leaf at a time and claims it only while
   its total in-flight count — async plus interactive — is below `SH_TURNS_PER_WORKER`. See the
   [configuration reference](../reference/configuration.md).
2. **Submit through the authenticated route.** `POST /v1/sessions/{id}/turns` with `async: true`
   answers `202 {sessionId, turnId}`. Over the fan-out quota it answers 429 `async_quota_exhausted`;
   under `MOCA_TENANCY=multi` it answers 501 `async_tenancy_unsupported` (see the limits below).
3. **Collect.** Poll `GET /v1/sessions/{id}/turns/{turnId}` for `state` and `attempts`, plus the
   result once the turn is terminal — the record's state is the source of truth, so a result written
   by a worker that then died is withheld until the reaper has ruled on it, rather than returned as
   an answer. `DELETE` the same path cancels a turn that is still `queued`; a running leaf is
   not interrupted (409 `turn_not_cancellable`). A result expires on `LEAF_RESULT_TTL_SECONDS` — the
   same variable and the same 24 h default the KEDA path used, nothing replaces it — and a finished
   turn's record an hour after that, so the record outlives the result it points at.

**What changed from the KEDA path**, beyond where the consumer runs:

- **The submission route.** The unauthenticated data-plane `POST /runs {async:true}` is not coming
  back — it stays removed permanently (#687), because an unauthenticated enqueue is a second trust
  model for the same queue, and it still answers 400 `async_removed` naming the replacement. A
  controller with no interactive user behind it holds a service-account credential like any other
  caller.
- **Scale-to-zero and queue-depth-driven capacity are dropped, deliberately.** ADR-0041 already
  accepted the first as a cost of leaving Knative; P6 admission is slot-driven, so queue depth
  becomes an operational metric (`async_queue_depth`, `async_oldest_age_ms`) rather than a scaling
  input. Fan-out width is one leaf per worker process — `SH_WORKERS` × replicas — sized ahead of the
  load rather than grown by it, and shared with whatever interactive traffic those workers carry. The
  spec's §10 gives every other KEDA-era behaviour a kept-or-dropped verdict — the `XAUTOCLAIM`
  reaper, dead-lettering, at-least-once delivery and the retry classes are all kept — so what
  changed is on the record rather than inferred.

**Limits on the shipped path**, each tracked rather than implied:

- **`MOCA_TENANCY=single` only.** Under `multi`, submission is refused by name
  (501 `async_tenancy_unsupported`) and the drain refuses to arm. Lifting the gate needs the grant
  and token-endpoint slice; it is M2 of the spec's §9.
- **`deploy/k8s` is wired but unproven.** The ConfigMap, overlays and `setup.sh` validation are in;
  the queued-leaf smoke test and the written capacity story are
  [#688](https://github.com/rossoctl/moca/issues/688).
- Per-turn wall-clock caps (`turn_exp`) are M2. A turn's caps are recorded, not enforced.

[#686](https://github.com/rossoctl/moca/issues/686) is the epic, and it closes when a fan-out
pipeline runs end to end on `deploy/k8s` as well.

## Archetype C, scheduled

Archetype C's `CronJob` on-ramp went the same way and has **no P6 equivalent yet**, and no design.
[#536](https://github.com/rossoctl/moca/issues/536) owns it, and it is expected to build on archetype
A's consumer rather than a second one.
