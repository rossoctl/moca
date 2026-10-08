export interface WorkloadRequest {
  name?: string;
  sandboxes?: number;
  contextUpload?: boolean;
  /** Type of the bundle the client will upload. Defaults to `workspace`. */
  contextType?: string;
  workspace?: {
    shared?: boolean;
    size?: string;
    storageClass?: string;
    readOnly?: boolean;
  };
}

export interface WorkloadRecord {
  workloadId: string;
  contextName?: string;
  contextId?: string;
  status: 'awaiting_upload' | 'provisioning' | 'ready' | 'deleting' | 'deleted';
  replicas: number;
  readyReplicas: number;
  sandboxSelector: string;
  workspace: {
    size: string;
    accessMode: string;
    storageClass?: string;
    readOnly: boolean;
  };
  /**
   * The authenticated subject that created it, or absent for an unauthenticated create. Set by the
   * server, never by Context Service: only a caller with the same subject (or, for an unowned
   * workload, an unauthenticated caller) may read, delete or run on it.
   */
  owner?: string;
  /** Immutable content revision mounted by this workload after activation. */
  revision?: string;
  /** Trusted storage metadata. Persisted by Moca and removed from every public response. */
  attachment?: { kind: 'pvc'; claimName: string };
}

export interface ContextResource {
  name: string;
  namespace: string;
  type: string;
  status: string;
  currentRevision?: string;
  storage: {
    backend: string;
    size: string;
    accessMode: string;
    storageClass?: string;
  };
  attachment?: { kind: string; claimName: string };
}

export interface ContextAttachmentResolution {
  contextId: string;
  namespace: string;
  status: string;
  currentRevision?: string;
  attachment: { kind: string; claimName: string };
}

export interface WorkloadContextUploadCapability {
  uploadUrl: string;
  token: string;
  expiresAt: string;
  method: 'PUT';
  contentType: 'application/vnd.rossoctl.context';
  maxBytes: number;
}

export class ContextServiceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ContextServiceRequestError';
  }
}

export function contextServiceConfigured(): boolean {
  return (process.env.CONTEXT_SERVICE_URL?.trim().length ?? 0) > 0;
}

function baseUrl(): string {
  const configured = process.env.CONTEXT_SERVICE_URL?.trim();
  if (!configured) throw new Error('Context Service is not configured');
  return configured.replace(/\/$/, '');
}

function publicBaseUrl(): string {
  const configured = process.env.CONTEXT_SERVICE_PUBLIC_URL?.trim();
  if (!configured) throw new Error('CONTEXT_SERVICE_PUBLIC_URL is required for context uploads');
  return configured.replace(/\/$/, '');
}

export function contextNamespace(): string {
  return (
    process.env.CONTEXT_SERVICE_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || 'default'
  );
}

// Single-node clusters such as Kind lack ReadWriteMany storage but can share a ReadWriteOnce
// volume between Sandboxes on the same node.
export function sharedContextAccessMode(): 'ReadWriteMany' | 'ReadWriteOnce' {
  const configured = process.env.CONTEXT_SERVICE_SHARED_ACCESS_MODE?.trim();
  if (!configured) return 'ReadWriteMany';
  if (configured === 'ReadWriteMany' || configured === 'ReadWriteOnce') return configured;
  throw new Error(`Unsupported CONTEXT_SERVICE_SHARED_ACCESS_MODE '${configured}'`);
}

async function request(
  path: string,
  subject: string,
  init?: RequestInit,
  acceptedStatuses: readonly number[] = [],
): Promise<Response> {
  const configuredTimeout = Number.parseInt(process.env.CONTEXT_SERVICE_TIMEOUT_MS ?? '5000', 10);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: contextServiceHeaders(subject, init?.headers),
      signal: controller.signal,
    });
    if (response.ok || acceptedStatuses.includes(response.status)) return response;
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ContextServiceRequestError(
      response.status,
      body.error ?? 'context_service_error',
      body.message ?? `Context Service returned ${response.status}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function contextServiceHeaders(subject: string, provided?: HeadersInit): Record<string, string> {
  const token = process.env.CONTEXT_SERVICE_TOKEN?.trim();
  if (!token) throw new Error('CONTEXT_SERVICE_TOKEN is required');
  return {
    ...Object.fromEntries(new Headers(provided).entries()),
    authorization: `Bearer ${token}`,
    'x-context-subject': subject,
  };
}

function delegatedContextSubject(subject: string | null, contextName: string): string {
  return subject === null ? `workload:${contextName}` : `user:${subject}`;
}

function contextPath(contextId: string): string {
  return `/v1/namespaces/${encodeURIComponent(contextNamespace())}/contexts/${encodeURIComponent(contextId)}`;
}

export async function createContext(
  contextName: string,
  spec: WorkloadRequest,
  subject: string | null,
): Promise<ContextAttachmentResolution> {
  const shared = spec.workspace?.shared === true;
  const storage = {
    backend: 'pvc',
    size: spec.workspace?.size ?? '1Gi',
    accessMode: shared ? sharedContextAccessMode() : 'ReadWriteOnce',
    ...(spec.workspace?.storageClass ? { storageClass: spec.workspace.storageClass } : {}),
  };
  const response = await request(
    '/internal/v1/contexts',
    delegatedContextSubject(subject, contextName),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: contextName,
        namespace: contextNamespace(),
        type: spec.contextType ?? 'workspace',
        storage,
      }),
    },
  );
  return (await response.json()) as ContextAttachmentResolution;
}

export async function getContext(
  contextName: string,
  subject: string | null,
): Promise<ContextAttachmentResolution> {
  const path = `/internal${contextPath(contextName)}/attachment`;
  const response = await request(path, delegatedContextSubject(subject, contextName));
  return (await response.json()) as ContextAttachmentResolution;
}

export async function deleteContext(contextName: string, subject: string | null): Promise<void> {
  await request(
    `/internal${contextPath(contextName)}`,
    delegatedContextSubject(subject, contextName),
    { method: 'DELETE' },
    [404],
  );
}

export async function freezeContext(
  contextName: string,
  revision: string,
  subject: string | null,
): Promise<ContextAttachmentResolution> {
  const response = await request(
    `/internal${contextPath(contextName)}/freeze`,
    delegatedContextSubject(subject, contextName),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision }),
    },
  );
  return (await response.json()) as ContextAttachmentResolution;
}

export async function createWorkloadContextUpload(
  contextName: string,
  subject: string | null,
): Promise<WorkloadContextUploadCapability> {
  const response = await request(
    `${contextPath(contextName)}/upload-capabilities`,
    delegatedContextSubject(subject, contextName),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
  );
  const capability = (await response.json()) as Partial<WorkloadContextUploadCapability>;
  const uploadId =
    typeof capability.uploadUrl === 'string'
      ? capability.uploadUrl.slice('/v1/uploads/'.length)
      : '';
  if (
    typeof capability.uploadUrl !== 'string' ||
    !capability.uploadUrl.startsWith('/v1/uploads/') ||
    !/^[A-Za-z0-9_-]+$/.test(uploadId) ||
    typeof capability.token !== 'string' ||
    capability.token.length === 0 ||
    typeof capability.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(capability.expiresAt)) ||
    capability.method !== 'PUT' ||
    capability.contentType !== 'application/vnd.rossoctl.context' ||
    typeof capability.maxBytes !== 'number' ||
    !Number.isSafeInteger(capability.maxBytes) ||
    capability.maxBytes <= 0
  ) {
    throw new Error('Context Service returned an invalid upload capability');
  }
  const publicBase = new URL(`${publicBaseUrl()}/`);
  if (
    !['http:', 'https:'].includes(publicBase.protocol) ||
    publicBase.username ||
    publicBase.password
  ) {
    throw new Error('CONTEXT_SERVICE_PUBLIC_URL must be an HTTP(S) URL without credentials');
  }
  const uploadUrl = new URL(capability.uploadUrl.replace(/^\/+/, ''), publicBase);
  return {
    uploadUrl: uploadUrl.toString(),
    token: capability.token,
    expiresAt: capability.expiresAt,
    method: capability.method,
    contentType: capability.contentType,
    maxBytes: capability.maxBytes,
  };
}
