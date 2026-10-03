import { describe, expect, it } from 'vitest';
import { metricsBody, readiness, startAdminServer } from '../src/admin.js';
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

describe('readiness', () => {
  it('is ready when at least one worker is healthy', () => {
    const h = harness({}, 2);
    h.forked[0]!.ready();
    expect(readiness(h.pool)).toEqual({ ready: true, workers: 2, healthy: 1 });
  });

  it('is not ready before any worker has announced itself', () => {
    expect(readiness(harness({}, 2).pool)).toEqual({
      ready: false,
      workers: 2,
      healthy: 0,
    });
  });

  it('stays ready when every worker is saturated: overload is the 429, not readiness', () => {
    const h = ready(2);
    h.forked[0]!.load(1000);
    h.forked[1]!.load(1000);
    // Pulling a saturated pod out of the Service would flap it under exactly the load it exists
    // to absorb, and shift that load onto its siblings.
    expect(readiness(h.pool).ready).toBe(true);
  });

  it('goes unready while the only worker restarts, and ready again once it is back', () => {
    const h = ready(1);
    h.forked[0]!.exit(1);
    expect(readiness(h.pool)).toEqual({ ready: false, workers: 1, healthy: 0 });
    h.runTimers(); // the restart backoff elapses; the pool forks a replacement
    expect(h.forked).toHaveLength(2);
    h.forked[1]!.ready();
    expect(readiness(h.pool)).toEqual({ ready: true, workers: 1, healthy: 1 });
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

  it('answers /healthz 200 and /readyz with the readiness body', async () => {
    const h = harness({}, 2);
    const admin = await startAdminServer({ pool: h.pool, port: 0 });
    try {
      const health = await fetch(`http://127.0.0.1:${admin.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok\n');

      const before = await fetch(`http://127.0.0.1:${admin.port}/readyz`);
      expect(before.status).toBe(503);
      expect(await before.json()).toEqual({ ready: false, workers: 2, healthy: 0 });

      h.forked[1]!.ready();
      const after = await fetch(`http://127.0.0.1:${admin.port}/readyz`);
      expect(after.status).toBe(200);
      expect(after.headers.get('content-type')).toMatch(/application\/json/);
      expect(await after.json()).toEqual({ ready: true, workers: 2, healthy: 1 });

      // Still a closed set: anything else is a misconfiguration and must look like one.
      expect((await fetch(`http://127.0.0.1:${admin.port}/readyz/x`)).status).toBe(404);
      const post = await fetch(`http://127.0.0.1:${admin.port}/readyz`, { method: 'POST' });
      expect(post.status).toBe(404);
    } finally {
      await admin.close();
    }
  });

  it('binds loopback by default and the given host when told', async () => {
    const pool = ready().pool;
    const loop = await startAdminServer({ pool, port: 0 });
    expect(loop.address).toBe('127.0.0.1');
    await loop.close();

    const any = await startAdminServer({ pool, port: 0, host: '0.0.0.0' });
    try {
      expect(any.address).toBe('0.0.0.0');
      expect((await fetch(`http://127.0.0.1:${any.port}/healthz`)).status).toBe(200);
    } finally {
      await any.close();
    }
  });
});

/** Kept out of the assertion so the intent reads as "the pids, in slot order". */
function body_pids(body: {
  workers: readonly { pid: number | undefined }[];
}): (number | undefined)[] {
  return body.workers.map((w) => w.pid);
}
