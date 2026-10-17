import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { CpError } from './errors.js';

/**
 * The session/API token: a compact JWS signed with Ed25519 (`alg: EdDSA`). Hand-rolled rather than
 * pulled from a JWT library because the whole thing is ~60 lines of node:crypto and the repo's
 * runtime-dependency budget is the tighter constraint (a token verifier is also code we want to be
 * able to read end to end).
 *
 * The asymmetry is the point (spec §5.2): the control plane holds the private key, the data plane
 * receives only public keys, so a compromised harness can verify but not MINT. makeSigner()
 * therefore refuses a public key outright.
 *
 * NO CREDENTIAL TRAVELS IN THE TOKEN. It is a capability naming a subject and (for a session token)
 * a session; the credential is fetched server-side by the exchange (spec §5.3).
 */
export const TOKEN_AUDIENCE = 'harness';
export const DEFAULT_ISSUER = 'sh-control-plane';

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  tenant: string;
  roles: string[];
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
  /** Present only on a session token; absent on an api token (plan gap #7). */
  sid?: string;
}

export interface MintInput {
  sub: string;
  tenant: string;
  roles: string[];
  scope: string[];
  ttlSeconds: number;
  sid?: string;
  iss?: string;
  /** Epoch SECONDS; injectable so expiry tests are not clock-dependent. */
  now?: number;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const json = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

/** Public key on the wire: base64 of the DER SPKI export (plan gap #6). */
export function publicKeyToBase64(publicKey: KeyObject): string {
  return (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

/**
 * Decode a base64 DER SPKI public key, and REFUSE anything that is not Ed25519.
 *
 * Not exploitable without it -- an RSA or P-256 key simply fails `cryptoVerify` with `alg: EdDSA`, so
 * every token is rejected -- but the failure then arrives per request as "bad token signature" on a
 * healthy-looking deployment. Asserting the curve here fails at PARSE time instead, so a mislabelled
 * key becomes a boot error naming the real problem.
 *
 * That only holds while BOTH tiers parse before serving, so the two call sites are named here rather
 * than asserted in prose: `main.ts` (`configFromEnv` -> `verifyKeysFromEnv`) on the control plane, and
 * `turn-auth.ts`'s `assertKeysetUsable`, called from `startServer`, on the data plane. The data plane
 * ALSO parses per request so a Knative env change needs no restart; neither `/healthz` nor `/readyz`
 * touches the keyset, so dropping the boot call would return this to a per-request failure on a pod
 * that looks Ready -- exactly what this comment claims it prevents.
 */
export function publicKeyFromBase64(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `public key is ${key.asymmetricKeyType ?? 'of unknown type'}, expected ed25519`,
    );
  }
  return key;
}

/**
 * The key id is DERIVED from the key (sha256 of its SPKI DER, first 16 hex chars), never assigned.
 * A `kid` that is a function of its key cannot drift from it, and rotation needs no registry: to
 * rotate, publish the new key alongside the old, roll the Service, then switch signing key.
 */
export function keyIdFor(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

/**
 * Parse `SH_SESSION_TOKEN_PUBLIC_KEYS`: `<kid>:<base64 SPKI>[,<kid>:<base64 SPKI>...]`.
 * Accepting a LIST is what makes rotation possible without a flag day (spec §5.2). A malformed or
 * mislabelled entry THROWS rather than being skipped: a silently dropped key is a deployment that
 * rejects every token minted with it, discovered only in production.
 */
export function parseKeyset(raw: string | undefined): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) {
      throw new Error(
        `SH_SESSION_TOKEN_PUBLIC_KEYS entry '${trimmed}' is not '<kid>:<base64 SPKI>'`,
      );
    }
    const kid = trimmed.slice(0, idx).trim();
    let key: KeyObject;
    try {
      key = publicKeyFromBase64(trimmed.slice(idx + 1).trim());
    } catch (err) {
      throw new Error(
        `SH_SESSION_TOKEN_PUBLIC_KEYS entry '${kid}' is not a base64 Ed25519 SPKI ` +
          `(a wrong curve is rejected here, not per request): ${String(err)}`,
      );
    }
    const derived = keyIdFor(key);
    if (derived !== kid) {
      throw new Error(
        `SH_SESSION_TOKEN_PUBLIC_KEYS entry kid '${kid}' does not match its key (expected '${derived}')`,
      );
    }
    keys.set(kid, key);
  }
  return keys;
}

/**
 * Build a minting signer from a PKCS#8 private key: PEM, or the same DER as one line of base64. The
 * one-line form exists for env files (a compose `.env`, a systemd EnvironmentFile), where a
 * multi-line PEM value is not portable; it is the private-key twin of `SH_SESSION_TOKEN_PUBLIC_KEYS`'s
 * base64 SPKI. Refuses a public key: the data plane holds only public halves, and "the harness cannot
 * mint" must be a property of this API rather than of its callers' discipline (spec §8.1,
 * token-forgery row).
 */
export function makeSigner(privateKeyPem: string): {
  kid: string;
  publicKeyBase64: string;
  signJws(typ: string, claims: object): string;
  mint(input: MintInput): string;
} {
  let key: KeyObject;
  try {
    key = privateKeyPem.includes('-----BEGIN')
      ? createPrivateKey(privateKeyPem)
      : createPrivateKey({
          key: Buffer.from(privateKeyPem.trim(), 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
  } catch (err) {
    throw new Error(`SH_SESSION_TOKEN_PRIVATE_KEY is not a usable private key: ${String(err)}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`session token signing key must be ed25519, got ${key.asymmetricKeyType}`);
  }
  const publicKey = createPublicKey(key);
  const kid = keyIdFor(publicKey);

  const signJws = (typ: string, claims: object): string => {
    const signingInput = `${b64u(json({ alg: 'EdDSA', typ, kid }))}.${b64u(json(claims))}`;
    return `${signingInput}.${b64u(cryptoSign(null, Buffer.from(signingInput), key))}`;
  };

  return {
    kid,
    publicKeyBase64: publicKeyToBase64(publicKey),
    /**
     * Sign any claims under a pinned `typ` -- MI1 §6.1's generalization of this primitive. The
     * session/API token is `typ: JWT`; the sandbox token (sandbox-token.ts) is `moca-sandbox+jwt`.
     * Each verifier pins its own typ, so one kind can never pass as the other.
     */
    signJws,
    mint(input: MintInput): string {
      const iat = input.now ?? Math.floor(Date.now() / 1000);
      const claims: TokenClaims = {
        iss: input.iss ?? DEFAULT_ISSUER,
        aud: TOKEN_AUDIENCE,
        sub: input.sub,
        tenant: input.tenant,
        roles: input.roles,
        scope: input.scope,
        iat,
        exp: iat + input.ttlSeconds,
        jti: randomUUID(),
        ...(input.sid ? { sid: input.sid } : {}),
      };
      return signJws('JWT', claims);
    },
  };
}

// A `function` declaration, not a `const` arrow, and for the reason credential-store.ts documents on
// its own `invalid()`: TS's never-return control-flow narrowing is unreliable for an arrow assigned to
// a `never`-typed const, so `if (!key) bad(...)` left `key` as `KeyObject | undefined` afterwards and
// the call site needed a `key!` to compensate. A function declaration narrows correctly, which is what
// makes that non-null assertion -- and the `header.kid as string` beside it -- genuinely redundant
// rather than merely ugly.
function bad(why: string): never {
  throw new CpError('token_invalid', why);
}

/**
 * The structural half of every verifier: structure, alg, typ, kid, then SIGNATURE, then payload
 * parse -- in that order, so nothing from the payload is trusted before the signature check.
 * `typ` is pinned by the caller: the harness token is `JWT`, the sandbox token `moca-sandbox+jwt`.
 */
export function verifyJws(
  token: string,
  keys: Map<string, KeyObject>,
  typ: string,
): { claims: Record<string, unknown> } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) bad('malformed token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
  } catch {
    return bad('unparseable token header');
  }
  if (typeof header !== 'object' || header === null) bad('unparseable token header');
  // Reject `alg: none` and every non-EdDSA alg BEFORE looking at the key: accepting the header's
  // word on the algorithm is the classic JWT downgrade.
  if (header.alg !== 'EdDSA') bad('unsupported alg');
  if (header.typ !== typ) bad(`wrong token typ (want ${typ})`);
  if (typeof header.kid !== 'string') bad('token header has no kid');
  const key = keys.get(header.kid);
  // `bad()` is declared `: never`, so control flow cannot reach past it -- no `key!` needed.
  if (!key) bad('unknown token key id');
  if (!cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
    bad('bad token signature');
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return bad('unparseable token payload');
  }
  if (typeof claims !== 'object' || claims === null) bad('unparseable token payload');
  return { claims };
}

/**
 * Verify locally -- no network, no JWKS fetch. Deliberately not a JWKS endpoint (spec §5.2):
 * fetching keys at verify time would put a control-plane round trip on every turn and undo §9.2's
 * property that an identity-provider or control-plane outage does not break running work.
 *
 * Order matters: structure, then alg, then kid, then SIGNATURE, then claims. Nothing from the
 * payload is trusted before the signature check, so a forged `exp` cannot produce `token_expired`
 * (which would tell an attacker their tampering parsed). The structural half is in verifyJws.
 */
export function verifyToken(
  token: string,
  keys: Map<string, KeyObject>,
  opts: { now?: number; requiredScope?: string } = {},
): TokenClaims {
  const claims = verifyJws(token, keys, 'JWT').claims as unknown as TokenClaims;
  if (claims.aud !== TOKEN_AUDIENCE) bad('wrong token audience');
  // `iss` was minted (MintInput lets a caller set it) but never checked, so the claim was decorative:
  // a token from any other issuer signed by a key in this keyset verified fine. It matters as soon as
  // a deployment publishes more than one issuer's key -- which is exactly what the keyset LIST exists
  // to allow (spec §5.2) -- so check it while there is still only one.
  if (claims.iss !== DEFAULT_ISSUER) bad('wrong token issuer');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) bad('token has no subject');
  if (typeof claims.exp !== 'number') bad('token has no expiry');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // `>` not `>=`: a token is valid THROUGH its exp second.
  if (now > claims.exp) throw new CpError('token_expired', 'token expired');
  if (opts.requiredScope && !(claims.scope ?? []).includes(opts.requiredScope)) {
    bad(`token scope does not include ${opts.requiredScope}`);
  }
  return claims;
}
