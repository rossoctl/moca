/**
 * The per-subject in-flight turn cap (#360, MI1 §13).
 *
 * The supervisor's admission gate bounds the POOL (`isSaturated`, packages/supervisor), so one
 * subject can take every slot on a host. The subject is known only after `resolveTurnAuth`, which
 * lives in this tier — so the cap is enforced here, per worker. A per-worker count bounds a
 * subject to `cap` of the worker's S slots (cap/S of the host) without putting shared state on the
 * turn hot path: this tier's own rule is that a Redis that cannot answer does not gate a caller,
 * and a counter that dies with the process needs no crash reconciliation. When S2's grants name
 * the user on the request, enforcement moves to the supervisor and becomes exact host-wide.
 */
/**
 * The cap for this process, or `undefined` when no quota applies.
 *
 * `SH_TURNS_PER_SUBJECT` is the operator's knob. Unset, the default is half the per-worker slots
 * (S, which the supervisor's fork passes through its environment): a single subject can never hold
 * more than half the pool, so the other half is always available to everyone else. Neither
 * variable set — the standalone (deprecated Knative) tier, which has no worker pool — means no
 * quota.
 *
 * A malformed or non-positive operator value falls back to the derived default rather than
 * throwing: the knob is read per request, and statsIntervalMs in worker.ts is this package's
 * precedent for "an unparsable value must not become a hot timer" — here, for "must not become an
 * accidental refusal of every turn" (0 would mean exactly that if it were honored).
 */
export function turnsPerSubjectCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SH_TURNS_PER_SUBJECT?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;

  const perWorker = env.SH_TURNS_PER_WORKER?.trim();
  const s = perWorker ? Number(perWorker) : NaN;
  if (!Number.isInteger(s) || s < 1) return undefined;
  return Math.max(1, Math.floor(s / 2));
}

/**
 * How many async leaves one owner may have RUNNING across the whole deployment (#391), or
 * `undefined` for no cluster-wide cap. The pair of the control plane's
 * `MOCA_ASYNC_QUEUED_PER_OWNER`: that one bounds what an owner may wait with, this one what they may
 * execute with.
 *
 * **No derived default, and off when unset**, unlike `turnsPerSubjectCap` above. Two reasons, both
 * about what a default would do to a working deployment:
 *
 * - The value is DEPLOYMENT-wide and every worker must agree on it, so it cannot be derived from
 *   this process's own `SH_TURNS_PER_WORKER` -- two differently-sized workers would enforce two
 *   different cluster caps and the effective bound would be whichever claimed first.
 * - A cap that appeared on upgrade would start pacing a single-owner deployment's own fan-out, which
 *   is the common case here: one user's `mocactl spawn` x20 is not an abuse to contain. Deferring it
 *   costs each paced entry up to `minIdleMs` (90 s) for no benefit at all.
 *
 * A malformed or non-positive value reads as unset, for `turnsPerSubjectCap`'s reason: `0` honoured
 * would defer every async turn in the deployment forever, and the knob is read once at boot where
 * nothing would report the refusal.
 */
export function runningPerOwnerCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.MOCA_ASYNC_RUNNING_PER_OWNER?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * In-flight turns, by subject. Entries are deleted at zero so the map tracks subjects with live
 * turns, not every subject ever seen.
 */
export class SubjectCounter {
  private readonly n = new Map<string, number>();

  /** Number of subjects currently holding at least one slot (a no-leak probe for tests). */
  get size(): number {
    return this.n.size;
  }

  inFlight(subject: string): number {
    return this.n.get(subject) ?? 0;
  }

  /**
   * Take one of `subject`'s slots. Returns an **idempotent** end function, or `null` when the
   * subject already holds `cap`. Idempotence follows TurnCounter's for the same reason: a second
   * decrement (an abort path that also calls end) would over-admit that subject forever after.
   */
  acquire(subject: string, cap: number): (() => void) | null {
    const current = this.n.get(subject) ?? 0;
    if (current >= cap) return null;
    this.n.set(subject, current + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.n.get(subject) ?? 1) - 1;
      if (left <= 0) this.n.delete(subject);
      else this.n.set(subject, left);
    };
  }
}
