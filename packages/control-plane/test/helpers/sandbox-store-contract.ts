import { describe, expect, it } from 'vitest';
import { viewOf, type SandboxRecord, type SandboxStore } from '../../src/sandbox-store.js';

export type MakeStore = () => Promise<{ store: SandboxStore; done(): Promise<void> }>;

/**
 * SBX0 §5: the behaviour both stores must share. The Lua scripts and the TypeScript model disagreeing
 * is the failure this exists for: handler tests run on the memory store, production on Redis.
 * T0 is the wall clock rounded down, because Redis's key TTLs are real time.
 */
export function sandboxStoreContract(name: string, make: MakeStore): void {
  const T0 = Math.floor(Date.now() / 1000);
  const LIMITS = { perSubject: 2, total: 3, retentionS: 3600 };
  let n = 0;
  const rec = (over: Partial<SandboxRecord> = {}): SandboxRecord => {
    n += 1;
    const id = `sbx-${String(n).padStart(26, '0')}`;
    return {
      id,
      owner: 'github:1',
      tenant: 'github:1',
      name: '',
      template: 'default',
      worker: 'sbx_default',
      wsk: id,
      labels: { project: 'p' },
      createdAt: T0 + n,
      expiresAt: T0 + 600,
      mode: 'per-exec',
      idleTimeoutS: 0,
      modeEpoch: 0,
      ...over,
    };
  };

  describe(`SandboxStore contract: ${name}`, () => {
    it('creates, then reads back the same record', async () => {
      const { store, done } = await make();
      const r = rec({ name: 'alpha', labels: { project: 'x', k: 'v' } });
      expect(await store.create(r, LIMITS, T0)).toBe('ok');
      expect(await store.get(r.id, T0)).toEqual(r);
      expect(await store.get('sbx-missing', T0)).toBeNull();
      // The mode fields round-trip as they were given, not as defaults.
      const leased = rec({ mode: 'lease+processes', idleTimeoutS: 120, modeEpoch: 4 });
      expect(await store.create(leased, LIMITS, T0)).toBe('ok');
      expect(await store.get(leased.id, T0)).toEqual(leased);
      await done();
    });

    it('raises the mode epoch on every setMode, even when nothing else changes', async () => {
      const { store, done } = await make();
      const r = rec({ name: 'm', labels: { project: 'x' } });
      await store.create(r, LIMITS, T0);
      const first = await store.setMode(r.id, 'lease', 600, T0);
      expect(first).toEqual({
        record: { ...r, mode: 'lease', idleTimeoutS: 600, modeEpoch: 1 },
        previousMode: 'per-exec',
      });
      // Same mode and timeout: a re-sent set-mode still needs a fresh epoch.
      expect(await store.setMode(r.id, 'lease', 600, T0)).toMatchObject({
        record: { mode: 'lease', idleTimeoutS: 600, modeEpoch: 2 },
        previousMode: 'lease',
      });
      expect(await store.setMode(r.id, 'per-exec', 0, T0)).toMatchObject({
        record: { mode: 'per-exec', idleTimeoutS: 0, modeEpoch: 3 },
        previousMode: 'lease',
      });
      expect(await store.get(r.id, T0)).toEqual({
        ...r,
        mode: 'per-exec',
        idleTimeoutS: 0,
        modeEpoch: 3,
      });
      await done();
    });

    it('gives two racing setMode calls distinct epochs', async () => {
      const { store, done } = await make();
      const r = rec();
      await store.create(r, LIMITS, T0);
      const out = await Promise.all([
        store.setMode(r.id, 'lease', 300, T0),
        store.setMode(r.id, 'lease+processes', 900, T0),
      ]);
      expect(out.map((o) => o?.record.modeEpoch).sort()).toEqual([1, 2]);
      expect((await store.get(r.id, T0))?.modeEpoch).toBe(2);
      // The previous mode is read in the same atomic step: the later call saw the earlier's mode.
      const [one, two] = [...out].sort((a, b) => a!.record.modeEpoch - b!.record.modeEpoch);
      expect(one!.previousMode).toBe('per-exec');
      expect(two!.previousMode).toBe(one!.record.mode);
      await done();
    });

    it('gives undefined from setMode for a missing or deleted sandbox, and changes nothing', async () => {
      const { store, done } = await make();
      expect(await store.setMode('sbx-missing', 'lease', 600, T0)).toBeUndefined();
      const r = rec();
      await store.create(r, LIMITS, T0);
      await store.markDeleted(r.id, T0 + 1, LIMITS.retentionS);
      expect(await store.setMode(r.id, 'lease', 600, T0)).toBeUndefined();
      expect(await store.get(r.id, T0 + 2)).toMatchObject({
        mode: 'per-exec',
        idleTimeoutS: 0,
        modeEpoch: 0,
        deletedAt: T0 + 1,
      });
      expect(await store.get('sbx-missing', T0)).toBeNull();
      await done();
    });

    it('gives undefined from setMode for an expired sandbox, and changes nothing (review #4559538369)', async () => {
      // As markDeleted reads it: expired AT expiresAt. A PUT that crosses expiry stores nothing.
      const { store, done } = await make();
      const r = rec({ expiresAt: T0 + 10 });
      await store.create(r, LIMITS, T0);
      expect(await store.setMode(r.id, 'lease', 600, T0 + 9)).toMatchObject({
        record: { mode: 'lease', modeEpoch: 1 },
      });
      expect(await store.setMode(r.id, 'per-exec', 0, T0 + 10)).toBeUndefined();
      expect(await store.setMode(r.id, 'per-exec', 0, T0 + 11)).toBeUndefined();
      expect(await store.get(r.id, T0 + 11)).toMatchObject({
        mode: 'lease',
        idleTimeoutS: 600,
        modeEpoch: 1,
      });
      await done();
    });

    it('returns a detached record from setMode', async () => {
      const { store, done } = await make();
      const r = rec({ labels: { project: 'p' } });
      await store.create(r, LIMITS, T0);
      const out = (await store.setMode(r.id, 'lease', 60, T0))!.record;
      out.labels.project = 'mutated';
      out.modeEpoch = 99;
      expect(await store.get(r.id, T0)).toMatchObject({ labels: { project: 'p' }, modeEpoch: 1 });
      await done();
    });

    it('enforces the per-subject quota on live sandboxes only', async () => {
      const { store, done } = await make();
      expect(await store.create(rec(), LIMITS, T0)).toBe('ok');
      const second = rec();
      expect(await store.create(second, LIMITS, T0)).toBe('ok');
      expect(await store.create(rec(), LIMITS, T0)).toBe('quota_subject');
      expect(await store.markDeleted(second.id, T0, LIMITS.retentionS)).toBe('deleted');
      expect(await store.create(rec(), LIMITS, T0)).toBe('ok');
      await done();
    });

    it('does not count an expired sandbox against either quota', async () => {
      const { store, done } = await make();
      expect(await store.create(rec({ expiresAt: T0 + 10 }), LIMITS, T0)).toBe('ok');
      expect(await store.create(rec({ expiresAt: T0 + 10 }), LIMITS, T0)).toBe('ok');
      expect(await store.create(rec(), LIMITS, T0 + 20)).toBe('ok');
      await done();
    });

    it('does not count expired sandboxes against the total quota', async () => {
      const { store, done } = await make();
      const limits = { ...LIMITS, perSubject: 3, total: 3 };
      for (const owner of ['github:1', 'github:2', 'github:3']) {
        expect(
          await store.create(rec({ owner, tenant: owner, expiresAt: T0 + 10 }), limits, T0),
        ).toBe('ok');
      }
      expect(
        await store.create(rec({ owner: 'github:4', tenant: 'github:4' }), limits, T0 + 20),
      ).toBe('ok');
      await done();
    });

    it('enforces the total quota across subjects', async () => {
      const { store, done } = await make();
      for (const owner of ['github:1', 'github:2', 'github:3']) {
        expect(await store.create(rec({ owner, tenant: owner }), LIMITS, T0)).toBe('ok');
      }
      expect(await store.create(rec({ owner: 'github:4', tenant: 'github:4' }), LIMITS, T0)).toBe(
        'quota_total',
      );
      await done();
    });

    it('lets only one of two racing creates take the last slot', async () => {
      const { store, done } = await make();
      expect(await store.create(rec(), LIMITS, T0)).toBe('ok');
      const outcomes = await Promise.all([
        store.create(rec(), LIMITS, T0),
        store.create(rec(), LIMITS, T0),
      ]);
      expect(outcomes.sort()).toEqual(['ok', 'quota_subject']);
      await done();
    });

    it('keeps names unique among one owner live sandboxes, and frees them on delete and expiry', async () => {
      const { store, done } = await make();
      const a = rec({ name: 'web' });
      expect(await store.create(a, LIMITS, T0)).toBe('ok');
      expect(await store.create(rec({ name: 'web' }), LIMITS, T0)).toBe('name_conflict');
      expect(
        await store.create(rec({ name: 'web', owner: 'github:2', tenant: 'github:2' }), LIMITS, T0),
      ).toBe('ok');
      await store.markDeleted(a.id, T0, LIMITS.retentionS);
      expect(await store.create(rec({ name: 'web', expiresAt: T0 + 5 }), LIMITS, T0)).toBe('ok');
      await done();
    });

    it("frees a name once its holder is expired by the caller's clock, with no wait", async () => {
      const { store, done } = await make();
      // Liveness is the caller's nowS, not a Redis key TTL: wall time never reaches T0 + 600 here.
      expect(await store.create(rec({ name: 'x', expiresAt: T0 + 600 }), LIMITS, T0)).toBe('ok');
      expect(await store.create(rec({ name: 'x', expiresAt: T0 + 1200 }), LIMITS, T0 + 601)).toBe(
        'ok',
      );
      await done();
    });

    it('frees a name at expiry', async () => {
      const { store, done } = await make();
      // Real time: both the caller's clock and Redis's pass a 1 s expiry, so this one sleeps.
      expect(await store.create(rec({ name: 'soon', expiresAt: T0 + 1 }), LIMITS, T0)).toBe('ok');
      await new Promise((r) => setTimeout(r, (T0 + 2) * 1000 - Date.now() + 50));
      expect(await store.create(rec({ name: 'soon' }), LIMITS, T0 + 2)).toBe('ok');
      await done();
    });

    it('deletes idempotently, and treats an expired sandbox as already ended', async () => {
      const { store, done } = await make();
      const a = rec();
      const b = rec({ expiresAt: T0 + 10 });
      await store.create(a, LIMITS, T0);
      await store.create(b, LIMITS, T0);
      expect(await store.markDeleted(a.id, T0 + 1, LIMITS.retentionS)).toBe('deleted');
      expect(await store.markDeleted(a.id, T0 + 2, LIMITS.retentionS)).toBe('already');
      expect(await store.markDeleted(b.id, T0 + 20, LIMITS.retentionS)).toBe('already');
      expect(await store.markDeleted('sbx-nope', T0, LIMITS.retentionS)).toBe('not_found');
      expect(viewOf((await store.get(a.id, T0 + 3))!, T0 + 3)).toMatchObject({
        state: 'terminated',
        reason: 'deleted',
        terminatedAt: T0 + 1,
      });
      expect(viewOf((await store.get(b.id, T0 + 20))!, T0 + 20)).toMatchObject({
        state: 'terminated',
        reason: 'expired',
        terminatedAt: T0 + 10,
      });
      await done();
    });

    // createSandbox's rollback (#806): a create undone leaves no record, slot or name behind.
    it('drops a record deleted with no retention at once, freeing its slot and its name', async () => {
      const { store, done } = await make();
      const one = { ...LIMITS, perSubject: 1 };
      const a = rec({ name: 'web' });
      expect(await store.create(a, one, T0)).toBe('ok');
      expect(await store.markDeleted(a.id, T0, 0)).toBe('deleted');
      expect(await store.get(a.id, T0)).toBeNull();
      expect(await store.listByOwner('github:1', T0)).toEqual([]);
      expect(await store.listAll(T0)).toEqual([]);
      const b = rec({ name: 'web' });
      expect(await store.create(b, one, T0)).toBe('ok');
      expect((await store.listByOwner('github:1', T0)).map((r) => r.id)).toEqual([b.id]);
      await done();
    });

    it("lists an owner's sandboxes newest first, terminated included, and nobody else's", async () => {
      const { store, done } = await make();
      const a = rec();
      const b = rec();
      const other = rec({ owner: 'github:2', tenant: 'github:2' });
      for (const r of [a, b, other]) await store.create(r, LIMITS, T0);
      await store.markDeleted(a.id, T0, LIMITS.retentionS);
      expect((await store.listByOwner('github:1', T0)).map((r) => r.id)).toEqual([b.id, a.id]);
      expect((await store.listAll(T0)).map((r) => r.id)).toEqual([other.id, b.id, a.id]);
      await done();
    });

    it('touch moves expiresAt to now + L, and the sandbox stays live past its old deadline', async () => {
      const { store, done } = await make();
      const r = rec();
      await store.create(r, LIMITS, T0);
      expect(await store.touch(r.id, T0 + 100, 1000, LIMITS.retentionS)).toEqual({
        ...r,
        expiresAt: T0 + 1100,
      });
      expect(viewOf((await store.get(r.id, T0 + 700))!, T0 + 700).state).toBe('ready');
      expect(viewOf((await store.get(r.id, T0 + 1100))!, T0 + 1100)).toMatchObject({
        state: 'terminated',
        reason: 'expired',
      });
      await done();
    });

    it('touch never moves expiresAt backwards', async () => {
      const { store, done } = await make();
      const r = rec();
      await store.create(r, LIMITS, T0);
      const got = await store.touch(r.id, T0 + 100, 60, LIMITS.retentionS);
      expect(got?.expiresAt).toBe(T0 + 600);
      expect((await store.get(r.id, T0 + 100))?.expiresAt).toBe(T0 + 600);
      await done();
    });

    it('touch refuses a missing, deleted or expired sandbox, the boundary included', async () => {
      const { store, done } = await make();
      expect(await store.touch('sbx-missing', T0, 1000, LIMITS.retentionS)).toBeNull();
      const gone = rec();
      await store.create(gone, LIMITS, T0);
      await store.markDeleted(gone.id, T0 + 10, LIMITS.retentionS);
      expect(await store.touch(gone.id, T0 + 20, 1000, LIMITS.retentionS)).toBeNull();
      expect(await store.get(gone.id, T0 + 20)).toEqual({
        ...gone,
        deletedAt: T0 + 10,
      });
      const edge = rec();
      await store.create(edge, LIMITS, T0);
      expect(await store.touch(edge.id, T0 + 600, 1000, LIMITS.retentionS)).toBeNull();
      expect((await store.get(edge.id, T0 + 600))?.expiresAt).toBe(T0 + 600);
      await done();
    });

    it('a touched sandbox counts for quotas and holds its name past the old deadline', async () => {
      const { store, done } = await make();
      const limits = { ...LIMITS, perSubject: 2 };
      const keep = rec({ name: 'keep' });
      await store.create(keep, limits, T0);
      await store.touch(keep.id, T0 + 100, 1900, limits.retentionS);
      expect(await store.get(keep.id, T0 + 700)).toMatchObject({ expiresAt: T0 + 2000 });
      expect(await store.create(rec({ name: 'keep' }), limits, T0 + 700)).toBe('name_conflict');
      expect(await store.create(rec({ name: 'two', expiresAt: T0 + 2000 }), limits, T0 + 700)).toBe(
        'ok',
      );
      expect(await store.create(rec({ name: 'three' }), limits, T0 + 700)).toBe('quota_subject');
      await done();
    });

    it('round-trips idleLifetimeS, and leaves it absent when not given', async () => {
      const { store, done } = await make();
      const withL = rec({ idleLifetimeS: 86_400 });
      const without = rec();
      await store.create(withL, LIMITS, T0);
      await store.create(without, LIMITS, T0);
      expect(await store.get(withL.id, T0)).toEqual(withL);
      const got = (await store.get(without.id, T0))!;
      expect('idleLifetimeS' in got).toBe(false);
      await done();
    });

    it('markReleased records releasedAt on an ended record only, once, keeping its retention', async () => {
      const { store, done } = await make();
      const live = rec();
      const gone = rec();
      const aged = rec({ owner: 'github:2', expiresAt: T0 + 10 });
      for (const r of [live, gone, aged]) expect(await store.create(r, LIMITS, T0)).toBe('ok');
      expect(await store.get(gone.id, T0)).not.toHaveProperty('releasedAt');
      // A live sandbox is never released, and a missing one is not created.
      expect(await store.markReleased(live.id, T0)).toBe(false);
      expect(await store.markReleased('sbx-missing', T0)).toBe(false);
      expect(await store.get(live.id, T0)).not.toHaveProperty('releasedAt');
      expect(await store.get('sbx-missing', T0)).toBeNull();
      await store.markDeleted(gone.id, T0 + 1, LIMITS.retentionS);
      expect(await store.markReleased(gone.id, T0 + 2)).toBe(true);
      // The first answer's time stays.
      expect(await store.markReleased(gone.id, T0 + 3)).toBe(true);
      expect(await store.get(gone.id, T0 + 3)).toEqual({
        ...gone,
        deletedAt: T0 + 1,
        releasedAt: T0 + 2,
      });
      // Expired by the clock alone (the boundary included) is ended too.
      expect(await store.markReleased(aged.id, T0 + 9)).toBe(false);
      expect(await store.markReleased(aged.id, T0 + 10)).toBe(true);
      expect((await store.get(aged.id, T0 + 10))?.releasedAt).toBe(T0 + 10);
      // Still listed, as retention keeps it: the mark does not move the purge.
      expect((await store.listAll(T0 + 10)).map((r) => r.id)).toContain(gone.id);
      await done();
    });

    it('claimRelease lets one caller send a release, until it is answered, dropped or lapses', async () => {
      const { store, done } = await make();
      const live = rec();
      const gone = rec();
      for (const r of [live, gone]) expect(await store.create(r, LIMITS, T0)).toBe('ok');
      expect(await store.claimRelease(live.id, T0, 60)).toBe(false);
      expect(await store.claimRelease('sbx-missing', T0, 60)).toBe(false);
      await store.markDeleted(gone.id, T0 + 1, LIMITS.retentionS);
      expect(await store.claimRelease(gone.id, T0 + 1, 60)).toBe(true);
      // Held: a second sender (a concurrent DELETE or sweep) does not send.
      expect(await store.claimRelease(gone.id, T0 + 1, 60)).toBe(false);
      // Dropped after an unanswered release: the next one may send.
      await store.unclaimRelease(gone.id);
      expect(await store.claimRelease(gone.id, T0 + 1, 1)).toBe(true);
      // A crashed sender's claim lapses (Redis by its key's real-time TTL, memory by nowS).
      await new Promise((r) => setTimeout(r, 1100));
      expect(await store.claimRelease(gone.id, T0 + 3, 60)).toBe(true);
      // Answered: nobody claims it again; the record itself is unchanged by the claims.
      await store.markReleased(gone.id, T0 + 3);
      await store.unclaimRelease(gone.id);
      expect(await store.claimRelease(gone.id, T0 + 3, 60)).toBe(false);
      expect(await store.get(gone.id, T0 + 3)).toEqual({
        ...gone,
        deletedAt: T0 + 1,
        releasedAt: T0 + 3,
      });
      await done();
    });
  });
}
