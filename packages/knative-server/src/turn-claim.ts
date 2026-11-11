import { CpError, type TurnState, type TurnStore } from '@moca/control-plane';
import type { ClaimedTurn } from '@moca/harness/leaf-job-runner';
import type { LeafEnvelope } from '@moca/harness/run-leaf';
import { toResultRecord, writeResult, type RedisLike } from '@moca/harness/leaf-result-store';
import { buildConfig } from './server.js';
import { validateExchangeBody, type TurnAuth } from './turn-auth.js';

export interface TurnClaimDeps {
  controlPlaneUrl: string;
  exchangeToken: string;
  /**
   * Structurally typed, so a test needs one function rather than a Redis. The real `TurnStore`
   * satisfies it. This is also the whole write surface the claim has: the worker owns the
   * `queued -> running` transition precisely because a deployment-wide shared bearer must not.
   */
  turns: Pick<TurnStore, 'markRunning'>;
  fetchImpl?: typeof fetch;
}

export interface DeadLetterDeps {
  turns: Pick<TurnStore, 'get' | 'finalize'>;
  resultStore: RedisLike;
  ttlSeconds: number;
  now?: () => string;
}

/** Codes that mean "this turn must not run", as opposed to "this call failed" (§5.4). */
const NOT_CLAIMABLE = new Set(['turn_not_found', 'turn_not_claimable']);

/**
 * §5.4's claim handshake. Returns `null` when the turn must not run -- cancelled, already terminal,
 * or gone -- and THROWS when the call itself failed, because the two have opposite consequences:
 * `null` acks the entry, a throw leaves it pending for another worker.
 *
 * Known limit (M1): because a throw leaves the entry pending, a control-plane outage lasting longer
 * than `maxAttempts` reclaim cycles (3 x 90 s) dead-letters queued turns as `lost`. Both numbers are
 * §6.2 fixed constants and §9.2 allows one operator knob, which SH_ASYNC_DRAIN spends. A `lost` turn
 * is visible on the record and counted; resubmission is the owner's.
 */
export async function claimTurn(
  turnId: string,
  deliveryCount: number,
  deps: TurnClaimDeps,
): Promise<ClaimedTurn | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: { status: number; text(): Promise<string> };
  try {
    res = (await fetchImpl(`${deps.controlPlaneUrl}/internal/turn-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.exchangeToken}`,
      },
      body: JSON.stringify({ turnId }),
    })) as unknown as { status: number; text(): Promise<string> };
  } catch {
    // Same rule as the session exchange: an unreachable control plane fails the claim and never
    // falls back to the environment (MU1 §9.2).
    throw new CpError('credential_unavailable', 'control plane unreachable');
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CpError('credential_unavailable', 'control plane returned a non-JSON body');
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  if (res.status !== 200) {
    const code = typeof body.error === 'string' ? body.error : '';
    // The turn itself is unrunnable: ack it. Anything else -- 500, 503, the 501 a `multi`-tenancy
    // deployment answers -- is this CALL failing, so the entry stays pending.
    if (NOT_CLAIMABLE.has(code)) return null;
    throw new CpError('credential_unavailable', `control plane returned ${res.status}`);
  }

  // Echoed by contract (openapi: "so a response cannot be misattributed to another claim"). A
  // mismatch would run another turn's leaf under this entry's id.
  if (body.turnId !== turnId) {
    throw new CpError('credential_unavailable', 'control plane echoed a different turn');
  }
  const resolved = validateExchangeBody(body);
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    throw new CpError('credential_unavailable', 'control plane returned no session id');
  }
  const envelope = body.envelope;
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new CpError('credential_unavailable', 'control plane returned no envelope');
  }
  // The envelope's session id is what runLeaf keys its Pi session on, and the record's is what the
  // result is written under: a disagreement would run the leaf in one session and answer in another.
  if ((envelope as Record<string, unknown>).sessionId !== body.sessionId) {
    throw new CpError('credential_unavailable', 'envelope session id does not match the record');
  }

  // Exchange first, THEN the state write -- see this file's header. markRunning re-checks
  // terminality, so a DELETE landing in between is refused here rather than stranding the record.
  const marked = await deps.turns.markRunning(turnId, deliveryCount);
  if (marked === 'refused') return null;

  const auth: TurnAuth = {
    subject: String(body.subject ?? ''),
    sessionId: body.sessionId,
    credential: {
      mode: resolved.mode,
      value: resolved.anthropicAuthToken,
      ...(resolved.authHeader === 'x-api-key' ? { header: resolved.authHeader } : {}),
    },
    anthropicBaseUrl: resolved.anthropicBaseUrl,
    ...(resolved.configRef ? { configRef: resolved.configRef } : {}),
    ...(typeof resolved.sandboxTier === 'string' && resolved.sandboxTier
      ? { sandboxTier: resolved.sandboxTier }
      : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
  };
  return {
    envelope: envelope as unknown as LeafEnvelope,
    sessionId: body.sessionId,
    attempts: deliveryCount,
    // The SAME builder the sync `/turn` path uses, so an async leaf and a sync one differ in how
    // they were admitted and in nothing else.
    config: buildConfig(auth),
  };
}

/**
 * The dead-letter write: a failed result the submitter can read, and a terminal record.
 *
 * It mints NO credential, and that is the point of it being separate from `claimTurn`. The branch
 * needs only the record's session id, and routing it through the exchange would issue and audit a
 * real credential for a turn that is never going to run.
 */
export async function deadLetterTurn(turnId: string, deps: DeadLetterDeps): Promise<void> {
  const rec = await deps.turns.get(turnId);
  // Already expired: there is nothing to answer and nothing to finalize. Acking the entry (the
  // caller's job) is the whole remaining action.
  if (!rec) return;
  const now = deps.now ?? (() => new Date().toISOString());
  await writeResult(
    deps.resultStore,
    rec.sessionId,
    toResultRecord({ status: 'failed', reason: 'error' }, rec.sessionId, now()),
    deps.ttlSeconds,
  );
  // 'lost' is the state for a turn that was delivered and never finished (§5.1). finalize
  // compare-and-sets, so a `done` that landed first wins -- which is what makes this safe to call
  // from both the inline dead-letter branch and the periodic reaper.
  await deps.turns.finalize(turnId, 'lost' as TurnState, Date.now());
}
