import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarkerScript,
  checkWorkspaceMarker,
  decideWorkspaceMarker,
  parseMarkerOutput,
  recordedMarker,
  WORKSPACE_MARKER,
  WORKSPACE_MARKER_ENTRY,
} from '../src/workspace-marker.js';

/**
 * The workspace marker (#338, option 2): the decision, pure, and the script run under a real bash
 * against a scratch directory standing in for the session's workspace.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'marker-ws-'));
  dirs.push(d);
  return d;
};

/** Runs each command under bash, as a worker's Exec does, and returns what the transport would. */
const bash = {
  exec: async (command: string) => {
    try {
      const stdout = execFileSync('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, exitCode: 0, truncated: false };
    } catch (e) {
      const err = e as { status: number; stdout?: Buffer };
      return { stdout: err.stdout ?? Buffer.from(''), exitCode: err.status, truncated: false };
    }
  },
};

/** A Pi session log stand-in: the entries and the one append the marker uses. */
function fakeLog(entries: unknown[] = []) {
  return {
    entries,
    getEntries: () => entries,
    appendCustomEntry: (customType: string, data?: unknown) => {
      entries.push({ type: 'custom', customType, data });
      return String(entries.length);
    },
  };
}

describe('decideWorkspaceMarker', () => {
  it('no record: a first turn, recorded once the marker is written', () => {
    expect(decideWorkspaceMarker(false, { prev: 'absent', now: 'ours' })).toEqual({
      verdict: 'first',
      record: true,
      finishWrite: false,
    });
  });

  it('no record and nothing to mark yet: no record, and the end of the turn tries again', () => {
    expect(decideWorkspaceMarker(false, { prev: 'absent', now: 'none' })).toEqual({
      verdict: 'first',
      finishWrite: true,
    });
  });

  it('record and marker present: intact, nothing to do', () => {
    expect(decideWorkspaceMarker(true, { prev: 'ours', now: 'ours' })).toEqual({
      verdict: 'intact',
      finishWrite: false,
    });
  });

  it('record and marker missing: reset, nothing recorded yet, the rewrite left to the turn end', () => {
    // With a record the start only reads, so `now` is `none`: the end-of-turn write rewrites it.
    expect(decideWorkspaceMarker(true, { prev: 'absent', now: 'none' })).toEqual({
      verdict: 'reset',
      finishWrite: true,
    });
  });

  it("record and another session's marker: reset as well", () => {
    expect(decideWorkspaceMarker(true, { prev: 'other', now: 'none' })).toEqual({
      verdict: 'reset',
      finishWrite: true,
    });
  });

  it('an Exec error gives no verdict, records nothing and writes nothing', () => {
    for (const recorded of [false, true]) {
      expect(decideWorkspaceMarker(recorded, { error: 'unavailable' })).toEqual({
        verdict: 'unknown',
        finishWrite: false,
      });
    }
  });
});

describe('recordedMarker', () => {
  const rec = (key: string, written: boolean) => ({
    type: 'custom',
    customType: WORKSPACE_MARKER_ENTRY,
    data: { key, written },
  });

  it('is absent (false) for a session with no record: every session from before this change', () => {
    expect(recordedMarker(fakeLog([{ type: 'message' }]), 's-1')).toBe(false);
  });

  it('reads the latest record for the key, ignoring other keys and other entries', () => {
    const log = fakeLog([rec('s-1', true), rec('s-2', false), { type: 'custom', customType: 'x' }]);
    expect(recordedMarker(log, 's-1')).toBe(true);
    log.entries.push(rec('s-1', false));
    expect(recordedMarker(log, 's-1')).toBe(false);
  });
});

describe('buildMarkerScript, run for real', () => {
  const run = async (dir: string, key = 's-1', write = true) =>
    parseMarkerOutput(
      (await bash.exec(buildMarkerScript({ key, dir }, { write }))).stdout.toString(),
    );

  it('leaves an empty workspace empty, so the empty-directory sweep (#551) still removes it', async () => {
    const dir = scratch();
    expect(await run(dir)).toEqual({ prev: 'absent', now: 'none' });
    expect(existsSync(join(dir, WORKSPACE_MARKER))).toBe(false);
  });

  it('writes the key into a workspace that holds files, then finds it', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.txt'), 'x');
    expect(await run(dir)).toEqual({ prev: 'absent', now: 'ours' });
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe('s-1');
    expect(await run(dir)).toEqual({ prev: 'ours', now: 'ours' });
  });

  it('counts a dotfile, and a lone marker of another key is replaced once there are files', async () => {
    const dir = scratch();
    writeFileSync(join(dir, WORKSPACE_MARKER), 's-other');
    expect(await run(dir)).toEqual({ prev: 'other', now: 'none' });
    writeFileSync(join(dir, '.env'), 'x');
    expect(await run(dir)).toEqual({ prev: 'other', now: 'ours' });
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe('s-1');
  });

  it('keeps the marker out of a repository at the workspace root (info/exclude), once', async () => {
    const dir = scratch();
    execFileSync('git', ['init', '-q', dir]);
    writeFileSync(join(dir, 'app.py'), 'x');
    await run(dir);
    rmSync(join(dir, WORKSPACE_MARKER));
    await run(dir);
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === `/${WORKSPACE_MARKER}`)).toHaveLength(1);
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.split('\n').filter(Boolean)).toEqual(['?? app.py']);
  });

  it('without write, only reads: a workspace with files and no marker stays unmarked', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.txt'), 'x');
    expect(await run(dir, 's-1', false)).toEqual({ prev: 'absent', now: 'none' });
    expect(existsSync(join(dir, WORKSPACE_MARKER))).toBe(false);
    writeFileSync(join(dir, WORKSPACE_MARKER), 's-1');
    expect(await run(dir, 's-1', false)).toEqual({ prev: 'ours', now: 'ours' });
  });

  it('a git worktree (.git is a file): the marker goes in the shared info/exclude', async () => {
    const root = scratch();
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      });
    execFileSync('git', ['init', '-q', main]);
    writeFileSync(join(main, 'base'), 'x');
    git(main, 'add', '-A');
    git(main, 'commit', '-qm', 'base');
    git(main, 'worktree', 'add', '-q', wt);
    writeFileSync(join(wt, 'app.py'), 'x');
    expect(await run(wt)).toEqual({ prev: 'absent', now: 'ours' });
    expect(git(wt, 'status', '--porcelain').split('\n').filter(Boolean)).toEqual(['?? app.py']);
  });

  it('a workspace in a subdirectory of a repository gets an exclude line for its own path', async () => {
    const root = scratch();
    execFileSync('git', ['init', '-q', root]);
    const dir = join(root, 'sub');
    mkdirSync(dir);
    writeFileSync(join(dir, 'app.py'), 'x');
    await run(dir);
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '-uall'], {
      encoding: 'utf8',
    });
    expect(status.split('\n').filter(Boolean)).toEqual(['?? sub/app.py']);
  });

  it('a failing git (a broken .git file, or no git at all) is ignored: the marker is still written', async () => {
    const dir = scratch();
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/repo\n');
    writeFileSync(join(dir, 'app.py'), 'x');
    expect(await run(dir)).toEqual({ prev: 'absent', now: 'ours' });
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe('s-1');

    // No git on PATH (only what the write needs): `command -v git` fails, the step is skipped.
    const bin = scratch();
    for (const tool of ['mv', 'rm']) symlinkSync(`/bin/${tool}`, join(bin, tool));
    const bare = scratch();
    writeFileSync(join(bare, 'f'), 'x');
    const script = buildMarkerScript({ key: 's-1', dir: bare }, { write: true });
    const out = execFileSync('/bin/bash', ['-c', script], { env: { PATH: bin }, encoding: 'utf8' });
    expect(parseMarkerOutput(out)).toEqual({ prev: 'absent', now: 'ours' });
  });

  it('a missing workspace directory is an exit status, not output that parses', async () => {
    const res = await bash.exec(
      buildMarkerScript({ key: 's-1', dir: join(scratch(), 'gone') }, { write: true }),
    );
    expect(res.exitCode).toBe(90);
  });

  it('quotes the directory and the key for the shell', async () => {
    const dir = join(scratch(), "it's here");
    mkdirSync(dir);
    writeFileSync(join(dir, 'f'), 'x');
    expect(await run(dir, "k'1")).toEqual({ prev: 'absent', now: 'ours' });
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe("k'1");
  });

  it('refuses output it does not recognize', () => {
    expect(parseMarkerOutput('')).toHaveProperty('error');
    expect(parseMarkerOutput('ours maybe')).toHaveProperty('error');
  });
});

describe('checkWorkspaceMarker', () => {
  it('a first turn on an empty workspace marks it at the end of the turn, once files exist', async () => {
    const dir = scratch();
    const log = fakeLog();
    const check = await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    expect(check.verdict).toBe('first');
    expect(log.entries).toEqual([]);
    writeFileSync(join(dir, 'cloned'), 'x'); // the agent's turn
    await check.finish();
    expect(log.entries).toEqual([
      { type: 'custom', customType: WORKSPACE_MARKER_ENTRY, data: { key: 's-1', written: true } },
    ]);
    // The next turn finds it.
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'intact',
    );
  });

  it('reports a reset when the recorded marker is gone, and logs it; the turn end rewrites it', async () => {
    const dir = scratch();
    const log = fakeLog();
    writeFileSync(join(dir, 'f'), 'x');
    await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    rmSync(dir, { recursive: true });
    mkdirSync(dir); // the worker's fresh directory for the key
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    expect(check.verdict).toBe('reset');
    expect(warn.mock.calls[0]?.[0]).toMatch(/no longer carries its marker \(absent\)/);
    writeFileSync(join(dir, 'again'), 'x'); // the agent's turn
    await check.finish();
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe('s-1');
    expect(log.entries).toHaveLength(1); // still `written: true`: nothing to record
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'intact',
    );
  });

  it('a reset turn that never reaches its end leaves the marker missing: the next turn reports it again', async () => {
    const dir = scratch();
    const log = fakeLog();
    writeFileSync(join(dir, 'f'), 'x');
    await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    rmSync(join(dir, WORKSPACE_MARKER));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The start only read: no write, no record, even though the workspace still holds files.
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'reset',
    );
    expect(existsSync(join(dir, WORKSPACE_MARKER))).toBe(false);
    // finish() not called: the turn failed before the agent ran.
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'reset',
    );
  });

  it('an intact turn that fails leaves the marker in place: no false reset next turn', async () => {
    const dir = scratch();
    const log = fakeLog();
    writeFileSync(join(dir, 'f'), 'x');
    await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    const check = await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    expect(check.verdict).toBe('intact');
    // No finish(): the turn failed. The check itself never removed anything.
    expect(readFileSync(join(dir, WORKSPACE_MARKER), 'utf8')).toBe('s-1');
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'intact',
    );
  });

  it('a reset into a workspace the turn leaves empty records written=false, so it is reported once', async () => {
    const dir = scratch();
    const log = fakeLog();
    writeFileSync(join(dir, 'f'), 'x');
    await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1');
    expect(check.verdict).toBe('reset');
    await check.finish(); // the agent wrote nothing
    expect(existsSync(join(dir, WORKSPACE_MARKER))).toBe(false);
    expect(recordedMarker(log, 's-1')).toBe(false);
    expect((await checkWorkspaceMarker(bash, { key: 's-1', dir }, log, 'sbx-1')).verdict).toBe(
      'first',
    );
  });

  it('an Exec that throws gives no verdict, records nothing, and its finish does nothing', async () => {
    const log = fakeLog([
      { type: 'custom', customType: WORKSPACE_MARKER_ENTRY, data: { key: 's-1', written: true } },
    ]);
    const exec = vi.fn(async () => {
      throw new Error('relay unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = await checkWorkspaceMarker({ exec }, { key: 's-1', dir: '/w' }, log, 'sbx-1');
    expect(check.verdict).toBe('unknown');
    await check.finish();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(log.entries).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/check failed \(relay unavailable\); no verdict/);
  });

  it('costs one Exec per turn once the workspace is marked', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'f'), 'x');
    const log = fakeLog();
    const exec = vi.fn(bash.exec);
    for (let i = 0; i < 3; i++) {
      const check = await checkWorkspaceMarker({ exec }, { key: 's-1', dir }, log, 'sbx-1');
      await check.finish();
    }
    expect(exec).toHaveBeenCalledTimes(3);
    expect(log.entries).toHaveLength(1);
  });
});
