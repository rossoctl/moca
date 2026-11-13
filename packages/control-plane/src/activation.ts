import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.4), as pure functions over the catalog, the hosts'
 * inventories and the relay's presence, so the rules are testable without a host:
 *
 *   - a build is WANTED active while any subject holds an unexpired lease on it (§6.3); aging is
 *     a lease running out, never a deactivation behind a holder's back;
 *   - it is PLACED on a host that holds its snapshot (by manifest hash, §6.1): on the host already
 *     running its worker, if one is (placement is sticky: a running build never moves), else within
 *     a holder's activeLimit, the one with the fewest workers counted, then by id. A host's count
 *     is every worker that stays running on it: the wanted builds placed or running there, and the
 *     unleased ones still draining a live sandbox;
 *   - over a host's limit, the newest leases wait: a held build is never evicted to make room,
 *     and the activation that cannot be placed is refused with no_active_slot (§6.3);
 *   - a subject holds at most quota.active builds at once.
 *
 * "Activation lease" here is a subject's timed claim that a build be kept running on some host. It
 * is neither the sandbox lease mode (a warm guest kept for one sandbox between Execs) nor the
 * harness's run lease (harness/src/sandbox-lease.ts); nothing is shared with either.
 */

export interface HostView {
  id: string;
  /** manifest hash -> template id */
  holds: Record<string, string>;
  activeLimit: number;
  /** The builds (manifest hashes) whose worker unit the host last said is running. */
  running?: string[];
}

/** Why a wanted build is not placed: no host holds it, or every holder is at its activeLimit. */
export type Unplaced = 'not_held' | 'no_slot';

export interface Placement {
  /** buildId -> host id, for every wanted build that fits. */
  placed: Map<string, string>;
  /** Wanted builds that fit nowhere. */
  unplaced: Map<string, Unplaced>;
  /** host id -> the workers counted against its activeLimit (placed, running and draining). */
  used: Map<string, number>;
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

/** A build an admin rejected after the fact (§5.2), as against one policy rejected at registration. */
export const rejectedByAdmin = (b: TemplateBuild): boolean =>
  b.status === 'rejected' && b.reason?.rule === 'admin';

/**
 * A build whose use has ended while its worker may still run (draining a live sandbox until its
 * host stops it): a retired one (§5.1), or one an admin rejected after the fact (§5.2). One
 * rejected at registration never had a worker.
 */
export const endedWithWorker = (b: TemplateBuild): boolean =>
  (b.status === 'retired' || rejectedByAdmin(b)) && b.worker !== '';

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
 * Placement (§6.2). Each host's count starts at the workers that stay running on it whatever this
 * pass decides: the wanted builds it runs, and the unleased ones it runs whose worker has a live
 * sandbox (`busy`: they drain, and are never stopped under one), retired builds included. Then, in
 * the wanted order (first leased, first placed), a build already running on a holder stays there
 * (the first by id, when more than one runs it), counted already; any other goes to a holder under
 * its activeLimit, the one with the lowest count, then by id. A build no host holds is `not_held`; one whose every
 * holder is full is `no_slot`.
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
  // A retired build's worker still draining a live sandbox keeps running too (§5.1), and so does
  // one an admin rejected after the fact (§5.2), so it counts.
  for (const d of docs)
    for (const b of d.builds)
      if (b.status === 'registered' || endedWithWorker(b)) workerOf.set(b.buildId, b.worker);
  const stays = (id: string) =>
    workerOf.has(id) && (wantedIds.has(id) || busy.has(workerOf.get(id)!));
  const used = new Map(hosts.map((h) => [h.id, (h.running ?? []).filter(stays).length]));
  for (const { build } of wanted) {
    const holders = hosts.filter((h) => h.holds[build.buildId] !== undefined);
    if (holders.length === 0) {
      unplaced.set(build.buildId, 'not_held');
      continue;
    }
    const runs = holders.find((h) => h.running?.includes(build.buildId));
    if (runs) {
      placed.set(build.buildId, runs.id);
      continue;
    }
    const free = holders
      .filter((h) => used.get(h.id)! < h.activeLimit)
      .sort((a, b) => used.get(a.id)! - used.get(b.id)! || (a.id < b.id ? -1 : 1));
    if (free.length === 0) {
      unplaced.set(build.buildId, 'no_slot');
      continue;
    }
    placed.set(build.buildId, free[0]!.id);
    used.set(free[0]!.id, used.get(free[0]!.id)! + 1);
  }
  return { placed, unplaced, used };
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
