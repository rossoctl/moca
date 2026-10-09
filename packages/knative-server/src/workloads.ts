import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CpError, statusFor } from '@moca/control-plane';
import {
  assertContextServiceSettings,
  contextServiceConfigured,
  ContextServiceError,
  createContext,
  createUploadGrant,
  deleteContext,
  freezeContext,
  type ContextStorage,
} from './context-service.js';
import { authenticateApiCaller, type TurnAuthDeps } from './turn-auth.js';

/**
 * The `/workloads` lifecycle: an owner-bound logical workload backed by one Context Service Context.
 * Moca stores the record; the client uploads its bundle straight to Context Service with a one-time
 * grant; activation freezes the uploaded revision. Running on a workload is a later change.
 *
 * Names are scoped per owner (the first half of rossoctl/moca#358, per-user PVC authorization): the
 * record key includes a hash of the owner, so two users may both own `demo`, and another user's
 * workload is indistinguishable from a missing one.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_BODY_BYTES = 1024 * 1024;
const NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 50;
const REVISION = /^[a-f0-9]{64}$/;
// Context Service requires an uploaded bundle's type to match its Context's.
const CONTEXT_TYPES = new Set(['workspace', 'state', 'memory', 'knowledge', 'artifacts']);
const CREATE_FIELDS = new Set(['name', 'contextType', 'workspace']);
const WORKSPACE_FIELDS = new Set(['size', 'storageClass']);

type WorkloadStatus = 'creating' | 'awaiting_upload' | 'ready' | 'deleting' | 'deleted';

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

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerScope = (owner: string) => sha256(owner).slice(0, 32);
const recordKey = (owner: string, name: string) => `sh:workload:${ownerScope(owner)}:${name}`;
const quotaKey = (owner: string) => `sh:workload-quota:${ownerScope(owner)}`;
/** Unique per owner, name and reservation, so a rollback can never delete a newer Context. */
const contextNameFor = (owner: string, name: string, generation: string) =>
  `w-${sha256(`${owner}\0${name}\0${generation}`).slice(0, 32)}`;

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

function publicView(record: WorkloadRecord) {
  return {
    workloadId: record.name,
    status: record.status,
    contextType: record.contextType,
    workspace: record.workspace,
    ...(record.revision ? { revision: record.revision } : {}),
  };
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
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
  if (Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
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

  const generation = randomUUID();
  const reserved: WorkloadRecord = {
    name,
    owner,
    generation,
    contextName: contextNameFor(owner, name, generation),
    status: 'creating',
    contextType,
    workspace: storage,
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
    await deleteContext(reserved.contextName, reserved.owner).catch((err: unknown) => {
      cleaned = false;
      console.error('workload create rollback could not delete its Context:', err);
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
  res: ServerResponse,
): Promise<void> {
  const revision = isObject(body) ? body.revision : undefined;
  if (typeof revision !== 'string' || !REVISION.test(revision)) {
    return send(res, 400, { error: 'revision_invalid' });
  }
  if (!record || record.status === 'deleted')
    return send(res, 404, { error: 'workload_not_found' });
  if (record.status === 'ready') {
    return record.revision === revision
      ? send(res, 200, publicView(record))
      : send(res, 409, { error: 'workload_already_active' });
  }
  if (record.status !== 'awaiting_upload') {
    return send(res, 409, { error: 'workload_not_activatable' });
  }
  try {
    const context = await freezeContext(record.contextName, revision, record.owner);
    if (context.contextId !== record.contextId || context.frozenRevision !== revision) {
      throw new ContextServiceError('Context Service froze a different Context or revision');
    }
    const ready: WorkloadRecord = { ...record, status: 'ready', revision };
    if (!(await transition(store, record, ready))) throw new WorkloadStateChangedError();
    send(res, 200, publicView(ready));
  } catch (err) {
    sendFailure(res, 'activate', err);
  }
}

async function deleteWorkload(
  record: WorkloadRecord | null,
  store: WorkloadStore,
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
    // Even while `creating`: the create may already have made the Context. An absent one is fine.
    await deleteContext(record.contextName, record.owner);
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
  switch (route) {
    case 'get':
      return record
        ? send(res, 200, publicView(record))
        : send(res, 404, { error: 'workload_not_found' });
    case 'uploads':
      return createUpload(record, res);
    case 'activate':
      return activateWorkload(body, record, store, res);
    case 'delete':
      return deleteWorkload(record, store, res);
  }
}
