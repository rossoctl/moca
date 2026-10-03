import { availableParallelism } from 'node:os';
import { isIP } from 'node:net';
import { policyFromName, type RoutingPolicy } from './routing.js';

export interface SupervisorConfig {
  readonly port: number;
  readonly workers: number;
  /** S — the per-worker soft cap on in-flight TURNS, not sessions (§3.8, §5.1). */
  readonly turnsPerWorker: number;
  readonly policy: RoutingPolicy;
  readonly restartBackoffMs: number;
  /** Loopback-only /metrics listener (§5.2, Task 11) — a separate port from the data path. */
  readonly adminPort: number;
  /**
   * Bind address of the admin listener. Loopback by default (the VM and Compose posture); a
   * Kubernetes pod sets 0.0.0.0 so the kubelet can probe /readyz on the pod IP, and NetworkPolicy
   * (deploy/k8s) takes over the job loopback did. An IP literal only: a hostname would make the
   * bind depend on DNS at boot.
   */
  readonly adminHost: string;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  /** `undefined` ⇒ the variable is REQUIRED and has no legal default (GC7). */
  fallback: number | undefined,
  bounds: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!raw) {
    // Expressing "no default" as `undefined` rather than a number means no reader has to work
    // out whether the value in that slot is a legal one for the variable. `SH_TURNS_PER_WORKER`
    // used to pass 0 here, which read as though 0 were a legal S -- the opposite of what the
    // blank check in readConfig() says. That check fires first, so this branch is unreachable
    // for it; it is a real net for anything else declared required later.
    if (fallback === undefined) throw new Error(`${name} is required and has no default`);
    // `bounds` apply to the fallback too, or the sentence above is only true of values an
    // OPERATOR typed. `SH_WORKERS` passes a COMPUTED one (`availableParallelism()`). Back when that
    // source was `cpus().length` -- and `os.cpus()` is documented as possibly returning an empty
    // array -- an unchecked 0 booted a supervisor that logged `supervisor_listening ... workers: 0`,
    // forked nothing, and answered 429 to everything forever, since `isSaturated([])` is true by
    // design -- with no error anywhere. Two things make that value unreachable here now:
    // `availableParallelism()` is documented to always return a value greater than zero, and
    // `defaultWorkers` clamps regardless. So this branch is unreachable for it, exactly as the blank
    // check above makes the `undefined` throw unreachable for `SH_TURNS_PER_WORKER`. Both are nets
    // for the next default, not dead code.
    if (!Number.isInteger(fallback) || fallback < bounds.min || fallback > max) {
      throw new Error(`${name} default ${fallback} is not an integer in [${bounds.min}, ${max}]`);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < bounds.min || n > max) {
    throw new Error(`${name}='${raw}' must be an integer in [${bounds.min}, ${max}]`);
  }
  return n;
}

function readHost(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (isIP(raw) === 0) {
    throw new Error(
      `${name}='${raw}' must be an IPv4 or IPv6 address literal, not a hostname or host:port`,
    );
  }
  return raw;
}

/**
 * W's default, clamped so a CPU count of 0 cannot become a wedged supervisor.
 *
 * 0 is not a legal W: the supervisor forks nothing, and `isSaturated([])` is `true` by design, so it
 * answers 429 to every request for the lifetime of the process. That is reachable from
 * `cpus().length`, since `os.cpus()` is documented as possibly returning an empty array.
 * `readConfig` no longer reads that source -- `availableParallelism()` is documented to always
 * return a value greater than zero -- but this stays a pure clamp of whatever count it is handed,
 * so the guarantee holds in one place whichever source a caller picks. Clamped rather than thrown,
 * because failed CPU detection is a property of the host and not an operator error -- one worker is
 * a working deployment, and a supervisor that refuses to boot over it would be a worse answer than
 * a quiet one. An operator who wants more sets `SH_WORKERS`, which is validated as an operator
 * value like every other knob.
 */
export function defaultWorkers(cpuCount: number): number {
  return Math.max(1, cpuCount);
}

export function readConfig(env: NodeJS.ProcessEnv): SupervisorConfig {
  const rawTurns = env.SH_TURNS_PER_WORKER?.trim();
  if (!rawTurns) {
    // No default on purpose (§3.8): every plausible one either hides the density this slice
    // exists to find or invites the thrash E8 is meant to locate — and unlike the other
    // knobs, its right value is an OUTPUT of E8, not a guess.
    throw new Error(
      'SH_TURNS_PER_WORKER is required and has no default: it is the per-worker cap on ' +
        'in-flight turns (S), and its right value is an output of E8, not a guess',
    );
  }
  const port = readInt(env, 'PORT', 8080, { min: 0, max: 65535 });
  const adminPort = readInt(env, 'SH_ADMIN_PORT', 8081, { min: 0, max: 65535 });
  if (adminPort !== 0 && adminPort === port) {
    // Two listeners on one port is an EADDRINUSE at boot in the best case; 0 is exempt
    // because the kernel hands out a distinct ephemeral port each time it is asked.
    throw new Error(`SH_ADMIN_PORT='${adminPort}' must differ from PORT='${port}'`);
  }
  // SH_SANDBOX_DISCOVERY is validated at boot too, but NOT here: `resolveDiscoverySource` lives in
  // @moca/harness and this package ships `dependencies: {}` on purpose -- the supervisor parent is the
  // one process that must never die of a dependency. The check sits in the worker's boot path
  // (knative-server/src/worker.ts), which already depends on the harness and is also where #249's
  // `assertKeysetUsable` -- the precedent for "validate at boot, not per request" -- already lives.
  return {
    port,
    // `availableParallelism()`, not `cpus().length`: `os.cpus()` enumerates the HOST's physical
    // CPUs and never consults a cgroup CPU quota, so under `docker run --cpus=N` or a Kubernetes
    // CPU limit W silently described a machine this deployment cannot use -- an oversized,
    // thrashing pool with no error and no warning, and any P6 density number gathered there
    // measuring the host rather than the deployment (§5.1; E8/E9). Node documents the rule
    // outright -- "`os.cpus().length` should not be used to calculate the amount of parallelism
    // available to an application" -- since `availableParallelism()` wraps libuv's
    // `uv_available_parallelism()`, which reads `cpu.max` (cgroup v2) / `cpu.cfs_quota_us` (v1)
    // and clamps to the quota.
    workers: readInt(env, 'SH_WORKERS', defaultWorkers(availableParallelism()), { min: 1 }),
    turnsPerWorker: readInt(env, 'SH_TURNS_PER_WORKER', undefined, { min: 1 }),
    policy: policyFromName(env.SH_ROUTING_POLICY),
    restartBackoffMs: readInt(env, 'SH_WORKER_RESTART_BACKOFF_MS', 250, { min: 0 }),
    adminPort,
    adminHost: readHost(env, 'SH_ADMIN_HOST', '127.0.0.1'),
  };
}
