import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadAuth, saveAuth } from '../src/config.js';
import { buildRuntime } from '../src/runtime.js';

// The real ControlPlaneClient wired by buildRuntime, over a fetch that rejects every API token but
// the refreshed one: a TUI left open past the 15-minute token (B14).
function rig() {
  const seen: string[] = [];
  let refreshes = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    seen.push(`${url} ${auth}`);
    if (url === 'http://cp/v1/auth/token') {
      refreshes++;
      return Response.json({
        token: 'api-new',
        subject: 'github:1',
        roles: [],
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        refreshToken: 'mrt_new',
      });
    }
    if (url.startsWith('http://cp/v1/sessions')) {
      return auth === 'Bearer api-new'
        ? Response.json({ sessions: [], nextCursor: null })
        : Response.json({ error: 'token_expired' }, { status: 401 });
    }
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }) as typeof fetch;
  const home = mkdtempSync(join(tmpdir(), 'mocactl-rt-auth-'));
  const env = { SH_CONTROL_PLANE_URL: 'http://cp', SH_HARNESS_URL: 'http://h' };
  const rt0 = buildRuntime({}, env, home, fetchImpl);
  saveAuth(rt0.paths, {
    apiToken: 'api-old', // still fresh by its own clock, but the control plane says otherwise
    subject: 'github:1',
    roles: [],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    controlPlaneUrl: 'http://cp',
    refreshToken: 'mrt_old',
  });
  const rt = buildRuntime({}, env, home, fetchImpl);
  return { rt, seen, refreshes: () => refreshes };
}

describe('the runtime control-plane client on a rejected token', () => {
  it('refreshes once and retries, and the new pair is on disk', async () => {
    const { rt, refreshes } = rig();
    await expect(rt.cp!.listSessions()).resolves.toEqual({ sessions: [], nextCursor: null });
    expect(refreshes()).toBe(1);
    expect(rt.auth?.apiToken).toBe('api-new');
    expect(loadAuth(rt.paths, 'http://cp')).toMatchObject({ refreshToken: 'mrt_new' });
  });

  it('several requests rejected at once spend the refresh token once', async () => {
    const { rt, refreshes } = rig();
    await Promise.all([rt.cp!.listSessions(), rt.cp!.listSessions(), rt.cp!.listSessions()]);
    expect(refreshes()).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)(
    'when the refresh cannot even start, surfaces the original 401, not the refresh failure',
    async () => {
      const { rt, refreshes } = rig();
      chmodSync(rt.paths.configDir, 0o500); // the lock cannot be created: EACCES
      onTestFinished(() => chmodSync(rt.paths.configDir, 0o700));
      await expect(rt.cp!.listSessions()).rejects.toMatchObject({ code: 'token_expired' });
      expect(refreshes()).toBe(0);
    },
  );
});
