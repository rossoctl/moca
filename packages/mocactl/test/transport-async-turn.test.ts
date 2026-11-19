import { describe, it, expect, vi } from 'vitest';
import { AsyncTurnTransport, type TurnApi } from '../src/transport/async-turn.js';
import type { TurnStatus } from '../src/api/types.js';

function api(over: Partial<TurnApi> = {}): TurnApi {
  return {
    submitTurn: vi.fn(async () => ({ sessionId: 's', turnId: 't' })),
    getTurn: vi.fn(async () => ({ turnId: 't', state: 'done', attempts: 1 }) as TurnStatus),
    getTurnArtifact: vi.fn(async (_s, _t, kind) => `the ${kind}`),
    ...over,
  } as TurnApi;
}

const turn = (over: Partial<TurnStatus>): TurnStatus =>
  ({ turnId: 't', state: 'done', attempts: 1, ...over }) as TurnStatus;

describe('AsyncTurnTransport.submit', () => {
  it('asks for the async path and sends only the envelope fields the route takes', async () => {
    const submitTurn = vi.fn(async () => ({ sessionId: 's', turnId: 'turn-9' }));
    const t = new AsyncTurnTransport(api({ submitTurn }));
    const turnId = await t.submit({
      sessionId: 's',
      kind: 'prompt',
      prompt: 'hi',
      // Neither travels: the session already carries the config, and a workload is a 501.
      configRef: 'sha256:' + 'a'.repeat(64),
      workloadId: 'demo',
    });
    expect(turnId).toBe('turn-9');
    expect(submitTurn).toHaveBeenCalledWith('s', { async: true, kind: 'prompt', prompt: 'hi' });
  });
});

describe('AsyncTurnTransport.readTurnState', () => {
  const read = async (state: TurnStatus) => {
    const t = new AsyncTurnTransport(api({ getTurn: vi.fn(async () => state) }));
    return t.readTurnState('s', 't');
  };

  it.each(['queued', 'running'] as const)("maps %s to the sync path's 'queued'", async (state) => {
    expect(await read(turn({ state }))).toBe('queued');
  });

  it('maps lost to a failure that says so', async () => {
    expect(await read(turn({ state: 'lost' }))).toMatchObject({
      status: 'failed',
      reason: 'lost',
    });
  });

  it('maps cancelled to aborted', async () => {
    expect(await read(turn({ state: 'cancelled' }))).toEqual({
      status: 'aborted',
      reason: 'cancelled',
    });
  });

  it('falls back to the turn state when the leaf stored no result', async () => {
    expect(await read(turn({ state: 'failed' }))).toEqual({ status: 'failed' });
  });

  it("keeps the result's finer status, its reason, its gate and the artifact kinds", async () => {
    expect(
      await read(
        turn({
          state: 'paused',
          result: {
            status: 'paused',
            reason: 'gate',
            gate: { summary: 's', proposed_action: 'a' },
            summary: 'clipped',
            artifacts: [
              { kind: 'patch', bytes: 3 },
              { kind: 'text', bytes: 2 },
            ],
          },
        }),
      ),
    ).toEqual({
      status: 'paused',
      reason: 'gate',
      gate: { summary: 's', proposed_action: 'a' },
      artifacts: ['patch', 'text'],
    });
  });

  it('carries no bytes: a status read is polled', async () => {
    const getTurnArtifact = vi.fn();
    const t = new AsyncTurnTransport(
      api({
        getTurn: vi.fn(async () =>
          turn({ result: { status: 'responded', artifacts: [{ kind: 'text', bytes: 4 }] } }),
        ),
        getTurnArtifact,
      }),
    );
    const body = await t.readTurnState('s', 't');
    expect(body).toMatchObject({ artifacts: ['text'] });
    expect(getTurnArtifact).not.toHaveBeenCalled();
  });
});

describe('AsyncTurnTransport.collect', () => {
  it('fetches each kind the result declared and drops the descriptor', async () => {
    const getTurnArtifact = vi.fn(async (_s: string, _t: string, kind: string) => `the ${kind}`);
    const t = new AsyncTurnTransport(api({ getTurnArtifact }));
    const out = await t.collect('s', 't', {
      status: 'responded',
      artifacts: ['patch', 'text'],
    });
    expect(out).toEqual({ status: 'responded', text: 'the text', patch: 'the patch' });
    expect(getTurnArtifact.mock.calls.map((c) => c[2])).toEqual(['text', 'patch']);
  });

  it('asks for nothing when the turn declared no artifacts', async () => {
    const getTurnArtifact = vi.fn();
    const t = new AsyncTurnTransport(api({ getTurnArtifact }));
    expect(await t.collect('s', 't', { status: 'failed', reason: 'boom' })).toEqual({
      status: 'failed',
      reason: 'boom',
    });
    expect(getTurnArtifact).not.toHaveBeenCalled();
  });
});
