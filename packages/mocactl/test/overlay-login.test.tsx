import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { LoginOverlay } from '../src/views/overlays/Login.js';
import { fakeControlPlane } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const waitForAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));

describe('LoginOverlay', () => {
  it('shows the code and URL, and copies the code on c', async () => {
    const copy = vi.fn();
    const deps = { cp: fakeControlPlane(), now: () => 0, sleep: waitForAbort };
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={deps}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
          copy={copy}
        />,
      ),
    );
    // deviceLogin()'s startDeviceAuth resolves asynchronously; wait on the rendered code rather
    // than a fixed tick — under a loaded worker that resolution can take longer than any small
    // fixed number of ticks. Also wait for inputReady: useInput's setRawMode(true) runs in a
    // later passive-effect tick than the commit that paints this content (see the helper's doc
    // comment), so a keystroke written right after the content check alone can be dropped.
    await waitFor(
      () => (lastFrame() ?? '').includes('ABCD-1234') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('ABCD-1234');
    expect(lastFrame()).toContain('https://github.com/login/device');
    expect(lastFrame()).toContain('code expires in 15m00s');
    stdin.write('c');
    await waitFor(() => copy.mock.calls.length > 0, 1000, lastFrame);
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('ignores ctrl+c: quitting is not copying the code', async () => {
    const copy = vi.fn();
    const deps = { cp: fakeControlPlane(), now: () => 0, sleep: waitForAbort };
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={deps}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
          copy={copy}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('ABCD-1234') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write(KEY.ctrl('c'));
    await tick(50);
    expect(copy).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('code copied');
  });

  it('shows the code and URL with escape sequences stripped, and copies the sanitized code', async () => {
    const copy = vi.fn();
    const hostileCode = 'ABCD\u001b[8m-1234';
    const hostileUri = 'https://github.com\u001b]52;c;ZXZpbA==\u0007/login/device';
    const cp = fakeControlPlane({
      startDeviceAuth: async () => ({
        deviceCode: 'd',
        userCode: hostileCode,
        verificationUri: hostileUri,
        interval: 5,
        expiresIn: 900,
      }),
    });
    const deps = { cp, now: () => 0, sleep: waitForAbort };
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={deps}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
          copy={copy}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('ABCD') && inputReady(stdin), 1000, lastFrame);
    expect(lastFrame()).not.toMatch(/\u001b|\u0007/);
    expect(lastFrame()).toContain('ABCD-1234');
    expect(lastFrame()).toContain('https://github.com/login/device');
    stdin.write('c');
    await waitFor(() => copy.mock.calls.length > 0, 1000, lastFrame);
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('swaps in a re-issued code when the first expires, and says why it changed', async () => {
    // #431: the overlay shows the second code with a fresh countdown, not a failure.
    let n = 0;
    const cp = fakeControlPlane({
      startDeviceAuth: async () => {
        n += 1;
        return {
          deviceCode: `d${n}`,
          userCode: `CODE-000${n}`,
          verificationUri: 'https://github.com/login/device',
          interval: 5,
          expiresIn: 900,
        };
      },
      pollDeviceAuth: async (dc) => (dc === 'd1' ? 'expired' : 'pending'),
    });
    let first = true;
    const sleep = (ms: number, signal?: AbortSignal) =>
      first ? ((first = false), Promise.resolve()) : waitForAbort(ms, signal);
    const { lastFrame, unmount } = render(
      withTheme(
        <LoginOverlay
          deps={{ cp, now: () => 0, sleep }}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(() => (lastFrame() ?? '').includes('CODE-0002'), 1000, lastFrame);
    expect(lastFrame()).not.toContain('CODE-0001');
    expect(lastFrame()).toContain('that code expired');
    expect(lastFrame()).toContain('code expires in 15m00s');
    unmount();
  });

  it('reports the login once approved', async () => {
    const onLoggedIn = vi.fn();
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => ({ token: 'api', subject: 'github:1', roles: [], expiresAt: 9 }),
    });
    render(
      withTheme(
        <LoginOverlay
          deps={{ cp, now: () => 0, sleep: async () => undefined }}
          controlPlaneUrl="http://cp"
          onLoggedIn={onLoggedIn}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(() => onLoggedIn.mock.calls.length > 0);
    expect(onLoggedIn).toHaveBeenCalledWith({
      apiToken: 'api',
      subject: 'github:1',
      roles: [],
      expiresAt: 9,
      controlPlaneUrl: 'http://cp',
      displayName: undefined,
    });
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
  });

  it('shows an error and retries on r', async () => {
    let starts = 0;
    const cp = fakeControlPlane({
      startDeviceAuth: async () => {
        starts++;
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={{ cp, now: () => 0, sleep: waitForAbort }}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(
      () =>
        (lastFrame() ?? '').includes('cannot reach the control plane: ECONNREFUSED') &&
        inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('cannot reach the control plane: ECONNREFUSED');
    stdin.write('r');
    await waitFor(() => starts >= 2, 1000, lastFrame);
    expect(starts).toBe(2);
  });

  it('cancels on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      withTheme(
        <LoginOverlay
          deps={{ cp: fakeControlPlane(), now: () => 0, sleep: waitForAbort }}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={onCancel}
        />,
      ),
    );
    // Writing Esc immediately on mount raced the same passive-effect lag as every other
    // keystroke here: useInput's listener isn't attached at the moment of mount, only some
    // ticks later, and an emit before that is dropped for good rather than queued.
    await waitFor(() => inputReady(stdin), 1000);
    stdin.write(KEY.escape);
    await tick(80);
    expect(onCancel).toHaveBeenCalled();
  });
});
