import { CpError } from './errors.js';
import { subjectHash } from './k8s-secret-store.js';
import { sanitizeLimits, type ModelLimits } from './models.js';

/**
 * The session-ownership index (spec §7.1-§7.3). It lives in Redis BECAUSE Redis is ephemeral: if
 * Redis is wiped the sessions are gone, so their ownership records are meaningless. Co-location
 * means index and data can never disagree. Credentials are the opposite -- they outlive every
 * session, which is why they are Kubernetes Secrets (k8s-secret-store.ts).
 *
 * Minimal structural Redis surface so unit tests inject an in-memory fake, exactly as
 * harness/src/leaf-result-store.ts and packages/config-bundle/src/store.ts do.
 */
export interface CpRedisLike {
  hSet(key: string, values: Record<string, string>): Promise<unknown>;
  /** Atomic +N on one hash field, for the runtime hash's counters (see RUNTIME_COUNTERS). */
  hIncrBy(key: string, field: string, by: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  /**
   * NOTE the argument order: node-redis takes (key, min, max) normally but (key, MAX, MIN) when
   * `REV` is set, which is the only way this index reads. Written max-first so the call site and the
   * client agree; the test fake reproduces the same order deliberately.
   */
  zRange(
    key: string,
    max: number | string,
    min: number | string,
    opts?: { BY?: 'SCORE'; REV?: boolean; LIMIT?: { offset: number; count: number } },
  ): Promise<string[]>;
  del(keys: string[]): Promise<unknown>;
  xAdd(
    key: string,
    id: string,
    fields: Record<string, string>,
    options?: { TRIM: { strategy: 'MAXLEN'; strategyModifier: '~'; threshold: number } },
  ): Promise<unknown>;
  /**
   * The score of one member, or null when it is gone. `listByOwner` needs it to page from the zset's
   * own position rather than from a surviving record -- see the comment there for why.
   */
  zScore(key: string, member: string): Promise<number | null>;
  /**
   * Set a field only if it is absent, answering whether this caller won. The async turn store's
   * idempotency claim (async spec §4.3) needs the check and the write to be ONE command: two
   * concurrent submissions on one key must produce one turn, not two that each believe they were
   * first.
   */
  hSetNX(key: string, field: string, value: string): Promise<boolean>;
  /**
   * A key's TTL in seconds. The async turn record carries NO TTL while it is non-terminal and gets
   * one at its terminal state (async spec §5.1) -- a record that expired on a schedule from creation
   * would 404 a caller polling a turn that in fact succeeded.
   */
  expire(key: string, seconds: number): Promise<unknown>;
  /** A sorted set's cardinality: the per-owner open-turn count the fan-out quota reads (§4.3). */
  zCard(key: string): Promise<number>;
  /**
   * One Lua script, server-side. The turn record's state transitions need the read and the write to
   * be indivisible (`turn-store.ts`'s CAS_STATE_LUA): a `cancel` landing between a claim's read and
   * its write would otherwise be overwritten, and the worker would run a turn the caller cancelled.
   *
   * `script` is always one of this package's own exported constants -- never a caller's string --
   * which is also what lets the in-memory fake dispatch on identity rather than interpret Lua.
   */
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface SessionRecord {
  sessionId: string;
  owner: string;
  tenant: string;
  createdAt: number;
  state: 'active' | 'deleting';
  poolSelector: string | null;
  /** Which credential this session's turns run on -- chosen once, at creation (plan gap #4). */
  credentialName: string;
  /** The config bundle this session's turns run with -- chosen once, at creation (ADR-0038). */
  configRef: string | null;
  tombstone: boolean;
  /**
   * The session's sandbox tier, chosen once at creation (P6.3 spec §3.3). '' when the deployment
   * declared none then. Undefined ONLY for a record written before P6.3, which has no field. Read
   * as stored, never coerced; the exchange gives both today's default (sessionTier, exchange.ts).
   */
  sandboxTier?: string;
  /**
   * The session's sandbox template, chosen once at creation (session-templates spec §3.3). Absent
   * (or '') when the session named none: it then runs only on untemplated workers.
   */
  sandboxTemplate?: string;
  /**
   * The build `sandboxTemplate` resolved to at creation through the template store (combined
   * control plane spec §3.4): `id` by its default tag, `id:tag`, or `id@<build id>`. Kept for the
   * session's life; when it is a manifest hash, a turn runs only on a worker labelled with it.
   * Absent without a template store.
   */
  sandboxBuildId?: string;
  /**
   * The model this session's turns run on (per-session model spec §4.4). '' or absent means the
   * deployment default. Changed by PATCH /v1/sessions/{id}, unlike the fields above.
   */
  model?: string;
  /** The catalog's limits for `model`, snapshotted when it was chosen; absent when unverified. */
  modelLimits?: ModelLimits;
}

export const AUDIT_STREAM = 'sh:cp:audit';
/** Every write to the audit stream trims it to about this many entries (MAXLEN ~). */
export const AUDIT_MAXLEN = 1_000_000;
/**
 * Refusals of a refresh token nobody issued go to `<prefix>audit:anon`, trimmed to this many.
 * Anyone can send one (POST /v1/auth/token takes no auth), so they get their own stream: sharing
 * the main one would let anonymous traffic trim away the history of real principals (#467).
 */
export const ANON_AUDIT_MAXLEN = 100_000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const sessionKey = (sid: string): string => `sh:cp:session:${sid}`;
export const runtimeKey = (sid: string): string => `sh:cp:session:${sid}:runtime`;
/** Hashed, so the keyspace itself discloses no logins -- same derivation as the Secret name. */
export const ownerKey = (subject: string): string => `sh:cp:owner:${subjectHash(subject)}:sessions`;

/** Keys of session DATA the cascade can address by name (plan gap #10). */
const dataKeys = (sid: string): string[] => [
  `session:${sid}`, // pi log stream       (packages/session-backend/src/redis-backend.ts:6)
  `session:${sid}:seq`, // its position counter (:7)
  // The SYNC `/runs` path's leaf result + gate state (harness/src/leaf-result-store.ts:32), which
  // is per session because a session has one interactive leaf at a time. An ASYNC turn's result
  // key carries a turn id too, so it can only be reached by enumerating the session's turns --
  // TurnStore.deleteSessionTurns, which deleteSession calls right after this cascade.
  `leaf:result:${sid}`,
];

/** Fields the runtime hash may carry. Anything else is dropped on write -- see putRuntime. */
const RUNTIME_FIELDS = [
  'harnessPod',
  'revision',
  'sandboxPod',
  'sandboxSelector',
  'leaseKey',
  'lastTurnAt',
  'turns',
  // A best-effort in-flight HINT, used only to choose 202 vs 204 on delete (plan gap #11). Never
  // authz, and a wrong value changes the status code, never whether the delete happened.
  'turnStartedAt',
  'turnEndedAt',
  // P6.3 spec §6: where the last leased turn ran, and when the session last lost its workspace
  // (knative-server runtimeFieldsForTurn). Display-only, read by the resources view's `placement`.
  'sandboxId',
  'sandboxTier',
  'workspaceResetAt',
  'workspaceResetFrom',
] as const;

/**
 * Readable, but NOT writable through `putRuntime` -- the one asymmetry in the runtime hash.
 *
 * `turns` is a counter, so it is the only runtime field whose new value depends on its old one. Two
 * things follow. It cannot ride the merging `hSet`: the server does not serialize concurrent turns
 * of one session (ADR-0036), so a read-modify-write would have both turns read N and both write
 * N+1. And it must not be settable to an arbitrary value by the tier that self-reports this hash
 * (spec §7.4), which a `fields.turns` passed to `putRuntime` would be. `bumpTurns` -- a server-side
 * HINCRBY of exactly +1 -- is the only writer; everything else is dropped on write.
 */
const RUNTIME_COUNTERS: readonly string[] = ['turns'];

/** A stored limits field, read tolerantly: '' or a corrupted value is "no limits", never a throw. */
function readLimits(raw: string | undefined): ModelLimits | undefined {
  if (!raw) return undefined;
  try {
    return sanitizeLimits(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export class OwnershipIndex {
  constructor(private readonly redis: CpRedisLike) {}

  /**
   * Turn a Redis transport failure into `redis_unavailable` (503), not an opaque 500. Spec §9.2 wants
   * "Redis down => session routes 503, while /v1/credentials stays up" -- which only holds if the
   * index itself says so, since the credential store is Kubernetes Secrets and has no idea Redis
   * exists. Mapped here rather than by string-matching in the router: this class is the only thing
   * that knows a call was a Redis call.
   *
   * EVERY method that touches `this.redis` routes through this -- reads and writes alike. Guarding
   * only the reads would leave `POST /v1/sessions` and `DELETE /v1/sessions/{id}` answering 500 with
   * Redis down, and both are session routes that §9.2 covers.
   */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      // A CpError thrown by a nested index call is already typed; do not re-wrap it.
      if (err instanceof CpError) throw err;
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  async create(rec: SessionRecord): Promise<void> {
    await this.guard(() =>
      this.redis.hSet(sessionKey(rec.sessionId), {
        owner: rec.owner,
        tenant: rec.tenant,
        createdAt: String(rec.createdAt),
        state: rec.state,
        poolSelector: rec.poolSelector ?? '',
        credentialName: rec.credentialName,
        configRef: rec.configRef ?? '',
        tombstone: rec.tombstone ? '1' : '0',
        sandboxTier: rec.sandboxTier ?? '',
        sandboxTemplate: rec.sandboxTemplate ?? '',
        sandboxBuildId: rec.sandboxBuildId ?? '',
        model: rec.model ?? '',
        modelLimits: rec.modelLimits ? JSON.stringify(rec.modelLimits) : '',
      }),
    );
    await this.guard(() =>
      this.redis.zAdd(ownerKey(rec.owner), { score: rec.createdAt, value: rec.sessionId }),
    );
  }

  async get(sid: string): Promise<SessionRecord | null> {
    const h = await this.guard(() => this.redis.hGetAll(sessionKey(sid)));
    // A hash with no `owner` is a partial write, not a session owned by nobody: returning a record
    // with owner:'' would give assertOwner something to compare an empty principal against.
    if (!h.owner) return null;
    return {
      sessionId: sid,
      owner: h.owner,
      tenant: h.tenant ?? h.owner,
      createdAt: Number(h.createdAt ?? 0),
      state: h.state === 'deleting' ? 'deleting' : 'active',
      poolSelector: h.poolSelector ? h.poolSelector : null,
      credentialName: h.credentialName ?? '',
      configRef: h.configRef ? h.configRef : null,
      tombstone: h.tombstone === '1',
      sandboxTier: h.sandboxTier,
      ...(h.sandboxTemplate ? { sandboxTemplate: h.sandboxTemplate } : {}),
      ...(h.sandboxBuildId ? { sandboxBuildId: h.sandboxBuildId } : {}),
      ...(h.model ? { model: h.model } : {}),
      ...(readLimits(h.modelLimits) ? { modelLimits: readLimits(h.modelLimits) } : {}),
    };
  }

  /**
   * The ONLY user-facing list path. LogStore deliberately has no listing at all (rossoctl/moca#361):
   * a store keyed by session id has no owner concept, so the closest thing it could offer is an
   * all-tenant keyspace scan. This method reads the owner zset instead.
   */
  async listByOwner(
    subject: string,
    opts: { limit?: number; cursor?: number } = {},
  ): Promise<{ sessions: SessionRecord[]; nextCursor: number | null }> {
    const requested = opts.limit ?? DEFAULT_PAGE_SIZE;
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    // `(score` is Redis's EXCLUSIVE bound: the cursor is the last score already returned, so an
    // inclusive bound would repeat that row forever on a one-per-page walk.
    const max = opts.cursor === undefined ? '+inf' : `(${opts.cursor}`;
    const ids = await this.guard(() =>
      this.redis.zRange(ownerKey(subject), max, '-inf', {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset: 0, count: limit },
      }),
    );
    const sessions: SessionRecord[] = [];
    for (const sid of ids) {
      const rec = await this.get(sid);
      // A member whose hash is gone is skipped rather than emitted as a null row: the cascade
      // removes the hash last, so this window is real and must read as "already deleted".
      if (rec) sessions.push(rec);
    }
    // The cursor must come from the last ZSET MEMBER's position, not the last surviving RECORD.
    // `sessions` has the ghosts filtered out, so on a page whose tail member has no hash the last
    // record's createdAt is a HIGHER score than the tail's -- and the next page's exclusive `(score`
    // bound then re-visits the ghost, and every real member between it and the record, forever. Worse,
    // a page that is entirely ghosts leaves `sessions` empty and truncated the walk to null while more
    // pages existed.
    //
    // A full page is the only case that needs a cursor, so this costs one extra round-trip per page and
    // none on the last. `zScore` returning null means the tail was removed between the two calls: fall
    // back to the last surviving record, which is the pre-existing behaviour and no worse than it.
    let nextCursor: number | null = null;
    if (ids.length === limit) {
      const tail = ids[ids.length - 1]!;
      const score = await this.guard(() => this.redis.zScore(ownerKey(subject), tail));
      nextCursor = score ?? sessions.at(-1)?.createdAt ?? null;
    }
    return { sessions, nextCursor };
  }

  /** Step 1 of the cascade, and the flag the credential exchange checks (spec §5.3, §7.3). */
  async tombstone(sid: string): Promise<void> {
    await this.guard(() => this.redis.hSet(sessionKey(sid), { tombstone: '1', state: 'deleting' }));
  }

  /** Replace the session's model (spec §4.3). Limits not given are cleared, never kept stale. */
  async setModel(sid: string, model: string, limits?: ModelLimits): Promise<void> {
    await this.guard(() =>
      this.redis.hSet(sessionKey(sid), {
        model,
        modelLimits: limits ? JSON.stringify(limits) : '',
      }),
    );
  }

  /**
   * Self-reported by the harness (spec §7.4). Written by the BRAIN tier, so it is untrusted,
   * display-only data and is never consulted for authz -- stated here because the tempting later
   * shortcut is to read `owner` from whatever the harness wrote. The allow-list is what makes that
   * impossible rather than merely discouraged: an `owner` field sent by a compromised harness is
   * dropped on write, not stored and then ignored.
   */
  async putRuntime(sid: string, fields: Record<string, string>): Promise<void> {
    const allowed: Record<string, string> = {};
    for (const f of RUNTIME_FIELDS) {
      // A counter is readable but never settable here -- see RUNTIME_COUNTERS. Dropped on write,
      // like a field off the allow-list, rather than stored and then ignored.
      if (RUNTIME_COUNTERS.includes(f)) continue;
      if (fields[f] !== undefined) allowed[f] = fields[f]!;
    }
    if (Object.keys(allowed).length === 0) return;
    await this.guard(() => this.redis.hSet(runtimeKey(sid), allowed));
  }

  /**
   * Count one completed turn (#420). HINCRBY, not a read-modify-write through `putRuntime`: the
   * server does not serialize concurrent turns of one session, so reading the old value here would
   * undercount. See RUNTIME_COUNTERS for why this is the only writer of `turns`.
   */
  async bumpTurns(sid: string): Promise<void> {
    await this.guard(() => this.redis.hIncrBy(runtimeKey(sid), 'turns', 1));
  }

  async getRuntime(sid: string): Promise<Record<string, string>> {
    const h = await this.guard(() => this.redis.hGetAll(runtimeKey(sid)));
    const out: Record<string, string> = {};
    for (const f of RUNTIME_FIELDS) if (h[f] !== undefined) out[f] = h[f]!;
    return out;
  }

  /** Append-only decision log, in a keyspace separate from the model-influenced session log (Z1 §6). */
  async audit(entry: {
    subject: string;
    sessionId?: string;
    /** The sandbox a decision is about (SBX0 §5). */
    sandboxId?: string;
    /** The async turn a decision is about (async fan-out spec §5.1). */
    turnId?: string;
    credential?: string;
    /** The host an egress lookup asked for (SBX0.2b), and the egress host that asked. */
    destination?: string;
    egressHost?: string;
    configRef?: string;
    bytes?: number;
    /** The template a decision is about (template lifecycle spec §4). */
    templateId?: string;
    /** The gating rule ids a policy refusal failed, comma-separated (spec §8.1). */
    rules?: string;
    decision: string;
    /**
     * The error code of a refusal; on a `sandbox_mode_changed` the policy made (a mode no longer
     * allowed, downgraded at a token mint), `mode_not_allowed`.
     */
    reason?: string;
    model?: string;
    fromModel?: string;
    /** A sandbox mode change (lease-mode spec §8.1): the old and new mode, and the new epoch. */
    fromMode?: string;
    toMode?: string;
    modeEpoch?: number;
  }): Promise<void> {
    await this.guard(() =>
      this.redis.xAdd(
        AUDIT_STREAM,
        '*',
        {
          ts: String(Date.now()),
          subject: entry.subject,
          decision: entry.decision,
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          ...(entry.sandboxId ? { sandboxId: entry.sandboxId } : {}),
          ...(entry.turnId ? { turnId: entry.turnId } : {}),
          // The credential NAME, never its value (spec §7.2).
          ...(entry.credential ? { credential: entry.credential } : {}),
          ...(entry.destination ? { destination: entry.destination } : {}),
          ...(entry.egressHost ? { egressHost: entry.egressHost } : {}),
          ...(entry.configRef ? { configRef: entry.configRef } : {}),
          ...(entry.bytes !== undefined ? { bytes: String(entry.bytes) } : {}),
          ...(entry.templateId ? { templateId: entry.templateId } : {}),
          ...(entry.rules ? { rules: entry.rules } : {}),
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.fromModel ? { fromModel: entry.fromModel } : {}),
          ...(entry.fromMode ? { fromMode: entry.fromMode } : {}),
          ...(entry.toMode ? { toMode: entry.toMode } : {}),
          ...(entry.modeEpoch !== undefined ? { modeEpoch: String(entry.modeEpoch) } : {}),
        },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: AUDIT_MAXLEN } },
      ),
    );
  }

  /**
   * Tombstone → data → index. NEVER the reverse: dropping the index first leaves data present but
   * invisible, which is worse than a visible orphan (spec §7.3). A sweeper reaps what an in-flight
   * turn writes on its way out; its sandbox lease is already released by its own `finally`.
   */
  async cascadeDelete(rec: SessionRecord): Promise<void> {
    await this.tombstone(rec.sessionId);
    await this.guard(() => this.redis.del([...dataKeys(rec.sessionId), runtimeKey(rec.sessionId)]));
    await this.guard(() => this.redis.zRem(ownerKey(rec.owner), rec.sessionId));
    await this.guard(() => this.redis.del([sessionKey(rec.sessionId)]));
  }
}
