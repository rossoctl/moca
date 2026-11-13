import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

// The #367 scope-item-3 suite, harness tier: the demo's negative, verbatim — a turn posted with
// user 1's session token to user 2's session id is refused. turn-auth-route.test.ts already pins
// the session_mismatch code for a SINGLE subject against a mismatched body; what it never drives
// is the two-subject story (two live sessions, both tokens valid for their own), and it never
// proves the refusal happens BEFORE the credential exchange is consulted.

vi.mock('@moca/harness/run-turn', () => ({
  // The mocks echo the sid the caller drove (every test in this file drives a-1 or b-1, never the
  // hardcoded 'sid-1' turn-auth-route.test.ts uses), so a future assertion on a response body
  // cannot be quietly right against a value no test uses. runTurn takes (prompt, sessionId?,
  // config?); executeTurn takes the input object.
  runTurn: vi.fn(async (_prompt: string, sessionId?: string) => ({
    sessionId: sessionId ?? 'unset',
    response: 'ok',
    stopReason: 'end_turn',
  })),
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

/** A turn:write token for the demo's two subjects, each bound to their own session. */
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
let cp: http.Server;
/** Requests the scripted control plane received — the counter behind "the exchange was never consulted". */
let cpCalls: { url: string; body: unknown }[];
const saved: Record<string, string | undefined> = {};

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

beforeEach(async () => {
  for (const k of [
    'SH_REQUIRE_AUTH',
    'SH_SESSION_TOKEN_PUBLIC_KEYS',
    'SH_CONTROL_PLANE_URL',
    'SH_EXCHANGE_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'REDIS_URL',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  cpCalls = [];
  cp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      cpCalls.push({
        url: req.url ?? '/',
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
      });
      // Which session a caller drives is only visible in the presented token, which the scripted
      // exchange would verify itself; the tests that reach the exchange drive bob's session only.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          mode: 'direct',
          anthropicAuthToken: 'sk-bob', // notsecret
          anthropicBaseUrl: 'https://litellm.internal/v1',
          sessionId: 'b-1',
          subject: BOB,
        }),
      );
    });
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  vi.mocked(runTurn).mockClear();
  vi.mocked(executeTurn).mockClear();
  server = startServer(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server.close();
  cp.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('two subjects, two live sessions (#367 scope item 3)', () => {
  it('each subject drives their own session first — the fixture is not broken', async () => {
    // Sanity for the negative below: bob's valid token on bob's session succeeds, and the
    // credential that reaches executeTurn is bob's own, tagged for his subject.
    const res = await post(
      '/turn',
      { sessionId: 'b-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${sessionTokenFor(BOB, 'b-1')}`,
      },
    );
    expect(res.status).toBe(200);
    const config = vi.mocked(executeTurn).mock.calls[0]![0]!.config!;
    expect(config.upstreamCredential).toEqual({ mode: 'direct', value: 'sk-bob' }); // notsecret
  });

  it("alice's token driving bob's session is refused: 400 session_mismatch, no turn, no exchange", async () => {
    // The demo's acceptance negative, verbatim: user 1's session token posted to user 2's session
    // id. Both facts are individually valid — the token is signed, unexpired, turn:write-scoped,
    // and bound to alice's real session a-1 — which is what makes this a two-SUBJECT test rather
    // than a bad-token test.
    const res = await post(
      '/turn',
      { sessionId: 'b-1', prompt: 'hi' },
      { Authorization: `Bearer ${sessionTokenFor(ALICE, 'a-1')}` },
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'session_mismatch' });
    // The refusal is auth-tier: no turn ran...
    expect(vi.mocked(executeTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
    // ...and the credential exchange was never consulted — the 400 is not a downstream refusal
    // re-labelled. cpCalls is counted by the scripted server itself, so the assertion cannot pass
    // vacuously.
    expect(cpCalls).toHaveLength(0);
  });

  it('the SSE branch refuses the same cross-drive before any streaming begins', async () => {
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        new URL('/turn', base),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${sessionTokenFor(ALICE, 'a-1')}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ sessionId: 'b-1', prompt: 'hi' }));
    });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/session_mismatch/);
    expect(vi.mocked(executeTurn)).not.toHaveBeenCalled();
    expect(cpCalls).toHaveLength(0);
  });

  it('the mismatch, not the token, is the refusal: alice drives her own session fine', async () => {
    // Pins that the cross-drive 400 above is about the sid binding, not about alice's token being
    // rejected in general. Alice's token drives her own session and reaches the exchange (the
    // scripted reply only knows bob's credential, but the point is the call happens and the turn
    // runs — the harness does not treat the subject itself as unauthorized).
    const res = await post(
      '/turn',
      { sessionId: 'a-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${sessionTokenFor(ALICE, 'a-1')}`,
      },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(1);
    expect(cpCalls).toHaveLength(1);
  });
});
