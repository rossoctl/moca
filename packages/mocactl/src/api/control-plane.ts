import { ApiError, TOKEN_CODES, errorFromResponse, networkError } from './errors.js';
import { trimTrailingSlashes } from './url.js';
import type {
  ApiLogin,
  CancelledTurn,
  ConfigBundleSummary,
  ControlPlaneApi,
  CreateSessionRequest,
  CreatedSession,
  CredentialDescriptor,
  DeviceStart,
  Discovery,
  GateDecisionRequest,
  Me,
  ModelList,
  PutCredentialRequest,
  SessionPage,
  SessionSummary,
  SessionToken,
  SubmitTurnRequest,
  SubmittedTurn,
  TurnEvent,
  TurnStatus,
} from './types.js';
import { readSse } from './sse-parser.js';

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

  protected async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      auth?: boolean;
      query?: Query;
      retried?: boolean;
      signal?: AbortSignal;
      /** Overrides the JSON default; the event stream asks for `text/event-stream`. */
      accept?: string;
    } = {},
  ): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' };
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
        signal: opts.signal,
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

  protected async json<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      auth?: boolean;
      query?: Query;
      retried?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    return (await (await this.request(method, path, opts)).json()) as T;
  }

  async healthz(): Promise<void> {
    await this.request('GET', '/healthz', { auth: false });
  }

  async readyz(): Promise<void> {
    await this.request('GET', '/readyz', { auth: false });
  }

  discovery(opts: { signal?: AbortSignal } = {}): Promise<Discovery> {
    return this.json('GET', '/v1/discovery', { auth: false, signal: opts.signal });
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

  /**
   * A test-user login (ADR-0045): one request, no polling, no browser. The reply is an ordinary
   * login body, so the caller stores it exactly as it stores a device login's.
   */
  testUserToken(index: number, secret: string): Promise<ApiLogin> {
    return this.json('POST', '/v1/auth/test-token', {
      auth: false,
      body: { index, secret, ...(this.opts.label ? { label: this.opts.label } : {}) },
    });
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

  listConfigBundles(): Promise<{ bundles: ConfigBundleSummary[] }> {
    return this.json('GET', '/v1/config-bundles');
  }

  async deleteConfigBundle(digest: string): Promise<void> {
    await this.request('DELETE', `/v1/config-bundles/${encodeURIComponent(digest)}`);
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  listModels(credential?: string): Promise<ModelList> {
    return this.json('GET', '/v1/models', { query: { credential } });
  }

  listSessionModels(id: string): Promise<ModelList> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/models`);
  }

  setSessionModel(
    id: string,
    model: string | null,
  ): Promise<SessionSummary & { modelVerified?: boolean }> {
    return this.json('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { body: { model } });
  }

  async deleteSession(id: string): Promise<'deleted' | 'accepted'> {
    const res = await this.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
    return res.status === 202 ? 'accepted' : 'deleted';
  }

  mintSessionToken(id: string): Promise<SessionToken> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/token`);
  }

  submitTurn(sessionId: string, req: SubmitTurnRequest): Promise<SubmittedTurn> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, { body: req });
  }

  getTurn(
    sessionId: string,
    turnId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TurnStatus> {
    return this.json(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      opts,
    );
  }

  async getTurnArtifact(
    sessionId: string,
    turnId: string,
    kind: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    // `text()`, not `json()`: the body is the artifact's own bytes with its own content type. A
    // patch that was stored base64 because it is not valid UTF-8 comes back with replacement
    // characters here — `get` writes a text file either way, as the sync path always has.
    const res = await this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}` +
        `/artifacts/${encodeURIComponent(kind)}`,
      opts,
    );
    return await res.text();
  }

  cancelTurn(sessionId: string, turnId: string): Promise<CancelledTurn> {
    // The 202 BODY is the answer, not just the status: a running turn was only asked to stop, and a
    // caller that discarded this could not tell the user which of the two happened (#391).
    return this.json(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    );
  }

  decideGate(sessionId: string, req: GateDecisionRequest): Promise<SubmittedTurn> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/decision`, {
      body: req,
    });
  }

  /**
   * The owner-scoped event stream (#392): one `TurnEvent` per transition of the caller's own turns,
   * `since` EXCLUSIVE. Without `since` the server starts from now and replays nothing.
   *
   * The generator ends when the server closes the stream (it caps one at an hour) or the body is
   * cut short; reopen it with the last event's `cursor` to continue exactly where it stopped.
   * `onGap` fires at most once, before any event, when `since` fell out of retention: the caller has
   * a hole and must read the turns themselves rather than assume continuity.
   */
  async *streamEvents(
    opts: { since?: string; signal?: AbortSignal; onGap?: (since: string) => void } = {},
  ): AsyncGenerator<TurnEvent> {
    const res = await this.request('GET', '/v1/events', {
      accept: 'text/event-stream',
      ...(opts.since === undefined ? {} : { query: { since: opts.since } }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.body) return;
    for await (const e of readSse(res.body)) {
      if (e.event === 'turn') yield JSON.parse(e.data) as TurnEvent;
      else if (e.event === 'gap') opts.onGap?.((JSON.parse(e.data) as { since: string }).since);
    }
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
