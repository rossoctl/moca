import type { BundleRedisLike } from '@moca/config-bundle';
import type { BundleBudgetRedisLike } from '../../src/bundle-budget.js';
import type { CpRedisLike } from '../../src/ownership.js';
import type { ResultRedisLike } from '../../src/turn-result.js';

/**
 * In-memory CpRedisLike. Reproduces node-redis's REV argument order -- (key, max, min) when REV is
 * set -- on purpose: a fake that accepted either order would let a reversed page ship. `expire` is
 * RECORDED rather than simulated: `expires` is what a test asserts against, so a TTL assertion reads
 * the same way here as against `fakeBundleRedis`.
 */
export function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  // Plain string keys. Only `leaf:result:<sid>` lives here today -- the leaf result the async status
  // route reads (async spec §4.4), which a test seeds as the worker would have written it.
  const strings = new Map<string, string>();
  const zsets = new Map<string, { score: number; value: string }[]>();
  const streams = new Map<string, Record<string, string>[]>();
  const ops: string[] = [];
  const expires: { key: string; seconds: number }[] = [];
  const redis: CpRedisLike & ResultRedisLike = {
    async hSet(key, values) {
      ops.push(`hSet ${key}`);
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...values });
      return 1;
    },
    async hIncrBy(key, field, by) {
      // The field name is recorded too: `turns` must move by HINCRBY and never by the merging hSet,
      // and an op log that said only `hIncrBy <key>` could not tell those apart.
      ops.push(`hIncrBy ${key} ${field}`);
      const h = hashes.get(key) ?? {};
      const next = (Number(h[field]) || 0) + by;
      hashes.set(key, { ...h, [field]: String(next) });
      return next;
    },
    async hGetAll(key) {
      return { ...(hashes.get(key) ?? {}) };
    },
    async zAdd(key, member) {
      ops.push(`zAdd ${key}`);
      const z = zsets.get(key) ?? [];
      zsets.set(key, [...z.filter((m) => m.value !== member.value), member]);
      return 1;
    },
    async zRem(key, member) {
      ops.push(`zRem ${key}`);
      zsets.set(
        key,
        (zsets.get(key) ?? []).filter((m) => m.value !== member),
      );
      return 1;
    },
    async zRange(key, max, min, opts) {
      if (!opts?.REV || opts.BY !== 'SCORE') throw new Error('this fake only serves REV BY SCORE');
      const parse = (v: number | string) => {
        const s = String(v);
        if (s === '+inf') return { bound: Infinity, exclusive: false };
        if (s === '-inf') return { bound: -Infinity, exclusive: false };
        return s.startsWith('(')
          ? { bound: Number(s.slice(1)), exclusive: true }
          : { bound: Number(s), exclusive: false };
      };
      const hi = parse(max);
      const lo = parse(min);
      let rows = [...(zsets.get(key) ?? [])]
        .filter((m) => (hi.exclusive ? m.score < hi.bound : m.score <= hi.bound))
        .filter((m) => (lo.exclusive ? m.score > lo.bound : m.score >= lo.bound))
        .sort((a, b) => b.score - a.score);
      if (opts.LIMIT) rows = rows.slice(opts.LIMIT.offset, opts.LIMIT.offset + opts.LIMIT.count);
      return rows.map((m) => m.value);
    },
    async del(keys) {
      ops.push(`del ${keys.join(',')}`);
      for (const k of keys) {
        hashes.delete(k);
        zsets.delete(k);
      }
      return keys.length;
    },
    async zScore(key, member) {
      return (zsets.get(key) ?? []).find((m) => m.value === member)?.score ?? null;
    },
    async xAdd(key, _id, fields) {
      ops.push(`xAdd ${key}`);
      streams.set(key, [...(streams.get(key) ?? []), fields]);
      return '1-0';
    },
    async hSetNX(key, field, value) {
      ops.push(`hSetNX ${key} ${field}`);
      const h = hashes.get(key) ?? {};
      if (h[field] !== undefined) return false;
      hashes.set(key, { ...h, [field]: value });
      return true;
    },
    async expire(key, seconds) {
      // RECORDED, not simulated: `expires` is what a test asserts against, and a fake that actually
      // dropped the key on a timer would make the TTL-ordering assertion a race.
      ops.push(`expire ${key}`);
      expires.push({ key, seconds });
      return 1;
    },
    async zCard(key) {
      return (zsets.get(key) ?? []).length;
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
  };
  return { redis, hashes, strings, zsets, streams, ops, expires };
}

/** Parse a node-redis score bound: a number, '+inf'/'-inf', or '(' for exclusive. */
function scoreBound(v: number | string): { bound: number; exclusive: boolean } {
  const s = String(v);
  if (s === '+inf') return { bound: Infinity, exclusive: false };
  if (s === '-inf') return { bound: -Infinity, exclusive: false };
  return s.startsWith('(')
    ? { bound: Number(s.slice(1)), exclusive: true }
    : { bound: Number(s), exclusive: false };
}

/** In-memory BundleRedisLike + the budget surface, for the bundle upload route. */
export function fakeBundleRedis(): BundleRedisLike &
  BundleBudgetRedisLike & {
    store: Map<string, string>;
    zsets: Map<string, Map<string, number>>;
    hashes: Map<string, Map<string, string>>;
    expires: { key: string; seconds: number }[];
  } {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const expires: { key: string; seconds: number }[] = [];
  const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!;
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  const inRange = (score: number, min: number | string, max: number | string) => {
    const lo = scoreBound(min);
    const hi = scoreBound(max);
    return (
      (lo.exclusive ? score > lo.bound : score >= lo.bound) &&
      (hi.exclusive ? score < hi.bound : score <= hi.bound)
    );
  };
  return {
    store,
    zsets,
    hashes,
    expires,
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async expire(key, seconds) {
      expires.push({ key, seconds });
      // Like EXPIRE: 0 for a key that does not exist.
      return store.has(key) || (zsets.get(key)?.size ?? 0) > 0 || (hashes.get(key)?.size ?? 0) > 0
        ? 1
        : 0;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async zAdd(key, member) {
      z(key).set(member.value, member.score);
      return 1;
    },
    async zRange(key, min, max, opts) {
      if (opts?.BY !== 'SCORE') throw new Error('this fake only serves BY SCORE');
      return [...z(key)]
        .filter(([, score]) => inRange(score, min, max))
        .sort((a, b) => a[1] - b[1])
        .map(([v]) => v);
    },
    async zRangeWithScores(key, min, max, opts) {
      if (opts?.BY !== 'SCORE') throw new Error('this fake only serves BY SCORE');
      return [...z(key)]
        .filter(([, score]) => inRange(score, min, max))
        .sort((a, b) => a[1] - b[1])
        .map(([value, score]) => ({ value, score }));
    },
    async zRem(key, member) {
      z(key).delete(member);
      return 1;
    },
    async zRemRangeByScore(key, min, max) {
      for (const [v, score] of z(key)) if (inRange(score, min, max)) z(key).delete(v);
      return 1;
    },
    async hSet(key, values) {
      for (const [f, v] of Object.entries(values)) h(key).set(f, v);
      return 1;
    },
    async hmGet(key, fields) {
      if (fields.length === 0) throw new Error('ERR wrong number of arguments for HMGET');
      return fields.map((f) => h(key).get(f) ?? null);
    },
    async hDel(key, fields) {
      for (const f of fields) h(key).delete(f);
      return fields.length;
    },
  };
}
