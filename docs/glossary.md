# Glossary

Canonical definitions for the two identity terms the harness actually uses. See
[#279](https://github.com/rossoctl/moca/issues/279) for the decision that produced
this doc.

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
  `POST /run-leaf` (`packages/knative-server/src/server.ts`) — kept as-is because the scripts
  under `deploy/knative/` already call them and a second rename cycle isn't worth the churn.

If a genuine grouping identity is ever needed inside the harness (e.g. parent/child lineage for a
leaf dispatching a child leaf), it should be named `parentSessionId`, not `runId`.
