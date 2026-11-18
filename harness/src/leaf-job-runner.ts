import type { ClaimedEntry, WorkQueue } from '@moca/work-queue';
import { classifyOutcome } from './classify-outcome.js';
import type { LeafEnvelope, LeafResult } from './run-leaf.js';
import type { TurnConfig } from './run-turn.js';
import { DEADLINE_ABORT } from './stop-reason.js';
import { toResultRecord, writeResult, type RedisLike } from './leaf-result-store.js';

/**
 * What the claim handshake yields (§5.4): everything needed to run the leaf, and nothing more.
 * `sessionId` is the TURN RECORD's session id, which is the key the control plane reads a result
 * under -- see the comment on the result write below.
 */
export interface ClaimedTurn {
  envelope: LeafEnvelope;
  sessionId: string;
  /** `attempts` as stamped on the record by markRunning, from the queue's delivery count. */
  attempts: number;
  /**
   * The per-turn config `runLeaf` takes as its second argument, carrying THIS turn's credential.
   * It cannot be built once for the loop: every claim resolves its own credential, base url, tier
   * and model. Typed as the harness's own `TurnConfig` rather than `@moca/server`'s `TurnAuth`,
   * because this package is the one `@moca/server` depends on, not the other way round.
   *
   * It also carries the turn's token cap as `budgetTokens` (`caps.tokens`, #391), because that one
   * is enforced INSIDE the leaf by the budget voter -- unlike the deadline below, which this file
   * enforces from outside.
   */
  config: TurnConfig;
  /**
   * The turn's wall-clock deadline as unix SECONDS, anchored by the control plane at this dequeue
   * (§5.4, #391): `caps.wallClock` clamped to MOCA_TURN_MAX_S, or that ceiling. Absent only from a
   * control plane older than #391, and then the leaf runs to its grant's own expiry as before.
   */
  turnExp?: number;
}

export interface LeafJobDeps {
  queue: WorkQueue;
  consumerId: string;
  /**
   * Mint the credential and flip the record queued->running. `null` means the control plane refused:
   * the turn is cancelled or already terminal, and must not run.
   *
   * Injected because reaching the control plane is `@moca/server`'s business, and because
   * every test of this function would otherwise need an HTTP server.
   */
  claimTurn: (turnId: string, deliveryCount: number) => Promise<ClaimedTurn | null>;
  /**
   * `runLeaf` itself in production; the second argument is the claim's own config. The third stops
   * the leaf -- a cancel request, or the turn's deadline (#391).
   */
  runLeaf: (env: LeafEnvelope, config: TurnConfig, signal: AbortSignal) => Promise<LeafResult>;
  /**
   * Has the owner asked for this turn to stop (§4.5, #391)? One HGET on the turn record, polled
   * while the leaf runs. Injected like `claimTurn` because the store is `@moca/server`'s to build;
   * absent ⇒ no cancel polling, which is what every pre-#391 caller gets.
   *
   * A false answer and a throw are the same thing to the caller: the leaf keeps running. A Redis
   * blip must not cancel a turn.
   */
  cancelRequested?: (turnId: string) => Promise<boolean>;
  /**
   * Take one of this turn's OWNER's concurrency slots (§5.3, #391), or answer `null` when that
   * owner already holds every slot their cap allows on this worker. The release is held for the
   * whole run and is idempotent.
   *
   * Injected, and taking a turn id rather than a subject, because the owner is on the turn record:
   * resolving it is a Redis read `@moca/server` already does, and the counter it checks against is
   * the same `SubjectCounter` instance the sync `/turn` path uses -- the two must share one count
   * or neither cap means anything. Absent ⇒ no per-owner fairness, the pre-#391 behaviour.
   */
  admitOwner?: (turnId: string) => Promise<(() => void) | null>;
  /** Stamp the terminal state on the record. 'aborted' has no TurnState; the caller maps it. */
  finalize: (turnId: string, status: LeafResult['status']) => Promise<void>;
  /**
   * The dead-letter path: read the record, write a failed result under its session id, finalize.
   * Injected separately from `claimTurn` so that a turn which will never run never causes a
   * credential to be minted or an issuance to be written to the audit log.
   */
  deadLetter: (turnId: string) => Promise<void>;
  resultStore: RedisLike;
  ttlSeconds: number;
  maxAttempts?: number;
  minIdleMs?: number;
  /**
   * XREADGROUP's BLOCK, in ms. Defaults to 0 = non-blocking, because the caller holds an admission
   * slot across this whole function (§5.3): a blocking claim reserves that slot for the wait, so an
   * armed-but-idle drain would look permanently saturated to an interactive `/turn`. The loop waits
   * for work with its own sleep instead, after the slot is released.
   */
  blockMs?: number;
  heartbeatMs?: number;
  /**
   * How often the cancel/deadline watchdog ticks, in ms. Defaults to CANCEL_POLL_MS. Its own timer
   * rather than a job for the heartbeat: the heartbeat's period is a third of `minIdleMs` (30 s),
   * and §4.5's criterion is that a cancel releases the sandbox within 10 s.
   */
  cancelPollMs?: number;
  /** How old a deferred entry may get before fairness yields to it. Defaults to DEFER_CEILING_MS. */
  deferCeilingMs?: number;
  log?: (msg: string) => void;
  now?: () => string;
  /**
   * The timer seam, shared by the touch heartbeat and the cancel/deadline watchdog -- two periods,
   * one injection point, because a test that drives one wants to drive the other.
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One claim's outcome, as the drain loop needs to see it.
 *
 * - `idle`: nothing to claim. The loop sleeps its idle backoff -- AFTER releasing its slot.
 * - `completed`: a terminal result is written, the record is final, the entry is acked.
 * - `redelivered`: retryable. No result, no finalize, NO ack -- the entry stays pending and another
 *   worker reclaims it after `minIdleMs`.
 * - `dead_lettered`: past `maxAttempts` (or malformed). Acked without running.
 * - `refused`: the turn must not run -- the control plane would not mint, or the record already
 *   carried a cancel request and was finalized `cancelled` without running (#391). Acked, because an
 *   entry nobody may run would otherwise be re-read until it exhausts `maxAttempts` -- three wasted
 *   deliveries for a turn whose answer will not change.
 * - `lost`: a heartbeat found the entry owned by someone else, so this run's work is discarded --
 *   no result, no finalize, NO ack. The reclaiming worker owns the turn and ends it.
 * - `deferred`: the turn's owner is at their per-worker cap, so the entry was handed back UNRUN and
 *   unpenalised (#391). Not a failure and not progress: the loop backs off as it does on `idle`,
 *   because claiming again immediately would re-read the same owner's next entry.
 *
 * Every outcome but `idle` carries `reclaimed`, because `async_reclaims` (§7) counts XAUTOCLAIM
 * firing, and a reclaimed entry that then dead-letters or is refused is exactly the case that
 * signal exists to show. Putting the flag only on `completed` would hide the worst of them. The
 * counter reads as "workers die mid-leaf" only NET of `async_deferred_subject`: a hand-back comes
 * back by the same XAUTOCLAIM, and nothing here can tell the two apart (§7).
 */
/**
 * The watchdog's period (#391). Two seconds, not the heartbeat's thirty: §4.5 asks that a cancel
 * release the sandbox within ten, and the poll it costs is one HGET per running leaf.
 */
export const CANCEL_POLL_MS = 2_000;

export type ProcessOutcome =
  | { kind: 'idle' }
  | { kind: 'completed'; turnId: string; status: LeafResult['status']; reclaimed: boolean }
  | { kind: 'redelivered'; turnId: string; reclaimed: boolean }
  | { kind: 'dead_lettered'; turnId: string; reclaimed: boolean }
  | { kind: 'refused'; turnId: string; reclaimed: boolean }
  | { kind: 'lost'; turnId: string; reclaimed: boolean }
  | { kind: 'deferred'; turnId: string; reclaimed: boolean };

/**
 * Claim and process at most one queue entry.
 *
 * The CALLER must already hold an admission slot before calling this (§5.3): taking it afterwards
 * would leave a window in which the cap is checked against a count that does not include this
 * claim. The claim is non-blocking by default (`blockMs`) precisely because the slot is held across
 * it -- so the slot is reserved for about two Redis round trips, not for a 5 s wait.
 *
 * A `runLeaf` throw propagates. That is deliberate and is the retry path: the heartbeat is cleared,
 * nothing is written, nothing is acked, so the entry is reclaimed. The loop catches it.
 */
export async function processOne(deps: LeafJobDeps): Promise<ProcessOutcome> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 0;

  const claimed = await deps.queue.claim(deps.consumerId, { minIdleMs, blockMs });
  if (!claimed) return { kind: 'idle' };

  // An entry with no turn id resolves to no record, so there is nothing to finalize and nothing to
  // write a result under. Acking is the only way it ever leaves the PEL.
  if (!claimed.turnId) {
    await deps.queue.ack(claimed.entryId);
    return { kind: 'dead_lettered', turnId: '', reclaimed: claimed.reclaimed };
  }

  if (claimed.deliveryCount > maxAttempts) {
    await deps.deadLetter(claimed.turnId);
    await deps.queue.ack(claimed.entryId);
    return { kind: 'dead_lettered', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  // The record can ALREADY carry the cancel flag (§4.5, #391): a cancel that landed while the
  // previous worker was dying leaves the turn `running` with `cancelRequested` set, and this delivery
  // is the reclaim. Honoured HERE, before the fairness slot and before `claimTurn`, so a turn that
  // must not run never mints a credential, never writes an issuance to the audit log, never leases a
  // sandbox, and never waits out another owner's cap first.
  //
  // A failed poll reads as "no cancel" and the turn RUNS: the in-run watchdog re-polls every
  // `cancelPollMs` and aborts within §4.5's ten seconds, so a Redis blip at claim time costs a few
  // seconds of a sandbox rather than a turn. Do not turn this catch into a refusal -- that would
  // make a blip strand a turn nobody asked to cancel.
  if (await deps.cancelRequested?.(claimed.turnId).catch(() => false)) {
    // No result record, exactly as a cancel while `queued` leaves none. `finalize` maps `aborted` to
    // `cancelled`, and the entry is acked because nothing will ever run it.
    await deps.finalize(claimed.turnId, 'aborted');
    await deps.queue.ack(claimed.entryId);
    return { kind: 'refused', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  // FAIRNESS (#391). The queue is one FIFO stream, so an entry's owner is unknowable until it is
  // claimed -- which is why this is a check-and-hand-back rather than a filter on the read. One
  // owner's fan-out holds at most `SH_TURNS_PER_SUBJECT` of this worker's slots, the same cap an
  // interactive `/turn` is held to and counted against the same `SubjectCounter`, so an owner whose
  // leaves are running cannot also fill the worker with interactive turns. Before `claimTurn`
  // deliberately: a turn that may not run yet must not have a credential minted for it, must not
  // flip to `running`, and must not appear in the audit log as an issuance.
  //
  // shortcut: this bounds an owner's MIXED load, not an async-only drain -- a worker runs one queued
  // leaf at a time, so async alone never reaches a cap of max(1, S/2) and A's deep backlog is still
  // served ahead of B's single turn. Upgrade when async-only fan-out from several owners is real:
  // the count has to be cluster-wide (per-owner streams, or a per-owner running count checked at the
  // dequeue exchange), which no in-process counter can provide. Open on #391; spec §12 has the shape.
  let releaseOwner = deps.admitOwner ? await deps.admitOwner(claimed.turnId) : noRelease;
  if (!releaseOwner) {
    if (entryAgeMs(claimed.entryId) < (deps.deferCeilingMs ?? DEFER_CEILING_MS)) {
      // Handed back UNRUN and at no cost to its attempt budget; see `defer`'s own doc for why the
      // entry then waits out `minIdleMs` rather than being instantly reclaimable.
      //
      // A throw here (a Redis blip mid-hand-back) must not propagate: the entry has already left
      // XREADGROUP's reach and sits in this consumer's PEL either way, so it returns via XAUTOCLAIM
      // after `minIdleMs` -- the same wait a successful defer costs it. The one lost effect is the
      // attempt refund, so this is logged rather than swallowed: a run of these means pacing is
      // charging deliveries, and an owner's entries could reach `maxAttempts` by being paced.
      try {
        await deps.queue.defer(claimed.entryId, deps.consumerId, claimed.deliveryCount - 1);
      } catch (err) {
        (deps.log ?? console.warn)(
          `[async] hand-back failed for entry ${claimed.entryId} (turn ${claimed.turnId}): ${
            err instanceof Error ? err.message : String(err)
          }; it returns on the reclaim path with this delivery charged`,
        );
      }
      return { kind: 'deferred', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
    }
    // Past the ceiling, so fairness yields: see DEFER_CEILING_MS. Logged because this is the one
    // trace a starving owner leaves -- `async_deferred_subject` counts defers in aggregate and
    // cannot tell "paced for 90 s" from "waiting since this morning".
    (deps.log ?? console.warn)(
      `[async] entry ${claimed.entryId} for turn ${claimed.turnId} deferred past the ceiling: running it over its owner's share`,
    );
    releaseOwner = noRelease;
  }
  try {
    return await runClaimedEntry(deps, claimed);
  } finally {
    // Idempotent (`SubjectCounter.acquire`), and in a `finally` around the whole of the run rather
    // than beside each of its returns: every path out gives the owner their slot back, including a
    // throw, which would otherwise leak one of their slots for the life of the process.
    releaseOwner();
  }
}

/**
 * How long an entry may be handed back before fairness yields to it (#391). A defer costs the entry
 * `minIdleMs` (90 s) and refunds its attempt budget, so nothing else bounds the number of deferrals:
 * an owner who stays at their cap -- a long interactive turn, or a slot leaked on another worker --
 * would otherwise have their queued turns deferred forever, never run and never dead-lettered, with
 * `turnExp` never starting because it is anchored at a dequeue that never comes.
 *
 * Ten minutes: a few rounds of pacing are the normal case, and past this the entry is being starved
 * rather than paced. It then runs on the worker's own admission slot, one leaf over its owner's
 * share, which is the smaller harm -- the global `SH_TURNS_PER_WORKER` cap still holds.
 */
export const DEFER_CEILING_MS = 600_000;

/**
 * How long ago this entry was enqueued, from the stream id's millisecond part -- so the ceiling
 * above costs no extra read. An id that does not parse reads as age 0, i.e. keep pacing it: the
 * fairness cap is the behaviour worth preserving when the clock is unknowable.
 */
function entryAgeMs(entryId: string): number {
  const enqueuedMs = Number(entryId.split('-')[0]);
  return Number.isFinite(enqueuedMs) ? Math.max(0, Date.now() - enqueuedMs) : 0;
}

/** The no-cap answer, so a caller without `admitOwner` takes exactly the admitted path. */
const noRelease = () => {};

/**
 * Everything from the claim handshake to the ack. Its own function so that the owner's fairness
 * slot can be released in one `finally` wrapped around all of it.
 */
async function runClaimedEntry(deps: LeafJobDeps, claimed: ClaimedEntry): Promise<ProcessOutcome> {
  // A third of minIdleMs: two consecutive misses still leave the entry un-reclaimable.
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? console.warn;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const turn = await deps.claimTurn(claimed.turnId, claimed.deliveryCount);
  if (!turn) {
    await deps.queue.ack(claimed.entryId);
    return { kind: 'refused', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  // Set by a heartbeat that finds the entry owned by someone else. There is no cancellation path
  // into `runLeaf`, so this run still finishes -- but its OUTPUT is discarded below.
  let lost = false;
  const hb = setTimer(() => {
    // Fire-and-forget, so a rejection here (e.g. the client was destroyed by a stop() racing this
    // leaf's shutdown, or a transient Redis blip) must not become an unhandled rejection that kills
    // a process also serving healthy sync traffic. A missed touch is already non-fatal by design:
    // the entry simply becomes reclaimable after minIdleMs, which is the same outcome a dropped
    // heartbeat produces on purpose.
    void deps.queue
      .touch(claimed.entryId, deps.consumerId)
      .then((held) => {
        // `touch` refuses to steal the entry back (see its doc), so a false here means another
        // worker reclaimed it -- or it is already acked and gone. Logged loudly either way: it is
        // the only trace the duplicate run leaves, and it means this worker stalled past
        // minIdleMs, which is a condition worth seeing on its own.
        if (!held) {
          lost = true;
          log(
            `[async] lost entry ${claimed.entryId} for turn ${claimed.turnId}: reclaimed elsewhere or already acked`,
          );
        }
      })
      .catch(() => undefined);
  }, heartbeatMs);
  // The leaf's stop (#391). Aborted by the watchdog below on a cancel request or the turn's
  // deadline; the REASON is what tells the two apart downstream -- `DEADLINE_ABORT` finalizes
  // `failed: budget`, anything else `cancelled`.
  const stop = new AbortController();
  // A deadline already in the past is only knowable after the claim, which is what anchors it. The
  // run short-circuits on it: `runLeaf` reads an already-aborted signal before it leases anything,
  // so this finalizes `failed: budget` through the ordinary path without starting a leaf.
  const deadlineMs = turn.turnExp ? turn.turnExp * 1000 : undefined;
  if (deadlineMs !== undefined && deadlineMs <= Date.now()) stop.abort(DEADLINE_ABORT);

  // Not armed when there is nothing for it to watch: a caller with no `cancelRequested` against a
  // control plane that sends no `turnExp` (both pre-#391) would otherwise pay a timer per leaf for a
  // tick that can never abort anything.
  const watchdog =
    stop.signal.aborted || (!deps.cancelRequested && deadlineMs === undefined)
      ? undefined
      : setTimer(() => {
          if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
            stop.abort(DEADLINE_ABORT);
            return;
          }
          // Fire-and-forget for the heartbeat's reason: a rejection here must not become an
          // unhandled rejection in a process also serving sync traffic. A failed poll just means
          // the cancel is noticed on the next tick.
          void deps
            .cancelRequested?.(claimed.turnId)
            .then((asked) => {
              if (asked) stop.abort('cancelled');
            })
            .catch(() => undefined);
        }, deps.cancelPollMs ?? CANCEL_POLL_MS);

  let result: LeafResult;
  try {
    result = await deps.runLeaf(turn.envelope, turn.config, stop.signal);
  } finally {
    clearTimer(hb);
    if (watchdog !== undefined) clearTimer(watchdog);
  }

  // The turn belongs to whoever holds the entry, and that is no longer this worker: drop this run's
  // output entirely. Each of the three writes below would corrupt the owner's turn --
  //
  // - `writeResult` is an unconditional SET, so finishing SECOND would leave the owner's `done`
  //   record beside this run's body, which may say `failed`;
  // - `finalize` is a CAS the owner wins, so this call is at best a no-op;
  // - XACK takes no consumer, so acking retires the OWNER's PEL entry -- removing the redelivery
  //   that would otherwise cover the owner dying mid-leaf.
  //
  // Residual window: a heartbeat can discover the loss in the gap between this check and the ack.
  // That is one beat wide instead of a whole leaf wide, and the writes it can still interleave are
  // the ones above; closing it properly needs an owner-checked ack, which Redis streams do not have.
  if (lost) {
    return { kind: 'lost', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  const outcome = classifyOutcome(result);
  if (outcome.retryable || !outcome.ack) {
    return { kind: 'redelivered', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  // Written under the TURN RECORD's session id AND this turn's id, not `leafSessionId(envelope)`.
  // The latter tenant-prefixes before sanitising (run-leaf.ts:183-185) while the control plane reads
  // the record's session id raw (turn-result.ts), and a record's tenant is never empty
  // (ownership.ts:208) -- so the prefixed key is one no reader ever looks at. The turn id is in the
  // key because §4.3 lets one session hold several queued turns at once: under a per-session key the
  // second to finish would overwrite the first's answer. The envelope's own session id still travels
  // INSIDE the record, for caller correlation.
  //
  // Result first, then finalize, then ack, and the order is load-bearing: a reader that sees a
  // terminal record must be able to fetch its result. A crash between the first two leaves a result
  // the reaper later replaces with `failed/error` -- which is the honest answer for a worker that
  // died mid-finalize.
  await writeResult(
    deps.resultStore,
    turn.sessionId,
    toResultRecord(result, turn.envelope.sessionId, now()),
    deps.ttlSeconds,
    claimed.turnId,
  );
  await deps.finalize(claimed.turnId, result.status);
  await deps.queue.ack(claimed.entryId);
  return {
    kind: 'completed',
    turnId: claimed.turnId,
    status: result.status,
    reclaimed: claimed.reclaimed,
  };
}
