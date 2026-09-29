import { gunzipSync, gzipSync } from 'node:zlib';
import { contentDigest, untar } from '@moca/config-bundle';

/**
 * Minimal structural Redis surface — lets unit tests inject an in-memory fake, exactly as
 * `leaf-result-store.ts` does. `exists` is what makes an unchanged re-promotion free.
 */
export interface BundleRedisLike {
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  exists(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Bundles are immutable; a TTL only reclaims space for workflows nobody dispatches any more. */
export const DEFAULT_BUNDLE_TTL_SECONDS = 60 * 60 * 24 * 30;

export function bundleKey(digest: string): string {
  return `config:bundle:${digest}`;
}

export class BundleNotFoundError extends Error {
  constructor(readonly digest: string) {
    super(`config bundle not found: ${digest}`);
    this.name = 'BundleNotFoundError';
  }
}

export class BundleDigestMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`config bundle digest mismatch: expected ${expected}, stored bytes hash to ${actual}`);
    this.name = 'BundleDigestMismatchError';
  }
}

/**
 * Store the bundle under its digest, gzipped and base64'd (base64 keeps the injectable
 * `BundleRedisLike` a plain string interface). Content-addressed, so an existing key means
 * identical content and the write is skipped. Verify the digest matches the tar first to prevent
 * key poisoning: a mismatched pair blocks any correct write under that digest for 30 days.
 */
export async function putBundle(
  redis: BundleRedisLike,
  digest: string,
  tar: Buffer,
  ttlSeconds: number = DEFAULT_BUNDLE_TTL_SECONDS,
): Promise<{ uploaded: boolean }> {
  // Verify digest matches tar before anything else
  let actual: string;
  try {
    actual = contentDigest(untar(tar));
  } catch {
    throw new BundleDigestMismatchError(digest, 'unreadable (untar failed)');
  }
  if (actual !== digest) throw new BundleDigestMismatchError(digest, actual);

  const key = bundleKey(digest);
  if ((await redis.exists(key)) > 0) {
    // Refresh TTL on skip: re-promotion must not let bundles age out while in active use
    await redis.expire(key, ttlSeconds);
    return { uploaded: false };
  }
  await redis.set(key, gzipSync(tar).toString('base64'), { EX: ttlSeconds });
  return { uploaded: true };
}

/**
 * Fetch and verify. A missing digest or a hash mismatch throws, never degrades: running a leaf
 * with silently-absent configuration produces plausible-but-wrong work, which is the expensive
 * remote failure this design exists to prevent (spec §4.4).
 */
export async function getBundle(redis: BundleRedisLike, digest: string): Promise<Buffer> {
  const raw = await redis.get(bundleKey(digest));
  if (raw === null) throw new BundleNotFoundError(digest);

  let tar: Buffer;
  try {
    tar = gunzipSync(Buffer.from(raw, 'base64'));
  } catch {
    throw new BundleDigestMismatchError(digest, 'unreadable (gunzip failed)');
  }

  let actual: string;
  try {
    actual = contentDigest(untar(tar));
  } catch {
    throw new BundleDigestMismatchError(digest, 'unreadable (untar failed)');
  }
  if (actual !== digest) throw new BundleDigestMismatchError(digest, actual);
  return tar;
}
