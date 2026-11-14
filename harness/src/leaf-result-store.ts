import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import type { Verdict } from './verdict.js';
import type { LeafResult, LeafUsage } from './run-leaf.js';
import type { TurnSeed, TurnWorkspace } from './run-turn.js';

export interface LeafResultRecord {
  status: 'done' | 'failed' | 'aborted' | 'paused' | 'solved' | 'responded';
  verdict: Verdict | null;
  gate: { gateId: number; summary: string; proposed_action: string } | null;
  reason: string | null;
  patch: string | null; // solve-leaf candidate patch (unified diff); null for non-solve results
  text: string | null; // prompt-leaf assistant text; null for non-prompt results
  usage: LeafUsage | null; // solve/prompt cumulative token usage (for run cost pricing); null otherwise
  sessionId: string; // RAW (un-sanitized) id, for caller correlation
  ts: string;
  /** A templated session's prompt leaf only (session-templates spec §5.1); absent otherwise. */
  seed?: TurnSeed;
  workspace?: TurnWorkspace;
}

/** Minimal structural Redis surface — lets unit tests inject an in-memory fake. */
export interface RedisLike {
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * With `turnId`, THIS TURN's result; without it, the session's — the shape the synchronous `/runs`
 * path has always used, where one session has one leaf at a time.
 *
 * An async session does not: §4.3 lets one session hold several queued turns at once, as long as
 * their `idempotencyKey`s differ. Under one key per session those siblings overwrite each other, so
 * `GET …/turns/A` could answer `done` with B's body. The turn id is what makes each answer its own.
 */
export function resultKey(leafSessionId: string, turnId?: string): string {
  return turnId ? `leaf:result:${leafSessionId}:${turnId}` : `leaf:result:${leafSessionId}`;
}

/** Map a terminal LeafResult to the persisted record. `rawSessionId` is the un-sanitized envelope id. */
export function toResultRecord(
  result: LeafResult,
  rawSessionId: string,
  ts: string,
): LeafResultRecord {
  const base: LeafResultRecord = {
    status: 'failed',
    verdict: null,
    gate: null,
    reason: null,
    patch: null,
    text: null,
    usage: null,
    sessionId: rawSessionId,
    ts,
  };
  if (result.status === 'done') return { ...base, status: 'done', verdict: result.verdict };
  if (result.status === 'solved')
    return { ...base, status: 'solved', patch: result.patch, usage: result.usage ?? null };
  if (result.status === 'responded')
    return {
      ...base,
      status: 'responded',
      text: result.text,
      usage: result.usage ?? null,
      ...(result.seed ? { seed: result.seed } : {}),
      ...(result.workspace ? { workspace: result.workspace } : {}),
    };
  if (result.status === 'paused') {
    return {
      ...base,
      status: 'paused',
      gate: {
        gateId: result.gateId,
        summary: result.gate.summary,
        proposed_action: result.gate.proposed_action,
      },
    };
  }
  if (result.status === 'aborted') return { ...base, status: 'aborted' };
  return { ...base, status: 'failed', reason: result.reason };
}

export async function writeResult(
  redis: RedisLike,
  leafSessionId: string,
  record: LeafResultRecord,
  ttlSeconds: number,
  turnId?: string,
): Promise<void> {
  await redis.set(resultKey(leafSessionId, turnId), JSON.stringify(record), { EX: ttlSeconds });
}

export async function readResult(
  redis: RedisLike,
  leafSessionId: string,
  turnId?: string,
): Promise<LeafResultRecord | null> {
  const raw = await redis.get(resultKey(leafSessionId, turnId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LeafResultRecord;
  } catch {
    return null;
  }
}

/** Real client used by the server and async worker. Reuses REDIS_URL, connects lazily. */
export class RedisResultStore implements RedisLike {
  private client: RedisClientType;
  private ready: Promise<void> | null;
  constructor(url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') {
    // Listener + bounded reconnect, which only work as a pair: no listener and an 'error' on an
    // established connection exits the process; a listener with node-redis's default strategy silences
    // the error that makes a failed connect() reject, so it hangs instead. See redis-errors.ts.
    this.client = createClient(resilientClientOptions(url)) as RedisClientType;
    swallowRedisErrors(this.client, 'leaf result store');
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
    if (this.ready && !this.client.isOpen) this.ready = null;
    return (this.ready ??= this.arm());
  }

  async set(key: string, value: string, opts?: { EX?: number }): Promise<unknown> {
    await this.open();
    return opts?.EX ? this.client.set(key, value, { EX: opts.EX }) : this.client.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    await this.open();
    return this.client.get(key);
  }
  async del(key: string): Promise<unknown> {
    await this.open();
    return this.client.del(key);
  }
  /** Atomic read-and-remove (Redis 6.2+; every deployment pins Valkey 9). The run-lease reaper
   * claims orphaned markers with it, so concurrent sweepers cannot double-finalize one run. */
  async getdel(key: string): Promise<string | null> {
    await this.open();
    return this.client.getDel(key);
  }
  /** Every key matching a glob pattern, via SCAN — never KEYS, which blocks the data-plane
   * Redis for the whole keyspace. The run-lease reaper is the only caller. */
  async keys(pattern: string): Promise<string[]> {
    await this.open();
    const found: string[] = [];
    // redis@6's scanIterator yields a PAGE of keys per iteration, not one key.
    for await (const page of this.client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
      found.push(...page);
    }
    return found;
  }
  /** Run a Lua script atomically. The workload lifecycle uses it for compare-and-set transitions. */
  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    await this.open();
    return this.client.eval(script, options);
  }
  /**
   * Close what is open, without propagating a failed connect: `await this.ready` meant a client that
   * never connected could not be closed AT ALL. Same bug, same fix as RedisSessionBackend.close().
   */
  async close(): Promise<void> {
    await this.ready?.catch(() => {});
    if (this.client.isOpen) await this.client.close();
  }
}
