import type { ControlPlaneApi, HarnessApi } from '../api/types.js';
import { sanitizeRemote } from './sanitize.js';
import { sleep } from './time.js';
import { VERSION } from '../version.js';

/** What the startup banner shows; every remote field may be unknown. */
export interface BannerInfo {
  mocactlVersion: string;
  cpVersion?: string;
  harnessVersion?: string;
  cwd: string;
}

/** collectBannerInfo reads only these halves of the runtime, so tests fake exactly that much. */
export interface BannerDeps {
  cp?: Pick<ControlPlaneApi, 'discovery'>;
  harness?: Pick<HarnessApi, 'health'>;
}

/** The CWD with the home directory folded to ~, the way a shell prompt prints its path. */
export function displayCwd(cwd: string, home: string): string {
  if (home && (cwd === home || cwd.startsWith(home + '/'))) return '~' + cwd.slice(home.length);
  return cwd;
}

/** A version that did not arrive within `ms` is an unknown version, not a wait. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, sleep(ms).then(() => undefined)]);
}

/**
 * A remote version made safe for the terminal: every ANSI/VT sequence stripped (an OSC clipboard
 * write smuggled through the string must not survive into output), then capped at 64 characters
 * so a misbehaving deployment cannot spray the screen. One that sanitizes to nothing is unknown,
 * not blank.
 */
function remoteVersion(v: string): string | undefined {
  const safe = sanitizeRemote(v).slice(0, 64);
  return safe || undefined;
}

/**
 * Collects the banner's remote halves in parallel. Neither may hold the TUI back: each call is
 * capped by `timeoutMs` and any failure just leaves that version unknown — the banner always
 * resolves, worst case with only the local line filled in. Both fetches are aborted when the
 * timeout gives up or the caller abandons the banner (`opts.signal`): mocactl exits via
 * process.exitCode, so a socket left running would hold the process alive.
 */
export async function collectBannerInfo(
  deps: BannerDeps,
  opts: { cwd: string; home: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<BannerInfo> {
  const timeoutMs = opts.timeoutMs ?? 750;
  // One controller behind both calls, following the caller's signal: aborting it makes the
  // underlying fetches fail (and any signal-respecting promise settle) instead of dangling.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const cp = deps.cp
    ? withTimeout(
        deps.cp
          .discovery({ signal: controller.signal })
          .then((d) => (typeof d.version === 'string' ? remoteVersion(d.version) : undefined))
          .catch(() => undefined),
        timeoutMs,
      )
    : undefined;
  const harness = deps.harness
    ? withTimeout(
        deps.harness
          .health({ signal: controller.signal })
          .then((h) => (h.version ? remoteVersion(h.version) : undefined))
          .catch(() => undefined),
        timeoutMs,
      )
    : undefined;
  try {
    const [cpVersion, harnessVersion] = await Promise.all([cp, harness]);
    return {
      mocactlVersion: VERSION,
      cpVersion,
      harnessVersion,
      cwd: displayCwd(opts.cwd, opts.home),
    };
  } finally {
    // A fetch that lost the race (or outlived the caller) must not keep running.
    controller.abort();
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}
