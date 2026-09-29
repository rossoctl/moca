import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
  executeTurn: vi.fn(async () => ({ sessionId: 'sid-1', response: 'ok', stopReason: 'end_turn' })),
}));

import { startServer } from '../src/server.js';
import { executeTurn, runTurn } from '@moca/harness/run-turn';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const token = signer.mint({
  sub: 'github:1234',
  tenant: 'github:1234',
  roles: [],
  scope: ['turn:write'],
  sid: 'sid-1',
  ttlSeconds: 300,
});

let server: ReturnType<typeof startServer>;
let base: string;
let cp: http.Server;
let cpReply: { status: number; body: unknown };
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

/**
 * Like post(), but for the SSE branch: the body is `event: ...\ndata: ...\n\n` frames, not JSON,
 * so this returns the raw text instead of attempting JSON.parse (fix round 1, Important 1).
 */
function postRaw(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, base),
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() });
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
  cpReply = {
    status: 200,
    body: {
      mode: 'direct',
      anthropicAuthToken: 'sk-alice', // notsecret
      anthropicBaseUrl: 'https://litellm.internal/v1',
      sessionId: 'sid-1',
      subject: 'github:1234',
    },
  };
  cp = http.createServer((_req, res) => {
    res.writeHead(cpReply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cpReply.body));
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

describe('POST /turn with a token', () => {
  it('passes the subject`s credential into TurnConfig, tagged', async () => {
    const res = await post(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(200);
    const config = vi.mocked(executeTurn).mock.calls[0]![0]!.config!;
    expect(config.upstreamCredential).toEqual({ mode: 'direct', value: 'sk-alice' }); // notsecret
    expect(config.anthropicBaseUrl).toBe('https://litellm.internal/v1');
  });

  it('does not put the ambient token in TurnConfig at all when authenticated', async () => {
    // §9.3 test 1, policy phase: the deployment's own key is in the environment, and the turn still
    // runs on the subject's credential -- with nothing ambient even offered to pi.
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    await post('/turn', { sessionId: 'sid-1', prompt: 'hi' }, { Authorization: `Bearer ${token}` });
    const config = vi.mocked(executeTurn).mock.calls[0]![0]!.config!;
    expect(config.anthropicAuthToken).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('sk-deployment-ambient'); // notsecret
  });

  it('binds createIfAbsent:true, so a control-plane-minted id does not 404 its first turn', async () => {
    // POST /v1/sessions creates the OWNERSHIP record, not the pi session log (spec §7.1), and /turn
    // binds createIfAbsent:false today -- so every MU1 session would fail its first turn (plan gap #1).
    await post('/turn', { sessionId: 'sid-1', prompt: 'hi' }, { Authorization: `Bearer ${token}` });
    expect(vi.mocked(executeTurn).mock.calls[0]![0]!.createIfAbsent).toBe(true);
  });

  it('the SSE branch converts too: binds createIfAbsent:true, tags the credential, drops the ambient token', async () => {
    // Fix round 1, Important 1: resolveTurnAuth runs once before the wantsStream split, so no bypass
    // exists (P5 §3.2), but until this test that branch was verified only by inspection.
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    const res = await postRaw(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeTurn).mock.calls[0]![0]!;
    expect(call.createIfAbsent).toBe(true);
    expect(call.config!.upstreamCredential).toEqual({ mode: 'direct', value: 'sk-alice' }); // notsecret
    expect(call.config!.anthropicAuthToken).toBeUndefined();
  });

  it('400s a session_mismatch', async () => {
    const res = await post(
      '/turn',
      { sessionId: 'other', prompt: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'session_mismatch' });
  });

  it('400s a subject_conflict', async () => {
    const res = await post(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      { Authorization: `Bearer ${token}`, 'X-SH-Subject': 'github:9999' },
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'subject_conflict' });
  });

  it('401s token_INVALID (not token_required) for a bad token with SH_REQUIRE_AUTH unset', async () => {
    // Status alone cannot tell the two 401s apart, and they mean opposite things to a client: with the
    // flag off, `token_required` would be wrong -- no token is needed -- while a PRESENT-but-bad token
    // must still be refused (spec §4.3.1). Asserting only 401 left that distinction untested, so the
    // sibling below asserting `token_required` under the flag was the only one pinning a code at all.
    const res = await post(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      {
        Authorization: 'Bearer nope',
      },
    );
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: 'token_invalid' });
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
  });

  it('503s when the control plane refuses, and does not run the turn', async () => {
    cpReply = { status: 503, body: { error: 'nope' } };
    const res = await post(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'credential_unavailable' });
    expect(vi.mocked(executeTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
  });

  it('400s credential_required, propagated from the control plane', async () => {
    cpReply = { status: 400, body: { error: 'credential_required' } };
    const res = await post(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'credential_required' });
  });
});

describe('POST /turn without a token', () => {
  it('behaves exactly as today under the permissive default', async () => {
    // The rollout requirement: 14 existing deploy scripts must keep working untouched (spec §4.3.1).
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    const res = await post('/turn', { sessionId: 'sid-1', prompt: 'hi' });
    expect(res.status).toBe(200);
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const config = vi.mocked(runTurn).mock.calls[0]![2]!;
    expect(config.anthropicAuthToken).toBe('sk-deployment-ambient'); // notsecret
    expect(config.upstreamCredential).toBeUndefined();
  });

  it('401s token_required when SH_REQUIRE_AUTH=true', async () => {
    process.env.SH_REQUIRE_AUTH = 'true';
    const res = await post('/turn', { sessionId: 'sid-1', prompt: 'hi' });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: 'token_required' });
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
  });

  it('the SSE branch still binds createIfAbsent:false, unchanged, with no token', async () => {
    // Companion to the authenticated-SSE test above: proves the conversion did not flip the
    // unauthenticated SSE branch's 404-on-missing-session contract along with it.
    const res = await postRaw(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      { Accept: 'text/event-stream' },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeTurn).mock.calls[0]![0]!.createIfAbsent).toBe(false);
  });
});

describe('the /v1 aliases', () => {
  it('serves POST /v1/turn identically to POST /turn', async () => {
    const res = await post(
      '/v1/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(executeTurn)).toHaveBeenCalledTimes(1);
  });

  it('serves POST /v1/runs', async () => {
    // Unchanged behaviour -- operator-authenticated and orchestrator-facing (spec §4.3). Asserted so
    // the alias is known to route, not merely declared.
    const res = await post('/v1/runs', { sessionId: 'x' });
    expect([200, 400, 503]).toContain(res.status);
    expect(res.status).not.toBe(404);
  });

  it('is an alias, not a version break — /turn still works', async () => {
    // Forcing a second simultaneous version break on /turn would run two migrations at once against
    // live orchestrators (spec §4.1).
    expect((await post('/turn', { sessionId: 'sid-1', prompt: 'hi' })).status).toBe(200);
  });
});

describe('a malformed SH_SESSION_TOKEN_PUBLIC_KEYS', () => {
  // parseKeyset throws on a malformed entry, a non-Ed25519 key, and a kid that does not match its key
  // (token.ts). Before this, turnAuthDeps() ran OUTSIDE handleTurn's try, so that throw reached the
  // route's own catch and became `500 {"error":"Error: SH_SESSION_TOKEN_PUBLIC_KEYS entry ..."}` --
  // internal error text to an arbitrary caller, on every /turn including the unauthenticated ones the
  // opt-in design exists to leave undisturbed.

  it('crashes the boot rather than serving, so an operator typo is a container log not a 500 per turn', () => {
    // token.ts justifies its curve assertion with "parseKeyset runs at startup on both tiers".
    // main.ts:57 made that true for the control plane; on this tier the only call was per request,
    // and /healthz never touches the keyset -- so the pod went Ready, stayed Ready, and 500ed every
    // turn. This boot call is what makes that comment's claim true here.
    process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = 'garbage';
    expect(() => startServer(0)).toThrow(/SH_SESSION_TOKEN_PUBLIC_KEYS/);
  });

  it('refuses a turn with a typed 503 when the env goes bad AFTER boot, leaking no error text', async () => {
    // The per-request read exists so a Knative env change takes effect without a restart, which is
    // the one way an already-booted pod reaches a bad keyset. Fail closed, and with a code rather
    // than a stringified Error.
    process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = 'garbage';
    const res = await post('/turn', { sessionId: 'sid-1', prompt: 'hi' });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'credential_unavailable' });
    expect(JSON.stringify(res.json)).not.toMatch(/base64|SPKI|Error:/);
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
  });

  it('refuses the SSE branch the same way, rather than streaming from an unusable keyset', async () => {
    process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = 'garbage';
    const res = await postRaw(
      '/turn',
      { sessionId: 'sid-1', prompt: 'hi' },
      { Accept: 'text/event-stream' },
    );
    expect(res.status).toBe(503);
    expect(vi.mocked(executeTurn)).not.toHaveBeenCalled();
  });
});
