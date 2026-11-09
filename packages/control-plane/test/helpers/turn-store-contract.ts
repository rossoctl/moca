import { describe, expect, it } from 'vitest';
import type { TurnStore } from '../../src/turn-store.js';
import type { TurnRecord } from '../../src/turn-record.js';

export type MakeTurnStore = () => Promise<{
  store: TurnStore;
  /** Epoch ms the suite treats as "now"; real Redis TTLs are real time, so this is the wall clock. */
  now: number;
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

    it('claims an idempotency key for the first turn and returns the FIRST id to the second (§4.3)', async () => {
      const { store, now, done } = await make();
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-first')).toBe('t-first');
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-second')).toBe('t-first');
      // Owner-scoped: one owner's key cannot address another's turn.
      expect(await store.claimIdempotencyKey('github:9999', 's-1', 't-other')).toBe('t-other');
      // Released when the turn goes terminal, so the same session can submit again afterwards.
      await store.releaseIdempotencyKey('github:1234', 's-1');
      expect(await store.claimIdempotencyKey('github:1234', 's-1', 't-third')).toBe('t-third');
      expect(now).toBeGreaterThan(0);
      await done();
    });
  });
}
