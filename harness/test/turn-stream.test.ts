import { describe, it, expect, afterEach } from 'vitest';
import {
  sseExtension,
  clip,
  previewCap,
  terminalFrame,
  type TurnStreamFrame,
} from '../src/turn-stream.js';
import type { TurnResult } from '../src/run-turn.js';

// A fake Pi that captures the handler registered per event NAME, plus emit() to fire one.
// sseExtension registers multiple handlers (message_update / tool_execution_start /
// tool_execution_end), so — unlike a single-handler extension fake — we key by event name.
function makePi() {
  const handlers = new Map<string, (e: any) => void>();
  const pi = {
    on: (event: string, h: (e: any) => void) => {
      handlers.set(event, h);
    },
  };
  return {
    pi,
    emit(event: string, e: any) {
      const h = handlers.get(event);
      if (!h) throw new Error(`no handler registered for ${event}`);
      h(e);
    },
  };
}

// Apply sseExtension against a captured sink; return the emitter and the frames it produced.
function drive(opts?: { previewBytes?: number }) {
  const frames: TurnStreamFrame[] = [];
  const { pi, emit } = makePi();
  sseExtension((f) => frames.push(f), opts)(pi as any);
  return { emit, frames };
}

describe('sseExtension frame translation', () => {
  it('translates text_delta / thinking_delta / tool start+end into the frame sequence', () => {
    const { emit, frames } = drive();
    emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } });
    emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
    emit('tool_execution_start', { toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } });
    emit('tool_execution_end', {
      toolCallId: 't1',
      toolName: 'bash',
      result: 'file.txt',
      isError: false,
    });
    expect(frames).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'thinking', delta: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_result', id: 't1', isError: false, preview: 'file.txt' },
    ]);
  });

  it("drops empty deltas (no frame for delta === '')", () => {
    const { emit, frames } = drive();
    emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '' } });
    emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: '' } });
    expect(frames).toEqual([]);
  });

  it('propagates isError verbatim on tool_result', () => {
    const { emit, frames } = drive();
    emit('tool_execution_end', {
      toolCallId: 't2',
      toolName: 'bash',
      result: 'boom',
      isError: true,
    });
    expect(frames[0]).toEqual({ type: 'tool_result', id: 't2', isError: true, preview: 'boom' });
  });
});

describe('clip / fidelity-B truncation', () => {
  it('returns short results unchanged', () => {
    expect(clip('hi', 2048)).toBe('hi');
  });

  it('clips an oversized result to the byte cap and marks it truncated', () => {
    const big = 'x'.repeat(5000);
    const out = clip(big, 2048);
    expect(out.startsWith('x'.repeat(2048))).toBe(true);
    expect(out.endsWith('…[truncated]')).toBe(true);
    // the un-suffixed head is exactly the cap in bytes
    expect(Buffer.from(out.slice(0, -'…[truncated]'.length), 'utf8').byteLength).toBe(2048);
  });

  it('coerces non-string results via JSON before clipping', () => {
    expect(clip({ a: 1 }, 2048)).toBe('{"a":1}');
  });
});

describe('previewCap resolution (override > env > default)', () => {
  const DEFAULT = 2048;
  const ENV = 'SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES';
  afterEach(() => {
    delete process.env[ENV]; // isolate the env-branch cases from each other and the default
  });

  it('uses a finite, non-negative override verbatim (0 is a valid cap)', () => {
    expect(previewCap(512)).toBe(512);
    expect(previewCap(0)).toBe(0);
  });

  it('clamps a non-finite or negative override back to the default', () => {
    expect(previewCap(-1)).toBe(DEFAULT);
    expect(previewCap(Number.NaN)).toBe(DEFAULT);
    expect(previewCap(Number.POSITIVE_INFINITY)).toBe(DEFAULT);
  });

  it('falls back to the default when neither override nor env is set', () => {
    expect(previewCap()).toBe(DEFAULT);
  });

  it('parses a valid env override when no explicit override is passed', () => {
    process.env[ENV] = '1024';
    expect(previewCap()).toBe(1024);
    process.env[ENV] = '0';
    expect(previewCap()).toBe(0);
  });

  it('clamps an unparseable or negative env value back to the default', () => {
    process.env[ENV] = 'not-a-number';
    expect(previewCap()).toBe(DEFAULT);
    process.env[ENV] = '-5';
    expect(previewCap()).toBe(DEFAULT);
  });

  it('an explicit override wins over the env value', () => {
    process.env[ENV] = '1024';
    expect(previewCap(256)).toBe(256);
  });
});

describe('terminalFrame selection & parity', () => {
  it('clean stop-reason → done carrying sessionId/stopReason/usage', () => {
    const r: TurnResult = {
      sessionId: 's1',
      response: 'hi',
      stopReason: 'end_turn',
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    };
    expect(terminalFrame(r)).toEqual({
      type: 'done',
      sessionId: 's1',
      stopReason: 'end_turn',
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    });
  });

  it('error stop-reason → error carrying the same errorMessage a sync caller reads', () => {
    const r: TurnResult = {
      sessionId: 's2',
      response: '',
      stopReason: 'error',
      errorMessage: 'boom',
    };
    expect(terminalFrame(r)).toEqual({
      type: 'error',
      sessionId: 's2',
      stopReason: 'error',
      errorMessage: 'boom',
    });
  });

  it('max_tokens is a clean finish → done', () => {
    const r: TurnResult = { sessionId: 's3', response: 'partial', stopReason: 'max_tokens' };
    expect(terminalFrame(r)).toEqual({ type: 'done', sessionId: 's3', stopReason: 'max_tokens' });
  });

  // executeTurn copies the last message's stopReason, which is PI's normalized vocabulary
  // (pi-fork packages/ai/src/types.ts: "stop" | "length" | "toolUse" | "error" | "aborted"), not the
  // Anthropic wire's end_turn/max_tokens. Every fixture above invents the wire value, which is how a
  // real, cleanly finished turn shipped ending in an `error` frame (#348's live smoke caught it).
  it.each(['stop', 'length'])("pi's clean stop reason '%s' → done", (stopReason) => {
    const r: TurnResult = { sessionId: 's4', response: 'pong', stopReason };
    expect(terminalFrame(r)).toEqual({ type: 'done', sessionId: 's4', stopReason });
  });

  it.each(['error', 'aborted', 'toolUse'])(
    "pi's stop reason '%s' is not a clean finish → error",
    (stopReason) => {
      const r: TurnResult = { sessionId: 's5', response: '', stopReason };
      expect(terminalFrame(r).type).toBe('error');
    },
  );
});

describe('terminalFrame carries where the turn ran and its patch (session-templates spec §5.1)', () => {
  const sandbox = {
    id: 'w-1',
    tier: 'microvm',
    seed: { source: 'build' as const, buildId: 'sha256:' + 'b'.repeat(64) },
  };
  const workspace = { baseline: 'abc', patch: 'diff\n', patchSha256: 'sha256:x', patchBytes: 5 };

  it('on done', () => {
    const f = terminalFrame({
      sessionId: 's',
      response: '',
      stopReason: 'stop',
      sandbox,
      workspace,
    });
    expect(f).toMatchObject({ type: 'done', sandbox, workspace });
  });

  it('on error', () => {
    const f = terminalFrame({
      sessionId: 's',
      response: '',
      stopReason: 'error',
      sandbox,
      workspace,
    });
    expect(f).toMatchObject({ type: 'error', sandbox, workspace });
  });
});
