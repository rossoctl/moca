import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './api/errors.js';
import type { ControlPlaneApi } from './api/types.js';
import { authLockPath, loadAuth, saveAuth, type CachedAuth, type Paths } from './config.js';
import { toCachedAuth } from './core/auth.js';

/**
 * The only way a mocactl command obtains an API token (B14 spec §5.2). The refresh token is single-use
 * and every use rotates it, so two refreshes at once would look like theft to the control plane: a
 * lock file serialises them -- across processes, and across concurrent calls within one process,
 * since O_EXCL is per file -- and whoever waited re-reads auth.json and uses the winner's result. The
 * new pair is written BEFORE the token is used, so a crash after the server rotated loses nothing the
 * grace window cannot recover.
 */

/** Refresh a token this close to expiry, so no request leaves with one that dies in flight. */
export const REFRESH_MARGIN_MS = 60_000;
/** A lock this old belongs to a process that died; break it. Wall clock (see EnsureDeps.now). */
export const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
/**
 * A refresh that has not answered by now is given up on. It must stay below STALE_LOCK_MS: the lock's
 * mtime is not renewed while we wait, and a peer may break the lock once it is older than that.
 */
export const REFRESH_TIMEOUT_MS = 20_000;

export type EnsureResult =
  | { kind: 'ok'; auth: CachedAuth }
  | { kind: 'login_required' }
  | { kind: 'unreachable'; error: unknown };

export interface EnsureDeps {
  paths: Paths;
  controlPlaneUrl: string;
  cp: Pick<ControlPlaneApi, 'refreshAuth'>;
  /**
   * Decides whether the API token is fresh; injectable so a test can jump 12 hours. The LOCK uses the
   * wall clock instead, since other processes share the lock file but not this clock.
   */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  /** Bound on the refresh call; default REFRESH_TIMEOUT_MS. Injectable so a test need not wait 20 s. */
  refreshTimeoutMs?: number;
  /** Test seam: runs between a lock's age check and its break. */
  onStaleSeen?: () => void;
}

const fresh = (a: CachedAuth | null, nowMs: number): a is CachedAuth =>
  !!a && a.expiresAt * 1000 - nowMs > REFRESH_MARGIN_MS;
const valid = (a: CachedAuth | null, nowMs: number): a is CachedAuth =>
  !!a && a.expiresAt * 1000 > nowMs;

export async function ensureAuth(
  deps: EnsureDeps,
  opts: { force?: boolean } = {},
): Promise<EnsureResult> {
  // loadAuth returns null for another control plane's login: a refresh token is only ever sent to
  // the control plane that issued it (spec §4.6 of the mocactl design).
  const before = loadAuth(deps.paths, deps.controlPlaneUrl);
  if (!opts.force && fresh(before, deps.now())) return { kind: 'ok', auth: before };
  if (!before?.refreshToken) {
    // A cache from before B14, or one whose refresh was refused: today's behaviour.
    return !opts.force && valid(before, deps.now())
      ? { kind: 'ok', auth: before }
      : { kind: 'login_required' };
  }

  const lock = await acquireLock(authLockPath(deps.paths), deps);
  if ('error' in lock) return { kind: 'unreachable', error: lock.error };
  try {
    const current = loadAuth(deps.paths, deps.controlPlaneUrl);
    // A peer refreshed while we waited: its result is ours. Compared by token, so a forced refresh
    // whose peer already replaced the rejected token does not spend the new refresh token too.
    if (current && current.apiToken !== before.apiToken && fresh(current, deps.now())) {
      return { kind: 'ok', auth: current };
    }
    if (!current?.refreshToken) return { kind: 'login_required' };
    let next: CachedAuth;
    try {
      next = toCachedAuth(
        await withTimeout(
          deps.cp.refreshAuth(current.refreshToken),
          deps.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS,
        ),
        deps.controlPlaneUrl,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_grant') {
        // Revoked, expired or replayed: it will never work again, so stop presenting it.
        try {
          saveAuth(deps.paths, withoutRefresh(current));
        } catch {
          // Could not forget it: the next refresh is refused the same way. Login is needed either way.
        }
        return { kind: 'login_required' };
      }
      return { kind: 'unreachable', error: err };
    }
    try {
      saveAuth(deps.paths, next); // before anyone uses it
    } catch {
      // The server already rotated, so `next` is the only live pair and the API token in it is good.
      // Failing here would throw it away; use it for this command. The disk still holds the spent
      // refresh token, which the grace window can recover at worst (else: log in again).
    }
    return { kind: 'ok', auth: next };
  } finally {
    lock.release();
  }
}

/** The login minus its refresh pair: what is left once the control plane refused the refresh token. */
export function withoutRefresh(auth: CachedAuth): CachedAuth {
  const rest = { ...auth };
  delete rest.refreshToken;
  delete rest.refreshExpiresAt;
  return rest;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`refresh timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Lock = { release: () => void } | { error: unknown };

/**
 * O_EXCL create; a stale lock is broken, a live one waited on up to lockWaitMs. Any other failure
 * (EACCES on the config dir, say) comes back as an error rather than a throw, so a command reports
 * it instead of dying with a stack trace.
 *
 * The lock holds a unique token and is only ever removed by someone who has checked it is the file
 * they mean to remove: release deletes only a lock still carrying our token, and a stale lock is
 * moved aside by an atomic rename (taking exactly the file at that moment) and re-checked there.
 */
async function acquireLock(path: string, deps: EnsureDeps): Promise<Lock> {
  const deadline = Date.now() + (deps.lockWaitMs ?? LOCK_WAIT_MS);
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { error };
  }
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, token);
      } catch {
        // The lock is ours either way; release then cannot prove it and leaves it to go stale.
      } finally {
        closeSync(fd);
      }
      return { release: () => releaseLock(path, token) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { error };
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue; // released between our open and our stat: try again at once
    }
    if (ageMs > STALE_LOCK_MS) {
      deps.onStaleSeen?.();
      breakStale(path);
      continue;
    }
    if (Date.now() >= deadline) {
      return { error: new Error('another mocactl is refreshing this login') };
    }
    await deps.sleep(50);
  }
}

function releaseLock(path: string, token: string): void {
  try {
    // Not ours any more (we were slow, a peer broke the lock and took its own): leave it be.
    if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** Remove the lock at `path` only if the file actually taken is still stale; else put it back. */
function breakStale(path: string): void {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // a peer got there first
  }
  try {
    if (Date.now() - statSync(aside).mtimeMs <= STALE_LOCK_MS) {
      // The file was replaced by a live peer's after our age check, and we just took it: return it.
      try {
        linkSync(aside, path);
      } catch {
        // Someone created a new lock meanwhile; the displaced one's release will find it gone.
      }
    }
  } catch {
    // vanished
  } finally {
    rmSync(aside, { force: true });
  }
}
