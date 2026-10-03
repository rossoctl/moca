import { createServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import type { WorkerPool } from './pool.js';

/**
 * Env vars a run record is allowed to quote. An allowlist because this body is served
 * unauthenticated (on loopback unless `SH_ADMIN_HOST` widens it) and ends up pasted into
 * EXPERIMENTS.md; a denylist would leak the first credential someone adds to the unit file.
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
  readonly file_op_p95_ms: number | 'NaN';
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
    file_op_p95_ms: num(agg.fileOpP95Ms),
    env: picked,
  };
}

/**
 * What a kubelet readiness probe needs: can this supervisor hand a connection to anyone? True when
 * at least one worker is healthy. Saturation deliberately does not count -- the 429 at the data
 * port is the overload signal (P6 spec §3.5), and tying readiness to it would pull a loaded pod
 * out of the Service and push its load onto the siblings.
 */
export function readiness(pool: WorkerPool): {
  ready: boolean;
  workers: number;
  healthy: number;
} {
  const views = pool.views();
  const healthy = views.filter((v) => v.healthy).length;
  return { ready: healthy > 0, workers: views.length, healthy };
}

export async function startAdminServer(opts: {
  pool: WorkerPool;
  port: number;
  /** Bind address; loopback unless the deployment says otherwise (SH_ADMIN_HOST). */
  host?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ port: number; address: string; close(): Promise<void> }> {
  const env = opts.env ?? process.env;
  const host = opts.host ?? '127.0.0.1';
  const server: HttpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      const r = readiness(opts.pool);
      res.writeHead(r.ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }
    if (req.method !== 'GET' || req.url !== '/metrics') {
      // No hand-off, no redirect: real traffic arriving here is a misconfiguration and must
      // look like one rather than quietly working.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('admin: GET /metrics, /healthz or /readyz only\n');
      return;
    }
    const body = JSON.stringify(metricsBody(opts.pool, env));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  // Loopback by default: unauthenticated and configuration-echoing, it has no business off-box.
  // A Kubernetes pod widens it so the kubelet can probe, and NetworkPolicy limits who reaches it.
  server.listen(opts.port, host);
  await once(server, 'listening');
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : opts.port;
  const address = typeof bound === 'object' && bound !== null ? bound.address : host;
  return {
    port,
    address,
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
