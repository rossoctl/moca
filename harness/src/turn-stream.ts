import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { LeafUsage } from './run-leaf.js';
import type { TurnResult } from './run-turn.js';

/** Why the registry aborted a detachable turn (turn-reattach spec §5); absent for any other end. */
export type AbortReasonCode =
  'cancelled' | 'unwatched' | 'restarting' | 'lease_lost' | 'owner_lost';

/**
 * Neutral, transport-agnostic frames the turn core emits during a streamed turn. A discriminated
 * union on `type` — both the sink (server SSE) and any future consumer share this vocabulary.
 * Fidelity B: tool_use carries verbatim args; tool_result carries isError + a clipped preview.
 */
export type TurnStreamFrame =
  // Detachable turns only (turn-reattach spec §4.1): first frame, names the turn its ids belong to.
  // `ended`: an attach whose cursor is at or past a finished turn's terminal; nothing follows it.
  | { type: 'turn'; turnId: string; sessionId: string; truncated?: boolean; ended?: boolean }
  | { type: 'text'; delta: string } // assistant-text token
  | { type: 'thinking'; delta: string } // reasoning token (optional; may never fire — §3.5)
  | { type: 'tool_use'; id: string; name: string; args: unknown } // tool call started (args verbatim)
  | { type: 'tool_result'; id: string; isError: boolean; preview: string } // tool call ended (clipped)
  // P6.3: emitted first when this turn's sandbox is not the one the session's previous turn used, so
  // the user learns at the turn itself why earlier files are gone. Old clients ignore unknown types.
  | {
      type: 'workspace_reset';
      sessionId: string;
      from: string;
      tier: string;
      reason: 'detached' | 'retiered';
    }
  | { type: 'done'; sessionId: string; stopReason: string; usage?: LeafUsage }
  | {
      type: 'error';
      sessionId: string;
      stopReason: string;
      errorMessage?: string;
      usage?: LeafUsage;
      abortReason?: AbortReasonCode;
    };

const DEFAULT_PREVIEW_BYTES = 2048;

/**
 * Byte cap for tool_result previews (fidelity B). Read per call so an override takes effect without
 * a restart; finite + non-negative or fall back to the default (mirrors server.ts intEnv).
 */
export function previewCap(override?: number): number {
  if (override !== undefined) {
    return Number.isFinite(override) && override >= 0 ? override : DEFAULT_PREVIEW_BYTES;
  }
  const raw = process.env.SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES;
  if (raw === undefined) return DEFAULT_PREVIEW_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PREVIEW_BYTES;
}

/**
 * Coerce a tool result to a string and clip it to a UTF-8 byte cap. Truncation is a domain concern
 * (§3.1), so no transport ever sees the untruncated result. Non-strings are JSON-encoded.
 */
export function clip(result: unknown, previewBytes?: number): string {
  const cap = previewCap(previewBytes);
  const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= cap) return text;
  return buf.subarray(0, cap).toString('utf8') + '…[truncated]';
}

/**
 * A Pi ExtensionFactory that translates Pi session events into neutral TurnStreamFrames and pushes
 * them to `onEvent` — the same five-line shape as flushExtension. Emits ONLY incremental progress
 * frames; the terminal done/error frame is derived from the returned TurnResult by terminalFrame.
 */
export function sseExtension(
  onEvent: (frame: TurnStreamFrame) => void,
  opts?: { previewBytes?: number },
): ExtensionFactory {
  return (pi) => {
    pi.on('message_update', (e) => {
      const a = e.assistantMessageEvent;
      if (a.type === 'text_delta' && a.delta) onEvent({ type: 'text', delta: a.delta });
      else if (a.type === 'thinking_delta' && a.delta)
        onEvent({ type: 'thinking', delta: a.delta });
    });
    pi.on('tool_execution_start', (e) =>
      onEvent({ type: 'tool_use', id: e.toolCallId, name: e.toolName, args: e.args }),
    );
    pi.on('tool_execution_end', (e) =>
      onEvent({
        type: 'tool_result',
        id: e.toolCallId,
        isError: e.isError,
        preview: clip(e.result, opts?.previewBytes),
      }),
    );
  };
}

/**
 * A clean finish, in BOTH vocabularies a TurnResult can carry: pi's normalized one (`stop`,
 * `length` -- what executeTurn copies from the last message, so what every real turn reports) and the
 * Anthropic wire's (`end_turn`, `max_tokens` -- run-turn.ts's own default when there is no message).
 * Matching only the wire's made every real, cleanly finished SSE turn end in an `error` frame.
 */
export const CLEAN_STOP_REASONS = new Set(['stop', 'length', 'end_turn', 'max_tokens']);

/**
 * Derive the terminal frame from the returned TurnResult (§3.4). `done` for a clean finish
 * (CLEAN_STOP_REASONS), `error` otherwise (error/aborted/toolUse). Both carry every TurnResult
 * field, so a streamed client ends with the same facts a sync client reads; only the event NAME
 * differs.
 */
export function terminalFrame(result: TurnResult): TurnStreamFrame {
  const clean = CLEAN_STOP_REASONS.has(result.stopReason);
  if (clean) {
    return {
      type: 'done',
      sessionId: result.sessionId,
      stopReason: result.stopReason,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
  return {
    type: 'error',
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
