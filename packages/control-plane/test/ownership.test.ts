import { beforeEach, describe, expect, it } from 'vitest';
import { subjectHash } from '../src/k8s-secret-store.js';
import {
  AUDIT_MAXLEN,
  AUDIT_STREAM,
  OwnershipIndex,
  ownerKey,
  runtimeKey,
  sessionKey,
  type SessionRecord,
} from '../src/ownership.js';
import { fakeRedis } from './helpers/fake-redis.js';

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 'sid-1',
  owner: 'github:1234',
  tenant: 'github:1234',
  createdAt: 1_757_000_000_000,
  state: 'active',
  poolSelector: null,
  credentialName: 'my-anthropic',
  configRef: null,
  sandboxTier: '',
  tombstone: false,
  ...over,
});

describe('keyspace', () => {
  it('matches spec §7.2', () => {
    expect(sessionKey('sid-1')).toBe('sh:cp:session:sid-1');
    expect(runtimeKey('sid-1')).toBe('sh:cp:session:sid-1:runtime');
    expect(ownerKey('github:1234')).toBe(`sh:cp:owner:${subjectHash('github:1234')}:sessions`);
    expect(AUDIT_STREAM).toBe('sh:cp:audit');
  });

  it('hashes the subject into the owner key, so the keyspace discloses no logins', () => {
    expect(ownerKey('github:1234')).not.toContain('1234');
  });
});

describe('create and get', () => {
  let f: ReturnType<typeof fakeRedis>;
  let index: OwnershipIndex;

  beforeEach(() => {
    f = fakeRedis();
    index = new OwnershipIndex(f.redis);
  });

  it('round-trips a record through the hash', async () => {
    await index.create(rec());
    expect(await index.get('sid-1')).toEqual(rec());
  });

  it('round-trips a poolSelector and a tombstone', async () => {
    await index.create(rec({ poolSelector: 'sh.kagenti.io/tenant=github-1234' }));
    expect((await index.get('sid-1'))?.poolSelector).toBe('sh.kagenti.io/tenant=github-1234');
    await index.tombstone('sid-1');
    const after = await index.get('sid-1');
    expect(after?.tombstone).toBe(true);
    expect(after?.state).toBe('deleting');
  });

  it('returns null for an unknown session rather than a half-empty record', async () => {
    expect(await index.get('nope')).toBeNull();
  });

  it('surfaces a Redis outage as redis_unavailable (503) on reads AND writes', async () => {
    // Spec §9.2: Redis down => session routes 503, while /v1/credentials stays up (they are in
    // different stores, §7.1). Only the index can make that distinction -- and it has to make it for
    // writes too, or POST /v1/sessions and DELETE /v1/sessions/{id} answer 500 instead.
    const down = () => {
      throw new Error('ECONNREFUSED 127.0.0.1:6379');
    };
    const broken = new OwnershipIndex({
      ...fakeRedis().redis,
      hGetAll: async () => down(),
      hSet: async () => down(),
      zAdd: async () => down(),
      zRem: async () => down(),
      del: async () => down(),
      xAdd: async () => down(),
      // zRange too, or listByOwner -- the ONLY user-facing list path -- is missing from the seven entry
      // points this exercises, and a 500 there would break /v1/sessions during an outage while every
      // other route correctly said 503.
      zRange: async () => down(),
      zScore: async () => down(),
    });
    const unavailable = { code: 'redis_unavailable' };
    await expect(broken.get('sid-1')).rejects.toMatchObject(unavailable);
    await expect(broken.create(rec())).rejects.toMatchObject(unavailable);
    await expect(broken.tombstone('sid-1')).rejects.toMatchObject(unavailable);
    await expect(broken.cascadeDelete(rec())).rejects.toMatchObject(unavailable);
    await expect(broken.getRuntime('sid-1')).rejects.toMatchObject(unavailable);
    await expect(broken.putRuntime('sid-1', { harnessPod: 'h' })).rejects.toMatchObject(
      unavailable,
    );
    await expect(broken.audit({ subject: 'github:1', decision: 'x' })).rejects.toMatchObject(
      unavailable,
    );
    await expect(broken.listByOwner('github:1234')).rejects.toMatchObject(unavailable);
  });

  it('returns null when the hash exists but has no owner', async () => {
    // A partially-written hash must not read as a session owned by nobody, which assertOwner would
    // then compare against and could match an empty principal.
    await f.redis.hSet(sessionKey('half'), { createdAt: '1' });
    expect(await index.get('half')).toBeNull();
  });

  it('adds the session to its owner zset scored by createdAt', async () => {
    await index.create(rec());
    expect(f.zsets.get(ownerKey('github:1234'))).toEqual([
      { score: 1_757_000_000_000, value: 'sid-1' },
    ]);
  });

  it('reads a record written before P6.3 (no sandboxTier field) as undefined, not ""', async () => {
    const fake = fakeRedis();
    const oldIndex = new OwnershipIndex(fake.redis);
    await fake.redis.hSet(sessionKey('old'), {
      owner: 'github:1',
      tenant: 'github:1',
      createdAt: '1',
      state: 'active',
      poolSelector: '',
      credentialName: '',
      tombstone: '0',
    });
    expect((await oldIndex.get('old'))?.sandboxTier).toBeUndefined();
  });
});

describe('listByOwner', () => {
  let index: OwnershipIndex;

  beforeEach(async () => {
    index = new OwnershipIndex(fakeRedis().redis);
    for (let i = 1; i <= 5; i++) {
      await index.create(rec({ sessionId: `sid-${i}`, createdAt: 1000 + i }));
    }
    await index.create(rec({ sessionId: 'other', owner: 'github:9999', tenant: 'github:9999' }));
  });

  it('is the ONLY user-facing list path, and returns newest first', async () => {
    // LogStore.list() must never serve one: it is a keys('session:*') scan (spec §2.3), O(keyspace)
    // and unowned. This method reads the owner zset instead.
    const page = await index.listByOwner('github:1234');
    expect(page.sessions.map((s) => s.sessionId)).toEqual([
      'sid-5',
      'sid-4',
      'sid-3',
      'sid-2',
      'sid-1',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("omits another owner's sessions", async () => {
    const page = await index.listByOwner('github:1234');
    expect(page.sessions.map((s) => s.sessionId)).not.toContain('other');
    expect((await index.listByOwner('github:9999')).sessions.map((s) => s.sessionId)).toEqual([
      'other',
    ]);
  });

  it('pages with an exclusive cursor and reports the next one', async () => {
    const first = await index.listByOwner('github:1234', { limit: 2 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(['sid-5', 'sid-4']);
    expect(first.nextCursor).toBe(1004);
    const second = await index.listByOwner('github:1234', { limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(['sid-3', 'sid-2']);
    const third = await index.listByOwner('github:1234', { limit: 2, cursor: second.nextCursor! });
    expect(third.sessions.map((s) => s.sessionId)).toEqual(['sid-1']);
    expect(third.nextCursor).toBeNull();
  });

  it('clamps the page size instead of letting a caller ask for the whole zset', async () => {
    expect((await index.listByOwner('github:1234', { limit: 10_000 })).sessions.length).toBe(5);
    expect((await index.listByOwner('github:1234', { limit: 0 })).sessions.length).toBe(5);
    expect((await index.listByOwner('github:1234', { limit: -3 })).sessions.length).toBe(5);
  });

  it('drops a zset member whose hash is gone rather than emitting a null row', async () => {
    const f = fakeRedis();
    const idx = new OwnershipIndex(f.redis);
    await idx.create(rec({ sessionId: 'ghost', createdAt: 500 }));
    await f.redis.del([sessionKey('ghost')]);
    expect((await idx.listByOwner('github:1234')).sessions).toEqual([]);
  });

  it('returns an empty page for an owner with nothing', async () => {
    expect(await index.listByOwner('github:0')).toEqual({ sessions: [], nextCursor: null });
  });

  it('takes nextCursor from the tail ZSET MEMBER, so a ghost at a page tail is not re-visited', async () => {
    // The cursor used to come from the last SURVIVING record, which is not the same thing: with the
    // tail member's hash gone, that record's createdAt is a HIGHER score than the tail's, so the next
    // page's exclusive `(score` bound lands above the ghost and re-reads it -- and everything between
    // it and that record -- on every subsequent page.
    const f = fakeRedis();
    const idx = new OwnershipIndex(f.redis);
    for (let i = 1; i <= 4; i++) {
      await idx.create(rec({ sessionId: `s${i}`, createdAt: 1000 + i }));
    }
    await f.redis.del([sessionKey('s3')]); // s3 is the tail of a limit-2 page (s4, s3)
    const first = await idx.listByOwner('github:1234', { limit: 2 });
    expect(first.sessions.map((x) => x.sessionId)).toEqual(['s4']); // the ghost is filtered out
    // 1003 is s3's own score, read off the zset -- NOT s4's 1004, which would re-visit s3.
    expect(first.nextCursor).toBe(1003);
    const second = await idx.listByOwner('github:1234', { limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((x) => x.sessionId)).toEqual(['s2', 's1']);
    // The whole walk visits each real session exactly once and terminates.
    expect(second.nextCursor).toBe(1001);
    const third = await idx.listByOwner('github:1234', { limit: 2, cursor: second.nextCursor! });
    expect(third).toEqual({ sessions: [], nextCursor: null });
  });

  it('keeps paging when an ENTIRE page is ghosts, instead of truncating the walk', async () => {
    // With no surviving record on the page there was no cursor to take, so nextCursor went null and
    // the caller never saw the real sessions further down the zset.
    const f = fakeRedis();
    const idx = new OwnershipIndex(f.redis);
    for (let i = 1; i <= 4; i++) {
      await idx.create(rec({ sessionId: `s${i}`, createdAt: 1000 + i }));
    }
    await f.redis.del([sessionKey('s4'), sessionKey('s3')]);
    const first = await idx.listByOwner('github:1234', { limit: 2 });
    expect(first.sessions).toEqual([]);
    expect(first.nextCursor).toBe(1003);
    const second = await idx.listByOwner('github:1234', { limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((x) => x.sessionId)).toEqual(['s2', 's1']);
  });
});

describe('runtime hash', () => {
  it('is written and read as opaque display-only fields', async () => {
    const index = new OwnershipIndex(fakeRedis().redis);
    await index.putRuntime('sid-1', { harnessPod: 'h-1', revision: 'r-1' });
    expect(await index.getRuntime('sid-1')).toEqual({ harnessPod: 'h-1', revision: 'r-1' });
  });

  it('carries no owner field, so it cannot be mistaken for an authz source', async () => {
    // The runtime hash is written by the BRAIN tier, so it is untrusted, display-only data and is
    // never consulted for authz (spec §7.4). `owner` lives only in sh:cp:session:<sid>.
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.putRuntime('sid-1', { harnessPod: 'h-1', owner: 'github:attacker' });
    // Pin the WRITE side independently of the read side: getRuntime() re-filters through the same
    // RUNTIME_FIELDS allow-list, so asserting only on its output would still pass even if putRuntime
    // stopped filtering and stored the raw hash. Reading the fake's underlying store directly proves
    // the field was dropped on write, not merely hidden on read.
    expect(f.hashes.get(runtimeKey('sid-1'))).not.toHaveProperty('owner');
    expect(await index.getRuntime('sid-1')).not.toHaveProperty('owner');
  });

  it("keeps the data plane's P6.3 placement fields (spec §6), which the resources view reads", async () => {
    // The knative-server reporter writes through this same putRuntime: a field missing from the
    // allow-list is silently dropped on write, and the resources view's placement stays null forever.
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    const placement = {
      sandboxId: 'm-1',
      sandboxTier: 'microvm',
      workspaceResetAt: '1757000002000',
      workspaceResetFrom: 'm-0',
    };
    await index.putRuntime('sid-1', placement);
    expect(f.hashes.get(runtimeKey('sid-1'))).toEqual(placement);
    expect(await index.getRuntime('sid-1')).toEqual(placement);
  });

  it("stores an empty sandboxTier, so an untiered turn clears the last turn's tier", async () => {
    // hSet merges: were '' dropped on write, a turn after tiers are switched off would leave the
    // old tier next to its new sandboxId.
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.putRuntime('sid-1', { sandboxId: 'm-1', sandboxTier: 'microvm' });
    await index.putRuntime('sid-1', { sandboxId: 'c-0', sandboxTier: '' });
    expect(await index.getRuntime('sid-1')).toEqual({ sandboxId: 'c-0', sandboxTier: '' });
  });
});

describe('audit', () => {
  it('caps the audit stream with an approximate MAXLEN on every write', async () => {
    const f = fakeRedis();
    const calls: unknown[] = [];
    const redis = {
      ...f.redis,
      xAdd: async (...args: Parameters<typeof f.redis.xAdd>) => {
        calls.push(args[3]);
        return f.redis.xAdd(...args);
      },
    };
    await new OwnershipIndex(redis).audit({ subject: 's', decision: 'x' });
    expect(AUDIT_MAXLEN).toBe(1_000_000);
    expect(calls).toEqual([
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: AUDIT_MAXLEN } },
    ]);
  });

  it('appends decisions to its own stream, never values', async () => {
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.audit({
      subject: 'github:1234',
      sessionId: 'sid-1',
      credential: 'my-anthropic',
      decision: 'credential_issued',
    });
    const row = f.streams.get(AUDIT_STREAM)![0]!;
    expect(row).toMatchObject({
      subject: 'github:1234',
      sessionId: 'sid-1',
      credential: 'my-anthropic',
      decision: 'credential_issued',
    });
    // The credential NAME is auditable; its value never is (spec §7.2).
    expect(Object.values(row).join()).not.toContain('sk-');
  });

  it('lives in a keyspace separate from the model-influenced session log', async () => {
    expect(AUDIT_STREAM.startsWith('sh:cp:')).toBe(true);
    expect(AUDIT_STREAM.startsWith('session:')).toBe(false);
  });
});

describe('cascadeDelete', () => {
  it('orders tombstone → data → index, never the reverse', async () => {
    // Dropping the index first leaves data present but INVISIBLE, which is worse than a visible
    // orphan (spec §7.3). The op log is the only way to assert an ordering.
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.create(rec());
    f.ops.length = 0;
    await index.cascadeDelete(rec());

    const tombstoneAt = f.ops.findIndex((o) => o === `hSet ${sessionKey('sid-1')}`);
    const dataAt = f.ops.findIndex((o) => o.startsWith('del session:sid-1'));
    const zremAt = f.ops.findIndex((o) => o.startsWith('zRem '));
    const hashDelAt = f.ops.findIndex((o) => o === `del ${sessionKey('sid-1')}`);
    expect(tombstoneAt).toBeGreaterThanOrEqual(0);
    expect(dataAt).toBeGreaterThan(tombstoneAt);
    expect(zremAt).toBeGreaterThan(dataAt);
    expect(hashDelAt).toBeGreaterThan(zremAt);
  });

  it('deletes exactly the keys it can name', async () => {
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.create(rec());
    f.ops.length = 0;
    await index.cascadeDelete(rec());
    const deleted = f.ops.filter((o) => o.startsWith('del ')).join(' ');
    // Spec §7.3 step 2, narrowed by plan gap #10: the pi log + seq and the leaf result (which also
    // carries the gate state). The shared leaf-queue stream is not addressable per session; the
    // tombstone is what neutralises anything already queued.
    expect(deleted).toContain('session:sid-1');
    expect(deleted).toContain('session:sid-1:seq');
    expect(deleted).toContain('leaf:result:sid-1');
    expect(deleted).toContain(runtimeKey('sid-1'));
    expect(deleted).not.toContain('leaf-queue');
  });

  it('leaves nothing behind that listByOwner or get can still see', async () => {
    const f = fakeRedis();
    const index = new OwnershipIndex(f.redis);
    await index.create(rec());
    await index.cascadeDelete(rec());
    expect(await index.get('sid-1')).toBeNull();
    expect((await index.listByOwner('github:1234')).sessions).toEqual([]);
  });
});
