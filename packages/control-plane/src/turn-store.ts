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

  /** Released when the turn goes terminal, so the same session can submit again (§4.3). */
  async releaseIdempotencyKey(owner: string, key: string): Promise<void> {
    await this.guard(() => this.redis.del([idempotencyKeyKey(this.tag(owner), key)]));
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
    // (listByOwner's rule), while a hash with no member would be invisible to the quota.
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
   */
  private async toTerminal(
    rec: TurnRecord,
    state: TurnState,
    now: number,
  ): Promise<'ok' | 'refused'> {
    await this.guard(() => this.redis.hSet(this.key(rec.turnId), { state, endedAt: String(now) }));
    await this.guard(() => this.redis.zRem(this.ownerKey(rec.owner), rec.turnId));
    await this.guard(() =>
      this.redis.expire(this.key(rec.turnId), this.opts.resultTtlSeconds + this.opts.ttlMarginSeconds),
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
