import { bundleKey, DEFAULT_BUNDLE_TTL_SECONDS } from '@moca/config-bundle';
import { CpError } from './errors.js';
import { subjectHash } from './subject-document.js';

/**
 * The Redis surface the config-bundle byte budget needs (R2 of the PR #458 review). Shapes match
 * node-redis: `zRange` here is the plain (key, MIN, MAX) BY SCORE form, not the index's REV form.
 */
export interface BundleBudgetRedisLike {
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRange(
    key: string,
    min: number | string,
    max: number | string,
    opts: { BY: 'SCORE' },
  ): Promise<string[]>;
  /** The same range, with each member's score: a listing needs the expiry the score already holds. */
  zRangeWithScores(
    key: string,
    min: number | string,
    max: number | string,
    opts: { BY: 'SCORE' },
  ): Promise<{ value: string; score: number }[]>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  hSet(key: string, values: Record<string, string>): Promise<unknown>;
  hmGet(key: string, fields: string[]): Promise<(string | null)[]>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  /** node-redis answers 1, or 0 when the key does not exist. */
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Layout. Each zset member is a digest scored by its expiry (epoch ms), so an entry ages out with
 * the bundle's own TTL; `meta` holds
 * `<storedBytes>:<subjectHash of the first uploader>[:<promotedAt epoch ms>]`.
 *
 * `promotedAt` is the third field because the score cannot answer "when did I promote this?": a
 * refresh or a session's touch pushes the score to now+TTL, so `score - TTL` reads as last-used.
 * Only `recordBundle` writes it, so a touch cannot move it. Entries written before it existed parse
 * with `promotedAt: null` (rossoctl/moca#559).
 */
export const BUNDLES_ALL_KEY = 'sh:cp:bundles:all';
export const BUNDLES_META_KEY = 'sh:cp:bundles:meta';
const ownerZsetFor = (hash: string): string => `sh:cp:bundles:owner:${hash}`;
export const bundleOwnerKey = (subject: string): string => ownerZsetFor(subjectHash(subject));

/**
 * The least a bundle is charged. A tiny bundle's value is ~100 B but its key, TTL, meta field and two
 * zset members cost Redis ~700-800 B, and each upload sums every live entry, so the floor bounds N.
 */
export const MIN_BUNDLE_CHARGE_BYTES = 4096;

export interface BundleBudgetLimits {
  subjectBytes: number;
  totalBytes: number;
}

const expiryMs = (nowMs: number): number => nowMs + DEFAULT_BUNDLE_TTL_SECONDS * 1000;

function parseMeta(
  raw: string | null,
): { bytes: number; owner: string; promotedAt: number | null } | null {
  if (raw === null) return null;
  const i = raw.indexOf(':');
  const bytes = Number(raw.slice(0, i));
  if (i <= 0 || !Number.isFinite(bytes)) return null;
  // The owner hash is fixed-width hex and carries no ':', so the rest splits unambiguously.
  const rest = raw.slice(i + 1);
  const j = rest.indexOf(':');
  if (j < 0) return { bytes, owner: rest, promotedAt: null };
  const promotedAt = Number(rest.slice(j + 1));
  return {
    bytes,
    owner: rest.slice(0, j),
    promotedAt: Number.isSafeInteger(promotedAt) && promotedAt > 0 ? promotedAt : null,
  };
}

/** The subjectHash a digest is charged to, or null when it has no budget entry. */
export async function bundleOwnerHash(
  redis: BundleBudgetRedisLike,
  digest: string,
): Promise<string | null> {
  const [raw] = await redis.hmGet(BUNDLES_META_KEY, [digest]);
  return parseMeta(raw ?? null)?.owner ?? null;
}

/** Remove whatever budget entry `digest` has, under whichever subject it is charged to. */
export async function dropBundleEntry(redis: BundleBudgetRedisLike, digest: string): Promise<void> {
  const owner = await bundleOwnerHash(redis, digest);
  await redis.zRem(BUNDLES_ALL_KEY, digest);
  if (owner !== null) await redis.zRem(ownerZsetFor(owner), digest);
  await redis.hDel(BUNDLES_META_KEY, [digest]);
}

/**
 * Refuse a NEW `digest` of `bytes` stored bytes that would take `subject` or the deployment past its
 * budget. Only sound under `withBundleLock`: admit, record and store must not interleave.
 */
export async function admitBundle(
  redis: BundleBudgetRedisLike,
  limits: BundleBudgetLimits,
  subject: string,
  digest: string,
  bytes: number,
  nowMs: number,
): Promise<void> {
  const ownKey = bundleOwnerKey(subject);
  // The caller found no key for `digest`, so any entry it still has is stale: counting it on top of
  // the new charge would refuse the very re-promotion that restores the bundle.
  await dropBundleEntry(redis, digest);
  const expired = await redis.zRange(BUNDLES_ALL_KEY, '-inf', nowMs, { BY: 'SCORE' });
  if (expired.length > 0) {
    await redis.hDel(BUNDLES_META_KEY, expired);
    await redis.zRemRangeByScore(BUNDLES_ALL_KEY, '-inf', nowMs);
  }
  await redis.zRemRangeByScore(ownKey, '-inf', nowMs);
  const live = await redis.zRange(BUNDLES_ALL_KEY, `(${nowMs}`, '+inf', { BY: 'SCORE' });
  const mine = new Set(await redis.zRange(ownKey, `(${nowMs}`, '+inf', { BY: 'SCORE' }));
  const metas = live.length > 0 ? await redis.hmGet(BUNDLES_META_KEY, live) : [];
  let total = 0;
  let own = 0;
  live.forEach((digest, i) => {
    const b = parseMeta(metas[i] ?? null)?.bytes ?? 0;
    total += b;
    if (mine.has(digest)) own += b;
  });
  if (own + bytes > limits.subjectBytes) {
    throw new CpError(
      'bundle_quota_exceeded',
      `storing this ${bytes}-byte bundle would exceed your config-bundle budget of ` +
        `${limits.subjectBytes} bytes (${own} in use)`,
    );
  }
  if (total + bytes > limits.totalBytes) {
    throw new CpError(
      'bundle_quota_exceeded',
      `storing this ${bytes}-byte bundle would exceed the deployment's config-bundle budget of ` +
        `${limits.totalBytes} bytes`,
    );
  }
}

/** Charge a newly stored digest to the subject that stored it. */
export async function recordBundle(
  redis: BundleBudgetRedisLike,
  subject: string,
  digest: string,
  bytes: number,
  nowMs: number,
): Promise<void> {
  const hash = subjectHash(subject);
  const score = expiryMs(nowMs);
  await redis.hSet(BUNDLES_META_KEY, { [digest]: `${bytes}:${hash}:${nowMs}` });
  await redis.zAdd(BUNDLES_ALL_KEY, { score, value: digest });
  await redis.zAdd(ownerZsetFor(hash), { score, value: digest });
  await redis.expire(ownerZsetFor(hash), DEFAULT_BUNDLE_TTL_SECONDS);
}

/** One of the caller's live charges, as `listBundlesByOwner` reports it. */
export interface OwnedBundle {
  digest: string;
  /** The charged bytes: the stored (gzip+base64) length, floored at MIN_BUNDLE_CHARGE_BYTES. */
  bytes: number;
  /** null for an entry recorded before the meta carried a promotedAt. */
  promotedAt: number | null;
  expiresAt: number;
}

/**
 * Every live bundle charged to `subject`, newest first (rossoctl/moca#559).
 *
 * Reads the subject's own zset, so there is no keyspace scan: a store keyed by digest has no owner
 * concept, and `KEYS config:bundle:*` is an all-tenant read the isolation spec S13 forbids on a
 * caller-facing path (rossoctl/moca#361) -- it was the cluster-admin workaround #559 was filed about.
 *
 * Unpaged on purpose. This zset is scored by EXPIRY, which a touch moves, so a score cursor could
 * skip or repeat a digest mid-walk; the sessions index pages safely only because its score is an
 * immutable promotedAt. N is bounded instead: the subject byte budget over MIN_BUNDLE_CHARGE_BYTES
 * caps a caller's live entries, and this costs two round trips whatever N is.
 *
 * Reports the BUDGET's view, not the keyspace's: an entry is not EXISTS-checked, because a charge
 * whose key has already gone still holds bytes until the next admit reaps it, and that charge is
 * exactly what the caller needs the digest of in order to delete it.
 */
export async function listBundlesByOwner(
  redis: BundleBudgetRedisLike,
  subject: string,
  nowMs: number,
): Promise<OwnedBundle[]> {
  const ownKey = bundleOwnerKey(subject);
  // `(nowMs` is Redis's exclusive bound, as admitBundle uses when it sums the live charges. WITHSCORES
  // because the score IS the expiry: fetching it per digest afterwards would be N round trips.
  const live = await redis.zRangeWithScores(ownKey, `(${nowMs}`, '+inf', { BY: 'SCORE' });
  if (live.length === 0) return [];
  const metas = await redis.hmGet(
    BUNDLES_META_KEY,
    live.map((m) => m.value),
  );
  const owner = subjectHash(subject);
  const bundles: OwnedBundle[] = [];
  live.forEach(({ value: digest, score }, i) => {
    const meta = parseMeta(metas[i] ?? null);
    // A member whose meta is gone is skipped rather than reported with a zero size: dropBundleEntry
    // removes the meta field, so this window is real and reads as "already deleted". A member whose
    // meta names another subject is a crossed write that must not widen into a cross-tenant read.
    if (meta && meta.owner === owner) {
      bundles.push({ digest, bytes: meta.bytes, promotedAt: meta.promotedAt, expiresAt: score });
    }
  });
  // Newest first. A legacy entry has no promotedAt to sort on and goes last, in digest order so the
  // listing is stable rather than dependent on the zset's expiry ordering.
  return bundles.sort(
    (a, b) =>
      (b.promotedAt ?? -1) - (a.promotedAt ?? -1) ||
      (a.promotedAt === null && b.promotedAt === null ? a.digest.localeCompare(b.digest) : 0),
  );
}

/** Push a stored digest's budget expiry out with its TTL. A digest with no entry is left alone. */
export async function refreshBundle(
  redis: BundleBudgetRedisLike,
  digest: string,
  nowMs: number,
): Promise<void> {
  const [raw] = await redis.hmGet(BUNDLES_META_KEY, [digest]);
  const meta = parseMeta(raw ?? null);
  if (!meta) return;
  const score = expiryMs(nowMs);
  await redis.zAdd(BUNDLES_ALL_KEY, { score, value: digest });
  await redis.zAdd(ownerZsetFor(meta.owner), { score, value: digest });
  await redis.expire(ownerZsetFor(meta.owner), DEFAULT_BUNDLE_TTL_SECONDS);
}

/** A session is using `digest`: keep the bundle and its budget entry alive for another TTL. */
export async function touchBundle(
  redis: BundleBudgetRedisLike,
  digest: string,
  nowMs: number,
): Promise<void> {
  // An expired key's entry lingers until the next admit; refreshing it would revive a charge for
  // bytes Redis no longer holds, and every 410ing turn of a dead session would keep it alive.
  if (Number(await redis.expire(bundleKey(digest), DEFAULT_BUNDLE_TTL_SECONDS)) !== 1) return;
  await refreshBundle(redis, digest, nowMs);
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` after every earlier caller's has settled. In-process only: this assumes the control plane
 * runs as a single replica (deploy/k8s renders 0 or 1), so one queue serializes every budget write.
 */
export function withBundleLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/** Undo `recordBundle` for a digest whose SET failed. */
export async function unrecordBundle(
  redis: BundleBudgetRedisLike,
  subject: string,
  digest: string,
): Promise<void> {
  await redis.zRem(BUNDLES_ALL_KEY, digest);
  await redis.zRem(bundleOwnerKey(subject), digest);
  await redis.hDel(BUNDLES_META_KEY, [digest]);
}
