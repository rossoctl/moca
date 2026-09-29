# ADR-0034: Density off Kubernetes comes from a socket-handing-off supervisor over a fixed worker pool, not from an orchestrator replacement

- **Status:** Proposed
- **Date:** 2026-09-08
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-09-08-p6-vm-process-manager-design.md`](../specs/2026-09-08-p6-vm-process-manager-design.md)

## Context

The harness runs on Knative because one resident agent process per session is expensive: scale to zero
between turns, cold-start on the next request (README:11-17). [P5](../specs/2026-09-06-p5-session-isolation-design.md)
changes that premise. Once N sessions share one process, the deployment never idles at zero, so the
autoscaler, the activator's cold-start path, and the revision machinery are cost with no matching
benefit. **Scale-to-zero and high density are substitutes, not complements.**

That is not speculative. E6's authoritative reading of its own saturation curve is that the knee was
"a _harness-tier_ limit, not sandbox saturation", and that the p95 blowup under concurrency was "LLM
latency + Knative cold-start (`max-scale=20` bursts new harness pods), not the sandbox"
(`deploy/knative/EXPERIMENTS.md:96`). Knative cold-start is already a named term in a measured
ceiling.

Tracing the tree at `c12a97c` shows how little is actually Kubernetes-shaped. The `SandboxTransport`
seam already has a gRPC path whose Go worker dials out and needs no inbound route; sandbox discovery,
capacity leases, session state, the work queue and leaf results are all Redis; the HTTP surface is
plain `node:http` with no Knative coupling anywhere in `src`; MU1 already put credentials behind a
`CredentialStore`. Two further facts decide the shape. First, the sandbox tier is not the bottleneck
and needs no change: on real code-review leaves E6 measured per-leaf sandbox duty at **0.061–0.079** on
OCP (N ≈ 12.6–16.5) and **0.042–0.051** on Kind (N ≈ 19.7–24.0), while E7 measured **0.021/0.035** on
mixed-ref converge leaves (N ≈ 28.6–47.6). Three rows, deliberately never blended — a basis is a row,
not an experiment, since each `(duty, N)` pair only holds within one — and the spec provisions from
**E6/OCP**, the conservative row, since `EXPERIMENTS.md:65` supersedes the 29–48:1 figure for
real-converge work (spec §2.3, §5.4). Second, E2
measured session rehydration at a **constant 6 entries / ~900 bytes** regardless of session length, so
warm in-process session state is worth far less than intuition suggests.

Exactly one code-level blocker exists: `harness/src/select-sandbox.ts:87` calls `listPoolPods`
unconditionally, before the gRPC branch, and that shells out to `kubectl`. The gRPC presence path
therefore cannot run on a host without `kubectl` today, despite needing nothing from it.

## Decision

We will run the harness on **one VM with no Kubernetes** as a `sh-supervisor` process owning a fixed
pool of long-lived `sh-worker` processes, each multiplexing S concurrent in-flight turns over many
addressable Pi sessions (the two axes the spec's §5.1 keeps apart), and we will **measure**
what that sustains (E8 density/saturation, E9 deployment-tier comparison against the same model stub).
This realizes the deployment-model slice that ADR-0032's follow-up defers, including
[#55](https://github.com/rossoctl/moca/issues/55)'s shift of overload handling from
pod-level to session-level, which lands as supervisor admission control.

**The supervisor hands off accepted sockets over IPC and never touches a response byte.** This is the
load-bearing choice. A byte-proxying supervisor would place its own event loop inside the very ceiling
E8 exists to find — every SSE chunk of every concurrent turn crossing it — so a knee could be the
supervisor's with no way to tell. Hand-off removes that confound structurally rather than by careful
measurement, and it also settles the supervisor's language: with no bytes on the hot path, Node is
sufficient and a Go supervisor would buy a second language boundary for nothing.

**The worker is a second entry point, not a rewrite.** `server.ts:576-577` already separates `handler`
from the listener; the worker builds `createServer(handler)`, never calls `listen()`, and emits
`'connection'` for each received socket. The only change the Kubernetes path sees is `handler` gaining
an `export`, so Knative behaviour is unchanged by construction rather than by testing.

**Routing is least-in-flight behind a `RoutingPolicy` seam**, mirroring `orderByLoad` — P2's
least-loaded-under-a-cap discipline applied one tier up. Sticky affinity is a **sweep variant**, so
E8 prices warmth empirically instead of us assuming it. Sticky keys on an `X-SH-Session-Id` **header**
set by the sweep driver, not on the body's session id, because that id is read from the JSON body
(`server.ts:93-101`) and `/turn` is matched on exact URL equality (`:564`) — parsing the body in the
supervisor would put bytes on the accept path and undo the hand-off decision above. Hand-off also makes
routing **connection-scoped for every policy**: the supervisor inspects a connection once and then holds
nothing, so sticky's key is the _first_ request's id, and least-in-flight buys load-aware _initial_
placement rather than per-request balancing. E8 therefore runs **both** arms at the same
connections-per-session and records it per rung, so the arms differ only in which worker gets chosen.
The consequence for sticky is that it is measurable but not adoptable without two client-contract
additions — the header, and not multiplexing sessions over one connection — which the finding must state.

**We add exactly one platform seam** — `SH_SANDBOX_DISCOVERY=pods|records|both`, defaulting to today's
behaviour — and explicitly **no `PlatformAdapter`**: each Kubernetes dependency is a different kind of
thing, several already have a seam, and two need nothing.

Round one claims **density and scalability only**, on two axes kept apart: **concurrent in-flight
turns** (the resource-consuming quantity, which the knee applies to) and **sessions addressable** (a
Redis capacity statement, not a density claim).

## Alternatives considered

- **A streaming reverse proxy in the supervisor** — the conventional shape, and it forecloses the
  measurement: the supervisor's event loop becomes an unattributable term in every rung of E8.
- **Node's `cluster` module** — gives socket sharing and restart for free, but schedules round-robin at
  connection level with no load awareness, no central admission control (so #55 has nowhere to live),
  and no way to route by session, which forecloses the affinity knob.
- **One process, event-loop mux, no supervisor** — cheapest and maximally dense per process, but one
  event loop uses one core so it cannot use the VM, and `output-guard.ts:91`'s `process.exit(1)` makes
  one session's write error a whole-host outage. Retained as E8's W=1 rung, not as the architecture.
- **Sticky affinity as the default** — better p95 and a bigger headline number, but E2 says the session
  log is ~900 bytes while the config bundle is megabytes, so the benefit is empirical; defaulting to it
  would make the density figure partly a statement about cache warmth.
- **Multi-VM placement from the start** — buys a horizontal claim and is where "we rebuilt Kubernetes,
  worse" lives: discovery, health, placement and rebalancing, before the single-host number is known.
- **Replacing Kubernetes outright** — cheapest to maintain, but discards the OpenShift deployment
  story, the reproducible Knative/KEDA evidence, and the E9 comparison arm that gives this slice its
  most useful number.
- **A `PlatformAdapter` god-interface** — invents a symmetry the coupling does not have.
- **Catching `kubectl`'s `ENOENT` instead of a discovery selector** — turns a broken `kubectl` on the
  cluster path from a diagnosable error into a silently empty pool.

## Consequences

- Positive: the VM path needs **two new components and one new seam**; everything below the worker line
  — relay, Go sandbox worker, Redis presence, leases, transports — is reused unchanged.
- Positive: Knative's cold-start term leaves the measured ceiling, and E9 quantifies what the
  deployment tier was costing, with the model tier held constant across both arms.
- Positive: the Kubernetes path is preserved and **used**, not merely kept — it supplies E9's
  comparison arm and stays the horizontal-scale story.
- Positive: #55's session-level overload handling gets a concrete home for the first time.
- Negative / accepted cost: P5 must land its credential scrub as a **shared function** both entry
  points call rather than inline in `server.ts` — a cross-track dependency, coordinated rather than
  duplicated.
- Negative / accepted cost: **round one is single-host.** No horizontal story off Kubernetes, by
  choice.
- Negative / accepted cost: **hardening regresses relative to the pod.** systemd directives approximate
  non-root / read-only-rootfs / seccomp, and NetworkPolicy egress control has no cheap single-host
  equivalent (Z2/Z5). Round one claims no isolation property; the sandbox keeps its container boundary.
- Negative / accepted cost: E8's headline number depends on a **stub model tier**, so it is a statement
  about harness capacity at a stated profile, not about end-to-end throughput against a real provider.
  A `V_LIVE=1` real-model run validates the path but does not produce the number.
- Negative / accepted cost: a worker crash costs S in-flight turns rather than one. Sessions survive in
  Redis (E4) and the supervisor restarts, but the blast radius per process grows with S — which makes
  P5's `output-guard` reachability pin and its `cwd` pin matter more here than on the 1:1 path.
- Follow-up owed: async-leaf and cron on the VM (the `--role` flag exists; the experiment does not);
  cost / resource-seconds accounting; `/resources` and the MU1 control plane on this substrate;
  multi-VM placement, if the single-host number justifies it.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
