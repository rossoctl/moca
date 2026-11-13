import { randomUUID, type KeyObject } from 'node:crypto';
import { CpError } from './errors.js';
import { verifyJws } from './token.js';

/**
 * The session GRANT (MI1 §6.1): a short-lived capability a worker holds for one turn, which buys a
 * credential at the token endpoint rather than being one. Two per turn, valid at different
 * enforcement points, and neither substitutes for the other:
 *
 *   inference grant  aud moca-inference  claims iss sub tenant sid cred iat exp jti turn_exp
 *   sandbox grant    aud moca-sandbox    claims iss sub tenant sid cfg egress iat exp jti turn_exp
 *
 * NO CREDENTIAL TRAVELS IN A GRANT, the same property `token.ts` states for the session token:
 * `cred` is a credential NAME and `egress` a list of names (§7.2). Nothing in this module decrypts
 * anything, and nothing in it holds a key -- the signer arrives as a parameter, as
 * `mintSandboxToken` takes it.
 *
 * Format is `token.ts`'s compact Ed25519 JWS generalized over `typ`, with a SEPARATE KEY RING and
 * header `typ: moca-grant+jwt`, "so a session token can never pass as a grant even where an `aud`
 * check is forgotten" (§6.1). Only the control plane holds the signing key; `moca-egress`,
 * `microvm-worker` and the relay receive public keys through `MOCA_GRANT_PUBLIC_KEYS`. Workers never
 * verify a grant -- they receive one over the authenticated exchange and present it onward.
 */
export const GRANT_TYP = 'moca-grant+jwt';
export const INFERENCE_GRANT_AUDIENCE = 'moca-inference';
/**
 * NOTE, and worth carrying to whoever writes the Go verifier: this is the SAME STRING as
 * `sandbox-token.ts`'s `SANDBOX_TOKEN_AUDIENCE`, so `aud` alone no longer tells a sandbox token from
 * a sandbox grant. What separates them is `typ` (`moca-sandbox+jwt` vs `moca-grant+jwt`), which is
 * exactly the protection §6.1 asks for, and each verifier pins its own -- `verifyJws`'s `typ`
 * argument is not optional. The strings match because both name the same enforcement point; renaming
 * one would make the spec and the code disagree for no gain.
 */
export const SANDBOX_GRANT_AUDIENCE = 'moca-sandbox';
export type GrantAudience = typeof INFERENCE_GRANT_AUDIENCE | typeof SANDBOX_GRANT_AUDIENCE;
/** Both, for a verifier that accepts either half -- the refresh endpoint is the only one. */
export const GRANT_AUDIENCES: readonly GrantAudience[] = [
  INFERENCE_GRANT_AUDIENCE,
  SANDBOX_GRANT_AUDIENCE,
];
/** Distinct from DEFAULT_ISSUER and SANDBOX_API_ISSUER, for the reason token.ts gives for those. */
export const DEFAULT_GRANT_ISSUER = 'moca-control-plane-grant';

interface GrantClaimsBase {
  iss: string;
  sub: string;
  tenant: string;
  /** The session id. A grant is always about one session. */
  sid: string;
  iat: number;
  /** `min(iat + MOCA_GRANT_TTL_S, turn_exp)` -- the refresh deadline. */
  exp: number;
  jti: string;
  /**
   * The ABSOLUTE cap on the turn (§6.1): turn start + `MOCA_TURN_MAX_S`. A refresh carries it
   * forward unchanged and is refused once it has passed, so it bounds the longest a turn may run on
   * one exchange no matter how many times the worker refreshes.
   */
  turn_exp: number;
}

export interface InferenceGrantClaims extends GrantClaimsBase {
  aud: typeof INFERENCE_GRANT_AUDIENCE;
  /**
   * The NAME of the session's inference credential (MU1 §6.4's per-session choice), never its value.
   * `''` when the session named none: resolution, including the audited operator fallback, is the
   * token endpoint's job, and §6.3 makes the SESSION RECORD authoritative there rather than this
   * claim -- "the grant's `cred` must name it; the session record, not the grant, is authoritative".
   */
  cred: string;
}

export interface SandboxGrantClaims extends GrantClaimsBase {
  aud: typeof SANDBOX_GRANT_AUDIENCE;
  /**
   * The NAMES of `sandbox-egress` credentials, never their values. These are the SESSION OWNER's
   * set as of the mint -- §6.1 words it per-session, but no session record narrows it -- so one
   * added mid-turn appears at the next refresh. The token endpoint re-filters by the
   * destination's `hosts` (§6.3 step 3), which makes this an upper bound and not an entitlement.
   */
  egress: string[];
  /** The bundle digest bound to the session (§7.2). Absent when none is. */
  cfg?: string;
}

export type GrantClaims = InferenceGrantClaims | SandboxGrantClaims;

export interface GrantMintInput {
  sub: string;
  tenant: string;
  sid: string;
  /** The session's inference credential NAME; `''` when it named none. */
  cred: string;
  /** The session's `sandbox-egress` credential NAMES; `[]` when it holds none. */
  egress: string[];
  /** The session's bundle digest; omitted or `''` when none is bound. */
  cfg?: string;
  ttlSeconds: number;
  /** The absolute turn cap, from `turnExp()`. */
  turnExp: number;
  iss?: string;
  /** Epoch SECONDS; injectable so expiry tests are not clock-dependent. */
  now: number;
}

function bad(why: string): never {
  throw new CpError('grant_invalid', why);
}

/**
 * The turn deadline, per async fan-out spec §5.4: `start + min(caps.wallClock ?? max, max)`.
 *
 * `turnMaxS` (`MOCA_TURN_MAX_S`) is the deployment-wide ceiling. A turn may request LESS and never
 * more; a caller asking for more is CLAMPED rather than refused, and the clamp happens here, in the
 * control plane at mint, never from a value a worker or a caller supplies.
 *
 * A non-positive request falls back to the ceiling instead of being honoured: `wallClock: 0` read
 * literally mints a grant that has already expired, which fails the turn with `grant_invalid`
 * instead of bounding it, and a cap is not a way to cancel.
 */
export function turnExp(nowS: number, wallClockS: number | undefined, turnMaxS: number): number {
  const requested = wallClockS !== undefined && wallClockS > 0 ? wallClockS : turnMaxS;
  return nowS + Math.min(requested, turnMaxS);
}

/**
 * Both grants for one turn, from one `turn_exp` and one `iat`, so the pair can never disagree about
 * the turn they belong to. `exp = min(now + MOCA_GRANT_TTL_S, turn_exp)` (§6.1) -- the same shape
 * `mintSandboxToken` uses for `notAfter`, and what makes the short lifetime bound revocation
 * latency, a stolen grant's replay window, and the turn itself.
 *
 * Each half gets its OWN `jti`: they are separate capabilities presented to separate enforcement
 * points, and a shared id would make two audit trails look like one event.
 */
export function mintGrants(
  signer: { signJws(typ: string, claims: object): string },
  i: GrantMintInput,
): { inferenceGrant: string; sandboxGrant: string; exp: number; turnExp: number } {
  const exp = Math.min(i.now + i.ttlSeconds, i.turnExp);
  // Already past the cap: mint nothing. The caller is refreshing a turn that has run out of time,
  // and a grant with `exp <= iat` would be refused by every verifier anyway -- answering here makes
  // "the turn is over" the reason rather than "your grant is bad".
  if (exp <= i.now) bad('this turn has reached turn_exp and will not be extended');
  const base = {
    iss: i.iss ?? DEFAULT_GRANT_ISSUER,
    sub: i.sub,
    tenant: i.tenant,
    sid: i.sid,
    iat: i.now,
    exp,
    turn_exp: i.turnExp,
  };
  const inference: InferenceGrantClaims = {
    ...base,
    aud: INFERENCE_GRANT_AUDIENCE,
    cred: i.cred,
    jti: randomUUID(),
  };
  const sandbox: SandboxGrantClaims = {
    ...base,
    aud: SANDBOX_GRANT_AUDIENCE,
    egress: i.egress,
    jti: randomUUID(),
    ...(i.cfg ? { cfg: i.cfg } : {}),
  };
  return {
    inferenceGrant: signer.signJws(GRANT_TYP, inference),
    sandboxGrant: signer.signJws(GRANT_TYP, sandbox),
    exp,
    turnExp: i.turnExp,
  };
}

/**
 * Verify a grant of a KNOWN audience. The structural half -- structure, alg, typ, kid, SIGNATURE,
 * payload parse, in that order -- is `verifyJws`, so nothing from the payload is trusted before the
 * signature check and `alg: none` is refused before the key is looked up.
 *
 * Every failure answers the single code `grant_invalid` (§6.3 item 1), including the
 * `token_invalid`/`token_expired` that `verifyJws` and the session verifier raise: the remap is
 * deliberate, and `errors.ts` explains why one code rather than six. It is the reason this wraps
 * `verifyJws` in a try rather than calling it bare.
 */
export function verifyGrant(
  token: string,
  keys: Map<string, KeyObject>,
  aud: GrantAudience,
  opts: { now?: number; issuer?: string } = {},
): GrantClaims {
  let raw: Record<string, unknown>;
  try {
    raw = verifyJws(token, keys, GRANT_TYP).claims;
  } catch (err) {
    // Message, not code: verifyJws's own text names the structural fault ('unsupported alg', 'wrong
    // token typ', 'unknown token key id') and says nothing about the payload, which was never
    // parsed. Any non-CpError is a programming fault, not a bad grant, so it goes up unchanged.
    if (err instanceof CpError) bad(err.message);
    throw err;
  }
  // NOT `Partial<InferenceGrantClaims & SandboxGrantClaims>`: intersecting the two makes `aud` the
  // impossible `'moca-inference' & 'moca-sandbox'`, which collapses the whole type to `never`.
  const c = raw as Partial<GrantClaimsBase> & {
    aud?: unknown;
    cred?: unknown;
    egress?: unknown;
    cfg?: unknown;
  };
  if (c.aud !== aud) bad('wrong grant audience');
  if (c.iss !== (opts.issuer ?? DEFAULT_GRANT_ISSUER)) bad('wrong grant issuer');
  for (const f of ['sub', 'tenant', 'sid'] as const) {
    const v = c[f];
    if (typeof v !== 'string' || v.length === 0) bad(`grant has no ${f}`);
  }
  // Checked for type, so the returned claims are what their type says.
  if (typeof c.iat !== 'number') bad('grant has no iat');
  if (typeof c.jti !== 'string') bad('grant has no jti');
  if (typeof c.exp !== 'number') bad('grant has no expiry');
  if (typeof c.turn_exp !== 'number') bad('grant has no turn_exp');
  // No clock leeway, deliberately unlike the sandbox token's 30 s: a grant lives
  // MOCA_GRANT_TTL_S (300 s) and the worker refreshes at half-life, so a verifier running 30 s fast
  // still has 120 s of valid grant in hand. Leeway here would only widen a stolen grant's replay
  // window, which the short lifetime exists to narrow (§6.2).
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // `>` not `>=`, as verifyToken has it: a grant is valid THROUGH its exp second.
  if (now > c.exp) bad('grant expired');
  // Checked SEPARATELY from exp even though mint guarantees `exp <= turn_exp`: the cap is what a
  // refresh carries forward, and a grant whose exp was minted correctly can still be presented
  // after the turn's own deadline if turn_exp was reached between mint and use.
  if (now > c.turn_exp) bad('this turn has reached turn_exp');
  if (c.aud === INFERENCE_GRANT_AUDIENCE) {
    // `''` is legitimate -- the session named no credential -- so this checks the TYPE only.
    if (typeof c.cred !== 'string') bad('inference grant has no cred');
    return c as unknown as InferenceGrantClaims;
  }
  if (!Array.isArray(c.egress) || c.egress.some((n: unknown) => typeof n !== 'string')) {
    bad('sandbox grant has no egress name list');
  }
  if (c.cfg !== undefined && typeof c.cfg !== 'string') bad('sandbox grant has a non-string cfg');
  return c as unknown as SandboxGrantClaims;
}
