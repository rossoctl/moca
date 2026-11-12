import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import { intEnv } from './lease-timings.js';

/**
 * Sandbox tiers and session-to-sandbox affinity (P6.3, spec §3.5 and §4).
 *
 * A worker advertises its tier as the presence label TIER_LABEL; `selectPoolSandbox` keeps only the
 * records in the session's tier, and prefers the sandbox recorded here as having served the
 * session's previous turn. Affinity lives in the data-plane Redis beside the leases it is coupled
 * to, keyed by the stable sandbox id, so it survives a relay restart -- every worker reattaches
 * under the same id.
 */

/** A value safe to interpolate into one log line: CR, LF and other control characters removed (CodeQL js/log-injection).
 * Explicit \r\n and no quantifier are required for CodeQL's StringReplaceSanitizer recognition.
 */
export function forLog(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, '');
}

/** The presence label the tier filter reads; the workers' `session.TierLabelKey`. */
export const TIER_LABEL = 'moca.dev/tier';

/**
 * The presence label naming the sandbox template a worker serves; the workers'
 * `session.TemplateLabelKey` (session-templates spec §3.1). A session with template T runs only on
 * workers labelled T; a session with none only on workers without the label (§4).
 */
export const TEMPLATE_LABEL = 'moca.dev/template';

/**
 * The presence labels that bind a sandbox to one workload and its owner (workload sandboxes spec
 * §3). Trusted only from a relay with attach public keys: it sets them from a signed attach token
 * and strips them from every other `Hello`. `selectPoolSandbox` reads both: a workload run takes
 * only a record whose workload AND owner match its own.
 */
export const WORKLOAD_LABEL = 'moca.dev/workload';
export const OWNER_LABEL = 'moca.dev/owner';

export function affinityKey(sessionId: string): string {
  return `sh:sandbox:affinity:${sessionId}`;
}

/** When a sandbox was last seen leaving (epoch ms). Written by the relay, and by the harness (§4 step 4). */
export function detachedKey(sandboxId: string): string {
  return `sh:sandbox:detached:${sandboxId}`;
}

export interface SandboxTiers {
  names: string[];
  default: string;
}

/** A Kubernetes label value: what an operator can put in SANDBOX_TIER and a manifest label alike. */
const TIER_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * Read SH_SANDBOX_TIERS / SH_SANDBOX_DEFAULT_TIER. Null means the deployment declares no tiers, and
 * nothing is filtered. Throws, naming the variable, on a configuration that cannot be served: a
 * silently ignored typo here would put every session in "no tier" and defeat the whole slice.
 *
 * The control plane has its own copy (it does not depend on this package); both are pinned to
 * test/fixtures/sandbox-tiers-cases.json.
 */
export function parseSandboxTiers(env: NodeJS.ProcessEnv): SandboxTiers | null {
  const names = (env.SH_SANDBOX_TIERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`SH_SANDBOX_TIERS names '${dup}' twice`);
  const bad = names.find((n) => !TIER_NAME.test(n));
  if (bad) {
    throw new Error(
      `SH_SANDBOX_TIERS: '${bad}' is not a tier name (letters, digits, '.', '_' and '-', at most 63)`,
    );
  }
  const def = env.SH_SANDBOX_DEFAULT_TIER?.trim() || (names.length === 1 ? names[0] : '');
  if (!def) {
    throw new Error(
      'SH_SANDBOX_DEFAULT_TIER is required when SH_SANDBOX_TIERS names more than one tier',
    );
  }
  if (!names.includes(def)) {
    throw new Error(
      `SH_SANDBOX_DEFAULT_TIER='${def}' is not one of SH_SANDBOX_TIERS (${names.join(', ')})`,
    );
  }
  return { names, default: def };
}

/**
 * The affinity TTL and the absence grace. The TTL must stay >= P4's SH_WORKSPACE_IDLE: affinity
 * outliving a workspace is harmless (the session returns to its sandbox and finds an empty workspace,
 * which is what a fallback would give it), while affinity expiring first loses a workspace that still
 * exists. A zero grace is legal and means "fall back as soon as the sandbox is gone".
 */
export function affinityTimings(env: NodeJS.ProcessEnv): { ttlMs: number; graceMs: number } {
  return {
    ttlMs: intEnv(env, 'SH_SANDBOX_AFFINITY_TTL_SECONDS', 86_400) * 1000,
    graceMs: intEnv(env, 'SH_SANDBOX_AFFINITY_GRACE_SECONDS', 60, 0) * 1000,
  };
}

export interface AffinityEntry {
  sandboxId: string;
  tier: string;
}

export interface AffinityStore {
  /** The session's affine sandbox, or null. A corrupt value is null (and logged), never a throw. */
  get(sessionId: string): Promise<AffinityEntry | null>;
  /**
   * Set the entry unless a valid one exists, refreshing the TTL either way, and return the entry now
   * in force. Two first turns of one session race here; the loser converges on the winner (§4 step 6).
   */
  claim(sessionId: string, entry: AffinityEntry, ttlMs: number): Promise<AffinityEntry>;
  /** Overwrite: used after a fallback, when the old sandbox is deliberately abandoned. */
  replace(sessionId: string, entry: AffinityEntry, ttlMs: number): Promise<void>;
  /**
   * When `sandboxId` was first seen gone: the relay's mark, or -- when there is none, it is not an
   * integer, or it is after `nowMs` -- `nowMs`, written so the grace clock starts at the first turn
   * that noticed (§4 step 4).
   */
  detachedSince(sandboxId: string, nowMs: number, ttlMs: number): Promise<number>;
}

function parseEntry(raw: string | null): AffinityEntry | null | 'corrupt' {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<AffinityEntry>;
    if (typeof v?.sandboxId === 'string' && v.sandboxId && typeof v.tier === 'string') {
      return { sandboxId: v.sandboxId, tier: v.tier };
    }
  } catch {
    // fall through
  }
  return 'corrupt';
}

/**
 * KEYS[1]=affinityKey ARGV=[json, ttlMs]. Keeps a VALID existing entry (refreshing its TTL), else
 * writes ours; returns the entry in force. Validity is checked in Lua so a corrupt value is repaired
 * atomically rather than by a racy GET-then-SET.
 */
export const CLAIM_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  local ok, d = pcall(cjson.decode, v)
  if ok and type(d) == 'table' and type(d.sandboxId) == 'string' and d.sandboxId ~= '' and type(d.tier) == 'string' then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return v
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ARGV[1]`;

/**
 * KEYS[1]=detachedKey ARGV=[nowMs, ttlMs]. Keeps an integer mark at or before now, else writes now;
 * returns the mark. A mark AHEAD of now (relay clock skew, or a huge integer such as
 * 99999999999999999999, which still matches ^%d+$) is replaced too: kept, it would hold the session
 * pending until the key's TTL instead of for the grace. Replaced, the grace runs from now.
 */
export const DETACHED_SINCE_LUA = `
local v = redis.call('GET', KEYS[1])
if v and string.match(v, '^%d+$') and tonumber(v) <= tonumber(ARGV[1]) then return v end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ARGV[1]`;

/**
 * node-redis-backed affinity store. The same shape as RedisLeaseStore on purpose: it is memoised and
 * guarded by select-sandbox.ts's `sharedAffinity` exactly as the lease store is by `sharedLease`, so
 * it inherits that memo's drop-and-rebuild recovery instead of re-arming itself (see `sharedLease`).
 */
export class RedisAffinityStore implements AffinityStore {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(
    url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    maxReconnectAttempts?: number,
  ) {
    this.client = createClient(
      resilientClientOptions(url, maxReconnectAttempts),
    ) as RedisClientType;
    swallowRedisErrors(this.client, 'sandbox affinity store');
    this.ready = this.client.connect().then(() => undefined);
  }
  async get(sessionId: string): Promise<AffinityEntry | null> {
    await this.ready;
    const parsed = parseEntry(await this.client.get(affinityKey(sessionId)));
    if (parsed === 'corrupt') {
      console.warn(
        `sandbox affinity: ignoring a corrupt value at ${affinityKey(forLog(sessionId))}`,
      );
      return null;
    }
    return parsed;
  }
  async claim(sessionId: string, entry: AffinityEntry, ttlMs: number): Promise<AffinityEntry> {
    await this.ready;
    const res = await this.client.eval(CLAIM_LUA, {
      keys: [affinityKey(sessionId)],
      arguments: [JSON.stringify(entry), String(ttlMs)],
    });
    const parsed = parseEntry(String(res));
    return parsed && parsed !== 'corrupt' ? parsed : entry;
  }
  async replace(sessionId: string, entry: AffinityEntry, ttlMs: number): Promise<void> {
    await this.ready;
    await this.client.set(affinityKey(sessionId), JSON.stringify(entry), { PX: ttlMs });
  }
  async detachedSince(sandboxId: string, nowMs: number, ttlMs: number): Promise<number> {
    await this.ready;
    const res = await this.client.eval(DETACHED_SINCE_LUA, {
      keys: [detachedKey(sandboxId)],
      arguments: [String(nowMs), String(ttlMs)],
    });
    const n = Number(res);
    return Number.isFinite(n) ? n : nowMs;
  }
  /** Same contract as RedisLeaseStore.close(): never re-throws a failed connect. */
  async close(): Promise<void> {
    await this.ready.catch(() => {});
    if (this.client.isOpen) await this.client.close();
  }
}
