// harness/src/leaf-job-runner.ts
import type { WorkQueue } from '@moca/work-queue';
import { classifyOutcome } from './classify-outcome.js';
import { leafSessionId, type LeafEnvelope, type LeafResult } from './run-leaf.js';
import { toResultRecord, writeResult, type RedisLike } from './leaf-result-store.js';

export interface LeafJobDeps {
  queue: WorkQueue;
  runLeaf: (env: LeafEnvelope) => Promise<LeafResult>;
  resultStore: RedisLike;
  ttlSeconds: number;
  consumerId: string;
  maxAttempts?: number;
  minIdleMs?: number;
  blockMs?: number;
  heartbeatMs?: number;
  now?: () => string;
  setHeartbeat?: (fn: () => void, ms: number) => unknown;
  clearHeartbeat?: (h: unknown) => void;
}

/**
 * Claim and process at most one queue entry.
 * - "idle": nothing to claim.
 * - "deadletter": delivery count exceeded → failed result record + ack, runLeaf not run.
 * - "done"/"failed"/"paused"/"aborted"/"solved"/"responded": runLeaf reached this terminal/parked state → write
 *   the result record + ack. "solved" is a terminal success (a solve leaf writes a patch record + ack); "responded"
 *   is likewise a terminal success (a prompt leaf writes a response record + ack).
 * - "retry": transient error → NO record, NOT acked (entry stays pending for reclaim).
 */
export async function processOne(
  deps: LeafJobDeps,
): Promise<
  | 'done'
  | 'failed'
  | 'paused'
  | 'aborted'
  | 'solved'
  | 'responded'
  | 'deadletter'
  | 'idle'
  | 'retry'
> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 5_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const now = deps.now ?? (() => new Date().toISOString());
  const setHb = deps.setHeartbeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearHb =
    deps.clearHeartbeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const claimed = await deps.queue.claim(deps.consumerId, { minIdleMs, blockMs });
  if (!claimed) return 'idle';

  const env = claimed.envelope as LeafEnvelope;
  const sid = leafSessionId(env);

  if (claimed.deliveryCount > maxAttempts) {
    await writeResult(
      deps.resultStore,
      sid,
      toResultRecord({ status: 'failed', reason: 'error' }, env.sessionId, now()),
      deps.ttlSeconds,
    );
    await deps.queue.ack(claimed.entryId);
    return 'deadletter';
  }

  const hb = setHb(() => {
    void deps.queue.touch(claimed.entryId, deps.consumerId);
  }, heartbeatMs);
  let result: LeafResult;
  try {
    result = await deps.runLeaf(env);
  } finally {
    clearHb(hb);
  }

  const outcome = classifyOutcome(result);
  if (outcome.retryable) return 'retry';

  await writeResult(
    deps.resultStore,
    sid,
    toResultRecord(result, env.sessionId, now()),
    deps.ttlSeconds,
  );
  if (outcome.ack) {
    await deps.queue.ack(claimed.entryId);
    return result.status;
  }
  return 'retry';
}
