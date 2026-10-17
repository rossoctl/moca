/**
 * The sandbox resource's store (SBX0 spec §5). This file is the contract and its in-memory model;
 * RedisSandboxStore (sandbox-redis.ts) is the production one, and
 * test/helpers/sandbox-store-contract.ts runs the same suite against both.
 *
 * Expiry is COMPUTED, never scheduled (§5.2): a record past its expiresAt reads as terminated/expired
 * on every path, so no job has to run for an expired sandbox to stop minting.
 */
export interface SandboxRecord {
  id: string;
  owner: string;
  tenant: string;
  /** '' when unnamed. */
  name: string;
  template: string;
  worker: string;
  wsk: string;
  labels: Record<string, string>;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  /** Set by delete; absent while live or after a plain expiry. */
  deletedAt?: number;
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
}

/** A detached copy without the store's bookkeeping, so callers cannot mutate what is stored. */
function strip(r: SandboxRecord & { retentionS?: number }): SandboxRecord {
  const { retentionS: _retention, ...rest } = r;
  return { ...rest, labels: { ...rest.labels } };
}
