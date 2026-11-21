import { createHash } from 'node:crypto';
import { forLog } from './audit-log.js';
import { countAsync } from './counters.js';
import { open, seal, type Opened } from './envelope.js';
import { CpError } from './errors.js';
import type { Consumer, CredentialDescriptor, StoredCredential } from './credential-store.js';

/**
 * The at-rest shape the non-Kubernetes stores share (file-store.ts, vault-store.ts): ONE document
 * per subject, holding every credential that subject owns. It is the Kubernetes design (one Secret
 * per subject, k8s-secret-store.ts) with the annotations and `data` map folded into one object:
 *
 *   { "v": 1, "credentials": { "<name>": { "descriptor": {...}, "sealed": "v1.<iv>.<tag>.<ct>" } } }
 *
 * The same invariants carry over unchanged:
 * - the document is addressed by the subject's HASH, so every access is a lookup by exact key and
 *   no backend needs a list/enumerate permission (spec §6.5);
 * - only `sealed` is secret, and it is envelope-encrypted with `subject|name` as AAD, so a reader of
 *   the backend gets ciphertext and a writer cannot relabel one subject's row into another's;
 * - the descriptor sits OUTSIDE the ciphertext, so `list` decrypts nothing (spec §6.2).
 */
export function subjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 16);
}

/**
 * The document AS READ from the backend: only its envelope (`v`, `credentials`) is checked, and
 * everything inside -- entries this version cannot read, descriptor fields it does not know, any
 * top-level field -- is kept exactly as stored. Writes change ONE named entry and carry the rest
 * back untouched; entries are parsed only to answer `get` and `list`.
 *
 * Rebuilding the document from what this version understood and writing THAT back would make the
 * first put or delete for a subject silently erase every row it skipped. With several Vault-backed
 * replicas that is a rolling upgrade (or rollback) in which an older replica deletes each credential
 * a newer one wrote. The Kubernetes store never had the problem: it merge-patches single keys.
 */
export interface SubjectDocument {
  v: 1;
  credentials: Record<string, unknown>;
  [field: string]: unknown;
}

interface Entry {
  descriptor: CredentialDescriptor;
  sealed: string;
}

export const emptyDocument = (): SubjectDocument => ({ v: 1, credentials: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check a document read back from a backend, refusing in a TYPED way. A corrupt or foreign file is
 * "the credential store is not answering usefully" (503), not "the control plane has a bug" (500) --
 * the same reasoning as k8s-secret-store.ts's parseSecretJson. A version other than 1 is refused
 * outright, reads and writes alike: this code cannot know which of its fields a write would lose.
 */
export function parseDocument(raw: unknown): SubjectDocument {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.credentials)) {
    throw new CpError(
      'credential_unavailable',
      'the credential store returned an unexpected shape',
    );
  }
  return raw as SubjectDocument;
}

/**
 * One entry, or null when this version cannot read it. A null entry is skipped by `get` and `list`,
 * which mirrors the Kubernetes store skipping a data key with no annotations: one bad row must not
 * lock a subject out of every other credential they hold. It is NOT removed -- see SubjectDocument.
 */
function parseEntry(name: string, entry: unknown): Entry | null {
  if (!isRecord(entry) || typeof entry.sealed !== 'string') return null;
  const d = entry.descriptor;
  if (
    !isRecord(d) ||
    d.name !== name ||
    typeof d.kind !== 'string' ||
    typeof d.consumer !== 'string' ||
    !isRecord(d.destination) ||
    !Array.isArray(d.destination.hosts) ||
    !(isRecord(d.binding) || Array.isArray(d.binding))
  ) {
    return null;
  }
  return {
    descriptor: {
      name,
      kind: d.kind,
      consumer: d.consumer as Consumer,
      destination: { hosts: d.destination.hosts as string[] },
      binding: d.binding as unknown as CredentialDescriptor['binding'],
      endpoint: typeof d.endpoint === 'string' ? d.endpoint : null,
    },
    sealed: entry.sealed,
  };
}

/**
 * A copy with `cred` sealed in under `keks[0]`. Every other entry and field is carried over as
 * stored; the input document is not mutated.
 */
export function withCredential(
  doc: SubjectDocument,
  keks: Buffer[],
  subject: string,
  cred: StoredCredential,
): SubjectDocument {
  const { descriptor, secret } = cred;
  const entry: Entry = {
    descriptor,
    sealed: seal(keks, subject, descriptor.name, JSON.stringify(secret)),
  };
  return { ...doc, credentials: { ...doc.credentials, [descriptor.name]: entry } };
}

/** A copy without `name`, everything else as stored; the input document is not mutated. */
export function withoutCredential(doc: SubjectDocument, name: string): SubjectDocument {
  const credentials = { ...doc.credentials };
  delete credentials[name];
  return { ...doc, credentials };
}

/** Descriptors of every READABLE entry, sorted by name -- never touches the KEK (spec §6.2). */
export function describeAll(doc: SubjectDocument): CredentialDescriptor[] {
  return Object.entries(doc.credentials)
    .map(([name, raw]) => parseEntry(name, raw)?.descriptor)
    .filter((d): d is CredentialDescriptor => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readCredential(
  doc: SubjectDocument,
  keks: Buffer[],
  subject: string,
  name: string,
): StoredCredential | null {
  // Own-property only: a credential name is caller-chosen, and `doc.credentials['constructor']`
  // must be "absent", not Object.prototype's function.
  if (!Object.hasOwn(doc.credentials, name)) return null;
  const entry = parseEntry(name, doc.credentials[name]);
  if (!entry) return null;
  const plaintext = openOrBlameSubject(keks, subject, name, entry.sealed);
  return { descriptor: entry.descriptor, secret: JSON.parse(plaintext) as Record<string, string> };
}

/**
 * `open`, plus the two things an operator needs from it and a caller must never get. Shared by
 * every store, because the KEK rotation procedure (envelope.ts) depends on them whichever backend
 * holds the ciphertext:
 *
 * - `keyIndex > 0` is logged AND counted on EVERY read, deliberately not deduplicated. The terminating
 *   condition for dropping a retired KEK is "no credential has opened under a non-primary key for N
 *   days", and a once-per-process log would let a long-lived process satisfy it while credentials were
 *   still stale. The log line carries the subject and credential, for finding WHICH is stale; the
 *   counter (`GET /metrics`) is the same signal without log scraping, for deciding WHETHER any is.
 * - On failure, the error gains the subject hash. `open`'s own message names the credential, but a
 *   credential name is user-chosen and collides freely across subjects, so without the hash an
 *   operator knew some users were broken and could not enumerate which. The hash is already every
 *   store's object-name input, so it discloses no login, and it reaches no caller: `writeError`
 *   reduces a non-CpError to a bare `internal_error` with no message at all.
 */
export function openOrBlameSubject(
  keks: Buffer[],
  subject: string,
  name: string,
  sealed: string,
): string {
  let opened: Opened;
  try {
    opened = open(keks, subject, name, sealed);
  } catch (err) {
    throw new Error(`failed to decrypt credential '${name}' for subject ${subjectHash(subject)}`, {
      cause: err,
    });
  }
  if (opened.keyIndex > 0) {
    countAsync('credential_nonprimary_kek_reads');
    console.warn(
      `[control-plane] credential opened under NON-PRIMARY KEK ring index ${opened.keyIndex}: ` +
        `subject=${subjectHash(subject)} credential=${forLog(name)} -- re-seals on its next PUT; ` +
        `the retired key cannot be dropped yet`,
    );
  }
  return opened.plaintext;
}

/**
 * One read-modify-write at a time PER SUBJECT, within this process. The file store has no other
 * concurrency control; the Vault store adds check-and-set for writers in OTHER processes, and uses
 * this so its own concurrent writes queue instead of burning each other's retries.
 */
export class SubjectQueue {
  /** The tail of each subject's operation chain. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Run `op` after every earlier operation on this subject has settled, success or not. */
  run<T>(subject: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(subject) ?? Promise.resolve();
    const next = prev.then(op, op);
    const tail = next.catch(() => undefined);
    this.chains.set(subject, tail);
    // Drop the entry once this is the last queued op, so the map does not grow per subject forever.
    void tail.then(() => {
      if (this.chains.get(subject) === tail) this.chains.delete(subject);
    });
    return next;
  }
}
