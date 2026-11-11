import { createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';
import { CpError } from './errors.js';
import {
  OIDC_SUB_PATTERN,
  rolesFor,
  secretMatches,
  type DeviceStart,
  type FetchLike,
  type IdentityProvider,
  type OidcCallbackResult,
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
 *   1. mocactl POSTs /v1/auth/device and gets a `verificationUri` (the provider's authorize URL),
 *      a `deviceCode` that is actually a high-entropy STATE token, and a short `userCode` shown
 *      only in the terminal that started the login.
 *   2. the user's browser authenticates at the provider, which redirects to the callback route.
 *   3. the control plane exchanges the code server-side (it alone holds the client secret) and
 *      verifies the id_token against the provider's JWKS -- but does NOT settle the login yet.
 *   4. the callback page asks for the terminal's `userCode` AND carries a fresh browser-bound
 *      token minted in that response; only BOTH matching parks the principal on the state.
 *   5. mocactl's poll (POST /v1/auth/device/token) picks it up, exactly as with GitHub.
 *
 * Step 4 is the browser-to-terminal binding, without which the authorize URL is itself a
 * capability: an attacker who starts a login and gets a victim (with a live SSO session) to open
 * the URL would otherwise hand the attacker a fully verified login AS the victim, one click and
 * no code to type. The confirmation code restores the device flow's binding property --
 * possession of the code is proof that the browser's human and the terminal's session are the
 * same party -- and it never rides in the URL, which is the piece the attacker holds. The code
 * alone is not enough (the login's initiator saw it in their own terminal), so the round-1
 * response also mints a token only the completing browser receives, and round 2 requires both.
 *
 * The STATE is the capability, on the device-code trust model: single-use, TTL-bound, and worth
 * nothing until the callback has verified a provider-signed id_token AND collected the terminal's
 * confirmation. No nonce is sent: the state already binds the authorize request to this login, and
 * the client secret (not PKCE) authenticates the code exchange, which never leaves the server.
 */

/** A pending or settled login, keyed by its state token. */
export interface PendingOidcAuth {
  /** The state token: the `deviceCode` the polling client presents. */
  state: string;
  /** Epoch ms after which the whole entry is dead, whatever it holds. */
  expiresAtMs: number;
  /** The terminal's confirmation code, shown as `userCode` at login start. Never in the URL. */
  confirmCode: string;
  /** Set by the callback once an id_token verified; the login completes only when `confirmed`. */
  principal?: Principal;
  /** Set when the confirmation was typed: the login is complete. */
  confirmed?: boolean;
  /**
   * The browser-bound half of the binding, minted in the provider-redirect round and delivered
   * only in that response. The terminal's user code alone does not bind: the login's initiator
   * holds it too (their terminal showed it), so they could confirm a victim's parked principal
   * with a bare request. This token is what they cannot produce -- only the browser that received
   * the round-1 response ever saw it.
   */
  confirmToken?: string;
  /** Wrong confirmation codes entered so far; at MAX_WRONG_CODES the login is refused. */
  wrongCodes?: number;
  /** Set when the provider or the user refused: the poll reports it. */
  denial?: string;
}

/**
 * Where pending logins live. Memory is the default and is correct for a single-replica control
 * plane; a deployment whose ingress load-balances across replicas must back it with the shared
 * store (Redis), or a callback landing on pod B never meets the state pod A issued.
 *
 * `put` refuses (returns false) once the store holds `maxEntries` live entries: the login-start
 * route is unauthenticated, so nothing else bounds the memory a loop of anonymous POSTs can park.
 * `settle` is write-once per outcome: a `principal` is never replaced (a second code exchange
 * must not swap who a parked login belongs to), and a `denial` is terminal. A denial landing on a
 * parked entry IS allowed -- that is the confirm path's designated transition (too many wrong
 * codes) -- so the provider keeps provider-side failures from ever sending one onto a login that
 * already succeeded past the provider (see settleProviderDenial).
 */
export interface PendingAuthStore {
  /** False when the store is at its cap; the caller refuses the login start. */
  put(entry: PendingOidcAuth): Promise<boolean>;
  get(state: string): Promise<PendingOidcAuth | undefined>;
  /** Record the callback's outcome; false when no live entry holds that state, or it is settled. */
  settle(
    state: string,
    patch: Partial<Omit<PendingOidcAuth, 'state' | 'expiresAtMs'>>,
  ): Promise<boolean>;
  delete(state: string): Promise<void>;
}

/** Live pending logins one control plane holds; past this, login starts are refused (429). */
export const MAX_PENDING_LOGINS = 10_000;

export class MemoryPendingAuthStore implements PendingAuthStore {
  private readonly entries = new Map<string, PendingOidcAuth>();
  constructor(
    private readonly now: () => number,
    private readonly maxEntries: number = MAX_PENDING_LOGINS,
  ) {}

  /**
   * Sweep only on put, and only when the map is at the cap: `get` checks each entry's own expiry
   * anyway, so the sweep exists to reclaim space, and reclaiming matters exactly when a put would
   * otherwise be refused. That keeps the common path O(1) instead of walking the map per request.
   */
  private sweep(): void {
    for (const [k, e] of this.entries) if (e.expiresAtMs <= this.now()) this.entries.delete(k);
  }

  async put(entry: PendingOidcAuth): Promise<boolean> {
    if (this.entries.size >= this.maxEntries) this.sweep();
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(entry.state, entry);
    return true;
  }
  async get(state: string): Promise<PendingOidcAuth | undefined> {
    const e = this.entries.get(state);
    return e && e.expiresAtMs > this.now() ? e : undefined;
  }
  async settle(
    state: string,
    patch: Partial<Omit<PendingOidcAuth, 'state' | 'expiresAtMs'>>,
  ): Promise<boolean> {
    const e = await this.get(state);
    if (!e) return false;
    // Write-once per outcome (see the interface): terminal once denied, principal never replaced.
    if (e.denial !== undefined) return false;
    if (e.principal !== undefined && patch.principal !== undefined) return false;
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

// The id_token sub, checked against the ONE pattern (identity.ts) that enrollment also builds
// its grammar from, so the two can never drift apart.
const SUB_RE = new RegExp(`^${OIDC_SUB_PATTERN}$`);

export const OIDC_SUBJECT_PREFIX = 'oidc:';

/**
 * The confirmation code's alphabet: uppercase and digits minus the confusables (I/O vs 1/0), the
 * same discipline as a device-flow user code. XXXX-XXXX (8 chars over 32) is ~2^40 -- far past
 * brute force against MAX_WRONG_CODES tries inside one state's TTL.
 */
const CONFIRM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONFIRM_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
/** Wrong confirmations one login tolerates before it is refused outright. */
export const MAX_WRONG_CODES = 5;

// A mask, not a modulo: `byte & 31` is uniform for a 32-entry alphabet with no bias at all (a
// modulo would be biased for any length not dividing 256). The length is enforced at load, so the
// mask and the alphabet cannot silently disagree.
if (CONFIRM_ALPHABET.length !== 32) {
  throw new Error(`CONFIRM_ALPHABET must hold exactly 32 entries (has ${CONFIRM_ALPHABET.length})`);
}

function mintConfirmCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += CONFIRM_ALPHABET[bytes[i]! & 31];
  }
  return code;
}

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
    // VERBATIM, not slash-trimmed: OIDC Discovery §4.3 and Core §3.1.3.7 compare the issuer by
    // exact match, and providers whose issuer legitimately ends in '/' (Auth0, for one) would
    // fail discovery against a trimmed value. The operator configures the issuer exactly as the
    // provider's discovery document states it.
    this.issuer = opts.issuer;
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
    // Discovery §4: remove a trailing '/' before appending the well-known path -- a verbatim
    // slash issuer would build `…//.well-known/…`, which some servers 404. ONE slash, here only:
    // the issuer itself is still compared verbatim everywhere.
    const base = this.issuer.endsWith('/') ? this.issuer.slice(0, -1) : this.issuer;
    const url = `${base}/.well-known/openid-configuration`;
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
    // The terminal's half of the binding: short, human-typable, and NEVER in the authorize URL --
    // the URL is the piece a victim can be handed, the code is not.
    const confirmCode = mintConfirmCode();
    const parked = await this.store.put({
      state,
      confirmCode,
      expiresAtMs: this.now() + this.stateTtlS * 1000,
    });
    if (!parked) {
      // The route is unauthenticated, so the cap is the only bound on anonymous memory; refusing
      // the START (429) is the client's signal to back off, and expired entries were swept first.
      throw new CpError('quota_exceeded', 'too many sign-ins are waiting; try again in a moment');
    }
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
      userCode: confirmCode,
      verificationUri: authorize.toString(),
      interval: 2,
      expiresIn: this.stateTtlS,
    };
  }

  /**
   * The callback route's other half, in two rounds: `code` (the provider's redirect) exchanges and
   * verifies but does NOT settle -- it returns 'awaiting_confirmation' plus a fresh browser-bound
   * token, delivered only in that response, so the route can ask for the terminal's code AND
   * carry the token as a hidden field; `confirm` (the confirmation form) settles only when BOTH
   * the terminal's code and the browser's token match. The `error` path is the provider's
   * `error` query parameter (access_denied and friends), recorded so the polling client hears it
   * instead of waiting out the window.
   */
  async handleCallback(q: {
    code?: string;
    state?: string;
    error?: string;
    confirm?: string;
    token?: string;
  }): Promise<OidcCallbackResult> {
    if (typeof q.state !== 'string' || q.state.length === 0) {
      throw new CpError('invalid_request', 'the callback is missing its state parameter');
    }
    if (q.error) {
      return this.settleProviderDenial(q.state, `provider refused: ${q.error}`);
    }
    if (q.confirm !== undefined) return this.confirmSignIn(q.state, q.confirm, q.token);
    if (typeof q.code !== 'string' || q.code.length === 0) {
      throw new CpError('invalid_request', 'the callback is missing its code parameter');
    }
    // The state must be live BEFORE the exchange: an unknown state is not ours to redeem, and
    // refusing it first keeps a stranger from making the control plane spend a code at all.
    if (!(await this.store.get(q.state))) {
      throw new CpError('unauthorized', 'unknown or expired sign-in state');
    }
    // Discovery, the exchange and the parse can all fail for reasons that are nobody's fault here
    // (the provider is down, a proxy ate the reply). Whatever the failure, the poll must hear
    // "refused" now rather than hang in authorization_pending for the rest of the window -- the
    // same discipline the verify failure below follows. The reason carries no secret: URLs and
    // provider error codes, never the client secret.
    let body: Record<string, unknown>;
    try {
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
      body = this.parseJson(await res.text(), res.status, d.token_endpoint);
    } catch (err) {
      if (err instanceof CpError && err.code === 'identity_provider_misconfigured') {
        console.error(`[control-plane] oidc provider misconfigured: ${err.message}`);
      }
      return this.settleProviderDenial(
        q.state,
        `the sign-in could not complete: ${(err as Error).message}`,
      );
    }
    if (typeof body.error === 'string') {
      // The operator's to fix, not the user's: a wrong client secret or an unregistered redirect
      // URI shows up here on every single login.
      console.error(`[control-plane] the oidc provider refused the token exchange: ${body.error}`);
      return this.settleProviderDenial(q.state, `token exchange failed: ${body.error}`);
    }
    const idToken = body.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      return this.settleProviderDenial(q.state, 'the token endpoint replied with no id_token');
    }
    // A token that does not verify settles a DENIAL rather than throwing: the browser gets its
    // sentence either way, but the polling client must hear "refused" now, not hang in
    // authorization_pending for the rest of the window over a login that can never complete.
    let principal: Principal;
    try {
      principal = await this.verifyIdToken(idToken);
    } catch (err) {
      if (!(err instanceof CpError) || err.code !== 'unauthorized') throw err;
      return this.settleProviderDenial(q.state, err.message);
    }
    // Parked but NOT confirmed: the principal is real (a verified id_token named them), yet the
    // login completes only when the browser's human proves they hold the terminal's code AND the
    // browser holds the token minted here. The code alone does not bind -- the login's initiator
    // saw it in their own terminal -- which is why the token is minted in THIS response, the one
    // the victim's browser receives and the attacker never sees.
    const confirmToken = randomBytes(32).toString('base64url');
    const ok = await this.store.settle(q.state, { principal, confirmed: false, confirmToken });
    if (!ok) return this.settleRefusedOutcome(q.state);
    return { outcome: 'awaiting_confirmation', confirmToken };
  }

  /**
   * A provider-side refusal (the provider's error parameter, a failed exchange, an unusable
   * reply). It must never flip a login that already succeeded past the provider -- a replayed
   * `?error=` or a retried exchange on a parked entry changes nothing -- so a parked entry is
   * left exactly as it stands.
   */
  private async settleProviderDenial(state: string, reason: string): Promise<OidcCallbackResult> {
    const entry = await this.store.get(state);
    if (!entry) throw new CpError('unauthorized', 'unknown or expired sign-in state');
    if (entry.principal !== undefined) return { outcome: 'awaiting_confirmation' };
    const ok = await this.store.settle(state, { denial: reason });
    return ok ? { outcome: 'refused' } : this.settleRefusedOutcome(state);
  }

  /**
   * A settle the store refused. The confirm token is deliberately NOT re-issued here: only a
   * request that itself completed a provider redirect (the successful exchange above) may carry
   * one away, or a second completer could harvest it and confirm a login that is not theirs.
   */
  private async settleRefusedOutcome(state: string): Promise<OidcCallbackResult> {
    const entry = await this.store.get(state);
    if (!entry) throw new CpError('unauthorized', 'unknown or expired sign-in state');
    if (entry.denial !== undefined) return { outcome: 'refused' };
    return { outcome: 'awaiting_confirmation' };
  }

  /**
   * The confirmation round. The browser's token is checked FIRST and a missing or wrong one burns
   * a try exactly like a wrong code: the login's initiator holds the state and the user code (both
   * were in their terminal) and must not be able to confirm a victim's parked principal with a
   * bare request. A wrong code returns 'wrong_code' (the route re-renders the form) and burns one
   * of MAX_WRONG_CODES tries; exhausting them settles a denial, so the polling client hears the
   * refusal instead of waiting out the window.
   */
  private async confirmSignIn(
    state: string,
    code: string,
    token: string | undefined,
  ): Promise<OidcCallbackResult> {
    const entry = await this.store.get(state);
    if (!entry) throw new CpError('unauthorized', 'unknown or expired sign-in state');
    if (entry.denial) return { outcome: 'refused' };
    if (!entry.principal) {
      // The provider's redirect has not landed yet: nothing to confirm against.
      throw new CpError(
        'invalid_request',
        'there is no sign-in waiting for a code -- open the sign-in URL first',
      );
    }
    if (entry.confirmed) return { outcome: 'confirmed' };
    // A shape-wrong code is refused before it costs a try: the shape is public, so it separates
    // typos and stray pastes from guesses at the secret, and only guesses must be scarce.
    const typed = code.trim().toUpperCase();
    if (!CONFIRM_CODE_RE.test(typed)) return { outcome: 'wrong_code' };
    // Both comparisons constant time (secretMatches hashes both sides to a fixed width first):
    // the reply's latency must not become a per-character oracle on either secret.
    const tokenOk =
      entry.confirmToken !== undefined && secretMatches(token ?? '', entry.confirmToken);
    const codeOk = secretMatches(typed, entry.confirmCode);
    if (!tokenOk || !codeOk) {
      const wrong = (entry.wrongCodes ?? 0) + 1;
      if (wrong >= MAX_WRONG_CODES) {
        await this.store.settle(state, { denial: 'too many wrong confirmation codes' });
        return { outcome: 'refused' };
      }
      await this.store.settle(state, { wrongCodes: wrong });
      return { outcome: 'wrong_code' };
    }
    await this.store.settle(state, { confirmed: true });
    return { outcome: 'confirmed' };
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
    // A principal without a confirmation is NOT a login yet: the poll keeps waiting, which is the
    // walk-in attack failing exactly here.
    if (!entry.principal || !entry.confirmed) {
      throw new CpError('authorization_pending', 'waiting for the browser');
    }
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
    // OIDC Core §3.1.3.7: with several audiences, azp must name this client. Low risk (the token
    // comes straight from the token endpoint), but cheap and correct.
    if (aud.length > 1 && claims.azp !== this.clientId) {
      throw new CpError('unauthorized', 'the id_token is not authorized for this client (azp)');
    }
    if (typeof claims.exp !== 'number' || claims.exp + this.clockSkewS <= nowS) {
      throw new CpError('unauthorized', 'the id_token has expired');
    }
    // Not strictly required with a server-side exchange, but cheap and OIDC Core §3.1.3.7: a
    // token whose validity has not begun (beyond skew) is refused rather than trusted.
    if (typeof claims.nbf === 'number' && claims.nbf - this.clockSkewS > nowS) {
      throw new CpError('unauthorized', 'the id_token is not yet valid');
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
