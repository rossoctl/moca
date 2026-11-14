import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { link, open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SubjectQueue } from './subject-document.js';

/**
 * Template provenance (template lifecycle spec §7): append-only records, each named by the sha256
 * of its canonical JSON and naming its predecessor's digest in `prev`, so any edit to a stored
 * record breaks the chain. Digests, not signatures: the chain heads, exported and kept elsewhere,
 * are what an offline verifier compares against.
 *
 * One chain per STREAM: `policy` for the deployment's policy records, `template/<id>` for
 * everything about one template (create, gate, build, check, activate, ...). A record in a
 * template stream cites a policy record by digest where it applied one (`check.body.policy`).
 *
 * On disk, under the control plane's persistent volume (NOT Redis, spec §7.2):
 *   records/<hex>.json   the record's canonical bytes; the file's own sha256 is its name
 *   heads/<hex>.json     per stream: {stream, head, count}; <hex> is the sha256 of the stream name
 *   blobs/<hex>          documents a record cites by sha256 (a gate record), byte for byte
 * A record is written before its stream's head moves, so a crash between the two leaves an
 * orphan record no chain reaches, never a head naming a missing record. One control-plane
 * process per directory, as for the file credential store.
 */

export const RECORD_SCHEMA = 'moca-provenance-record/1';
export const EXPORT_SCHEMA = 'moca-provenance-export/1';

/**
 * The record kinds of spec §7.1. The units that produce each event write its records; a verifier
 * that predates a kind refuses a store holding one.
 */
export const RECORD_KINDS = [
  'policy',
  'create',
  'gate',
  'build',
  'check',
  'activate',
  'deactivate',
  'tag',
  'visibility',
  'owner',
  'retire',
  'reject',
  'use',
  // A sandbox's span on its template's chain (§7.1): written at create and when it ends.
  'sandbox',
  // A Moca Pi session's span on a build (§7.1), as `sandbox` for a sandbox.
  'session',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** `policy`, or `template/<id>` with a template id as sandbox-config.ts admits it. */
const STREAM_RE = /^(policy|template\/[a-z0-9][a-z0-9-]{0,30})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface ProvenanceRecord {
  schema: typeof RECORD_SCHEMA;
  stream: string;
  /** 1 for a stream's first record. */
  seq: number;
  kind: RecordKind;
  /** The digest of the stream's previous record; null for seq 1. */
  prev: string | null;
  /** RFC 3339, UTC, whole seconds. */
  at: string;
  /** Who: a subject (`github:…`), `policy` for an automatic decision, `janitor`, or `host:<id>`. */
  subject: string;
  body: Record<string, unknown>;
}

export interface StreamHead {
  stream: string;
  head: string;
  count: number;
}

export interface ProvenanceExport {
  schema: typeof EXPORT_SCHEMA;
  exported_at: string;
  streams: StreamHead[];
  /** Every record of every exported stream, each stream's in seq order. */
  records: ProvenanceRecord[];
  /** The documents records cite by sha256, base64 of their exact bytes. */
  blobs: { sha256: string; base64: string }[];
}

/** A string holding a lone surrogate, which canonical JSON refuses (a caller checks input with it). */
export const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Canonical JSON: object keys sorted, no whitespace, JSON.stringify's string escapes. Restricted
 * so a second implementation (the stdlib-only Python verifier) produces the same bytes: keys are
 * ASCII, numbers are safe integers, strings hold no lone surrogate, and only plain objects,
 * arrays, strings, integers, booleans and null appear. Anything else is refused, not coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new Error(`canonical JSON holds integers only, got ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE_RE.test(value)) {
      throw new Error('canonical JSON refuses a string holding a lone surrogate');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (!/^[\x20-\x7e]*$/.test(k))
        throw new Error(`canonical JSON keys are printable ASCII, got ${JSON.stringify(k)}`);
      if (obj[k] === undefined)
        throw new Error(`canonical JSON refuses an undefined value (key ${k})`);
      parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonical JSON refuses a ${typeof value}`);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function recordDigest(r: ProvenanceRecord): string {
  return `sha256:${sha256Hex(canonicalJson(r))}`;
}

/**
 * The digest of a build's `build` record (outcome `built`): what a retire cites as `buildRecord`.
 * Matched by the build's handle when it has one, so a build that was built and then rejected (its
 * `buildId` stays its handle, not the manifest hash) still finds its record; by the manifest hash
 * otherwise. Null for a build that never produced one (imported, or retired before it was built).
 */
export async function buildRecordOf(
  store: ProvenanceStore,
  template: string,
  build: { buildId: string; handle?: string },
): Promise<string | null> {
  const r = (await store.chain(`template/${template}`)).find((x) => {
    const body = x.body as { outcome?: string; handle?: string; manifest_hash?: string };
    if (x.kind !== 'build' || body.outcome !== 'built') return false;
    return build.handle !== undefined
      ? body.handle === build.handle
      : body.manifest_hash === build.buildId;
  });
  return r ? recordDigest(r) : null;
}

const hexOf = (digest: string): string => digest.slice('sha256:'.length);

export interface AppendInput {
  stream: string;
  kind: RecordKind;
  subject: string;
  body: Record<string, unknown>;
}

export class ProvenanceStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly queue = new SubjectQueue();

  /**
   * Creates the directory tree (0700) and checks it is writable NOW, so a missing or read-only
   * volume fails the control plane at start, not on the first write.
   */
  constructor(opts: { dir: string; now?: () => number }) {
    if (!opts.dir) throw new Error('SH_PROVENANCE_DIR is required for the provenance store');
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    for (const d of ['records', 'heads', 'blobs'])
      mkdirSync(join(this.dir, d), { recursive: true, mode: 0o700 });
    accessSync(this.dir, constants.W_OK | constants.X_OK);
  }

  private headPath(stream: string): string {
    return join(this.dir, 'heads', `${sha256Hex(stream)}.json`);
  }

  async head(stream: string): Promise<StreamHead | null> {
    checkStream(stream);
    let raw: string;
    try {
      raw = await readFile(this.headPath(stream), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const h = JSON.parse(raw) as StreamHead;
    if (
      h.stream !== stream ||
      !DIGEST_RE.test(h.head) ||
      !Number.isSafeInteger(h.count) ||
      h.count < 1
    ) {
      throw new Error(`provenance head for ${stream} is malformed`);
    }
    return h;
  }

  /** Appends one record to its stream and returns it with its digest. */
  async append(input: AppendInput): Promise<{ digest: string; record: ProvenanceRecord }> {
    checkStream(input.stream);
    if (!(RECORD_KINDS as readonly string[]).includes(input.kind)) {
      throw new Error(`unknown provenance record kind ${input.kind}`);
    }
    if (input.kind === 'policy' && input.stream !== 'policy') {
      throw new Error('a policy record belongs to the policy stream');
    }
    if (input.kind !== 'policy' && input.stream === 'policy') {
      throw new Error(`a ${input.kind} record belongs to a template stream`);
    }
    if (!input.subject) throw new Error('a provenance record names its subject');
    return this.queue.run(input.stream, async () => {
      const h = await this.head(input.stream);
      const record: ProvenanceRecord = {
        schema: RECORD_SCHEMA,
        stream: input.stream,
        seq: (h?.count ?? 0) + 1,
        kind: input.kind,
        prev: h?.head ?? null,
        at: new Date(Math.floor(this.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        subject: input.subject,
        body: input.body,
      };
      const bytes = canonicalJson(record);
      const digest = `sha256:${sha256Hex(bytes)}`;
      await writeOnce(join(this.dir, 'records', `${hexOf(digest)}.json`), bytes);
      await writeReplace(
        this.headPath(input.stream),
        canonicalJson({ stream: input.stream, head: digest, count: record.seq }),
      );
      return { digest, record };
    });
  }

  /** Stores a document a record cites (a gate record), by the sha256 of its exact bytes. */
  async putBlob(bytes: Buffer): Promise<string> {
    const hex = sha256Hex(bytes);
    await writeOnce(join(this.dir, 'blobs', hex), bytes);
    return `sha256:${hex}`;
  }

  async getBlob(digest: string): Promise<Buffer | null> {
    if (!DIGEST_RE.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
    try {
      return await readFile(join(this.dir, 'blobs', hexOf(digest)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Reads one record, checking that its bytes still hash to its name. */
  async get(digest: string): Promise<ProvenanceRecord | null> {
    if (!DIGEST_RE.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
    let raw: string;
    try {
      raw = await readFile(join(this.dir, 'records', `${hexOf(digest)}.json`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (`sha256:${sha256Hex(raw)}` !== digest)
      throw new Error(`provenance record ${digest} does not match its digest`);
    return JSON.parse(raw) as ProvenanceRecord;
  }

  /** A stream's records, oldest first, walked from its head by `prev`. */
  async chain(stream: string): Promise<ProvenanceRecord[]> {
    const h = await this.head(stream);
    if (!h) return [];
    const out: ProvenanceRecord[] = [];
    let at: string | null = h.head;
    while (at) {
      const r = await this.get(at);
      if (!r) throw new Error(`provenance record ${at} of ${stream} is missing`);
      out.push(r);
      at = r.prev;
    }
    if (out.length !== h.count)
      throw new Error(
        `provenance stream ${stream} has ${out.length} records, its head says ${h.count}`,
      );
    return out.reverse();
  }

  /**
   * An export of the given template streams plus the policy stream they cite, and every blob a
   * `gate` record names: everything an offline verifier needs, in one JSON document.
   */
  async export(streams: string[]): Promise<ProvenanceExport> {
    const wanted = [...new Set(['policy', ...streams])];
    const heads: StreamHead[] = [];
    const records: ProvenanceRecord[] = [];
    const blobs: { sha256: string; base64: string }[] = [];
    for (const s of wanted) {
      const h = await this.head(s);
      if (!h) continue;
      heads.push(h);
      for (const r of await this.chain(s)) {
        records.push(r);
        const cited = r.kind === 'gate' ? r.body.record_sha256 : undefined;
        if (typeof cited === 'string' && !blobs.some((b) => b.sha256 === cited)) {
          const b = await this.getBlob(cited);
          if (b) blobs.push({ sha256: cited, base64: b.toString('base64') });
        }
      }
    }
    return {
      schema: EXPORT_SCHEMA,
      exported_at: new Date(Math.floor(this.now() / 1000) * 1000)
        .toISOString()
        .replace('.000Z', 'Z'),
      streams: heads,
      records,
      blobs,
    };
  }
}

function checkStream(stream: string): void {
  if (!STREAM_RE.test(stream))
    throw new Error(`provenance stream must be policy or template/<id>, got ${stream}`);
}

/**
 * Creates the file exactly once; an existing file with the same bytes is the same record. The bytes go
 * to a temp file first (fsync'd), and `link` puts it at `path` atomically or fails with EEXIST, so a
 * crash never leaves a torn file under a record's name. An existing file is read through its own
 * handle (O_RDONLY | O_NOFOLLOW), never by a second lookup of the path.
 */
async function writeOnce(path: string, bytes: string | Buffer): Promise<void> {
  const want = Buffer.from(bytes);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fh = await openFile(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(want);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, path);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const rh = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let have: Buffer;
    try {
      have = await rh.readFile();
    } finally {
      await rh.close();
    }
    if (!have.equals(want))
      throw new Error(`${path} exists with other bytes: refusing to overwrite`);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** write-temp + fsync + rename: the old content or the new, never a torn file. */
async function writeReplace(path: string, bytes: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fh = await openFile(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface VerifyResult {
  ok: boolean;
  /** One line per failed check; empty when ok. */
  errors: string[];
  /** Per stream: its head and record count, as verified. */
  streams: StreamHead[];
}

/**
 * Verifies an export offline, from the document alone: every record's digest, every stream's
 * `seq` and `prev` chain up to its listed head and count, record kinds and streams, every blob
 * against its sha256, and the references between records (a `check` cites a `policy` record of
 * the export; a `gate` names a blob the export carries). It cannot tell an export that dropped a
 * stream's latest records from an older one: compare `streams` with a head kept elsewhere.
 */
export function verifyExport(doc: ProvenanceExport): VerifyResult {
  const errors: string[] = [];
  if (doc?.schema !== EXPORT_SCHEMA) {
    return {
      ok: false,
      errors: [`schema is ${JSON.stringify(doc?.schema)}, want ${EXPORT_SCHEMA}`],
      streams: [],
    };
  }
  const byDigest = new Map<string, ProvenanceRecord>();
  const byStream = new Map<string, ProvenanceRecord[]>();
  for (const r of doc.records ?? []) {
    let d: string;
    try {
      d = recordDigest(r);
    } catch (e) {
      errors.push(`a record of ${r?.stream} is not canonical JSON: ${(e as Error).message}`);
      continue;
    }
    byDigest.set(d, r);
    if (!byStream.has(r.stream)) byStream.set(r.stream, []);
    byStream.get(r.stream)!.push(r);
  }
  const blobs = new Map<string, Buffer>();
  for (const b of doc.blobs ?? []) {
    const bytes = Buffer.from(b.base64, 'base64');
    if (`sha256:${sha256Hex(bytes)}` !== b.sha256)
      errors.push(`blob ${b.sha256} does not match its bytes`);
    else blobs.set(b.sha256, bytes);
  }
  const listed = new Set<string>();
  for (const h of doc.streams ?? []) {
    listed.add(h.stream);
    const rs = byStream.get(h.stream) ?? [];
    let prev: string | null = null;
    rs.forEach((r, i) => {
      const d = recordDigest(r);
      const where = `${h.stream} seq ${r.seq}`;
      if (r.schema !== RECORD_SCHEMA) errors.push(`${where}: schema ${JSON.stringify(r.schema)}`);
      if (r.seq !== i + 1) errors.push(`${where}: expected seq ${i + 1}`);
      if (r.prev !== prev)
        errors.push(`${where}: prev ${r.prev} does not name the record before it (${prev})`);
      if (!(RECORD_KINDS as readonly string[]).includes(r.kind))
        errors.push(`${where}: unknown kind ${r.kind}`);
      if ((r.kind === 'policy') !== (h.stream === 'policy'))
        errors.push(`${where}: a ${r.kind} record in stream ${h.stream}`);
      if (r.kind === 'check') {
        const p = r.body?.policy;
        const pr = typeof p === 'string' ? byDigest.get(p) : undefined;
        if (!pr || pr.kind !== 'policy')
          errors.push(
            `${where}: check cites policy ${String(p)}, not a policy record of this export`,
          );
      }
      if (r.kind === 'gate') {
        const g = r.body?.record_sha256;
        if (typeof g !== 'string' || !blobs.has(g))
          errors.push(`${where}: gate cites ${String(g)}, not a blob of this export`);
      }
      prev = d;
    });
    if (rs.length !== h.count)
      errors.push(`${h.stream}: ${rs.length} records, its head says ${h.count}`);
    if (prev !== h.head)
      errors.push(`${h.stream}: the last record is ${prev}, its head says ${h.head}`);
  }
  for (const s of byStream.keys())
    if (!listed.has(s)) errors.push(`records of stream ${s}, which has no head in the export`);
  return { ok: errors.length === 0, errors, streams: doc.streams ?? [] };
}
