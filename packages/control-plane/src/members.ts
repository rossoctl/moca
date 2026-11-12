import { randomUUID } from 'node:crypto';
import { open as openFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProvenanceStore } from './provenance.js';

/**
 * Enrollment and roles through the API (enrollment and roles spec). The deployment's
 * settings stay the bootstrap: SH_ALLOWED_SUBJECTS are always enrolled and SH_ADMIN_SUBJECTS always
 * admins, and the API never edits either. This store holds what the API adds on top of them, in the
 * control plane's template store directory (SH_PROVENANCE_DIR) beside the catalog, and each change is
 * a record on the `members` provenance stream.
 *
 * Roles are evaluated PER REQUEST from the bootstrap lists and this store (`rolesNow`), not taken
 * from a token's claims, so a grant, a revoke or a lapsed `until` takes effect at the subject's next
 * request. Reads come from an in-memory copy, re-read only when the file's mtime changes, so the
 * per-request evaluation (`membershipNow`) costs one open and fstat of the file, none for an admin
 * named in the settings. A subject the settings name is still answered when the file can't be read
 * (the settings stay the recovery path); anyone else fails closed.
 */

export const ADMIN = 'admin';

/**
 * The furthest ahead a grant's `until` may be: 366 days. A value in milliseconds (a pasted
 * `Date.now()`) would otherwise be accepted as a date tens of thousands of years away, a
 * "temporary" admin that never lapses. For a longer grant, give none (no expiry) and revoke it.
 */
export const MAX_GRANT_SECONDS = 366 * 86_400;

export interface RoleGrant {
  role: typeof ADMIN;
  /** Epoch seconds; absent: no expiry. */
  until?: number;
  /** The admin who granted it. */
  by: string;
  /** Epoch seconds. */
  since: number;
  /** Set once the lapse has been recorded (the `expired` record is written once). */
  expiredRecorded?: boolean;
}

export interface Member {
  subject: string;
  enrolled: boolean;
  roles: RoleGrant[];
  /** Epoch seconds of the last change. */
  since: number;
  /** The admin who made the last change. */
  by: string;
}

interface MembersDoc {
  members: Record<string, Member>;
}

export interface MemberView {
  subject: string;
  enrolled: boolean;
  /** `env`: from the deployment's settings (SH_ALLOWED_SUBJECTS / SH_ADMIN_SUBJECTS); `api`: this store. */
  source: 'env' | 'api';
  /**
   * Whether the store itself enrolls the subject, apart from the settings and any role: what an
   * unenroll would change, and what keeps the subject enrolled after the settings drop it.
   */
  storeEnrolled: boolean;
  roles: { role: string; source: 'env' | 'api'; until: number | null; by: string | null }[];
}

/** The deployment's bootstrap lists: what the API can never change. */
export interface Bootstrap {
  allowed: readonly string[];
  admins: readonly string[];
}

export class MembersStore {
  private readonly path: string;
  private readonly provenance: ProvenanceStore;
  private pending: Promise<unknown> = Promise.resolve();
  private cache: MembersDoc = { members: {} };
  private cacheMtimeMs = -1;
  readonly bootstrap: Bootstrap;

  constructor(opts: { dir: string; provenance: ProvenanceStore; bootstrap: Bootstrap }) {
    this.path = join(opts.dir, 'members.json');
    this.provenance = opts.provenance;
    this.bootstrap = opts.bootstrap;
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.pending.then(op, op);
    this.pending = next.catch(() => undefined);
    return next;
  }

  /**
   * The store as on disk, through the cache (re-read when the file's mtime moved). The mtime and the
   * bytes come from ONE open file: the file is replaced by rename, so the handle always reads the
   * version whose mtime it reported, never a newer one swapped in between a check and a read.
   */
  async doc(): Promise<MembersDoc> {
    let fh;
    try {
      fh = await openFile(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { members: {} };
        this.cacheMtimeMs = -1;
        return this.cache;
      }
      throw err;
    }
    try {
      const { mtimeMs } = await fh.stat();
      if (mtimeMs !== this.cacheMtimeMs) {
        const parsed = JSON.parse(await fh.readFile('utf8')) as MembersDoc;
        if (!parsed || typeof parsed.members !== 'object')
          throw new Error('members.json is invalid');
        this.cache = parsed;
        this.cacheMtimeMs = mtimeMs;
      }
    } finally {
      await fh.close();
    }
    return this.cache;
  }

  private async write(doc: MembersDoc): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let mtimeMs: number;
    try {
      const fh = await openFile(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(doc));
        await fh.sync();
        // The file's own mtime, from its handle: rename keeps it, so it is the mtime doc() will see.
        mtimeMs = (await fh.stat()).mtimeMs;
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    this.cache = doc;
    this.cacheMtimeMs = mtimeMs;
  }

  /**
   * One change, serialized: `fn` edits a copy of the doc and returns the record to write (or null
   * for no change). The record is appended before the file is replaced: a crash between the two leaves a record for a change the store does not hold, never the reverse.
   */
  change(
    fn: (
      doc: MembersDoc,
    ) => { kind: 'member' | 'role'; subject: string; body: Record<string, unknown> } | null,
  ): Promise<string | null> {
    return this.serial(async () => {
      const doc = structuredClone(await this.doc());
      const rec = fn(doc);
      if (!rec) return null;
      const { digest } = await this.provenance.append({
        stream: 'members',
        kind: rec.kind,
        subject: rec.subject,
        body: rec.body,
      });
      await this.write(doc);
      return digest;
    });
  }

  /**
   * The subject's roles now: the bootstrap admins, plus a store grant that has not lapsed. A grant
   * first seen lapsed has its `expired` record written once (best effort: a failure to record it
   * never changes the answer, which is already "not admin").
   */
  async rolesNow(subject: string, nowS: number): Promise<string[]> {
    if (this.bootstrap.admins.includes(subject)) return [ADMIN];
    return this.storeRoles(subject, (await this.doc()).members[subject], nowS);
  }

  /**
   * The subject's roles and the store's own enrollment now, for the per-request evaluation, from ONE
   * read of the store. An admin named in the settings is answered from the settings without reading
   * the file at all. A subject on the allow list is answered from the settings (no API role, no
   * store enrollment; the allow list still enrolls it) when the file can't be read, with a warning,
   * so a damaged members.json never locks out the settings' subjects. Anyone else fails closed: the
   * read's error propagates.
   */
  async membershipNow(
    subject: string,
    nowS: number,
  ): Promise<{ roles: string[]; enrolled: boolean }> {
    if (this.bootstrap.admins.includes(subject)) return { roles: [ADMIN], enrolled: false };
    let doc: MembersDoc;
    try {
      doc = await this.doc();
    } catch (err) {
      if (!this.bootstrap.allowed.includes(subject)) throw err;
      const why = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
      console.warn(
        `[control-plane] members.json can't be read (${why}): ${subject} answered from the settings alone`,
      );
      return { roles: [], enrolled: false };
    }
    const m = doc.members[subject];
    return { roles: await this.storeRoles(subject, m, nowS), enrolled: m?.enrolled === true };
  }

  /** A store grant's roles now; a grant first seen lapsed has its `expired` record written once. */
  private async storeRoles(
    subject: string,
    m: Member | undefined,
    nowS: number,
  ): Promise<string[]> {
    const g = m?.roles.find((r) => r.role === ADMIN);
    if (!g) return [];
    if (g.until === undefined || g.until > nowS) return [ADMIN];
    if (!g.expiredRecorded) await this.recordExpiry(subject, nowS).catch(() => undefined);
    return [];
  }

  /** Whether the store (not the allow list) enrolls the subject. */
  async storeEnrolled(subject: string): Promise<boolean> {
    return (await this.doc()).members[subject]?.enrolled === true;
  }

  /** Whether the subject is enrolled: the allow list, the store, or an admin by either route. */
  async enrolledNow(subject: string, nowS: number): Promise<boolean> {
    if (this.bootstrap.allowed.includes(subject)) return true;
    if ((await this.doc()).members[subject]?.enrolled) return true;
    return (await this.rolesNow(subject, nowS)).includes(ADMIN);
  }

  private recordExpiry(subject: string, nowS: number): Promise<string | null> {
    return this.change((doc) => {
      const g = doc.members[subject]?.roles.find((r) => r.role === ADMIN);
      if (!g || g.expiredRecorded || g.until === undefined || g.until > nowS) return null;
      g.expiredRecorded = true;
      return {
        kind: 'role',
        subject: 'control-plane',
        body: { subject, role: ADMIN, state: 'expired', until: g.until, before: 'granted' },
      };
    });
  }

  /** Every subject the deployment or the store knows, with where each fact comes from. */
  async list(nowS: number): Promise<MemberView[]> {
    const bootstrap = this.bootstrap;
    const doc = await this.doc();
    const subjects = new Set([
      ...bootstrap.allowed,
      ...bootstrap.admins,
      ...Object.keys(doc.members),
    ]);
    const out: MemberView[] = [];
    for (const subject of [...subjects].sort()) {
      const m = doc.members[subject];
      const envEnrolled = bootstrap.allowed.includes(subject);
      const envAdmin = bootstrap.admins.includes(subject);
      const roles: MemberView['roles'] = [];
      if (envAdmin) roles.push({ role: ADMIN, source: 'env', until: null, by: null });
      const g = m?.roles.find((r) => r.role === ADMIN);
      if (!envAdmin && g && (g.until === undefined || g.until > nowS))
        roles.push({ role: ADMIN, source: 'api', until: g.until ?? null, by: g.by });
      const enrolled = envEnrolled || !!m?.enrolled || roles.length > 0;
      if (!enrolled) continue;
      out.push({
        subject,
        enrolled,
        source: envEnrolled || envAdmin ? 'env' : 'api',
        storeEnrolled: m?.enrolled === true,
        roles,
      });
    }
    return out;
  }

  /** One subject's view (enrolled false, no roles, when neither the settings nor the store has it). */
  async view(subject: string, nowS: number): Promise<MemberView> {
    return (
      (await this.list(nowS)).find((v) => v.subject === subject) ?? {
        subject,
        enrolled: false,
        source: 'api',
        storeEnrolled: false,
        roles: [],
      }
    );
  }
}
