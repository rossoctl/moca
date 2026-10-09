import { describe, expect, it } from 'vitest';
import type { TurnFrame } from '../src/api/frames.js';
import {
  EMPTY_BLOCKS,
  TRUNCATED_TURN_NOTICE,
  addNotice,
  addUser,
  endTurn,
  fromTranscript,
  lastTurnState,
  markSent,
  reduceFrame,
  splitStatic,
  type BlockState,
} from '../src/render/blocks.js';

const apply = (s: BlockState, ...frames: TurnFrame[]) => frames.reduce(reduceFrame, s);

describe('reduceFrame', () => {
  it('appends text deltas into one assistant block and thinking alongside', () => {
    const s = apply(
      addUser(EMPTY_BLOCKS, 'hi'),
      { type: 'thinking', delta: 'hm' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
    );
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    expect(s.blocks[1]).toMatchObject({ text: 'Hello', thinking: 'hm', final: false });
  });

  it('pairs a tool result with its call and starts a new assistant block afterwards', () => {
    const s = apply(
      EMPTY_BLOCKS,
      { type: 'text', delta: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'bash', args: { command: 'ls' } },
      { type: 'tool_result', id: 't1', isError: false, preview: 'a.ts' },
      { type: 'text', delta: 'Found it.' },
    );
    expect(s.blocks.map((b) => b.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(s.blocks[0]).toMatchObject({ final: true });
    expect(s.blocks[1]).toMatchObject({
      name: 'bash',
      result: { isError: false, preview: 'a.ts' },
    });
  });

  it('done finalizes the reply and records usage', () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 };
    const s = apply(
      EMPTY_BLOCKS,
      { type: 'text', delta: 'ok' },
      { type: 'done', sessionId: 's', stopReason: 'end_turn', usage },
    );
    expect(s.blocks.map((b) => b.kind)).toEqual(['assistant', 'turn-end']);
    expect(s.blocks[0]).toMatchObject({ final: true });
    expect(s.blocks[1]).toMatchObject({ outcome: 'done', usage });
  });

  it('an error frame keeps partial text and carries the message', () => {
    const s = apply(
      EMPTY_BLOCKS,
      { type: 'text', delta: 'part' },
      { type: 'error', sessionId: 's', stopReason: 'error', errorMessage: 'boom' },
    );
    expect(s.blocks[0]).toMatchObject({ text: 'part', final: true });
    expect(s.blocks[1]).toMatchObject({ kind: 'turn-end', outcome: 'error', message: 'boom' });
  });

  it('renders an unknown frame as a generic event', () => {
    const s = apply(EMPTY_BLOCKS, { type: 'unknown', event: 'paused', data: { gateId: 3 } });
    expect(s.blocks).toEqual([{ kind: 'event', id: 0, label: 'paused', data: { gateId: 3 } }]);
  });

  it('a tool result with no matching call becomes an event rather than being dropped', () => {
    const s = apply(EMPTY_BLOCKS, { type: 'tool_result', id: 'nope', isError: true, preview: 'x' });
    expect(s.blocks[0]).toMatchObject({ kind: 'event', label: 'tool_result' });
  });

  it('shows a workspace_reset frame as a warning notice naming the old sandbox', () => {
    const s = reduceFrame(EMPTY_BLOCKS, {
      type: 'workspace_reset',
      sessionId: 's',
      from: 'm-0',
      tier: 'microvm',
      reason: 'detached',
    });
    const notice = s.blocks.find((b) => b.kind === 'notice');
    expect(notice).toMatchObject({ kind: 'notice', tone: 'warning' });
    expect((notice as { text: string }).text).toContain("'m-0'");
    expect((notice as { text: string }).text).toContain('microvm');
  });

  it('a workspace_reset with no tier names no tier', () => {
    const s = reduceFrame(EMPTY_BLOCKS, {
      type: 'workspace_reset',
      sessionId: 's',
      from: 'c-0',
      tier: '',
      reason: 'detached',
    });
    const notice = s.blocks.find((b) => b.kind === 'notice') as { text: string };
    expect(notice.text).toBe(
      "workspace reset: sandbox 'c-0' is gone; this turn runs on a fresh workspace",
    );
  });
});

describe('queued prompts', () => {
  it('markSent clears the oldest queued user block', () => {
    let s = addUser(addUser(EMPTY_BLOCKS, 'a', true), 'b', true);
    s = markSent(s);
    expect(s.blocks.map((b) => (b as { queued?: boolean }).queued)).toEqual([false, true]);
  });
});

describe('queued prompt placement', () => {
  it('keeps queued prompts below the running turn as it streams and ends', () => {
    let s = apply(addUser(EMPTY_BLOCKS, 'a'), { type: 'text', delta: 'work' });
    s = addUser(s, 'b', true);
    s = apply(s, { type: 'text', delta: 'ing' });
    s = endTurn(s, 'cancelled');
    expect(s.blocks.map((b) => (b.kind === 'turn-end' ? `end:${b.outcome}` : b.kind))).toEqual([
      'user',
      'assistant',
      'end:cancelled',
      'user',
    ]);
    expect(s.blocks[1]).toMatchObject({ text: 'working', final: true });
    s = markSent(s);
    s = apply(s, { type: 'text', delta: 'reply to b' });
    expect(s.blocks.map((b) => b.kind)).toEqual([
      'user',
      'assistant',
      'turn-end',
      'user',
      'assistant',
    ]);
  });
});

describe('endTurn', () => {
  it('finalizes the open reply and records a cancellation', () => {
    const s = endTurn(apply(EMPTY_BLOCKS, { type: 'text', delta: 'x' }), 'cancelled');
    expect(s.blocks[0]).toMatchObject({ final: true });
    expect(s.blocks[1]).toMatchObject({ kind: 'turn-end', outcome: 'cancelled' });
  });
});

describe('splitStatic', () => {
  it('settles everything up to the first block that can still change', () => {
    const s = apply(
      addUser(EMPTY_BLOCKS, 'q'),
      { type: 'tool_use', id: 't1', name: 'read', args: { path: 'a' } },
      { type: 'tool_result', id: 't1', isError: false, preview: '' },
      { type: 'text', delta: 'streaming' },
    );
    const { settled, live } = splitStatic(s.blocks);
    expect(settled.map((b) => b.kind)).toEqual(['user', 'tool']);
    expect(live.map((b) => b.kind)).toEqual(['assistant']);
  });

  it('keeps a queued prompt live so its marker can clear', () => {
    const { settled, live } = splitStatic(addUser(EMPTY_BLOCKS, 'later', true).blocks);
    expect(settled).toEqual([]);
    expect(live).toHaveLength(1);
  });
});

describe('fromTranscript', () => {
  it('replays prompts and frames into blocks', () => {
    const s = fromTranscript({
      sessionId: 's',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'hi' },
        { kind: 'frame', frame: { type: 'text', delta: 'hello' } },
        { kind: 'frame', frame: { type: 'done', sessionId: 's', stopReason: 'end_turn' } },
      ],
      prompts: ['hi'],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 1 },
    });
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'turn-end']);
    expect(splitStatic(s.blocks).live).toEqual([]);
  });

  it('gives tool blocks without result the interrupted result', () => {
    const s = fromTranscript({
      sessionId: 's',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'go' },
        { kind: 'frame', frame: { type: 'tool_use', id: 't1', name: 'bash', args: {} } },
      ],
      prompts: ['go'],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 1 },
    });
    expect(s.blocks[1]).toMatchObject({
      kind: 'tool',
      result: { isError: true, preview: 'interrupted' },
    });
    expect(splitStatic(s.blocks).live).toEqual([]);
  });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 1 };
  const done = { type: 'done', sessionId: 's', stopReason: 'stop' } as const;

  it('ends with a notice when the last turn never finished', () => {
    const s = fromTranscript({
      sessionId: 's',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'go' },
        { kind: 'frame', frame: { type: 'text', delta: 'working on' } },
      ],
      prompts: ['go'],
      usage,
    });
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'notice']);
    expect(s.blocks[2]).toMatchObject({ tone: 'warning' });
    expect((s.blocks[2] as { text: string }).text).toMatch(/isn't running/);
    expect(splitStatic(s.blocks).live).toEqual([]);
  });

  it('adds no notice when the last turn finished, whatever came before', () => {
    for (const last of [done, { type: 'error', sessionId: 's', stopReason: 'error' } as const]) {
      const s = fromTranscript({
        sessionId: 's',
        createdAt: 0,
        entries: [
          { kind: 'prompt', text: 'first' },
          { kind: 'frame', frame: { type: 'text', delta: 'cut short' } },
          { kind: 'prompt', text: 'go on' },
          { kind: 'frame', frame: last },
        ],
        prompts: ['first', 'go on'],
        usage,
      });
      expect(s.blocks.some((b) => b.kind === 'notice')).toBe(false);
    }
  });

  it('reports the last turn state', () => {
    const t = (entries: any[]) => ({ sessionId: 's', createdAt: 0, entries, prompts: [], usage });
    expect(lastTurnState(t([]))).toBe('none');
    expect(
      lastTurnState(
        t([
          { kind: 'prompt', text: 'p' },
          { kind: 'frame', frame: done },
        ]),
      ),
    ).toBe('finished');
    expect(lastTurnState(t([{ kind: 'prompt', text: 'p' }]))).toBe('open');
    expect(
      lastTurnState(
        t([
          { kind: 'prompt', text: 'p' },
          { kind: 'turn', turnId: 't1' },
        ]),
      ),
    ).toBe('open-detachable');
  });

  it('leaves an open detachable turn to the attach step: no notice', () => {
    const s = fromTranscript({
      sessionId: 's',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'go' },
        { kind: 'turn', turnId: 't1' },
        { kind: 'frame', frame: { type: 'text', delta: 'half' }, eventId: 't1:2-0' },
      ],
      prompts: ['go'],
      usage,
    });
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
  });

  it('old transcript keeps the #472 notice once', () => {
    const s = fromTranscript({
      sessionId: 's',
      createdAt: 0,
      entries: [
        { kind: 'prompt', text: 'go' },
        { kind: 'frame', frame: { type: 'text', delta: 'half' } },
      ],
      prompts: ['go'],
      usage,
    });
    expect(s.blocks.filter((b) => b.kind === 'notice')).toHaveLength(1);
  });

  it('adds no notice to a transcript without turns', () => {
    const s = fromTranscript({ sessionId: 's', createdAt: 0, entries: [], prompts: [], usage });
    expect(s.blocks).toEqual([]);
  });
});

describe('addNotice', () => {
  it('does not finalize the open reply', () => {
    let s = apply(EMPTY_BLOCKS, { type: 'text', delta: 'wor' });
    s = addNotice(s, 'note', 'info');
    s = apply(s, { type: 'text', delta: 'king' });
    const blocks = s.blocks;
    const assistants = blocks.filter((b) => b.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: 'working', final: false });
  });
});

describe('turn frames', () => {
  it('a turn frame adds no block', () => {
    const s = reduceFrame(EMPTY_BLOCKS, { type: 'turn', turnId: 't1', sessionId: 's' });
    expect(s.blocks).toEqual([]);
  });

  it('a truncated replay adds a notice', () => {
    const s = reduceFrame(EMPTY_BLOCKS, {
      type: 'turn',
      turnId: 't1',
      sessionId: 's',
      truncated: true,
    });
    expect(s.blocks).toMatchObject([{ kind: 'notice', text: TRUNCATED_TURN_NOTICE }]);
  });

  it('an error frame with abortReason cancelled ends the turn as cancelled', () => {
    const s = reduceFrame(EMPTY_BLOCKS, {
      type: 'error',
      sessionId: 's',
      stopReason: 'aborted',
      errorMessage: 'cancelled',
      abortReason: 'cancelled',
    });
    expect(s.blocks).toMatchObject([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it('any other abort stays an error with its message', () => {
    const s = reduceFrame(EMPTY_BLOCKS, {
      type: 'error',
      sessionId: 's',
      stopReason: 'aborted',
      errorMessage: 'harness restarting',
      abortReason: 'restarting',
    });
    expect(s.blocks).toMatchObject([
      { kind: 'turn-end', outcome: 'error', message: 'harness restarting' },
    ]);
  });
});
