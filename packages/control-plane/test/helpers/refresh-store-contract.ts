import { afterEach, describe, expect, it } from 'vitest';
import {
  isRefreshTokenShape,
  type AuditFields,
  type RefreshPolicy,
  type RefreshStore,
} from '../../src/refresh-store.js';

export type MakeStore = (policy: RefreshPolicy) => Promise<{
  store: RefreshStore;
  audit(): Promise<AuditFields[]>;
  /** The separate stream refusals of an unknown token go to: no family, no principal (#467). */
  anonAudit(): Promise<AuditFields[]>;
  done(): Promise<void>;
}>;

const S = 1000;
const DAY = 86_400 * S;
const T0 = 1_757_000_000_000;
const POLICY: RefreshPolicy = { idleTtlS: 30 * 86_400, maxTtlS: 90 * 86_400, graceS: 30 };

type Handle = Awaited<ReturnType<MakeStore>>;

/**
 * The behaviour B14 spec §4.3 pins, run against every RefreshStore. The Lua script and the
 * TypeScript fake disagreeing is the failure mode this exists for: handler tests run on the fake,
 * production on the script.
 */
export function refreshStoreContract(name: string, make: MakeStore): void {
  describe(`RefreshStore contract: ${name}`, () => {
    let h: Handle | undefined;
    const setup = async (policy: RefreshPolicy = POLICY) => (h = await make(policy));
    afterEach(async () => {
      const cur = h;
      h = undefined;
      await cur?.done();
    });
    const cur = () => {
      if (!h) throw new Error('setup() not called');
      return h;
    };
    const login = (subject = 'github:1', nowMs = T0) =>
      cur().store.issue({ subject, displayName: 'Ada', label: 'laptop', nowMs });

    it('issues an mrt_ token, caps it at the absolute limit, and audits refresh_issued', async () => {
      await setup();
      const i = await login();
      expect(isRefreshTokenShape(i.refreshToken)).toBe(true);
      expect(i.absExpS).toBe(Math.floor((T0 + 90 * DAY) / 1000));
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
      ]);
    });

    it('rotates: a new token each time, the old one superseded', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0 + 60 * S);
      expect(r1).toMatchObject({
        ok: true,
        family: i.family,
        subject: 'github:1',
        graceReplay: false,
        absExpS: i.absExpS,
      });
      if (!r1.ok) throw new Error('unreachable');
      expect(r1.refreshToken).not.toBe(i.refreshToken);
      expect(r1.displayName).toBe('Ada');
      const r2 = await cur().store.rotate(r1.refreshToken, T0 + 120 * S);
      expect(r2).toMatchObject({ ok: true, absExpS: i.absExpS });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0 + 60 * S),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 120 * S),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
      ]);
    });

    it('answers a replay of the previous token inside the grace window with the SAME successor', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      const again = await cur().store.rotate(i.refreshToken, T0 + 10 * S);
      expect(again).toMatchObject({ ok: true, graceReplay: true, absExpS: i.absExpS });
      if (!again.ok) throw new Error('unreachable');
      expect(again.refreshToken).toBe(r1.refreshToken);
      // The family is still live: the successor keeps working.
      const r3 = await cur().store.rotate(r1.refreshToken, T0 + 20 * S);
      expect(r3).toMatchObject({ ok: true, absExpS: i.absExpS });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 10 * S),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
          reason: 'grace_replay',
        },
        {
          ts: String(T0 + 20 * S),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
      ]);
    });

    it('revokes the family when the previous token comes back after the grace window', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      expect(await cur().store.rotate(i.refreshToken, T0 + 31 * S)).toEqual({
        ok: false,
        reason: 'reuse',
      });
      // Both holders are now out: the legitimate successor is refused too.
      expect(await cur().store.rotate(r1.refreshToken, T0 + 32 * S)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 31 * S),
          subject: 'github:1',
          decision: 'refresh_reuse_detected',
          family: i.family,
        },
        {
          ts: String(T0 + 32 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'revoked',
        },
      ]);
    });

    it('treats a token two generations old as reuse even inside the grace window', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      await cur().store.rotate(r1.refreshToken, T0 + 1 * S);
      expect(await cur().store.rotate(i.refreshToken, T0 + 2 * S)).toEqual({
        ok: false,
        reason: 'reuse',
      });
    });

    it('slides the idle limit on use and refuses after it lapses', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0 + 29 * DAY);
      expect(r1.ok).toBe(true);
      if (!r1.ok) throw new Error('unreachable');
      // 29 days after the LAST use is still fine; 30 is not.
      const r2 = await cur().store.rotate(r1.refreshToken, T0 + 58 * DAY);
      expect(r2.ok).toBe(true);
      if (!r2.ok) throw new Error('unreachable');
      const r3 = await cur().store.rotate(r2.refreshToken, T0 + 88 * DAY);
      expect(r3).toEqual({
        ok: false,
        reason: 'idle_expired',
      });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0 + 29 * DAY),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 58 * DAY),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 88 * DAY),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'idle_expired',
        },
      ]);
    });

    it('never extends past the absolute limit, however often it is used', async () => {
      await setup({ idleTtlS: 10 * 86_400, maxTtlS: 15 * 86_400, graceS: 30 });
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0 + 9 * DAY);
      if (!r1.ok) throw new Error('unreachable');
      const r2 = await cur().store.rotate(r1.refreshToken, T0 + 15 * DAY);
      expect(r2).toEqual({
        ok: false,
        reason: 'abs_expired',
      });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0 + 9 * DAY),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 15 * DAY),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'abs_expired',
        },
      ]);
    });

    it('refuses an unknown token and audits it in the anonymous stream, not the main one', async () => {
      await setup();
      expect(await cur().store.rotate('mrt_' + 'A'.repeat(43), T0)).toEqual({
        ok: false,
        reason: 'unknown',
      });
      // Anyone can send these, so they must not share (and so trim away) the main audit history.
      expect(await cur().audit()).toEqual([]);
      expect(await cur().anonAudit()).toEqual([
        {
          ts: String(T0),
          subject: '-',
          decision: 'refresh_refused',
          family: '-',
          reason: 'unknown',
        },
      ]);
    });

    it('revokes by any token of the family, idempotently, auditing the transition once', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      expect(await cur().store.revoke(i.refreshToken, T0 + S)).toBe(true); // a superseded token still names it
      expect(await cur().store.revoke(r1.refreshToken, T0 + 2 * S)).toBe(true);
      expect(await cur().store.rotate(r1.refreshToken, T0 + 3 * S)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + S),
          subject: 'github:1',
          decision: 'refresh_revoked',
          family: i.family,
          reason: 'logout',
        },
        {
          ts: String(T0 + 3 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'revoked',
        },
      ]);
    });

    it('answers false, and audits nothing, when revoking a token nobody issued', async () => {
      await setup();
      expect(await cur().store.revoke('mrt_' + 'B'.repeat(43), T0)).toBe(false);
      expect(await cur().audit()).toEqual([]);
    });

    it('revokeAllFor revokes every family of one subject and none of another', async () => {
      await setup();
      const a1 = await login('github:1');
      const a2 = await login('github:1');
      const b = await login('github:2');
      expect(await cur().store.revokeAllFor('github:1', T0 + S)).toBe(2);
      expect((await cur().store.rotate(a1.refreshToken, T0 + 2 * S)).ok).toBe(false);
      expect((await cur().store.rotate(a2.refreshToken, T0 + 2 * S)).ok).toBe(false);
      expect((await cur().store.rotate(b.refreshToken, T0 + 2 * S)).ok).toBe(true);
      const a = await cur().audit();
      expect(a).toHaveLength(8); // 3 issued, 2 revoked, 3 rotate outcomes — nothing else
      expect(a.slice(0, 3)).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: a1.family },
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: a2.family },
        { ts: String(T0), subject: 'github:2', decision: 'refresh_issued', family: b.family },
      ]);
      const byFamily = (x: AuditFields, y: AuditFields) => x.family!.localeCompare(y.family!);
      expect([...a.slice(3, 5)].sort(byFamily)).toEqual(
        [
          {
            ts: String(T0 + S),
            subject: 'github:1',
            decision: 'refresh_revoked' as const,
            family: a1.family,
            reason: 'logout_all',
          },
          {
            ts: String(T0 + S),
            subject: 'github:1',
            decision: 'refresh_revoked' as const,
            family: a2.family,
            reason: 'logout_all',
          },
        ].sort(byFamily),
      );
      expect(a.slice(5)).toEqual([
        {
          ts: String(T0 + 2 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: a1.family,
          reason: 'revoked',
        },
        {
          ts: String(T0 + 2 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: a2.family,
          reason: 'revoked',
        },
        {
          ts: String(T0 + 2 * S),
          subject: 'github:2',
          decision: 'refresh_rotated',
          family: b.family,
        },
      ]);
      expect(await cur().store.revokeAllFor('github:1', T0 + 3 * S)).toBe(0);
      expect(await cur().audit()).toHaveLength(8);
    });

    it('checks revoked BEFORE grace: revoked token never gets a grace answer', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      await cur().store.revoke(r1.refreshToken, T0 + S);
      // Replay i (the predecessor) at T0+2s: inside the grace window, but family is revoked.
      // §4.3 checks revoked before grace, so this should be 'revoked', not a grace answer.
      const result = await cur().store.rotate(i.refreshToken, T0 + 2 * S);
      expect(result).toEqual({ ok: false, reason: 'revoked' });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + S),
          subject: 'github:1',
          decision: 'refresh_revoked',
          family: i.family,
          reason: 'logout',
        },
        {
          ts: String(T0 + 2 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'revoked',
        },
      ]);
    });

    it('checks revoked BEFORE reuse: revoked family refuses reuse without refresh_reuse_detected', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      await cur().store.revoke(r1.refreshToken, T0 + S);
      // Replay i (the old token): after the grace window, would normally be reuse. But family is revoked.
      // §4.3 checks revoked before reuse, so no refresh_reuse_detected; just refresh_refused:revoked.
      const result = await cur().store.rotate(i.refreshToken, T0 + 31 * S);
      expect(result).toEqual({ ok: false, reason: 'revoked' });
      const audit = await cur().audit();
      expect(audit.filter((e) => e.decision === 'refresh_reuse_detected')).toEqual([]);
      expect(audit.filter((e) => e.decision === 'refresh_refused')).toEqual([
        {
          ts: String(T0 + 31 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'revoked',
        },
      ]);
    });

    it('checks revoked BEFORE expiry: expiration does not matter if family is revoked', async () => {
      await setup();
      const i = await login();
      await cur().store.revoke(i.refreshToken, T0 + S);
      // Try to rotate after the absolute expiry: revoked check comes first.
      const result = await cur().store.rotate(i.refreshToken, T0 + 91 * DAY);
      expect(result).toEqual({ ok: false, reason: 'revoked' });
    });

    it('checks expiry BEFORE grace/reuse: absolute expiry blocks grace and reuse', async () => {
      await setup({ idleTtlS: 60, maxTtlS: 60, graceS: 30 });
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0 + 50 * S);
      if (!r1.ok) throw new Error('unreachable');
      // At T0+60s: absExp is reached. Replay i inside grace window: should be abs_expired, not grace.
      const r2 = await cur().store.rotate(i.refreshToken, T0 + 60 * S);
      expect(r2).toEqual({ ok: false, reason: 'abs_expired' });
      // At T0+90s: still expired. Replay i: should be abs_expired, not reuse (and family not marked reuse).
      const r3 = await cur().store.rotate(i.refreshToken, T0 + 90 * S);
      expect(r3).toEqual({ ok: false, reason: 'abs_expired' });
      // Verify no refresh_reuse_detected in audit: just two abs_expired refusals.
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0 + 50 * S),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 60 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'abs_expired',
        },
        {
          ts: String(T0 + 90 * S),
          subject: 'github:1',
          decision: 'refresh_refused',
          family: i.family,
          reason: 'abs_expired',
        },
      ]);
    });

    it('grace boundary: a replay at exactly T0+graceS (now == untilMs) is NOT a grace answer', async () => {
      await setup();
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      // At T0+30s: exactly at the grace boundary (now == untilMs). Should be reuse, not grace.
      const result = await cur().store.rotate(i.refreshToken, T0 + 30 * S);
      expect(result).toEqual({ ok: false, reason: 'reuse' });
      expect(await cur().audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
        {
          ts: String(T0),
          subject: 'github:1',
          decision: 'refresh_rotated',
          family: i.family,
        },
        {
          ts: String(T0 + 30 * S),
          subject: 'github:1',
          decision: 'refresh_reuse_detected',
          family: i.family,
        },
      ]);
    });

    it('grace replay changes no state: idle is not slid by a grace answer', async () => {
      await setup({ idleTtlS: 60, maxTtlS: 3600, graceS: 30 });
      const i = await login();
      const r1 = await cur().store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      // Grace replay at T0+20s (inside window).
      const grace = await cur().store.rotate(i.refreshToken, T0 + 20 * S);
      expect(grace).toMatchObject({ ok: true, graceReplay: true });
      if (!grace.ok) throw new Error('unreachable');
      // Now rotate the successor at T0+61s: should be idle_expired.
      // If grace had slid idleExp, this would succeed. But it doesn't, so it expires.
      const result = await cur().store.rotate(r1.refreshToken, T0 + 61 * S);
      expect(result).toEqual({ ok: false, reason: 'idle_expired' });
    });

    it('never writes a token or a hash into the audit stream', async () => {
      await setup();
      const i = await login();
      await cur().store.rotate(i.refreshToken, T0);
      await cur().store.rotate('mrt_' + 'C'.repeat(43), T0);
      const text = JSON.stringify([await cur().audit(), await cur().anonAudit()]);
      expect(text).not.toMatch(/mrt_/);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    });
  });
}
