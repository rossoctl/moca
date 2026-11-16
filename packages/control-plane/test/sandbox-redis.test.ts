import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisEgressStore, type EgressRedisLike } from '../src/egress-log.js';
import { RedisSandboxStore, type SandboxRedisLike } from '../src/sandbox-redis.js';
import { subjectHash } from '../src/subject-document.js';
import { sandboxStoreContract } from './helpers/sandbox-store-contract.js';

// Needs Redis on 6379, as refresh-redis.test.ts does; CI provides a redis:7 service.
const client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
const redis = client as unknown as SandboxRedisLike;
beforeAll(async () => void (await client.connect()));
afterAll(async () => void client.destroy());

function isolated() {
  const prefix = `test:sbx:${process.pid}:${randomUUID()}:`;
  return {
    prefix,
    store: new RedisSandboxStore(redis, prefix, `${prefix}egress:`),
    egress: new RedisEgressStore(client as unknown as EgressRedisLike, 3600, `${prefix}egress:`),
    done: async () => {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

sandboxStoreContract('redis', async () => isolated());

describe('RedisSandboxStore TTLs (retention is the key lifetime)', () => {
  it('sets the record to live until expiresAt + retention, then to retention after delete', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(
      {
        id: 'sbx-t',
        owner: 'github:1',
        tenant: 'github:1',
        name: '',
        template: 'd',
        worker: 'w',
        wsk: 'sbx-t',
        labels: {},
        createdAt: now,
        expiresAt: now + 1000,
        mode: 'per-exec',
        idleTimeoutS: 0,
        modeEpoch: 0,
      },
      { perSubject: 1, total: 1, retentionS: 500 },
      now,
    );
    const ttl1 = await client.ttl(`${prefix}sandbox:sbx-t`);
    expect(ttl1).toBeGreaterThan(1400);
    expect(ttl1).toBeLessThanOrEqual(1500);
    await store.markDeleted('sbx-t', now, 500);
    const ttl2 = await client.ttl(`${prefix}sandbox:sbx-t`);
    expect(ttl2).toBeGreaterThan(490);
    expect(ttl2).toBeLessThanOrEqual(500);
    await done();
  });

  it('keeps the name key until expiresAt + retention, so only `live` decides who holds a name', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(
      {
        id: 'sbx-n',
        owner: 'github:1',
        tenant: 'github:1',
        name: 'web',
        template: 'd',
        worker: 'w',
        wsk: 'sbx-n',
        labels: {},
        createdAt: now,
        expiresAt: now + 1000,
        mode: 'per-exec',
        idleTimeoutS: 0,
        modeEpoch: 0,
      },
      { perSubject: 1, total: 1, retentionS: 500 },
      now,
    );
    // Garbage collection only: a Redis clock running ahead must not free a name whose holder is live.
    const ttl = await client.ttl(`${prefix}name:${subjectHash('github:1')}:web`);
    expect(ttl).toBeGreaterThan(1400);
    expect(ttl).toBeLessThanOrEqual(1500);
    await done();
  });

  it('prunes index members whose record is gone on create, so a create-and-delete loop never grows them', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    const rec = (id: string) => ({
      id,
      owner: 'github:1',
      tenant: 'github:1',
      name: '',
      template: 'd',
      worker: 'w',
      wsk: id,
      labels: {},
      createdAt: now,
      expiresAt: now + 1000,
      mode: 'per-exec' as const,
      idleTimeoutS: 0,
      modeEpoch: 0,
    });
    const limits = { perSubject: 50, total: 50, retentionS: 500 };
    for (let i = 0; i < 20; i++) {
      expect(await store.create(rec(`sbx-old${i}`), limits, now)).toBe('ok');
      await store.markDeleted(`sbx-old${i}`, now, 500);
      // Retention passed: the TTL took the record, as Redis would.
      await client.del(`${prefix}sandbox:sbx-old${i}`);
    }
    const owner = `${prefix}owner:${subjectHash('github:1')}`;
    expect(await client.zCard(owner)).toBeLessThanOrEqual(1);
    expect(await client.zCard(`${prefix}all`)).toBeLessThanOrEqual(2);
    // A live member stays.
    expect(await store.create(rec('sbx-live'), limits, now)).toBe('ok');
    expect(await client.zScore(owner, 'sbx-live')).not.toBeNull();
    await done();
  });
});

describe('RedisSandboxStore touch (idle lifetime, spec §5.2)', () => {
  const rec = (id: string, now: number, name = '') => ({
    id,
    owner: 'github:1',
    tenant: 'github:1',
    name,
    template: 'd',
    worker: 'w',
    wsk: id,
    labels: {},
    createdAt: now,
    expiresAt: now + 600,
    mode: 'per-exec' as const,
    idleTimeoutS: 0,
    modeEpoch: 0,
  });
  const EVENT = '{"bytes_up":1000,"decision":"tunnel","host":"a.example.com"}';
  const lim = { perSubject: 2, total: 2, retentionS: 3600 };
  const near = (ttl: number, want: number) => {
    expect(ttl).toBeGreaterThan(want - 2);
    expect(ttl).toBeLessThanOrEqual(want);
  };

  it('a touch moves the record TTL and the name key PXAT with the deadline', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(rec('sbx-tt', now, 'web'), lim, now);
    const out = await store.touch('sbx-tt', now, 5000, 3600);
    expect(out?.expiresAt).toBe(now + 5000);
    near(await client.ttl(`${prefix}sandbox:sbx-tt`), 5000 + 3600);
    const nameKey = (await client.keys(`${prefix}name:*`))[0]!;
    near(await client.ttl(nameKey), 5000 + 3600);
    expect(await client.zScore(`${prefix}live`, 'sbx-tt')).toBe(now + 5000);
    await done();
  });

  it('a touch moves an existing egress log with the deadline, and leaves a missing one absent', async () => {
    const { prefix, store, egress, done } = isolated();
    const ep = `${prefix}egress:`;
    const now = Math.floor(Date.now() / 1000);
    await store.create(rec('sbx-e1', now), lim, now);
    await store.create(rec('sbx-e2', now), lim, now);
    await egress.append(
      'host-1',
      'c1',
      [
        {
          sandboxId: 'sbx-e1',
          lines: [EVENT],
          proxyDropped: 0,
          invalid: 1, // a counter is what creates the meta hash
          expireAtS: now + 600 + 3600,
        },
      ],
      0,
      0,
    );
    await store.touch('sbx-e1', now, 5000, 3600);
    await store.touch('sbx-e2', now, 5000, 3600);
    near(await client.ttl(`${ep}sbx-e1`), 5000 + 3600);
    near(await client.ttl(`${ep}sbx-e1:meta`), 5000 + 3600);
    expect(await client.zScore(`${ep}expiry`, 'sbx-e1')).toBe(now + 5000 + 3600);
    expect(await client.exists(`${ep}sbx-e2`)).toBe(0);
    expect(await client.exists(`${ep}sbx-e2:meta`)).toBe(0);
    expect(await client.zScore(`${ep}expiry`, 'sbx-e2')).toBeNull();
    await done();
  });

  it('leaves a sealed egress log alone', async () => {
    const { prefix, store, egress, done } = isolated();
    const ep = `${prefix}egress:`;
    const now = Math.floor(Date.now() / 1000);
    await store.create(rec('sbx-s', now), lim, now);
    await egress.append(
      'host-1',
      'c1',
      [
        {
          sandboxId: 'sbx-s',
          lines: [EVENT],
          proxyDropped: 0,
          invalid: 1, // a counter is what creates the meta hash
          expireAtS: now + 600 + 3600,
        },
      ],
      0,
      0,
    );
    await egress.seal('sbx-s', now + 600 + 3600);
    await store.touch('sbx-s', now, 5000, 3600);
    expect(await client.zScore(`${ep}expiry`, 'sbx-s')).toBe(now + 600 + 3600);
    near(await client.ttl(`${ep}sbx-s`), 600 + 3600);
    await done();
  });

  it('does not touch a name key that now names another sandbox', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(rec('sbx-o', now, 'web'), lim, now);
    const nameKey = (await client.keys(`${prefix}name:*`))[0]!;
    await client.set(nameKey, 'sbx-other', { PXAT: (now + 600 + 3600) * 1000 });
    await store.touch('sbx-o', now, 5000, 3600);
    near(await client.ttl(nameKey), 600 + 3600);
    await done();
  });

  it('reads a hash written before idle lifetimes without idleLifetimeS', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    const L = 7 * 86_400;
    await client.hSet(`${prefix}sandbox:sbx-old`, {
      id: 'sbx-old',
      owner: 'github:1',
      tenant: 'github:1',
      name: '',
      template: 'd',
      worker: 'w',
      wsk: 'sbx-old',
      labels: '{}',
      createdAt: String(now),
      expiresAt: String(now + 1000),
    });
    const got = await store.get('sbx-old', now);
    expect(got).not.toBeNull();
    expect('idleLifetimeS' in got!).toBe(false);
    const out = await store.touch('sbx-old', now, L, 3600);
    expect(out?.expiresAt).toBe(Math.max(now + 1000, now + L));
    await done();
  });
});

describe('RedisSandboxStore mode fields (lease-mode spec §8.1)', () => {
  // A hash as the store wrote it before the record had a mode: no mode, idleTimeoutS or modeEpoch.
  const legacyHash = (id: string, now: number) => ({
    id,
    owner: 'github:1',
    tenant: 'github:1',
    name: '',
    template: 'd',
    worker: 'w',
    wsk: id,
    labels: '{}',
    createdAt: String(now),
    expiresAt: String(now + 1000),
  });

  it('reads a record written before the mode fields as per-exec, idle 0, epoch 0', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await client.hSet(`${prefix}sandbox:sbx-legacy`, legacyHash('sbx-legacy', now));
    expect(await store.get('sbx-legacy', now)).toMatchObject({
      id: 'sbx-legacy',
      mode: 'per-exec',
      idleTimeoutS: 0,
      modeEpoch: 0,
    });
    // ...and its first setMode raises the epoch from 0 to 1.
    expect(await store.setMode('sbx-legacy', 'lease', 600, now)).toMatchObject({
      record: { mode: 'lease', idleTimeoutS: 600, modeEpoch: 1 },
      previousMode: 'per-exec',
    });
    await done();
  });

  it('reads an unknown stored mode as per-exec, the least it may grant', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await client.hSet(`${prefix}sandbox:sbx-odd`, {
      ...legacyHash('sbx-odd', now),
      mode: 'resident',
      idleTimeoutS: '60',
      modeEpoch: '3',
    });
    expect(await store.get('sbx-odd', now)).toMatchObject({
      mode: 'per-exec',
      idleTimeoutS: 60,
      modeEpoch: 3,
    });
    // ...and setMode reports it as it reads: per-exec.
    expect(await store.setMode('sbx-odd', 'lease', 60, now)).toMatchObject({
      record: { mode: 'lease', modeEpoch: 4 },
      previousMode: 'per-exec',
    });
    await done();
  });

  it('keeps the record TTL across setMode', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(
      {
        ...legacyHash('sbx-ttl', now),
        labels: {},
        createdAt: now,
        expiresAt: now + 1000,
        mode: 'per-exec',
        idleTimeoutS: 0,
        modeEpoch: 0,
      },
      { perSubject: 1, total: 1, retentionS: 500 },
      now,
    );
    await store.setMode('sbx-ttl', 'lease', 600, now);
    const ttl = await client.ttl(`${prefix}sandbox:sbx-ttl`);
    expect(ttl).toBeGreaterThan(1400);
    expect(ttl).toBeLessThanOrEqual(1500);
    await done();
  });
});
