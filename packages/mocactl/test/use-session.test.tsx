import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { SessionManager, type ActiveSession } from '../src/core/session-manager.js';
import {
  EMPTY_BLOCKS,
  INTERRUPTED_TURN_NOTICE,
  fromTranscript,
  splitStatic,
} from '../src/render/blocks.js';
import { COALESCE_MS, useSession, type SessionView } from '../src/views/useSession.js';
import { doneFrame, fakeControlPlane, fakeHarness, type HarnessStep } from './helpers/fakes.js';
import { tick, waitFor } from './helpers/ink.js';

let clock = 0;
const now = () => clock;

async function mount(steps: HarnessStep[]) {
  clock = 0; // isolate each test's TTFT/retry-timing math from whatever a prior test left it at
  const manager = new SessionManager({
    cp: fakeControlPlane(),
    harness: fakeHarness(steps),
    now,
    sleep: async () => undefined,
    cancelPauseMs: 0, // the double-Esc window is the session's concern, tested there
  });
  const session = await manager.resume('s1');
  const view: { current?: SessionView } = {};
  function Probe({ s }: { s: ActiveSession }) {
    view.current = useSession(s, { initial: EMPTY_BLOCKS, now });
    return <Text>{view.current.turn.phase}</Text>;
  }
  render(<Probe s={session} />);
  await tick();
  return view as { current: SessionView };
}

// What the view shows, turn-ends tagged with their outcome.
const kindsOf = (v: { current: SessionView }) =>
  v.current.state.blocks.map((b) => (b.kind === 'turn-end' ? `end:${b.outcome}` : b.kind));

describe('useSession', () => {
  it('turns a streamed turn into blocks, coalescing deltas, records usage, and computes TTFT', async () => {
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
    const deltas = Array.from({ length: 50 }, (_, i) => ({
      type: 'text' as const,
      delta: String(i % 10),
    }));
    // Holds the fake stream open right after turn-start so the test can advance the clock before
    // the first frame arrives, making lastTtftMs an assertable, non-zero value instead of just
    // "defined".
    let resolveWait!: () => void;
    const waited = new Promise<void>((r) => (resolveWait = r));
    const view = await mount([
      { wait: () => waited, frames: [...deltas, { ...doneFrame(), usage }] },
    ]);
    view.current.submit('hi');
    await tick(5); // turn-start has fired; the stream is blocked on `waited`, before any frame
    expect(view.current.turn.phase).toBe('waiting');
    clock += 1500;
    resolveWait();
    await waitFor(() => view.current.turn.phase === 'idle');
    const blocks = view.current.state.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'turn-end']);
    expect((blocks[1] as { text: string }).text).toBe('0123456789'.repeat(5));
    expect(view.current.turn.phase).toBe('idle');
    expect(view.current.turn.lastTtftMs).toBe(1500);
    expect(view.current.usage).toMatchObject({ input: 10, output: 5 });
    expect(view.current.lastReply()).toBe('0123456789'.repeat(5));
  });

  it('buffers text deltas until the COALESCE_MS interval flushes them, not immediately or only at turn-end', async () => {
    // Fake timers make the "before COALESCE_MS elapses" assertion deterministic instead of racing
    // the hook's real setInterval(flush, COALESCE_MS) against this test's own real-timer wait —
    // under full-suite load that race flaked (both are real macrotask timers, and scheduling
    // jitter can perturb their relative firing order). Enabled BEFORE mounting — not via the
    // shared mount() helper, whose own setup awaits a real tick() that would hang once faked —
    // so the effect's setInterval call itself is captured as a fake timer from the start.
    vi.useFakeTimers();
    try {
      clock = 0;
      const manager = new SessionManager({
        cp: fakeControlPlane(),
        harness: fakeHarness([
          {
            frames: [
              { type: 'text', delta: 'a' },
              { type: 'text', delta: 'b' },
            ],
            hang: true,
          },
        ]),
        now,
        sleep: async () => undefined,
      });
      const session = await manager.resume('s1');
      const view: { current?: SessionView } = {};
      function Probe({ s }: { s: ActiveSession }) {
        view.current = useSession(s, { initial: EMPTY_BLOCKS, now });
        return <Text>{view.current.turn.phase}</Text>;
      }
      render(<Probe s={session} />);
      await vi.advanceTimersByTimeAsync(0); // let the mount effect run and register the interval
      const v = view as { current: SessionView };

      v.current.submit('hi');
      // Let the fake stream's frames flow through (that chain runs on microtasks, not timers)
      // without letting the 40ms COALESCE_MS interval fire.
      await vi.advanceTimersByTimeAsync(0);
      expect(v.current.state.blocks.some((b) => b.kind === 'assistant')).toBe(false);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      // The interval's setState() call lands during the advance above, but React's own re-render
      // (which updates view.current) needs one more microtask/macrotask turn to commit — an extra
      // 0ms advance, rather than a bigger window, makes that turn explicit instead of coincidental.
      await vi.advanceTimersByTimeAsync(0);
      expect(v.current.lastReply()).toBe('ab');
      expect(v.current.state.blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
      v.current.cancel();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a prompt submitted mid-turn as queued, then sends it after a cancel', async () => {
    const view = await mount([{ frames: [{ type: 'text', delta: 'working' }], hang: true }]);
    view.current.submit('a');
    await waitFor(() => view.current.turn.phase === 'streaming');
    view.current.submit('b');
    await tick();
    expect(view.current.state.blocks.at(-1)).toMatchObject({
      kind: 'user',
      text: 'b',
      queued: true,
    });
    expect(view.current.turn.queued).toBe(1);
    view.current.cancel();
    await waitFor(() => kindsOf(view).includes('end:done'));
    expect(kindsOf(view)).toEqual(['user', 'assistant', 'end:cancelled', 'user', 'end:done']);
    expect(view.current.state.blocks[3]).toMatchObject({ queued: false });
  });

  it('resend runs a prompt again without adding a second user block', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const view = await mount([
      { error: new ApiError('control-plane', 401, 'token_expired') },
      { frames: [{ type: 'text', delta: 'ok' }, doneFrame()] },
    ]);
    view.current.submit('a');
    await waitFor(() => kindsOf(view).includes('end:error'));
    view.current.resend('a');
    await waitFor(() => kindsOf(view).includes('end:done'));
    expect(kindsOf(view)).toEqual(['user', 'end:error', 'assistant', 'end:done']);
  });

  it('clearQueue drops queued prompts from the transcript', async () => {
    const view = await mount([{ hang: true }]);
    view.current.submit('a');
    await tick();
    view.current.submit('b');
    await tick();
    view.current.clearQueue();
    view.current.cancel();
    await waitFor(() => kindsOf(view).includes('end:cancelled'));
    expect(
      view.current.state.blocks
        .filter((b) => b.kind === 'user')
        .map((b) => (b as { text: string }).text),
    ).toEqual(['a']);
  });

  it('shows a transport failure as an error turn-end', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const view = await mount([
      { error: new ApiError('harness', 0, 'network_error', 'ECONNRESET') },
    ]);
    view.current.submit('a');
    await waitFor(() => kindsOf(view).includes('end:error'));
    expect(view.current.state.blocks.at(-1)).toMatchObject({
      kind: 'turn-end',
      outcome: 'error',
      message: 'cannot reach the harness: ECONNRESET',
    });
  });
});

describe('useSession on resume', () => {
  it('shows the interrupted notice when an expected turn could not be attached', async () => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness([]), // no attach steps: attach answers turn_not_found
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial: EMPTY_BLOCKS, now });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    session.attachExisting({ expectOpen: true });
    await waitFor(() => view.current!.state.blocks.length === 1);
    expect(view.current!.state.blocks[0]).toMatchObject({
      kind: 'notice',
      text: INTERRUPTED_TURN_NOTICE,
    });
    expect(view.current!.turn.phase).toBe('idle');
  });

  // I1: a resumed open detachable turn stays open until the attach step says how it stands.
  const openMidTool = () =>
    fromTranscript({
      sessionId: 's1',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'go' },
        { kind: 'turn', turnId: 't1' },
        { kind: 'frame', frame: { type: 'text', delta: 'half' } },
        { kind: 'frame', frame: { type: 'tool_use', id: 'x1', name: 'bash', args: {} } },
        { kind: 'frame', frame: { type: 'text', delta: 'more' } },
      ],
      prompts: ['go'],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    });

  it.each([
    [
      'nothing to attach',
      [] as HarnessStep[],
      ['user', 'assistant', 'tool', 'assistant', 'notice'],
    ],
    [
      'an attach error',
      [{ error: new ApiError('harness', 500, 'internal') }] as HarnessStep[],
      ['user', 'assistant', 'tool', 'assistant', 'end:error'],
    ],
  ])('settles the resumed open turn after %s', async (_how, attachSteps, kinds) => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness([], {}, attachSteps),
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const initial = openMidTool();
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial, now });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    expect(view.current!.state.blocks[3]).toMatchObject({ kind: 'assistant', final: false });
    session.attachExisting({ expectOpen: true });
    await session.idle();
    const v = view as { current: SessionView };
    await waitFor(() => kindsOf(v).length === kinds.length);
    expect(kindsOf(v)).toEqual(kinds);
    expect(v.current.state.blocks[2]).toMatchObject({
      result: { isError: true, preview: 'interrupted' },
    });
    expect(v.current.state.blocks[3]).toMatchObject({ final: true });
  });

  // #483 scope 1, the two-device case. Device A quits mid-tool with "keep" on t1, device B then
  // runs t2, and A resumes: the attach replays the session's LATEST turn (t2), not the rest of t1.
  it("renders another device's newer turn as its own, settling the turn this device left open", async () => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness([], {}, [
        {
          frames: [
            { type: 'turn', turnId: 't2', sessionId: 's1' },
            { type: 'text', delta: 'T2 REPLY' },
            doneFrame(),
          ],
          ids: ['t2:1-0', 't2:2-0', 't2:3-0'],
        },
      ]),
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const initial = openMidTool();
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial, now, openTurnId: 't1' });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    session.attachExisting({ lastEventId: 't1:4-0', expectOpen: true });
    await session.idle();
    const v = view as { current: SessionView };
    await waitFor(() => kindsOf(v).includes('end:done'));
    expect(kindsOf(v)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'notice',
      'assistant',
      'end:done',
    ]);
    // t1 is settled: its reply final, its result-less tool interrupted.
    expect(v.current.state.blocks[2]).toMatchObject({
      result: { isError: true, preview: 'interrupted' },
    });
    expect(v.current.state.blocks[3]).toMatchObject({ text: 'more', final: true });
    // t2's text is its own block, not appended into t1's (the bug).
    expect(v.current.state.blocks[5]).toMatchObject({ text: 'T2 REPLY' });
    // Nothing of either turn stays pinned in the live area.
    expect(splitStatic(v.current.state.blocks).live).toEqual([]);
  });

  // #483 scope 1, the single-device case the #481 I1 fix added: the catch-up continues OUR turn,
  // so it must still land in the open blocks -- one tool with its real result, one reply.
  it("continues this device's own turn in place when the catch-up replays it", async () => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness([], {}, [
        {
          frames: [
            { type: 'turn', turnId: 't1', sessionId: 's1' },
            { type: 'tool_result', id: 'x1', isError: false, preview: 'ok' },
            { type: 'text', delta: ' and done' },
            doneFrame(),
          ],
          ids: ['t1:5-0', 't1:6-0', 't1:7-0', 't1:8-0'],
        },
      ]),
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const initial = openMidTool();
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial, now, openTurnId: 't1' });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    session.attachExisting({ lastEventId: 't1:4-0', expectOpen: true });
    await session.idle();
    const v = view as { current: SessionView };
    await waitFor(() => kindsOf(v).includes('end:done'));
    expect(kindsOf(v)).toEqual(['user', 'assistant', 'tool', 'assistant', 'end:done']);
    expect(v.current.state.blocks.some((b) => b.kind === 'notice')).toBe(false);
    expect(v.current.state.blocks[2]).toMatchObject({
      result: { isError: false, preview: 'ok' },
    });
    expect(v.current.state.blocks[3]).toMatchObject({ text: 'more and done', final: true });
  });

  // #483 scope 2: a same-turn catch-up that ends on a terminal while a tool still has no result
  // (`restarting`, `owner_lost`, `cancelled` mid-tool). The resume-time interrupted marking does
  // not run for an open-detachable turn, so that tool stayed unsettled and pinned the live area.
  it.each([
    ['owner_lost', 'end:error'],
    ['restarting', 'end:error'],
    ['cancelled', 'end:cancelled'],
  ])('marks a still-open tool interrupted when the catch-up ends %s', async (reason, end) => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness([], {}, [
        {
          frames: [
            { type: 'turn', turnId: 't1', sessionId: 's1' },
            { type: 'tool_use', id: 'x2', name: 'bash', args: {} },
            {
              type: 'error',
              sessionId: 's1',
              stopReason: 'aborted',
              abortReason: reason as 'owner_lost' | 'restarting' | 'cancelled',
            },
          ],
          ids: ['t1:5-0', 't1:6-0', 't1:7-0'],
        },
      ]),
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const initial = openMidTool();
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial, now, openTurnId: 't1' });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    session.attachExisting({ lastEventId: 't1:4-0', expectOpen: true });
    await session.idle();
    const v = view as { current: SessionView };
    await waitFor(() => kindsOf(v).includes(end));
    // Both tools of the turn are settled: the one the transcript held and the one the catch-up
    // opened before the terminal cut it off.
    const tools = v.current.state.blocks.filter((b) => b.kind === 'tool');
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t).toMatchObject({ result: { preview: 'interrupted' } });
    expect(splitStatic(v.current.state.blocks).live).toEqual([]);
  });

  // #483 review: the open-turn ref outlives the turn it describes. An `attach-none` settles the
  // resumed turn in the blocks but used to leave the ref naming it, so the NEXT turn this device
  // ran was compared against it and labelled another device's. The repro the reviewer gave:
  // resume an open turn the server no longer has, take the notice's advice and say "go on".
  it("does not label this device's next turn as another's after an attach found nothing", async () => {
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness: fakeHarness(
        [
          {
            frames: [
              { type: 'turn', turnId: 't2', sessionId: 's1' },
              { type: 'text', delta: 'carrying on' },
              doneFrame(),
            ],
          },
        ],
        {},
        [],
      ),
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const initial = openMidTool();
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial, now, openTurnId: 't1' });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    session.attachExisting({ expectOpen: true });
    await session.idle();
    const v = view as { current: SessionView };
    await waitFor(() => kindsOf(v).includes('notice'));
    v.current.submit('go on');
    await session.idle();
    await waitFor(() => kindsOf(v).includes('end:done'));
    expect(kindsOf(v)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'notice', // the interrupted-turn notice, the only one of this session
      'user',
      'assistant',
      'end:done',
    ]);
    expect(v.current.state.blocks.filter((b) => b.kind === 'notice')).toHaveLength(1);
    expect(v.current.state.blocks[6]).toMatchObject({ text: 'carrying on' });
  });

  // The same stale ref, reached by the other path: a turn that ends with no terminal frame, as a
  // dropped stream does. turn-end settles the blocks, so the ref must stop naming that turn too.
  it("does not label this device's next turn as another's after one ended without a terminal", async () => {
    const view = await mount([
      {
        frames: [
          { type: 'turn', turnId: 't1', sessionId: 's1' },
          { type: 'text', delta: 'cut off' },
        ],
        error: new ApiError('harness', 0, 'network_error', 'dropped'),
      },
      {
        frames: [
          { type: 'turn', turnId: 't2', sessionId: 's1' },
          { type: 'text', delta: 'second' },
          doneFrame(),
        ],
      },
    ]);
    view.current.submit('first');
    await waitFor(() => kindsOf(view).includes('end:error'));
    view.current.submit('second');
    await waitFor(() => kindsOf(view).includes('end:done'));
    expect(kindsOf(view)).toEqual([
      'user',
      'assistant',
      'end:error',
      'user',
      'assistant',
      'end:done',
    ]);
    expect(view.current.state.blocks.some((b) => b.kind === 'notice')).toBe(false);
  });

  it('shows a failed server-side cancel as an error notice', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const harness = fakeHarness([
      {
        frames: [{ type: 'turn', turnId: 't1', sessionId: 's1' }],
        ids: ['t1:1-0'],
        hang: true,
      },
    ]);
    harness.cancelTurn = async () => {
      throw new ApiError('harness', 0, 'network_error', 'down');
    };
    const manager = new SessionManager({
      cp: fakeControlPlane(),
      harness,
      now,
      sleep: async () => undefined,
      cancelPauseMs: 0,
      detachable: true,
    });
    const session = await manager.resume('s1');
    const view: { current?: SessionView } = {};
    function Probe({ s }: { s: ActiveSession }) {
      view.current = useSession(s, { initial: EMPTY_BLOCKS, now });
      return <Text>{view.current.turn.phase}</Text>;
    }
    render(<Probe s={session} />);
    await tick();
    view.current!.submit('go');
    await tick(5);
    view.current!.cancel();
    await waitFor(() => view.current!.state.blocks.some((b) => b.kind === 'notice'));
    expect(view.current!.state.blocks.find((b) => b.kind === 'notice')).toMatchObject({
      text: "couldn't cancel — the turn keeps running",
      tone: 'error',
    });
    session.detach();
    await session.idle();
  });
});
