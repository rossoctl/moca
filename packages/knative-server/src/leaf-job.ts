// packages/knative-server/src/leaf-job.ts
import { RedisWorkQueue } from '@moca/work-queue';
import { processOne } from '@moca/harness/leaf-job-runner';
import { runLeaf, leafSessionId, type LeafEnvelope } from '@moca/harness/run-leaf';
import { RedisResultStore, toResultRecord, writeResult } from '@moca/harness/leaf-result-store';
import { type TurnConfig } from '@moca/harness/run-turn';

const MIN_IDLE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const CONSUMER_GC_IDLE_MS = 300_000; // 5 min — GC consumers idle longer than this with 0 pending
const RESULT_TTL_SECONDS = parseInt(process.env.LEAF_RESULT_TTL_SECONDS ?? '86400', 10);

function buildConfig(): TurnConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  };
}

// Module-scoped so the top-level catch can close it if an exception escapes the drain loop.
let queue: RedisWorkQueue | undefined;

async function main(): Promise<void> {
  const q = new RedisWorkQueue(process.env.REDIS_URL);
  queue = q;
  await q.ensureGroup();
  const consumerId = process.env.HOSTNAME ?? `leaf-job-${process.pid}`;

  const resultStore = new RedisResultStore(process.env.REDIS_URL);

  // Startup reap: dead-letter stale PEL entries past maxAttempts so pendingEntriesCount drops
  // and KEDA can scale to zero without waiting for reclaim cycles.
  const deadLettered = await q.reapDeadLetters(consumerId, {
    minIdleMs: MIN_IDLE_MS,
    maxAttempts: MAX_ATTEMPTS,
  });
  for (const { entryId, envelope } of deadLettered) {
    if (envelope && typeof envelope === 'object') {
      const env = envelope as LeafEnvelope;
      try {
        await writeResult(
          resultStore,
          leafSessionId(env),
          toResultRecord(
            { status: 'failed', reason: 'error' },
            env.sessionId,
            new Date().toISOString(),
          ),
          RESULT_TTL_SECONDS,
        );
      } catch {
        /* best-effort record write */
      }
    } else {
      console.warn(`reaper: entry ${entryId} dead-lettered with unrecoverable envelope`);
    }
  }
  if (deadLettered.length > 0) {
    console.log(`reaper: dead-lettered ${deadLettered.length} stale entries`);
  }

  // GC idle consumers with 0 pending entries (orphaned by completed/crashed pods).
  const gcCount = await q.gcIdleConsumers(CONSUMER_GC_IDLE_MS);
  if (gcCount > 0) {
    console.log(`reaper: removed ${gcCount} idle consumers`);
  }

  // Drain: process entries until the queue yields nothing ("idle"), then close and exit 0 so
  // KEDA can scale to zero. A transient "retry" closes and exits non-zero (process.exit(1)) so
  // the entry stays pending and a later Job reclaims it. (process.exit skips finally blocks, so
  // the queue is closed explicitly on each terminal path rather than in a finally.)
  for (;;) {
    const outcome = await processOne({
      queue: q,
      runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
      resultStore,
      ttlSeconds: RESULT_TTL_SECONDS,
      consumerId,
    });
    if (outcome === 'idle') break;
    if (outcome === 'retry') {
      // Entry stays pending for another pod to reclaim — do NOT delete our consumer.
      await q.close();
      await resultStore.close();
      process.exit(1);
    }
  }

  // Clean exit: no pending entries for us, safe to remove our consumer registration.
  await q.deleteConsumer(consumerId);
  await q.close();
  await resultStore.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('leaf-job error:', err);
  try {
    await queue?.close();
  } catch {
    // Best-effort close; suppress errors on exit.
  }
  process.exit(1);
});
