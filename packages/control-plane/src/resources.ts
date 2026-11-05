import { buildFindPodBySelectorArgs, buildGetPodPhaseArgs, type RunKubectl } from './kubectl.js';
import { viewTier } from './exchange.js';
import type { SessionRecord } from './ownership.js';
import type { SandboxTiers } from './sandbox-tiers.js';

/**
 * The /resources projection (spec §7.4).
 *
 * There is no session -> pod index in the tree (spec §2.4: leases are a ZSET keyed by pod, with the
 * sanitized session id as the member -- see docs/glossary.md), so the harness SELF-REPORTS into
 * sh:cp:session:<sid>:runtime. That hash is written by the brain tier, so it is untrusted,
 * DISPLAY-ONLY data and is never consulted for authz
 * -- which is why this module emits only fields it knows by name rather than spreading the hash.
 *
 * Fail-soft throughout: for an introspection endpoint, partial data with explicit unknowns beats an
 * error (spec §9.2), so a Kubernetes outage yields `phase: "unknown"`, never a 500.
 */
export interface SandboxView {
  podName: string | null;
  phase: string;
  tenant: string | null;
}

export async function resolveSandbox(
  runtime: Record<string, string>,
  namespace: string,
  run: RunKubectl | undefined,
  tenant: string,
): Promise<SandboxView> {
  const pinned = runtime.sandboxPod;
  const selector = runtime.sandboxSelector;
  if (!run || (!pinned && !selector)) {
    return { podName: pinned ?? null, phase: 'unknown', tenant };
  }
  try {
    if (pinned) {
      const phase = (await run(buildGetPodPhaseArgs(pinned, namespace))).trim();
      return { podName: pinned, phase: phase || 'unknown', tenant };
    }
    const [name = '', phase = ''] = (await run(buildFindPodBySelectorArgs(selector!, namespace)))
      .trim()
      .split('\t');
    return { podName: name || null, phase: phase || 'unknown', tenant };
  } catch {
    // K8s API down, RBAC denied, kubectl missing -- all the same answer to a caller asking "where is
    // my session running": we do not know right now.
    return { podName: pinned ?? null, phase: 'unknown', tenant };
  }
}

const num = (v: string | undefined): number | null =>
  v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * When and from where the session last lost its workspace, or null. Through `num()`, because the hash
 * is self-reported: an unparseable time is "no reset we can show", not a NaN timestamp.
 */
function workspaceReset(runtime: Record<string, string>): { at: number; from: string } | null {
  // `num('')` is 0, a real-looking epoch, so an empty value is absent, as it was before num().
  const at = runtime.workspaceResetAt ? num(runtime.workspaceResetAt) : null;
  return at !== null && runtime.workspaceResetFrom
    ? { at, from: runtime.workspaceResetFrom }
    : null;
}

export function projectResources(
  rec: SessionRecord,
  runtime: Record<string, string>,
  sandbox: SandboxView,
  /** The deployment's tiers, so a record stored with '' or none shows the default it runs in. */
  tiers: SandboxTiers | null = null,
): unknown {
  const harnessPod = runtime.harnessPod ?? null;
  return {
    session: {
      id: rec.sessionId,
      state: rec.state,
      createdAt: rec.createdAt,
      lastTurnAt: num(runtime.lastTurnAt),
      turns: num(runtime.turns) ?? 0,
      // The tier the session runs in, by the same rule as the session view (sessionView): from the
      // control plane's own record, never from the self-reported runtime hash.
      sandboxTier: viewTier(rec, tiers),
    },
    harness: {
      // A P6 worker pod name when the data plane self-reported one. Display-only.
      mode: harnessPod ? 'worker' : null,
      podName: harnessPod,
      revision: runtime.revision ?? null,
      // Nothing self-reported means nothing is serving the session right now -- the normal
      // state between turns, not an error.
      ready: harnessPod !== null,
    },
    sandbox,
    // P6.3 spec §6: where the session's last leased turn ran, and when it last lost its workspace.
    // Self-reported by the data plane at turn end (runtimeFieldsForTurn), so null until one has.
    placement: runtime.sandboxId
      ? {
          sandboxId: runtime.sandboxId,
          tier: runtime.sandboxTier || null,
          workspaceReset: workspaceReset(runtime),
        }
      : null,
    // null, not a fabricated zero: MU1's /turn path takes no pool lease and has no queue position
    // (spec §8.2), so MU2 filling these in should be visibly a change.
    lease: runtime.leaseKey
      ? {
          key: runtime.leaseKey,
          expiresAt: null,
          ttlSeconds: null,
        }
      : null,
    queue: null,
  };
}
