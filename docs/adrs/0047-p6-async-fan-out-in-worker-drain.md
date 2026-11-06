# ADR-0047: P6 async fan-out is a drain loop inside the turn worker, sharing its admission budget

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-11-05
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-11-05-p6-async-fan-out-design.md`](../specs/2026-11-05-p6-async-fan-out-design.md)
- **Supersedes:** [ADR-0015](0015-async-leaf-completion.md) (KEDA ScaledJob over Redis Streams),
  which [ADR-0041](0041-deprecate-knative-keda-deployment.md) had already superseded as a deployment
  model. This record replaces the capability ADR-0041 left owed.
- **Issue:** [#686](https://github.com/rossoctl/moca/issues/686) (epic),
  [#386](https://github.com/rossoctl/moca/issues/386) (this record and its spec)

## Context

Async fan-out — Archetype A of [`../concepts/dispatch-archetypes.md`](../concepts/dispatch-archetypes.md)
— is submitting N leaf turns that run later, draining them at a concurrency cap below N, and
collecting per-leaf results. Its only implementation was `leaf-job.ts`, a Redis Streams drainer run
as a KEDA `ScaledJob`, and it existed on the Knative/KEDA deployment path alone.

ADR-0041 deprecated that path on 2026-10-11 and recorded the loss as an accepted cost: "async leaf
dispatch (the KEDA drainer) and the CronJob scheduled on-ramp have no P6 equivalent yet — ADR-0034
flagged both as owed, and they still are." #490 confirmed no remaining user depended on it, so #691
removed it on 2026-11-05 — the drainer, `@moca/work-queue`, and the enqueue route, which now answers
`400 async_removed`.

P6 therefore has no async path at all. Workers are purely reactive: each is an HTTP server that never
calls `listen()` and only accepts sockets the supervisor hands it over IPC. Nothing in the codebase
pulls its own work. The execution lane survived intact — `runLeaf`, `leaf-result-store` and the
run-lease reaper are all live behind synchronous `/runs` — which is why the removal was survivable and
what this decision builds on.

Two live constraints shape the answer. The supervisor admits turns against `SH_TURNS_PER_WORKER`
using a per-worker `TurnCounter` the worker owns and the supervisor reconciles from. And the shutdown
budget is small: `SHUTDOWN_GRACE_MS` is 20 s against a `MOCA_TURN_MAX_S` of 1800 s.

## Decision

**Async fan-out is a drain loop that runs inside the ordinary turn worker and takes its slots from
the same `TurnCounter` as interactive turns.** Submission is an authenticated control-plane API; the
queue carries a turn id and nothing else; the leaf's credentials are minted when a worker claims it.

- **One queue, one consumer, one trust model.** Both callers the epic anticipates — an operator's
  `mocactl` and an LLM coding agent spawning subagents (#378/#387) — enqueue through the same
  authenticated, owner-scoped API: `POST /v1/sessions/{id}/turns {async:true}` → `202 {turnId}`. The
  trust model is uniformly "assume a misbehaving client," because the archetypes spec's assumption of
  a deterministic non-LLM orchestrator (§5.1) no longer holds.
- **The data-plane route stays removed, permanently (#687).** It is unauthenticated when
  `SH_REQUIRE_AUTH` is off, which is the second trust model the point above rules out. `async_removed`
  gains a pointer to the authenticated path and to this record. A controller that needs fan-out holds
  a service-account credential.
- **Shared admission, no reserved headroom.** The loop claims an entry only while
  `counter.inFlight < SH_TURNS_PER_WORKER`, through the same idempotent `counter.start()` contract the
  handler uses. The supervisor needs no change: `onChange` already sends the `load` IPC, and
  `reconcile` already treats the worker as authoritative over its own count. **The slot is taken in
  the same tick as the check, before the blocking claim** — `claim()` ends in `XREADGROUP BLOCK`, and
  checking the cap then awaiting it would leave the worker looking free for `blockMs` while the
  supervisor keeps handing it sockets, so the loop's `start()` could land one above the cap. Taking
  first costs apparent busyness for up to `blockMs` instead, which `reconcile` already measures as
  `spurious_refusals`; a measured refusal is the safer error than a worker running `cap + 1` turns.
- **No credential in the queue.** At claim the worker presents its own identity plus the turn id; the
  control plane loads the turn record it owns, resolves a credential _name_ against the owner's
  subject document, and mints an inference grant and a sandbox grant (MI1 §6.5). "Turn start" for
  `turn_exp` is **dequeue**, not enqueue — a leaf that waited an hour must still get its full
  `MOCA_TURN_MAX_S`.
- **A per-turn `turn_exp` that can only tighten, clamped at mint.**
  `turn_exp = dequeue + min(caps.wallClock ?? MOCA_TURN_MAX_S, MOCA_TURN_MAX_S)`. #386 item 5 asks
  for a policy allowing "hour-long detached turns within a bound"; today's bound is 1800 s, so an
  hour is an **operator** decision — raising `MOCA_TURN_MAX_S` — not a caller's. A caller asking for
  more is clamped rather than refused, because the ceiling is a deployment property and a refusal
  would make it a negotiation. The clamp lives in the control plane at mint, never in a value the
  worker or the caller supplies, since §3 assumes a misbehaving client and an unclamped request
  would hand that client control of its own credential's lifetime.
- **The turn record outlives its result.** Its TTL is `LEAF_RESULT_TTL_SECONDS` plus a margin, set
  when the turn goes terminal, not at creation; a non-terminal record carries no TTL and the
  reaper's `lost` transition is what guarantees every record eventually becomes terminal. Deriving
  the record's TTL from the result's keeps one knob: raising retention moves both. The inverse
  ordering would reintroduce the queued/never-submitted conflation this record rejects elsewhere —
  a succeeded turn answering `404` because its record expired first.
- **On drain, abandon without acking.** The loop stops claiming, the in-flight leaf is left pending
  for `XAUTOCLAIM` to reclaim, and the slot is released so `awaitIdle` exits early. Delivery is
  at-least-once and the idempotency key makes redelivery safe.
- **Status is read from the turn record on a new route; `GET /runs/status` is untouched.**
  `GET /v1/sessions/{id}/turns/{turnId}` answers from the record, so queued, never-submitted (`404`)
  and reaped-as-`lost` are distinguishable. The existing route infers status from the _result store_
  — no record answers `{status:'queued'}` — which conflates all three, and extending it would change
  a live route's responses on top of the admission change below. Two routes, one source of truth
  each.
- **Cancellation covers `queued` turns only.** `DELETE` on the turn flips a queued record to
  `cancelled` and the drain loop skips it at claim; a `running` leaf runs to completion and the call
  answers `409`. Interrupting a running leaf needs a cancel signal addressed to one specific worker,
  which does not exist for async — interactive cancel (ADR-0040) rides the turn's own connection.
- **Revive `packages/work-queue` _and_ `harness/src/leaf-job-runner.ts` from `38aa2146`** behind the
  existing `WorkQueue` interface, with the KEDA-era parity audit (#689) recorded below rather than
  assumed. The runner is not optional detail: its `processOne` holds the `touch` heartbeat that keeps
  a long leaf's claim alive. `minIdleMs` is 90 s against a 1800 s `MOCA_TURN_MAX_S`, so without it a
  leaf running past 90 s is reclaimed **while still running** and two workers execute one turn —
  idempotent in its result, but double-spent in budget and sandboxes. Only the runner's
  exit-between-entries outcome vocabulary needs rework for a long-lived loop.
- **Reclaim is periodic and armed by every worker.** The removed drainer reaped once at process start
  and GC'd idle consumers so KEDA could scale to zero; neither trigger exists when workers are
  long-lived and nothing scales to zero. `reapDeadLetters` and `gcIdleConsumers` move onto a timer
  every worker arms — the shape `run-lease.ts`'s `reapOrphanedRuns` already uses for sandbox leases,
  with claim-based mutual exclusion so N reapers cannot double-finalize one entry. The consumer id is
  **`moca-${HOSTNAME}-w${SH_WORKER_ID}`**: `SH_WORKER_ID` alone is the pool _slot index_
  (`String(id)`, reused across an in-place restart, which is the stability wanted) and so repeats
  across supervisor replicas, which `deploy/k8s/base/supervisor.yaml` names as the way to add
  capacity — two live workers sharing one consumer name would share a PEL and share the idle and
  pending numbers `gcIdleConsumers` decides on. No worker gets priority on its own abandoned
  entries: `claim()` is `XAUTOCLAIM` over the whole group PEL at `minIdleMs` and never reads its own
  PEL from `0`, so an abandoned entry waits out `minIdleMs` and then goes to whichever sweep reaches
  it first — which is all redelivery needs.
- **The mint at claim refuses only `cancelled` and terminal records, not "not `queued`".** The first
  claim sets `running`, so every redelivery — crash-reclaimed, drained, or a `retryable` outcome
  returned unacked — arrives on a record that already says `running`. Refusing those would ack and
  drop them, defeating crash survival in the case it exists for and stranding a record in `running`
  with no TTL and no entry left for the reaper. `queued → running` is a compare-and-set; attempt
  exhaustion stays the queue's `deliveryCount`, checked before the mint, so there is one authority
  for it rather than two that can disagree.
- **Unbounded fan-out is bounded by a per-owner queued-turn quota**,
  `MOCA_ASYNC_QUEUED_PER_OWNER` (default 50), counting non-terminal turns and enforced in the control
  plane before the enqueue, `429 async_quota_exhausted`. It reads the per-owner zset the turn record
  already lives in, so there is no second index to drift. It is the one containment against the
  misbehaving submitter the trust model assumes, so it ships in M1 with the path it protects.
  Distinct from `SH_TURNS_PER_SUBJECT` (#360), which is per worker and in-process and bounds turns
  _executing_; a per-worker in-memory counter cannot bound a queue it does not hold.
- **Delivery in three milestones.** M1 is a working drain on `deploy/vm`/compose, gated to
  `MOCA_TENANCY=single`. M2 implements `turn_exp`, completes grant-at-dequeue, and lifts the gate.
  M3 is `deploy/k8s` manifests and a queued-leaf smoke test.

### The M1 tenancy gate is a dated conditional refusal

M1 refuses async submission under `MOCA_TENANCY=multi`, by name, with the reason. This is a stated
condition with a lifting criterion — `turn_exp` implemented and both grant audiences minted at
dequeue (M2) — not an omission to be discovered in production. It takes the shape ADR-0041 used for
its own deprecation window: a floor plus a condition, rather than a state users must infer from
absence of evidence.

### The KEDA-era parity audit (#689)

| KEDA-era behaviour                                      | Verdict                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Scale-to-zero                                           | **Dropped.** ADR-0041 accepted this cost explicitly                                  |
| Queue-depth-driven capacity                             | **Dropped.** Admission is slot-driven, not depth-driven                              |
| `pendingEntriesCount` for the scaler                    | **Repurposed** as an operational metric; nothing scales on it                        |
| Exit-0-when-idle drain semantics                        | **Replaced** by the supervisor's `drain` signal                                      |
| `XAUTOCLAIM` reaper (#17)                               | **Kept.** Crash recovery depends on it                                               |
| Dead-letter past `maxAttempts`                          | **Kept**, mapped to a `lost` turn state                                              |
| `LEAF_RESULT_TTL_SECONDS` (86400)                       | **Kept** as-is; longer retention is owed                                             |
| At-least-once delivery                                  | **Kept.** The claim/ack cycle is unchanged                                           |
| `runLeaf` idempotency on the session id                 | **Kept**, and promoted to the submission-time `idempotencyKey` default               |
| `classifyOutcome` retry classes                         | **Kept and already in tree** — `harness/src/classify-outcome.ts` survived #691       |
| Leaf kinds accepted async (`prompt`/`converge`/`solve`) | **All three kept.** The loop calls `runLeaf`, which dispatches on `kind`             |
| Refusing async workload runs                            | **Kept**, moved to submission time so it stays a synchronous `501`                   |
| `queued` when no result record exists                   | **Not carried**, deliberately: an inference replaced by a record                     |
| Global concurrency cap                                  | **Replaced** by supervisor admission — one slot budget, no separate queue-side limit |
| Per-class concurrency caps                              | **Not carried.** Archetypes §2 wants them; recorded as a gap; #360/#391 own quotas   |
| Queue-depth and leaf-outcome metrics                    | **Kept and expanded** to seven counters on the supervisor's admin `/metrics`         |

`classifyOutcome` is the one piece of the async contract #691 left standing — `run-leaf.ts` and
`select-sandbox.ts` still explain their behaviour in terms of it. The drain loop is its first caller
since the removal, so its retry classes need no revival: `failed/error` and `failed/saturated` stay
retryable and everything else acks. Dropping the `queued`-when-absent inference is the one parity
item where matching the old behaviour would itself have been the defect, since it conflates queued,
never-submitted and reaped-as-lost.

### Alternatives considered

- **Dedicated leaf workers via the reserved `--role=leaf` seam.** Cleaner blast radius: a drain bug
  could not reach interactive turns. Rejected because it creates **two capacity budgets that must be
  reconciled** — `SH_TURNS_PER_WORKER` against a separate leaf concurrency — and because the
  supervisor would need a new concept of a child it supervises but never routes to. #686's acceptance
  asks for draining _inside_ admission; two budgets is the definition of alongside it. The seam stays
  reserved and unconsumed.
- **A separate counter for leaves in the same worker.** Would make `SH_TURNS_PER_WORKER` undercount
  true load and over-admit — the failure `TurnCounter`'s own idempotent-`end` comment warns about,
  reached by a different door.
- **Restore `POST /runs {async:true}` as well (#687).** Two submission paths means every safety
  property is enforced twice and can diverge once, on the path that is unauthenticated by default.
  Rejected.
- **Reserve headroom for interactive turns.** A second number to tune, and the two-budget shape
  again. Not added before a measurement asks for it.
- **Extend `GET /runs/status` to serve async callers too.** One route for both, and it would fix the
  queued/never-submitted conflation for existing synchronous callers as well. Rejected because it
  changes a live route's responses, and this decision already imposes one behaviour change on the
  synchronous path (the admission fix below); two is a migration rather than a cost.
- **Full cancellation, including running leaves.** Rejected for this design as new
  control-plane-to-specific-worker machinery; the per-turn caps already bound how long a leaf runs,
  so it is a latency improvement, not a containment property. Recorded as owed.
- **Abort the in-flight leaf on drain, as `armDetachedDrain` does for a detached interactive turn.**
  An interactive turn aborts because a client is waiting on a stream; nobody waits on an async leaf,
  so redelivery is strictly better. A 1800 s leaf cannot finish in a 20 s grace window regardless.
- **Rewrite the queue rather than revive it.** 261 lines plus 319 lines of tests, none of it
  Knative-specific — plain Redis Streams behind a `WorkQueue` interface. Rewriting re-derives the same
  calls with fresh bugs.
- **Scale-to-zero by some other mechanism.** Out of scope: ADR-0041 traded it away deliberately.

## Consequences

- Positive: async fan-out returns to a P6 deployment, closing the capability ADR-0041 listed as owed
  and unblocking anyone who could not finish migrating.
- Positive: leaves are admitted by the same budget as interactive turns, so one knob
  (`SH_TURNS_PER_WORKER`) describes a worker's whole load — lighter than KEDA, which was a second,
  blind capacity system beside the first.
- Positive: no bearer token is ever written to the queue, and a queue entry read by something that
  should not have it yields an opaque id.
- Positive: Archetype C (cron, #536) inherits the identity answer and the whole queue-and-drain
  substrate; only the schedule is left to design.
- Negative / accepted cost: **workers stop being purely reactive.** A fault in the drain loop shares
  a process with interactive turns. Contained by the same thing that contains a handler fault — the
  supervisor's restart backoff — with the abandoned entry reclaimed on redelivery.
- Negative / accepted cost: **a full queue can occupy every slot**, so an interactive `/turn`
  arriving then is refused with `429`, exactly as it would be behind other interactive turns. Per-class
  caps are the knob to reach for if that proves wrong.
- Negative / accepted cost: **a deterministic controller must now hold a credential**, which on the
  old unauthenticated data-plane path it never did.
- Negative / accepted cost / **behaviour change on a live path**: all three synchronous leaf aliases
  (`/runs`, `/run-leaf`, `/v1/runs`) are brought into the turn counter, fixing a pre-existing
  over-admission defect — they occupy no slot today. Deployments at their admission ceiling will see
  `429`s they previously would not have. This is the correct answer and was always
  `SH_TURNS_PER_WORKER`'s intent, but it is a change operators must be told about, not folded in
  silently.
- Negative / accepted cost: at-least-once delivery means a leaf can run twice. Effectively-once rests
  on the idempotency key and on `runLeaf`'s existing retry contract, not on the queue.
- Negative / accepted cost: **nothing watches the queue as a side effect any more.** KEDA's scaler
  read `pendingEntriesCount` because it acted on it; slot-driven admission removes the actor and with
  it the observation. Depth, oldest-entry age, claims, reclaims, dead-letters, claims-denied-when-
  full and quota refusals must therefore be reported deliberately, on the supervisor's admin `GET /metrics`
  JSON body. They ride the advisory `stats` IPC row, which stays advisory: telemetry only, never an
  input to admission or routing.
- Negative / accepted cost: a queued turn can be withdrawn but a running one cannot, so a caller who
  submits a long leaf by mistake waits for its cap to expire.
- Follow-up owed: `turn_exp` is specified in MI1 §6.1 but **implemented nowhere in TypeScript** —
  expiry today is always `exp = iat + ttlSeconds`. #388 is larger than it reads, and this is where the
  M1/M2 split comes from, and the clamp above is where the policy lands when it is built. One
  question inside it stays open and belongs to #388: whether refresh past `turn_exp` is refused
  outright (MI1 §6.2's current rule, and what M2 should ship) or whether a provably-still-running
  leaf may extend once — the §6.2 heartbeat is what such an extension would key off, since it
  already proves liveness. Also owed: cancelling a running leaf; result retention beyond 24 h and
  richer artifacts; per-class concurrency caps, for which `async_claim_denied_full` against
  interactive `429`s is the measurement that would justify them; `/v1/batches` (#537) once a working
  fan-out exists to measure against; the documentation updates in #690 (ADR-0041's "Still owed" note,
  the Archetype A row, the `async_removed` entry); and the wording amendment where MU1 §4.2 and MI1
  §6.5/§10 still say "owned `/v1/runs`" against #279's resolution.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
