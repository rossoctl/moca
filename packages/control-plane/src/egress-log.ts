import { createHash } from 'node:crypto';
import { CpError } from './errors.js';
import { canonicalJson } from './provenance.js';

/**
 * Per-sandbox egress records (docs/specs/2026-11-08-sandbox-egress-records-design.md).
 * A KVM host's agent posts the egress proxy's audit events (`moca-egress`, remote-worker
 * internal/egress/audit.go `Event`) as they are; each event whose `sid` is a sandbox's workspace
 * key is appended, in arrival order, to that sandbox's log.
 *
 * What is stored is the event exactly as the proxy wrote it, as one canonical JSON line
 * (provenance.ts's canonicalJson): an event naming any field the proxy's Event does not is refused,
 * never trimmed, so nothing reaches the log that the proxy did not log.
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
 * A sandbox's log holds at most this many events; later ones are counted as dropped (`cap`). About
 * 317 B each in Redis (measured, a typical CONNECT event), so about 3 MB per log at the cap.
 */
export const EGRESS_LOG_CAP = 10_000;
/**
 * All sandboxes' logs together hold at most this many events, about 64 MB: the bound on Redis
 * memory, which SBX0 gives 256 MiB in all (deploy/k8s/base/redis.yaml) for sessions, sandboxes and
 * templates too. An event over it is not stored and is counted as dropped (`budget`) in its
 * sandbox's log. The total is derived, never kept: the Lua append sums the lengths of the logs that
 * still exist, so a log that expired (14 days after its sandbox ended) gives its share back with no
 * reconciliation and no counter to drift.
 */
export const EGRESS_TOTAL_BUDGET = 200_000;
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
  /** Events over a log's cap, counted as dropped in that log. */
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
  /** Over the length cap. */
  cap: number;
  /** Over the total budget (EGRESS_TOTAL_BUDGET). */
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

/** The in-memory store, for tests; it keeps no expiry (the Redis store's TTLs are tested on Redis). */
export class MemoryEgressStore implements EgressStore {
  private readonly logs = new Map<
    string,
    { entries: EgressEntry[]; meta: EgressMeta; expireAtS: number }
  >();
  private readonly hosts = new Map<string, { cursor: string; answer: EgressAnswer }>();
  private seq = 0;

  constructor(
    private readonly cap: number = EGRESS_LOG_CAP,
    private readonly budget: number = EGRESS_TOTAL_BUDGET,
  ) {}

  /** Forgets a log, as its keys' expiry does in Redis (for tests). */
  expire(id: string): void {
    this.logs.delete(id);
  }

  private log(id: string) {
    let l = this.logs.get(id);
    if (!l) {
      l = {
        entries: [],
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
    let total = 0;
    for (const l of this.logs.values()) total += l.entries.length;
    for (const g of groups) {
      const l = this.log(g.sandboxId);
      if (l.meta.sealed) {
        a.refused += g.lines.length + g.invalid;
        continue;
      }
      l.meta.invalid += g.invalid;
      a.invalid += g.invalid;
      for (const line of g.lines) {
        if (l.entries.length >= this.cap) {
          l.meta.cap += 1;
          a.capped += 1;
        } else if (total >= this.budget) {
          l.meta.budget += 1;
          a.overBudget += 1;
        } else {
          this.seq += 1;
          l.entries.push({ id: `${this.seq}-0`, line });
          a.accepted += 1;
          total += 1;
        }
      }
      l.meta.proxy += g.proxyDropped;
      l.expireAtS = g.expireAtS;
    }
    this.hosts.set(host, { cursor, answer: a });
    return a;
  }

  async page(id: string, after: string | null, limit: number) {
    const es = this.logs.get(id)?.entries ?? [];
    const from = after === null ? 0 : es.findIndex((e) => e.id === after) + 1;
    return es.slice(from, from + limit);
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

// KEYS: the host key, the index (the set of sandbox ids with a log), then per sandbox its stream and
// its meta hash.
// ARGV: cursor, cap, host TTL seconds, refused, dropped, groups G, budget, the stream key prefix; per
// group (count, proxyDropped, invalid, expireAt); then every line, the groups' in order. One script,
// so a post is appended whole or not at all, and its replay check, the sealed check and the budget
// check are atomic with the append: two hosts posting at once cannot pass the budget together.
//
// The total is derived from the index: the sum of the lengths of the logs that still exist (an
// expired stream is gone, and XLEN of it is 0, so it is dropped from the index here). Nothing is
// kept that could drift, and an expired log gives its budget back at the next append. The index's
// members are read by name, outside KEYS, which a standalone Redis allows (SBX0 runs one, not a
// cluster). Its size is the sandboxes retained with a log, one XLEN each per post.
const APPEND = `
local last = redis.call('HGET', KEYS[1], 'cursor')
if last and last == ARGV[1] then return redis.call('HGET', KEYS[1], 'answer') end
local cap = tonumber(ARGV[2]); local g = tonumber(ARGV[6]); local budget = tonumber(ARGV[7])
local prefix = ARGV[8]
local total = 0
for _, id in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  local n = redis.call('XLEN', prefix .. id)
  if n == 0 then redis.call('SREM', KEYS[2], id) else total = total + n end
end
local accepted, refused, capped, over, invalid = 0, tonumber(ARGV[4]), 0, 0, 0
local li = 9 + 4 * g
for i = 1, g do
  local b = 5 + 4 * i
  local n = tonumber(ARGV[b]); local pd = tonumber(ARGV[b + 1]); local inv = tonumber(ARGV[b + 2])
  local exp = ARGV[b + 3]
  local s, m = KEYS[2 * i + 1], KEYS[2 * i + 2]
  if redis.call('HGET', m, 'sealed') == '1' then
    refused = refused + n + inv
  else
    if inv > 0 then redis.call('HINCRBY', m, 'invalid', inv); invalid = invalid + inv end
    local len = redis.call('XLEN', s); local c, o = 0, 0
    for j = 0, n - 1 do
      if len >= cap then c = c + 1
      elseif total >= budget then o = o + 1
      else
        redis.call('XADD', s, '*', 'e', ARGV[li + j]); len = len + 1; total = total + 1
        accepted = accepted + 1
      end
    end
    if c > 0 then redis.call('HINCRBY', m, 'cap', c); capped = capped + c end
    if o > 0 then redis.call('HINCRBY', m, 'budget', o); over = over + o end
    if pd > 0 then redis.call('HINCRBY', m, 'proxy', pd) end
    if len > 0 then redis.call('SADD', KEYS[2], string.sub(s, #prefix + 1)) end
    redis.call('EXPIREAT', s, exp); redis.call('EXPIREAT', m, exp)
  end
  li = li + n
end
local answer = cjson.encode({accepted = accepted, refused = refused, capped = capped,
  overBudget = over, invalid = invalid, dropped = tonumber(ARGV[5]), cursor = ARGV[1]})
redis.call('HSET', KEYS[1], 'cursor', ARGV[1], 'answer', answer)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return answer
`;

// KEYS: meta. ARGV: expireAt.
const SEAL = `
if redis.call('HGET', KEYS[1], 'sealed') == '1' then return 0 end
redis.call('HSET', KEYS[1], 'sealed', '1')
redis.call('EXPIREAT', KEYS[1], ARGV[1])
return 1
`;

// KEYS: stream, meta. ARGV: at. EXPIREAT on an absent key is a no-op.
const EXPIRE = `
redis.call('EXPIREAT', KEYS[1], ARGV[1]); redis.call('EXPIREAT', KEYS[2], ARGV[1])
return 1
`;

/**
 * The production store. A sandbox's log is the stream `sh:sbx:egress:<sandboxId>` (one field, `e`,
 * the canonical line) and its counters the hash `sh:sbx:egress:<sandboxId>:meta` (`proxy`, `cap`,
 * `budget`, `invalid`, `sealed`); both expire when the sandbox record does (EXPIREAT, set on every append and moved on
 * deletion). A host's last post is `sh:sbx:egress:host:<host>` (`cursor`, `answer`), for replays.
 * `sh:sbx:egress:index` is the set of sandbox ids with a log, which the total budget is summed over.
 */
export class RedisEgressStore implements EgressStore {
  constructor(
    private readonly redis: EgressRedisLike,
    private readonly hostTtlS: number,
    private readonly prefix: string = EGRESS_KEY_PREFIX,
    private readonly limits: { cap: number; budget: number } = {
      cap: EGRESS_LOG_CAP,
      budget: EGRESS_TOTAL_BUDGET,
    },
  ) {}

  private stream = (id: string) => `${this.prefix}${id}`;
  private metaKey = (id: string) => `${this.prefix}${id}:meta`;
  private hostKey = (host: string) => `${this.prefix}host:${host}`;
  private get indexKey() {
    return `${this.prefix}index`;
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
        this.indexKey,
        ...groups.flatMap((g) => [this.stream(g.sandboxId), this.metaKey(g.sandboxId)]),
      ];
      const args = [
        cursor,
        String(this.limits.cap),
        String(this.hostTtlS),
        String(refused),
        String(dropped),
        String(groups.length),
        String(this.limits.budget),
        this.prefix,
        ...groups.flatMap((g) => [
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
          await this.redis.eval(SEAL, { keys: [this.metaKey(id)], arguments: [String(expireAtS)] }),
        ) === 1,
    );
  }

  expireAt(id: string, atS: number) {
    return this.guard(async () => {
      await this.redis.eval(EXPIRE, {
        keys: [this.stream(id), this.metaKey(id)],
        arguments: [String(atS)],
      });
    });
  }
}
