import { defaultAuditLog } from './audit-log.js';
import { CpError } from './errors.js';
import { sessionFromToken } from './exchange.js';
import { GRANT_AUDIENCES, mintGrants, turnExp, verifyGrant, type GrantClaims } from './grant.js';
import type { CpDeps } from './handlers.js';
import type { SessionRecord } from './ownership.js';

/**
 * The GRANT lifecycle endpoints (MI1 §6.2): the two calls that put a turn's grants in a worker's
 * hands and keep them fresh while the turn runs.
 *
 *   turn start  worker: session token + SH_EXCHANGE_TOKEN  -> POST /internal/turn-grants
 *   mid-turn    worker: current grant  + SH_EXCHANGE_TOKEN -> POST /internal/grants/refresh
 *
 * NO CREDENTIAL IS READ, DECRYPTED OR RETURNED ANYWHERE IN THIS FILE. The response carries two
 * signed grants and a bundle digest; `cred` is a credential NAME off the session record and `egress`
 * a list of names off its descriptors (§7.2). That is the whole point of the slice: the worker holds
 * a capability it must spend at an enforcement point, not a secret it could spend anywhere.
 *
 * `inferenceUrl` from §6.2's response is deliberately absent: it names the `moca-egress` inference
 * listener, which does not exist yet (§8.6). Adding the field now would mean publishing an address
 * nothing is listening on. The redeemer's slice adds it.
 */
export interface TurnGrantsResponse {
  inferenceGrant: string;
  sandboxGrant: string;
  /** Absolute epoch SECONDS. The worker refreshes until this, then the turn is over. */
  turnExp: number;
  /** When to come back: `min(iat + MOCA_GRANT_TTL_S, turnExp)`. Refresh at half-life. */
  exp: number;
  /** The bundle digest bound to the session; absent when none is. */
  cfg?: string;
}

/** What `/internal/turn-grants` and `/internal/grants/refresh` need beyond the base deps. */
function grantDeps(deps: CpDeps): {
  signer: NonNullable<CpDeps['grantSigner']>;
  keys: NonNullable<CpDeps['grantVerifyKeys']>;
} {
  // Both routes are feature-gated on `grantSigner` (server.ts) and 404 without it, so reaching here
  // with no signer is a wiring fault rather than caller input -- hence internal_error, not a 4xx.
  if (!deps.grantSigner || !deps.grantVerifyKeys) {
    throw new CpError('internal_error', 'grant signing key is not configured');
  }
  return { signer: deps.grantSigner, keys: deps.grantVerifyKeys };
}

/**
 * Both halves of the pair, derived from the SESSION RECORD rather than from anything the caller
 * presented. One code path for issue and refresh, which is what makes a mid-turn credential or
 * bundle change take effect at the next refresh (decision D4) instead of being echoed forward.
 *
 * The audit write is NOT best-effort, for the reason `turn-exchange.ts:144` gives about its own: it
 * is the only record that a grant left the control plane, so a failed write refuses the grant rather
 * than issuing one off the books. Both submission routes' `auditBestEffort` audit a write that
 * already happened; this audits a capability about to be handed out.
 */
async function mintFor(
  rec: SessionRecord,
  turnExpS: number,
  decision: 'grants_issued' | 'grants_refreshed',
  deps: CpDeps,
): Promise<TurnGrantsResponse> {
  const { signer } = grantDeps(deps);
  // Descriptors only -- `list` is the route that must enumerate without decrypting. A session may
  // hold several egress credentials (one per destination), so this is a list and not a choice.
  // The set is the OWNER's `sandbox-egress` credentials as of this mint, not a per-session subset:
  // nothing on the session record narrows them. §6.3 step 3 re-filters by `destination.hosts` when
  // the grant is redeemed, so the claim is an upper bound on what a token can be minted for.
  // shortcut: one uncached `list` per issue AND per refresh -- on the Kubernetes store that is a
  // `kubectl get secret` subprocess, so a turn refreshing at half-life costs ~13 instead of 1.
  // Cache it on the session record (or pass the descriptors through) when a redeemer makes refresh
  // a real code path; today nothing refreshes.
  const descriptors = await deps.credentials.list(rec.owner);
  const egress = descriptors.filter((d) => d.consumer === 'sandbox-egress').map((d) => d.name);
  const minted = mintGrants(signer, {
    sub: rec.owner,
    // The record's tenant, on both paths. A refresh does NOT echo the presented grant's claim:
    // every other field is re-read, and tenant re-read with them is one less thing to reason about.
    tenant: rec.tenant,
    sid: rec.sessionId,
    // The NAME the session chose at creation, verbatim. '' when it chose none: resolution, including
    // the audited operator fallback, is the token endpoint's job, and §6.3 keeps the session record
    // authoritative there rather than this claim.
    cred: rec.credentialName,
    egress,
    ...(rec.configRef ? { cfg: rec.configRef } : {}),
    ttlSeconds: deps.config.grantTtlS,
    turnExp: turnExpS,
    now: Math.floor(deps.now() / 1000),
  });
  const entry = {
    subject: rec.owner,
    sessionId: rec.sessionId,
    // The credential NAME. Never its value (spec §7.2). Omitted when the session named none, which
    // is what `audit`'s own `entry.credential ? ...` already does with ''.
    credential: rec.credentialName,
    configRef: rec.configRef ?? undefined,
    decision,
  };
  try {
    await deps.index.audit(entry);
  } catch (err) {
    if (err instanceof CpError) throw err;
    throw new CpError('internal_error', 'grant audit write failed');
  }
  (deps.log ?? defaultAuditLog)({ event: 'audit', ...entry });
  return {
    inferenceGrant: minted.inferenceGrant,
    sandboxGrant: minted.sandboxGrant,
    turnExp: minted.turnExp,
    exp: minted.exp,
    ...(rec.configRef ? { cfg: rec.configRef } : {}),
  };
}

/**
 * Turn start. The worker presents the SESSION TOKEN it was handed with the turn, plus its own
 * `SH_EXCHANGE_TOKEN` (the route's `auth: 'exchange'`), and gets the turn's two grants.
 *
 * `turn_exp` is §6.1's literal "turn start + `MOCA_TURN_MAX_S`", and it is set HERE, in the control
 * plane, from the control plane's own clock -- never from a value the worker sends. The caps-aware
 * form (§5.4's `dequeue + min(caps.wallClock ?? MAX, MAX)`) belongs to the dequeue path's grants;
 * `turnExp` already takes the parameter, so that slice adds a call site rather than a function.
 */
export async function issueTurnGrants(
  presentedToken: string,
  deps: CpDeps,
): Promise<TurnGrantsResponse> {
  const rec = await sessionFromToken(presentedToken, deps);
  const nowS = Math.floor(deps.now() / 1000);
  return mintFor(rec, turnExp(nowS, undefined, deps.config.turnMaxS), 'grants_issued', deps);
}

/**
 * Mid-turn refresh. The worker presents a grant it already holds -- EITHER half, since both are
 * bound to the same turn and a worker refreshing with the one it happens to be using should not get
 * a confusing 401.
 *
 * `turn_exp` is carried forward UNCHANGED: it is an absolute cap, so refreshing cannot extend the
 * turn no matter how many times it happens. Past it the refresh is REFUSED outright rather than
 * clamped (async spec §5.4: "refusing is the safe default and what M2 should ship") -- `verifyGrant`
 * raises `grant_invalid` on a grant whose `turn_exp` has passed, before the session is read.
 *
 * The session is re-read rather than echoed (decision D4): a presented inference grant carries no
 * `cfg`/`egress` and a sandbox grant no `cred`, so "same claims" (§6.2) cannot reconstruct the other
 * half. Re-reading is one shared code path with issue AND strictly tighter -- a session tombstoned
 * mid-turn stops refreshing, which is §6.2's "refused ... once the session is tombstoned".
 */
export async function refreshTurnGrants(
  presentedGrant: string,
  deps: CpDeps,
): Promise<TurnGrantsResponse> {
  const { keys } = grantDeps(deps);
  const nowS = Math.floor(deps.now() / 1000);
  const claims: GrantClaims = verifyGrantEitherAudience(presentedGrant, keys, nowS);
  const rec = await deps.index.get(claims.sid);
  // Unknown session, another subject's session and a tombstoned one are the SAME 404-shaped answer
  // `sessionFromToken` gives, so the refresh route is no more of an existence oracle than the issue
  // route. The owner compare matters even with a valid signature: a grant minted for one subject
  // must not refresh against another's session.
  if (!rec || rec.owner !== claims.sub || rec.tombstone) {
    throw new CpError('session_not_found', undefined, claims.sid);
  }
  return mintFor(rec, claims.turn_exp, 'grants_refreshed', deps);
}

/**
 * `verifyGrant` for a caller that accepts either audience. Kept here rather than in `grant.ts`
 * because every OTHER verifier in the system pins exactly one audience -- that is what an audience
 * is for -- and only the refresh endpoint legitimately takes both.
 */
function verifyGrantEitherAudience(
  token: string,
  keys: NonNullable<CpDeps['grantVerifyKeys']>,
  nowS: number,
): GrantClaims {
  let last: unknown;
  for (const aud of GRANT_AUDIENCES) {
    try {
      return verifyGrant(token, keys, aud, { now: nowS });
    } catch (err) {
      // Keep the FIRST failure, not the last: a token that is not a grant at all (bad signature,
      // wrong typ, expired) fails identically under both audiences, and the first attempt's message
      // names that real fault. The second attempt's would always be 'wrong grant audience', which
      // would mislabel every structural failure as an audience mismatch.
      last ??= err;
    }
  }
  throw last;
}
