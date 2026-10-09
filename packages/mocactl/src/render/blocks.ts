import { isTerminal, type TurnFrame, type Usage } from '../api/frames.js';
import type { Transcript } from '../core/transcripts.js';

export type Block =
  | { kind: 'user'; id: number; text: string; queued?: boolean }
  | { kind: 'assistant'; id: number; text: string; thinking: string; final: boolean }
  | {
      kind: 'tool';
      id: number;
      toolId: string;
      name: string;
      args: unknown;
      result?: { isError: boolean; preview: string };
    }
  | {
      kind: 'turn-end';
      id: number;
      outcome: 'done' | 'error' | 'cancelled';
      message?: string;
      usage?: Usage;
    }
  | { kind: 'event'; id: number; label: string; data: unknown }
  | { kind: 'notice'; id: number; text: string; tone: 'info' | 'warning' | 'error' };

export interface BlockState {
  blocks: Block[];
  nextId: number;
}

export const EMPTY_BLOCKS: BlockState = { blocks: [], nextId: 0 };

export type FrameReducer = (s: BlockState, frame: TurnFrame) => BlockState;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewBlock = DistributiveOmit<Block, 'id'>;

// Queued prompts stay at the bottom, below the turn that is still running (spec §6.1): everything
// except a new queued prompt is inserted above the trailing run of queued prompts.
function tailStart(blocks: Block[]): number {
  let i = blocks.length;
  while (i > 0) {
    const b = blocks[i - 1];
    if (b.kind !== 'user' || !b.queued) break;
    i--;
  }
  return i;
}

function push(s: BlockState, block: NewBlock): BlockState {
  const b = { ...block, id: s.nextId } as Block;
  const at = b.kind === 'user' && b.queued ? s.blocks.length : tailStart(s.blocks);
  return { blocks: [...s.blocks.slice(0, at), b, ...s.blocks.slice(at)], nextId: s.nextId + 1 };
}

function replaceAt(s: BlockState, i: number, b: Block): BlockState {
  const blocks = [...s.blocks];
  blocks[i] = b;
  return { ...s, blocks };
}

function finalizeOpen(s: BlockState): BlockState {
  const i = tailStart(s.blocks) - 1;
  const open = s.blocks[i];
  if (open?.kind !== 'assistant' || open.final) return s;
  return replaceAt(s, i, { ...open, final: true });
}

function appendToAssistant(s: BlockState, field: 'text' | 'thinking', delta: string): BlockState {
  const i = tailStart(s.blocks) - 1;
  const open = s.blocks[i];
  if (open?.kind === 'assistant' && !open.final) {
    return replaceAt(
      s,
      i,
      field === 'text'
        ? { ...open, text: open.text + delta }
        : { ...open, thinking: open.thinking + delta },
    );
  }
  return push(s, {
    kind: 'assistant',
    text: field === 'text' ? delta : '',
    thinking: field === 'thinking' ? delta : '',
    final: false,
  });
}

const eventReducer: FrameReducer = (s, frame) =>
  push(finalizeOpen(s), {
    kind: 'event',
    label: frame.type === 'unknown' ? frame.event : frame.type,
    data: frame.type === 'unknown' ? frame.data : frame,
  });

// Spec §7.2: one reducer per frame type; anything else falls to eventReducer.
export const FRAME_REDUCERS: Record<string, FrameReducer> = {
  turn: (s, f) =>
    f.type === 'turn' && f.truncated ? addNotice(s, TRUNCATED_TURN_NOTICE, 'info') : s,
  text: (s, f) => (f.type === 'text' ? appendToAssistant(s, 'text', f.delta) : s),
  thinking: (s, f) => (f.type === 'thinking' ? appendToAssistant(s, 'thinking', f.delta) : s),
  tool_use: (s, f) =>
    f.type === 'tool_use'
      ? push(finalizeOpen(s), { kind: 'tool', toolId: f.id, name: f.name, args: f.args })
      : s,
  tool_result: (s, f) => {
    if (f.type !== 'tool_result') return s;
    let i = s.blocks.length - 1;
    while (
      i >= 0 &&
      !(s.blocks[i].kind === 'tool' && (s.blocks[i] as { toolId: string }).toolId === f.id)
    )
      i--;
    if (i === -1 || (s.blocks[i] as { result?: unknown }).result) return eventReducer(s, f);
    const blocks = [...s.blocks];
    blocks[i] = {
      ...(blocks[i] as Extract<Block, { kind: 'tool' }>),
      result: { isError: f.isError, preview: f.preview },
    };
    return { ...s, blocks };
  },
  workspace_reset: (s, f) =>
    f.type === 'workspace_reset' ? addNotice(s, workspaceResetText(f), 'warning') : s,
  done: (s, f) =>
    f.type === 'done'
      ? push(finalizeOpen(s), { kind: 'turn-end', outcome: 'done', usage: f.usage })
      : s,
  error: (s, f) =>
    f.type === 'error'
      ? push(
          finalizeOpen(s),
          // The user's own cancel of a detachable turn arrives as an error frame; show it as the
          // cancel it was, like Esc on a non-detachable turn.
          f.abortReason === 'cancelled'
            ? { kind: 'turn-end', outcome: 'cancelled', usage: f.usage }
            : {
                kind: 'turn-end',
                outcome: 'error',
                message: f.errorMessage ?? f.stopReason,
                usage: f.usage,
              },
        )
      : s,
};

export function reduceFrame(s: BlockState, frame: TurnFrame): BlockState {
  return (FRAME_REDUCERS[frame.type] ?? eventReducer)(s, frame);
}

export function addUser(s: BlockState, text: string, queued = false): BlockState {
  return push(queued ? s : finalizeOpen(s), { kind: 'user', text, queued });
}

export function markSent(s: BlockState): BlockState {
  const i = s.blocks.findIndex((b) => b.kind === 'user' && b.queued);
  if (i === -1) return s;
  const blocks = [...s.blocks];
  blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'user' }>), queued: false };
  return { ...s, blocks };
}

export function workspaceResetText(f: {
  from: string;
  tier: string;
  reason: 'detached' | 'retiered';
}): string {
  // No tier when the deployment declares none: name no tier rather than print "in tier ''".
  const where = f.tier ? ` in tier '${f.tier}'` : '';
  return f.reason === 'retiered'
    ? `workspace reset: sandbox '${f.from}' moved to another tier; this turn runs on a fresh workspace${where}`
    : `workspace reset: sandbox '${f.from}' is gone; this turn runs on a fresh workspace${where}`;
}

export function addNotice(
  s: BlockState,
  text: string,
  tone: 'info' | 'warning' | 'error' = 'info',
): BlockState {
  const tail = tailStart(s.blocks);
  const openAssistantIdx = tail - 1;
  const openAssistant = s.blocks[openAssistantIdx];

  if (openAssistant?.kind === 'assistant' && !openAssistant.final) {
    // Insert notice above the open assistant, keeping it open
    const notice: Block = { kind: 'notice', id: s.nextId, text, tone };
    const newBlocks = [
      ...s.blocks.slice(0, openAssistantIdx),
      notice,
      ...s.blocks.slice(openAssistantIdx),
    ];
    return { blocks: newBlocks, nextId: s.nextId + 1 };
  }

  return push(finalizeOpen(s), { kind: 'notice', text, tone });
}

export function endTurn(
  s: BlockState,
  outcome: 'done' | 'error' | 'cancelled',
  message?: string,
): BlockState {
  return push(finalizeOpen(s), { kind: 'turn-end', outcome, message });
}

/**
 * Why a resumed session can stop mid-reply on a turn that cannot be re-attached: a turn that was
 * not detachable (no `turn` frame recorded, e.g. a transcript written before detachable turns, or
 * a harness without them) aborts on a client disconnect and nothing replays it (turn SSE spec
 * §3.6). Without this note the cut-off reply reads as one still being written.
 */
export const INTERRUPTED_TURN_NOTICE =
  'the last turn didn\'t finish (mocactl closed, or it was cancelled or failed) and isn\'t running — send a prompt such as "go on" to continue';

export const TRUNCATED_TURN_NOTICE = 'earlier output of this turn is no longer available';

/** Where the transcript's last turn stands: 'open-detachable' is one a resume can re-attach to. */
export function lastTurnState(t: Transcript): 'none' | 'finished' | 'open' | 'open-detachable' {
  let state: 'none' | 'finished' | 'open' | 'open-detachable' = 'none';
  for (const e of t.entries) {
    if (e.kind === 'prompt') state = 'open';
    else if (e.kind === 'turn') state = state === 'open' ? 'open-detachable' : state;
    else if (isTerminal(e.frame)) state = 'finished';
  }
  return state;
}

/** Marks every tool block in [from, to) that has no result as interrupted. */
function interruptTools(s: BlockState, from = 0, to = Infinity): BlockState {
  const blocks = s.blocks.map((b, i) =>
    i >= from && i < to && b.kind === 'tool' && !b.result
      ? { ...b, result: { isError: true, preview: 'interrupted' } }
      : b,
  );
  return { ...s, blocks };
}

/**
 * Settles a turn left open for the resume's attach step (see fromTranscript) once that step ends
 * without the turn's terminal: its reply is final and its unfinished tools were interrupted.
 */
export function settleOpenTurn(s: BlockState): BlockState {
  return interruptTools(finalizeOpen(s));
}

export function fromTranscript(t: Transcript): BlockState {
  let s = EMPTY_BLOCKS;
  let lastTurnFrom = 0; // where the last prompt's blocks start
  for (const e of t.entries) {
    if (e.kind === 'prompt') {
      s = addUser(s, e.text);
      lastTurnFrom = s.blocks.length - 1;
    } else if (e.kind === 'frame') s = reduceFrame(s, e.frame);
  }
  const state = lastTurnState(t);
  // An open detachable turn may still be running: the resume's attach step replays the rest into
  // it (a tool result, more of the reply), so it stays open; settleOpenTurn closes it if that step
  // finds nothing. Earlier turns are settled as ever.
  if (state === 'open-detachable') return interruptTools(s, 0, lastTurnFrom);
  s = interruptTools(finalizeOpen(s));
  return state === 'open' ? addNotice(s, INTERRUPTED_TURN_NOTICE, 'warning') : s;
}

export function isSettled(b: Block): boolean {
  switch (b.kind) {
    case 'assistant':
      return b.final;
    case 'tool':
      return b.result !== undefined;
    case 'user':
      return !b.queued;
    default:
      return true;
  }
}

export function splitStatic(blocks: Block[]): { settled: Block[]; live: Block[] } {
  const i = blocks.findIndex((b) => !isSettled(b));
  return i === -1
    ? { settled: blocks, live: [] }
    : { settled: blocks.slice(0, i), live: blocks.slice(i) };
}
