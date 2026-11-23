import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import {
  DIAGNOSTIC_NAMES,
  formatDiagnostics,
  runDiagnostics,
  type DiagnosticsDeps,
} from '../src/core/diagnostics.js';
import { credential, fakeControlPlane, fakeHarness } from './helpers/fakes.js';

const deps = (over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps => ({
  cp: fakeControlPlane({ listCredentials: async () => [credential('anthropic')] }),
  harness: fakeHarness([]),
  controlPlaneUrl: 'http://cp',
  harnessOverridden: false,
  loggedIn: true,
  ...over,
});

describe('runDiagnostics', () => {
  it('passes all seven checks on a healthy setup and deletes the scratch session', async () => {
    const d = deps();
    const results = await runDiagnostics(d);
    expect(results.map((r) => r.status)).toEqual(Array(7).fill('pass'));
    expect(results.map((r) => r.name)).toEqual([...DIAGNOSTIC_NAMES]);
    const calls = (d.cp as unknown as { calls: string[] }).calls;
    expect(calls).toContain('createSession');
    expect(calls).toContain('deleteSession');
  });

  it('stops at the first failure with a fix naming the URL', async () => {
    const d = deps({
      cp: fakeControlPlane({
        healthz: async () => {
          throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
        },
      }),
    });
    const results = await runDiagnostics(d);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 1, status: 'fail', detail: 'ECONNREFUSED' });
    expect(results[0].fix).toContain('http://cp');
  });

  it('fails the login check without calling /v1/me when there is no cached login', async () => {
    const d = deps({ loggedIn: false });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 3, status: 'fail', detail: 'no cached login' });
    expect(results.at(-1)?.fix).toBe(
      'not logged in — run `mocactl login`, or start `mocactl harness` to log in',
    );
    expect((d.cp as unknown as { calls: string[] }).calls).not.toContain('me');
  });

  // #529: there IS a login, for another control plane. Saying so is what stops the user logging in
  // again and overwriting it -- the loop the issue was reported as.
  it('names the other control plane when the cached login is not for this one (#529)', async () => {
    const results = await runDiagnostics(deps({ loggedIn: false, storedLoginUrl: 'http://cp-a' }));
    const login = results.at(-1);
    expect(login).toMatchObject({ id: 3, status: 'fail' });
    expect(login?.detail).toContain('http://cp-a');
    expect(login?.detail).toContain('http://cp');
    expect(login?.fix).toContain('http://cp-a');
    expect(login?.fix).toContain('mocactl login');
  });

  it('fails check 4 when only non-inference credentials exist', async () => {
    const results = await runDiagnostics(
      deps({
        cp: fakeControlPlane({
          listCredentials: async () => [credential('gh', { consumer: 'sandbox-egress' })],
        }),
      }),
    );
    expect(results.at(-1)).toMatchObject({ id: 4, status: 'fail' });
    expect(results.at(-1)!.fix).toMatch(/\/credentials/);
  });

  it('reports an untrusted harness with the settings it needs, and still cleans up', async () => {
    const d = deps({ harness: fakeHarness([], { probeTrust: async () => 'untrusted' }) });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 7, status: 'fail' });
    expect(results.at(-1)!.fix).toContain('SH_SESSION_TOKEN_PUBLIC_KEYS');
    // On the VM path the exchange token is a systemd credential setup-vm.sh writes, never an env line.
    expect(results.at(-1)!.fix).toContain('sudo ./deploy/vm/setup-vm.sh');
    expect(results.at(-1)!.fix).not.toContain('SH_EXCHANGE_TOKEN');
    expect((d.cp as unknown as { calls: string[] }).calls).toContain('deleteSession');
  });

  it('cleans up the scratch session even when the probe throws', async () => {
    const d = deps({
      harness: fakeHarness([], {
        probeTrust: async () => {
          throw new Error('boom');
        },
      }),
    });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 7, status: 'fail', detail: 'boom' });
    expect((d.cp as unknown as { calls: string[] }).calls).toContain('deleteSession');
  });
});

describe('harness location', () => {
  it('says where the harness was found, and that the control plane advertised it', async () => {
    const results = await runDiagnostics(deps());
    expect(results[4]).toMatchObject({
      id: 5,
      name: 'harness located',
      status: 'pass',
      detail: 'http://h (advertised by the control plane)',
    });
  });

  it('labels a local override as one', async () => {
    const results = await runDiagnostics(deps({ harnessOverridden: true }));
    expect(results[4]!.detail).toBe('http://h (local override)');
  });

  it('stops at check 5 with discovery`s own fix when the harness cannot be located', async () => {
    const harness = fakeHarness([], {
      baseUrl: async () => {
        throw new ApiError(
          'control-plane',
          404,
          'harness_unadvertised',
          'set SH_PUBLIC_HARNESS_URL',
        );
      },
    });
    const results = await runDiagnostics(deps({ harness }));
    expect(results).toHaveLength(5);
    expect(results.at(-1)).toMatchObject({
      id: 5,
      status: 'fail',
      fix: 'set SH_PUBLIC_HARNESS_URL',
    });
  });

  it('points an unreachable advertised harness at the control plane`s setting', async () => {
    const harness = fakeHarness([], {
      health: async () => {
        throw new ApiError('harness', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const results = await runDiagnostics(deps({ harness }));
    expect(results.at(-1)).toMatchObject({ id: 6, status: 'fail' });
    expect(results.at(-1)!.fix).toBe(
      'cannot reach the harness at http://h — check SH_PUBLIC_HARNESS_URL on the control plane, or pass --harness-url',
    );
    const overridden = await runDiagnostics(deps({ harness, harnessOverridden: true }));
    expect(overridden.at(-1)!.fix).toBe(
      'cannot reach the harness at http://h — check --harness-url',
    );
  });
});

describe('formatDiagnostics', () => {
  it('renders one line per check', () => {
    expect(
      formatDiagnostics([
        { id: 1, name: 'control plane reachable', status: 'pass' },
        { id: 2, name: 'control plane ready', status: 'fail', fix: 'start Redis' },
      ]),
    ).toBe('✓ 1 control plane reachable\n✗ 2 control plane ready — start Redis');
  });

  it('appends what a passing check found', () => {
    expect(
      formatDiagnostics([
        { id: 5, name: 'harness located', status: 'pass', detail: 'http://h (local override)' },
      ]),
    ).toBe('✓ 5 harness located — http://h (local override)');
  });
});
