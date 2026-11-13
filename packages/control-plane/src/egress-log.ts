import { createHash } from 'node:crypto';
import { CpError } from './errors.js';
import { canonicalJson } from './provenance.js';

/**
 * Per-sandbox egress records (docs/specs/2026-11-08-sandbox-egress-records-design.md).
 * A KVM host's agent posts the egress proxy's audit events (`moca-egress`, remote-worker
 * internal/egress/audit.go `Event`) as they are; each event whose `sid` is a sandbox's workspace
 * key is appended, in arrival order, to that sandbox's log.
 *
 * What is stored is the event's fields and values as the proxy wrote them, as one canonical JSON
 * line (provenance.ts's canonicalJson; the bytes may differ from the proxy's, e.g. in escaping): an
 * event naming any field the proxy's Event does not is refused, never trimmed, so nothing reaches
 * the log that the proxy did not log.
 *
 * The log's digest is `sha256:` + the hex sha256 of its NDJSON export: every stored line, in
 * arrival order, each followed by one `\n` (the empty log's is the sha256 of no bytes). It is
 * computed from the stored lines when read (Redis's Lua has no sha256), so it is the digest of
 * exactly what `GET …/egress?format=ndjson` returns.
 */

/** The proxy's `Event` fields, by their JSON names (audit.go), and nothing else. */
export const EVENT_STRING_FIELDS = [
  'time',
  'via',
  'vm_id',
  'sid',
  'sub',
  'host',
  'dial_addr',
  'method',
  'path',
  'credential',
  'decision',
] as const;
export const EVENT_INT_FIELDS = [
  'status',
  'bytes_up',
  'bytes_down',
  'dropped',
  'coalesced',
] as const;
export const EVENT_FIELDS: readonly string[] = [...EVENT_STRING_FIELDS, ...EVENT_INT_FIELDS];

/**
 * A sandbox's log holds at most this many events, and at most EGRESS_LOG_BYTES of lines, whichever
 * comes first; later events are counted as dropped (`cap`). A typical CONNECT event is about 317 B
 * in Redis (measured), so about 3 MB per log at this cap.
 */
export const EGRESS_LOG_CAP = 10_000;
/**
 * A sandbox's log holds at most this many bytes of stored lines (4 MiB). A line may be up to
 * 8 KiB and its `host` and `path` come from the guest, so the event cap alone would let one log
 * reach about 80 MB; this cap keeps it near the typical log's size.
 */
export const EGRESS_LOG_BYTES = 4 * 1024 * 1024;
/**
 * All sandboxes' logs together hold at most this many bytes of stored lines (64 MiB): the bound on
 * Redis memory, which SBX0 gives 256 MiB in all (deploy/k8s/base/redis.yaml) for sessions,
 * sandboxes and templates too. Redis's own overhead per stream entry comes on top (a few tens of
 * bytes; egress-redis.test.ts logs what a typical event costs). An event over it is not stored and
 * is counted as dropped (`budget`) in its sandbox's log.
 *
 * The total is a running sum kept by the Lua append, so a post costs the same however many logs are
 * retained: each log's bytes are kept beside an index of the logs by expiry, and when a log's expiry
 * has passed the next append gives its bytes back. The counters change only in the store's scripts.
 */
export const EGRESS_TOTAL_BYTES = 64 * 1024 * 1024;
/** At most this many expired logs are given back by one append (the rest by the next ones). */
export const EGRESS_REAP_MAX = 500;
/** At most this many events in one host post (the host agent sends batches of up to 1000). */
export const EGRESS_POST_MAX = 1000;
/**
 * Events for a sandbox are taken until this long after it ended (deleted or expired), so the
 * last seconds of its egress, still in the host's journal when it ends, reach its log. Then the
 * log is sealed: later events are refused, and the janitor's sweep writes a `sandbox` record
 * with `state: 'egress'` if the log changed after the end record named it.
 */
export const EGRESS_GRACE_S = 600;
/**
 * An `audit_dropped` event names no VM: its count is charged to every sandbox on the posting host's
 * workers that was live at any time in this many seconds before it (the proxy reports drops every
 * 10 s; the margin is deliberate). Conservative: a sandbox that lost nothing may be marked
 * incomplete, never the reverse.
 */
export const EGRESS_DROP_WINDOW_S = 60;
/**
 * One `audit_dropped` report's count is taken up to this many (a larger one counts as this many):
 * the charge goes to every sandbox in the window, so one malformed report must not write a huge
 * count into all of them, nor overflow a counter (Redis HINCRBY) and fail the whole post. A log so
 * charged is incomplete either way.
 */
export const EGRESS_DROP_REPORT_MAX = 1_000_000;
const MAX_STRING = 4096;
const MAX_LINE = 8192;

export type EgressEvent = Record<string, string | number>;

/** The event as the proxy logged it, or null if it is not one (an unknown field, a bad type). */
export function parseEgressEvent(v: unknown): EgressEvent | null {
  if (typeof v !== 'object' || v === null || Object.getPrototypeOf(v) !== Object.prototype) {
    return null;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!EVENT_FIELDS.includes(k)) return null;
  for (const k of EVENT_STRING_FIELDS) {
    if (o[k] !== undefined && (typeof o[k] !== 'string' || (o[k] as string).length > MAX_STRING))
      return null;
  }
  for (const k of EVENT_INT_FIELDS) {
    const n = o[k];
    if (n !== undefined && !(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0))
      return null;
  }
  if (o.via !== 'moca-egress' || typeof o.time !== 'string' || !o.decision) return null;
  return o as EgressEvent;
}

/** The canonical line of an event, or null when it cannot be one (a lone surrogate, too long). */
export function egressLine(e: EgressEvent): string | null {
  try {
    const line = canonicalJson(e);
    return Buffer.byteLength(line) <= MAX_LINE ? line : null;
  } catch {
    return null;
  }
}

/** One sandbox's share of a host post. */
export interface EgressGroup {
  sandboxId: string;
  /** Canonical event lines, in the order posted. */
  lines: string[];
  /** Events an `audit_dropped` report charges to this sandbox. */
  proxyDropped: number;
  /** Events that name this sandbox but are not a proxy Event (refused, and counted as dropped). */
  invalid: number;
  /** When its log expires: the sandbox record's own end of retention, epoch seconds. */
  expireAtS: number;
}

export interface EgressAnswer {
  /** Events stored in a sandbox's log. */
  accepted: number;
  /** Events refused: no sandbox of this host's, not an Event, or after the log was sealed. */
  refused: number;
  /** Events over a log's cap (events or bytes), counted as dropped in that log. */
  capped: number;
  /** Events over the deployment's total budget, counted as dropped in their logs. */
  overBudget: number;
  /** Events naming a sandbox of this host's that were not a proxy Event (dropped in that log). */
  invalid: number;
  /** The events the proxy reported lost (`audit_dropped`), summed, in this post. */
  dropped: number;
  cursor: string;
}

export interface EgressMeta {
  /** Charged by `audit_dropped` reports. */
  proxy: number;
  /** Over the log's cap (EGRESS_LOG_CAP events or EGRESS_LOG_BYTES). */
  cap: number;
  /** Over the total budget (EGRESS_TOTAL_BYTES). */
  budget: number;
  /** Named this sandbox but were not a proxy Event. */
  invalid: number;
  /** Past its grace: takes no more events. */
  sealed: boolean;
}

export interface EgressEntry {
  id: string;
  line: string;
}

export interface EgressStore {
  /**
   * Appends one host post, idempotent by (host, cursor): a post repeating the host's last cursor
   * appends nothing and answers what the first one did. `refused` is counted by the caller.
   */
  append(
    host: string,
    cursor: string,
    groups: EgressGroup[],
    refused: number,
    dropped: number,
  ): Promise<EgressAnswer>;
  /** Up to `limit` entries after `after` (an entry id; null from the start), in arrival order. */
  page(sandboxId: string, after: string | null, limit: number): Promise<EgressEntry[]>;
  meta(sandboxId: string): Promise<EgressMeta>;
  /** Marks the log sealed; true the first time. */
  seal(sandboxId: string, expireAtS: number): Promise<boolean>;
  /** Moves the log's expiry, as a sandbox's deletion moves its record's. */
  expireAt(sandboxId: string, atS: number): Promise<void>;
}

export const ENTRY_ID_RE = /^[0-9]{1,20}-[0-9]{1,20}$/;

/** Stream ids (`<ms>-<seq>`) in Redis's order: by ms, then seq, each a 64-bit number. */
export function compareEntryIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  return am !== bm ? (am < bm ? -1 : 1) : as === bs ? 0 : as < bs ? -1 : 1;
}
const PAGE = 1000;

export interface EgressSummary {
  byHost: Record<
    string,
    { count: number; decisions: Record<string, number>; bytesUp: number; bytesDown: number }
  >;
  total: number;
  dropped: number;
  droppedBy: { proxy: number; cap: number; budget: number; invalid: number };
  complete: boolean;
  sealed: boolean;
  sha256: string;
}

/** Reads the whole log once: its digest (see the header) and its per-host summary. */
export async function summarize(store: EgressStore, sandboxId: string): Promise<EgressSummary> {
  const h = createHash('sha256');
  const byHost: EgressSummary['byHost'] = {};
  let total = 0;
  for await (const line of allLines(store, sandboxId)) {
    h.update(`${line}\n`);
    total += 1;
    const e = JSON.parse(line) as EgressEvent;
    const host = typeof e.host === 'string' ? e.host : '';
    const s = (byHost[host] ??= { count: 0, decisions: {}, bytesUp: 0, bytesDown: 0 });
    s.count += 1;
    const d = String(e.decision);
    s.decisions[d] = (s.decisions[d] ?? 0) + 1;
    s.bytesUp += Number(e.bytes_up ?? 0);
    s.bytesDown += Number(e.bytes_down ?? 0);
  }
  const m = await store.meta(sandboxId);
  const dropped = m.proxy + m.cap + m.budget + m.invalid;
  return {
    byHost,
    total,
    dropped,
    droppedBy: { proxy: m.proxy, cap: m.cap, budget: m.budget, invalid: m.invalid },
    complete: dropped === 0,
    sealed: m.sealed,
    sha256: `sha256:${h.digest('hex')}`,
  };
}

/** Every stored line, in arrival order, read a page at a time. */
export async function* allLines(store: EgressStore, sandboxId: string): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const page = await store.page(sandboxId, after, PAGE);
    for (const e of page) yield e.line;
    if (page.length < PAGE) return;
    after = page[page.length - 1]!.id;
  }
}

/** A store's caps: events and bytes per log, and bytes across all logs. */
export interface EgressLimits {
  cap: number;
  capBytes: number;
  budgetBytes: number;
}
const LIMITS: EgressLimits = {
  cap: EGRESS_LOG_CAP,
  capBytes: EGRESS_LOG_BYTES,
  budgetBytes: EGRESS_TOTAL_BYTES,
};

/** The in-memory store, for tests; it keeps no expiry (the Redis store's TTLs are tested on Redis). */
export class MemoryEgressStore implements EgressStore {
  private readonly logs = new Map<
    string,
    { entries: EgressEntry[]; bytes: number; meta: EgressMeta; expireAtS: number }
  >();
  private readonly hosts = new Map<string, { cursor: string; answer: EgressAnswer }>();
  private readonly limits: EgressLimits;
  private seq = 0;
  /** The bytes of every log's lines: a running sum, as the Redis store keeps it. */
  private total = 0;

  constructor(limits: Partial<EgressLimits> = {}) {
    this.limits = { ...LIMITS, ...limits };
  }

  /** Forgets a log, as its keys' expiry does in Redis, and gives its bytes back (for tests). */
  expire(id: string): void {
    this.total -= this.logs.get(id)?.bytes ?? 0;
    this.logs.delete(id);
  }

  private log(id: string) {
    let l = this.logs.get(id);
    if (!l) {
      l = {
        entries: [],
        bytes: 0,
        meta: { proxy: 0, cap: 0, budget: 0, invalid: 0, sealed: false },
        expireAtS: 0,
      };
      this.logs.set(id, l);
    }
    return l;
  }

  /** What the store holds for a sandbox: its lines and expiry (for tests). */
  peek(id: string) {
    return this.logs.get(id);
  }

  async append(
    host: string,
    cursor: string,
    groups: EgressGroup[],
    refused: number,
    dropped: number,
  ) {
    const last = this.hosts.get(host);
    if (last && last.cursor === cursor) return last.answer;
    const a: EgressAnswer = {
      accepted: 0,
      refused,
      capped: 0,
      overBudget: 0,
      invalid: 0,
      dropped,
      cursor,
    };
    const { cap, capBytes, budgetBytes } = this.limits;
    for (const g of groups) {
      const l = this.log(g.sandboxId);
      if (l.meta.sealed) {
        a.refused += g.lines.length + g.invalid;
        continue;
      }
      l.meta.invalid += g.invalid;
      a.invalid += g.invalid;
      for (const line of g.lines) {
        const w = Buffer.byteLength(line);
        if (l.entries.length >= cap || l.bytes + w > capBytes) {
          l.meta.cap += 1;
          a.capped += 1;
        } else if (this.total + w > budgetBytes) {
          l.meta.budget += 1;
          a.overBudget += 1;
        } else {
          this.seq += 1;
          l.entries.push({ id: `${this.seq}-0`, line });
          l.bytes += w;
          this.total += w;
          a.accepted += 1;
        }
      }
      l.meta.proxy += g.proxyDropped;
      l.expireAtS = g.expireAtS;
    }
    this.hosts.set(host, { cursor, answer: a });
    return a;
  }

  /** As Redis XRANGE `(after`: the entries whose id is after `after` in stream-id order. */
  async page(id: string, after: string | null, limit: number) {
    const es = this.logs.get(id)?.entries ?? [];
    const from = after === null ? 0 : es.findIndex((e) => compareEntryIds(e.id, after) > 0);
    return from < 0 ? [] : es.slice(from, from + limit);
  }

  async meta(id: string) {
    return {
      ...(this.logs.get(id)?.meta ?? { proxy: 0, cap: 0, budget: 0, invalid: 0, sealed: false }),
    };
  }

  async seal(id: string, expireAtS: number) {
    const l = this.log(id);
    if (l.meta.sealed) return false;
    l.meta.sealed = true;
    l.expireAtS = expireAtS;
    return true;
  }

  async expireAt(id: string, atS: number) {
    const l = this.logs.get(id);
    if (l) l.expireAtS = atS;
  }
}

/** Narrow, as SandboxRedisLike is: what RedisEgressStore calls. */
export interface EgressRedisLike {
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  xRange(
    key: string,
    start: string,
    end: string,
    opts?: { COUNT: number },
  ): Promise<{ id: string; message: Record<string, string> }[]>;
}

export const EGRESS_KEY_PREFIX = 'sh:sbx:egress:';

// KEYS: the host key, the expiry index (a sorted set: sandbox id -> its log's expiry, epoch seconds),
// the sizes (a hash: sandbox id -> its log's bytes), the total (the sizes' sum), then per sandbox its
// stream and its meta hash.
// ARGV: cursor, cap, host TTL seconds, refused, dropped, groups G, budget bytes, cap bytes, reap max;
// per group (sandbox id, count, proxyDropped, invalid, expireAt); then every line, the groups' in
// order. One script, so a post is appended whole or not at all, and its replay check, the sealed
// check, the caps and the budget are atomic with the append: two hosts posting at once cannot pass
// the budget together. Every key it touches is in KEYS.
//
// The total is kept, not summed: its cost per post is the post's own events plus the logs whose
// expiry has passed (at most the reap max), however many logs are retained. A log whose expiry is
// past (by the server's clock, which EXPIREAT also reads) has expired with its keys, so its bytes come
// back. A total that is missing (a Redis that lost the key) is summed once from the sizes. A log
// removed by hand stays counted until its expiry passes: the budget errs towards storing less.
const APPEND = `
local last = redis.call('HGET', KEYS[1], 'cursor')
if last and last == ARGV[1] then return redis.call('HGET', KEYS[1], 'answer') end
local cap = tonumber(ARGV[2]); local g = tonumber(ARGV[6]); local budget = tonumber(ARGV[7])
local capb = tonumber(ARGV[8])
local now = tonumber(redis.call('TIME')[1])
local total = tonumber(redis.call('GET', KEYS[4]) or '')
if total == nil then
  total = 0
  for _, b in ipairs(redis.call('HVALS', KEYS[3])) do total = total + tonumber(b) end
end
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. now, 'LIMIT', 0,
    tonumber(ARGV[9]))) do
  total = total - tonumber(redis.call('HGET', KEYS[3], id) or '0')
  redis.call('HDEL', KEYS[3], id); redis.call('ZREM', KEYS[2], id)
end
if total < 0 then total = 0 end
local accepted, refused, capped, over, invalid = 0, tonumber(ARGV[4]), 0, 0, 0
local li = 10 + 5 * g
for i = 1, g do
  local b = 5 + 5 * i
  local id = ARGV[b]; local n = tonumber(ARGV[b + 1]); local pd = tonumber(ARGV[b + 2])
  local inv = tonumber(ARGV[b + 3]); local exp = ARGV[b + 4]
  local s, m = KEYS[2 * i + 3], KEYS[2 * i + 4]
  if redis.call('HGET', m, 'sealed') == '1' then
    refused = refused + n + inv
  else
    if inv > 0 then redis.call('HINCRBY', m, 'invalid', inv); invalid = invalid + inv end
    local len = redis.call('XLEN', s); local size = tonumber(redis.call('HGET', KEYS[3], id) or '0')
    local c, o = 0, 0
    for j = 0, n - 1 do
      local line = ARGV[li + j]; local w = #line
      if len >= cap or size + w > capb then c = c + 1
      elseif total + w > budget then o = o + 1
      else
        redis.call('XADD', s, '*', 'e', line); len = len + 1; size = size + w; total = total + w
        accepted = accepted + 1
      end
    end
    if c > 0 then redis.call('HINCRBY', m, 'cap', c); capped = capped + c end
    if o > 0 then redis.call('HINCRBY', m, 'budget', o); over = over + o end
    if pd > 0 then redis.call('HINCRBY', m, 'proxy', pd) end
    if size > 0 then
      redis.call('HSET', KEYS[3], id, size); redis.call('ZADD', KEYS[2], exp, id)
    end
    redis.call('EXPIREAT', s, exp); redis.call('EXPIREAT', m, exp)
  end
  li = li + n
end
redis.call('SET', KEYS[4], total)
local answer = cjson.encode({accepted = accepted, refused = refused, capped = capped,
  overBudget = over, invalid = invalid, dropped = tonumber(ARGV[5]), cursor = ARGV[1]})
redis.call('HSET', KEYS[1], 'cursor', ARGV[1], 'answer', answer)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return answer
`;

// KEYS: meta, the expiry index. ARGV: expireAt, sandbox id. The index follows the log's expiry (XX:
// only a log with bytes is in it).
const SEAL = `
if redis.call('HGET', KEYS[1], 'sealed') == '1' then return 0 end
redis.call('HSET', KEYS[1], 'sealed', '1')
redis.call('EXPIREAT', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], 'XX', ARGV[1], ARGV[2])
return 1
`;

// KEYS: stream, meta, the expiry index. ARGV: at, sandbox id. EXPIREAT on an absent key is a no-op.
const EXPIRE = `
redis.call('EXPIREAT', KEYS[1], ARGV[1]); redis.call('EXPIREAT', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], 'XX', ARGV[1], ARGV[2])
return 1
`;

/**
 * The production store. A sandbox's log is the stream `sh:sbx:egress:<sandboxId>` (one field, `e`,
 * the canonical line) and its counters the hash `sh:sbx:egress:<sandboxId>:meta` (`proxy`, `cap`,
 * `budget`, `invalid`, `sealed`); both expire when the sandbox record does (EXPIREAT, set on every
 * append and moved on deletion). A host's last post is `sh:sbx:egress:host:<host>` (`cursor`,
 * `answer`), for replays. The budget's keys: `sh:sbx:egress:expiry` (a sorted set, each log with
 * bytes by its expiry), `sh:sbx:egress:bytes` (a hash, each such log's bytes) and
 * `sh:sbx:egress:total` (their sum); they do not expire, and a log leaves them when its expiry passes.
 */
export class RedisEgressStore implements EgressStore {
  constructor(
    private readonly redis: EgressRedisLike,
    private readonly hostTtlS: number,
    private readonly prefix: string = EGRESS_KEY_PREFIX,
    limits: Partial<EgressLimits> = {},
  ) {
    this.limits = { ...LIMITS, ...limits };
  }

  private readonly limits: EgressLimits;

  private stream = (id: string) => `${this.prefix}${id}`;
  private metaKey = (id: string) => `${this.prefix}${id}:meta`;
  private hostKey = (host: string) => `${this.prefix}host:${host}`;
  private get expiryKey() {
    return `${this.prefix}expiry`;
  }
  private get sizesKey() {
    return `${this.prefix}bytes`;
  }
  private get totalKey() {
    return `${this.prefix}total`;
  }

  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof CpError) throw err;
      console.error('[control-plane] egress store error:', (err as Error)?.message);
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  append(host: string, cursor: string, groups: EgressGroup[], refused: number, dropped: number) {
    return this.guard(async () => {
      const keys = [
        this.hostKey(host),
        this.expiryKey,
        this.sizesKey,
        this.totalKey,
        ...groups.flatMap((g) => [this.stream(g.sandboxId), this.metaKey(g.sandboxId)]),
      ];
      const args = [
        cursor,
        String(this.limits.cap),
        String(this.hostTtlS),
        String(refused),
        String(dropped),
        String(groups.length),
        String(this.limits.budgetBytes),
        String(this.limits.capBytes),
        String(EGRESS_REAP_MAX),
        ...groups.flatMap((g) => [
          g.sandboxId,
          String(g.lines.length),
          String(g.proxyDropped),
          String(g.invalid),
          String(g.expireAtS),
        ]),
        ...groups.flatMap((g) => g.lines),
      ];
      return JSON.parse(
        String(await this.redis.eval(APPEND, { keys, arguments: args })),
      ) as EgressAnswer;
    });
  }

  page(id: string, after: string | null, limit: number) {
    return this.guard(async () =>
      (
        await this.redis.xRange(this.stream(id), after === null ? '-' : `(${after}`, '+', {
          COUNT: limit,
        })
      ).map((e) => ({ id: e.id, line: e.message.e ?? '' })),
    );
  }

  meta(id: string) {
    return this.guard(async () => {
      const h = await this.redis.hGetAll(this.metaKey(id));
      return {
        proxy: Number(h.proxy ?? 0),
        cap: Number(h.cap ?? 0),
        budget: Number(h.budget ?? 0),
        invalid: Number(h.invalid ?? 0),
        sealed: h.sealed === '1',
      };
    });
  }

  seal(id: string, expireAtS: number) {
    return this.guard(
      async () =>
        Number(
          await this.redis.eval(SEAL, {
            keys: [this.metaKey(id), this.expiryKey],
            arguments: [String(expireAtS), id],
          }),
        ) === 1,
    );
  }

  expireAt(id: string, atS: number) {
    return this.guard(async () => {
      await this.redis.eval(EXPIRE, {
        keys: [this.stream(id), this.metaKey(id), this.expiryKey],
        arguments: [String(atS), id],
      });
    });
  }
}
