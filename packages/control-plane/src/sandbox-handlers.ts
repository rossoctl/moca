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
import {
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
import type { TokenClaims } from './token.js';

/**
 * The sandbox resource's handlers (SBX0 spec §5.1), mounted on the `sandbox` route profile only,
 * and the template reads (template lifecycle spec §4), mounted on both.
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
    const b = d.builds.find((x) => x.buildId === (ctx.params.build ?? ''));
    if (!b) throw new CpError('template_not_found', 'no such build of this template');
    return { status: 200, body: buildBody(d, b, await readinessFacts(deps), true) };
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
