import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, type CommandHost } from '../src/commands/builtin.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { DoctorOverlay } from '../src/views/overlays/Doctor.js';
import { HelpOverlay } from '../src/views/overlays/Help.js';
import { LeaveTurnOverlay } from '../src/views/overlays/LeaveTurn.js';
import { PaletteOverlay } from '../src/views/overlays/Palette.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const host = () =>
  ({
    hasSession: () => true,
    openOverlay: vi.fn(),
    newSession: vi.fn(),
    renameSession: vi.fn(),
    prefillInput: vi.fn(),
    toggleDetails: vi.fn(),
    toggleThinking: vi.fn(),
    copyLastReply: vi.fn(),
    exportTranscript: vi.fn(),
    composeInEditor: vi.fn(),
    cycleTheme: vi.fn(),
    notify: vi.fn(),
    quit: vi.fn(),
  }) as unknown as CommandHost & Record<string, ReturnType<typeof vi.fn>>;

const registry = new CommandRegistry(BUILTIN_COMMANDS);

describe('DoctorOverlay', () => {
  it('shows each check and the fix for the failing one, and re-runs on r', async () => {
    const run = vi.fn(async () => [
      { id: 1, name: 'control plane reachable', status: 'pass' as const },
      {
        id: 2,
        name: 'control plane ready',
        status: 'fail' as const,
        fix: 'the control plane is up but its session store (Redis) is down',
      },
    ]);
    const { lastFrame, stdin } = render(withTheme(<DoctorOverlay run={run} onClose={vi.fn()} />));
    // run() resolves asynchronously; wait on its rendered results (and for useInput's listener
    // to attach, per test/helpers/ink.ts) rather than a fixed tick before writing 'r'.
    await waitFor(
      () => (lastFrame() ?? '').includes('session store (Redis) is down') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('✓ 1 control plane reachable');
    expect(lastFrame()).toContain('✗ 2 control plane ready');
    expect(lastFrame()).toContain('session store (Redis) is down');
    stdin.write('r');
    await waitFor(() => run.mock.calls.length >= 2, 1000, lastFrame);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('DoctorOverlay onError', () => {
  it('offers a failed run to the host, and shows it only when the host declines', async () => {
    const err = new Error('boom');
    for (const handled of [true, false]) {
      const onError = vi.fn(() => handled);
      const { lastFrame, unmount } = render(
        withTheme(
          <DoctorOverlay run={() => Promise.reject(err)} onClose={vi.fn()} onError={onError} />,
        ),
      );
      await waitFor(() => onError.mock.calls.length > 0, 1000, lastFrame);
      expect(onError).toHaveBeenCalledWith(err);
      await waitFor(() => handled || (lastFrame() ?? '').includes('boom'), 1000, lastFrame);
      if (handled) expect(lastFrame()).not.toContain('boom');
      unmount();
    }
  });
});

describe('PaletteOverlay', () => {
  it('filters commands as you type and runs the chosen one after closing', async () => {
    const h = host();
    const onClose = vi.fn();
    const { stdin, lastFrame } = render(
      withTheme(<PaletteOverlay registry={registry} host={h} onClose={onClose} />),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('ctrl+x n') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('ctrl+x n');
    stdin.write('thinking');
    await waitFor(() => (lastFrame() ?? '').includes('Toggle thinking'), 1000, lastFrame);
    // Same SelectList instance (filtering as you type, no unmount), so no need to recheck
    // inputReady before Enter.
    stdin.write(KEY.enter);
    await waitFor(() => onClose.mock.calls.length > 0, 1000, lastFrame);
    expect(onClose).toHaveBeenCalled();
    expect(h.toggleThinking).toHaveBeenCalled();
  });
});

describe('HelpOverlay', () => {
  it('lists commands with slash names and keybinds, and the input keys', async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      withTheme(<HelpOverlay registry={registry} host={host()} onClose={onClose} />),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('/sessions, /resume') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('/sessions, /resume');
    expect(lastFrame()).toContain('ctrl+x l');
    expect(lastFrame()).toContain('alt+enter newline');
    stdin.write('x');
    await waitFor(() => onClose.mock.calls.length > 0, 1000, lastFrame);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('LeaveTurnOverlay', () => {
  it('k and ctrl+c keep, c cancels, esc stays', async () => {
    for (const [key, expected] of [
      ['k', 'keep'],
      ['\u0003', 'keep'],
      ['c', 'cancel'],
      ['\u001b', 'stay'],
    ] as const) {
      const got: string[] = [];
      const { stdin, lastFrame, unmount } = render(
        withTheme(
          <LeaveTurnOverlay
            onKeep={() => got.push('keep')}
            onCancel={() => got.push('cancel')}
            onStay={() => got.push('stay')}
          />,
        ),
      );
      // useInput attaches after the first paint (test/helpers/ink.ts); a key written earlier is lost.
      await waitFor(
        () => (lastFrame() ?? '').includes('a turn is running') && inputReady(stdin),
        1000,
        lastFrame,
      );
      stdin.write(key);
      await tick();
      expect(got).toEqual([expected]);
      unmount();
    }
  });
});
