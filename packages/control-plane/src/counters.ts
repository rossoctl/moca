/**
 * Process-local control-plane counters (async fan-out spec §7). `async_quota_refusals` is the one
 * async counter that cannot ride the worker's `stats` IPC row: §4.3 enforces the quota HERE, and a
 * worker never sees a refused submission.
 *
 * `credential_nonprimary_kek_reads` is not async at all; it shares this module because `GET /metrics`
 * is the only counter surface there is. It counts credentials opened under a RETIRED KEK
 * (`openOrBlameSubject`, subject-document.ts), which is the terminating condition of a KEK rotation:
 * re-sealing is write-driven, so an entry nobody writes keeps the old key, and the retired key may be
 * dropped only once this stops moving. The matching log line names the subject and credential; this
 * is the number an operator can watch without scraping logs (deploy/sbx/RUNBOOK.md).
 *
 * Counters only -- never an input to a decision. Read by `GET /metrics` (admin-only; see routes.ts),
 * which is the whole reason `asyncCounters()` returns a copy: a caller must not be able to reset the
 * process's own telemetry by mutating what it was handed.
 */
export type AsyncCounter = 'async_quota_refusals' | 'credential_nonprimary_kek_reads';

const ZERO: Record<AsyncCounter, number> = {
  async_quota_refusals: 0,
  credential_nonprimary_kek_reads: 0,
};

const counters: Record<AsyncCounter, number> = { ...ZERO };

export function countAsync(name: AsyncCounter): void {
  counters[name] += 1;
}

export function asyncCounters(): Record<AsyncCounter, number> {
  return { ...counters };
}

/**
 * Tests only: module state outlives a test file otherwise, and the second assertion would drift.
 * Driven by the key set rather than by name, so a counter added above cannot be left out of the reset
 * and leak a count into the next test.
 */
export function resetAsyncCounters(): void {
  Object.assign(counters, ZERO);
}
