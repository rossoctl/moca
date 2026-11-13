import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpError } from '@moca/control-plane';
import { claimTurn, deadLetterTurn, type TurnClaimDeps } from '../src/turn-claim.js';

const SID = 'c0ffee00-0000-4000-8000-000000000001';
const TURN = 't-11111111-2222-4333-8444-555555555555';
// Distinctive, so a substring assertion against console/error output is unambiguous.
const SECRET = 'sk-ant-SENTINEL-DO-NOT-LEAK';

const ok = (over: Record<string, unknown> = {}) => ({
  turnId: TURN,
  mode: 'direct',
  anthropicAuthToken: SECRET,
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

// Suite-wide guard against item 5's regressions: `console.error(raw)` after `res.text()`, or any
// other console call, printing the live credential. Spying on all five levels and asserting no
// call argument -- stringified -- ever contains the secret catches a leak regardless of which
// console method a future change used.
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  markRunning = vi.fn(async () => 'ok');
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SECRET);
      }
    }
    spy.mockRestore();
  }
  consoleSpies.length = 0;
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
    expect(claimed!.config.upstreamCredential).toEqual({ mode: 'direct', value: SECRET });
    expect(claimed!.config.anthropicBaseUrl).toBe('https://gw.example/v1');
    expect(claimed!.config.serverMode).toBe(true);
  });

  it('carries x-api-key through to the credential header when the exchange says so', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ authHeader: 'x-api-key' })) });
    const claimed = await claimTurn(TURN, 1, d);
    expect(claimed!.config.upstreamCredential).toMatchObject({ header: 'x-api-key' });
  });

  it("carries a templated session's template, seed and build onto the config it hands to runLeaf", async () => {
    const B = 'sha256:' + 'b'.repeat(64);
    const d = deps({
      fetchImpl: reply(
        200,
        ok({
          sandboxTemplate: 'example-repo',
          sandboxSeed: 'cp -a /opt/src/. /workspace/',
          sandboxSeedSource: 'build',
          sandboxBuildId: B,
        }),
      ),
    });
    const claimed = await claimTurn(TURN, 1, d);
    expect(claimed!.config).toMatchObject({
      sandboxTemplate: 'example-repo',
      sandboxSeed: 'cp -a /opt/src/. /workspace/',
      sandboxSeedSource: 'build',
      sandboxBuildId: B,
    });
    // An untemplated session's claim carries none of them.
    const plain = await claimTurn(TURN, 1, deps());
    for (const k of ['sandboxTemplate', 'sandboxSeed', 'sandboxSeedSource', 'sandboxBuildId'])
      expect(plain!.config).not.toHaveProperty(k);
  });

  it('refuses a malformed template field rather than run the turn on other hands', async () => {
    const d = deps({
      fetchImpl: reply(200, ok({ sandboxTemplate: 'example-repo', sandboxBuildId: 'latest' })),
    });
    await expect(claimTurn(TURN, 1, d)).rejects.toThrow(/sandboxBuildId/);
    expect(markRunning).not.toHaveBeenCalled();
  });

  it('flips the record to running with the delivery count as attempts', async () => {
    await claimTurn(TURN, 3, deps());
    expect(markRunning).toHaveBeenCalledWith(TURN, 3);
    // Pinned exactly, not just "called with at least these": a stray extra argument (e.g. a
    // credential or the body) would pass toHaveBeenCalledWith but fail this.
    expect(markRunning.mock.calls[0]).toEqual([TURN, 3]);
  });

  it('merges the exchange response configRef into the claimed envelope (R13)', async () => {
    // A realistic 64-hex digest, not a short placeholder: validateExchangeBody's configRef check
    // is a regex over the full shape.
    const configRef = `sha256:${'a1b2'.repeat(16)}`;
    const d = deps({ fetchImpl: reply(200, ok({ configRef })) });
    const claimed = await claimTurn(TURN, 1, d);
    expect((claimed!.envelope as unknown as Record<string, unknown>).configRef).toBe(configRef);
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

  it('throws (does not resolve to null) when markRunning itself fails (R16)', async () => {
    // The whole point of null vs throw: a swallowed markRunning failure that resolved to `null`
    // would ack and permanently drop a turn that was never actually refused.
    markRunning = vi.fn(async () => {
      throw new CpError('redis_unavailable', 'redis down');
    });
    await expect(claimTurn(TURN, 1, deps())).rejects.toBeInstanceOf(CpError);
  });

  it.each([
    [404, 'turn_not_found'],
    [409, 'turn_not_claimable'],
    [404, 'session_not_found'],
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

  // Genuinely NOT in NOT_CLAIMABLE (turn_not_found / turn_not_claimable / session_not_found):
  // 'internal_error' must stay a call failure, not a claim refusal.
  it.each([500, 503, 501])('throws on an unexpected %i, leaving the entry pending', async (s) => {
    const d = deps({ fetchImpl: reply(s, { error: 'internal_error' }) });
    await expect(claimTurn(TURN, 1, d)).rejects.toBeInstanceOf(CpError);
    expect(markRunning).not.toHaveBeenCalled();
  });

  it('refuses a response echoing a different turn id', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ turnId: 't-other' })) });
    const err = await claimTurn(TURN, 1, d).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'credential_unavailable' });
    expect(JSON.stringify(err)).not.toContain(SECRET);
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
    const err = await claimTurn(TURN, 1, d).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'credential_unavailable' });
    expect(markRunning).not.toHaveBeenCalled();
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('refuses a response with an unknown credential mode (shared validation)', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ mode: 'sideways' })) });
    const err = await claimTurn(TURN, 1, d).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'credential_unavailable' });
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('never puts the credential value in a thrown message', async () => {
    const d = deps({ fetchImpl: reply(200, ok({ turnId: 't-other' })) });
    const err = await claimTurn(TURN, 1, d).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(SECRET);
  });
});

describe('deadLetterTurn', () => {
  it('writes a failed result under the record session id AND turn id, finalizes lost', async () => {
    const store = new Map<string, string>();
    const finalize = vi.fn(async () => 'ok');
    await deadLetterTurn(TURN, {
      turns: { get: async () => ({ sessionId: SID, state: 'queued' }), finalize } as never,
      resultStore: {
        set: async (k: string, v: string) => void store.set(k, v),
        get: async () => null,
      },
      ttlSeconds: 60,
      now: () => '2026-11-10T00:00:00.000Z',
    });
    expect([...store.keys()]).toEqual([`leaf:result:${SID}:${TURN}`]);
    expect(JSON.parse(store.get(`leaf:result:${SID}:${TURN}`)!)).toMatchObject({
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

  it('is a no-op for a record that is already terminal (R14): never overwrites a done result', async () => {
    // Last delivery, leaf succeeded, worker killed before ack: the entry is reclaimed and
    // dead-lettered even though the record already says 'done'. Must not stomp the real result.
    const set = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => 'ok');
    await deadLetterTurn(TURN, {
      turns: { get: async () => ({ sessionId: SID, state: 'done' }), finalize } as never,
      resultStore: { set, get: async () => null },
      ttlSeconds: 60,
    });
    expect(set).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('mints no credential: it never calls the control plane', async () => {
    const fetchImpl = vi.fn();
    globalThis.fetch = fetchImpl as never;
    await deadLetterTurn(TURN, {
      turns: {
        get: async () => ({ sessionId: SID, state: 'queued' }),
        finalize: async () => 'ok',
      } as never,
      resultStore: { set: async () => undefined, get: async () => null },
      ttlSeconds: 60,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
