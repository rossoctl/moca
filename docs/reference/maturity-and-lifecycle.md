# Maturity and lifecycle

> Decided by the maintainer on 2026-10-13. This page is the policy; the registry
> ([`docs/specs/README.md`](../specs/README.md)) remains the source of truth for each milestone's status, and a
> page's label must agree with it.

## Labels

| Label       | Meaning                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| **Stable**  | Supported, no planned removal. Meets every criterion below.                                      |
| **Preview** | Implemented and the recommended direction, but not yet Stable. Interfaces and limits may change. |
| **Legacy**  | Deprecated. Security and breakage fixes only; removal is gated as described below.               |

The label describes a deployment path or a documented interface, not the project as a whole. Banner
wording is in [`CONTRIBUTING-DOCS.md`](../CONTRIBUTING-DOCS.md#maturity-labels-and-banners).

## What Stable requires

A path graduates from Preview to Stable when **all** of these hold:

1. **A release names it.** A tagged release's notes state that the path is supported.
2. **End-to-end CI.** CI exercises it end to end without manual steps, and that check is required.
3. **Upgrade and recovery.** An upgrade path and a data-recovery path are documented.
4. **No silent failures.** Its known data-loss or silent-failure limits are closed or have a documented
   workaround.
5. **A change policy.** Its API or configuration contract has a stated change policy: [Change policy](change-policy.md)
   (adopted 2026-10-13).

There are no time-based windows (such as "nine months in Beta"): the project is too young to honour them.

## Where each path stands

The first Stable target is **P6 on Kubernetes** (the process manager as ordinary cluster workloads,
[`deploy/k8s`](../../deploy/k8s/README.md)).

| Path                             | Label   | Against the criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P6 on Kubernetes**             | Preview | **First target for Stable.** (1) No release names it yet. (2) A `k8s-e2e` job runs on `main`, but it is not a required check until it has passed ten consecutive runs. (3) Not yet: no upgrade or Redis backup guide. (4) Idle workspace reclaim is silent (#338); async fan-out runs on P6 but is unproven on this path (#688), and cron still has no P6 equivalent. (5) Met by [Change policy](change-policy.md), though several of its decisions still need code changes |
| Single VM                        | Preview | Production-oriented, and Redis now persists (named volume + AOF, and a re-run of the installer keeps sessions — #410), but there is no upgrade or backup guide and no end-to-end CI. A later candidate                                                                                                                                                                                                                                                                      |
| Docker Compose                   | Preview | A trial path by design; it will not be promoted                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P4 microVM tier                  | Preview | Open limits (#277 no guest network, #274 fresh VM per call, #338 silent reset, no per-user binding); its CI gate is manual only                                                                                                                                                                                                                                                                                                                                             |
| `mocactl` and the `/v1` HTTP API | Preview | The API is versioned, and a [change policy](change-policy.md) is adopted, with follow-up code changes open. It can reach Stable independently of any deployment path                                                                                                                                                                                                                                                                                                        |

Before any path is promoted, a release should be cut whose notes say that P6 is the supported runtime and
that it is Preview. No release says that today.

## Removed paths

The Knative + KEDA deployment was deprecated 2026-10-11 and removed in November 2026
([ADR-0041](../adrs/0041-deprecate-knative-keda-deployment.md) records the decision, the window's
fixes-only policy, and the removal conditions: the end-of-October-2026 floor, and migration confirmed
on the [tracking issue](https://github.com/rossoctl/moca/issues/490)). Nothing serves it now; the last
release that carries it keeps working code but gets no fixes. Archetypes A (async fan-out) and C
(scheduled dispatch) went with it. **A has a P6 replacement and runs today** — a drain loop in the
turn worker, opt-in behind `SH_ASYNC_DRAIN` and `MOCA_TENANCY=single`
([ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md),
[#686](https://github.com/rossoctl/moca/issues/686), operator steps in
[dispatch archetypes](../concepts/dispatch-archetypes.md)); C has no design
([#536](https://github.com/rossoctl/moca/issues/536)) and no P6 equivalent.
