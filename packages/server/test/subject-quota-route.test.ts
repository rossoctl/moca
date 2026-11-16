import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

// The #360 suite, harness tier: the admission quota's acceptance test, verbatim — "subject A at
// its cap is refused while subject B is still admitted". The supervisor's pool-wide 429
// (`overloaded`) is untouched; what this pins is the worker-side, post-auth refusal with its own
// code, so a client can tell "you are over your share" from "the host is full".

vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(async (_prompt: string, sessionId?: string) => ({
    sessionId: sessionId ?? 'unset',
    response: 'ok',
    stopReason: 'end_turn',
  })),
  // Re-implemented per test in beforeEach (the hold logic lives there, not here, so the factory
  // references nothing outside itself).
  executeTurn: vi.fn(async (input: { sessionId?: string }) => ({
    sessionId: input.sessionId ?? 'unset',
    response: 'ok',
    stopReason: 'end_turn',
  })),
}));

import { startServer } from '../src/server.js';
import { executeTurn, runTurn } from '@moca/harness/run-turn';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());

const ALICE = 'github:1234';
const BOB = 'github:9999';

/** A turn:write token for either subject, each bound to their own session. */
function sessionTokenFor(sub: string, sid: string): string {
  return signer.mint({
    sub,
    tenant: sub,
    roles: [],
    scope: ['turn:write'],
    sid,
    ttlSeconds: 300,
  });
}

let server: ReturnType<typeof startServer>;
let base: string;
// Held-turn plumbing, shared with the run-turn mock implementations set in beforeEach. Module
// scope (not inside beforeEach) so a test can disarm the hold (`holdNext = false`) when its turns
// must resolve at once.
let holdNext = false;
let releaseHeld: () => void = () => undefined;
/** Resolves once the held turn has actually begun — the signal that the slot is taken. */
let started!: Promise<void>;
/** When set, the scripted control plane holds its reply until `open` settles (a departure test). */
let cpGate: { reached: () => void; open: Promise<void> } | undefined;
const saved: Record<string, string | undefined> = {};

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; retryAfter: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/turn', base),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            json: text ? JSON.parse(text) : undefined,
            retryAfter: res.headers['retry-after'],
          });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const aliceHeaders = { Authorization: `Bearer ${sessionTokenFor(ALICE, 'a-1')}` };
const bobHeaders = { Authorization: `Bearer ${sessionTokenFor(BOB, 'b-1')}` };

beforeEach(async () => {
  for (const k of [
    'SH_REQUIRE_AUTH',
    'SH_SESSION_TOKEN_PUBLIC_KEYS',
    'SH_CONTROL_PLANE_URL',
    'SH_EXCHANGE_TOKEN',
    'SH_TURNS_PER_SUBJECT',
    'SH_TURNS_PER_WORKER',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'REDIS_URL',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // The first turn of each test is HELD until the test releases it, so the turn stays in flight —
  // and its subject's slot with it — across the requests that follow. Later turns resolve at once.
  // `turnStarted` fires on every call so a test can await "the turn actually began" before sending
  // the request whose outcome depends on the slot being held.
  let held!: Promise<void>;
  held = new Promise<void>((r) => (releaseHeld = r));
  let turnStarted!: () => void;
  started = new Promise<void>((r) => (turnStarted = r));
  holdNext = true;
  cpGate = undefined;
  vi.mocked(executeTurn).mockImplementation(async (input: { sessionId?: string }) => {
    turnStarted();
    if (holdNext) {
      holdNext = false;
      await held;
    }
    return { sessionId: input.sessionId ?? 'unset', response: 'ok', stopReason: 'end_turn' };
  });
  // The UNAUTHENTICATED sync path runs runTurn, not executeTurn (server.ts) — held the same way so
  // the anonymous test can hold a turn in flight too.
  vi.mocked(runTurn).mockImplementation(async (_prompt: string, sessionId?: string) => {
    turnStarted();
    if (holdNext) {
      holdNext = false;
      await held;
    }
    return { sessionId: sessionId ?? 'unset', response: 'ok', stopReason: 'end_turn' };
  });
  // The scripted control plane: one credential reply serves either subject — which subject is
  // driving is the token's business, not the exchange's.
  const cp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      // A departure test arms cpGate so the exchange reply lands only when it chooses.
      if (cpGate) {
        cpGate.reached();
        await cpGate.open;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          mode: 'direct',
          anthropicAuthToken: 'sk-test', // notsecret
          anthropicBaseUrl: 'https://litellm.internal/v1',
        }),
      );
    });
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  process.env.SH_TURNS_PER_SUBJECT = '1';
  // Cleared AFTER the implementations are (re)armed and BEFORE the server starts, so each test
  // counts only its own turns — a held turn from the previous test resolves during that test's
  // own afterEach, but its CALL was counted then.
  vi.mocked(executeTurn).mockClear();
  vi.mocked(runTurn).mockClear();
  server = startServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  afterCp = () => cp.close();
});

let afterCp: () => void;

afterEach(async () => {
  releaseHeld();
  await new Promise((r) => setTimeout(r, 0));
  server.close();
  afterCp();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('per-subject admission quota (#360)', () => {
  it('subject A at its cap is refused while subject B is still admitted', async () => {
    // A's first turn: held in flight, so A occupies their one slot.
    const a1 = post({ sessionId: 'a-1', prompt: 'hi' }, aliceHeaders);
    await started;

    // A's second turn: over the cap. A DISTINCT refusal — not the supervisor's `overloaded` —
    // with Retry-After, and no turn ran for it.
    const a2 = await post({ sessionId: 'a-1', prompt: 'hi again' }, aliceHeaders);
    expect(a2.status).toBe(429);
    expect(a2.json).toMatchObject({ error: 'subject_quota_exceeded' });
    expect(a2.retryAfter).toBeDefined();
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(1);

    // Subject B, same instant: admitted.
    const b1 = await post({ sessionId: 'b-1', prompt: 'hi' }, bobHeaders);
    expect(b1.status).toBe(200);
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(2);

    // A's slot frees when the held turn ends, and A is admitted again.
    releaseHeld();
    expect((await a1).status).toBe(200);
    const a3 = await post({ sessionId: 'a-1', prompt: 'once more' }, aliceHeaders);
    expect(a3.status).toBe(200);
  });

  it('the SSE branch is gated too: a second streaming turn for a capped subject never starts streaming', async () => {
    const sse = (headers: Record<string, string>) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.request(
          new URL('/turn', base),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                text: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ sessionId: 'a-1', prompt: 'hi' }));
      });
    const a1 = sse(aliceHeaders);
    await started;
    const a2 = await sse(aliceHeaders);
    expect(a2.status).toBe(429);
    expect(a2.text).toMatch(/subject_quota_exceeded/);
    expect(a2.text).not.toMatch(/event:/); // refused before any SSE frame, as a JSON body
    releaseHeld();
    await a1;
  });

  it('no cap configured (neither SH_TURNS_PER_SUBJECT nor SH_TURNS_PER_WORKER) means no quota', async () => {
    delete process.env.SH_TURNS_PER_SUBJECT;
    const a1 = post({ sessionId: 'a-1', prompt: 'hi' }, aliceHeaders);
    await started;
    const a2 = await post({ sessionId: 'a-1', prompt: 'hi again' }, aliceHeaders);
    expect(a2.status).toBe(200);
    releaseHeld();
    await a1;
  });

  it('an unauthenticated caller has no subject, so no slot is taken from anyone', async () => {
    // The anonymous path keeps today's behaviour byte-for-byte (MU1 §4.3.1): the quota is a
    // per-SUBJECT bound, and there is no subject to bind.
    const anon1 = post({ sessionId: 'a-1', prompt: 'hi' });
    await started;
    const anon2 = await post({ sessionId: 'a-1', prompt: 'hi again' });
    expect(anon2.status).toBe(200);
    releaseHeld();
    await anon1;
  });

  it('a client that leaves during the credential exchange does not leak the subject slot', async () => {
    // Review round 1's blocking finding: `resolveTurnAuth` awaits the exchange, a client can be
    // gone by the time it answers, and the acquire that follows pushed its release onto a slot
    // that had already ended (worker path) — or onto a 'close' listener registered after the
    // event fired, which never runs (standalone path). The subject's count then stays up for the
    // life of the process: with cap 1, one abandoned request locked that user out of the worker.
    // The synchronization (gate, destroy, timed waits) mirrors the turn-counter's own
    // departure-during-exchange test in detachable-turn-route.test.ts.
    holdNext = false; // this test's hold is the EXCHANGE's; its turns resolve at once
    let open!: () => void;
    let reached!: () => void;
    const inExchange = new Promise<void>((r) => (reached = r));
    cpGate = { reached, open: new Promise<void>((r) => (open = r)) };

    const req = http.request(new URL('/turn', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...aliceHeaders },
    });
    req.on('error', () => {}); // the destroy below is the error; nothing to do with it
    req.end(JSON.stringify({ sessionId: 'a-1', prompt: 'hi' }));
    await inExchange;
    req.destroy(); // the client leaves while the control plane is still answering
    await new Promise((r) => setTimeout(r, 100)); // the server sees the close first
    open(); // the exchange answers — to a response that is already gone
    await new Promise((r) => setTimeout(r, 300)); // resolveTurnAuth lands on the dead request

    // The departed client's turn never ran...
    expect(vi.mocked(executeTurn)).not.toHaveBeenCalled();
    // ...and its subject's slot went with it: a FRESH turn for the same subject is admitted,
    // not locked out until restart.
    const a2 = await post({ sessionId: 'a-1', prompt: 'again' }, aliceHeaders);
    expect(a2.status).toBe(200);
  });
});
