import { BUNDLE_FORMAT_VERSION } from './types.js';
import type { TarEntry } from './types.js';

/**
 * The bundle's format version, carried IN the content (change policy decision 7, #510).
 *
 * `lockfile.json` has always recorded `formatVersion`, but the store keeps only the verified content
 * and drops the lockfile (ADR-0038, `prepareBundle`), so the version never reached a reader. This
 * entry is content like any other: the digest covers it, the store keeps it, and the harness reads
 * it after verifying the digest. That does not make the digest depend on itself, which is the reason
 * the lockfile is excluded (`contentDigest`): this file records the format, never the digest.
 *
 * A root-level path, outside every prefix a reader acts on (`skills/`, `prompts/`, `context/`,
 * `prompt/`, `memory/`), so a harness from before this file ignores it, and no user file can land
 * here: every user file is placed under one of those prefixes by `buildBundle`.
 */
export const FORMAT_PATH = 'format.json';

/** The entry `buildBundle` adds: fixed bytes per version, so identical content keeps one digest. */
export function formatEntry(version: number = BUNDLE_FORMAT_VERSION): TarEntry {
  return {
    path: FORMAT_PATH,
    content: Buffer.from(`${JSON.stringify({ formatVersion: version })}\n`, 'utf8'),
  };
}

/** A verified bundle this reader must not use: a newer format than it knows, or a bad marker. */
export class BundleFormatError extends Error {
  constructor(
    readonly found: string,
    readonly known: number,
  ) {
    super(
      /^[1-9]\d*$/.test(found)
        ? `config bundle format version ${found} is newer than the ${known} this release reads; ` +
            'upgrade the harness and the control plane before the client that built it'
        : `config bundle ${FORMAT_PATH} is not a format version this release reads (${found}); it reads up to ${known}`,
    );
    this.name = 'BundleFormatError';
  }
}

/**
 * The format version of a bundle's content entries. A bundle without the marker is version 1: it was
 * built before the marker existed, and the policy requires the previous format to stay readable.
 * Throws `BundleFormatError` on a malformed marker.
 */
export function bundleFormatVersion(
  entries: TarEntry[],
  known: number = BUNDLE_FORMAT_VERSION,
): number {
  const entry = entries.find((e) => e.path === FORMAT_PATH);
  if (!entry) return 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content.toString('utf8'));
  } catch {
    throw new BundleFormatError('unparseable JSON', known);
  }
  const v = (parsed as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw new BundleFormatError(`formatVersion ${JSON.stringify(v ?? null)}`, known);
  }
  return v;
}

/**
 * Refuse, loudly, a format this reader does not understand; accept this one and every older one.
 * Called on verified content only (after the digest check), by the store on upload and on read.
 */
export function assertBundleFormat(
  entries: TarEntry[],
  known: number = BUNDLE_FORMAT_VERSION,
): number {
  const v = bundleFormatVersion(entries, known);
  if (v > known) throw new BundleFormatError(String(v), known);
  return v;
}
