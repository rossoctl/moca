import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { access, open as openFile, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProvenanceStore } from './provenance.js';
import { SubjectQueue } from './subject-document.js';
import type { SandboxTemplate } from './sandbox-config.js';

/**
 * The template catalog (template lifecycle spec §3.1-§3.3): templates are declared in the control
 * plane's store, each a name over its builds, with tags naming builds. This holds what the read API
 * (§4), the self-serve create (§4, §8.1), the host agents' builds and registration (§6.1, §8.2,
 * host-handlers.ts) and activation (§6.2-§6.4, activation.ts: each build's leases) need.
 *
 * Two implementations:
 *   MemoryTemplateCatalog  built from SH_SANDBOX_TEMPLATES at every start: today's behaviour, no
 *                          volume needed; nothing is recorded.
 *   FileTemplateCatalog    one JSON document per template under <SH_PROVENANCE_DIR>/catalog, the
 *                          env list imported ONCE into an empty catalog (with a provenance `create`
 *                          record per template) and ignored after that (a warning when it differs).
 *
 * A template imported from the env list has one build, `imported:<12 hex>` (importedBuildId): the
 * list names no snapshot, so there is no manifest hash to be its id, and the worker id is
 * deployment plumbing a client never sees, so the id is a digest of it, not the worker itself. A
 * registered build from a host agent is named by its snapshot's manifest hash.
 */

/** Written last by the one-time import, so a start without it resumes an interrupted import. */
const IMPORTED_MARKER = '.imported';

export const TEMPLATE_DOC_SCHEMA = 'moca-template/1';

export type OnboardingStatus =
  'queued' | 'building' | 'probing' | 'built' | 'registered' | 'rejected' | 'failed' | 'retired';

export interface BuildSpec {
  guest_mb?: number;
  vcpus?: number;
  workspace_mb?: number;
  seed?: string;
  tools: string[];
}

export interface TemplateBuild {
  /**
   * The provisional handle `b-<26 hex>` a queued build is followed by (§4), until it is built and
   * its buildId becomes its manifest hash; absent for an imported build.
   */
  handle?: string;
  /** `sha256:<manifest hash>`, or `imported:<12 hex>` for a build imported from the env list. */
  buildId: string;
  status: OnboardingStatus;
  /** The policy profile it was checked under (§8); `imported` for the env list's. */
  profile: string;
  /** The relay sandbox id of the worker serving it: deployment plumbing, never sent to clients. */
  worker: string;
  spec: BuildSpec;
  /** Epoch seconds. */
  createdAt: number;
  /** The digest of the provenance record that created it, when the catalog records provenance. */
  provenance?: string;
  /** What a host agent needs to build it (§6.1): the image and the spec as the client sent them. */
  request?: { image: string; spec: Record<string, unknown>; gateRecordSha256?: string };
  /** Epoch milliseconds it was queued: the claim order (createdAt is whole seconds). */
  queuedAtMs?: number;
  /** The host that claimed it, and when (epoch seconds). */
  claim?: { host: string; at: number };
  /**
   * Created on a selfAttest profile with a gate record the policy did not trust (self-attestation):
   * a fact of its create. Whether it is self-attested NOW is recomputed from the current policy
   * (attestationOf): an admin's promotion or removal of the record needs no rewrite.
   */
  selfAttested?: boolean;
  /**
   * Created on a selfAttest profile with a gate record, trusted or not at create: a fact of its
   * create. Such a build reads as self-attested whenever its record is not trusted NOW
   * (attestationOf), so a trust removal narrows it whatever the order of events.
   */
  selfAttestProfile?: boolean;
  /**
   * Its gate record's offline facts: whether the floor was checked offline, and, from a
   * `network_needed` contract, whether the offline run met it. Absent: no gate record.
   */
  gateFloor?: { checkedOffline: boolean; metOffline?: boolean };
  /** On `failed` or `rejected`: why, and at which step or rule. */
  reason?: { message: string; step?: string; rule?: string };
  /**
   * Activation leases (§6.3): each subject's hold on this build, until (epoch seconds). The build is
   * wanted active while any lease is unexpired; aging is a lease running out. `since` is when the
   * subject's hold began (renewals keep it: first leased, first placed); `record` is the digest of
   * the `activate` record that granted the lease, which a sandbox under it cites (§7.1).
   */
  leases?: { subject: string; until: number; since?: number; record?: string }[];
  /**
   * When its last lease ended, epoch seconds (§6.5, the idle grace): set when leases are dropped (a
   * deactivate's time, or the end of an expired lease the write clears). An expired lease still
   * stored counts too (lastLeaseEnd() in activation.ts takes the later).
   */
  lastLeaseEnd?: number;
  /**
   * The time of a deactivate with `stopNow: true` that left it with no lease (§6.5): a lease that
   * ended at or before it gets no idle grace (forced cold).
   */
  stopNowAt?: number;
  /** The host agent's build log, newest last, at most LOG_MAX entries (§4 logs). */
  log?: { at: number; level: 'info' | 'warn' | 'error'; step: string; message: string }[];
}

/** A build log keeps at most this many entries; older ones are dropped, oldest first. */
export const LOG_MAX = 1000;

export interface TemplateDoc {
  schema: typeof TEMPLATE_DOC_SCHEMA;
  id: string;
  /** Who owns it (§3.2); null for one the deployment declared (the env list). */
  owner: string | null;
  visibility: 'private' | 'deployment';
  description: string;
  /** tag -> buildId; `default` is the build a bare id resolves to. */
  tags: Record<string, string>;
  /**
   * tag -> when it was last assigned (epoch seconds) and by whom (a subject; null for the
   * deployment). Absent for a tag set at creation: then the template's createdAt and owner.
   */
  tagsMeta?: Record<string, { at: number; by: string | null }>;
  /** Newest first. */
  builds: TemplateBuild[];
  createdAt: number;
}

export interface TemplateCatalog {
  list(): Promise<TemplateDoc[]>;
  get(id: string): Promise<TemplateDoc | null>;
  /**
   * Writes a template (a new one, or one with a new build), serialized per id. `mutate` receives
   * the current document (null when there is none) and returns the one to write, or throws to
   * refuse; the write happens only when it returns. Absent on a catalog that cannot store.
   */
  update?(
    id: string,
    mutate: (cur: TemplateDoc | null) => Promise<TemplateDoc>,
  ): Promise<TemplateDoc>;
}

/** The build a reference names: `id` (tag default), `id:tag`, or `id@sha256:...` (§3.2). */
export function resolveBuild(
  doc: TemplateDoc,
  ref: { tag?: string; build?: string },
): TemplateBuild | null {
  if (ref.build !== undefined) return doc.builds.find((b) => b.buildId === ref.build) ?? null;
  const tag = ref.tag ?? 'default';
  // An own property only: `id:constructor` names no tag, not Object.prototype's constructor.
  const id = Object.hasOwn(doc.tags, tag) ? doc.tags[tag] : undefined;
  return id === undefined ? null : (doc.builds.find((b) => b.buildId === id) ?? null);
}

/** An imported build's id: stable per worker, and not the worker id (clients never see that). */
export const importedBuildId = (worker: string): string =>
  `imported:${createHash('sha256').update(worker).digest('hex').slice(0, 12)}`;

/** The template a declared env-list entry is, as one imported, registered build. */
export function docFromDeclared(
  t: SandboxTemplate,
  nowS: number,
  provenance?: string,
): TemplateDoc {
  const buildId = importedBuildId(t.worker);
  return {
    schema: TEMPLATE_DOC_SCHEMA,
    id: t.id,
    owner: null,
    visibility: 'deployment',
    description: t.description,
    tags: { default: buildId },
    builds: [
      {
        buildId,
        status: 'registered',
        profile: 'imported',
        worker: t.worker,
        spec: { tools: [...t.tools] },
        createdAt: nowS,
        ...(provenance ? { provenance } : {}),
      },
    ],
    createdAt: nowS,
  };
}

export class MemoryTemplateCatalog implements TemplateCatalog {
  private readonly docs: TemplateDoc[];
  constructor(declared: SandboxTemplate[], nowS = 0) {
    this.docs = declared.map((t) => docFromDeclared(t, nowS));
  }
  async list(): Promise<TemplateDoc[]> {
    return this.docs;
  }
  async get(id: string): Promise<TemplateDoc | null> {
    return this.docs.find((d) => d.id === id) ?? null;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export class FileTemplateCatalog implements TemplateCatalog {
  private readonly queue = new SubjectQueue();
  private readonly dir: string;
  private readonly declared: SandboxTemplate[];
  private readonly provenance: ProvenanceStore;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private ready: Promise<void> | undefined;

  /**
   * Creates <dir>/catalog (0700) and checks it is writable now. The import runs on first use, so a
   * constructor stays synchronous (depsFromEnv is); a failed import is retried on the next call.
   */
  constructor(opts: {
    dir: string;
    declared: SandboxTemplate[];
    provenance: ProvenanceStore;
    now?: () => number;
    warn?: (msg: string) => void;
  }) {
    this.dir = join(opts.dir, 'catalog');
    this.declared = opts.declared;
    this.provenance = opts.provenance;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((m) => console.warn(`[control-plane] ${m}`));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    accessSync(this.dir, constants.W_OK | constants.X_OK);
  }

  private ensure(): Promise<void> {
    this.ready ??= this.importOnce().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  /**
   * Imports SH_SANDBOX_TEMPLATES once, into an empty catalog, and is safe to crash part way: the
   * marker `.imported` is written last, so a start that finds no marker resumes. It writes only the
   * templates not yet in the catalog, and reuses a template's `create` record from the env list when
   * its stream already ends in one (a crash between the record and the document), so a resumed
   * import never appends a second `create`. With the marker present the catalog holds the
   * templates, and an env list that differs is only warned about.
   */
  private async importOnce(): Promise<void> {
    const have = await this.readAll();
    if (await this.imported()) {
      const ids = new Set(have.map((d) => d.id));
      const differs =
        this.declared.length !== have.filter((d) => d.owner === null).length ||
        this.declared.some((t) => !ids.has(t.id));
      if (differs) {
        this.warn(
          'SH_SANDBOX_TEMPLATES differs from the template catalog, which holds the templates now ' +
            '(it was imported once, into an empty catalog); the env list is ignored',
        );
      }
      return;
    }
    const done = new Set(have.map((d) => d.id));
    const nowS = Math.floor(this.now() / 1000);
    for (const t of this.declared) {
      if (done.has(t.id)) continue;
      const digest = (await this.importedCreate(t.id)) ?? (await this.appendCreate(t));
      await this.write(docFromDeclared(t, nowS, digest));
    }
    await this.markImported();
  }

  private async appendCreate(t: SandboxTemplate): Promise<string> {
    const { digest } = await this.provenance.append({
      stream: `template/${t.id}`,
      kind: 'create',
      subject: 'deployment',
      body: {
        source: 'SH_SANDBOX_TEMPLATES',
        buildId: importedBuildId(t.worker),
        worker: t.worker,
        description: t.description,
        tools: [...t.tools],
      },
    });
    return digest;
  }

  /** The digest of an earlier, interrupted import's `create` record for `id`, if its stream ends in one. */
  private async importedCreate(id: string): Promise<string | null> {
    const h = await this.provenance.head(`template/${id}`);
    if (!h) return null;
    const rec = await this.provenance.get(h.head);
    const body = rec?.body as { source?: unknown } | undefined;
    return rec?.kind === 'create' && body?.source === 'SH_SANDBOX_TEMPLATES' ? h.head : null;
  }

  private async imported(): Promise<boolean> {
    try {
      await access(join(this.dir, IMPORTED_MARKER));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private async markImported(): Promise<void> {
    const fh = await openFile(join(this.dir, IMPORTED_MARKER), 'w', 0o600);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async readAll(): Promise<TemplateDoc[]> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json')).sort();
    const out: TemplateDoc[] = [];
    for (const n of names) {
      const d = await this.readFile(n.slice(0, -'.json'.length));
      if (d) out.push(d);
    }
    return out;
  }

  private async readFile(id: string): Promise<TemplateDoc | null> {
    if (!ID_RE.test(id)) return null;
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const d = JSON.parse(raw) as TemplateDoc;
    if (d.schema !== TEMPLATE_DOC_SCHEMA || d.id !== id) {
      throw new Error(`template catalog entry ${id} is malformed`);
    }
    return d;
  }

  private async write(doc: TemplateDoc): Promise<void> {
    const final = join(this.dir, `${doc.id}.json`);
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
      const fh = await openFile(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(doc));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async list(): Promise<TemplateDoc[]> {
    await this.ensure();
    return this.readAll();
  }

  async get(id: string): Promise<TemplateDoc | null> {
    await this.ensure();
    return this.readFile(id);
  }

  async update(
    id: string,
    mutate: (cur: TemplateDoc | null) => Promise<TemplateDoc>,
  ): Promise<TemplateDoc> {
    if (!ID_RE.test(id)) throw new Error(`template id ${id} is not valid`);
    await this.ensure();
    return this.queue.run(id, async () => {
      const next = await mutate(await this.readFile(id));
      if (next.id !== id || next.schema !== TEMPLATE_DOC_SCHEMA)
        throw new Error('catalog update changed the id');
      await this.write(next);
      return next;
    });
  }
}

/** A worker's presence, as the relay mirrors it (harness pool-records.ts SandboxRecord). */
export interface PresenceRecord {
  sandboxId: string;
  labels: Record<string, string>;
  capacityMax: number;
}

export interface PresenceReader {
  list(): Promise<PresenceRecord[]>;
}

/**
 * The Redis hash the relay writes presence into: field = sandboxId, value = JSON(SandboxRecord).
 * MUST equal harness pool-records.ts recordsKey() (template-catalog.test.ts reads that source).
 */
export const PRESENCE_KEY = 'sh:sandbox:records';

export interface PresenceRedisLike {
  hGetAll(key: string): Promise<Record<string, string>>;
}

export function redisPresenceReader(client: PresenceRedisLike): PresenceReader {
  return {
    async list() {
      const all = await client.hGetAll(PRESENCE_KEY);
      const out: PresenceRecord[] = [];
      for (const v of Object.values(all)) {
        try {
          const r = JSON.parse(v) as Partial<PresenceRecord>;
          if (typeof r.sandboxId === 'string') {
            out.push({
              sandboxId: r.sandboxId,
              labels: r.labels && typeof r.labels === 'object' ? r.labels : {},
              capacityMax: typeof r.capacityMax === 'number' ? r.capacityMax : 0,
            });
          }
        } catch {
          // One unreadable record must not hide the others; readiness reads it as absent.
        }
      }
      return out;
    },
  };
}
