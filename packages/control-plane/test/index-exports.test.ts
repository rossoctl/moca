import { describe, expect, it } from 'vitest';
import * as cp from '../src/index.js';

/**
 * The package boundary, pinned. @moca/knative-server's drain loop (#389) reaches the turn record and
 * the queue names through these; a rename that drops one is a worker that fails to compile at best,
 * and at worst a worker that drains a stream nobody submits to.
 */
describe('@moca/control-plane exports', () => {
  it('exports what the async worker needs', () => {
    for (const name of [
      'TurnStore',
      'isTerminalState',
      'LEAF_QUEUE_STREAM',
      'LEAF_QUEUE_GROUP',
      'RedisTurnQueue',
      'asyncCounters',
      'exchangeTurnCredential',
    ]) {
      expect(cp, name).toHaveProperty(name);
    }
  });

  it('names the queue stream and group the submitter writes to', () => {
    expect(cp.LEAF_QUEUE_STREAM).toBe('leaf-queue');
    expect(cp.LEAF_QUEUE_GROUP).toBe('leaf-workers');
  });
});
