import type { CpRedisLike } from './ownership.js';
import { CpError } from './errors.js';
import {
  idempotencyKeyKey,
  isTerminalState,
  ownerTurnsKey,
  turnKey,
  TURN_STATES,
  type TurnCaps,
  type TurnRecord,
  type TurnState,
} from './turn-record.js';

export interface TurnStoreOptions {
  /** `LEAF_RESULT_TTL_SECONDS` (86400 default) -- the RESULT's lifetime, not the record's. */
  resultTtlSeconds: number;
  /** How much longer than its result a terminal record lives (async spec §5.1). */
  ttlMarginSeconds: number;
  /** Test-only key suffix, so a real-Redis suite can delete exactly what it wrote. */
  keyTag?: string;
}

/**
 * The async turn record's only writer (async fan-out spec §5.1). Written against the STRUCTURAL
 * CpRedisLike, so one implementation serves the in-memory fake and real Redis
 * (test/helpers/turn-store-contract.ts runs it against both). `SandboxStore` needs two
 * implementations because its quotas are Lua; nothing here is -- the one place that needs
 * atomicity is the idempotency claim, which is a single HSETNX.
 *
 * Two invariants live here rather than in a handler, because a handler cannot enforce them:
 *
 * - **A non-terminal record carries no TTL at all.** The TTL is set at the terminal transition, to
 *   `resultTtlSeconds + ttlMarginSeconds`. A record that expired on a schedule from creation would
 *   answer 404 -- "never submitted" -- for a turn that succeeded, which is the same conflation §4.4
 *   rejects in `/runs/status`, reintroduced by a TTL instead of by an inference.
 * - **A terminal state is reached once.** `finalize` and `cancel` both compare-and-set, so the
 *   reaper's `lost` cannot overwrite a `done` that landed first.
 */
export class TurnStore {
  constructor(
    private readonly redis: CpRedisLike,
    private readonly opts: TurnStoreOptions,
  ) {}

  /** Identical in spirit to OwnershipIndex.guard: any transport failure reads as 503, never 500. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CpError) throw err;
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }

  private key(turnId: string): string {
    return turnKey(this.tag(turnId));
  }

  private tag(id: string): string {
    return this.opts.keyTag ? `${id}:${this.opts.keyTag}` : id;
  }

  private ownerKey(owner: string): string {
    return ownerTurnsKey(this.tag(owner));
  }

  /**
   * Claim `key` for `turnId`, returning whichever turn id HOLDS it. An existing holder wins, so a
   * resubmission returns the first turn (§4.3) rather than enqueueing a second copy. HSETNX, so two
   * concurrent submissions cannot both believe they were first.
   */
  async claimIdempotencyKey(owner: string, key: string, turnId: string): Promise<string> {
    const k = idempotencyKeyKey(this.tag(owner), key);
    const won = await this.guard(() => this.redis.hSetNX(k, 'turnId', turnId));
    if (won) return turnId;
    const held = await this.guard(() => this.redis.hGetAll(k));
    // A hash that lost its field between the two calls is treated as unclaimed: answering with the
    // caller's own id is correct there, and it is the only reading that cannot wedge a session.
    return held.turnId ?? turnId;
  }

  /**
   * Release `key` ONLY while `expected` still holds it, answering whether it was released. This is
   * the ONLY release: there is no blind `del` of a claim, because no caller can know it still holds
   * one. The compare is the point -- a submission that steps over a terminal holder
   * (turn-handlers.claimKey), a turn going terminal (`toTerminal`) and the enqueue-failure
   * compensation (turn-handlers.submitTurn) must none of them remove a claim some OTHER submission
   * made in between, or both would believe they were first and fan out two turns for one
   * idempotency key (§4.3).
   *
   * Compare-then-delete over two round trips, not one atomic op: `CpRedisLike` is deliberately a
   * handful of typed commands with no WATCH, no MULTI and no EVAL, and §5.1 rules out Lua here. The
   * residual window is between this read and its delete; a caller that loses it is still caught by
   * re-reading the holder after its second claim, which is why claimKey does both.
   */
  async releaseIdempotencyKeyIf(owner: string, key: string, expected: string): Promise<boolean> {
    const k = idempotencyKeyKey(this.tag(owner), key);
    const held = await this.guard(() => this.redis.hGetAll(k));
    // An already-empty key counts as released: the caller's next claim then wins it outright.
    if (held.turnId !== undefined && held.turnId !== expected) return false;
    await this.guard(() => this.redis.del([k]));
    return true;
  }

  async create(rec: TurnRecord): Promise<void> {
    await this.guard(() =>
      this.redis.hSet(this.key(rec.turnId), {
        turnId: rec.turnId,
        owner: rec.owner,
        tenant: rec.tenant,
        sessionId: rec.sessionId,
        cfg: rec.cfg,
        credentialName: rec.credentialName,
        caps: JSON.stringify(rec.caps),
        idempotencyKey: rec.idempotencyKey,
        envelope: JSON.stringify(rec.envelope),
        state: rec.state,
        attempts: String(rec.attempts),
        createdAt: String(rec.createdAt),
      }),
    );
    // The OPEN set, written after the hash: a member whose hash is missing reads as "already gone"
    // (listByOwner's rule), while a hash with no member would be invisible to the quota. Idempotent
    // against `reserveOpenSlot`, which a submission calls with this same turn id before creating the
    // record: ZADD on an existing member only rewrites its score, so the slot is taken once.
    await this.guard(() =>
      this.redis.zAdd(this.ownerKey(rec.owner), { score: rec.createdAt, value: rec.turnId }),
    );
  }

  async get(turnId: string): Promise<TurnRecord | null> {
    const h = await this.guard(() => this.redis.hGetAll(this.key(turnId)));
    // A hash with no `owner` is a partial write, not a turn owned by nobody -- the rule
    // OwnershipIndex.get already applies, for the same reason: assertOwner must not get an empty
    // string to compare an empty principal against.
    if (!h.owner) return null;
    const state = (TURN_STATES as readonly string[]).includes(h.state ?? '')
      ? (h.state as TurnState)
      : 'queued';
    return {
      turnId,
      owner: h.owner,
      tenant: h.tenant ?? h.owner,
      sessionId: h.sessionId ?? '',
      cfg: h.cfg ?? '',
      credentialName: h.credentialName ?? '',
      caps: parseJson<TurnCaps>(h.caps) ?? {},
      idempotencyKey: h.idempotencyKey ?? '',
      envelope: parseJson<Record<string, unknown>>(h.envelope) ?? {},
      state,
      attempts: Number(h.attempts ?? 0),
      createdAt: Number(h.createdAt ?? 0),
      ...(h.endedAt ? { endedAt: Number(h.endedAt) } : {}),
    };
  }

  /**
   * The owner's NON-TERMINAL turns, as one ZCARD (§4.3). The open set holds exactly those, because
   * every terminal transition removes from it -- so this cannot drift from the records it describes,
   * and no second counter exists to disagree with them.
   */
  async countOpen(owner: string): Promise<number> {
    return this.guard(() => this.redis.zCard(this.ownerKey(owner)));
  }

  /**
   * Take a quota slot for `turnId` and answer the owner's open count INCLUDING it (§4.3).
   *
   * The quota must be decided by a WRITE. Reading the count and then checking it lets every
   * concurrent submission read the same under-limit number and all pass -- measured against real
   * Redis, 100 parallel submissions were all accepted with the limit at 5, because each one's ZCARD
   * ran before any other's record existed. The slot is therefore claimed first and counted second,
   * so a submission that is over the limit sees itself in the count.
   *
   * The member is the turn id the caller is about to create, so a reservation that becomes a record
   * costs no extra write -- `create`'s own zAdd re-adds the same member with the same score. A
   * caller that does NOT go on to create it (refused here, or deduplicated onto an existing turn)
   * must `releaseOpenSlot` it, or the slot stays burned for the deployment's lifetime.
   */
  async reserveOpenSlot(owner: string, turnId: string, now: number): Promise<number> {
    await this.guard(() => this.redis.zAdd(this.ownerKey(owner), { score: now, value: turnId }));
    return this.countOpen(owner);
  }

  /** Give back a slot `reserveOpenSlot` took for a turn that will never exist. */
  async releaseOpenSlot(owner: string, turnId: string): Promise<void> {
    await this.guard(() => this.redis.zRem(this.ownerKey(owner), turnId));
  }

  /**
   * Delete `sessionId`'s OPEN turns and return their quota slots, for `OwnershipIndex.cascadeDelete`
   * (F2). A TERMINAL turn is left alone -- it already carries a TTL (§5.1) and will expire on its
   * own, so re-deleting it here would only duplicate that clock. Only `queued`/`running` turns are
   * at risk: nothing else in this design will ever move them to terminal once their session is gone,
   * so without this they would hold their owner's quota slot forever.
   *
   * This is the only place outside `turn-handlers.ts` that knows a session can own several turns
   * over its life, which is why the cleanup lives here rather than as a `dataKeys` entry in
   * `ownership.ts`: a turn key is keyed by turnId, not sessionId, so `cascadeDelete` cannot name it
   * without restating `TurnStore`'s own key derivation.
   *
   * Open-set member removed BEFORE the hash: a crash between the two steps must leave the quota
   * slot freed (the bug this method exists to fix) even if the orphaned hash itself lingers, which
   * matches `get`'s existing rule that a member with no hash reads as "already gone".
   */
  async deleteSessionTurns(sessionId: string, owner: string): Promise<void> {
    const ids = await this.guard(() =>
      this.redis.zRange(this.ownerKey(owner), '+inf', '-inf', { BY: 'SCORE', REV: true }),
    );
    for (const turnId of ids) {
      const rec = await this.get(turnId);
      if (!rec || rec.sessionId !== sessionId) continue;
      await this.guard(() => this.redis.zRem(this.ownerKey(owner), turnId));
      await this.guard(() => this.redis.del([this.key(turnId)]));
      await this.releaseIdempotencyKeyIf(owner, rec.idempotencyKey, turnId);
    }
  }

  /**
   * `queued → running` at claim, writing `attempts` from the entry's `deliveryCount`. A record
   * ALREADY `running` is a redelivery and stays `running` with the new count: refusing it would ack
   * and drop every crash-reclaimed, drained or `retryable` entry (§5.4). Only `cancelled` and
   * terminal states are refused.
   */
  async markRunning(turnId: string, attempts: number): Promise<'ok' | 'refused'> {
    const rec = await this.get(turnId);
    if (!rec || isTerminalState(rec.state)) return 'refused';
    await this.guard(() =>
      this.redis.hSet(this.key(turnId), { state: 'running', attempts: String(attempts) }),
    );
    return 'ok';
  }

  async finalize(turnId: string, state: TurnState, now: number): Promise<'ok' | 'refused'> {
    if (!isTerminalState(state)) {
      throw new CpError('internal_error', `finalize needs a terminal state, got '${state}'`);
    }
    const rec = await this.get(turnId);
    if (!rec || isTerminalState(rec.state)) return 'refused';
    return this.toTerminal(rec, state, now);
  }

  /**
   * A `queued` turn flips to `cancelled`; anything else is a conflict naming its state. A RUNNING
   * leaf is deliberately not interrupted (§4.5): interrupting one needs a signal addressed to the
   * single worker holding it, which does not exist.
   */
  async cancel(turnId: string, now: number): Promise<'cancelled' | 'conflict'> {
    const rec = await this.get(turnId);
    if (!rec || rec.state !== 'queued') return 'conflict';
    await this.toTerminal(rec, 'cancelled', now);
    return 'cancelled';
  }

  /**
   * Record first, open-set second, TTL last. That order is the invariant: the TTL is the only
   * irreversible step, so it goes after the state is durable, and the open-set removal goes before
   * it so a reader that arrives mid-way sees a terminal record rather than an expiring open one.
   *
   * The idempotency-key release sits between record and open-set. It cannot go before the record
   * write: releasing first would let a resubmission re-claim the key and create a SECOND record
   * while this one still reads `queued`, which is the duplicate fan-out §4.3 exists to prevent. Once
   * the record is terminal, though, a resubmission that wins the freed key is safe no matter when it
   * arrives -- `claimKey`'s stale-stepover already handles "key points at a terminal turn" for every
   * caller that loses this race, so putting the release any later only widens that window for no
   * benefit. The release COMPARES, as every release here does: by the time a turn goes terminal, a
   * newer submission may already have re-claimed this key (F1), and a blind `del` would delete that
   * live claim instead of the stale one that belongs to this turn.
   */
  private async toTerminal(
    rec: TurnRecord,
    state: TurnState,
    now: number,
  ): Promise<'ok' | 'refused'> {
    await this.guard(() => this.redis.hSet(this.key(rec.turnId), { state, endedAt: String(now) }));
    await this.releaseIdempotencyKeyIf(rec.owner, rec.idempotencyKey, rec.turnId);
    await this.guard(() => this.redis.zRem(this.ownerKey(rec.owner), rec.turnId));
    await this.guard(() =>
      this.redis.expire(
        this.key(rec.turnId),
        this.opts.resultTtlSeconds + this.opts.ttlMarginSeconds,
      ),
    );
    return 'ok';
  }
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt field reads as absent rather than throwing: a record half-written by an older
    // version must still report its state, which is what §4.4 promises a polling caller.
    return null;
  }
}
