import type { BundleRedisLike } from '@moca/config-bundle';
import type { BundleBudgetRedisLike } from '../../src/bundle-budget.js';
import type { CpRedisLike } from '../../src/ownership.js';
import { CAS_STATE_LUA, RESERVE_RUNNING_LUA } from '../../src/turn-store.js';
import { compareCursor } from '../../src/turn-record.js';
import type { ResultRedisLike } from '../../src/turn-result.js';

/**
 * In-memory CpRedisLike. Reproduces node-redis's REV argument order -- (key, max, min) when REV is
 * set -- on purpose: a fake that accepted either order would let a reversed page ship. `expire` is
 * RECORDED rather than simulated: `expires` is what a test asserts against, so a TTL assertion reads
 * the same way here as against `fakeBundleRedis`.
 */
/** Byte-wise, as Redis compares members of equal score; `localeCompare` would not be. */
const byMember = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  // Plain string keys. Only `leaf:result:<sid>:<turnId>` lives here today -- the leaf result the
  // async status route reads (async spec §4.4), which a test seeds as the worker would have
  // written it.
  const strings = new Map<string, string>();
  const zsets = new Map<string, { score: number; value: string }[]>();
  const streams = new Map<string, Record<string, string>[]>();
  /**
   * The same rows WITH their entry ids, which is what a cursor is. `streams` keeps the bare fields
   * because every audit assertion in this package reads it that way; the field objects are shared,
   * so the two views cannot disagree.
   */
  const entries = new Map<string, { id: string; message: Record<string, string> }[]>();
  let streamSeq = 0;
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
    async hGet(key, field) {
      return hashes.get(key)?.[field] ?? null;
    },
    async zAdd(key, member) {
      ops.push(`zAdd ${key}`);
      const z = zsets.get(key) ?? [];
      zsets.set(key, [...z.filter((m) => m.value !== member.value), member]);
      return 1;
    },
    async zRem(key, member) {
      ops.push(`zRem ${key}`);
      const gone = new Set(Array.isArray(member) ? member : [member]);
      const before = zsets.get(key) ?? [];
      const after = before.filter((m) => !gone.has(m.value));
      zsets.set(key, after);
      // The COUNT actually removed, not 1: `claimGate` is a CAS on this number, so a fake that
      // always claimed success would let two sweepers resume the same gate.
      return before.length - after.length;
    },
    async zRange(key, from, to, opts) {
      if (opts?.BY !== 'SCORE') throw new Error('this fake only serves BY SCORE');
      const [max, min] = opts.REV ? [from, to] : [to, from];
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
        // LIMIT applies AFTER the sort, so the direction decides which page a bounded read gets.
        // Ties broken BY MEMBER, as Redis does -- ascending forward, descending REV. Without it a
        // tie paged in insertion order, so a test could pass on an order real Redis never gives:
        // two gates due in the same millisecond, or two turns created in one.
        .sort((a, b) =>
          opts.REV
            ? b.score - a.score || byMember(b.value, a.value)
            : a.score - b.score || byMember(a.value, b.value),
        );
      if (opts.LIMIT) rows = rows.slice(opts.LIMIT.offset, opts.LIMIT.offset + opts.LIMIT.count);
      return rows.map((m) => m.value);
    },
    // Only the form the turn index uses: ('-inf', <number>), inclusive at the top. A wider fake
    // would be guessing at semantics no caller here asks for.
    async zRemRangeByScore(key, min, max) {
      ops.push(`zRemRangeByScore ${key}`);
      if (String(min) !== '-inf') throw new Error('this fake only sweeps from -inf');
      const hi = Number(max);
      const before = zsets.get(key) ?? [];
      zsets.set(
        key,
        before.filter((m) => m.score > hi),
      );
      return before.length - (zsets.get(key) ?? []).length;
    },
    async del(keys) {
      ops.push(`del ${keys.join(',')}`);
      for (const k of keys) {
        hashes.delete(k);
        zsets.delete(k);
        // STRINGS too, which is where a leaf result lives: without this line every assertion that a
        // session delete removed a stored result passed without the code deleting anything.
        strings.delete(k);
      }
      return keys.length;
    },
    async zScore(key, member) {
      return (zsets.get(key) ?? []).find((m) => m.value === member)?.score ?? null;
    },
    async xAdd(key, id, fields, options) {
      ops.push(`xAdd ${key}`);
      // The id was DISCARDED here before #392, and the id is the cursor -- a fake that minted none
      // could not serve a resume at all. Monotonic across keys, which is all a cursor needs.
      const entryId = id === '*' ? `${++streamSeq}-0` : id;
      const max = options?.TRIM?.threshold;
      // MAXLEN exactly, not `~`: approximating is a free pass a fake does not need, and a test that
      // asserts the log is bounded has to see it bounded. Both views are trimmed together.
      const trim = <T>(rows: T[]): T[] => (max === undefined ? rows : rows.slice(-max));
      streams.set(key, trim([...(streams.get(key) ?? []), fields]));
      entries.set(key, trim([...(entries.get(key) ?? []), { id: entryId, message: fields }]));
      return entryId;
    },
    async xRange(key, start, end, options) {
      const rows = (entries.get(key) ?? []).filter((r) => inIdRange(r.id, start, end));
      return options?.COUNT === undefined ? rows : rows.slice(0, options.COUNT);
    },
    async xRevRange(key, end, start, options) {
      const rows = (entries.get(key) ?? []).filter((r) => inIdRange(r.id, start, end)).reverse();
      return options?.COUNT === undefined ? rows : rows.slice(0, options.COUNT);
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
    // Dispatch on the script's IDENTITY, not on its text: this fake interprets no Lua, and
    // `CpRedisLike.eval` is documented to carry only this package's own exported constants, so an
    // unrecognised one is a programming error rather than something to guess at. Each body mirrors
    // its script exactly -- CAS_STATE_LUA's ARGV is [allowedCount, ...allowedStates, ...field,
    // value], RESERVE_RUNNING_LUA's is [score, member, cap].
    async eval(script, { keys, arguments: argv }) {
      if (script === RESERVE_RUNNING_LUA) {
        ops.push(`eval reserve-running ${keys[0]}`);
        const key = keys[0]!;
        const z = (zsets.get(key) ?? []).filter((m) => m.value !== argv[1]);
        zsets.set(key, [...z, { score: Number(argv[0]), value: argv[1]! }]);
        const n = z.length + 1;
        if (n > Number(argv[2])) zsets.set(key, z);
        return n;
      }
      if (script !== CAS_STATE_LUA) throw new Error(`this fake does not know this script`);
      ops.push(`eval cas ${keys[0]}`);
      const n = Number(argv[0]);
      const h = hashes.get(keys[0]!);
      const state = h?.state;
      if (state === undefined) return 0;
      if (!argv.slice(1, n + 1).includes(state)) return 0;
      const flat = argv.slice(n + 1);
      const next = { ...h };
      for (let i = 0; i < flat.length; i += 2) next[flat[i]!] = flat[i + 1]!;
      hashes.set(keys[0]!, next);
      // The three-element table CAS_STATE_LUA returns to a winner; a loser is still 0 above.
      return [state, next.owner ?? '', next.sessionId ?? ''];
    },
  };
  return { redis, hashes, strings, zsets, streams, entries, ops, expires };
}

/** `-`/`+`/`<id>`/`(<id>` as XRANGE reads them: a bare id inclusive, a `(`-prefixed one not. */
function inIdRange(id: string, start: string, end: string): boolean {
  const lo =
    start === '-' ||
    (start.startsWith('(') ? compareCursor(id, start.slice(1)) > 0 : compareCursor(id, start) >= 0);
  const hi =
    end === '+' ||
    (end.startsWith('(') ? compareCursor(id, end.slice(1)) < 0 : compareCursor(id, end) <= 0);
  return lo && hi;
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
