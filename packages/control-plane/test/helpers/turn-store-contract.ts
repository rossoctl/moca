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

    it('cancels a queued turn and answers conflict for a running or terminal one (§4.5)', async () => {
      const { store, now, done } = await make();
      await store.create(rec({ turnId: 't-q' }));
      expect(await store.cancel('t-q', now)).toBe('cancelled');
      expect((await store.get('t-q'))?.state).toBe('cancelled');
      // Cancel is idempotent in effect but reports the conflict: already-cancelled is terminal.
      expect(await store.cancel('t-q', now)).toBe('conflict');

      await store.create(rec({ turnId: 't-r' }));
      await store.markRunning('t-r', 1);
      // A running leaf is NOT interrupted (§4.5): the DELETE answers 409 naming the state.
      expect(await store.cancel('t-r', now)).toBe('conflict');
      expect((await store.get('t-r'))?.state).toBe('running');
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
  });
}
