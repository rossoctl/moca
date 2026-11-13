import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.4), as pure functions over the catalog, the hosts'
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
 *   - a subject holds at most quota.active builds at once.
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
  /** host id -> the workers counted against its activeLimit (placed, running and draining). */
  used: Map<string, number>;
  /** Per host that reports its memory figures: its use after this placement. */
  memory: Map<string, HostMemoryUse>;
}

/** A worker's fixed overhead beside its guest's RAM: the VMM and the worker itself (§6.2). */
export const workerOverheadMib = 128;
/** The guest size of a build that recorded none (imported, or older than the manifest's field). */
export const defaultCostMib = 4096;
/** An inventory older than this gives its host no headroom for new starts (four missed reports). */
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
 * runs whose worker has a live sandbox (`busy`: they drain, and are never stopped under one). Then,
 * in the wanted order (first leased, first placed), a build already running on a holder stays there
 * (the first by id, when more than one runs it), counted already and paid for; any other goes to a
 * holder under its activeLimit, the one with the lowest count, then by id. A build no host holds is
 * `not_held`; one whose every holder is full is `no_slot`.
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
 * start, before it attaches, and presence does not say which host a worker is on.
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
  const buildOfWorker = new Map<string, string>();
  for (const d of docs)
    for (const b of d.builds)
      if (b.status === 'registered') {
        workerOf.set(b.buildId, b.worker);
        if (b.worker) buildOfWorker.set(b.worker, b.buildId);
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
  for (const h of hosts) {
    const m = h.memory;
    if (m?.totalMib === undefined || m.availableMib === undefined || m.floorMib === undefined)
      continue;
    let usedMib = 0;
    let pendingMib = 0;
    const inInventory = new Set(m.running ?? []);
    for (const w of runningWorkers.get(h.id)!) {
      const c = costByWorker.get(w) ?? defaultCostMib + workerOverheadMib;
      usedMib += c;
      // Started since the inventory (an attached report newer than it): its MemAvailable cannot
      // show it yet, so it comes off that bound too, as a start placed this pass would.
      if (!inInventory.has(w)) pendingMib += c;
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
  const headroom = (h: HostView): number => {
    const m = h.memory!;
    const u = memUse.get(h.id)!;
    return Math.min(
      m.totalMib! - m.floorMib! - u.usedMib,
      m.availableMib! - m.floorMib! - u.pendingMib,
    );
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
    // Sticky: a holder already running it keeps it, counted already, its memory paid for.
    const runs = sound
      .filter((h) => runningBuilds.get(h.id)!.has(build.buildId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (runs) {
      placed.set(build.buildId, runs.id);
      continue;
    }
    const underLimit = sound.filter((h) => used.get(h.id)! < h.activeLimit);
    const cost = costMib(build);
    const fits = (h: HostView) => {
      const u = memUse.get(h.id);
      return !u || (u.brake === null && cost <= headroom(h));
    };
    const free = underLimit
      .filter(fits)
      .sort((a, b) => used.get(a.id)! - used.get(b.id)! || (a.id < b.id ? -1 : 1));
    if (free.length === 0) {
      unplaced.set(build.buildId, underLimit.length > 0 ? 'memory' : 'no_slot');
      continue;
    }
    const to = free[0]!;
    placed.set(build.buildId, to.id);
    used.set(to.id, used.get(to.id)! + 1);
    const u = memUse.get(to.id);
    if (u) {
      u.usedMib += cost;
      u.pendingMib += cost;
    }
  }
  for (const h of hosts) {
    const u = memUse.get(h.id);
    // A braked host has none for a new start, whatever the figures (the brake says why).
    if (u) u.headroomMib = u.brake === null ? Math.max(0, headroom(h)) : 0;
  }
  return { placed, unplaced, used, memory: memUse };
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
