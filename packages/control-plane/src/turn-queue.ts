import type { CpRedisLike } from './ownership.js';
import { CpError } from './errors.js';

/**
 * The stream and group the restored consumer reads (async spec §10): the names
 * `RedisWorkQueue`'s constructor defaulted to at `38aa2146`, before #691 removed it. Exported
 * constants rather than literals in two packages, because a mismatch between submitter and consumer
 * is a submission that enqueues successfully and is never drained -- silent, not loud.
 */
export const LEAF_QUEUE_STREAM = 'leaf-queue';
export const LEAF_QUEUE_GROUP = 'leaf-workers';

/** Keep a deep backlog from growing without bound; `~` lets Redis trim on node boundaries. */
const QUEUE_MAXLEN = 100_000;

/**
 * What the SUBMITTER needs from the queue, and nothing more (async spec §5.1: "the queue carries a
 * turn id and nothing else"). `claim`/`ack`/`touch`/`reapDeadLetters` belong to the consumer side
 * restored by #389; the control plane deliberately cannot reach them, because a submitter that can
 * claim is a submitter that can be mistaken for a worker.
 */
export interface TurnQueue {
  /** Append `turnId`; resolves to the queue's own entry id (useful in logs, authoritative nowhere). */
  enqueue(turnId: string): Promise<string>;
}

export class RedisTurnQueue implements TurnQueue {
  /**
   * The stream name is a parameter defaulting to the constant, not a hard-coded constant, for ONE
   * reason: the end-to-end suite (Task 9) runs against a real Redis and needs a per-run stream so
   * two copies do not drain each other. Production never passes it, and turn-queue.test.ts pins the
   * default, so the §6.4 name cannot drift.
   */
  constructor(
    private readonly redis: CpRedisLike,
    private readonly stream: string = LEAF_QUEUE_STREAM,
  ) {}

  async enqueue(turnId: string): Promise<string> {
    // An empty id would produce an entry no consumer can resolve to a record, which dead-letters
    // after maxAttempts instead of failing the submission. Caught here, where it is still a 500.
    if (!turnId) throw new CpError('internal_error', 'enqueue requires a non-empty turnId');
    try {
      const id = await this.redis.xAdd(
        this.stream,
        '*',
        { turnId },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: QUEUE_MAXLEN } },
      );
      return String(id);
    } catch {
      // 503, not 500: the submission is retryable and the caller should be told so. Matches
      // OwnershipIndex.guard's reading of a transport failure.
      throw new CpError('redis_unavailable', 'redis is not answering');
    }
  }
}

/**
 * In-memory, for tests that must assert **queue depth** rather than a status code -- which async
 * spec §8 names as the assertion for a refused submission: "enqueues nothing for it -- the queue
 * depth, not just the status code".
 */
export class MemoryTurnQueue implements TurnQueue {
  readonly ids: string[] = [];
  /** Set to make the next enqueue reject, exercising a handler's compensation path. */
  failWith: Error | null = null;

  async enqueue(turnId: string): Promise<string> {
    if (this.failWith) throw this.failWith;
    this.ids.push(turnId);
    return `0-${this.ids.length}`;
  }

  depth(): number {
    return this.ids.length;
  }
}
