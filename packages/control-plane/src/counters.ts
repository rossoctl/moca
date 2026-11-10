/**
 * Process-local control-plane counters (async fan-out spec §7). `async_quota_refusals` is the one
 * async counter that cannot ride the worker's `stats` IPC row: §4.3 enforces the quota HERE, and a
 * worker never sees a refused submission.
 *
 * Counters only -- never an input to a decision. The control plane has no telemetry route today
 * (`server.ts` serves `/healthz` and `/readyz`), so the surface that exposes these is the §7 task's;
 * this module is where the number accumulates in the meantime, and `asyncCounters()` is what that
 * task will read.
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
