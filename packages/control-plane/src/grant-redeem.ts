import { defaultAuditLog } from './audit-log.js';
import { CpError } from './errors.js';
import { refuseMisdirectedSecret, resolveInference, type ResolvedInference } from './exchange.js';
import { INFERENCE_GRANT_AUDIENCE, verifyGrant } from './grant.js';
import type { CpDeps } from './handlers.js';

/**
 * REDEMPTION (MI1 §6.3): a presented inference grant becomes the credential it names, for the one
 * in-process caller that sends it upstream (`inference-proxy.ts`). This is the half of §6.3 that
 * matters -- its RFC 8693 token endpoint exists so a SEPARATE process can ask; here the asker is
 * the same process, so there is no token to mint, no `MOCA_EGRESS_CP_TOKEN` to hold, and no secret
 * crossing a socket (decision D1).
 *
 * The checks are §6.3's, in its order, and the order is the point: nothing is resolved before the
 * signature, the expiry, the session and the owner have all been checked.
 *
 * NO SECRET REACHES A LOG, AN AUDIT ENTRY OR AN ERROR MESSAGE from here. The return value is the
 * only way out, and its one caller puts it in a single outbound header.
 */
export interface RedeemedInference extends ResolvedInference {
  /** The grant's subject, equal to the session's owner by the check below. */
  sub: string;
  sessionId: string;
}

export async function redeemInferenceGrant(
  presentedGrant: string,
  deps: CpDeps,
): Promise<RedeemedInference> {
  // The listener starts only alongside a configured ring (`checkGrantRedemption`), so no ring here
  // is a wiring fault rather than caller input.
  if (!deps.grantVerifyKeys) {
    throw new CpError('internal_error', 'grant signing key is not configured');
  }
  // 1. The grant itself: structure, alg, typ, kid, signature, then aud, iss, exp and turn_exp --
  //    all inside verifyGrant, all answering the single `grant_invalid` §6.3 names.
  const claims = verifyGrant(presentedGrant, deps.grantVerifyKeys, INFERENCE_GRANT_AUDIENCE, {
    now: Math.floor(deps.now() / 1000),
  });
  // verifyGrant pins the audience, so this cannot fire; narrowing on `aud` is how the compiler
  // learns which half of the claims union it holds, without a cast that would survive a refactor.
  if (claims.aud !== INFERENCE_GRANT_AUDIENCE) {
    throw new CpError('grant_invalid', 'wrong grant audience');
  }

  // 2. The SESSION, which §6.3 makes authoritative: it must exist, be owned by the grant's subject,
  //    and not be tombstoned. Checked on EVERY redemption, which is what lets a deleted session and
  //    a rotated credential take effect at once rather than within MOCA_GRANT_TTL_S (D4). All three
  //    answer the 404-shaped `session_not_found` the rest of the codebase gives, so a grant for a
  //    session the caller cannot see is no existence oracle.
  const rec = await deps.index.get(claims.sid);
  if (!rec || rec.owner !== claims.sub || rec.tombstone) {
    throw new CpError('session_not_found', undefined, claims.sid);
  }

  // 3. Resolve. The grant's `cred` names WHICH credential (decision D2: an async turn pins its
  //    credential name at submission, async §5.1, so a session that switched credentials mid-turn
  //    must not move an already-queued turn), resolved under the SESSION's owner and never under a
  //    subject the caller supplied. Deletion and rotation are still honoured, because the value is
  //    re-read here on every request. `''` takes the audited operator fallback exactly as the
  //    interactive exchange does, and refuses the same way when there is none.
  const resolved = await resolveInference(
    { owner: rec.owner, credentialName: claims.cred, sessionId: rec.sessionId },
    deps,
  );
  // 4. The redeemer ALWAYS sends the real secret, like the model catalog does, so the misdirected-
  //    secret check applies unconditionally rather than in direct mode only (#368, MI1 §6.2).
  refuseMisdirectedSecret(resolved, rec.sessionId);

  // 5. Audit -- the operator fallback ONLY (decision D3). "A capability left the control plane" is
  //    already audited once per turn at dequeue (`grants_issued`), and a turn makes dozens of
  //    inference requests, so auditing each would be a Redis write per LLM call. The fallback is the
  //    exception because §6.4 requires the operator's own key to be attributable to a subject.
  //    Blocking, not best-effort, for the reason turn-exchange.ts:144 gives: it is the only record
  //    that the deployment's key was spent on this subject. Redis is already on this path (the
  //    index.get above), so it adds no new failure mode.
  // shortcut: one audit write per REQUEST while the fallback is on, not one per turn. Collapse it
  // (per-jti, in memory) if a fallback deployment ever carries real traffic.
  if (resolved.usedOperatorFallback) {
    const entry = {
      subject: rec.owner,
      sessionId: rec.sessionId,
      // The NAME, never the value (MI1 §7.2).
      credential: resolved.credentialName,
      decision: 'operator_fallback_used',
    };
    try {
      await deps.index.audit(entry);
    } catch (err) {
      if (err instanceof CpError) throw err;
      throw new CpError('internal_error', 'grant redemption audit write failed');
    }
    (deps.log ?? defaultAuditLog)({ event: 'audit', ...entry });
  }

  return { ...resolved, sub: claims.sub, sessionId: rec.sessionId };
}
