import type { CpDeps } from './handlers.js';
// `turn-handlers.js` is in a runtime cycle with `handlers.js` (it imports `assertOwner` from it), so
// a module that reaches THIS file before `handlers.js` enters the cycle from the wrong side: HANDLERS
// then spreads a TURN_HANDLERS that is still uninitialized and silently serves no turn routes.
// main.ts imports `server.js` well before this one, which is what keeps the production order right.
import { pausedGateId, submitResume } from './turn-handlers.js';

/**
 * How often the deadline sweep runs (#393 §3). Fixed rather than configurable: it is the GRANULARITY
 * of a gate deadline, not a policy -- a deployment that wants gates answered sooner shortens the
 * deadline, and no deployment needs to pay for a sweep that runs more often than that.
 */
export const GATE_SWEEP_INTERVAL_MS = 30_000;

/** Reaches the model as the decision's feedback, so it says what happened in a sentence it can act on. */
export const GATE_TIMEOUT_FEEDBACK = 'No decision was recorded before the gate deadline expired.';

/** How many gates one pass will answer. Bounds the work a single interval can do, not the backlog. */
const SWEEP_LIMIT = 100;

/**
 * Resume every gate whose deadline has passed, with the paused turn's `onTimeout` (#393 §3).
 *
 * `abort` by default and `approve` NEVER: a clock cannot consent. The gate exists because a human was
 * supposed to say yes, so its expiry is the absence of a yes -- `reject` is as lenient as the
 * contract allows, and a submission opts into it.
 *
 * Returns what THIS caller resumed. Every replica runs the same pass; `claimGate`'s ZREM is what
 * makes exactly one of them do the work (and `submitResume`'s gate-keyed idempotency key is what
 * makes it harmless if two somehow do).
 */
export async function sweepGates(deps: CpDeps, limit = SWEEP_LIMIT): Promise<number> {
  const turns = deps.turns;
  if (!turns) return 0;
  let resumed = 0;
  for (const turnId of await turns.dueGates(deps.now(), limit)) {
    try {
      const paused = await turns.get(turnId);
      if (!paused) {
        // Its record expired (`toTerminal` armed a TTL on it). Nothing left to resume and nothing
        // left to read -- so take the member out rather than carry it forever.
        await turns.claimGate(turnId);
        continue;
      }
      const gateId = await pausedGateId(deps, paused);
      if (gateId === null) {
        // The result is not readable YET: the record's state is written before its result, and a
        // decision needs the gate id. Left in the index for the next pass, which the record's own
        // TTL bounds -- when that expires, the branch above drops the member.
        continue;
      }
      // Claimed as late as possible: everything above is a read, and a claim that is not followed by
      // a submission strands the gate.
      if (!(await turns.claimGate(turnId))) continue;
      // The member can be STALE: `submitResume` claims the gate only after its enqueue, so a crash
      // or a Redis error in between leaves the member behind on a gate that was in fact answered.
      // `toTerminal` then releases the gate-keyed idempotency key when that resume finishes, so the
      // key no longer converges us onto it and this pass would build a SECOND resume from the same
      // paused turn -- the continuation running twice, double spend for one decision.
      //
      // The same question the catch block below asks, and for the same reason it asks it; the
      // difference is that this path has no exception to notice. `resumeOf` is what makes it
      // answerable: it is durable, unlike the key. Nothing to hand back -- the claim above took the
      // stale member out, which is exactly where an answered gate belongs.
      const already = await turns.findPausedBySession(paused.sessionId);
      if (already?.paused.turnId === paused.turnId && already.resumed) continue;
      let created: boolean;
      try {
        ({ created } = await submitResume(deps, paused, {
          gateId,
          action: paused.onTimeout ?? 'abort',
          feedback: GATE_TIMEOUT_FEEDBACK,
        }));
      } catch (err) {
        // Hand the claim back, or this gate's deadline never fires again: the ZREM is the lock, so
        // the member is the only thing that brings a later pass back to it. Re-added at the deadline
        // it already had, which `toTerminal` scored as `paused-at + gateDeadlineS`.
        //
        // ONLY while the gate is still UNANSWERED, which is the same question the decision route
        // asks: a human decision can land in the window this submission failed in, and handing the
        // member back then would let a later pass build a SECOND resume from the same paused turn --
        // the continuation running twice, double spend and double side effects for one decision. The
        // gate-keyed idempotency key cannot answer it, because `toTerminal` releases that key as
        // soon as the resume finishes; `resumeOf` on the record is durable, so this reads it.
        //
        // `found` must be THIS turn and unresumed. A newest-paused that is some other turn means the
        // chain moved on -- somebody's resume ran and paused at a gate of its own, which has its own
        // member -- and a `resumed` marker means the gate is answered. This submission's own failed
        // resume does not count (`findPausedBySession` skips a `failed` one), so the ordinary enqueue
        // failure still hands back.
        //
        // Its own try/catch: a hand-back that throws must not replace the error that caused it.
        try {
          const found = await turns.findPausedBySession(paused.sessionId);
          if (found?.paused.turnId === paused.turnId && !found.resumed) {
            const dueAt = (paused.endedAt ?? deps.now()) + (paused.gateDeadlineS ?? 0) * 1000;
            await turns.releaseGate(turnId, dueAt);
          }
        } catch (handBack) {
          console.error(`[gate-sweep] ${turnId}: gate hand-back failed:`, handBack);
        }
        throw err;
      }
      // Only a resume this pass actually CREATED. A human's `submitResume` that claimed the gate key
      // between our `claimGate` and our own submission hands us their turn id back, and counting it
      // would report a gate this sweep expired when a human answered it.
      if (created) resumed += 1;
    } catch (err) {
      // One bad gate must not strand the rest of the pass. Logged, not rethrown: the next interval
      // retries whatever is still indexed, including the gate this pass handed back.
      console.error(`[gate-sweep] ${turnId}:`, err);
    }
  }
  return resumed;
}

/**
 * Start the periodic sweep. UNREF'ED, like `@moca/server`'s async reaper: a timer that keeps the
 * event loop alive turns a drained SIGTERM into a hang.
 */
export function startGateSweep(deps: CpDeps, intervalMs = GATE_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    // Same fix as notify-sweep.ts's startNotifySweep: an unhandled rejection here terminates the
    // process on Node 22 by default, so a Redis blip would restart the control plane every tick.
    void sweepGates(deps).catch((err) => console.error('[gate-sweep]', err));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
