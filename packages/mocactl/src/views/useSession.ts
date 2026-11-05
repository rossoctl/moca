import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminal, type TurnFrame, type Usage } from '../api/frames.js';
import { describeError } from '../core/messages.js';
import type { ActiveSession, SessionEvent } from '../core/session-manager.js';
import {
  addNotice,
  addUser,
  endTurn,
  INTERRUPTED_TURN_NOTICE,
  markSent,
  reduceFrame,
  settleOpenTurn,
  startsForeignTurn,
  type BlockState,
} from '../render/blocks.js';
import type { TurnState } from './status.js';

export const COALESCE_MS = 40;

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export interface SessionView {
  state: BlockState;
  turn: TurnState;
  usage: Usage;
  submit(text: string): void;
  /** Runs `text` again without a second user block: the replay after a re-login (spec §8.1). */
  resend(text: string): void;
  cancel(): void;
  clearQueue(): void;
  lastReply(): string | undefined;
}

interface Options {
  initial: BlockState;
  initialUsage?: Usage;
  now: () => number;
  /**
   * The turn `initial` left open, when it is a detachable one (#483). The resume's attach replays
   * the session's LATEST turn, which may be a newer one another device ran: a `turn` frame naming
   * any other id means the catch-up is not continuing this turn, so this one is settled first and
   * the replay renders as a turn of its own. Undefined when there is nothing open to continue.
   */
  openTurnId?: string;
  onTurnEnd?: (e: Extract<SessionEvent, { kind: 'turn-end' }>) => void;
}

export function useSession(session: ActiveSession | undefined, opts: Options): SessionView {
  const [state, setState] = useState(opts.initial);
  const [turn, setTurn] = useState<TurnState>({ phase: 'idle', queued: 0 });
  const [usage, setUsage] = useState<Usage>(opts.initialUsage ?? ZERO);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onTurnEnd = useRef(opts.onTurnEnd);
  onTurnEnd.current = opts.onTurnEnd;
  // Which turn the rendered blocks still have open, so a catch-up's `turn` frame can be told from
  // it (#483). Reset alongside the blocks it describes, and cleared the moment that turn stops
  // being open — by its own terminal, by a turn-end that brought none, by an attach that found
  // nothing left of it, or by this device starting a turn of its own. Only an attach's first
  // `turn` frame is ever compared against it; left set any longer, it would name a turn that is
  // already settled and label this device's next turn as another device's.
  const openTurn = useRef(opts.openTurnId);

  // Resets when the session or its initial snapshot changes (a session swap must not carry over
  // another session's blocks/usage/turn state); opts.initialUsage is deliberately not a
  // dependency — it seeds state alongside opts.initial rather than on every render.
  useEffect(() => {
    setState(opts.initial);
    setUsage(opts.initialUsage ?? ZERO);
    setTurn({ phase: 'idle', queued: 0 });
    openTurn.current = opts.openTurnId;
  }, [session, opts.initial]);

  useEffect(() => {
    if (!session) return;
    let pending: TurnFrame[] = [];
    let startedAt = 0;
    // Starts false: a hook that subscribes mid-turn (turn-start already emitted before this
    // effect ran) must not treat the next frame it happens to see as the turn's first frame and
    // record a bogus TTFT of now() - 0. Only an actual 'turn-start' event flips this true.
    let firstFrame = false;
    let sawTerminal = false;
    // An attach job is running: a resumed open turn (left open by fromTranscript) is its to settle.
    let attaching = false;

    const flush = () => {
      if (pending.length === 0) return;
      const frames = pending;
      pending = [];
      setState((s) => frames.reduce(reduceFrame, s));
    };
    const timer = setInterval(flush, COALESCE_MS);

    const off = session.on((e) => {
      switch (e.kind) {
        case 'turn-start':
          startedAt = opts.now();
          firstFrame = true;
          sawTerminal = false;
          attaching = false;
          openTurn.current = undefined;
          setState((s) => markSent(s));
          setTurn((t) => ({ ...t, phase: 'waiting', startedAt }));
          break;
        case 'attach-start':
          startedAt = opts.now();
          firstFrame = false; // a catch-up has no time-to-first-token
          sawTerminal = false;
          attaching = true;
          setTurn((t) => ({ ...t, phase: 'waiting', startedAt }));
          break;
        case 'attach-none':
          attaching = false;
          openTurn.current = undefined;
          flush();
          // Nothing more of the resumed turn is coming: settle what the transcript left open.
          setState((s) => {
            const settled = settleOpenTurn(s);
            return e.missed ? addNotice(settled, INTERRUPTED_TURN_NOTICE, 'warning') : settled;
          });
          setTurn((t) => ({ ...t, phase: 'idle', startedAt: undefined }));
          break;
        case 'notice':
          flush();
          setState((s) => addNotice(s, e.text, e.tone));
          break;
        case 'frame': {
          const f = e.frame;
          // The catch-up named its turn. If it is not the one the blocks still have open, it is
          // another device's newer turn (#483): end ours here and let the replay render on its
          // own, rather than appending it into our still-open reply.
          if (f.type === 'turn') {
            const ours = openTurn.current;
            openTurn.current = f.turnId;
            if (ours !== undefined && ours !== f.turnId) {
              flush();
              setState(startsForeignTurn);
            }
          }
          if (f.type === 'text' || f.type === 'thinking') pending.push(f);
          else {
            flush();
            setState((s) => reduceFrame(s, f));
          }
          if (isTerminal(f)) {
            sawTerminal = true;
            // A terminal can arrive with a tool still result-less: `restarting`, `owner_lost` or a
            // cancel mid-tool. The resume-time interrupted marking does not run for an open
            // detachable turn, so without this that tool stays unsettled and pins every later
            // block in the live area for the rest of the session (#483).
            openTurn.current = undefined;
            setState(settleOpenTurn);
            const u = f.usage;
            if (u) {
              setUsage((acc) => ({
                input: acc.input + u.input,
                output: acc.output + u.output,
                cacheRead: acc.cacheRead + u.cacheRead,
                cacheWrite: acc.cacheWrite + u.cacheWrite,
                total: acc.total + u.total,
              }));
            }
          }
          if (firstFrame) {
            firstFrame = false;
            const ttft = opts.now() - startedAt;
            setTurn((t) => ({ ...t, phase: 'streaming', lastTtftMs: ttft }));
          } else {
            setTurn((t) => (t.phase === 'streaming' ? t : { ...t, phase: 'streaming' }));
          }
          break;
        }
        case 'retrying':
          setTurn((t) => ({ ...t, phase: 'retrying', retryUntil: opts.now() + e.seconds * 1000 }));
          break;
        case 'queue':
          setTurn((t) => ({ ...t, queued: e.size }));
          break;
        case 'turn-end':
          openTurn.current = undefined;
          flush();
          if (!sawTerminal) {
            const message = e.error ? describeError(e.error) : undefined;
            // An attach ended without the terminal: settle the resumed turn it left open.
            const settle = attaching ? settleOpenTurn : (s: BlockState) => s;
            setState((s) => endTurn(settle(s), e.outcome, message));
          }
          attaching = false;
          setTurn((t) => ({ ...t, phase: 'idle', startedAt: undefined, retryUntil: undefined }));
          onTurnEnd.current?.(e);
          break;
      }
    });

    return () => {
      off();
      clearInterval(timer);
    };
  }, [session]);

  const submit = useCallback(
    (text: string) => {
      if (!session) return;
      // Read busy before setState: React may run the updater after session.submit() below has
      // already flipped it, which would mis-tag this prompt as queued when it was actually sent.
      const queued = session.busy;
      setState((s) => addUser(s, text, queued));
      session.submit(text);
    },
    [session],
  );

  const resend = useCallback((text: string) => session?.submit(text, { resend: true }), [session]);

  const cancel = useCallback(() => session?.cancel(), [session]);

  const clearQueue = useCallback(() => {
    session?.clearQueue();
    setState((s) => ({ ...s, blocks: s.blocks.filter((b) => !(b.kind === 'user' && b.queued)) }));
  }, [session]);

  const lastReply = useCallback(() => {
    const blocks = stateRef.current.blocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'assistant' && b.text) return b.text;
    }
    return undefined;
  }, []);

  return { state, turn, usage, submit, resend, cancel, clearQueue, lastReply };
}
