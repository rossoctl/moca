import { isTerminal, type TurnFrame, type Usage } from '../api/frames.js';
import type { Transcript } from '../core/transcripts.js';

export type Block =
  /**
   * `unsent` is a prompt that never went out (#479). Like `queued` it stays below the turn above
   * it, so that turn's reply keeps growing in its own block; unlike `queued` it is settled, since
   * nothing will ever send it.
   */
  | { kind: 'user'; id: number; text: string; queued?: boolean; unsent?: boolean }
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
  /** `pinned` keeps a notice with the bottom block it heads, rather than with the turn above. */
  | {
      kind: 'notice';
      id: number;
      text: string;
      tone: 'info' | 'warning' | 'error';
      pinned?: boolean;
    };

export interface BlockState {
  blocks: Block[];
  nextId: number;
}

export const EMPTY_BLOCKS: BlockState = { blocks: [], nextId: 0 };

export type FrameReducer = (s: BlockState, frame: TurnFrame) => BlockState;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewBlock = DistributiveOmit<Block, 'id'>;

/**
 * Blocks that belong below the turn above them rather than inside it: a queued prompt waiting for
 * it (spec §6.1), an unsent one it held back (#479), and a notice pinned to either. Everything else
 * is inserted above the trailing run of them, so a reply still being written keeps growing in place.
 */
function atBottom(b: Block): boolean {
  if (b.kind === 'user') return b.queued === true || b.unsent === true;
  return b.kind === 'notice' && b.pinned === true;
}

function tailStart(blocks: Block[]): number {
  let i = blocks.length;
  while (i > 0 && atBottom(blocks[i - 1])) i--;
  return i;
}

function push(s: BlockState, block: NewBlock): BlockState {
  const b = { ...block, id: s.nextId } as Block;
  const at = atBottom(b) ? s.blocks.length : tailStart(s.blocks);
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
  // A prompt that actually goes out is what retires an unsent record: it was pinned to the bottom
  // only while it was still the one thing owed to the user. Retiring it keeps this prompt -- the
  // prefill the resume offered, usually this very text -- and everything it leads to BELOW the
  // warning about it, instead of spliced in front of blocks <Static> has already printed (#479).
  //
  // A QUEUED prompt has retired nothing: it is itself still waiting, behind the very turn the
  // warning is about. Unpinning here would drop the bottom below the warning, so the rest of that
  // turn's reply could no longer reach the block it was filling and would open a second one under
  // the warning -- splitting the reply in two and leaving its first half unfinalized, which holds
  // every block in the live area for good. `markSent` is what finally puts a sent prompt below
  // them, and nothing can walk back above it, so this runs exactly once per record.
  return push(queued ? s : unpinBottom(finalizeOpen(s)), { kind: 'user', text, queued });
}

/**
 * Turns the bottom-pinned run into ordinary history: the `unsent` prompts and the notices heading
 * them stop claiming the bottom, so later blocks append after them in the order they happened.
 * Queued prompts keep their flag — they are still waiting, and it is what marks them on screen.
 */
function unpinBottom(s: BlockState): BlockState {
  const from = tailStart(s.blocks);
  if (from === s.blocks.length) return s;
  const blocks = s.blocks.map((b, i) => {
    if (i < from) return b;
    if (b.kind === 'user' && b.unsent) return { ...b, unsent: false };
    if (b.kind === 'notice' && b.pinned) return { ...b, pinned: false };
    return b;
  });
  return { ...s, blocks };
}

/**
 * A prompt that never went out (#479), with the line saying so. Both sit at the bottom, under a
 * turn that may still be running: it is the other device's, and it keeps its own reply block.
 */
export function addUnsent(s: BlockState, text: string): BlockState {
  return push(
    push(s, { kind: 'notice', text: UNSENT_PROMPT_NOTICE, tone: 'warning', pinned: true }),
    {
      kind: 'user',
      text,
      unsent: true,
    },
  );
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
    ? `workspace reset: sandbox '${f.from}' moved to another tier or template; this turn runs on a fresh workspace${where}`
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

/**
 * The catch-up replayed a turn this device never started: another device ran it while this one was
 * away (#483). Without the line the turn reads as the reply to whatever prompt sits above it.
 */
export const OTHER_DEVICE_TURN_NOTICE = "another device's turn";

/**
 * A prompt that was waiting behind another device's turn when this device left, so the queue
 * holding it was dropped before it was ever sent (#479). Without the line it reads as a prompt
 * that was asked and answered by the turn above it.
 */
export const UNSENT_PROMPT_NOTICE =
  "your last prompt was not sent — it was waiting for another device's turn";

/**
 * Where the transcript's last turn stands: 'open-detachable' is one a resume can re-attach to.
 * A `turn` entry opens one after its prompt, and also with no prompt before it: a 409's attach
 * records another device's turn on its own.
 */
export function lastTurnState(t: Transcript): 'none' | 'finished' | 'open' | 'open-detachable' {
  let state: 'none' | 'finished' | 'open' | 'open-detachable' = 'none';
  for (const e of t.entries) {
    if (e.kind === 'prompt') state = 'open';
    else if (e.kind === 'turn') state = 'open-detachable';
    // An unsent prompt (#479) is not a turn: it says one never started, which leaves where the
    // last turn stands exactly as the entries before it had it.
    else if (e.kind === 'unsent') continue;
    else if (isTerminal(e.frame)) state = 'finished';
  }
  return state;
}

/**
 * The turn id of the transcript's open detachable turn, if it has one. The resume's attach replays
 * the session's LATEST turn, which need not be this one (spec §4.2): comparing the replayed
 * `turn` frame's id against this says whether the catch-up continues our turn or starts another
 * device's (#483). Undefined when the last turn finished, or was open but not detachable — an old
 * transcript records no `turn` entry, so there is no id to compare and nothing to continue.
 */
export function openTurnId(t: Transcript): string | undefined {
  let id: string | undefined;
  for (const e of t.entries) {
    if (e.kind === 'turn') id = e.turnId;
    else if (e.kind === 'prompt' || (e.kind === 'frame' && isTerminal(e.frame))) id = undefined;
  }
  return id;
}

/**
 * The prompt a resume should offer back: one recorded unsent (#479) with nothing sent since. A
 * later `prompt` entry settles the matter — the user asked something after, so the dropped one is
 * no longer what they were waiting on.
 */
export function unsentPrompt(t: Transcript): string | undefined {
  let text: string | undefined;
  for (const e of t.entries) {
    if (e.kind === 'unsent') text = e.text;
    else if (e.kind === 'prompt') text = undefined;
  }
  return text;
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

/**
 * The catch-up is replaying a turn of its own, not the rest of the one the transcript left open
 * (#483): that turn ends here, settled as `settleOpenTurn` would, and a notice says the turn
 * about to stream belongs to another device. Settling first is what keeps the two apart — an open
 * assistant block would otherwise swallow the other turn's text, and an unsettled tool would pin
 * every later block in the live area for the rest of the session.
 */
export function startsForeignTurn(s: BlockState): BlockState {
  return push(settleOpenTurn(s), { kind: 'notice', text: OTHER_DEVICE_TURN_NOTICE, tone: 'info' });
}

export function fromTranscript(t: Transcript): BlockState {
  let s = EMPTY_BLOCKS;
  let lastTurnFrom = 0; // where the last turn's blocks start: its prompt, or a prompt-less turn
  let open = false; // a prompt or turn entry came after the last terminal
  for (const e of t.entries) {
    if (e.kind === 'prompt') {
      s = addUser(s, e.text);
      lastTurnFrom = s.blocks.length - 1;
      open = true;
    } else if (e.kind === 'turn') {
      // Another device's turn, recorded by a 409's attach with no prompt of its own.
      if (!open) lastTurnFrom = s.blocks.length;
      open = true;
    } else if (e.kind === 'unsent') {
      // A prompt that never went out (#479): the user's own words, under a line saying so, since
      // on its own it reads as a prompt the turn above it answered. It opens no turn, so `open`
      // and `lastTurnFrom` stay as they were.
      s = addUnsent(s, e.text);
    } else {
      s = reduceFrame(s, e.frame);
      if (isTerminal(e.frame)) open = false;
    }
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
