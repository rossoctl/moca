import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

/**
 * A turn that THROWS after its sandbox was leased still reports where it ran (P6.3 spec §6).
 *
 * The 'end' runtime report used to read the placement from `result?.sandbox` only, so a turn that fell
 * back to a fresh sandbox and then failed recorded nothing -- and the resources view never showed that
 * the session had lost its workspace. Both authenticated /turn paths now also capture it through
 * executeTurn's `onPlacement`.
 *
 * executeTurn is faked to do what the real one does on that path (call onPlacement, then fail), and
 * the reporter's Redis client is faked at `createClient`, so the REAL reporter and the control plane's
 * putRuntime allow-list both run: an `hSet` here is exactly what would reach the runtime hash.
 */
const { hSet } = vi.hoisted(() => ({
  hSet: vi.fn(async (_key: string, _fields: Record<string, string>) => 1),
}));
vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    on: () => {},
    connect: async () => {},
    hSet,
    destroy: () => {},
  })),
}));
vi.mock('@moca/harness/run-turn', () => ({
  runTurn: vi.fn(),
  executeTurn: vi.fn(),
}));

import { startServer } from '../src/server.js';
import { executeTurn } from '@moca/harness/run-turn';

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

const PLACEMENT = {
  id: 'm-1',
  tier: 'microvm',
  workspaceReset: { from: 'm-0', reason: 'detached' as const },
};

let server: ReturnType<typeof startServer>;
let base: string;
let cp: http.Server;
const ENV = [
  'SH_REQUIRE_AUTH',
  'SH_SESSION_TOKEN_PUBLIC_KEYS',
  'SH_CONTROL_PLANE_URL',
  'SH_EXCHANGE_TOKEN',
  'REDIS_URL',
] as const;
const saved: Record<string, string | undefined> = {};

function post(headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/turn', base),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...headers,
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
    req.end(JSON.stringify({ sessionId: 'sid-1', prompt: 'hi' }));
  });
}

/** The reporter is fire-and-forget (`void`), so wait for the turn-end write to land. */
async function endReport(): Promise<Record<string, string>> {
  await vi.waitFor(() => {
    expect(hSet.mock.calls.some(([, f]) => f.turnEndedAt !== undefined)).toBe(true);
  });
  return hSet.mock.calls.find(([, f]) => f.turnEndedAt !== undefined)![1];
}

beforeEach(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-alice', // notsecret
        anthropicBaseUrl: 'https://litellm.internal/v1',
        sessionId: 'sid-1',
        subject: 'github:1234',
      }),
    );
  });
  await new Promise<void>((r) => cp.listen(0, () => r()));
  process.env.SH_SESSION_TOKEN_PUBLIC_KEYS = `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`;
  process.env.SH_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SH_EXCHANGE_TOKEN = 'shared-abc'; // notsecret
  // Never dialled: createClient is faked above. Set so the reporter is not the no-op one.
  process.env.REDIS_URL = 'redis://placement-report.invalid:6379';
  hSet.mockClear();
  vi.mocked(executeTurn).mockReset();
  // What executeTurn does for a leased turn that falls back and then fails: report the placement as
  // soon as the lease is taken (and, streaming, emit workspace_reset), then throw from the core.
  vi.mocked(executeTurn).mockImplementation(async (input) => {
    input.onPlacement?.(PLACEMENT);
    input.onEvent?.({
      type: 'workspace_reset',
      sessionId: 'sid-1',
      from: 'm-0',
      tier: 'microvm',
      reason: 'detached',
    });
    throw new Error('model upstream failed');
  });
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

describe('a turn that throws after a workspace reset (P6.3 spec §6)', () => {
  it('the JSON path still reports sandboxId and the reset at turn end', async () => {
    const res = await post({});
    expect(res.status).toBe(500);
    expect(await endReport()).toMatchObject({
      sandboxId: 'm-1',
      sandboxTier: 'microvm',
      workspaceResetFrom: 'm-0',
      workspaceResetAt: expect.stringMatching(/^\d+$/),
    });
  });

  it('the SSE path still reports sandboxId and the reset at turn end', async () => {
    const res = await post({ Accept: 'text/event-stream' });
    // The reset frame went out first, so the failure degrades to a terminal error frame.
    expect(res.text).toContain('event: workspace_reset');
    expect(res.text).toContain('event: error');
    expect(await endReport()).toMatchObject({
      sandboxId: 'm-1',
      sandboxTier: 'microvm',
      workspaceResetFrom: 'm-0',
      workspaceResetAt: expect.stringMatching(/^\d+$/),
    });
  });
});
