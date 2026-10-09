import { createClient, type RedisClientType } from 'redis';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import type { Verdict } from './verdict.js';
import type { LeafResult, LeafUsage } from './run-leaf.js';

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
}

/** Minimal structural Redis surface — lets unit tests inject an in-memory fake. */
export interface RedisLike {
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function resultKey(leafSessionId: string): string {
  return `leaf:result:${leafSessionId}`;
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
    return { ...base, status: 'responded', text: result.text, usage: result.usage ?? null };
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
): Promise<void> {
  await redis.set(resultKey(leafSessionId), JSON.stringify(record), { EX: ttlSeconds });
}

export async function readResult(
  redis: RedisLike,
  leafSessionId: string,
): Promise<LeafResultRecord | null> {
  const raw = await redis.get(resultKey(leafSessionId));
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
