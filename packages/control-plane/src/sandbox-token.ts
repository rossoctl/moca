import { randomUUID, type KeyObject } from 'node:crypto';
import { CpError } from './errors.js';
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

export function mintSandboxToken(
  signer: { signJws(typ: string, claims: object): string },
  i: SandboxMintInput,
): { token: string; exp: number } {
  const exp = Math.min(i.now + i.ttlSeconds, i.notAfter);
  if (exp <= i.now)
    throw new CpError('sandbox_terminated', 'sandbox has expired', undefined, {
      reason: 'expired',
    });
  const claims: SandboxTokenClaims = {
    iss: i.iss,
    aud: SANDBOX_TOKEN_AUDIENCE,
    sub: i.sub,
    tenant: i.tenant,
    sbx: i.sbx,
    wrk: i.wrk,
    wsk: i.wsk,
    scope: [SANDBOX_SCOPE_EXEC],
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
  const c = verifyJws(token, keys, SANDBOX_TOKEN_TYP).claims as Partial<SandboxTokenClaims>;
  if (c.aud !== SANDBOX_TOKEN_AUDIENCE) bad('wrong token audience');
  if (c.iss !== opts.issuer) bad('wrong token issuer');
  for (const f of ['sub', 'tenant', 'sbx', 'wrk', 'wsk'] as const) {
    if (typeof c[f] !== 'string' || c[f].length === 0) bad(`token has no ${f}`);
  }
  // Checked for type, so the returned claims are what their type says: nothing here is trusted as
  // a SandboxTokenClaims field that was not checked (the relay logs iat and jti; §3.5).
  if (typeof c.iat !== 'number') bad('token has no iat');
  if (typeof c.jti !== 'string') bad('token has no jti');
  if (typeof c.exp !== 'number') bad('token has no expiry');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now > c.exp + (opts.leewayS ?? SANDBOX_CLOCK_LEEWAY_S)) {
    throw new CpError('token_expired', 'token expired');
  }
  if (!Array.isArray(c.scope) || !c.scope.includes(SANDBOX_SCOPE_EXEC)) {
    bad('token scope does not include exec');
  }
  return c as SandboxTokenClaims;
}
