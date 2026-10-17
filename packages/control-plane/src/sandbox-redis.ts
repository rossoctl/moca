import { CpError } from './errors.js';
import type {
  CreateOutcome,
  DeleteOutcome,
  SandboxLimits,
  SandboxRecord,
  SandboxStore,
} from './sandbox-store.js';
import { subjectHash } from './subject-document.js';

/**
 * The production SandboxStore (SBX0 spec §5.5). Every check-and-mutate is ONE Lua script, so two
 * creates racing for a subject's last slot cannot both pass the quota count (§5.3).
 *
 * Liveness is judged from the caller's `nowS` against stored scores, never from Redis TIME or from
 * whether a key still exists: the `live` ZSET (id -> expiresAt) is the truth for quotas and for name
 * uniqueness, which keeps this store and MemorySandboxStore in step under one injected clock. Key
 * TTLs are retention only: the record hash lives until terminatedAt + retention (EXPIREAT on create,
 * EXPIRE on delete), the name key until expiresAt + retention (PXAT). The name key's TTL never
 * decides liveness, so a Redis clock running ahead cannot free a name whose holder is still live.
 *
 * Subjects appear in key names only as subjectHash, as ownerKey does, so the keyspace names no logins.
 *
 * Narrow on purpose, as RefreshRedisLike is: CpRedisLike's fake cannot run Lua, so this takes only
 * what it calls, and test/sandbox-redis.test.ts runs it against a real Redis.
 */
export interface SandboxRedisLike {
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  zRange(
    key: string,
    min: number | string,
    max: number | string,
    opts: { BY: 'SCORE' },
  ): Promise<string[]>;
  zRem(key: string, members: string[]): Promise<unknown>;
}

export const DEFAULT_SANDBOX_PREFIX = 'sbx:';

// KEYS: live, owner, all, rec, name (a placeholder when unnamed).
// ARGV: now, expiresAt, perSubject, total, retention, id, createdAt, hasName, nameGcAtMs,
// field1, value1, ...
// The name key only says WHO last took the name; `live` alone says whether that holder is still
// live at `now`, exactly as in the memory model. Its PXAT is (expiresAt + retention), garbage
// collection only: a holder expired by the caller's clock frees the name though the key remains,
// and a Redis clock running ahead cannot drop the key while the holder is still live.
const CREATE = `
local now = tonumber(ARGV[1]); local exp = tonumber(ARGV[2])
local per = tonumber(ARGV[3]); local tot = tonumber(ARGV[4]); local ret = tonumber(ARGV[5])
local id = ARGV[6]; local created = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ret)
if redis.call('ZCOUNT', KEYS[1], '(' .. ARGV[1], '+inf') >= tot then return 'quota_total' end
local n = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  local s = redis.call('ZSCORE', KEYS[1], m)
  if s and tonumber(s) > now then n = n + 1 end
end
if n >= per then return 'quota_subject' end
if ARGV[8] == '1' then
  local holder = redis.call('GET', KEYS[5])
  if holder then
    local s = redis.call('ZSCORE', KEYS[1], holder)
    if s and tonumber(s) > now then return 'name_conflict' end
  end
end
local fields = {}
for i = 10, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('HSET', KEYS[4], unpack(fields))
redis.call('EXPIREAT', KEYS[4], exp + ret)
redis.call('ZADD', KEYS[1], exp, id)
redis.call('ZADD', KEYS[2], created, id)
redis.call('ZADD', KEYS[3], created, id)
if ARGV[8] == '1' then redis.call('SET', KEYS[5], id, 'PXAT', ARGV[9]) end
return 'ok'
`;

// KEYS: rec, live, name (a placeholder when unnamed).
// ARGV: now, retention, id, hasName.
const DELETE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'not_found' end
if redis.call('HEXISTS', KEYS[1], 'deletedAt') == 1 then return 'already' end
local now = tonumber(ARGV[1]); local ret = tonumber(ARGV[2])
if now >= tonumber(redis.call('HGET', KEYS[1], 'expiresAt')) then return 'already' end
redis.call('HSET', KEYS[1], 'deletedAt', ARGV[1])
redis.call('EXPIRE', KEYS[1], ret)
redis.call('ZREM', KEYS[2], ARGV[3])
if ARGV[4] == '1' and redis.call('GET', KEYS[3]) == ARGV[3] then redis.call('DEL', KEYS[3]) end
return 'deleted'
`;

export class RedisSandboxStore implements SandboxStore {
  constructor(
    private readonly redis: SandboxRedisLike,
    private readonly prefix: string = DEFAULT_SANDBOX_PREFIX,
  ) {}

  private recKey = (id: string) => `${this.prefix}sandbox:${id}`;
  private ownerKey = (subject: string) => `${this.prefix}owner:${subjectHash(subject)}`;
  private nameKey = (subject: string, name: string) =>
    `${this.prefix}name:${subjectHash(subject)}:${name}`;
  private get liveKey() {
    return `${this.prefix}live`;
  }
  private get allKey() {
    return `${this.prefix}all`;
  }
  /** Stands in for the name key when a sandbox is unnamed; the scripts never touch it. */
  private get noneKey() {
    return `${this.prefix}none`;
  }

  /** A Redis transport failure is `redis_unavailable` (503), as RedisRefreshStore.guard maps it. */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof CpError) throw err;
      console.error('[control-plane] sandbox store error:', (err as Error)?.message);
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  create(rec: SandboxRecord, l: SandboxLimits, nowS: number): Promise<CreateOutcome> {
    return this.guard(async () => {
      const fields = Object.entries(toHash(rec)).flat();
      return (await this.redis.eval(CREATE, {
        keys: [
          this.liveKey,
          this.ownerKey(rec.owner),
          this.allKey,
          this.recKey(rec.id),
          rec.name ? this.nameKey(rec.owner, rec.name) : this.noneKey,
        ],
        arguments: [
          String(nowS),
          String(rec.expiresAt),
          String(l.perSubject),
          String(l.total),
          String(l.retentionS),
          rec.id,
          String(rec.createdAt),
          rec.name ? '1' : '0',
          String((rec.expiresAt + l.retentionS) * 1000),
          ...fields,
        ],
      })) as CreateOutcome;
    });
  }

  /** `nowS` is unused: retention is the record key's TTL, so Redis does the purge. */
  get(id: string, _nowS?: number): Promise<SandboxRecord | null> {
    return this.guard(() => this.read(id));
  }

  private async read(id: string): Promise<SandboxRecord | null> {
    return fromHash(await this.redis.hGetAll(this.recKey(id)));
  }

  /** Reads every id, and drops from `indexes` the ids whose record the TTL already took. */
  private async readAll(ids: string[], indexes: string[]): Promise<SandboxRecord[]> {
    const recs = await Promise.all(ids.map((id) => this.read(id)));
    const gone = ids.filter((_, i) => recs[i] === null);
    if (gone.length) await Promise.all(indexes.map((k) => this.redis.zRem(k, gone)));
    return recs.filter((r): r is SandboxRecord => r !== null);
  }

  /** An index scored by createdAt, newest first; members whose record is gone are pruned. */
  private readIndex(key: string): Promise<SandboxRecord[]> {
    return this.guard(async () => {
      const ids = (await this.redis.zRange(key, '-inf', '+inf', { BY: 'SCORE' })).reverse();
      return this.readAll(ids, [key]);
    });
  }

  listByOwner(owner: string, _nowS?: number): Promise<SandboxRecord[]> {
    return this.readIndex(this.ownerKey(owner));
  }

  listAll(_nowS?: number): Promise<SandboxRecord[]> {
    return this.readIndex(this.allKey);
  }

  markDeleted(id: string, nowS: number, retentionS: number): Promise<DeleteOutcome> {
    return this.guard(async () => {
      // Read first only to learn the name key; the script re-checks everything atomically.
      const r = await this.read(id);
      if (!r) return 'not_found';
      return (await this.redis.eval(DELETE, {
        keys: [
          this.recKey(id),
          this.liveKey,
          r.name ? this.nameKey(r.owner, r.name) : this.noneKey,
        ],
        arguments: [String(nowS), String(retentionS), id, r.name ? '1' : '0'],
      })) as DeleteOutcome;
    });
  }
}

function toHash(r: SandboxRecord): Record<string, string> {
  return {
    id: r.id,
    owner: r.owner,
    tenant: r.tenant,
    name: r.name,
    template: r.template,
    worker: r.worker,
    wsk: r.wsk,
    labels: JSON.stringify(r.labels),
    createdAt: String(r.createdAt),
    expiresAt: String(r.expiresAt),
  };
}

function fromHash(h: Record<string, string>): SandboxRecord | null {
  if (!h.id) return null;
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(h.labels ?? '{}') as Record<string, string>;
  } catch {
    labels = {};
  }
  return {
    id: h.id,
    owner: h.owner ?? '',
    tenant: h.tenant ?? '',
    name: h.name ?? '',
    template: h.template ?? '',
    worker: h.worker ?? '',
    wsk: h.wsk ?? '',
    labels,
    createdAt: Number(h.createdAt),
    expiresAt: Number(h.expiresAt),
    ...(h.deletedAt !== undefined ? { deletedAt: Number(h.deletedAt) } : {}),
  };
}
