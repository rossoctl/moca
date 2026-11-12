/**
 * The sandbox resource's store (SBX0 spec §5). This file is the contract and its in-memory model;
 * RedisSandboxStore (sandbox-redis.ts) is the production one, and
 * test/helpers/sandbox-store-contract.ts runs the same suite against both.
 *
 * Expiry is COMPUTED, never scheduled (§5.2): a record past its expiresAt reads as terminated/expired
 * on every path, so no job has to run for an expired sandbox to stop minting.
 */

/**
 * How the worker runs a sandbox's Execs (lease-mode spec §8.1): the vmpool `Mode.String()` names, as
 * the record and the sandbox token carry them. Named apart from the proto enum `SandboxMode`.
 */
export type SandboxModeName = 'per-exec' | 'lease' | 'lease+processes';

export const SANDBOX_MODE_NAMES: readonly SandboxModeName[] = [
  'per-exec',
  'lease',
  'lease+processes',
];

export const isSandboxModeName = (v: unknown): v is SandboxModeName =>
  (SANDBOX_MODE_NAMES as readonly unknown[]).includes(v);

export interface SandboxRecord {
  id: string;
  owner: string;
  tenant: string;
  /** '' when unnamed. */
  name: string;
  template: string;
  worker: string;
  /**
   * The build the template reference resolved to at creation (template lifecycle spec §9): its
   * manifest hash, or an imported build's id; absent on a record from before tracing.
   */
  buildId?: string;
  wsk: string;
  labels: Record<string, string>;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  /** Set by delete; absent while live or after a plain expiry. */
  deletedAt?: number;
  /** `per-exec` unless the owner picked a lease mode. */
  mode: SandboxModeName;
  /** The owner's lease idle timeout in seconds; 0 = the worker's default. */
  idleTimeoutS: number;
  /** Raised by 1 on every setMode, so the worker can refuse an older mode (0 = never set). */
  modeEpoch: number;
}

export type SandboxState = 'ready' | 'terminated';
export type TerminationReason = 'deleted' | 'expired';

export interface SandboxView extends SandboxRecord {
  state: SandboxState;
  reason?: TerminationReason;
  terminatedAt?: number;
}

export function viewOf(rec: SandboxRecord, nowS: number): SandboxView {
  if (rec.deletedAt !== undefined) {
    return { ...rec, state: 'terminated', reason: 'deleted', terminatedAt: rec.deletedAt };
  }
  if (nowS >= rec.expiresAt) {
    return { ...rec, state: 'terminated', reason: 'expired', terminatedAt: rec.expiresAt };
  }
  return { ...rec, state: 'ready' };
}

export interface SandboxLimits {
  perSubject: number;
  total: number;
  retentionS: number;
}

export type CreateOutcome = 'ok' | 'quota_subject' | 'quota_total' | 'name_conflict';
export type DeleteOutcome = 'deleted' | 'already' | 'not_found';

export interface SandboxStore {
  create(rec: SandboxRecord, limits: SandboxLimits, nowS: number): Promise<CreateOutcome>;
  get(id: string, nowS: number): Promise<SandboxRecord | null>;
  /** Newest first, terminated (but retained) records included. */
  listByOwner(owner: string, nowS: number): Promise<SandboxRecord[]>;
  /** Newest first, terminated (but retained) records included. */
  listAll(nowS: number): Promise<SandboxRecord[]>;
  markDeleted(id: string, nowS: number, retentionS: number): Promise<DeleteOutcome>;
  /**
   * Sets mode and idle timeout and raises modeEpoch by 1, atomically, on EVERY call -- the same mode
   * again included. Stores what it is given: the policy bounds are the caller's. Undefined for a
   * missing or deleted sandbox.
   */
  setMode(
    id: string,
    mode: SandboxModeName,
    idleTimeoutS: number,
  ): Promise<SandboxRecord | undefined>;
}

/** Live: not deleted and not yet expired. Quotas and name uniqueness count only these. */
export const isLive = (r: SandboxRecord, nowS: number): boolean =>
  r.deletedAt === undefined && nowS < r.expiresAt;

/** terminatedAt for a record that is not live (viewOf's). */
const endOf = (r: SandboxRecord) => r.deletedAt ?? r.expiresAt;

/** createdAt descending; ties by id descending, which is the Redis ZSET's reverse order. */
const newestFirst = (a: SandboxRecord, b: SandboxRecord) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

type Stored = SandboxRecord & { retentionS: number };

export class MemorySandboxStore implements SandboxStore {
  private readonly recs = new Map<string, Stored>();

  /**
   * Drops records whose retention has run out. The boundary matches Redis: a key with
   * EXPIREAT t is gone at t, so a record is readable while nowS < terminatedAt + retention.
   */
  private purge(nowS: number): void {
    for (const [id, r] of this.recs) {
      if (nowS >= endOf(r) + r.retentionS) this.recs.delete(id);
    }
  }

  private list(nowS: number, keep: (r: SandboxRecord) => boolean): SandboxRecord[] {
    this.purge(nowS);
    return [...this.recs.values()].filter(keep).map(strip).sort(newestFirst);
  }

  // No await before the mutation, so a create is atomic here as the Lua script is in Redis.
  async create(rec: SandboxRecord, limits: SandboxLimits, nowS: number): Promise<CreateOutcome> {
    this.purge(nowS);
    const live = [...this.recs.values()].filter((r) => isLive(r, nowS));
    if (live.length >= limits.total) return 'quota_total';
    const mine = live.filter((r) => r.owner === rec.owner);
    if (mine.length >= limits.perSubject) return 'quota_subject';
    if (rec.name && mine.some((r) => r.name === rec.name)) return 'name_conflict';
    this.recs.set(rec.id, { ...strip(rec), retentionS: limits.retentionS });
    return 'ok';
  }

  async get(id: string, nowS: number): Promise<SandboxRecord | null> {
    this.purge(nowS);
    const r = this.recs.get(id);
    return r ? strip(r) : null;
  }

  async listByOwner(owner: string, nowS: number): Promise<SandboxRecord[]> {
    return this.list(nowS, (r) => r.owner === owner);
  }

  async listAll(nowS: number): Promise<SandboxRecord[]> {
    return this.list(nowS, () => true);
  }

  async markDeleted(id: string, nowS: number, retentionS: number): Promise<DeleteOutcome> {
    this.purge(nowS);
    const r = this.recs.get(id);
    if (!r) return 'not_found';
    if (!isLive(r, nowS)) return 'already';
    r.deletedAt = nowS;
    r.retentionS = retentionS;
    return 'deleted';
  }

  // No await before the mutation, as in create. No purge: there is no caller clock here, and a
  // record past its retention is one that is deleted or expired, which the caller refuses anyway.
  async setMode(
    id: string,
    mode: SandboxModeName,
    idleTimeoutS: number,
  ): Promise<SandboxRecord | undefined> {
    const r = this.recs.get(id);
    if (!r || r.deletedAt !== undefined) return undefined;
    r.mode = mode;
    r.idleTimeoutS = idleTimeoutS;
    r.modeEpoch += 1;
    return strip(r);
  }
}

/** A detached copy without the store's bookkeeping, so callers cannot mutate what is stored. */
function strip(r: SandboxRecord & { retentionS?: number }): SandboxRecord {
  const { retentionS: _retention, ...rest } = r;
  return { ...rest, labels: { ...rest.labels } };
}
