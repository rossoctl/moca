import { describe, expect, it } from 'vitest';
import { metricsBody, startAdminServer } from '../src/admin.js';
import { harness } from './helpers/fake-worker.js';

/** Task 6's harness, with both workers already `ready` — the steady state /metrics describes. */
function ready(workers = 2): ReturnType<typeof harness> {
  const h = harness({}, workers);
  for (const w of h.forked) w.ready();
  return h;
}

describe('metricsBody', () => {
  it('reports NaN, not 0, for telemetry no worker has sent', () => {
    const body = metricsBody(ready().pool, {});
    // A 0 here would read as "no lag" and would exonerate the tier that actually saturated.
    expect(body.workers.map((w) => w.loop_lag_p99_ms)).toEqual(['NaN', 'NaN']);
    expect(body.workers.map((w) => w.rss_bytes)).toEqual(['NaN', 'NaN']);
    expect(body.lease_saturation).toBe('NaN');
    expect(body.file_op_p95_ms).toBe('NaN');
  });

  it('carries a stats message through to the wire names plan 2 parses', () => {
    const h = ready();
    h.forked[0]!.stats({ loopLagP99Ms: 4.25, rssBytes: 120_000_000 });
    const body = metricsBody(h.pool, {});
    expect(body.workers[0]!.loop_lag_p99_ms).toBe(4.25);
    expect(body.workers[0]!.rss_bytes).toBe(120_000_000);
    // The worker that said nothing still says nothing. Filling it in from a sibling would
    // average away the very asymmetry that identifies which worker saturated.
    expect(body.workers[1]!.loop_lag_p99_ms).toBe('NaN');
  });

  it('reports the pid the worker announced, so a rung can be tied to a process', () => {
    const h = ready();
    expect(body_pids(metricsBody(h.pool, {}))).toEqual(h.forked.map((w) => w.pid));
  });

  it('never lets telemetry reach a routing decision', () => {
    const h = ready();
    h.forked[0]!.stats({ loopLagP99Ms: 900, rssBytes: 1 });
    // `WorkerView` is the whole of what a policy sees, and `stats` does not touch it.
    expect(h.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });
  });

  it('derives lease saturation from held leases over pool size', () => {
    const h = ready();
    h.forked[0]!.stats({ leasesHeld: 2, leasePoolSize: 4 });
    h.forked[1]!.stats({ leasesHeld: 1, leasePoolSize: 4 });
    // 3 of 4. Pool size is the max reported, not the sum: every worker leases from the SAME
    // pool, so summing would report a pool twice its real size and hide saturation.
    expect(h.pool.aggregates().leaseSaturation).toBeCloseTo(0.75);
  });

  it('reports the sandbox pool size raw, because saturation cannot express an ABSENT pool', () => {
    const h = ready();
    h.forked[0]!.stats({ leasesHeld: 0, leasePoolSize: 3 });
    // leaseSaturation is 0 for "3 sandboxes, none leased" AND for "no sandboxes" — E8's
    // precondition needs the count itself to tell those apart.
    expect(metricsBody(h.pool, {}).sandbox_pool_size).toBe(3);
    expect(h.pool.aggregates().leasePoolSize).toBe(3);
  });

  it('distinguishes a pool observed to be EMPTY from one never observed', () => {
    // The distinction the whole field turns on. Never observed ⇒ 'NaN' ⇒ E8 refuses to measure,
    // because after a live rung it means no turn went through pool selection at all. Observed as 0
    // ⇒ a real, empty pool ⇒ E8 fails the floor. Collapsing both to 0 would make a healthy run
    // fail; collapsing both to NaN would let a run with no sandbox tier proceed.
    expect(metricsBody(ready().pool, {}).sandbox_pool_size).toBe('NaN');

    const h = ready();
    h.forked[0]!.stats({ leasesHeld: 0, leasePoolSize: 0 });
    expect(metricsBody(h.pool, {}).sandbox_pool_size).toBe(0);
  });

  it('carries per-worker CPU seconds through to the wire, NaN until reported', () => {
    // The metric that lets a knee be attributed to "the worker tier is actually full" rather than
    // to "the stub is slow" (§5.2 as amended). NaN, not 0, for the same reason as every other
    // reading here: a 0 would read as an idle worker and would exonerate the tier that saturated.
    const h = ready();
    expect(metricsBody(h.pool, {}).workers.map((w) => w.cpu_seconds)).toEqual(['NaN', 'NaN']);
    h.forked[0]!.stats({ cpuSeconds: 12.5 });
    const body = metricsBody(h.pool, {});
    expect(body.workers[0]!.cpu_seconds).toBe(12.5);
    expect(body.workers[1]!.cpu_seconds).toBe('NaN');
  });

  it('publishes the cores of the box the WORKERS run on, not the drivers', () => {
    // The driver's own `nproc` describes the generator, which the required topology puts on a
    // different and smaller machine (4 cores against the target's 8 in the published runs). Dividing
    // the target's worker CPU by the generator's core count inflates every utilisation by that ratio,
    // so the denominator ships from the same box as the numerator.
    const body = metricsBody(ready().pool, {});
    expect(typeof body.cores).toBe('number');
    expect(body.cores).toBeGreaterThan(0);
  });

  it('publishes the lag histogram resolution, so an 11 ms reading can be read against its floor', () => {
    // Three published runs read ~11 ms at every rung including c=1, which is the sampler's own
    // resolution floor rather than delay. A record that quotes the lag without the resolution
    // cannot distinguish "the floor" from "real delay", so the denominator ships with the number.
    const h = ready();
    expect(metricsBody(h.pool, {}).lag_resolution_ms).toBe('NaN');
    h.forked[0]!.stats({ loopLagP99Ms: 1.2, lagResolutionMs: 1 });
    expect(metricsBody(h.pool, {}).lag_resolution_ms).toBe(1);
  });

  it('takes the worst worker s file-op p95, not the mean', () => {
    const h = ready();
    h.forked[0]!.stats({ fileOpP95Ms: 12 });
    h.forked[1]!.stats({ fileOpP95Ms: 340 });
    // A p95 averaged across workers is not a p95 of anything, and the mean would hide the
    // worker whose relay is the reason the rung degraded.
    expect(h.pool.aggregates().fileOpP95Ms).toBe(340);
  });

  it('exposes the pool counters under the §5.2 names', () => {
    const h = ready();
    // A spurious refusal requires the estimate to have been stale HIGH at the moment of
    // refusal (§3.9): noteRefusal() on an untouched 0-estimate slot can never satisfy
    // `actual < atRefusal`, so establish a nonzero estimate first (mirrors pool.test.ts's own
    // refusal-accounting test) -- the brief's snippet here calls noteRefusal() then load(0)
    // straight off `ready()`, which reconcile() correctly declines to count.
    h.forked[0]!.load(4);
    h.pool.noteRefusal();
    h.forked[0]!.load(1);
    const body = metricsBody(h.pool, {});
    expect(body.counters.spurious_refusals).toBe(1);
    expect(body.counters).toHaveProperty('over_admission');
    expect(body.counters).toHaveProperty('restarts');
  });

  it('reports head truncations, so E8 can see the sticky arm losing affinity', () => {
    // Additive: a new key alongside the existing snake_case counters, never a rename -- plan 2's
    // `worker_metrics()` parses these names and anything that renames them breaks it.
    const h = ready();
    h.pool.noteHeadTruncated(20_000);
    expect(metricsBody(h.pool, {}).counters.head_truncations).toBe(1);
  });

  it('echoes only the env vars a run record needs, never the whole environment', () => {
    const body = metricsBody(ready().pool, {
      SH_WORKERS: '4',
      SH_TURNS_PER_WORKER: '8',
      ANTHROPIC_BASE_URL: 'http://stub:8080',
      ANTHROPIC_API_KEY: 'sk-not-a-real-key', // notsecret
      AWS_SECRET_ACCESS_KEY: 'nope', // notsecret
    });
    expect(body.env.ANTHROPIC_BASE_URL).toBe('http://stub:8080');
    expect(body.env.SH_TURNS_PER_WORKER).toBe('8');
    // An allowlist, not a denylist: this body is served unauthenticated on loopback and gets
    // pasted into EXPERIMENTS.md, so anything not explicitly wanted must not be here.
    expect(body.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(body.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});

describe('startAdminServer', () => {
  it('serves /metrics as JSON and 404s everything else', async () => {
    const admin = await startAdminServer({ pool: ready().pool, port: 0, env: { SH_WORKERS: '2' } });
    try {
      const res = await fetch(`http://127.0.0.1:${admin.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = (await res.json()) as { workers: unknown[] };
      expect(body.workers).toHaveLength(2);

      const miss = await fetch(`http://127.0.0.1:${admin.port}/turn`);
      // Not a redirect and not a hand-off: a turn arriving here is a misconfiguration, and
      // answering it would silently route real traffic onto the admin port.
      expect(miss.status).toBe(404);
    } finally {
      await admin.close();
    }
  });

  it('closes cleanly, so a restarted supervisor does not hit EADDRINUSE', async () => {
    const h = ready();
    const first = await startAdminServer({ pool: h.pool, port: 0 });
    const port = first.port;
    await first.close();
    const second = await startAdminServer({ pool: h.pool, port });
    expect(second.port).toBe(port);
    await second.close();
  });
});

/** Kept out of the assertion so the intent reads as "the pids, in slot order". */
function body_pids(body: {
  workers: readonly { pid: number | undefined }[];
}): (number | undefined)[] {
  return body.workers.map((w) => w.pid);
}
