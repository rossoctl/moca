import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import type { TurnFrame } from '../src/api/frames.js';
import {
  HarnessUntrustedError,
  LOST_TURN_MESSAGE,
  SessionManager,
  type SessionDeps,
  type SessionEvent,
} from '../src/core/session-manager.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { lastTurnState } from '../src/render/blocks.js';
import { doneFrame, fakeControlPlane, fakeHarness, type HarnessStep } from './helpers/fakes.js';

const NOW = 1_000_000_000; // ms
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(
  steps: HarnessStep[],
  over: Partial<SessionDeps> = {},
  attachSteps: HarnessStep[] = [],
) {
  const cp = fakeControlPlane();
  const harness = fakeHarness(steps, {}, attachSteps);
  const slept: number[] = [];
  const deps: SessionDeps = {
    cp,
    harness,
    now: () => NOW,
    sleep: async (ms) => void slept.push(ms),
    ...over,
  };
  return { cp, harness, slept, deps, manager: new SessionManager(deps) };
}

async function started(
  steps: HarnessStep[],
  over: Partial<SessionDeps> = {},
  attachSteps: HarnessStep[] = [],
) {
  const s = setup(steps, over, attachSteps);
  const session = await s.manager.resume('s1');
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return { ...s, session, events, ends: () => events.filter((e) => e.kind === 'turn-end') };
}

const harnessError = (status: number, code: string, retryAfterS?: number) =>
  new ApiError('harness', status, code, undefined, retryAfterS);

describe('ActiveSession', () => {
  it('runs a turn and forwards its frames', async () => {
    const { session, events } = await started([
      { frames: [{ type: 'text', delta: 'hi' }, doneFrame()] },
    ]);
    session.submit('hello');
    await session.idle();
    expect(events.map((e) => e.kind)).toEqual([
      'queue',
      'queue',
      'turn-start',
      'frame',
      'frame',
      'turn-end',
    ]);
    expect(events.at(-1)).toEqual({ kind: 'turn-end', outcome: 'done' });
  });

  it('runs one turn at a time, in submission order', async () => {
    const { session, harness, events } = await started([
      { frames: [doneFrame()] },
      { frames: [doneFrame()] },
    ]);
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
    expect(
      events.filter((e) => e.kind === 'turn-start').map((e) => (e as { prompt: string }).prompt),
    ).toEqual(['a', 'b']);
  });

  it('queues a prompt submitted while a turn is streaming; cancel moves on to it', async () => {
    const { session, ends } = await started(
      [{ frames: [{ type: 'text', delta: 'x' }], hang: true }],
      { cancelPauseMs: 5 },
    );
    session.submit('a');
    await tick();
    session.submit('b');
    expect(session.busy).toBe(true);
    expect(session.queued).toBe(1);
    session.cancel();
    await session.idle();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'done']);
  });

  it('clearQueue drops waiting prompts', async () => {
    const { session, harness } = await started([{ hang: true }]);
    session.submit('a');
    await tick();
    session.submit('b');
    session.clearQueue();
    session.cancel();
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
  });

  it('after a cancel, waits before sending the next queued prompt, so a clearQueue drops it', async () => {
    const { session, harness, ends } = await started([{ hang: true }], { cancelPauseMs: 10_000 });
    session.submit('a');
    await tick();
    session.submit('b');
    session.cancel();
    await tick();
    await tick();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled']);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']); // 'b' is waiting, not sent
    expect(session.queued).toBe(1);
    session.clearQueue(); // the second Esc, within the window
    await session.idle(); // ends the pause at once: no 10 s wait
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
  });

  it('after a cancel, sends the next queued prompt once the pause has passed', async () => {
    const { session, harness, ends } = await started([{ hang: true }], { cancelPauseMs: 30 });
    session.submit('a');
    await tick();
    session.submit('b');
    const cancelledAt = Date.now();
    session.cancel();
    await session.idle();
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(25);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'done']);
  });

  it('does not pause after a turn that finished normally', async () => {
    const { session, harness } = await started([{ frames: [doneFrame()] }], {
      cancelPauseMs: 10_000,
    });
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
  });

  it('remints a session token that is inside the 30 s margin', async () => {
    let mints = 0;
    const s = setup([]);
    s.cp.mintSessionToken = async () =>
      mints++ === 0
        ? { token: 'near', expiresAt: NOW / 1000 + 10 }
        : { token: 'renewed', expiresAt: NOW / 1000 + 300 };
    const session = await s.manager.resume('s1');
    session.submit('p');
    await session.idle();
    expect(mints).toBe(2); // resume, then the pre-turn remint
    expect(s.harness.turns[0].token).toBe('renewed');
  });

  it('remints once on a harness token rejection and succeeds', async () => {
    const { session, cp, ends } = await started([
      { error: harnessError(401, 'token_invalid') },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(2); // resume + one remint
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('token_expired from the harness remints once and succeeds', async () => {
    const { session, ends } = await started([
      { error: harnessError(401, 'token_expired') },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('diagnoses an untrusted harness when a fresh token is rejected again', async () => {
    const { session, ends } = await started([
      { error: harnessError(401, 'token_invalid') },
      { error: harnessError(401, 'token_invalid') },
    ]);
    session.submit('p');
    await session.idle();
    const end = ends()[0] as { outcome: string; error?: Error };
    expect(end.outcome).toBe('error');
    expect(end.error).toBeInstanceOf(HarnessUntrustedError);
  });

  it('waits out Retry-After on a 503 and retries', async () => {
    const { session, slept, events } = await started([
      { error: harnessError(503, 'saturated', 4) },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(slept).toEqual([4000]);
    expect(events).toContainEqual({ kind: 'retrying', seconds: 4 });
    expect(events.at(-1)).toEqual({ kind: 'turn-end', outcome: 'done' });
  });

  it('cancel during a Retry-After wait ends the turn as cancelled', async () => {
    const waitForAbort = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
    const { session, ends } = await started([{ error: harnessError(503, 'saturated', 60) }], {
      sleep: waitForAbort,
    });
    session.submit('p');
    await tick();
    await tick();
    session.cancel();
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it('a truncated stream ends the turn as an error and the queue continues', async () => {
    const truncated = new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream before the turn finished',
    );
    const { session, cp, ends } = await started([
      { frames: [{ type: 'text', delta: 'part' }], error: truncated },
      { frames: [doneFrame()] },
    ]);
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['error', 'done']);
    expect((ends()[0] as { error?: Error }).error).toBe(truncated);
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(1); // no remint after frames flowed
    expect(session.busy).toBe(false);
  });

  it('reports an error frame as an error outcome with its message', async () => {
    const { session, ends } = await started([
      {
        frames: [
          { type: 'error', sessionId: 's1', stopReason: 'error', errorMessage: 'model refused' },
        ],
      },
    ]);
    session.submit('p');
    await session.idle();
    expect((ends()[0] as { error?: Error }).error?.message).toBe('model refused');
  });

  it('records the prompt and frames in the transcript store', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { session } = await started([{ frames: [{ type: 'text', delta: 'ok' }, doneFrame()] }], {
      transcripts,
    });
    session.submit('hello');
    await session.idle();
    expect(transcripts.load('s1')!.entries.map((e) => e.kind)).toEqual([
      'prompt',
      'frame',
      'frame',
    ]);
  });
});

describe('SessionManager', () => {
  it('create uses the token from the create response and ensures a transcript', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { manager, cp, harness } = setup([], { transcripts });
    const session = await manager.create({ credentials: { inference: 'a' } });
    expect(session.sessionId).toBe('s-new');
    expect(transcripts.has('s-new')).toBe(true);
    session.submit('p');
    await session.idle();
    expect(harness.turns[0].token).toBe('st');
    expect(cp.calls).not.toContain('mintSessionToken');
  });

  it('remove deletes the session and its transcript', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    transcripts.appendPrompt('s1', 'x');
    const { manager } = setup([], { transcripts });
    expect(await manager.remove('s1')).toBe('deleted');
    expect(transcripts.has('s1')).toBe(false);
  });

  it('a control-plane mint failure during remint ends the turn as error', async () => {
    const cpError = new ApiError('control-plane', 401, 'token_expired');
    const { session, cp, ends } = await started([{ error: harnessError(401, 'token_invalid') }]);
    cp.mintSessionToken = async () => {
      throw cpError;
    };
    session.submit('p');
    await session.idle();
    expect(ends()[0]).toEqual({ kind: 'turn-end', outcome: 'error', error: cpError });
  });

  it('session_mismatch twice throws the ApiError, not HarnessUntrustedError', async () => {
    const mismatchError = harnessError(400, 'session_mismatch');
    const { session, ends } = await started([{ error: mismatchError }, { error: mismatchError }]);
    session.submit('p');
    await session.idle();
    const end = ends()[0] as { outcome: string; error?: Error };
    expect(end.outcome).toBe('error');
    expect(end.error).toBe(mismatchError);
  });

  it('a 503 with Retry-After that arrives after a frame has flowed is not retried', async () => {
    const { session, slept, ends } = await started([
      { frames: [{ type: 'text', delta: 'x' }], error: harnessError(503, 'saturated', 2) },
    ]);
    session.submit('p');
    await session.idle();
    expect(slept).toEqual([]); // No sleep because streamed=true blocks retry
    expect(ends()[0]?.outcome).toBe('error');
    expect(ends()[0]?.error).toBeDefined();
  });

  it('with a real TranscriptStore, a truncated stream leaves the pending text delta', async () => {
    const truncated = new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream',
    );
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { session } = await started(
      [{ frames: [{ type: 'text', delta: 'part' }], error: truncated }],
      { transcripts },
    );
    session.submit('a');
    await session.idle();
    const t = transcripts.load('s1')!;
    // Entries include prompt and the buffered text frame (flushed on error)
    expect(t.entries.map((e) => e.kind)).toEqual(['prompt', 'frame']);
    // Frame entry should be the text delta
    const textFrameEntry = t.entries[1] as { kind: 'frame'; frame: TurnFrame };
    expect(textFrameEntry.frame.type).toBe('text');
    expect((textFrameEntry.frame as { type: string; delta: string }).delta).toBe('part');
  });

  it('a listener that throws on every event does not break the session', async () => {
    const { session, ends } = await started([{ frames: [doneFrame()] }, { frames: [doneFrame()] }]);
    const throwingListener = () => {
      throw new Error('listener crash');
    };
    const goodEvents: SessionEvent[] = [];
    const goodListener = (e: SessionEvent) => {
      goodEvents.push(e);
    };
    session.on(throwingListener);
    session.on(goodListener);
    session.submit('a');
    session.submit('b');
    await session.idle();
    // Both turns should complete with exactly one turn-end each, despite throwing listener
    const turnEnds = goodEvents.filter((e) => e.kind === 'turn-end');
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds.map((e) => (e as { outcome: string }).outcome)).toEqual(['done', 'done']);
  });

  it('a TranscriptStore whose appendPrompt throws does not crash the turn', async () => {
    const badTranscripts = {
      appendPrompt: () => {
        throw new Error('disk full');
      },
    } as unknown as TranscriptStore;
    const { session, ends } = await started([{ frames: [doneFrame()] }], {
      transcripts: badTranscripts,
    });
    session.submit('p');
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });
});

const turnF = { type: 'turn', turnId: 't1', sessionId: 's1' } as const;
const text = (delta: string) => ({ type: 'text', delta }) as const;
const cancelledF: TurnFrame = {
  type: 'error',
  sessionId: 's1',
  stopReason: 'aborted',
  abortReason: 'cancelled',
  errorMessage: 'cancelled',
};
const COULD_NOT_CANCEL = {
  kind: 'notice',
  text: "couldn't cancel — the turn keeps running",
  tone: 'error',
} as const;

describe('detachable turns', () => {
  it('asks for a detachable turn and records the turn and its ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-'));
    const transcripts = new TranscriptStore(dir, { subject: 'u', controlPlaneUrl: 'http://cp' });
    const { session, harness } = await started(
      [{ frames: [turnF, text('a'), doneFrame()], ids: ['t1:1-0', 't1:2-0', 't1:3-0'] }],
      { detachable: true, transcripts },
    );
    session.submit('go');
    await session.idle();
    expect(harness.turns[0]!.detachable).toBe(true);
    expect(transcripts.load('s1')!.lastEventId).toBe('t1:3-0');
  });

  it('a non-detachable session asks for a plain turn', async () => {
    const { session, harness } = await started([{ frames: [doneFrame()] }]);
    session.submit('go');
    await session.idle();
    expect(harness.turns[0]!.detachable).toBe(false);
  });

  it('re-attaches after a dropped stream with the last id, and finishes', async () => {
    const drop = new ApiError('harness', 0, 'network_error', 'socket hang up');
    const { session, harness, events, slept } = await started(
      [{ frames: [turnF, text('a')], ids: ['t1:1-0', 't1:2-0'], error: drop }],
      { detachable: true },
      [{ frames: [turnF, text('b'), doneFrame()], ids: ['t1:1-0', 't1:3-0', 't1:4-0'] }],
    );
    session.submit('go');
    await session.idle();
    expect(harness.attaches[0]!.lastEventId).toBe('t1:2-0');
    expect(slept[0]).toBe(500);
    expect(events.filter((e) => e.kind === 'turn-end')).toEqual([
      { kind: 'turn-end', outcome: 'done' },
    ]);
  });

  it('gives up after 5 tries with the lost-turn error', async () => {
    const drop = () => ({ error: new ApiError('harness', 0, 'network_error', 'x') });
    const { session, ends, slept } = await started(
      [
        {
          frames: [turnF],
          ids: ['t1:1-0'],
          error: new ApiError('harness', 0, 'network_error', 'x'),
        },
      ],
      { detachable: true },
      [drop(), drop(), drop(), drop(), drop()],
    );
    session.submit('go');
    await session.idle();
    expect(slept).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(ends()).toMatchObject([{ outcome: 'error', error: { message: LOST_TURN_MESSAGE } }]);
  });

  it('the re-attach budget is per drop: 6 drops, each after new frames, still finish', async () => {
    const drop = () => new ApiError('harness', 0, 'network_error', 'x');
    const reattaches: HarnessStep[] = Array.from({ length: 6 }, (_, i) => ({
      frames: [turnF, text(`r${i}`)],
      ids: [`t1:${i + 2}-0`, `t1:${i + 3}-0`],
      error: drop(),
    }));
    const { session, ends, slept, harness } = await started(
      [{ frames: [turnF, text('a')], ids: ['t1:1-0', 't1:2-0'], error: drop() }],
      { detachable: true },
      [...reattaches, { frames: [turnF, doneFrame()], ids: ['t1:8-0', 't1:9-0'] }],
    );
    session.submit('go');
    await session.idle();
    expect(harness.attaches).toHaveLength(7);
    expect(slept).toEqual([500, 500, 500, 500, 500, 500, 500]); // the backoff restarts too
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('a re-attach that only repeats the turn frame does not renew the budget', async () => {
    const drop = () => ({
      frames: [turnF],
      ids: ['t1:1-0'],
      error: new ApiError('harness', 0, 'network_error', 'x'),
    });
    const { session, ends, slept } = await started([drop()], { detachable: true }, [
      drop(),
      drop(),
      drop(),
      drop(),
      drop(),
    ]);
    session.submit('go');
    await session.idle();
    expect(slept).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(ends()).toMatchObject([{ outcome: 'error', error: { message: LOST_TURN_MESSAGE } }]);
  });

  it.each([
    ['a 503 redis_unavailable', harnessError(503, 'redis_unavailable', 1)],
    ['a gateway 502', harnessError(502, 'bad_gateway')],
    ['a gateway 504', harnessError(504, 'gateway_timeout')],
  ])('%s on a re-attach is retried', async (_how, error) => {
    const { session, ends, harness } = await started(
      [
        {
          frames: [turnF, text('a')],
          ids: ['t1:1-0', 't1:2-0'],
          error: new ApiError('harness', 0, 'network_error', 'x'),
        },
      ],
      { detachable: true },
      [{ error }, { frames: [turnF, doneFrame()], ids: ['t1:2-0', 't1:3-0'] }],
    );
    session.submit('go');
    await session.idle();
    expect(harness.attaches).toHaveLength(2);
    expect(harness.attaches[1]!.lastEventId).toBe('t1:2-0');
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('Esc on a detachable turn cancels through the route and keeps reading', async () => {
    let release!: () => void;
    // The first stream ends after the turn frame, so the session re-attaches; that attach holds
    // until `release`, then delivers the cancelled terminal.
    const { session, harness, ends } = await started([{ frames: [turnF], ids: ['t1:1-0'] }], {
      detachable: true,
    });
    harness.attachQueuePush({
      wait: () => new Promise<void>((r) => (release = r)),
      frames: [cancelledF],
    });
    session.submit('go');
    await tick();
    session.cancel();
    await tick();
    expect(harness.cancels).toEqual([
      { sessionId: 's1', turnId: 't1', token: expect.any(String), signal: expect.any(AbortSignal) },
    ]);
    release();
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it('a failed cancel says so and leaves the turn running', async () => {
    const { session, harness, events } = await started(
      [{ frames: [turnF], ids: ['t1:1-0'], hang: true }],
      { detachable: true },
    );
    harness.cancelTurn = async () => {
      throw new ApiError('harness', 0, 'network_error', 'down');
    };
    session.submit('go');
    await tick();
    expect(await session.cancelRemote()).toBe(false);
    expect(events).toContainEqual(COULD_NOT_CANCEL);
    expect(session.runningDetachable).toBe(true);
    session.detach();
    await session.idle();
  });

  it('a cancel the server never answers fails within the bound', async () => {
    const { session, harness, events } = await started(
      [{ frames: [turnF], ids: ['t1:1-0'], hang: true }],
      { detachable: true, cancelTimeoutMs: 20 },
    );
    harness.cancelTurn = () => new Promise<void>(() => undefined);
    session.submit('go');
    await tick();
    const startedAt = Date.now();
    expect(await session.cancelRemote()).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(events).toContainEqual(COULD_NOT_CANCEL);
    expect(session.runningDetachable).toBe(true);
    session.detach();
    await session.idle();
  });

  it('a server-cancelled turn still holds the next queued prompt for the double-Esc pause', async () => {
    const { session, harness } = await started(
      [{ frames: [turnF, cancelledF], ids: ['t1:1-0', 't1:2-0'] }],
      { detachable: true, cancelPauseMs: 10_000 },
    );
    session.submit('a');
    session.submit('b');
    await tick();
    await tick();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']); // 'b' waits out the pause
    session.clearQueue();
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
  });

  it('attachExisting replays a finished turn, then runs the queued prompt', async () => {
    const { session, harness, events } = await started(
      [{ frames: [doneFrame()] }],
      { detachable: true },
      [{ frames: [turnF, text('rest'), doneFrame()], ids: ['t1:1-0', 't1:5-0', 't1:6-0'] }],
    );
    session.attachExisting({ lastEventId: 't1:4-0', expectOpen: true });
    session.submit('next');
    await session.idle();
    expect(harness.attaches[0]!.lastEventId).toBe('t1:4-0');
    const order = events
      .map((e) => e.kind)
      .filter((k) => k === 'attach-start' || k === 'turn-start');
    expect(order).toEqual(['attach-start', 'turn-start']);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['next']);
  });

  it('detach during an attach job re-attaching ends it cancelled, not as an error', async () => {
    let slept!: () => void;
    const { session, harness, ends } = await started(
      [],
      {
        detachable: true,
        // The first re-attach backoff holds until detach aborts it.
        sleep: (_ms, signal) =>
          new Promise<void>((r) => {
            slept = r;
            signal?.addEventListener('abort', () => r(), { once: true });
          }),
      },
      [
        {
          frames: [turnF],
          ids: ['t1:1-0'],
          error: new ApiError('harness', 0, 'network_error', 'x'),
        },
      ],
    );
    session.attachExisting({ expectOpen: true });
    await tick();
    expect(slept).toBeDefined();
    session.detach();
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
    expect(harness.cancels).toEqual([]);
  });

  it('an attach stream that ends with no frame at all ends as the lost-turn error', async () => {
    const { session, ends } = await started([], { detachable: true }, [{ frames: [] }]);
    session.attachExisting({ expectOpen: true });
    await session.idle();
    expect(ends()).toMatchObject([{ outcome: 'error', error: { message: LOST_TURN_MESSAGE } }]);
  });

  it('attachExisting with nothing to attach reports whether a turn was missed', async () => {
    const { session, events } = await started([], { detachable: true });
    session.attachExisting({ expectOpen: true });
    await session.idle();
    expect(events).toContainEqual({ kind: 'attach-none', missed: true });
  });

  it('409 turn_in_progress attaches to the running turn, then sends the prompt', async () => {
    const busy = new ApiError('harness', 409, 'turn_in_progress');
    const { session, harness } = await started(
      [{ error: busy }, { frames: [doneFrame()] }],
      { detachable: true },
      [{ frames: [turnF, doneFrame()], ids: ['t9:1-0', 't9:2-0'] }],
    );
    session.submit('mine');
    await session.idle();
    expect(harness.attaches).toHaveLength(1);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['mine', 'mine']);
  });

  // #471 review: the other device's turn must not be recorded as this prompt's answer.
  it("a 409 records the other device's turn on its own, then the prompt with its own turn", async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'sm-')), {
      subject: 'u',
      controlPlaneUrl: 'http://cp',
    });
    const busy = new ApiError('harness', 409, 'turn_in_progress');
    const mineT = { type: 'turn', turnId: 't2', sessionId: 's1' } as const;
    const { session } = await started(
      [
        { error: busy },
        { frames: [mineT, text('mine'), doneFrame()], ids: ['t2:1-0', 't2:2-0', 't2:3-0'] },
      ],
      { detachable: true, transcripts },
      [{ frames: [turnF, text('theirs'), doneFrame()], ids: ['t1:1-0', 't1:2-0', 't1:3-0'] }],
    );
    session.submit('P');
    await session.idle();
    const t = transcripts.load('s1')!;
    expect(
      t.entries.map((e) =>
        e.kind === 'prompt'
          ? `prompt ${e.text}`
          : e.kind === 'turn'
            ? `turn ${e.turnId}`
            : `${e.frame.type}${e.frame.type === 'text' ? ` ${e.frame.delta}` : ''}`,
      ),
    ).toEqual(['turn t1', 'text theirs', 'done', 'prompt P', 'turn t2', 'text mine', 'done']);
    expect(t.prompts).toEqual(['P']);
    expect(t.title).toBe('P');
  });

  it('a 409 resend that is cut mid-turn reads as open-detachable on resume', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'sm-')), {
      subject: 'u',
      controlPlaneUrl: 'http://cp',
    });
    const busy = new ApiError('harness', 409, 'turn_in_progress');
    const mineT = { type: 'turn', turnId: 't2', sessionId: 's1' } as const;
    const { session } = await started(
      [{ error: busy }, { frames: [mineT, text('mine')], ids: ['t2:1-0', 't2:2-0'], hang: true }],
      { detachable: true, transcripts },
      [{ frames: [turnF, doneFrame()], ids: ['t1:1-0', 't1:2-0'] }],
    );
    session.submit('P');
    // The resend's own turn frame is recorded: its stream is being read.
    await expect
      .poll(() =>
        transcripts.load('s1')?.entries.some((e) => e.kind === 'turn' && e.turnId === 't2'),
      )
      .toBe(true);
    session.detach(); // quit with "keep it running"
    await session.idle();
    expect(lastTurnState(transcripts.load('s1')!)).toBe('open-detachable');
  });

  it.each([
    ['a refusal', [{ error: new ApiError('harness', 400, 'bad_request', 'no') }]],
    [
      'too many 409s',
      Array.from({ length: 4 }, () => ({ error: harnessError(409, 'turn_in_progress') })),
    ],
  ])('a prompt that never ran is still recorded after %s', async (_how, steps) => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'sm-')), {
      subject: 'u',
      controlPlaneUrl: 'http://cp',
    });
    const other = { frames: [turnF, doneFrame()], ids: ['t1:1-0', 't1:2-0'] };
    const { session } = await started(steps, { detachable: true, transcripts }, [
      other,
      other,
      other,
    ]);
    session.submit('P');
    await session.idle();
    expect(transcripts.load('s1')!.prompts).toEqual(['P']);
  });

  it('a non-detachable session fails a 409 turn_in_progress turn: no attach, no cancel', async () => {
    const busy = new ApiError('harness', 409, 'turn_in_progress');
    const { session, harness, ends } = await started([{ error: busy }]);
    session.submit('mine');
    await session.idle();
    session.cancel();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'error', error: busy }]);
    expect(harness.attaches).toEqual([]);
    expect(harness.cancels).toEqual([]);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['mine']);
  });

  it.each([
    ['ends', undefined],
    ['errors', new ApiError('harness', 0, 'network_error', 'x')],
  ])(
    'an attach job whose stream %s after frames, then re-attaches into turn_not_found, ends with one error turn-end',
    async (_how, error) => {
      const { session, events, ends } = await started([], { detachable: true }, [
        { frames: [turnF, text('a')], ids: ['t1:1-0', 't1:2-0'], error },
        // the re-attach: the fake's empty attach queue answers turn_not_found
      ]);
      session.attachExisting({ expectOpen: true });
      await session.idle();
      expect(ends()).toMatchObject([{ outcome: 'error', error: { code: 'turn_not_found' } }]);
      expect(events.filter((e) => e.kind === 'attach-none')).toEqual([]);
    },
  );

  it('an attach job remints once on a rejected token and retries', async () => {
    const { session, cp, harness, ends } = await started([], { detachable: true }, [
      { error: new ApiError('harness', 401, 'token_expired') },
      { frames: [turnF, doneFrame()], ids: ['t1:1-0', 't1:2-0'] },
    ]);
    session.attachExisting({ expectOpen: true });
    await session.idle();
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(2); // resume + remint
    expect(harness.attaches).toHaveLength(2);
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('a re-attach remints once on a rejected token and retries', async () => {
    const { session, cp, harness, ends, slept } = await started(
      [{ frames: [turnF], ids: ['t1:1-0'] }],
      { detachable: true },
      [
        { error: new ApiError('harness', 401, 'token_invalid') },
        { frames: [turnF, doneFrame()], ids: ['t1:1-0', 't1:2-0'] },
      ],
    );
    session.submit('go');
    await session.idle();
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(2);
    expect(harness.attaches).toHaveLength(2);
    expect(slept).toEqual([500]); // the remint is not a re-attach try
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('a double Esc sends one server-side cancel, and both share its answer', async () => {
    const { session, harness } = await started([{ frames: [turnF], ids: ['t1:1-0'], hang: true }], {
      detachable: true,
    });
    let answer!: () => void;
    let calls = 0;
    harness.cancelTurn = () => {
      calls++;
      return new Promise<void>((r) => (answer = r));
    };
    session.submit('go');
    await tick();
    const first = session.cancelRemote();
    session.cancel();
    const second = session.cancelRemote();
    await tick();
    expect(calls).toBe(1);
    answer();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // Once settled, a later cancel is sent afresh.
    void session.cancelRemote();
    await tick();
    expect(calls).toBe(2);
    answer();
    session.detach();
    await session.idle();
  });

  it('detach stops reading without cancelling on the server', async () => {
    const { session, harness } = await started([{ frames: [turnF], ids: ['t1:1-0'], hang: true }], {
      detachable: true,
    });
    session.submit('go');
    await tick();
    session.detach();
    await session.idle();
    expect(harness.cancels).toEqual([]);
  });
});
