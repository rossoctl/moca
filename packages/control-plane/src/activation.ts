import type { TemplateBuild, TemplateDoc } from './template-catalog.js';

/**
 * Activation (template lifecycle spec §6.2-§6.4), as pure functions over the catalog, the hosts'
 * inventories and the relay's presence, so the rules are testable without a host:
 *
 *   - a build is WANTED active while any subject holds an unexpired lease on it (§6.3); aging is
 *     a lease running out, never a deactivation behind a holder's back;
 *   - it is PLACED on a host that holds its snapshot (by manifest hash, §6.1), within that host's
 *     activeLimit: the holding host with the fewest wanted builds, then by id;
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
}

/** Why a wanted build is not placed: no host holds it, or every holder is at its activeLimit. */
export type Unplaced = 'not_held' | 'no_slot';

export interface Placement {
  /** buildId -> host id, for every wanted build that fits. */
  placed: Map<string, string>;
  /** Wanted builds that fit nowhere. */
  unplaced: Map<string, Unplaced>;
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
 * Placement (§6.2). In the wanted order (first leased, first placed), each build goes to a host
 * that holds it and is under its activeLimit: the one with the fewest builds placed this pass, then
 * by id. A build no host holds is `not_held`; one whose every holder is full is `no_slot`.
 */
export function place(docs: TemplateDoc[], hosts: HostView[], nowS: number): Placement {
  const placed = new Map<string, string>();
  const unplaced = new Map<string, Unplaced>();
  const used = new Map(hosts.map((h) => [h.id, 0]));
  for (const { build } of wantedBuilds(docs, nowS)) {
    const holders = hosts.filter((h) => h.holds[build.buildId] !== undefined);
    if (holders.length === 0) {
      unplaced.set(build.buildId, 'not_held');
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
  return { placed, unplaced };
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
