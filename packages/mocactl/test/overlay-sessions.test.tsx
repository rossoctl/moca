import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/api/types.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { SessionsOverlay, sessionTitle } from '../src/views/overlays/Sessions.js';
import { fakeControlPlane } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0);
const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  owner: 'github:1',
  tenant: 't',
  createdAt: Date.UTC(2026, 8, 25, 9, 30),
  state: 'active',
  lastTurnAt: NOW - 3 * 3_600_000,
  turns: 4,
  ...over,
});

function setup() {
  const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-ov-')), {
    subject: 'github:1',
    controlPlaneUrl: 'http://cp',
  });
  transcripts.appendPrompt('aaaaaaaa-1', 'Fix the payment bug');
  const cp = fakeControlPlane({
    listSessions: async () => ({
      sessions: [
        summary('aaaaaaaa-1'),
        summary('bbbbbbbb-2', {
          turns: 1,
          configRef: `sha256:${'b'.repeat(64)}`,
          model: 'granite-4.1-8b',
        }),
      ],
      nextCursor: null,
    }),
  });
  const props = {
    onResume: vi.fn(),
    onNew: vi.fn(),
    onDeleted: vi.fn(),
    onCancel: vi.fn(),
    remove: vi.fn(async () => 'deleted'),
  };
  const r = render(
    withTheme(
      <SessionsOverlay
        cp={cp}
        transcripts={transcripts}
        now={() => NOW}
        currentSessionId="aaaaaaaa-1"
        {...props}
      />,
    ),
  );
  return { ...r, ...props, transcripts };
}

describe('sessionTitle', () => {
  it('falls back to creation time and a short id', () => {
    expect(sessionTitle(summary('bbbbbbbb-2'))).toBe('2026-09-25 09:30 · bbbbbbbb');
  });

  it('strips escape sequences from a title derived from a prompt, and from the id', () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-ov-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    transcripts.appendPrompt('s1', 'fix \u001b]2;pwned\u0007the \u001b[8mbug');
    expect(sessionTitle(summary('s1'), transcripts)).toBe('fix the bug');
    expect(sessionTitle(summary('\u001b[8mabcdefgh'))).toBe('2026-09-25 09:30 · abcdefgh');
  });
});

describe('SessionsOverlay', () => {
  it('lists sessions with titles, relative times, turn counts and markers', async () => {
    const { lastFrame } = setup();
    // cp.listSessions() resolves asynchronously; wait on the actual content the list renders
    // rather than a fixed tick, since under a loaded worker that resolution can take longer than
    // any small fixed number of ticks (see the helper's doc comment for the investigation).
    await waitFor(() => (lastFrame() ?? '').includes('Fix the payment bug'), 1000, lastFrame);
    const f = lastFrame()!;
    expect(f).toContain('Fix the payment bug');
    expect(f).toContain('3h ago · 4 turns · local history · current');
    expect(f).toContain('2026-09-25 09:30 · bbbbbbbb');
    expect(f).toContain('1 turn');
  });

  it('shows the sandbox tier a session runs in, and none for an untiered one (P6.3)', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => ({
        sessions: [
          summary('aaaaaaaa-1', { sandboxTier: 'microvm' }),
          summary('bbbbbbbb-2', { turns: 1, sandboxTier: null }),
        ],
        nextCursor: null,
      }),
    });
    const { lastFrame } = render(
      withTheme(
        <SessionsOverlay
          cp={cp}
          now={() => NOW}
          remove={vi.fn()}
          onResume={vi.fn()}
          onNew={vi.fn()}
          onDeleted={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('bbbbbbbb'), 1000, lastFrame);
    const f = lastFrame()!;
    expect(f).toContain('3h ago · 4 turns · microvm');
    expect(f).toMatch(/3h ago · 1 turn\s*$/m);
  });

  it('shows the sandbox template beside the tier (session-templates spec §6)', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => ({
        sessions: [
          summary('aaaaaaaa-1', { sandboxTier: 'microvm', sandboxTemplate: 'django-django-11133' }),
          summary('bbbbbbbb-2', { turns: 1, sandboxTier: 'microvm', sandboxTemplate: null }),
        ],
        nextCursor: null,
      }),
    });
    const { lastFrame } = render(
      withTheme(
        <SessionsOverlay
          cp={cp}
          now={() => NOW}
          remove={vi.fn()}
          onResume={vi.fn()}
          onNew={vi.fn()}
          onDeleted={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('bbbbbbbb'), 1000, lastFrame);
    const f = lastFrame()!;
    expect(f).toContain('4 turns · microvm · django-django-11133');
    expect(f).toMatch(/1 turn · microvm\s*$/m);
  });

  it('resumes the highlighted session on Enter', async () => {
    const { stdin, onResume, lastFrame } = setup();
    await waitFor(
      () => (lastFrame() ?? '').includes('Fix the payment bug') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write(KEY.down);
    await waitFor(
      () => (lastFrame() ?? '').includes('› 2026-09-25 09:30 · bbbbbbbb'),
      1000,
      lastFrame,
    );
    // Same List instance as above (cursor move only, no unmount/remount), so its useInput
    // listener is still the one already confirmed attached — no need to recheck inputReady.
    stdin.write(KEY.enter);
    await tick();
    // With its bundle digest and model, so the status line can show them once attached.
    expect(onResume).toHaveBeenCalledWith(
      'bbbbbbbb-2',
      `sha256:${'b'.repeat(64)}`,
      'granite-4.1-8b',
    );
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('deletes only after confirmation', async () => {
    const { stdin, remove, onDeleted, lastFrame } = setup();
    await waitFor(
      () => (lastFrame() ?? '').includes('Fix the payment bug') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('d');
    // 'd' swaps the list for a freshly-mounted Confirm. Its useInput attaches its own listener
    // on its own effect-flush schedule, independent of when the prompt text paints, so wait for
    // both before writing 'n'.
    await waitFor(
      () => (lastFrame() ?? '').includes('Delete "Fix') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('Delete "Fix the payment bug"?');
    stdin.write('n');
    await waitFor(() => !(lastFrame() ?? '').includes('Delete "Fix'), 1000, lastFrame);
    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').not.toContain('Delete "');
    // 'n' swaps Confirm back out for a freshly-mounted List — wait for its listener too before
    // writing the second 'd'.
    await waitFor(() => inputReady(stdin), 1000, lastFrame);
    stdin.write('d');
    await waitFor(
      () => (lastFrame() ?? '').includes('Delete "Fix') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('y');
    // Wait for the full async chain (remove().then(() => onDeleted(...))) to settle, not just
    // for `remove` to have been invoked.
    await waitFor(() => onDeleted.mock.calls.length > 0, 1000, lastFrame);
    expect(remove).toHaveBeenCalledWith('aaaaaaaa-1');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith('aaaaaaaa-1');
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('renames through a one-field form', async () => {
    const { stdin, transcripts, lastFrame } = setup();
    await waitFor(
      () => (lastFrame() ?? '').includes('Fix the payment bug') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('r');
    // 'r' swaps the list for a freshly-mounted Form; its useInput attaches on its own
    // effect-flush schedule, so wait for the listener as well as the heading before the burst.
    await waitFor(
      () => (lastFrame() ?? '').includes('Rename session') && inputReady(stdin),
      1000,
      lastFrame,
    );
    for (let i = 0; i < 30; i++) stdin.write(KEY.backspace);
    stdin.write('Payments');
    stdin.write(KEY.enter);
    await tick();
    expect(transcripts.load('aaaaaaaa-1')?.title).toBe('Payments');
    expect(lastFrame()).toContain('Payments');
  });

  it('starts a new session on n', async () => {
    const { stdin, onNew, lastFrame } = setup();
    await waitFor(
      () => (lastFrame() ?? '').includes('Fix the payment bug') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('n');
    await waitFor(() => onNew.mock.calls.length > 0, 1000, lastFrame);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('shows a load error', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => {
        throw new Error('boom');
      },
    });
    const { lastFrame } = render(
      withTheme(
        <SessionsOverlay
          cp={cp}
          now={() => NOW}
          remove={vi.fn()}
          onResume={vi.fn()}
          onNew={vi.fn()}
          onDeleted={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('boom'), 1000, lastFrame);
    expect(lastFrame()).toContain('boom');
  });
});
