import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

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
  /**
   * Whether the call never got an HTTP response at all (network error, timeout, connection
   * refused). Set only in `request()`'s fetch-catch; semantic failures on an answered reply
   * (`'Context Service returned an invalid …'`, bundle validation, etc.) leave it `false`, so a
   * future `retryWhileUnreachable` caller cannot accidentally retry a reply the server already
   * decided on.
   */
  readonly unreachable: boolean;

  constructor(
    message: string,
    /** The HTTP status Context Service answered, when it answered. */
    readonly status?: number,
    /** Context Service's `error` code, when it sent one. */
    readonly code?: string,
    options: { unreachable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ContextServiceError';
    this.unreachable = options.unreachable ?? false;
  }

  /** True when the Context Service call never got a response (vs got an error response). */
  isUnreachable(): boolean {
    return this.unreachable;
  }
}

const retrySleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry `fn` on `ContextServiceError` that marks Context Service as unreachable (no HTTP response
 * ever arrived). An error response from Context Service, even 5xx with a code, is not retried: it
 * means the server is reachable and the problem is semantic. Caller-visible errors (bad input,
 * local misconfiguration) are not retried either.
 */
export async function retryWhileUnreachable<T>(
  fn: () => Promise<T>,
  { attempts, backoffMs }: { attempts: number; backoffMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ContextServiceError) || !err.isUnreachable() || i === attempts - 1) {
        throw err;
      }
      await retrySleep(backoffMs);
    }
  }
  // Loop always returns or throws; this is unreachable but keeps TypeScript happy.
  throw lastErr;
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
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  acceptedStatuses: readonly number[] = [],
  timeout = timeoutMs(),
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
    signal: AbortSignal.timeout(timeout),
  }).catch((err: unknown) => {
    throw new ContextServiceError(
      `Context Service is unreachable: ${String(err)}`,
      undefined,
      undefined,
      { unreachable: true },
    );
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

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Frozen bundles Moca has downloaded, least recently used first, within
 * `MOCA_CONTEXT_BUNDLE_CACHE_BYTES`. A frozen revision never changes, so an entry never goes stale.
 * Keyed by owner, Context and revision, so one user's download never serves another user.
 */
const bundleCache = new Map<string, Buffer>();
const bundleDownloads = new Map<string, Promise<Buffer>>();
let bundleCacheBytes = 0;

function cacheBundle(key: string, bundle: Buffer): void {
  const parsed = Number.parseInt(process.env.MOCA_CONTEXT_BUNDLE_CACHE_BYTES ?? '', 10);
  const limit = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 64 * 1024 * 1024;
  if (bundle.length > limit || bundleCache.has(key)) return;
  for (const [oldest, entry] of bundleCache) {
    if (bundleCacheBytes + bundle.length <= limit) break;
    bundleCache.delete(oldest);
    bundleCacheBytes -= entry.length;
  }
  bundleCache.set(key, bundle);
  bundleCacheBytes += bundle.length;
}

/** Drops `owner`'s cached bundles of Context `name`, every revision. Called when it is deleted. */
export function evictContextBundles(name: string, owner: string): void {
  const prefix = `${owner}\0${name}\0`;
  for (const [key, entry] of bundleCache) {
    if (!key.startsWith(prefix)) continue;
    bundleCache.delete(key);
    bundleCacheBytes -= entry.length;
  }
}

/** Empties the bundle cache. For tests. */
export function clearContextBundleCache(): void {
  bundleCache.clear();
  bundleCacheBytes = 0;
}

/**
 * Bytes the downloads in flight may buffer, process-wide, within
 * `MOCA_CONTEXT_DOWNLOAD_BUDGET_BYTES`. Bundles over the cache limit are downloaded again for every
 * run, so without it N concurrent runs of a large workload would buffer N bundles at once.
 */
let downloadBytesInFlight = 0;
const downloadBudgetWaiters = new Set<() => void>();

/**
 * Reserves `bytes` of the download budget, waiting until `deadline` (epoch ms) for other downloads
 * to release theirs. Resolves to the function that releases the reservation.
 */
async function reserveDownloadBytes(bytes: number, deadline: number): Promise<() => void> {
  const budget = positiveIntEnv('MOCA_CONTEXT_DOWNLOAD_BUDGET_BYTES', 512 * 1024 * 1024);
  if (bytes > budget) {
    throw new ContextServiceError(
      'Context Service bundle exceeds MOCA_CONTEXT_DOWNLOAD_BUDGET_BYTES',
    );
  }
  while (downloadBytesInFlight + bytes > budget) {
    const wait = deadline - Date.now();
    if (wait <= 0) {
      throw new ContextServiceError(
        'no MOCA_CONTEXT_DOWNLOAD_BUDGET_BYTES came free within MOCA_CONTEXT_EXPORT_TIMEOUT_MS',
      );
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        downloadBudgetWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, wait);
      downloadBudgetWaiters.add(wake);
    });
  }
  downloadBytesInFlight += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    downloadBytesInFlight -= bytes;
    // Every waiter rechecks; those that still do not fit wait again.
    for (const wake of [...downloadBudgetWaiters]) wake();
  };
}

/** Bytes the downloads in flight have reserved. For tests. */
export function contextDownloadBytesInFlight(): number {
  return downloadBytesInFlight;
}

/**
 * Context Service streams the export after its 200 header, so an export that fails midway ends the
 * response cleanly with a short body. Only a complete gzip stream is cached or delivered, and only
 * one that inflates to at most `maxExpanded` bytes: the sandbox extracts it onto a disk that several
 * users share, so a small bundle that inflates without bound would fill it for everyone.
 */
async function assertCompleteGzip(bundle: Buffer, maxExpanded: number): Promise<void> {
  let expanded = 0;
  let tooLarge = false;
  try {
    await pipeline(
      Readable.from([bundle]),
      createGunzip(),
      new Writable({
        write: (chunk: Buffer, _encoding, done) => {
          expanded += chunk.length;
          if (expanded <= maxExpanded) return done();
          tooLarge = true;
          done(new Error('expanded size limit'));
        },
      }),
    );
  } catch {
    throw new ContextServiceError(
      tooLarge
        ? 'Context Service bundle expands past MOCA_CONTEXT_BUNDLE_MAX_EXPANDED_BYTES'
        : 'Context Service returned a truncated or invalid bundle',
    );
  }
}

async function fetchBundle(name: string, revision: string, owner: string): Promise<Buffer> {
  const maxBytes = positiveIntEnv('MOCA_CONTEXT_BUNDLE_MAX_BYTES', 256 * 1024 * 1024);
  // Context Service limits an upload's files to 1 GiB. This counts the inflated tar stream, headers
  // and padding included, so it leaves headroom: a bundle Context Service accepted is never refused.
  const maxExpanded = positiveIntEnv('MOCA_CONTEXT_BUNDLE_MAX_EXPANDED_BYTES', 1280 * 1024 * 1024);
  const timeout = positiveIntEnv('MOCA_CONTEXT_EXPORT_TIMEOUT_MS', 300_000);
  const deadline = Date.now() + timeout;
  const tooLarge = () =>
    new ContextServiceError('Context Service bundle exceeds MOCA_CONTEXT_BUNDLE_MAX_BYTES');
  // The timeout covers the body as well as the headers.
  const response = await request(
    `/internal/v1${contextPath(name)}/revisions/${revision}/bundle`,
    owner,
    'GET',
    undefined,
    [],
    timeout,
  );
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== CONTEXT_BUNDLE_TYPE) {
    await response.body?.cancel().catch(() => {});
    throw new ContextServiceError('Context Service returned an invalid bundle content type');
  }
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw new ContextServiceError('Context Service returned no bundle body');
  // Reserve before buffering: the declared length, or the most a bundle may be.
  const reserved = Number.isFinite(declared) && declared >= 0 ? declared : maxBytes;
  let release: () => void;
  try {
    release = await reserveDownloadBytes(reserved, deadline);
  } catch (err) {
    await response.body.cancel().catch(() => {});
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        throw new ContextServiceError(`Context Service bundle stream failed: ${String(err)}`);
      });
      if (done) break;
      received += value.byteLength;
      if (received > reserved) {
        await reader.cancel().catch(() => {});
        throw received > maxBytes
          ? tooLarge()
          : new ContextServiceError('Context Service bundle exceeds its Content-Length');
      }
      chunks.push(Buffer.from(value));
    }
    const bundle = Buffer.concat(chunks, received);
    await assertCompleteGzip(bundle, maxExpanded);
    return bundle;
  } finally {
    release();
  }
}

/**
 * The bundle of a frozen revision, from the trusted export
 * (`GET /internal/v1/namespaces/{ns}/contexts/{name}/revisions/{sha256}/bundle`). Served from the
 * in-memory cache when present; concurrent requests for the same revision share one download, and
 * a failed download is never cached.
 *
 * The revision is Context Service's digest of the Context's files, not of the compressed bundle, so
 * Moca cannot check the bytes against it. It trusts this authenticated export for which revision
 * the bytes are; the sha256 the sandbox later checks proves only that the relay copy is intact.
 */
export async function downloadContextBundle(
  name: string,
  revision: string,
  owner: string,
): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid context revision');
  const key = `${owner}\0${name}\0${revision}`;
  const cached = bundleCache.get(key);
  if (cached) {
    // Refresh its place in the LRU order.
    bundleCache.delete(key);
    bundleCache.set(key, cached);
    return cached;
  }
  let download = bundleDownloads.get(key);
  if (!download) {
    download = fetchBundle(name, revision, owner)
      .then((bundle) => {
        cacheBundle(key, bundle);
        return bundle;
      })
      .finally(() => bundleDownloads.delete(key));
    bundleDownloads.set(key, download);
  }
  return download;
}
