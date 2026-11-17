import { gunzipSync, gzipSync } from 'node:zlib';
import { contentDigest, LOCKFILE_PATH } from './build.js';
import { assertBundleFormat } from './format.js';
import { canonicalTar, untar } from './tar.js';

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

/** Largest tar the control plane accepts; the client refuses the same bound before uploading. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

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
 * Verify `tar` against `digest` and return the exact string `putBundle` stores for it: the verified
 * content only, re-canonicalised (no `lockfile.json`, no trailing data), so the stored bytes are a
 * function of the digest and the first uploader cannot pin anything unchecked for everyone.
 */
export function prepareBundle(digest: string, tar: Buffer): string {
  let content: ReturnType<typeof untar>;
  try {
    content = untar(tar).filter((e) => e.path !== LOCKFILE_PATH);
  } catch {
    throw new BundleDigestMismatchError(digest, 'unreadable (untar failed)');
  }
  const actual = contentDigest(content);
  if (actual !== digest) throw new BundleDigestMismatchError(digest, actual);
  // After the digest: the marker is only meaningful on content that is what it claims to be. A
  // format this release cannot read is refused at upload, the earliest point anyone can be told,
  // rather than stored for a harness to fail on at the first turn (#510).
  assertBundleFormat(content);
  return gzipSync(canonicalTar(content)).toString('base64');
}

/**
 * Store the bundle's verified content (canonical tar, no `lockfile.json`) under its digest, gzipped
 * and base64'd (base64 keeps the injectable `BundleRedisLike` a plain string interface).
 * Content-addressed, so an existing key means identical content and the write is skipped. Verify the
 * digest matches the tar first to prevent key poisoning: a mismatched pair blocks any correct write
 * under that digest for 30 days.
 */
export async function putBundle(
  redis: BundleRedisLike,
  digest: string,
  tar: Buffer,
  ttlSeconds: number = DEFAULT_BUNDLE_TTL_SECONDS,
): Promise<{ uploaded: boolean }> {
  const value = prepareBundle(digest, tar);
  const key = bundleKey(digest);
  if ((await redis.exists(key)) > 0) {
    // Refresh TTL on skip: re-promotion must not let bundles age out while in active use
    await redis.expire(key, ttlSeconds);
    return { uploaded: false };
  }
  await redis.set(key, value, { EX: ttlSeconds });
  return { uploaded: true };
}

/**
 * Fetch and verify. A missing digest, a hash mismatch or an unknown format throws, never degrades:
 * running a leaf with silently-absent configuration produces plausible-but-wrong work, which is the
 * expensive remote failure this design exists to prevent (spec §4.4).
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

  let entries: ReturnType<typeof untar>;
  try {
    entries = untar(tar);
  } catch {
    throw new BundleDigestMismatchError(digest, 'unreadable (untar failed)');
  }
  const actual = contentDigest(entries);
  if (actual !== digest) throw new BundleDigestMismatchError(digest, actual);
  // A format newer than this reader knows throws rather than unpacking a layout it would misread:
  // the same "never degrade" rule as above (#510). No marker reads as version 1.
  assertBundleFormat(entries);
  return tar;
}
