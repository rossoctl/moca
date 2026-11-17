import { describe, expect, it } from 'vitest';
import type { TurnStore } from '../../src/turn-store.js';
import type { TurnRecord } from '../../src/turn-record.js';

export type MakeTurnStore = () => Promise<{
  store: TurnStore;
  /** Epoch ms the suite treats as "now"; real Redis TTLs are real time, so this is the wall clock. */
  now: number;
  /** The store's own `resultTtlSeconds`/`ttlMarginSeconds`, so the suite builds its TTL band from
   *  the constructor options it actually passed rather than a hardcoded number. */
  resultTtlSeconds: number;
  ttlMarginSeconds: number;
  /**
   * Seconds of TTL remaining on the turn record's key, or -1 when it carries none. Mirrors Redis
   * TTL semantics so the §5.1 invariant reads the same against both backings.
   */
  ttlOf(turnId: string): Promise<number>;
  /** The same, for the session's turn index (§9.2). */
  ttlOfSession(sessionId: string): Promise<number>;
  /**
   * The members of that index. Read directly rather than inferred from `deleteSessionTurns`, because
   * the thing to assert about the trim is which ids it DROPPED -- and a dropped id is invisible to
   * every public method of the store.
   */
  indexedTurns(sessionId: string): Promise<string[]>;
  /**
   * A session id unique to this make(). The suite cannot hardcode one: `leafResultKey` is
   * deliberately UNTAGGED (turn-result.ts -- the worker writes it, and it knows no test key tag), so
   * the only thing that keeps the real-Redis backing's `*${tag}*` sweep able to delete the results
   * this suite seeds is the session id they are keyed by.
   */
  sessionId: string;
  /** Seed a stored leaf result under the key the worker would have written (§4.4). */
  putResult(sessionId: string, turnId: string, body: string): Promise<void>;
  hasResult(sessionId: string, turnId: string): Promise<boolean>;
  done(): Promise<void>;
}>;

/**
 * The behaviour the turn store must have wherever it runs (async fan-out spec §5.1, §4.3, §4.5,
 * §5.4). One suite, two backings: the in-memory fake the handler tests use, and real Redis. The
 * failure this exists for is a TTL or a set-membership rule that holds in the fake and not in Redis.
 */
export function turnStoreContract(name: string, make: MakeTurnStore): void {
  const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
    turnId: 't-1',
    owner: 'github:1234',
    tenant: 'github:1234',
    sessionId: 's-1',
    cfg: '',
    credentialName: 'anthropic',
    model: '',
    sandboxTier: '',
    caps: { tokens: 1000 },
    idempotencyKey: 's-1',
    envelope: { item: { item_id: 'i1', file: 'f', pattern: 'p' } },
    state: 'queued',
    attempts: 0,
    createdAt: 1,
    ...over,
  });

  describe(`TurnStore contract: ${name}`, () => {
    it('creates, then reads back the same record', async () => {
      const { store, done } = await make();
      const r = rec();
      await store.create(r);
      expect(await store.get('t-1')).toEqual(r);
      expect(await store.get('t-missing')).toBeNull();
      await done();
    });

    it('round-trips caps, an empty caps object and an absent endedAt', async () => {
      const { store, done } = await make();
      // caps and envelope are JSON on the hash; `{}` must come back as `{}` and not as undefined,
      // or a turn submitted with no caps would read differently from one submitted with none.
      await store.create(rec({ turnId: 't-caps', caps: {} }));
      const got = await store.get('t-caps');
      expect(got?.caps).toEqual({});
      expect(got?.endedAt).toBeUndefined();
      await done();
    });

    it('round-trips the pinned model, its limits and the tier (#388)', async () => {
      const { store, done } = await make();
      // The point of the pin is that the turn spends what its SUBMISSION chose, so these three must
      // survive the hash -- `modelLimits` as JSON, the other two as plain strings. Asserted in the
      // contract rather than in one suite because the fake and real Redis must agree: a limits field
      // that came back as a string from one of them would reach the harness as `max_tokens`.
      await store.create(
        rec({
          turnId: 't-pin',
          model: 'claude-opus-4-8',
          modelLimits: { contextWindow: 200000, maxTokens: 32000 },
          sandboxTier: 'microvm',
        }),
      );
      expect(await store.get('t-pin')).toMatchObject({
        model: 'claude-opus-4-8',
        modelLimits: { contextWindow: 200000, maxTokens: 32000 },
        sandboxTier: 'microvm',
      });
      // A record that pinned no model reads back as '' with no limits, never as undefined: that is
      // how "the session named none" is stored, and the exchange leaves `model` out for it.
      await store.create(rec({ turnId: 't-none' }));
      const none = await store.get('t-none');
      expect(none?.model).toBe('');
      expect(none?.modelLimits).toBeUndefined();
      await done();
    });

    it('counts only NON-TERMINAL turns per owner, and never another owner s (§4.3)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-a' }));
      await store.create(rec({ turnId: 't-b' }));
      await store.create(rec({ turnId: 't-c', owner: 'github:9999', tenant: 'github:9999' }));
      expect(await store.countOpen('github:1234')).toBe(2);
      expect(await store.countOpen('github:9999')).toBe(1);
      // A turn that reached a terminal state released its claim, so the count drops. This is what
      // makes "a terminal turn frees a quota slot" true (§8).
      expect(await store.finalize('t-a', 'done', now)).toBe('ok');
      expect(await store.countOpen('github:1234')).toBe(1);
      // ...and `running` is NOT terminal, so it still counts.
      expect(await store.markRunning('t-b', 1)).toBe('ok');
      expect(await store.countOpen('github:1234')).toBe(1);
      expect(await store.countOpen('nobody')).toBe(0);
      await done();
    });

    it('promotes queued to running and writes attempts from the delivery count (§5.4)', async () => {
      const { store, done } = await make();
      await store.create(rec());
      expect(await store.markRunning('t-1', 1)).toBe('ok');
      expect((await store.get('t-1'))?.state).toBe('running');
      expect((await store.get('t-1'))?.attempts).toBe(1);
      // A REDELIVERY arrives on a record that already says `running` and must still run: the first
      // claim set `running`, so refusing here would ack and drop every crash-reclaimed entry.
      expect(await store.markRunning('t-1', 2)).toBe('ok');
      expect((await store.get('t-1'))?.attempts).toBe(2);
      await done();
    });

    it('refuses to run a cancelled or already-terminal record, and only those (§5.4)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-cancel' }));
      expect(await store.cancel('t-cancel', now)).toBe('cancelled');
      expect(await store.markRunning('t-cancel', 1)).toBe('refused');

      await store.create(rec({ turnId: 't-done' }));
      expect(await store.finalize('t-done', 'done', now)).toBe('ok');
      expect(await store.markRunning('t-done', 1)).toBe('refused');

      expect(await store.markRunning('t-absent', 1)).toBe('refused');
      await done();
    });

    it('cancels a queued turn and answers conflict for a terminal one (§4.5)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-q' }));
      expect(await store.cancel('t-q', now)).toBe('cancelled');
      expect((await store.get('t-q'))?.state).toBe('cancelled');
      // Cancel is idempotent in effect but reports the conflict: already-cancelled is terminal.
      expect(await store.cancel('t-q', now)).toBe('conflict');

      await store.create(rec({ turnId: 't-d' }));
      expect(await store.finalize('t-d', 'done', now)).toBe('ok');
      expect(await store.cancel('t-d', now)).toBe('conflict');
      await done();
    });

    it('REQUESTS a cancel on a running turn, leaving it running for its worker to stop (#391)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-r' }));
      await store.markRunning('t-r', 1);

      expect(await store.cancel('t-r', now)).toBe('cancelling');
      // The STATE is untouched. Every redelivery write CASes against the open states, so a third
      // live state would refuse exactly the reclaimed entries crash recovery exists for -- which
      // the markRunning below is here to prove.
      expect((await store.get('t-r'))?.state).toBe('running');
      expect((await store.get('t-r'))?.cancelRequested).toBe(true);
      expect(await store.cancelRequested('t-r')).toBe(true);
      // Idempotent: a caller retrying the DELETE is told the same thing, not given a 409 for a
      // cancel already in flight.
      expect(await store.cancel('t-r', now)).toBe('cancelling');
      expect(await store.markRunning('t-r', 2)).toBe('ok');

      // The worker's own finalize is what ends it, mapping its aborted leaf to `cancelled`.
      expect(await store.finalize('t-r', 'cancelled', now)).toBe('ok');
      expect((await store.get('t-r'))?.state).toBe('cancelled');
      await done();
    });

    it('reports no cancel request for a turn that has none, or no record at all (#391)', async () => {
      const { store, done } = await make();
      await store.create(rec({ turnId: 't-1' }));
      expect(await store.cancelRequested('t-1')).toBe(false);
      expect(await store.cancelRequested('t-missing')).toBe(false);
      await done();
    });

    it('reads the owner of a turn, and empty for no record (#391)', async () => {
      const { store, done } = await make();
      await store.create(rec({ turnId: 't-1', owner: 'github:1234' }));
      expect(await store.owner('t-1')).toBe('github:1234');
      // '' not a throw: the async drain reads this before its claim, and the claim is what decides
      // what a missing record means.
      expect(await store.owner('t-missing')).toBe('');
      await done();
    });

    it('finalizes once: a second finalize is refused and does not move the state', async () => {
      const { store, now, done } = await make();
      await store.create(rec());
      expect(await store.finalize('t-1', 'solved', now)).toBe('ok');
      expect(await store.finalize('t-1', 'failed', now)).toBe('refused');
      expect((await store.get('t-1'))?.state).toBe('solved');
      expect((await store.get('t-1'))?.endedAt).toBe(now);
      await done();
    });

    it('releases the idempotency key at the terminal transition, so a resubmission gets a NEW turn (F1)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-1', idempotencyKey: 'k-1' }));
      expect(await store.claimIdempotencyKey('github:1234', 'k-1', 't-1')).toBe('t-1');
      expect(await store.finalize('t-1', 'done', now)).toBe('ok');
      // The key must be gone outright -- not merely stale -- so the NEXT submission claims it
      // outright rather than deduplicating against the finished turn (turn-store.ts:82's promise).
      expect(await store.claimIdempotencyKey('github:1234', 'k-1', 't-2')).toBe('t-2');
      await done();
    });

    it('claims an idempotency key for the first turn and returns the FIRST id to the second (§4.3)', async () => {
      const { store, done } = await make();
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-first')).toBe('t-first');
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-second')).toBe('t-first');
      // Owner-scoped: one owner's key cannot address another's turn.
      expect(await store.claimIdempotencyKey('github:9999', 's-1', 't-other')).toBe('t-other');
      // Released when the turn goes terminal, so the same session can submit again afterwards.
      expect(await store.releaseIdempotencyKeyIf('github:1234', 's-1', 't-first')).toBe(true);
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-third')).toBe('t-third');
      await done();
    });

    it('releases a key only while the expected turn still holds it (§4.3)', async () => {
      const { store, done } = await make();
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-first')).toBe('t-first');
      // The compare is what stops a submission stepping over a TERMINAL holder from deleting the
      // live claim another submission made in between -- which would fan out two turns for one key.
      expect(await store.releaseIdempotencyKeyIf('github:1234', 's-1', 't-someone-else')).toBe(
        false,
      );
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-second')).toBe('t-first');
      expect(await store.releaseIdempotencyKeyIf('github:1234', 's-1', 't-first')).toBe(true);
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-third')).toBe('t-third');
      // An already-absent key reads as released: the caller's own next claim then wins it outright.
      expect(await store.releaseIdempotencyKeyIf('github:1234', 's-1', 't-third')).toBe(true);
      expect(await store.releaseIdempotencyKeyIf('github:1234', 's-1', 't-gone')).toBe(true);
      await done();
    });

    it('reserves a quota slot with the count INCLUDING it, and gives it back (§4.3)', async () => {
      const { store, now, done } = await make();
      // The write is what decides the quota: a submission's own slot must be in the count it reads,
      // or every member of a parallel batch reads the same under-limit number and all pass.
      expect(await store.reserveOpenSlot('github:1234', 't-1', now)).toBe(1);
      expect(await store.reserveOpenSlot('github:1234', 't-2', now)).toBe(2);
      expect(await store.countOpen('github:1234')).toBe(2);
      // Owner-scoped, like every other key here.
      expect(await store.reserveOpenSlot('github:9999', 't-3', now)).toBe(1);

      await store.releaseOpenSlot('github:1234', 't-2');
      expect(await store.countOpen('github:1234')).toBe(1);
      // `create` re-adds the same member, so a reservation that becomes a record costs no extra
      // slot: a second slot here would halve the owner's effective quota.
      await store.create(rec({ turnId: 't-1' }));
      expect(await store.countOpen('github:1234')).toBe(1);
      await done();
    });

    it('admits at most `limit` of a parallel batch, on this backing (§4.3)', async () => {
      const { store, now, done } = await make();
      const limit = 5;
      // The whole point of reserving instead of counting, asserted where it has to hold: on REAL
      // Redis, not only in a fake whose "concurrency" is one event loop. The same batch against a
      // read-then-check quota was accepted 100 of 100 with the limit at 5, because every ZCARD ran
      // before any other submission had written anything.
      const admitted = await Promise.all(
        Array.from({ length: 40 }, async (_unused, i) => {
          const turnId = `t-par-${i}`;
          const held = await store.reserveOpenSlot('github:1234', turnId, now);
          if (held <= limit) return turnId;
          await store.releaseOpenSlot('github:1234', turnId);
          return null;
        }),
      );
      const won = admitted.filter((id): id is string => id !== null);
      expect(won.length).toBeLessThanOrEqual(limit);
      // Every refused reservation gave its slot back, so the set holds exactly the winners -- a
      // leaked one is permanent, since no record exists to ever go terminal and remove it.
      expect(await store.countOpen('github:1234')).toBe(won.length);
      await done();
    });

    it('carries no TTL while non-terminal, in `queued` or `running` (§5.1)', async () => {
      const { store, ttlOf, done } = await make();
      await store.create(rec());
      expect(await ttlOf('t-1')).toBe(-1);
      // `running` is a long-lived non-terminal state too -- a leaf can sit there for the turn's
      // whole wall-clock budget, so it must not pick up a TTL either.
      expect(await store.markRunning('t-1', 1)).toBe('ok');
      expect(await ttlOf('t-1')).toBe(-1);
      await done();
    });

    it('sets the TTL to resultTtl + margin at a terminal transition (§5.1)', async () => {
      const { store, now, resultTtlSeconds, ttlMarginSeconds, ttlOf, done } = await make();
      const band = resultTtlSeconds + ttlMarginSeconds;

      await store.create(rec({ turnId: 't-done' }));
      expect(await store.finalize('t-done', 'done', now)).toBe('ok');
      const doneTtl = await ttlOf('t-done');
      expect(doneTtl).toBeGreaterThan(band - 5);
      expect(doneTtl).toBeLessThanOrEqual(band);

      // `cancelled` is terminal too, and must get the TTL exactly like `done` does.
      await store.create(rec({ turnId: 't-cancel' }));
      expect(await store.cancel('t-cancel', now)).toBe('cancelled');
      const cancelTtl = await ttlOf('t-cancel');
      expect(cancelTtl).toBeGreaterThan(band - 5);
      expect(cancelTtl).toBeLessThanOrEqual(band);
      await done();
    });

    it('deletes a FINISHED turn s record and stored result with its session (§9.2)', async () => {
      const { store, now, sessionId, putResult, hasResult, done } = await make();
      // Same OWNER, a different session: the owner's open set spans both, so this is the turn a
      // delete that walked the wrong set would take with it.
      const other = `${sessionId}-other`;

      await store.create(rec({ turnId: 't-fin', sessionId, idempotencyKey: 'k-fin' }));
      await putResult(sessionId, 't-fin', '{"status":"done"}');
      // TERMINAL, which is the case the owner-set walk could never reach: `finalize` removes the
      // member it used to enumerate, so before the index this record and its seven days of result
      // bytes survived the session that produced them.
      expect(await store.finalize('t-fin', 'done', now)).toBe('ok');

      await store.create(rec({ turnId: 't-other', sessionId: other, idempotencyKey: 'k-other' }));
      await putResult(other, 't-other', '{"status":"done"}');
      expect(await store.finalize('t-other', 'done', now)).toBe('ok');

      // An OPEN turn of the doomed session, for the quota slot and the idempotency claim.
      await store.create(rec({ turnId: 't-open', sessionId, idempotencyKey: 'k-open' }));
      expect(await store.claimIdempotencyKey('github:1234', 'k-open', 't-open')).toBe('t-open');
      expect(await store.countOpen('github:1234')).toBe(1);

      await store.deleteSessionTurns(sessionId, 'github:1234');

      expect(await store.get('t-fin')).toBeNull();
      expect(await hasResult(sessionId, 't-fin')).toBe(false);
      expect(await store.get('t-open')).toBeNull();
      // The slot and the claim go with the record, or a deleted session's turns would hold a quota
      // slot nothing can ever free and keep deduplicating submissions onto a turn that is gone.
      expect(await store.countOpen('github:1234')).toBe(0);
      expect(await store.claimIdempotencyKey('github:1234', 'k-open', 't-new')).toBe('t-new');

      expect(await store.get('t-other')).not.toBeNull();
      expect(await hasResult(other, 't-other')).toBe(true);
      await done();
    });

    it('sweeps more turns than one DEL chunk holds (§9.2)', async () => {
      const { store, now, sessionId, putResult, hasResult, done } = await make();
      // 251 turns is 502 keys, which is one full chunk of 500 plus a remainder: the boundary where
      // a chunking loop that stops one iteration early leaves the last turn's bytes behind, with
      // every single-turn assertion above still green.
      const ids = Array.from({ length: 251 }, (_, i) => `t-bulk-${i}`);
      for (const turnId of ids) {
        await store.create(rec({ turnId, sessionId, idempotencyKey: turnId }));
        await putResult(sessionId, turnId, '{"status":"done"}');
        expect(await store.finalize(turnId, 'done', now)).toBe('ok');
      }

      await store.deleteSessionTurns(sessionId, 'github:1234');

      for (const turnId of [ids[0]!, ids[249]!, ids[250]!]) {
        expect(await store.get(turnId)).toBeNull();
        expect(await hasResult(sessionId, turnId)).toBe(false);
      }
      await done();
    });

    it('keeps the session index alive at least as long as the record it points at (§9.2)', async () => {
      const {
        store,
        now,
        sessionId,
        resultTtlSeconds,
        ttlMarginSeconds,
        ttlOf,
        ttlOfSession,
        done,
      } = await make();
      const band = resultTtlSeconds + ttlMarginSeconds;

      await store.create(rec({ turnId: 't-idx', sessionId }));
      // Armed at CREATE as well, so a session whose turns all go `lost` without a terminal write
      // cannot leave an index key with no expiry at all.
      const atCreate = await ttlOfSession(sessionId);
      expect(atCreate).toBeGreaterThan(band - 5);
      expect(atCreate).toBeLessThanOrEqual(band);

      expect(await store.finalize('t-idx', 'done', now)).toBe('ok');
      // Read the INDEX first: it is armed after the record, so reading it earlier can only
      // understate the gap. If the index ever expires first, `deleteSessionTurns` loses its only
      // route to a finished turn -- the failure is silent, and the leaked bytes outlive the session.
      const indexTtl = await ttlOfSession(sessionId);
      expect(indexTtl).toBeGreaterThanOrEqual(await ttlOf('t-idx'));
      await done();
    });

    it('trims index members past the retention window, but never a turn that just finished (§9.2)', async () => {
      const {
        store,
        now,
        sessionId,
        resultTtlSeconds,
        ttlMarginSeconds,
        indexedTurns,
        putResult,
        hasResult,
        done,
      } = await make();
      const band = (resultTtlSeconds + ttlMarginSeconds) * 1000;

      // Submitted three windows ago and never finished a terminal write: whatever became of its
      // record, the window it was submitted in is long over, and its index entry would otherwise sit
      // here for as long as the session keeps submitting -- every `create` re-arms the key's expiry.
      await store.create(
        rec({ turnId: 't-ancient', sessionId, createdAt: now - band * 3, idempotencyKey: 'k-anc' }),
      );
      // Submitted two windows ago and finished NOW. By submission time it is as stale as the one
      // above; by the clock that governs its record and result -- which starts at the terminal
      // transition -- it is brand new. The re-score in `toTerminal` is the only thing that tells
      // these two apart, and getting it wrong deletes a live turn's only route home.
      await store.create(
        rec({ turnId: 't-late', sessionId, createdAt: now - band * 2, idempotencyKey: 'k-late' }),
      );
      await putResult(sessionId, 't-late', '{"status":"done"}');
      expect(await store.finalize('t-late', 'done', now)).toBe('ok');

      // Today's submission is what runs the sweep.
      await store.create(
        rec({ turnId: 't-fresh', sessionId, createdAt: now, idempotencyKey: 'k-fresh' }),
      );

      const members = await indexedTurns(sessionId);
      expect(members).toContain('t-late');
      expect(members).toContain('t-fresh');
      expect(members).not.toContain('t-ancient');

      // ...and the one the sweep kept is still reachable, result bytes included.
      await store.deleteSessionTurns(sessionId, 'github:1234');
      expect(await store.get('t-late')).toBeNull();
      expect(await hasResult(sessionId, 't-late')).toBe(false);
      await done();
    });
  });
}
