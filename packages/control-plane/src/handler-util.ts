import type { OwnershipIndex } from './ownership.js';
import type { TokenClaims } from './token.js';

/**
 * Helpers shared by handlers.ts and sandbox-handlers.ts. A LEAF: it imports neither handlers file
 * (handlers.ts spreads sandbox-handlers.ts's table, so either importing the other at runtime would
 * be a cycle), which is why the deps it takes are structural rather than CpDeps.
 */

/** A JSON body as an object; anything else (array, null, scalar) as `{}`. */
export const asRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

/** The injectable clock (CpDeps.now, epoch ms) in epoch seconds. */
export const seconds = (deps: { now(): number }): number => Math.floor(deps.now() / 1000);

/** Whether the caller holds the admin role (SH_ADMIN_SUBJECTS). */
export const isAdmin = (p: TokenClaims): boolean => (p.roles ?? []).includes('admin');

/**
 * Audit a route whose write has ALREADY happened, without letting the audit's own failure change the
 * caller's status.
 *
 * Spec §9.2 promises "Redis down => session routes 503, while /v1/credentials stays up, because §7.1
 * put them in different stores". The credential store is Kubernetes Secrets and knows nothing about
 * Redis -- but `index.audit()` is a Redis write, and `OwnershipIndex.guard` turns any transport
 * failure into `redis_unavailable` (503). Awaiting it after a successful Secret patch therefore
 * reported 503 for a write that HAD happened: the status lied, and a user could not repair their
 * credential during a Redis outage. Availability of the repair path is worth more than the audit
 * record, so the audit is what gives way. The sandbox routes (SBX0 §5) use it for the same reason:
 * a created or deleted sandbox must not be reported as failed.
 *
 * Deliberately NOT applied to `audit` globally, and never to the session routes: their 503 is correct
 * and spec-mandated, because those routes' own state lives in the very Redis that is down.
 *
 * The swallow is loud. An audit gap must be discoverable, so it logs the route and the target's
 * NAME (a credential name, a digest, a sandbox id) -- never a value, which this function is never
 * given in the first place.
 */
export async function auditBestEffort(
  deps: { index: Pick<OwnershipIndex, 'audit'> },
  route: string,
  target: string,
  entry: Parameters<OwnershipIndex['audit']>[0],
): Promise<void> {
  try {
    await deps.index.audit(entry);
  } catch (err) {
    console.error(
      `[control-plane] audit write failed for ${route} ${target}: ` +
        `${(err as Error).message} -- the write itself SUCCEEDED`,
    );
  }
}
