import { createHash, timingSafeEqual } from 'node:crypto';
import { CpError } from './errors.js';

/**
 * Identity, behind a seam (spec §5.1). Slice 1 is `github-oauth`; slice 2 adds a generic `oidc`
 * provider (discovery + JWKS) for Keycloak/Dex/Entra/OCP cluster OAuth.
 *
 * GitHub is NOT an OIDC provider, and that changes the implementation: its user-login flow is plain
 * OAuth 2.0 -- no id_token, no discovery document, no JWKS. A code is exchanged for an OPAQUE token
 * and identity comes from GET /user. Running Dex with a GitHub connector was rejected for slice 1:
 * cleaner long-term, but it adds a second new deployable to the demo path to defer code needed anyway.
 *
 * The DEVICE flow, not the browser authorization-code flow, because demo-multiuser.sh is a shell
 * script and cannot complete a browser redirect (spec §5.1.1). It also needs no client secret, which
 * is what makes it safe to drive from a script a developer reads.
 */
export interface Principal {
  subject: string;
  displayName: string;
  roles: string[];
}

export interface DeviceStart {
  deviceCode: string;
  /**
   * The code the user confirms the login with: typed at the provider (GitHub's device flow) or
   * on the control plane's own confirmation page (the OIDC flow, where it doubles as the
   * browser-to-terminal binding -- see oidc.ts). Every provider mints one; a client still must
   * not assume it is present, only render it when it is.
   */
  userCode?: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface IdentityProvider {
  startDeviceAuth(): Promise<DeviceStart>;
  /**
   * Throws `authorization_pending` (428) while the user has not yet approved, and
   * `device_code_expired` (410) once the code has lapsed unapproved.
   */
  completeDeviceAuth(deviceCode: string): Promise<Principal>;
  /**
   * The subject's roles NOW. A refresh calls this rather than replaying the roles recorded at login,
   * so an SH_ADMIN_SUBJECTS change reaches a long-lived login within one API-token lifetime (B14).
   */
  rolesFor(subject: string): string[];

  /**
   * A provider whose user completes login in a browser pointed BACK at the control plane (the OIDC
   * authorization-code flow, oidc.ts): the callback route hands the query parameters here. Absent
   * on providers that hold the whole flow themselves (GitHub's device flow), and the callback
   * route answers those deployments with a plain refusal.
   *
   * `code` is the provider's redirect (first round); `confirm` is the terminal's user code typed
   * into the callback page, with `token` the browser-bound half of the binding (second round --
   * see oidc.ts).
   */
  handleCallback?(q: {
    code?: string;
    state?: string;
    error?: string;
    confirm?: string;
    token?: string;
  }): Promise<OidcCallbackResult>;
}

/**
 * What the OIDC callback route should show the browser next: the confirmation form (the provider's
 * redirect landed, the terminal's code is still owed), a wrong code (re-render with a note), a
 * completed sign-in, or a refusal the poll will report.
 */
export type OidcCallbackOutcome = 'awaiting_confirmation' | 'wrong_code' | 'confirmed' | 'refused';

/**
 * The callback's answer, plus -- on the first round only -- the browser-bound confirmation token
 * the route must deliver in THAT response (a hidden form field) and require back in the second.
 * It is the piece the login's initiator never sees: their victim's browser received it, they did
 * not, so state + user code + this token together prove the confirmation came from the browser
 * that completed the provider's redirect.
 */
export interface OidcCallbackResult {
  outcome: OidcCallbackOutcome;
  confirmToken?: string;
}

/** Structural subset of fetch, so tests inject a scripted transport and no test touches the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** The subject form the control plane mints (`github:<numeric id>`, see completeDeviceAuth). */
export const GITHUB_SUBJECT_RE = /^github:[0-9]+$/;

/** The synthetic subject form `SH_TEST_USERS` mints (`test:<1-based index>`). */
export const TEST_SUBJECT_RE = /^test:[0-9]+$/;

/**
 * The most test users one deployment may mint. A mistyped `SH_TEST_USERS=100000` would otherwise
 * create a six-digit subject space, each able to store credentials and own sessions.
 */
export const TEST_USERS_MAX = 1000;

/** The shortest `SH_TEST_USER_SECRET` accepted: it is a password on a login path, not a label. */
export const TEST_USER_SECRET_MIN_CHARS = 16;

export const testSubject = (index: number): string => `test:${index}`;

/**
 * `SH_TEST_USERS`: how many synthetic logins this deployment serves; 0 (the default) disables the
 * path entirely. Refused rather than coerced -- a silent 0 from a typo would look like "the feature
 * is off" to an operator who had just switched it on, and a silent huge value is worse.
 */
export function testUsersFromEnv(raw: string | undefined): number {
  const s = (raw ?? '').trim();
  if (s === '') return 0;
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`SH_TEST_USERS must be a whole number of users (got ${JSON.stringify(s)})`);
  }
  const n = Number(s);
  if (n > TEST_USERS_MAX) {
    throw new Error(`SH_TEST_USERS must be at most ${TEST_USERS_MAX} (got ${n})`);
  }
  return n;
}

/**
 * `SH_TEST_USER_SECRET`: the shared secret a client must present to get a test-user login. Required
 * whenever test users are on, because the endpoint hands out a real login for an arbitrary subject:
 * without it, anyone who can reach the control plane is every test user. A minimum length is
 * enforced here -- the variable is set by the same hand that sets SH_TEST_USERS, and a two-character
 * value would be brute-forceable long before an operator noticed.
 */
export function testUserSecretFromEnv(raw: string | undefined, testUsers: number): string {
  const s = raw ?? '';
  if (testUsers === 0) {
    // Set-without-SH_TEST_USERS is a misconfiguration worth naming: the operator believes they
    // enabled something they have not.
    if (s !== '') {
      throw new Error('SH_TEST_USER_SECRET is set but SH_TEST_USERS is not: no test users exist');
    }
    return '';
  }
  if (s === '') {
    throw new Error(
      'SH_TEST_USER_SECRET is required when SH_TEST_USERS is set: the test-login endpoint ' +
        'issues a real login for any test subject, so it must be gated by a secret',
    );
  }
  if (s.length < TEST_USER_SECRET_MIN_CHARS) {
    throw new Error(
      `SH_TEST_USER_SECRET must be at least ${TEST_USER_SECRET_MIN_CHARS} characters ` +
        `(got ${s.length})`,
    );
  }
  return s;
}

/**
 * Constant time, so the reply's latency cannot be used to recover the secret one character at a
 * time. `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle, so
 * both sides are hashed to a fixed width first -- the comparison is then always over 32 bytes.
 *
 * Hashing with SHA-256 (not HMAC) is enough here: this compares a secret against itself, so there
 * is no message to authenticate and no key to separate.
 */
export function secretMatches(presented: string, expected: string): boolean {
  if (expected === '') return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Identity for `SH_TEST_USERS` (ADR-0045): N synthetic subjects that log in with a shared secret
 * instead of a browser, so automation can exercise the multi-user claims.
 *
 * It implements the same seam as GithubOAuthProvider but refuses the device flow: a test user has
 * no browser to approve anything. Everything AFTER identity is deliberately unchanged -- the
 * handler issues the same refresh family and returns the same login body as a device login, so a
 * test user is configured exactly like a GitHub user.
 */
export class TestUserProvider implements IdentityProvider {
  readonly count: number;
  private readonly secret: string;
  private readonly adminSubjects: string[];

  constructor(opts: { count: number; secret: string; adminSubjects?: string[] }) {
    if (!Number.isInteger(opts.count) || opts.count <= 0) {
      throw new Error('TestUserProvider needs a positive whole user count');
    }
    if (opts.secret.length < TEST_USER_SECRET_MIN_CHARS) {
      throw new Error(
        `TestUserProvider needs a secret of at least ${TEST_USER_SECRET_MIN_CHARS} characters`,
      );
    }
    this.count = opts.count;
    this.secret = opts.secret;
    this.adminSubjects = opts.adminSubjects ?? [];
  }

  /** True when the client presented the configured secret. Constant time (see secretMatches). */
  authenticates(presentedSecret: string): boolean {
    return secretMatches(presentedSecret, this.secret);
  }

  /** 1-based, matching the subject form a user reads in `test:3`. */
  has(index: number): boolean {
    return Number.isInteger(index) && index >= 1 && index <= this.count;
  }

  principalFor(index: number): Principal {
    if (!this.has(index)) {
      throw new CpError('invalid_request', `index must be a whole number in 1..${this.count}`);
    }
    const subject = testSubject(index);
    return {
      subject,
      displayName: `Test User ${index}`,
      roles: rolesFor(subject, this.adminSubjects),
    };
  }

  async startDeviceAuth(): Promise<DeviceStart> {
    throw new CpError('unauthorized', 'a test user does not use the device flow');
  }

  async completeDeviceAuth(): Promise<Principal> {
    throw new CpError('unauthorized', 'a test user does not use the device flow');
  }

  rolesFor(subject: string): string[] {
    return rolesFor(subject, this.adminSubjects);
  }
}
/**
 * The charset an oidc provider's `sub` may carry, as a PATTERN (not a RegExp) so both users of
 * the grammar build from this one string and cannot drift: oidc.ts's token check and the
 * enrollment grammar below. It allows exactly what an enterprise IdP's sub carries (w3id's is an
 * email address, hence `@`; AppID's a UUID) and nothing that would break a Redis key, an audit
 * line or SH_ALLOWED_SUBJECTS: no whitespace, no control characters, and no colon -- that is the
 * provider/subject separator.
 */
export const OIDC_SUB_PATTERN = '[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}';

/**
 * Every subject form the control plane mints, across providers: `github:<numeric id>`,
 * `test:<index>` (SH_TEST_USERS, above) or `oidc:<provider sub>`. Built from the same pattern
 * oidc.ts verifies tokens against, so enrollment (SH_ALLOWED_SUBJECTS) and login can never
 * disagree about what an oidc subject is.
 */
export const SUBJECT_RE = new RegExp(`^(?:github:[0-9]+|test:[0-9]+|oidc:${OIDC_SUB_PATTERN})$`);

/**
 * The subjects the members, owner and quota routes accept (adapted to #701): a person's
 * login from either real provider, `github:<numeric id>` or `oidc:<provider sub>`. Never `test:<n>`:
 * a synthetic test user is enrolled by SH_TEST_USERS, not by the API, and the sandbox profile refuses
 * one outright. Built from the same pattern as SUBJECT_RE, so the two cannot drift.
 */
export const MEMBER_SUBJECT_RE = new RegExp(`^(?:github:[0-9]+|oidc:${OIDC_SUB_PATTERN})$`);

/** The member grammar as a reader sees it, for refusals and help texts. */
export const MEMBER_SUBJECT_FORMS = 'github:<numeric id> or oidc:<provider sub>';

export function adminSubjectsFromEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function rolesFor(subject: string, adminSubjects: string[]): string[] {
  return adminSubjects.includes(subject) ? ['admin'] : [];
}

const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
/** No `repo` or `user` scope: MU1 needs the numeric id and a display name, nothing more. */
const SCOPE = 'read:user';

export class GithubOAuthProvider implements IdentityProvider {
  private readonly clientId: string;
  private readonly adminSubjects: string[];
  private readonly fetchImpl: FetchLike;
  private readonly oauthBase: string;
  private readonly apiBase: string;

  constructor(opts: {
    clientId: string;
    adminSubjects?: string[];
    fetch?: FetchLike;
    oauthBase?: string;
    apiBase?: string;
  }) {
    if (!opts.clientId) {
      throw new Error('SH_GITHUB_CLIENT_ID is required for the github-oauth identity provider');
    }
    this.clientId = opts.clientId;
    this.adminSubjects = opts.adminSubjects ?? [];
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.oauthBase = opts.oauthBase ?? 'https://github.com';
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
  }

  /** GitHub replies form-encoded unless asked for JSON, so the Accept header is load-bearing. */
  private async postJson(
    url: string,
    params: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, body: parseBody(await res.text(), res.status) };
  }

  async startDeviceAuth(): Promise<DeviceStart> {
    const { status, body } = await this.postJson(`${this.oauthBase}/login/device/code`, {
      client_id: this.clientId,
      scope: SCOPE,
    });
    if (typeof body.error === 'string') {
      // The two likeliest first-run failures are the operator's to fix, not the user's: the device
      // flow is OFF by default on a GitHub OAuth app (spec §5.1.1), and a mistyped client id gets a
      // bare 404 {"error":"Not Found"} that never mentions the client id. Each gets its own code and
      // the fix as the message (#405); GitHub's text stays in it so a log still greps for it. The
      // fix names only settings, never a doc path: the VM README and the kind QUICKSTART both use
      // these names, and the message is the same in every deployment.
      if (body.error === 'device_flow_disabled') {
        throw this.misconfigured(
          "the control plane's GitHub OAuth app has the device flow off (device_flow_disabled): " +
            'tick Enable Device Flow on the app',
        );
      }
      // Keyed on the status, not GitHub's text, which is not a documented error code.
      if (status === 404) {
        throw this.misconfigured(
          `GitHub knows no OAuth app with client id ${shortClientId(this.clientId)} ` +
            `(${body.error}): check SH_GITHUB_CLIENT_ID`,
        );
      }
      throw new CpError('unauthorized', `github device code failed: ${body.error}`);
    }
    if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
      throw new CpError('unauthorized', 'github device code reply had no device_code');
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri:
        typeof body.verification_uri === 'string'
          ? body.verification_uri
          : 'https://github.com/login/device',
      // A missing interval must not become 0, or a polling client hot-loops into a slow_down.
      interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 900,
    };
  }

  /**
   * Logged as well as returned: the user who sees the reply is not the operator who can fix it, so
   * the control plane's own log must carry it too.
   */
  private misconfigured(message: string): CpError {
    console.error(`[control-plane] GitHub refused the OAuth app: ${message}`);
    return new CpError('identity_provider_misconfigured', message);
  }

  async completeDeviceAuth(deviceCode: string): Promise<Principal> {
    const { body: token } = await this.postJson(`${this.oauthBase}/login/oauth/access_token`, {
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: GRANT_DEVICE_CODE,
    });
    if (typeof token.error === 'string') {
      // `slow_down` is NOT terminal -- it means "still pending, poll less often". Treating it as
      // fatal would abort a login that is perfectly live.
      if (token.error === 'authorization_pending' || token.error === 'slow_down') {
        throw new CpError('authorization_pending', `github: ${token.error}`);
      }
      // Terminal, but not a denial: the user did not approve in time. Its own code lets mocactl
      // re-issue a code rather than report a failure (#431).
      if (token.error === 'expired_token') {
        throw new CpError('device_code_expired', 'the device code expired before it was approved');
      }
      throw new CpError('unauthorized', `github device authorization failed: ${token.error}`);
    }
    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new CpError('unauthorized', 'github returned no access token');
    }

    const res = await this.fetchImpl(`${this.apiBase}/user`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'sh-control-plane',
      },
    });
    const user = parseBody(await res.text(), res.status);
    // The subject is the NUMERIC id, never the login: a login is mutable and reusable after account
    // deletion, so a login-keyed subject would let a new account inherit a departed user's sessions
    // and credentials (spec §5.1).
    if (typeof user.id !== 'number') {
      throw new CpError('unauthorized', 'github /user returned no numeric id');
    }
    const subject = `github:${user.id}`;
    // The opaque access token is used once, here, and then dropped. MU1 stores no GitHub token:
    // OAuth authenticates API CALLS while the stored credential authorizes EGRESS, and the two are
    // decoupled, so a queued or cron-fired run needs no refresh token (spec §5.5).
    return {
      subject,
      displayName:
        (typeof user.name === 'string' && user.name) ||
        (typeof user.login === 'string' ? user.login : subject),
      roles: rolesFor(subject, this.adminSubjects),
    };
  }

  rolesFor(subject: string): string[] {
    return rolesFor(subject, this.adminSubjects);
  }
}

/**
 * Enough of the client id to spot a typo, never all of it. The reply goes to an unauthenticated
 * caller, and the case it reports is a WRONG value: a pasted client secret or PAT also gets a 404.
 * Half the value at most, so a short one is not shown whole either; the length catches a truncation.
 */
export function shortClientId(clientId: string): string {
  const shown = clientId.slice(0, Math.min(6, Math.floor(clientId.length / 2)));
  const n = clientId.length;
  return `${shown}… (${n} char${n === 1 ? '' : 's'})`;
}

/** A non-JSON reply (an HTML 502 from a proxy, say) must be `unauthorized`, not a raw SyntaxError. */
function parseBody(text: string, status: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CpError('unauthorized', `github replied ${status} with a non-JSON body`);
  }
}
