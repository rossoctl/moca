import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisWorkQueue } from '@moca/work-queue';
import {
  LEAF_QUEUE_GROUP,
  RedisTurnQueue,
  TurnStore,
  isTerminalState,
  turnKey,
  type CpRedisLike,
} from '@moca/control-plane';
import { processOne, type LeafJobDeps } from '@moca/harness/leaf-job-runner';
import { resultKey } from '@moca/harness/leaf-result-store';
import type { LeafEnvelope, LeafResult } from '@moca/harness/run-leaf';
import { createLeafDrainLoop } from '../src/leaf-drain-loop.js';
import { claimTurn, deadLetterTurn } from '../src/turn-claim.js';
import { asyncFinalizeState } from '../src/async-worker.js';
import { TurnCounter } from '../src/worker.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
// Production timings make a faithful reclaim test wait 90 s+, which CI will not gate on. These are
// the SAME parameters production passes, not a test seam (§9.2).
const FAST = { minIdleMs: 50, heartbeatMs: 20, blockMs: 50, maxAttempts: 1 };
const TTL = 600;

let client: ReturnType<typeof createClient>;
let cp: http.Server;
let cpUrl: string;
let tag: string;
let stream: string;
let turns: TurnStore;
let submitter: RedisTurnQueue;
/**
 * Every client a test opened. `RedisWorkQueue` takes an INJECTED client and deliberately has no
 * `close()` (Task 1), so whoever opened a client closes it -- track clients, not queues.
 */
let clients: Array<ReturnType<typeof createClient>>;

beforeAll(async () => {
  client = createClient({ url: REDIS_URL });
  await client.connect();
  // A stub, on purpose: the real /internal/turn-credentials has its own suite in its own package
  // (turn-exchange.test.ts). What is under test here is what the DRAIN does with a mint. It answers
  // from the RECORD, which already carries both the envelope and the session id (turn-record.ts:43).
  cp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      void (async () => {
        const { turnId } = JSON.parse(Buffer.concat(chunks).toString()) as { turnId: string };
        const rec = await turns.get(turnId);
        if (!rec) return send(404, { error: 'turn_not_found' });
        // isTerminalState is "everything but queued and running", so this covers `cancelled` too --
        // and ADMITS `running`, which is what every redelivery looks like (turn-record.ts:24-32).
        if (isTerminalState(rec.state)) return send(409, { error: 'turn_not_claimable' });
        // Exactly the three fields validateExchangeBody REQUIRES: a known mode, a non-empty token,
        // a non-empty base url (turn-auth.ts:210-223). authHeader/configRef/model are optional and
        // omitted on purpose, so the claim's absent-field branches get exercised too. The base url
        // is never dialed -- runLeaf is faked in every test below.
        send(200, {
          turnId,
          sessionId: rec.sessionId,
          envelope: rec.envelope,
          mode: 'direct',
          anthropicAuthToken: 'stub-credential', // notsecret
          anthropicBaseUrl: 'http://127.0.0.1:1/unused',
        });
      })();
    });
  });
  await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
  cpUrl = `http://127.0.0.1:${(cp.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => cp.close(() => r()));
  if (client.isOpen) await client.close();
});

beforeEach(() => {
  // Per-run isolation through the two seams built for it: TurnStore's keyTag (turn-store.ts:19-20)
  // and RedisTurnQueue's stream parameter (turn-queue.ts:29-33). Two copies of this suite must not
  // delete each other's records, and NOTHING here may touch the production LEAF_QUEUE_STREAM.
  tag = randomUUID().slice(0, 8);
  stream = `test-leaf-queue-${tag}`;
  turns = new TurnStore(client as unknown as CpRedisLike, {
    resultTtlSeconds: TTL,
    ttlMarginSeconds: 60,
    keyTag: tag,
  });
  submitter = new RedisTurnQueue(client as unknown as CpRedisLike, stream);
  clients = [];
});

afterEach(async () => {
  for (const c of clients) if (c.isOpen) await c.close();
  // Safe because the tag is in the record key (keyTag), in the stream name, and in every session id.
  const keys = await client.keys(`*${tag}*`);
  if (keys.length > 0) await client.del(keys);
});

/** A queue on this run's stream, with its own client -- as production gives the queue its own. */
async function newQueue(): Promise<RedisWorkQueue> {
  const c = createClient({ url: REDIS_URL });
  c.on('error', () => {});
  await c.connect();
  // The cast matches turn-auth.test.ts's: `ReturnType<typeof createClient>` resolves from the
  // overload set differently inside `Array<...>` than in a plain variable declaration, so a bare
  // `push(c)` sees a narrower concrete type than the array's declared element type.
  clients.push(c as unknown as ReturnType<typeof createClient>);
  const q = new RedisWorkQueue(c as never, stream, LEAF_QUEUE_GROUP);
  await q.ensureGroup();
  return q;
}

/**
 * A queued turn: the record `submitTurn` writes, enqueued through the REAL submitter -- `WorkQueue`
 * has no `enqueue`, deliberately (turn-queue.ts:17-21). `sessionId` carries the tag so the teardown
 * reaches the result record too, and it appears INSIDE the envelope as well: `claimTurn` refuses a
 * claim whose envelope session id disagrees with the record's.
 */
async function submit(): Promise<{ turnId: string; sessionId: string }> {
  const turnId = `t-${randomUUID()}`;
  const sessionId = `sid-${tag}-${randomUUID().slice(0, 6)}`;
  await turns.create({
    turnId,
    owner: `owner-${tag}`,
    tenant: 'default',
    sessionId,
    cfg: '',
    credentialName: 'default',
    caps: {},
    idempotencyKey: sessionId,
    envelope: { sessionId, kind: 'prompt', prompt: 'hi' },
    state: 'queued',
    attempts: 0,
    createdAt: Date.now(),
  });
  await submitter.enqueue(turnId);
  return { turnId, sessionId };
}

/** LeafJobDeps wired to real Redis, the stub exchange, and a caller-supplied runLeaf. */
function jobFor(
  queue: RedisWorkQueue,
  consumerId: string,
  runLeaf: (env: LeafEnvelope) => Promise<LeafResult>,
): LeafJobDeps {
  return {
    queue,
    consumerId,
    claimTurn: (turnId, dc) =>
      claimTurn(turnId, dc, { controlPlaneUrl: cpUrl, exchangeToken: 'stub', turns }),
    // The production signature is (envelope, config); no faked leaf here needs the config.
    runLeaf: (env) => runLeaf(env),
    // asyncFinalizeState, not a hand-rolled map: it is what Task 7 wires in production, and
    // `aborted -> cancelled` exists only there.
    finalize: async (turnId, status) => {
      await turns.finalize(turnId, asyncFinalizeState(status), Date.now());
    },
    deadLetter: (turnId) =>
      deadLetterTurn(turnId, { turns, resultStore: client as never, ttlSeconds: TTL }),
    resultStore: client as never,
    ttlSeconds: TTL,
    ...FAST,
  };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * The key this run's store actually writes under. `keyTag` tags the id INSIDE the key --
 * `turnKey(this.tag(turnId))`, turn-store.ts:55-59 -- so a bare `turnKey(turnId)` would address a key
 * that does not exist and a TTL assertion against it would read -2 and pass for the wrong reason.
 */
const recordKey = (turnId: string): string => turnKey(`${turnId}:${tag}`);

describe('§8 — the drain under mixed load', () => {
  // §5.3's take-before-claim ordering exists for EXACTLY this case, and a drain-only test passes
  // whether or not the ordering is right. So interactive turns arrive while the loop drains.
  it('finishes every queued turn while sync turns arrive', async () => {
    const cap = 2;
    const queue = await newQueue();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await submit()).turnId);

    const counter = new TurnCounter(() => {});

    const finished: string[] = [];
    const loop = createLeafDrainLoop({
      job: jobFor(queue, 'w-drain', async (env) => {
        await settle(30);
        finished.push(env.sessionId);
        return { status: 'done' } as LeafResult;
      }),
      counter,
      cap,
    });
    loop.start();

    // Interactive /turn traffic, taking slots through the same counter the loop uses.
    for (let i = 0; i < 10; i++) {
      const release = counter.start();
      await settle(10);
      release();
    }

    const deadline = Date.now() + 10_000;
    while (finished.length < ids.length && Date.now() < deadline) await settle(50);
    await loop.stop();

    expect(finished).toHaveLength(ids.length);
    for (const id of ids) expect((await turns.get(id))?.state).toBe('done');
  });
});

describe('§8 — crash recovery, with timings injected', () => {
  it('reclaims an entry a dead worker never acked, and the second claim mints on `running`', async () => {
    const { turnId } = await submit();
    const qa = await newQueue();
    // Worker A claims and "dies": claimed, record flipped to running, never acked.
    const first = await qa.claim('w-a', { minIdleMs: FAST.minIdleMs, blockMs: 50 });
    expect(first?.turnId).toBe(turnId);
    expect(
      await claimTurn(turnId, 1, { controlPlaneUrl: cpUrl, exchangeToken: 'stub', turns }),
    ).not.toBeNull();
    expect((await turns.get(turnId))?.state).toBe('running');

    await settle(FAST.minIdleMs + 20); // its heartbeat died with it
    const qb = await newQueue();
    let ran = 0;
    // maxAttempts: 2, not FAST's 1 -- XAUTOCLAIM increments deliveriesCounter to 2 on this very
    // reclaim (verified against real Redis: a fresh xReadGroup reports 1, the next xAutoClaim
    // reports 2), so maxAttempts: 1 would dead-letter every reclaim before it could ever complete
    // one. The dead-letter test below is the one that wants maxAttempts: 1.
    const outcome = await processOne({
      ...jobFor(qb, 'w-b', async () => {
        ran++;
        return { status: 'done' } as LeafResult;
      }),
      maxAttempts: 2,
    });
    expect(outcome).toMatchObject({ kind: 'completed', turnId, reclaimed: true });
    expect(ran).toBe(1);
    // The assertion worth making separately (§5.4): a reclaim landing on a REFUSED mint looks like
    // a successful reclaim right up to the ack. The record said `running`, and the mint admitted it.
    expect((await turns.get(turnId))?.state).toBe('done');
    expect(await qb.pending()).toBe(0);
  });

  it('does not reclaim a leaf that is still alive, and does once its heartbeat stops', async () => {
    // The one async property whose absence is invisible until a leaf runs past 90 s in production,
    // which is most real leaves.
    const { turnId } = await submit();
    const qa = await newQueue();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = processOne(
      jobFor(qa, 'w-slow', async () => {
        await held;
        return { status: 'done' } as LeafResult;
      }),
    );
    await settle(FAST.minIdleMs * 3); // well past minIdleMs, heartbeat touching throughout

    const qb = await newQueue();
    expect(await qb.claim('w-thief', { minIdleMs: FAST.minIdleMs, blockMs: 50 })).toBeNull();

    release();
    await slow;
    expect((await turns.get(turnId))?.state).toBe('done');
  });

  it('dead-letters past maxAttempts: `lost` on the record AND a failed result, so a poller ends', async () => {
    const { turnId, sessionId } = await submit();
    const queue = await newQueue();
    const job = jobFor(queue, 'w-dl', async () => {
      throw new Error('leaf exploded');
    });
    // First delivery throws, so the entry is never acked; after minIdleMs it comes back with
    // deliveryCount 2, which is past maxAttempts: 1.
    await expect(processOne(job)).rejects.toThrow('leaf exploded');
    await settle(FAST.minIdleMs + 20);
    expect(await processOne(job)).toMatchObject({ kind: 'dead_lettered', turnId });

    expect((await turns.get(turnId))?.state).toBe('lost');
    expect(await queue.pending()).toBe(0);
    // Under the RECORD's session id, not `leafSessionId(env)` -- that divergence is the defect
    // Task 4 fixes -- AND under this turn's id, so a sibling turn on the same session cannot
    // overwrite it (§4.3). This is the assertion that pins both.
    expect(JSON.parse((await client.get(resultKey(sessionId, turnId)))!)).toMatchObject({
      status: 'failed',
    });
  });

  it('drains without acking: the entry stays pending for one redelivery, the slot is released', async () => {
    // §6.3, and the trap: XGROUP DELCONSUMER would DISCARD this pending entry, turning the one
    // redelivery the design relies on into silent loss.
    await submit(); // the turn id is irrelevant here: the assertion is about the QUEUE's pending set
    const queue = await newQueue();
    const counter = new TurnCounter(() => {});
    let started = false;
    const loop = createLeafDrainLoop({
      job: jobFor(queue, 'w-drained', async () => {
        started = true;
        await settle(5_000); // outlives the drain, as a real leaf would
        return { status: 'done' } as LeafResult;
      }),
      counter,
      cap: 1,
    });
    loop.start();
    const deadline = Date.now() + 5_000;
    while (!started && Date.now() < deadline) await settle(20);

    const t0 = Date.now();
    await loop.stop();
    expect(Date.now() - t0).toBeLessThan(1_000); // never awaits the leaf (§6.3)
    expect(counter.inFlight).toBe(0);
    expect(await queue.pending()).toBe(1); // abandoned UNACKED, not discarded
  });
});

describe('§8 — two workers, one stale entry', () => {
  it('finalizes it once, not twice', async () => {
    // The property run-lease.ts:189 already states for sandbox leases. finalize compare-and-sets,
    // which is what makes arming the reaper on EVERY worker safe.
    const { turnId } = await submit();
    const qa = await newQueue();
    const claimed = await qa.claim('w-stale', { minIdleMs: FAST.minIdleMs, blockMs: 50 });
    expect(claimed?.turnId).toBe(turnId);
    await settle(FAST.minIdleMs + 20);

    const reapers = await Promise.all([newQueue(), newQueue()]);
    const reaped = await Promise.all(
      reapers.map((q, i) =>
        q.reapDeadLetters(`reaper-${i}`, { minIdleMs: FAST.minIdleMs, maxAttempts: 0 }),
      ),
    );
    expect(reaped.flat()).toHaveLength(1); // XCLAIM gives the entry to exactly one of them
    for (const entry of reaped.flat()) {
      await deadLetterTurn(entry.turnId, { turns, resultStore: client as never, ttlSeconds: TTL });
    }
    expect((await turns.get(turnId))?.state).toBe('lost');
  });
});

describe('§8 — record TTL ordering (§5.1)', () => {
  it('leaves a queued record un-expiring, and expires a finished one AFTER its result', async () => {
    // The failure this catches: a caller polls a succeeded turn and reads 404 because the record
    // went first.
    const { turnId, sessionId } = await submit();
    expect(await client.ttl(recordKey(turnId))).toBe(-1); // no TTL while it may still run

    const queue = await newQueue();
    await processOne(jobFor(queue, 'w-ttl', async () => ({ status: 'done' }) as LeafResult));

    const recordTtl = await client.ttl(recordKey(turnId));
    const resultTtl = await client.ttl(resultKey(sessionId, turnId));
    expect(recordTtl).toBeGreaterThan(resultTtl);
  });
});

describe('§8 — parity carry-overs (§10)', () => {
  // classifyOutcome's contract, exercised for the first time since #691.
  it.each([
    ['done', 'done', 0],
    ['solved', 'solved', 0],
    ['responded', 'responded', 0],
  ] as const)('acks a %s leaf and finalizes the record', async (status, state, pending) => {
    const { turnId } = await submit();
    const queue = await newQueue();
    const out = await processOne(
      jobFor(queue, `w-${status}`, async () => ({ status }) as LeafResult),
    );
    expect(out).toMatchObject({ kind: 'completed', turnId, status });
    expect(await queue.pending()).toBe(pending);
    expect((await turns.get(turnId))?.state).toBe(state);
  });

  it('does NOT ack a failed/saturated leaf, so it is redelivered', async () => {
    const { turnId } = await submit();
    const queue = await newQueue();
    const out = await processOne(
      jobFor(queue, 'w-sat', async () => ({ status: 'failed', reason: 'saturated' }) as LeafResult),
    );
    expect(out).toMatchObject({ kind: 'redelivered', turnId });
    expect(await queue.pending()).toBe(1);
    // Still claimable: `running` is not terminal, which is the whole reason the mint admits it.
    expect((await turns.get(turnId))?.state).toBe('running');
  });
});
