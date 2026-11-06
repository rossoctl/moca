import { createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';
import { CpError } from './errors.js';
import {
  rolesFor,
  type DeviceStart,
  type FetchLike,
  type IdentityProvider,
  type Principal,
} from './identity.js';

/**
 * The generic OIDC identity provider (slice 2 of the identity seam, identity.ts): discovery + JWKS,
 * the browser AUTHORIZATION-CODE flow with the control plane itself as the redirect target.
 *
 * Why not the device flow, as GitHub uses: the target provider (w3id, IBM's SSO) does not implement
 * RFC 8628, and neither do most enterprise OIDC servers. Instead the control plane exposes its own
 * callback route (`/v1/auth/oidc/callback`, typically behind an OpenShift Route or an ingress), and
 * the flow looks like the device flow from mocactl's seat:
 *
 *   1. mocactl POSTs /v1/auth/device and gets a `verificationUri` (the provider's authorize URL)
 *      plus a `deviceCode` that is actually a high-entropy STATE token.
 *   2. the user's browser authenticates at the provider, which redirects to the callback route.
 *   3. the control plane exchanges the code server-side (it alone holds the client secret), verifies
 *      the id_token against the provider's JWKS, and parks the principal against the state.
 *   4. mocactl's poll (POST /v1/auth/device/token) picks it up, exactly as with GitHub.
 *
 * The STATE is the capability, on the device-code trust model: single-use, TTL-bound, and worth
 * nothing until the callback has verified a provider-signed id_token against it. No nonce is sent:
 * the state already binds the authorize request to this login, and the client secret (not PKCE)
 * authenticates the code exchange, which never leaves the server.
 */

/** A pending or settled login, keyed by its state token. */
export interface PendingOidcAuth {
  /** The state token: the `deviceCode` the polling client presents. */
  state: string;
  /** Epoch ms after which the whole entry is dead, whatever it holds. */
  expiresAtMs: number;
  /** Set by the callback once an id_token verified: the login succeeded. */
  principal?: Principal;
  /** Set by the callback when the provider or the user refused: the poll reports it. */
  denial?: string;
}

/**
 * Where pending logins live. Memory is the default and is correct for a single-replica control
 * plane; a deployment whose ingress load-balances across replicas must back it with the shared
 * store (Redis), or a callback landing on pod B never meets the state pod A issued.
 */
export interface PendingAuthStore {
  put(entry: PendingOidcAuth): Promise<void>;
  get(state: string): Promise<PendingOidcAuth | undefined>;
  /** Record the callback's outcome; false when no live entry holds that state. */
  settle(state: string, patch: { principal?: Principal; denial?: string }): Promise<boolean>;
  delete(state: string): Promise<void>;
}

export class MemoryPendingAuthStore implements PendingAuthStore {
  private readonly entries = new Map<string, PendingOidcAuth>();
  constructor(private readonly now: () => number) {}

  /** Lazy sweep on every touch: a background timer would outlive a test's store. */
  private sweep(): void {
    for (const [k, e] of this.entries) if (e.expiresAtMs <= this.now()) this.entries.delete(k);
  }

  async put(entry: PendingOidcAuth): Promise<void> {
    this.sweep();
    this.entries.set(entry.state, entry);
  }
  async get(state: string): Promise<PendingOidcAuth | undefined> {
    this.sweep();
    const e = this.entries.get(state);
    return e && e.expiresAtMs > this.now() ? e : undefined;
  }
  async settle(state: string, patch: { principal?: Principal; denial?: string }): Promise<boolean> {
    const e = await this.get(state);
    if (!e) return false;
    // A settled entry keeps its TTL: the polling client has the rest of the window to collect it.
    Object.assign(e, patch);
    return true;
  }
  async delete(state: string): Promise<void> {
    this.entries.delete(state);
  }
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [claim: string]: unknown;
}

/** RS256 only: it is what w3id (and every enterprise IdP this targets) signs with. */
const SUPPORTED_ALG = 'RS256';

/** The id_token `sub`, as it becomes part of the control plane's subject. */
const SUB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const OIDC_SUBJECT_PREFIX = 'oidc:';

export class OidcProvider implements IdentityProvider {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly adminSubjects: string[];
  private readonly scope: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly store: PendingAuthStore;
  private readonly stateTtlS: number;
  private readonly clockSkewS: number;

  private discovery?: Discovery;
  private jwks?: { keys: Jwk[]; fetchedAtMs: number };

  constructor(opts: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    /** The control plane's own callback URL, as registered with the provider. */
    redirectUri: string;
    adminSubjects?: string[];
    scope?: string;
    fetch?: FetchLike;
    now?: () => number;
    store?: PendingAuthStore;
    stateTtlS?: number;
    clockSkewS?: number;
  }) {
    for (const k of ['issuer', 'clientId', 'clientSecret', 'redirectUri'] as const) {
      if (!opts[k]) throw new Error(`the oidc identity provider requires ${k}`);
    }
    this.issuer = opts.issuer.replace(/\/+$/, '');
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
    this.adminSubjects = opts.adminSubjects ?? [];
    this.scope = opts.scope ?? 'openid email profile';
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store ?? new MemoryPendingAuthStore(this.now);
    this.stateTtlS = opts.stateTtlS ?? 900;
    this.clockSkewS = opts.clockSkewS ?? 60;
  }

  /** Discovery is fetched on first use, so a provider briefly down at boot does not wedge boot. */
  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.issuer}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = this.parseJson(await res.text(), res.status, url);
    const d: Discovery = {
      authorization_endpoint: String(body.authorization_endpoint ?? ''),
      token_endpoint: String(body.token_endpoint ?? ''),
      jwks_uri: String(body.jwks_uri ?? ''),
    };
    for (const [k, v] of Object.entries(d)) {
      if (!/^https:\/\//.test(v)) {
        throw this.misconfigured(`discovery at ${url} has no https ${k}`);
      }
    }
    // OIDC discovery §4.3: the document's issuer MUST be the configured one, else everything the
    // document says is about some other provider.
    if (body.issuer !== this.issuer) {
      throw this.misconfigured(
        `discovery at ${url} advertises issuer ${String(body.issuer)}, not ${this.issuer}`,
      );
    }
    this.discovery = d;
    return d;
  }

  async startDeviceAuth(): Promise<DeviceStart> {
    const d = await this.discover();
    // 32 random bytes, base64url: the state is the capability the client polls with, so it is
    // unguessable for the same reason a device code or refresh token is.
    const state = randomBytes(32).toString('base64url');
    await this.store.put({ state, expiresAtMs: this.now() + this.stateTtlS * 1000 });
    const authorize = new URL(d.authorization_endpoint);
    // URLSearchParams encodes the state and redirect_uri; append so a provider whose endpoint
    // already carries query parameters keeps them.
    const params = new URLSearchParams(authorize.search);
    params.set('client_id', this.clientId);
    params.set('response_type', 'code');
    params.set('scope', this.scope);
    params.set('state', state);
    params.set('redirect_uri', this.redirectUri);
    authorize.search = params.toString();
    return {
      deviceCode: state,
      // No user code: the browser session at the provider IS the thing the person completes, and
      // the state rides in the URL rather than being read and typed.
      verificationUri: authorize.toString(),
      interval: 2,
      expiresIn: this.stateTtlS,
    };
  }

  /**
   * The callback route's other half: exchange the code, verify the id_token, and settle the login
   * the state names. The `denial` path is the provider's `error` query parameter (access_denied
   * and friends): recorded so the polling client hears it instead of waiting out the window.
   */
  async handleCallback(q: { code?: string; state?: string; error?: string }): Promise<void> {
    if (typeof q.state !== 'string' || q.state.length === 0) {
      throw new CpError('invalid_request', 'the callback is missing its state parameter');
    }
    if (q.error) {
      const known = await this.store.settle(q.state, { denial: `provider refused: ${q.error}` });
      if (!known) throw new CpError('unauthorized', 'unknown or expired sign-in state');
      return;
    }
    if (typeof q.code !== 'string' || q.code.length === 0) {
      throw new CpError('invalid_request', 'the callback is missing its code parameter');
    }
    // The state must be live BEFORE the exchange: an unknown state is not ours to redeem, and
    // refusing it first keeps a stranger from making the control plane spend a code at all.
    if (!(await this.store.get(q.state))) {
      throw new CpError('unauthorized', 'unknown or expired sign-in state');
    }
    const d = await this.discover();
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }).toString(),
    });
    const body = this.parseJson(await res.text(), res.status, d.token_endpoint);
    if (typeof body.error === 'string') {
      // The operator's to fix, not the user's: a wrong client secret or an unregistered redirect
      // URI shows up here on every single login.
      console.error(`[control-plane] the oidc provider refused the token exchange: ${body.error}`);
      const ok = await this.store.settle(q.state, {
        denial: `token exchange failed: ${body.error}`,
      });
      if (!ok) throw new CpError('unauthorized', 'unknown or expired sign-in state');
      return;
    }
    const idToken = body.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw this.misconfigured('the token endpoint replied with no id_token');
    }
    // A token that does not verify settles a DENIAL rather than throwing: the browser gets its
    // sentence either way, but the polling client must hear "refused" now, not hang in
    // authorization_pending for the rest of the window over a login that can never complete.
    let principal: Principal;
    try {
      principal = await this.verifyIdToken(idToken);
    } catch (err) {
      if (!(err instanceof CpError) || err.code !== 'unauthorized') throw err;
      const ok = await this.store.settle(q.state, { denial: err.message });
      if (!ok) throw new CpError('unauthorized', 'unknown or expired sign-in state');
      return;
    }
    const ok = await this.store.settle(q.state, { principal });
    if (!ok) throw new CpError('unauthorized', 'unknown or expired sign-in state');
  }

  async completeDeviceAuth(deviceCode: string): Promise<Principal> {
    const entry = await this.store.get(deviceCode);
    // An unknown state is reported as EXPIRED, not pending: the client's only move is a fresh one
    // (the same one-code-for-every-refusal discipline as the refresh store).
    if (!entry) throw new CpError('device_code_expired', 'the sign-in state is unknown or expired');
    if (entry.denial) {
      await this.store.delete(deviceCode);
      throw new CpError('unauthorized', entry.denial);
    }
    if (!entry.principal) throw new CpError('authorization_pending', 'waiting for the browser');
    await this.store.delete(deviceCode);
    return entry.principal;
  }

  rolesFor(subject: string): string[] {
    return rolesFor(subject, this.adminSubjects);
  }

  /** RS256 over the JWS signing input, against the JWKS key the header's `kid` names. */
  private async verifyIdToken(idToken: string): Promise<Principal> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new CpError('unauthorized', 'the id_token is not a JWS');
    const [encHeader, encPayload, encSig] = parts as [string, string, string];
    const header = this.decodeJson(encHeader, 'the id_token header');
    if (header.alg !== SUPPORTED_ALG || typeof header.kid !== 'string') {
      throw new CpError('unauthorized', `the id_token is not ${SUPPORTED_ALG} with a kid`);
    }
    const claims = this.decodeJson(encPayload, 'the id_token payload');

    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.issuer) {
      throw new CpError('unauthorized', 'the id_token issuer is not the configured one');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) {
      throw new CpError('unauthorized', 'the id_token audience is not this client');
    }
    if (typeof claims.exp !== 'number' || claims.exp + this.clockSkewS <= nowS) {
      throw new CpError('unauthorized', 'the id_token has expired');
    }
    if (typeof claims.sub !== 'string' || !SUB_RE.test(claims.sub)) {
      // The sub becomes part of subjects -- Redis keys, audit lines, SH_ALLOWED_SUBJECTS -- so an
      // exotic value is refused rather than smuggled through them.
      throw new CpError('unauthorized', 'the id_token has no usable sub claim');
    }

    const key = await this.signingKey(header.kid);
    const ok = createVerify('RSA-SHA256')
      .update(`${encHeader}.${encPayload}`)
      .verify(key, Buffer.from(encSig, 'base64url'));
    if (!ok) throw new CpError('unauthorized', 'the id_token signature did not verify');

    const subject = `${OIDC_SUBJECT_PREFIX}${claims.sub}`;
    const displayName =
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.email === 'string' && claims.email) ||
      subject;
    return { subject, displayName, roles: rolesFor(subject, this.adminSubjects) };
  }

  /**
   * The JWKS is cached and re-fetched once when a kid is not in it, so a provider key rotation
   * costs one extra request per rotation, not one per login.
   */
  private async signingKey(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const fetchJwks = async (): Promise<Jwk[]> => {
      const d = await this.discover();
      const res = await this.fetchImpl(d.jwks_uri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const body = this.parseJson(await res.text(), res.status, d.jwks_uri);
      if (!Array.isArray(body.keys)) throw this.misconfigured('the JWKS has no keys array');
      this.jwks = { keys: body.keys as Jwk[], fetchedAtMs: this.now() };
      return this.jwks.keys;
    };
    const keys = this.jwks ? this.jwks.keys : await fetchJwks();
    const pick = (ks: Jwk[]) =>
      ks.find((k) => k.kid === kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'));
    let jwk = pick(keys);
    if (!jwk && this.jwks) jwk = pick(await fetchJwks());
    if (!jwk) throw new CpError('unauthorized', `the JWKS has no key for kid ${kid}`);
    try {
      return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    } catch {
      throw new CpError('unauthorized', `the JWKS key for kid ${kid} is not a usable RSA key`);
    }
  }

  private misconfigured(message: string): CpError {
    console.error(`[control-plane] oidc provider misconfigured: ${message}`);
    return new CpError('identity_provider_misconfigured', message);
  }

  /** A non-JSON reply must be an error, not a raw SyntaxError with the URL in its stack. */
  private parseJson(text: string, status: number, url: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw this.misconfigured(`${url} replied ${status} with a non-JSON body`);
    }
  }

  private decodeJson(seg: string, what: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new CpError('unauthorized', `${what} did not decode as JSON`);
    }
  }
}
