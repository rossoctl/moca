import { CpError } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  requireEnrolledPrincipal,
  seconds,
} from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import type { SandboxConfig } from './sandbox-config.js';
import { canonicalJson, sha256Hex, type ProvenanceStore } from './provenance.js';
import {
  checkCreate,
  normalizeSpec,
  policyDigest,
  policyProblems,
  TEMPLATE_ID_RE,
  type Policy,
  type PolicyStore,
} from './template-policy.js';
import {
  TEMPLATE_DOC_SCHEMA,
  MemoryTemplateCatalog,
  resolveBuild,
  type TemplateBuild,
  type TemplateCatalog,
  type TemplateDoc,
} from './template-catalog.js';
import {
  isLive,
  viewOf,
  type SandboxRecord,
  type SandboxStore,
  type SandboxView,
} from './sandbox-store.js';
import { mintSandboxToken } from './sandbox-token.js';
import { SubjectQueue } from './subject-document.js';
import type { TokenClaims } from './token.js';

/**
 * The sandbox resource's handlers (SBX0 spec §5.1), mounted on the `sandbox` route profile only,
 * and the template routes (template lifecycle spec §4: reads, self-serve create, cancel, the policy
 * and the quota), mounted on both.
 * Only TYPES come from handlers.ts, which spreads this table into HANDLERS: a runtime import back
 * would be a module cycle.
 */

/** `sbx-` plus 26 random lowercase hex characters (spec §5.1); also the workspace key. */
export const SANDBOX_ID_RE = /^sbx-[0-9a-f]{26}$/;
const ID_HEX = 26;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A label key; openapi.yaml's `propertyNames` states the same pattern (openapi-contract.test.ts). */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_LABELS = 16;
const MAX_LABEL_BYTES = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function service(deps: CpDeps): { cfg: SandboxConfig; store: SandboxStore } {
  // The sandbox profile always has both (configFromEnv, depsFromEnv); a harness one never mounts
  // these routes. Either missing is a wiring bug.
  if (!deps.config.sandbox || !deps.sandboxes) {
    throw new CpError('internal_error', 'the sandbox service is not configured');
  }
  return { cfg: deps.config.sandbox, store: deps.sandboxes };
}

/**
 * The id, from `deps.newId()`: its first 26 RANDOM hex characters. In production newId is
 * randomUUID, whose version nibble is fixed and whose variant nibble is half fixed, so both are
 * dropped (30 random hex remain). Fewer than 26 would make ids collide, so that is refused.
 */
function sandboxId(raw: string): string {
  let hex = raw.toLowerCase();
  if (UUID_RE.test(hex)) {
    const h = hex.replace(/-/g, '');
    hex = h.slice(0, 12) + h.slice(13, 16) + h.slice(17);
  }
  hex = hex.replace(/[^0-9a-f]/g, '');
  if (hex.length < ID_HEX) throw new CpError('internal_error', 'id source is too short');
  return `sbx-${hex.slice(0, ID_HEX)}`;
}

const requireEnrolled = (ctx: RequestCtx, deps: CpDeps): TokenClaims =>
  requireEnrolledPrincipal(ctx, deps.config);

/**
 * The sandbox ownership choke point, as assertOwner is for sessions. Every `sandboxScoped` route
 * goes through it (route-authz-enumeration.test.ts). A non-owner gets 404, never 403, so an id
 * names nothing to anyone else (spec §5.1). `admin` may read and delete any sandbox; minting is
 * owner-only for admins too (spec §4.2), so an admin cannot exec into another user's code.
 */
async function assertSandboxOwner(
  ctx: RequestCtx,
  deps: CpDeps,
  opts: { admin: boolean },
): Promise<SandboxRecord> {
  const p = requireEnrolled(ctx, deps);
  const id = ctx.params.id ?? '';
  const rec = await service(deps).store.get(id, seconds(deps));
  if (!rec || (rec.owner !== p.sub && !(opts.admin && isAdmin(p)))) {
    throw new CpError('sandbox_not_found', 'no such sandbox');
  }
  return rec;
}

/** The wire `Sandbox` (spec §5.1): nulls, never absent fields, and no worker or tenant. */
function sandboxBody(v: SandboxView) {
  return {
    id: v.id,
    owner: v.owner,
    name: v.name || null,
    template: v.template,
    // The exact build it runs on (template lifecycle spec §9): its manifest hash when the build has
    // one; null on a record from before tracing.
    buildId: v.buildId ?? null,
    templateManifestHash: v.buildId?.startsWith('sha256:') ? v.buildId : null,
    state: v.state,
    reason: v.reason ?? null,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    terminatedAt: v.terminatedAt ?? null,
    labels: v.labels,
  };
}

function parseLabels(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  const o = asRecord(raw);
  if (raw !== o || Object.keys(o).length > MAX_LABELS) {
    throw new CpError(
      'invalid_request',
      `labels must be an object of at most ${MAX_LABELS} entries`,
    );
  }
  for (const [k, v] of Object.entries(o)) {
    if (!LABEL_KEY_RE.test(k)) {
      throw new CpError('invalid_request', `label keys must match ${LABEL_KEY_RE}`);
    }
    if (typeof v !== 'string' || Buffer.byteLength(v) > MAX_LABEL_BYTES) {
      throw new CpError(
        'invalid_request',
        `label values must be strings of at most ${MAX_LABEL_BYTES} bytes`,
      );
    }
  }
  return { ...(o as Record<string, string>) };
}

/** Sandbox writes are audited best effort: the write already happened (handler-util.ts). */
const audit = (deps: CpDeps, subject: string, sandboxId: string, decision: string) =>
  auditBestEffort(deps, decision, sandboxId, { subject, sandboxId, decision });

/**
 * A sandbox's start on its template's chain (template lifecycle spec §7.1): the build its reference
 * resolved to, and that build's manifest hash (null for a build imported from SH_SANDBOX_TEMPLATES,
 * which names no snapshot). There are no activation leases yet, so `lease` is null; activation
 * fills it in, as the digest of the `activate` record the lease came from. A no-op without a
 * provenance store.
 */
async function sandboxCreated(deps: CpDeps, rec: SandboxRecord, subject: string): Promise<void> {
  if (!deps.provenance) return;
  await deps.provenance.append({
    stream: `template/${rec.template}`,
    kind: 'sandbox',
    subject,
    body: {
      sandboxId: rec.id,
      buildId: rec.buildId ?? null,
      templateManifestHash: rec.buildId?.startsWith('sha256:') ? rec.buildId : null,
      lease: null,
      state: 'created',
      expiresAt: rec.expiresAt,
    },
  });
}

/**
 * A sandbox's end on its template's chain (§7.1): `deleted` when DELETE ends it, `expired` when it
 * is first seen past its expiresAt (expiry is computed, not an event, so that record comes when it
 * is noticed; its body's expiresAt is the true end).
 */
async function sandboxEnded(
  deps: CpDeps,
  rec: SandboxRecord,
  subject: string,
  reason: 'deleted' | 'expired',
  nowS: number,
): Promise<void> {
  if (!deps.provenance) return;
  await deps.provenance.append({
    stream: `template/${rec.template}`,
    kind: 'sandbox',
    subject,
    body: {
      sandboxId: rec.id,
      buildId: rec.buildId ?? null,
      state: 'terminated',
      reason,
      expiresAt: rec.expiresAt,
      ...(reason === 'deleted' ? { endedAt: nowS } : {}),
    },
  });
}

/**
 * The `expired` end records (§7.1), written when expiry is first noticed: the janitor's sweep reads
 * every sandbox, so it is where an expired one is seen. Once per sandbox: a template chain already
 * holding this sandbox's terminated record is skipped (the chain is the marker, no store field).
 */
async function recordExpiries(deps: CpDeps, recs: SandboxRecord[], nowS: number): Promise<void> {
  if (!deps.provenance) return;
  const expired = recs.filter((r) => r.deletedAt === undefined && nowS >= r.expiresAt);
  const byTemplate = new Map<string, SandboxRecord[]>();
  for (const r of expired) byTemplate.set(r.template, [...(byTemplate.get(r.template) ?? []), r]);
  for (const [template, rs] of byTemplate) {
    const ended = new Set(
      (await deps.provenance.chain(`template/${template}`))
        .filter(
          (x) => x.kind === 'sandbox' && (x.body as { state?: string }).state === 'terminated',
        )
        .map((x) => (x.body as { sandboxId?: string }).sandboxId),
    );
    for (const r of rs)
      if (!ended.has(r.id)) await sandboxEnded(deps, r, 'janitor', 'expired', nowS);
  }
}

/**
 * The catalog (template lifecycle spec §3.1); built from the env list when none is wired: the
 * sandbox profile's SH_SANDBOX_TEMPLATES. A harness control plane without a store declares none, and
 * its catalog is empty.
 */
function catalog(deps: CpDeps): TemplateCatalog {
  return deps.templates ?? new MemoryTemplateCatalog(deps.config.sandbox?.templates ?? []);
}

const canSee = (d: TemplateDoc, p: TokenClaims): boolean =>
  d.visibility === 'deployment' || d.owner === p.sub || isAdmin(p);

async function visibleTemplates(deps: CpDeps, p: TokenClaims): Promise<TemplateDoc[]> {
  return (await catalog(deps).list()).filter((d) => canSee(d, p));
}

/** 404 for a template the caller cannot see, as for one that does not exist (no existence oracle). */
async function visibleTemplate(deps: CpDeps, p: TokenClaims, id: string): Promise<TemplateDoc> {
  const d = await catalog(deps).get(id);
  if (!d || !canSee(d, p)) throw new CpError('template_not_found', 'no such template');
  return d;
}

/**
 * What readiness is derived from (§3.3): attached workers, and, where this control plane holds
 * sandbox records (the sandbox profile), the live sandboxes per worker and the latest creation
 * on each. The harness profile's sessions name a template, not a worker, so there `inUse` and
 * `lastUsed` are null (not zero): unknown, until use records exist (spec §7.1 `use`).
 */
interface ReadinessFacts {
  /** worker sandbox id -> its advertised capacity; present = attached to the relay. */
  attached: Map<string, number> | null;
  inUse: Map<string, number> | null;
  /** worker -> epoch seconds of the newest sandbox created on it, retained records included. */
  lastUsed: Map<string, number> | null;
}

async function readinessFacts(deps: CpDeps): Promise<ReadinessFacts> {
  let attached: Map<string, number> | null = null;
  if (deps.presence) {
    try {
      attached = new Map((await deps.presence.list()).map((r) => [r.sandboxId, r.capacityMax]));
    } catch {
      // Presence unreadable: readiness is unknown, not inactive (a client must not act on a guess).
      attached = null;
    }
  }
  if (deps.config.routeProfile !== 'sandbox' || !deps.sandboxes) {
    return { attached, inUse: null, lastUsed: null };
  }
  const inUse = new Map<string, number>();
  const lastUsed = new Map<string, number>();
  const now = seconds(deps);
  for (const r of await deps.sandboxes.listAll(now)) {
    if (isLive(r, now)) inUse.set(r.worker, (inUse.get(r.worker) ?? 0) + 1);
    lastUsed.set(r.worker, Math.max(lastUsed.get(r.worker) ?? 0, r.createdAt));
  }
  return { attached, inUse, lastUsed };
}

/**
 * One build on the wire (openapi TemplateBuild), never its worker. Readiness, for a registered
 * build: `active` while the relay holds its worker's presence record, `inactive` without one,
 * `unknown` when presence cannot be read; null for a build that is not registered.
 */
function buildBody(d: TemplateDoc, b: TemplateBuild, f: ReadinessFacts, full: boolean) {
  const readiness =
    b.status !== 'registered'
      ? null
      : f.attached === null
        ? 'unknown'
        : f.attached.has(b.worker)
          ? 'active'
          : 'inactive';
  return {
    buildId: b.buildId,
    status: b.status,
    profile: b.profile,
    readiness,
    capacity:
      readiness === 'active'
        ? {
            running: f.attached?.get(b.worker) ?? 0,
            inUse: f.inUse === null ? null : (f.inUse.get(b.worker) ?? 0),
          }
        : null,
    lastUsedAt: f.lastUsed === null ? null : (f.lastUsed.get(b.worker) ?? null),
    tags: Object.entries(d.tags)
      .filter(([, id]) => id === b.buildId)
      .map(([t]) => t)
      .sort(),
    createdAt: b.createdAt,
    provenance: b.provenance ?? null,
    // The handle a create answered (§4); equal to buildId until the build is built.
    handle: b.handle ?? b.buildId,
    // On failed or rejected: why, and the step or the rule (§4).
    reason: b.reason ?? null,
    ...(full ? { spec: b.spec } : {}),
  };
}

/** One template on the wire (openapi Template): today's three fields first, then its builds. */
function templateBody(d: TemplateDoc, f: ReadinessFacts, full: boolean) {
  const def = resolveBuild(d, {});
  return {
    id: d.id,
    description: d.description,
    tools: def?.spec.tools ?? [],
    owner: d.owner,
    visibility: d.visibility,
    onboarding: d.builds.some((b) => b.status === 'registered')
      ? 'registered'
      : (d.builds[0]?.status ?? null),
    readiness: def ? buildBody(d, def, f, false).readiness : null,
    tags: { ...d.tags },
    builds: d.builds.map((b) => buildBody(d, b, f, full)),
  };
}

/**
 * A sandbox's template reference (§3.2, §4): `id`, `id:tag` or `id@<build id>`, resolved to one
 * registered build and its worker at creation, and kept for the sandbox's life. An unknown id, tag
 * or build, one the caller cannot see, or a build not registered is `400 unknown_template`, as an
 * unknown id always was. A build not attached is not refused here: its first Exec waits on the
 * relay, as before.
 */
async function resolveForUse(
  deps: CpDeps,
  p: TokenClaims,
  ref: string,
): Promise<{ id: string; worker: string; buildId: string }> {
  const at = ref.indexOf('@');
  const colon = at < 0 ? ref.indexOf(':') : -1;
  const id = at >= 0 ? ref.slice(0, at) : colon >= 0 ? ref.slice(0, colon) : ref;
  const r =
    at >= 0 ? { build: ref.slice(at + 1) } : colon >= 0 ? { tag: ref.slice(colon + 1) } : {};
  const d = await catalog(deps).get(id);
  const b = d && canSee(d, p) ? resolveBuild(d, r) : null;
  if (!d || !b || b.status !== 'registered' || !b.worker) {
    throw new CpError('unknown_template', 'no such template (GET /v1/templates lists them)');
  }
  return { id: d.id, worker: b.worker, buildId: b.buildId };
}

/**
 * Create (template lifecycle spec §4, §8.1): self-serve, any enrolled client. Needs the stored
 * catalog and policy (SH_PROVENANCE_DIR); without them the route says so rather than pretending.
 */
function writable(deps: CpDeps): {
  cat: TemplateCatalog & Required<Pick<TemplateCatalog, 'update'>>;
  policy: PolicyStore;
  prov: ProvenanceStore;
} {
  const cat = deps.templates;
  if (!cat?.update || !deps.policy || !deps.provenance) {
    throw new CpError(
      'invalid_request',
      'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
    );
  }
  return {
    cat: cat as TemplateCatalog & Required<Pick<TemplateCatalog, 'update'>>,
    policy: deps.policy,
    prov: deps.provenance,
  };
}

/** The policy store, for the policy routes; absent without SH_PROVENANCE_DIR. */
function policyStore(deps: CpDeps): PolicyStore {
  if (!deps.policy)
    throw new CpError(
      'invalid_request',
      'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
    );
  return deps.policy;
}

/** `b-` and the same 26 random hex characters a sandbox id takes (sandboxId: a UUID's fixed nibbles dropped). */
const buildHandle = (raw: string): string => `b-${sandboxId(raw).slice('sbx-'.length)}`;

/**
 * The quota counters for one subject (§6.2). `templates`: the templates it owns with a build
 * registered or on its way there (a template whose builds all failed, were cancelled or were
 * retired holds no slot, so a failure never locks a subject out). `buildsQueued`: its builds not
 * yet built (queued, building or probing), the host work it has in flight.
 */
async function usage(
  cat: TemplateCatalog,
  subject: string,
): Promise<{ templates: number; buildsQueued: number }> {
  let templates = 0;
  let buildsQueued = 0;
  for (const d of await cat.list()) {
    if (d.owner !== subject) continue;
    if (d.builds.some((b) => REUSABLE.has(b.status))) templates++;
    buildsQueued += d.builds.filter((b) => CANCELLABLE.has(b.status)).length;
  }
  return { templates, buildsQueued };
}

/**
 * One quota check and write at a time per subject (§6.2), per catalog. The catalog serializes
 * per template id only, and the quota counts across every id a subject owns: without this, two
 * creates for different ids would both read the same use and both pass. Taken outside the
 * catalog's id lock, always in that order.
 */
const quotaLocks = new WeakMap<TemplateCatalog, SubjectQueue>();
function quotaLock(cat: TemplateCatalog): SubjectQueue {
  let q = quotaLocks.get(cat);
  if (!q) quotaLocks.set(cat, (q = new SubjectQueue()));
  return q;
}

/**
 * The shared body of both create routes. `existing`: true for POST /v1/templates/{id}/builds (the
 * template must exist and be the caller's), false for POST /v1/templates (a new id, or the
 * caller's own existing one).
 */
async function createBuild(ctx: RequestCtx, deps: CpDeps, existing: boolean) {
  const p = requireEnrolled(ctx, deps);
  const { cat, policy, prov } = writable(deps);
  const b = asRecord(ctx.body);
  const id = existing ? (ctx.params.id ?? '') : typeof b.id === 'string' ? b.id.toLowerCase() : '';
  const spec = asRecord(b.spec);
  let gateRecordBytes: Buffer | undefined;
  if (b.gateRecord !== undefined) {
    if (typeof b.gateRecord !== 'string') {
      throw new CpError(
        'invalid_request',
        'gateRecord must be the gate record file as a string, byte for byte (its sha256 is what is trusted)',
      );
    }
    gateRecordBytes = Buffer.from(b.gateRecord, 'utf8');
  }
  if (b.visibility !== undefined && b.visibility !== 'private' && b.visibility !== 'deployment') {
    throw new CpError('invalid_request', "visibility must be 'private' or 'deployment'");
  }
  const { policy: pol, record: policyRecord } = await policy.current();
  const result = checkCreate(
    {
      id,
      image: typeof b.image === 'string' ? b.image : '',
      spec,
      ...(typeof b.profile === 'string' ? { profile: b.profile } : {}),
      ...(gateRecordBytes ? { gateRecordBytes } : {}),
    },
    pol,
  );
  const stream = `template/${id}`;
  const checkBody = {
    policy: policyRecord,
    profile: result.profile,
    at: 'create',
    outcome: result.passed ? 'admitted' : 'refused',
    results: result.results as unknown as Record<string, unknown>[],
  };
  if (!result.passed) {
    // A refusal is recorded on its template's stream only when the template exists and the caller
    // may write its stream: its own, or (adding a build) any as an admin. A refusal on an id no
    // template holds is only answered: recording it would let any enrolled subject open
    // provenance streams without bound, which no quota counts. A refusal on someone else's id is
    // only answered too, so no subject grows another's stream; and an id the rule refuses has no
    // stream to record on.
    if (TEMPLATE_ID_RE.test(id)) {
      const cur = await cat.get(id);
      if (cur && (cur.owner === p.sub || (existing && isAdmin(p))))
        await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
    }
    const f = result.failed!;
    throw new CpError('policy_refused', f.message ?? f.rule, undefined, { rule: f.rule });
  }
  const now = seconds(deps);
  const handle = buildHandle(deps.newId());
  const quota = pol.quota;
  const built = normalizeSpec(spec);
  const want = reuseKey(b.image as string, built, result.profile, result.gateRecordSha256);
  let reused: TemplateBuild | undefined;
  // The quota is the template's owner's: an admin adding a build to another's template uses the
  // owner's buildsQueued, not its own. The owner's lock is held around the check and the write
  // (quotaLock). A template's owner never changes, so reading it before the lock is safe; a new id
  // another subject takes meanwhile is refused inside, before any quota is read.
  const charged = (await cat.get(id))?.owner ?? p.sub;
  const doc = await quotaLock(cat).run(charged, () =>
    cat.update(id, async (cur) => {
      if (existing && !cur) throw new CpError('template_not_found', 'no such template');
      if (cur && cur.owner !== p.sub && !(existing && isAdmin(p))) {
        // 404 for a private template, 409 for a visible one: never an existence oracle for private.
        throw cur.visibility === 'private' && !isAdmin(p)
          ? new CpError('template_not_found', 'no such template')
          : new CpError('template_exists', `template '${id}' belongs to another subject`);
      }
      // §3.2: the same inputs are the same build. One registered, or still on its way there, is
      // answered instead of a second build (two creates would otherwise queue two builds that
      // register under one manifest hash).
      reused = cur?.builds.find((x) => REUSABLE.has(x.status) && buildReuseKey(x) === want);
      if (reused) return cur!;
      const u = await usage(cat, charged);
      if (!cur && u.templates >= quota.templates) {
        throw new CpError(
          'quota_exceeded',
          `at most ${quota.templates} templates per subject`,
          undefined,
          { quota: 'templates' },
        );
      }
      if (u.buildsQueued >= quota.buildsQueued) {
        throw new CpError(
          'quota_exceeded',
          `at most ${quota.buildsQueued} builds queued per subject`,
          undefined,
          { quota: 'buildsQueued' },
        );
      }
      if (gateRecordBytes) await prov.putBlob(gateRecordBytes);
      const created = await prov.append({
        stream,
        kind: 'create',
        subject: p.sub,
        body: {
          image: b.image as string,
          // A round trip through JSON: what the client sent, as the wire carries it (no undefined),
          // with the guest size under the key the build reads (normalizeSpec).
          spec: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
          profile: result.profile,
          handle,
          ...(result.gateRecordSha256 ? { gate_record_sha256: result.gateRecordSha256 } : {}),
        },
      });
      if (result.gateRecordSha256) {
        await prov.append({
          stream,
          kind: 'gate',
          subject: p.sub,
          body: {
            record_sha256: result.gateRecordSha256,
            // `trusted`: in trustedGateRecords. `client`: any other (a profile that does not require
            // X1). The policy record in force names what the trust was at create, after any change.
            source: result.gateTrusted ? 'trusted' : 'client',
            policy: policyRecord,
          },
        });
      }
      await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
      const build: TemplateBuild = {
        buildId: handle,
        handle,
        status: 'queued',
        profile: result.profile,
        worker: '',
        spec: buildSpec(built),
        createdAt: now,
        provenance: created.digest,
        request: {
          image: b.image as string,
          spec: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
          ...(result.gateRecordSha256 ? { gateRecordSha256: result.gateRecordSha256 } : {}),
        },
      };
      const base: TemplateDoc = cur ?? {
        schema: TEMPLATE_DOC_SCHEMA,
        id,
        owner: p.sub,
        visibility: (b.visibility as 'private' | 'deployment' | undefined) ?? 'deployment',
        description: String(built.description ?? ''),
        tags: {},
        builds: [],
        createdAt: now,
      };
      return { ...base, builds: [build, ...base.builds] };
    }),
  );
  if (reused) {
    await auditBestEffort(deps, 'template_build_reused', id, {
      subject: p.sub,
      decision: 'template_build_reused',
    });
    const done = reused.status === 'registered';
    return {
      status: done ? 200 : 202,
      body: {
        templateId: doc.id,
        buildId: done ? reused.buildId : null,
        build: `/v1/templates/${doc.id}/builds/${done ? reused.buildId : (reused.handle ?? reused.buildId)}`,
        status: reused.status,
        reused: true,
      },
    };
  }
  await auditBestEffort(deps, 'template_build_queued', id, {
    subject: p.sub,
    decision: 'template_build_queued',
  });
  return {
    status: 202,
    body: {
      templateId: doc.id,
      buildId: null,
      build: `/v1/templates/${doc.id}/builds/${handle}`,
      status: 'queued',
    },
  };
}

/** The statuses a build is reused from: registered, or on its way there (§3.2). */
const REUSABLE = new Set<TemplateBuild['status']>([
  'queued',
  'building',
  'probing',
  'built',
  'registered',
]);

/**
 * What makes two creates the same build (§3.2): the image, the spec as sent, the profile and the
 * gate record's sha256. The builder (Moca commit, kernel) is the host's, unknown at create, so it
 * is not part of it: one deployment's hosts build with one builder.
 */
function reuseKey(
  image: string,
  spec: Record<string, unknown>,
  profile: string,
  gateRecordSha256: string | undefined,
): string {
  return canonicalJson({
    image,
    spec: JSON.parse(JSON.stringify(spec)),
    profile,
    gate: gateRecordSha256 ?? null,
  });
}

/** A stored build's reuse key; none for an imported build (it has no request). */
function buildReuseKey(x: TemplateBuild): string | undefined {
  if (!x.request) return undefined;
  return reuseKey(x.request.image, x.request.spec, x.profile, x.request.gateRecordSha256);
}

/** What a build keeps of its spec: the fields a client reads back (§4). */
function buildSpec(spec: Record<string, unknown>): TemplateBuild['spec'] {
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const guest = n(spec.guest_ram_mb); // normalizeSpec has put the alias guest_mb here
  return {
    ...(guest !== undefined ? { guest_mb: guest } : {}),
    ...(n(spec.vcpus) !== undefined ? { vcpus: n(spec.vcpus) } : {}),
    ...(n(spec.workspace_mb) !== undefined ? { workspace_mb: n(spec.workspace_mb) } : {}),
    ...(typeof spec.seed === 'string' ? { seed: spec.seed } : {}),
    tools: Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
  };
}

/** The statuses an owner may cancel (§5.1): not yet built. */
const CANCELLABLE = new Set<TemplateBuild['status']>(['queued', 'building', 'probing']);

/**
 * Cancel (§5.1): the owner (or an admin) withdraws a build not yet built; it becomes `failed`
 * with step `cancelled`, and a `build` record says who cancelled it. A failed build takes no
 * further report from a build host, so it never registers.
 */
async function cancelBuild(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  if (d0.owner !== p.sub && !isAdmin(p))
    throw new CpError('forbidden', "only the template's owner cancels its builds");
  const ref = ctx.params.build ?? '';
  let cancelled: TemplateBuild | undefined;
  await cat.update(d0.id, async (cur) => {
    const x = cur!.builds.find((y) => y.handle === ref || y.buildId === ref);
    if (!x) throw new CpError('template_not_found', 'no such build of this template');
    if (!CANCELLABLE.has(x.status))
      throw new CpError(
        'invalid_request',
        `the build is ${x.status}; only a queued, building or probing build is cancelled`,
      );
    cancelled = {
      ...x,
      status: 'failed',
      reason: { message: `cancelled by ${p.sub}`, step: 'cancelled' },
    };
    return { ...cur!, builds: cur!.builds.map((y) => (y === x ? cancelled! : y)) };
  });
  await prov.append({
    stream: `template/${d0.id}`,
    kind: 'build',
    subject: p.sub,
    body: { handle: cancelled!.handle ?? cancelled!.buildId, outcome: 'cancelled' },
  });
  await auditBestEffort(deps, 'template_build_cancelled', d0.id, {
    subject: p.sub,
    decision: 'template_build_cancelled',
  });
  return {
    status: 200,
    body: { templateId: d0.id, build: cancelled!.handle ?? cancelled!.buildId, status: 'failed' },
  };
}

export const SANDBOX_HANDLERS: Record<string, Handler> = {
  // The template reads (template lifecycle spec §4), on both route profiles (§4.1): on `harness`
  // requireEnrolled admits any logged-in subject. The worker id is deployment plumbing; a client
  // names a template, never a worker.
  listTemplates: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const docs = await visibleTemplates(deps, p);
    const live = await readinessFacts(deps);
    const templates = docs.map((d) => templateBody(d, live, false));
    // Per-host limits and use (§4, §6.2) are reported by a host agent, which a later issue adds:
    // an empty list means "no host reports", never "no limit".
    return { status: 200, body: { templates, hosts: [] } };
  },

  listTemplateTags: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const tags = Object.entries(d.tags)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, buildId]) => {
        const m = d.tagsMeta?.[tag];
        return { tag, buildId, assignedAt: m?.at ?? d.createdAt, assignedBy: m?.by ?? d.owner };
      });
    return { status: 200, body: { tags } };
  },

  getTemplate: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    return { status: 200, body: templateBody(d, await readinessFacts(deps), true) };
  },

  listTemplateBuilds: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const live = await readinessFacts(deps);
    return { status: 200, body: { builds: d.builds.map((b) => buildBody(d, b, live, true)) } };
  },

  getTemplateBuild: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const ref = ctx.params.build ?? '';
    const b = d.builds.find((x) => x.buildId === ref || x.handle === ref);
    if (!b) throw new CpError('template_not_found', 'no such build of this template');
    return { status: 200, body: buildBody(d, b, await readinessFacts(deps), true) };
  },

  // Self-serve create (§4, §8.1), a new build of one's own template, and cancel (§5.1).
  createTemplate: (ctx, deps) => createBuild(ctx, deps, false),
  createTemplateBuild: (ctx, deps) => createBuild(ctx, deps, true),
  cancelTemplateBuild: cancelBuild,

  // The policy (§8): any enrolled client reads it; only an admin sets it, and each set is a
  // `policy` record naming who.
  getPolicy: async (ctx, deps) => {
    requireEnrolled(ctx, deps);
    const { policy, record } = await policyStore(deps).current();
    return { status: 200, body: { policy, digest: policyDigest(policy), record } };
  },

  putPolicy: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    if (!isAdmin(p)) throw new CpError('forbidden', 'setting the policy requires the admin role');
    const store = policyStore(deps);
    const bad = policyProblems(ctx.body);
    if (bad.length) throw new CpError('invalid_request', bad.join('; '));
    const { policy, record } = await store.set(ctx.body as Policy, p.sub);
    await auditBestEffort(deps, 'policy_set', 'policy', { subject: p.sub, decision: 'policy_set' });
    return { status: 200, body: { policy, digest: policyDigest(policy), record } };
  },

  getQuota: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const { cat, policy } = writable(deps);
    const { policy: pol } = await policy.current();
    const u = await usage(cat, p.sub);
    const nowS = seconds(deps);
    // SBX0's live-sandbox cap: shown where it applies, so a client sees it before a create is
    // refused by it.
    let sandboxes: { limit: number; used: number } | undefined;
    if (deps.config.sandbox && deps.sandboxes) {
      const live = (await deps.sandboxes.listByOwner(p.sub, nowS)).filter((r) => isLive(r, nowS));
      sandboxes = { limit: deps.config.sandbox.maxPerSubject, used: live.length };
    }
    return {
      status: 200,
      body: {
        subject: p.sub,
        templates: { limit: pol.quota.templates, used: u.templates },
        buildsQueued: { limit: pol.quota.buildsQueued, used: u.buildsQueued },
        // Activation (§6) is not built yet: nothing holds a template active, so none is used.
        active: { limit: pol.quota.active, used: 0 },
        ...(sandboxes ? { sandboxes } : {}),
      },
    };
  },

  createSandbox: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const { cfg, store } = service(deps);
    const b = asRecord(ctx.body);
    if (typeof b.template !== 'string')
      throw new CpError('invalid_request', 'template is required');
    const template = await resolveForUse(deps, p, b.template);
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME_RE.test(b.name))) {
      throw new CpError('invalid_request', `name must match ${NAME_RE}`);
    }
    const labels = parseLabels(b.labels);
    const now = seconds(deps);
    const id = sandboxId(deps.newId());
    // Create does no I/O to the worker: the first Exec creates the workspace, and wsk being the
    // sandbox's own id is what makes a new sandbox always start empty (spec §5.1).
    const rec: SandboxRecord = {
      id,
      owner: p.sub,
      tenant: p.tenant,
      name: (b.name as string | undefined) ?? '',
      template: template.id,
      worker: template.worker,
      buildId: template.buildId,
      wsk: id,
      labels,
      createdAt: now,
      expiresAt: now + cfg.lifetimeS,
    };
    const outcome = await store.create(
      rec,
      { perSubject: cfg.maxPerSubject, total: cfg.maxTotal, retentionS: cfg.retentionS },
      now,
    );
    if (outcome === 'quota_subject') {
      throw new CpError('quota_exceeded', `at most ${cfg.maxPerSubject} live sandboxes per user`);
    }
    if (outcome === 'quota_total') {
      throw new CpError('quota_exceeded', 'the sandbox service is at capacity');
    }
    if (outcome === 'name_conflict') {
      throw new CpError('name_conflict', `you already have a live sandbox named '${rec.name}'`);
    }
    await audit(deps, p.sub, id, 'sandbox_created');
    await sandboxCreated(deps, rec, p.sub);
    return { status: 201, body: sandboxBody(viewOf(rec, now)) };
  },

  listSandboxes: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const { store } = service(deps);
    // Presence, not value, is what needs the role (RouteSpec.adminOnlyQuery), as with ?owner=.
    const all = ctx.query.get('all');
    if (all !== null && !isAdmin(p))
      throw new CpError('forbidden', '?all= requires the admin role');
    if (all !== null && all !== '1') throw new CpError('invalid_request', "all must be '1'");
    const state = ctx.query.get('state');
    if (state !== null && state !== 'ready' && state !== 'terminated') {
      throw new CpError('invalid_request', "state must be 'ready' or 'terminated'");
    }
    const now = seconds(deps);
    const recs = all ? await store.listAll(now) : await store.listByOwner(p.sub, now);
    const sandboxes = recs
      .map((r) => viewOf(r, now))
      .filter((v) => state === null || v.state === state)
      .map(sandboxBody);
    return { status: 200, body: { sandboxes } };
  },

  getSandbox: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    return { status: 200, body: sandboxBody(viewOf(rec, seconds(deps))) };
  },

  deleteSandbox: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    const { cfg, store } = service(deps);
    const now = seconds(deps);
    const outcome = await store.markDeleted(rec.id, now, cfg.retentionS);
    // Retention ran out between the read and the delete: it is gone, as it would read now.
    if (outcome === 'not_found') throw new CpError('sandbox_not_found', 'no such sandbox');
    if (outcome === 'deleted') {
      await audit(deps, ctx.principal!.sub, rec.id, 'sandbox_deleted');
      await sandboxEnded(deps, rec, ctx.principal!.sub, 'deleted', now);
    }
    // Idempotent: a second delete, or a delete after expiry, reports how it actually ended.
    const ended = viewOf(outcome === 'deleted' ? { ...rec, deletedAt: now } : rec, now);
    return {
      status: 200,
      body: { id: rec.id, state: 'terminated', reason: ended.reason ?? 'deleted' },
    };
  },

  mintSandboxToken: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: false });
    const { cfg } = service(deps);
    const now = seconds(deps);
    const v = viewOf(rec, now);
    // Expiry is computed (spec §5.2): a sandbox past its expiresAt refuses here with no job run.
    if (v.state === 'terminated') {
      const reason = v.reason ?? 'expired';
      const why = reason === 'deleted' ? 'sandbox was deleted' : 'sandbox has expired';
      throw new CpError('sandbox_terminated', why, undefined, { reason });
    }
    const { token, exp } = mintSandboxToken(deps.signer, {
      sub: rec.owner,
      tenant: rec.tenant,
      sbx: rec.id,
      wrk: rec.worker,
      wsk: rec.wsk,
      ttlSeconds: cfg.tokenTtlS,
      notAfter: rec.expiresAt,
      iss: cfg.issuer,
      now,
    });
    return {
      status: 200,
      body: {
        token,
        expiresAt: exp,
        execEndpoint: cfg.execEndpoint,
        wrk: rec.worker,
        wsk: rec.wsk,
        execCa: cfg.execCa ?? null,
      },
    };
  },

  /**
   * The host janitor's read (spec §8.3): every live sandbox, and every terminated one still
   * retained, with only what it needs to find a workspace tree. The router admits only the
   * SH_JANITOR_TOKEN bearer; a handler reached without that mark is a routing bug.
   */
  janitorSandboxes: async (ctx, deps) => {
    if (!ctx.janitorAuthorized) throw new CpError('unauthorized', 'janitor authentication failed');
    const { store } = service(deps);
    const now = seconds(deps);
    const live: { wsk: string; wrk: string }[] = [];
    const terminated: { wsk: string; wrk: string; terminatedAt: number }[] = [];
    const all = await store.listAll(now);
    for (const rec of all) {
      const v = viewOf(rec, now);
      if (v.state === 'ready') live.push({ wsk: v.wsk, wrk: v.worker });
      else terminated.push({ wsk: v.wsk, wrk: v.worker, terminatedAt: v.terminatedAt! });
    }
    await recordExpiries(deps, all, now);
    return { status: 200, body: { live, terminated } };
  },
};
