/**
 * The control plane's release of an ended workspace on its worker (#338): a sandbox at its delete
 * or when the janitor's sweep first sees it ended, a session at its delete. Through the relay's
 * control listener (packages/sandbox-relay/src/control-listener.ts), `POST /v1/release {worker,
 * workspaceKey}` with the release-only bearer, which answers the worker's ack (`released`,
 * `kept_busy`, `unknown_key`) or `release_unsupported` for a worker that predates release. Those
 * four are TERMINAL: the worker said what became of the key. Anything else -- the relay down, no
 * live worker, a timeout, a refusal -- is not an answer, and the caller may try again.
 *
 * Best-effort, always under RELEASE_BOUND_MS: a release never fails the DELETE or the sweep it runs
 * in and never delays it past the bound. The worker's idle reclaim stays the backstop for every
 * workspace a release did not reach.
 *
 * Off unless SH_RELAY_CONTROL_URL is set; then MOCA_RELAY_RELEASE_TOKEN (a credential file under
 * CREDENTIALS_DIRECTORY, as every control-plane secret: CONTROL_PLANE_SECRETS) is required.
 */

/** A terminal answer: the worker's ack, or `unsupported` for a worker that predates release. */
export type ReleaseAnswer = 'released' | 'kept_busy' | 'unknown_key' | 'unsupported';

export interface RelayReleaser {
  /**
   * The worker's terminal answer for `workspaceKey` on `worker`. Rejects on anything that is not
   * one (a transport failure, a non-200, an unknown body), and when `signal` aborts.
   */
  release(worker: string, workspaceKey: string, signal: AbortSignal): Promise<ReleaseAnswer>;
}

/**
 * How long a release may hold up the DELETE or the sweep it runs in. Short: the worker answers at
 * once (it queues the workspace's removal off the request path), so a slower answer means the relay
 * or the worker is in trouble, and the next sweep, or idle reclaim, takes over.
 */
export const RELEASE_BOUND_MS = 5_000;

/**
 * How long one sender's claim on a sandbox's release lasts (SandboxStore.claimRelease): well past the
 * bound, so a claim never lapses under a release still running, and short enough that a crashed
 * claimer's release is retried by the next sweep.
 */
export const RELEASE_CLAIM_TTL_S = 60;

/** Releases the sweep has in flight at once; the relay's control listener caps its own at 16. */
export const RELEASE_SWEEP_CONCURRENCY = 8;

/** The release bearer travels in an HTTP header, as the janitor's: at least 32 characters. */
const MIN_TOKEN_LENGTH = 32;

const ANSWERS: Record<string, ReleaseAnswer> = {
  released: 'released',
  kept_busy: 'kept_busy',
  unknown_key: 'unknown_key',
  release_unsupported: 'unsupported',
};

/** The relay's control listener at `baseUrl`, authorized by `token`. */
export function httpRelayReleaser(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): RelayReleaser {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/release`;
  return {
    async release(worker, workspaceKey, signal) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ worker, workspaceKey }),
        signal,
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: unknown; error?: unknown };
      const answer = res.status === 200 ? ANSWERS[String(body.outcome)] : undefined;
      if (!answer) {
        // The relay's error code only: its message may name the worker, never anything secret,
        // but the code is all a caller acts on.
        throw new Error(
          `the relay answered ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}`,
        );
      }
      return answer;
    },
  };
}

/**
 * The releaser, or undefined when SH_RELAY_CONTROL_URL is unset (release off: nothing is sent and
 * no record changes). Set, it must be an absolute http(s) URL, and MOCA_RELAY_RELEASE_TOKEN must be
 * present, at least 32 characters, and differ from every bearer in `others` (the control plane's
 * own: a janitor or host token that also released workspaces would erase the separation the
 * release bearer exists for), or the control plane does not boot. Errors name variables only.
 */
export function relayReleaserFromEnv(
  env: NodeJS.ProcessEnv,
  others: readonly string[] = [],
  fetchImpl?: typeof fetch,
): RelayReleaser | undefined {
  const raw = env.SH_RELAY_CONTROL_URL?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('SH_RELAY_CONTROL_URL must be an absolute http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('SH_RELAY_CONTROL_URL must be an absolute http(s) URL');
  }
  const token = env.MOCA_RELAY_RELEASE_TOKEN;
  if (!token) {
    throw new Error('SH_RELAY_CONTROL_URL needs MOCA_RELAY_RELEASE_TOKEN (the release bearer)');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MOCA_RELAY_RELEASE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (others.includes(token)) {
    throw new Error(
      'MOCA_RELAY_RELEASE_TOKEN must differ from every other control-plane secret and bearer',
    );
  }
  return httpRelayReleaser(raw, token, fetchImpl);
}

/**
 * Starts `work` and returns at once: a release a DELETE sends after it commits must neither fail nor
 * delay it. Every error ends here (logged), never as an unhandled rejection, which would end the
 * process.
 */
export function inBackground(what: string, work: () => Promise<void>): void {
  let p: Promise<void>;
  try {
    p = work();
  } catch (err) {
    p = Promise.reject(err);
  }
  p.catch((err: unknown) =>
    console.error(
      `[control-plane] ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

/**
 * Runs `work` under `boundMs` and resolves by then, whatever `work` does: at the bound its signal
 * aborts and this returns, leaving anything still running to finish (or fail) on its own. Never
 * rejects: a release is best-effort, so its error is `work`'s to log, never the caller's to see.
 */
export async function withinBound(
  boundMs: number,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve();
    }, boundMs);
  });
  try {
    await Promise.race([work(stop.signal).catch(() => {}), bound]);
  } finally {
    clearTimeout(timer);
  }
}
