import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisRecordStore } from '@moca/harness';
import { resetSharedStores, selectPoolSandbox } from '@moca/harness/select-sandbox';
import { createRelay } from '../src/relay.js';
import { detachMarks } from '../src/main.js';

/**
 * Session templates end to end (session-templates spec §8): workers with and without a template
 * attach through a REAL relay into real Redis, and many sessions -- with a template, and without
 * one -- each stay on workers of their own kind, turn after turn.
 */

const run = randomUUID().slice(0, 8);
const TPL = `tpl-${run}`;
const PLAIN = [`p0-${run}`, `p1-${run}`];
const TEMPLATED = [`t0-${run}`, `t1-${run}`];
const ALL = [...PLAIN, ...TEMPLATED];

const env = {
  KAGENTI_SANDBOX_POOL_SELECTOR: 'app=it',
  SH_SANDBOX_DISCOVERY: 'records',
  SH_SANDBOX_AFFINITY_TTL_SECONDS: '300',
  SH_SANDBOX_AFFINITY_GRACE_SECONDS: '30',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
} as NodeJS.ProcessEnv;

function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: (k: string) => string[] };
    write: (f: unknown) => void;
    end: () => void;
    emitData: (f: unknown) => void;
  };
  s.metadata = { get: () => ['Bearer t'] };
  s.write = () => {};
  s.end = () => s.emit('end');
  s.emitData = (f) => s.emit('data', f);
  return s;
}

const records = new RedisRecordStore(env.REDIS_URL);
const relay = createRelay({
  records,
  detach: detachMarks(records, env),
  validateToken: () => true,
});
const streams = new Map<string, ReturnType<typeof fakeAttach>>();
const fakeTransport = {
  exec: async () => ({ stdout: Buffer.alloc(0), exitCode: 0, truncated: false }),
  close: async () => {},
  fastTier: 'per-call-exec' as const,
};

async function present(ids: string[], want: boolean) {
  await vi.waitFor(
    async () => {
      const listed = new Set((await records.list()).map((r) => r.sandboxId));
      expect(ids.every((id) => listed.has(id) === want)).toBe(true);
    },
    { timeout: 5_000, interval: 50 },
  );
}

const select = (sid: string, template?: string) =>
  selectPoolSandbox(
    env,
    '/h',
    sid,
    { cap: 8, ttlMs: 60_000, remoteSandbox: true, ...(template ? { template } : {}) },
    { makeExecClient: () => ({}) as never, makeTransport: () => fakeTransport },
  );

describe('session templates end to end (session-templates spec §8)', () => {
  beforeAll(async () => {
    for (const id of ALL) {
      const s = fakeAttach();
      relay.onAttach(s as never);
      s.emitData({
        hello: {
          sandboxId: id,
          labels: TEMPLATED.includes(id) ? { 'moca.dev/template': TPL } : {},
          capabilities: [],
          image: '',
          arch: 'amd64',
          capacityMax: 8,
          trust: 'untrusted',
        },
      });
      streams.set(id, s);
    }
    await present(ALL, true);
  });

  afterAll(async () => {
    for (const id of ALL) streams.get(id)?.emit('end');
    await present(ALL, false).catch(() => {});
    resetSharedStores();
    await records.close();
  });

  it('the relay records the template label as the worker sent it', async () => {
    const recs = (await records.list()).filter((r) => ALL.includes(r.sandboxId));
    for (const r of recs) {
      expect(r.labels['moca.dev/template']).toBe(TEMPLATED.includes(r.sandboxId) ? TPL : undefined);
    }
  });

  it('every turn of a templated session stays on a templated worker, and of a plain one on a plain worker', async () => {
    const sessions = Array.from({ length: 16 }, (_, i) => ({
      sid: `s-${run}-${i}`,
      template: i % 2 ? TPL : undefined,
    }));
    const first = new Map<string, string>();
    // Turn 1, every lease held at once, so new sessions spread by load as in production.
    const held = [];
    for (const s of sessions) {
      const sel = (await select(s.sid, s.template))!;
      expect((s.template ? TEMPLATED : PLAIN).includes(sel.sandboxId!)).toBe(true);
      first.set(s.sid, sel.sandboxId!);
      held.push(sel);
    }
    await Promise.all(held.map((h) => h.release()));
    // Later turns: the same sandbox every time (affinity), still of the session's kind.
    for (let turn = 0; turn < 2; turn++) {
      for (const s of sessions) {
        const sel = (await select(s.sid, s.template))!;
        expect(sel.sandboxId).toBe(first.get(s.sid));
        expect(sel.workspaceReset).toBeUndefined();
        await sel.release();
      }
    }
    // New sessions spread over both workers of each kind.
    const used = new Set(first.values());
    expect(TEMPLATED.every((id) => used.has(id)) && PLAIN.every((id) => used.has(id))).toBe(true);
  });
});
