import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.4), as pure functions over the catalog, the hosts'
 * inventories and the relay's presence, so the rules are testable without a host:
 *
 *   - a build is WANTED active while any subject holds an unexpired lease on it (§6.3); aging is
 *     a lease running out, never a deactivation behind a holder's back;
 *   - it is PLACED on a host that holds its snapshot (by manifest hash, §6.1), within that host's
 *     activeLimit and, where the host reports its memory, within its memory headroom (§6.2,
 *     memory): the holding host with the fewest wanted builds, then by id;
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
  /** Σ cost(placed here this pass, not running yet): not in the host's MemAvailable yet. */
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

/** The wanted builds, their leases' earliest start breaking ties: first leased, first placed. */
export function wantedBuilds(
  docs: TemplateDoc[],
  nowS: number,
): { doc: TemplateDoc; build: TemplateBuild; since: number }[] {
  const out: { doc: TemplateDoc; build: TemplateBuild; since: number }[] = [];
  for (const doc of docs) {
    for (const build of doc.builds) {
      if (build.status !== 'registered') continue;
      const live = liveLeases(build, nowS);
      if (live.length === 0) continue;
      out.push({ doc, build, since: Math.min(...live.map((l) => l.since ?? l.until)) });
    }
  }
  return out.sort((a, b) => a.since - b.since || (a.build.buildId < b.build.buildId ? -1 : 1));
}

/**
 * Placement (§6.2, with its memory rule). In the wanted order (first leased, first
 * placed), each build goes to a host that holds it and is under its activeLimit, the one with the
 * fewest builds placed this pass, then by id; a memory-reporting host already running the build's
 * worker comes first. A build no host holds is `not_held`; one whose every holder is full is
 * `no_slot`.
 *
 * A host that reports its memory figures must also have room for the build, unless it already runs
 * the build's worker (that is paid for, and a running worker is never evicted):
 *   pending  = Σ cost(placed here this pass, its worker not running yet)
 *   used     = Σ cost(running workers) + Σ vmCommittedMib + pending
 *   headroom = min(total − floor − used, available − floor − pending)
 * (MemAvailable already reflects what runs, so only the pending starts come off it: two builds
 * placed in one pass both count against the same host, whichever bound binds)
 * and it fits if cost ≤ headroom; a build that fits no holder under its limit is `memory`. A host
 * whose inventory is older than memoryStaleS, or whose PSI `full avg10` is above its limit, takes no
 * new start (what it runs is kept). A build in a host's memfileMismatch is never placed there (every
 * holder: `memfile_mismatch`). A host with no memory figures is placed as before.
 *
 * "Running" is the agent's own report (`runningWorkers`: the sbx-worker units active on that
 * host), not the relay's presence: a worker pins its memfile from its start, before it attaches,
 * and presence does not say which host a worker is on.
 */
export function place(docs: TemplateDoc[], hosts: HostView[], nowS: number): Placement {
  const placed = new Map<string, string>();
  const unplaced = new Map<string, Unplaced>();
  const count = new Map(hosts.map((h) => [h.id, 0]));
  // Every build's cost by its worker, whatever its status: a draining or retired build's worker
  // that still runs holds its memfile as much as a wanted one's.
  const costByWorker = new Map<string, number>();
  for (const d of docs)
    for (const b of d.builds) if (b.worker) costByWorker.set(b.worker, costMib(b));
  const memUse = new Map<string, HostMemoryUse>();
  const running = new Map<string, Set<string>>();
  for (const h of hosts) {
    const m = h.memory;
    running.set(h.id, new Set(m?.running ?? []));
    if (m?.totalMib === undefined || m.availableMib === undefined || m.floorMib === undefined)
      continue;
    let used = 0;
    for (const w of running.get(h.id)!)
      used += costByWorker.get(w) ?? defaultCostMib + workerOverheadMib;
    for (const v of Object.values(m.vmCommittedMib ?? {})) used += v;
    const brake =
      h.at === undefined || nowS - h.at > memoryStaleS
        ? 'stale'
        : m.pressureFull10 !== undefined &&
            m.pressureLimit !== undefined &&
            m.pressureFull10 > m.pressureLimit
          ? 'pressure'
          : null;
    memUse.set(h.id, { usedMib: used, pendingMib: 0, headroomMib: 0, brake });
  }
  const headroom = (h: HostView): number => {
    const m = h.memory!;
    const u = memUse.get(h.id)!;
    return Math.min(
      m.totalMib! - m.floorMib! - u.usedMib,
      m.availableMib! - m.floorMib! - u.pendingMib,
    );
  };
  for (const { build } of wantedBuilds(docs, nowS)) {
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
    // Only on a host with memory figures: without them placement is exactly as before.
    const isRunning = (h: HostView) =>
      memUse.has(h.id) && build.worker !== '' && running.get(h.id)!.has(build.worker);
    const underLimit = sound.filter((h) => count.get(h.id)! < h.activeLimit);
    const cost = costMib(build);
    const fits = (h: HostView) => {
      const u = memUse.get(h.id);
      if (!u || isRunning(h)) return true;
      return u.brake === null && cost <= headroom(h);
    };
    const free = underLimit
      .filter(fits)
      .sort(
        (a, b) =>
          Number(isRunning(b)) - Number(isRunning(a)) ||
          count.get(a.id)! - count.get(b.id)! ||
          (a.id < b.id ? -1 : 1),
      );
    if (free.length === 0) {
      unplaced.set(build.buildId, underLimit.length > 0 ? 'memory' : 'no_slot');
      continue;
    }
    const to = free[0]!;
    placed.set(build.buildId, to.id);
    count.set(to.id, count.get(to.id)! + 1);
    const u = memUse.get(to.id);
    if (u && !isRunning(to)) {
      u.usedMib += cost;
      u.pendingMib += cost;
    }
  }
  for (const h of hosts) {
    const u = memUse.get(h.id);
    // A braked host has none for a new start, whatever the figures (the brake says why).
    if (u) u.headroomMib = u.brake === null ? Math.max(0, headroom(h)) : 0;
  }
  return { placed, unplaced, memory: memUse };
}

/**
 * Readiness of a registered build (§3.3), from what is wanted, placed and attached. `p` is null on
 * a deployment where no host agent has reported: readiness is then the worker's presence alone.
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
  if (!p) return isAttached ? 'active' : 'inactive';
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
