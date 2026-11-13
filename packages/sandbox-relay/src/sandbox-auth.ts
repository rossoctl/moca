import { createHmac, type KeyObject } from 'node:crypto';
import {
  CpError,
  KeysetError,
  parseKeyset,
  verifySandboxToken,
  verifySetModeToken,
  type SandboxTokenClaims,
  type SetModeClaims,
} from '@moca/control-plane';

/**
 * The verdict on one presented sandbox token. `reason` is for the operator's refusal log only
 * (SBX0 §3.5): the caller is told UNAUTHENTICATED and nothing more. It is one of the verifier's
 * fixed messages and never contains the token or any part of it.
 */
export type SandboxVerdict =
  { claims: SandboxTokenClaims; reason?: undefined } | { claims?: undefined; reason: string };

/**
 * The relay's sandbox caller (SBX0 spec §3.2): a moca-sandbox+jwt minted by the sandbox control
 * plane, verified here with PUBLIC keys only, so a compromised relay can route but never mint.
 * Never throws per call.
 */
export type SandboxVerifier = (presented: string | undefined) => SandboxVerdict;

/** The verdict on one presented set-mode token; `reason` as SandboxVerdict's. */
export type SetModeVerdict =
  { claims: SetModeClaims; reason?: undefined } | { claims?: undefined; reason: string };

/**
 * The relay's check of a set_mode's `set_mode_token` (lease-mode spec §8.2): a
 * `moca-sandbox-mode+jwt` from the same control plane, so a sandbox token cannot stand in for it.
 * Same keys, issuer and leeway as SandboxVerifier. Never throws per call.
 */
export type SetModeVerifier = (presented: string | undefined) => SetModeVerdict;

const KEYSET_VAR = 'SH_SANDBOX_TOKEN_PUBLIC_KEYS';

const KEYSET_DEFECT: Record<KeysetError['kind'], string> = {
  format: `is not '<kid>:<base64 SPKI>'`,
  key: 'is not a base64 Ed25519 SPKI',
  kid: 'has a kid that does not match its key',
};

/**
 * parseKeyset's errors name SH_SESSION_TOKEN_PUBLIC_KEYS and quote the offending entry. Neither is
 * right here: the operator must fix the variable this relay reads, and a boot error never echoes a
 * configured value. So each entry is parsed alone and a failure is reported by position and by its
 * KeysetError kind. Shared with the attach keyset (MOCA_ATTACH_PUBLIC_KEYS), hence `varName`.
 */
export function keysetFromEnv(varName: string, raw: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    let one: Map<string, KeyObject>;
    try {
      one = parseKeyset(entry);
    } catch (err) {
      const kind = err instanceof KeysetError ? err.kind : 'key';
      throw new Error(`${varName} entry ${i + 1} ${KEYSET_DEFECT[kind]}`);
    }
    for (const [kid, key] of one) keys.set(kid, key);
  });
  if (keys.size === 0) throw new Error(`${varName} lists no key`);
  return keys;
}

/**
 * Builds the sandbox verifier from the environment, or returns undefined when no keyset is set
 * (a harness-only relay). A keyset that does not parse, or one without its issuer, is a boot error
 * naming the variable (§3.3).
 */
export function makeSandboxTokenVerifier(env: NodeJS.ProcessEnv): SandboxVerifier | undefined {
  const cfg = sandboxKeys(env);
  return cfg && verifierOf((t) => verifySandboxToken(t, cfg.keys, { issuer: cfg.issuer }));
}

/**
 * The set-mode token verifier, from the same variables as makeSandboxTokenVerifier, with the same
 * boot errors; undefined when no keyset is set.
 */
export function makeSetModeTokenVerifier(env: NodeJS.ProcessEnv): SetModeVerifier | undefined {
  const cfg = sandboxKeys(env);
  return cfg && verifierOf((t) => verifySetModeToken(t, cfg.keys, { issuer: cfg.issuer }));
}

/** SH_SANDBOX_TOKEN_PUBLIC_KEYS and its issuer, or undefined when the keyset is unset or blank. */
function sandboxKeys(
  env: NodeJS.ProcessEnv,
): { keys: Map<string, KeyObject>; issuer: string } | undefined {
  const raw = env[KEYSET_VAR]?.trim();
  if (!raw) return undefined;
  const keys = keysetFromEnv(KEYSET_VAR, raw);
  const issuer = env.SH_SANDBOX_TOKEN_ISSUER?.trim();
  if (!issuer) throw new Error(`SH_SANDBOX_TOKEN_ISSUER is required with ${KEYSET_VAR}`);
  return { keys, issuer };
}

function verifierOf<C>(
  verify: (presented: string) => C,
): (
  presented: string | undefined,
) => { claims: C; reason?: undefined } | { claims?: undefined; reason: string } {
  return (presented) => {
    if (!presented) return { reason: 'no bearer token' };
    try {
      return { claims: verify(presented) };
    } catch (err) {
      // CpError messages are the verifier's own fixed strings. Anything else is unexpected, and
      // its message could carry input, so it is not logged.
      return { reason: err instanceof CpError ? err.message : 'invalid token' };
    }
  };
}

/** SBX0 §3.6: one running, one waiting at the worker's per-workspace gate. */
export const DEFAULT_SANDBOX_MAX_INFLIGHT = 2;

/** `SH_SANDBOX_MAX_INFLIGHT`: a positive integer; unset or empty is the default. */
export function sandboxMaxInflight(env: NodeJS.ProcessEnv): number {
  const raw = env.SH_SANDBOX_MAX_INFLIGHT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SANDBOX_MAX_INFLIGHT;
  const v = raw.trim();
  const n = Number(v);
  if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(n)) {
    // The value is not secret, but boot errors name variables, not values, everywhere here.
    throw new Error('SH_SANDBOX_MAX_INFLIGHT must be a positive integer');
  }
  return n;
}

/**
 * The worker-side req_id of a sandbox caller's Exec (SBX0 §3.6): the first 53 bits of
 * HMAC-SHA-256(key, utf8(sbx) || 0x00 || reqId as 8 big-endian bytes), with 0 mapped to 1.
 *
 * Every sandbox of a template shares one worker, whose dedup cache and in-flight registry key on
 * req_id with a fingerprint that leaves out the workspace key. Without this, two sandboxes sending
 * the same req_id and command would share one result, and one could block or abort the other's
 * Exec. Keyed with a secret only the relay holds, so a sandbox cannot search offline for a req_id
 * of its own that lands on another sandbox's id and plant a result in the worker's dedup cache.
 * Deterministic for one key, so a client retrying its own req_id still reaches the worker's dedup;
 * 53 bits, so the id survives the generated client's uint64-as-number mapping.
 */
export function workerReqId(key: Buffer, sbx: string, reqId: number): number {
  if (!Number.isSafeInteger(reqId) || reqId < 0) {
    throw new RangeError('req_id must be a non-negative safe integer');
  }
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(BigInt(reqId));
  const digest = createHmac('sha256', key)
    .update(Buffer.from(sbx, 'utf8'))
    .update(Buffer.from([0]))
    .update(be)
    .digest();
  const id = Number(digest.readBigUInt64BE(0) >> 11n);
  return id === 0 ? 1 : id;
}
