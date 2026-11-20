import { randomUUID, type KeyObject } from 'node:crypto';
import { CpError } from './errors.js';
import { verifyJws } from './token.js';

/**
 * The attach token (workload sandboxes spec §3.1, #476 phase 2): the binding between a workload's
 * sandbox pods and the workload and owner the relay stamps on their presence records. Minted by
 * `moca-provisioner` (ADR-0043) and verified by the relay with PUBLIC keys only
 * (`MOCA_ATTACH_PUBLIC_KEYS`), so neither the relay nor a sandbox can mint one.
 *
 * Its typ and audience are its own: it never passes as a session or API token (`JWT`, `harness`)
 * or as SBX0's caller token (`moca-sandbox+jwt`, #546), and none of those passes as it.
 */
export const ATTACH_TOKEN_TYP = 'moca-attach+jwt';
export const ATTACH_TOKEN_AUDIENCE = 'moca-relay-attach';
export const ATTACH_TOKEN_ISSUER = 'moca-provisioner';
/** Clock skew tolerated on `exp`, as for the sandbox token. */
export const ATTACH_CLOCK_LEEWAY_S = 30;

/** `w-<32 hex>`: the workload's Context name, which the record already derives per generation. */
export const ATTACH_WORKLOAD_RE = /^w-[0-9a-f]{32}$/;
/** `recordScope(owner)`: the 32-hex owner hash the workload record key already uses. */
export const ATTACH_OWNER_RE = /^[0-9a-f]{32}$/;
/** A tier name as a label value; the relay stamps it as `moca.dev/tier`. */
const ATTACH_TIER_RE = /^[a-z][a-z0-9-]{0,62}$/;

export interface AttachTokenClaims {
  iss: string;
  aud: string;
  /** The workload key. */
  wl: string;
  /** The owner scope. */
  own: string;
  /** The workload generation. */
  gen: string;
  /** The tier. */
  tr: string;
  /** The workload's sandbox count: the relay accepts only sandbox ordinals below it. */
  n: number;
  iat: number;
  /** Required. The relay refuses a token past it and closes an attach stream when it passes. */
  exp: number;
  jti: string;
}

export interface AttachMintInput {
  wl: string;
  own: string;
  gen: string;
  tr: string;
  /** The workload's `sandboxes.count`. */
  n: number;
  /** Epoch seconds. */
  now: number;
  /** `exp` is `now + ttlSeconds`; the provisioner's default is MOCA_ATTACH_TOKEN_TTL_S (one day). */
  ttlSeconds: number;
}

function bad(why: string): never {
  throw new CpError('token_invalid', why);
}

/** Checks the binding's fields; shared by mint and verify so neither accepts what the other refuses. */
function checkBinding(c: Partial<AttachTokenClaims>): void {
  if (typeof c.wl !== 'string' || !ATTACH_WORKLOAD_RE.test(c.wl)) bad('token has no valid wl');
  if (typeof c.own !== 'string' || !ATTACH_OWNER_RE.test(c.own)) bad('token has no valid own');
  if (typeof c.gen !== 'string' || c.gen.length === 0) bad('token has no gen');
  if (typeof c.tr !== 'string' || !ATTACH_TIER_RE.test(c.tr)) bad('token has no valid tr');
  if (typeof c.n !== 'number' || !Number.isSafeInteger(c.n) || c.n < 1) bad('token has no valid n');
}

export function mintAttachToken(
  signer: { signJws(typ: string, claims: object): string },
  i: AttachMintInput,
): string {
  const claims: AttachTokenClaims = {
    iss: ATTACH_TOKEN_ISSUER,
    aud: ATTACH_TOKEN_AUDIENCE,
    wl: i.wl,
    own: i.own,
    gen: i.gen,
    tr: i.tr,
    n: i.n,
    iat: i.now,
    exp: i.now + i.ttlSeconds,
    jti: randomUUID(),
  };
  checkBinding(claims);
  if (!Number.isSafeInteger(i.ttlSeconds) || i.ttlSeconds < 1) bad('ttlSeconds must be positive');
  return signer.signJws(ATTACH_TOKEN_TYP, claims);
}

/**
 * Verify an attach token: typ, alg, kid and signature first (verifyJws), then audience, issuer,
 * the binding's fields (including `n`) and the required expiry. Throws CpError with a fixed message; the message
 * never contains the token.
 */
export function verifyAttachToken(
  token: string,
  keys: Map<string, KeyObject>,
  opts: { now?: number; leewayS?: number } = {},
): AttachTokenClaims {
  const c = verifyJws(token, keys, ATTACH_TOKEN_TYP).claims as Partial<AttachTokenClaims>;
  if (c.aud !== ATTACH_TOKEN_AUDIENCE) bad('wrong token audience');
  if (c.iss !== ATTACH_TOKEN_ISSUER) bad('wrong token issuer');
  checkBinding(c);
  if (typeof c.iat !== 'number') bad('token has no iat');
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) bad('token has no expiry');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now > c.exp + (opts.leewayS ?? ATTACH_CLOCK_LEEWAY_S)) {
    throw new CpError('token_expired', 'token expired');
  }
  return c as AttachTokenClaims;
}
