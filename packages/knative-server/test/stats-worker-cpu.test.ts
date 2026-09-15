import { describe, expect, it } from 'vitest';
import {
  resolveLagResolutionMs,
  startStatsReporter,
  type WorkerToSupervisor,
} from '../src/worker.js';

/**
 * Per-turn worker CPU is the metric whose absence made E8's published knee ambiguous (P6 §5.2, as
 * amended): with only loop lag and RSS, "the worker tier is actually full" and "the stub is slow"
 * produce the same record. The driver computes CPU-seconds-per-turn from a DELTA across a rung, so
 * what a worker reports must be CUMULATIVE process CPU — a per-interval figure cannot be differenced
 * and a rate would have to pick a window nobody agreed on.
 */
function collect(opts: Partial<Parameters<typeof startStatsReporter>[0]> = {}) {
  const sent: WorkerToSupervisor[] = [];
  const stop = startStatsReporter({
    send: (m) => sent.push(m),
    intervalMs: 5,
    lag: () => 1,
    rss: () => 1,
    ...opts,
  });
  return { sent, stop };
}

const statsOf = (sent: WorkerToSupervisor[]) =>
  sent.filter((m) => m.type === 'stats') as Array<{
    cpuSeconds?: number;
    lagResolutionMs?: number;
  }>;

describe('startStatsReporter worker CPU', () => {
  it('reports cumulative process CPU seconds', async () => {
    let cpu = 1.5;
    const { sent, stop } = collect({ cpu: () => cpu });
    await new Promise((r) => setTimeout(r, 20));
    cpu = 2.75;
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const stats = statsOf(sent);
    expect(stats[0]!.cpuSeconds).toBe(1.5);
    // Monotonic across ticks, because the driver differences two samples a rung apart.
    expect(stats.at(-1)!.cpuSeconds).toBe(2.75);
  });

  it('reads real process CPU when no injection seam is given, and it only ever grows', async () => {
    const { sent, stop } = collect();
    // Burn measurable CPU so a reading that is merely present can be told from one that tracks work.
    const until = Date.now() + 60;
    while (Date.now() < until) JSON.parse(JSON.stringify({ a: Math.random() }));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const cpus = statsOf(sent).map((s) => s.cpuSeconds!);
    expect(cpus.length).toBeGreaterThan(0);
    for (const c of cpus) expect(c).toBeGreaterThan(0);
    expect(cpus.at(-1)!).toBeGreaterThanOrEqual(cpus[0]!);
  });

  it('reports the lag histogram resolution beside the lag, so a reading can be read against its floor', async () => {
    const { sent, stop } = collect({ lagResolutionMs: 4 });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(statsOf(sent)[0]!.lagResolutionMs).toBe(4);
  });
});

describe('resolveLagResolutionMs', () => {
  /**
   * The shipped sampler read ~11 ms on every rung of all three published runs — at c=1, where one
   * turn is in flight and the tier is nearly idle, and at c=64 alike. Measured cause (probe against
   * this exact sampler shape): that is the histogram's own RESOLUTION FLOOR, not delay.
   *
   *   resolution 10 (as shipped): idle p99 15.7–21.6 ms | 50 ms-blocked p99 56.1–57.0 ms
   *   resolution 1:               idle p99  1.9– 6.4 ms | 50 ms-blocked p99 50.4 ms
   *
   * So the metric does discriminate a genuinely starved loop, but at resolution 10 nothing below
   * ~10 ms of real lag is visible, and §5.2's attribution threshold (lag/lag0 >= 4) needs ~44 ms of
   * real delay before it can fire. 1 ms lowers the floor ~10x, which is what makes gradual growth —
   * the shape a filling worker tier actually produces — legible at all.
   */
  it('defaults to 1 ms, not the 10 ms that put the floor above the signal', () => {
    expect(resolveLagResolutionMs({})).toBe(1);
  });

  it('honours SH_LAG_RESOLUTION_MS so the floor can be traded against sampling cost', () => {
    expect(resolveLagResolutionMs({ SH_LAG_RESOLUTION_MS: '10' })).toBe(10);
  });

  it('falls back to the default rather than throwing on a value that cannot make a histogram', () => {
    // monitorEventLoopDelay requires resolution > 0: a 0 or a typo must not take the worker down,
    // and must not silently disable the metric either.
    for (const bad of ['0', '-1', 'ten', '', 'NaN']) {
      expect(resolveLagResolutionMs({ SH_LAG_RESOLUTION_MS: bad })).toBe(1);
    }
  });
});

describe('the lag sampler against a deliberately starved loop', () => {
  /**
   * P6 §5.2 makes loop lag an attribution for worker CPU, and three published runs read a flat
   * ~11 ms at every rung — so the open question was whether the metric discriminates anything at
   * all. This test answers it *in the tree* rather than in prose: it starves the loop and asserts
   * the reading moves. Without it the resolution change rests on numbers nobody can reproduce.
   *
   * Thresholds are deliberately loose (a CI box is noisy and this is a timing test): the claim being
   * pinned is "a blocked loop reads several times its idle floor", not any particular millisecond.
   */
  async function p99Over(ms: number, blockMs: number, resolution: number): Promise<number> {
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const h = monitorEventLoopDelay({ resolution });
    h.enable();
    let hog: NodeJS.Timeout | undefined;
    if (blockMs > 0) {
      hog = setInterval(() => {
        const until = Date.now() + blockMs;
        while (Date.now() < until) {}
      }, blockMs + 5);
    }
    await new Promise((r) => setTimeout(r, ms));
    if (hog) clearInterval(hog);
    h.disable();
    return h.percentile(99) / 1e6;
  }

  it('reads far higher when the loop is blocked than when it is idle (resolution 1)', async () => {
    const idle = await p99Over(400, 0, 1);
    const starved = await p99Over(400, 50, 1);
    // The signal: ~50 ms of real delay against a floor of a few ms.
    expect(starved).toBeGreaterThan(25);
    expect(starved).toBeGreaterThan(idle * 3);
  }, 10_000);

  it('has a floor at resolution 10 that swallows small delays — why the default moved to 1', async () => {
    // The measured cause of the flat ~11 ms column: at resolution 10 an IDLE loop already reads in
    // the tens of ms, so a lag/lag0 ratio needs tens of ms of real delay before it can move. This
    // asserts the FLOOR relationship (res 10 idle reads materially higher than res 1 idle), which is
    // the whole reason the default changed.
    const idle10 = await p99Over(400, 0, 10);
    const idle1 = await p99Over(400, 0, 1);
    expect(idle10).toBeGreaterThan(idle1);
    expect(idle10).toBeGreaterThan(5);
  }, 10_000);
});
