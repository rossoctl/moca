import { createHash, type KeyObject } from 'node:crypto';
import {
  CpError,
  parseKeyset,
  verifySandboxToken,
  type SandboxTokenClaims,
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

const KEYSET_VAR = 'SH_SANDBOX_TOKEN_PUBLIC_KEYS';

/**
 * parseKeyset's errors name SH_SESSION_TOKEN_PUBLIC_KEYS and quote the offending entry. Neither is
 * right here: the operator must fix the variable this relay reads, and a boot error never echoes a
 * configured value. So each entry is parsed alone and a failure is reported by position and kind.
 */
function keysetFromEnv(raw: string): Map<string, KeyObject> {
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
      const m = (err as Error).message;
      const kind = / is not '<kid>:/.test(m)
        ? `is not '<kid>:<base64 SPKI>'`
        : /does not match its key/.test(m)
          ? 'has a kid that does not match its key'
          : 'is not a base64 Ed25519 SPKI';
      throw new Error(`${KEYSET_VAR} entry ${i + 1} ${kind}`);
    }
    for (const [kid, key] of one) keys.set(kid, key);
  });
  if (keys.size === 0) throw new Error(`${KEYSET_VAR} lists no key`);
  return keys;
}

/**
 * Builds the sandbox verifier from the environment, or returns undefined when no keyset is set
 * (a harness-only relay). A keyset that does not parse, or one without its issuer, is a boot error
 * naming the variable (§3.3).
 */
export function makeSandboxTokenVerifier(env: NodeJS.ProcessEnv): SandboxVerifier | undefined {
  const raw = env[KEYSET_VAR]?.trim();
  if (!raw) return undefined;
  const keys = keysetFromEnv(raw);
  const issuer = env.SH_SANDBOX_TOKEN_ISSUER?.trim();
  if (!issuer) throw new Error(`SH_SANDBOX_TOKEN_ISSUER is required with ${KEYSET_VAR}`);
  return (presented) => {
    if (!presented) return { reason: 'no bearer token' };
    try {
      return { claims: verifySandboxToken(presented, keys, { issuer }) };
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
 * SHA-256(utf8(sbx) || 0x00 || reqId as 8 big-endian bytes), with 0 mapped to 1.
 *
 * Every sandbox of a template shares one worker, whose dedup cache and in-flight registry key on
 * req_id with a fingerprint that leaves out the workspace key. Without this, two sandboxes sending
 * the same req_id and command would share one result, and one could block or abort the other's
 * Exec. Deterministic, so a client retrying its own req_id still reaches the worker's dedup; 53
 * bits, so the id survives the generated client's uint64-as-number mapping.
 */
export function workerReqId(sbx: string, reqId: number): number {
  if (!Number.isSafeInteger(reqId) || reqId < 0) {
    throw new RangeError('req_id must be a non-negative safe integer');
  }
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(BigInt(reqId));
  const digest = createHash('sha256')
    .update(Buffer.from(sbx, 'utf8'))
    .update(Buffer.from([0]))
    .update(be)
    .digest();
  const id = Number(digest.readBigUInt64BE(0) >> 11n);
  return id === 0 ? 1 : id;
}
