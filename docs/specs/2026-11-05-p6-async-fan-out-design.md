# P6 Async Fan-Out — Design

Version: 1.0 — November 5, 2026
Status: Proposed
Issue: [#686](https://github.com/rossoctl/moca/issues/686) (epic); this document is the deliverable
of its gating child [#386](https://github.com/rossoctl/moca/issues/386) (B1: spec + ADR)
Decision record: [ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md)
Supersedes in substance: [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md)
(the KEDA ScaledJob substrate, deprecated by ADR-0041 and removed by #691)

Scope: how a caller submits many leaf turns without waiting, how a P6 worker drains them under the
same admission budget as interactive turns, how a leaf gets its credential at dequeue without a
bearer token in the queue, and how results are collected. Covers all three P6 deployments
(`deploy/k8s`, `deploy/vm`, `deploy/compose`).

> **What this is not.** Not the cron on-ramp (Archetype C, #536), though §9 states what that design
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
continuously. Nothing here tries to recover it, and §8 records what else from the KEDA path is
deliberately dropped.

---

## 3. The submitter question, and why there is one queue

#686 and #386 assume different callers, and the difference is not cosmetic.

The archetypes spec's first cross-archetype invariant (§5.1) is explicit:

> A deterministic, non-LLM outer orchestrator. State machine / staged scripts / scheduler. The LLM
> is always a **leaf**, never the controller.

Its §6 is blunter still — for bulk fan-out, Archetype A **rejected** agent-managed subagents: the
subprocess pool "replaces ask the main agent to spawn N sub-agents in its own context."

But #386 is item B1 of the coding-agent subagents epic (#378), where the submitter *is* an LLM. Its
own item 8 names the collision: "Archetypes §5.1 expects a deterministic, non-LLM orchestrator, and
an LLM coding agent is neither, so every safety property must hold with a misbehaving client."

**Decision: one queue and one consumer, with submission as a thin authenticated layer above them.**
Both callers enqueue through the same authenticated API, and the trust model is uniformly "assume a
misbehaving client." The alternative — two submission paths with two trust models — would mean every
safety property in §6 is enforced twice and can diverge once.

The cost is real and is accepted: a deterministic controller must now hold a credential, which on the
old unauthenticated data-plane path it never did. This is the same "who does a job with no
interactive user run as" question #536 faces for cron, and §9 keeps the two answers aligned.

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
still say "owned `/v1/runs`"; this design amends that wording (§10).

`202` rather than `200`: the work is accepted, not done. The response carries the `turnId` the caller
polls, and nothing else — no result, no partial state.

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

### 4.3 Caps and idempotency

Every async turn carries caps resolved at submission and stored on the turn record: tokens, cost and
wall-clock. §6 covers enforcement.

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

| Field            | Notes                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `turnId`         | opaque; the only thing in the queue                                |
| `owner`          | subject string, as `SessionRecord.owner` (`github:<id>`)           |
| `tenant`         | gates M1 (§7)                                                      |
| `sessionId`      | the session the turn belongs to                                    |
| `cfg`            | bundle digest, as on the session                                    |
| `credentialName` | a **name**, resolved server-side at dequeue — never the credential |
| `caps`           | tokens, cost, wall-clock (§4.3)                                    |
| `idempotencyKey` | defaults to `sessionId` (§4.3)                                     |
| `envelope`       | the `LeafEnvelope` to run                                          |
| `state`          | below                                                              |
| `attempts`       | incremented at claim; bounds redelivery (§6.2)                     |

```
queued → running → paused | responded | done | solved | failed | cancelled | lost
```

`paused`, `responded`, `done`, `solved` and `failed` mirror `LeafResult`'s existing discriminants, so
a result maps to a state without translation. `cancelled` is a caller's withdrawal. `lost` is the
terminal the reaper writes when attempts are exhausted (§6.2) — distinct from `failed`, because
"we never found out" is operationally different from "it ran and failed."

Stored like `SessionRecord`: Redis hash plus per-owner zset, via `OwnershipIndex`. Owner scoping is a
flat subject string on the record, following the existing convention rather than inventing a scope
object (mind #361).

### 5.2 Where the consumer runs

**Decision: a drain loop inside the turn worker, sharing the existing `TurnCounter`.**

Two candidates were considered. The reserved `--role=leaf` seam would fork dedicated leaf workers:
cleaner blast radius, since a drain bug could not touch interactive turns. It was rejected because it
creates **two capacity budgets that must be reconciled** — `SH_TURNS_PER_WORKER` against a separate
leaf concurrency — and because the supervisor would need a new concept of a child it supervises but
never routes to. Goal 2 asks for draining *inside* admission; two budgets is the definition of
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
interactive turns. §10 records per-class caps as the knob to reach for if that proves wrong.

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
2. The control plane loads the turn record, checks `state === 'queued'`, resolves `credentialName`
   against the owner's `SubjectDocument`, and mints an **inference grant** and a **sandbox grant** —
   `aud: moca-inference` / `moca-sandbox`, the claim sets in MI1 §6.1's table.
3. `state → running`, `attempts` incremented.
4. The worker runs `runLeaf` with the grants.

**`turn_exp` must be built.** #386 item 5 reads like a policy to tune on an existing field; it is not.
MI1 §6.1 specifies `turn_exp` as "an absolute cap: turn start + `MOCA_TURN_MAX_S`" with
`exp = min(now + MOCA_GRANT_TTL_S, turn_exp)`, and `MOCA_TURN_MAX_S` defaulting to 1800 — but no
TypeScript in the repo implements it. Expiry today is always `exp = iat + ttlSeconds`, clamped only
for sandbox tokens by the resource's own `expiresAt`. #388 is therefore larger than it reads, and this
is where the M1/M2 split in §7 comes from.

For an async leaf, "turn start" is **dequeue**, not enqueue. A leaf that waits an hour in the queue
must still get its full `MOCA_TURN_MAX_S`, and a grant minted at enqueue would already be expired.

### 5.5 Execution and results

Unchanged, and deliberately so. `runLeaf` builds the `pi-coding-agent` session, converges the
workspace, selects a sandbox, runs the turn and captures the diff; `leaf-result-store` writes one
record per leaf keyed by `leafSessionId` under `LEAF_RESULT_TTL_SECONDS` (86400 default). The
consumer calls `prepareServerProcess(process.env)` at boot for the tenancy, keyset and
credential-scrub invariants (MI1 §5 R2), exactly as the HTTP path does — the removed drainer had the
same line, with the same comment: "a queued run is a server turn too."

Retention beyond 24 h and richer artifacts are out of scope here; §10 lists them as owed.

The caller polls the turn record for state, and the result store for the artifact. Whether N-way
collection needs `/v1/batches` is #537, decided once this is measurable.

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

The restored queue brings this machinery with it (§8).

### 6.3 Shutdown: the one place async differs sharply from interactive

The numbers do not leave a choice. `MOCA_TURN_MAX_S` is 1800 s. The supervisor's
`SHUTDOWN_GRACE_MS` is 20 s, and the worker's `DETACHED_DRAIN_MS` is 15 s, deliberately under it so
terminal frames land before SIGKILL. **A long leaf cannot finish inside the grace window.**

So on `drain`:

- The loop stops claiming immediately.
- An in-flight leaf is **abandoned without an ack**. It stays pending, is reclaimed by another
  worker, and the idempotency key makes that safe.
- The slot is released so `awaitIdle` can exit early rather than burning the full 20 s.

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
| Unbounded fan-out               | Per-owner queued-turn quota, refused at submission with `429`             |
| Runaway spend                   | Per-turn caps (§4.3) enforced in the worker, not trusted from the client   |
| Turns that never end            | `turn_exp` (§5.4) refuses refresh past the cap; the worker's own deadline  |
| Reading another owner's results | Owner scoping on the turn record; the queue holds no readable payload      |
| Credential exfiltration         | No credential in the queue; grants minted at dequeue, short-lived          |
| Retry storms                    | Idempotency key collapses duplicates to one `turnId`                       |

A drain-loop fault sharing a process with interactive turns (§5.2's accepted cost) is contained by
the same thing that contains a handler fault today: the supervisor's restart backoff, with the
abandoned entry reclaimed per §6.3.

---

## 7. Delivery in three milestones

The design is whole; the delivery is staged, because §5.4 showed `turn_exp` and the turn record are
new construction and nothing can be demonstrated until something drains.

**M1 — a working drain, single tenancy.** Restore the queue (§8). Drain loop in the worker, sharing
`TurnCounter`. `/runs` brought into the counter. Results through the existing store. Submission
resolves the credential from the turn record at dequeue under **`MOCA_TENANCY=single` only**; async
under `multi` is refused by name, as #386 item 5's interim allows. Acceptance: N leaves submitted,
drained at a cap below N, all results collected, and #389's crash and drain acceptance holding.

**M2 — multi-tenant.** `turn_exp` implemented (MI1 §6.1). Full grant-at-dequeue with both audiences
(#388). The tenancy gate lifts. Control-plane turn record and submission API complete (#387).

**M3 — `deploy/k8s`.** Manifests, Kind and OCP overlays, `setup.sh`, and a queued-leaf smoke test
(#688); the removed `leaf-async-smoke.sh` at `38aa2146` is the starting point. M1 lands on
`deploy/vm` and compose first (#389), since they need no manifests.

The ADR records the M1 tenancy gate as a dated, conditional refusal rather than an omission — the
shape ADR-0041 used for its own deprecation window.

---

## 8. The queue: revive, with the parity audit on the record

**Decision: restore `packages/work-queue` from `38aa2146` behind its existing `WorkQueue` interface.**

It is 261 lines plus 319 lines of tests across five files, and nothing in it is Knative-specific:
`ensureGroup`/`enqueue`/`claim`/`ack`/`touch`/`pending`/`gcIdleConsumers`/`reapDeadLetters` is plain
Redis Streams behind an interface, with `RedisWorkQueue` as one implementation. Rewriting it would
re-derive the same calls with fresh bugs; the interface keeps a different backing store available
later. Its removal settled nothing either way, as #686 notes.

What it inherits from the KEDA era must be audited, not assumed — this is #689, and the ADR records
the verdict on each item:

| KEDA-era behaviour                   | Verdict                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| Scale-to-zero                        | **Dropped.** ADR-0041 accepted this cost explicitly               |
| Queue-depth-driven capacity          | **Dropped.** Admission is slot-driven (§5.3), not depth-driven     |
| `pendingEntriesCount` for the scaler | **Repurposed** as an operational metric; nothing scales on it      |
| Exit-0-when-idle drain semantics     | **Replaced** by the `drain` signal (§6.3)                          |
| `XAUTOCLAIM` reaper (#17)            | **Kept.** §6.2 depends on it                                      |
| Dead-letter past `maxAttempts`       | **Kept**, mapped to the `lost` state (§5.1)                        |
| `LEAF_RESULT_TTL_SECONDS` (86400)    | **Kept** as-is; longer retention is owed (§10)                     |
| Per-class concurrency caps           | **Not carried.** Archetypes §2 wants them; §10 records the gap     |

Housekeeping: delete the dead `LeafEnvelope.async?: boolean` field, whose comment still claims "the
HTTP layer enqueues instead of running inline." Nothing reads it, and leaving it invites a future
reader to believe the field is load-bearing.

---

## 9. What Archetype C inherits

#536 (cron) should build on this consumer rather than a second one. It needs a trigger and an
identity to run as; this design supplies the identity answer (§3: a service-account credential and
the authenticated path, never an unauthenticated route) and the whole queue-and-drain substrate. What
it adds is the schedule. Its design should cite this document for both.

---

## 10. Owed, and explicitly not here

- Result retention beyond 24 h, and richer artifacts than the current patch/text/summary.
- Per-class concurrency caps (archetypes §2) — §8 drops them for now; a global slot cap is what M1
  delivers.
- `/v1/batches` (#537), once a working fan-out exists to measure a client-side loop against.
- Documentation: ADR-0041's "Still owed" note, the Archetype A row and section of
  `dispatch-archetypes.md`, and the `async_removed` entry in `docs/reference/http-api.md` (#690).
- Wording amendments: MU1 §4.2 and MI1 §6.5/§10 still say "owned `/v1/runs`" (§4.1).

## 11. References

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
