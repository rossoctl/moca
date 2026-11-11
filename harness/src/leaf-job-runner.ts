import type { WorkQueue } from '@moca/work-queue';
import { classifyOutcome } from './classify-outcome.js';
import type { LeafEnvelope, LeafResult } from './run-leaf.js';
import type { TurnConfig } from './run-turn.js';
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
   * and model. Typed as the harness's own `TurnConfig` rather than `knative-server`'s `TurnAuth`,
   * because this package is the one `knative-server` depends on, not the other way round.
   */
  config: TurnConfig;
}

export interface LeafJobDeps {
  queue: WorkQueue;
  consumerId: string;
  /**
   * Mint the credential and flip the record queued->running. `null` means the control plane refused:
   * the turn is cancelled or already terminal, and must not run.
   *
   * Injected because reaching the control plane is `@moca/knative-server`'s business, and because
   * every test of this function would otherwise need an HTTP server.
   */
  claimTurn: (turnId: string, deliveryCount: number) => Promise<ClaimedTurn | null>;
  /** `runLeaf` itself in production; the second argument is the claim's own config. */
  runLeaf: (env: LeafEnvelope, config: TurnConfig) => Promise<LeafResult>;
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
  blockMs?: number;
  heartbeatMs?: number;
  now?: () => string;
  setHeartbeat?: (fn: () => void, ms: number) => unknown;
  clearHeartbeat?: (handle: unknown) => void;
}

/**
 * One claim's outcome, as the drain loop needs to see it.
 *
 * - `idle`: nothing to claim. The loop's BLOCK has already slept; it does not sleep again.
 * - `completed`: a terminal result is written, the record is final, the entry is acked.
 * - `redelivered`: retryable. No result, no finalize, NO ack -- the entry stays pending and another
 *   worker reclaims it after `minIdleMs`.
 * - `dead_lettered`: past `maxAttempts` (or malformed). Acked without running.
 * - `refused`: the control plane would not mint. Acked, because an entry nobody may run would
 *   otherwise be re-read until it exhausts `maxAttempts` -- three wasted deliveries for a turn
 *   whose answer will not change.
 *
 * Every outcome but `idle` carries `reclaimed`, because `async_reclaims` (§7) counts XAUTOCLAIM
 * firing -- "a nonzero steady rate means workers die mid-leaf" -- and a reclaimed entry that then
 * dead-letters or is refused is exactly the case that signal exists to show. Putting the flag only
 * on `completed` would hide the worst of them.
 */
export type ProcessOutcome =
  | { kind: 'idle' }
  | { kind: 'completed'; turnId: string; status: LeafResult['status']; reclaimed: boolean }
  | { kind: 'redelivered'; turnId: string; reclaimed: boolean }
  | { kind: 'dead_lettered'; turnId: string; reclaimed: boolean }
  | { kind: 'refused'; turnId: string; reclaimed: boolean };

/**
 * Claim and process at most one queue entry.
 *
 * The CALLER must already hold an admission slot before calling this (§5.3): the first thing here is
 * `queue.claim`, which BLOCKs, so taking the slot afterwards would leave a window in which the cap
 * is checked against a count that does not include this claim.
 *
 * A `runLeaf` throw propagates. That is deliberate and is the retry path: the heartbeat is cleared,
 * nothing is written, nothing is acked, so the entry is reclaimed. The loop catches it.
 */
export async function processOne(deps: LeafJobDeps): Promise<ProcessOutcome> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 5_000;
  // A third of minIdleMs: two consecutive misses still leave the entry un-reclaimable.
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const now = deps.now ?? (() => new Date().toISOString());
  const setHb = deps.setHeartbeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearHb =
    deps.clearHeartbeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

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

  const turn = await deps.claimTurn(claimed.turnId, claimed.deliveryCount);
  if (!turn) {
    await deps.queue.ack(claimed.entryId);
    return { kind: 'refused', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  const hb = setHb(() => {
    void deps.queue.touch(claimed.entryId, deps.consumerId);
  }, heartbeatMs);
  let result: LeafResult;
  try {
    result = await deps.runLeaf(turn.envelope, turn.config);
  } finally {
    clearHb(hb);
  }

  const outcome = classifyOutcome(result);
  if (outcome.retryable || !outcome.ack) {
    return { kind: 'redelivered', turnId: claimed.turnId, reclaimed: claimed.reclaimed };
  }

  // Written under the TURN RECORD's session id, not `leafSessionId(envelope)`. The latter
  // tenant-prefixes before sanitising (run-leaf.ts:183-185) while the control plane reads
  // `leaf:result:${turn.sessionId}` raw (turn-result.ts:13), and a record's tenant is never empty
  // (ownership.ts:208) -- so the prefixed key is one no reader ever looks at. The envelope's own
  // session id still travels INSIDE the record, for caller correlation.
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
