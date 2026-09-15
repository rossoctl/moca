import { createServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import type { WorkerPool } from './pool.js';

/**
 * Env vars a run record is allowed to quote. An allowlist because this body is served
 * unauthenticated on loopback and ends up pasted into EXPERIMENTS.md; a denylist would leak
 * the first credential someone adds to the unit file.
 */
const ENV_ALLOWLIST = [
  'PORT',
  'SH_WORKERS',
  'SH_TURNS_PER_WORKER',
  'SH_ROUTING_POLICY',
  'SH_SANDBOX_DISCOVERY',
  'SH_REMOTE_SANDBOX',
  'SH_PERSISTENT_EXEC',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  // The per-sandbox lease cap. Needed to READ `lease_saturation`, which is leases per sandbox
  // (held ÷ pool size) and therefore saturates at this value rather than at 1.0 — without it in
  // the record, a reader cannot tell a full pool from a quarter-full one. Non-secret config, which
  // is exactly what this allowlist is for (§5.3 pin 1: prove which configuration produced a run).
  'KAGENTI_SANDBOX_CAP',
  // The event-loop-lag sampling resolution (worker.ts's resolveLagResolutionMs). Non-secret config,
  // and the lag column's denominator: a record quoting ~11 ms of lag without it cannot be told from
  // one quoting a resolution-10 histogram's own floor.
  'SH_LAG_RESOLUTION_MS',
] as const;

/** The exact JSON plan 2's `worker_metrics()` parses. Wire names are snake_case. */
export interface MetricsBody {
  readonly workers: readonly {
    readonly id: number;
    readonly pid: number | undefined;
    readonly inFlight: number;
    readonly healthy: boolean;
    readonly loop_lag_p99_ms: number | 'NaN';
    readonly rss_bytes: number | 'NaN';
    /**
     * Cumulative process CPU seconds. E8 differences two samples a rung apart and divides by turns
     * served: per-turn worker CPU is what attributes a knee to "the worker tier is actually full"
     * rather than to "the stub is slow" (§5.2 as amended, issue #254 item 2e). Its absence is why
     * the first published density record could not distinguish those two.
     */
    readonly cpu_seconds: number | 'NaN';
  }[];
  readonly counters: {
    readonly restarts: number;
    readonly handoff_retries: number;
    readonly handoff_failures: number;
    readonly over_admission: number;
    readonly spurious_refusals: number;
    /** Header blocks that exceeded the pre-read cap, so those connections lost affinity. */
    readonly head_truncations: number;
  };
  readonly lease_saturation: number | 'NaN';
  /**
   * Cores available to THIS host — the one the workers actually run on. Published because the driver
   * cannot know it: `nproc` in the driver describes the GENERATOR, which on the required topology is a
   * different, smaller machine (a 4-core generator against an 8-core target in the published runs). A
   * worker-CPU utilisation computed against the generator's count is inflated by the ratio, so the
   * denominator has to come from the same box as the numerator.
   */
  readonly cores: number | 'NaN';
  /**
   * The resolution the workers' lag histograms are sampling at. Published because the lag column is
   * unreadable without it: three published runs read ~11 ms at every rung including c=1, which was
   * a resolution-10 histogram's own floor and not delay.
   */
  readonly lag_resolution_ms: number | 'NaN';
  readonly file_op_p95_ms: number | 'NaN';
  /**
   * Leasable sandboxes as the workers' last selection saw them, `'NaN'` until one has looked.
   * E8's sandbox-pool precondition reads THIS instead of counting containers locally: the driver's
   * own `podman ps` describes whatever box the driver runs on (nothing, off-box) and counts
   * containers rather than leasable records — which on hardware showed three running containers
   * against an empty pool.
   */
  readonly sandbox_pool_size: number | 'NaN';
  /** Echoed so a run record can prove which model tier and policy produced it (§5.3 pin 1). */
  readonly env: Readonly<Record<string, string>>;
}

/** JSON has no NaN, so the wire carries the string. Plan 2's drivers read it as `NaN`. */
const num = (n: number): number | 'NaN' => (Number.isFinite(n) ? n : 'NaN');

export function metricsBody(pool: WorkerPool, env: NodeJS.ProcessEnv): MetricsBody {
  const c = pool.counters;
  const agg = pool.aggregates();
  const picked: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = env[k];
    if (v !== undefined) picked[k] = v;
  }
  return {
    workers: pool.telemetry().map((w) => ({
      id: w.id,
      pid: w.pid,
      inFlight: w.inFlight,
      healthy: w.healthy,
      loop_lag_p99_ms: num(w.loopLagP99Ms),
      rss_bytes: num(w.rssBytes),
      cpu_seconds: num(w.cpuSeconds),
    })),
    counters: {
      restarts: c.restarts,
      handoff_retries: c.handoffRetries,
      handoff_failures: c.handoffFailures,
      over_admission: c.overAdmission,
      spurious_refusals: c.spuriousRefusals,
      head_truncations: c.headTruncations,
    },
    lease_saturation: num(agg.leaseSaturation),
    cores: num(availableParallelism()),
    lag_resolution_ms: num(agg.lagResolutionMs),
    file_op_p95_ms: num(agg.fileOpP95Ms),
    sandbox_pool_size: num(agg.leasePoolSize),
    env: picked,
  };
}

export async function startAdminServer(opts: {
  pool: WorkerPool;
  port: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ port: number; close(): Promise<void> }> {
  const env = opts.env ?? process.env;
  const server: HttpServer = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      // No hand-off, no redirect: real traffic arriving here is a misconfiguration and must
      // look like one rather than quietly working.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('admin: GET /metrics only\n');
      return;
    }
    const body = JSON.stringify(metricsBody(opts.pool, env));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  // Loopback only. Unauthenticated and configuration-echoing; it has no business off-box.
  server.listen(opts.port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  return {
    port,
    async close(): Promise<void> {
      // Captured BEFORE close() can fire it: `once()` registered after the event has already
      // been emitted waits for something that will never happen again.
      const closed = once(server, 'close');
      // Explicit rather than relying on `http.Server.close()`'s own handling of idle keep-alive
      // connections (which it has done since Node 19). This listener exists to be polled by a
      // driver on a warm connection, so being explicit about it is worth one line: it says out
      // loud that a poller must not be able to hold shutdown open.
      server.closeIdleConnections();
      server.close();
      await closed;
    },
  };
}
