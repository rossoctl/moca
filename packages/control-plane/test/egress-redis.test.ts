import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EGRESS_DROP_REPORT_MAX,
  EGRESS_LOG_BYTES,
  EGRESS_LOG_CAP,
  EGRESS_POST_MAX,
  EGRESS_TOTAL_BYTES,
  MemoryEgressStore,
  RedisEgressStore,
  compareEntryIds,
  summarize,
  type EgressRedisLike,
  type EgressStore,
} from '../src/egress-log.js';

// Needs Redis on 6379, as sandbox-redis.test.ts does. The Lua append against the memory model.
const client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
const redis = client as unknown as EgressRedisLike;
beforeAll(async () => void (await client.connect()));
afterAll(async () => void client.destroy());

function isolated() {
  const prefix = `test:egress:${process.pid}:${randomUUID()}:`;
  return {
    prefix,
    store: new RedisEgressStore(redis, 3600, prefix),
    done: async () => {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

/** A typical stored event: a CONNECT tunnel, with nanosecond time, as moca-egress writes it. */
const REAL = JSON.stringify({
  bytes_down: 1234567,
  bytes_up: 4321,
  decision: 'tunnel',
  dial_addr: '192.0.2.10:443',
  host: 'files.pythonhosted.example.com',
  method: 'CONNECT',
  sid: 'sbx-0123456789abcdef0123456789',
  status: 200,
  time: '2026-11-08T12:00:00.123456789Z',
  via: 'moca-egress',
  vm_id: 'sbx_t1-0123456789abcdef',
});
// Every line is L bytes (i < 9000), so the byte budgets below read as counts of lines.
const line = (i: number) => `{"bytes_up":${1000 + i},"decision":"tunnel","host":"a.example.com"}`;
const L = Buffer.byteLength(line(0));
const group = (sandboxId: string, n: number, expireAtS: number, from = 0) => ({
  sandboxId,
  lines: Array.from({ length: n }, (_, i) => line(from + i)),
  proxyDropped: 0,
  invalid: 0,
  expireAtS,
});

describe('compareEntryIds', () => {
  it('orders stream ids by ms, then seq, numerically', () => {
    expect(compareEntryIds('9-0', '10-0')).toBe(-1);
    expect(compareEntryIds('10-2', '10-10')).toBe(-1);
    expect(compareEntryIds('10-10', '10-10')).toBe(0);
    expect(compareEntryIds('18446744073709551615-1', '18446744073709551615-0')).toBe(1);
  });
});

describe.each([
  [
    'memory',
    () => ({ store: new MemoryEgressStore() as EgressStore, prefix: '', done: async () => {} }),
  ],
  ['redis', isolated],
])('the egress store (%s)', (name, make) => {
  it('appends in order, pages by id, is idempotent by (host, cursor), and seals', async () => {
    const { store, done } = make();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const a = await store.append('host-1', 'c1', [group('sbx-a', 3, exp)], 2, 0);
    expect(a).toEqual({
      accepted: 3,
      refused: 2,
      capped: 0,
      overBudget: 0,
      invalid: 0,
      dropped: 0,
      cursor: 'c1',
    });
    expect(await store.append('host-1', 'c1', [group('sbx-a', 3, exp)], 2, 0)).toEqual(a);
    await store.append(
      'host-1',
      'c2',
      [{ ...group('sbx-a', 2, exp, 3), proxyDropped: 4, invalid: 1 }],
      0,
      4,
    );
    const p1 = await store.page('sbx-a', null, 2);
    const p2 = await store.page('sbx-a', p1[1]!.id, 10);
    expect([...p1, ...p2].map((e) => e.line)).toEqual([0, 1, 2, 3, 4].map(line));
    const s = await summarize(store, 'sbx-a');
    const want = [0, 1, 2, 3, 4].map((i) => `${line(i)}\n`).join('');
    expect(s.sha256).toBe(`sha256:${createHash('sha256').update(want).digest('hex')}`);
    expect(s).toMatchObject({
      total: 5,
      dropped: 5,
      droppedBy: { proxy: 4, cap: 0, budget: 0, invalid: 1 },
    });
    expect(await store.seal('sbx-a', exp)).toBe(true);
    expect(await store.seal('sbx-a', exp)).toBe(false);
    const late = await store.append('host-1', 'c3', [group('sbx-a', 2, exp)], 0, 0);
    expect(late).toMatchObject({ accepted: 0, refused: 2 });
    await done();
  });

  it('pages after an id that is not in the log by id order, as XRANGE does', async () => {
    const { store, done } = make();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await store.append('host-1', 'c1', [group('sbx-a', 3, exp)], 0, 0);
    const all = await store.page('sbx-a', null, 10);
    const [ms, seq] = all[1]!.id.split('-');
    // An id just after the 2nd entry's, which need not be in the log (in the memory store it is
    // not), one before every entry, and one after them all.
    const between = `${ms}-${BigInt(seq!) + 1n}`;
    const want = all.filter((e) => compareEntryIds(e.id, between) > 0).map((e) => e.line);
    expect((await store.page('sbx-a', between, 10)).map((e) => e.line)).toEqual(want);
    expect((await store.page('sbx-a', '0-0', 10)).map((e) => e.line)).toEqual(
      all.map((e) => e.line),
    );
    expect(await store.page('sbx-a', '99999999999999-0', 10)).toEqual([]);
    await done();
  });

  it('holds all logs together to the budget; an expired log gives its share back', async () => {
    // A budget of 10 lines and a cap of 6 on a fresh store of each kind, so the numbers stay readable.
    const limits = { cap: 6, budgetBytes: 10 * L };
    const small =
      name === 'memory'
        ? { store: new MemoryEgressStore(limits), prefix: '', done: async () => {} }
        : (() => {
            const p = `test:egress:${process.pid}:${randomUUID()}:`;
            return {
              store: new RedisEgressStore(redis, 3600, p, limits),
              prefix: p,
              done: async () => {
                const keys = await client.keys(`${p}*`);
                if (keys.length) await client.del(keys);
              },
            };
          })();
    const { store, done } = small;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(await store.append('host-1', 'c1', [group('sbx-a', 8, exp)], 0, 0)).toMatchObject({
      accepted: 6,
      capped: 2,
      overBudget: 0,
    });
    expect(
      await store.append('host-2', 'c1', [group('sbx-b', 3, exp), group('sbx-c', 2, exp)], 0, 0),
    ).toMatchObject({ accepted: 4, overBudget: 1 });
    // The over-budget event is dropped in its own log, which is then incomplete.
    expect(await summarize(store, 'sbx-c')).toMatchObject({
      total: 1,
      droppedBy: { budget: 1 },
      complete: false,
    });
    expect(await store.append('host-1', 'c2', [group('sbx-d', 1, exp)], 0, 0)).toMatchObject({
      accepted: 0,
      overBudget: 1,
    });
    // sbx-a's log expires (in Redis: its keys are gone with its expiry); its 6 come back at the next
    // append, no sweep needed.
    if (name === 'memory') (store as MemoryEgressStore).expire('sbx-a');
    else await store.expireAt('sbx-a', Math.floor(Date.now() / 1000) - 1);
    // 10 - (3 + 1) = 6 free: sbx-d takes 6, and its 7th is over its own cap of 6, not the budget.
    expect(await store.append('host-1', 'c3', [group('sbx-d', 7, exp)], 0, 0)).toMatchObject({
      accepted: 6,
      capped: 1,
      overBudget: 0,
    });
    await done();
  });

  it('caps a log by its bytes too: guest-sized lines stop at the byte cap, counted as cap drops', async () => {
    const limits = { capBytes: 3 * L + 10, budgetBytes: 100 * L };
    const p = `test:egress:${process.pid}:${randomUUID()}:`;
    const store =
      name === 'memory'
        ? new MemoryEgressStore(limits)
        : new RedisEgressStore(redis, 3600, p, limits);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(await store.append('host-1', 'c1', [group('sbx-a', 5, exp)], 0, 0)).toMatchObject({
      accepted: 3,
      capped: 2,
      overBudget: 0,
    });
    // A line over what is left of the cap is capped; the log stays at 3 lines.
    const big = { ...group('sbx-a', 0, exp), lines: [`{"host":"${'x'.repeat(4000)}"}`] };
    expect(await store.append('host-1', 'c2', [big], 0, 0)).toMatchObject({ capped: 1 });
    expect(await summarize(store, 'sbx-a')).toMatchObject({ total: 3, droppedBy: { cap: 3 } });
    // Another log is not held by this one's cap.
    expect(await store.append('host-1', 'c3', [group('sbx-b', 3, exp)], 0, 0)).toMatchObject({
      accepted: 3,
    });
    if (name === 'redis') {
      expect(Number(await client.get(`${p}total`))).toBe(6 * L);
      const keys = await client.keys(`${p}*`);
      if (keys.length) await client.del(keys);
    }
  });

  if (name === 'redis') {
    it('cannot pass the budget with two hosts posting at once (one Lua script per post)', async () => {
      const p = `test:egress:${process.pid}:${randomUUID()}:`;
      const store = new RedisEgressStore(redis, 3600, p, { cap: 1000, budgetBytes: 1500 * L });
      // A second connection, so the two posts really race on the server.
      const other = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
      await other.connect();
      const store2 = new RedisEgressStore(other as unknown as EgressRedisLike, 3600, p, {
        cap: 1000,
        budgetBytes: 1500 * L,
      });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const posts = [];
      for (let i = 0; i < 10; i++) {
        posts.push(store.append('host-1', `a${i}`, [group(`sbx-a${i}`, 200, exp)], 0, 0));
        posts.push(store2.append('host-2', `b${i}`, [group(`sbx-b${i}`, 200, exp)], 0, 0));
      }
      const answers = await Promise.all(posts);
      const accepted = answers.reduce((n, a) => n + a.accepted, 0);
      const over = answers.reduce((n, a) => n + a.overBudget, 0);
      expect(accepted).toBe(1500);
      expect(over).toBe(4000 - 1500);
      let stored = 0;
      for (let i = 0; i < 10; i++)
        stored += (await client.xLen(`${p}sbx-a${i}`)) + (await client.xLen(`${p}sbx-b${i}`));
      expect(stored).toBe(1500);
      expect(Number(await client.get(`${p}total`))).toBe(1500 * L);
      other.destroy();
      const keys = await client.keys(`${p}*`);
      if (keys.length) await client.del(keys);
    });

    it('takes back the budget of a log whose keys expired passively (EXPIREAT in the past)', async () => {
      const p = `test:egress:${process.pid}:${randomUUID()}:`;
      const store = new RedisEgressStore(redis, 3600, p, { cap: 100, budgetBytes: 5 * L });
      const now = Math.floor(Date.now() / 1000);
      await store.append('host-1', 'c1', [group('sbx-old', 5, now + 3600)], 0, 0);
      expect(
        await store.append('host-1', 'c2', [group('sbx-new', 1, now + 3600)], 0, 0),
      ).toMatchObject({
        accepted: 0,
        overBudget: 1,
      });
      // As retention ends: the log's expiry moves to now (deleteSandbox's expireAt), Redis drops it.
      await store.expireAt('sbx-old', now - 1);
      expect(await client.exists(`${p}sbx-old`)).toBe(0);
      expect(
        await store.append('host-1', 'c3', [group('sbx-new', 5, now + 3600)], 0, 0),
      ).toMatchObject({
        accepted: 5,
        overBudget: 0,
      });
      expect(await client.zRange(`${p}expiry`, 0, -1)).toEqual(['sbx-new']);
      expect(await client.hGetAll(`${p}bytes`)).toEqual({ 'sbx-new': String(5 * L) });
      expect(Number(await client.get(`${p}total`))).toBe(5 * L);
      const keys = await client.keys(`${p}*`);
      if (keys.length) await client.del(keys);
    });

    it('takes the largest charge a post can carry without overflowing a counter', async () => {
      const { store, prefix, done } = isolated();
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const charge = EGRESS_POST_MAX * EGRESS_DROP_REPORT_MAX;
      for (const c of ['c1', 'c2'])
        await store.append(
          'host-1',
          c,
          [{ ...group('sbx-a', 0, exp), proxyDropped: charge }],
          0,
          0,
        );
      expect(await client.hGet(`${prefix}sbx-a:meta`, 'proxy')).toBe(String(2 * charge));
      await done();
    });

    it("keeps the total as a running sum; a lost total is summed again from the logs' sizes", async () => {
      const p = `test:egress:${process.pid}:${randomUUID()}:`;
      const store = new RedisEgressStore(redis, 3600, p, { cap: 100, budgetBytes: 8 * L });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      await store.append('host-1', 'c1', [group('sbx-a', 3, exp), group('sbx-b', 2, exp)], 0, 0);
      expect(Number(await client.get(`${p}total`))).toBe(5 * L);
      // The deletion moves the log's expiry, and the index follows it.
      await store.expireAt('sbx-a', exp + 60);
      expect(await client.zScore(`${p}expiry`, 'sbx-a')).toBe(exp + 60);
      await client.del(`${p}total`);
      expect(await store.append('host-1', 'c2', [group('sbx-c', 4, exp)], 0, 0)).toMatchObject({
        accepted: 3,
        overBudget: 1,
      });
      expect(Number(await client.get(`${p}total`))).toBe(8 * L);
      const keys = await client.keys(`${p}*`);
      if (keys.length) await client.del(keys);
    });

    it('names its keys sh:sbx:egress:<id> and :meta, both expiring with the sandbox record', async () => {
      const { store, prefix, done } = isolated();
      const exp = Math.floor(Date.now() / 1000) + 1800;
      await store.append('host-1', 'c1', [{ ...group('sbx-b', 1, exp), proxyDropped: 1 }], 0, 1);
      for (const k of [`${prefix}sbx-b`, `${prefix}sbx-b:meta`]) {
        expect(await client.expireTime(k)).toBe(exp);
      }
      expect(await client.type(`${prefix}sbx-b`)).toBe('stream');
      const ttl = await client.ttl(`${prefix}host:host-1`);
      expect(ttl).toBeGreaterThan(3500);
      await store.expireAt('sbx-b', exp + 60);
      expect(await client.expireTime(`${prefix}sbx-b`)).toBe(exp + 60);
      expect(new RedisEgressStore(redis, 1)['stream']('sbx-x')).toBe('sh:sbx:egress:sbx-x');
      await done();
    });

    it(`stops at ${EGRESS_LOG_CAP} entries and counts the rest as cap drops`, async () => {
      expect([EGRESS_LOG_BYTES, EGRESS_TOTAL_BYTES]).toEqual([4 * 1024 * 1024, 64 * 1024 * 1024]);
      const { store, prefix, done } = isolated();
      const exp = Math.floor(Date.now() / 1000) + 600;
      const k = `${prefix}sbx-c`;
      // Fill to one short of the cap directly, then let the script take one and cap two.
      const batch: string[] = [];
      for (let i = 0; i < EGRESS_LOG_CAP - 1; i++) batch.push('*', 'e', REAL);
      for (let i = 0; i < batch.length; i += 3000) {
        const m = client.multi();
        for (let j = i; j < Math.min(i + 3000, batch.length); j += 3)
          m.xAdd(k, '*', { e: batch[j + 2]! });
        await m.exec();
      }
      const r = await store.append('host-1', 'c1', [group('sbx-c', 3, exp)], 0, 0);
      expect(r).toMatchObject({ accepted: 1, capped: 2 });
      expect(await client.xLen(k)).toBe(EGRESS_LOG_CAP);
      // Memory: what one stored event costs, at the cap (the report's estimate).
      const bytes = await client.memoryUsage(k);
      console.log(
        `[egress-redis] ${EGRESS_LOG_CAP} events of ${REAL.length} B: ${bytes} B, ${Math.round(Number(bytes) / EGRESS_LOG_CAP)} B each`,
      );
      await done();
    });
  }
});
