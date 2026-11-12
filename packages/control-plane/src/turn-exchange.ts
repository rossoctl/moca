import { defaultAuditLog } from './audit-log.js';
import { touchBundle } from './bundle-budget.js';
import { CpError } from './errors.js';
import {
  placeholderFor,
  refuseMisdirectedSecret,
  resolveInference,
  sessionTier,
  type CredentialMode,
  type ExchangeResponse,
} from './exchange.js';
import type { CpDeps } from './handlers.js';
import { isTerminalState, type TurnCaps } from './turn-record.js';

/**
 * The DEQUEUE-time credential exchange (async fan-out spec §5.4, MI1 §6.5). A worker that has just
 * taken a turn id off the queue presents it with its own shared bearer and gets back the credential
 * that turn spends.
 *
 * Why this is a separate function and not a branch in `exchangeCredential`: that one authenticates a
 * SESSION TOKEN THE CALLER PRESENTS, and at dequeue there is no session token. Minting one and putting
 * it in the queue is the single thing MI1 §6.5 forbids -- "no bearer token is ever stored in the work
 * queue. The control plane mints a leaf's grants when a worker takes it off the queue, from a run
 * record the control plane owns, created by the authenticated enqueue." That record is the authority
 * here. Everything AFTER deciding which subject and credential are in play is shared with the session
 * exchange (`resolveInference`, `refuseMisdirectedSecret`, `placeholderFor`, `sessionTier`), so an
 * async turn spends exactly the credential an interactive one would.
 *
 * This READS. It does not claim: `queued -> running` is the consumer's `TurnStore.markRunning` (#389).
 * `SH_EXCHANGE_TOKEN` is one deployment-wide secret, so a write here would let every holder of it flip
 * an arbitrary turn out of `queued` -- and because `cancel` accepts `queued` only, make a caller's own
 * turn permanently uncancellable. `markRunning` re-checks terminality itself, so a `DELETE` landing
 * between this call and that one is still refused there; nothing is stranded.
 *
 * `turnId` is trusted to be a string, not to be well-formed: the `isMintedTurnId` shape gate is the
 * ROUTE's (handlers.exchangeTurnCredential), because what it bounds is caller input reaching a key on
 * a shared-bearer route. A library caller reaching this export directly has already passed whatever
 * gate it answers to, so repeating the check here would only turn its own 404 into a 400.
 *
 * M1 INTERIM (§9.1): it returns the resolved credential, under `MOCA_TENANCY=single` only. M2 replaces
 * the return value with MI1 §6.1's two grants and lifts the tenancy gate. `turn_exp`,
 * `MOCA_TURN_MAX_S` and refresh belong to that slice and are deliberately absent here.
 */
export interface TurnExchangeResponse extends ExchangeResponse {
  turnId: string;
  /** The caps recorded at submission (§4.3). Enforcing them is the worker's job (#389). */
  caps: TurnCaps;
  /**
   * The LeafEnvelope the worker runs, from the record (§5.1), with the record's `sessionId`
   * attached -- `parseTurnSubmission` deliberately stores none, and `LeafEnvelope.sessionId` is
   * required. Returned HERE rather than from a second internal route (§9.2): the handler that
   * answers this call has already loaded the record, so fetching the envelope separately would be
   * two round trips for one read, on a route whose contract is "the id alone is sufficient".
   *
   * It contains no credential and no bearer: the record stores a credential NAME, and the name is
   * not in the envelope either.
   */
  envelope: Record<string, unknown>;
}

export async function exchangeTurnCredential(
  turnId: string,
  deps: CpDeps,
): Promise<TurnExchangeResponse> {
  // depsFromEnv always builds the store, so a missing one is a wiring bug and not a caller error --
  // the same reading turn-handlers.service() applies. Checked rather than asserted so it cannot
  // surface as a TypeError on `undefined.get`.
  if (!deps.turns) {
    throw new CpError('internal_error', 'async turn exchange is not configured');
  }

  const turn = turnId ? await deps.turns.get(turnId) : null;
  if (!turn) {
    // DISTINGUISHABLE from the other claim refusals, deliberately: it is what tells a worker holding
    // a stale entry to ack and drop rather than retry a turn whose record has expired. Not the
    // 404-not-403 of spec §8.1 -- openapi.yaml's 404 description argues why, in one place.
    throw new CpError('turn_not_found', 'no such turn');
  }
  // `cancelled` and terminal ONLY. `running` is admitted: the first claim writes it, so every
  // redelivery -- crash-reclaimed (§6.2), drained (§6.3), or a `retryable` outcome left unacked --
  // arrives on a record that already says `running`, and refusing those would ack and drop exactly
  // the entries crash recovery exists for (§5.4). `attempts` is deliberately not tested either: the
  // queue entry's `deliveryCount` is the single authority on exhaustion and the consumer checks it
  // before calling here, so a second limit read off the record could only disagree with it.
  if (isTerminalState(turn.state)) {
    throw new CpError(
      'turn_not_claimable',
      `this turn is '${turn.state}' and will not be run`,
      turn.sessionId,
    );
  }

  const rec = await deps.index.get(turn.sessionId);
  // Unknown session and owner mismatch are the same 404-shaped answer, as the session exchange has
  // it. The OWNER compare is load-bearing rather than belt-and-braces: `resolveInference` reads
  // `owner` and `credentialName` off the record it is HANDED, so a turn record whose owner does not
  // match its session's would otherwise be a request for whichever subject's credential it names.
  if (!rec || rec.owner !== turn.owner) {
    throw new CpError('session_not_found', undefined, turn.sessionId);
  }
  // What stops a DELETED session running its still-queued leaves (spec §5.3, §7.3). It matters more
  // here than on the interactive path: the queue entries survive the delete, so without this a
  // cascade-deleted session's fan-out would drain anyway, each leaf spending the owner's credential.
  if (rec.tombstone) throw new CpError('session_not_found', undefined, turn.sessionId);

  // The M1 interim gate (§9.1; MI1 §6.6: "under `multi` the exchange returns grants or refuses; it
  // never returns a real key"). BEFORE resolveInference, deliberately: a gate that fired afterwards
  // would have already read a secret it is forbidden to return. `submitTurn` refuses `multi` too, and
  // both are needed -- that one stops new submissions, this one stops a deployment flipped to `multi`
  // from draining the entries already on the queue down the single-tenant path.
  if (deps.config.tenancy === 'multi') {
    throw new CpError(
      'async_tenancy_unsupported',
      'async turns require MOCA_TENANCY=single in this release (ADR-0047); grant-at-dequeue is M2',
    );
  }

  // The TURN's own `owner`/`credentialName`, not the session's current ones. They are equal by
  // construction (submitTurn copies them, and the compare above re-checks `owner`), but the record is
  // the authority §5.1 names: a session whose credential was switched after submission must still
  // spend the credential its already-queued turn was admitted with.
  const resolved = await resolveInference(turn, deps);
  const { secretValue, credentialName, baseUrl, authHeader, usedOperatorFallback } = resolved;

  // Placeholder mode WINS whenever the deployment has an injector, exactly as the session exchange
  // decides it: adding an injector must narrow what a worker holds on both paths.
  const mode: CredentialMode = deps.config.injectorConfigured ? 'placeholder' : 'direct';
  if (mode === 'direct') {
    // Direct mode sends the secret itself, in the header its binding names, so header and endpoint
    // must agree (#368). Nothing checks the pair at submission: the deployment default the endpoint
    // may resolve to is not known until here.
    refuseMisdirectedSecret(resolved, turn.sessionId);
  }

  const entry = {
    subject: turn.owner,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    // The credential NAME. Never its value (spec §7.2).
    credential: credentialName,
    decision: (usedOperatorFallback ? 'operator_fallback_used' : 'credential_issued') as
      'credential_issued' | 'operator_fallback_used',
  };
  // NOT best-effort, deliberately unlike the submission routes' auditBestEffort: those audit a write
  // that already happened, so swallowing keeps a repair path open during a Redis outage. This audit is
  // the only record that a credential left the control plane, so a failed write refuses the credential
  // rather than issuing one off the books. Emitted after the await so stdout agrees with the server.
  // A real Redis outage is already typed by OwnershipIndex.audit's own `guard` (redis_unavailable),
  // rethrown unchanged below; anything else unknown becomes a bare `internal_error`, not a re-mapping
  // to `redis_unavailable` -- that outage path is exchange.test.ts's `redisDown()` suite, not this one.
  try {
    await deps.index.audit(entry);
  } catch (err) {
    if (err instanceof CpError) throw err;
    throw new CpError('internal_error', 'async credential audit write failed');
  }
  (deps.log ?? defaultAuditLog)({ event: 'audit', ...entry });

  // The TURN's own cfg, not the session's current one: a session that changed bundles after
  // submission must not move an already-queued turn onto the new one. '' when it names none.
  if (turn.cfg) {
    // Best effort: a bundle in daily use must not age out, but a failed refresh never fails a turn.
    await touchBundle(deps.bundles, turn.cfg, deps.now()).catch((err: unknown) =>
      console.error(
        `[control-plane] bundle TTL refresh failed for configRef=${turn.cfg}: ` +
          `${(err as Error)?.message ?? String(err)}`,
      ),
    );
  }

  // `sandboxTier` and `model` come from the LIVE session, while `credentialName` and `cfg` above come
  // from the record. The split is deliberate, and it is where a turn record stops being authoritative:
  // §5.1 copies onto the record only what a turn must spend unchanged, so the two it does not copy can
  // only be read from the session as it is now. The consequence is real and worth knowing -- a
  // `PATCH /v1/sessions/{id}` between submission and dequeue moves an already-queued turn onto the new
  // model, which updateSession's own "a turn in flight keeps its model" does not cover because an async
  // turn's exchange can be an hour after its submission. Pinning them means adding both to the record
  // (M2/#388 -- the record is this issue's, so #389 cannot pin what it does not carry), not reading
  // them from a different place here.
  const tier = sessionTier(rec, deps.config.sandboxTiers);
  return {
    turnId: turn.turnId,
    mode,
    anthropicAuthToken: mode === 'placeholder' ? placeholderFor(turn.owner) : secretValue,
    anthropicBaseUrl: baseUrl,
    sessionId: turn.sessionId,
    subject: turn.owner,
    caps: turn.caps,
    // sessionId LAST, so a stored envelope cannot override the record's own.
    envelope: { ...turn.envelope, sessionId: turn.sessionId },
    // Direct mode only: in placeholder mode the worker sends `Bearer <placeholder>` and the injector
    // decides the upstream header.
    ...(mode === 'direct' && authHeader === 'x-api-key' ? { authHeader } : {}),
    ...(turn.cfg ? { configRef: turn.cfg } : {}),
    ...(tier ? { sandboxTier: tier } : {}),
    ...(rec.model ? { model: { id: rec.model, ...rec.modelLimits } } : {}),
  };
}
