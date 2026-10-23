import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CpError,
  ownerScopeFor,
  statusFor,
  workloadKeyFor,
  workloadRecordKey,
} from '@moca/control-plane';
import {
  assertContextServiceSettings,
  contextServiceConfigured,
  ContextServiceError,
  createContext,
  createUploadGrant,
  deleteContext,
  evictContextBundles,
  freezeContext,
  retryWhileUnreachable,
  type ContextStorage,
} from './context-service.js';
import { recordsKey } from '@moca/harness/pool-records';
import { OWNER_LABEL, WORKLOAD_LABEL } from '@moca/harness/sandbox-affinity';
import {
  assertProvisionerSettings,
  deleteSandboxes,
  provisionerConfigured,
  ProvisionerError,
  provisionSandboxes,
} from './provisioner-client.js';
import { authenticateApiCaller, type TurnAuthDeps } from './turn-auth.js';

/**
 * The `/workloads` lifecycle: an owner-bound logical workload backed by one Context Service Context.
 * Moca stores the record; the client uploads its bundle straight to Context Service with a one-time
 * grant; activation freezes the uploaded revision. A run that names a ready workload gets that
 * revision delivered to its sandbox (`resolveWorkloadRun`).
 *
 * Names are scoped per owner (the first half of rossoctl/moca#358, per-user PVC authorization): the
 * record key includes a hash of the owner, so two users may both own `demo`, and another user's
 * workload is indistinguishable from a missing one.
 *
 * A workload created with `sandboxes` (phase 2, workload sandboxes spec §6.1) also gets sandboxes of
 * its own from moca-provisioner at activation, and its runs execute only there. That needs
 * MOCA_PROVISIONER_URL; without it, `sandboxes` is refused like any unknown field.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_BODY_BYTES = 1024 * 1024;
const NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 50;
const REVISION = /^[a-f0-9]{64}$/;
// Context Service requires an uploaded bundle's type to match its Context's.
const CONTEXT_TYPES = new Set(['workspace', 'state', 'memory', 'knowledge', 'artifacts']);
const CREATE_FIELDS = new Set(['name', 'contextType', 'workspace']);
/** Accepted only with the provisioner configured: off by default. */
const SANDBOXES_FIELD = 'sandboxes';
const SANDBOX_FIELDS = new Set(['count', 'tier']);
const WORKSPACE_FIELDS = new Set(['size', 'storageClass']);
/** Retry-After on a passed-through `429 owner_sandbox_quota_exceeded`. */
const PROVISIONER_RETRY_AFTER_S = 30;

type WorkloadStatus =
  'creating' | 'awaiting_upload' | 'provisioning' | 'ready' | 'deleting' | 'deleted';

/** A phase 2 workload's own sandboxes (spec §7). Absent on a phase 1 workload. */
interface WorkloadSandboxes {
  count: number;
  tier: 'container';
}

interface WorkloadRecord {
  name: string;
  owner: string;
  /** Unique per reservation, so a stale request cannot act on a re-created workload. */
  generation: string;
  /** Derived per reservation and never returned: it must not reveal the owner. */
  contextName: string;
  contextId?: string;
  status: WorkloadStatus;
  contextType: string;
  workspace: ContextStorage;
  revision?: string;
  sandboxes?: WorkloadSandboxes;
  /** Why the last provisioning attempt failed; cleared when one succeeds. */
  error?: string;
}

/** The subset of the Redis result store the lifecycle uses. */
export interface WorkloadStore {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface WorkloadDeps {
  store: () => WorkloadStore;
  authDeps: () => TurnAuthDeps;
}

/** A competing request (usually DELETE) changed the record first. */
class WorkloadStateChangedError extends Error {}

/** Off by default: both the flag and a Context Service URL are needed. */
export function workloadsEnabled(): boolean {
  return process.env.MOCA_CONTEXT_WORKLOADS_ENABLED === '1' && contextServiceConfigured();
}

/** Scopes the owner's Redis keys (shared with moca-provisioner, @moca/control-plane workload-key.ts). */
const recordScope = ownerScopeFor;
const recordKey = workloadRecordKey;
const quotaKey = (owner: string) => `sh:wl-quota:${recordScope(owner)}`;
let cacheSecret: string | Buffer | undefined;

/**
 * Names the owner's copies in a shared sandbox's context cache (`cache/<scope>-<revision>`). An
 * HMAC under a secret the agents never see, so an agent cannot compute another user's scope and
 * plant a copy for a revision it knows. The secret is `MOCA_CONTEXT_CACHE_SECRET`, or random per
 * process: replicas with different secrets only miss each other's copies.
 */
export function sandboxCacheScope(owner: string): string {
  cacheSecret ??= process.env.MOCA_CONTEXT_CACHE_SECRET?.trim() || randomBytes(32);
  return createHmac('sha256', cacheSecret).update(owner).digest('hex').slice(0, 32);
}

/**
 * Unique per owner, name and reservation, so a rollback can never delete a newer Context. It is also
 * the workload key moca-provisioner names the workload's sandboxes by (spec §3.1).
 */
const contextNameFor = workloadKeyFor;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Claim the name and one unit of the owner's quota. Any record that is not `deleted` keeps both.
const RESERVE = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).status ~= 'deleted' then return 'duplicate' end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 'quota' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'ok'`;

// Compare-and-set on (generation, status). Only the request whose transition to `deleted` lands
// releases the quota unit, so it is released exactly once. A deleted record expires after
// ARGV[5] seconds; until then GET reports it as deleted.
const TRANSITION = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if decoded.generation ~= ARGV[1] or decoded.status ~= ARGV[2] then return 0 end
if ARGV[4] == '1' then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[5]))
  if tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then redis.call('DECR', KEYS[2]) end
else
  redis.call('SET', KEYS[1], ARGV[3])
end
return 1`;

async function transition(
  store: WorkloadStore,
  from: WorkloadRecord,
  to: WorkloadRecord,
): Promise<boolean> {
  const changed = await store.eval(TRANSITION, {
    keys: [recordKey(from.owner, from.name), quotaKey(from.owner)],
    arguments: [
      from.generation,
      from.status,
      JSON.stringify(to),
      to.status === 'deleted' ? '1' : '0',
      String(positiveIntEnv('MOCA_WORKLOAD_DELETED_TTL_SECONDS', 24 * 60 * 60)),
    ],
  });
  return Number(changed) === 1;
}

async function findWorkload(
  store: WorkloadStore,
  owner: string,
  name: string,
): Promise<WorkloadRecord | null> {
  const raw = await store.get(recordKey(owner, name));
  return raw ? (JSON.parse(raw) as WorkloadRecord) : null;
}

/** `ready` is the number of the workload's sandboxes attached to the relay, when it was counted. */
function publicView(record: WorkloadRecord, ready?: number) {
  return {
    workloadId: record.name,
    status: record.status,
    contextType: record.contextType,
    workspace: record.workspace,
    ...(record.revision ? { revision: record.revision } : {}),
    ...(record.sandboxes
      ? {
          sandboxes: {
            ...record.sandboxes,
            ready: ready ?? (record.status === 'ready' ? record.sandboxes.count : 0),
          },
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

// The workload's sandboxes the relay has a presence record for. Their workload and owner labels come
// from the signed attach token (spec §3.2), so a shared-pool sandbox cannot be counted here.
const COUNT_ATTACHED = `
local n = 0
for _, v in ipairs(redis.call('HVALS', KEYS[1])) do
  local ok, r = pcall(cjson.decode, v)
  if ok and type(r) == 'table' and type(r.labels) == 'table'
    and r.labels[ARGV[1]] == ARGV[3] and r.labels[ARGV[2]] == ARGV[4] then n = n + 1 end
end
return n`;

async function countAttached(store: WorkloadStore, record: WorkloadRecord): Promise<number> {
  return Number(
    await store.eval(COUNT_ATTACHED, {
      keys: [recordsKey()],
      arguments: [WORKLOAD_LABEL, OWNER_LABEL, record.contextName, recordScope(record.owner)],
    }),
  );
}

/** The workload's own sandboxes, or the 400 code to refuse the create with. */
function sandboxesSpec(value: unknown): WorkloadSandboxes | string {
  if (!isObject(value) || Object.keys(value).some((key) => !SANDBOX_FIELDS.has(key))) {
    return 'sandboxes_field_not_allowed';
  }
  // Container only: the provisioner creates pods in the cluster, and P4 hosts sit outside it.
  const tier = value.tier ?? 'container';
  if (tier === 'microvm') return 'sandbox_tier_unavailable';
  if (tier !== 'container') return 'sandbox_tier_invalid';
  const count = value.count ?? 1;
  const max = positiveIntEnv('MOCA_WORKLOAD_MAX_SANDBOXES', 2);
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > max) {
    return 'sandboxes_count_invalid';
  }
  return { count: count as number, tier };
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, 'body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  // Every create field is optional, so a body-less request means "all defaults".
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, 'invalid_json');
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The storage Context Service is asked for, within this deployment's ceiling and allowlist. */
function contextStorage(workspace: Record<string, unknown>): ContextStorage | string {
  const size = workspace.size ?? '1Gi';
  const match = typeof size === 'string' ? /^([1-9][0-9]{0,6})(Mi|Gi)$/.exec(size) : null;
  const maxMiB = positiveIntEnv('MOCA_CONTEXT_MAX_STORAGE_GIB', 10) * 1024;
  if (!match || Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1) > maxMiB) {
    return 'workspace_size_invalid';
  }
  const storageClass = workspace.storageClass;
  if (storageClass === undefined) return { size: size as string };
  const allowed = (process.env.MOCA_CONTEXT_STORAGE_CLASSES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (typeof storageClass !== 'string' || !allowed.includes(storageClass)) {
    return 'storage_class_not_allowed';
  }
  return { size: size as string, storageClass };
}

/**
 * Only failures that originated at Context Service read as `context_service_error`; its 409s
 * (for example `revision_mismatch`) pass through, a lost lifecycle race is a 409, and anything
 * local (Redis, configuration) is a 500.
 */
function sendFailure(res: ServerResponse, operation: string, err: unknown): void {
  console.error(`workload ${operation} failed:`, err);
  if (err instanceof WorkloadStateChangedError) {
    send(res, 409, { error: 'workload_state_changed' });
  } else if (err instanceof ProvisionerError && err.code && err.status === 429) {
    // The owner's cap across workloads (spec §6.3): it frees once the owner deletes a workload.
    res
      .writeHead(429, { ...JSON_HEADERS, 'Retry-After': String(PROVISIONER_RETRY_AFTER_S) })
      .end(JSON.stringify({ error: err.code }));
  } else if (
    err instanceof ProvisionerError &&
    err.code &&
    (err.status === 400 || err.status === 409 || err.status === 422)
  ) {
    // The provisioner's own caps and conflicts, and the cluster refusing the objects (422
    // workload_refused): the caller's or the operator's to act on, not an outage.
    send(res, err.status, { error: err.code });
  } else if (err instanceof ProvisionerError) {
    send(res, 502, { error: 'provisioner_error' });
  } else if (err instanceof ContextServiceError && err.status === 409) {
    send(res, 409, { error: err.code ?? 'context_conflict' });
  } else if (err instanceof ContextServiceError) {
    send(res, 502, { error: 'context_service_error' });
  } else {
    send(res, 500, { error: 'internal_error' });
  }
}

async function createWorkload(
  body: unknown,
  owner: string,
  store: WorkloadStore,
  res: ServerResponse,
): Promise<void> {
  if (!isObject(body)) return send(res, 400, { error: 'workload_invalid' });
  const allowed = (key: string) =>
    CREATE_FIELDS.has(key) || (key === SANDBOXES_FIELD && provisionerConfigured());
  if (Object.keys(body).some((key) => !allowed(key))) {
    return send(res, 400, { error: 'workload_field_not_allowed' });
  }
  const name = body.name ?? `wl-${randomUUID().slice(0, 8)}`;
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
    return send(res, 400, { error: 'workload_name_invalid' });
  }
  const contextType = body.contextType ?? 'workspace';
  if (typeof contextType !== 'string' || !CONTEXT_TYPES.has(contextType)) {
    return send(res, 400, { error: 'context_type_invalid' });
  }
  const workspace = body.workspace ?? {};
  if (!isObject(workspace) || Object.keys(workspace).some((key) => !WORKSPACE_FIELDS.has(key))) {
    return send(res, 400, { error: 'workspace_field_not_allowed' });
  }
  const storage = contextStorage(workspace);
  if (typeof storage === 'string') return send(res, 400, { error: storage });
  const sandboxes = body.sandboxes === undefined ? undefined : sandboxesSpec(body.sandboxes);
  if (typeof sandboxes === 'string') return send(res, 400, { error: sandboxes });

  const generation = randomUUID();
  const reserved: WorkloadRecord = {
    name,
    owner,
    generation,
    contextName: contextNameFor(owner, name, generation),
    status: 'creating',
    contextType,
    workspace: storage,
    ...(sandboxes ? { sandboxes } : {}),
  };
  const reservation = String(
    await store.eval(RESERVE, {
      keys: [recordKey(owner, name), quotaKey(owner)],
      arguments: [
        JSON.stringify(reserved),
        String(positiveIntEnv('MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER', 5)),
      ],
    }),
  );
  if (reservation === 'duplicate') return send(res, 409, { error: 'workload_name_taken' });
  if (reservation === 'quota') return send(res, 429, { error: 'workload_quota_exceeded' });

  try {
    const context = await createContext(reserved.contextName, contextType, storage, owner);
    const upload = await createUploadGrant(reserved.contextName, owner);
    const created: WorkloadRecord = {
      ...reserved,
      contextId: context.contextId,
      status: 'awaiting_upload',
    };
    if (!(await transition(store, reserved, created))) throw new WorkloadStateChangedError();
    send(res, 201, { ...publicView(created), upload });
  } catch (err) {
    await rollbackCreate(store, reserved);
    sendFailure(res, 'create', err);
  }
}

/**
 * Undo a failed create. The Context name is unique to this reservation, so deleting it can never
 * hit a newer workload's Context. The quota unit is released only if this reservation is still the
 * stored record; if the Context could not be deleted, the record stays `deleting` so the owner's
 * DELETE can retry, and it keeps its quota unit until then.
 */
async function rollbackCreate(store: WorkloadStore, reserved: WorkloadRecord): Promise<void> {
  try {
    let cleaned = true;
    // Retry only while Context Service is unreachable (no HTTP response). A reply that already
    // says "gone" or any 4xx/5xx with a status is terminal — it tells us the server saw us and
    // decided. The retry absorbs transient blips (pod restart, momentary network loss).
    await retryWhileUnreachable(() => deleteContext(reserved.contextName, reserved.owner), {
      attempts: positiveIntEnv('MOCA_CONTEXT_ROLLBACK_RETRY_ATTEMPTS', 3),
      backoffMs: positiveIntEnv('MOCA_CONTEXT_ROLLBACK_RETRY_BACKOFF_MS', 500),
    }).catch((err: unknown) => {
      cleaned = false;
      // The Context name is derived and does not reveal the owner; log it so an operator can
      // delete the Context if no record is left for a retry to act on.
      console.error(
        `workload create rollback could not delete Context ${reserved.contextName} after retries:`,
        err,
      );
    });
    await transition(store, reserved, { ...reserved, status: cleaned ? 'deleted' : 'deleting' });
  } catch (err) {
    console.error('workload create rollback failed:', err);
  }
}

async function createUpload(record: WorkloadRecord | null, res: ServerResponse): Promise<void> {
  if (!record || record.status === 'deleted')
    return send(res, 404, { error: 'workload_not_found' });
  if (record.status !== 'awaiting_upload') {
    return send(res, 409, { error: 'workload_not_awaiting_upload' });
  }
  try {
    send(res, 201, await createUploadGrant(record.contextName, record.owner));
  } catch (err) {
    sendFailure(res, 'upload grant', err);
  }
}

async function activateWorkload(
  body: unknown,
  record: WorkloadRecord | null,
  store: WorkloadStore,
  userToken: string,
  res: ServerResponse,
): Promise<void> {
  const revision = isObject(body) ? body.revision : undefined;
  if (typeof revision !== 'string' || !REVISION.test(revision)) {
    return send(res, 400, { error: 'revision_invalid' });
  }
  if (!record || record.status === 'deleted')
    return send(res, 404, { error: 'workload_not_found' });
  if (record.status === 'ready' || record.status === 'provisioning') {
    if (record.revision !== revision) return send(res, 409, { error: 'workload_already_active' });
    if (record.status === 'ready') return send(res, 200, publicView(record));
    // A repeat activation retries provisioning, which is idempotent (spec §6.1).
    return provision(record, store, userToken, res);
  }
  if (record.status !== 'awaiting_upload') {
    return send(res, 409, { error: 'workload_not_activatable' });
  }
  try {
    const context = await freezeContext(record.contextName, revision, record.owner);
    if (context.contextId !== record.contextId || context.frozenRevision !== revision) {
      throw new ContextServiceError('Context Service froze a different Context or revision');
    }
    if (record.sandboxes) {
      // Freeze cannot be undone, so the record keeps the revision from here on, whatever happens
      // to provisioning.
      const provisioning: WorkloadRecord = { ...record, status: 'provisioning', revision };
      if (!(await transition(store, record, provisioning))) throw new WorkloadStateChangedError();
      return provision(provisioning, store, userToken, res);
    }
    const { error: _stale, ...rest } = record;
    const ready: WorkloadRecord = { ...rest, status: 'ready', revision };
    if (!(await transition(store, record, ready))) throw new WorkloadStateChangedError();
    send(res, 200, publicView(ready));
  } catch (err) {
    sendFailure(res, 'activate', err);
  }
}

/**
 * Ask the provisioner for the workload's sandboxes, then answer `200 ready` once the relay has a
 * record for each of them, or `202 provisioning` until then (GET and a repeat activate check again).
 * A failure stays on the record as `error`, and the record stays `provisioning` for a retry. A
 * refusal no retry can fix (a 400 such as `sandboxes_count_exceeded`, or `422 workload_refused`)
 * stays the same way: the revision is frozen, so DELETE is the way out (docs/context-service.md).
 */
async function provision(
  record: WorkloadRecord,
  store: WorkloadStore,
  userToken: string,
  res: ServerResponse,
): Promise<void> {
  const sandboxes = record.sandboxes!;
  try {
    assertProvisionerSettings();
    await provisionSandboxes(
      { name: record.name, generation: record.generation, userToken },
      { count: sandboxes.count, tier: sandboxes.tier, revision: record.revision! },
    );
  } catch (err) {
    const error =
      err instanceof ProvisionerError ? (err.code ?? 'provisioner_error') : 'internal_error';
    // Best effort: the refusal below is the answer whether or not the error is recorded.
    await transition(store, record, { ...record, error }).catch(() => false);
    return sendFailure(res, 'provision', err);
  }
  try {
    const { error: _cleared, ...current } = record;
    const [view, status] = await settleProvisioning(store, current as WorkloadRecord, record);
    send(res, status, view);
  } catch (err) {
    sendFailure(res, 'provision', err);
  }
}

/**
 * Move a `provisioning` record to `ready` once all its sandboxes have attached. `from` is the stored
 * record the compare-and-set expects; `next` is what to keep when not every sandbox is there yet.
 */
async function settleProvisioning(
  store: WorkloadStore,
  next: WorkloadRecord,
  from: WorkloadRecord = next,
): Promise<[ReturnType<typeof publicView>, number]> {
  const ready = await countAttached(store, next);
  if (ready >= next.sandboxes!.count) {
    // A ready workload carries no error: an earlier failed PUT is history once every sandbox is up.
    const { error: _stale, ...rest } = next;
    const active: WorkloadRecord = { ...rest, status: 'ready' };
    if (!(await transition(store, from, active))) throw new WorkloadStateChangedError();
    return [publicView(active), 200];
  }
  if (from.error !== next.error && !(await transition(store, from, next))) {
    throw new WorkloadStateChangedError();
  }
  return [publicView(next, ready), 202];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delete the workload's sandboxes and wait, up to MOCA_PROVISIONER_DELETE_WAIT_MS, until no pod of
 * it remains. False when pods are still terminating after that: the caller answers 202 and the
 * owner's next DELETE continues.
 */
async function sandboxesGone(record: WorkloadRecord, userToken: string): Promise<boolean> {
  assertProvisionerSettings();
  if (!provisionerConfigured())
    throw new Error('MOCA_PROVISIONER_URL is required to delete sandboxes');
  const ref = { name: record.name, generation: record.generation, userToken };
  const deadline = Date.now() + positiveIntEnv('MOCA_PROVISIONER_DELETE_WAIT_MS', 60_000);
  for (;;) {
    if (await deleteSandboxes(ref)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

async function deleteWorkload(
  record: WorkloadRecord | null,
  store: WorkloadStore,
  userToken: string,
  res: ServerResponse,
): Promise<void> {
  if (!record || record.status === 'deleted')
    return send(res, 404, { error: 'workload_not_found' });
  try {
    // A `deleting` record is a delete (or a create rollback) that failed midway: retry it.
    const deleting: WorkloadRecord = { ...record, status: 'deleting' };
    if (record.status !== 'deleting' && !(await transition(store, record, deleting))) {
      throw new WorkloadStateChangedError();
    }
    // Sandboxes first, and only then the Context: Context Service refuses to delete a claim a pod
    // still mounts (spec §6.1). Each step tolerates "already gone", so a retry finishes the rest.
    if (record.sandboxes && !(await sandboxesGone(record, userToken))) {
      return send(res, 202, publicView(deleting));
    }
    // Even while `creating`: the create may already have made the Context. An absent one is fine.
    await deleteContext(record.contextName, record.owner);
    evictContextBundles(record.contextName, record.owner);
    if (!(await transition(store, deleting, { ...deleting, status: 'deleted' }))) {
      const current = await findWorkload(store, record.owner, record.name);
      // A concurrent retry finished the same delete.
      if (current?.generation !== record.generation || current.status !== 'deleted') {
        throw new WorkloadStateChangedError();
      }
    }
    send(res, 204);
  } catch (err) {
    sendFailure(res, 'delete', err);
  }
}

/** What a run needs from a workload, or the refusal to answer with. */
export type WorkloadRun =
  | {
      contextName: string;
      revision: string;
      cacheScope: string;
      /** Set for a workload with sandboxes of its own: the run selects only those (spec §3.3). */
      sandboxes?: { workload: string; ownerScope: string };
    }
  | { status: number; error: 'workload_not_found' | 'workload_not_ready' };

/**
 * Resolve the workload a run names. Only `owner`'s own records are read, so another user's workload
 * is `workload_not_found`, exactly like a missing one.
 */
export async function resolveWorkloadRun(
  store: WorkloadStore,
  owner: string,
  workloadId: unknown,
): Promise<WorkloadRun> {
  const record =
    typeof workloadId === 'string' && NAME.test(workloadId)
      ? await findWorkload(store, owner, workloadId)
      : null;
  if (!record || record.status === 'deleted') return { status: 404, error: 'workload_not_found' };
  if (record.status !== 'ready' || !record.revision || !REVISION.test(record.revision)) {
    return { status: 409, error: 'workload_not_ready' };
  }
  return {
    contextName: record.contextName,
    revision: record.revision,
    cacheScope: sandboxCacheScope(owner),
    ...(record.sandboxes
      ? { sandboxes: { workload: record.contextName, ownerScope: recordScope(owner) } }
      : {}),
  };
}

type Route = 'create' | 'get' | 'delete' | 'uploads' | 'activate';

function routeFor(method: string | undefined, id?: string, action?: string): Route | null {
  if (!id) return method === 'POST' ? 'create' : null;
  if (action) return method === 'POST' ? (action as Route) : null;
  if (method === 'GET') return 'get';
  if (method === 'DELETE') return 'delete';
  return null;
}

/** Handles every request under `/workloads`. `path` excludes the query string. */
export async function handleWorkloads(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: WorkloadDeps,
): Promise<void> {
  if (!workloadsEnabled()) return send(res, 501, { error: 'workloads_unavailable' });
  const match = /^\/workloads(?:\/([^/]+)(?:\/(uploads|activate))?)?$/.exec(path);
  if (!match) return send(res, 404, { error: 'not_found' });
  const route = routeFor(req.method, match[1], match[2]);
  if (!route) return send(res, 405, { error: 'method_not_allowed' });

  let owner: string;
  try {
    owner = authenticateApiCaller(req.headers, deps.authDeps());
  } catch (err) {
    if (!(err instanceof CpError)) throw err;
    return send(res, statusFor(err.code), {
      error: err.code,
      ...(err.message && err.message !== err.code ? { message: err.message } : {}),
    });
  }
  try {
    assertContextServiceSettings();
    assertProvisionerSettings();
  } catch (err) {
    console.error('workloads are misconfigured:', err);
    return send(res, 500, { error: 'workloads_misconfigured' });
  }

  let body: unknown;
  if (route === 'create' || route === 'activate') {
    try {
      body = await readJson(req);
    } catch (err) {
      if (err instanceof BodyError) return send(res, err.status, { error: err.code });
      throw err;
    }
  }
  const store = deps.store();
  if (route === 'create') return createWorkload(body, owner, store, res);

  let name: string;
  try {
    name = decodeURIComponent(match[1]!);
  } catch {
    return send(res, 404, { error: 'workload_not_found' });
  }
  // Only the caller's own records are ever read, so another user's name looks absent.
  const record = NAME.test(name) ? await findWorkload(store, owner, name) : null;
  // Forwarded to the provisioner, which verifies it itself and takes the owner from it (spec §4.1).
  const userToken = bearerOf(req);
  switch (route) {
    case 'get':
      return getWorkload(record, store, res);
    case 'uploads':
      return createUpload(record, res);
    case 'activate':
      return activateWorkload(body, record, store, userToken, res);
    case 'delete':
      return deleteWorkload(record, store, userToken, res);
  }
}

/** The presented bearer; authenticateApiCaller has already verified it. */
function bearerOf(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  return (Array.isArray(raw) ? raw[0] : raw)?.replace(/^bearer\s+/i, '').trim() ?? '';
}

/**
 * A `provisioning` record is moved to `ready` here once all its sandboxes have attached (spec §6.1
 * step 4), by the same compare-and-set as every other transition. Nothing else is ever written.
 */
async function getWorkload(
  record: WorkloadRecord | null,
  store: WorkloadStore,
  res: ServerResponse,
): Promise<void> {
  if (!record) return send(res, 404, { error: 'workload_not_found' });
  if (record.status !== 'provisioning') return send(res, 200, publicView(record));
  try {
    const [view] = await settleProvisioning(store, record);
    send(res, 200, view);
  } catch (err) {
    sendFailure(res, 'get', err);
  }
}
