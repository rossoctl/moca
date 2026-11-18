import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * executeTurn's workspace marker (#338, option 2), driven turn by turn: a session's Pi log and Pi
 * itself are faked (the log persists across turns, as Redis would), and the sandbox is a transport
 * that runs every Exec under a real bash in a scratch directory standing in for the workspace. The
 * fake agent writes a file during its turn, as a session that clones a repository does.
 */
const { prompts, logs, selection, FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read() {
      return [];
    }
    async latestWhere() {
      return null;
    }
    async append() {
      return {};
    }
    async list() {
      return [];
    }
    async close() {}
  }
  return {
    prompts: [] as string[],
    logs: new Map<string, unknown[]>(),
    selection: { current: null as unknown },
    FakeRedisSessionBackend,
  };
});

/** What the fake agent does in its turn: set per test. */
let agentTurn: () => void = () => {};

vi.mock('@moca/session-backend', () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
  swallowRedisErrors: () => {},
}));
vi.mock('@earendil-works/pi-coding-agent', () => {
  const manager = (sid: string) => {
    const entries = logs.get(sid) ?? [];
    logs.set(sid, entries);
    return {
      getSessionId: () => sid,
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data?: unknown) => {
        entries.push({ type: 'custom', customType, data });
        return String(entries.length);
      },
    };
  };
  return {
    createAgentSession: async () => ({
      session: {
        prompt: async (p: string) => {
          prompts.push(p);
          agentTurn();
        },
        abort: () => {},
        state: { messages: [] },
      },
    }),
    DefaultResourceLoader: class {
      async reload() {}
    },
    getAgentDir: () => '/fake/agent-dir',
    SessionManager: {
      create: (_c: string, _s: unknown, opts?: { id: string }) => manager(opts?.id ?? 'sess-new'),
      openFromCheckpoint: async (sid: string) => manager(sid),
    },
    SettingsManager: { create: () => ({}) },
  };
});
vi.mock('../src/pre-prompt-compaction.js', () => ({ compactIfOverflowing: async () => false }));
vi.mock('../src/model-switch-record.js', () => ({ recordModelSwitch: () => false }));
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return { ...actual, selectPoolSandbox: async () => selection.current };
});

const { executeTurn } = await import('../src/run-turn.js');
const { WORKSPACE_MARKER, WORKSPACE_RESET_NOTE } = await import('../src/workspace-marker.js');

const dirs: string[] = [];
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'turn-marker-'));
  dirs.push(ws);
  prompts.length = 0;
  logs.clear();
  selection.current = null;
  agentTurn = () => writeFileSync(join(ws, 'work.txt'), 'x');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A relay transport stand-in: every Exec under bash; `fail` makes it throw instead. */
function bashTransport(opts: { fail?: boolean } = {}) {
  const commands: string[] = [];
  return {
    commands,
    fastTier: 'per-call-exec' as const,
    close: async () => {},
    exec: async (command: string) => {
      commands.push(command);
      if (opts.fail) throw new Error('relay unavailable');
      try {
        const stdout = execFileSync('bash', ['-c', command], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { stdout, exitCode: 0, truncated: false };
      } catch (e) {
        const err = e as { status: number };
        return { stdout: Buffer.from(''), exitCode: err.status, truncated: false };
      }
    },
  };
}

/** The idle reclaim: the worker deletes the directory, and the next Exec gets a fresh one. */
function reclaim() {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws);
}

async function turn(
  transport: ReturnType<typeof bashTransport>,
  opts: { workspace?: boolean; frames?: string[]; sid?: string } = {},
) {
  const frames: unknown[] = [];
  const result = await executeTurn({
    prompt: 'do the work',
    sessionId: opts.sid ?? 'sess-1',
    createIfAbsent: true,
    sandbox: {
      transport,
      podCwd: ws,
      sandboxId: 'sbx-1',
      ...(opts.workspace === false ? {} : { workspace: { key: opts.sid ?? 'sess-1', dir: ws } }),
    },
    onEvent: (f) => frames.push(f),
  });
  return { result, frames };
}

describe('executeTurn: the workspace marker (#338)', () => {
  it('marks the workspace, finds it intact, and reports a reclaim with a frame and a prompt note', async () => {
    const t = bashTransport();

    // Turn 1, a new session: nothing recorded, an empty workspace, marked once the agent wrote.
    const t1 = await turn(t);
    expect(t1.frames).toEqual([]);
    expect(prompts[0]).toBe('do the work');
    expect(t.commands).toHaveLength(2); // the start check, and the end-of-turn write

    // Turn 2: the marker is there. One Exec, no frame, the prompt as sent.
    const t2 = await turn(t);
    expect(t2.frames).toEqual([]);
    expect(prompts[1]).toBe('do the work');
    expect(t.commands).toHaveLength(3);

    // The session idles past SH_WORKSPACE_IDLE; the worker reclaims its workspace.
    reclaim();

    // Turn 3: recorded, missing. The frame first, the note before the prompt, then the rewrite.
    const t3 = await turn(t);
    expect(t3.frames).toEqual([
      {
        type: 'workspace_reset',
        sessionId: 'sess-1',
        from: 'sbx-1',
        tier: '',
        reason: 'reclaimed',
      },
    ]);
    expect(prompts[2]).toBe(`${WORKSPACE_RESET_NOTE}\n\ndo the work`);

    // Turn 4: marked again during turn 3, so intact.
    const t4 = await turn(t);
    expect(t4.frames).toEqual([]);
    expect(prompts[3]).toBe('do the work');
  });

  it('a session from before this change (no record) is never reported on its first turn', async () => {
    const t = bashTransport();
    writeFileSync(join(ws, 'old.txt'), 'x'); // files, but no marker and no record
    const { frames } = await turn(t);
    expect(frames).toEqual([]);
    expect(prompts[0]).toBe('do the work');
  });

  it('an Exec that fails does not fail the turn, and gives no verdict', async () => {
    const good = bashTransport();
    await turn(good);
    reclaim();
    const { result, frames } = await turn(bashTransport({ fail: true }));
    expect(result.stopReason).toBe('end_turn');
    expect(frames).toEqual([]);
    expect(prompts[1]).toBe('do the work');
  });

  it('runs no Exec at all when the sandbox has no session workspace (an empty workspace key)', async () => {
    const t = bashTransport();
    await turn(t, { workspace: false });
    reclaim();
    const { frames } = await turn(t, { workspace: false });
    expect(t.commands).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('a leased turn carries the reclaim in its placement, its frame and its result', async () => {
    const t = bashTransport();
    selection.current = {
      transport: t,
      podCwd: ws,
      sandboxId: 'sbx-1',
      tier: 'container',
      workspaceKey: 'sess-1',
      heartbeat: async () => {},
      release: async () => {},
    };
    const leased = async () => {
      const placements: unknown[] = [];
      const frames: unknown[] = [];
      const result = await executeTurn({
        prompt: 'do the work',
        sessionId: 'sess-1',
        createIfAbsent: true,
        onPlacement: (p) => placements.push(p),
        onEvent: (f) => frames.push(f),
      });
      return { placements, frames, result };
    };
    await leased();
    reclaim();
    const { placements, frames, result } = await leased();
    const reset = { from: 'sbx-1', reason: 'reclaimed' };
    expect(placements).toEqual([{ id: 'sbx-1', tier: 'container', workspaceReset: reset }]);
    expect(frames).toEqual([
      { type: 'workspace_reset', sessionId: 'sess-1', ...reset, tier: 'container' },
    ]);
    expect(result.sandbox).toEqual({ id: 'sbx-1', tier: 'container', workspaceReset: reset });
    expect(prompts[1]).toBe(`${WORKSPACE_RESET_NOTE}\n\ndo the work`);
  });

  it('a session that moved keeps its own reset reason, and the model is told as well', async () => {
    const t = bashTransport();
    writeFileSync(join(ws, WORKSPACE_MARKER), 'sess-1');
    logs.set('sess-1', [
      { type: 'custom', customType: 'workspace_marker', data: { key: 'sess-1', written: true } },
    ]);
    reclaim();
    selection.current = {
      transport: t,
      podCwd: ws,
      sandboxId: 'sbx-2',
      tier: 'container',
      workspaceKey: 'sess-1',
      workspaceReset: { from: 'sbx-1', reason: 'detached' },
      heartbeat: async () => {},
      release: async () => {},
    };
    const frames: unknown[] = [];
    await executeTurn({
      prompt: 'do the work',
      sessionId: 'sess-1',
      createIfAbsent: true,
      onEvent: (f) => frames.push(f),
    });
    expect(frames).toEqual([
      {
        type: 'workspace_reset',
        sessionId: 'sess-1',
        from: 'sbx-1',
        tier: 'container',
        reason: 'detached',
      },
    ]);
    expect(prompts[0]).toBe(`${WORKSPACE_RESET_NOTE}\n\ndo the work`);
  });
});
