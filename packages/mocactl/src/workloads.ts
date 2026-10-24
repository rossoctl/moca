/**
 * `mocactl workloads create | get | delete`: a workload carries a context (built elsewhere, e.g.
 * with `contextctl ctx pack`) that `mocactl spawn --workload` runs prompts on. The harness has no
 * route that lists workloads, so there is no list command.
 */
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError, TOKEN_CODES } from './api/errors.js';
import {
  ContextUploadError,
  MAX_WORKLOAD_ID_LENGTH,
  WorkloadsClient,
  validWorkloadId,
  type UploadGrant,
  type UploadResult,
  type Workload,
  type WorkloadMount,
} from './api/workloads.js';
import { describeError } from './core/messages.js';
import { sanitizeRemote } from './core/sanitize.js';
import { ready, type Io } from './headless.js';
import { ensureRuntimeAuth, type Runtime } from './runtime.js';

/** A grant this close to its expiry is replaced before the upload starts. */
const GRANT_EXPIRY_MARGIN_MS = 10_000;
/** How long `create --sandboxes` waits for the workload's sandboxes to attach, and how often it looks. */
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;

export interface WorkloadOptions {
  json: boolean;
  signal?: AbortSignal;
  /** Test seam; otherwise built from the runtime. */
  client?: WorkloadsClient;
}

function clientFor(rt: Runtime & Required<Pick<Runtime, 'harness'>>): WorkloadsClient {
  return new WorkloadsClient(
    rt.harness,
    async () => {
      // A long upload can outlive the 15-minute API token; this is a no-op while it is fresh.
      await ensureRuntimeAuth(rt);
      return rt.auth?.apiToken;
    },
    rt.fetchImpl,
  );
}

/** The sentence for a failed workload request: the harness's own code, which matters here. */
export function describeWorkloadError(err: unknown, id?: string): string {
  if (err instanceof ContextUploadError) {
    return sanitizeRemote(
      err.status === 0
        ? err.message
        : `Context Service refused the upload: ${err.status} ${err.code}` +
            (err.message && err.message !== err.code ? ` (${err.message})` : ''),
    );
  }
  if (err instanceof ApiError && err.status !== 0 && !TOKEN_CODES.has(err.code)) {
    switch (err.code) {
      case 'workloads_unavailable':
        return 'workloads are not enabled on this harness — its operator turns them on (docs/context-service.md)';
      case 'workloads_misconfigured':
        return "the harness's workload settings are incomplete — ask its operator";
      case 'workload_not_found':
        return id ? `no workload '${sanitizeRemote(id)}' (or it is not yours)` : 'no such workload';
      case 'workload_quota_exceeded':
        return 'you have as many workloads as you may — delete one with `mocactl workloads delete ID`';
      case 'workload_name_taken':
        return `you already have a workload named '${sanitizeRemote(id ?? '')}'`;
    }
    return sanitizeRemote(
      `the harness refused: ${err.status} ${err.code}` +
        (err.message && err.message !== err.code ? ` (${err.message})` : ''),
    );
  }
  return describeError(err);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A name for `create` without `--name`, in the harness's own pattern (`wl-` and 8 hex). */
export function generateWorkloadId(): string {
  return `wl-${randomBytes(4).toString('hex')}`;
}

// --- create ---

export interface CreateOptions extends WorkloadOptions {
  /** The context file to upload, as `contextctl ctx pack` writes it. */
  contextPath: string;
  name?: string;
  /** `--sandboxes N`: the workload gets N sandboxes of its own (phase 2). */
  sandboxes?: number;
  /** `--mount MODE`: with `sandboxes`, mount the context from the workload's own PVC. */
  mount?: WorkloadMount;
  /** Test seam: how long to wait for a `provisioning` workload to become ready. */
  readyTimeoutMs?: number;
}

/**
 * POST /workloads, PUT the context file to the grant, then activate the revision the upload
 * returned. A grant that has expired, or that the upload rejects with 401, is replaced once via
 * POST .../uploads. On any failure after the workload exists, it is deleted again (best effort) so
 * it does not hold a slot of the per-user quota. Without `--name` the name is generated here, not by
 * the harness, so the id is known even when the reply to the POST never arrives. With `sandboxes`,
 * activate answers `provisioning` while the workload's own sandboxes start; `create` polls
 * `GET /workloads/{id}` until it is `ready`, and treats a recorded `error` or a timeout as a failure.
 */
export async function cmdWorkloadCreate(rt: Runtime, io: Io, opts: CreateOptions): Promise<number> {
  if (opts.name !== undefined && !validWorkloadId(opts.name)) {
    io.err(
      `--name must be a lowercase Kubernetes name of at most ${MAX_WORKLOAD_ID_LENGTH} characters (a-z, 0-9, '-')`,
    );
    return 2;
  }
  const path = resolve(opts.contextPath);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      io.err(`--context ${opts.contextPath} is not a file`);
      return 2;
    }
    size = st.size;
  } catch {
    io.err(
      `--context ${opts.contextPath} does not exist (build one with \`contextctl ctx pack DIR -o FILE\`)`,
    );
    return 2;
  }
  if (size === 0) {
    io.err(`--context ${opts.contextPath} is empty`);
    return 2;
  }
  if (opts.mount !== undefined && opts.sandboxes === undefined) {
    io.err(
      '--mount needs --sandboxes N: only a workload with its own sandboxes mounts its context',
    );
    return 2;
  }
  if (!ready(rt, io)) return 2;
  const client = opts.client ?? clientFor(rt);
  const { signal } = opts;

  const name = opts.name ?? generateWorkloadId();
  // The POST may have landed even though its reply did not: name the workload to delete.
  const mayExist = () =>
    io.err(
      `workload ${sanitizeRemote(name)} may have been created: \`mocactl workloads delete ${sanitizeRemote(name)}\``,
    );
  let created: Workload & { upload: UploadGrant };
  try {
    created = await client.create(
      {
        name,
        ...(opts.sandboxes !== undefined ? { sandboxes: { count: opts.sandboxes } } : {}),
        ...(opts.mount !== undefined ? { workspace: { mount: opts.mount } } : {}),
      },
      signal,
    );
  } catch (err) {
    if (aborted(signal)) {
      mayExist();
      return 130;
    }
    io.err(describeWorkloadError(err, name));
    if (err instanceof ApiError && err.status === 0) mayExist();
    return 1;
  }
  const id = created.workloadId;
  io.err(`created workload ${sanitizeRemote(id)}; uploading ${size} bytes`);

  const fail = async (message: string): Promise<number> => {
    io.err(message);
    if (aborted(signal)) {
      io.err(
        `workload ${sanitizeRemote(id)} was left ${uploaded ? 'activating' : 'awaiting upload'}: \`mocactl workloads delete ${sanitizeRemote(id)}\``,
      );
      return 130;
    }
    try {
      await client.delete(id);
      io.err(`deleted workload ${sanitizeRemote(id)}`);
    } catch (err) {
      io.err(
        `could not delete workload ${sanitizeRemote(id)} (${describeWorkloadError(err, id)}); ` +
          `run \`mocactl workloads delete ${sanitizeRemote(id)}\``,
      );
    }
    return 1;
  };
  const tooLarge = (grant: UploadGrant) =>
    size > grant.maxBytes
      ? `--context ${opts.contextPath} is ${size} bytes; Context Service accepts at most ${grant.maxBytes}`
      : undefined;

  let grant = created.upload;
  let replaced = false;
  let uploaded: UploadResult | undefined;
  try {
    if (Date.parse(grant.expiresAt) - rt.now() < GRANT_EXPIRY_MARGIN_MS) {
      grant = await client.freshUpload(id, signal);
      replaced = true;
    }
    for (;;) {
      const problem = tooLarge(grant);
      if (problem) return await fail(problem);
      try {
        uploaded = await client.upload(grant, path, size, signal);
        break;
      } catch (err) {
        // The grant expired in transit, or was already spent: one fresh grant, one more try.
        if (!replaced && err instanceof ContextUploadError && err.status === 401) {
          io.err('the upload grant was refused; retrying with a fresh one');
          grant = await client.freshUpload(id, signal);
          replaced = true;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    return fail(describeWorkloadError(err, id));
  }

  let active: Workload;
  try {
    active = await client.activate(id, uploaded.revision, signal);
  } catch (err) {
    return fail(describeWorkloadError(err, id));
  }
  if (active.status === 'provisioning') {
    io.err(`workload ${sanitizeRemote(id)} is provisioning its sandboxes`);
    const deadline = rt.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    let reactivated = false;
    try {
      while (active.status === 'provisioning') {
        // The harness lost the held bundle (a provisioner restart, or a seed hold that lapsed while
        // a claim sat Pending): the documented remedy is to repeat the activate, once.
        if (active.error === 'seed_bundle_missing' && !reactivated) {
          reactivated = true;
          io.err(`workload ${sanitizeRemote(id)} lost its seed bundle; activating again`);
          active = await client.activate(id, uploaded.revision, signal);
          continue;
        }
        if (active.error) {
          return await fail(
            `workload ${sanitizeRemote(id)} failed to provision: ${sanitizeRemote(active.error)}`,
          );
        }
        if (rt.now() >= deadline) {
          const s = active.sandboxes;
          return await fail(
            `workload ${sanitizeRemote(id)} is still provisioning` +
              (s ? ` (${s.ready ?? 0} of ${s.count} sandboxes attached)` : ''),
          );
        }
        await rt.sleep(READY_POLL_MS, signal);
        if (aborted(signal)) return await fail('interrupted while the sandboxes start');
        active = await client.get(id, signal);
      }
    } catch (err) {
      return fail(describeWorkloadError(err, id));
    }
  }
  io.err(
    `workload ${sanitizeRemote(id)} is ${sanitizeRemote(active.status)} (revision ${uploaded.revision.slice(0, 12)}` +
      (uploaded.files !== undefined ? `, ${uploaded.files} files` : '') +
      ')',
  );
  if (opts.json) {
    io.out(
      JSON.stringify({
        workloadId: id,
        status: active.status,
        contextType: active.contextType ?? null,
        revision: uploaded.revision,
        files: uploaded.files ?? null,
        bytes: uploaded.bytes ?? null,
        ...(active.sandboxes ? { sandboxes: active.sandboxes } : {}),
        ...(active.workspace?.mount ? { mount: active.workspace.mount } : {}),
      }) + '\n',
    );
  } else {
    io.out(`${id}\n`);
  }
  return 0;
}

// --- get / delete ---

export interface IdOptions extends WorkloadOptions {
  id: string;
}

function checkId(io: Io, id: string): boolean {
  if (validWorkloadId(id)) return true;
  io.err(`invalid workload id '${sanitizeRemote(id)}'`);
  return false;
}

export async function cmdWorkloadGet(rt: Runtime, io: Io, opts: IdOptions): Promise<number> {
  if (!checkId(io, opts.id)) return 2;
  if (!ready(rt, io)) return 2;
  const client = opts.client ?? clientFor(rt);
  let w: Workload;
  try {
    w = await client.get(opts.id, opts.signal);
  } catch (err) {
    if (aborted(opts.signal)) return 130;
    io.err(describeWorkloadError(err, opts.id));
    return 1;
  }
  const view = {
    workloadId: w.workloadId,
    status: w.status,
    contextType: w.contextType ?? null,
    workspace: w.workspace ?? null,
    revision: w.revision ?? null,
    sandboxes: w.sandboxes ?? null,
    ...(w.error ? { error: w.error } : {}),
  };
  if (opts.json) {
    io.out(JSON.stringify(view) + '\n');
    return 0;
  }
  const rows = [
    ['WORKLOAD', 'STATUS', 'TYPE', 'SIZE', 'SANDBOXES', 'MOUNT', 'REVISION'],
    [
      view.workloadId,
      view.status,
      view.contextType ?? '-',
      view.workspace?.size ?? '-',
      view.sandboxes ? `${view.sandboxes.ready ?? 0}/${view.sandboxes.count}` : '-',
      view.workspace?.mount ?? '-',
      view.revision ?? '-',
    ].map(sanitizeRemote),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  io.out(
    rows
      .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '))
      .join('\n') + '\n',
  );
  return 0;
}

export async function cmdWorkloadDelete(rt: Runtime, io: Io, opts: IdOptions): Promise<number> {
  if (!checkId(io, opts.id)) return 2;
  if (!ready(rt, io)) return 2;
  const client = opts.client ?? clientFor(rt);
  try {
    await client.delete(opts.id, opts.signal);
  } catch (err) {
    if (aborted(opts.signal)) return 130;
    io.err(describeWorkloadError(err, opts.id));
    return 1;
  }
  io.err(`deleted workload ${sanitizeRemote(opts.id)}`);
  if (opts.json) io.out(JSON.stringify({ workloadId: opts.id, status: 'deleted' }) + '\n');
  return 0;
}
