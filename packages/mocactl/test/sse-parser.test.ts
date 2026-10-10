import { describe, expect, it } from 'vitest';
import { isTerminal } from '../src/api/frames.js';
import { SseParser, readSse, toFrame } from '../src/api/sse-parser.js';
import { sseText, streamOf } from './helpers/sse.js';

const frames = [
  { type: 'text', delta: 'Hel' },
  { type: 'tool_use', id: 't1', name: 'bash', args: { command: 'ls' } },
  { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
];

describe('SseParser', () => {
  it('parses complete events', () => {
    const events = new SseParser().push(sseText(frames));
    expect(events.map((e) => e.event)).toEqual(['text', 'tool_use', 'done']);
    expect(JSON.parse(events[0].data)).toEqual(frames[0]);
  });

  it('yields the same events however the input is split', () => {
    const text = sseText(frames);
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser();
      const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut)), ...p.flush()];
      expect(got.map((e) => e.event)).toEqual(['text', 'tool_use', 'done']);
    }
  });

  it('handles CRLF line endings, including a CR at the end of a chunk', () => {
    const p = new SseParser();
    const got = [
      ...p.push('event: text\r\ndata: {"type":"text","delta":"a"}\r'),
      ...p.push('\n\r\n'),
    ];
    expect(got).toEqual([{ event: 'text', data: '{"type":"text","delta":"a"}' }]);
  });

  it('ignores comments such as the keepalive heartbeat', () => {
    expect(new SseParser().push(': keepalive\n\n')).toEqual([]);
  });

  it('joins multi-line data with newlines and defaults the event name', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });

  it('flush emits a final event with no trailing blank line', () => {
    const p = new SseParser();
    expect(p.push('event: text\ndata: x')).toEqual([]);
    expect(p.flush()).toEqual([{ event: 'text', data: 'x' }]);
  });

  it('reads the id field', () => {
    const p = new SseParser();
    expect(p.push('id: t1:5-0\nevent: text\ndata: {"type":"text","delta":"x"}\n\n')).toEqual([
      { event: 'text', data: '{"type":"text","delta":"x"}', id: 't1:5-0' },
    ]);
  });
});

describe('readSse', () => {
  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode(sseText([{ type: 'text', delta: 'é' } as never]));
    const at = bytes.indexOf(0xc3) + 1; // split inside the two-byte é
    const events = [];
    for await (const e of readSse(streamOf([bytes.slice(0, at), bytes.slice(at)]))) events.push(e);
    expect(JSON.parse(events[0].data).delta).toBe('é');
  });

  // The SSE spec discards a block with no closing blank line at EOF. The harness writes `id:`
  // before `data:`, so a body cut mid-event must not report that event's id: a re-attach would
  // resume after it and never see the frame (#471 review).
  it.each([
    ['after the id line', 'id: t1:4-0\n'],
    ['mid-data', 'id: t1:4-0\nevent: tool_result\ndata: {"type":"tool_res'],
    ['after a complete data line', 'id: t1:4-0\nevent: text\ndata: {"type":"text","delta":"x"}\n'],
  ])('a block cut %s at EOF yields no event and no id', async (_how, tail) => {
    const head = 'id: t1:3-0\nevent: text\ndata: {"type":"text","delta":"a"}\n\n';
    const events = [];
    for await (const e of readSse(streamOf([head + tail]))) events.push(e);
    expect(events.map((e) => e.id)).toEqual(['t1:3-0']);
  });

  it('a block closed by a lone-CR blank line at EOF is still dispatched', async () => {
    const events = [];
    for await (const e of readSse(streamOf(['id: t1:1-0\rdata: x\r\r']))) events.push(e);
    expect(events).toEqual([{ event: 'message', data: 'x', id: 't1:1-0' }]);
  });
});

describe('toFrame', () => {
  it('returns known frames as-is', () => {
    const f = toFrame({ event: 'done', data: JSON.stringify(frames[2]) });
    expect(f).toEqual(frames[2]);
    expect(isTerminal(f)).toBe(true);
  });

  it('wraps an unknown event type instead of dropping it', () => {
    expect(toFrame({ event: 'paused', data: '{"gateId":3}' })).toEqual({
      type: 'unknown',
      event: 'paused',
      data: { gateId: 3 },
    });
  });

  it('wraps malformed JSON and an event/type mismatch as unknown', () => {
    expect(toFrame({ event: 'text', data: '{nope' })).toEqual({
      type: 'unknown',
      event: 'text',
      data: '{nope',
    });
    expect(toFrame({ event: 'text', data: '{"type":"done"}' }).type).toBe('unknown');
  });
});
