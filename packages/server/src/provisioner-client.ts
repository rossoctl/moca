/**
 * Client for moca-provisioner's internal API (workload sandboxes spec §4.1, ADR-0043). The worker
 * presents its service token (MOCA_PROVISIONER_TOKEN) and forwards the caller's own API token; the
 * provisioner verifies that token itself and derives the workload key from its subject, so no
 * request here names a workload key.
 *
 * Off unless MOCA_PROVISIONER_URL is set: without it, `sandboxes` on POST /workloads is refused as
 * any unknown field is, and nothing here is called.
 */

import { CONTEXT_BUNDLE_TYPE } from './context-service.js';

export const USER_TOKEN_HEADER = 'x-moca-user-token';

export class ProvisionerError extends Error {
  constructor(
    message: string,
    /** The status the provisioner answered, when it answered. */
    readonly status?: number,
    /** Its `error` code, when it sent one. */
    readonly code?: string,
    /** Its Retry-After, when it sent one (`503 seed_budget_full`). */
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'ProvisionerError';
  }
}

export function provisionerConfigured(): boolean {
  return (process.env.MOCA_PROVISIONER_URL?.trim().length ?? 0) > 0;
}

/** Throws when the provisioner is configured without its token. */
export function assertProvisionerSettings(): void {
  if (provisionerConfigured() && !process.env.MOCA_PROVISIONER_TOKEN?.trim()) {
    throw new Error('MOCA_PROVISIONER_TOKEN is required with MOCA_PROVISIONER_URL');
  }
}

export interface WorkloadRefForProvisioner {
  name: string;
  generation: string;
  /** The caller's control-plane API token, forwarded verbatim. */
  userToken: string;
}

async function call(
  method: 'PUT' | 'GET' | 'DELETE',
  ref: WorkloadRefForProvisioner,
  body?: unknown,
  suffix = '',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const base = process.env.MOCA_PROVISIONER_URL?.trim().replace(/\/+$/, '');
  const token = process.env.MOCA_PROVISIONER_TOKEN?.trim();
  if (!base || !token) throw new Error('the provisioner is not configured');
  const configured = Number.parseInt(process.env.MOCA_PROVISIONER_TIMEOUT_MS ?? '', 10);
  // A bundle is up to MOCA_CONTEXT_BUNDLE_MAX_BYTES: at least a minute for it.
  const floor = Buffer.isBuffer(body) ? 60_000 : 0;
  const timeout = Math.max(
    floor,
    Number.isSafeInteger(configured) && configured > 0 ? configured : 15_000,
  );
  const path = `/internal/v1/workloads/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.generation)}${suffix}`;
  const raw = Buffer.isBuffer(body);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      [USER_TOKEN_HEADER]: ref.userToken,
      ...(body === undefined
        ? {}
        : { 'content-type': raw ? CONTEXT_BUNDLE_TYPE : 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : // The bundle's own bytes, never copied: fetch sends them with their Content-Length,
        // which the provisioner requires to reserve its seed budget first.
        {
          body: raw
            ? // A view of the Buffer's memory, not a copy. Node Buffers never sit on a
              // SharedArrayBuffer, which is all the cast rules out.
              (new Uint8Array(
                (body as Buffer).buffer,
                (body as Buffer).byteOffset,
                (body as Buffer).length,
              ) as Uint8Array<ArrayBuffer>)
            : JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(timeout),
  }).catch((err: unknown) => {
    throw new ProvisionerError(`the provisioner is unreachable: ${String(err)}`);
  });
  const json = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : undefined;
    throw new ProvisionerError(
      `the provisioner answered ${response.status}${code ? ` ${code}` : ''}`,
      response.status,
      code,
      response.headers.get('retry-after') ?? undefined,
    );
  }
  return { status: response.status, json };
}

/**
 * Create or converge the workload's sandboxes. Idempotent by (name, generation). `mount` and
 * `storage` ask for the workload's own PVC, seeded from the bundle handed over first.
 */
export async function provisionSandboxes(
  ref: WorkloadRefForProvisioner,
  spec: {
    count: number;
    tier: string;
    revision: string;
    mount?: string;
    storage?: { size: string; storageClass?: string };
  },
): Promise<void> {
  await call('PUT', ref, spec);
}

/**
 * Hand the provisioner the frozen bundle a mounted workload's PVC is seeded from (spec §5.2), before
 * the PUT that creates its sandboxes. It holds the bundle in memory until the seed has run.
 */
export async function handOverBundle(
  ref: WorkloadRefForProvisioner,
  bundle: Buffer,
): Promise<void> {
  await call('PUT', ref, bundle, '/bundle');
}

/**
 * A mounted workload's seed, as the provisioner sees it (spec §5.2): `bundle_missing` after a
 * provisioner restart lost the held bundle before the seed ran.
 */
export async function sandboxesSeed(ref: WorkloadRefForProvisioner): Promise<string | undefined> {
  const { json } = await call('GET', ref);
  return typeof json.seed === 'string' ? json.seed : undefined;
}

/**
 * Delete the workload's sandboxes. Resolves `true` once no pod of it remains (200), `false` while
 * pods are still terminating (202); the caller repeats.
 */
export async function deleteSandboxes(ref: WorkloadRefForProvisioner): Promise<boolean> {
  return (await call('DELETE', ref)).status === 200;
}
