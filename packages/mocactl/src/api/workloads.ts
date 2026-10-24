/**
 * Client for the harness's `/workloads` routes (docs/context-service.md) and the one-time upload
 * of a context file straight to Context Service. The routes take the user's API token; the upload
 * takes only the grant's own token.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { ApiError, errorFromResponse, networkError } from './errors.js';
import type { LeafHarness } from '../transport/leaf-turn.js';
import { trimTrailingSlashes } from './url.js';

/** The media type Context Service accepts on an upload. */
export const CONTEXT_MEDIA_TYPE = 'application/vnd.rossoctl.context';
/** A workload name: a lowercase Kubernetes name, as the harness checks it. */
export const WORKLOAD_ID = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
export const MAX_WORKLOAD_ID_LENGTH = 50;
const REVISION = /^[a-f0-9]{64}$/;

export function validWorkloadId(id: string): boolean {
  return id.length <= MAX_WORKLOAD_ID_LENGTH && WORKLOAD_ID.test(id);
}

/** A one-time grant to PUT one context file to Context Service. */
export interface UploadGrant {
  uploadUrl: string;
  token: string;
  expiresAt: string;
  method: 'PUT';
  contentType: string;
  maxBytes: number;
}

/** `workspace.mount` (phase 2): how a workload's own sandboxes mount its context. */
export const WORKLOAD_MOUNTS = ['read-only', 'writable'] as const;
export type WorkloadMount = (typeof WORKLOAD_MOUNTS)[number];

export interface Workload {
  workloadId: string;
  status: string;
  contextType?: string;
  workspace?: { size?: string; storageClass?: string; mount?: string };
  revision?: string;
  /** Phase 2: the workload's own sandboxes; `ready` of `count` are attached. */
  sandboxes?: { count: number; tier?: string; ready?: number };
  /** Why the last provisioning attempt failed (a `provisioning` workload only). */
  error?: string;
}

export interface CreateWorkloadRequest {
  name?: string;
  /** Phase 2 (docs/context-service.md, "Own sandboxes"): sandboxes of the workload's own. */
  sandboxes?: { count: number };
  /** Needs `sandboxes`: mount the context from the workload's own PVC instead of copying it. */
  workspace?: { mount: WorkloadMount };
}

export interface UploadResult {
  revision: string;
  files?: number;
  bytes?: number;
}

/** A refusal from Context Service's upload route; `status` 0 means it was never reached. */
export class ContextUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ContextUploadError';
  }
}

/**
 * Where an upload may go: HTTPS, or plain HTTP on loopback only (local development), the rule the
 * harness applies to `CONTEXT_SERVICE_PUBLIC_URL`. Anything else would send the grant's token in
 * the clear. Returns the reason it is refused, or undefined.
 */
export function uploadUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'the upload URL is not a URL';
  }
  if (url.protocol === 'https:') return undefined;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && loopback) return undefined;
  return 'the upload URL must use HTTPS (plain HTTP only on loopback)';
}

export class WorkloadsClient {
  constructor(
    private readonly harness: LeafHarness,
    /** The user's API token, refreshed if needed; read before every request. */
    private readonly apiToken: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** POST /workloads: the workload, awaiting upload, plus its first grant. */
  async create(
    req: CreateWorkloadRequest,
    signal?: AbortSignal,
  ): Promise<Workload & { upload: UploadGrant }> {
    const body = await this.request('POST', '/workloads', req, signal);
    const workload = asWorkload(body);
    const upload = asGrant((body as { upload?: unknown }).upload);
    return { ...workload, upload };
  }

  /** POST /workloads/{id}/uploads: a fresh grant while the workload awaits upload. */
  async freshUpload(id: string, signal?: AbortSignal): Promise<UploadGrant> {
    return asGrant(
      await this.request('POST', `/workloads/${encodeURIComponent(id)}/uploads`, undefined, signal),
    );
  }

  /** POST /workloads/{id}/activate: freeze the uploaded revision; the workload becomes ready. */
  async activate(id: string, revision: string, signal?: AbortSignal): Promise<Workload> {
    return asWorkload(
      await this.request(
        'POST',
        `/workloads/${encodeURIComponent(id)}/activate`,
        { revision },
        signal,
      ),
    );
  }

  async get(id: string, signal?: AbortSignal): Promise<Workload> {
    return asWorkload(
      await this.request('GET', `/workloads/${encodeURIComponent(id)}`, undefined, signal),
    );
  }

  /** DELETE /workloads/{id}: 204. */
  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request('DELETE', `/workloads/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * PUT the file at `path` (`size` bytes) to the grant's URL, streamed from disk rather than read
   * into memory. Throws ContextUploadError for a refusal or an unusable reply.
   */
  async upload(
    grant: UploadGrant,
    path: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    const problem = uploadUrlProblem(grant.uploadUrl);
    if (problem) throw new ContextUploadError(0, 'upload_url_unsafe', problem);
    const stream = createReadStream(path);
    let res: Response;
    try {
      res = await this.fetchImpl(grant.uploadUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${grant.token}`,
          'content-type': grant.contentType,
          'content-length': String(size),
        },
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        // Required by Node's fetch for a streamed request body.
        duplex: 'half',
        signal,
      } as RequestInit & { duplex: 'half' });
    } catch (err) {
      stream.destroy();
      if (signal?.aborted) throw err;
      throw new ContextUploadError(
        0,
        'network_error',
        `cannot reach Context Service: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const e = await errorFromResponse('harness', res);
      throw new ContextUploadError(res.status, e.code, e.message);
    }
    const body = (await res.json().catch(() => null)) as Partial<UploadResult> | null;
    if (!body || typeof body.revision !== 'string' || !REVISION.test(body.revision)) {
      throw new ContextUploadError(
        res.status,
        'invalid_body',
        'Context Service returned no revision',
      );
    }
    return {
      revision: body.revision,
      ...(typeof body.files === 'number' ? { files: body.files } : {}),
      ...(typeof body.bytes === 'number' ? { bytes: body.bytes } : {}),
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const base = trimTrailingSlashes(await this.harness.baseUrl());
    const token = await this.apiToken();
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      throw new ApiError('harness', 0, 'invalid_body', `the harness returned non-JSON for ${path}`);
    }
  }
}

function invalid(what: string): ApiError {
  return new ApiError('harness', 0, 'invalid_body', `the harness returned an invalid ${what}`);
}

function asWorkload(body: unknown): Workload {
  const b = body as Partial<Workload> | null;
  if (!b || typeof b.workloadId !== 'string' || typeof b.status !== 'string') {
    throw invalid('workload');
  }
  return {
    workloadId: b.workloadId,
    status: b.status,
    ...(typeof b.contextType === 'string' ? { contextType: b.contextType } : {}),
    ...(b.workspace && typeof b.workspace === 'object' ? { workspace: b.workspace } : {}),
    ...(typeof b.revision === 'string' ? { revision: b.revision } : {}),
    ...(b.sandboxes && typeof b.sandboxes === 'object' && typeof b.sandboxes.count === 'number'
      ? { sandboxes: b.sandboxes }
      : {}),
    ...(typeof b.error === 'string' ? { error: b.error } : {}),
  };
}

function asGrant(body: unknown): UploadGrant {
  const g = body as Partial<UploadGrant> | null;
  if (
    !g ||
    typeof g.uploadUrl !== 'string' ||
    typeof g.token !== 'string' ||
    !g.token ||
    typeof g.expiresAt !== 'string' ||
    // The only media type Context Service accepts: a grant naming another is not one to follow.
    g.contentType !== CONTEXT_MEDIA_TYPE ||
    typeof g.maxBytes !== 'number' ||
    !Number.isSafeInteger(g.maxBytes) ||
    g.maxBytes <= 0
  ) {
    throw invalid('upload grant');
  }
  return {
    uploadUrl: g.uploadUrl,
    token: g.token,
    expiresAt: g.expiresAt,
    method: 'PUT',
    contentType: g.contentType,
    maxBytes: g.maxBytes,
  };
}
