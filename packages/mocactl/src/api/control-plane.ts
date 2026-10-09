import { ApiError, TOKEN_CODES, errorFromResponse, networkError } from './errors.js';
import { trimTrailingSlashes } from './url.js';
import type {
  ApiLogin,
  ControlPlaneApi,
  CreateSessionRequest,
  CreatedSession,
  CredentialDescriptor,
  DeviceStart,
  Discovery,
  Me,
  PutCredentialRequest,
  SessionPage,
  SessionSummary,
  SessionToken,
} from './types.js';

type Query = Record<string, string | number | undefined>;

export interface ControlPlaneClientOptions {
  /**
   * Called once when an authenticated route answers 401 with a token_* code; resolving true retries
   * the request with whatever getToken returns then. Runtime wires it to a forced refresh (B14), so a
   * TUI left open past the 15-minute API token carries on.
   */
  onTokenRejected?: () => Promise<boolean>;
  /** Sent as the device-flow `label`; the control plane shows it back and never trusts it. */
  label?: string;
}

export class ControlPlaneClient implements ControlPlaneApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly getToken: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: ControlPlaneClientOptions = {},
  ) {
    this.base = trimTrailingSlashes(baseUrl);
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean; query?: Query; retried?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      const token = this.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      throw networkError('control-plane', err);
    }
    if (!res.ok) {
      const err = await errorFromResponse('control-plane', res);
      // One retry, only for an authenticated call whose token was the problem: a refresh cannot fix
      // anything else, and a second 401 means the new token is no better.
      if (
        res.status === 401 &&
        opts.auth !== false &&
        !opts.retried &&
        TOKEN_CODES.has(err.code) &&
        this.opts.onTokenRejected &&
        (await this.opts.onTokenRejected())
      ) {
        return this.request(method, path, { ...opts, retried: true });
      }
      throw err;
    }
    return res;
  }

  private async json<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; auth?: boolean; query?: Query; retried?: boolean },
  ): Promise<T> {
    return (await (await this.request(method, path, opts)).json()) as T;
  }

  async healthz(): Promise<void> {
    await this.request('GET', '/healthz', { auth: false });
  }

  async readyz(): Promise<void> {
    await this.request('GET', '/readyz', { auth: false });
  }

  discovery(): Promise<Discovery> {
    return this.json('GET', '/v1/discovery', { auth: false });
  }

  startDeviceAuth(): Promise<DeviceStart> {
    return this.json('POST', '/v1/auth/device', { auth: false });
  }

  async pollDeviceAuth(deviceCode: string): Promise<ApiLogin | 'pending' | 'expired'> {
    try {
      return await this.json<ApiLogin>('POST', '/v1/auth/device/token', {
        auth: false,
        body: { deviceCode, ...(this.opts.label ? { label: this.opts.label } : {}) },
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'authorization_pending') return 'pending';
      if (err instanceof ApiError && err.code === 'device_code_expired') return 'expired';
      throw err;
    }
  }

  refreshAuth(refreshToken: string): Promise<ApiLogin> {
    return this.json('POST', '/v1/auth/token', {
      auth: false,
      body: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
  }

  async revokeAuth(refreshToken: string): Promise<void> {
    await this.request('POST', '/v1/auth/revoke', { auth: false, body: { token: refreshToken } });
  }

  async revokeAllAuth(): Promise<number> {
    return (await this.json<{ revoked: number }>('POST', '/v1/auth/revoke-all')).revoked;
  }

  me(): Promise<Me> {
    return this.json('GET', '/v1/me');
  }

  listSessions(opts: { limit?: number; cursor?: number } = {}): Promise<SessionPage> {
    return this.json('GET', '/v1/sessions', { query: { limit: opts.limit, cursor: opts.cursor } });
  }

  createSession(req: CreateSessionRequest): Promise<CreatedSession> {
    return this.json('POST', '/v1/sessions', { body: req });
  }

  putConfigBundle(req: {
    digest: string;
    tar: string;
  }): Promise<{ digest: string; uploaded: boolean }> {
    return this.json('POST', '/v1/config-bundles', { body: req });
  }

  async deleteConfigBundle(digest: string): Promise<void> {
    await this.request('DELETE', `/v1/config-bundles/${encodeURIComponent(digest)}`);
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  async deleteSession(id: string): Promise<'deleted' | 'accepted'> {
    const res = await this.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
    return res.status === 202 ? 'accepted' : 'deleted';
  }

  mintSessionToken(id: string): Promise<SessionToken> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/token`);
  }

  async listCredentials(): Promise<CredentialDescriptor[]> {
    return (await this.json<{ credentials: CredentialDescriptor[] }>('GET', '/v1/credentials'))
      .credentials;
  }

  async putCredential(name: string, req: PutCredentialRequest): Promise<void> {
    await this.request('PUT', `/v1/credentials/${encodeURIComponent(name)}`, { body: req });
  }

  async deleteCredential(name: string): Promise<void> {
    await this.request('DELETE', `/v1/credentials/${encodeURIComponent(name)}`);
  }
}
