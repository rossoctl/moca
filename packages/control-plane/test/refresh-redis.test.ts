import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CpError } from '../src/errors.js';
import {
  DEFAULT_REFRESH_PREFIX,
  RedisRefreshStore,
  type RefreshRedisLike,
} from '../src/refresh-redis.js';
import { hashRefreshToken, type RefreshPolicy } from '../src/refresh-store.js';
import { subjectHash } from '../src/subject-document.js';
import { refreshStoreContract } from './helpers/refresh-store-contract.js';

// Needs Redis on 6379, as work-queue's tests do; CI provides a redis:7 service (.github/workflows/ci.yml).
const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const client = createClient({ url: URL });
const redis = client as unknown as RefreshRedisLike;
beforeAll(async () => void (await client.connect()));
afterAll(async () => void client.destroy());

const T0 = 1_757_000_000_000;
const POLICY: RefreshPolicy = { idleTtlS: 30 * 86_400, maxTtlS: 90 * 86_400, graceS: 30 };

// node-redis types the XRANGE reply as nullable; a missing stream reads as [].
const stream = async (key: string) =>
  ((await client.xRange(key, '-', '+')) ?? []).map((e) => e.message as Record<string, string>);

/** A unique prefix per store, so the suite shares a Redis with anything else without colliding. */
function isolated(policy: RefreshPolicy) {
  const prefix = `test:refresh:${process.pid}:${randomUUID()}:`;
  const store = new RedisRefreshStore(redis, policy, prefix);
  return {
    prefix,
    store,
    audit: () => stream(`${prefix}audit`),
    anonAudit: () => stream(`${prefix}audit:anon`),
    done: async () => {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

refreshStoreContract('redis', async (policy) => isolated(policy));

describe('RedisRefreshStore, Redis-only behaviour', () => {
  it('defaults to the sh:cp: keyspace, so the audit stream is sh:cp:audit', () => {
    expect(DEFAULT_REFRESH_PREFIX).toBe('sh:cp:');
  });

  it('stores only the hash, and sets garbage-collection TTLs on every key', async () => {
    const h = isolated(POLICY);
    try {
      const i = await h.store.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'l',
        nowMs: T0,
      });
      const fam = `${h.prefix}refresh:family:${i.family}`;
      const tok = `${h.prefix}refresh:token:${hashRefreshToken(i.refreshToken)}`;
      expect(await client.get(tok)).toBe(i.family);
      const fields = await client.hGetAll(fam);
      expect(JSON.stringify(fields)).not.toContain(i.refreshToken);
      for (const key of [fam, tok]) {
        const pttl = await client.pTTL(key);
        expect(pttl).toBeGreaterThan(30 * 86_400_000 - 10_000);
        expect(pttl).toBeLessThanOrEqual(30 * 86_400_000);
      }
      const r = await h.store.rotate(i.refreshToken, T0);
      expect(r.ok).toBe(true);
      const grace = await client.pTTL(`${h.prefix}refresh:grace:${i.family}`);
      expect(grace).toBeGreaterThan(0);
      expect(grace).toBeLessThanOrEqual(30_000);
    } finally {
      await h.done();
    }
  });

  it('lets exactly one of two concurrent rotations win; the other gets the same successor', async () => {
    const h = isolated(POLICY);
    try {
      const i = await h.store.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'l',
        nowMs: T0,
      });
      const [a, b] = await Promise.all([
        h.store.rotate(i.refreshToken, T0 + 1000),
        h.store.rotate(i.refreshToken, T0 + 1000),
      ]);
      if (!a.ok || !b.ok)
        throw new Error(`a concurrent rotation was refused: ${JSON.stringify([a, b])}`);
      expect([a.graceReplay, b.graceReplay].sort()).toEqual([false, true]);
      expect(a.refreshToken).toBe(b.refreshToken);
      expect((await h.store.rotate(a.refreshToken, T0 + 2000)).ok).toBe(true);
    } finally {
      await h.done();
    }
  });

  it('prunes owner-set members whose family has already expired', async () => {
    const h = isolated(POLICY);
    try {
      const i = await h.store.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'l',
        nowMs: T0,
      });
      const owner = `${h.prefix}owner:${subjectHash('github:1')}:families`;
      expect(await client.zRange(owner, 0, -1)).toEqual([i.family]);
      await client.del(`${h.prefix}refresh:family:${i.family}`); // what the TTL does eventually
      expect(await h.store.revokeAllFor('github:1', T0)).toBe(0);
      // Redis deletes a zset with its last member, so the pruned owner set reads as empty.
      expect(await client.zRange(owner, 0, -1)).toEqual([]);
    } finally {
      await h.done();
    }
  });

  it('maps a Redis failure to redis_unavailable (503), never an opaque 500', async () => {
    const down: RefreshRedisLike = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      eval: async () => {
        throw new Error('ECONNREFUSED');
      },
      xAdd: async () => {
        throw new Error('ECONNREFUSED');
      },
      zRange: async () => {
        throw new Error('ECONNREFUSED');
      },
      zRem: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const store = new RedisRefreshStore(down, POLICY);
    for (const call of [
      () => store.issue({ subject: 's', displayName: 'd', label: 'l', nowMs: T0 }),
      () => store.rotate('mrt_' + 'A'.repeat(43), T0),
      () => store.revoke('mrt_' + 'A'.repeat(43), T0),
      () => store.revokeAllFor('s', T0),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CpError);
      expect((err as CpError).code).toBe('redis_unavailable');
    }
  });

  it('prunes only families past their OWN absolute expiry, and expires the set with the latest', async () => {
    const h = isolated(POLICY);
    try {
      const owner = `${h.prefix}owner:${subjectHash('github:1')}:families`;
      // Members are scored by absExp: one that expired a moment ago is dead, whatever the policy.
      await client.zAdd(owner, { score: T0 - 1, value: 'dead-fid' });
      const i = await h.store.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'l',
        nowMs: T0,
      });
      expect(await client.zRange(owner, 0, -1)).toEqual([i.family]);
      const pttl = await client.pTTL(owner);
      expect(pttl).toBeGreaterThan(90 * 86_400_000 - 10_000);
      expect(pttl).toBeLessThanOrEqual(90 * 86_400_000);
    } finally {
      await h.done();
    }
  });

  it('keeps live families indexed after the absolute limit is lowered, so logout --all still ends them (#467)', async () => {
    const long = isolated(POLICY); // 90 days
    const prefix = long.prefix;
    // The same keyspace after an operator tightens SH_REFRESH_MAX_TTL_SECONDS to 7 days.
    const short = new RedisRefreshStore(
      redis,
      { idleTtlS: 7 * 86_400, maxTtlS: 7 * 86_400, graceS: 30 },
      prefix,
    );
    try {
      const day = 86_400_000;
      const old = await long.store.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'lost laptop',
        nowMs: T0,
      });
      // Eight days later, past the NEW limit but well inside the old family's own 90-day absExp.
      await short.issue({
        subject: 'github:1',
        displayName: 'Ada',
        label: 'new laptop',
        nowMs: T0 + 8 * day,
      });
      const owner = `${prefix}owner:${subjectHash('github:1')}:families`;
      expect(await client.zRange(owner, 0, -1)).toContain(old.family);
      // The set must outlive the longest-lived member, not shrink to the new 7-day limit.
      expect(await client.pTTL(owner)).toBeGreaterThan(80 * day);
      expect(await short.revokeAllFor('github:1', T0 + 8 * day + 1000)).toBe(2);
      expect(await short.rotate(old.refreshToken, T0 + 8 * day + 2000)).toEqual({
        ok: false,
        reason: 'revoked',
      });
    } finally {
      await long.done();
    }
  });

  it('caps every audit write with MAXLEN ~ AUDIT_MAXLEN (Lua scripts and the unknown-token xAdd)', async () => {
    const scripts: { script: string; args: string[] }[] = [];
    const trims: unknown[] = [];
    const spy: RefreshRedisLike = {
      get: (k) => redis.get(k),
      eval: (script, o) => {
        scripts.push({ script, args: o.arguments });
        return redis.eval(script, o);
      },
      xAdd: (k, id, f, o) => {
        trims.push(o);
        return redis.xAdd(k, id, f, o);
      },
      zRange: (k, a, b) => redis.zRange(k, a, b),
      zRem: (k, m) => redis.zRem(k, m),
    };
    const prefix = `test:refresh:${process.pid}:${randomUUID()}:`;
    const store = new RedisRefreshStore(spy, POLICY, prefix);
    try {
      const a = await store.issue({ subject: 's', displayName: 'd', label: 'l', nowMs: T0 });
      const r = await store.rotate(a.refreshToken, T0 + 1000);
      if (!r.ok) throw new Error('rotate failed');
      await store.revoke(r.refreshToken, T0 + 2000);
      await store.rotate('mrt_' + 'A'.repeat(43), T0 + 3000); // unknown token -> TS xAdd
      expect(scripts).toHaveLength(3);
      for (const { script, args } of scripts) {
        expect(script).toContain("'MAXLEN', '~'");
        expect(args).toContain('1000000');
      }
      // The unknown-token refusal goes to the smaller anonymous stream (#467).
      expect(trims).toEqual([
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100_000 } },
      ]);
      expect(await client.xLen(`${prefix}audit`)).toBe(3);
      expect(await client.xLen(`${prefix}audit:anon`)).toBe(1);
    } finally {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    }
  });
});
