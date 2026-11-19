import { createHash } from 'node:crypto';
import { countAsync } from './counters.js';
import { CpError } from './errors.js';
import { auditBestEffort } from './handler-util.js';
import { assertOwner, type CpDeps, type Handler, type RequestCtx } from './handlers.js';
import type { SessionRecord } from './ownership.js';
import { isTerminalState, parseTurnSubmission, type TurnRecord } from './turn-record.js';
import { pickArtifact, projectLeafResult, readLeafResult } from './turn-result.js';
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
   * workload refusal, then the quota, then idempotency, then create-and-enqueue. Each later step
   * would otherwise answer for an earlier one -- most visibly the workload 501, which must not be
   * reported as a 429 for a request that can never be served at all. ADR-0047's tenancy gate used to
   * sit between the two; #388 deleted it, because the dequeue now mints grants rather than refusing.
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

    // Pre-enqueue, so a refusal leaves nothing behind (§4.3): no record, no entry, no key claimed,
    // no slot held. The slot is RESERVED rather than counted, because a read-then-check cannot hold
    // a limit against parallel submitters -- they all read the same under-limit count and all pass.
    // `reserveOpenSlot` writes first and counts after, so the count a submission sees includes
    // itself and only one of any over-limit batch can be under the limit.
    const candidate = `t-${deps.newId()}`;
    const held = await turns.reserveOpenSlot(rec.owner, candidate, deps.now());
    if (held > deps.config.asyncQueuedPerOwner) {
      await turns.releaseOpenSlot(rec.owner, candidate);
      countAsync('async_quota_refusals');
      await refusal(deps, rec, 'async_quota_exhausted');
      throw new CpError(
        'async_quota_exhausted',
        // The count WITHOUT this submission, which is what the caller already has.
        `you already have ${held - 1} non-terminal async turns (limit ${deps.config.asyncQueuedPerOwner}); wait for one to finish`,
      );
    }

    const idempotencyKey = parsed.idempotencyKey ?? rec.sessionId;
    const claim = await claimKey(turns, rec.owner, idempotencyKey, candidate);
    if (!claim.fresh) {
      // A resubmission on a live key returns the EXISTING turn and enqueues nothing (§4.3): a client
      // retrying a 202 it already received must not fan out twice. The reservation belongs to a turn
      // that will now never exist, so it goes back -- left behind it would burn a quota slot on a
      // member with no record, and nothing else in this design removes one.
      await turns.releaseOpenSlot(rec.owner, candidate);
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
      // Copied for the reason `cfg` and `credentialName` are: the turn spends these unchanged, and a
      // queued turn can wait an hour, so reading them from the live session at dequeue let a
      // `PATCH /v1/sessions/{id}` move it onto a model its submitter never chose (#388).
      model: rec.model ?? '',
      ...(rec.modelLimits ? { modelLimits: rec.modelLimits } : {}),
      sandboxTier: rec.sandboxTier ?? '',
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
      //
      // The release COMPARES, and must. `finalize`'s own terminal transition already releases the
      // key (F1), so by the time this line runs the key may belong to SOMEBODY ELSE: a resubmission
      // that arrived in between found this turn terminal, stepped over it (claimKey's stepover) and
      // claimed the key for its own turn. An unconditional `del` would delete that live claim,
      // leaving a live turn with no key -- so the next submission claims the key outright and fans
      // out a second turn for one key, the duplicate §4.3 exists to prevent. The compare makes this
      // a no-op in exactly that case, and still releases the key when it is in fact still ours
      // (`finalize` refused because the record was never written).
      await turns.finalize(turn.turnId, 'failed', deps.now());
      await turns.releaseIdempotencyKeyIf(rec.owner, idempotencyKey, turn.turnId);
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
    // The key carries THIS turn's id, so a sibling turn on the same session -- §4.3 permits one per
    // distinct `idempotencyKey` -- can no longer answer in its place, and a `cancelled` turn (which
    // never ran, §4.5) simply has no key to read.
    //
    // Still gated on terminality, for one narrow window: a worker writes the result, then dies before
    // `finalize`. The record is `running` until the reaper replaces the result with `failed/error`, so
    // the record's own `state` stays the single source of truth for status (§4.4).
    const result =
      isTerminalState(turn.state) && deps.leafResults
        ? await readLeafResult(deps.leafResults, turn.sessionId, turn.turnId)
        : null;
    return {
      status: 200,
      body: {
        turnId: turn.turnId,
        state: turn.state,
        attempts: turn.attempts,
        // Only while a cancel is in flight (#391): the state is still `running`, and this is how a
        // poller tells "running" from "running, stopping".
        //
        // Gated on the STATE, not on the flag alone. The flag is never cleared -- `toTerminal` keeps
        // the whole record for the status read's TTL -- so a leaf that finished before it noticed the
        // cancel would otherwise report `done` plus `cancelRequested: true` forever, which reads as
        // "still stopping" on a turn that is over. The contract (openapi.yaml) says this field is
        // present only on a running turn, so terminality drops it.
        ...(turn.cancelRequested && turn.state === 'running' ? { cancelRequested: true } : {}),
        // PROJECTED, not the stored record (#390): the patch and the assistant text are fetched as
        // artifacts instead, so the RESPONSE is bounded whatever the leaf produced.
        //
        // The READ is not: `readLeafResult` still GETs and JSON.parses the whole stored record, so a
        // four-megabyte patch is still fetched from Redis and parsed per poll -- only not serialised
        // back out. Bounding that too means storing the descriptor under its own key, a second writer
        // in the harness; §4.4 records it as the known limit rather than pretending it is closed.
        ...(result ? { result: projectLeafResult(result, deps.config.turnSummaryBytes) } : {}),
      },
    };
  },

  /**
   * GET /v1/sessions/{id}/turns/{turnId}/artifacts/{kind} (§4.4, B5): the output the status read
   * leaves out, served whole and with its own content type: `patch` and `text`.
   *
   * Every absence is 404 -- unknown kind, a turn still running, a terminal turn with no result,
   * a capture refused for size -- with a message naming which. `turn_not_found` is NOT reused: that
   * code belongs to the dequeue exchange (errors.ts), where it means something else entirely.
   */
  getTurnArtifact: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const turn = await turnOnSession(ctx, deps, rec);
    const kind = ctx.params.kind ?? '';
    if (!isTerminalState(turn.state)) {
      throw new CpError('not_found', `this turn is '${turn.state}'; it has no artifacts yet`);
    }
    const result = deps.leafResults
      ? await readLeafResult(deps.leafResults, turn.sessionId, turn.turnId)
      : null;
    if (!result) throw new CpError('not_found', 'this turn stored no result');
    const artifact = pickArtifact(result, kind);
    if (!artifact) throw new CpError('not_found', `this turn has no '${kind}' artifact`);
    // The CAPTURE's digest of these same bytes, which is also what the status read advertises as
    // `artifacts[].sha256` -- so the ETag and that field cannot disagree, and an 8 MiB patch is not
    // re-hashed on the single event loop once per fetch. Hashed here only for a record that carries
    // no digest (an older worker's, or a solve whose baseline was never captured), and carrying the
    // same `sha256:` prefix the capture writes, so a client comparing the two never has to strip one.
    const etag =
      artifact.sha256 ?? `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;
    return {
      status: 200,
      body: artifact.bytes,
      contentType: artifact.contentType,
      headers: { ETag: `"${etag}"` },
    };
  },

  /**
   * DELETE /v1/sessions/{id}/turns/{turnId} (§4.5). A `queued` turn flips to `cancelled` and the
   * drain loop drops it at claim. A `running` one is REQUESTED (#391): the record keeps its state
   * and carries `cancelRequested`, the worker holding the leaf polls it, aborts the run and
   * finalizes `cancelled`. Both answer 202, because both are accepted-not-done: a leaf that
   * finishes before it notices stays finished, and the caller polls the status read either way.
   * Anything else is a 409 naming the state.
   */
  cancelTurn: async (ctx, deps) => {
    const rec = await assertOwner(ctx.params.id!, ctx.principal, deps);
    const turn = await turnOnSession(ctx, deps, rec);
    const { turns } = service(deps);
    const outcome = await turns.cancel(turn.turnId, deps.now());
    if (outcome === 'conflict') {
      // The state as `cancel` left it, not as this request first read it: a turn that went terminal
      // between the two would otherwise be refused as the `queued` it no longer is, and 409 is the
      // one answer a caller is meant to stop on.
      const fresh = await service(deps).turns.get(turn.turnId);
      throw new CpError(
        'turn_not_cancellable',
        `this turn is '${fresh?.state ?? turn.state}'; only a queued or running turn can be cancelled`,
      );
    }
    await auditBestEffort(deps, 'turn_cancelled', turn.turnId, {
      subject: rec.owner,
      sessionId: rec.sessionId,
      turnId: turn.turnId,
      decision: outcome === 'cancelling' ? 'turn_cancel_requested' : 'turn_cancelled',
    });
    // `state` is the record's own, so a requested cancel reports `running` and never a state the
    // status read cannot also return.
    return outcome === 'cancelling'
      ? { status: 202, body: { turnId: turn.turnId, state: 'running', cancelRequested: true } }
      : { status: 202, body: { turnId: turn.turnId, state: 'cancelled' } };
  },
};
