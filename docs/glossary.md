# Glossary

Canonical definitions for the terms moca uses. `session` and `turn` are the two identity terms the
harness actually uses (see
[#279](https://github.com/rossoctl/moca/issues/279) for the decision that produced
them); the rest name the parts of the runtime and its contracts. P6 and P4 are milestone IDs: P6 is
the process-manager runtime, P4 the microVM sandbox tier.

## session

The durable, owned, resumable unit of work. `session_id` is the one identity the harness treats
as load-bearing: it is the Redis-backed idempotency key ([MVP leaf-session contract
design](specs/2026-06-26-mvp-leaf-session-contract-design.md) §2.1), it survives process/pod
restarts (`harness/src/run-leaf.ts`), and it is the sole key in the multi-user ownership model
([multi-user control-plane design](specs/2026-09-08-multi-user-control-plane-design.md) §7.2:
`sh:cp:session:<sid>`, `sh:cp:owner:<subjectHash>:sessions`).

## turn

One exchange within a session — `POST /turn` executes a single interactive turn and can stream
incrementally, as opposed to running a session to completion in one call. See the [turn SSE
streaming design](specs/2026-08-26-turn-sse-streaming-design.md).

## `run`

Not a harness concept. Historically the word was reused for three different things — an
orchestrator-level batch id, a sandbox-lease field that duplicated `session_id` under a different
name, and the "run to completion" vs. "one turn" execution-mode distinction — which is what #279
tracked down and eliminated. Batch grouping (e.g. `"<run_id>/<item_id>"` composed into a
`session_id`) remains a caller-side naming convention the orchestrator owns; the harness itself
treats `session_id` as opaque and holds no separate "run" identity.

`run` survives only:

- As an English verb ("run to completion" vs. "one turn").
- In the frozen, legacy data-plane route names `POST /runs` and its deprecated alias
  `POST /run-leaf` (`packages/knative-server/src/server.ts`) — kept as-is; a second rename
  cycle isn't worth the churn.

If a genuine grouping identity is ever needed inside the harness (e.g. parent/child lineage for a
leaf dispatching a child leaf), it should be named `parentSessionId`, not `runId`.

## leaf

One unit of agent work dispatched by an external orchestrator over `POST /runs`: parameterized, run
to completion in a tooled sandbox, returning a structured result. A leaf is addressed by a
`session_id` like any other session. The contract is _re-entrant_ in the sense that a leaf can dispatch a
child leaf through `/runs`; re-invoking the same `session_id` re-runs and overwrites. See
the [leaf-session contract](specs/2026-06-26-mvp-leaf-session-contract-design.md). Contrast `turn`,
which is one interactive exchange on `POST /turn`. Under P6 a `--role=leaf` worker role is reserved for queued leaf work, but it is not
implemented yet (the worker exits 2 for any role but `turn`), and async leaf dispatch has no P6
equivalent.

## archetype

A dispatch pattern an orchestrator can use against the same backend. **A** is async fan-out
(`async: true`, a Redis Streams queue, many leaves at once), **B** is the human gate (a leaf pauses
with status `paused` and resumes on an external verdict), **C** is scheduled dispatch (a cron
trigger posts async leaves). B is served by the P6 runtime; A and C were removed with the
Knative/KEDA path. See the [README](../README.md#dispatch-archetypes).

## brain and hands

The agent's reasoning and session logic (the _brain_: model calls, the conversation, tool selection)
run in a worker process; every tool or command executes in a separate sandbox (the _hands_). The
agent never executes tools in its own process.

## supervisor

The P6 process manager. It accepts connections on an L4 listener and hands each accepted socket to a
worker, and never touches a response byte
([ADR-0034](adrs/0034-vm-process-manager-socket-handoff.md)).

## worker

A process forked by the supervisor that runs the model loop and serves many sessions, with a bounded
number of concurrent turns each (`SH_TURNS_PER_WORKER`). Workers and the supervisor are the same
image. The worker entry point lives in `packages/knative-server/src/worker.ts`; the package name is
historical. Not to be confused with a sandbox worker (below).

## sandbox

The isolated environment where a session's tools run. Two tiers exist: a container, and (P4) a
Firecracker microVM per `Exec`. A sandbox runs a `remote-worker` process that dials out to the relay,
so it needs no inbound route ([ADR-0024](adrs/0024-sandbox-transport-remote-exec.md),
[ADR-0035](adrs/0035-per-exec-microvm-warm-standby.md)). On the removed Knative path a sandbox was
the single pod reached with `kubectl exec` (`sandbox-0`).

## relay

The sandbox relay (`packages/sandbox-relay`) bridges a worker's `Exec` calls to the sandbox's
outbound `Attach` gRPC stream and mirrors connected sandboxes into the Redis pool. Sandboxes attach
to one port; the harness's workers call `SandboxExec` on a separate listener (loopback on a VM, the
brain network in Compose, a cluster service on Kubernetes).

## tier and affinity

A **tier** is an operator-defined sandbox class (for example `container` and `microvm`), advertised
by a sandbox worker as the `moca.dev/tier` label and declared with `SH_SANDBOX_TIERS` and
`SH_SANDBOX_DEFAULT_TIER`. A session picks its tier once, at creation, and never changes it.
**Affinity** keeps a session on the same sandbox as its previous turn; if that sandbox is gone longer
than a grace period the turn moves within the tier and a workspace reset is recorded
([P6.3 design](specs/2026-10-04-p6-on-kubernetes-slice3-design.md)).

## control plane

The multi-user service (MU1) that handles login, session ownership and credential issuance, and
exchanges a user's session token for the credentials a turn needs. `mocactl` is its terminal client
([ADR-0033](adrs/0033-multi-user-control-plane.md)).

## config bundle

A content-addressed tar built by `@moca/config-bundle` from a user's `.claude` skills and commands,
the `CLAUDE.md` chain and the memory index and files (under `context/`), that a session or leaf runs
with, referenced by digest (`configRef: sha256:…`). Built and credential-scanned client-side;
see [Promoting a local Claude Code workflow](guides/promote-claude-workflow.md).

## human gate

A pause point in a leaf: it stops (status `paused` on `/runs`) and resumes or terminates on an external approve, reject or abort verdict
([human-gate design](specs/2026-06-28-human-gate-design.md)). Archetype B. The early archetypes
requirements doc describes B as an iterative role-based loop; this glossary follows the README and
the human-gate design. There is no human-gate path on `/turn`.

## handler

The HTTP request handler in `packages/knative-server/src/server.ts` that serves `/turn`, `/runs` and
the other routes. The P6 worker serves the same handler, which is why the package name is historical.
