import { randomUUID } from 'node:crypto';
import { CpError } from './errors.js';
import { ANON_AUDIT_MAXLEN, AUDIT_MAXLEN } from './ownership.js';
import {
  hashRefreshToken,
  MAX_LABEL_CHARS,
  newRefreshToken,
  type IssueInput,
  type Issued,
  type RefreshPolicy,
  type RefreshStore,
  type RefusalReason,
  type RotateResult,
} from './refresh-store.js';
import { subjectHash } from './subject-document.js';

/**
 * The production RefreshStore (B14 spec §4). Each state change -- its checks, its mutation and its
 * audit entry -- is ONE Lua script, so a refresh can never rotate unaudited, audit without rotating,
 * or let two concurrent callers both rotate the same token.
 *
 * Narrow on purpose: CpRedisLike's in-memory fake cannot run Lua, so this takes only what it calls,
 * and test/refresh-redis.test.ts runs it against a real Redis.
 *
 * The clock is the caller's `nowMs`, never Redis TIME, and expiry is judged from stored fields. Every
 * PEXPIRE/PX below is garbage collection only -- which is what lets the shared contract suite drive
 * this and MemoryRefreshStore with one injected clock.
 */
export interface RefreshRedisLike {
  get(key: string): Promise<string | null>;
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  xAdd(
    key: string,
    id: string,
    fields: Record<string, string>,
    options?: { TRIM: { strategy: 'MAXLEN'; strategyModifier: '~'; threshold: number } },
  ): Promise<unknown>;
  zRange(key: string, start: number, stop: number): Promise<string[]>;
  zRem(key: string, member: string): Promise<unknown>;
}

export const DEFAULT_REFRESH_PREFIX = 'sh:cp:';

// KEYS: family, token, owner, audit. ARGV: fid, subject, displayName, label, now, absExp, idleExp,
// hash, ttlMs, auditMaxlen.
// The owner set is scored by each family's OWN absExp, never by the current policy: lowering
// SH_REFRESH_MAX_TTL_SECONDS must not unindex families that still work until their stored limit,
// or logout --all would stop ending them (#467). A member scored at or before now is dead: drop it.
// The set's TTL (garbage collection only, from the caller's clock like every TTL here) follows its
// latest member, so it only ever outlives what it indexes.
const ISSUE = `
redis.call('HSET', KEYS[1], 'subject', ARGV[2], 'displayName', ARGV[3], 'label', ARGV[4],
  'createdAt', ARGV[5], 'absExp', ARGV[6], 'idleExp', ARGV[7], 'currentHash', ARGV[8], 'prevHash', '')
redis.call('PEXPIRE', KEYS[1], ARGV[9])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[9])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[5])
redis.call('ZADD', KEYS[3], ARGV[6], ARGV[1])
local latest = redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[3], tonumber(latest[2]) - tonumber(ARGV[5]))
redis.call('XADD', KEYS[4], 'MAXLEN', '~', ARGV[10], '*', 'ts', ARGV[5], 'subject', ARGV[2], 'decision', 'refresh_issued',
  'family', ARGV[1])
return 1
`;

// KEYS: family, newToken, grace, audit, anonAudit. ARGV: presentedHash, newHash, newToken, now,
// idleMs, graceMs, fid, auditMaxlen, anonAuditMaxlen. Returns {'ok', token, absExp, subject, displayName, '0'|'1'} or {reason}.
// The step numbers are B14 spec §4.3's.
const ROTATE = `
local f = redis.call('HMGET', KEYS[1], 'subject', 'displayName', 'absExp', 'idleExp',
  'currentHash', 'prevHash', 'revokedAt')
local now = tonumber(ARGV[4])
local subject = f[1]
local function audit(decision, reason)
  if reason then
    redis.call('XADD', KEYS[4], 'MAXLEN', '~', ARGV[8], '*', 'ts', ARGV[4], 'subject', subject, 'decision', decision,
      'family', ARGV[7], 'reason', reason)
  else
    redis.call('XADD', KEYS[4], 'MAXLEN', '~', ARGV[8], '*', 'ts', ARGV[4], 'subject', subject, 'decision', decision,
      'family', ARGV[7])
  end
end
if not subject then
  -- The token key outlived its family (TTL races): as good as unknown, so the anonymous stream.
  redis.call('XADD', KEYS[5], 'MAXLEN', '~', ARGV[9], '*', 'ts', ARGV[4], 'subject', '-', 'decision', 'refresh_refused',
    'family', '-', 'reason', 'unknown')
  return {'unknown'}
end
if f[7] then audit('refresh_refused', 'revoked'); return {'revoked'} end           -- step 2
local absExp = tonumber(f[3])
if now >= absExp then audit('refresh_refused', 'abs_expired'); return {'abs_expired'} end -- 3
if now >= tonumber(f[4]) then audit('refresh_refused', 'idle_expired'); return {'idle_expired'} end
if ARGV[1] == f[6] then                                                              -- step 4
  local g = redis.call('GET', KEYS[3])
  if g then
    local sep = string.find(g, '|', 1, true)
    if now < tonumber(string.sub(g, 1, sep - 1)) then
      audit('refresh_rotated', 'grace_replay')
      return {'ok', string.sub(g, sep + 1), f[3], subject, f[2], '1'}
    end
  end
end
if ARGV[1] ~= f[5] then                                                              -- step 5
  redis.call('HSET', KEYS[1], 'revokedAt', ARGV[4], 'revokedReason', 'reuse')
  redis.call('DEL', KEYS[3])
  audit('refresh_reuse_detected')
  return {'reuse'}
end
local idleExp = math.min(now + tonumber(ARGV[5]), absExp)                            -- step 6
local ttl = idleExp - now
redis.call('HSET', KEYS[1], 'prevHash', f[5], 'currentHash', ARGV[2], 'idleExp', tostring(idleExp))
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('SET', KEYS[2], ARGV[7], 'PX', ttl)
redis.call('SET', KEYS[3], tostring(now + tonumber(ARGV[6])) .. '|' .. ARGV[3], 'PX', ARGV[6])
audit('refresh_rotated')
return {'ok', ARGV[3], f[3], subject, f[2], '0'}
`;

/** ROTATE's reply: ok + successor, absExp, subject, displayName, grace flag; or a refusal. */
type RotateReply = ['ok', string, string, string, string, '0' | '1'] | [RefusalReason];

// KEYS: family, grace, audit. ARGV: now, fid, reason, auditMaxlen. 1 revoked now, 0 already revoked, -1 gone.
const REVOKE = `
local f = redis.call('HMGET', KEYS[1], 'subject', 'revokedAt')
if not f[1] then return -1 end
if f[2] then return 0 end
redis.call('HSET', KEYS[1], 'revokedAt', ARGV[1], 'revokedReason', ARGV[3])
redis.call('DEL', KEYS[2])
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*', 'ts', ARGV[1], 'subject', f[1], 'decision', 'refresh_revoked',
  'family', ARGV[2], 'reason', ARGV[3])
return 1
`;

export class RedisRefreshStore implements RefreshStore {
  constructor(
    private readonly redis: RefreshRedisLike,
    private readonly policy: RefreshPolicy,
    private readonly prefix: string = DEFAULT_REFRESH_PREFIX,
  ) {}

  private familyKey = (fid: string) => `${this.prefix}refresh:family:${fid}`;
  private tokenKey = (hash: string) => `${this.prefix}refresh:token:${hash}`;
  private graceKey = (fid: string) => `${this.prefix}refresh:grace:${fid}`;
  private ownerKey = (subject: string) => `${this.prefix}owner:${subjectHash(subject)}:families`;
  private get auditKey() {
    return `${this.prefix}audit`;
  }
  private get anonAuditKey() {
    return `${this.prefix}audit:anon`;
  }

  /** A Redis transport failure is `redis_unavailable` (503), as OwnershipIndex.guard maps it. */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof CpError) throw err;
      // The message only -- never arguments, which carry tokens.
      console.error('[control-plane] refresh store error:', (err as Error)?.message);
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  issue(input: IssueInput): Promise<Issued> {
    return this.guard(async () => {
      const family = randomUUID();
      const refreshToken = newRefreshToken();
      const absExp = input.nowMs + this.policy.maxTtlS * 1000;
      const idleExp = Math.min(input.nowMs + this.policy.idleTtlS * 1000, absExp);
      await this.redis.eval(ISSUE, {
        keys: [
          this.familyKey(family),
          this.tokenKey(hashRefreshToken(refreshToken)),
          this.ownerKey(input.subject),
          this.auditKey,
        ],
        arguments: [
          family,
          input.subject,
          input.displayName,
          input.label.slice(0, MAX_LABEL_CHARS),
          String(input.nowMs),
          String(absExp),
          String(idleExp),
          hashRefreshToken(refreshToken),
          String(idleExp - input.nowMs),
          String(AUDIT_MAXLEN),
        ],
      });
      return { family, refreshToken, absExpS: Math.floor(absExp / 1000) };
    });
  }

  rotate(token: string, nowMs: number): Promise<RotateResult> {
    return this.guard(async () => {
      const hash = hashRefreshToken(token);
      const fid = await this.redis.get(this.tokenKey(hash));
      if (!fid) {
        // Anyone can send this, so it goes to the anonymous stream, capped smaller (#467).
        await this.redis.xAdd(
          this.anonAuditKey,
          '*',
          {
            ts: String(nowMs),
            subject: '-',
            decision: 'refresh_refused',
            family: '-',
            reason: 'unknown',
          },
          { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: ANON_AUDIT_MAXLEN } },
        );
        return { ok: false, reason: 'unknown' };
      }
      // Minted before the script so it can be stored atomically; discarded unless step 6 runs.
      const next = newRefreshToken();
      const reply = (await this.redis.eval(ROTATE, {
        keys: [
          this.familyKey(fid),
          this.tokenKey(hashRefreshToken(next)),
          this.graceKey(fid),
          this.auditKey,
          this.anonAuditKey,
        ],
        arguments: [
          hash,
          hashRefreshToken(next),
          next,
          String(nowMs),
          String(this.policy.idleTtlS * 1000),
          String(this.policy.graceS * 1000),
          fid,
          String(AUDIT_MAXLEN),
          String(ANON_AUDIT_MAXLEN),
        ],
      })) as RotateReply;
      if (reply[0] !== 'ok') return { ok: false, reason: reply[0] };
      const [, refreshToken, absExp, subject, displayName, grace] = reply;
      return {
        ok: true,
        family: fid,
        refreshToken,
        absExpS: Math.floor(Number(absExp) / 1000),
        subject,
        displayName,
        graceReplay: grace === '1',
      };
    });
  }

  private revokeFamily(
    fid: string,
    nowMs: number,
    reason: 'logout' | 'logout_all',
  ): Promise<number> {
    return this.redis
      .eval(REVOKE, {
        keys: [this.familyKey(fid), this.graceKey(fid), this.auditKey],
        arguments: [String(nowMs), fid, reason, String(AUDIT_MAXLEN)],
      })
      .then(Number);
  }

  revoke(token: string, nowMs: number): Promise<boolean> {
    return this.guard(async () => {
      const fid = await this.redis.get(this.tokenKey(hashRefreshToken(token)));
      if (!fid) return false;
      return (await this.revokeFamily(fid, nowMs, 'logout')) !== -1;
    });
  }

  revokeAllFor(subject: string, nowMs: number): Promise<number> {
    return this.guard(async () => {
      const owner = this.ownerKey(subject);
      let revoked = 0;
      for (const fid of await this.redis.zRange(owner, 0, -1)) {
        const r = await this.revokeFamily(fid, nowMs, 'logout_all');
        if (r === 1) revoked++;
        // The family's TTL already took it: drop the dangling member (spec §4.2, "pruned on read").
        if (r === -1) await this.redis.zRem(owner, fid);
      }
      return revoked;
    });
  }
}
