import { CpError } from './errors.js';
import { asRecord } from './handler-util.js';
import { subjectHash } from './subject-document.js';

/**
 * The async turn record (async fan-out spec §5.1). A PURE module -- types, keys and body validation,
 * no Redis and no HTTP -- so `turn-store.ts` and `turn-handlers.ts` can each import it without
 * importing the other.
 */
export const TURN_STATES = [
  'queued',
  'running',
  'paused',
  'responded',
  'done',
  'solved',
  'failed',
  'cancelled',
  'lost',
] as const;

export type TurnState = (typeof TURN_STATES)[number];

/**
 * Everything but `queued` and `running`. The claim at dequeue refuses `cancelled` and terminal
 * records only (§5.4): the first claim writes `running`, so EVERY redelivery -- crash-reclaimed,
 * drained, or a `retryable` outcome returned unacked -- arrives on a record that already says
 * `running`. Treating `running` as terminal here would ack and drop exactly the entries crash
 * recovery exists for, and strand the record with no TTL and no entry left for the reaper.
 */
export function isTerminalState(s: TurnState): boolean {
  return s !== 'queued' && s !== 'running';
}

/** Per-turn caps, resolved at submission and stored (§4.3). Enforcement is the worker's (#389). */
export interface TurnCaps {
  tokens?: number;
  costUsd?: number;
  /** Seconds. #388 clamps `turn_exp` to it at mint; nothing reads it in M1. */
  wallClock?: number;
}

export interface TurnRecord {
  turnId: string;
  /** Flat subject string, as `SessionRecord.owner` -- not a scope object (mind #361). */
  owner: string;
  tenant: string;
  sessionId: string;
  /** The session's bundle digest, copied at submission; '' when the session names none. */
  cfg: string;
  /** A NAME, resolved against the owner's credentials at dequeue -- never the credential (§5.1). */
  credentialName: string;
  caps: TurnCaps;
  /** Defaults to `sessionId` (§4.3). */
  idempotencyKey: string;
  /** The LeafEnvelope the worker runs. On the record, never in the queue (§5.1). */
  envelope: Record<string, unknown>;
  state: TurnState;
  /** Written from the queue entry's `deliveryCount` at claim; DESCRIPTIVE (§5.4). */
  attempts: number;
  createdAt: number;
  /** Epoch ms the turn reached a terminal state; absent while it is live. */
  endedAt?: number;
}

export const turnKey = (turnId: string): string => `sh:cp:turn:${turnId}`;

/**
 * The shape `turn-handlers.submitTurn` mints: `t-` plus a lowercase UUID (`deps.newId()` is
 * `handler-util.defaultNewId` in production, main.ts). Anchored, so nothing trails or leads it.
 *
 * The coupling to that generator is silent if it breaks -- enqueued, never claimable, redelivered
 * until dead-letter -- so the tests that claim a turn inject `defaultNewId` itself rather than
 * restating what it does (turn-handlers.test.ts, turn-e2e.test.ts).
 *
 * Only the DEQUEUE exchange needs this. That route's caller is authenticated by the deployment-wide
 * `SH_EXCHANGE_TOKEN` rather than by a session, so the turn id is the one piece of caller input that
 * reaches a key -- `HGETALL sh:cp:turn:<input>` -- and `TurnStore.tag` may append `:${keyTag}` to it
 * besides. Checking the shape first bounds that key space to ids the control plane could have
 * written. It closes no hole on its own: `get` only reads, and the handler re-checks the record's
 * owner against its session. It is the cheaper default on a shared-bearer route, and the 400 it
 * produces costs that caller nothing (openapi.yaml's 404 description argues why).
 *
 * The owner-scoped `/v1` turn routes deliberately do NOT use it. There a malformed id must stay a
 * 404, indistinguishable from another subject's turn, or the error code becomes the existence oracle
 * `assertOwner` exists to deny (spec §8.1).
 *
 * Exported because `openapi.yaml` states the same pattern on the route's request body, pinned by
 * openapi-contract.test.ts -- two sources of truth for a validation rule is how a documented API
 * starts lying, the same reading `CREDENTIAL_NAME_RE` and `SANDBOX_ID_RE` already get.
 */
export const MINTED_TURN_ID_RE = /^t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isMintedTurnId = (turnId: string): boolean => MINTED_TURN_ID_RE.test(turnId);

/**
 * One owner's OPEN turns, scored by `createdAt`. The quota (§4.3) counts the members of this set,
 * which is why `finalize` REMOVES from it rather than rescoring: a count then costs one `ZCARD`
 * instead of N `HGETALL`s, and cannot drift from the records because the same call writes both.
 */
export const ownerTurnsKey = (subject: string): string =>
  `sh:cp:owner:${subjectHash(subject)}:turns`;
/** Owner-scoped, so one owner's key cannot address another's turn. */
export const idempotencyKeyKey = (owner: string, key: string): string =>
  `sh:cp:turnidem:${subjectHash(owner)}:${key}`;

export interface ParsedSubmission {
  kind: 'verdict' | 'prompt' | 'solve';
  envelope: Record<string, unknown>;
  caps: TurnCaps;
  idempotencyKey?: string;
  /** Reported, not refused: the 501 is the handler's, before admission and before enqueue (§4.2). */
  workloadId?: string;
}

const KEY_RE = /^[\x21-\x7e]{1,128}$/;

function cap(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new CpError('invalid_request', `caps.${field} must be a positive number`);
  }
  return raw;
}

const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/**
 * Validate a submission body (§4.1) into the envelope to store. The three kinds mirror the data
 * plane's `isLeafEnvelope` / `isPromptEnvelope` / `isSolveEnvelope` (knative-server server.ts) so one
 * body is accepted by both paths. `sessionId` is NOT read from the body: the handler supplies the
 * path's session id, which is what keeps the leaf's result under the key `cascadeDelete` already
 * cleans up (`leaf:result:<sid>`, ownership.ts dataKeys).
 */
export function parseTurnSubmission(body: unknown): ParsedSubmission {
  const b = asRecord(body);
  if (b.async !== true) {
    throw new CpError('invalid_request', 'async must be true on this route');
  }
  // An authenticated request may not name a tenant: the token alone scopes the turn (MI1 R7),
  // exactly as POST /v1/runs refuses it.
  if (b.tenant !== undefined) throw new CpError('invalid_request', 'tenant is not allowed');

  const capsIn = asRecord(b.caps);
  const caps: TurnCaps = {};
  const tokens = cap(capsIn.tokens, 'tokens');
  const costUsd = cap(capsIn.costUsd, 'costUsd');
  const wallClock = cap(capsIn.wallClock, 'wallClock');
  if (tokens !== undefined) caps.tokens = tokens;
  if (costUsd !== undefined) caps.costUsd = costUsd;
  if (wallClock !== undefined) caps.wallClock = wallClock;

  let idempotencyKey: string | undefined;
  if (b.idempotencyKey !== undefined) {
    if (typeof b.idempotencyKey !== 'string' || !KEY_RE.test(b.idempotencyKey)) {
      throw new CpError(
        'invalid_request',
        'idempotencyKey must be 1-128 printable characters without spaces',
      );
    }
    idempotencyKey = b.idempotencyKey;
  }

  const workloadId = typeof b.workloadId === 'string' ? b.workloadId : undefined;
  const common = {
    caps,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(workloadId !== undefined ? { workloadId } : {}),
  };

  const item = asRecord(b.item);
  // `converge` is the explicit wire spelling of the default kind (spec §10 parity table: "Leaf
  // kinds accepted async (prompt/converge/solve) -- All three kept"); runLeaf treats an absent
  // `kind` and `kind: 'converge'` identically (harness/src/run-leaf.ts). Accepting both here but
  // normalising the stored envelope to the absent form keeps exactly one representation in the
  // turn record rather than two that mean the same thing. `'verdict'` itself is never a wire
  // value -- it is this parser's internal discriminant -- so it is deliberately NOT accepted here.
  if (
    (b.kind === undefined || b.kind === 'converge') &&
    str(item.item_id) &&
    str(item.file) &&
    str(item.pattern)
  ) {
    return { kind: 'verdict', envelope: { item: b.item }, ...common };
  }
  if (b.kind === 'prompt' && str(b.prompt)) {
    return { kind: 'prompt', envelope: { kind: 'prompt', prompt: b.prompt }, ...common };
  }
  if (b.kind === 'solve' && str(b.problemStatement) && str(b.repoUrl) && str(b.ref)) {
    return {
      kind: 'solve',
      envelope: {
        kind: 'solve',
        problemStatement: b.problemStatement,
        repoUrl: b.repoUrl,
        ref: b.ref,
      },
      ...common,
    };
  }
  throw new CpError(
    'envelope_invalid',
    'body must be a verdict leaf (item), a prompt leaf (kind:prompt, prompt) or a solve leaf (kind:solve, problemStatement, repoUrl, ref)',
  );
}
