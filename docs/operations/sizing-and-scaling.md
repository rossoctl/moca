# Sizing and scaling

> **Preview.** For P6 on Kubernetes. **No capacity measurements are published.** `SH_TURNS_PER_WORKER` is documented
> as an output of an experiment (E8) whose results are not in this repository, so the defaults below are trial
> values. Do not read them as recommendations.

## What a supervisor pod can do

One supervisor pod runs `SH_WORKERS` workers, each allowing `SH_TURNS_PER_WORKER` concurrent turns. The shipped
manifest pins **2 workers and 4 turns per worker**, so a pod serves up to **8 concurrent turns**; beyond that it
answers `429 {"error":"overloaded"}` with `Retry-After: 1` before reading the request. Only `POST /turn` and
`POST /v1/turn` count toward the cap, but the supervisor checks saturation once per connection, before reading any
bytes, so while a pod is saturated **every** connection on the data port gets the 429, `/v1/runs` included. See [Session multiplexing](../harness/concepts/session-multiplexing.md).

Change the worker count, the CPU limit and the memory request together: the manifest pins W with a CPU limit of 2
(about one CPU per worker) and a memory request of at least W x 256Mi (a manifest test enforces that), plus about 256Mi of headroom, which is
advice in the deploy README and not tested. If `SH_WORKERS` were unset, W would follow the pod's CPU limit.

## Resource defaults

| Workload                  | Requests         | Limits                     |
| ------------------------- | ---------------- | -------------------------- |
| Supervisor (with workers) | 500m CPU / 768Mi | 2 CPU / 1Gi                |
| Control plane             | 100m / 256Mi     | 500m / 512Mi               |
| Relay                     | 50m / 256Mi      | memory 512Mi, no CPU limit |
| Redis                     | 50m / 64Mi       | memory 256Mi               |
| Each sandbox              | 10m / 64Mi       | memory 512Mi               |
| ghostunnel (OpenShift)    | 10m / 32Mi       | memory 64Mi                |

## Adding capacity

- **More concurrent turns:** add supervisor pods (`replicas` in an overlay). Workers share only Redis. The Service
  spreads _connections_, not load, and the default `leastInFlight` policy balances only within a pod, so one pod can
  429 while another has room (inferred from the per-pod admission; not stated in the repository).
- **Or raise W and S** in one pod, with CPU and memory raised to match (above).
- **One user cannot take every slot:** each authenticated subject is capped at `SH_TURNS_PER_SUBJECT` in-flight turns
  per worker (default half of S), refused with 429 `subject_quota_exceeded` and `Retry-After` — a different code from
  the pool-wide `overloaded` 429. The cap is per worker, so a subject's host-wide share is `cap/S`, not the knob value
  itself. Async turns count against the same number (#391): an entry claimed past its owner's cap is handed back to the
  queue unrun, counted as `async_deferred_subject`, so an owner whose fan-out is running cannot also fill the worker
  with interactive turns. It does **not** pace an async-only drain: a worker runs one queued leaf at a time, so async
  work alone never reaches the cap, and the queue is one FIFO stream — one owner's deep backlog still delays another
  owner's async turn, which needs a cluster-wide per-owner count and is open on #391.
- **More sandboxes:** set `SH_SANDBOX_COUNT` for `setup.sh` (default 2, sticky). Each pod's sandbox id is its pod
  name. Each sandbox accepts up to `KAGENTI_SANDBOX_CAP` concurrent leases (the manifest sets 4; the code default is
  20), so container capacity is roughly sandboxes x 4 concurrent turns. A pool with no free slot returns 503
  `sandbox_unavailable` with `Retry-After`. Scaling the count down removes the workspaces of sessions pinned to the
  removed pods.
- There is **no autoscaling**: no HPA, no KEDA.

## What does not scale

- **Control plane:** keep one replica. The bundle-budget check is serialized in process.
- **Relay:** exactly one replica (`Recreate`); a restart drops every attached sandbox.
- **Redis:** one instance, no Sentinel or cluster mode.
- **Sticky routing:** `stickyBySession` pins within one pod only.
- **L4 only:** put no Ingress, edge Route, mesh sidecar or other HTTP proxy in front of the supervisor port; a proxy
  that reuses upstream connections defeats the per-connection hand-off and the turn cap. On OpenShift the data route is
  a passthrough to a TLS sidecar.

## Limits to watch

| Limit                                   | Default                                   | Notes                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis memory                            | 256Mi limit, 1Gi volume                   | Sessions never expire; per-session memory is unmeasured                                                                                                                                               |
| Config bundles                          | 16 MiB per user, 64 MiB total, 8 MiB each | 429 `bundle_quota_exceeded` when the per-user or total budget is full; a single bundle over 8 MiB gets 400 `invalid_request` (and `mocactl promote` refuses it locally); bundles expire after 30 days |
| Detachable turns                        | 1800 s unwatched, 86400 s log retention   | `SH_TURN_DETACHED_MAX_S`, `SH_TURN_LOG_TTL_S`                                                                                                                                                         |
| Sandbox affinity                        | 86400 s memory, 60 s grace                | `SH_SANDBOX_AFFINITY_TTL_SECONDS`, `SH_SANDBOX_AFFINITY_GRACE_SECONDS`                                                                                                                                |
| Token lifetimes                         | API 900 s, session 300 s                  | Refresh 30 days idle, 90 days absolute                                                                                                                                                                |
| Harness config cache (`/tmp/sh-config`) | Grows with each distinct bundle digest    | No cleanup yet (a known ADR-0038 follow-up)                                                                                                                                                           |

The cold-turn cost of a promoted bundle is unmeasured.
