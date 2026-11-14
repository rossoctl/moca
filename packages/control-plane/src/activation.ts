import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.5), as pure functions over the catalog, the hosts'
 * inventories and the relay's presence, so the rules are testable without a host:
 *
 *   - a build is WANTED active while any subject holds an unexpired lease on it (§6.3); aging is
 *     a lease running out, never a deactivation behind a holder's back;
 *   - it is PLACED on a host that holds its snapshot (by manifest hash, §6.1): on the host already
 *     running its worker, if one is (placement is sticky: a running build never moves), else within
 *     a holder's activeLimit and, where the host reports its memory, within its memory headroom
 *     (§6.2, memory), the one with the fewest workers counted, then by id. A host's count is every
 *     worker that stays running on it: the wanted builds placed or running there, and the unleased
 *     ones still draining a live sandbox;
 *   - over a host's limit, the newest leases wait: a held build is never evicted to make room,
 *     and the activation that cannot be placed is refused with no_active_slot (§6.3);
 *   - a subject holds at most quota.active builds at once;
 *   - a host starts at most its startConcurrency workers at once (§6.5): a placed build beyond it
 *     waits in the host's start line, `activating`, queued;
 *   - on a host with an idle grace (SBX_IDLE_GRACE_S > 0, §6.5), a build whose last lease has
 *     ended keeps its running worker for that long (GRACED), in a slot no wanted build needs: a
 *     wanted build that needs the slot (or the memory) displaces it, the only stop of a worker
 *     nobody asked to stop, and only of one with no lease.
 *
 * "Activation lease" here is a subject's timed claim that a build be kept running on some host. It
 * is neither the sandbox lease mode (a warm guest kept for one sandbox between Execs) nor the
 * harness's run lease (harness/src/sandbox-lease.ts); nothing is shared with either.
 */

/**
 * What a host's agent reports about its memory (§6.2, memory). Every field is
 * optional: an older agent sends none, and its host is placed by activeLimit alone.
 */
export interface HostMemory {
  /** MemTotal, MemAvailable and the effective floor, in MiB: all three, or none (no memory test). */
  totalMib?: number;
  availableMib?: number;
  floorMib?: number;
  /** Memory PSI `full avg10`, a percentage; absent with no /proc/pressure (no brake). */
  pressureFull10?: number;
  pressureLimit?: number;
  /** The worker ids whose sbx-worker unit runs on the host now: each holds its pinned memfile. */
  running?: string[];
  /** Worker id -> what its running VMs hold beyond the pinned memfile, MiB. */
  vmCommittedMib?: Record<string, number>;
  /** Manifest hashes whose memfile is not guest_ram_mb x 1 MiB there: never placed on this host. */
  memfileMismatch?: string[];
}

export interface HostView {
  id: string;
  /** manifest hash -> template id */
  holds: Record<string, string>;
  activeLimit: number;
  /**
   * Epoch seconds of its last inventory (the memory test's 60 s staleness): a host with memory
   * figures and no `at` is taken as stale.
   */
  at?: number;
  /** The builds (manifest hashes) whose worker unit the host last said is running. */
  running?: string[];
  memory?: HostMemory;
  /**
   * Its agent's start limit and measured cold-start time (§6.5): absent from an older agent, and
   * then its builds' readiness carries no queue position.
   */
  start?: HostStart;
  /**
   * SBX_IDLE_GRACE_S: how long a released build's running worker is kept, in seconds; absent or 0
   * (off, and from an older agent): stopped as soon as it is not wanted.
   */
  idleGraceSeconds?: number;
}

/** What a host's agent reports of its starts (§6.5). */
export interface HostStart {
  /** SBX_START_CONCURRENCY: at most this many workers starting (started, not attached) at once. */
  concurrency: number;
  /** The mean of its last cold starts, start to attach, in seconds; absent before one is done. */
  seconds?: number;
}

/**
 * Why a wanted build is not placed: no host holds it (not_held), every holder is at its
 * activeLimit (no_slot), a holder under its limit has no memory for it (memory), or every holder
 * reports its memory file wrong (memfile_mismatch).
 */
export type Unplaced = 'not_held' | 'no_slot' | 'memory' | 'memfile_mismatch';

/** A memory-reporting host's figures after placement (the hosts block shows them). */
export interface HostMemoryUse {
  /** Σ cost(running workers) + Σ vmCommittedMib + pendingMib. */
  usedMib: number;
  /**
   * Σ cost(placed here this pass, not running yet; or started since the inventory, by an attached
   * report): not in the host's MemAvailable yet.
   */
  pendingMib: number;
  /** min(total − floor − used, available − floor − pending), at least 0; 0 while braked. */
  headroomMib: number;
  /** Why the host takes no new start whatever its headroom: null when it takes them. */
  brake: 'pressure' | 'stale' | null;
}

export interface Placement {
  /** buildId -> host id, for every wanted build that fits. */
  placed: Map<string, string>;
  /** Wanted builds that fit nowhere, and why. */
  unplaced: Map<string, Unplaced>;
  /**
   * host id -> the workers counted against its activeLimit (placed, running and draining); its
   * graced builds take slots too, and are counted apart, in `graced`.
   */
  used: Map<string, number>;
  /** Per host that reports its memory figures: its use after this placement. */
  memory: Map<string, HostMemoryUse>;
  /**
   * Builds in their host's idle grace: no live lease, their worker running there, kept until
   * `until` (epoch seconds) in a slot no wanted build needs. Empty without a grace.
   */
  graced: Map<string, Graced>;
  /**
   * Builds that were in their host's idle grace and gave it up (buildId -> host): a wanted build
   * needed the slot or the memory, or the host is over its memory with them. Stopped.
   */
  displaced: Map<string, string>;
}

/** A build kept in its host's idle grace. */
export interface Graced {
  host: string;
  /** Epoch seconds: its last lease's end plus the host's idleGraceSeconds. */
  until: number;
}

/** A worker's fixed overhead beside its guest's RAM: the VMM and the worker itself (§6.2). */
export const workerOverheadMib = 128;
/** The guest size of a build that recorded none (imported, or older than the manifest's field). */
export const defaultCostMib = 4096;
/**
 * An inventory older than this gives its host no headroom for new starts (four missed reports).
 * The first of two steps: after about 60 s without an inventory this brake stops new starts on a
 * memory-reporting host (what it runs is kept); at host-handlers.ts's HOST_STALE_S (360 s) the host
 * leaves placement entirely.
 */
export const memoryStaleS = 60;

/**
 * A build's memory cost on a host (§6.2): its guest's RAM, which its worker pins whole (a Full
 * snapshot), plus the fixed overhead. The guest size is the registered spec's (`guest_mb`, checked
 * against the manifest's guest_ram_mb at registration), else the create's; a build with none counts
 * at defaultCostMib, plus the overhead, so nothing older is undercounted.
 */
export function costMib(b: TemplateBuild): number {
  const pos = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);
  const guest =
    pos(b.spec.guest_mb) ||
    pos(b.request?.spec.guest_mb) ||
    pos(b.request?.spec.guest_ram_mb) ||
    defaultCostMib;
  return guest + workerOverheadMib;
}

export const liveLeases = (b: TemplateBuild, nowS: number) =>
  (b.leases ?? []).filter((l) => l.until > nowS);

/**
 * When a build's last lease ended, epoch seconds: the latest of its recorded
 * `lastLeaseEnd` (a deactivate's time, or an expired lease's end it cleared) and the ends of its
 * expired leases still stored. Undefined when it has none (never leased, or released before
 * the idle grace existed).
 */
export function lastLeaseEnd(b: TemplateBuild, nowS: number): number | undefined {
  let end = b.lastLeaseEnd;
  for (const l of b.leases ?? [])
    if (l.until <= nowS && (end === undefined || l.until > end)) end = l.until;
  return end;
}

/**
 * Until when a build would be in an idle grace of `graceS` seconds: its last lease's
 * end plus the grace, or undefined when none applies (a live lease, no recorded end, a grace of 0,
 * or a release with stopNow since that end). Whether it is graced also needs its worker running on
 * a host with room: place() decides that.
 */
export function graceUntil(b: TemplateBuild, graceS: number, nowS: number): number | undefined {
  if (graceS <= 0 || b.status !== 'registered' || liveLeases(b, nowS).length > 0) return undefined;
  const end = lastLeaseEnd(b, nowS);
  if (end === undefined || (b.stopNowAt !== undefined && end <= b.stopNowAt)) return undefined;
  return end + graceS;
}

/**
 * Whether a host agent can hold, run and stop this build: one registered from a host's build, named
 * by its snapshot's manifest hash (§6.1). A build imported from SH_SANDBOX_TEMPLATES
 * (`imported:<12 hex>`) names no snapshot, so no host's inventory ever holds it: the deployment runs
 * its worker. Such a build takes no lease, is never placed, and its readiness is its worker's
 * presence alone, on every deployment, with host agents or without.
 */
export const hostManaged = (b: TemplateBuild): boolean => b.buildId.startsWith('sha256:');

/** The wanted builds, their leases' earliest start breaking ties: first leased, first placed. */
export function wantedBuilds(
  docs: TemplateDoc[],
  nowS: number,
): { doc: TemplateDoc; build: TemplateBuild; since: number }[] {
  const out: { doc: TemplateDoc; build: TemplateBuild; since: number }[] = [];
  for (const doc of docs) {
    for (const build of doc.builds) {
      if (build.status !== 'registered' || !hostManaged(build)) continue;
      const live = liveLeases(build, nowS);
      if (live.length === 0) continue;
      out.push({ doc, build, since: Math.min(...live.map((l) => l.since ?? l.until)) });
    }
  }
  return out.sort((a, b) => a.since - b.since || (a.build.buildId < b.build.buildId ? -1 : 1));
}

/**
 * Placement (§6.2, with its memory rule). Each host's count starts at the workers that stay
 * running on it whatever this pass decides: the wanted builds it runs, and the unleased ones it
 * runs whose worker has a live sandbox (`busy`: they drain, and are never stopped under one),
 * retired builds included. Then, in the wanted order (first leased, first placed), a build already
 * running on a holder stays there (the first by id, when more than one runs it), counted already
 * and paid for: no start at all (§6.5), and no displacement for it; any other goes to a holder
 * under its activeLimit, the one that fits without displacing a graced build first, then the
 * lowest count, then by id. A build no host holds is `not_held`; one whose every holder is full is
 * `no_slot`.
 *
 * A host that reports its memory figures must also have room for a build it does not run yet:
 *   pending  = Σ cost(placed here this pass, its worker not running yet; or running by an attached
 *              report newer than the inventory, so not in its MemAvailable yet)
 *   used     = Σ cost(running workers) + Σ vmCommittedMib + pending
 *   headroom = min(total − floor − used, available − floor − pending)
 * (MemAvailable already reflects what runs, so only the pending starts come off it: two builds
 * placed in one pass both count against the same host, whichever bound binds)
 * and it fits if cost ≤ headroom; a build that fits no holder under its limit is `memory`. A host
 * whose inventory is older than memoryStaleS, or whose PSI `full avg10` is above its limit, takes no
 * new start (what it runs is kept: a running worker is never evicted). A build in a host's
 * memfileMismatch is never placed there, not even where it runs (every holder: `memfile_mismatch`).
 * A host with no memory figures is placed by its activeLimit alone.
 *
 * "Running" is the agent's own report, not the relay's presence: the held builds it marks running
 * (kept current by its attached and detached reports) and its memory's `runningWorkers` (the
 * sbx-worker units active on that host), the union of both. A worker pins its memfile from its
 * start, before it attaches, and presence does not say which host a worker is on. A worker in its
 * idle grace still runs its unit, so its memory is in `used` with no change.
 *
 * The idle grace (§6.5): on a host with idleGraceSeconds > 0, a registered build with no live
 * lease and no live sandbox (`busy`), whose worker runs there, is a grace candidate until
 * graceUntil(). It is not in the host's count above (neither wanted nor draining), but each
 * candidate takes a slot of the host's activeLimit; a wanted build that would otherwise not fit a
 * holder (no slot, or no memory) displaces the candidates that end soonest there, as few as fit it.
 * Only a candidate is ever displaced: never a leased build, never a worker under a live sandbox. A
 * candidate leased again is wanted and running, so it stays where it runs (sticky). A host still
 * over its memory with its candidates (headroom below 0), or with more of them than free slots,
 * drops the soonest-ending. The rest are `graced` (not in `used`); the dropped ones `displaced`.
 * With no grace anywhere, placement is exactly as without one.
 */
export function place(
  docs: TemplateDoc[],
  hosts: HostView[],
  nowS: number,
  busy: ReadonlySet<string> = new Set(),
): Placement {
  const placed = new Map<string, string>();
  const unplaced = new Map<string, Unplaced>();
  const wanted = wantedBuilds(docs, nowS);
  const wantedIds = new Set(wanted.map((w) => w.build.buildId));
  const workerOf = new Map<string, string>();
  // A retired build's worker still draining a live sandbox keeps running too (§5.1), so it counts.
  const buildOfWorker = new Map<string, string>();
  for (const d of docs)
    for (const b of d.builds)
      if (b.status === 'registered' || (b.status === 'retired' && b.worker !== '')) {
        workerOf.set(b.buildId, b.worker);
        // A worker a registered build shares is that build's; a retired one's own is its own.
        if (b.worker && (b.status === 'registered' || !buildOfWorker.has(b.worker)))
          buildOfWorker.set(b.worker, b.buildId);
      }
  // Every build's cost by its worker, whatever its status: a draining or retired build's worker
  // that still runs holds its memfile as much as a wanted one's.
  const costByWorker = new Map<string, number>();
  for (const d of docs)
    for (const b of d.builds) if (b.worker) costByWorker.set(b.worker, costMib(b));
  // What each host runs, by build and by worker: its held builds marked running, and its memory's
  // runningWorkers, the union of both (one may be newer than the other between inventories).
  const runningBuilds = new Map<string, Set<string>>();
  const runningWorkers = new Map<string, Set<string>>();
  for (const h of hosts) {
    const rb = new Set(h.running ?? []);
    const rw = new Set(h.memory?.running ?? []);
    for (const w of rw) if (buildOfWorker.has(w)) rb.add(buildOfWorker.get(w)!);
    for (const id of rb) if (workerOf.get(id)) rw.add(workerOf.get(id)!);
    runningBuilds.set(h.id, rb);
    runningWorkers.set(h.id, rw);
  }
  const stays = (id: string) =>
    workerOf.has(id) && (wantedIds.has(id) || busy.has(workerOf.get(id)!));
  const used = new Map(
    hosts.map((h) => [h.id, [...runningBuilds.get(h.id)!].filter(stays).length]),
  );
  const memUse = new Map<string, HostMemoryUse>();
  // Per memory-reporting host, the running workers its last inventory shows (in its MemAvailable).
  const inInventory = new Map<string, Set<string>>();
  for (const h of hosts) {
    const m = h.memory;
    if (m?.totalMib === undefined || m.availableMib === undefined || m.floorMib === undefined)
      continue;
    let usedMib = 0;
    let pendingMib = 0;
    const inv = new Set(m.running ?? []);
    inInventory.set(h.id, inv);
    for (const w of runningWorkers.get(h.id)!) {
      const c = costByWorker.get(w) ?? defaultCostMib + workerOverheadMib;
      usedMib += c;
      // Started since the inventory (an attached report newer than it): its MemAvailable cannot
      // show it yet, so it comes off that bound too, as a start placed this pass would.
      if (!inv.has(w)) pendingMib += c;
    }
    for (const v of Object.values(m.vmCommittedMib ?? {})) usedMib += v;
    const brake =
      h.at === undefined || nowS - h.at > memoryStaleS
        ? 'stale'
        : m.pressureFull10 !== undefined &&
            m.pressureLimit !== undefined &&
            m.pressureFull10 > m.pressureLimit
          ? 'pressure'
          : null;
    memUse.set(h.id, { usedMib, pendingMib, headroomMib: 0, brake });
  }
  // The memory displaced grace candidates free once stopped, of those the inventory shows: their
  // MemAvailable does not show it free yet.
  const freedMib = new Map<string, number>();
  const headroom = (h: HostView): number => {
    const m = h.memory!;
    const u = memUse.get(h.id)!;
    return Math.min(
      m.totalMib! - m.floorMib! - u.usedMib,
      m.availableMib! - m.floorMib! - u.pendingMib + (freedMib.get(h.id) ?? 0),
    );
  };
  // Each host's grace candidates, soonest-ending first (the first displaced).
  type Candidate = { buildId: string; worker: string; cost: number; until: number };
  const candidates = new Map<string, Candidate[]>();
  const taken = new Set<string>();
  for (const h of [...hosts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const g = h.idleGraceSeconds ?? 0;
    if (g <= 0) continue;
    const list: Candidate[] = [];
    for (const d of docs) {
      for (const b of d.builds) {
        if (taken.has(b.buildId) || h.holds[b.buildId] === undefined) continue;
        if (b.worker === '' || !runningBuilds.get(h.id)!.has(b.buildId) || busy.has(b.worker))
          continue;
        const until = graceUntil(b, g, nowS);
        if (until === undefined || nowS >= until) continue;
        list.push({ buildId: b.buildId, worker: b.worker, cost: costMib(b), until });
        taken.add(b.buildId);
      }
    }
    list.sort((a, b) => a.until - b.until || (a.buildId < b.buildId ? -1 : 1));
    if (list.length) candidates.set(h.id, list);
  }
  const displaced = new Map<string, string>();
  const displace = (h: HostView, k: number) => {
    const list = candidates.get(h.id) ?? [];
    const u = memUse.get(h.id);
    for (const c of list.splice(0, k)) {
      displaced.set(c.buildId, h.id);
      if (!u) continue;
      // Both bounds gain its cost: off `used`, and either back on MemAvailable (the inventory
      // shows it) or off `pending` (started since the inventory, counted there).
      u.usedMib -= c.cost;
      if (inInventory.get(h.id)!.has(c.worker))
        freedMib.set(h.id, (freedMib.get(h.id) ?? 0) + c.cost);
      else u.pendingMib -= c.cost;
    }
  };
  for (const { build } of wanted) {
    const holders = hosts.filter((h) => h.holds[build.buildId] !== undefined);
    if (holders.length === 0) {
      unplaced.set(build.buildId, 'not_held');
      continue;
    }
    const sound = holders.filter((h) => !(h.memory?.memfileMismatch ?? []).includes(build.buildId));
    if (sound.length === 0) {
      unplaced.set(build.buildId, 'memfile_mismatch');
      continue;
    }
    // Sticky: a holder already running it keeps it, counted already, its memory paid for (a graced
    // worker leased again among them: it is no longer a candidate, so never displaced).
    const runs = sound
      .filter((h) => runningBuilds.get(h.id)!.has(build.buildId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (runs) {
      placed.set(build.buildId, runs.id);
      continue;
    }
    const underLimit = sound.filter((h) => used.get(h.id)! < h.activeLimit);
    const cost = costMib(build);
    // How many of the host's grace candidates must give way for this build (0: none), or null
    // when it does not fit even with all of them gone. A grace candidate holds a slot, and its
    // memory is in `used` (its worker runs); displacing k frees both.
    const need = (h: HostView): number | null => {
      const list = candidates.get(h.id) ?? [];
      const u = memUse.get(h.id);
      let freed = 0;
      for (let k = 0; k <= list.length; k++) {
        if (k > 0) freed += list[k - 1]!.cost;
        if (used.get(h.id)! + list.length - k >= h.activeLimit) continue;
        if (!u) return k;
        if (u.brake !== null) return null;
        if (cost <= headroom(h) + freed) return k;
      }
      return null;
    };
    const free = underLimit
      .map((h) => ({ h, k: need(h) }))
      .filter((x): x is { h: HostView; k: number } => x.k !== null)
      .sort(
        (a, b) => a.k - b.k || used.get(a.h.id)! - used.get(b.h.id)! || (a.h.id < b.h.id ? -1 : 1),
      );
    if (free.length === 0) {
      unplaced.set(build.buildId, underLimit.length > 0 ? 'memory' : 'no_slot');
      continue;
    }
    const to = free[0]!.h;
    if (free[0]!.k > 0) displace(to, free[0]!.k);
    placed.set(build.buildId, to.id);
    used.set(to.id, used.get(to.id)! + 1);
    const u = memUse.get(to.id);
    if (u) {
      u.usedMib += cost;
      u.pendingMib += cost;
    }
  }
  // The grace keeps only what the host has room for: free slots, and memory at or above the
  // floor with its graced workers counted; the soonest-ending give way first.
  const graced = new Map<string, Graced>();
  for (const h of hosts) {
    const list = candidates.get(h.id);
    if (!list) continue;
    const over = used.get(h.id)! + list.length - h.activeLimit;
    if (over > 0) displace(h, over);
    const u = memUse.get(h.id);
    while (u && list.length > 0 && headroom(h) < 0) displace(h, 1);
    for (const c of list) graced.set(c.buildId, { host: h.id, until: c.until });
  }
  for (const h of hosts) {
    const u = memUse.get(h.id);
    // A braked host has none for a new start, whatever the figures (the brake says why).
    if (u) u.headroomMib = u.brake === null ? Math.max(0, headroom(h)) : 0;
  }
  return { placed, unplaced, used, memory: memUse, graced, displaced };
}

/**
 * Readiness of a registered build (§3.3), from what is wanted, placed and attached. `p` is null on
 * a deployment where no host agent has reported: readiness is then the worker's presence alone, as
 * it always is for a build no host can hold (hostManaged).
 */
export function readinessOf(
  build: TemplateBuild,
  nowS: number,
  p: Placement | null,
  attached: Map<string, number> | null,
): 'active' | 'activating' | 'deactivating' | 'inactive' | 'unavailable' | 'unknown' {
  if (attached === null) return 'unknown';
  const isAttached = build.worker !== '' && attached.has(build.worker);
  const wanted = liveLeases(build, nowS).length > 0;
  if (!p || !hostManaged(build)) return isAttached ? 'active' : 'inactive';
  if (wanted) {
    if (p.unplaced.has(build.buildId)) return isAttached ? 'active' : 'unavailable';
    return isAttached ? 'active' : 'activating';
  }
  return isAttached ? 'deactivating' : 'inactive';
}

/** Why an `unavailable` build is (placement's reason); null for any other readiness. */
export function readinessReasonOf(
  build: TemplateBuild,
  readiness: string | null,
  p: Placement | null,
): Unplaced | null {
  return readiness === 'unavailable' ? (p?.unplaced.get(build.buildId) ?? null) : null;
}

/** A build's place in its host's start line. */
export interface StartLine {
  host: string;
  /** 1-based, among the host's placed, wanted builds not attached yet, in the wanted order. */
  position: number;
  /** Beyond the host's startConcurrency: waiting for a start slot, not started yet. */
  queued: boolean;
}

export interface StartQueue {
  /** buildId -> its line, for builds on hosts that report a startConcurrency. */
  byBuild: Map<string, StartLine>;
  /** host -> its starting (within the limit) and queued (beyond it) builds. */
  byHost: Map<string, { starting: number; queued: number }>;
}

/**
 * The builds placed and wanted whose worker is not attached to the relay, in the
 * wanted order (first leased first, the order the agent starts them in), with their host. This is
 * the wanted answer's `starting`: the agent counts those whose unit it runs as starting. Attachment
 * is the relay's presence, as readiness reads it.
 */
export function unattachedPlaced(
  docs: TemplateDoc[],
  p: Placement,
  attached: Map<string, number>,
  nowS: number,
): { buildId: string; host: string }[] {
  const out: { buildId: string; host: string }[] = [];
  for (const { build } of wantedBuilds(docs, nowS)) {
    const host = p.placed.get(build.buildId);
    if (host === undefined) continue;
    if (build.worker !== '' && attached.has(build.worker)) continue;
    out.push({ buildId: build.buildId, host });
  }
  return out;
}

/**
 * Each host's start line (§6.5): of its placed, wanted builds not
 * attached, in the wanted order, the first startConcurrency are starting and the rest queued. Only
 * for hosts whose agent reports its startConcurrency (an older agent's builds have no line). The
 * agent applies the limit; this is the control plane's view of it, for readiness and Retry-After.
 */
export function startQueue(
  docs: TemplateDoc[],
  hosts: HostView[],
  p: Placement,
  attached: Map<string, number>,
  nowS: number,
): StartQueue {
  const limit = new Map<string, number>();
  for (const h of hosts) if (h.start) limit.set(h.id, h.start.concurrency);
  const byBuild = new Map<string, StartLine>();
  const byHost = new Map<string, { starting: number; queued: number }>();
  for (const h of limit.keys()) byHost.set(h, { starting: 0, queued: 0 });
  for (const { buildId, host } of unattachedPlaced(docs, p, attached, nowS)) {
    const n = limit.get(host);
    if (n === undefined) continue;
    const c = byHost.get(host)!;
    const position = c.starting + c.queued + 1;
    const queued = position > n;
    if (queued) c.queued += 1;
    else c.starting += 1;
    byBuild.set(buildId, { host, position, queued });
  }
  return { byBuild, byHost };
}

/**
 * Retry-After for a build in a start line (§6.5): the waves before its start ends,
 * ceil(ceil(position / startConcurrency) x the host's measured start seconds), at least 1; null
 * when the host has measured none (the caller then answers as before).
 */
export function startRetryAfterS(line: StartLine, host: HostView | undefined): number | null {
  const s = host?.start;
  if (!s || s.seconds === undefined || s.concurrency < 1) return null;
  return Math.max(1, Math.ceil(Math.ceil(line.position / s.concurrency) * s.seconds));
}
