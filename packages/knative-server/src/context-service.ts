/**
 * Client for Context Service's trusted, storage-only API (rossoctl/context-service#52, upload and
 * freeze for Moca). Moca calls it with its service bearer and names the user it acts for in
 * `X-Context-Subject`, so Context Service records that user as the Context's owner.
 */

export const CONTEXT_BUNDLE_TYPE = 'application/vnd.rossoctl.context';

/** Context Service's trusted view of a Context. It carries no storage attachment. */
export interface TrustedContext {
  contextId: string;
  name: string;
  namespace: string;
  type: string;
  status: string;
  currentRevision?: string;
  frozenRevision?: string;
}

/** A one-time grant the client uses to PUT its bundle straight to Context Service. */
export interface UploadGrant {
  uploadUrl: string;
  token: string;
  expiresAt: string;
  method: 'PUT';
  contentType: typeof CONTEXT_BUNDLE_TYPE;
  maxBytes: number;
}

export interface ContextStorage {
  size: string;
  storageClass?: string;
}

/**
 * A failure that originated at Context Service: unreachable, an error status, or a reply Moca
 * refuses. Local misconfiguration and Redis failures are plain errors.
 */
export class ContextServiceError extends Error {
  constructor(
    message: string,
    /** The HTTP status Context Service answered, when it answered. */
    readonly status?: number,
    /** Context Service's `error` code, when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ContextServiceError';
  }
}

export function contextServiceConfigured(): boolean {
  return (process.env.CONTEXT_SERVICE_URL?.trim().length ?? 0) > 0;
}

export function contextNamespace(): string {
  return (
    process.env.CONTEXT_SERVICE_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || 'default'
  );
}

function serviceToken(): string {
  const token = process.env.CONTEXT_SERVICE_TOKEN?.trim();
  if (!token) throw new Error('CONTEXT_SERVICE_TOKEN is required');
  return token;
}

/**
 * The base URL clients upload to. It must be HTTPS, because the grant's token travels with the
 * upload; plain HTTP is allowed on loopback only, for local development.
 */
export function publicBaseUrl(): URL {
  const configured = process.env.CONTEXT_SERVICE_PUBLIC_URL?.trim();
  if (!configured) throw new Error('CONTEXT_SERVICE_PUBLIC_URL is required');
  const url = new URL(`${configured.replace(/\/+$/, '')}/`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CONTEXT_SERVICE_PUBLIC_URL must be an HTTP(S) URL without credentials');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('CONTEXT_SERVICE_PUBLIC_URL must use HTTPS except on loopback');
  }
  return url;
}

/** Throws when a setting the workload routes need is missing or unsafe. */
export function assertContextServiceSettings(): void {
  serviceToken();
  publicBaseUrl();
}

function timeoutMs(): number {
  const configured = Number.parseInt(process.env.CONTEXT_SERVICE_TIMEOUT_MS ?? '5000', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 5000;
}

async function request(
  path: string,
  owner: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
  acceptedStatuses: readonly number[] = [],
): Promise<Response> {
  const base = process.env.CONTEXT_SERVICE_URL?.trim().replace(/\/+$/, '');
  if (!base) throw new Error('CONTEXT_SERVICE_URL is required');
  const headers: Record<string, string> = {
    authorization: `Bearer ${serviceToken()}`,
    'x-context-subject': `user:${owner}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs()),
  }).catch((err: unknown) => {
    throw new ContextServiceError(`Context Service is unreachable: ${String(err)}`);
  });
  if (response.ok || acceptedStatuses.includes(response.status)) return response;
  const failure = (await response.json().catch(() => ({}))) as { error?: unknown };
  const code = typeof failure.error === 'string' ? failure.error : undefined;
  throw new ContextServiceError(
    `Context Service answered ${response.status}${code ? ` ${code}` : ''}`,
    response.status,
    code,
  );
}

async function trustedContext(response: Response): Promise<TrustedContext> {
  const context = (await response.json().catch(() => null)) as Partial<TrustedContext> | null;
  if (
    !context ||
    typeof context.contextId !== 'string' ||
    !context.contextId ||
    context.namespace !== contextNamespace()
  ) {
    throw new ContextServiceError('Context Service returned an invalid Context');
  }
  return context as TrustedContext;
}

const contextPath = (name: string) =>
  `/namespaces/${encodeURIComponent(contextNamespace())}/contexts/${encodeURIComponent(name)}`;

export async function createContext(
  name: string,
  type: string,
  storage: ContextStorage,
  owner: string,
): Promise<TrustedContext> {
  const response = await request('/internal/v1/contexts', owner, 'POST', {
    name,
    namespace: contextNamespace(),
    type,
    storage: { backend: 'pvc', accessMode: 'ReadWriteOnce', ...storage },
  });
  return trustedContext(response);
}

/** Pin `revision`. Context Service answers 409 unless it is the Context's current revision. */
export async function freezeContext(
  name: string,
  revision: string,
  owner: string,
): Promise<TrustedContext> {
  const response = await request(`/internal/v1${contextPath(name)}/freeze`, owner, 'POST', {
    revision,
  });
  return trustedContext(response);
}

/** Delete the Context. One that is already gone counts as deleted. */
export async function deleteContext(name: string, owner: string): Promise<void> {
  await request(`/internal/v1${contextPath(name)}`, owner, 'DELETE', undefined, [404]);
}

export async function createUploadGrant(name: string, owner: string): Promise<UploadGrant> {
  // Checked before Context Service issues a grant that could not be used.
  const publicBase = publicBaseUrl();
  const response = await request(`/v1${contextPath(name)}/upload-capabilities`, owner, 'POST');
  const grant = (await response.json().catch(() => null)) as Partial<UploadGrant> | null;
  if (
    !grant ||
    typeof grant.uploadUrl !== 'string' ||
    !/^\/v1\/uploads\/[A-Za-z0-9_-]+$/.test(grant.uploadUrl) ||
    typeof grant.token !== 'string' ||
    !grant.token ||
    typeof grant.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(grant.expiresAt)) ||
    grant.method !== 'PUT' ||
    grant.contentType !== CONTEXT_BUNDLE_TYPE ||
    !Number.isSafeInteger(grant.maxBytes) ||
    (grant.maxBytes as number) <= 0
  ) {
    throw new ContextServiceError('Context Service returned an invalid upload grant');
  }
  return {
    uploadUrl: new URL(grant.uploadUrl.slice(1), publicBase).toString(),
    token: grant.token,
    expiresAt: grant.expiresAt,
    method: grant.method,
    contentType: grant.contentType,
    maxBytes: grant.maxBytes as number,
  };
}
