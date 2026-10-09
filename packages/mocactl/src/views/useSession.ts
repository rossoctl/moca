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

  // Resets when the session or its initial snapshot changes (a session swap must not carry over
  // another session's blocks/usage/turn state); opts.initialUsage is deliberately not a
  // dependency — it seeds state alongside opts.initial rather than on every render.
  useEffect(() => {
    setState(opts.initial);
    setUsage(opts.initialUsage ?? ZERO);
    setTurn({ phase: 'idle', queued: 0 });
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
          setState((s) => markSent(s));
          setTurn((t) => ({ ...t, phase: 'waiting', startedAt }));
          break;
        case 'attach-start':
          startedAt = opts.now();
          firstFrame = false; // a catch-up has no time-to-first-token
          sawTerminal = false;
          setTurn((t) => ({ ...t, phase: 'waiting', startedAt }));
          break;
        case 'attach-none':
          if (e.missed) setState((s) => addNotice(s, INTERRUPTED_TURN_NOTICE, 'warning'));
          setTurn((t) => ({ ...t, phase: 'idle', startedAt: undefined }));
          break;
        case 'notice':
          flush();
          setState((s) => addNotice(s, e.text, e.tone));
          break;
        case 'frame': {
          const f = e.frame;
          if (f.type === 'text' || f.type === 'thinking') pending.push(f);
          else {
            flush();
            setState((s) => reduceFrame(s, f));
          }
          if (isTerminal(f)) {
            sawTerminal = true;
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
          flush();
          if (!sawTerminal) {
            const message = e.error ? describeError(e.error) : undefined;
            setState((s) => endTurn(s, e.outcome, message));
          }
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
