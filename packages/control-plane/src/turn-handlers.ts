import { countAsync } from './counters.js';
import { CpError } from './errors.js';
import { auditBestEffort } from './handler-util.js';
import { assertOwner, type CpDeps, type Handler, type RequestCtx } from './handlers.js';
import type { SessionRecord } from './ownership.js';
import { isTerminalState, parseTurnSubmission, type TurnRecord } from './turn-record.js';
import { readLeafResult } from './turn-result.js';
import type { TurnQueue } from './turn-queue.js';
import type { TurnStore } from './turn-store.js';

/**
 * The async turn routes (async fan-out spec §4.1, §4.4, §4.5), spread into HANDLERS by handlers.ts.
 * Only TYPES come from handlers.ts -- a runtime import back would be a module cycle, which is the
 * same arrangement sandbox-handlers.ts uses.
 *
 * `sessionScoped: true` in the route table is DATA, read by the authz enumeration test and by nobody
 * at runtime: the router does not act on it. So every handler here calls `assertOwner` itself, and
 * calls it FIRST -- the enumeration sweep invokes each session-scoped handler with `params.id` and
 * no `turnId`, expecting `session_not_found`, so a handler that read `params.turnId` or validated a
 * body first would answer the wrong code to a stranger and fail that sweep.
 */

function service(deps: CpDeps): { turns: TurnStore; queue: TurnQueue } {
  // depsFromEnv always builds both. Either missing is a wiring bug, not a caller error.
  if (!deps.turns || !deps.turnQueue) {
    throw new CpError('internal_error', 'async turn submission is not configured');
  }
  return { turns: deps.turns, queue: deps.turnQueue };
}

const refusal = (deps: CpDeps, rec: SessionRecord, reason: string) =>
  auditBestEffort(deps, 'turn_refused', rec.sessionId, {
    subject: rec.owner,
    sessionId: rec.sessionId,
    decision: 'turn_refused',
    reason,
  });

/**
 * The turn addressed by the path, or a 404. Two separate checks, both 404 rather than 403, for the
 * reason assertOwner gives: a distinguishable answer is an existence oracle. The SESSION check
 * matters as much as the owner one -- without it, `GET /v1/sessions/{b}/turns/{t}` would report a
 * turn belonging to a different session of the same owner.
 */
async function turnOnSession(
  ctx: RequestCtx,
  deps: CpDeps,
  rec: SessionRecord,
): Promise<TurnRecord> {
  const { turns } = service(deps);
  const turnId = ctx.params.turnId ?? '';
  const turn = turnId ? await turns.get(turnId) : null;
  if (!turn || turn.owner !== rec.owner || turn.sessionId !== rec.sessionId) {
    throw new CpError('not_found', 'no such turn on this session');
  }
  return turn;
}

/**
 * Claim `key`, stepping over a holder whose turn is already terminal. One retry, not a loop: the
 * only way the second claim loses is another submission winning the key in between, and that
 * submission's turn is by definition non-terminal, so returning its id is the right answer anyway.
 *
 * The release is CONDITIONAL on the stale holder we actually read, and that compare is what keeps
 * one key to one turn. Two submissions can both read the same terminal holder; the first then
 * releases, re-claims and creates its record. An unconditional release would let the second delete
 * that live claim and create a SECOND record and queue entry for one key -- exactly the duplicate
 * fan-out idempotency exists to prevent (§4.3). Comparing means the loser's release is a no-op, so
 * its second claim loses too and it returns the winner's id, the same answer a live holder gives.
 */
async function claimKey(
  turns: TurnStore,
  owner: string,
  key: string,
  turnId: string,
): Promise<{ turnId: string; fresh: boolean }> {
  const held = await turns.claimIdempotencyKey(owner, key, turnId);
  if (held === turnId) return { turnId, fresh: true };
  const existing = await turns.get(held);
  if (existing && !isTerminalState(existing.state)) return { turnId: held, fresh: false };
  // The holder finished (or its record is gone): the key is stale, so release THAT holder and take
  // it. The second claim re-reads the holder, so losing the compare and losing the claim converge.
  await turns.releaseIdempotencyKeyIf(owner, key, held);
  const second = await turns.claimIdempotencyKey(owner, key, turnId);
  return { turnId: second, fresh: second === turnId };
}

export const TURN_HANDLERS: Record<string, Handler> = {
  /**
   * POST /v1/sessions/{id}/turns (§4.1). 202 with the turn id and nothing else.
   *
   * The order below is specified, not incidental (§4.2, §4.3): ownership, then shape, then the
   * workload refusal, then the tenancy gate, then the quota, then idempotency, then create-and-
   * enqueue. Each later step would otherwise answer for an earlier one -- most visibly the workload
   * 501, which must not be reported as a 429 for a request that can never be served at all.
   */
  submitTurn: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    if (rec.tombstone) throw new CpError('session_not_found', undefined, rec.sessionId);
    const { turns, queue } = service(deps);
    const parsed = parseTurnSubmission(ctx.body);

    if (parsed.workloadId !== undefined) {
      await refusal(deps, rec, 'workload_runs_unavailable');
      throw new CpError(
        'workload_runs_unavailable',
        'workload runs are unavailable; submit a leaf turn without workloadId',
      );
    }
    if (deps.config.tenancy === 'multi') {
      await refusal(deps, rec, 'async_tenancy_unsupported');
      throw new CpError(
        'async_tenancy_unsupported',
        'async turns require MOCA_TENANCY=single in this release (ADR-0047); the multi-tenant path is M2',
      );
    }

    // Pre-enqueue, so a refusal leaves nothing behind (§4.3): no record, no entry, no key claimed.
    const open = await turns.countOpen(rec.owner);
    if (open >= deps.config.asyncQueuedPerOwner) {
      countAsync('async_quota_refusals');
      await refusal(deps, rec, 'async_quota_exhausted');
      throw new CpError(
        'async_quota_exhausted',
        `you already have ${open} non-terminal async turns (limit ${deps.config.asyncQueuedPerOwner}); wait for one to finish`,
      );
    }

    const idempotencyKey = parsed.idempotencyKey ?? rec.sessionId;
    const candidate = `t-${deps.newId()}`;
    const claim = await claimKey(turns, rec.owner, idempotencyKey, candidate);
    if (!claim.fresh) {
      // A resubmission on a live key returns the EXISTING turn and enqueues nothing (§4.3): a client
      // retrying a 202 it already received must not fan out twice.
      return { status: 202, body: { sessionId: rec.sessionId, turnId: claim.turnId } };
    }

    const turn: TurnRecord = {
      turnId: claim.turnId,
      owner: rec.owner,
      tenant: rec.tenant,
      sessionId: rec.sessionId,
      cfg: rec.configRef ?? '',
      // The NAME. Resolved against the owner's credentials at dequeue (§5.4), never carried.
      credentialName: rec.credentialName,
      caps: parsed.caps,
      idempotencyKey,
      envelope: parsed.envelope,
      state: 'queued',
      attempts: 0,
      createdAt: deps.now(),
    };
    await turns.create(turn);
    try {
      await queue.enqueue(turn.turnId);
    } catch (err) {
      // A `queued` record with no queue entry is the one leak this path can produce: nothing would
      // ever claim it, so it would never go terminal and therefore never acquire a TTL (§5.1).
      // Finalize it and release the key, so the caller's retry is not deduplicated against a turn
      // that will never run.
      await turns.finalize(turn.turnId, 'failed', deps.now());
      await turns.releaseIdempotencyKey(rec.owner, idempotencyKey);
      throw err;
    }
    await auditBestEffort(deps, 'turn_submitted', turn.turnId, {
      subject: rec.owner,
      sessionId: rec.sessionId,
      turnId: turn.turnId,
      credential: rec.credentialName,
      decision: 'turn_submitted',
    });
    return { status: 202, body: { sessionId: rec.sessionId, turnId: turn.turnId } };
  },

  /**
   * GET /v1/sessions/{id}/turns/{turnId} (§4.4). `state` and `attempts` come from the record -- the
   * single source of truth -- and `result` from the leaf result store once the leaf has written one.
   * `/runs/status` is deliberately untouched and keeps inferring status from the result store.
   */
  getTurn: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const turn = await turnOnSession(ctx, deps, rec);
    // Only once the turn is TERMINAL. The result key is per SESSION and shared with the synchronous
    // path, so a session that ran an interactive turn and then submitted an async one would report
    // `queued` beside the PREVIOUS turn's result, and a caller polling for completion would read it
    // as this turn's. Nothing is written for an async turn until it finishes, so there is no partial
    // result being withheld here (§4.4).
    const result = isTerminalState(turn.state)
      ? deps.leafResults
        ? await readLeafResult(deps.leafResults, turn.sessionId)
        : null
      : null;
    return {
      status: 200,
      body: {
        turnId: turn.turnId,
        state: turn.state,
        attempts: turn.attempts,
        ...(result ? { result } : {}),
      },
    };
  },

  /**
   * DELETE /v1/sessions/{id}/turns/{turnId} (§4.5). A `queued` turn flips to `cancelled` and the
   * drain loop drops it at claim. Anything else is a 409 naming the state: a running leaf is NOT
   * interrupted, because interrupting one needs control-plane-to-specific-worker machinery that does
   * not exist (interactive cancel rides the turn's own connection; async has none). Owed in §12.
   */
  cancelTurn: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const turn = await turnOnSession(ctx, deps, rec);
    const { turns } = service(deps);
    const outcome = await turns.cancel(turn.turnId, deps.now());
    if (outcome === 'conflict') {
      throw new CpError(
        'turn_not_cancellable',
        `this turn is '${turn.state}'; only a queued turn can be cancelled`,
      );
    }
    await auditBestEffort(deps, 'turn_cancelled', turn.turnId, {
      subject: rec.owner,
      sessionId: rec.sessionId,
      turnId: turn.turnId,
      decision: 'turn_cancelled',
    });
    return { status: 202, body: { turnId: turn.turnId, state: 'cancelled' } };
  },
};
