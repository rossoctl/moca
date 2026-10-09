import type { TurnFrame } from './frames.js';

// Mirrors docs/api/openapi.yaml; test/contract.test.ts holds the two together (spec §7.4).
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
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
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: number | null;
}

export interface CreateSessionRequest {
  credentials?: { inference?: string };
  /** A promoted config bundle digest; fixed for the session's life (ADR-0038). */
  configRef?: string;
  sandbox?: { tier?: string };
}

export interface SessionToken {
  token: string;
  expiresAt: number;
}

export interface CreatedSession extends SessionToken {
  sessionId: string;
}

export type CredentialConsumer = 'inference' | 'sandbox-egress' | 'control-plane';

export interface CredentialDescriptor {
  name: string;
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding: { header: string; format: string };
  endpoint?: string | null;
}

export interface PutCredentialRequest {
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding?: { header: string; format: string };
  endpoint?: string | null;
  secret: Record<string, string>;
}

/** GET /v1/discovery: where the rest of the deployment is, readable before login. */
export interface Discovery {
  harnessUrl: string | null;
  /** P6.3. Optional so a pre-P6.3 control plane, which omits it, still parses. */
  sandboxTiers?: { names: string[]; default: string } | null;
}

export interface ControlPlaneApi {
  healthz(): Promise<void>;
  readyz(): Promise<void>;
  discovery(): Promise<Discovery>;
  startDeviceAuth(): Promise<DeviceStart>;
  /** 'pending' until approved; 'expired' once the code lapsed unapproved (start a new one). */
  pollDeviceAuth(deviceCode: string): Promise<ApiLogin | 'pending' | 'expired'>;
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
  deleteSession(id: string): Promise<'deleted' | 'accepted'>;
  mintSessionToken(id: string): Promise<SessionToken>;
  listCredentials(): Promise<CredentialDescriptor[]>;
  putCredential(name: string, req: PutCredentialRequest): Promise<void>;
  deleteCredential(name: string): Promise<void>;
  putConfigBundle(req: {
    digest: string;
    tar: string;
  }): Promise<{ digest: string; uploaded: boolean }>;
  /** Only the subject the digest is charged to, or an admin, may delete it. */
  deleteConfigBundle(digest: string): Promise<void>;
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

export interface HarnessApi {
  /** The base URL turns go to; for a discovered harness this asks the control plane first. */
  baseUrl(): Promise<string>;
  health(): Promise<void>;
  streamTurn(args: StreamTurnArgs): AsyncGenerator<TurnFrame>;
  probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'>;
  /** Replays the session's current turn after lastEventId, then follows it (spec §4.2). */
  attach(args: AttachArgs): AsyncGenerator<TurnFrame>;
  cancelTurn(args: CancelTurnArgs): Promise<void>;
}
