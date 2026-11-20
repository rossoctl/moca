import type { CpRedisLike } from './ownership.js';
import { CpError } from './errors.js';
import { sanitizeLimits } from './models.js';
import {
  decodeTurnEvent,
  encodeTurnEvent,
  EVENTS_MAXLEN,
  idempotencyKeyKey,
  isTerminalState,
  ownerEventsKey,
  ownerRunningTurnsKey,
  ownerTurnsKey,
  sessionTurnsKey,
  turnKey,
  TURN_STATES,
  type TurnCaps,
  type TurnEvent,
  type TurnRecord,
  type TurnState,
} from './turn-record.js';
import { leafResultKey } from './turn-result.js';

export interface TurnStoreOptions {
  /** `LEAF_RESULT_TTL_SECONDS` (604800 default) -- the RESULT's lifetime, not the record's. */
  resultTtlSeconds: number;
  /** How much longer than its result a terminal record lives (async spec §5.1). */
  ttlMarginSeconds: number;
  /** Test-only key suffix, so a real-Redis suite can delete exactly what it wrote. */
  keyTag?: string;
}

/**
 * Write hash fields only if the record's CURRENT state is one of the allowed ones. Every state
 * transition here goes through it, because a get-then-write over two round trips is not a
 * compare-and-set: `DELETE /turns/{id}` flipping a record to `cancelled` between a claim's read and
 * its write would be silently overwritten, and the worker would run -- and bill -- a turn the caller
 * had already cancelled and been told was cancelled. The same gap lets the reaper's `lost` overwrite
 * a `done` that landed first, and lets two finalizers each release the idempotency key.
 *
 * ARGV is `[allowedCount, ...allowedStates, ...field, value, field, value]`, flattened because
 * that is the only shape EVAL's argument list has. A missing record (no `state` field) returns 0:
 * nothing is created here, and a record that expired mid-turn must not be resurrected without its
 * owner, caps or envelope.
 *
 * A WINNER answers `{previousState, owner, sessionId}` rather than 1. The previous state is what
 * makes "one event per transition" (#392) decidable at the only place every transition passes: a
 * redelivery rewrites `running` over `running` and must emit nothing, and nothing outside this
 * script can tell the two apart. The owner and session come back on the same round trip because the
 * event stream's key is derived from the owner, and `markRunning` is handed a turn id alone -- a
 * second HGETALL there would be an extra round trip on the claim hot path, per claimed turn.
 */
export const CAS_STATE_LUA = `
local s = redis.call('HGET', KEYS[1], 'state')
if not s then return 0 end
local n = tonumber(ARGV[1])
local ok = false
for i = 2, n + 1 do if s == ARGV[i] then ok = true break end end
if not ok then return 0 end
local fields = {}
for i = n + 2, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('HSET', KEYS[1], unpack(fields))
local meta = redis.call('HMGET', KEYS[1], 'owner', 'sessionId')
return {s, meta[1] or '', meta[2] or ''}
`;

/**
 * Take an owner's CLUSTER-WIDE running slot and answer their count, in one step (#391).
 *
 * ARGV is `[score, turnId, cap]`. The add and the count have to be atomic because separately they
 * are exact in one direction only. Counting first is wrong: N workers that each read an under-limit
 * ZCARD before any of them writes all pass (`reserveOpenSlot` measured that against real Redis).
 * Adding first and counting second never admits more than `cap` -- but N workers that each add
 * before any of them counts all see the full total and all hand their entry back, with none of them
 * running anything, which is exactly the contended case the cap exists for and costs each entry a
 * reclaim window. In one script the loser's add is the only one undone.
 *
 * A returned count over `cap` therefore means "not admitted, and holding nothing": the member is
 * already gone and the caller has no slot to give back.
 */
export const RESERVE_RUNNING_LUA = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
if n > tonumber(ARGV[3]) then
  redis.call('ZREM', KEYS[1], ARGV[2])
end
return n
`;

/** The two states a turn can be written from: everything else is already final (§5.4). */
const OPEN_STATES: readonly TurnState[] = TURN_STATES.filter((s) => !isTerminalState(s));

/**
 * Keys per DEL in `deleteSessionTurns` (two per turn, so 250 turns). Bulk, because the walk spans
 * the whole retention window; bounded, because one DEL of a hundred thousand keys blocks the
 * single-threaded server for everybody else.
 */
const DELETE_CHUNK = 500;

/**
 * The async turn record's only writer (async fan-out spec §5.1). Written against the STRUCTURAL
 * CpRedisLike, so one implementation serves the in-memory fake and real Redis
 * (test/helpers/turn-store-contract.ts runs it against both).
 *
 * Two invariants live here rather than in a handler, because a handler cannot enforce them:
 *
 * - **A non-terminal record carries no TTL at all.** The TTL is set at the terminal transition, to
 *   `resultTtlSeconds + ttlMarginSeconds`. A record that expired on a schedule from creation would
 *   answer 404 -- "never submitted" -- for a turn that succeeded, which is the same conflation §4.4
 *   rejects in `/runs/status`, reintroduced by a TTL instead of by an inference.
 * - **A terminal state is reached once.** Every transition compare-and-sets through
 *   `CAS_STATE_LUA`, so the reaper's `lost` cannot overwrite a `done` that landed first, and a
 *   claim cannot un-cancel a cancelled turn.
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

  private runningKey(owner: string): string {
    return ownerRunningTurnsKey(this.tag(owner));
  }

  private sessionKey(sessionId: string): string {
    return sessionTurnsKey(this.tag(sessionId));
  }

  /** A terminal record's lifetime, and the session index's: one sum, one place (§5.1). */
  private ttlSeconds(): number {
    return this.opts.resultTtlSeconds + this.opts.ttlMarginSeconds;
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
  /**
   * Who holds `key` right now, WITHOUT claiming it (#393). The decision route's replay check: the
   * claim itself cannot answer it, because claiming an unheld key takes it.
   */
  async idempotencyHolder(owner: string, key: string): Promise<string | null> {
    const k = idempotencyKeyKey(this.tag(owner), key);
    const held = await this.guard(() => this.redis.hGetAll(k));
    return held.turnId ?? null;
  }

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
        // Always written, '' included, exactly as `cfg` is: a hash field present and empty is how
        // "the session named no model" is stored, and `get` reads it back as that.
        model: rec.model,
        modelLimits: rec.modelLimits ? JSON.stringify(rec.modelLimits) : '',
        sandboxTier: rec.sandboxTier,
        caps: JSON.stringify(rec.caps),
        idempotencyKey: rec.idempotencyKey,
        envelope: JSON.stringify(rec.envelope),
        state: rec.state,
        attempts: String(rec.attempts),
        createdAt: String(rec.createdAt),
        // Only when set: an empty string here would read back as a resume of a turn named ''.
        ...(rec.resumeOf ? { resumeOf: rec.resumeOf } : {}),
      }),
    );
    // The OPEN set, written after the hash: a member whose hash is missing reads as "already gone"
    // (listByOwner's rule), while a hash with no member would be invisible to the quota. Idempotent
    // against `reserveOpenSlot`, which a submission calls with this same turn id before creating the
    // record: ZADD on an existing member only rewrites its score, so the slot is taken once.
    await this.guard(() =>
      this.redis.zAdd(this.ownerKey(rec.owner), { score: rec.createdAt, value: rec.turnId }),
    );
    // The SESSION index (§9.2), which unlike the open set keeps a turn after it finishes -- it is
    // what lets `deleteSessionTurns` reach a finished turn's record and result. Given a TTL here
    // rather than only at the terminal transition, so a session whose turns never finish (every one
    // of them `lost` before the reaper's record write, or a crash between the two) cannot leave an
    // immortal key behind; `toTerminal` re-arms it from the same sum.
    await this.guard(() =>
      this.redis.zAdd(this.sessionKey(rec.sessionId), { score: rec.createdAt, value: rec.turnId }),
    );
    await this.guard(() => this.redis.expire(this.sessionKey(rec.sessionId), this.ttlSeconds()));
    // ...and TRIMMED to the retention window on the same write. This is the one index here that keeps
    // a member after its turn finished, and every `create` pushes its expiry out again -- so without
    // this a session that runs turns for a year holds a year of ids, all but the last week of them
    // naming keys that are already gone, and `deleteSessionTurns` enumerates and DELs every one.
    // By score, the same sweep `bundle-budget.ts` does for expired bundles.
    //
    // Safe because of what the score MEANS: `toTerminal` re-scores a member to the moment the turn
    // finished, which is when its record's and result's own TTLs start. So nothing trimmed here can
    // still have a record -- and a turn that outlived the window while still OPEN is reached by the
    // walk's owner-set pass, which does not consult this index at all.
    const cutoff = rec.createdAt - this.ttlSeconds() * 1000;
    await this.guard(() =>
      this.redis.zRemRangeByScore(this.sessionKey(rec.sessionId), '-inf', cutoff),
    );
    // The turn's first transition: it exists and it is queued (#392). After every index write, so a
    // client woken by this event finds the record and the quota already consistent with it.
    await this.emit(rec.owner, {
      ts: rec.createdAt,
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      state: rec.state,
      attempts: rec.attempts,
    });
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
    // Re-sanitized on the way out, as OwnershipIndex.get does for the session's own copy: this field
    // reaches the harness as a turn's `max_tokens`, and a hand-edited or half-written hash must not
    // become one.
    const limits = sanitizeLimits(parseJson(h.modelLimits));
    return {
      turnId,
      owner: h.owner,
      tenant: h.tenant ?? h.owner,
      sessionId: h.sessionId ?? '',
      cfg: h.cfg ?? '',
      credentialName: h.credentialName ?? '',
      // shortcut: a record written before #388 carries neither field, so it reads as "the session
      // named no model", and its leaf runs on the deployment's default model rather than the
      // session's. Only turns already on the queue during that one rollout are affected, and the
      // consequence is one turn answered by the wrong model. Upgrade to a live-session fallback keyed
      // on `h.model === undefined` if a deployment ever needs a queue to survive an upgrade unchanged.
      // The TIER has that fallback already (`turn-exchange.ts`), because there the same gap retiers
      // the session's sandbox and starts its workspace empty -- data loss, not a wrong answer.
      model: h.model ?? '',
      ...(limits ? { modelLimits: limits } : {}),
      sandboxTier: h.sandboxTier ?? '',
      caps: parseJson<TurnCaps>(h.caps) ?? {},
      idempotencyKey: h.idempotencyKey ?? '',
      envelope: parseJson<Record<string, unknown>>(h.envelope) ?? {},
      state,
      attempts: Number(h.attempts ?? 0),
      createdAt: Number(h.createdAt ?? 0),
      ...(h.endedAt ? { endedAt: Number(h.endedAt) } : {}),
      ...(h.cancelRequested === '1' ? { cancelRequested: true } : {}),
      ...(h.resumeOf ? { resumeOf: h.resumeOf } : {}),
    };
  }

  /**
   * This session's newest `paused` turn, and whether a later turn already resumed it (#393).
   *
   * Newest-first over the session index, stopping at the first paused record: a resume is created
   * after the turn it resumes, so every candidate resume has been seen by then. Bounded by `scan`
   * rather than walking a week of turns -- a session whose last 50 turns are all unpaused has no
   * pending gate worth finding, and the alternative (a second index keyed by session) would have to
   * be kept in step with every transition.
   */
  async findPausedBySession(
    sessionId: string,
    scan = 50,
  ): Promise<{ paused: TurnRecord; resumed: boolean } | null> {
    const ids = await this.guard(() =>
      this.redis.zRange(this.sessionKey(sessionId), '+inf', '-inf', {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset: 0, count: scan },
      }),
    );
    const resumed = new Set<string>();
    for (const id of ids) {
      const rec = await this.get(id);
      if (!rec) continue;
      if (rec.resumeOf) resumed.add(rec.resumeOf);
      if (rec.state === 'paused') return { paused: rec, resumed: resumed.has(rec.turnId) };
    }
    return null;
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
   * Take a CLUSTER-WIDE running slot for `turnId` and answer the owner's running count INCLUDING it
   * (#391, `ownerRunningTurnsKey`). Called by the async worker when it admits a claimed entry, which
   * is why it lives here rather than behind a control-plane route: records and queue share one Redis
   * in M1, the same thing `cancelRequested` relies on.
   *
   * `cap` is passed in and enforced inside `RESERVE_RUNNING_LUA` rather than compared by the caller,
   * so that two workers claiming one owner's entries at once cannot both defer: a count over `cap`
   * comes back with this turn's member already removed, and the caller owes nothing.
   *
   * On admission the caller MUST `releaseRunningSlot` on every way out, including the ones that leave
   * the record `running` for another worker to reclaim: the member describes a delivery in flight,
   * not a turn.
   */
  async reserveRunningSlot(
    owner: string,
    turnId: string,
    now: number,
    cap: number,
  ): Promise<number> {
    const n = await this.guard(() =>
      this.redis.eval(RESERVE_RUNNING_LUA, {
        keys: [this.runningKey(owner)],
        arguments: [String(now), turnId, String(cap)],
      }),
    );
    return Number(n ?? 0);
  }

  async releaseRunningSlot(owner: string, turnId: string): Promise<void> {
    await this.guard(() => this.redis.zRem(this.runningKey(owner), turnId));
  }

  /**
   * Delete every one of `sessionId`'s turns -- record, stored result and quota slot -- for
   * `OwnershipIndex.cascadeDelete` (F2).
   *
   * Two enumerations, two passes, and both are needed:
   *
   * - The SESSION index (§9.2), which holds finished turns as well as open ones. It is what makes a
   *   finished turn's record and result go away with its session rather than linger for the result
   *   TTL -- seven days of them since #390, which is why the index stopped being optional.
   * - The owner's OPEN set, exactly as before. A record written before the index existed has no
   *   entry in it, and an open record carries NO TTL at all (§5.1), so dropping this pass would
   *   leak such a turn's hash and its owner's quota slot for the deployment's lifetime.
   *
   * This is the only place outside `turn-handlers.ts` that knows a session can own several turns
   * over its life, which is why the cleanup lives here rather than as a `dataKeys` entry in
   * `ownership.ts`: a turn key is keyed by turnId, not sessionId, so `cascadeDelete` cannot name it
   * without restating `TurnStore`'s own key derivation. The session index must NOT be added to
   * `dataKeys` either -- `deleteSession` cascades before it calls this method, so the index would be
   * gone before the walk could read it, with every test still green.
   *
   * Open-set member removed BEFORE the hash: a crash between the two steps must leave the quota
   * slot freed (the bug this method exists to fix) even if the orphaned hash itself lingers, which
   * matches `get`'s existing rule that a member with no hash reads as "already gone".
   *
   * ONE-SHOT, and it has to finish: `deleteSession` (handlers.ts) tombstones the session through
   * `cascadeDelete` BEFORE calling this, so a second `DELETE` stops in `assertOwner` with
   * `session_not_found` and never re-enters here. Whatever a crash mid-walk leaves behind is
   * reclaimed only by the index's own TTL, which is why the per-turn work below is batched into a
   * fixed handful of round trips instead of three or four per turn: seven days of a busy session's
   * turns is thousands of them, and a walk that outlives its HTTP request is a walk that gets cut.
   * The index key itself goes last, so a cut walk at least leaves the route to the stragglers
   * visible to an operator.
   */
  async deleteSessionTurns(sessionId: string, owner: string): Promise<void> {
    const byRecency = { BY: 'SCORE', REV: true } as const;
    const indexed = new Set(
      await this.guard(() =>
        this.redis.zRange(this.sessionKey(sessionId), '+inf', '-inf', byRecency),
      ),
    );
    const open = await this.guard(() =>
      this.redis.zRange(this.ownerKey(owner), '+inf', '-inf', byRecency),
    );
    const openSet = new Set(open);
    // The OPEN pass, one turn at a time, and it must stay that way: the owner set spans every
    // session of the subject, so each member's record is the only thing that says whose turn it is,
    // and a still-open turn holds both a quota slot and an idempotency claim that only its own
    // record can release. Bounded by the open-turn quota (§4.3), not by the retention window.
    for (const turnId of open) {
      const rec = await this.get(turnId);
      // A record naming another session is that session's turn. One that is ABSENT is only this
      // session's to clean up when the index says so: a missing record in the owner set says
      // nothing about who the turn belonged to, and its hash is not this delete's to remove.
      if (rec ? rec.sessionId !== sessionId : !indexed.has(turnId)) continue;
      await this.guard(() => this.redis.zRem(this.ownerKey(owner), turnId));
      // And its running slot (#391), for the reason the open-set removal above exists: this walk
      // deletes the record outright instead of going through `toTerminal`, so nothing else will.
      await this.guard(() => this.redis.zRem(this.runningKey(owner), turnId));
      // The record AND this turn's result key, which `cascadeDelete`'s `dataKeys` cannot name: the
      // key carries a turn id, so only an enumeration of the session's turns reaches it.
      await this.guard(() => this.redis.del([this.key(turnId), leafResultKey(sessionId, turnId)]));
      // Only with a record in hand: the release compares against the holder, and without the
      // record's own `idempotencyKey` there is nothing to compare.
      if (rec) await this.releaseIdempotencyKeyIf(owner, rec.idempotencyKey, turnId);
    }
    // The INDEXED pass: everything the index names that the open set did not. Every one of them is
    // this session's by construction (`create` adds to this session's key alone) and no longer
    // open, because `toTerminal` is what removed it from the owner set -- and the same step already
    // released its idempotency key and removed its quota slot. So there is nothing left to read per
    // turn, and no reason to spend a round trip reading it: just the keys, deleted in bulk.
    const keys: string[] = [];
    for (const turnId of indexed) {
      if (openSet.has(turnId)) continue;
      keys.push(this.key(turnId), leafResultKey(sessionId, turnId));
    }
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      await this.guard(() => this.redis.del(keys.slice(i, i + DELETE_CHUNK)));
    }
    await this.guard(() => this.redis.del([this.sessionKey(sessionId)]));
  }

  /**
   * `queued → running` at claim, writing `attempts` from the entry's `deliveryCount`. A record
   * ALREADY `running` is a redelivery and stays `running` with the new count: refusing it would ack
   * and drop every crash-reclaimed, drained or `retryable` entry (§5.4). Only `cancelled` and
   * terminal states are refused.
   */
  async markRunning(turnId: string, attempts: number): Promise<'ok' | 'refused'> {
    const won = await this.cas(this.key(turnId), OPEN_STATES, {
      state: 'running',
      attempts: String(attempts),
    });
    if (!won) return 'refused';
    // Only a REAL queued → running is a transition. A redelivery re-writes `running` and must emit
    // nothing, or `watch --json` would print a line for a state change that did not happen -- which
    // is exactly the acceptance criterion "exactly one line per transition".
    if (won.prev !== 'running') {
      await this.emit(won.owner, {
        // `Date.now()` and not an injected clock: this timestamp is descriptive only -- no retention
        // or ordering decision reads it, the cursor does -- and a `now` parameter would change the
        // worker's call site in turn-claim.ts for nothing.
        ts: Date.now(),
        sessionId: won.sessionId,
        turnId,
        state: 'running',
        attempts,
      });
    }
    return 'ok';
  }

  async finalize(
    turnId: string,
    state: TurnState,
    now: number,
    /** The leaf's own reason and gate, carried onto the event so a client needs no follow-up read
     *  (#392). Absent where the caller has no result in hand (the reaper's `lost`). */
    detail?: { reason?: string; gate?: string },
  ): Promise<'ok' | 'refused'> {
    if (!isTerminalState(state)) {
      throw new CpError('internal_error', `finalize needs a terminal state, got '${state}'`);
    }
    // The record is read for the fields `toTerminal` needs AFTER it (owner, idempotencyKey); the
    // state it reports is not trusted, because the CAS inside `toTerminal` re-checks it.
    const rec = await this.get(turnId);
    if (!rec) return 'refused';
    return this.toTerminal(rec, state, now, OPEN_STATES, detail);
  }

  /**
   * A `queued` turn flips to `cancelled` outright. A `running` one gets `cancelRequested` and STAYS
   * `running`, answering `cancelling` (§4.5, #391): the worker holding the leaf polls the flag,
   * aborts the run and finalizes `cancelled` itself -- so no message addressed to one particular
   * worker is needed, only the turn record both already read. Anything else is a conflict naming
   * its state.
   *
   * The state must not become a `cancelling` of its own. Every write a redelivery makes
   * (`markRunning`, `finalize`) compare-and-sets against OPEN_STATES, so a third live state would
   * refuse exactly the crash-reclaimed entries recovery exists for.
   */
  async cancel(turnId: string, now: number): Promise<'cancelled' | 'cancelling' | 'conflict'> {
    // Read, then CAS on the state that read saw, and on a lost CAS read again -- twice at most.
    // Without the retry, a claim landing between the read and the `['queued']` CAS answered
    // `conflict`, which the handler reports as a 409 meaning "already terminal": the caller stops,
    // so the "cancelled through the flag by the caller's next DELETE" this used to rely on never
    // happens and a running turn is uncancellable for the rest of its life. Two passes are enough
    // because only queued → running can defeat the first, and the running CAS that follows loses
    // only to a finalize, which is a real conflict.
    //
    // So falling out of the loop is an HONEST conflict, not a lost race: CAS_STATE_LUA returns 0
    // only when the state is outside the allowed set or the record is gone, and the sole transition
    // out of `running` is a terminal one. A third pass would re-read a turn that is already final.
    // The 409's message is built from a FRESH read for the same reason (turn-handlers.ts).
    for (let attempt = 0; attempt < 2; attempt++) {
      const rec = await this.get(turnId);
      if (!rec) return 'conflict';
      if (rec.state === 'running') {
        // Already requested: idempotent, so a caller retrying a DELETE sees the same answer rather
        // than a 409 for a cancel that is in flight. Emits NO event (#392): the record stays
        // `running`, so this is not a state transition, and the `cancelled` that follows when the
        // worker stops is emitted by `toTerminal`.
        if (await this.cas(this.key(turnId), ['running'], { cancelRequested: '1' }))
          return 'cancelling';
        continue;
      }
      if (rec.state !== 'queued') return 'conflict';
      if ((await this.toTerminal(rec, 'cancelled', now, ['queued'])) === 'ok') return 'cancelled';
    }
    return 'conflict';
  }

  /**
   * Has a cancel been requested for this RUNNING turn (#391)? One field, not the whole record: the
   * worker polls this every couple of seconds for every leaf it is running, and the record carries
   * the turn's whole envelope.
   */
  async cancelRequested(turnId: string): Promise<boolean> {
    const v = await this.guard(() => this.redis.hGet(this.key(turnId), 'cancelRequested'));
    return v === '1';
  }

  /**
   * Who owns this turn, or '' when there is no record (#391's per-owner fairness). One field for
   * `cancelRequested`'s reason: the async worker reads it for every entry it claims, before it
   * decides whether that owner may run another leaf, and the whole record carries an envelope.
   *
   * An absent record answers '' rather than throwing: the caller's next step is the claim, which
   * is the call that resolves what a missing record means (refused, not deferred).
   */
  async owner(turnId: string): Promise<string> {
    return (await this.guard(() => this.redis.hGet(this.key(turnId), 'owner'))) ?? '';
  }

  /**
   * One CAS attempt, with the transport mapped to 503 like every other call here. A winner answers
   * what it REPLACED, for the caller's event emit (#392); a loser answers null.
   */
  private async cas(
    key: string,
    allowed: readonly TurnState[],
    fields: Record<string, string>,
  ): Promise<{ prev: TurnState; owner: string; sessionId: string } | null> {
    const won = await this.guard(() =>
      this.redis.eval(CAS_STATE_LUA, {
        keys: [key],
        arguments: [String(allowed.length), ...allowed, ...Object.entries(fields).flat()],
      }),
    );
    // A loser is the number 0; a winner is the three-element table above.
    if (!Array.isArray(won)) return null;
    const [prev, owner, sessionId] = won as string[];
    return { prev: prev as TurnState, owner: owner ?? '', sessionId: sessionId ?? '' };
  }

  /**
   * Append one transition to the owner's event stream (#392), best-effort and AFTER the state is
   * durable. Deliberately not inside the CAS's Lua: the stream's key is a sha256 of the subject
   * taken in TypeScript, so making it atomic would mean storing that derived key on every record
   * just to pass it as KEYS[2].
   *
   * shortcut: a process death between the CAS and this XADD loses the event, and a thrown XADD is
   * swallowed -- a finished turn must not become a refused transition because its notification
   * failed. Every client therefore keeps a slow re-read (mocactl's `watch` sweeps every 60 s);
   * upgrade to the KEYS[2] form if a client ever wants to drop that.
   */
  private async emit(owner: string, e: TurnEvent): Promise<void> {
    // A record with no owner is a partial write (`get`'s rule); there is no stream to key.
    if (!owner) return;
    const key = ownerEventsKey(this.tag(owner));
    try {
      await this.redis.xAdd(key, '*', encodeTurnEvent(e), {
        TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: EVENTS_MAXLEN },
      });
      // #390's retention, derived rather than restated: the log outlives the records it describes by
      // exactly the margin they outlive their results by. Re-armed on every append, so an active
      // owner's cursor never expires under them.
      await this.redis.expire(key, this.ttlSeconds());
    } catch {
      // Best effort, by the shortcut above.
      //
      // shortcut: the append and the EXPIRE are two commands, so an append that lands before a
      // failed EXPIRE leaves the key with no TTL -- bounded at EVENTS_MAXLEN entries, but immortal
      // until the owner's next transition re-arms it. Wrap the pair in a MULTI when CpRedisLike
      // grows one (nothing else here needs a transaction today).
    }
  }

  /** The owner's events AFTER `since` (exclusive), oldest first. `'0-0'` reads from the start. */
  async readEvents(owner: string, since: string, count: number): Promise<TurnEvent[]> {
    const rows = await this.guard(() =>
      this.redis.xRange(ownerEventsKey(this.tag(owner)), `(${since}`, '+', { COUNT: count }),
    );
    return rows.map((r) => decodeTurnEvent(r.id, r.message));
  }

  /**
   * Where the stream ends now, or `'0-0'` when the owner has none: the cursor a client that asked
   * for no history starts from.
   */
  async lastEventId(owner: string): Promise<string> {
    const rows = await this.guard(() =>
      this.redis.xRevRange(ownerEventsKey(this.tag(owner)), '+', '-', { COUNT: 1 }),
    );
    return rows[0]?.id ?? '0-0';
  }

  /**
   * The oldest event still kept, or `''` when the owner has none -- what a `since` older than the
   * retention window is compared against (the route's `gap` frame).
   */
  async firstEventId(owner: string): Promise<string> {
    const rows = await this.guard(() =>
      this.redis.xRange(ownerEventsKey(this.tag(owner)), '-', '+', { COUNT: 1 }),
    );
    return rows[0]?.id ?? '';
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
    allowed: readonly TurnState[],
    detail?: { reason?: string; gate?: string },
  ): Promise<'ok' | 'refused'> {
    // The CAS is the gate for everything below it. A loser does nothing at all -- in particular it
    // does not release the idempotency key or re-arm the TTL, both of which belong to the writer
    // that actually made the record terminal.
    if (!(await this.cas(this.key(rec.turnId), allowed, { state, endedAt: String(now) }))) {
      return 'refused';
    }
    await this.releaseIdempotencyKeyIf(rec.owner, rec.idempotencyKey, rec.turnId);
    await this.guard(() => this.redis.zRem(this.ownerKey(rec.owner), rec.turnId));
    // The cluster-wide running slot too (#391). The worker that admitted the delivery releases it
    // itself on every path out, so this is the one case that worker cannot cover: it was SIGKILLed
    // mid-leaf, and the entry's redelivery dead-lettered rather than ran. Idempotent -- a ZREM of a
    // member that is not there is the normal case here.
    await this.guard(() => this.redis.zRem(this.runningKey(rec.owner), rec.turnId));
    await this.guard(() => this.redis.expire(this.key(rec.turnId), this.ttlSeconds()));
    // The session index LAST, and off the same sum: it must never expire while a record it points at
    // is still there, or `deleteSessionTurns` loses its only route to that record and its result.
    // Re-armed rather than set once, because this turn's record just started a fresh clock. A record
    // written before #390 has no index entry; the walk keeps the owner-set pass for those.
    if (rec.sessionId) {
      // Re-scored to NOW first, which is what makes `create`'s trim safe: the member's score becomes
      // the moment this record's own TTL started, so "older than the window" means "its record is
      // gone" rather than "it was submitted a long time ago". Same member, so nothing is added; the
      // walk reads this index as a set and has no order to disturb.
      await this.guard(() =>
        this.redis.zAdd(this.sessionKey(rec.sessionId), { score: now, value: rec.turnId }),
      );
      await this.guard(() => this.redis.expire(this.sessionKey(rec.sessionId), this.ttlSeconds()));
    }
    await this.emit(rec.owner, {
      ts: now,
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      state,
      attempts: rec.attempts,
      ...(detail?.reason ? { reason: detail.reason } : {}),
      ...(detail?.gate ? { gate: detail.gate } : {}),
    });
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
