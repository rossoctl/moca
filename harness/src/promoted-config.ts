import { gzipSync } from 'node:zlib';
import { createClient } from 'redis';
import { canonicalTar, type BundleRedisLike } from '@moca/config-bundle';
import type { SandboxTransport } from '@moca/k8s-sandbox';
import { resilientClientOptions, swallowRedisErrors } from '@moca/session-backend';
import { resolvePromotedConfig, type PromotedConfig } from './config-resolver.js';
import { buildConfigCleanupScript, overlayConfig } from './config-overlay.js';

/**
 * Lazily-created Redis client for the bundle store. Kept separate from the session backend's client
 * so a bundle fetch cannot interfere with session buffering.
 *
 * Caches the in-flight PROMISE, not the resolved client, mirroring RedisLeaseStore
 * (sandbox-lease.ts:38-45). Caching only the resolved value is a check-then-act race: two leaves
 * arriving before the first connect() settles would both pass the `!client` test, each create and
 * connect a client, and the loser's connection would be silently leaked — never closed, never
 * referenced again. Awaiting one shared promise makes concurrent callers converge on one client.
 */
let bundleRedisPromise: Promise<BundleRedisLike> | undefined;
let bundleRedisClient: { isOpen: boolean } | undefined;
/**
 * This runs in the WORKER process (`POST /runs` with a `configRef`) and lives as long as it does, so it
 * takes the same pairing as every other long-lived client (redis-errors.ts in @moca/session-backend):
 * the `'error'` listener, without which a Redis restart is an uncaught exception that kills the worker
 * and its in-flight turns (#423, Task 16b); the bounded reconnect, without which that listener would
 * leave a refused connect pending forever and hang the leaf; and the `!isOpen` re-arm, because past
 * the bound node-redis gives up on an ESTABLISHED client for good and every later command would
 * reject `ClientClosedError` against a memo that still looks resolved.
 */
export function getBundleRedis(redisUrl?: string): Promise<BundleRedisLike> {
  if (bundleRedisClient && !bundleRedisClient.isOpen) {
    // Given up for good (or closed): drop the memo and build afresh. A connect still in flight keeps
    // isOpen true (node-redis sets it synchronously in connect()), so this cannot race one.
    bundleRedisPromise = undefined;
    bundleRedisClient = undefined;
  }
  if (!bundleRedisPromise) {
    const attempt: Promise<BundleRedisLike> = (async () => {
      const client = createClient(
        resilientClientOptions(redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'),
      );
      swallowRedisErrors(client, 'config bundle store');
      bundleRedisClient = client;
      await client.connect();
      return client as unknown as BundleRedisLike;
    })().catch((err) => {
      // Do not cache a failed connect: clear the slot so the next leaf retries rather than
      // inheriting a permanently rejected promise. Only if it is still OURS: the !isOpen re-arm
      // above may already have replaced it, and clearing a newer attempt would orphan its client.
      if (bundleRedisPromise === attempt) {
        bundleRedisPromise = undefined;
        bundleRedisClient = undefined;
      }
      throw err;
    });
    bundleRedisPromise = attempt;
  }
  return bundleRedisPromise;
}

export interface PromotedConfigDeps {
  bundleRedis?: BundleRedisLike;
  resolvePromotedConfig?: typeof resolvePromotedConfig;
  overlayConfig?: typeof overlayConfig;
}

/**
 * The sandbox a promoted config overlays into: its exec channel. The transport is
 * caller-owned (a leased relay transport, ADR-0041 removed pod-exec) and is never closed
 * here — the caller's lease lifecycle owns it.
 */
export interface PromotedSandbox {
  transport: SandboxTransport;
}

export interface AttachedPromotedConfig {
  promotedConfig: PromotedConfig;
  /** Release this session's overlay link and its ref on the digest. Best-effort and idempotent. */
  detach(): Promise<void>;
}

/** Resolve a bundle into this pod and, when there is a sandbox, overlay it there (spec §4.4). */
export async function attachPromotedConfig(opts: {
  digest: string;
  sessionId: string;
  /** Keys this attach's ref on the digest; the session link stays keyed by `sessionId`. */
  refId?: string;
  sandbox: PromotedSandbox | null;
  redisUrl?: string;
  deps?: PromotedConfigDeps;
}): Promise<AttachedPromotedConfig> {
  const resolveFn = opts.deps?.resolvePromotedConfig ?? resolvePromotedConfig;
  const overlayFn = opts.deps?.overlayConfig ?? overlayConfig;
  const resolved = await resolveFn(
    opts.deps?.bundleRedis ?? (await getBundleRedis(opts.redisUrl)),
    opts.digest,
  );
  const sandbox = opts.sandbox;
  if (!sandbox) return { promotedConfig: resolved, detach: async () => {} };

  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    // Best-effort, matching cleanupWorkspace (converge.ts): swallow errors so a teardown hiccup
    // never masks the leaf's actual verdict. Same transport as the overlay below.
    try {
      await sandbox.transport.exec(
        buildConfigCleanupScript(opts.sessionId, opts.digest, opts.refId),
        { timeout: 60 },
      );
    } catch {
      /* ignore */
    }
  };

  // The overlay runs on the caller's leased relay transport (ADR-0041 removed the
  // KubectlTransport fallback for pods): the sandbox half of the bundle always arrives —
  // skill sibling files and memory must be readable — and the transport is never closed
  // here, because the caller's lease lifecycle owns it.
  try {
    const paths = await overlayFn(
      sandbox.transport,
      opts.digest,
      opts.sessionId,
      gzipSync(canonicalTar(resolved.entries)),
      ...(opts.refId === undefined ? [] : [opts.refId]),
    );
    return {
      promotedConfig: {
        ...resolved,
        // The overlay landed, so the skills are now readable from the sandbox — tell the
        // resolver, which rewrites the path pi ADVERTISES for each skill to this one
        // (issue #222). Set here and nowhere else: it is only true once the link exists.
        sandboxSkillsDir: paths.skillsDir,
        promptFragments: [
          ...resolved.promptFragments,
          // Self-describing and multi-line on purpose: this is the ONLY place the absolute
          // sandbox paths exist (the bundle is content-addressed and built before any leaf
          // or sandbox does, so notes.ts's skillsRootNote() cannot bake them in — it instead
          // points back at these two lines). A single-line string here would also risk
          // pi-fork's resolvePromptInput treating it as a file path when existsSync(input)
          // is true.
          [
            'The following are absolute sandbox paths for this session:',
            '',
            `Skill files: ${paths.skillsDir}`,
            `Memory files: ${paths.memoryDir}`,
          ].join('\n'),
        ],
      },
      detach,
    };
  } catch (err) {
    // Attempted, not succeeded (#216): overlayConfig's first exec claims the ref before it can push
    // any bytes, so an overlay that throws partway has already left one behind. Keying teardown on
    // success would pin that digest's cache forever and restore the very bug the refcount fixes. The
    // release script is idempotent, so running it after a failure is free.
    await detach();
    throw err;
  }
}
