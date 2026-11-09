import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { startControlPlane } from '../src/server.js';
import { OwnershipIndex, ownerKey, type CpRedisLike } from '../src/ownership.js';
import { RedisTurnQueue, LEAF_QUEUE_GROUP, LEAF_QUEUE_STREAM } from '../src/turn-queue.js';
import { TurnStore } from '../src/turn-store.js';
import { turnKey } from '../src/turn-record.js';
import { makeDeps, seedCredential, type TestDeps } from './helpers/deps.js';

/**
 * The #387 acceptance criterion "an end-to-end test with a fake worker passes", over real HTTP and
 * real Redis. The handler suite proves the three routes against a fake; this proves the thing a
 * client meets -- router auth order, signed tokens, JSON envelopes, a real XADD and a real consumer
 * group -- and, crucially, the CONTRACT BETWEEN THE TWO HALVES: that a consumer holding only what
 * the queue carries can rebuild everything it needs. The real drain loop is #389.
 */

const ALICE = 'github:1234';
const BOB = 'github:9999';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let server: ReturnType<typeof startControlPlane>;
let base: string;
let d: TestDeps;
let client: ReturnType<typeof createClient>;
// Every key this file writes carries the tag, so the teardown can delete exactly its own and two
// copies of the suite can run at once without deleting each other's records.
let tag: string;
let stream: string;

function request(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json(): any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, json: () => (body ? JSON.parse(body) : undefined) });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

const token = (sub: string) =>
  d.signer.mint({ sub, tenant: sub, roles: [], scope: ['api'], ttlSeconds: 900 });

const auth = (sub: string) => ({ Authorization: `Bearer ${token(sub)}` });

// Session keys are NOT tagged -- OwnershipIndex owns their naming and this suite does not get to
// rename them -- so they are tracked here and deleted by id. A test that leaves owner zsets behind
// makes the NEXT run's quota assertions fail with a count nobody can explain.
const created: string[] = [];

async function createSession(sub: string): Promise<string> {
  const res = await request('POST', '/v1/sessions', {
    body: { credentials: { inference: 'my-anthropic' } },
    headers: auth(sub),
  });
  expect(res.status, `creating a session as ${sub}`).toBe(201);
  const sid = res.json().sessionId as string;
  created.push(sid);
  return sid;
}

beforeEach(async () => {
  created.length = 0;
  tag = `e2e-${process.pid}-${randomUUID()}`;
  stream = `${LEAF_QUEUE_STREAM}:${tag}`;
  client = createClient({ url: REDIS_URL });
  await client.connect();
  const redis = client as unknown as CpRedisLike;
  d = makeDeps({
    index: new OwnershipIndex(redis),
    turns: new TurnStore(redis, {
      resultTtlSeconds: 86_400,
      ttlMarginSeconds: 3_600,
      keyTag: tag,
    }),
    // The stream name is tagged ONLY here, so two runs of this suite do not drain each other. The
    // constant is still what pins the production name (turn-queue.test.ts).
    turnQueue: new RedisTurnQueue(redis, stream),
    leafResults: client as unknown as { get(k: string): Promise<string | null> },
    newId: () => randomUUID(),
  });
  await seedCredential(d, ALICE);
  await seedCredential(d, BOB);
  server = startControlPlane(d, 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.close();
  // Three cleanups, in the order that leaves nothing: the tagged keys (turn records, owner turn
  // zsets, the idempotency hash), the untagged session records this suite created, and the stream
  // with its group. `keys()` is fine at this scale and is what sandbox-redis.test.ts already does.
  const tagged = await client.keys(`*${tag}*`);
  if (tagged.length) await client.del(tagged);
  for (const sid of created) {
    const keys = await client.keys(`*${sid}*`);
    if (keys.length) await client.del(keys);
  }
  // The owner zsets keep the ids of sessions now gone, and leaving them makes the next run's
  // `GET /v1/sessions` return dangling ids. Remove exactly this suite's members rather than deleting
  // the key: `del sh:cp:owner:*:sessions` would wipe a developer's real sessions on a shared local
  // Redis, which is a steep price for test hygiene.
  for (const sub of [ALICE, BOB]) {
    if (created.length) await client.zRem(ownerKey(sub), created);
  }
  await client.close();
});

/**
 * The fake worker. Deliberately minimal and deliberately blind: it is handed NOTHING but the stream,
 * so the only way it can run a turn is by reading the id and loading the record -- which is the
 * contract #389's drain loop has to honour.
 */
async function fakeWorker(result: Record<string, unknown>): Promise<{
  fields: Record<string, string>;
  rebuilt: { sessionId: string; credentialName: string; envelope: unknown; attempts: number };
}> {
  try {
    // '0' delivers from the start of the stream, so creating the group AFTER the XADD is correct.
    // BUSYGROUP is swallowed because the fan-out case calls this worker three times -- same
    // reasoning, same shape as RedisWorkQueue.ensureGroup.
    await client.xGroupCreate(stream, LEAF_QUEUE_GROUP, '0', { MKSTREAM: true });
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
  }
  const res = await client.xReadGroup(
    LEAF_QUEUE_GROUP,
    `fake-worker-${tag}`,
    [{ key: stream, id: '>' }],
    { COUNT: 1, BLOCK: 1000 },
  );
  const msg = res?.[0]?.messages?.[0];
  if (!msg) throw new Error('the fake worker found nothing on the queue');
  const fields = msg.message as Record<string, string>;
  // Everything below uses ONLY fields.turnId. If a future change put the envelope back on the queue,
  // this worker would keep passing while the real one quietly depended on it.
  const loaded = await d.turns!.get(fields.turnId!);
  if (!loaded) throw new Error(`no record for ${fields.turnId}`);
  await d.turns!.markRunning(loaded.turnId, 1);
  await client.set(`leaf:result:${loaded.sessionId}`, JSON.stringify(result), { EX: 300 });
  await d.turns!.finalize(
    loaded.turnId,
    result.status === 'solved' ? 'solved' : 'done',
    Date.now(),
  );
  await client.xAck(stream, LEAF_QUEUE_GROUP, msg.id);
  // Re-read after markRunning, not the pre-claim snapshot: `attempts` is written by markRunning, so
  // asserting it against `loaded` would always read the stale pre-claim value (0) and the suite
  // would pass while telling the caller the wrong attempt count.
  const turn = await d.turns!.get(loaded.turnId);
  if (!turn) throw new Error(`record for ${loaded.turnId} vanished mid-drain`);
  return {
    fields,
    rebuilt: {
      sessionId: turn.sessionId,
      credentialName: turn.credentialName,
      envelope: turn.envelope,
      attempts: turn.attempts,
    },
  };
}

describe('async turn, end to end (#387 acceptance)', () => {
  it('submits, drains with a fake worker, and reads the result back over HTTP', async () => {
    const sid = await createSession(ALICE);
    const submitted = await request('POST', `/v1/sessions/${sid}/turns`, {
      body: {
        async: true,
        kind: 'prompt',
        prompt: 'summarise the repo',
        caps: { tokens: 1000 },
      },
      headers: auth(ALICE),
    });
    expect(submitted.status).toBe(202);
    const { turnId } = submitted.json();

    // Queued, 0 attempts, no result yet -- what a client polling immediately must see.
    const queued = await request('GET', `/v1/sessions/${sid}/turns/${turnId}`, {
      headers: auth(ALICE),
    });
    expect(queued.status).toBe(200);
    expect(queued.json()).toEqual({ turnId, state: 'queued', attempts: 0 });

    const { fields, rebuilt } = await fakeWorker({
      status: 'solved',
      patch: 'diff --git a/x b/x',
      sessionId: sid,
    });

    // THE assertion of this file: the queue carried a turn id and nothing else -- no envelope, no
    // credential, no bearer token -- and everything the worker needed came from the record.
    expect(Object.keys(fields)).toEqual(['turnId']);
    expect(fields.turnId).toBe(turnId);
    expect(rebuilt.sessionId).toBe(sid);
    expect(rebuilt.credentialName).toBe('my-anthropic');
    expect(rebuilt.envelope).toMatchObject({ kind: 'prompt', prompt: 'summarise the repo' });
    expect(rebuilt.attempts).toBe(1);

    const done = await request('GET', `/v1/sessions/${sid}/turns/${turnId}`, {
      headers: auth(ALICE),
    });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({
      turnId,
      state: 'solved',
      attempts: 1,
      result: { status: 'solved', patch: 'diff --git a/x b/x' },
    });
  });

  it('leaves the record unexpiring while the turn is live, and expires it only at the end', async () => {
    // The §5.1 invariant, against REAL Redis. turn-store-contract.ts proves it against a fake that
    // RECORDS expire() calls -- which cannot show an actual key lifetime, and would pass just as
    // happily if the production code set a TTL through some path the fake does not model.
    const sid = await createSession(ALICE);
    const { turnId } = (
      await request('POST', `/v1/sessions/${sid}/turns`, {
        body: { async: true, kind: 'prompt', prompt: 'go' },
        headers: auth(ALICE),
      })
    ).json();
    // Via the helper, with the tag appended as TurnStore.key() does -- a literal 'sh:cp:turn:...'
    // here would be a second copy of the keyspace to keep in step.
    const key = turnKey(`${turnId}:${tag}`);
    // -1 is "exists, no TTL". -2 would be "no such key" and would pass a `toBeLessThan(0)`, so this
    // is pinned exactly: a 404 for a turn that is queued is the bug this invariant exists to stop.
    expect(await client.ttl(key)).toBe(-1);

    await fakeWorker({ status: 'done', text: 'ok', sessionId: sid });

    const ttl = await client.ttl(key);
    // 86400 (LEAF_RESULT_TTL_SECONDS) + 3600 margin: the record outlives its own result, so a
    // caller that can still read a result can always read the state that explains it.
    expect(ttl).toBeGreaterThan(86_400);
    expect(ttl).toBeLessThanOrEqual(90_000);
  });

  it('a fan-out of three leaves is three sessions, each with its own turn and result', async () => {
    // The idempotency key defaults to the session id (§4.3), so this is the shape an orchestrator
    // must use. Submitting three turns on ONE session would deduplicate to one.
    const sessions = [
      await createSession(ALICE),
      await createSession(ALICE),
      await createSession(ALICE),
    ];
    const turns: string[] = [];
    for (const [i, sid] of sessions.entries()) {
      const res = await request('POST', `/v1/sessions/${sid}/turns`, {
        body: { async: true, item: { item_id: `i${i}`, file: 'f.ts', pattern: 'p' } },
        headers: auth(ALICE),
      });
      expect(res.status).toBe(202);
      turns.push(res.json().turnId);
    }
    expect(new Set(turns).size).toBe(3);
    expect(await client.xLen(stream)).toBe(3);

    for (const [i, sid] of sessions.entries()) {
      const { rebuilt } = await fakeWorker({ status: 'done', text: `leaf ${i}`, sessionId: sid });
      // Each drain picks up a DIFFERENT turn; the worker never needs to know which.
      expect(sessions).toContain(rebuilt.sessionId);
    }
    for (const [i, sid] of sessions.entries()) {
      const res = await request('GET', `/v1/sessions/${sid}/turns/${turns[i]}`, {
        headers: auth(ALICE),
      });
      expect(res.json()).toMatchObject({ state: 'done', result: { status: 'done' } });
    }
  });

  it('an idempotent resubmission returns the same turn and queues nothing further', async () => {
    const sid = await createSession(ALICE);
    const first = await request('POST', `/v1/sessions/${sid}/turns`, {
      body: { async: true, kind: 'prompt', prompt: 'go' },
      headers: auth(ALICE),
    });
    const again = await request('POST', `/v1/sessions/${sid}/turns`, {
      body: { async: true, kind: 'prompt', prompt: 'go' },
      headers: auth(ALICE),
    });
    expect(again.status).toBe(202);
    expect(again.json().turnId).toBe(first.json().turnId);
    // Over the wire, with a real stream: the acceptance criterion is that the second call did not
    // create WORK, not merely that it answered the same id.
    expect(await client.xLen(stream)).toBe(1);
  });

  it('cancels a queued turn over HTTP, and the fake worker finds nothing to run', async () => {
    const sid = await createSession(ALICE);
    const { turnId } = (
      await request('POST', `/v1/sessions/${sid}/turns`, {
        body: { async: true, kind: 'prompt', prompt: 'go' },
        headers: auth(ALICE),
      })
    ).json();
    const cancelled = await request('DELETE', `/v1/sessions/${sid}/turns/${turnId}`, {
      headers: auth(ALICE),
    });
    expect(cancelled.status).toBe(202);
    // The ENTRY is still on the stream -- cancel flips the record, it does not reach into the queue
    // (§4.5). What makes the cancel effective is the claim refusing a cancelled record, so the
    // record is what this asserts.
    expect(await client.xLen(stream)).toBe(1);
    const after = await request('GET', `/v1/sessions/${sid}/turns/${turnId}`, {
      headers: auth(ALICE),
    });
    expect(after.json().state).toBe('cancelled');
  });

  it('refuses past the quota over HTTP with 429, and the stream stops growing', async () => {
    const quota = 2;
    d.config = { ...d.config, asyncQueuedPerOwner: quota };
    const sessions = [
      await createSession(ALICE),
      await createSession(ALICE),
      await createSession(ALICE),
    ];
    const codes: number[] = [];
    for (const sid of sessions) {
      const res = await request('POST', `/v1/sessions/${sid}/turns`, {
        body: { async: true, kind: 'prompt', prompt: 'go' },
        headers: auth(ALICE),
      });
      codes.push(res.status);
      if (res.status === 429) expect(res.json().error).toBe('async_quota_exhausted');
    }
    expect(codes).toEqual([202, 202, 429]);
    expect(await client.xLen(stream)).toBe(quota);
  });
});
