import { seal } from './envelope.js';
import { CpError } from './errors.js';
import {
  buildCreateSecretArgs,
  buildGetSecretArgs,
  buildPatchSecretArgs,
  defaultRunKubectl,
  isAlreadyExists,
  type RunKubectl,
} from './kubectl.js';
import type {
  Consumer,
  CredentialDescriptor,
  CredentialStore,
  StoredCredential,
} from './credential-store.js';
import { openOrBlameSubject, subjectHash } from './subject-document.js';

// Re-exported: the hash is also every other store's object-name input (subject-document.ts), and
// this module was its original home.
export { subjectHash };

/**
 * Per-user Kubernetes Secrets in a DEDICATED namespace, under envelope encryption (spec §6.5).
 *
 * Redis cannot hold these: it is entirely ephemeral (spec §2.5 -- no PVC, no volume, no appendonly),
 * so a pod bounce would lose every user's key and re-entry after each restart would make the system
 * fragile in its most visible place. Credentials are the one thing that must outlive every session.
 *
 * The Secret NAME is derived from the subject (sha256, 16 hex chars), which is what makes every
 * access a `get` by exact name -- so the runtime Role can omit the `list` verb and a bug or an
 * injection cannot enumerate users. A hash also means object names disclose no logins.
 *
 * Writes are MERGE PATCHES, never `apply`: apply would replace the whole Secret and drop the
 * subject's other credentials, and read-modify-write would lose updates -- the exact failure mode
 * spec §6.6 rejects a single shared Secret over.
 *
 * Per-user Secrets are right at demo and team scale and a known anti-pattern at very large user
 * counts (one etcd object each, with watch and informer cost). The recorded direction is an external
 * manager -- Vault, or External Secrets -- behind the same CredentialStore interface (spec §6.6).
 */
export function secretNameFor(subject: string): string {
  return `sh-cred-${subjectHash(subject)}`;
}

const ANNOTATION_PREFIX = 'sh.io';
const FIELDS = ['kind', 'consumer', 'destination', 'binding', 'endpoint'] as const;
const annotationKey = (field: (typeof FIELDS)[number], name: string): string =>
  `${ANNOTATION_PREFIX}/${field}.${name}`;

interface SecretJson {
  metadata?: { annotations?: Record<string, string> };
  data?: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse `kubectl get -o json` output into a SecretJson, or refuse in a TYPED way.
 *
 * `JSON.parse(raw) as SecretJson` asserted a shape it had not checked, so malformed kubectl output
 * (a proxy's HTML error page, a truncated read) escaped as a raw SyntaxError and became a 500
 * `internal_error` -- a code that says "the control plane has a bug" about something that is
 * squarely "the credential store is not answering right now".
 */
function parseSecretJson(raw: string): SecretJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CpError('credential_unavailable', 'the credential store returned a non-JSON body');
  }
  if (!isRecord(parsed)) {
    throw new CpError(
      'credential_unavailable',
      'the credential store returned an unexpected shape',
    );
  }
  // metadata/data are both optional in the wire object, so a wrong TYPE on either is the only thing
  // left to reject; every consumer below already treats absent as empty.
  const { metadata, data } = parsed as { metadata?: unknown; data?: unknown };
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new CpError(
      'credential_unavailable',
      'the credential store returned unexpected metadata',
    );
  }
  if (data !== undefined && !isRecord(data)) {
    throw new CpError('credential_unavailable', 'the credential store returned unexpected data');
  }
  return parsed as SecretJson;
}

/**
 * How long a `get secret` answer is reused, and how many subjects' answers are held.
 *
 * Every read here FORKS A PROCESS (kubectl.ts spawns the binary). One fork per credential read was
 * fine while reads happened at session start, and stopped being fine with MI1 §6.3's inference
 * listener: a worker redeems its grant on every single request to the provider, so a handful of
 * concurrent turns means a fork per completion -- the first thing to fall over under load, and the
 * loudest possible neighbour to the apiserver.
 *
 * Three seconds, not three minutes: it must be short enough that a credential a user has just
 * changed through another replica is not used for a visible length of time, and long enough that one
 * turn's burst of requests costs one fork.
 */
const READ_TTL_MS = 3_000;
const READ_MAX = 256;

export class K8sSecretStore implements CredentialStore {
  private readonly namespace: string;
  /** The KEK ring, newest first: `seal` uses the first, `open` tries each (envelope.ts). */
  private readonly keks: Buffer[];
  private readonly run: RunKubectl;
  private readonly now: () => number;
  /**
   * Cached READS, keyed by subject. The value is the in-flight PROMISE, not its result, so N
   * concurrent redemptions for the same user collapse into one fork rather than N.
   */
  private readonly reads = new Map<string, { at: number; secret: Promise<SecretJson | null> }>();

  constructor(opts: { namespace: string; keks: Buffer[]; run?: RunKubectl; now?: () => number }) {
    this.namespace = opts.namespace;
    this.keks = opts.keks;
    this.run = opts.run ?? defaultRunKubectl;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Turn a kubectl / Kubernetes-API failure into `credential_unavailable` (503) rather than letting it
   * escape as a plain Error and become 500 `internal_error`.
   *
   * The taxonomy already has the right code and nothing on the control-plane side mapped to it: an
   * unreachable API server, an expired ServiceAccount token, a 403 from a narrowed Role are all "the
   * credential store is not answering", which is a 503 the caller can retry -- not a 500 that says the
   * control plane is broken. The exact mirror of OwnershipIndex.guard, and for the same reason: this
   * class is the only thing that knows a call was a credential-store call.
   *
   * A CpError from a nested call is already typed and passes through unwrapped. The message never
   * carries kubectl's stderr, which can hold a token or a resource name.
   */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof CpError) throw err;
      throw new CpError('credential_unavailable', 'the credential store is not answering');
    }
  }

  private fetch(subject: string): Promise<SecretJson | null> {
    const hit = this.reads.get(subject);
    if (hit && this.now() - hit.at < READ_TTL_MS) return hit.secret;
    const secret = this.read(subject);
    // A FAILED read is never cached: a momentarily unreachable store must be retried by the next
    // caller, not held as this subject's answer for the whole TTL.
    secret.catch(() => this.reads.delete(subject));
    if (this.reads.size >= READ_MAX) this.prune();
    this.reads.set(subject, { at: this.now(), secret });
    return secret;
  }

  private async read(subject: string): Promise<SecretJson | null> {
    const raw = (
      await this.guard(() => this.run(buildGetSecretArgs(secretNameFor(subject), this.namespace)))
    ).trim();
    if (!raw) return null; // --ignore-not-found prints nothing
    return parseSecretJson(raw);
  }

  /** Drop what has expired, and if everything is still live, the oldest -- the map stays bounded. */
  private prune(): void {
    const cutoff = this.now() - READ_TTL_MS;
    for (const [subject, entry] of this.reads) {
      if (entry.at <= cutoff) this.reads.delete(subject);
    }
    const oldest = this.reads.keys().next();
    if (this.reads.size >= READ_MAX && !oldest.done) this.reads.delete(oldest.value);
  }

  /** Idempotent: the create is attempted every time and AlreadyExists is the expected outcome. */
  private async ensureSecret(subject: string): Promise<void> {
    try {
      await this.run(buildCreateSecretArgs(secretNameFor(subject), this.namespace));
    } catch (err) {
      // AlreadyExists is the expected outcome and is NOT an outage; anything else is.
      if (!isAlreadyExists(err)) {
        if (err instanceof CpError) throw err;
        throw new CpError('credential_unavailable', 'the credential store is not answering');
      }
    }
  }

  async put(subject: string, cred: StoredCredential): Promise<void> {
    const { descriptor, secret } = cred;
    await this.ensureSecret(subject);
    const patch = {
      metadata: {
        annotations: {
          [annotationKey('kind', descriptor.name)]: descriptor.kind,
          [annotationKey('consumer', descriptor.name)]: descriptor.consumer,
          [annotationKey('destination', descriptor.name)]: JSON.stringify(
            descriptor.destination.hosts,
          ),
          [annotationKey('binding', descriptor.name)]: JSON.stringify(descriptor.binding),
          // A null clears a stale endpoint left by a previous, inference-flavoured put.
          [annotationKey('endpoint', descriptor.name)]: descriptor.endpoint,
        },
      },
      // stringData, so kubectl does the base64. Read back through `data`, which is base64 -- the
      // asymmetry is kubectl's, and the fake in the test reproduces it on purpose.
      stringData: {
        [descriptor.name]: seal(this.keks, subject, descriptor.name, JSON.stringify(secret)),
      },
    };
    await this.guard(() =>
      this.run(buildPatchSecretArgs(secretNameFor(subject), this.namespace), JSON.stringify(patch)),
    );
    // A write THIS process made takes effect at once, whatever the read TTL says: a user who just
    // re-entered a key must not be served the old one by the replica they entered it on.
    this.reads.delete(subject);
  }

  async get(subject: string, name: string): Promise<StoredCredential | null> {
    const secret = await this.fetch(subject);
    const sealed = secret?.data?.[name];
    const annotations = secret?.metadata?.annotations ?? {};
    if (!sealed) return null;
    const descriptor = describe(name, annotations);
    if (!descriptor) return null;
    // Throws when NO key in the ring opens it, or on a wrong subject or a relabelled ciphertext --
    // the AAD is what makes "move Alice's row into Bob's" fail rather than succeed (spec §6.5). A
    // value sealed under a retired KEK still opens while that key remains in the ring, which is what
    // makes rotation possible; one sealed under a key that has been dropped throws rather than
    // reading as absent.
    // The rotation log line and the subject-hash blame live in subject-document.ts, shared with the
    // file and Vault stores; `data` is base64 on the wire, so decode before opening.
    const opened = openOrBlameSubject(
      this.keks,
      subject,
      name,
      Buffer.from(sealed, 'base64').toString('utf8'),
    );
    return { descriptor, secret: JSON.parse(opened) as Record<string, string> };
  }

  /** Descriptors only, from annotations -- so this path never touches the KEK (spec §6.2). */
  async list(subject: string): Promise<CredentialDescriptor[]> {
    const secret = await this.fetch(subject);
    if (!secret) return [];
    const annotations = secret.metadata?.annotations ?? {};
    const out: CredentialDescriptor[] = [];
    for (const name of Object.keys(secret.data ?? {})) {
      const descriptor = describe(name, annotations);
      // A stray data key with no annotations is skipped rather than reported with an invented
      // descriptor: list() reports only what it can actually describe.
      if (descriptor) out.push(descriptor);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(subject: string, name: string): Promise<void> {
    const secret = await this.fetch(subject);
    if (!secret) return; // nothing to do, and creating one to delete from would be absurd
    const patch = {
      metadata: {
        annotations: Object.fromEntries(FIELDS.map((f) => [annotationKey(f, name), null])),
      },
      // `data`, not `stringData`: `stringData` is a write-only, admission-time convenience the
      // apiserver base64-encodes INTO `data` for a non-null value and otherwise ignores entirely
      // -- nulling a stringData entry does not delete the corresponding data key, so a delete
      // that used it left the encrypted value in the Secret forever (invisible to list()/get(),
      // which both require the annotations this patch DOES clear, but never actually erased).
      // Only nulling `data` itself removes the persisted key.
      data: { [name]: null },
    };
    await this.guard(() =>
      this.run(buildPatchSecretArgs(secretNameFor(subject), this.namespace), JSON.stringify(patch)),
    );
    this.reads.delete(subject); // a revoke on this replica is immediate, as put()'s is
  }
}

/** Rebuild a descriptor from annotations, or null when the required ones are missing/corrupt. */
function describe(name: string, annotations: Record<string, string>): CredentialDescriptor | null {
  const kind = annotations[annotationKey('kind', name)];
  const consumer = annotations[annotationKey('consumer', name)];
  const destination = annotations[annotationKey('destination', name)];
  const binding = annotations[annotationKey('binding', name)];
  if (!kind || !consumer || !destination || !binding) return null;
  try {
    return {
      name,
      kind,
      consumer: consumer as Consumer,
      destination: { hosts: JSON.parse(destination) as string[] },
      binding: JSON.parse(binding) as CredentialDescriptor['binding'],
      endpoint: annotations[annotationKey('endpoint', name)] ?? null,
    };
  } catch {
    return null;
  }
}
