import { fileURLToPath } from 'node:url';
import {
  credentialValue,
  makeSigner,
  parseKeyset,
  parseStorageClasses,
  publicKeyFromBase64,
  redisClientOptions,
  storageMiB,
} from '@moca/control-plane';
import type { KeyObject } from 'node:crypto';
import { createClient } from 'redis';
import { inClusterOptions, RestKube } from './kube.js';
import {
  DEFAULT_ORPHAN_GRACE_S,
  DEFAULT_REDIS_TIMEOUT_MS,
  remintExpiring,
  settleSeeds,
  sweepOrphans,
  type ProvisionerConfig,
  type ProvisionerDeps,
  type RecordStore,
} from './provisioner.js';
import { BundleStore, DEFAULT_SEED_HOLD_S } from './seed.js';
import { startSeedServer, startServer, type ServerDeps } from './server.js';

/**
 * moca-provisioner (ADR-0043): the only MOCA component with Kubernetes permissions in the sandbox
 * namespace. Secrets are files under CREDENTIALS_DIRECTORY (credentialValue), as the control
 * plane's are: MOCA_ATTACH_PRIVATE_KEY (its own Ed25519 key, PKCS#8 base64 or PEM),
 * MOCA_PROVISIONER_TOKEN (the workers' service token) and REDIS_URL (used by the orphan sweep only,
 * for GETs; unset, there is no sweep). On Kubernetes REDIS_URL names the provisioner's own Redis
 * ACL user, which may GET sh:wl:* and nothing else (#626, spec §9; deploy/k8s/setup.sh's
 * REDIS_PROVISIONER_ACL), so this process never holds the deployment's read-write password.
 */

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** A positive integer, the default when unset; anything else refuses to boot. */
export function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return Number(v);
}

export function configFromEnv(env: NodeJS.ProcessEnv): ProvisionerConfig {
  const maxStorage = env.MOCA_WORKLOAD_MAX_STORAGE?.trim() || '10Gi';
  const maxMiB = storageMiB(maxStorage);
  if (maxMiB === null) {
    throw new Error(`MOCA_WORKLOAD_MAX_STORAGE must be <n>Mi or <n>Gi, got "${maxStorage}"`);
  }
  return {
    maxPerWorkload: positiveIntEnv(env, 'MOCA_WORKLOAD_MAX_SANDBOXES', 2),
    maxPerOwner: positiveIntEnv(env, 'MOCA_OWNER_MAX_SANDBOXES', 4),
    attachTtlS: positiveIntEnv(env, 'MOCA_ATTACH_TOKEN_TTL_S', 86400),
    storage: { maxMiB, classes: parseStorageClasses(env.MOCA_WORKLOAD_STORAGE_CLASSES) },
    seedUrl:
      env.MOCA_PROVISIONER_SEED_URL?.trim() ||
      'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
    maxEntries: positiveIntEnv(env, 'MOCA_CONTEXT_BUNDLE_MAX_ENTRIES', 10_000),
  };
}

/**
 * The workload records the orphan sweep reads (spec §6.2): this code only GETs, and on Kubernetes
 * its ACL user can do nothing else (#626). No offline queue, so a read while Redis is down fails at once (that
 * workload is skipped this pass) instead of waiting for a reconnect; the sweep runs only while the
 * client is ready anyway (orphanSweeper). A read on a socket that stops answering while the client
 * still looks ready is bounded by the sweep itself (MOCA_PROVISIONER_REDIS_TIMEOUT_MS).
 */
export function redisRecords(
  url: string,
): RecordStore & { ready: () => boolean; close: () => void } {
  const client = createClient({ ...redisClientOptions(url), disableOfflineQueue: true });
  // The message only, never the error object: the URL carries the password (as the control plane).
  client.on('error', (err: unknown) =>
    console.error('provisioner: redis client error:', (err as Error)?.message ?? String(err)),
  );
  void client
    .connect()
    .catch((err: unknown) =>
      console.error('provisioner: redis connect failed:', (err as Error)?.message ?? String(err)),
    );
  return {
    get: (key) => client.get(key),
    ready: () => client.isReady,
    // destroy, not close: close() waits on queued commands, which never drain while disconnected.
    close: () => client.destroy(),
  };
}

export function depsFromEnv(env: NodeJS.ProcessEnv): ServerDeps & {
  reconcileS: number;
  orphanGraceS: number;
  redisTimeoutMs: number;
  attachKeys: Map<string, KeyObject>;
  records?: RecordStore & { ready: () => boolean; close: () => void };
} {
  const signer = makeSigner(
    required(credentialValue(env, 'MOCA_ATTACH_PRIVATE_KEY'), 'MOCA_ATTACH_PRIVATE_KEY'),
  );
  const userKeys = parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
  if (userKeys.size === 0) throw new Error('SH_SESSION_TOKEN_PUBLIC_KEYS is required');
  const namespace = env.MOCA_SANDBOX_NAMESPACE?.trim() || 'moca-sandbox';
  const budget = positiveIntEnv(env, 'MOCA_PROVISIONER_SEED_BUDGET_BYTES', 1024 * 1024 * 1024);
  const maxBundleBytes = positiveIntEnv(env, 'MOCA_CONTEXT_BUNDLE_MAX_BYTES', 256 * 1024 * 1024);
  // One owner holds at most half the budget, so a largest bundle must fit in half of it.
  if (maxBundleBytes > Math.floor(budget / 2)) {
    throw new Error(
      'MOCA_PROVISIONER_SEED_BUDGET_BYTES must be at least twice MOCA_CONTEXT_BUNDLE_MAX_BYTES',
    );
  }
  const redisUrl = credentialValue(env, 'REDIS_URL');
  return {
    kube: new RestKube(inClusterOptions(env, namespace)),
    ...(redisUrl ? { records: redisRecords(redisUrl) } : {}),
    signer,
    // The seed port verifies attach tokens with this provisioner's own public key.
    attachKeys: new Map([[signer.kid, publicKeyFromBase64(signer.publicKeyBase64)]]),
    config: configFromEnv(env),
    // Held bundles and hand-offs in flight together, half of it per owner; each held at most
    // MOCA_PROVISIONER_SEED_HOLD_S (spec §5.2).
    bundles: new BundleStore(
      budget,
      positiveIntEnv(env, 'MOCA_PROVISIONER_SEED_HOLD_S', DEFAULT_SEED_HOLD_S),
    ),
    // Phase 1's ceiling on a downloaded bundle (MOCA_CONTEXT_BUNDLE_MAX_BYTES), held to again here:
    // setup.sh gives the provisioner the workers' value.
    maxBundleBytes,
    serviceToken: required(
      credentialValue(env, 'MOCA_PROVISIONER_TOKEN'),
      'MOCA_PROVISIONER_TOKEN',
    ),
    userKeys,
    reconcileS: positiveIntEnv(env, 'MOCA_PROVISIONER_RECONCILE_S', 300),
    orphanGraceS: positiveIntEnv(env, 'MOCA_PROVISIONER_ORPHAN_GRACE_S', DEFAULT_ORPHAN_GRACE_S),
    redisTimeoutMs: positiveIntEnv(
      env,
      'MOCA_PROVISIONER_REDIS_TIMEOUT_MS',
      DEFAULT_REDIS_TIMEOUT_MS,
    ),
  };
}

/**
 * The orphan sweep (sweepOrphans, spec §6.2), on the reconcile tick: one pass at a time, and none
 * while Redis is not ready (every record would read as unknown, so nothing could be decided). Every
 * record read is bounded by `timeoutMs`, so a pass always ends and the next one can start.
 */
export function orphanSweeper(
  deps: ProvisionerDeps & { records: RecordStore & { ready: () => boolean } },
  graceS: number,
  timeoutMs = DEFAULT_REDIS_TIMEOUT_MS,
) {
  let running: Promise<void> | null = null;
  return (): Promise<void> => {
    if (!deps.records.ready()) {
      console.error('provisioner: orphan sweep skipped: Redis is not ready');
      return Promise.resolve();
    }
    return (running ??= sweepOrphans(deps, graceS, timeoutMs)
      .then((r) => {
        if (r.swept > 0) console.log(`provisioner: swept ${r.swept} orphaned workload(s)`);
        if (r.kept > 0) {
          console.error(
            `provisioner: ${r.kept} PVC(s) kept on missing records; they count against the ` +
              'moca-sandbox ResourceQuota until deleted by hand (docs/context-service.md)',
          );
        }
      })
      .catch((err: unknown) =>
        console.error('provisioner: orphan sweep failed:', (err as Error)?.message ?? String(err)),
      )
      .finally(() => {
        running = null;
      }));
  };
}

/** How often seeds are checked while one may be in progress. */
export const SEED_POLL_MS = 5000;

/**
 * The seed-settle pass (settleSeeds), run once at startup by the reconcile tick and then every
 * SEED_POLL_MS while a bundle is held or a StatefulSet still carries the seed annotation: a seed
 * that finishes after a restart (nothing held) is settled in seconds, not at the next reconcile, so
 * GET does not report bundle_missing for a seed that succeeded. One pass at a time.
 */
export function seedSettler(deps: ProvisionerDeps) {
  let pending = 0;
  let running: Promise<void> | null = null;
  const run = (): Promise<void> =>
    (running ??= settleSeeds(deps)
      .then((r) => {
        pending = r.pending;
        if (r.settled > 0) console.log(`provisioner: ${r.settled} workload PVC(s) seeded`);
      })
      .catch((err: unknown) => console.error('provisioner: seed pass failed:', err))
      .finally(() => {
        running = null;
      }));
  return {
    run,
    /** The poll: a pass only while something may still seed. */
    poll: (): Promise<void> =>
      pending > 0 || deps.bundles.heldBytes > 0 ? run() : Promise.resolve(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = depsFromEnv(process.env);
  const port = positiveIntEnv(process.env, 'MOCA_PROVISIONER_PORT', 8080);
  const server = startServer(deps, port);
  const seedServer = startSeedServer(
    deps,
    positiveIntEnv(process.env, 'MOCA_PROVISIONER_SEED_PORT', 8081),
  );
  const settle = seedSettler(deps);
  const records = deps.records;
  const sweep = records
    ? orphanSweeper({ ...deps, records }, deps.orphanGraceS, deps.redisTimeoutMs)
    : null;
  if (!sweep) console.error('provisioner: REDIS_URL is not set: no orphan sweep (spec §6.2)');
  // Re-mint attach tokens nearing expiry (spec §3.1), finish seeds a restart left behind (spec
  // §5.3), then sweep orphaned workloads (spec §6.2).
  const tick = () => {
    void settle.run();
    return remintExpiring(deps)
      .then((n) => n > 0 && console.log(`provisioner: re-minted ${n} attach token(s)`))
      .catch((err: unknown) => console.error('provisioner: re-mint pass failed:', err))
      .then(() => sweep?.());
  };
  void tick();
  const timer = setInterval(tick, deps.reconcileS * 1000);
  const seedTimer = setInterval(() => void settle.poll(), SEED_POLL_MS);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    clearInterval(seedTimer);
    seedServer.close();
    records?.close();
    server.close(() => process.exit(0));
  });
}
