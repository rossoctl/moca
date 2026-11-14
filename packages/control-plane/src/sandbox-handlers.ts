import { CpError } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  requireEnrolledPrincipal,
  requireReader,
  seconds,
} from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import {
  buildRecordOf,
  canonicalJson,
  LONE_SURROGATE_RE,
  sha256Hex,
  type AppendInput,
  type ProvenanceStore,
} from './provenance.js';
import { MEMBER_SUBJECT_FORMS, MEMBER_SUBJECT_RE } from './identity.js';
import { isEnrolledForSandbox, MIN_IDLE_TIMEOUT_S, type SandboxConfig } from './sandbox-config.js';
import {
  hostManaged,
  lastLeaseEnd,
  liveLeases,
  place,
  readinessOf,
  readinessReasonOf,
  startQueue,
  startRetryAfterS,
  type HostView,
  type Placement,
  type StartQueue,
} from './activation.js';
import { activationLock } from './activation-lock.js';
import { busyWorkers, freshHosts, hostViewsOf, liveSnapshots } from './host-handlers.js';
import { SubjectQueue } from './subject-document.js';
import {
  checkCreate,
  DEFAULT_GATE_RECORD_SCHEMA,
  normalizeSpec,
  ownedLimit,
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
  isSandboxModeName,
  viewOf,
  type SandboxModeName,
  type SandboxRecord,
  type SandboxStore,
  type SandboxView,
} from './sandbox-store.js';
import { mintSandboxToken, mintSetModeToken } from './sandbox-token.js';
import {
  allLines,
  EGRESS_GRACE_S,
  ENTRY_ID_RE,
  summarize,
  type EgressStore,
} from './egress-log.js';
import type { TokenClaims } from './token.js';

/**
 * The sandbox resource's handlers (SBX0 spec §5.1), mounted on the `sandbox` route profile only,
 * and the template routes (template lifecycle spec §4: reads, self-serve create, cancel, the policy
 * and the quota; §5.1-§5.2: tags, edits and owner transfer; §6.3: activation leases), mounted on
 * both.
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
    mode: v.mode,
    idleTimeoutS: v.idleTimeoutS,
    modeEpoch: v.modeEpoch,
  };
}

/**
 * The mode a body asks for (lease-mode spec §8.1). `per-exec` is always allowed, whatever
 * SH_SANDBOX_MODES_ALLOWED lists, so going back to it is never refused by policy (ruling R7); the
 * list governs the lease modes.
 */
function parseMode(raw: unknown, cfg: SandboxConfig): SandboxModeName {
  if (!isSandboxModeName(raw)) {
    throw new CpError('invalid_request', 'mode must be one of per-exec, lease, lease+processes');
  }
  if (raw !== 'per-exec' && !cfg.modesAllowed.has(raw)) {
    throw new CpError('mode_not_allowed', `mode '${raw}' is not allowed on this deployment`);
  }
  return raw;
}

/** The owner's lease idle timeout: omitted is 0 (the worker's default); given, 30..the ceiling. */
function parseIdleTimeout(raw: unknown, cfg: SandboxConfig): number {
  if (raw === undefined) return 0;
  if (
    !Number.isSafeInteger(raw) ||
    (raw as number) < MIN_IDLE_TIMEOUT_S ||
    (raw as number) > cfg.idleCeilingS
  ) {
    throw new CpError(
      'invalid_request',
      `idleTimeoutS must be an integer from ${MIN_IDLE_TIMEOUT_S} to ${cfg.idleCeilingS}`,
    );
  }
  return raw as number;
}

/**
 * Expiry is computed (spec §5.2): a sandbox past its expiresAt, or deleted, refuses here with no job
 * run. A record past its retention never gets here: the store's get has purged it (404).
 */
function requireLive(rec: SandboxRecord, now: number): void {
  const v = viewOf(rec, now);
  if (v.state === 'terminated') {
    const reason = v.reason ?? 'expired';
    const why = reason === 'deleted' ? 'sandbox was deleted' : 'sandbox has expired';
    throw new CpError('sandbox_terminated', why, undefined, { reason });
  }
}

/**
 * setMode gave undefined: the sandbox was deleted, expired or purged since the caller's read. Answer
 * as a read would now: 409 with the reason while it is retained, 404 once it is gone.
 */
async function refuseGone(store: SandboxStore, id: string, now: number): Promise<never> {
  const fresh = await store.get(id, now);
  if (fresh) requireLive(fresh, now);
  throw new CpError('sandbox_not_found', 'no such sandbox');
}

/**
 * The record as the policy allows it NOW, before a token is minted from it (lease-mode spec §8.1).
 * SH_SANDBOX_MODES_ALLOWED is the switch: create and PUT check it, but a sandbox outlives a policy
 * change, so a mint re-checks it too. A lease mode the policy no longer lists is downgraded to
 * per-exec through the store's atomic setMode, which raises the epoch: the next Exec, carrying the
 * new token, ends the live lease, where a same-epoch re-issue would read to the worker as a retry
 * (spec §8.2). Audited as a `sandbox_mode_changed` with reason `mode_not_allowed`, the policy's
 * change rather than the owner's. The owner's idle timeout is kept: per-exec does not use it.
 *
 * Two mints racing here may both downgrade, raising the epoch twice; each audits what it changed,
 * and both tokens are per-exec. An owner PUT to a mode still allowed, landing between this read and
 * the setMode, is overwritten with per-exec; the owner can PUT it again. Both are accepted rather
 * than closed with a conditional setMode, which the store does not have.
 */
async function underPolicy(
  deps: CpDeps,
  subject: string,
  rec: SandboxRecord,
  now: number,
): Promise<SandboxRecord> {
  const { cfg, store } = service(deps);
  if (rec.mode === 'per-exec' || cfg.modesAllowed.has(rec.mode)) return rec;
  const changed = await store.setMode(rec.id, 'per-exec', rec.idleTimeoutS, now);
  if (!changed) return refuseGone(store, rec.id, now);
  const next = changed.record;
  await auditBestEffort(deps, 'sandbox_mode_changed', rec.id, {
    subject,
    sandboxId: rec.id,
    decision: 'sandbox_mode_changed',
    reason: 'mode_not_allowed',
    fromMode: changed.previousMode,
    toMode: next.mode,
    modeEpoch: next.modeEpoch,
  });
  return next;
}

/**
 * The idle timeout a token carries: the record's, clamped to the ceiling as it is NOW. Lowering
 * SH_SANDBOX_IDLE_CEILING_S changes neither the record nor the epoch: the idle timeout travels on
 * every Exec (ruling R12), so the next token is enough. 0, the worker's default, stays 0.
 */
const idleClaim = (deps: CpDeps, rec: SandboxRecord): number =>
  Math.min(rec.idleTimeoutS, service(deps).cfg.idleCeilingS);

/** A set-mode token for the record's mode and epoch, as they are now (spec §8.2). */
function setModeTokenFor(deps: CpDeps, rec: SandboxRecord, now: number): string {
  return mintSetModeToken(deps.signer, {
    sub: rec.owner,
    sbx: rec.id,
    wrk: rec.worker,
    wsk: rec.wsk,
    mode: rec.mode,
    modeEpoch: rec.modeEpoch,
    idleTimeoutS: idleClaim(deps, rec),
    notAfter: rec.expiresAt,
    iss: service(deps).cfg.issuer,
    now,
  });
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
 * resolved to, that build's manifest hash (null for a build imported from SH_SANDBOX_TEMPLATES,
 * which names no snapshot), and `lease`: the digest of the `activate` record that granted the
 * caller's live lease on the build (§6.3), or null with none (e.g. a deployment without host
 * agents). A no-op without a provenance store.
 */
async function sandboxCreated(
  deps: CpDeps,
  rec: SandboxRecord,
  subject: string,
  lease: string | null,
): Promise<void> {
  if (!deps.provenance) return;
  await deps.provenance.append({
    stream: `template/${rec.template}`,
    kind: 'sandbox',
    subject,
    body: {
      sandboxId: rec.id,
      buildId: rec.buildId ?? null,
      templateManifestHash: rec.buildId?.startsWith('sha256:') ? rec.buildId : null,
      lease,
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
      ...(deps.egress ? { egress: await egressDigest(deps.egress, rec.id) } : {}),
    },
  });
}

/**
 * What a `sandbox` record names of the egress log: its digest, and its completeness
 * with the reasons (`droppedBy`: proxy, cap, budget, invalid).
 */
async function egressDigest(store: EgressStore, id: string) {
  const s = await summarize(store, id);
  return {
    events: s.total,
    sha256: s.sha256,
    dropped: s.dropped,
    droppedBy: s.droppedBy,
    complete: s.complete,
  };
}

/** The egress log's NDJSON export, a store page at a time: each line and its `\n`. */
async function* ndjson(store: EgressStore, id: string): AsyncGenerator<string> {
  let chunk = '';
  let n = 0;
  for await (const line of allLines(store, id)) {
    chunk += `${line}\n`;
    if (++n % EGRESS_STREAM_LINES === 0) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}
const EGRESS_STREAM_LINES = 1000;

/**
 * Seals each ended sandbox's egress log once its grace has passed (egress-log.ts EGRESS_GRACE_S),
 * in the janitor's sweep after recordExpiries. A log that changed after its end record named it
 * (events that arrived in the grace) gets one more `sandbox` record, `state: 'egress'`, naming the
 * final log: the newest `sandbox` record of a sandbox that carries `egress` is its log's digest.
 *
 * The seal comes last, after the record is written: a sweep that fails before it (the chain, the
 * digest or the append) leaves the log unsealed, so the next sweep does the work again. Past the
 * grace the host post takes no events for the sandbox, so the log no longer changes, and the
 * compare with the chain's newest record keeps a repeated sweep from writing a second record.
 */
async function sealEgress(deps: CpDeps, recs: SandboxRecord[], nowS: number): Promise<void> {
  const store = deps.egress;
  const retentionS = deps.config.sandbox?.retentionS ?? 0;
  if (!store) return;
  const due = recs.filter(
    (r) => !isLive(r, nowS) && nowS >= (r.deletedAt ?? r.expiresAt) + EGRESS_GRACE_S,
  );
  const chains = new Map<string, Awaited<ReturnType<ProvenanceStore['chain']>>>();
  for (const r of due) {
    if ((await store.meta(r.id)).sealed) continue;
    if (deps.provenance) {
      const stream = `template/${r.template}`;
      if (!chains.has(stream)) chains.set(stream, await deps.provenance.chain(stream));
      const named = chains
        .get(stream)!
        .filter(
          (x) =>
            x.kind === 'sandbox' &&
            (x.body as { sandboxId?: string }).sandboxId === r.id &&
            (x.body as { egress?: unknown }).egress !== undefined,
        )
        .pop()?.body.egress as { sha256?: string; dropped?: number } | undefined;
      const now = await egressDigest(store, r.id);
      if (!named || named.sha256 !== now.sha256 || named.dropped !== now.dropped) {
        await deps.provenance.append({
          stream,
          kind: 'sandbox',
          subject: 'janitor',
          body: { sandboxId: r.id, buildId: r.buildId ?? null, state: 'egress', egress: now },
        });
      }
    }
    await store.seal(r.id, (r.deletedAt ?? r.expiresAt) + retentionS);
  }
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

/**
 * The trust a build's gate record has NOW (self-attestation): `deployment` when its sha256 is in the
 * current policy's trustedGateRecords, or the build names no gate record; `self` when it was
 * created on a selfAttest profile with a record the policy does not (or no longer) trust, whether
 * or not the record was trusted at create (`selfAttestProfile`; `selfAttested` implies it).
 * Recomputed on every read, never stored, so an admin's promotion or removal needs no rewrite.
 */
export function attestationOf(
  b: TemplateBuild,
  trusted: ReadonlySet<string>,
): 'deployment' | 'self' {
  const g = b.request?.gateRecordSha256;
  const onSelfProfile = b.selfAttestProfile === true || b.selfAttested === true;
  return onSelfProfile && g !== undefined && !trusted.has(g) ? 'self' : 'deployment';
}

/**
 * A template's visibility in effect (self-attestation): `private` whenever any of its registered
 * builds is self-attested now, whatever is stored, so a record whose trust an admin removed narrows
 * its templates on the next read. Otherwise the stored visibility.
 */
export function effectiveVisibility(
  d: TemplateDoc,
  trusted: ReadonlySet<string>,
): 'private' | 'deployment' {
  return d.visibility === 'deployment' &&
    d.builds.some((b) => b.status === 'registered' && attestationOf(b, trusted) === 'self')
    ? 'private'
    : d.visibility;
}

/** The current policy's trusted gate records, or none on a deployment without a policy store. */
async function trustedSet(deps: CpDeps): Promise<ReadonlySet<string>> {
  return new Set(deps.policy ? (await deps.policy.current()).policy.trustedGateRecords : []);
}

const canSee = (d: TemplateDoc, p: TokenClaims, trusted: ReadonlySet<string>): boolean =>
  effectiveVisibility(d, trusted) === 'deployment' || d.owner === p.sub || isAdmin(p);

async function visibleTemplates(deps: CpDeps, p: TokenClaims): Promise<TemplateDoc[]> {
  const trusted = await trustedSet(deps);
  return (await catalog(deps).list()).filter((d) => canSee(d, p, trusted));
}

/** 404 for a template the caller cannot see, as for one that does not exist (no existence oracle). */
async function visibleTemplate(deps: CpDeps, p: TokenClaims, id: string): Promise<TemplateDoc> {
  const d = await catalog(deps).get(id);
  if (!d || !canSee(d, p, await trustedSet(deps)))
    throw new CpError('template_not_found', 'no such template');
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
  /** Where wanted builds are placed (§6.2), when any host agent has reported; else null. */
  placement: Placement | null;
  /**
   * The hosts' start lines (§6.5): placed, wanted builds not attached, per host that reports its
   * startConcurrency; null without placement or presence.
   */
  queue: StartQueue | null;
  /** The hosts as last reported (empty without host agents): a start line's Retry-After reads them. */
  hosts: HostView[];
  /**
   * Every host as last reported, stale ones too, for each build's `heldBy`: it is the snapshot
   * inventory, not placement, and a silent host still holds what it last reported (it is told to
   * stop a retired build once it reports again). Null without host agents.
   */
  holders: HostView[] | null;
  /** Whether a build's snapshot or worker a build that is not retired shares (liveSnapshots). */
  shared: (b: TemplateBuild) => boolean;
  nowS: number;
  /** The current policy's trusted gate records (self-attestation: attestation and visibility in effect). */
  trusted: ReadonlySet<string>;
}

/** The host views, or null on a deployment without host agents (no `heldBy` to report). */
const viewsOrNull = (deps: CpDeps, hosts: HostView[]): HostView[] | null =>
  hosts.length > 0 || deps.config.templateHosts?.length ? hosts : null;

async function readinessFacts(deps: CpDeps, docs?: TemplateDoc[]): Promise<ReadinessFacts> {
  const trusted = await trustedSet(deps);
  const nowS = seconds(deps);
  const hosts = hostViewsOf(deps);
  // The workers with a live sandbox: they drain and keep their slot, and are never graced (§6.5).
  const busy = await busyWorkers(deps, nowS);
  // Every template, not only those the caller sees: sharing is judged across the catalog.
  const all = docs ?? (await catalog(deps).list());
  const shared = liveSnapshots(all);
  const placement = hosts.length > 0 ? place(all, hosts, nowS, busy) : null;
  // Fresh hosts only for placement (HOST_STALE_S); every reported host for `heldBy`.
  const holders = viewsOrNull(
    deps,
    (deps.hosts?.all() ?? []).map(([id, h]) => ({
      id,
      holds: h.holds,
      activeLimit: h.limits.activeLimit,
      running: h.running,
    })),
  );
  let attached: Map<string, number> | null = null;
  if (deps.presence) {
    try {
      attached = new Map((await deps.presence.list()).map((r) => [r.sandboxId, r.capacityMax]));
    } catch {
      // Presence unreadable: readiness is unknown, not inactive (a client must not act on a guess).
      attached = null;
    }
  }
  const queue = placement && attached ? startQueue(all, hosts, placement, attached, nowS) : null;
  if ((deps.config.routeProfile ?? 'harness') === 'harness' || !deps.sandboxes) {
    return {
      attached,
      inUse: null,
      lastUsed: null,
      placement,
      queue,
      hosts,
      holders,
      shared,
      nowS,
      trusted,
    };
  }
  const inUse = new Map<string, number>();
  const lastUsed = new Map<string, number>();
  const now = seconds(deps);
  for (const r of await deps.sandboxes.listAll(now)) {
    if (isLive(r, now)) inUse.set(r.worker, (inUse.get(r.worker) ?? 0) + 1);
    lastUsed.set(r.worker, Math.max(lastUsed.get(r.worker) ?? 0, r.createdAt));
  }
  return { attached, inUse, lastUsed, placement, queue, hosts, holders, shared, nowS, trusted };
}

/**
 * One build on the wire (openapi TemplateBuild), never its worker. Readiness, for a registered
 * build (§3.3, activation.ts readinessOf): from its leases, where it is placed and whether the
 * relay holds its worker's presence record; `unknown` when presence cannot be read; `retired` for
 * a retired build (§5.1); null for any other build that is not registered.
 */
function buildBody(d: TemplateDoc, b: TemplateBuild, f: ReadinessFacts, full: boolean) {
  const shared = b.status === 'retired' && f.shared(b);
  const readiness =
    b.status === 'retired'
      ? 'retired'
      : b.status !== 'registered'
        ? null
        : readinessOf(b, f.nowS, f.placement, f.attached);
  const readinessReason = readinessReasonOf(b, readiness, f.placement);
  // Waiting for a start slot on its host (§6.5): present only on an `activating` build.
  const line = readiness === 'activating' ? f.queue?.byBuild.get(b.buildId) : undefined;
  // In its host's idle grace (§6.5): no lease, its worker kept running until gracedUntil.
  const grace = b.status === 'registered' ? f.placement?.graced.get(b.buildId) : undefined;
  return {
    buildId: b.buildId,
    status: b.status,
    profile: b.profile,
    readiness,
    // Why an `unavailable` build is not placed: present only then.
    ...(readinessReason ? { readinessReason } : {}),
    ...(line ? { queued: line.queued, queuePosition: line.position } : {}),
    ...(grace ? { graced: true, gracedUntil: grace.until } : {}),
    // For an active build; and for a retired one whose worker still holds a presence record (it
    // runs until its host stops it), so a client sees the stop. For a retired build whose
    // presence cannot be read, `running: null`: not known to be stopped, so null capacity means
    // only "read, and not attached". A build retired before it registered has no worker
    // (`worker` empty), so nothing to stop: null capacity, presence read or not. Nor does one
    // whose snapshot or worker a build that is not retired shares (`shared`): its worker is left
    // running for that build, never stopped for the retire.
    capacity:
      readiness === 'active' ||
      (b.status === 'retired' &&
        b.worker !== '' &&
        !shared &&
        (f.attached === null || f.attached.has(b.worker)))
        ? {
            running: f.attached === null ? null : (f.attached.get(b.worker) ?? 0),
            inUse: f.inUse === null ? null : (f.inUse.get(b.worker) ?? 0),
          }
        : null,
    // A retired build whose snapshot or worker a build that is not retired shares: its worker is
    // kept for that build. False for every other build.
    shared,
    lastUsedAt: f.lastUsed === null ? null : (f.lastUsed.get(b.worker) ?? null),
    // The hosts whose last inventory holds this build's snapshot (§6.1), a host silent past
    // HOST_STALE_S too: ids only, no paths, so a client sees which hosts still hold a retired
    // build. Null without host agents.
    heldBy:
      f.holders === null
        ? null
        : f.holders
            .filter((h) => h.holds[b.buildId] !== undefined)
            .map((h) => h.id)
            .sort(),
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
    // Self-attestation: whether its gate record is trusted deployment-wide now, or only by its submitter.
    attestation: attestationOf(b, f.trusted),
    // Its gate's floor checked offline (gate.floor_checked_offline); null with no gate record, and
    // true for a gate record created before the field (whose gates ran offline).
    gateFloorCheckedOffline:
      b.gateFloor?.checkedOffline ?? (b.request?.gateRecordSha256 ? true : null),
    // Only from a network_needed gate: whether its offline run met the floor anyway.
    ...(b.gateFloor?.metOffline !== undefined
      ? { gateFloorMetOffline: b.gateFloor.metOffline }
      : {}),
    ...(full ? { spec: b.spec } : {}),
  };
}

/** One template on the wire (openapi Template): today's three fields first, then its builds. */
function templateBody(d: TemplateDoc, f: ReadinessFacts, full: boolean) {
  const def = resolveBuild(d, {});
  const defBody = def ? buildBody(d, def, f, false) : null;
  return {
    id: d.id,
    description: d.description,
    tools: def?.spec.tools ?? [],
    owner: d.owner,
    // In effect: private while any registered build is self-attested.
    visibility: effectiveVisibility(d, f.trusted),
    // Self-attestation: `self` when any registered build is self-attested now.
    attestation: d.builds.some(
      (b) => b.status === 'registered' && attestationOf(b, f.trusted) === 'self',
    )
      ? 'self'
      : 'deployment',
    onboarding: d.builds.some((b) => b.status === 'registered')
      ? 'registered'
      : (d.builds[0]?.status ?? null),
    readiness: defBody?.readiness ?? null,
    ...(defBody?.readinessReason ? { readinessReason: defBody.readinessReason } : {}),
    tags: { ...d.tags },
    builds: d.builds.map((b) => buildBody(d, b, f, full)),
  };
}

/**
 * A sandbox's template reference (§3.2, §4): `id`, `id:tag` or `id@<build id>`, resolved to one
 * registered build and its worker at creation, and kept for the sandbox's life. An unknown id, tag
 * or build, one the caller cannot see, or a build not registered is `400 unknown_template`, as an
 * unknown id always was; a retired build, or a template whose every build is retired, is `410
 * template_retired` (§5.1). Whether the build is active is requireActive's question (§6.4).
 */
export async function resolveForUse(
  deps: CpDeps,
  p: TokenClaims,
  ref: string,
): Promise<{
  id: string;
  worker: string;
  buildId: string;
  doc: TemplateDoc;
  build: TemplateBuild;
}> {
  const at = ref.indexOf('@');
  const colon = at < 0 ? ref.indexOf(':') : -1;
  const id = at >= 0 ? ref.slice(0, at) : colon >= 0 ? ref.slice(0, colon) : ref;
  const r =
    at >= 0 ? { build: ref.slice(at + 1) } : colon >= 0 ? { tag: ref.slice(colon + 1) } : {};
  const d = await catalog(deps).get(id);
  const seen = d !== null && canSee(d, p, await trustedSet(deps));
  const b = d && seen ? resolveBuild(d, r) : null;
  // A retired build, or a template whose every build is retired, is gone, not unknown (§5.1).
  if (
    d &&
    seen &&
    (b?.status === 'retired' ||
      (!b && d.builds.length > 0 && d.builds.every((x) => x.status === 'retired')))
  ) {
    throw new CpError(
      'template_retired',
      `template '${d.id}'${b ? ` build ${b.buildId}` : ''} is retired`,
    );
  }
  if (!d || !b || b.status !== 'registered' || !b.worker) {
    throw new CpError('unknown_template', 'no such template (GET /v1/templates lists them)');
  }
  return { id: d.id, worker: b.worker, buildId: b.buildId, doc: d, build: b };
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
 * yet built (queued, building or probing), the host work it has in flight. `owned`: the template
 * ids it owns in any status, the catalog documents and provenance streams it holds.
 */
async function usage(
  cat: TemplateCatalog,
  subject: string,
): Promise<{ templates: number; buildsQueued: number; owned: number }> {
  let templates = 0;
  let buildsQueued = 0;
  let owned = 0;
  for (const d of await cat.list()) {
    if (d.owner !== subject) continue;
    owned++;
    if (d.builds.some((b) => REUSABLE.has(b.status))) templates++;
    buildsQueued += d.builds.filter((b) => CANCELLABLE.has(b.status)).length;
  }
  return { templates, buildsQueued, owned };
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

/** Thrown inside a create's write when the template changed owner since it was read. */
const OWNER_MOVED = new Error('the template changed owner');

/**
 * One create at a time per gate record sha256, per catalog, within this process: X1.self.scope's
 * lookup (who already self-attested the record) and the create's write run as one step, so two
 * subjects sending the same untrusted record at once can't both claim it. The catalog serializes
 * its own writes per id the same way, in this process; a deployment runs one control plane.
 */
/** The build statuses that release a self-attested claim (X1.self.scope): ended without a template. */
const CLAIM_RELEASED = new Set<TemplateBuild['status']>(['failed']);

const gateClaimQueues = new WeakMap<TemplateCatalog, SubjectQueue>();
function gateClaimQueue(cat: TemplateCatalog): SubjectQueue {
  let q = gateClaimQueues.get(cat);
  if (!q) gateClaimQueues.set(cat, (q = new SubjectQueue()));
  return q;
}

/**
 * The shared body of both create routes. `existing`: true for POST /v1/templates/{id}/builds (the
 * template must exist and be the caller's), false for POST /v1/templates (a new id, or the
 * caller's own existing one).
 */
async function createBuild(ctx: RequestCtx, deps: CpDeps, existing: boolean) {
  const p = requireEnrolled(ctx, deps);
  const { cat } = writable(deps);
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
  const gateSha = gateRecordBytes ? `sha256:${sha256Hex(gateRecordBytes)}` : undefined;
  const admit = () => admitBuild(deps, existing, p, b, id, spec, gateRecordBytes, gateSha);
  return gateSha ? gateClaimQueue(cat).run(gateSha, admit) : admit();
}

/** createBuild's checks and write, under the gate record's claim queue when it sends one. */
async function admitBuild(
  deps: CpDeps,
  existing: boolean,
  p: TokenClaims,
  b: Record<string, unknown>,
  id: string,
  spec: Record<string, unknown>,
  gateRecordBytes: Buffer | undefined,
  gateSha: string | undefined,
) {
  const { cat, policy, prov } = writable(deps);
  const { policy: pol, record: policyRecord } = await policy.current();
  // Self-attestation: the subject a self-attested record counts for is the template's owner (the
  // gate record's `scope` and X1.self.scope's key alike). An admin adding a build to another
  // subject's template attests for that owner; an imported template (owner null) has none, so a
  // self-attested record is refused there (X1.trusted).
  const prior = existing && isAdmin(p) ? await cat.get(id) : null;
  const attester = prior && prior.owner !== p.sub ? prior.owner : p.sub;
  // Who already self-attested this record (keyed by subject and sha256), from the catalog: a build
  // self-attested at create (selfAttested) names its record's sha256, and its template the owner it
  // counts for. A claim is made by an admitted self-attested create and held while its build is
  // queued, building, probing, built, registered, rejected or retired (a real use, or an admin's
  // decision). It is released when the build ends `failed`, which never admitted a template, so no
  // one holds a published record with a build that fails. A refused create claims nothing.
  const gateSelfSubmitters =
    gateSha && !pol.trustedGateRecords.includes(gateSha)
      ? [
          ...new Set(
            (await cat.list())
              .filter(
                (d) =>
                  d.owner !== null &&
                  d.builds.some(
                    (x) =>
                      x.selfAttested === true &&
                      x.request?.gateRecordSha256 === gateSha &&
                      !CLAIM_RELEASED.has(x.status),
                  ),
              )
              .map((d) => d.owner as string),
          ),
        ]
      : [];
  const result = checkCreate(
    {
      id,
      image: typeof b.image === 'string' ? b.image : '',
      spec,
      ...(typeof b.profile === 'string' ? { profile: b.profile } : {}),
      ...(gateRecordBytes ? { gateRecordBytes } : {}),
      ...(attester ? { subject: attester } : {}),
      gateSelfSubmitters,
    },
    pol,
    deps.config.sandbox?.gateRecordSchema
      ? { gateRecordSchema: deps.config.sandbox.gateRecordSchema }
      : {},
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
    // template holds writes one audit line instead (the capped audit stream), naming the subject,
    // the id and the failed rules: a provenance record would let any enrolled subject open
    // streams without bound, which no quota counts. A refusal on someone else's id is only
    // answered, so no subject grows another's stream; and an id the rule refuses has no stream
    // to record on.
    if (TEMPLATE_ID_RE.test(id)) {
      const cur = await cat.get(id);
      if (cur && (cur.owner === p.sub || (existing && isAdmin(p))))
        await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
      else if (!cur)
        await auditBestEffort(deps, 'template_create_refused', id, {
          subject: p.sub,
          templateId: id,
          decision: 'template_create_refused',
          reason: 'policy_refused',
          rules: result.results
            .filter((r) => !r.passed)
            .map((r) => r.rule)
            .join(','),
        });
    }
    const f = result.failed!;
    throw new CpError('policy_refused', f.message ?? f.rule, undefined, { rule: f.rule });
  }
  // A self-attested create never makes its template deployment-visible.
  const selfAttestedCreate =
    result.gateTrust === 'self' && pol.profiles[result.profile]?.selfAttest === true;
  if (selfAttestedCreate && b.visibility === 'deployment')
    throw new CpError(
      'self_attested',
      'a self-attested template is private until an admin trusts its gate record (trustedGateRecords)',
    );
  const now = seconds(deps);
  const handle = buildHandle(deps.newId());
  const quota = pol.quota;
  const built = normalizeSpec(spec);
  const want = reuseKey(b.image as string, built, result.profile, result.gateRecordSha256);
  let reused: TemplateBuild | undefined;
  // The quota is the template's owner's: an admin adding a build to another's template uses the
  // owner's buildsQueued, not its own. The owner's lock is held around the check and the write
  // (quotaLock); a new id another subject takes meanwhile is refused inside, before any quota is
  // read. The owner is read before the lock, and an admin's transfer (PUT …/owner) can move it in
  // between: the write sees another owner, writes nothing, and the step runs again under the new
  // owner's lock.
  let doc: TemplateDoc | undefined;
  for (let attempt = 1; !doc; attempt++) {
    const charged = (await cat.get(id))?.owner ?? p.sub;
    try {
      doc = await quotaLock(cat).run(charged, () =>
        cat.update(id, async (cur) => {
          if (existing && !cur) throw new CpError('template_not_found', 'no such template');
          if (cur && cur.owner !== p.sub && !(existing && isAdmin(p))) {
            // 404 for a private template, 409 for a visible one: never an existence oracle for
            // private.
            throw cur.visibility === 'private' && !isAdmin(p)
              ? new CpError('template_not_found', 'no such template')
              : new CpError('template_exists', `template '${id}' belongs to another subject`);
          }
          // The owner charged is the one read before the lock; a transfer meanwhile runs it again.
          if ((cur?.owner ?? p.sub) !== charged) throw OWNER_MOVED;
          // A self-attested build on a template others can see would reach them on its owner's own
          // gate (self-attestation): refused; the template must be private, or an admin trusts the
          // record.
          if (selfAttestedCreate && cur && cur.visibility === 'deployment')
            throw new CpError(
              'self_attested',
              `template '${id}' is deployment-visible: it must be private before a self-attested build is added`,
            );
          // The record was checked as attested for `attester`; the template's owner must still be
          // it (an admin's transfer meanwhile refuses the create, to be sent again).
          if (selfAttestedCreate && (cur ? cur.owner : p.sub) !== attester)
            throw new CpError(
              'self_attested',
              `template '${id}' changed owner during the create; send it again`,
            );
          // §3.2: the same inputs are the same build. One registered, or still on its way there,
          // is answered instead of a second build (two creates would otherwise queue two builds
          // that register under one manifest hash).
          reused = cur?.builds.find((x) => REUSABLE.has(x.status) && buildReuseKey(x) === want);
          if (reused) return cur!;
          const u = await usage(cat, charged);
          // A template takes a slot when it holds none yet: a new id, or one whose builds all
          // failed, were cancelled or were retired (usage does not count it). Checking only new
          // ids would let a subject bring such templates back past the quota.
          const holdsSlot = cur?.builds.some((x) => REUSABLE.has(x.status)) ?? false;
          if (!holdsSlot && u.templates >= quota.templates) {
            throw new CpError(
              'quota_exceeded',
              `at most ${quota.templates} templates per subject`,
              undefined,
              { quota: 'templates' },
            );
          }
          // A new id is one more document and stream for good: a create-then-cancel loop frees
          // its templates and buildsQueued slots, never this one.
          if (!cur && u.owned >= ownedLimit(quota)) {
            throw new CpError(
              'quota_exceeded',
              `at most ${ownedLimit(quota)} template ids owned per subject, in any status`,
              undefined,
              { quota: 'owned' },
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
              // A round trip through JSON: what the client sent, as the wire carries it (no
              // undefined), with the guest size under the key the build reads (normalizeSpec).
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
                // `trusted`: in trustedGateRecords. `self` (self-attestation): trusted only for the
                // template owner's templates, on a selfAttest profile, which `scope` names (the
                // submitter, or the owner an admin added the build for). `client`: any other (a profile
                // that does not require X1). The policy record in force names what the trust was at
                // create, after any later change.
                source:
                  result.gateTrust === 'trusted'
                    ? 'trusted'
                    : selfAttestedCreate
                      ? 'self'
                      : 'client',
                ...(selfAttestedCreate ? { scope: attester } : {}),
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
            queuedAtMs: deps.now(),
            provenance: created.digest,
            request: {
              image: b.image as string,
              spec: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
              ...(result.gateRecordSha256 ? { gateRecordSha256: result.gateRecordSha256 } : {}),
            },
            ...(selfAttestedCreate ? { selfAttested: true } : {}),
            // On a selfAttest profile, the record's trust is the policy's at each read, not at create.
            ...(result.gateRecordSha256 && pol.profiles[result.profile]?.selfAttest === true
              ? { selfAttestProfile: true }
              : {}),
            ...(result.gateFloor ? { gateFloor: result.gateFloor } : {}),
          };
          const base: TemplateDoc = cur ?? {
            schema: TEMPLATE_DOC_SCHEMA,
            id,
            owner: p.sub,
            visibility: selfAttestedCreate
              ? 'private'
              : ((b.visibility as 'private' | 'deployment' | undefined) ?? 'deployment'),
            description: String(built.description ?? ''),
            tags: {},
            builds: [],
            createdAt: now,
          };
          return { ...base, builds: [build, ...base.builds] };
        }),
      );
    } catch (err) {
      if (err !== OWNER_MOVED) throw err;
      if (attempt >= 3)
        throw new CpError('internal_error', "the template's owner kept changing; retry the create");
    }
  }
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

/**
 * A change's records (§7.1), appended inside the catalog's write, as create does: the write
 * happens only after they are on the chain, so a change is never stored without its record. Every
 * body is checked as canonical JSON before the first append, so a body the chain refuses refuses
 * the change and writes nothing. A failed write after the appends leaves records of a change not
 * stored, which a reader sees against the catalog; never the reverse. Returns their digests.
 */
async function appendRecords(prov: ProvenanceStore, inputs: AppendInput[]): Promise<string[]> {
  for (const x of inputs) canonicalJson(x.body);
  const digests: string[] = [];
  for (const x of inputs) digests.push((await prov.append(x)).digest);
  return digests;
}

/** The statuses an owner may cancel (§5.1): not yet built. */
const CANCELLABLE = new Set<TemplateBuild['status']>(['queued', 'building', 'probing']);

/**
 * Cancel (§5.1): the owner (or an admin) withdraws a build not yet built; it becomes `failed`
 * with step `cancelled`, and a `build` record says who cancelled it. A failed build takes no
 * further report from a build host, so it never registers.
 */
async function cancelBuild(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'cancels its builds');
  const ref = ctx.params.build ?? '';
  let cancelled: TemplateBuild | undefined;
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    const x = cur.builds.find((y) => y.handle === ref || y.buildId === ref);
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
    await appendRecords(prov, [
      {
        stream: `template/${d0.id}`,
        kind: 'build',
        subject: p.sub,
        body: { handle: cancelled.handle ?? cancelled.buildId, outcome: 'cancelled' },
      },
    ]);
    return { ...cur, builds: cur.builds.map((y) => (y === x ? cancelled! : y)) };
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

/**
 * Per host: its limits, its use (the workers placement counts on it: placed, running, draining) and
 * its disk (§4, §6.2), as its agent last reported them, and, from an agent that reports it, its
 * memory: the figures, the effective floor, the use and headroom placement counts, and the brake
 * (pressure or a stale inventory) that stops new starts; from an agent that reports them, its start
 * limit, measured start time and start line, and its idle grace with the builds in it (§6.5, apart
 * from `used`). Empty when no host has reported, never meaning "no limit"; a host silent for over
 * HOST_STALE_S is left out, as placement leaves it out.
 */
function hostsBlock(deps: CpDeps, f: ReadinessFacts) {
  const used = f.placement?.used ?? new Map<string, number>();
  const graced = new Map<string, number>();
  for (const g of f.placement?.graced.values() ?? [])
    graced.set(g.host, (graced.get(g.host) ?? 0) + 1);
  return freshHosts(deps).map(([id, h]) => {
    const q = f.queue?.byHost.get(id);
    const start = h.start
      ? {
          concurrency: h.start.concurrency,
          seconds: h.start.seconds ?? null,
          starting: q?.starting ?? null,
          queued: q?.queued ?? null,
        }
      : undefined;
    const m = h.memory;
    const u = f.placement?.memory.get(id);
    const memory =
      m && m.totalMib !== undefined && u
        ? {
            totalMib: m.totalMib,
            availableMib: m.availableMib!,
            floorMib: m.floorMib!,
            usedMib: u.usedMib,
            headroomMib: u.headroomMib,
            pressureFull10: m.pressureFull10 ?? null,
            pressureLimit: m.pressureLimit ?? null,
            brake: u.brake,
            runningWorkers: (m.running ?? []).length,
            memfileMismatch: [...(m.memfileMismatch ?? [])].sort(),
            reportedAt: h.at,
          }
        : undefined;
    return {
      id,
      active: { limit: h.limits.activeLimit, used: used.get(id) ?? 0 },
      idleLimitSeconds: h.limits.idleLimitSeconds,
      disk: { freeGb: h.limits.diskFreeGb, floorGb: h.limits.diskFloorGb },
      ...(memory ? { memory } : {}),
      ...(start ? { start } : {}),
      // Its idle grace and the builds in it now, only from an agent that sets one.
      ...(h.idleGraceSeconds
        ? { idleGraceSeconds: h.idleGraceSeconds, graced: graced.get(id) ?? 0 }
        : {}),
    };
  });
}

/** The builds `subject` holds a live lease on (§6.3): what the `active` quota counts. */
const leasedBy = (docs: TemplateDoc[], subject: string, nowS: number): TemplateBuild[] =>
  docs
    .flatMap((d) => d.builds)
    .filter((x) => liveLeases(x, nowS).some((l) => l.subject === subject));

/**
 * Activate (§6.3): take or renew this subject's lease on a registered build, by `tag` (default
 * `default`) or `build`, `leaseSeconds` long (default the largest idle limit of the hosts that hold it, clamped
 * to 60-86400, else 3600; at most a day per grant, renewals unlimited). Refused with template_unavailable when no
 * registered build or no host holds it, no_active_slot (Retry-After) when every holder is full,
 * quota_exceeded over the subject's active quota; on a refusal no lease is kept.
 */
async function activate(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const b = asRecord(ctx.body);
  const ref =
    typeof b.build === 'string'
      ? { build: b.build }
      : { tag: typeof b.tag === 'string' ? b.tag : 'default' };
  const target = resolveBuild(d0, ref);
  if (target?.status === 'retired')
    throw new CpError('template_retired', `template '${d0.id}' build ${target.buildId} is retired`);
  if (!target || target.status !== 'registered') {
    throw new CpError(
      'template_unavailable',
      'no registered build of this template under that reference',
      undefined,
      { readiness: 'unavailable' },
    );
  }
  if (!hostManaged(target)) throw deploymentRun(d0.id);
  const r = await takeLease(deps, p, d0, target, b.leaseSeconds, 'owner');
  return {
    status: 200,
    body: { templateId: d0.id, buildId: target.buildId, leaseUntil: r.until, host: r.host },
  };
}

/**
 * The refusal of a lease on a build no host can hold (activation.ts hostManaged): one imported from
 * SH_SANDBOX_TEMPLATES, whose worker the deployment runs. It needs no activation: a sandbox is
 * created on it whenever its worker is attached, as on a deployment without host agents.
 */
const deploymentRun = (id: string) =>
  new CpError(
    'invalid_request',
    `template '${id}' is run by the deployment (SH_SANDBOX_TEMPLATES); it takes no activation lease`,
  );

/**
 * Takes or renews `p`'s lease on `target` (§6.3) and records it, or refuses with no lease kept:
 * template_unavailable, no_active_slot (Retry-After), quota_exceeded. Shared by activate and by
 * activation on first use (§6.4); `reason` is the record's (§7.1). Runs under activationLock.
 */
async function takeLease(
  deps: CpDeps,
  p: TokenClaims,
  d0: TemplateDoc,
  target: TemplateBuild,
  leaseSeconds: unknown,
  reason: 'owner' | 'first_use',
): Promise<{ until: number; host: string | null }> {
  if (!hostManaged(target)) throw deploymentRun(d0.id);
  const { cat } = writable(deps);
  return activationLock(cat).run('activation', () =>
    takeLeaseLocked(deps, p, d0, target, leaseSeconds, reason),
  );
}

/** takeLease's body: run only under activationLock. */
async function takeLeaseLocked(
  deps: CpDeps,
  p: TokenClaims,
  d0: TemplateDoc,
  target: TemplateBuild,
  leaseSeconds: unknown,
  reason: 'owner' | 'first_use',
): Promise<{ until: number; host: string | null }> {
  const { cat, policy, prov } = writable(deps);
  const nowS = seconds(deps);
  const DAY = 86_400;
  const hosts = hostViewsOf(deps);
  // An explicit leaseSeconds is the client's, range-checked. The default is the largest idle limit
  // of the hosts that hold this build (3600 when none reports one), clamped into the range: a
  // host's SBX_IDLE_LIMIT_S outside it never refuses a request that named no lease.
  let want: number;
  if (leaseSeconds !== undefined && leaseSeconds !== null) {
    if (
      typeof leaseSeconds !== 'number' ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 60 ||
      leaseSeconds > DAY
    ) {
      throw new CpError('invalid_request', 'leaseSeconds must be 60-86400 (renew to hold longer)');
    }
    want = leaseSeconds;
  } else {
    const idle = hosts
      .filter((h) => h.holds[target.buildId] !== undefined)
      .map((h) => deps.hosts!.get(h.id)!.limits.idleLimitSeconds);
    want = Math.min(DAY, Math.max(60, Math.max(0, ...idle) || 3600));
  }
  const { policy: pol } = await policy.current();
  const docs = await cat.list();
  // `target` was resolved before the lock; a retire takes the lock too, so this read is current. A
  // build retired since is refused here, so no lease (none counting against the quota) is written
  // onto it.
  const fresh = docs.find((d) => d.id === d0.id)?.builds.find((x) => x.buildId === target.buildId);
  if (fresh?.status === 'retired')
    throw new CpError('template_retired', `template '${d0.id}' build ${target.buildId} is retired`);
  if (fresh?.status !== 'registered')
    throw new CpError('template_unavailable', 'this build is no longer registered', undefined, {
      readiness: 'unavailable',
    });
  // A renewal does not count against itself.
  const held = leasedBy(docs, p.sub, nowS).filter((x) => x.buildId !== target.buildId);
  if (held.length >= pol.quota.active) {
    throw new CpError(
      'quota_exceeded',
      `at most ${pol.quota.active} active templates per subject`,
      undefined,
      { quota: 'active' },
    );
  }
  const withLease = (x: TemplateBuild, record?: string): TemplateBuild => {
    const others = (x.leases ?? []).filter((l) => l.subject !== p.sub && l.until > nowS);
    const mine = (x.leases ?? []).find((l) => l.subject === p.sub && l.until > nowS);
    return {
      ...x,
      leases: [
        ...others,
        {
          subject: p.sub,
          until: nowS + want,
          since: mine?.since ?? nowS,
          ...(record ? { record } : {}),
        },
      ],
    };
  };
  // Would it be placed? Judge with this lease added, before keeping it.
  const trial = docs.map((d) =>
    d.id !== d0.id
      ? d
      : { ...d, builds: d.builds.map((x) => (x.buildId === target.buildId ? withLease(x) : x)) },
  );
  // A graced worker gives its slot up to this lease (it is not `placed`, so never "displaced"
  // below); the workers with a live sandbox drain, keep their slot, and are never graced.
  const busy = await busyWorkers(deps, nowS);
  const pl = place(trial, hosts, nowS, busy);
  // A held build is never evicted to make room (§6.3): placement breaks a tie of equal `since` (whole
  // seconds) by buildId, so a lease taken in the same second as a placed one could otherwise sort
  // ahead of it and push it off its host. Such a lease waits, as one that does not fit.
  const before = place(docs, hosts, nowS, busy);
  const displaced = [...before.placed.keys()].find(
    (x) => x !== target.buildId && !pl.placed.has(x),
  );
  const displaces = displaced !== undefined;
  // Displacing, the refusal's reason is the displaced build's: what would push it off.
  const why =
    displaced !== undefined ? pl.unplaced.get(displaced) : pl.unplaced.get(target.buildId);
  if (hosts.length > 0 && why === 'not_held') {
    throw new CpError('template_unavailable', "no host holds this build's snapshot", undefined, {
      readiness: 'unavailable',
    });
  }
  // Every holder reports this build's memory file wrong: no wait clears it, a rebuild does.
  if (!displaces && why === 'memfile_mismatch') {
    throw new CpError(
      'template_unavailable',
      "every host holding this build reports its memory file is not the guest's size",
      undefined,
      { readiness: 'unavailable', reason: 'memfile_mismatch' },
    );
  }
  if (why === 'no_slot' || why === 'memory' || displaces) {
    // Retry-After: the soonest a slot (or the memory) on one of this build's holders can free, that
    // is the soonest another build placed on one of them loses its last live lease. Other hosts'
    // builds, and other subjects' leases on a build that stays leased, free nothing here. 60 s when
    // no leased build holds those slots (draining workers, whose end no lease tells).
    const holders = new Set(
      hosts.filter((h) => h.holds[target.buildId] !== undefined).map((h) => h.id),
    );
    const free = Math.min(
      ...trial
        .flatMap((d) => d.builds)
        .filter((x) => x.buildId !== target.buildId && holders.has(pl.placed.get(x.buildId) ?? ''))
        .map((x) => Math.max(...liveLeases(x, nowS).map((l) => l.until)) - nowS),
    );
    // A memory refusal says so; one at the active limit answers exactly as before.
    throw new CpError(
      'no_active_slot',
      why === 'memory'
        ? 'no host holding this build has the memory for its worker now (memory-aware placement)'
        : 'every host holding this build is at its active limit with leased builds',
      undefined,
      why === 'memory'
        ? { readiness: 'unavailable', reason: 'memory' }
        : { readiness: 'unavailable' },
      Number.isFinite(free) ? Math.max(1, free) : 60,
    );
  }
  // The record first, so the lease can name it (a sandbox under this lease cites it, §7.1), and no
  // lease is ever stored without its record.
  const host = pl.placed.get(target.buildId) ?? null;
  const rec = await prov.append({
    stream: `template/${d0.id}`,
    kind: 'activate',
    subject: p.sub,
    body: {
      buildId: target.buildId,
      leaseSeconds: want,
      until: nowS + want,
      ...(host ? { host } : {}),
      ...(reason === 'first_use' ? { reason } : {}),
    },
  });
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => (x.buildId === target.buildId ? withLease(x, rec.digest) : x)),
  }));
  return { until: nowS + want, host };
}

/**
 * Deactivate (§6.3): drop this subject's leases on the template's builds (an admin with
 * `all: true`, everyone's); a build stays wanted while another subject's lease stands. A drop is
 * a `deactivate` record; one that drops nothing writes none. When none is left, the time is kept
 * as the build's lastLeaseEnd, from which a host's idle grace runs (§6.5). `stopNow: true` skips
 * that grace: a build left with no lease is stopped at the next wanted answer (forced cold), and
 * the `deactivate` record says `stopNow: true`.
 */
async function deactivate(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const b = asRecord(ctx.body);
  if (b.stopNow !== undefined && typeof b.stopNow !== 'boolean')
    throw new CpError('invalid_request', 'stopNow must be a boolean');
  const stopNow = b.stopNow === true;
  const nowS = seconds(deps);
  const all = isAdmin(p) && b.all === true;
  let dropped = 0;
  // Builds whose idle grace this stopNow ends: unleased, with a lease end it had not covered yet.
  let ended = 0;
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => {
      const live = (x.leases ?? []).filter((l) => l.until > nowS);
      const keep = live.filter((l) => !(all || l.subject === p.sub));
      dropped += live.length - keep.length;
      // The end of its last lease: now when this drop leaves none, else what the expired leases
      // this write clears said (lastLeaseEnd reads them before they go).
      const prior = lastLeaseEnd(x, nowS);
      const end = keep.length === 0 && live.length > 0 ? nowS : prior;
      const out: TemplateBuild = {
        ...x,
        leases: keep,
        ...(end !== undefined ? { lastLeaseEnd: end } : {}),
      };
      if (stopNow && keep.length === 0 && x.status === 'registered' && end !== undefined) {
        if (x.stopNowAt === undefined || end > x.stopNowAt) ended += 1;
        out.stopNowAt = nowS;
      }
      return out;
    }),
  }));
  if (dropped > 0 || ended > 0) {
    await prov.append({
      stream: `template/${d0.id}`,
      kind: 'deactivate',
      subject: p.sub,
      body: { leases: dropped, all, ...(stopNow ? { stopNow: true } : {}) },
    });
  }
  return { status: 200, body: { templateId: d0.id, released: dropped } };
}

/**
 * Why each build is in use now (§5.1): a live sandbox runs on it. A retire is refused while any
 * build it names is in use, so it never cuts off running work. A sandbox names the build it
 * resolved to (`buildId`), so it counts for that build only: two builds of one template from one
 * image can share a worker id, and a sandbox on one must not block retiring the other. A record
 * from before builds were traced (no `buildId`) counts for every build on its worker. Sessions
 * pinned to a build, once sessions are, are live use too, and are to be checked here.
 */
async function buildsInUse(
  deps: CpDeps,
  builds: TemplateBuild[],
  nowS: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!deps.sandboxes) return out;
  const busyBuilds = new Set<string>();
  const legacyWorkers = new Set<string>();
  for (const r of await deps.sandboxes.listAll(nowS)) {
    if (!isLive(r, nowS)) continue;
    if (r.buildId) busyBuilds.add(r.buildId);
    else legacyWorkers.add(r.worker);
  }
  for (const x of builds) {
    if (busyBuilds.has(x.buildId) || (x.worker !== '' && legacyWorkers.has(x.worker)))
      out.set(x.buildId, 'still serves a live sandbox');
  }
  return out;
}

/** One build a retire answered for (openapi RetiredBuild). */
interface RetiredBuild {
  build: string;
  buildId: string | null;
  readiness: 'retired';
  record: string | null;
}

/**
 * Retire (§5.1): the owner, or an admin, retires a whole template (every build not yet retired) or
 * one build. A retired build is never used again (a sandbox or an activation naming it answers
 * `410 template_retired`) and its leases go, so it is no longer wanted: a host holding it is told
 * to stop its worker (`GET /v1/hosts/{host}/wanted` `stop`). Refused while a live sandbox runs on
 * a build it names (`409 build_in_use`). Its records stay, and each build retired writes a
 * `retire` record naming the caller, the status before (`from`) and the build's `build` record
 * (`buildRecord`). Idempotent: an already retired build is answered with `record: null`.
 */
async function retireBuilds(
  ctx: RequestCtx,
  deps: CpDeps,
  which: (b: TemplateBuild) => boolean,
): Promise<{ templateId: string; subject: string; builds: RetiredBuild[] }> {
  // The owner's check is made on the template as read and again under its lock (ownerCheck), so a
  // retire by an owner it was transferred away from meanwhile is refused.
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'retires it');
  const reason = asRecord(ctx.body).reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1024))
    throw new CpError('invalid_request', 'reason must be a string of at most 1024 characters');
  const done: TemplateBuild[] = [];
  const records = new Map<string, string>();
  // Under the activation lock, so an activation never writes a lease onto a build retired after
  // it resolved the build: it re-reads the build's status under the same lock (takeLeaseLocked).
  await activationLock(cat).run('activation', async () => {
    // The template is read again under the lock: the request's read (d0) may be older than a
    // build registered, or a sandbox created on one, since. Read before the catalog update, so no
    // sandbox-store lookup runs inside it.
    const d1 = (await cat.get(d0.id)) ?? d0;
    const inUse = await buildsInUse(deps, d1.builds.filter(which), seconds(deps));
    await cat.update(d0.id, async (c) => {
      const cur = own(c);
      done.length = 0;
      records.clear();
      const targets = cur.builds.filter(which);
      if (targets.length === 0)
        throw new CpError('template_not_found', 'no such build of this template');
      const busy = targets.find((x) => x.status !== 'retired' && inUse.has(x.buildId));
      if (busy)
        throw new CpError(
          'build_in_use',
          `build ${busy.handle ?? busy.buildId} ${inUse.get(busy.buildId)}: delete it, then retire`,
        );
      done.push(...targets.filter((x) => x.status !== 'retired'));
      // Each `retire` record is written inside the update, as a host's build report writes its
      // own: a record that cannot be written leaves the build as it was, so a retry retires it
      // with its record, and no build is retired without one.
      for (const x of done) {
        const rec = await prov.append({
          stream: `template/${d0.id}`,
          kind: 'retire',
          subject: p.sub,
          body: {
            build: x.handle ?? x.buildId,
            ...(x.status === 'registered' ? { buildId: x.buildId } : {}),
            buildRecord: await buildRecordOf(prov, d0.id, x),
            from: x.status,
            ...(typeof reason === 'string' ? { reason } : {}),
          },
        });
        records.set(x.handle ?? x.buildId, rec.digest);
      }
      return {
        ...cur,
        builds: cur.builds.map((x) =>
          done.includes(x) ? { ...x, status: 'retired' as const, leases: [] } : x,
        ),
      };
    });
  });
  if (done.length > 0)
    await auditBestEffort(deps, 'template_retired', d0.id, {
      subject: p.sub,
      decision: 'template_retired',
    });
  // Each build, its id, its readiness and the record written now (null for one already retired),
  // so a client can tie the answer to the template's chain.
  const after = (await cat.get(d0.id))!;
  return {
    templateId: d0.id,
    subject: p.sub,
    builds: after.builds
      .filter((x) => x.status === 'retired' && which(x))
      .map((x) => ({
        build: x.handle ?? x.buildId,
        // A build retired before it registered has only its handle.
        buildId: x.buildId.startsWith('b-') ? null : x.buildId,
        readiness: 'retired' as const,
        record: records.get(x.handle ?? x.buildId) ?? null,
      })),
  };
}

/** POST /v1/templates/{id}/retire (§5.1): every build of the template not yet retired. */
async function retireTemplate(ctx: RequestCtx, deps: CpDeps) {
  const r = await retireBuilds(ctx, deps, () => true);
  return { status: 200, body: { ...r, status: 'retired' } };
}

/** DELETE /v1/templates/{id}/builds/{build} (§5.1): one build, by its build id or handle. */
async function retireTemplateBuild(ctx: RequestCtx, deps: CpDeps) {
  const ref = ctx.params.build ?? '';
  const r = await retireBuilds(ctx, deps, (x) => x.handle === ref || x.buildId === ref);
  return {
    status: 200,
    body: { templateId: r.templateId, subject: r.subject, ...r.builds[0], status: 'retired' },
  };
}

/**
 * A sandbox record's write (§5.1), run under the activation lock after re-reading its build's
 * status. A retire judges use and retires under the same lock, so a create racing it either writes
 * first, and the retire sees its sandbox and is refused `409 build_in_use`, or finds the build
 * retired, and is refused `410 template_retired` with no record written. Without a template store
 * nothing can be retired, so no lock is taken.
 */
async function notRetired<T>(
  deps: CpDeps,
  t: { id: string; buildId: string },
  write: () => Promise<T>,
): Promise<T> {
  const cat = deps.templates;
  if (!cat?.update || !deps.provenance) return write();
  return activationLock(cat).run('activation', async () => {
    const cur = (await cat.get(t.id))?.builds.find((x) => x.buildId === t.buildId);
    if (cur?.status === 'retired')
      throw new CpError('template_retired', `template '${t.id}' build ${t.buildId} is retired`);
    return write();
  });
}

/** How long a client waits before retrying a create on a template still activating (§6.4). */
export const FIRST_USE_RETRY_S = 30;

/**
 * Activation on first use (§6.4): on a deployment with host agents, a sandbox is created only on
 * an `active` build. One not active is refused with `409 template_not_active` and Retry-After, and,
 * unless the client sent `activate: false`, the caller's lease on it is taken first, so the host
 * agent starts its worker; the retry succeeds once it is attached. No sandbox record is kept while
 * waiting, so a wait never uses the caller's live-sandbox cap. Without host agents (workers run
 * by the deployment, SH_TEMPLATE_HOSTS unset) nothing changes: the create succeeds as before.
 * With hosts configured but none reported within HOST_STALE_S (a fresh deploy, a restart, every
 * host down), readiness is the worker's presence alone: an attached worker serves, and an absent one is refused rather
 * than left to wait at the relay. A build imported from SH_SANDBOX_TEMPLATES (no snapshot, so no
 * host ever holds it) is never gated: the deployment runs its worker.
 *
 * `mayActivate` false (a session's create by a subject not enrolled for sandboxes, combined spec
 * §3.4) never takes a lease: activation is enrolled-only, as on the activate route. Such a caller
 * waits (409) on a build another subject's lease is starting, and is refused (403 not_enrolled) one
 * nobody is starting, which only an enrolled subject can.
 */
export async function requireActive(
  deps: CpDeps,
  p: TokenClaims,
  t: { doc: TemplateDoc; build: TemplateBuild },
  activate: boolean,
  mayActivate = true,
): Promise<void> {
  if (hostViewsOf(deps).length === 0 && !deps.config.templateHosts?.length) return;
  // A build imported from SH_SANDBOX_TEMPLATES is the deployment's to run, never a host's: no gate,
  // as on a deployment without host agents.
  if (!hostManaged(t.build)) return;
  let facts = await readinessFacts(deps);
  const readiness = readinessOf(t.build, facts.nowS, facts.placement, facts.attached);
  if (readiness === 'active') return;
  let now = readiness;
  let started = false;
  // A caller that already holds a live lease on the build (a retry of its own first use, say) is
  // only told to wait: no renewal and no new `activate` record on every retry.
  const leased = liveLeases(t.build, facts.nowS).some((l) => l.subject === p.sub);
  if (activate && !mayActivate && !leased && readiness !== 'activating') {
    throw new CpError(
      'not_enrolled',
      `template '${t.doc.id}' is ${readiness}, and this account (${p.sub}) is not enrolled in the ` +
        'sandbox service, so it cannot activate it: an enrolled user must activate it first',
      undefined,
      { readiness },
    );
  }
  if (
    activate &&
    mayActivate &&
    !leased &&
    (readiness === 'inactive' || readiness === 'deactivating' || readiness === 'activating')
  ) {
    // Its refusals (no_active_slot, quota_exceeded, template_unavailable) answer as activate's.
    const lease = await takeLease(deps, p, t.doc, t.build, undefined, 'first_use');
    // A build in its idle grace has its worker attached, and the lease keeps it there (placement
    // prefers the host running it): it serves now, with no wait (§6.5).
    const graced = facts.placement?.graced.get(t.build.buildId);
    if (graced && lease.host === graced.host && readiness === 'deactivating') return;
    now = 'activating';
    started = true;
    // The lease may have placed it just now: its start line is read after it (§6.5).
    if (readiness !== 'activating') facts = await readinessFacts(deps);
  }
  // On a host whose agent reports its start limit and time, the wait its place in the host's
  // start line implies (§6.5); else FIRST_USE_RETRY_S, as before.
  const line = now === 'activating' ? facts.queue?.byBuild.get(t.build.buildId) : undefined;
  const estimate = line
    ? startRetryAfterS(
        line,
        facts.hosts.find((h) => h.id === line.host),
      )
    : null;
  throw new CpError(
    'template_not_active',
    started
      ? `template '${t.doc.id}' is ${now}; its activation has started: retry after the wait`
      : activate
        ? `template '${t.doc.id}' is ${now}: retry after the wait`
        : `template '${t.doc.id}' is ${now}; activate it (POST /v1/templates/${t.doc.id}/activate) or retry without activate: false`,
    undefined,
    {
      readiness: now,
      ...(now === 'unavailable' && facts.placement?.unplaced.get(t.build.buildId)
        ? { reason: facts.placement.unplaced.get(t.build.buildId)! }
        : {}),
    },
    estimate ?? FIRST_USE_RETRY_S,
  );
}

/**
 * The owner's actions (§5.1): the template's owner, or an admin (every owner action is open to
 * admins, on any template, §5.2). A caller who cannot see the template gets 404, as on the reads.
 */
async function ownTemplate(ctx: RequestCtx, deps: CpDeps, verb: string) {
  const p = requireEnrolled(ctx, deps);
  const w = writable(deps);
  const trusted = await trustedSet(deps);
  const own = (d: TemplateDoc | null): TemplateDoc => ownerCheck(d, p, verb, trusted);
  const d0 = own(await catalog(deps).get(ctx.params.id ?? ''));
  return { p, ...w, d0, own, trusted };
}

/**
 * The owner's check on a document: 404 for one the caller cannot see (or none), 403 for one that
 * is neither theirs nor an admin's to act on. `ownTemplate` makes it on the document as read, for
 * an early answer; each write makes it again on the document under the template's lock, so an
 * owner transfer (or a change to private) between the two is seen and the old owner's change
 * refused.
 */
function ownerCheck(
  d: TemplateDoc | null,
  p: TokenClaims,
  verb: string,
  trusted: ReadonlySet<string>,
): TemplateDoc {
  if (!d || !canSee(d, p, trusted)) throw new CpError('template_not_found', 'no such template');
  if (d.owner !== p.sub && !isAdmin(p))
    throw new CpError('forbidden', `only the template's owner, or an admin, ${verb}`);
  return d;
}

/**
 * Tags (§3.2, §5.1): the owner, or an admin, moves tags onto a registered build without rebuilding;
 * a reference `id:tag` (and `id` for `default`) then resolves to the new build for new sandboxes
 * and sessions, and those already created keep theirs. Each tag that changes is a `tag` record with
 * the new build and the one before (§7.1); a tag already on the build writes nothing.
 */
async function moveTemplateTags(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'moves its tags');
  const b = asRecord(ctx.body);
  const tags = b.tags;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > 16)
    throw new CpError('invalid_request', 'tags must be a list of 1-16 tag names');
  for (const t of tags)
    if (typeof t !== 'string' || !TEMPLATE_ID_RE.test(t))
      throw new CpError(
        'invalid_request',
        `tag '${String(t)}' must match ${TEMPLATE_ID_RE.source}`,
      );
  if (new Set(tags).size !== tags.length)
    throw new CpError('invalid_request', 'a tag is listed twice');
  const ref = typeof b.build === 'string' ? b.build : '';
  const nowS = seconds(deps);
  let buildId = '';
  let moved: { tag: string; from: string | null }[] = [];
  const records: Record<string, string> = {};
  // The build is checked under the template's write lock, so it is still registered when tagged.
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    moved = [];
    const target = cur.builds.find((x) => x.buildId === ref || x.handle === ref);
    if (!target) throw new CpError('template_not_found', 'no such build of this template');
    if (target.status !== 'registered')
      throw new CpError(
        'invalid_request',
        `the build is ${target.status}; only a registered build is tagged`,
      );
    buildId = target.buildId;
    const next = { ...cur.tags };
    const meta = { ...(cur.tagsMeta ?? {}) };
    for (const t of tags as string[]) {
      // An own property only: a tag such as `constructor` is not Object.prototype's.
      const from = Object.hasOwn(next, t) ? next[t]! : null;
      if (from === buildId) continue;
      moved.push({ tag: t, from });
      next[t] = buildId;
      meta[t] = { at: nowS, by: p.sub };
    }
    const digests = await appendRecords(
      prov,
      moved.map((m) => ({
        stream: `template/${d0.id}`,
        kind: 'tag' as const,
        subject: p.sub,
        body: { tag: m.tag, buildId, before: m.from },
      })),
    );
    moved.forEach((m, i) => (records[m.tag] = digests[i]!));
    return { ...cur, tags: next, tagsMeta: meta };
  });
  if (moved.length > 0)
    await auditBestEffort(deps, 'template_tags_moved', d0.id, {
      subject: p.sub,
      decision: 'template_tags_moved',
    });
  return {
    status: 200,
    body: {
      templateId: d0.id,
      subject: p.sub,
      buildId,
      // `before`: what the tag named until now (null: it is new); an unchanged tag names its build.
      tags: (tags as string[]).map((t) => {
        const m = moved.find((x) => x.tag === t);
        return { tag: t, buildId, before: m ? m.from : buildId, record: records[t] ?? null };
      }),
    },
  };
}

/**
 * Remove a tag (§5.1): its build is never deleted and stays addressable by its build id. `default`
 * is moved, never removed: the bare id must resolve. A `tag` record with `buildId: null`.
 */
async function removeTemplateTag(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'removes its tags');
  const tag = ctx.params.tag ?? '';
  if (!TEMPLATE_ID_RE.test(tag))
    throw new CpError('invalid_request', `tag '${tag}' must match ${TEMPLATE_ID_RE.source}`);
  if (tag === 'default')
    throw new CpError(
      'invalid_request',
      'the default tag is moved (POST …/tags), never removed: the bare id must resolve',
    );
  let before = '';
  let record = '';
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    const b = Object.hasOwn(cur.tags, tag) ? cur.tags[tag] : undefined;
    if (b === undefined)
      throw new CpError('template_not_found', `no tag '${tag}' on this template`);
    before = b;
    const next = { ...cur.tags };
    const meta = { ...(cur.tagsMeta ?? {}) };
    delete next[tag];
    delete meta[tag];
    [record] = await appendRecords(prov, [
      {
        stream: `template/${d0.id}`,
        kind: 'tag',
        subject: p.sub,
        body: { tag, buildId: null, before },
      },
    ]);
    return { ...cur, tags: next, tagsMeta: meta };
  });
  await auditBestEffort(deps, 'template_tag_removed', d0.id, {
    subject: p.sub,
    decision: 'template_tag_removed',
  });
  return {
    status: 200,
    body: { templateId: d0.id, subject: p.sub, tag, buildId: null, before, record },
  };
}

type TemplateEdit = { field: 'visibility' | 'description'; value: string; before: string };

/**
 * Edit (§5.1): the owner, or an admin, changes a template's description or visibility. `private`
 * hides it from other subjects (they get 404, as for an id that does not exist) and refuses their
 * new use; their sandboxes and sessions already created keep running. Each field that changes is a
 * `visibility` record (the field, the new value and the one before), so every edit is on the chain.
 */
async function updateTemplate(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own, trusted } = await ownTemplate(ctx, deps, 'edits it');
  const b = asRecord(ctx.body);
  if (b.visibility === undefined && b.description === undefined)
    throw new CpError('invalid_request', 'nothing to change: send visibility or description');
  if (b.visibility !== undefined && b.visibility !== 'private' && b.visibility !== 'deployment')
    throw new CpError('invalid_request', "visibility must be 'private' or 'deployment'");
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || b.description.length > 1024)
  )
    throw new CpError('invalid_request', 'description must be a string of at most 1024 characters');
  // A JSON body can carry a lone surrogate (`"\ud800"`), which a provenance record cannot hold.
  if (typeof b.description === 'string' && LONE_SURROGATE_RE.test(b.description))
    throw new CpError('invalid_request', 'description must not hold a lone surrogate');
  const visibility = b.visibility as 'private' | 'deployment' | undefined;
  const description = b.description as string | undefined;
  let changes: TemplateEdit[] = [];
  const records: Record<string, string> = {};
  const after = await cat.update(d0.id, async (c) => {
    const cur = own(c);
    // Self-attestation (subject-trust spec §6): a template with a self-attested build, registered
    // or on its way there, stays private until an admin trusts the record; refused as at create.
    if (
      visibility === 'deployment' &&
      cur.visibility !== 'deployment' &&
      cur.builds.some((x) => REUSABLE.has(x.status) && attestationOf(x, trusted) === 'self')
    )
      throw new CpError(
        'self_attested',
        'a self-attested template is private until an admin trusts its gate record (trustedGateRecords)',
      );
    changes = [];
    if (visibility !== undefined && visibility !== cur.visibility)
      changes.push({ field: 'visibility', value: visibility, before: cur.visibility });
    if (description !== undefined && description !== cur.description)
      changes.push({ field: 'description', value: description, before: cur.description });
    const digests = await appendRecords(
      prov,
      changes.map((c) => ({
        stream: `template/${d0.id}`,
        kind: 'visibility' as const,
        subject: p.sub,
        body: { field: c.field, value: c.value, before: c.before },
      })),
    );
    changes.forEach((c, i) => (records[c.field] = digests[i]!));
    return {
      ...cur,
      ...(visibility !== undefined ? { visibility } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  });
  if (changes.length > 0)
    await auditBestEffort(deps, 'template_updated', d0.id, {
      subject: p.sub,
      decision: 'template_updated',
    });
  return {
    status: 200,
    body: {
      templateId: d0.id,
      subject: p.sub,
      visibility: after.visibility,
      description: after.description,
      changes: changes.map((c) => ({ ...c, record: records[c.field]! })),
    },
  };
}

/**
 * Transfer ownership (§5.2): an admin makes another enrolled subject the template's owner, for
 * example when its creator leaves. The new owner gets every owner action, and the quotas count it
 * as theirs from now on; sandboxes and sessions already made keep their own subjects. An `owner`
 * record names the admin, the new owner and the one before.
 *
 * A template the deployment declared (imported from SH_SANDBOX_TEMPLATES, owner null) is handed to
 * a subject the same way, `before: null`: its id otherwise blocks every self-serve create under it
 * (`409 template_exists`). The import runs once, into an empty catalog, so a restart does not take
 * it back.
 */
async function transferTemplateOwner(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  if (!isAdmin(p))
    throw new CpError('forbidden', 'transferring a template requires the admin role');
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const owner = asRecord(ctx.body).owner;
  if (typeof owner !== 'string' || !MEMBER_SUBJECT_RE.test(owner))
    throw new CpError('invalid_request', `owner must be a subject, ${MEMBER_SUBJECT_FORMS}`);
  // The new owner must be able to act on it: enrolled now (the allow list, or an admin).
  if (!isEnrolledForSandbox(owner, deps.identity.rolesFor(owner), deps.config))
    throw new CpError(
      'invalid_request',
      `${owner} is not enrolled: add them to SH_ALLOWED_SUBJECTS first`,
    );
  let before = null as string | null;
  let record: string | null = null;
  const trusted = await trustedSet(deps);
  await cat.update(d0.id, async (cur) => {
    if (!cur) throw new CpError('template_not_found', 'no such template');
    before = cur.owner;
    if (before === owner) return cur;
    // Self-attestation (subject-trust spec §6): a subject's own gate record counts for that subject's
    // own templates only, so a template with a self-attested build, registered or on its way there,
    // is not handed to another subject until an admin trusts the record.
    if (cur.builds.some((x) => REUSABLE.has(x.status) && attestationOf(x, trusted) === 'self'))
      throw new CpError(
        'self_attested',
        "a self-attested template keeps its owner until an admin trusts its gate record (trustedGateRecords): the record counts for its submitter's own templates only",
      );
    [record] = await appendRecords(prov, [
      { stream: `template/${d0.id}`, kind: 'owner', subject: p.sub, body: { owner, before } },
    ]);
    return { ...cur, owner };
  });
  if (owner !== before) {
    await auditBestEffort(deps, 'template_owner_transferred', d0.id, {
      subject: p.sub,
      decision: 'template_owner_transferred',
    });
  }
  return { status: 200, body: { templateId: d0.id, subject: p.sub, owner, before, record } };
}

export const SANDBOX_HANDLERS: Record<string, Handler> = {
  // The template reads (template lifecycle spec §4), on every route profile (§4.1): on `harness`
  // and `combined` requireReader admits any logged-in subject. The worker id is deployment
  // plumbing; a client names a template, never a worker.
  listTemplates: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const docs = await visibleTemplates(deps, p);
    const live = await readinessFacts(deps);
    const templates = docs.map((d) => templateBody(d, live, false));
    // Per-host limits and use (§4, §6.2), from the host agents' inventories (host-handlers.ts): an
    // empty list means "no host reports", never "no limit".
    return { status: 200, body: { templates, hosts: hostsBlock(deps, live) } };
  },

  listTemplateTags: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const tags = Object.entries(d.tags)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, buildId]) => {
        const m = d.tagsMeta && Object.hasOwn(d.tagsMeta, tag) ? d.tagsMeta[tag] : undefined;
        return { tag, buildId, assignedAt: m?.at ?? d.createdAt, assignedBy: m?.by ?? d.owner };
      });
    return { status: 200, body: { tags } };
  },

  getTemplate: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    return { status: 200, body: templateBody(d, await readinessFacts(deps), true) };
  },

  listTemplateBuilds: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const live = await readinessFacts(deps);
    return { status: 200, body: { builds: d.builds.map((b) => buildBody(d, b, live, true)) } };
  },

  getTemplateBuild: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
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
  retireTemplate,
  retireTemplateBuild,

  // The owner's and the admin's actions (§5.1-§5.2): tags, edits and owner transfer.
  moveTemplateTags,
  removeTemplateTag,
  updateTemplate,
  transferTemplateOwner,

  // Activation leases (§6.3): take or renew, and release.
  activateTemplate: activate,
  deactivateTemplate: deactivate,

  // The policy (§8): any enrolled client reads it; only an admin sets it, and each set is a
  // `policy` record naming who.
  getPolicy: async (ctx, deps) => {
    requireReader(ctx, deps.config);
    const { policy, record } = await policyStore(deps).current();
    // The general-gate schema rides along, so a client's dry run applies X1.offline as this
    // deployment does.
    const gateRecordSchema = deps.config.sandbox?.gateRecordSchema ?? DEFAULT_GATE_RECORD_SCHEMA;
    return {
      status: 200,
      body: { policy, digest: policyDigest(policy), record, gateRecordSchema },
    };
  },

  putPolicy: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    if (!isAdmin(p)) throw new CpError('forbidden', 'setting the policy requires the admin role');
    const store = policyStore(deps);
    const bad = policyProblems(ctx.body);
    if (bad.length) throw new CpError('invalid_request', bad.join('; '));
    // Self-attestation: a record whose trust this removes narrows its deployment-visible templates
    // to private on read. Name each narrowed build in the policy record, so nothing is silent. The
    // policy itself is what the admin sent, every field kept as sent.
    const before = new Set((await store.current()).policy.trustedGateRecords);
    const after = new Set((ctx.body as Policy).trustedGateRecords);
    const narrowed: { template: string; buildId: string }[] = [];
    if ([...before].some((g) => !after.has(g)) && deps.templates)
      for (const d of await deps.templates.list())
        if (effectiveVisibility(d, before) === 'deployment')
          for (const x of d.builds)
            if (
              x.status === 'registered' &&
              attestationOf(x, before) === 'deployment' &&
              attestationOf(x, after) === 'self'
            )
              narrowed.push({ template: d.id, buildId: x.buildId });
    const { policy, record } = await store.set(
      ctx.body as Policy,
      p.sub,
      narrowed.length ? { narrowed } : undefined,
    );
    await auditBestEffort(deps, 'policy_set', 'policy', { subject: p.sub, decision: 'policy_set' });
    return {
      status: 200,
      body: {
        policy,
        digest: policyDigest(policy),
        record,
        ...(narrowed.length ? { narrowed } : {}),
      },
    };
  },

  getQuota: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const { cat, policy } = writable(deps);
    const { policy: pol } = await policy.current();
    const u = await usage(cat, p.sub);
    const nowS = seconds(deps);
    // The builds this subject holds a live lease on (§6.3), as activate counts them.
    const active = leasedBy(await cat.list(), p.sub, nowS).length;
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
        active: { limit: pol.quota.active, used: active },
        owned: { limit: ownedLimit(pol.quota), used: u.owned },
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
    if (b.activate !== undefined && typeof b.activate !== 'boolean')
      throw new CpError('invalid_request', 'activate must be true or false');
    const template = await resolveForUse(deps, p, b.template);
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME_RE.test(b.name))) {
      throw new CpError('invalid_request', `name must match ${NAME_RE}`);
    }
    const labels = parseLabels(b.labels);
    const mode = b.mode === undefined ? 'per-exec' : parseMode(b.mode, cfg);
    const idleTimeoutS = parseIdleTimeout(b.idleTimeoutS, cfg);
    await requireActive(deps, p, template, b.activate !== false);
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
      mode,
      idleTimeoutS,
      // Per-exec is epoch 0, as every sandbox made before modes existed is. A lease mode starts at
      // 1 (ruling R8): the worker serves every epoch-0 Exec as unversioned per-Exec, so a lease at
      // 0 could never be served. At 1 it is served per-Exec only until the first set_mode makes
      // the workspace's epoch known (spec §8.2), which the client sends right after create.
      modeEpoch: mode === 'per-exec' ? 0 : 1,
    };
    const outcome = await notRetired(deps, template, () =>
      store.create(
        rec,
        { perSubject: cfg.maxPerSubject, total: cfg.maxTotal, retentionS: cfg.retentionS },
        now,
      ),
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
    // Its lease (§7.1): the caller's live lease on the build, by the activate record that granted it.
    const lease = liveLeases(template.build, now).find((l) => l.subject === p.sub);
    await sandboxCreated(deps, rec, p.sub, lease?.record ?? null);
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
      // The egress log is kept as long as the record, whose retention now runs from the delete.
      await deps.egress?.expireAt(rec.id, now + cfg.retentionS);
      await sandboxEnded(deps, rec, ctx.principal!.sub, 'deleted', now);
    }
    // Idempotent: a second delete, or a delete after expiry, reports how it actually ended.
    const ended = viewOf(outcome === 'deleted' ? { ...rec, deletedAt: now } : rec, now);
    return {
      status: 200,
      body: { id: rec.id, state: 'terminated', reason: ended.reason ?? 'deleted' },
    };
  },

  /**
   * A sandbox's egress log, for whoever may read the sandbox (GET /v1/sandboxes/{id}):
   * `{events, next, summary}` a page at a time (`after` is the last page's `next`; `summary` on the
   * first page, null after it), or with
   * `format=ndjson` the whole log, whose sha256 is `summary.sha256` and the end record's.
   */
  getSandboxEgress: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    if (!deps.egress) throw new CpError('internal_error', 'the egress log is not configured');
    const format = ctx.query.get('format');
    if (format !== null && format !== 'json' && format !== 'ndjson')
      throw new CpError('invalid_request', "format must be 'json' or 'ndjson'");
    if (format === 'ndjson') {
      // Streamed a store page at a time (server.ts writeStream), never built whole in memory.
      return {
        status: 200,
        body: ndjson(deps.egress, rec.id),
        contentType: 'application/x-ndjson',
      };
    }
    const after = ctx.query.get('after');
    if (after !== null && !ENTRY_ID_RE.test(after))
      throw new CpError('invalid_request', "after must be a page's next");
    const rawLimit = ctx.query.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CpError('invalid_request', 'limit must be 1-1000');
    const page = await deps.egress.page(rec.id, after, limit);
    return {
      status: 200,
      body: {
        events: page.map((e) => JSON.parse(e.line) as unknown),
        next: page.length === limit ? page[page.length - 1]!.id : null,
        // On the first page only: the summary reads the whole log, so a page after it (`after`)
        // costs that page alone, and paging a log through is linear in its length.
        summary: after === null ? await summarize(deps.egress, rec.id) : null,
      },
    };
  },

  mintSandboxToken: async (ctx, deps) => {
    const read = await assertSandboxOwner(ctx, deps, { admin: false });
    const { cfg } = service(deps);
    const now = seconds(deps);
    requireLive(read, now);
    const rec = await underPolicy(deps, ctx.principal!.sub, read, now);
    const { token, exp } = mintSandboxToken(deps.signer, {
      sub: rec.owner,
      tenant: rec.tenant,
      sbx: rec.id,
      wrk: rec.worker,
      wsk: rec.wsk,
      mode: rec.mode,
      modeEpoch: rec.modeEpoch,
      idleTimeoutS: idleClaim(deps, rec),
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
   * Change the mode (lease-mode spec §8.1). Owner only, as minting is: an admin calling it on
   * another user's sandbox gets the same 404 as anyone else, since a mode is what the owner's Execs
   * may do. Every accepted call raises the epoch, the same mode included, and
   * returns a set-mode token for that epoch, for the client's `LeaseControl set_mode`: a downgrade
   * takes effect at once only through it (spec §8.2).
   */
  setSandboxMode: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: false });
    const { cfg, store } = service(deps);
    const now = seconds(deps);
    requireLive(rec, now);
    const b = asRecord(ctx.body);
    const mode = parseMode(b.mode, cfg);
    const idleTimeoutS = parseIdleTimeout(b.idleTimeoutS, cfg);
    const changed = await store.setMode(rec.id, mode, idleTimeoutS, now);
    // Deleted, expired or past retention since the read above.
    if (!changed) return refuseGone(store, rec.id, now);
    const next = changed.record;
    await auditBestEffort(deps, 'sandbox_mode_changed', rec.id, {
      subject: ctx.principal!.sub,
      sandboxId: rec.id,
      decision: 'sandbox_mode_changed',
      // From the atomic update, not `rec`: another PUT may have landed since that read (ruling R9).
      fromMode: changed.previousMode,
      toMode: next.mode,
      modeEpoch: next.modeEpoch,
    });
    return {
      status: 200,
      body: {
        sandbox: sandboxBody(viewOf(next, now)),
        setModeToken: setModeTokenFor(deps, next, now),
      },
    };
  },

  /**
   * A set-mode token for the mode and epoch the record holds now, raising nothing: what `mocactl sbx
   * get` re-sends when the worker reports the epoch unknown (spec §8.2). Owner only, as above. The
   * one exception is a mode the policy no longer allows, downgraded first (underPolicy).
   */
  mintSandboxModeToken: async (ctx, deps) => {
    const read = await assertSandboxOwner(ctx, deps, { admin: false });
    const now = seconds(deps);
    requireLive(read, now);
    const rec = await underPolicy(deps, ctx.principal!.sub, read, now);
    return { status: 200, body: { setModeToken: setModeTokenFor(deps, rec, now) } };
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
    await sealEgress(deps, all, now);
    return { status: 200, body: { live, terminated } };
  },
};
