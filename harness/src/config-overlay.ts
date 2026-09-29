import { assertValidDigest, digestDirName } from '@moca/config-bundle';
import type { SandboxTransport } from '@moca/k8s-sandbox';

/** Single-quote-escape for safe bash interpolation. Copied from converge.ts:4 by design. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shared, immutable, digest-keyed: safe to reuse across every leaf holding a ref on this pod. */
export function configCacheDir(digest: string): string {
  return `/workspace/.sh-config/${digestDirName(assertValidDigest(digest))}`;
}

/**
 * One empty file per live leaf, so the cache can be torn down when the last of them goes (#216).
 *
 * Dot-prefixed deliberately. The demo and the docs both enumerate cached bundles through a
 * `/workspace/.sh-config/sha256-*` glob; a refs tree matching that glob would be counted as a
 * cached bundle and make an emptiness check fail on a genuinely empty cache. Note that this holds
 * only for glob-scoped enumeration: an unscoped `find /workspace/.sh-config` does list ref files,
 * which is why the walkthrough's listing is scoped rather than left bare.
 *
 * A sibling of the digest dirs rather than a child of one, because ADR-0031's `chmod -R a-w` makes
 * the cache tree read-only — there is nowhere inside it to write a ref.
 */
export function configRefsDir(digest: string): string {
  return `/workspace/.sh-config/.refs/${digestDirName(assertValidDigest(digest))}`;
}

/** Per-leaf link, under the leaf workspace so `cleanupWorkspace` remains the only teardown path. */
export function leafConfigDir(sessionId: string): string {
  return `/workspace/leaves/${sessionId}/.sh-config`;
}

/**
 * Age at which a ref is presumed abandoned. A harness pod that dies mid-leaf never runs its
 * teardown, and one leaked ref would pin that digest's cache forever — reinstating #216 for it.
 *
 * Chosen to be orders of magnitude longer than any turn, because the failure mode in the other
 * direction is worse: sweeping a LIVE leaf's ref lets the cache be deleted under its symlink, and
 * the turn then runs with silently-absent configuration. The sandbox lease TTL (60s, heartbeated —
 * `run-leaf.ts:392`) is not a usable bound here; it expires while a leaf is healthy.
 */
const REF_STALE_MINUTES = 1440;

/**
 * A sessionId used as a ref FILENAME, validated rather than assumed.
 *
 * `toSessionId` (`run-leaf.ts:78`) already reduces every sessionId to `[A-Za-z0-9._-]` with
 * alphanumeric ends, so in practice this always passes. It is asserted anyway because the
 * consequence of a sessionId that escaped its directory would be a `rm -rf` aimed by it, and
 * because a second caller could one day reach these builders without going through
 * `toSessionId`. Validating also lets the scripts interpolate the name plainly instead of
 * quoting around it.
 */
function assertSafeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..')
    throw new Error(`invalid sessionId for a config ref: ${JSON.stringify(sessionId)}`);
  return sessionId;
}

export interface OverlayPaths {
  skillsDir: string;
  memoryDir: string;
}

/**
 * Claim a ref on the digest for this leaf, then print `hit` when it is already cached, `miss`
 * otherwise.
 *
 * This used to be a pure probe, and the cache it probed was never released — so it outlived the
 * leaf that created it, and a later leaf dispatched with NO `configRef` could lease the same pooled
 * sandbox, find a sibling's promoted `CLAUDE.md` and `memory/` still on disk, and answer from them
 * (#216). That breaks spec §2 goal 6 ("absent a promoted bundle, harness behavior is unchanged")
 * observably, because every tool call runs in the sandbox. The ref written here is what tells
 * `buildConfigCleanupScript` when the last leaf using a digest is gone.
 *
 * The ref is registered BEFORE the presence check, and both happen inside ONE flock. That ordering
 * is the race fix, not tidiness: were the check first, this leaf could read `hit` and a concurrent
 * leaf's cleanup could then see an empty refs dir and delete the cache, leaving this leaf's symlink
 * dangling and its turn running unconfigured — the plausible-but-wrong-work failure the promotion
 * design exists to prevent (spec §4.4).
 */
export function buildCacheAcquireScript(digest: string, sessionId: string): string {
  return [
    `set -eu`,
    // Marker so a test's fake transport can tell this call from the others by content rather
    // than by call position. A no-op shell comment; keep it if you touch this script.
    `# CACHE_ACQUIRE`,
    `DIR=${sq(configCacheDir(digest))}; REFS=${sq(configRefsDir(digest))}`,
    `LOCK=/workspace/.sh-config.lock`,
    `(`,
    `  flock 9`,
    // Inside the lock, not before it: cleanup rmdir's the empty refs dir under this same lock, and
    // a mkdir outside would leave a window where that rmdir lands between the mkdir and the flock,
    // failing the ref write below and killing the leaf on a pure teardown race.
    `  mkdir -p "$REFS"`,
    `  find "$REFS" -maxdepth 1 -type f -mmin +${REF_STALE_MINUTES} -delete 2>/dev/null || true`,
    `  : > "$REFS/${assertSafeSessionId(sessionId)}"`,
    `  if [ -d "$DIR" ]; then printf 'hit'; else printf 'miss'; fi`,
    `) 9>"$LOCK"`,
  ].join('\n');
}

/**
 * Populate the shared cache from base64 tar.gz on stdin, under the same per-pod flock
 * `converge.ts` uses, so concurrent leaves on a cold pod do not race. Staged then renamed, so
 * a crash cannot leave a half-populated cache that would truncate skill instructions.
 */
export function buildCachePopulateScript(digest: string): string {
  const DIR = configCacheDir(digest);
  return [
    // pipefail is REQUIRED, not stylistic. Without it the `base64 -d | tar` pipeline reports only
    // tar's status, so a truncated or corrupt stdin can leave base64 failing while tar returns 0 on
    // the partial bytes it did receive — and the script would then chmod, mv and print 'ok' over an
    // incompletely populated shared cache. Safe to use: the transport runs `bash -c`
    // (k8s-sandbox/src/transport.ts:35) and every sandbox variant installs bash.
    `set -euo pipefail`,
    `DIR=${sq(DIR)}; LOCK=/workspace/.sh-config.lock`,
    `mkdir -p /workspace/.sh-config`,
    `TMP="$DIR.tmp.$$"`,
    `(`,
    `  flock 9`,
    // Clean up the staging dir on ANY failure. Without this, `set -e` aborts before the mv and
    // leaves $DIR.tmp.$$ behind — and since each attempt uses a fresh PID, a systemic failure
    // (a transport truncating stdin, say) accumulates stale staging dirs indefinitely on a
    // long-lived pooled sandbox. The canonical path is still never half-populated either way.
    // `chmod -R a-w` below (ADR-0031) makes the staged tree read-only before it can ever fail
    // out of this trap, so the trap must restore write permission first, or `rm -rf` on a
    // read-only tree can itself fail and leak the staging dir on every failure.
    `  trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT`,
    // Benign race, deliberately tolerated rather than fixed: if two leaves both miss the probe,
    // the flock loser reaches this line and exits WITHOUT draining the bundle piped on stdin. The
    // exec transports tolerate an undrained stdin, and overlayConfig only sends bytes on a miss, so
    // the cost is one wasted transfer at worst. Do not "fix" this by draining or by dropping the
    // early exit: the first reintroduces the transfer this optimisation exists to avoid, and the
    // second re-extracts over a populated cache.
    `  # Benign undrained-stdin race: loser exits without draining piped bundle; transports tolerate it.`,
    `  [ -d "$DIR" ] && exit 0`,
    `  rm -rf "$TMP"; mkdir -p "$TMP"`,
    `  base64 -d | tar -x -z -C "$TMP"`,
    `  find "$TMP" -name '*.sh' -exec chmod +x {} +`,
    // ADR-0031: promoted memory (and skill bodies) must be read-only, because this cache is
    // shared by every leaf on the pod and nothing else prevents one leaf's write from mutating
    // what every later leaf on this pod reads. Drop write AFTER the +x pass (so the scripts this
    // cache ships stay executable) and BEFORE the mv (so the canonical path is never briefly
    // writable).
    `  chmod -R a-w "$TMP"`,
    `  mv "$TMP" "$DIR"`,
    `) 9>"$LOCK"`,
    `printf 'ok'`,
  ].join('\n');
}

/** Link the shared cache into this leaf's workspace and echo the leaf-local root. */
export function buildLeafBindScript(digest: string, sessionId: string): string {
  const LEAF = leafConfigDir(sessionId);
  return [
    `set -eu`,
    `DIR=${sq(configCacheDir(digest))}; LEAF=${sq(LEAF)}`,
    `mkdir -p "$(dirname "$LEAF")"`,
    `ln -sfn "$DIR" "$LEAF"`,
    `printf '%s' "$LEAF"`,
  ].join('\n');
}

/**
 * Drop the per-leaf link and this leaf's ref, and tear the shared cache down once no leaf holds one.
 *
 * The cache used to outlive every leaf by design; #216 is what that cost. Reuse is still real for
 * the case it was built for — a concurrent fan-out holds many refs at once, so the bundle is pushed
 * once (spec §4.5) — but it is no longer reused across *separate dispatches*: a later dispatch of
 * the same digest onto an idle pool re-transfers it. That is the accepted price of a bare leaf never
 * finding a sibling's promoted context on disk.
 *
 * Best-effort throughout (`set -u`, not `set -eu`), matching `cleanupWorkspace` (converge.ts:76): a
 * teardown hiccup must never mask the turn's actual verdict.
 */
export function buildConfigCleanupScript(sessionId: string, digest: string): string {
  return [
    `set -u`,
    `rm -f ${sq(leafConfigDir(sessionId))} 2>/dev/null || true`,
    `DIR=${sq(configCacheDir(digest))}; REFS=${sq(configRefsDir(digest))}`,
    `LOCK=/workspace/.sh-config.lock`,
    `(`,
    // The same lock the acquire and populate scripts use, so "drop my ref, then count what is left"
    // is atomic against a concurrent leaf claiming one.
    `  flock 9 || exit 0`,
    `  rm -f "$REFS/${assertSafeSessionId(sessionId)}" 2>/dev/null || true`,
    `  find "$REFS" -maxdepth 1 -type f -mmin +${REF_STALE_MINUTES} -delete 2>/dev/null || true`,
    `  if [ -z "$(ls -A "$REFS" 2>/dev/null)" ]; then`,
    // ADR-0031's `chmod -R a-w` clears the write bit on the cache's DIRECTORIES too, and a directory
    // needs write permission on itself to unlink its entries. Without restoring it first the rm
    // fails silently and the cache survives — which is the bug, not a cosmetic leak. The populate
    // script's EXIT trap does the same thing to its staging dir for the same reason.
    `    chmod -R u+w "$DIR" 2>/dev/null || true`,
    `    rm -rf "$DIR" 2>/dev/null || true`,
    `    rmdir "$REFS" 2>/dev/null || true`,
    `  fi`,
    `) 9>"$LOCK"`,
  ].join('\n');
}

async function run(transport: SandboxTransport, script: string, stdin?: Buffer): Promise<string> {
  const { stdout, exitCode, truncated } = await transport.exec(script, {
    timeout: 300,
    ...(stdin ? { stdin } : {}),
  });
  if (truncated) throw new Error('config overlay exceeded the sandbox output cap');
  if (exitCode !== 0) throw new Error(`config overlay failed (exit ${exitCode})`);
  return stdout.toString();
}

/**
 * Mirror the bundle into the sandbox and return the paths the injected prompt notes name.
 *
 * The first exec claims a ref on the digest and reports hit/miss, and bytes go only on a miss:
 * bundles are immutable and content-addressed, so a 200-leaf fan-out transfers the bundle once
 * rather than 200 times (spec §4.5). Claiming the ref first — before any transfer, and before the
 * caller can fail — is what makes the cache safe to reclaim in `buildConfigCleanupScript` (#216).
 */
export async function overlayConfig(
  transport: SandboxTransport,
  digest: string,
  sessionId: string,
  tarGz: Buffer,
): Promise<OverlayPaths> {
  const acquired = await run(transport, buildCacheAcquireScript(digest, sessionId));
  if (acquired.trim() !== 'hit') {
    await run(transport, buildCachePopulateScript(digest), Buffer.from(tarGz.toString('base64')));
  }
  await run(transport, buildLeafBindScript(digest, sessionId));
  const root = leafConfigDir(sessionId);
  return { skillsDir: `${root}/skills`, memoryDir: `${root}/memory` };
}
