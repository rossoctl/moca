import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Refresh tokens for long-lived client logins (B14, ADR-0039). An opaque random secret, stored only
 * as its hash under a per-login FAMILY; every use rotates it, and a superseded token coming back
 * after the grace window revokes the family -- reuse detection, the OAuth 2.1 rule for public clients.
 *
 * This file is the contract and its in-memory model. RedisRefreshStore (refresh-redis.ts) is the
 * production one; test/helpers/refresh-store-contract.ts runs the same suite against both.
 */

/** A prefix secret scanners can match on. */
export const REFRESH_TOKEN_PREFIX = 'mrt_';
const TOKEN_RE = /^mrt_[A-Za-z0-9_-]{43}$/;

export function newRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** The exact minted shape. Anything else is refused before it is hashed or looked up. */
export function isRefreshTokenShape(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

/** A fast hash is enough: the input is 256 random bits, not a password. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RefreshPolicy {
  idleTtlS: number;
  maxTtlS: number;
  graceS: number;
}

export interface IssueInput {
  subject: string;
  displayName: string;
  /** A client hint (mocactl sends the hostname). Shown back, never trusted. */
  label: string;
  nowMs: number;
}

export interface Issued {
  family: string;
  refreshToken: string;
  absExpS: number;
}

export type RefusalReason = 'unknown' | 'revoked' | 'idle_expired' | 'abs_expired' | 'reuse';

export type RotateResult =
  | {
      ok: true;
      family: string;
      subject: string;
      displayName: string;
      refreshToken: string;
      absExpS: number;
      /** True when this answered a retried predecessor inside the grace window (spec §4.3 step 4). */
      graceReplay: boolean;
    }
  | { ok: false; reason: RefusalReason };

export interface RefreshStore {
  issue(input: IssueInput): Promise<Issued>;
  rotate(token: string, nowMs: number): Promise<RotateResult>;
  /** True when the token names a family (revoked now or already); false for a token nobody issued. */
  revoke(token: string, nowMs: number): Promise<boolean>;
  /** How many of the subject's families this call revoked. */
  revokeAllFor(subject: string, nowMs: number): Promise<number>;
}

export type AuditFields = Record<string, string>;

/** The longest a client-supplied label is kept. */
export const MAX_LABEL_CHARS = 64;

interface Family {
  subject: string;
  displayName: string;
  label: string;
  createdAt: number;
  absExp: number;
  idleExp: number;
  currentHash: string;
  prevHash: string;
  revokedAt?: number;
}

/**
 * The spec's semantics in plain TypeScript, for handler tests. Expiry is judged from `nowMs` and the
 * stored fields only -- no eviction on its own clock -- exactly as the Lua script judges it, so one
 * injected clock drives both.
 */
export class MemoryRefreshStore implements RefreshStore {
  readonly audit: AuditFields[] = [];
  /** Refusals of a token nobody issued: the anonymous stream (RedisRefreshStore's `audit:anon`). */
  readonly anonAudit: AuditFields[] = [];
  private readonly families = new Map<string, Family>();
  /** hash -> family id, kept after rotation so a stale token is recognised (spec §4.2). */
  private readonly tokens = new Map<string, string>();
  private readonly grace = new Map<string, { token: string; untilMs: number }>();

  constructor(private readonly policy: RefreshPolicy) {}

  private record(
    nowMs: number,
    subject: string,
    decision: string,
    family: string,
    reason?: string,
  ) {
    this.audit.push({
      ts: String(nowMs),
      subject,
      decision,
      family,
      ...(reason ? { reason } : {}),
    });
  }

  async issue(input: IssueInput): Promise<Issued> {
    const family = randomUUID();
    const refreshToken = newRefreshToken();
    const absExp = input.nowMs + this.policy.maxTtlS * 1000;
    const hash = hashRefreshToken(refreshToken);
    this.families.set(family, {
      subject: input.subject,
      displayName: input.displayName,
      label: input.label.slice(0, MAX_LABEL_CHARS),
      createdAt: input.nowMs,
      absExp,
      idleExp: Math.min(input.nowMs + this.policy.idleTtlS * 1000, absExp),
      currentHash: hash,
      prevHash: '',
    });
    this.tokens.set(hash, family);
    this.record(input.nowMs, input.subject, 'refresh_issued', family);
    return { family, refreshToken, absExpS: Math.floor(absExp / 1000) };
  }

  async rotate(token: string, nowMs: number): Promise<RotateResult> {
    const hash = hashRefreshToken(token);
    const fid = this.tokens.get(hash);
    const f = fid ? this.families.get(fid) : undefined;
    if (!fid || !f) {
      this.anonAudit.push({
        ts: String(nowMs),
        subject: '-',
        decision: 'refresh_refused',
        family: '-',
        reason: 'unknown',
      });
      return { ok: false, reason: 'unknown' };
    }
    const refuse = (reason: RefusalReason): RotateResult => {
      this.record(nowMs, f.subject, 'refresh_refused', fid, reason);
      return { ok: false, reason };
    };
    if (f.revokedAt !== undefined) return refuse('revoked');
    if (nowMs >= f.absExp) return refuse('abs_expired');
    if (nowMs >= f.idleExp) return refuse('idle_expired');
    const absExpS = Math.floor(f.absExp / 1000);
    const g = this.grace.get(fid);
    if (hash === f.prevHash && g && nowMs < g.untilMs) {
      this.record(nowMs, f.subject, 'refresh_rotated', fid, 'grace_replay');
      return {
        ok: true,
        family: fid,
        subject: f.subject,
        displayName: f.displayName,
        refreshToken: g.token,
        absExpS,
        graceReplay: true,
      };
    }
    if (hash !== f.currentHash) {
      f.revokedAt = nowMs;
      this.grace.delete(fid);
      this.record(nowMs, f.subject, 'refresh_reuse_detected', fid);
      return { ok: false, reason: 'reuse' };
    }
    const next = newRefreshToken();
    const nextHash = hashRefreshToken(next);
    f.prevHash = f.currentHash;
    f.currentHash = nextHash;
    f.idleExp = Math.min(nowMs + this.policy.idleTtlS * 1000, f.absExp);
    this.tokens.set(nextHash, fid);
    this.grace.set(fid, { token: next, untilMs: nowMs + this.policy.graceS * 1000 });
    this.record(nowMs, f.subject, 'refresh_rotated', fid);
    return {
      ok: true,
      family: fid,
      subject: f.subject,
      displayName: f.displayName,
      refreshToken: next,
      absExpS,
      graceReplay: false,
    };
  }

  private revokeFamily(fid: string, nowMs: number, reason: 'logout' | 'logout_all'): boolean {
    const f = this.families.get(fid);
    if (!f || f.revokedAt !== undefined) return false;
    f.revokedAt = nowMs;
    // The revoked check (in rotate) precedes grace, so deleting the grace entry is garbage
    // collection, not a semantic part of reuse detection.
    this.grace.delete(fid);
    this.record(nowMs, f.subject, 'refresh_revoked', fid, reason);
    return true;
  }

  async revoke(token: string, nowMs: number): Promise<boolean> {
    const fid = this.tokens.get(hashRefreshToken(token));
    if (!fid || !this.families.has(fid)) return false;
    this.revokeFamily(fid, nowMs, 'logout');
    return true;
  }

  async revokeAllFor(subject: string, nowMs: number): Promise<number> {
    let n = 0;
    for (const [fid, f] of this.families) {
      if (f.subject === subject && this.revokeFamily(fid, nowMs, 'logout_all')) n++;
    }
    return n;
  }
}
