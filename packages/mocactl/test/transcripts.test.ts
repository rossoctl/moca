import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptStore, deriveTitle } from '../src/core/transcripts.js';

const owner = { subject: 'github:1', controlPlaneUrl: 'http://cp' };
const store = (dir = mkdtempSync(join(tmpdir(), 'mocactl-tx-'))) => ({
  dir,
  s: new TranscriptStore(dir, owner, () => 1000),
});
const done = {
  type: 'done' as const,
  sessionId: 's1',
  stopReason: 'end_turn',
  usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 },
};

describe('TranscriptStore', () => {
  it('round-trips prompts and frames, merging consecutive text deltas', () => {
    const { s } = store();
    s.appendPrompt('s1', 'fix the bug');
    s.appendFrame('s1', { type: 'text', delta: 'Look' });
    s.appendFrame('s1', { type: 'text', delta: 'ing.' });
    s.appendFrame('s1', { type: 'tool_use', id: 't', name: 'bash', args: { command: 'ls' } });
    s.appendFrame('s1', done);
    const t = s.load('s1')!;
    expect(t.entries).toEqual([
      { kind: 'prompt', text: 'fix the bug' },
      { kind: 'frame', frame: { type: 'text', delta: 'Looking.' } },
      {
        kind: 'frame',
        frame: { type: 'tool_use', id: 't', name: 'bash', args: { command: 'ls' } },
      },
      { kind: 'frame', frame: done },
    ]);
    expect(t.prompts).toEqual(['fix the bug']);
  });

  it('titles a session from its first prompt only', () => {
    const { s } = store();
    s.appendPrompt('s1', 'first question');
    s.appendPrompt('s1', 'second question');
    expect(s.load('s1')).toMatchObject({ title: 'first question', titleSource: 'auto' });
  });

  it('a rename wins over the automatic title', () => {
    const { s } = store();
    s.appendPrompt('s1', 'first');
    s.rename('s1', 'My session');
    expect(s.load('s1')).toMatchObject({ title: 'My session', titleSource: 'user' });
  });

  it('sums usage across terminal frames', () => {
    const { s } = store();
    s.appendFrame('s1', done);
    s.appendFrame('s1', done);
    expect(s.load('s1')!.usage).toEqual({
      input: 20,
      output: 10,
      cacheRead: 4,
      cacheWrite: 0,
      total: 34,
      turns: 2,
    });
  });

  it('never loads another subject or control plane transcript', () => {
    const { dir, s } = store();
    s.appendPrompt('s1', 'secret plans');
    expect(new TranscriptStore(dir, { ...owner, subject: 'github:2' }).load('s1')).toBeNull();
    expect(
      new TranscriptStore(dir, { ...owner, controlPlaneUrl: 'http://other' }).load('s1'),
    ).toBeNull();
  });

  it('skips a torn trailing line', () => {
    const { dir, s } = store();
    s.appendPrompt('s1', 'hello');
    appendFileSync(join(dir, 's1.jsonl'), '{"kind":"frame","at":1,"frame":{"type":"te');
    expect(s.load('s1')!.entries).toEqual([{ kind: 'prompt', text: 'hello' }]);
    // The next process appends after the torn line without losing its first record to it.
    const next = new TranscriptStore(dir, owner);
    next.appendPrompt('s1', 'again');
    next.appendFrame('s1', { type: 'done', sessionId: 's1', stopReason: 'end_turn' });
    expect(next.load('s1')!.entries).toEqual([
      { kind: 'prompt', text: 'hello' },
      { kind: 'prompt', text: 'again' },
      { kind: 'frame', frame: { type: 'done', sessionId: 's1', stopReason: 'end_turn' } },
    ]);
  });

  it('writes 0600 files in a 0700 directory', () => {
    const { dir, s } = store(join(mkdtempSync(join(tmpdir(), 'mocactl-tx-')), 'transcripts'));
    s.appendPrompt('s1', 'x');
    expect(statSync(join(dir, 's1.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a session id that could escape the directory', () => {
    const { s } = store();
    expect(() => s.appendPrompt('../evil', 'x')).toThrow(/unsafe session id/);
  });

  it('delete removes the file and pending deltas', () => {
    const { s } = store();
    s.appendFrame('s1', { type: 'text', delta: 'pending' });
    s.delete('s1');
    expect(s.has('s1')).toBe(false);
    expect(s.load('s1')).toBeNull();
  });

  it('flush writes a pending text delta', () => {
    const { dir, s } = store();
    s.appendFrame('s1', { type: 'text', delta: 'partial' });
    s.flush('s1');
    expect(readFileSync(join(dir, 's1.jsonl'), 'utf8')).toContain('partial');
  });

  it('silently rejects writes to a foreign-owned file', () => {
    const { dir } = store();
    const storeA = new TranscriptStore(
      dir,
      { subject: 'github:1', controlPlaneUrl: 'http://cp' },
      () => 1000,
    );
    const storeB = new TranscriptStore(
      dir,
      { subject: 'github:2', controlPlaneUrl: 'http://cp' },
      () => 1000,
    );

    storeA.appendPrompt('s1', 'a secret');
    storeB.appendPrompt('s1', 'b secret');
    storeB.appendFrame('s1', { type: 'text', delta: 'b frame' });
    storeB.rename('s1', 'B Session');

    const tA = storeA.load('s1')!;
    expect(tA.prompts).toEqual(['a secret']);
    expect(tA.title).toBe('a secret');
    expect(tA.titleSource).toBe('auto');

    const content = readFileSync(join(dir, 's1.jsonl'), 'utf8');
    expect(content).not.toContain('b secret');
    expect(content).not.toContain('b frame');
    expect(content).not.toContain('B Session');
  });
});

describe('transcript frame ids', () => {
  it('records the turn and the last id, merging deltas under the last delta id', () => {
    const { s } = store();
    s.appendPrompt('s1', 'go');
    s.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    s.appendFrame('s1', { type: 'text', delta: 'a' }, 't1:2-0');
    s.appendFrame('s1', { type: 'text', delta: 'b' }, 't1:3-0');
    s.flush('s1');
    const t = s.load('s1')!;
    expect(t.entries).toEqual([
      { kind: 'prompt', text: 'go' },
      { kind: 'turn', turnId: 't1' },
      { kind: 'frame', frame: { type: 'text', delta: 'ab' }, eventId: 't1:3-0' },
    ]);
    expect(t.lastEventId).toBe('t1:3-0');
  });

  it('records a turn once even when a re-attach repeats its turn frame', () => {
    const { s } = store();
    s.appendPrompt('s1', 'go');
    s.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    s.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    expect(s.load('s1')!.entries.filter((e) => e.kind === 'turn')).toHaveLength(1);
  });

  it('records a turn once across store instances (a resumed process re-attaching)', () => {
    const { dir, s } = store();
    s.appendPrompt('s1', 'go');
    s.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    const again = new TranscriptStore(dir, owner, () => 1000);
    expect(again.load('s1')!.lastEventId).toBe('t1:1-0');
    again.appendFrame('s1', { type: 'turn', turnId: 't1', sessionId: 's1' }, 't1:1-0');
    expect(again.load('s1')!.entries.filter((e) => e.kind === 'turn')).toHaveLength(1);
  });

  it('loads a file written before ids existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-tx-'));
    writeFileSync(
      join(dir, 's1.jsonl'),
      [
        { kind: 'header', v: 1, createdAt: 1, ...owner },
        { kind: 'prompt', at: 1, text: 'go' },
        { kind: 'frame', at: 1, frame: { type: 'text', delta: 'x' } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const t = new TranscriptStore(dir, owner, () => 1).load('s1')!;
    expect(t.entries).toEqual([
      { kind: 'prompt', text: 'go' },
      { kind: 'frame', frame: { type: 'text', delta: 'x' } },
    ]);
    expect(t.lastEventId).toBeUndefined();
  });
});

describe('deriveTitle', () => {
  it('collapses whitespace and keeps short prompts whole', () => {
    expect(deriveTitle('  fix\n the   bug ')).toBe('fix the bug');
  });

  it('cuts long prompts on a word boundary with an ellipsis', () => {
    const t = deriveTitle(
      'refactor the session manager so that retries are observable in the status line',
    );
    expect(t.endsWith('…')).toBe(true);
    expect(Array.from(t).length).toBeLessThanOrEqual(51);
    expect(t).not.toMatch(/ …$/);
  });

  it('never splits an emoji', () => {
    const t = deriveTitle('🚀'.repeat(60));
    expect(Array.from(t.slice(0, -1)).every((c) => c === '🚀')).toBe(true);
  });
});
