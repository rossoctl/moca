# P6 Async Fan-Out — Design

Version: 1.7 — November 10, 2026
Status: Proposed (M1 submission and dequeue-exchange slices built; §9.2 records the drain loop's
implementation decisions and one correction to §5.5)
Issue: [#686](https://github.com/rossoctl/moca/issues/686) (epic); this document is the deliverable
of its gating child [#386](https://github.com/rossoctl/moca/issues/386) (B1: spec + ADR)
Decision record: [ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md)
Supersedes in substance: [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md)
(the KEDA ScaledJob substrate, deprecated by ADR-0041 and removed by #691)

Scope: how a caller submits many leaf turns without waiting, how a P6 worker drains them under the
same admission budget as interactive turns, how a leaf gets its credential at dequeue without a
bearer token in the queue, how status and results are read back, what can be cancelled, what is
measured, and what proves it. Covers all three P6 deployments (`deploy/k8s`, `deploy/vm`,
`deploy/compose`).

> **What this is not.** Not the cron on-ramp (Archetype C, #536), though §11 states what that design
> inherits from this one. Not batch execution (`/v1/batches`, #537), which is decided once a working
> fan-out exists to measure. Synchronous `POST /v1/runs` and interactive `POST /v1/turn` keep their
> current contracts, with one deliberate exception recorded in §5.3.

---

## 1. Problem

Async fan-out — Archetype A of
[`docs/concepts/dispatch-archetypes.md`](../concepts/dispatch-archetypes.md) — means submitting N
leaves that run later, draining them at a concurrency cap below N, and collecting per-leaf results.
It is how an orchestrator dispatches work that runs for minutes without holding N long-lived HTTP
connections.

Before #691 the only consumer was `packages/knative-server/src/leaf-job.ts`, a Redis Streams drainer
run as a KEDA `ScaledJob` (ADR-0015). It existed only on the Knative/KEDA deployment path. ADR-0041
deprecated that path on 2026-10-11 and listed the consequence in writing:

> async leaf dispatch (the KEDA drainer) and the CronJob scheduled on-ramp have no P6 equivalent yet
> — ADR-0034 flagged both as owed, and they still are.

#490 polled the remaining users; none claimed a dependency on async fan-out, so #691 removed the
path on 2026-11-05 without a replacement. `POST /runs {async:true}` now answers `400 async_removed`.

**State on `main` at `f699f7f9`.** P6 has no async path at all:

- `packages/work-queue` is deleted (commit `d8329df8`). Its last state is `38aa2146`.
- The supervisor forks only `--role=turn`. `--role=leaf` is a reserved seam that exits 2:
  `--role=${role} is not implemented in round one; only --role=turn is` (`worker.ts:270-275`).
- No worker pulls its own work. Every worker is `createServer(wrappedHandler)` that never calls
  `listen()`; its sole job is to accept sockets the supervisor hands it. There is no polling loop
  anywhere in the codebase.
- `LeafEnvelope.async?: boolean` survives as a dead field — nothing reads it. The refusal in
  `server.ts` tests the raw parsed body, not the typed envelope.

What did **not** go away is the execution lane: `harness/src/run-leaf.ts`, `leaf-result-store.ts` and
the run-lease reaper are all live behind synchronous `/runs`. That is why the removal was survivable,
and it is the foundation this design builds on rather than replaces.

---

## 2. Goals and non-goals

**Goals** (from #686's acceptance):

1. Submit N leaves without waiting.
2. Drain them with bounded concurrency **inside supervisor admission** — not alongside it.
3. Survive a worker crash or restart with at-least-once delivery that completes effectively once.
4. Collect per-leaf results.
5. Work on `deploy/k8s` and on `deploy/vm`/`deploy/compose`.
6. A recorded decision on data-plane `/runs {async:true}`: restored, replaced, or permanently
   removed.

**Non-goals.** Scale-to-zero. ADR-0041 accepted its loss as the headline cost of the P6 cutover:
capacity scales by adding process-manager pods or sizing them up, and idle capacity costs memory
continuously. Nothing here tries to recover it, and §10 records what else from the KEDA path is
deliberately dropped.

---

## 3. The submitter question, and why there is one queue

#686 and #386 assume different callers, and the difference is not cosmetic.

The archetypes spec's first cross-archetype invariant (§5.1) is explicit:

> A deterministic, non-LLM outer orchestrator. State machine / staged scripts / scheduler. The LLM
> is always a **leaf**, never the controller.

Its §6 is blunter still — for bulk fan-out, Archetype A **rejected** agent-managed subagents: the
subprocess pool "replaces ask the main agent to spawn N sub-agents in its own context."

But #386 is item B1 of the coding-agent subagents epic (#378), where the submitter _is_ an LLM. Its
own item 8 names the collision: "Archetypes §5.1 expects a deterministic, non-LLM orchestrator, and
an LLM coding agent is neither, so every safety property must hold with a misbehaving client."

**Decision: one queue and one consumer, with submission as a thin authenticated layer above them.**
Both callers enqueue through the same authenticated API, and the trust model is uniformly "assume a
misbehaving client." The alternative — two submission paths with two trust models — would mean every
safety property in §6 is enforced twice and can diverge once.

The cost is real and is accepted: a deterministic controller must now hold a credential, which on the
old unauthenticated data-plane path it never did. This is the same "who does a job with no
interactive user run as" question #536 faces for cron, and §11 keeps the two answers aligned.

---

## 4. Submission

### 4.1 The API

```
POST /v1/sessions/{sessionId}/turns
  { kind, prompt | item | problemStatement, repoUrl?, ref?, async: true, idempotencyKey? }
  → 202 { sessionId, turnId }
```

Authenticated, owner-scoped, async on the **turn** rather than at session creation — a session may
mix interactive and async turns, and binding `async` to the session would forbid that for no gain.

There is no `run` noun and no second `/v1/runs`, per #279's resolution. MU1 §4.2 and MI1 §6.5/§10
still say "owned `/v1/runs`"; this design amends that wording (§12).

`202` rather than `200`: the work is accepted, not done. The response carries the `turnId` the caller
polls, and nothing else — no result, no partial state.

One refusal carries over from the removed route: an async turn naming a `workloadId` answers
`501 workload_runs_unavailable` at submission, before admission and before enqueue. §4.2 has the
reasoning.

### 4.2 Data-plane `/runs {async:true}`: replaced, not restored (#687)

**Decision: it stays removed, permanently, and `async_removed` names the authenticated path as its
replacement.**

The route is unauthenticated when `SH_REQUIRE_AUTH` is off, which is exactly what the one-queue
decision in §3 rules out: restoring it would reintroduce the second trust model. A controller that
needs fan-out holds a service-account credential and uses §4.1.

This closes #687 as "replaced". The refusal message gains a pointer, replacing today's dead end:

```
async leaf dispatch was removed with the Knative/KEDA deployment path (ADR-0041).
Use POST /v1/sessions/{id}/turns with async:true (authenticated). See ADR-0047.
```

#687 asks how the decision interacts with three specific things, and each answer is load-bearing
rather than incidental:

- **`MOCA_TENANCY=single`.** The removed route was reachable precisely when nobody authenticated, so
  the obvious reading of "single tenancy" is that it should come back there. It does not. Single
  tenancy means one _subject_, not no subject: the credential is the operator's ambient one, and
  §5.4 resolves it from the turn record at dequeue. The authenticated path works under `single`
  — that is exactly what M1 ships (§9.1) — so the unauthenticated route has no niche left to fill.
  What `single` changes is whose credential runs the leaf, not whether a caller must present one.
- **`LEAF_RESULT_TTL_SECONDS`.** Unchanged, and shared. The result store is keyed by
  `leafSessionId` (§5.5) and knows nothing about which route submitted the work, so the 24 h
  retention applies identically to async turns. There is no second _result_ store to reconcile; §10
  keeps the value as-is and §12 owns the longer-retention question. The turn record has a TTL of its
  own, derived from this one rather than tuned separately (§5.1).
- **The rule refusing async workload runs.** This one is a real behavioural carry-over, and the
  pre-removal code shows why it was ordered the way it was: `if (parsed.workloadId !== undefined)
return rejectWorkloadRun(res)` sat _before_ the auth gate, deliberately, "so every asynchronous
  run naming a workload gets the same answer" (`38aa2146`, `server.ts:1337-1338`). The refusal is
  `501 workload_runs_unavailable`, and `rejectWorkloadRun` still exists on the synchronous path
  (`server.ts:971`). **The rule carries to §4.1 unchanged:** an async turn naming a `workloadId` is
  refused at submission, before admission and before enqueue, so the refusal is synchronous and the
  caller learns at `POST` time rather than by polling a turn that will never run. Enqueueing it to
  fail at dequeue would convert a 501 into a dead-letter.

### 4.3 Caps, the fan-out quota, and idempotency

Every async turn carries caps resolved at submission and stored on the turn record: tokens, cost and
wall-clock. §6 covers enforcement.

**The per-owner queued-turn quota, which §6.4 leans on and which has to be more than a table row.**
It is the only containment for unbounded fan-out from a submitter §3 assumes is misbehaving, so it is
specified here rather than left to the implementation:

- **`MOCA_ASYNC_QUEUED_PER_OWNER`, default 50.** It joins the control plane's existing per-owner
  limits and follows their naming and shape — `MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER` (default 5) is
  the precedent. The default is a fan-out breadth a legitimate orchestrator stays well inside while
  still bounding a loop that submits without checking.
- **It counts non-terminal turns** — `queued` plus `running` — not lifetime submissions. The thing
  being bounded is concurrent claim on the deployment, and a turn that finished released its claim.
- **Enforced at submission, in the control plane, before the enqueue**, answering
  `429 async_quota_exhausted` with the owner's current count. The record is created and the entry
  enqueued only after the check passes, so a refusal leaves nothing behind: the measurement §8 asserts
  is the queue depth, not the error body.
- **It reads the per-owner zset §5.1 already stores the record in.** `OwnershipIndex`'s owner zset
  is how `listByOwner` avoids an all-tenant keyspace scan (`ownership.ts:209-211`), and a non-terminal
  count is a bounded read of that same key — no second index, and no counter that can drift from the
  records it describes.
- **Distinct from `SH_TURNS_PER_SUBJECT` (#360), deliberately.** That cap is per worker, in-process,
  and counts turns _executing_; this one is per deployment, in Redis, and counts turns _waiting_. A
  per-worker in-memory counter cannot bound a queue it does not hold. Both apply: the quota bounds
  what an owner may enqueue, and #360 bounds what an owner may simultaneously run once drained.

The quota lands in M1 (§9), with the drain loop it exists to protect.

`idempotencyKey` defaults to the session id. A resubmission with a key already in a non-terminal
state returns `202` with the **existing** `turnId` rather than enqueueing a second copy — a
misbehaving client retrying a 202 it already received must not fan out twice.

Two consequences of that default, stated because each could be read the other way:

- **A fan-out of N leaves is N sessions, not N turns in one session.** Each leaf already gets its own
  `leafSessionId` and its own result record, so the default gives each one a distinct key for free,
  and it is the retry contract `dispatch-archetypes.md` already documents for synchronous leaves:
  re-send the same `sessionId`.
- **A session therefore has at most one async turn in flight.** A second submission to a session
  whose async turn is still non-terminal is deduplicated, not queued behind it. That matches
  interactive behaviour, where a session already running a turn answers `409 turn_in_progress`. A
  caller that genuinely wants two queued turns on one session passes distinct `idempotencyKey`s and
  takes responsibility for the ordering, which the queue does not promise.

### 4.4 Reading status and collecting results

```
GET /v1/sessions/{sessionId}/turns/{turnId}
  → 200 { turnId, state, attempts, result?: { status, patch? | text? | gate? | reason? } }
  → 404 unknown turn
```

Authenticated and owner-scoped, like §4.1. The turn record is the **single source of truth for
state**; `result` is the artifact from `leaf-result-store`, present once the leaf has written one.
Goal 4 is satisfied by N of these — one per leaf — which is also the measurement #537 needs before
`/v1/batches` can be judged worth building.

**`GET /runs/status` is deliberately left exactly as it is.** It already exists
(`server.ts:1237-1240`) and infers status _from the result store_: no record answers
`{status:'queued'}` (`:1163`). That inference cannot be reused here, for two reasons:

- It conflates three different situations — queued, never submitted, and reaped-as-`lost` all look
  like "no record yet" — and an async caller polling for minutes needs them distinguished. The new
  route answers from the record, so `404` means never submitted and `lost` is its own state.
- Extending it to consult the turn record would make a **live** route's responses change, on top of
  the admission change §5.3 already flags. One behaviour change on the sync path is a cost worth
  stating; two is a migration.

So the two routes coexist with one source of truth each: `/runs/status` serves synchronous callers
from the result store as it always has, and the route above serves async callers from the record.

### 4.5 Cancellation: queued only

```
DELETE /v1/sessions/{sessionId}/turns/{turnId}  → 202 | 409
```

A `queued` record flips to `cancelled`, and the drain loop skips it at claim — `cancelled` is one of
the two states the mint refuses (§5.4), so a cancelled entry is acked and dropped without running.
The refusal is deliberately narrow: `cancelled` and terminal only, never `running`, because a
redelivered entry's record already says `running` and must still run.

**A `running` leaf is not interrupted.** It finishes and writes its result; the `DELETE` answers
`409` naming the state. This is a deliberate scope line, not an oversight:

- Interrupting a running leaf needs a cancel signal addressed to the one worker holding it.
  Interactive cancel (ADR-0040) rides the turn's own connection, and async has no connection — so
  this is new control-plane-to-specific-worker machinery, not a reuse.
- The per-turn caps of §4.3 already bound how long a leaf can run, so "cancel a running leaf" is a
  latency improvement over waiting for the cap, not a containment property §6.4 depends on.

Cancelling a running leaf is recorded as owed in §12.

---

## 5. Architecture

```
  ┌─ submitter ─────────────────────────────────────────────┐
  │  mocactl / coding agent (#387)   ·   controller (§4.2)   │
  └───────────────────────┬─────────────────────────────────┘
                          │  POST /v1/sessions/{id}/turns {async:true}  → 202 {turnId}
                          ▼
  ┌─ control plane ─────────────────────────────────────────┐
  │  auth · owner scoping · credential store   [exists]      │
  │  turn record (§5.1)                        [new]         │
  │  grant minted at dequeue (§5.4)            [new]         │
  └───────────────────────┬─────────────────────────────────┘
                          │  enqueue { turnId }   ── no credential, ever
                          ▼
  ┌─ queue ─────────────────────────────────────────────────┐
  │  Redis Streams · claim/ack/touch · XAUTOCLAIM reaper     │
  └───────────────────────┬─────────────────────────────────┘
                          │  claim only when a slot is free (§5.3)
                          ▼
  ┌─ turn worker (one process, one budget) ─────────────────┐
  │  wrappedHandler  ──┐                                     │
  │  drainLoop()     ──┴─→ TurnCounter ──→ `load` IPC → pool │
  │                        └─→ runLeaf()            [exists] │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─ results ───────────────────────────────────────────────┐
  │  leaf-result-store, one record per leaf      [exists]    │
  └─────────────────────────────────────────────────────────┘
```

### 5.1 The turn record

The control plane owns it. **The queue carries a turn id and nothing else** — no envelope, no
credential, no config. Everything authoritative is read from the record at dequeue, which is what
makes §5.4 possible and what bounds the damage if the queue is ever read by something that should not
have it.

| Field            | Notes                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `turnId`         | opaque; the only thing in the queue                                   |
| `owner`          | subject string, as `SessionRecord.owner` (`github:<id>`)              |
| `tenant`         | gates M1 (§9)                                                         |
| `sessionId`      | the session the turn belongs to                                       |
| `cfg`            | bundle digest, as on the session                                      |
| `credentialName` | a **name**, resolved server-side at dequeue — never the credential    |
| `caps`           | tokens, cost, wall-clock (§4.3)                                       |
| `idempotencyKey` | defaults to `sessionId` (§4.3)                                        |
| `envelope`       | the `LeafEnvelope` to run                                             |
| `state`          | below                                                                 |
| `attempts`       | written from the entry's `deliveryCount` at claim; descriptive (§5.4) |

```
queued → running → paused | responded | done | solved | failed | cancelled | lost
```

`paused`, `responded`, `done`, `solved` and `failed` mirror `LeafResult`'s existing discriminants, so
a result maps to a state without translation. `cancelled` is a caller's withdrawal of a turn that was
still `queued` (§4.5); it is never reached from `running`. `lost` is the terminal the reaper writes
when the entry's `deliveryCount` exceeds `maxAttempts` (§6.2) — distinct from `failed`, because "we
never found out" is operationally different from "it ran and failed."

`running` is **not** terminal and a redelivered entry re-mints against it, which §5.4 states as a
rule because the narrower "`queued` only" reading of it is a defect: it would drop exactly the
entries goal 3 exists to recover.

**`running` needs no separate heartbeat, and #390 should know why.** #390 scopes "a `running` state
with a heartbeat, plus stale detection (`lost`)" as new work. For async turns the liveness signal
already exists one layer down: the claim heartbeat in §6.2 keeps the queue entry alive, and its
absence is what promotes a turn to `lost` through the reaper. Adding a second heartbeat on the turn
record would mean two liveness signals that can disagree — a record that says `running` while the
entry has been reclaimed, or the reverse. So the record's `state` is written at the queue's
transitions, and `lost` has exactly one author: the reaper. #390's heartbeat scope applies to
turns that are **not** queue-backed, if any exist.

Stored like `SessionRecord`: Redis hash plus per-owner zset, via `OwnershipIndex`. Owner scoping is a
flat subject string on the record, following the existing convention rather than inventing a scope
object (mind #361).

**The record's TTL, which item 2 asks for and which is not the result TTL.** Two different lifetimes
get confused here, so both are named:

- The **result** lives in `leaf-result-store` under `LEAF_RESULT_TTL_SECONDS` (86400). Unchanged
  (§5.5).
- The **turn record** is the thing §4.4 reads `state` from, so it must outlive the result or a
  caller polling a finished turn would get `404` — "never submitted" — for a turn that in fact
  succeeded. That is the same conflation §4.4 rejects in `/runs/status`, reintroduced by a TTL
  mismatch instead of by an inference.

So the turn record's TTL is **`LEAF_RESULT_TTL_SECONDS` plus a margin**, set when the turn reaches a
terminal state, not at creation — a queued turn that waits is not a turn whose record should expire
underneath it. A non-terminal record carries no TTL at all; the reaper's `lost` transition (§6.2) is
what guarantees every record eventually becomes terminal and therefore eventually expires. That
ordering is the invariant worth testing: **a record must never expire while its turn is live, and
must never outlive its own result by more than the margin.**

§12 notes that if #390 raises result retention to 7 days, this TTL follows it rather than being
re-decided — one knob, with the record's margin derived from it.

### 5.2 Where the consumer runs

**Decision: a drain loop inside the turn worker, sharing the existing `TurnCounter`.**

Two candidates were considered. The reserved `--role=leaf` seam would fork dedicated leaf workers:
cleaner blast radius, since a drain bug could not touch interactive turns. It was rejected because it
creates **two capacity budgets that must be reconciled** — `SH_TURNS_PER_WORKER` against a separate
leaf concurrency — and because the supervisor would need a new concept of a child it supervises but
never routes to. Goal 2 asks for draining _inside_ admission; two budgets is the definition of
alongside it.

The accepted cost: workers stop being purely reactive, and a fault in the drain loop shares a process
with interactive turns. §6.4 states what contains that.

`--role=leaf` stays reserved and unimplemented. This design does not consume it.

### 5.3 Shared admission

This is the integration that makes the replacement lighter than KEDA, and it is a small seam.

Today `TurnCounter` is driven from exactly one place:

```ts
const TURN_PATHS = new Set(['/turn', '/v1/turn']);
const counter = new TurnCounter((inFlight) => send({ type: 'load', inFlight }));
if (isTurnRequest(req.method, req.url)) attachTurnSlot(res, counter.start());
```

`start()` returns an **idempotent** end function, with a comment explaining why: a second decrement
"would bias the supervisor's estimate permanently low — silent over-admission forever." The drain
loop uses that same contract — `const end = counter.start()` at claim, `end()` on every exit path.

Because `onChange` is what sends the `load` IPC, and the supervisor's `reconcile` already treats the
worker as the authority over its own count, **the supervisor needs no change at all.** A separate
counter would make `SH_TURNS_PER_WORKER` undercount true load and over-admit.

**When the loop claims.** Only while `counter.inFlight < SH_TURNS_PER_WORKER` — the same cap the
handler path is admitted against, with **no headroom reserved for either side**. One cap, first come
first served. The alternative, reserving k slots for interactive turns, is a second number to tune
and reintroduces the two-budget shape §5.2 rejected; it is not added before there is a measurement
asking for it. The consequence is stated rather than hidden: a full queue can occupy every slot, so
an interactive `/turn` arriving then is refused with `429` exactly as it would be behind other
interactive turns. §12 records per-class caps as the knob to reach for if that proves wrong.

**The slot is taken before the claim, not after it.** "Check the cap, then await a claim, then
`start()`" leaves a window the length of the claim in which the worker looks free. The supervisor
goes on handing it `/turn` sockets against that estimate — `handOff` increments its own copy
optimistically and `reconcile` corrects from the next `load` (`pool.ts:219`, `:442`) — so a handler
can fill the slot the loop was about to use, and the loop's `start()` then lands at
`inFlight == cap`, one above it. So:

```ts
if (counter.inFlight >= cap) { await sleep(idleBackoffMs); continue; }
const end = counter.start();            // same tick as the check; nothing can interleave
let backoffMs = 0;
try {
  const claimed = await queue.claim(consumerId, { minIdleMs });   // NON-blocking
  if (!claimed) { backoffMs = idleBackoffMs; }
  else { ... }
} finally { end(); }                    // idempotent; see `start()`'s own comment
if (backoffMs > 0) await sleep(backoffMs);   // waiting happens WITHOUT a slot
```

The check and the take are one synchronous tick, so **the loop never takes a slot it has not just
observed free** — which is what makes §8's "never observed above the cap" an invariant rather than a
hope. The cost is paid in the other direction: while the claim is in flight the worker reports a slot
busy that is running nothing, so an interactive turn arriving in that window can be refused by a
supervisor that did in fact have capacity. That is already a measured condition rather than a silent
one — `reconcile` stamps it `spurious_refusals` on the next `load` (`pool.ts:454-465`) — and it is
the safer direction to err in, because the opposite error is a worker running `cap + 1` turns.

**The claim does not block, and the wait for work holds no slot.** Those two together are what bound
that window to roughly two Redis round trips. A blocking `XREADGROUP` would hold the slot for the
whole `BLOCK` interval, and because an `idle` claim is the common case on an idle deployment the
worker would then report itself saturated essentially all the time — a one-slot worker refusing every
interactive `/turn` while its queue sat empty. So `claim()` omits `BLOCK` (`BLOCK 0` means block
_forever_ in Redis, so omitting is the only non-blocking spelling), and the loop does its own waiting
after the slot is released: `idleBackoffMs` on `idle`, `errorBackoffMs` after a throw. The price is
up to `idleBackoffMs` of extra pickup latency on a newly submitted turn, and a trickle of Redis
traffic on an empty queue — at the 250 ms default, about 8 commands a second per worker, multiplied
by `SH_WORKERS` and by replicas. M1 keeps that a flat poll because M1's deployments are one VM and
one compose stack against a single Redis; the constant's own comment records when an exponential
idle backoff becomes worth its pickup-latency cost.

Pull-when-ready, rather than claim-then-queue-internally: an entry claimed but not started is an
entry no other worker can take, and it is also the window in which a crash costs a reclaim cycle.

**One inherited defect, fixed here.** None of the synchronous leaf routes is in `TURN_PATHS`, so a
sync leaf run occupies no slot today. `isTurnRequest` compares the raw target, and the leaf route
matches three: `/runs`, `/run-leaf` and `/v1/runs` (`server.ts:1277`). **All three** go into the
counter — admitting one alias while counting another is the same defect with a narrower door.

Counting async leaves while sync leaves stay invisible would be incoherent: the same `runLeaf` call,
the same sandbox, one counted and one not. So this is named as a pre-existing over-admission fix
rather than folded in silently, because it is a behaviour change on a live path: deployments at
their admission ceiling will see `429`s they previously would not have, which is the correct answer
and was always the intent of `SH_TURNS_PER_WORKER`.

### 5.4 Credentials: no bearer token in the queue

MI1 §6.5 requires that "the control plane mints a leaf's grants when a worker takes it off the queue,
from a run record the control plane owns, created by the authenticated enqueue." This design
satisfies it directly: the queue holds a turn id, and the worker presents its own identity plus that
turn id to mint.

At claim:

1. The worker calls the control plane with the `turnId`.
2. The control plane loads the turn record and mints unless the record is **`cancelled` or already
   terminal**, then resolves `credentialName` against the owner's `SubjectDocument` and mints an
   **inference grant** and a **sandbox grant** — `aud: moca-inference` / `moca-sandbox`, the claim
   sets in MI1 §6.1's table.
3. `state → running` as a compare-and-set from `queued`; a record already `running` is a redelivery
   and stays `running`. `attempts` is written from the entry's `deliveryCount`.
4. The worker runs `runLeaf` with the grants.

**Why the mint check is "not terminal" rather than "`queued`".** A narrower check would defeat goal
3 in exactly the case it exists for. Step 3 sets `running` on the first claim, so every redelivery
arrives with the record already `running`: a crash-reclaimed entry (§6.2), a drained one (§6.3), and
a `retryable` outcome that `processOne` returns without acking (§10's `classifyOutcome` row) all look
identical to the mint. Refusing those would ack and drop them, and — because §5.1 gives a
non-terminal record no TTL and makes attempt exhaustion the only author of `lost` — would strand the
record in `running` forever with no entry left for the reaper to find. So the mint refuses only a
withdrawal (`cancelled`, §4.5) and a turn that has already reached a terminal state.

**Attempt exhaustion is the queue's call, not the record's.** `deliveryCount` is the single
authority, checked by `processOne`'s dead-letter branch before the mint is ever reached (§6.2), so
the mint does not test `attempts` as well — two counters that can disagree is the shape §5.1's
heartbeat note already rejects for liveness. The record's `attempts` is descriptive, written from
`deliveryCount` at claim so §4.4 can report it.

**`turn_exp` must be built.** #386 item 5 reads like a policy to tune on an existing field; it is not.
MI1 §6.1 specifies `turn_exp` as "an absolute cap: turn start + `MOCA_TURN_MAX_S`" with
`exp = min(now + MOCA_GRANT_TTL_S, turn_exp)`, and `MOCA_TURN_MAX_S` defaulting to 1800 — but no
TypeScript in the repo implements it. Expiry today is always `exp = iat + ttlSeconds`, clamped only
for sandbox tokens by the resource's own `expiresAt`. #388 is therefore larger than it reads, and this
is where the M1/M2 split in §9 comes from.

For an async leaf, "turn start" is **dequeue**, not enqueue. A leaf that waits an hour in the queue
must still get its full `MOCA_TURN_MAX_S`, and a grant minted at enqueue would already be expired.

**The long-turn policy itself, which item 5 asks for in as many words: "a per-turn `turn_exp` policy
that allows hour-long detached turns within a bound."** Today's numbers do not allow one.
`MOCA_TURN_MAX_S` defaults to **1800 s — thirty minutes** (MI1 §14's table), so an hour-long turn is
over the cap by a factor of two. The policy:

- **`MOCA_TURN_MAX_S` stays the deployment-wide ceiling and keeps its 1800 s default.** It is the
  bound the request asks the policy to stay within, and MI1's table notes it "should match the
  worker's own turn deadline" — raising the default would silently desynchronise it from
  `MOCA_TURN_MAX_S`'s sibling deadlines and change every interactive turn too.
- **A turn may request less, never more.** `caps.wallClock` (§4.3) is already on the record, so
  `turn_exp = dequeue + min(caps.wallClock ?? MOCA_TURN_MAX_S, MOCA_TURN_MAX_S)`. The `min` is the
  whole policy: a per-turn value that can only tighten. A caller asking for more is not refused —
  the request is clamped, because refusing would make a client's cap request a deployment-coupling
  concern.
- **An hour-long turn is therefore an operator decision, not a caller's.** Raising
  `MOCA_TURN_MAX_S` to 3600 is the supported way to get one, and it is a deliberate, auditable
  change to a deployment-wide ceiling rather than something any client can ask for. This is a
  narrower answer than item 5's phrasing implies, and it is the deliberate one: letting a caller
  name its own expiry above the ceiling hands an untrusted client (§3) control of how long its own
  credential lives.
- **The clamp is enforced at mint, in the control plane** — never from a value the worker or the
  caller supplies, for the same reason §6.4 enforces caps in the worker rather than trusting the
  client.

That leaves one genuinely open question, and it belongs to #388 rather than here: whether refresh
past `turn_exp` should be refused outright (MI1 §6.2's current rule) or whether a leaf that is
provably still running may extend once. Refusing is the safe default and what M2 should ship; the
heartbeat in §6.2 is what a future extension would key off, since it already proves liveness.

### 5.5 Execution and results

> **Corrected by §9.2.** "Keyed by `leafSessionId`" below is wrong for the async path and would break
> every async turn's result read, not merely a tenanted one. §9.2 has the finding and the resolution.

Unchanged, and deliberately so. `runLeaf` builds the `pi-coding-agent` session, converges the
workspace, selects a sandbox, runs the turn and captures the diff; `leaf-result-store` writes one
record per leaf keyed by `leafSessionId` under `LEAF_RESULT_TTL_SECONDS` (86400 default). The
consumer calls `prepareServerProcess(process.env)` at boot for the tenancy, keyset and
credential-scrub invariants (MI1 §5 R2), exactly as the HTTP path does — the removed drainer had the
same line, with the same comment: "a queued run is a server turn too."

Retention beyond 24 h and richer artifacts are out of scope here; §12 lists them as owed.

The caller polls the turn record for state, and the result store for the artifact. Whether N-way
collection needs `/v1/batches` is #537, decided once this is measurable.

**What this retires: #380's interim contract.** A synchronous `/runs` leaf keeps running after its
client disconnects, and #380 pinned that accident as a tested interim contract explicitly "until
async leaf turns on P6 (#389) replace it" — #389's scope item 5 is "retire #380's interim contract."
This design is that replacement, so the retirement has a condition and it is **not** the moment M1
merges:

- The contract is retired once a caller who disconnects has a supported alternative, which is
  async submission plus the §4.4 status read. That is M1 for `MOCA_TENANCY=single` and M2 for
  `multi`, so the sync-disconnect behaviour must survive until M2 lands rather than being removed
  with the first drain.
- Retiring it means replacing the behaviour's _documentation_, not changing the behaviour. ADR-0028's
  amendment and the `/runs` entry in `docs/api/openapi.yaml` currently say async turns supersede it;
  those pointers become ADR-0047 and §4.1. Whether sync `/runs` then _starts_ aborting on disconnect
  is a separate decision this design does not make — it would be a third live-path behaviour change,
  and §5.3 already carries one.
- The §5.3 admission fix is the part that touches sync `/runs` now, and it is orthogonal: counting a
  run in admission says nothing about whether a disconnect cancels it.

#380 is open and unimplemented, so there may be nothing to retire. If it ships before M2, the
retirement is a docs change against ADR-0028 and the OpenAPI entry; if it does not, the interim
contract is simply never pinned and this design supersedes the need for it. Either way the obligation
belongs to #389, and §12 records it.

---

## 6. Failure, safety and the misbehaving client

### 6.1 At-least-once, effectively once

Delivery is at-least-once: an entry is acked only after its result record is written. The idempotency
key (§4.3) makes redelivery safe, and `runLeaf`'s existing behaviour is what the key leans on —
re-sending the same `sessionId` is already the documented retry contract for synchronous leaves
(`dispatch-archetypes.md`), where a verdict leaf returns its recorded verdict and the others run
again.

### 6.2 Crash and reclaim

A claimed entry stays in the consumer group's PEL. `XAUTOCLAIM` reclaims entries idle past a minimum
after their owner dies; past `maxAttempts`, an entry dead-letters to a `lost` turn record plus a
failed result, so a caller polling always reaches a terminal state rather than waiting forever.

The restored queue brings this machinery with it (§10). What it does **not** bring is a caller, and
that is a real gap rather than a detail: the removed drainer ran all of it from process startup,
which worked only because a KEDA pod was born per batch of work.

**Consumer identity.** The drainer used `process.env.HOSTNAME ?? 'leaf-job-${pid}'` — one pod, one
consumer, gone when the pod exited. A P6 worker is long-lived and restarted in place by the
supervisor, so it needs an identity that is stable across a restart but distinct per live worker.

`SH_WORKER_ID` is already injected into every worker's env (`supervisor/src/main.ts:60`) and gives
the stability half: it is the pool **slot index** (`String(id)`), and `restart` reuses the slot, so a
replaced worker inherits its predecessor's id. It does **not** give uniqueness. Being a slot index
means it is `0..W-1` in every supervisor process, and `deploy/k8s/base/supervisor.yaml:1` is explicit
that capacity beyond one pod is `replicas` (so is `deploy/k8s/README.md:255`). With two replicas,
two live workers would share one consumer name in one group — and therefore share a PEL, share their
`XINFO CONSUMERS` idle and pending numbers, and make `gcIdleConsumers`'s "pending 0 and idle past
300 s" a statement about two processes rather than one. One of them being busy would hold the other's
abandoned entries out of the reaper's reach.

So the consumer id includes the supervisor process's own identity:
**`moca-${HOSTNAME}-w${SH_WORKER_ID}`**, falling back to the supervisor's pid where `HOSTNAME` is
unset. `HOSTNAME` is the pod name under `deploy/k8s` and the container id under `deploy/compose`,
which is exactly the per-replica discriminator missing above, and it survives an in-place worker
restart because the pod does not restart with it. The invariant the implementation owes is narrow and
worth stating as such: **two concurrently live workers must never share a consumer id, and a
restarted worker should reuse its predecessor's.** Whatever supplies the first half, the second comes
from `SH_WORKER_ID`.

**Who reaps, and when.** The drainer did a startup reap plus `gcIdleConsumers`, timed to let KEDA
scale to zero. Neither trigger survives: workers do not start per batch and nothing scales to zero.
So the reap becomes **periodic and armed by every worker**, which is exactly the shape
`run-lease.ts`'s `reapOrphanedRuns` already uses for sandbox run leases — armed by every worker,
sweeping on an interval, with claim-based mutual exclusion "so the N workers that each arm a reaper
cannot double-finalize one run" (`run-lease.ts:189`). Async reclaim reuses that pattern rather than
inventing a second one: `reapDeadLetters` and `gcIdleConsumers` on a timer, idempotent, safe to run
concurrently on every worker. `XAUTOCLAIM` is already mutually exclusive by construction.

**Nobody reclaims faster for being the original owner.** `claim()` is `XAUTOCLAIM` over the group's
whole PEL at `minIdleMs`, then `XREADGROUP '>'` (`queue.ts:122-153` at `38aa2146`) — it never reads
its own PEL from `0`. An abandoned entry is therefore invisible to **every** worker, its restarted
self included, until it has been idle past `minIdleMs`; after that, whichever worker's sweep lands
first takes it. That is the behaviour §6.3 describes and this design wants: redelivery is the point,
and which worker redelivers is not a property anything depends on. An own-PEL read from `0` would
shorten the window for one worker, and is not specified here — it would only be safe once the
consumer id above is genuinely unique per live worker, and it buys nothing a `minIdleMs` wait does
not already give.

The three constants come across unchanged, and are now worth naming because nothing else in P6
implies them: `minIdleMs` 90 s, `maxAttempts` 3, consumer GC idle 300 s. The constraint on
`minIdleMs` is the heartbeat below, not the drain window: it must stay a comfortable multiple of the
30 s beat so an alive leaf is never reclaimed, which is also what makes it necessarily longer than
the 20 s grace a drained worker gets.

**The claim heartbeat, which is not optional.** `minIdleMs` is 90 s and `MOCA_TURN_MAX_S` is 1800 s,
so a leaf running longer than 90 s goes idle in the PEL **while it is still running** and a peer's
`XAUTOCLAIM` reclaims it. Two workers then run the same leaf concurrently. Idempotency makes the
_result_ survivable (§6.1), but the duplicated work is not: it spends the owner's budget twice and
holds two sandboxes for one turn.

The removed runner solved this and the solution must come across: it armed
`setInterval(() => queue.touch(entryId, consumerId), 30_000)` for the life of the leaf and cleared it
in a `finally` (`leaf-job-runner.ts` at `38aa2146`, lines 70-77). So:

- Every claimed entry is touched on a **30 s** heartbeat — a third of `minIdleMs`, so two missed
  beats do not trigger a reclaim — armed at claim and cleared in a `finally` on every exit path,
  alongside the `counter.start()` end function §5.3 describes.
- Stopping the heartbeat is exactly what makes a crashed or drained worker's entry reclaimable, so
  §6.3's "abandon without acking" works _because_ the interval dies with the process. The heartbeat
  is the liveness signal; its absence is the death signal the reaper trusts. This mirrors
  `run-lease.ts`'s marker heartbeat, whose comment makes the same point: absence is "the only
  evidence of death the reaper trusts."
- **`harness/src/leaf-job-runner.ts` was removed by #691**, so `processOne` — the claim, the
  heartbeat, the `maxAttempts` dead-letter branch, the `classifyOutcome` dispatch and the result
  write — has to be restored along with `packages/work-queue` (§10). §10's "restore the queue"
  understated the surface: the runner is the second half, and it is where this heartbeat lives. Its
  shape needs one change for P6 — it returns `'retry'`/`'idle'` outcomes designed for a process that
  exits between entries, and the drain loop keeps running instead.

### 6.3 Shutdown: the one place async differs sharply from interactive

The numbers do not leave a choice. `MOCA_TURN_MAX_S` is 1800 s. The supervisor's
`SHUTDOWN_GRACE_MS` is 20 s, and the worker's `DETACHED_DRAIN_MS` is 15 s, deliberately under it so
terminal frames land before SIGKILL. **A long leaf cannot finish inside the grace window.**

So on `drain`:

- The loop stops claiming immediately.
- An in-flight leaf is **abandoned without an ack**. It stays pending until it is idle past
  `minIdleMs`, then goes to whichever worker's `XAUTOCLAIM` sweep reaches it first — possibly the
  restarted worker itself, with no priority either way (§6.2) — and the idempotency key makes that
  safe.
- The slot is released so `awaitIdle` can exit early rather than burning the full 20 s.
- The claim heartbeat (§6.2) stops with the process, which is what makes the abandoned entry
  reclaimable at all. There is nothing extra to do here, but the dependency is worth stating: if a
  future change moved the heartbeat anywhere outside the leaf's own lifetime, abandonment would
  silently stop working and the entry would look alive forever.

This is deliberately different from an interactive detached turn, which `armDetachedDrain` aborts
with `restarting` (turn-reattach spec §5.5) because a client is waiting on a stream. Nobody is
waiting on an async leaf, so redelivery is strictly better than an abort — and this is precisely the
property the KEDA path got from the ScaledJob's exit semantics, now obtained from the drain signal
instead.

### 6.4 The misbehaving client (#386 item 8)

The archetypes spec assumed a deterministic orchestrator. §3 accepted an LLM instead, so each safety
property must hold without that assumption:

| Attack                          | Containment                                                               |
| ------------------------------- | ------------------------------------------------------------------------- |
| Unbounded fan-out               | `MOCA_ASYNC_QUEUED_PER_OWNER` (§4.3), refused at submission with `429`    |
| Runaway spend                   | Per-turn caps (§4.3) enforced in the worker, not trusted from the client  |
| Turns that never end            | `turn_exp` (§5.4) refuses refresh past the cap; the worker's own deadline |
| Reading another owner's results | Owner scoping on the turn record; the queue holds no readable payload     |
| Credential exfiltration         | No credential in the queue; grants minted at dequeue, short-lived         |
| Retry storms                    | Idempotency key collapses duplicates to one `turnId`                      |

A drain-loop fault sharing a process with interactive turns (§5.2's accepted cost) is contained by
the same thing that contains a handler fault today: the supervisor's restart backoff, with the
abandoned entry reclaimed per §6.3.

---

## 7. Observability

Dropping queue-depth-driven capacity (§10) means **nothing watches the queue as a side effect any
more.** KEDA's scaler read `pendingEntriesCount` to decide how many Jobs to spawn, so depth was
visible because something acted on it. Slot-driven admission removes the actor, and with it the
observation — so the metrics have to be asked for explicitly rather than inherited.

The existing surface sets the shape: `GET /metrics` on the supervisor's **admin** port returns a JSON
body (not Prometheus text) whose `counters` object is snake_case — `restarts`, `handoff_retries`,
`over_admission`, `spurious_refusals`, `head_truncations` (`supervisor/src/admin.ts`). New async
counters join that object and follow it.

| Metric                    | Kind  | Why it earns its place                                                      |
| ------------------------- | ----- | --------------------------------------------------------------------------- |
| `async_queue_depth`       | gauge | The one KEDA gave for free. Sustained growth means arrival outruns drain    |
| `async_oldest_age_ms`     | gauge | Depth alone cannot distinguish a deep fast queue from a stalled shallow one |
| `async_claims`            | count | Drain throughput; with depth, the arrival-vs-drain ratio                    |
| `async_reclaims`          | count | `XAUTOCLAIM` firing. A nonzero steady rate means workers die mid-leaf       |
| `async_dead_letters`      | count | Entries that reached `lost` (§6.2) — always an alert, never normal          |
| `async_claim_denied_full` | count | Claims not attempted because every slot was busy (§5.3's accepted cost)     |
| `async_quota_refusals`    | count | Submissions refused by §4.3's per-owner quota — the containment, firing     |

`async_claim_denied_full` is the design's own stated risk made visible: §5.3 reserves no headroom, so
a full queue can occupy every slot. If it and interactive `429`s rise together, that is the
measurement which would justify the per-class caps §12 holds in reserve. `async_quota_refusals` is
the other one that is about this design's choices rather than the queue's health — §4.3's quota is
the single containment against a runaway submitter, so a deployment needs to see it firing to know
whether 50 is the right number.

**The reporting path already exists and is the constraint.** The drain loop runs in the worker, which
reaches the admin port only through the advisory `stats` IPC row — and that row is deliberately
"never routed on, never merged into the supervisor's `WorkerView`" (`worker.ts:15-31`). Async
counters ride it on the same terms: telemetry only, never an input to admission or routing. Queue
depth and oldest-entry age are properties of Redis rather than of any one worker, so whichever
component reports them must do so once per deployment, not once per worker.

`async_quota_refusals` is the one exception to the shape above, because §4.3 enforces the quota in
the **control plane** — a worker never sees a refused submission. It is counted where it happens and
surfaced on the control plane's own telemetry rather than smuggled through a worker that has no
knowledge of it.

---

## 8. Test strategy

What proves each part, named here because the implementation plan is written from this document and
the repo's TDD discipline requires the failing test first. `vitest` throughout, following the
existing suites.

**Unit, no Redis.** The drain loop's slot arithmetic against a fake `WorkQueue` and a real
`TurnCounter`: claims while `inFlight < cap`, stops at the cap, releases on every exit path
including a throw. `start()`'s end function is idempotent, so the test that matters is that a leaf
failing _and_ the loop's own cleanup running cannot double-decrement — the bias the counter's own
comment warns about. The restored `work-queue` arrives with 319 lines of its own tests (§10).

**Integration, with Redis** — as `session-backend` and the workload suites already require:

- N submitted, cap below N, all N results collected, and the counter never observed above the cap.
  **Under mixed load specifically** — interactive `/turn`s arriving while the loop drains — since
  that is the case §5.3's take-before-claim ordering exists for, and a drain-only test passes whether
  or not the ordering is right.
- Crash mid-leaf: kill a worker holding a claimed entry, assert `XAUTOCLAIM` reclaims it, **the mint
  succeeds against a record that already says `running`**, it runs to completion elsewhere, and the
  idempotency key makes the redelivery effectively once. The mint is the half worth asserting
  separately: a reclaim that lands on a refused mint looks like a successful reclaim right up to the
  point where the entry is acked and dropped (§5.4).
- The same mint, for the other two redelivery paths: a `retryable` outcome (`failed/saturated`) and a
  drained entry (§6.3) both re-mint on a `running` record. Only `cancelled` and terminal states are
  refused, and a cancelled record's entry is acked without running.
- Drain: `drain` stops claiming, the in-flight entry is abandoned **unacked** and still pending, the
  slot is released, and `awaitIdle` exits early rather than burning the full 20 s (§6.3).
- Dead-letter: an entry failing past `maxAttempts` reaches `lost` **and** a failed result, so a
  polling caller always terminates.
- Cancel: a `queued` turn flips to `cancelled` and is never claimed; a `running` one answers `409`.
- The fan-out quota (§4.3): submitting `MOCA_ASYNC_QUEUED_PER_OWNER + 1` refuses the last one with
  `429` and **enqueues nothing for it** — the queue depth, not just the status code, is the
  assertion. A terminal turn frees a slot (the count is of non-terminal records, so draining one
  lets the next submission through), and one owner's exhausted quota does not refuse another's.
- Reaper concurrency (§6.2): two workers arming the periodic reap over one stale entry finalize it
  once, not twice — the property `run-lease.ts:189` already states for sandbox leases.
- **The heartbeat, with time controlled** (§6.2): a leaf running past `minIdleMs` is **not**
  reclaimed while it is alive, and becomes reclaimable once the heartbeat stops. `processOne` already
  injects `setHeartbeat`/`clearHeartbeat` for exactly this, so the test needs no real 90 s wait. This
  is the one async property whose absence is invisible until a leaf runs longer than 90 s in
  production, which is most real leaves.
- Record TTL ordering (§5.1): a queued record carries no TTL; a terminal one expires **after** its
  result, not before. The failure this catches is a caller polling a succeeded turn and reading
  `404` because the record went first.
- The `turn_exp` clamp (§5.4), at M2: a turn requesting `caps.wallClock` below `MOCA_TURN_MAX_S` gets
  what it asked for; one requesting above it gets the ceiling, not a refusal and not the request.
- Parity carry-overs (§10): each of `prompt`, `converge` and `solve` drains; an async turn naming a
  `workloadId` is refused `501` at `POST` with nothing enqueued; a `failed/saturated` leaf is not
  acked and is redelivered, which is `classifyOutcome`'s contract exercised for the first time since
  #691.

**The admission change needs its own characterization test (§5.3).** All three synchronous aliases —
`/runs`, `/run-leaf`, `/v1/runs` — must each be shown to occupy a slot. A test that covers only
`/runs` would pass while two doors stay open, which is the defect restated. The existing
`supervisor/test/real-worker.integration.test.ts` forks the real worker and drives the IPC rows, and
is the natural home for the end-to-end half.

**Live smoke, env-gated.** The queued-leaf smoke test on `deploy/k8s` (#688) follows the existing
`M3_LIVE_SMOKE` convention; the removed `leaf-async-smoke.sh` at `38aa2146` is the starting point.

**Explicitly not covered by tests:** `turn_exp`, until M2 builds it — there is nothing to test, and a
test asserting today's `exp = iat + ttlSeconds` would lock in the behaviour MI1 §6.1 says is wrong.

---

## 9. Delivery in three milestones

The design is whole; the delivery is staged, because §5.4 showed `turn_exp` and the turn record are
new construction and nothing can be demonstrated until something drains.

**M1 — a working drain, single tenancy.** Restore the queue (§10). Drain loop in the worker, sharing
`TurnCounter`. All three synchronous aliases brought into the counter (§5.3). Submission with the
per-owner fan-out quota (§4.3) — it is M1's only containment against the submitter §3 assumes, so it
ships with the path it protects, not after it — the status read (§4.4) and queued-only cancel
(§4.5). Results through the existing store. Credentials resolved
from the turn record at dequeue under **`MOCA_TENANCY=single` only**; async under `multi` is refused
by name, as #386 item 5's interim allows. The §7 counters land with the loop that increments them —
a drain whose depth and reclaims are invisible cannot be operated, and they are what M1's acceptance
is read from. Acceptance: N leaves submitted, drained at a cap below N, all results collected, and
#389's crash and drain acceptance holding, per §8.

**M2 — multi-tenant.** `turn_exp` implemented (MI1 §6.1). Full grant-at-dequeue with both audiences
(#388). The tenancy gate lifts. Control-plane turn record and submission API complete (#387).

**M3 — `deploy/k8s`.** Manifests, Kind and OCP overlays, `setup.sh`, and a queued-leaf smoke test
(#688); the removed `leaf-async-smoke.sh` at `38aa2146` is the starting point. M1 lands on
`deploy/vm` and compose first (#389), since they need no manifests.

The ADR records the M1 tenancy gate as a dated, conditional refusal rather than an omission — the
shape ADR-0041 used for its own deprecation window.

### 9.1 Sequencing against MI1 S2 and S3

#386's acceptance asks for this explicitly, and the milestone split above is where the answer shows
up: **M1 is deliberately placed before S2, and M2 is gated behind it.**

| This design | MI1 slice                                  | Relationship                                                                                                       |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| M1          | **before S2**                              | Uses S2's own stated interim — the credential resolved from the turn record at dequeue, `MOCA_TENANCY=single` only |
| M2          | **requires S2** (grants, token endpoint)   | Grant-at-dequeue with both audiences is S2 machinery; `turn_exp` is MI1 §6.1, unbuilt (§5.4)                       |
| M3          | independent                                | `deploy/k8s` manifests; no slice dependency                                                                        |
| —           | **S3** (bundle ownership, the `cfg` claim) | No dependency either way: the turn record carries `cfg` as a digest (§5.1), exactly as a session does              |

Two consequences worth stating, because each is a choice rather than a fact:

- **M1 does not wait for S2.** If it did, async fan-out would be blocked on the whole grant and
  token-endpoint slice, and #386 item 5 asks for the single-tenancy interim precisely so it need not
  be. The cost is the tenancy gate, which is why the gate is a named refusal with a lifting criterion
  rather than silence.
- **M2 does not extend S2.** `turn_exp` is MI1's own specified field, unimplemented; building it is
  discharging S2's spec, not adding to it. This design is a consumer of that work and says so, so the
  two are not designed twice.

This design also **feeds the S2 review** rather than only consuming it, as #386 anticipated: §5.4's
finding that `turn_exp` exists in the spec and nowhere in the TypeScript is a correction S2 needs
regardless of async fan-out, and "turn start = dequeue, not enqueue" is a semantic S2's own §6.1 does
not currently pin down.

### 9.2 M1 implementation decisions (#389), and one thing §5.5 got wrong

Added November 10, 2026, after #387 and #388's M1 slice landed (`11da422d`, `bb89a84e`). The drain
loop is the last piece of M1, and building against the sections above surfaced **six** questions they
do not settle. Five are choices. The sixth is not a choice at all — it is **a claim in §5.5 that is
false**, and it blocks M1's acceptance. Each is recorded against the section it refines, so a reader
who finds the original text first also finds the correction.

**The one that is a defect, not a decision — §5.5's result key.** §5.5 says execution and results are
"unchanged, and deliberately so," with `leaf-result-store` writing "one record per leaf keyed by
`leafSessionId`." That is exactly what breaks. `leafSessionId` prefixes the tenant and then sanitizes
(`run-leaf.ts:183-185`), while the control plane reads the raw `leaf:result:${turn.sessionId}`
(`turn-result.ts:13`) — and `ownership.ts:208` is `tenant: h.tenant ?? h.owner`, so **a turn record's
tenant is never empty**: under `single` it falls back to the owner. The async path would therefore
write `leaf:result:github-1234-<uuid>` where the reader looks for `leaf:result:<uuid>`, on _every_
async turn rather than only on tenanted ones. #704's review carried this as a latent divergence; it
is in fact blocking, because M1's "all results collected" acceptance cannot pass with it.

**Resolution:** the async path writes under `turn.sessionId` — the control plane's own id, already a
uuid, unique without a tenant prefix and needing no sanitization, and the authority §5.1 names.
Synchronous leaves keep `leafSessionId` unchanged: their envelope ids genuinely are caller-supplied
`<run>/<item>` strings that need sanitizing, so this is a divergence in the _inputs_, not two
conventions for one input. The test that pins it asserts the written key and the read key are the
same string for a turn whose tenant is non-empty, which is now every turn.

**The other five.**

| Decision                                                                      | Refines | Why                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaimedEntry` carries `turnId`, not a parsed `envelope`                      | §10     | A verbatim restore is **broken**. The old queue writes `{envelope: JSON.stringify(…)}` and parses it back; #387's `RedisTurnQueue` writes `{turnId}` only (`turn-queue.ts:44`), and #388's e2e test asserts the entry's fields are exactly `['turnId']`. Restored as-is, `claim()` would `JSON.parse(undefined)` on every entry                                                                                                                   |
| `RedisWorkQueue` takes an injected client                                     | §10     | Its own `createClient`, reconnect strategy, error listener and `isOpen` re-arm duplicate `@moca/session-backend`'s `resilientClientOptions`/`swallowRedisErrors`, with an inline `redactUrl` copy kept honest by a cross-package parity test. The worker already holds a client. The **stream commands are still restored verbatim** — that is what §10 protects; the connection boilerplate is not                                               |
| `envelope` joins the dequeue exchange response                                | §5.4    | A worker needs one to call `runLeaf`, and #388 shipped without it, so its e2e fake worker reads the record straight from Redis (`turn-e2e.test.ts:183`). One authenticated hop instead, no second reader of the record schema #387 owns, and the endpoint becomes the complete claim handshake its own description implies                                                                                                                        |
| `async_queue_depth` and `async_oldest_age_ms` are reported by **slot 0 only** | §7      | §7 requires them "once per deployment, not once per worker" without naming who. `packages/supervisor` ships `dependencies: {}` deliberately and cannot query Redis. Slot 0 adds them to the existing advisory `stats` row; the others omit them. Every worker reporting would mean W Redis queries for one number. Cost: the two gauges go stale while slot 0 restarts, which is acceptable for telemetry nothing routes on                       |
| Injected timings in CI, one env-gated live `kill -9`                          | §8      | `minIdleMs` is 90 s, so a faithful reclaim test waits 90 s+ and CI will not gate on it. `processOne` already takes `minIdleMs`/`heartbeatMs`/`maxAttempts` as deps, so reclaim, heartbeat, dead-letter and cap saturation run against real Redis in seconds with no test-only seam. The live crash test proves the one thing injected timings cannot: that the supervisor restarts a worker whose leaf was mid-flight and the leaf completes once |

**Two findings that are not decisions, recorded because they shrink the work.** The claim path needs
**no new environment variable on either deployment**: the worker already has `SH_EXCHANGE_TOKEN` as a
systemd credential (`LoadCredential` in `sh-supervisor.service`, set directly in compose),
`SH_CONTROL_PLANE_URL` and `REDIS_URL`. `deploy/vm/env/supervisor.env.example:65` is explicit that
setting `SH_EXCHANGE_TOKEN` as an env line instead makes the workers refuse to boot, so scope item 4
is narrower than it reads — one knob for the loop, plus the three §6.2 constants documented where an
operator looks. And `asyncCounters()` (`counters.ts:19`), which #704 noted had no reader, gets its
first one here.

**A retention limit the per-turn result key makes visible, recorded rather than fixed.** Because the
key now carries a turn id (`leaf:result:<sid>:<turnId>`), only an enumeration of a session's turns
reaches it, and the only enumeration there is — `TurnStore.deleteSessionTurns`, walking the owner's
open set — sees **open turns only**: `toTerminal` removes a finished turn from that set to free its
quota slot. So a finished async turn's result survives `DELETE /v1/sessions/{id}` and expires on
`LEAF_RESULT_TTL_SECONDS` (24 h by default). This is **not new with the per-turn key**: the finished
turn's RECORD — which carries the envelope, so the same class of caller content — has always
survived that delete on the same clock, which §5.1 chose deliberately when it made the terminal TTL
the record's only expiry. The result now expires on `resultTtl` and the record on
`resultTtl + margin`, so the pair goes together. The API cannot reach either (the session 404s), but
the bytes are retained after the owner asked for deletion, and `configuration.md` says so in the
`LEAF_RESULT_TTL_SECONDS` row. Making the delete immediate needs an index the design does not
have — a per-session turn set, written at submission and walked here, covering terminal turns as
well as open ones — which also changes §5.1's terminal-record rule. M2 owns that, with the record
and the result deleted by the same walk; a `SCAN MATCH` is not the alternative, because SCAN's cost
is the whole keyspace per session delete, not the matches.

**Deferred, with the reason on the record.** #389's scope item 5 — retire #380's interim
sync-disconnect contract — is **not** in M1. §5.5 already argues the condition is a supported
alternative for a caller who disconnects, which is async submission plus the §4.4 status read, and
under `multi` that is M2. §12 carries it.

---

## 10. The queue: revive, with the parity audit on the record

**Decision: restore `packages/work-queue` _and_ `harness/src/leaf-job-runner.ts` from `38aa2146`,
behind the existing `WorkQueue` interface.**

> **Qualified by §9.2.** "Restore" is not "restore verbatim": the queue's wire format changed under
> this section when #387 shipped `RedisTurnQueue`, so a literal restore does not work. §9.2 names
> what is restored as-is (the stream commands) and what is not (the envelope payload, the owned
> Redis client).

The queue is 261 lines plus 319 lines of tests across five files, and nothing in it is
Knative-specific: `ensureGroup`/`enqueue`/`claim`/`ack`/`touch`/`pending`/`gcIdleConsumers`/`reapDeadLetters`
is plain Redis Streams behind an interface, with `RedisWorkQueue` as one implementation. Rewriting it
would re-derive the same calls with fresh bugs; the interface keeps a different backing store
available later. Its removal settled nothing either way, as #686 notes.

`leaf-job-runner.ts`'s `processOne` is the second half and was removed by the same PR. It holds the
per-entry sequence — claim, the `maxAttempts` dead-letter branch, the `touch` heartbeat that keeps a
long leaf's claim alive (§6.2), the `classifyOutcome` dispatch, the result write and the ack. Only
the KEDA-shaped outcome vocabulary needs rework: `'retry'` and `'idle'` were signals for a process
that exits between entries, and a long-lived drain loop continues instead. Everything else is the
behaviour this design depends on, and rewriting it is how the heartbeat gets forgotten.

What it inherits from the KEDA era must be audited, not assumed — this is #689, and the ADR records
the verdict on each item. The table covers every property on #689's "At minimum" list, so the issue
can be closed against it rather than against a subset:

| KEDA-era behaviour                                      | Verdict                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Scale-to-zero                                           | **Dropped.** ADR-0041 accepted this cost explicitly                                                     |
| Queue-depth-driven capacity                             | **Dropped.** Admission is slot-driven (§5.3), not depth-driven                                          |
| `pendingEntriesCount` for the scaler                    | **Repurposed** as an operational metric; nothing scales on it                                           |
| Exit-0-when-idle drain semantics                        | **Replaced** by the `drain` signal (§6.3)                                                               |
| `XAUTOCLAIM` reaper (#17)                               | **Kept.** §6.2 depends on it                                                                            |
| Dead-letter past `maxAttempts`                          | **Kept**, mapped to the `lost` state (§5.1)                                                             |
| `LEAF_RESULT_TTL_SECONDS` (86400)                       | **Kept** as-is; longer retention is owed (§12)                                                          |
| At-least-once delivery                                  | **Kept.** §6.1: the claim/ack cycle is unchanged, so a leaf can run twice                               |
| `runLeaf` idempotency on the session id                 | **Kept, and now the submission default too** — §4.3 defaults `idempotencyKey` to `sessionId`            |
| `classifyOutcome` retry classes                         | **Kept, and already present** — it survived #691 in `harness/src/classify-outcome.ts`; see below        |
| Leaf kinds accepted async (`prompt`/`converge`/`solve`) | **All three kept.** `runLeaf` dispatches on `kind` (`run-leaf.ts:391-392`) and the loop calls `runLeaf` |
| Refusing async workload runs                            | **Kept**, moved to submission time (§4.2) so it stays a synchronous `501`, not a dead-letter            |
| `queued` when no result record exists                   | **Not carried.** §4.4 reads state from the turn record; `/runs/status` is untouched                     |
| Global concurrency cap                                  | **Replaced** by supervisor admission (§5.3) — one slot budget, not a separate queue-side limit          |
| Per-class concurrency caps                              | **Not carried.** Archetypes §2 wants them; §12 records the gap, #360/#391 own quotas                    |
| Queue-depth and leaf-outcome metrics                    | **Kept and expanded** — §7's seven counters, on the supervisor's admin `/metrics`                       |

Two of those deserve a sentence beyond the verdict.

**`classifyOutcome` is the one piece of the async contract #691 did not remove.** It still lives at
`harness/src/classify-outcome.ts` with its tests, and `run-leaf.ts` and `select-sandbox.ts` still
carry comments explaining their behaviour in terms of it ("keeps it retryable for the async queue").
So the retry classes need no revival and no redesign: `failed/error` and `failed/saturated` return
`{ack: false, retryable: true}` and everything else acks. The drain loop in §5.2 is its first caller
since the removal, and the comments stop being aspirational. `saturated` matters most here — the
synchronous path bounded-waits then `503`s, while the async path has no bounded wait, so the entry
stays pending and drains as capacity frees. That is the behaviour §5.3's no-reserved-headroom choice
depends on.

**The `queued`-when-absent inference is deliberately dropped, not overlooked.** It was the only
status signal the KEDA path had, and it is wrong in two directions (§4.4): it cannot distinguish a
queued turn from one never submitted, nor from one reaped as `lost`. Replacing an inference with a
record is the parity item where matching the old behaviour would have been the defect.

Housekeeping: delete the dead `LeafEnvelope.async?: boolean` field, whose comment still claims "the
HTTP layer enqueues instead of running inline." Nothing reads it, and leaving it invites a future
reader to believe the field is load-bearing.

---

## 11. What Archetype C inherits

#536 (cron) should build on this consumer rather than a second one. It needs a trigger and an
identity to run as; this design supplies the identity answer (§3: a service-account credential and
the authenticated path, never an unauthenticated route) and the whole queue-and-drain substrate. What
it adds is the schedule. Its design should cite this document for both.

---

## 12. Owed, and explicitly not here

- **Cancelling a `running` leaf** (§4.5). Needs a cancel signal addressed to the one worker holding
  it — new control-plane-to-worker machinery, since interactive cancel (ADR-0040) rides the turn's own
  connection and async has none. The §4.3 caps bound how long a leaf runs meanwhile, so this is a
  latency improvement rather than a missing containment property.
- Result retention beyond 24 h, and richer artifacts than the current patch/text/summary. The turn
  record's TTL is derived from `LEAF_RESULT_TTL_SECONDS` (§5.1), so raising retention moves one knob
  and the record follows — not two values to keep in step.
- Per-class concurrency caps (archetypes §2) — §10 drops them for now; a global slot cap is what M1
  delivers. §7's `async_claim_denied_full` against interactive `429`s is the measurement that would
  justify adding them.
- `/v1/batches` (#537), once a working fan-out exists to measure a client-side loop against.
- Documentation: ADR-0041's "Still owed" note, the Archetype A row and section of
  `dispatch-archetypes.md`, and the `async_removed` entry in `docs/reference/http-api.md` (#690).
  `MOCA_ASYNC_QUEUED_PER_OWNER` (§4.3) joins `docs/reference/configuration.md`'s table with the code
  that reads it, as that file's own rule requires — it lists variables as they exist in the code.
- Retiring #380's interim sync-disconnect contract (§5.5), which belongs to #389's scope item 5. The
  condition is M2, not M1, and it is a docs change rather than a behaviour change. §9.2 confirms this
  as M1's one deliberately deferred scope item.
- Updating children #387–#390 and #391 to match this design, per #386's acceptance. The decisions
  they need are §4.1/§4.4/§4.5 (#387), §5.4's `turn_exp` finding (#388), §5.5/§6.2/§6.3 and §8
  (#389), §5.1's heartbeat note and §9's milestones (#390), and §10's parity verdicts (#689).
- **Not a design gap, but the epic's acceptance:** #686 closes on a pipeline running end to end on
  `deploy/k8s` **and** on `deploy/vm` or compose, which is M1 plus M3. A reviewed spec and ADR close
  #386, not #686.

**Done, not owed:** the MU1 and MI1 wording amendments #386's acceptance asks for are applied, as
dated amendment notes at the head of each spec in that repo's established convention (MI1 §14), and
registered in MI1 §14's amendment table. MU1 §4.2/§4.3/§9 and MI1 §6.1/§6.5/§10 now read as §4 and
§5.4 of this document.

## 13. References

- Issues: #686 (epic), #386 (this spec), #387, #388, #389, #687, #688, #689, #690, #537, #536, #378,
  #490, #691, #279, #361, #17
- ADRs: [0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md) (this design's decision record),
  0015 (KEDA ScaledJob dispatch, superseded by 0047), 0034 (P6 socket hand-off; flagged both gaps),
  0037 (P6 on Kubernetes), 0041 (deprecation, and the accepted costs)
- Specs: MI1 [`2026-09-28-moca-multi-user-isolation-design.md`](2026-09-28-moca-multi-user-isolation-design.md)
  (§5 R2, §6.1, §6.2, §6.5); MU1 [`2026-09-08-multi-user-control-plane-design.md`](2026-09-08-multi-user-control-plane-design.md)
  (§4.2); [`2026-06-26-pipeline-archetypes-requirements.md`](2026-06-26-pipeline-archetypes-requirements.md)
  (§2, §5.1, §6); [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md)
  (the superseded KEDA design)
- Reference implementation, pinned pre-#691: [`38aa2146`](https://github.com/rossoctl/moca/tree/38aa2146893ce2a97c12af110dd565444e39bb87)
  — `packages/work-queue/`, `packages/knative-server/src/leaf-job.ts`,
  `harness/src/leaf-job-runner.ts`, `deploy/knative/leaf-scaledjob.yaml`
