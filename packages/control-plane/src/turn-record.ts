import { CpError } from './errors.js';
import { asRecord } from './handler-util.js';
import type { ModelLimits } from './models.js';
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

/**
 * How much longer the turn record lives than its result (§5.1). The record must OUTLIVE the
 * result: a caller polling a finished turn whose record expired first would read `404 not
 * submitted` for a turn that in fact succeeded. One hour, longer than any plausible gap between a
 * result being read and the poll that follows it.
 *
 * Here rather than in `main.ts` because the WORKER finalizes turns too (#389), and a record
 * finalized by a worker must get the same expiry as one finalized by the control plane. This module
 * is pure, so a worker can import the number instead of re-typing it.
 */
export const TURN_RECORD_TTL_MARGIN_SECONDS = 3_600;

/**
 * `LEAF_RESULT_TTL_SECONDS`, the lifetime of a leaf result, read the SAME way in every process that
 * writes one. Beside the margin above and for the same reason: the control plane and the async
 * worker both write results, under the same keys, from the same variable, so a second parse of it
 * is a second meaning. A malformed value refuses to boot rather than becoming `NaN` -- `writeResult`
 * passes this straight to Redis as `EX`, and `EX NaN` is `ERR value is not an integer`, so a typo'd
 * TTL would turn every result write into a runtime error instead of a startup one. Zero is refused
 * too: Redis rejects `EX 0`, so "no retention" is not something this knob can express.
 *
 * SEVEN DAYS by default (#390). An async turn is submitted precisely because nobody is waiting for
 * it, so a day is the wrong unit: a Friday afternoon turn must still be readable on Monday. This is
 * the ONE retention knob -- the turn record's own expiry derives from it
 * (`+ TURN_RECORD_TTL_MARGIN_SECONDS`) and so does the per-session turn index, so raising it moves
 * everything together and there is no second number to keep in step (spec §5.1, ADR-0047).
 */
export function resultTtlSeconds(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number {
  // TRIMMED first. The value reaches a worker from a systemd EnvironmentFile or a ConfigMap, where
  // `LEAF_RESULT_TTL_SECONDS=86400 ` and a CRLF line ending are both ordinary operator slips -- and
  // this parse runs at module load, so refusing one takes down a tier that was serving sync traffic
  // happily before the knob was ever set. Whitespace-only is therefore the same as unset.
  const v = env.LEAF_RESULT_TTL_SECONDS?.trim();
  if (v === undefined || v === '') return 7 * 86_400;
  if (!/^[1-9][0-9]*$/.test(v))
    throw new Error(`LEAF_RESULT_TTL_SECONDS must be a positive integer (seconds), got "${v}"`);
  return Number(v);
}

/**
 * Per-turn caps, resolved at submission and stored (§4.3). Enforced by the WORKER: the dequeue
 * exchange hands both fields back and `turn-claim.ts` carries them into the leaf (#391).
 *
 * No `costUsd`. It was accepted and stored here and nothing could ever enforce it -- there is no
 * price table in the repo and no USD arithmetic anywhere -- so `parseTurnSubmission` now REFUSES
 * it rather than taking a cap it silently ignores. A record written before that carries a JSON
 * field nothing reads.
 */
export interface TurnCaps {
  tokens?: number;
  /** Seconds. #388 clamps `turn_exp` to it at mint; the worker's deadline IS that `turn_exp`. */
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
  /**
   * The session's model, copied at submission; '' when it names none, and the worker then uses its
   * deployment default.
   *
   * COPIED rather than read from the live session at dequeue, which is what #388 changed. §5.1 copies
   * onto the record what a turn must spend unchanged, and the model is one of those: a queued turn can
   * wait an hour, so `PATCH /v1/sessions/{id}`'s own "a turn already running keeps its model" cannot
   * cover it -- the turn has not started. Reading the session at dequeue therefore moved an
   * already-queued turn onto a model its submitter never chose.
   */
  model: string;
  /**
   * The catalog's limits for `model`, snapshotted with it. Pinned TOGETHER with the id or they
   * disagree: the limits describe that model, so a record keeping the old id against the session's
   * new limits would send the wrong `max_tokens` upstream.
   */
  modelLimits?: ModelLimits;
  /**
   * The session's STORED tier, copied at submission.
   *
   * Not the submitter's raw choice: `createSession` already resolves it
   * (`requestedTier ?? tiers?.default ?? ''`), so on a deployment that declared tiers when the
   * session was created this is the default that was current THEN. Changing
   * `sandboxTiers.default` afterwards therefore does not move an already-queued turn.
   *
   * '' in two cases only -- a session created while the deployment declared no tiers, and a record
   * written before #388 -- and the dequeue resolves both against the session (`turn-exchange.ts`).
   */
  sandboxTier: string;
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
  /**
   * `DELETE /v1/sessions/{id}/turns/{turnId}` on a RUNNING turn (§4.5, #391). The state stays
   * `running`: the worker holding the leaf polls this field, aborts the run and finalizes
   * `cancelled` itself, so a cancel needs no message addressed to a particular worker. A queued
   * turn is still cancelled outright and never carries this.
   */
  cancelRequested?: boolean;
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

/**
 * One owner's turns a worker is RUNNING RIGHT NOW, scored by the moment that delivery was admitted
 * (#391). The cluster-wide half of per-owner fairness: `SubjectCounter` is a Map in one worker
 * process, so it cannot bound an owner who is occupying every worker's drain at once.
 *
 * Separate from the open set above rather than derived from it, because that set counts `queued` as
 * well as `running` and the two caps mean different things -- `MOCA_ASYNC_QUEUED_PER_OWNER` bounds
 * what an owner may WAIT with, this bounds what they may EXECUTE with.
 *
 * A member is one DELIVERY's claim, not the turn's life: the worker adds it when it admits the entry
 * and removes it on every way out of `processOne`, redelivery and loss included. So a turn whose
 * record still says `running` because the worker holding it died holds no slot here once the entry
 * is reclaimed, and the count needs no staleness horizon to self-heal.
 */
export const ownerRunningTurnsKey = (subject: string): string =>
  `sh:cp:owner:${subjectHash(subject)}:running`;

/**
 * One owner's turn state changes, as a Redis STREAM (#392). A stream and not a zset because the
 * entry id IS the cursor a client resumes from: the server mints no sequence of its own, nothing has
 * to be deduplicated by score, and `XADD MAXLEN ~` bounds the log on the same write that appends to
 * it.
 *
 * Owner-scoped the way the two keys above are -- derived from the subject, so one subject's stream
 * cannot name another's events and there is no filter for a handler to get wrong (the two-subject
 * test in turn-store-contract.ts asserts the consequence, not the derivation).
 */
export const ownerEventsKey = (subject: string): string =>
  `sh:cp:owner:${subjectHash(subject)}:events`;

/**
 * Entries kept per owner, trimmed with `~` so Redis drops whole nodes and the number is a floor
 * rather than a promise. 500 is several days of an unattended fan-out's transitions (three per turn,
 * and `MOCA_ASYNC_QUEUED_PER_OWNER` is 50), and a client that falls further behind than the log is
 * TOLD so -- `GET /v1/events` answers a `gap` frame -- rather than handed a history with a silent
 * hole in it.
 */
export const EVENTS_MAXLEN = 500;

/** A stream entry id, `<ms>-<seq>`. Checked at the route, so `compareCursor` never parses junk. */
export const CURSOR_RE = /^[0-9]+-[0-9]+$/;

/**
 * One state transition, as a client reads it. `reason` and `gate` are carried so the stream is
 * self-sufficient: a notifier (#394) and `mocactl watch` can both render a finished turn without a
 * second request per event.
 */
export interface TurnEvent {
  /** The stream entry id, i.e. the cursor to resume AFTER. Absent on an event being written. */
  cursor?: string;
  ts: number;
  sessionId: string;
  turnId: string;
  state: TurnState;
  attempts: number;
  reason?: string;
  gate?: string;
}

/**
 * Stream fields are flat strings. An absent field beats an empty one, so a decode cannot invent a
 * reason the leaf never gave.
 */
export function encodeTurnEvent(e: TurnEvent): Record<string, string> {
  return {
    ts: String(e.ts),
    sessionId: e.sessionId,
    turnId: e.turnId,
    state: e.state,
    attempts: String(e.attempts),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.gate ? { gate: e.gate } : {}),
  };
}

export function decodeTurnEvent(cursor: string, f: Record<string, string>): TurnEvent {
  return {
    cursor,
    ts: Number(f.ts ?? 0),
    sessionId: f.sessionId ?? '',
    turnId: f.turnId ?? '',
    // An unrecognised state reads as `queued`, exactly as `TurnStore.get` does: a client must never
    // be handed a state outside the union the contract publishes.
    state: (TURN_STATES as readonly string[]).includes(f.state ?? '')
      ? (f.state as TurnState)
      : 'queued',
    attempts: Number(f.attempts ?? 0),
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.gate ? { gate: f.gate } : {}),
  };
}

/**
 * Order two cursors. A lexical compare is wrong -- '100-0' sorts before '99-0' as text -- and the
 * one question asked of this is whether a client's `since` predates the oldest entry still in the
 * stream, i.e. whether retention cut history out from under it. Both arguments have passed
 * `CURSOR_RE`, so there is nothing to validate here.
 */
export function compareCursor(a: string, b: string): number {
  const [ams, aseq] = a.split('-').map(Number) as [number, number];
  const [bms, bseq] = b.split('-').map(Number) as [number, number];
  return ams - bms || aseq - bseq;
}

/**
 * One SESSION's turns, open and finished alike, scored by `createdAt` (async fan-out spec §9.2).
 *
 * The owner set above cannot serve this: it holds OPEN turns only, because the quota counts its
 * members, so a finished turn's record and result -- and with #390 that is seven days of them --
 * survived `DELETE /v1/sessions/{id}` and expired on their own clock. A session's turns are keyed by
 * turn id, so without an index nothing can enumerate them; §9.2 rules out `SCAN MATCH` for exactly
 * the reason it is tempting, that it scans the whole keyspace on a tenant's delete.
 *
 * Armed with the same TTL as a terminal record (`resultTtlSeconds + ttlMarginSeconds`) and re-armed
 * on every terminal transition, so the index never expires before a member it would have to reach.
 */
export const sessionTurnsKey = (sessionId: string): string => `sh:cp:session:${sessionId}:turns`;

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
  // A positive SAFE INTEGER, which is what the contract advertises (`type: integer`). Half a token
  // and half a second are not quantities either enforcer can act on, and 1e300 survives the record
  // round trip only to arrive as a cap nothing can compare against meaningfully.
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new CpError('invalid_request', `caps.${field} must be a positive integer`);
  }
  return raw;
}

const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/**
 * Validate a submission body (§4.1) into the envelope to store. The three kinds mirror the data
 * plane's `isLeafEnvelope` / `isPromptEnvelope` / `isSolveEnvelope` (`@moca/server` server.ts) so one
 * body is accepted by both paths. `sessionId` is NOT read from the body: the handler supplies the
 * path's session id, which is what keeps the leaf's result under a key this session's delete can
 * reach (`leaf:result:<sid>:<turnId>`, TurnStore.deleteSessionTurns).
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
  // REFUSED, not ignored (#391). Nothing in the repo can price a turn -- no model price table, no
  // USD arithmetic -- so this cap was accepted and then had no effect, which is worse for an
  // unattended fan-out than not offering it: a caller that set it believed its spend was bounded.
  // A narrowing of a Preview surface, listed in the API changelog. `caps.tokens` is the bound that
  // works.
  if (capsIn.costUsd !== undefined) {
    throw new CpError(
      'invalid_request',
      'caps.costUsd is not enforceable (no price table); use caps.tokens',
    );
  }
  const tokens = cap(capsIn.tokens, 'tokens');
  const wallClock = cap(capsIn.wallClock, 'wallClock');
  if (tokens !== undefined) caps.tokens = tokens;
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
