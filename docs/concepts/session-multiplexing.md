# Session multiplexing

> **Preview.** Describes the P6 runtime on `main` as of 2026-10-12. No density or latency measurements for
> P6 are published in this repository; the sizing knobs below have no measured recommendation yet.

On the removed Knative path one request meant one scaled-to-zero process. P6 turns that around: a
**supervisor** keeps a fixed pool of warm **workers**, each serving many sessions. Scale-to-zero and high
density trade against each other ([ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md)), so
idle capacity costs memory, in exchange for no cold start and no autoscaler to operate.

## How a request travels

1. The supervisor listens on one port at layer 4. It accepts the connection and **hands the socket** to a
   worker, reading at most the request head (only under `stickyBySession`). It never touches a response
   byte on a handed-off socket; the 429 under Overload is the one answer it writes itself.
2. The worker serves the request with the same HTTP handler used everywhere, then returns to the pool.
3. The turn's state is in Redis, so the next request, even from the same client, may land on any worker.

The supervisor must sit in front of the workers at layer 4 only. A layer-7 proxy that reuses upstream
connections would defeat the per-connection hand-off.

## Knobs

| Setting               | Meaning                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `SH_WORKERS`          | W, the number of workers. Defaults to the CPU count the unit may use                                 |
| `SH_TURNS_PER_WORKER` | S, concurrent turns allowed per worker. **Required**, no default: the right value has to be measured |
| `SH_ROUTING_POLICY`   | `leastInFlight` (the default) or `stickyBySession`                                                   |

The capacity at any moment is W x S concurrent turns. The Kubernetes manifest and the Compose installer use S = 4 as a
trial value, not a recommendation; the VM template ships it empty. Only `POST /turn` and `POST /v1/turn` count toward S; `/v1/runs` does
not.

**Routing** is decided per connection, not per request, so a keep-alive connection stays on its first
worker. `stickyBySession` pins by the `X-SH-Session-Id` request header, kept in supervisor memory (capped at
10,000 entries); `mocactl` does not send that header, so sticky routing does not apply to it.

## Overload

When no healthy worker has a free slot, the supervisor **refuses new connections** with
`429 Retry-After: 1` and `{"error":"overloaded"}` before reading the request. Admission control replaces
autoscaling. Two consequences follow from the code: while saturated, _every_ new connection is refused,
including `/health`, a re-attach (`GET /v1/turn`) and a cancel (`POST /v1/turn/cancel`); and clients
should retry after the delay.

## When things fail

- **A worker dies:** its in-flight turns die, the session survives in Redis, and the supervisor restarts
  the worker with exponential backoff (starting at `SH_WORKER_RESTART_BACKOFF_MS`, capped at 30 seconds,
  reset after 10 seconds of healthy running). Its sandbox leases expire after the 60-second TTL.
- **The supervisor dies:** workers exit when they lose their link to it, and the process manager restarts
  the set. Re-adopting running workers is deliberately not built.
- **A graceful stop:** the supervisor drains workers and waits up to 20 seconds for idle; within that, a detachable turn
  is aborted with "harness restarting" after 15 seconds.

## Why one process can serve many sessions

Sharing a process is only safe if no session can see another's identity or credentials. The harness
enforces this per request: an authenticated turn takes its identity from the verified session token (a
conflicting `X-SH-Subject` is rejected), the process holds no ambient provider credential under
`MOCA_TENANCY=multi` (it is scrubbed and replaced by a sentinel), and the worker's Pi loader is locked
down. Some process-wide state in Pi cannot be isolated and is pinned by tests rather than refactored; the
[P5 design](../specs/2026-09-06-p5-session-isolation-design.md) lists the residual hazards (for example, a write error in the output guard can exit the whole process,
which the spec calls a fleet-wide outage triggered by one session). The P5 spec's `X-SH-Subject` flow for
unauthenticated callers does not appear in the current server code.
