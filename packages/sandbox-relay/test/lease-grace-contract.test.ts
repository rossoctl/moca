import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEASE_MUTATE_TIMEOUT_MS } from '../src/sandbox-caller.js';

/**
 * The relay's mutate timeout outlasts the longest grace a worker boots with (`maxLeaseGraceS` in
 * remote-worker/cmd/microvm-worker/main.go) plus the 60 s margin for the cut Exec's unwind (review
 * #4569829088). This reads the worker's literal; its TestMaxLeaseGraceFitsTheRelayMutateTimeout
 * reads this side's.
 */
describe('LEASE_MUTATE_TIMEOUT_MS and the worker’s maxLeaseGraceS', () => {
  it('leaves the grace limit plus 60 s inside the relay’s timeout', () => {
    const main = readFileSync(
      fileURLToPath(new URL('../../../remote-worker/cmd/microvm-worker/main.go', import.meta.url)),
      'utf8',
    );
    const m = /^const maxLeaseGraceS = (\d+)$/m.exec(main);
    expect(m, 'const maxLeaseGraceS = <n> in main.go').not.toBeNull();
    expect((Number(m![1]) + 60) * 1000).toBeLessThanOrEqual(LEASE_MUTATE_TIMEOUT_MS);
  });
});
