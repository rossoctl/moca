import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import type { ApiLogin } from '../src/api/types.js';
import { ensureAuth, type EnsureDeps } from '../src/auth-refresh.js';
import { authLockPath, loadAuth, resolvePaths, saveAuth, type CachedAuth } from '../src/config.js';

const CP = 'http://cp';
const NOW = 1_800_000_000_000;
const S = (ms: number) => Math.floor(ms / 1000);

function setup(
  over: Partial<CachedAuth> | null = {},
  refreshAuth?: EnsureDeps['cp']['refreshAuth'],
) {
  const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-refresh-')));
  if (over !== null) {
    saveAuth(paths, {
      apiToken: 'api-old',
      subject: 'github:1',
      roles: [],
      expiresAt: S(NOW) - 60, // expired a minute ago
      controlPlaneUrl: CP,
      refreshToken: 'mrt_old',
      refreshExpiresAt: S(NOW) + 80 * 86_400,
      ...over,
    });
  }
  const calls: string[] = [];
  let now = NOW;
  const deps: EnsureDeps = {
    paths,
    controlPlaneUrl: CP,
    cp: {
      refreshAuth:
        refreshAuth ??
        (async (t) => {
          calls.push(t);
          return next();
        }),
    },
    now: () => now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    lockWaitMs: 500,
  };
  return { paths, deps, calls, advance: (ms: number) => void (now += ms) };
}

const next = (): ApiLogin => ({
  token: 'api-new',
  subject: 'github:1',
  roles: [],
  expiresAt: S(NOW) + 900,
  refreshToken: 'mrt_new',
  refreshExpiresAt: S(NOW) + 80 * 86_400,
});

describe('ensureAuth', () => {
  it('returns a token with more than a minute left without touching the network', async () => {
    const { deps, calls } = setup({ expiresAt: S(NOW) + 600 });
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-old' } });
    expect(calls).toEqual([]);
  });

  it('refreshes an expired token and writes the new pair, mode 0600, before returning it', async () => {
    const { deps, paths, calls } = setup();
    const r = await ensureAuth(deps);
    expect(r).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-new', refreshToken: 'mrt_new' } });
    expect(calls).toEqual(['mrt_old']);
    expect(loadAuth(paths, CP)).toMatchObject({ apiToken: 'api-new', refreshToken: 'mrt_new' });
    expect(statSync(paths.authFile).mode & 0o777).toBe(0o600);
    expect(existsSync(authLockPath(paths))).toBe(false); // released
  });

  it('refreshes a token inside the one-minute margin, so a request never leaves with a dying one', async () => {
    const { deps, calls } = setup({ expiresAt: S(NOW) + 30 });
    expect((await ensureAuth(deps)).kind).toBe('ok');
    expect(calls).toEqual(['mrt_old']);
  });

  it('force refreshes even a fresh token (the 401 path)', async () => {
    const { deps, calls } = setup({ expiresAt: S(NOW) + 600 });
    expect(await ensureAuth(deps, { force: true })).toMatchObject({
      kind: 'ok',
      auth: { apiToken: 'api-new' },
    });
    expect(calls).toEqual(['mrt_old']);
  });

  it('on invalid_grant, forgets the refresh token and asks for a login', async () => {
    const { deps, paths } = setup({}, async () => {
      throw new ApiError('control-plane', 400, 'invalid_grant');
    });
    expect(await ensureAuth(deps)).toEqual({ kind: 'login_required' });
    expect(loadAuth(paths, CP)).not.toHaveProperty('refreshToken');
  });

  it('when the control plane is unreachable, says so and keeps both tokens on disk', async () => {
    const { deps, paths } = setup({}, async () => {
      throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
    });
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'unreachable' });
    expect(loadAuth(paths, CP)).toMatchObject({ apiToken: 'api-old', refreshToken: 'mrt_old' });
  });

  it('old cache without refreshToken: still valid is used, expired asks for a login (Review Focus 1)', async () => {
    const fresh = setup({ refreshToken: undefined, expiresAt: S(NOW) + 600 });
    expect((await ensureAuth(fresh.deps)).kind).toBe('ok');
    const stale = setup({ refreshToken: undefined });
    expect(await ensureAuth(stale.deps)).toEqual({ kind: 'login_required' });
    expect(stale.calls).toEqual([]);
  });

  it('never sends a refresh token to another control plane (Review Focus 2)', async () => {
    const { deps, calls } = setup({ controlPlaneUrl: 'http://other-cp' });
    expect(await ensureAuth(deps)).toEqual({ kind: 'login_required' });
    expect(calls).toEqual([]);
  });

  it('no cache at all asks for a login', async () => {
    const { deps } = setup(null);
    expect(await ensureAuth(deps)).toEqual({ kind: 'login_required' });
  });

  it('two concurrent ensureAuth calls refresh once, and both get the new token (Review Focus 5)', async () => {
    let n = 0;
    const { deps } = setup({}, async () => {
      n++;
      await new Promise((r) => setTimeout(r, 80)); // hold the lock while the other one waits
      return next();
    });
    const [a, b] = await Promise.all([ensureAuth(deps), ensureAuth(deps)]);
    expect(n).toBe(1);
    expect(a).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-new' } });
    expect(b).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-new' } });
  });

  it('three concurrent forced refreshes (several in-flight 401s) spend the refresh token once', async () => {
    let n = 0;
    const { deps } = setup({ expiresAt: S(NOW) + 600 }, async () => {
      n++;
      await new Promise((r) => setTimeout(r, 80));
      return next();
    });
    const rs = await Promise.all([1, 2, 3].map(() => ensureAuth(deps, { force: true })));
    expect(n).toBe(1);
    for (const r of rs) expect(r).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-new' } });
  });

  it('breaks a stale lock left by a killed process (Review Focus 5)', async () => {
    const { deps, paths, calls } = setup();
    writeFileSync(authLockPath(paths), '');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(authLockPath(paths), old, old);
    expect((await ensureAuth(deps)).kind).toBe('ok');
    expect(calls).toEqual(['mrt_old']);
  });

  it('gives up waiting on a live lock as unreachable, without refreshing', async () => {
    const { deps, paths, calls } = setup();
    writeFileSync(authLockPath(paths), String(process.pid)); // fresh mtime: a live peer
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'unreachable' });
    expect(calls).toEqual([]);
    expect(readFileSync(authLockPath(paths), 'utf8')).toBe(String(process.pid)); // not ours to delete
  });

  it.skipIf(process.getuid?.() === 0)(
    'a lock that cannot be created (EACCES) is reported as unreachable, not thrown',
    async () => {
      const { deps, paths, calls } = setup();
      chmodSync(paths.configDir, 0o500);
      onTestFinished(() => chmodSync(paths.configDir, 0o700));
      const r = await ensureAuth(deps);
      expect(r).toMatchObject({ kind: 'unreachable', error: { code: 'EACCES' } });
      expect(calls).toEqual([]);
    },
  );

  it('releases only a lock that still carries its own token', async () => {
    const { deps, paths } = setup({}, async () => {
      // We are slow: a peer broke our lock and holds its own by the time we finish.
      writeFileSync(authLockPath(paths), 'peer:token');
      return next();
    });
    expect((await ensureAuth(deps)).kind).toBe('ok');
    expect(readFileSync(authLockPath(paths), 'utf8')).toBe('peer:token');
  });

  it('a stale break does not remove a lock replaced after the age check', async () => {
    const { deps, paths, calls } = setup();
    const lock = authLockPath(paths);
    writeFileSync(lock, 'old');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    deps.onStaleSeen = () => {
      // A peer breaks the stale lock and takes a fresh one, between our stat and our break.
      rmSync(lock);
      writeFileSync(lock, 'peer:fresh');
    };
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'unreachable' });
    expect(calls).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe('peer:fresh');
  });

  it('a refresh that never answers is unreachable within the timeout, cache untouched', async () => {
    const { deps, paths } = setup({}, () => new Promise(() => {}));
    deps.refreshTimeoutMs = 50;
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'unreachable' });
    expect(loadAuth(paths, CP)).toMatchObject({ apiToken: 'api-old', refreshToken: 'mrt_old' });
    expect(existsSync(authLockPath(paths))).toBe(false);
  });

  it('a failed write of the rotated pair does not throw; the new token is still used', async () => {
    const { deps, paths } = setup({}, async () => {
      mkdirSync(`${paths.authFile}.${process.pid}.tmp`); // saveAuth cannot write its temp file
      return next();
    });
    onTestFinished(() => rmdirSync(`${paths.authFile}.${process.pid}.tmp`));
    expect(await ensureAuth(deps)).toMatchObject({ kind: 'ok', auth: { apiToken: 'api-new' } });
  });

  it('a failed write after invalid_grant still reports login_required, not a throw', async () => {
    const { deps, paths } = setup({}, async () => {
      mkdirSync(`${paths.authFile}.${process.pid}.tmp`);
      throw new ApiError('control-plane', 400, 'invalid_grant');
    });
    onTestFinished(() => rmdirSync(`${paths.authFile}.${process.pid}.tmp`));
    expect(await ensureAuth(deps)).toEqual({ kind: 'login_required' });
  });
});
