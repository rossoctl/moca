// Mirrors harness/src/turn-stream.ts's TurnStreamFrame. Redeclared, not imported (spec §3.1);
// test/contract.test.ts keeps the two in step.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type AbortReason = 'cancelled' | 'unwatched' | 'restarting' | 'lease_lost' | 'owner_lost';

/** Detachable turns only: the first frame, naming the turn later frame ids belong to. */
export type TurnStartFrame = {
  type: 'turn';
  turnId: string;
  sessionId: string;
  truncated?: boolean;
};
export type TextFrame = { type: 'text'; delta: string };
export type ThinkingFrame = { type: 'thinking'; delta: string };
export type ToolUseFrame = { type: 'tool_use'; id: string; name: string; args: unknown };
export type ToolResultFrame = {
  type: 'tool_result';
  id: string;
  isError: boolean;
  preview: string;
};
export type DoneFrame = { type: 'done'; sessionId: string; stopReason: string; usage?: Usage };
export type ErrorFrame = {
  type: 'error';
  sessionId: string;
  stopReason: string;
  errorMessage?: string;
  usage?: Usage;
  abortReason?: AbortReason;
};
export type WorkspaceResetFrame = {
  type: 'workspace_reset';
  sessionId: string;
  from: string;
  tier: string;
  reason: 'detached' | 'retiered';
};
export type UnknownFrame = { type: 'unknown'; event: string; data: unknown };

export type TurnFrame =
  | TurnStartFrame
  | TextFrame
  | ThinkingFrame
  | ToolUseFrame
  | ToolResultFrame
  | WorkspaceResetFrame
  | DoneFrame
  | ErrorFrame
  | UnknownFrame;

export const KNOWN_FRAME_TYPES = [
  'turn',
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'workspace_reset',
  'done',
  'error',
] as const;

export function isTerminal(f: TurnFrame): f is DoneFrame | ErrorFrame {
  return f.type === 'done' || f.type === 'error';
}
