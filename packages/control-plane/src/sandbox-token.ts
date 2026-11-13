import { randomUUID, type KeyObject } from 'node:crypto';
import { CpError } from './errors.js';
import { isSandboxModeName, type SandboxModeName } from './sandbox-store.js';
import { verifyJws } from './token.js';

/**
 * The sandbox token (SBX0 spec §4.3): a capability for ONE sandbox's workspace on ONE worker,
 * minted by the control plane's `sandbox` profile and verified by the relay with public keys only.
 * Its typ and audience are its own, so it can never pass as a session or API token, nor the reverse.
 */
export const SANDBOX_TOKEN_TYP = 'moca-sandbox+jwt';
export const SANDBOX_TOKEN_AUDIENCE = 'moca-sandbox';
export const DEFAULT_SANDBOX_ISSUER = 'sbx-control-plane';
export const SANDBOX_SCOPE_EXEC = 'exec';
/** Clock skew the relay tolerates between itself and the control plane. */
export const SANDBOX_CLOCK_LEEWAY_S = 30;

export interface SandboxTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  tenant: string;
  /** The sandbox id. */
  sbx: string;
  /** The worker sandbox_id serving the sandbox's template (ExecRequest.sandbox_id). */
  wrk: string;
  /** The workspace key (Exec.workspace_key); equal to sbx. */
  wsk: string;
  scope: string[];
  /**
   * How the worker runs this sandbox's Execs, its mode epoch and the owner's idle timeout (0 = the
   * worker's default), from the record at mint time (lease-mode spec §8.2). The relay sets the
   * Exec's fields from these. A token minted before they existed reads as per-exec, 0, 0.
   */
  mode: SandboxModeName;
  mode_epoch: number;
  idle_timeout_s: number;
  iat: number;
  exp: number;
  jti: string;
}

export interface SandboxMintInput {
  sub: string;
  tenant: string;
  sbx: string;
  wrk: string;
  wsk: string;
  /** The record's mode fields; absent means per-exec, epoch 0, idle 0. */
  mode?: SandboxModeName;
  modeEpoch?: number;
  idleTimeoutS?: number;
  ttlSeconds: number;
  /** The sandbox's expiresAt (epoch s): no token outlives its sandbox (spec §5.4 invariant 2). */
  notAfter: number;
  iss: string;
  /** Epoch seconds. */
  now: number;
}

function bad(why: string): never {
  throw new CpError('token_invalid', why);
}

/** exp is the sooner of now + ttl and the sandbox's own expiry; none is minted for an ended one. */
function expiryFor(now: number, ttlS: number, notAfter: number): number {
  const exp = Math.min(now + ttlS, notAfter);
  if (exp <= now)
    throw new CpError('sandbox_terminated', 'sandbox has expired', undefined, {
      reason: 'expired',
    });
  return exp;
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

type ModeClaims = Pick<SandboxTokenClaims, 'mode' | 'mode_epoch' | 'idle_timeout_s'>;

/**
 * The three mode claims, checked. `required: false` is the sandbox token, where a claim may be
 * absent (minted before it existed) and then defaults to the least it can grant; a claim that is
 * present is checked either way, so a malformed one never reads as the default.
 */
function modeClaims(c: Partial<ModeClaims>, required: boolean): ModeClaims {
  const missing = (f: keyof ModeClaims) => required && c[f] === undefined;
  if (missing('mode') || (c.mode !== undefined && !isSandboxModeName(c.mode))) {
    bad('token has no valid mode');
  }
  for (const f of ['mode_epoch', 'idle_timeout_s'] as const) {
    if (missing(f) || (c[f] !== undefined && !isCount(c[f]))) bad(`token has no valid ${f}`);
  }
  return {
    mode: c.mode ?? 'per-exec',
    mode_epoch: c.mode_epoch ?? 0,
    idle_timeout_s: c.idle_timeout_s ?? 0,
  };
}

/** iss, aud, the identity strings, iat, jti and exp: what every sandbox-key token carries. */
function commonClaims(
  c: Record<string, unknown>,
  fields: readonly string[],
  opts: { issuer: string; now?: number; leewayS?: number },
): void {
  if (c.aud !== SANDBOX_TOKEN_AUDIENCE) bad('wrong token audience');
  if (c.iss !== opts.issuer) bad('wrong token issuer');
  for (const f of fields) {
    const v = c[f];
    if (typeof v !== 'string' || v.length === 0) bad(`token has no ${f}`);
  }
  // Checked for type, so the returned claims are what their type says: nothing here is trusted as
  // a claims field that was not checked (the relay logs iat and jti; §3.5).
  if (typeof c.iat !== 'number') bad('token has no iat');
  if (typeof c.jti !== 'string') bad('token has no jti');
  if (typeof c.exp !== 'number') bad('token has no expiry');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now > c.exp + (opts.leewayS ?? SANDBOX_CLOCK_LEEWAY_S)) {
    throw new CpError('token_expired', 'token expired');
  }
}

export function mintSandboxToken(
  signer: { signJws(typ: string, claims: object): string },
  i: SandboxMintInput,
): { token: string; exp: number } {
  const exp = expiryFor(i.now, i.ttlSeconds, i.notAfter);
  const claims: SandboxTokenClaims = {
    iss: i.iss,
    aud: SANDBOX_TOKEN_AUDIENCE,
    sub: i.sub,
    tenant: i.tenant,
    sbx: i.sbx,
    wrk: i.wrk,
    wsk: i.wsk,
    scope: [SANDBOX_SCOPE_EXEC],
    mode: i.mode ?? 'per-exec',
    mode_epoch: i.modeEpoch ?? 0,
    idle_timeout_s: i.idleTimeoutS ?? 0,
    iat: i.now,
    exp,
    jti: randomUUID(),
  };
  return { token: signer.signJws(SANDBOX_TOKEN_TYP, claims), exp };
}

export function verifySandboxToken(
  token: string,
  keys: Map<string, KeyObject>,
  opts: { issuer: string; now?: number; leewayS?: number },
): SandboxTokenClaims {
  const c = verifyJws(token, keys, SANDBOX_TOKEN_TYP).claims;
  commonClaims(c, ['sub', 'tenant', 'sbx', 'wrk', 'wsk'], opts);
  const scope = c.scope;
  if (!Array.isArray(scope) || !scope.includes(SANDBOX_SCOPE_EXEC)) {
    bad('token scope does not include exec');
  }
  return { ...c, ...modeClaims(c, false) } as unknown as SandboxTokenClaims;
}

/**
 * The set-mode token (lease-mode spec §8.2): the signed mode and epoch of one `LeaseControl
 * set_mode`, minted by `PUT /v1/sandboxes/{id}/mode` and `POST .../mode-token` under the sandbox
 * signing key. Its typ is its own, so a sandbox token (an Exec capability) can never set a mode, and
 * this token can never run an Exec. Short-lived: it is sent once, right after it is minted.
 */
export const SANDBOX_MODE_TOKEN_TYP = 'moca-sandbox-mode+jwt';
export const SANDBOX_MODE_TOKEN_TTL_S = 300;

export interface SetModeClaims {
  iss: string;
  aud: string;
  sub: string;
  sbx: string;
  wrk: string;
  wsk: string;
  mode: SandboxModeName;
  mode_epoch: number;
  idle_timeout_s: number;
  iat: number;
  exp: number;
  jti: string;
}

export interface SetModeMintInput {
  sub: string;
  sbx: string;
  wrk: string;
  wsk: string;
  mode: SandboxModeName;
  modeEpoch: number;
  idleTimeoutS: number;
  /** The sandbox's expiresAt (epoch s): no token outlives its sandbox. */
  notAfter: number;
  iss: string;
  /** Epoch seconds. */
  now: number;
}

export function mintSetModeToken(
  signer: { signJws(typ: string, claims: object): string },
  i: SetModeMintInput,
): string {
  const claims: SetModeClaims = {
    iss: i.iss,
    aud: SANDBOX_TOKEN_AUDIENCE,
    sub: i.sub,
    sbx: i.sbx,
    wrk: i.wrk,
    wsk: i.wsk,
    mode: i.mode,
    mode_epoch: i.modeEpoch,
    idle_timeout_s: i.idleTimeoutS,
    iat: i.now,
    exp: expiryFor(i.now, SANDBOX_MODE_TOKEN_TTL_S, i.notAfter),
    jti: randomUUID(),
  };
  return signer.signJws(SANDBOX_MODE_TOKEN_TYP, claims);
}

/** Every claim is required: no set-mode token predates its claims. Same clock leeway as Exec's. */
export function verifySetModeToken(
  token: string,
  keys: Map<string, KeyObject>,
  opts: { issuer: string; now?: number; leewayS?: number },
): SetModeClaims {
  const c = verifyJws(token, keys, SANDBOX_MODE_TOKEN_TYP).claims;
  commonClaims(c, ['sub', 'sbx', 'wrk', 'wsk'], opts);
  return { ...c, ...modeClaims(c, true) } as unknown as SetModeClaims;
}
