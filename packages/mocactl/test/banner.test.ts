import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../src/api/control-plane.js';
import { DiscoveringHarness, discoverHarnessUrl } from '../src/api/discovery.js';
import { collectBannerInfo, displayCwd } from '../src/core/banner.js';
import { VERSION } from '../src/version.js';

describe('displayCwd', () => {
  it('folds the home directory to ~', () => {
    expect(displayCwd('/home/paolo/work/moca', '/home/paolo')).toBe('~/work/moca');
  });

  it('is exactly ~ at home itself', () => {
    expect(displayCwd('/home/paolo', '/home/paolo')).toBe('~');
  });

  it('leaves a path outside home alone', () => {
    expect(displayCwd('/tmp/x', '/home/paolo')).toBe('/tmp/x');
  });

  it('does not fold a lookalike prefix', () => {
    expect(displayCwd('/home/paolo2/x', '/home/paolo')).toBe('/home/paolo2/x');
  });
});

describe('collectBannerInfo', () => {
  const base = { cwd: '/home/paolo/w', home: '/home/paolo' };

  it('collects both remote versions and folds the cwd', async () => {
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => ({ harnessUrl: 'http://h', version: '0.5.1' }) },
        harness: { health: async () => ({ version: '0.5.0' }) },
      },
      base,
    );
    expect(info).toEqual({
      // The build-time version (`dev` under vitest), so the banner agrees with `--version`.
      mocactlVersion: VERSION,
      cpVersion: '0.5.1',
      harnessVersion: '0.5.0',
      cwd: '~/w',
    });
  });

  it('reports unknown versions for an old control plane and an old harness', async () => {
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => ({ harnessUrl: 'http://h', version: null }) },
        harness: { health: async () => ({}) },
      },
      base,
    );
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
  });

  it('leaves a version unknown when its call fails', async () => {
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => Promise.reject(new Error('down')) },
        harness: { health: async () => ({ version: '0.5.0' }) },
      },
      base,
    );
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBe('0.5.0');
  });

  it('stops waiting on a slow network rather than holding the banner back', async () => {
    const never = () => new Promise<never>(() => {});
    const info = await collectBannerInfo(
      { cp: { discovery: never }, harness: { health: never } },
      { ...base, timeoutMs: 20 },
    );
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
  });

  it('runs with nothing configured', async () => {
    const info = await collectBannerInfo({}, base);
    expect(info).toEqual({ mocactlVersion: VERSION, cwd: '~/w' });
  });

  it('sanitizes a remote version before it can reach the terminal', async () => {
    // An OSC 52 clipboard-write sequence smuggled through the version string must not survive
    // into terminal output (the same defense every other remote string gets).
    const evil = '0.5.2\x1b]52;c;aGVsbG8=\x07';
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => ({ harnessUrl: 'http://h', version: evil }) },
        harness: { health: async () => ({ version: evil }) },
      },
      base,
    );
    expect(info.cpVersion).toBe('0.5.2');
    expect(info.harnessVersion).toBe('0.5.2');
  });

  it('caps a remote version at 64 characters', async () => {
    const long = 'v'.repeat(100);
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => ({ harnessUrl: 'http://h', version: long }) },
        harness: { health: async () => ({ version: long }) },
      },
      base,
    );
    expect(info.cpVersion).toBe('v'.repeat(64));
    expect(info.harnessVersion).toBe('v'.repeat(64));
  });

  it('treats a version that sanitizes to nothing as unknown', async () => {
    const info = await collectBannerInfo(
      {
        cp: { discovery: async () => ({ harnessUrl: 'http://h', version: '\x1b]52;c;bw==\x07' }) },
        harness: { health: async () => ({ version: '\x07\x07' }) },
      },
      base,
    );
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
  });

  it('aborts the version fetches when the timeout gives up on them', async () => {
    // mocactl exits via process.exitCode, so a fetch left running would hold the process alive.
    const signals: Array<AbortSignal | undefined> = [];
    const hang = (opts?: { signal?: AbortSignal }) => {
      signals.push(opts?.signal);
      return new Promise<never>(() => {});
    };
    const info = await collectBannerInfo(
      { cp: { discovery: hang }, harness: { health: hang } },
      { ...base, timeoutMs: 20 },
    );
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
  });

  it('aborts the version fetches when the caller abandons the banner', async () => {
    // A fetch that respects its signal rejects on abort; the fake mirrors that.
    const signals: Array<AbortSignal | undefined> = [];
    const hang = (opts?: { signal?: AbortSignal }) => {
      signals.push(opts?.signal);
      return new Promise<never>((_, reject) =>
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    };
    const caller = new AbortController();
    const pending = collectBannerInfo(
      { cp: { discovery: hang }, harness: { health: hang } },
      { ...base, signal: caller.signal },
    );
    caller.abort(); // the app unmounts while the calls are in flight
    const info = await pending;
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
  });

  it('aborts the discovery behind an unresolved harness health probe', async () => {
    // The harness client finds its URL through the control plane on first use; that inner
    // discovery fetch must die with the banner too, or a hung control plane leaves a socket
    // holding the process alive after the UI is gone.
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).endsWith('/v1/discovery')) {
        signals.push(init.signal ?? undefined);
        return new Promise<Response>(() => {});
      }
      return new Response('ok');
    }) as typeof fetch;
    const cp = new ControlPlaneClient('http://cp', () => 't', fetchImpl);
    const harness = new DiscoveringHarness(
      (signal) => discoverHarnessUrl(cp, { signal }),
      fetchImpl,
    );
    const info = await collectBannerInfo({ cp, harness }, { ...base, timeoutMs: 20 });
    expect(info.cpVersion).toBeUndefined();
    expect(info.harnessVersion).toBeUndefined();
    expect(signals.length).toBeGreaterThanOrEqual(2); // the banner's own read + health's
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });
});
