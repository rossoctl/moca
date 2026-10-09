import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import { forLog } from './sandbox-affinity.js';
import type { AbortReasonCode, TurnStreamFrame } from './turn-stream.js';

/**
 * Detachable turns (turn-reattach spec §5). A turn that opts in outlives its HTTP connection: a
 * per-session lease makes it the session's one live turn, a per-turn Redis Stream holds every frame
 * so any process can replay and follow it, and cancel is an explicit request rather than a dropped
 * socket. Lives in the data-plane Redis beside the session log it describes.
 */
export const activeKey = (sid: string) => `sh:turn:${sid}:active`;
export const lastKey = (sid: string) => `sh:turn:${sid}:last`;
export const eventsKey = (sid: string, turnId: string) => `sh:turn:${sid}:${turnId}:events`;
export const watchKey = (sid: string, turnId: string) => `sh:turn:${sid}:${turnId}:watch`;
/** Set, with the log's TTL, in the step that logs the turn's terminal: nothing is appended after. */
export const termKey = (sid: string, turnId: string) => `sh:turn:${sid}:${turnId}:term`;
export const CANCEL_CHANNEL = 'sh:turn:cancel';

/** The reasons the owner itself aborts; `owner_lost` is written by an attach (§5.1), never here. */
export type AbortReason = Exclude<AbortReasonCode, 'owner_lost'>;

/** The SSE id of a logged frame: the turn it belongs to, then its stream entry id. */
export const eventId = (turnId: string, entryId: string) => `${turnId}:${entryId}`;

export function parseEventId(s: string): { turnId: string; entryId: string } | undefined {
  const i = s.lastIndexOf(':');
  if (i <= 0) return undefined;
  const entryId = s.slice(i + 1);
  return /^\d+-\d+$/.test(entryId) ? { turnId: s.slice(0, i), entryId } : undefined;
}

export function compareEntryIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  if (am !== bm) return am! < bm! ? -1 : 1;
  return as === bs ? 0 : as! < bs! ? -1 : 1;
}

export interface TurnRegistryTimings {
  leaseMs: number;
  renewMs: number;
  detachedMaxMs: number;
  logTtlS: number;
  maxLen: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (!raw) return def; // unset or empty: the default, as compose's blank passthrough means
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function turnRegistryTimings(env: NodeJS.ProcessEnv = process.env): TurnRegistryTimings {
  return {
    leaseMs: 30_000,
    renewMs: 10_000,
    detachedMaxMs: positiveInt(env, 'SH_TURN_DETACHED_MAX_S', 1800) * 1000,
    logTtlS: positiveInt(env, 'SH_TURN_LOG_TTL_S', 86_400),
    maxLen: 100_000,
  };
}

export function abortMessage(reason: AbortReasonCode, t: TurnRegistryTimings): string {
  switch (reason) {
    case 'cancelled':
      return 'cancelled';
    case 'unwatched':
      return t.detachedMaxMs >= 60_000
        ? `turn unwatched for ${Math.round(t.detachedMaxMs / 60_000)} min`
        : `turn unwatched for ${t.detachedMaxMs / 1000} s`;
    case 'restarting':
      return 'harness restarting';
    case 'lease_lost':
      return 'the turn lost its lease';
    case 'owner_lost':
      return 'the harness process running this turn stopped';
  }
}

export class TurnInProgressError extends Error {
  constructor(readonly turnId: string) {
    super(`session already has a running turn ${turnId}`);
    this.name = 'TurnInProgressError';
  }
}
export class TurnNotFoundError extends Error {
  constructor() {
    super('no running or retained turn for this session');
    this.name = 'TurnNotFoundError';
  }
}
export class TurnMismatchError extends Error {
  constructor(readonly turnId: string) {
    super(`the running turn is ${turnId}`);
    this.name = 'TurnMismatchError';
  }
}
export class TurnRegistryUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`turn registry unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TurnRegistryUnavailableError';
  }
}

/**
 * Bound a registry call: node-redis has no command timeout, so against a blackholed Redis (socket
 * open, nothing answers) a call never settles. Past `ms` this rejects with
 * TurnRegistryUnavailableError; the call itself is not cancelled and may still land later, so use
 * it only where a late landing is harmless (a read, a cancel request). `begin` bounds itself.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TurnRegistryUnavailableError(new Error(`no answer in ${ms} ms`))),
      ms,
    );
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface LoggedFrame {
  id: string;
  frame: TurnStreamFrame;
}

/**
 * KEYS[1]=active KEYS[2]=last KEYS[3]=events ARGV=[leaseJson, leaseMs, turnId, ttlS, turnFrameJson,
 * maxLen]. {'held', holder} when taken; else {'ok', turnFrameEntryId}. Takes the lease and logs the
 * turn frame in one step, and `last` and the log carry the retention TTL from the start (renewal
 * keeps refreshing it): an owner that dies before END leaves nothing behind past ttlS, and no step
 * can leave a log without one.
 */
export const BEGIN_LUA = `
local v = redis.call('GET', KEYS[1])
if v then return {'held', v} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
local id = redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[6], '*', 'f', ARGV[5])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return {'ok', id}`;

/**
 * KEYS[1]=active KEYS[2]=events KEYS[3]=term ARGV=[turnId, frameJson, maxLen]. Logs one of the
 * owner's frames, or nil: once the lease no longer names the turn, or its terminal is logged, the
 * owner's writes are fenced -- the node-redis offline queue would otherwise land them after an
 * attach's owner_lost on reconnect (§5.1). A log that is gone (expired) is not recreated.
 */
export const APPEND_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then return false end
local v = redis.call('GET', KEYS[1])
if not v or cjson.decode(v).turnId ~= ARGV[1] then return false end
if redis.call('EXISTS', KEYS[2]) == 0 then return false end
return redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*', 'f', ARGV[2])`;

/**
 * KEYS[1]=active KEYS[2]=last KEYS[3]=events KEYS[4]=term ARGV=[turnId, leaseMs, ttlS]. Extends OUR
 * lease only, and refreshes the retention TTL on `last`, the log and (if set) the terminal marker:
 * wherever the log's TTL moves, the marker's moves with it. Returns the lease, or nil if not ours.
 */
export const RENEW_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return false end
if cjson.decode(v).turnId ~= ARGV[1] then return false end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
redis.call('EXPIRE', KEYS[3], ARGV[3])
redis.call('EXPIRE', KEYS[4], ARGV[3])
return v`;

/**
 * KEYS[1]=active KEYS[2]=last KEYS[3]=events KEYS[4]=term ARGV=[turnId, ttlS, frameJson, maxLen].
 * Appends the terminal, sets the terminal marker, starts the retention clock, releases the lease --
 * one step, so a watcher never sees a released lease before the terminal it would otherwise
 * synthesize. A turn whose terminal is already logged (an attach wrote owner_lost while this owner
 * stalled past its lease) gets no second one. Returns {entryId, frameJson} of the terminal actually
 * logged, which is then that earlier one -- or {'', frameJson} with the caller's frame if the entry
 * the marker names is gone. The marker's TTL moves with the log's: a marker that expired before
 * its log would let an attach write a second owner_lost.
 */
export const END_LUA = `
local id = redis.call('GET', KEYS[4])
local f = ARGV[3]
if id then
  local e = redis.call('XRANGE', KEYS[3], id, id)
  if #e > 0 then f = e[1][2][2] else id = '' end
  redis.call('EXPIRE', KEYS[4], ARGV[2])
else
  id = redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*', 'f', ARGV[3])
  redis.call('SET', KEYS[4], id, 'EX', ARGV[2])
end
redis.call('EXPIRE', KEYS[3], ARGV[2])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
local v = redis.call('GET', KEYS[1])
if v and cjson.decode(v).turnId == ARGV[1] then redis.call('DEL', KEYS[1]) end
return {id, f}`;

/**
 * KEYS[1]=active KEYS[2]=last ARGV=[turnId or '']. {'none'} | {'mismatch', running} |
 * {'ended', last} | {'requested', turnId}. Sets the lease flag the owner reads at renewal (§5.4).
 */
export const CANCEL_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then
  local last = redis.call('GET', KEYS[2])
  if not last then return {'none'} end
  return {'ended', last}
end
local d = cjson.decode(v)
if ARGV[1] ~= '' and ARGV[1] ~= d.turnId then return {'mismatch', d.turnId} end
d.cancelRequested = true
redis.call('SET', KEYS[1], cjson.encode(d), 'KEEPTTL')
return {'requested', d.turnId}`;

/**
 * KEYS[1]=active KEYS[2]=events KEYS[3]=last KEYS[4]=term ARGV=[turnId, frameJson, ttlS, maxLen].
 * Appends the owner-lost terminal ONLY if no lease names the turn and no terminal is logged yet (the
 * marker, not the tail: a fenced owner can no longer append after one) -- checked and written
 * atomically with the marker, so concurrent attaches write it once (§5.1).
 */
export const OWNER_LOST_LUA = `
local v = redis.call('GET', KEYS[1])
if v and cjson.decode(v).turnId == ARGV[1] then return false end
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
if redis.call('EXISTS', KEYS[2]) == 0 then return false end
local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[4], '*', 'f', ARGV[2])
redis.call('SET', KEYS[4], id, 'EX', ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('EXPIRE', KEYS[3], ARGV[3]) end
return id`;

export class ActiveTurn {
  readonly signal: AbortSignal;
  abortReason?: AbortReason;
  readonly ended: Promise<void>;
  private readonly controller = new AbortController();
  private ownWatched = true;
  private unwatchedSince?: number;
  private lastRenewOk: number;
  private finished = false;
  private renewing = false;
  private resolveEnded!: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly reg: TurnRegistry,
    readonly sessionId: string,
    readonly turnId: string,
    readonly start: LoggedFrame,
    /** The clock read just before BEGIN: the lease was set at some instant after it (§5.1). */
    leaseFrom: number,
  ) {
    this.signal = this.controller.signal;
    this.ended = new Promise((r) => (this.resolveEnded = r));
    this.lastRenewOk = leaseFrom;
    this.timer = setInterval(() => void this.tick(), reg.timings.renewMs);
    this.timer.unref();
  }

  /** Whether the connection that started the turn is still open (§5.3). */
  watched(own: boolean): void {
    this.ownWatched = own;
  }

  abort(reason: AbortReason): void {
    if (this.finished || this.controller.signal.aborted) return;
    this.abortReason = reason;
    this.controller.abort(reason);
  }

  /**
   * Logs one frame; the SSE id to send it with, or undefined when the write failed or was refused
   * because the turn no longer holds its lease or its terminal is logged (§5.2).
   */
  async append(frame: TurnStreamFrame): Promise<string | undefined> {
    try {
      const entry = await this.reg.xadd(this.sessionId, this.turnId, frame);
      return entry === null ? undefined : eventId(this.turnId, entry);
    } catch (err) {
      console.error(
        `[turn-registry] log write failed for ${forLog(this.sessionId)}/${this.turnId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Writes the terminal (marked with the abort reason, if the registry aborted the turn). Returns
   * the terminal actually logged: when one already was (an attach's owner_lost), that one and its
   * id, not `terminal`. On a failed write, `terminal` (marked) and no id.
   */
  async end(terminal: TurnStreamFrame): Promise<{ id?: string; frame: TurnStreamFrame }> {
    if (this.finished) throw new Error('turn already ended');
    this.finished = true;
    clearInterval(this.timer);
    const frame: TurnStreamFrame =
      this.abortReason && terminal.type === 'error'
        ? {
            ...terminal,
            abortReason: this.abortReason,
            errorMessage: abortMessage(this.abortReason, this.reg.timings),
          }
        : terminal;
    let id: string | undefined;
    let logged = frame;
    try {
      const r = await this.reg.endTurn(this.sessionId, this.turnId, frame);
      if (r.entryId) id = eventId(this.turnId, r.entryId);
      logged = r.frame;
    } catch (err) {
      console.error(
        `[turn-registry] terminal write failed for ${forLog(this.sessionId)}/${this.turnId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.reg.forget(this);
    this.resolveEnded();
    return { id, frame: logged };
  }

  /** Stops the renewal timer without ending the turn; only TurnRegistry.close() calls this. */
  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.finished) return;
    // A slow renew must not overlap the next tick: two in flight could judge the lease out of order.
    // But a renew that never settles (a blackholed Redis keeps the socket open, and node-redis has no
    // command timeout) never reaches its catch, so the skipped tick must still enforce the deadline.
    if (this.renewing) return this.checkLeaseDeadline();
    this.renewing = true;
    try {
      await this.renewOnce();
    } finally {
      this.renewing = false;
    }
  }

  /**
   * Stop one renewal interval BEFORE the lease can lapse in Redis, judged by the clock now (after a
   * failed await, or while one hangs), not at tick start: two owners must never both believe they
   * hold the session (§5.1), and waiting for the next tick would come too late.
   */
  private checkLeaseDeadline(): void {
    const { leaseMs, renewMs } = this.reg.timings;
    if (this.reg.now() - this.lastRenewOk >= leaseMs - renewMs) this.abort('lease_lost');
  }

  private async renewOnce(): Promise<void> {
    // Taken BEFORE the renew: the lease is extended at some instant after this, so crediting the
    // earlier time is the conservative reading.
    const now = this.reg.now();
    let lease: { cancelRequested?: boolean } | null;
    try {
      lease = await this.reg.renew(this.sessionId, this.turnId);
      this.lastRenewOk = now;
    } catch {
      return this.checkLeaseDeadline();
    }
    if (this.finished) return;
    if (lease === null) return this.abort('lease_lost');
    if (lease.cancelRequested) return this.abort('cancelled');
    let watched = this.ownWatched;
    if (!watched) {
      try {
        watched = await this.reg.watching(this.sessionId, this.turnId);
      } catch {
        watched = true; // unknown is not "nobody": a Redis blip must not count against the turn
      }
    }
    if (watched) {
      this.unwatchedSince = undefined;
      return;
    }
    this.unwatchedSince ??= now;
    if (now - this.unwatchedSince >= this.reg.timings.detachedMaxMs) this.abort('unwatched');
  }
}

export class TurnRegistry {
  readonly timings: TurnRegistryTimings;
  readonly now: () => number;
  private readonly client: RedisClientType;
  private ready: Promise<void> | null;
  private closed = false;
  private readonly url: string;
  private readonly ownerId: string;
  private sub?: Promise<RedisClientType>;
  private subClient?: RedisClientType;
  private readonly live = new Map<string, ActiveTurn>();
  private readonly readers = new Set<RedisClientType>();

  /**
   * `maxReconnectAttempts` is a seam for tests, not a knob anyone is expected to set -- the same one
   * `resilientClientOptions` documents; unset means its default.
   */
  constructor(opts: {
    url?: string;
    ownerId: string;
    timings?: Partial<TurnRegistryTimings>;
    now?: () => number;
    maxReconnectAttempts?: number;
  }) {
    this.url = opts.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    this.ownerId = opts.ownerId;
    this.timings = { ...turnRegistryTimings(), ...opts.timings };
    this.now = opts.now ?? Date.now;
    this.client = createClient(
      resilientClientOptions(this.url, opts.maxReconnectAttempts),
    ) as RedisClientType;
    swallowRedisErrors(this.client, 'turn registry');
    this.ready = this.arm();
  }

  /** Connect, clearing the memo on rejection so the next call retries. Mirrors RedisSessionBackend.arm(). */
  private arm(): Promise<void> {
    const attempt = this.client.connect().then(() => undefined);
    void attempt.catch(() => {
      if (this.ready === attempt) this.ready = null;
    });
    return attempt;
  }

  /**
   * Await the live attempt, re-arming if the last one FAILED or if node-redis permanently closed the
   * socket past `resilientClientOptions`' bound -- the second is invisible to the `.catch` above,
   * because that connect succeeded. Full rationale and citations on `resilientClientOptions`.
   */
  private open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('turn registry closed'));
    if (this.ready && !this.client.isOpen) this.ready = null;
    return (this.ready ??= this.arm());
  }

  /**
   * Take the session's lease and log the turn frame. `timeoutMs` bounds the whole call (connect,
   * subscribe, BEGIN): past it this rejects with TurnRegistryUnavailableError, and a BEGIN that
   * still lands later is ended at once with an error terminal, so it holds no lease and renews
   * nothing (there is nobody to run it).
   */
  async begin(sessionId: string, opts: { timeoutMs?: number } = {}): Promise<ActiveTurn> {
    const ms = opts.timeoutMs;
    if (ms === undefined) return this.beginOnce(sessionId);
    return new Promise<ActiveTurn>((resolve, reject) => {
      let settled = false; // one flag for both sides: a turn is either handed over or ended here
      const timer = setTimeout(() => {
        settled = true;
        reject(new TurnRegistryUnavailableError(new Error(`no answer in ${ms} ms`)));
      }, ms);
      timer.unref();
      this.beginOnce(sessionId).then(
        (turn) => {
          if (settled) {
            void turn.end({
              type: 'error',
              sessionId,
              stopReason: 'error',
              errorMessage: 'the turn did not start in time',
            });
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(turn);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async beginOnce(sessionId: string): Promise<ActiveTurn> {
    const turnId = randomUUID();
    const frame: TurnStreamFrame = { type: 'turn', turnId, sessionId };
    let r: [string, string];
    let leaseFrom: number;
    try {
      await this.open();
      await this.subscribed();
      // Before BEGIN: the lease starts at some instant after this, so the deadline is conservative.
      leaseFrom = this.now();
      const lease = JSON.stringify({
        turnId,
        owner: this.ownerId,
        startedAt: leaseFrom,
        cancelRequested: false,
      });
      r = (await this.client.eval(BEGIN_LUA, {
        keys: [activeKey(sessionId), lastKey(sessionId), eventsKey(sessionId, turnId)],
        arguments: [
          lease,
          String(this.timings.leaseMs),
          turnId,
          String(this.timings.logTtlS),
          JSON.stringify(frame),
          String(this.timings.maxLen),
        ],
      })) as [string, string];
    } catch (err) {
      throw new TurnRegistryUnavailableError(err);
    }
    if (r[0] === 'held') throw new TurnInProgressError(JSON.parse(r[1]).turnId);
    const turn = new ActiveTurn(
      this,
      sessionId,
      turnId,
      { id: eventId(turnId, r[1]), frame },
      leaseFrom,
    );
    this.live.set(`${sessionId} ${turnId}`, turn);
    return turn;
  }

  /** The session's running detachable turn, or null (§4.4). */
  async peek(sessionId: string): Promise<string | null> {
    await this.open();
    const v = await this.client.get(activeKey(sessionId));
    return v ? (JSON.parse(v) as { turnId: string }).turnId : null;
  }

  async cancel(
    sessionId: string,
    turnId?: string,
  ): Promise<{ turnId: string; outcome: 'requested' | 'ended' }> {
    await this.open();
    const r = (await this.client.eval(CANCEL_LUA, {
      keys: [activeKey(sessionId), lastKey(sessionId)],
      arguments: [turnId ?? ''],
    })) as string[];
    if (r[0] === 'none') throw new TurnNotFoundError();
    if (r[0] === 'mismatch') throw new TurnMismatchError(r[1]!);
    if (r[0] === 'requested') await this.client.publish(CANCEL_CHANNEL, `${sessionId} ${r[1]}`);
    return { turnId: r[1]!, outcome: r[0] as 'requested' | 'ended' };
  }

  /**
   * Replay the session's current (or last retained) turn after `cursor`, then follow it live to
   * its terminal frame (§4.2). A cursor naming another turn, or none, replays from the start. Each
   * attach holds its own connection: XREAD BLOCK would stall every other command on a shared one.
   */
  async *attach(
    sessionId: string,
    cursor: string | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<LoggedFrame> {
    await this.open();
    const turnId = await this.client.get(lastKey(sessionId));
    if (!turnId) throw new TurnNotFoundError();
    const key = eventsKey(sessionId, turnId);
    const first = (await this.client.xRange(key, '-', '+', { COUNT: 1 })) ?? [];
    if (first.length === 0) throw new TurnNotFoundError();
    const parsed = cursor ? parseEventId(cursor) : undefined;
    const after = parsed?.turnId === turnId ? parsed.entryId : undefined;
    const truncated = after !== undefined && compareEntryIds(after, first[0]!.id) < 0;
    let lastId = after !== undefined && !truncated ? after : '0-0';
    // A cursor at or past the tail: on a finished turn there is nothing left to send (§4.2: it
    // "ends at once"); on a running one, XREAD after an id beyond the tail would never match.
    let ended = false;
    if (after !== undefined && !truncated) {
      const tail = ((await this.client.xRevRange(key, '+', '-', { COUNT: 1 })) ?? [])[0];
      if (tail && compareEntryIds(after, tail.id) >= 0) {
        const t = (JSON.parse(tail.message.f) as TurnStreamFrame).type;
        if (t === 'done' || t === 'error') ended = true;
        else lastId = tail.id;
      }
    }
    const start: TurnStreamFrame = {
      type: 'turn',
      turnId,
      sessionId,
      ...(truncated ? { truncated: true } : {}),
      // Caught up on a finished turn: nothing follows, and the client must not read the EOF as a drop.
      ...(ended ? { ended: true } : {}),
    };
    // A same-turn cursor stays the turn frame's id, so a reconnect right after it resumes where the
    // client was rather than replaying (or, after a trim, skipping) what follows.
    yield { id: eventId(turnId, after ?? first[0]!.id), frame: start };
    if (ended) return;

    const reader = this.client.duplicate() as RedisClientType;
    swallowRedisErrors(reader, 'turn attach reader');
    // close() destroys the readers still following a turn, and the generator then ends quietly.
    this.readers.add(reader);
    const stop = () => {
      if (reader.isOpen) reader.destroy();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const blockMs = Math.max(10, Math.floor(this.timings.renewMs / 2));
    let lastCheck = -Infinity;
    try {
      if (signal?.aborted) return;
      await reader.connect();
      for (;;) {
        if (signal?.aborted || this.closed) return;
        const now = this.now();
        if (now - lastCheck >= this.timings.renewMs) {
          lastCheck = now;
          await this.open();
          await this.client.set(watchKey(sessionId, turnId), '1', { PX: this.timings.leaseMs });
          await this.client.eval(OWNER_LOST_LUA, {
            keys: [activeKey(sessionId), key, lastKey(sessionId), termKey(sessionId, turnId)],
            arguments: [
              turnId,
              JSON.stringify({
                type: 'error',
                sessionId,
                stopReason: 'aborted',
                abortReason: 'owner_lost',
                errorMessage: abortMessage('owner_lost', this.timings),
              }),
              String(this.timings.logTtlS),
              String(this.timings.maxLen),
            ],
          });
        }
        const res = await reader.xRead({ key, id: lastId }, { COUNT: 500, BLOCK: blockMs });
        for (const m of res?.[0]?.messages ?? []) {
          lastId = m.id;
          const frame = JSON.parse(m.message.f) as TurnStreamFrame;
          if (frame.type === 'turn') continue; // synthesized above, with the truncation flag
          yield { id: eventId(turnId, m.id), frame };
          if (frame.type === 'done' || frame.type === 'error') return;
        }
      }
    } catch (err) {
      // destroy() rejects whatever the reader was awaiting (connect or XREAD): that is the abort.
      if (signal?.aborted || this.closed) return;
      throw err;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.readers.delete(reader);
      stop();
    }
  }

  /** Drain and exit (§5.5): abort every live turn, then wait up to waitMs for their terminals. */
  async abortAll(reason: AbortReason, waitMs = 2000): Promise<void> {
    const turns = [...this.live.values()];
    for (const t of turns) t.abort(reason);
    await Promise.race([
      Promise.all(turns.map((t) => t.ended)),
      new Promise((r) => setTimeout(r, waitMs).unref()),
    ]);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.live.values()) t.stop();
    this.live.clear();
    for (const r of this.readers) if (r.isOpen) r.destroy();
    this.readers.clear();
    const sub = await this.sub?.catch(() => undefined);
    if (sub?.isOpen) sub.destroy();
    await this.ready?.catch(() => undefined);
    if (this.client.isOpen) this.client.destroy();
  }

  // ---- used by ActiveTurn and attach(); not part of the route-facing surface ----

  /** The owner's fenced append (APPEND_LUA): the entry id, or null when refused. */
  async xadd(sessionId: string, turnId: string, frame: TurnStreamFrame): Promise<string | null> {
    await this.open();
    const id = await this.client.eval(APPEND_LUA, {
      keys: [activeKey(sessionId), eventsKey(sessionId, turnId), termKey(sessionId, turnId)],
      arguments: [turnId, JSON.stringify(frame), String(this.timings.maxLen)],
    });
    return typeof id === 'string' ? id : null;
  }

  /** END_LUA: the entry id and frame of the terminal actually logged; no id if its entry is gone. */
  async endTurn(
    sessionId: string,
    turnId: string,
    frame: TurnStreamFrame,
  ): Promise<{ entryId?: string; frame: TurnStreamFrame }> {
    await this.open();
    const [entryId, f] = (await this.client.eval(END_LUA, {
      keys: [
        activeKey(sessionId),
        lastKey(sessionId),
        eventsKey(sessionId, turnId),
        termKey(sessionId, turnId),
      ],
      arguments: [
        turnId,
        String(this.timings.logTtlS),
        JSON.stringify(frame),
        String(this.timings.maxLen),
      ],
    })) as [string, string];
    return { ...(entryId ? { entryId } : {}), frame: JSON.parse(f) as TurnStreamFrame };
  }

  async renew(sessionId: string, turnId: string): Promise<{ cancelRequested?: boolean } | null> {
    await this.open();
    const v = await this.client.eval(RENEW_LUA, {
      keys: [
        activeKey(sessionId),
        lastKey(sessionId),
        eventsKey(sessionId, turnId),
        termKey(sessionId, turnId),
      ],
      arguments: [turnId, String(this.timings.leaseMs), String(this.timings.logTtlS)],
    });
    return typeof v === 'string' ? JSON.parse(v) : null;
  }

  async watching(sessionId: string, turnId: string): Promise<boolean> {
    await this.open();
    return (await this.client.exists(watchKey(sessionId, turnId))) > 0;
  }

  forget(turn: ActiveTurn): void {
    this.live.delete(`${turn.sessionId} ${turn.turnId}`);
  }

  private subscribed(): Promise<void> {
    // A subscriber node-redis gave up on (past the reconnect bound) is rebuilt, not reused: the same
    // silent permanent close `open()` re-arms the main client for.
    if (this.subClient && !this.subClient.isOpen) {
      this.sub = undefined;
      this.subClient = undefined;
    }
    this.sub ??= (async () => {
      const s = this.client.duplicate() as RedisClientType;
      swallowRedisErrors(s, 'turn cancel subscriber');
      try {
        await s.connect();
        await s.subscribe(CANCEL_CHANNEL, (msg: string) => this.live.get(msg)?.abort('cancelled'));
      } catch (err) {
        if (s.isOpen) s.destroy();
        throw err;
      }
      this.subClient = s;
      return s;
    })().catch((err: unknown) => {
      this.sub = undefined; // retry on the next begin rather than fail every turn forever
      throw err;
    });
    return this.sub.then(() => undefined);
  }
}
