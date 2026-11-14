import { randomUUID } from 'node:crypto';
import type { AuditLog } from './audit-log.js';
import { defaultAuditLog } from './audit-log.js';
import type { OwnershipIndex } from './ownership.js';
import { CpError } from './errors.js';
import { isEnrolledForSandbox, notEnrolled } from './sandbox-config.js';
import type { CpConfig } from './handlers.js';
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

/**
 * The production `CpDeps.newId`, as `defaultAuditLog` and `defaultRunKubectl` are for their fields:
 * main.ts wires THIS rather than spelling a generator out, so there is one place the id shape is
 * decided and tests can exercise it instead of restating it.
 *
 * Three consumers depend on the shape, not just on uniqueness, which is why it is named and not
 * inlined: session ids are their own leafSessionId sanitisation (gap #10, handlers.ts); `sandboxId`
 * needs 26 random hex and REFUSES a shorter source (sandbox-handlers.ts); and `turn-handlers` mints
 * `t-${newId()}`, which the dequeue exchange then checks against `MINTED_TURN_ID_RE`. That last one
 * fails SILENTLY if the two drift -- every submission still answers 202 while every claim 400s, so
 * the turn is enqueued, never claimable, and redelivered until it dead-letters. Swap this and the
 * coupling tests that import it fail, which is the point.
 */
export const defaultNewId = (): string => randomUUID();

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
  deps: { index: Pick<OwnershipIndex, 'audit'>; log?: AuditLog },
  route: string,
  target: string,
  entry: Parameters<OwnershipIndex['audit']>[0],
): Promise<void> {
  // Mirror to stdout BEFORE the Redis write so the line still appears when Redis is down.
  (deps.log ?? defaultAuditLog)({ event: 'audit', ...entry });

  try {
    await deps.index.audit(entry);
  } catch (err) {
    console.error(
      `[control-plane] audit write failed for ${route} ${target}: ` +
        `${(err as Error).message} -- the write itself SUCCEEDED`,
    );
  }
}

/**
 * Spec §4.2: the allow list (plus admins) gates the sandbox routes and the template writes, on the
 * sandbox and the combined profile; returns the principal.
 */
export function requireEnrolledPrincipal(
  ctx: { principal?: TokenClaims },
  config: CpConfig,
): TokenClaims {
  const p = ctx.principal;
  if (!p) throw new CpError('token_required', 'this route requires a token');
  if (!isEnrolledForSandbox(p.sub, p.roles ?? [], config)) throw notEnrolled(p.sub);
  return p;
}

/**
 * A route open to any logged-in subject on `harness` and `combined` (template, policy and quota
 * reads, combined spec §3.2) but enrolled-only on `sandbox`, whose login is closed anyway.
 */
export function requireReader(ctx: { principal?: TokenClaims }, config: CpConfig): TokenClaims {
  if (config.routeProfile === 'sandbox') return requireEnrolledPrincipal(ctx, config);
  const p = ctx.principal;
  if (!p) throw new CpError('token_required', 'this route requires a token');
  return p;
}
