import { CpError } from './errors.js';
import { subjectHash } from './k8s-secret-store.js';

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
  `leaf:result:${sid}`, // leaf result + gate state (harness/src/leaf-result-store.ts:23)
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
    };
  }

  /**
   * The ONLY user-facing list path. LogStore.list() must never serve one: it is a
   * keys('session:*') scan (spec §2.3), O(keyspace) and with no owner concept.
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
      if (fields[f] !== undefined) allowed[f] = fields[f]!;
    }
    if (Object.keys(allowed).length === 0) return;
    await this.guard(() => this.redis.hSet(runtimeKey(sid), allowed));
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
    credential?: string;
    configRef?: string;
    bytes?: number;
    decision: string;
    /** The error code of a refusal. */
    reason?: string;
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
          // The credential NAME, never its value (spec §7.2).
          ...(entry.credential ? { credential: entry.credential } : {}),
          ...(entry.configRef ? { configRef: entry.configRef } : {}),
          ...(entry.bytes !== undefined ? { bytes: String(entry.bytes) } : {}),
          ...(entry.reason ? { reason: entry.reason } : {}),
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
