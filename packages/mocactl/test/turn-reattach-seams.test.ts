// The seams between the detachable-turn tasks (#471 final review): resume, Esc, and restart flows
// end to end, through the real HarnessClient where the wire bytes matter.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiscoveringHarness } from '../src/api/discovery.js';
import { ApiError } from '../src/api/errors.js';
import type { TurnFrame } from '../src/api/frames.js';
import { HarnessClient } from '../src/api/harness.js';
import {
  ActiveSession,
  BLIND_CANCEL_RETRY_MS,
  BLIND_CANCEL_TRIES,
  LOST_TURN_MESSAGE,
  PENDING_CANCEL_MS,
  type SessionDeps,
  type SessionEvent,
} from '../src/core/session-manager.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { doneFrame, fakeControlPlane, fakeHarness, type HarnessStep } from './helpers/fakes.js';

const NOW = 1_000_000_000; // ms

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

function session(fetchImpl: typeof fetch) {
  const slept: number[] = [];
  const s = new ActiveSession(
    {
      cp: fakeControlPlane(),
      harness: new HarnessClient('http://h', fetchImpl),
      now: () => NOW,
      sleep: async (ms) => void slept.push(ms),
      detachable: true,
    },
    's1',
    { token: 'st', expiresAt: 4_000_000_000 },
  );
  const events: SessionEvent[] = [];
  s.on((e) => events.push(e));
  return { session: s, slept, events, ends: () => events.filter((e) => e.kind === 'turn-end') };
}

describe('C1: resume after a finished turn', () => {
  it('a cursor at the terminal ends at once: attach-none, no re-attach, no error', async () => {
    // What GET /v1/turn sends when Last-Event-ID is the terminal's id: an ended turn frame, then EOF.
    const body =
      'id: t1:5-0\nevent: turn\ndata: {"type":"turn","turnId":"t1","sessionId":"s1","ended":true}\n\n';
    let calls = 0;
    const {
      session: s,
      slept,
      events,
      ends,
    } = session((async () => {
      calls++;
      return sse(body);
    }) as unknown as typeof fetch);
    const t0 = Date.now();
    s.attachExisting({ lastEventId: 't1:5-0', expectOpen: false });
    await s.idle();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(events).toContainEqual({ kind: 'attach-none', missed: false });
    expect(ends()).toEqual([]);
    expect(s.runningDetachable).toBe(false);
  });

  it('records no second turn in the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seams-'));
    const owner = { subject: 'u', controlPlaneUrl: 'http://cp' };
    const before = new TranscriptStore(dir, owner);
    before.appendPrompt('s1', 'go');
    before.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    before.appendFrame('s1', { type: 'done', sessionId: 's1', stopReason: 'stop' }, 't1:5-0');
    // A fresh process resumes: it loads the transcript, then attaches from its last id.
    const transcripts = new TranscriptStore(dir, owner);
    const t = transcripts.load('s1')!;
    const body =
      'id: t1:5-0\nevent: turn\ndata: {"type":"turn","turnId":"t1","sessionId":"s1","ended":true}\n\n';
    const s = new ActiveSession(
      {
        cp: fakeControlPlane(),
        harness: new HarnessClient('http://h', (async () => sse(body)) as unknown as typeof fetch),
        transcripts,
        now: () => NOW,
        sleep: async () => undefined,
        detachable: true,
      },
      's1',
      { token: 'st', expiresAt: 4_000_000_000 },
    );
    s.attachExisting({ lastEventId: t.lastEventId, expectOpen: false });
    await s.idle();
    const turns = readFileSync(join(dir, 's1.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"kind":"turn"'));
    expect(turns).toHaveLength(1);
  });
});

const turnF = (turnId = 't1') => ({ type: 'turn', turnId, sessionId: 's1' }) as const;
const text = (delta: string) => ({ type: 'text', delta }) as const;
const cancelledF: TurnFrame = {
  type: 'error',
  sessionId: 's1',
  stopReason: 'aborted',
  abortReason: 'cancelled',
  errorMessage: 'cancelled',
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, wait: () => opened };
};

function faked(
  steps: HarnessStep[],
  over: Partial<SessionDeps> = {},
  attachSteps: HarnessStep[] = [],
) {
  const harness = fakeHarness(steps, {}, attachSteps);
  const s = new ActiveSession(
    {
      cp: fakeControlPlane(),
      harness,
      now: () => NOW,
      sleep: async () => undefined,
      detachable: true,
      cancelPauseMs: 0,
      ...over,
    },
    's1',
    { token: 'st', expiresAt: 4_000_000_000 },
  );
  const events: SessionEvent[] = [];
  s.on((e) => events.push(e));
  return {
    session: s,
    harness,
    events,
    ends: () => events.filter((e) => e.kind === 'turn-end'),
  };
}

describe('I2: Esc before the turn frame', () => {
  it('a detachable turn is pending from the request, so leaving asks', async () => {
    const g = gate();
    const { session: s } = faked([{ wait: g.wait, frames: [turnF(), doneFrame()] }]);
    s.submit('go');
    await tick();
    expect(s.runningDetachable).toBe(true);
    g.open();
    await s.idle();
  });

  it('Esc, then the turn frame: exactly one server-side cancel, and the turn ends cancelled', async () => {
    const g = gate();
    const {
      session: s,
      harness,
      ends,
    } = faked(
      [{ wait: g.wait, frames: [turnF()], ids: ['t1:1-0'] }],
      {},
      // The stream ends after the turn frame; the re-attach reads the cancel's terminal.
      [{ frames: [turnF(), cancelledF], ids: ['t1:1-0', 't1:2-0'] }],
    );
    s.submit('go');
    await tick();
    s.cancel();
    await tick();
    expect(harness.turns[0]!.signal!.aborted).toBe(false); // still reading
    expect(harness.cancels).toEqual([]);
    g.open();
    await s.idle();
    await tick();
    expect(harness.cancels.map((c) => c.turnId)).toEqual(['t1']);
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it('Esc when the first frame is plain text (no detachable turn): the fetch is aborted', async () => {
    const g = gate();
    const {
      session: s,
      harness,
      ends,
    } = faked([{ wait: g.wait, frames: [text('a'), doneFrame()] }]);
    s.submit('go');
    await tick();
    s.cancel();
    g.open();
    await s.idle();
    expect(harness.turns[0]!.signal!.aborted).toBe(true);
    expect(harness.cancels).toEqual([]);
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  // #471 review: the server may hold the turn's lease before it writes the turn frame, and closing a
  // detachable request detaches the turn rather than cancelling it. So the deadline aborts the
  // fetch AND cancels the session's running turn on the server, by session (no turnId yet).
  it('Esc with no frame for the deadline: the fetch is aborted, not before, then a turnId-less cancel', async () => {
    const { session: s, harness, ends } = faked([{ hang: true }], { pendingCancelMs: 60 });
    s.submit('go');
    await tick();
    s.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.turns[0]!.signal!.aborted).toBe(false);
    expect(harness.cancels).toEqual([]);
    await s.idle();
    expect(harness.turns[0]!.signal!.aborted).toBe(true);
    expect(harness.cancels).toHaveLength(1);
    expect(harness.cancels[0]).toMatchObject({ sessionId: 's1', token: 'st' });
    expect('turnId' in harness.cancels[0]! && harness.cancels[0]!.turnId).toBeFalsy();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  const notFound = () => new ApiError('harness', 404, 'turn_not_found');

  it('the turnId-less cancel retries turn_not_found (it can land before begin), then resolves true', async () => {
    const slept: number[] = [];
    const {
      session: s,
      harness,
      events,
    } = faked([{ hang: true }], {
      pendingCancelMs: 10,
      sleep: async (ms) => void slept.push(ms),
    });
    let calls = 0;
    harness.cancelTurn = async (args) => {
      harness.cancels.push(args);
      if (++calls < 3) throw notFound();
    };
    s.submit('go');
    await tick();
    expect(await s.cancelRemote()).toBe(true);
    await s.idle();
    expect(harness.cancels).toHaveLength(3);
    expect(slept).toEqual([BLIND_CANCEL_RETRY_MS, BLIND_CANCEL_RETRY_MS]);
    expect(events.filter((e) => e.kind === 'notice')).toEqual([]);
  });

  it("when every try finds no turn (an old or Knative harness), it reports it couldn't cancel", async () => {
    const { session: s, harness, events } = faked([{ hang: true }], { pendingCancelMs: 10 });
    harness.cancelTurn = async (args) => {
      harness.cancels.push(args);
      throw notFound();
    };
    s.submit('go');
    await tick();
    expect(await s.cancelRemote()).toBe(false);
    await s.idle();
    expect(harness.cancels).toHaveLength(BLIND_CANCEL_TRIES);
    expect(events).toContainEqual({
      kind: 'notice',
      text: "couldn't cancel — the turn keeps running",
      tone: 'error',
    });
  });

  it('3 tries over about 3 s', () => {
    expect(BLIND_CANCEL_TRIES).toBe(3);
    expect((BLIND_CANCEL_TRIES - 1) * BLIND_CANCEL_RETRY_MS).toBe(3000);
  });

  it('a cancel failure other than turn_not_found is not retried', async () => {
    const { session: s, harness } = faked([{ hang: true }], { pendingCancelMs: 10 });
    harness.cancelTurn = async (args) => {
      harness.cancels.push(args);
      throw new ApiError('harness', 0, 'network_error', 'down');
    };
    s.submit('go');
    await tick();
    expect(await s.cancelRemote()).toBe(false);
    await s.idle();
    expect(harness.cancels).toHaveLength(1);
  });

  it('the next queued prompt waits for the turnId-less cancel to settle, so it cannot hit it', async () => {
    const g = gate();
    const { session: s, harness } = faked([{ hang: true }, { frames: [doneFrame()] }], {
      pendingCancelMs: 10,
    });
    harness.cancelTurn = async (args) => {
      harness.cancels.push(args);
      await g.wait();
    };
    s.submit('a');
    s.submit('b');
    await tick();
    s.cancel();
    await expect.poll(() => harness.cancels.length).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
    g.open();
    await s.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
  });

  it('a prompt submitted after the cancelled turn ended also waits for that cancel', async () => {
    const g = gate();
    const { session: s, harness } = faked([{ hang: true }, { frames: [doneFrame()] }], {
      pendingCancelMs: 10,
    });
    harness.cancelTurn = async (args) => {
      harness.cancels.push(args);
      await g.wait();
    };
    s.submit('a');
    await tick();
    s.cancel();
    await expect.poll(() => harness.cancels.length).toBe(1);
    await s.idle(); // 'a' ended cancelled; its cancel is still out
    s.submit('b');
    await new Promise((r) => setTimeout(r, 30));
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
    g.open();
    await s.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
  });

  it('waits 2 s by default', () => {
    expect(PENDING_CANCEL_MS).toBe(2000);
  });

  it("the overlay's cancel while pending resolves once the turn frame's cancel is sent", async () => {
    const g = gate();
    const { session: s, harness } = faked([
      { wait: g.wait, frames: [turnF()], ids: ['t1:1-0'], hang: true },
    ]);
    s.submit('go');
    await tick();
    const cancelled = s.cancelRemote();
    g.open();
    expect(await cancelled).toBe(true);
    expect(harness.cancels.map((c) => c.turnId)).toEqual(['t1']);
    s.detach();
    await s.idle();
  });

  it('a refusal before any frame still ends the turn with its error', async () => {
    const g = gate();
    const refused = new ApiError('harness', 400, 'bad_request', 'no');
    const { session: s, harness, ends } = faked([{ wait: g.wait, error: refused }]);
    s.submit('go');
    await tick();
    s.cancel();
    g.open();
    await s.idle();
    expect(harness.cancels).toEqual([]);
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'error', error: refused }]);
  });
});

describe("I3: Esc during a 409's attach", () => {
  const busy = () => new ApiError('harness', 409, 'turn_in_progress');

  it("stops following the other device's turn, cancels nothing, and withdraws the prompt", async () => {
    const {
      session: s,
      harness,
      ends,
    } = faked([{ error: busy() }, { frames: [doneFrame()] }], {}, [
      { frames: [turnF('other')], ids: ['other:1-0'], hang: true },
    ]);
    s.submit('mine');
    await expect.poll(() => s.runningDetachable && harness.attaches.length === 1).toBe(true);
    s.cancel();
    await s.idle();
    expect(harness.cancels).toEqual([]);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['mine']); // no resend
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it("the leave overlay's cancel detaches the same way", async () => {
    const { session: s, harness } = faked([{ error: busy() }, { frames: [doneFrame()] }], {}, [
      { frames: [turnF('other')], ids: ['other:1-0'], hang: true },
    ]);
    s.submit('mine');
    await expect.poll(() => s.runningDetachable && harness.attaches.length === 1).toBe(true);
    expect(await s.cancelRemote()).toBe(true);
    await s.idle();
    expect(harness.cancels).toEqual([]);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['mine']);
  });
});

describe('M2: a failed resume attach when nothing was running', () => {
  it.each([
    ['a network error', new ApiError('harness', 0, 'network_error', 'down')],
    ['a 503', new ApiError('harness', 503, 'redis_unavailable', undefined, 1)],
  ])('%s shows no error', async (_how, error) => {
    const { session: s, events, ends } = faked([], {}, [{ error }]);
    s.attachExisting({ expectOpen: false });
    await s.idle();
    expect(events).toContainEqual({ kind: 'attach-none', missed: false });
    expect(ends()).toEqual([]);
  });

  it('still reports one when a turn was expected', async () => {
    const error = new ApiError('harness', 0, 'network_error', 'down');
    const { session: s, ends } = faked([], {}, [{ error }]);
    s.attachExisting({ expectOpen: true });
    await s.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'error', error }]);
  });
});

describe('M4: the cancel bound aborts the request', () => {
  it('cancelRemote aborts the cancel call it gave up on', async () => {
    const { session: s, harness } = faked([{ frames: [turnF()], ids: ['t1:1-0'], hang: true }], {
      cancelTimeoutMs: 20,
    });
    let signal: AbortSignal | undefined;
    harness.cancelTurn = (args) => {
      signal = args.signal;
      return new Promise<void>(() => undefined);
    };
    s.submit('go');
    await tick();
    expect(await s.cancelRemote()).toBe(false);
    expect(signal?.aborted).toBe(true);
    s.detach();
    await s.idle();
  });

  it('HarnessClient.cancelTurn hands the signal to fetch, through DiscoveringHarness', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('{"turnId":"t1"}', { status: 202 });
    }) as unknown as typeof fetch;
    const c = new AbortController();
    await new DiscoveringHarness(async () => 'http://h', fetchImpl).cancelTurn({
      sessionId: 's1',
      turnId: 't1',
      token: 'st',
      signal: c.signal,
    });
    expect(seen).toBe(c.signal);
  });
});

describe('ledger minors', () => {
  it("a cancel still in flight for turn A does not stand in for turn B's", async () => {
    const { session: s, harness } = faked([
      { frames: [turnF('tA')], ids: ['tA:1-0'], hang: true },
      { frames: [turnF('tB')], ids: ['tB:1-0'], hang: true },
    ]);
    const sent: string[] = [];
    harness.cancelTurn = (args) => {
      sent.push(args.turnId!);
      return new Promise<void>(() => undefined); // never answers within the window
    };
    s.submit('a');
    await tick();
    void s.cancelRemote();
    await tick();
    s.detach(); // A ends while its cancel is in flight
    await s.idle();
    s.submit('b');
    await tick();
    s.cancel();
    await tick();
    expect(sent).toEqual(['tA', 'tB']);
    s.detach();
    await s.idle();
  });

  it('an attach that loses the turn after frames says so in words, not as a code', async () => {
    const { session: s, ends } = faked([], {}, [
      { frames: [turnF(), text('a')], ids: ['t1:1-0', 't1:2-0'] },
    ]);
    s.attachExisting({ expectOpen: true });
    await s.idle();
    expect(ends()).toMatchObject([
      { outcome: 'error', error: { code: 'turn_not_found', message: LOST_TURN_MESSAGE } },
    ]);
  });
});
