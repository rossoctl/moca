import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CpError } from '@moca/control-plane';
import { claimTurn, deadLetterTurn, type TurnClaimDeps } from '../src/turn-claim.js';

const SID = 'c0ffee00-0000-4000-8000-000000000001';
const TURN = 't-11111111-2222-4333-8444-555555555555';

const ok = (over: Record<string, unknown> = {}) => ({
  turnId: TURN,
  mode: 'direct',
  anthropicAuthToken: 'sk-secret',
  anthropicBaseUrl: 'https://gw.example/v1',
  sessionId: SID,
  subject: 'github:1234',
  caps: { tokens: 100 },
  envelope: { kind: 'prompt', prompt: 'go', sessionId: SID },
  ...over,
});

function reply(status: number, body: unknown) {
  return vi.fn(async () => ({ status, text: async () => JSON.stringify(body) })) as never;
}

let markRunning: ReturnType<typeof vi.fn>;

function deps(over: Partial<TurnClaimDeps> = {}): TurnClaimDeps {
  return {
    controlPlaneUrl: 'http://cp.local',
    exchangeToken: 'shared-exchange-secret',
    turns: { markRunning } as never,
    fetchImpl: reply(200, ok()),
    ...over,
  };
}

beforeEach(() => {
  markRunning = vi.fn(async () => 'ok');
});

describe('claimTurn', () => {
  it('presents the turn id to the dequeue route with the exchange bearer', async () => {
    const fetchImpl = reply(200, ok());
    await claimTurn(TURN, 1, deps({ fetchImpl }));
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('http://cp.local/internal/turn-credentials');
    expect(JSON.parse(String(init.body))).toEqual({ turnId: TURN });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer shared-exchange-secret',
    );
  });

  it('returns the envelope, the record session id and the delivery count as attempts', async () => {
    const claimed = await claimTurn(TURN, 2, deps());
    expect(claimed).toMatchObject({ sessionId: SID, attempts: 2 });
    expect(claimed!.envelope).toEqual({ kind: 'prompt', prompt: 'go', sessionId: SID });
  });

  it('puts the resolved credential on the config it hands to runLeaf', async () => {
    const claimed = await claimTurn(TURN, 1, deps());
    expect(claimed!.config.upstreamCredential).toEqual({ mode: 'direct', value: 'sk-secret' });
    expect(claimed!.config.anthropicBaseUrl).toBe('https://gw.example/v1');
    expect(claimed!.config.serverMode).toBe(true);
  });

  it('carries x-api-key through to the credential header when the exchange says so', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ authHeader: 'x-api-key' })) });
    const claimed = await claimTurn(TURN, 1, d);
    expect(claimed!.config.upstreamCredential).toMatchObject({ header: 'x-api-key' });
  });

  it('flips the record to running with the delivery count as attempts', async () => {
    await claimTurn(TURN, 3, deps());
    expect(markRunning).toHaveBeenCalledWith(TURN, 3);
  });

  it('exchanges BEFORE it marks running', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push('exchange');
      return { status: 200, text: async () => JSON.stringify(ok()) };
    }) as never;
    markRunning = vi.fn(async () => {
      order.push('markRunning');
      return 'ok';
    });
    await claimTurn(TURN, 1, deps({ fetchImpl }));
    expect(order).toEqual(['exchange', 'markRunning']);
  });

  it('returns null when markRunning refuses (cancelled between the two calls)', async () => {
    markRunning = vi.fn(async () => 'refused');
    expect(await claimTurn(TURN, 1, deps())).toBeNull();
  });

  it.each([
    [404, 'turn_not_found'],
    [409, 'turn_not_claimable'],
  ])('returns null on %i %s, without marking running', async (status, error) => {
    const d = deps({ fetchImpl: reply(status, { error }) });
    expect(await claimTurn(TURN, 1, d)).toBeNull();
    expect(markRunning).not.toHaveBeenCalled();
  });

  it('throws credential_unavailable when the control plane is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    await expect(claimTurn(TURN, 1, deps({ fetchImpl }))).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(markRunning).not.toHaveBeenCalled();
  });

  it.each([500, 503, 501])('throws on an unexpected %i, leaving the entry pending', async (s) => {
    const d = deps({ fetchImpl: reply(s, { error: 'internal_error' }) });
    await expect(claimTurn(TURN, 1, d)).rejects.toBeInstanceOf(CpError);
    expect(markRunning).not.toHaveBeenCalled();
  });

  it('refuses a response echoing a different turn id', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ turnId: 't-other' })) });
    await expect(claimTurn(TURN, 1, d)).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it.each([
    ['no envelope', {}],
    ['an envelope that is not an object', 'nope'],
    ['an envelope with no session id', { kind: 'prompt', prompt: 'go' }],
    ['an envelope whose session id disagrees with the record', { sessionId: 'other' }],
  ])('refuses a response with %s', async (_label, envelope) => {
    const body = ok();
    if (envelope && typeof envelope === 'object' && Object.keys(envelope).length === 0) {
      delete (body as Record<string, unknown>).envelope;
    } else {
      (body as Record<string, unknown>).envelope = envelope;
    }
    const d = deps({ fetchImpl: reply(200, body) });
    await expect(claimTurn(TURN, 1, d)).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(markRunning).not.toHaveBeenCalled();
  });

  it('refuses a response with an unknown credential mode (shared validation)', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ mode: 'sideways' })) });
    await expect(claimTurn(TURN, 1, d)).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('never puts the credential value in a thrown message', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ turnId: 't-other' })) });
    const err = await claimTurn(TURN, 1, d).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('sk-secret');
  });
});

describe('deadLetterTurn', () => {
  it('writes a failed result under the record session id and finalizes lost', async () => {
    const store = new Map<string, string>();
    const finalize = vi.fn(async () => 'ok');
    await deadLetterTurn(TURN, {
      turns: { get: async () => ({ sessionId: SID }), finalize } as never,
      resultStore: {
        set: async (k: string, v: string) => void store.set(k, v),
        get: async () => null,
      },
      ttlSeconds: 60,
      now: () => '2026-11-10T00:00:00.000Z',
    });
    expect([...store.keys()]).toEqual([`leaf:result:${SID}`]);
    expect(JSON.parse(store.get(`leaf:result:${SID}`)!)).toMatchObject({
      status: 'failed',
      reason: 'error',
    });
    expect(finalize).toHaveBeenCalledWith(TURN, 'lost', expect.any(Number));
  });

  it('is a no-op for a record that has already expired', async () => {
    const finalize = vi.fn(async () => 'ok');
    await deadLetterTurn(TURN, {
      turns: { get: async () => null, finalize } as never,
      resultStore: { set: async () => undefined, get: async () => null },
      ttlSeconds: 60,
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('mints no credential: it never calls the control plane', async () => {
    const fetchImpl = vi.fn();
    globalThis.fetch = fetchImpl as never;
    await deadLetterTurn(TURN, {
      turns: { get: async () => ({ sessionId: SID }), finalize: async () => 'ok' } as never,
      resultStore: { set: async () => undefined, get: async () => null },
      ttlSeconds: 60,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
