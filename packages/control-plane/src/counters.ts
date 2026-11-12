/**
 * Process-local control-plane counters (async fan-out spec §7). `async_quota_refusals` is the one
 * async counter that cannot ride the worker's `stats` IPC row: §4.3 enforces the quota HERE, and a
 * worker never sees a refused submission.
 *
 * Counters only -- never an input to a decision. Read by `GET /metrics` (admin-only; see routes.ts),
 * which is the whole reason `asyncCounters()` returns a copy: a caller must not be able to reset the
 * process's own telemetry by mutating what it was handed.
 */
export type AsyncCounter = 'async_quota_refusals';

const counters: Record<AsyncCounter, number> = { async_quota_refusals: 0 };

export function countAsync(name: AsyncCounter): void {
  counters[name] += 1;
}

export function asyncCounters(): Record<AsyncCounter, number> {
  return { ...counters };
}

/** Tests only: module state outlives a test file otherwise, and the second assertion would drift. */
export function resetAsyncCounters(): void {
  counters.async_quota_refusals = 0;
}
