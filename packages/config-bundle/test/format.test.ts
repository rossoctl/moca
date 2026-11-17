import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BUNDLE_FORMAT_VERSION,
  BundleFormatError,
  FORMAT_PATH,
  LOCKFILE_PATH,
  assertBundleFormat,
  buildBundle,
  bundleKey,
  canonicalTar,
  contentDigest,
  formatEntry,
  getBundle,
  prepareBundle,
  untar,
  type BundleRedisLike,
  type TarEntry,
} from '../src/index.js';

/** The format version must survive upload and be checked on read (change policy decision 7, #510). */

const skill: TarEntry = { path: 'skills/x/SKILL.md', content: Buffer.from('---\nname: x\n---\nb') };

function marker(body: string): TarEntry {
  return { path: FORMAT_PATH, content: Buffer.from(body) };
}

/** A tar of `entries` and the digest it really has, as a client would upload it. */
function upload(entries: TarEntry[]): { tar: Buffer; digest: string } {
  return { tar: canonicalTar(entries), digest: contentDigest(entries) };
}

/** A Redis holding `entries` exactly as the store keeps them. */
function storedRedis(entries: TarEntry[]): { redis: BundleRedisLike; digest: string } {
  const digest = contentDigest(entries);
  const value = gzipSync(canonicalTar(entries)).toString('base64');
  const redis: BundleRedisLike = {
    set: async () => 'OK',
    get: async (k) => (k === bundleKey(digest) ? value : null),
    exists: async () => 1,
    expire: async () => 1,
  };
  return { redis, digest };
}

describe('buildBundle writes the format version into the content', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cb-format-'));
    mkdirSync(join(root, 'prompts'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'go.md'), 'do it');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('as a content entry that the store keeps and the digest covers', () => {
    const r = buildBundle({
      roots: {},
      promptsDir: join(root, 'prompts'),
      entry: 'go',
      mode: 'unattended',
      sandboxImage: 'img',
      versions: { pi: '0', harness: '0' },
    });
    const entries = untar(r.tar);
    // Literal paths and messages in the tests that pin behavior, so they fail on a tree without the
    // marker by assertion rather than by a missing export.
    const format = entries.find((e) => e.path === 'format.json');
    expect(format?.content.toString('utf8')).toBe(`{"formatVersion":${BUNDLE_FORMAT_VERSION}}\n`);
    // The lockfile still records it too, and agrees.
    expect(r.lockfile.formatVersion).toBe(BUNDLE_FORMAT_VERSION);

    // What the control plane stores: verified content, lockfile dropped. The marker survives.
    const kept = untar(gunzipSync(Buffer.from(prepareBundle(r.digest, r.tar), 'base64'))).map(
      (e) => e.path,
    );
    expect(kept).toContain('format.json');
    expect(kept).not.toContain(LOCKFILE_PATH);

    // The digest depends on the marker, so a stored bundle cannot have it stripped or swapped.
    const without = entries.filter((e) => e.path !== 'format.json' && e.path !== LOCKFILE_PATH);
    expect(contentDigest(without)).not.toBe(r.digest);
  });
});

describe('assertBundleFormat', () => {
  it('names the marker format.json and writes the version as JSON', () => {
    expect(FORMAT_PATH).toBe('format.json');
    expect(formatEntry(3).content.toString('utf8')).toBe('{"formatVersion":3}\n');
  });

  it('reads a bundle without the marker as version 1 (built before it existed)', () => {
    expect(assertBundleFormat([skill])).toBe(1);
  });

  it('accepts the current version', () => {
    expect(assertBundleFormat([skill, formatEntry()])).toBe(BUNDLE_FORMAT_VERSION);
  });

  it('accepts an older version (the previous format stays readable)', () => {
    expect(assertBundleFormat([skill, formatEntry(1)], 2)).toBe(1);
  });

  it('refuses a newer version, naming both and what to upgrade', () => {
    const err = (() => {
      try {
        assertBundleFormat([skill, formatEntry(BUNDLE_FORMAT_VERSION + 1)]);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BundleFormatError);
    expect((err as Error).message).toContain(
      `format version ${BUNDLE_FORMAT_VERSION + 1} is newer`,
    );
    expect((err as Error).message).toContain('upgrade the harness');
  });

  it.each([
    'not json',
    '{}',
    '{"formatVersion":0}',
    '{"formatVersion":"1"}',
    '{"formatVersion":1.5}',
    'null',
  ])('refuses a malformed marker %j', (body) => {
    expect(() => assertBundleFormat([skill, marker(body)])).toThrow(BundleFormatError);
  });
});

describe('the store checks the format on upload and on read', () => {
  it('prepareBundle refuses a newer format (the control plane answers 400 with the message)', () => {
    const { tar, digest } = upload([skill, marker('{"formatVersion":2}\n')]);
    expect(() => prepareBundle(digest, tar)).toThrow(/format version 2 is newer/);
  });

  it('prepareBundle accepts a bundle without the marker and one with the current version', () => {
    for (const entries of [[skill], [skill, formatEntry()]]) {
      const { tar, digest } = upload(entries);
      expect(() => prepareBundle(digest, tar)).not.toThrow();
    }
  });

  it('getBundle refuses a stored bundle in a newer format, so the harness never unpacks it', async () => {
    const { redis, digest } = storedRedis([skill, marker('{"formatVersion":2}\n')]);
    await expect(getBundle(redis, digest)).rejects.toThrow(/format version 2 is newer/);
  });

  it('getBundle reads a stored bundle without the marker (stored before this change)', async () => {
    const { redis, digest } = storedRedis([skill]);
    expect(untar(await getBundle(redis, digest)).map((e) => e.path)).toEqual([skill.path]);
  });

  it('getBundle reads a stored bundle in the current format', async () => {
    const { redis, digest } = storedRedis([skill, formatEntry()]);
    expect(untar(await getBundle(redis, digest)).map((e) => e.path)).toContain(FORMAT_PATH);
  });
});
