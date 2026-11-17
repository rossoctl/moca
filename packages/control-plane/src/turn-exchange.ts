import { defaultAuditLog } from './audit-log.js';
import { touchBundle } from './bundle-budget.js';
import { CpError } from './errors.js';
import { grantsForTurn } from './grant-exchange.js';
import { turnExp } from './grant.js';
import {
  placeholderFor,
  refuseMisdirectedSecret,
  resolveInference,
  sessionSeed,
  sessionTemplate,
  sessionTier,
  type CredentialMode,
  type ExchangeResponse,
} from './exchange.js';
import type { CpDeps } from './handlers.js';
import { holdPinnedWorker } from './host-handlers.js';
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
 * TWO MODES, picked by tenancy and nothing else. Under `MOCA_TENANCY=single` it returns the resolved
 * credential (`direct`, or `placeholder` where an injector exists). Under `multi` it returns MI1
 * §6.1's two grants and the inference listener's URL (`grant`) and reads no credential at all, which
 * is §6.6's "under `multi` the exchange returns grants or refuses; it never returns a real key".
 * Everything that is not the credential -- caps, envelope, bundle, tier, template, seed, model -- is
 * identical on both.
 */
export interface TurnExchangeResponse extends ExchangeResponse {
  turnId: string;
  /** The caps recorded at submission (§4.3). The WORKER enforces them (#391, `turn-claim.ts`). */
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

  // The TURN's own cfg, not the session's current one: a session that changed bundles after
  // submission must not move an already-queued turn onto the new one. '' when it names none.
  // Above the tenancy branch because it depends on `turn.cfg` alone: a bundle in daily use by async
  // turns must not age out just because the deployment runs multi-tenant.
  if (turn.cfg) {
    // Best effort: a bundle in daily use must not age out, but a failed refresh never fails a turn.
    await touchBundle(deps.bundles, turn.cfg, deps.now()).catch((err: unknown) =>
      console.error(
        `[control-plane] bundle TTL refresh failed for configRef=${turn.cfg}: ` +
          `${(err as Error)?.message ?? String(err)}`,
      ),
    );
  }

  // The session's template and seed, resolved before either branch's audit as every refusal is: a
  // store that cannot answer for the seed refuses the claim (sessionSeed), which leaves the turn
  // pending, and nothing is recorded as issued and then withheld.
  const template = sessionTemplate(rec, deps.config.sessionTemplates);
  const seed = template ? await sessionSeed(rec, deps) : undefined;
  // Everything the worker needs that is NOT the credential. Identical on both branches by
  // construction: a grant-mode turn of a templated session must still land on that template's
  // workers, pinned to its build and seeded, or it runs with the wrong workspace.
  //
  // The tier is the one the record STORED, which is the session's stored tier and not a raw choice:
  // `createSession` already resolved it (`requestedTier ?? tiers?.default ?? ''`). So a turn keeps
  // the default that was current when its SESSION was created, and an operator who changes
  // `sandboxTiers.default` afterwards does not move an already-queued turn.
  //
  // It reads '' in exactly two cases, and the fallback to the session covers both. A session created
  // while the deployment declared no tiers stores '' as well, so resolving against it is the same
  // answer as resolving the record. A record written before #388 carries no tier at all, and there
  // the fallback is load-bearing: handing the worker the deployment default instead of the session's
  // own tier retiers the session's sandbox, and a retier starts its workspace empty
  // (`select-sandbox.ts`, `reason: 'retiered'`).
  //
  // The template, its seed and its build come from the SESSION, not copied onto the turn record, and
  // that is a pin all the same: a session's template and build are written once, at creation, and no
  // route changes them, so the record of a turn queued an hour ago and the session now agree. A
  // template the deployment no longer declares is still sent, without a seed, so the turn is refused
  // rather than run untemplated.
  const tier = sessionTier(turn.sandboxTier ? turn : rec, deps.config.sandboxTiers);
  const sandbox = {
    ...(turn.cfg ? { configRef: turn.cfg } : {}),
    ...(tier ? { sandboxTier: tier } : {}),
    ...(template ? { sandboxTemplate: template.id } : {}),
    ...(seed ? { sandboxSeed: seed.seed, sandboxSeedSource: seed.source } : {}),
    // Only a manifest-hash build pins workers; an `imported:` build names no snapshot.
    ...(template && rec.sandboxBuildId?.startsWith('sha256:')
      ? { sandboxBuildId: rec.sandboxBuildId }
      : {}),
    ...(turn.model ? { model: { id: turn.model, ...turn.modelLimits } } : {}),
  };

  // The turn's DEADLINE, anchored at this dequeue (§5.4): `caps.wallClock` clamped to
  // MOCA_TURN_MAX_S, or the ceiling itself when the submission named no cap. An ask above the
  // ceiling is clamped rather than refused -- a caller asking for too long wants the longest turn
  // it can have.
  //
  // Returned in BOTH modes (#391), because the WORKER now stops the leaf on it and a wall-clock cap
  // that only existed under `multi` would be a cap that depends on tenancy. Computed once, here, and
  // handed to the grant mint below so the grants' `exp` and this field cannot disagree (decision D4).
  const turnExpS = turnExp(
    Math.floor(deps.now() / 1000),
    turn.caps.wallClock,
    deps.config.turnMaxS,
  );

  // #388 item 3: ADR-0047's `async_tenancy_unsupported` gate is GONE from here, and the refusal it
  // enforced is now a boot contract (`checkGrantRedemption`, main.ts) plus the branch below. The gate
  // existed because MI1 §6.6 forbids returning a real key under `multi` and there was nothing else to
  // return; there is now.
  if (deps.config.tenancy === 'multi') {
    // Unreachable in a booted deployment -- `checkGrantRedemption` refuses `multi` without a
    // redeemer -- so this is the belt for a library caller assembling its own config. A refusal,
    // never a fallthrough to the single-tenant path: that fallthrough is what §6.6 forbids.
    if (!deps.config.inferenceUrl) {
      throw new CpError('internal_error', 'MOCA_INFERENCE_URL is not configured');
    }
    // The turn record's own fields, as a GrantSource -- it is not structurally one, because the
    // record calls the bundle digest `cfg` where a session record calls it `configRef`.
    const grants = await grantsForTurn(
      {
        owner: turn.owner,
        tenant: turn.tenant,
        sessionId: turn.sessionId,
        credentialName: turn.credentialName,
        ...(turn.cfg ? { configRef: turn.cfg } : {}),
      },
      // Turn start means DEQUEUE (async §5.4), so the anchor is `now` -- here, at the claim -- and
      // never the submission. The same number the response carries, computed above.
      turnExpS,
      turn.turnId,
      deps,
    );
    // NO resolveInference above this line, deliberately: the gate this branch replaces sat before it
    // for the same reason -- a path that returns grants must never have read a secret at all. That is
    // also why the audit entry belongs to `grantsForTurn` and not to this function: nothing here
    // knows a credential value to leave out.
    if (rec.sandboxTemplate) await holdPinnedWorker(rec, deps);
    return {
      turnId: turn.turnId,
      mode: 'grant',
      anthropicAuthToken: grants.inferenceGrant,
      // The control plane's own inference listener, not a provider. The worker cannot reach a
      // provider directly in this mode and does not know one's address.
      anthropicBaseUrl: deps.config.inferenceUrl,
      sandboxGrant: grants.sandboxGrant,
      turnExp: turnExpS,
      sessionId: turn.sessionId,
      subject: turn.owner,
      caps: turn.caps,
      envelope: { ...turn.envelope, sessionId: turn.sessionId },
      // No `authHeader`: the redeemer sets whichever header the credential's binding names, so the
      // worker always sends a Bearer and never has to be told otherwise.
      ...sandbox,
    };
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

  // Everything in `sandbox` above comes from the RECORD, which is now authoritative for all four of
  // `credentialName`, `cfg`, `model` and `sandboxTier` (§5.1). `sandboxTier` and `model` used to be
  // read from the live session, and that was a defect rather than a split: a
  // `PATCH /v1/sessions/{id}` between submission and dequeue moved an already-queued turn onto the
  // new model, which `updateSession`'s own "a turn already running keeps its model" cannot cover
  // because the turn has not started -- an async turn's exchange can be an hour after its
  // submission. The session is still read above, for the owner compare and the tombstone; nothing
  // the turn SPENDS is taken from it.
  //
  // A queued turn of a session pinned to a build keeps that build's worker, as an interactive one:
  // after the audit and every refusal, so a refused claim holds nothing.
  if (rec.sandboxTemplate) await holdPinnedWorker(rec, deps);
  return {
    turnId: turn.turnId,
    mode,
    anthropicAuthToken: mode === 'placeholder' ? placeholderFor(turn.owner) : secretValue,
    anthropicBaseUrl: baseUrl,
    sessionId: turn.sessionId,
    subject: turn.owner,
    caps: turn.caps,
    turnExp: turnExpS,
    // sessionId LAST, so a stored envelope cannot override the record's own.
    envelope: { ...turn.envelope, sessionId: turn.sessionId },
    // Direct mode only: in placeholder mode the worker sends `Bearer <placeholder>` and the injector
    // decides the upstream header.
    ...(mode === 'direct' && authHeader === 'x-api-key' ? { authHeader } : {}),
    ...sandbox,
  };
}
