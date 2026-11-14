import type { TurnFrame } from './frames.js';

// Mirrors docs/api/openapi.yaml; test/contract.test.ts holds the two together (spec §7.4).

/** A model an inference credential reaches (GET /v1/models); limits are absent when unreported. */
export interface ModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export interface ModelList {
  credential: string;
  models: ModelEntry[];
}

export interface DeviceStart {
  deviceCode: string;
  /**
   * The code the user confirms the login with: typed at the provider (github) or on the control
   * plane's confirmation page (oidc) -- see DeviceStart.userCode in the control plane.
   */
  userCode?: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface ApiLogin {
  token: string;
  subject: string;
  displayName?: string;
  roles?: string[];
  expiresAt: number;
  /** The single-use refresh token behind this login (B14); absent from an older control plane. */
  refreshToken?: string;
  /** Epoch seconds: the login's absolute limit, however often it is refreshed. */
  refreshExpiresAt?: number;
}

export interface Me {
  subject: string;
  tenant: string;
  roles: string[];
}

export interface SessionSummary {
  sessionId: string;
  owner: string;
  tenant: string;
  createdAt: number;
  state: 'active' | 'deleting';
  lastTurnAt: number | null;
  turns: number;
  configRef?: string | null;
  /**
   * The sandbox tier the session runs in (P6.3); null when the deployment declares no tiers, absent
   * before P6.3.
   */
  sandboxTier?: string | null;
  /** The session's sandbox template; null for none on a templated deployment, absent elsewhere. */
  sandboxTemplate?: string | null;
  /** The session's model; null on the deployment default, absent before per-session models. */
  model?: string | null;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: number | null;
}

export interface CreateSessionRequest {
  credentials?: { inference?: string };
  /** A promoted config bundle digest; fixed for the session's life (ADR-0038). */
  configRef?: string;
  sandbox?: { tier?: string; template?: string; activate?: boolean };
  /** A model id the credential lists; fixed until switched with /model. */
  model?: string;
}

export interface SessionToken {
  token: string;
  expiresAt: number;
}

export interface CreatedSession extends SessionToken {
  sessionId: string;
  model?: string;
  modelVerified?: boolean;
}

/**
 * An async turn submission (ADR-0047 §4.1). `async` is required and must be `true`: the async path
 * is REQUESTED, never inferred from which payload field is set.
 */
export interface SubmitTurnRequest {
  async: true;
  kind?: string;
  prompt?: string;
  item?: Record<string, unknown>;
  problemStatement?: string;
  repoUrl?: string;
  ref?: string;
  /**
   * Printable ASCII, 1-128 chars. DEFAULTS TO THE SESSION ID server-side, so a session holds at most
   * one async turn in flight and a resubmission returns the same turn rather than queueing a second.
   * Set it only to run two async turns on one session deliberately.
   */
  idempotencyKey?: string;
  caps?: { tokens?: number; costUsd?: number; wallClock?: number };
}

export interface SubmittedTurn {
  sessionId: string;
  turnId: string;
}

/** `queued` and `running` are the only non-terminal states; `lost` is reaper-written. */
export type AsyncTurnState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'responded'
  | 'done'
  | 'solved'
  | 'failed'
  | 'cancelled'
  | 'lost';

export interface TurnStatus {
  turnId: string;
  state: AsyncTurnState;
  /**
   * Deliveries so far, DESCRIPTIVE only. The server's queue holds the only authoritative delivery
   * count, so do not compute "the server gave up" from this -- read `state: 'failed' | 'lost'`.
   */
  attempts: number;
  /** Absent until the leaf writes one. `status: 'aborted'` has no state of its own; it reads `failed`. */
  result?: {
    status: string;
    patch?: string;
    text?: string;
    gate?: Record<string, unknown>;
    reason?: string;
  };
}

export type CredentialConsumer = 'inference' | 'sandbox-egress' | 'control-plane';

/** Where a credential goes on the wire; `sandbox-egress` may hold a list of 1-4. */
export interface CredentialBinding {
  header: string;
  format: string;
}

export interface CredentialDescriptor {
  name: string;
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding: CredentialBinding | CredentialBinding[];
  endpoint?: string | null;
}

export interface PutCredentialRequest {
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding?: CredentialBinding | CredentialBinding[];
  endpoint?: string | null;
  secret: Record<string, string>;
}

/** GET /v1/discovery: where the rest of the deployment is, readable before login. */
export interface Discovery {
  harnessUrl: string | null;
  /** P6.3. Optional so a pre-P6.3 control plane, which omits it, still parses. */
  sandboxTiers?: { names: string[]; default: string } | null;
  /** Session templates (session-templates spec §3.3). Absent when the deployment declares none. */
  sandboxTemplates?: { id: string; description: string; tools: string[] }[] | null;
  /** The control plane's version; null/absent when it predates advertising one. */
  version?: string | null;
}

export interface ControlPlaneApi {
  healthz(): Promise<void>;
  readyz(): Promise<void>;
  discovery(opts?: { signal?: AbortSignal }): Promise<Discovery>;
  startDeviceAuth(): Promise<DeviceStart>;
  /** 'pending' until approved; 'expired' once the code lapsed unapproved (start a new one). */
  pollDeviceAuth(deviceCode: string): Promise<ApiLogin | 'pending' | 'expired'>;
  /** ADR-0045: a test-user login, gated by the control plane's shared secret. */
  testUserToken(index: number, secret: string): Promise<ApiLogin>;
  /** The next API token and refresh token. ApiError `invalid_grant` means "log in again". */
  refreshAuth(refreshToken: string): Promise<ApiLogin>;
  /** End the login this refresh token belongs to (RFC 7009: answers alike for an unknown one). */
  revokeAuth(refreshToken: string): Promise<void>;
  /** End every login of the caller; how many there were. Needs a valid API token. */
  revokeAllAuth(): Promise<number>;
  me(): Promise<Me>;
  listSessions(opts?: { limit?: number; cursor?: number }): Promise<SessionPage>;
  createSession(req: CreateSessionRequest): Promise<CreatedSession>;
  getSession(id: string): Promise<SessionSummary>;
  /** The models a credential reaches; the credential a new session would use when omitted. */
  listModels(credential?: string): Promise<ModelList>;
  listSessionModels(id: string): Promise<ModelList>;
  /** Switch a session's model; null returns it to the deployment default. */
  setSessionModel(
    id: string,
    model: string | null,
  ): Promise<SessionSummary & { modelVerified?: boolean }>;
  deleteSession(id: string): Promise<'deleted' | 'accepted'>;
  mintSessionToken(id: string): Promise<SessionToken>;
  listCredentials(): Promise<CredentialDescriptor[]>;
  putCredential(name: string, req: PutCredentialRequest): Promise<void>;
  deleteCredential(name: string): Promise<void>;
  putConfigBundle(req: {
    digest: string;
    tar: string;
  }): Promise<{ digest: string; uploaded: boolean }>;
  /** The caller's own live bundles, newest first. Unpaged: the byte budget bounds how many. */
  listConfigBundles(): Promise<{ bundles: ConfigBundleSummary[] }>;
  /** Only the subject the digest is charged to, or an admin, may delete it. */
  deleteConfigBundle(digest: string): Promise<void>;
  /**
   * Submit a turn asynchronously; answers as soon as it is queued (ADR-0047 §4.1). Throws ApiError
   * `async_quota_exhausted` (429) when the caller already holds the deployment's limit of
   * non-terminal turns -- back off rather than retrying at once.
   */
  submitTurn(sessionId: string, req: SubmitTurnRequest): Promise<SubmittedTurn>;
  /** An async turn's state, and its result once written. */
  getTurn(sessionId: string, turnId: string): Promise<TurnStatus>;
  /**
   * Cancel a QUEUED async turn. Throws ApiError `turn_not_cancellable` for a running or finished
   * one. Distinct from `HarnessApi.cancelTurn` below: that one interrupts a streaming turn over its
   * own connection; this one removes a queued async turn from the queue. Neither can do the other's
   * job, which is exactly why DELETE answers 409 for a running async turn.
   */
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
}

/** One of the caller's stored config bundles (rossoctl/moca#559). */
export interface ConfigBundleSummary {
  digest: string;
  /** What the bundle is CHARGED, not the size of the tar that was uploaded. */
  bytes: number;
  /** null for a bundle stored before the server recorded one. */
  promotedAt: number | null;
  expiresAt: number;
}

export interface StreamTurnArgs {
  sessionId: string;
  prompt: string;
  token: string;
  signal?: AbortSignal;
  /** Ask for a turn that outlives this connection (turn-reattach spec §4.1). */
  detachable?: boolean;
  /** Called with each frame's SSE id just before the frame is yielded. */
  onEventId?: (id: string) => void;
}

export interface AttachArgs {
  sessionId: string;
  token: string;
  lastEventId?: string;
  signal?: AbortSignal;
  onEventId?: (id: string) => void;
}

export interface CancelTurnArgs {
  sessionId: string;
  turnId?: string;
  token: string;
  signal?: AbortSignal;
}

/** GET /health on the harness: what it can tell about itself. */
export interface HealthReport {
  /** From the X-Moca-Version header; absent for an old harness that sent none. */
  version?: string;
}

export interface HarnessApi {
  /** The base URL turns go to; for a discovered harness this asks the control plane first. */
  baseUrl(): Promise<string>;
  health(opts?: { signal?: AbortSignal }): Promise<HealthReport>;
  streamTurn(args: StreamTurnArgs): AsyncGenerator<TurnFrame>;
  probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'>;
  /** Replays the session's current turn after lastEventId, then follows it (spec §4.2). */
  attach(args: AttachArgs): AsyncGenerator<TurnFrame>;
  /**
   * Cancels the session's turn (spec §4.3). Resolves on 202 with the turn the server named, which
   * for a turnId-less cancel may be an earlier, already-ended turn. A fake may resolve void.
   */
  cancelTurn(args: CancelTurnArgs): Promise<CancelTurnResult | void>;
}

export interface CancelTurnResult {
  turnId?: string;
  /** 'requested': a running turn was asked to stop; 'ended': it had already ended. Older servers omit it. */
  outcome?: 'requested' | 'ended';
}
