import { CpError } from './errors.js';
import { asRecord, seconds } from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { recordDigest } from './provenance.js';
import { LOG_MAX, type TemplateBuild, type TemplateDoc } from './template-catalog.js';
import { activationLock } from './activation-lock.js';
import {
  liveLeases,
  place,
  unattachedPlaced,
  wantedBuilds,
  type HostMemory,
  type HostStart,
  type HostView,
} from './activation.js';
import { isEnrolledForSandbox } from './sandbox-config.js';
import { isLive, type SandboxRecord } from './sandbox-store.js';
import {
  EGRESS_DROP_REPORT_MAX,
  EGRESS_DROP_WINDOW_S,
  EGRESS_GRACE_S,
  EGRESS_POST_MAX,
  egressLine,
  parseEgressEvent,
  type EgressGroup,
} from './egress-log.js';

/**
 * The template host agent's routes (template lifecycle spec §6.1): a KVM host's `sbx-host-agent`
 * polls these with its own bearer (`auth: 'host'`, SH_HOST_TOKEN_<ID>); the host named in the path
 * is the one whose token was presented, so a host reports only for itself.
 *
 *   POST /v1/hosts/{host}/inventory          what it holds (by manifest hash), its limits and, from
 *                                            an agent with memory-aware placement, its memory
 *   POST /v1/hosts/{host}/builds/claim       up to N queued builds, oldest first, subjects in turn
 *   GET  /v1/hosts/{host}/blobs/{digest}     a gate record a claimed build cites, byte for byte
 *   POST /v1/hosts/{host}/builds/{build}/log      log entries for a build it claimed
 *   POST /v1/hosts/{host}/builds/{build}/report   a step: building, probing, built (with T and S), failed
 *
 * The control plane never trusts a report it cannot tie to its chain: a report must answer a build
 * this host claimed. On `built` it checks the build record against the create's request and the
 * policy (§8.2) and registers or rejects the build, automatically, with a `check` record.
 *
 *   GET  /v1/hosts/{host}/wanted             the builds this host should run (leased and placed on
 *                                            it, first leased first), those it holds that it should
 *                                            stop (no lease left, no live sandbox), of `run` those
 *                                            not attached yet (`starting`, for the start limit),
 *                                            and those kept in its idle grace (`graced`)
 *   POST /v1/hosts/{host}/workers/report     {buildId, event: attached | refused | detached, reason?}
 *   POST /v1/hosts/{host}/egress             {events, cursor}: the egress proxy's audit events, as it
 *                                            wrote them, into each sandbox's egress log
 *
 * Readiness itself is never taken from a report: `active` is the relay's attached record (§3.3).
 * The worker reports are provenance: who ran what, where, when.
 */

const MANIFEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const CLAIM_MAX = 4;
/** The host agent's journal cursor, opaque here: printable ASCII, bounded. */
const CURSOR_RE = /^[\x21-\x7e]{1,512}$/;

/**
 * The spec a host agent hands template-build.sh for a claimed build. The API takes the guest's size as
 * `guest_mb` or `guest_ram_mb` (policy M7.guest reads either), but template-build.sh reads only
 * `guest_ram_mb`, so a create that named `guest_mb` passed the policy and then failed the build's own
 * spec check. The job always names `guest_ram_mb`, with the value the policy checked
 * (`guest_mb ?? guest_ram_mb`, as M7 and the build's S.guest_ram_mb check read it); `guest_mb` is
 * dropped from it. The job's `id` and `image` are always the template's and the
 * create's, whatever the spec carries.
 */
export function buildJobSpec(
  id: string,
  image: string,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const { guest_mb, ...rest } = spec;
  const guest = guest_mb ?? rest.guest_ram_mb;
  // The template's own id and the create's image come last, so a spec key of the same name (which
  // the create does not refuse) can't rename the build or swap its image in the job.
  return { ...rest, ...(guest !== undefined ? { guest_ram_mb: guest } : {}), id, image };
}

/**
 * The workers of the builds a host holds (its last inventory): whose sandboxes it may report. The
 * inventory is the host's own claim, not checked against placement or the attaching host: hosts
 * are trusted, so a host's events reach only its own sandboxes when its inventory is true, and a
 * host that claims a build it does not run can write into that build's sandboxes' egress logs.
 */
async function hostWorkers(deps: CpDeps, host: string): Promise<Set<string>> {
  const holds = deps.hosts?.get(host)?.holds ?? {};
  const out = new Set<string>();
  for (const d of (await deps.templates?.list()) ?? [])
    for (const b of d.builds) if (b.worker && holds[b.buildId] !== undefined) out.add(b.worker);
  return out;
}

const endOf = (r: SandboxRecord) => r.deletedAt ?? r.expiresAt;

/**
 * The sandboxes whose egress events this host may ship: every sandbox on a worker of
 * a build this host holds (hostSandboxes), live or ended less than EGRESS_GRACE_S ago
 * (egressAccepts). hostEgress accepts events for exactly these, and hostWanted hands their workspace
 * keys to the agent (`egressSids`), which sends nothing else, so the events of the proxy's other
 * clients (a Moca P6 session) never leave the host.
 */
async function hostSandboxes(deps: CpDeps, host: string, nowS: number): Promise<SandboxRecord[]> {
  if (!deps.sandboxes || !deps.egress) return [];
  const workers = await hostWorkers(deps, host);
  if (!workers.size) return [];
  return (await deps.sandboxes.listAll(nowS)).filter((r) => workers.has(r.worker));
}

/** Of a host's sandboxes, the ones whose events are taken now: live, or ended within the grace. */
const egressAccepts = (rs: SandboxRecord[], nowS: number): SandboxRecord[] =>
  rs.filter((r) => nowS < endOf(r) + EGRESS_GRACE_S);

/** An event's time in epoch seconds; `fallback` when it does not parse. */
function eventSeconds(e: Record<string, unknown>, fallback: number): number {
  const t = typeof e.time === 'string' ? Date.parse(e.time) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
}

export interface HostState {
  /** Epoch seconds of the host's last inventory. */
  at: number;
  /** manifest hash -> template id, what the host holds. */
  holds: Record<string, string>;
  /**
   * The held builds whose worker unit runs: as the last inventory said, then kept current by the
   * host's attached and detached reports, so placement counts what the host really runs.
   */
  running: string[];
  /**
   * buildId -> the last `refused` report (its reason) this host made for a build it is still asked
   * to run: a repeat is not recorded again (hostWorkerReport). Cleared once the build leaves the
   * host's `run`, or on any other report for it.
   */
  refused?: Record<string, string>;
  limits: {
    activeLimit: number;
    idleLimitSeconds: number;
    buildConcurrency: number;
    diskFreeGb: number;
    diskFloorGb: number;
  };
  /**
   * The inventory's `memory` (memory-aware placement), as far as it is well-formed; absent from an
   * older agent, and then its host is placed by activeLimit alone.
   */
  memory?: HostMemory;
  /** The agent's start limit and measured start time (§6.5); absent from an older agent. */
  start?: HostStart;
  /**
   * SBX_IDLE_GRACE_S as its agent reports it (§6.5, the idle grace); absent from an older agent,
   * which is a grace of 0 (off).
   */
  idleGraceSeconds?: number;
}

/** In-memory host state; the inventory is re-sent on every poll, so a restart loses nothing durable. */
export class HostRegistry {
  private readonly hosts = new Map<string, HostState>();
  /**
   * buildId -> its worker, and until when (epoch s) a turn of a session pinned to it keeps that
   * worker as a live sandbox does (busyWorkers): set by each turn's credential exchange
   * (holdPinnedWorker). In memory, as the host state: a restart forgets it until the next turn.
   */
  private readonly sessionUse = new Map<string, { worker: string; until: number }>();
  set(id: string, st: HostState): void {
    this.hosts.set(id, st);
  }
  get(id: string): HostState | undefined {
    return this.hosts.get(id);
  }
  all(): [string, HostState][] {
    return [...this.hosts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }
  /**
   * How long a pinned session's turn keeps its build's worker: the largest idle limit of the fresh
   * hosts holding the build, 3600 s when none reports one, clamped to 60-86400 s (the same rule as a
   * lease's default length, takeLease).
   */
  sessionHoldSeconds(buildId: string, nowS: number): number {
    const idle = [...this.hosts.values()]
      .filter((h) => nowS - h.at <= HOST_STALE_S && h.holds[buildId] !== undefined)
      .map((h) => h.limits.idleLimitSeconds);
    return Math.min(86_400, Math.max(60, Math.max(0, ...idle) || 3600));
  }
  /** The worker a pinned session's turn last kept for `buildId`, if that hold has not run out. */
  sessionWorker(buildId: string, nowS: number): string | undefined {
    const u = this.sessionUse.get(buildId);
    return u && u.until > nowS ? u.worker : undefined;
  }
  markSessionUse(buildId: string, worker: string, until: number): void {
    this.sessionUse.set(buildId, { worker, until });
  }
  /** The workers a pinned session's turn keeps now; the holds that ran out are dropped. */
  sessionWorkers(nowS: number): string[] {
    const out: string[] = [];
    for (const [b, u] of this.sessionUse) {
      if (u.until > nowS) out.push(u.worker);
      else this.sessionUse.delete(b);
    }
    return out;
  }
}

/**
 * A host whose last inventory is older than this is left out of placement, of the hosts block and of
 * the default lease until it reports again: three of the build poll's two-minute intervals (the
 * --wanted-only timer re-sends it every 15 s). A host whose agent died or was removed then takes no
 * new placement and no activeLimit slot, and a deployment whose every host is silent reads
 * readiness from the workers' presence alone, as before any host reported.
 *
 * Two steps with activation.ts's memoryStaleS (60 s): after about 60 s without an inventory, the
 * memory brake (`stale`) already stops new starts on a host that reports its memory, while it keeps
 * what it runs; at HOST_STALE_S the host leaves placement entirely.
 */
export const HOST_STALE_S = 360;

/** The hosts as their agents last reported (§6.1), as placement reads them: fresh ones only, with memory. */
export function hostViewsOf(deps: CpDeps): HostView[] {
  return freshHosts(deps).map(([id, h]) => ({
    id,
    holds: h.holds,
    activeLimit: h.limits.activeLimit,
    at: h.at,
    running: h.running,
    ...(h.memory ? { memory: h.memory } : {}),
    ...(h.start ? { start: h.start } : {}),
    ...(h.idleGraceSeconds ? { idleGraceSeconds: h.idleGraceSeconds } : {}),
  }));
}

/**
 * The workers with a live sandbox, or with a recent turn of a session pinned to their build
 * (HostRegistry.sessionUse): never stopped under one, so they drain and keep their slot. A session
 * keeps a worker that runs; it never starts one (only a lease does).
 */
export async function busyWorkers(deps: CpDeps, nowS: number): Promise<Set<string>> {
  const busy = new Set<string>();
  if (deps.sandboxes) {
    for (const r of await deps.sandboxes.listAll(nowS)) if (isLive(r, nowS)) busy.add(r.worker);
  }
  for (const w of deps.hosts?.sessionWorkers(nowS) ?? []) busy.add(w);
  return busy;
}

/**
 * A turn of a session pinned to a host-managed build (its credential exchange) keeps that build's
 * worker for the hold (sessionHoldSeconds) from now, as a live sandbox keeps its worker, so the
 * worker outlives the first-use lease while the session is in use. Only when the session's owner
 * is enrolled for sandboxes (the rule first-use leases follow, combined spec §3.4): a turn of a
 * subject who is not runs while the worker is up but extends nothing, so it cannot keep a build
 * running after every lease on it has gone (deactivate, the host's capacity). Best effort: a
 * failure is logged and never fails the turn. Reads the catalog only for the first turn of a hold.
 */
export async function holdPinnedWorker(
  rec: { owner: string; sandboxBuildId?: string },
  deps: CpDeps,
): Promise<void> {
  const build = rec.sandboxBuildId;
  const hosts = deps.hosts;
  if (!hosts || !deps.templates || !build?.startsWith('sha256:')) return;
  try {
    if (!isEnrolledForSandbox(rec.owner, deps.identity.rolesFor(rec.owner), deps.config)) return;
    const nowS = seconds(deps);
    let worker = hosts.sessionWorker(build, nowS);
    if (worker === undefined) {
      worker = (await deps.templates.list())
        .flatMap((d) => d.builds)
        .find((b) => b.buildId === build && b.status === 'registered')?.worker;
    }
    if (worker) hosts.markSessionUse(build, worker, nowS + hosts.sessionHoldSeconds(build, nowS));
  } catch (err) {
    console.error(
      `[control-plane] holding the worker of build ${build} for a session turn failed: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );
  }
}

/** The hosts whose last inventory is at most HOST_STALE_S old, by id. */
export function freshHosts(deps: CpDeps): [string, HostState][] {
  const nowS = seconds(deps);
  return (deps.hosts?.all() ?? []).filter(([, h]) => nowS - h.at <= HOST_STALE_S);
}

function catalogOf(deps: CpDeps) {
  const cat = deps.templates;
  if (!cat?.update || !deps.provenance || !deps.policy) {
    throw new CpError(
      'invalid_request',
      'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
    );
  }
  return { cat: cat as Required<typeof cat>, prov: deps.provenance, policy: deps.policy };
}

const hostOf = (ctx: RequestCtx): string => {
  if (!ctx.host) throw new CpError('unauthorized', 'host authentication failed');
  return ctx.host;
};

const nonNeg = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** The most a start limit or a start time is taken at (a malformed figure is dropped). */
const START_MAX = 1_000_000;

/**
 * The inventory limits' startConcurrency and startSeconds (§6.5): a concurrency of at least 1, and
 * seconds only beside it. Neither from an older agent: then no start line for its host.
 */
export function parseHostStart(l: Record<string, unknown>): HostStart | undefined {
  const c = nonNeg(l.startConcurrency);
  if (c === undefined || c < 1 || c > START_MAX) return undefined;
  const sec = nonNegNum(l.startSeconds);
  return { concurrency: c, ...(sec !== undefined && sec <= START_MAX ? { seconds: sec } : {}) };
}

/** The most an idle grace is taken at: a day (a malformed or larger figure is dropped). */
const GRACE_MAX = 86_400;

/** The inventory limits' idleGraceSeconds (§6.5): a whole number 0..GRACE_MAX, else none. */
export function parseIdleGrace(l: Record<string, unknown>): number | undefined {
  const g = nonNeg(l.idleGraceSeconds);
  return g !== undefined && g <= GRACE_MAX ? g : undefined;
}

const WORKER_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEM_LIST_MAX = 1024;

/** A non-negative finite number (PSI is a percentage with decimals). */
const nonNegNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * The inventory's `memory` object, field by field: what is malformed is dropped, never guessed.
 * MemTotal, MemAvailable and the floor are kept only all three together (the memory test needs
 * each); the lists keep only well-formed worker ids and manifest hashes.
 */
export function parseHostMemory(raw: unknown): HostMemory | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined;
  const m = raw as Record<string, unknown>;
  const out: HostMemory = {};
  const total = nonNeg(m.memTotalMib);
  const avail = nonNeg(m.memAvailableMib);
  const floor = nonNeg(m.memFloorMib);
  if (total !== undefined && total > 0 && avail !== undefined && floor !== undefined) {
    out.totalMib = total;
    out.availableMib = avail;
    out.floorMib = floor;
  }
  const psi = nonNegNum(m.memPressureFull10);
  if (psi !== undefined) out.pressureFull10 = psi;
  const limit = nonNegNum(m.memPressureLimit);
  if (limit !== undefined && limit > 0) out.pressureLimit = limit;
  if (Array.isArray(m.runningWorkers)) {
    out.running = m.runningWorkers
      .filter((w): w is string => typeof w === 'string' && WORKER_ID_RE.test(w))
      .slice(0, MEM_LIST_MAX);
  }
  const vc = m.vmCommittedMib;
  if (vc && typeof vc === 'object' && !Array.isArray(vc)) {
    out.vmCommittedMib = {};
    for (const [w, v] of Object.entries(vc as Record<string, unknown>).slice(0, MEM_LIST_MAX)) {
      const n = nonNeg(v);
      if (WORKER_ID_RE.test(w) && n !== undefined) out.vmCommittedMib[w] = n;
    }
  }
  if (Array.isArray(m.memfileMismatch)) {
    out.memfileMismatch = m.memfileMismatch
      .filter((h): h is string => typeof h === 'string' && MANIFEST_HASH_RE.test(h))
      .slice(0, MEM_LIST_MAX);
  }
  return out;
}

/** Finds the build a host refers to by handle or build id, in a template it claimed it for. */
async function claimedBuild(
  deps: CpDeps,
  host: string,
  handle: string,
): Promise<{ doc: TemplateDoc; build: TemplateBuild }> {
  const { cat } = catalogOf(deps);
  for (const doc of await cat.list()) {
    const build = doc.builds.find((b) => b.handle === handle || b.buildId === handle);
    if (build) {
      if (build.claim?.host !== host)
        throw new CpError('not_found', 'no such build claimed by this host');
      return { doc, build };
    }
  }
  throw new CpError('not_found', 'no such build claimed by this host');
}

/** What a built report's records must say about the request (§8.2): the registration check. */
function registrationResults(
  build: TemplateBuild,
  t: Record<string, unknown>,
  sManifest: Record<string, unknown>,
) {
  const req = build.request!;
  const spec = req.spec;
  const out: { rule: string; passed: boolean; message?: string }[] = [];
  const rule = (id: string, ok: boolean, message: string) =>
    out.push(ok ? { rule: id, passed: true } : { rule: id, passed: false, message });
  rule(
    'T.schema',
    t.schema === 'moca-sbx-template/1',
    'the template record is not moca-sbx-template/1',
  );
  rule('T.image', t.image === req.image, 'the template record names another image than the create');
  const hash = t.manifest_hash;
  rule(
    'T.manifest_hash',
    typeof hash === 'string' && MANIFEST_HASH_RE.test(hash),
    'the template record has no manifest_hash',
  );
  rule(
    'S.hash',
    sManifest.hash === hash,
    "the manifest's hash is not the template record's manifest_hash",
  );
  rule(
    'S.hash_version',
    sManifest.hash_version === 2,
    'the manifest is not hash version 2 (PV2-PV3): rebuild with the current build-snapshot.sh',
  );
  const digest = req.image.slice(req.image.indexOf('@') + 1);
  rule(
    'S.source_image_digest',
    sManifest.source_image_digest === digest,
    "the snapshot's rootfs is not from the create's image (R)",
  );
  const guest = spec.guest_mb ?? spec.guest_ram_mb;
  rule(
    'S.guest_ram_mb',
    sManifest.guest_ram_mb === guest && t.guest_ram_mb === guest,
    "the guest size is not the spec's",
  );
  rule('S.vcpus', sManifest.vcpus === spec.vcpus, "the vCPU count is not the spec's");
  rule(
    'T.probe',
    t.probe_status === undefined || t.probe_status === spec.probe_status,
    'the probe status differs from the spec',
  );
  if (req.gateRecordSha256) {
    const g = (t.gate_record as Record<string, unknown> | undefined)?.sha256;
    rule(
      'T.gate_record',
      g === req.gateRecordSha256,
      'the template record cites another gate record than the create (X10)',
    );
  }
  if (spec.skip_git_identity_check === true) {
    rule(
      'T.X12',
      t.skip_git_identity_check === true,
      'the template record does not carry skip_git_identity_check (X12)',
    );
  }
  return out;
}

/** The statuses a host may still report on: claimed, and not yet registered, rejected or failed. */
const REPORTABLE = new Set<TemplateBuild['status']>(['building', 'probing', 'built']);

/** Refuses a report on a build that is not this host's, or that takes no more reports. */
function reportable(y: TemplateBuild, host: string): void {
  if (y.claim?.host !== host) throw new CpError('not_found', 'no such build claimed by this host');
  if (!REPORTABLE.has(y.status))
    throw new CpError('invalid_request', `the build is ${y.status}; it takes no more reports`);
}

export const HOST_HANDLERS: Record<string, Handler> = {
  /**
   * The egress proxy's audit events from this host's journal. An event is stored in
   * a sandbox's log only when its `sid` is the workspace key (`wsk`) of a sandbox on a worker of a
   * build this host holds, and the sandbox has not ended more than EGRESS_GRACE_S ago; every other
   * event is refused and counted. An event naming such a sandbox that is not exactly a proxy Event
   * is not stored, and counted as dropped in that sandbox's log, as is each `oversized` sid (an event
   * the agent kept back for its size). An `audit_dropped` event (no VM)
   * is charged to every sandbox on this host's workers live within EGRESS_DROP_WINDOW_S before it
   * (egress-log.ts). Idempotent by (host, cursor): the agent's retry of a post repeats its cursor.
   */
  hostEgress: async (ctx, deps) => {
    const host = hostOf(ctx);
    const b = asRecord(ctx.body);
    if (typeof b.cursor !== 'string' || !CURSOR_RE.test(b.cursor))
      throw new CpError('invalid_request', 'cursor must be the journal cursor, printable ASCII');
    const oversized = b.oversized ?? [];
    if (
      !Array.isArray(b.events) ||
      !Array.isArray(oversized) ||
      b.events.length + oversized.length > EGRESS_POST_MAX
    )
      throw new CpError(
        'invalid_request',
        `events and oversized must be arrays of at most ${EGRESS_POST_MAX} in all`,
      );
    const nowS = seconds(deps);
    const retentionS = deps.config.sandbox?.retentionS ?? 0;
    // Every sandbox of the host's workers for the drop rule; only egressAccepts' for events.
    const mine = await hostSandboxes(deps, host, nowS);
    const byWsk = new Map(egressAccepts(mine, nowS).map((r) => [r.wsk, r]));
    const groups = new Map<string, EgressGroup>();
    const group = (r: SandboxRecord) => {
      let g = groups.get(r.id);
      if (!g) {
        g = {
          sandboxId: r.id,
          lines: [],
          proxyDropped: 0,
          invalid: 0,
          expireAtS: endOf(r) + retentionS,
        };
        groups.set(r.id, g);
      }
      return g;
    };
    let refused = 0;
    let dropped = 0;
    for (const raw of b.events) {
      const o = asRecord(raw);
      if (raw === o && o.decision === 'audit_dropped' && !o.sid) {
        const n = Math.min(nonNeg(o.dropped) ?? 0, EGRESS_DROP_REPORT_MAX);
        const t = eventSeconds(o, nowS);
        dropped += n;
        for (const r of mine)
          if (r.createdAt <= t && endOf(r) >= t - EGRESS_DROP_WINDOW_S) group(r).proxyDropped += n;
        continue;
      }
      const r = typeof o.sid === 'string' ? byWsk.get(o.sid) : undefined;
      if (!r) {
        refused += 1;
        continue;
      }
      const e = parseEgressEvent(raw);
      const line = e && egressLine(e);
      if (line) group(r).lines.push(line);
      else group(r).invalid += 1;
    }
    // Events the agent did not send because they were too long (over 8 KiB): only their sid comes,
    // and each is counted as dropped in its sandbox's log, as an event that is not an Event.
    for (const sid of oversized) {
      const r = typeof sid === 'string' ? byWsk.get(sid) : undefined;
      if (!r) refused += 1;
      else group(r).invalid += 1;
    }
    if (!deps.egress) {
      return {
        status: 200,
        body: {
          accepted: 0,
          refused,
          capped: 0,
          overBudget: 0,
          invalid: 0,
          dropped,
          cursor: b.cursor,
        },
      };
    }
    const answer = await deps.egress.append(host, b.cursor, [...groups.values()], refused, dropped);
    return { status: 200, body: answer };
  },

  /**
   * The wanted state (§6.3, §6.5): `run`, the registered builds this host holds that are leased
   * and placed on it (the same placement activate judges by), in start order; `stop`, the ones it
   * holds with no live lease and no idle grace, or that it runs while placement keeps them on
   * another host; `starting`, those placed but not yet attached; and `graced`, those kept running
   * through their idle grace (see wantedAnswer). A worker is never stopped under a live sandbox: it
   * drains first, so a build with one is in no stop list.
   * `egressSids`: the workspace keys of the sandboxes whose egress events the agent ships
   * (hostSandboxes), and no others.
   */
  hostWanted: async (ctx, deps) => {
    const host = hostOf(ctx);
    const nowS = seconds(deps);
    const grace = (deps.hosts?.get(host)?.idleGraceSeconds ?? 0) > 0;
    const answer = await wantedAnswer(deps, host, nowS, hostViewsOf(deps), grace);
    const egressSids = egressAccepts(await hostSandboxes(deps, host, nowS), nowS)
      .map((r) => r.wsk)
      .sort();
    return { ...answer, body: { ...answer.body, egressSids } };
  },

  /**
   * A worker started (`attached`: its unit is running), not started (`refused`, with why: not
   * installed, or the start failed) or stopped (`detached`), for a registered build this host
   * holds: an `activate` or `deactivate` record by the host, except a refusal repeating the host's
   * last one for a build still in its `run` (answered `recorded: null`). Readiness still comes from
   * the relay.
   */
  hostWorkerReport: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat, prov } = catalogOf(deps);
    const b = asRecord(ctx.body);
    const event = b.event;
    if (event !== 'attached' && event !== 'refused' && event !== 'detached') {
      throw new CpError('invalid_request', 'event must be attached, refused or detached');
    }
    const buildId = typeof b.buildId === 'string' ? b.buildId : '';
    const doc = (await cat.list()).find((d) =>
      d.builds.some((x) => x.buildId === buildId && x.status === 'registered'),
    );
    if (!doc || deps.hosts?.get(host)?.holds[buildId] === undefined) {
      throw new CpError('not_found', 'no registered build this host holds');
    }
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 1024) : undefined;
    // What the host runs, as placement counts it, without waiting for its next inventory: started
    // (attached) runs; stopped (detached) and not started (refused) do not.
    const st = deps.hosts!.get(host)!;
    const others = st.running.filter((x) => x !== buildId);
    st.running = event === 'attached' ? [...others, buildId] : others;
    // The memory report's runningWorkers stay as the inventory said: they are what its MemAvailable
    // reflects. A worker started since is pending on that side until the next inventory (place()).
    // A refusal the same as this host's last one for a build it is still asked to run (the agent
    // retries every 15 s: a worker not installed, a unit whose start keeps failing) is not appended
    // again: the template's stream is append-only provenance, and would grow by one record a poll.
    st.refused ??= {};
    if (event === 'refused') {
      if (st.refused[buildId] === (reason ?? '')) {
        return { status: 200, body: { recorded: null } };
      }
      st.refused[buildId] = reason ?? '';
    } else {
      delete st.refused[buildId];
    }
    await prov.append({
      stream: `template/${doc.id}`,
      kind: event === 'detached' ? 'deactivate' : 'activate',
      subject: `host:${host}`,
      body: { buildId, event, ...(reason ? { reason } : {}) },
    });
    return { status: 200, body: { recorded: event } };
  },

  hostInventory: async (ctx, deps) => {
    const host = hostOf(ctx);
    const b = asRecord(ctx.body);
    const holds: Record<string, string> = {};
    const running: string[] = [];
    const inv = Array.isArray(b.holds) ? b.holds : [];
    for (const h of inv) {
      const r = asRecord(h);
      if (
        typeof r.manifestHash === 'string' &&
        MANIFEST_HASH_RE.test(r.manifestHash) &&
        typeof r.template === 'string'
      ) {
        holds[r.manifestHash] = r.template;
        if (r.running === true) running.push(r.manifestHash);
      }
    }
    const l = asRecord(b.limits);
    const limits = {
      activeLimit: nonNeg(l.activeLimit) ?? 0,
      idleLimitSeconds: nonNeg(l.idleLimitSeconds) ?? 0,
      buildConcurrency: nonNeg(l.buildConcurrency) ?? 1,
      diskFreeGb: nonNeg(l.diskFreeGb) ?? 0,
      diskFloorGb: nonNeg(l.diskFloorGb) ?? 0,
    };
    const memory = parseHostMemory(b.memory);
    const start = parseHostStart(l);
    const grace = parseIdleGrace(l);
    // A host's unrepeated refusals outlive its inventories (each poll replaces the rest).
    const refused = deps.hosts?.get(host)?.refused ?? {};
    deps.hosts?.set(host, {
      at: seconds(deps),
      holds,
      running,
      refused,
      limits,
      ...(memory ? { memory } : {}),
      ...(start ? { start } : {}),
      ...(grace !== undefined ? { idleGraceSeconds: grace } : {}),
    });
    return { status: 200, body: { host, holds: Object.keys(holds).length } };
  },

  hostClaimBuilds: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const b = asRecord(ctx.body);
    const want = Math.min(nonNeg(b.max) ?? 1, CLAIM_MAX);
    const now = seconds(deps);
    // Oldest first, one subject's at a time in turn (§6.1 step 2), so one batch holds no host.
    const queued = (await cat.list())
      .flatMap((d) =>
        d.builds.filter((x) => x.status === 'queued' && x.request).map((x) => ({ d, x })),
      )
      .sort(
        (p, q) =>
          (p.x.queuedAtMs ?? p.x.createdAt * 1000) - (q.x.queuedAtMs ?? q.x.createdAt * 1000) ||
          (p.x.handle! < q.x.handle! ? -1 : 1),
      );
    const order: typeof queued = [];
    const bySubject = new Map<string, typeof queued>();
    for (const e of queued) {
      const k = e.d.owner ?? '';
      if (!bySubject.has(k)) bySubject.set(k, []);
      bySubject.get(k)!.push(e);
    }
    while (order.length < queued.length) {
      for (const list of bySubject.values()) if (list.length) order.push(list.shift()!);
    }
    const claimed: Record<string, unknown>[] = [];
    for (const { d, x } of order) {
      if (claimed.length >= want) break;
      let got = false;
      await cat.update(d.id, async (cur) => {
        const doc = cur!;
        const build = doc.builds.find((y) => y.handle === x.handle);
        if (!build || build.status !== 'queued') return doc; // another host took it
        got = true;
        return {
          ...doc,
          builds: doc.builds.map((y) =>
            y === build ? { ...y, status: 'building' as const, claim: { host, at: now } } : y,
          ),
        };
      });
      if (!got) continue;
      claimed.push({
        template: d.id,
        build: x.handle,
        image: x.request!.image,
        spec: buildJobSpec(d.id, x.request!.image, x.request!.spec),
        ...(x.request!.gateRecordSha256
          ? { gateRecord: `/v1/hosts/${host}/blobs/${x.request!.gateRecordSha256}` }
          : {}),
      });
    }
    return { status: 200, body: { builds: claimed } };
  },

  hostBlob: async (ctx, deps) => {
    hostOf(ctx);
    const { prov } = catalogOf(deps);
    const blob = await prov.getBlob(ctx.params.digest ?? '').catch(() => null);
    if (!blob) throw new CpError('not_found', 'no such document');
    return { status: 200, body: { sha256: ctx.params.digest, base64: blob.toString('base64') } };
  },

  hostBuildLog: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat } = catalogOf(deps);
    const { doc, build } = await claimedBuild(deps, host, ctx.params.build ?? '');
    const b = asRecord(ctx.body);
    const now = seconds(deps);
    const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 200).flatMap((e) => {
      const r = asRecord(e);
      const level = r.level === 'warn' || r.level === 'error' ? r.level : 'info';
      return typeof r.message === 'string'
        ? [
            {
              at: now,
              level: level as 'info' | 'warn' | 'error',
              step: typeof r.step === 'string' ? r.step.slice(0, 64) : '',
              message: r.message.slice(0, 4096),
            },
          ]
        : [];
    });
    await cat.update(doc.id, async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((y) =>
        y.handle === build.handle
          ? { ...y, log: [...(y.log ?? []), ...entries].slice(-LOG_MAX) }
          : y,
      ),
    }));
    return { status: 200, body: { appended: entries.length } };
  },

  hostBuildReport: async (ctx, deps) => {
    const host = hostOf(ctx);
    const { cat, prov, policy } = catalogOf(deps);
    const { doc, build } = await claimedBuild(deps, host, ctx.params.build ?? '');
    const b = asRecord(ctx.body);
    const event = b.event;
    const stream = `template/${doc.id}`;
    // A quick refusal on what this request read; the same check runs again inside every write
    // below, in the template's update queue, because the build can change in between (an owner's
    // cancel), and a report never overwrites a build the host may no longer report on.
    reportable(build, host);
    const withBuild = (mutate: (y: TemplateBuild, c: TemplateDoc) => Promise<TemplateDoc>) =>
      cat.update(doc.id, async (cur) => {
        const y = cur?.builds.find((x) => x.handle === build.handle);
        if (!cur || !y) throw new CpError('not_found', 'no such build claimed by this host');
        reportable(y, host);
        return mutate(y, cur);
      });
    const patched = (c: TemplateDoc, y: TemplateBuild, patch: Partial<TemplateBuild>) => ({
      ...c,
      builds: c.builds.map((x) => (x === y ? { ...x, ...patch } : x)),
    });
    if (event === 'building' || event === 'probing') {
      await withBuild(async (y, c) => patched(c, y, { status: event }));
      return { status: 200, body: { status: event } };
    }
    if (event === 'failed') {
      const step = typeof b.step === 'string' ? b.step.slice(0, 64) : 'unknown';
      const message = typeof b.message === 'string' ? b.message.slice(0, 4096) : 'the build failed';
      // The record is written inside the update, so a refused report leaves none.
      await withBuild(async (y, c) => {
        await prov.append({
          stream,
          kind: 'build',
          subject: `host:${host}`,
          body: { handle: build.handle!, outcome: 'failed', step, message },
        });
        return patched(c, y, { status: 'failed', reason: { message, step } });
      });
      return { status: 200, body: { status: 'failed' } };
    }
    if (event !== 'built')
      throw new CpError('invalid_request', 'event must be building, probing, built or failed');
    // The build record (T) and the manifest (S), as the host's files: kept in the store byte for
    // byte, so an offline check can read exactly what was reported.
    if (typeof b.templateRecord !== 'string' || typeof b.manifest !== 'string') {
      throw new CpError(
        'invalid_request',
        'a built report carries templateRecord and manifest, each its file as a string',
      );
    }
    let t: Record<string, unknown>;
    let sm: Record<string, unknown>;
    try {
      t = asRecord(JSON.parse(b.templateRecord));
      sm = asRecord(JSON.parse(b.manifest));
    } catch {
      throw new CpError('invalid_request', 'templateRecord and manifest must be JSON');
    }
    const tSha = await prov.putBlob(Buffer.from(b.templateRecord, 'utf8'));
    const sSha = await prov.putBlob(Buffer.from(b.manifest, 'utf8'));
    const { record: policyRecord } = await policy.current();
    const manifestHash = String(t.manifest_hash);
    // Set inside the update (a closure TypeScript's narrowing does not follow).
    const verdict: { failed?: { rule: string; message?: string } } = {};
    // The status re-check, the registration check and both records happen inside the update, so
    // a cancel either lands first (this report is refused, and no record says it registered) or
    // after (it finds the build registered or rejected, and refuses).
    await withBuild(async (y, c) => {
      const buildRec = await prov.append({
        stream,
        kind: 'build',
        subject: `host:${host}`,
        body: {
          handle: build.handle!,
          outcome: 'built',
          manifest_hash: String(t.manifest_hash ?? ''),
          template_record_sha256: tSha,
          manifest_sha256: sSha,
          worker: String(t.worker ?? ''),
          snapshot: String(t.snapshot ?? ''),
        },
      });
      // Registration (§8.2): automatic, by policy, never a person.
      const results = registrationResults(y, t, sm);
      // A build id names one build of a template: a second build of the same snapshot (the same
      // image and spec, created again with another gate record or profile) is not registered
      // beside the first.
      const twin = c.builds.find((x) => x !== y && x.buildId === manifestHash);
      results.push(
        twin
          ? {
              rule: 'T.unique',
              passed: false,
              message: `another build of this template (${twin.handle ?? twin.buildId}, ${twin.status}) already has this manifest hash`,
            }
          : { rule: 'T.unique', passed: true },
      );
      const failed = results.find((r) => !r.passed);
      verdict.failed = failed;
      await prov.append({
        stream,
        kind: 'check',
        subject: 'policy',
        body: {
          policy: policyRecord,
          profile: y.profile,
          at: 'registration',
          build: recordDigest(buildRec.record),
          outcome: failed ? 'rejected' : 'registered',
          results: results as unknown as Record<string, unknown>[],
        },
      });
      const next = failed
        ? patched(c, y, {
            status: 'rejected',
            reason: { message: failed.message ?? failed.rule, rule: failed.rule },
          })
        : patched(c, y, {
            status: 'registered',
            buildId: manifestHash,
            worker: String(t.worker ?? ''),
          });
      // A first registered build of a template takes `default` (§3.2); later ones are tagged by the owner.
      return !failed && c.tags.default === undefined
        ? { ...next, tags: { ...c.tags, default: manifestHash } }
        : next;
    });
    const { failed } = verdict;
    const outcome = failed ? 'rejected' : 'registered';
    return {
      status: 200,
      body: { status: outcome, ...(failed ? { rule: failed.rule } : { buildId: manifestHash }) },
    };
  },
};

/**
 * The wanted answer (§6.3), for GET /v1/hosts/{host}/wanted: `run` in the wanted order (first
 * leased first, the order the agent starts them in), `stop`, and `starting` (§6.5). `grace`: the
 * host has an idle grace (§6.5): its graced builds stay in `run` and are listed in `graced`, and a
 * graced worker displaced for a wanted build is re-checked for a lease at stop time, under the
 * activation lock (so a lease being taken is written, or not yet begun).
 */
async function wantedAnswer(
  deps: CpDeps,
  host: string,
  nowS: number,
  views: HostView[],
  grace: boolean,
) {
  const { cat } = catalogOf(deps);
  const docs = await cat.list();
  const mine = deps.hosts?.get(host);
  // A worker is never stopped under a live sandbox (§6.3): it drains first, and keeps its slot.
  const busy = await busyWorkers(deps, nowS);
  // Read-only: the same placement takeLease judges by (hostViewsOf). With a grace on any host it
  // also says which unleased builds keep their running worker there (`graced`).
  const p = place(docs, views, nowS, busy);
  const run: Record<string, unknown>[] = [];
  const stop: Record<string, unknown>[] = [];
  // The unleased builds this host keeps running in its idle grace, after `run`'s wanted ones (the
  // agent starts nothing for them: their units run).
  const keep: Record<string, unknown>[] = [];
  const displaced: Record<string, unknown>[] = [];
  for (const d of docs) {
    for (const b of d.builds) {
      if (b.status !== 'registered' || !mine || mine.holds[b.buildId] === undefined) continue;
      const entry = { template: d.id, buildId: b.buildId, worker: b.worker };
      if (p.placed.get(b.buildId) === host) {
        run.push(entry);
        continue;
      }
      if (grace && p.graced.get(b.buildId)?.host === host) {
        keep.push(entry);
        continue;
      }
      if (mine.refused) delete mine.refused[b.buildId];
      if (busy.has(b.worker)) continue;
      // Stopped when no lease is left (a displaced graced worker re-checked below), or when it runs
      // here while placement keeps it on another host (one worker id on two hosts): this host's copy
      // stops. "Runs here" is the union placement reads: a held build marked running, or its worker
      // in the memory report's runningWorkers.
      if (liveLeases(b, nowS).length === 0) {
        if (p.displaced.get(b.buildId) === host) displaced.push(entry);
        else stop.push(entry);
        continue;
      }
      const runsHere =
        mine.running.includes(b.buildId) ||
        (b.worker !== '' && (mine.memory?.running ?? []).includes(b.worker));
      if (runsHere) stop.push(entry);
    }
  }
  // A graced worker displaced for a wanted build is the one stop nobody asked for: at stop time,
  // the catalog is read again under the activation lock (no lease half-written), and a build
  // leased since keeps its worker running.
  if (displaced.length > 0) {
    await activationLock(cat).run('activation', async () => {
      const t = seconds(deps);
      for (const e of displaced) {
        const now = (await cat.get(e.template as string))?.builds.find(
          (x) => x.buildId === e.buildId,
        );
        if (now && now.status === 'registered' && liveLeases(now, t).length === 0) stop.push(e);
      }
    });
  }
  // The agent starts `run` in order, as many as its start limit allows: first leased first, the
  // order placement uses, so the oldest activations start first.
  const order = new Map(wantedBuilds(docs, nowS).map((w, i) => [w.build.buildId, i]));
  run.sort((a, b) => order.get(a.buildId as string)! - order.get(b.buildId as string)!);
  // The graced builds stay in `run` (their units keep running), soonest grace end first, and are
  // listed in `graced` so the agent counts them without guessing.
  keep.sort(
    (a, b) =>
      p.graced.get(a.buildId as string)!.until - p.graced.get(b.buildId as string)!.until ||
      ((a.buildId as string) < (b.buildId as string) ? -1 : 1),
  );
  run.push(...keep);
  // Of `run`, the builds whose worker is not attached to the relay (its presence, as readiness
  // reads it); the agent counts those whose unit it runs as starting. Absent when the presence
  // cannot be read: the agent then counts its own recent starts.
  let starting: string[] | undefined;
  if (deps.presence) {
    try {
      const attached = new Map(
        (await deps.presence.list()).map((r) => [r.sandboxId, r.capacityMax]),
      );
      starting = unattachedPlaced(docs, p, attached, nowS)
        .filter((x) => x.host === host)
        .map((x) => x.buildId);
    } catch {
      starting = undefined;
    }
  }
  return {
    status: 200,
    body: {
      run,
      stop,
      ...(starting ? { starting } : {}),
      ...(grace ? { graced: keep.map((x) => x.buildId as string) } : {}),
    },
  };
}
