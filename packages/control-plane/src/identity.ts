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
  userCode: string;
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
}

/** Structural subset of fetch, so tests inject a scripted transport and no test touches the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

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
