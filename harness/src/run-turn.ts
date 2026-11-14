import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import {
  getModel,
  getModels,
  getProviders,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { RedisSessionBackend } from '@moca/session-backend';
import { BufferedRedisBackend } from './buffered-redis-backend.js';
import { flushExtension } from './flush-extension.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  createCapacityLatch,
  DEFAULT_OUTPUT_CAP,
  k8sSandboxExtension,
  SandboxCapacityRefusedError,
  type SandboxTransport,
} from '@moca/k8s-sandbox';
// Value import, and safe: select-sandbox.ts imports nothing from run-turn.js, so unlike the
// run-leaf↔run-turn pair below there is no cycle to avoid here.
import {
  selectPoolSandbox,
  SandboxPoolSaturatedError,
  SandboxPoolEmptyError,
  SandboxAffinityPendingError,
  assertServerSandbox,
  type SelectDeps,
  type WorkspaceReset,
} from './select-sandbox.js';
import { checkpointExtension } from './checkpoint-extension.js';
import { budgetVoterExtension, branchSpend } from './budget-voter.js';
import { AMBIENT_KEY_SENTINEL } from './ambient-sentinel.js';
import { toolChoiceExtension } from './tool-choice-extension.js';
// Type-only import (erased at compile time) so it is safe against the run-leaf↔run-turn value
// cycle: run-leaf.ts imports values from run-turn.js, but a `import type` adds no runtime edge.
import type { LeafUsage } from './run-leaf.js';
import { sseExtension, type TurnStreamFrame } from './turn-stream.js';
import { promotedLoaderOptions, type PromotedConfig } from './config-resolver.js';
import { leaseTimings } from './lease-timings.js';
import { attachPromotedConfig, type AttachedPromotedConfig } from './promoted-config.js';
import { compactIfOverflowing } from './pre-prompt-compaction.js';
import { recordModelSwitch } from './model-switch-record.js';

// Re-exported because they are now part of executeTurn's CONTRACT: since /turn leases from the pool,
// every caller of executeTurn can be handed these errors and needs to distinguish them from a generic
// failure (all three are transient — a 503, not a 500: a full pool, an empty pool or tier, and a
// session waiting for its own briefly-absent sandbox). harness/package.json exposes no ./select-sandbox
// subpath, and this is the module those callers already import.
export { SandboxPoolSaturatedError, SandboxPoolEmptyError, SandboxAffinityPendingError };
// Fourth transient, and the one that arrives LATEST: the three above are raised at lease
// time, before any exec, while this one comes from a sandbox that was leased successfully
// and whose host then refused the work mid-turn (#452). Same 503 + Retry-After outcome,
// which is why it belongs in this export list rather than only in k8s-sandbox's.
export { SandboxCapacityRefusedError };
// Same reason: a promoted session's turn can fail with it, and server.ts maps it to 410.
export { BundleNotFoundError } from '@moca/config-bundle';

/**
 * One session store per process, not per turn.
 *
 * `executeTurnCore` used to `new RedisSessionBackend(...)` on every call and never close it. Its
 * constructor connects eagerly, so each turn leaked one live Redis connection — and this predates
 * the supervisor, but the supervisor is what makes it fatal: a turn used to be served by a
 * short-lived request-scaled container, whereas a supervisor worker is process-lived and
 * admits S concurrent turns for hours. The leak then climbs to `maxclients` (10000), Redis answers
 * `ERR max number of clients reached`, and node-redis raises that as an `'error'` on a client with
 * no listener, so every worker exits at once. Measured: all four died simultaneously ~13 minutes
 * into a sustained ladder.
 *
 * Sharing is safe because the store is stateless per session — the URL is the only construction
 * input and every method takes the session id — and node-redis multiplexes concurrent commands over
 * one connection.
 *
 * Unlike the stores in select-sandbox.ts there is no drop-on-failure wrapper here, and the reason is
 * that the hazard such a wrapper guards against — memoising a client that never connected — is now
 * fixed at its source instead of worked around at each call site. `RedisSessionBackend` used to
 * assign `ready` once in its constructor and never reassign it, so a rejected `connect()` poisoned
 * every later method call on that instance forever; memoising one process-wide would then have
 * traded a bounded per-turn leak for an unbounded outage, and in the very window the leak never
 * mattered in (the first turn after boot). It now RE-ARMS: a failed attempt clears itself so the
 * next call reconnects (packages/session-backend/src/redis-backend.ts, `arm()`), which fixes it for
 * every caller of the class rather than for this memo alone.
 *
 * Worth knowing which failures reach that path: probed on the pinned redis@6.2.1, both shapes do — a
 * REFUSED connect rejects with `ECONNREFUSED`, and a black-holed SYN rejects once the 5s
 * `connectTimeout` raises `ConnectionTimeoutError`. In a cluster the second is the one to expect: a
 * Service with no ready endpoints, or a NetworkPolicy drop, black-holes the SYN instead of refusing
 * it.
 *
 * The re-arm handles the promise channel. A socket lost AFTER connecting is the event channel, and
 * that one is fatal without an `'error'` listener regardless of any memoisation — hence
 * `swallowRedisErrors`, which every long-lived client here now registers.
 */
let sessionStoreMemo: { url: string; store: RedisSessionBackend<FileEntry> } | null = null;

function sharedSessionStore(url: string): RedisSessionBackend<FileEntry> {
  if (!sessionStoreMemo || sessionStoreMemo.url !== url) {
    // A changed REDIS_URL is a different Redis; replace rather than silently address the old one.
    if (sessionStoreMemo) void sessionStoreMemo.store.close().catch(() => {});
    sessionStoreMemo = { url, store: new RedisSessionBackend<FileEntry>(url) };
  }
  return sessionStoreMemo.store;
}

/** Test-only: drop the cached session store. */
export function resetSharedSessionStore(): void {
  if (sessionStoreMemo) void sessionStoreMemo.store.close().catch(() => {});
  sessionStoreMemo = null;
}

/**
 * The sandbox a turn's tool calls run in: the leased relay transport plus where head paths
 * map inside the sandbox. Null ⇒ run tools in the harness process itself (no pool resolved).
 */
export interface TurnSandbox {
  transport: SandboxTransport;
  /** The sandbox-side cwd; head paths under the harness cwd map here. */
  podCwd: string;
  /** The sandbox's id, named in the model's prompt. */
  sandboxId?: string;
}

/**
 * A turn's sandbox plus the lease lifecycle that keeps it. `leased` is true ONLY when THIS call
 * took the lease, which is what makes `heartbeat`/`release` safe to drive unconditionally: for an
 * injected sandbox the caller owns the lease, and renewing or returning someone else's would let
 * one turn release the sandbox another turn is still executing in.
 */
export interface AcquiredTurnSandbox {
  sandbox: TurnSandbox | null;
  leased: boolean;
  /** Renew this call's lease. A no-op unless `leased`. */
  heartbeat: () => Promise<void>;
  /** Return this call's lease. A no-op unless `leased`. */
  release: () => Promise<void>;
  placement?: TurnPlacement;
}

/** Where a leased turn ran (P6.3 spec §6). Absent when nothing was leased. */
export interface TurnPlacement {
  sandboxId: string;
  tier: string;
  /** The seed the session's workspace is filled with: where it came from (session-templates spec §5). */
  seed?: TurnSeed;
  workspaceReset?: WorkspaceReset;
}

/**
 * Where a templated session's seed came from (session-templates spec §5): `build`, the pinned
 * build's own spec in the control plane's template store (then `buildId` is that build), or
 * `declared`, the deployment's SH_SANDBOX_TEMPLATES. A client checks it against its pin, as it
 * checks a sandbox's served build.
 */
export interface TurnSeed {
  source: 'build' | 'declared';
  buildId?: string;
}

/**
 * The end state of a templated session's workspace after a turn (session-templates spec §5.1): the
 * diff from the seed's baseline commit to everything in the workspace now, binary-safe. `patch` is
 * the diff as text, or `patchBase64` when it is not valid UTF-8; either is whole, never truncated.
 * Over SH_TURN_PATCH_MAX_BYTES it is left out and `patchRefused` says so (`patchSha256` and
 * `patchBytes` still describe it when the transport returned it whole). `error` alone: the capture
 * failed (no git, no baseline commit), which never fails the turn.
 */
export interface TurnWorkspace {
  baseline?: string;
  patch?: string;
  patchBase64?: string;
  patchSha256?: string;
  patchBytes?: number;
  patchRefused?: 'too_large';
  error?: string;
}

/**
 * The id a turn holds its sandbox lease under. Unique per TURN — never the session id.
 *
 * Named for what it identifies (the lease's HOLDER) rather than a "run": #279 established that `run`
 * is not a harness concept and that the old lease `runId` was `session_id` under another name. This
 * value is the counter-example that makes the identity real — it MUST differ from the session id, for
 * the two reasons below — so it gets its own descriptive name, as docs/glossary.md prescribes.
 *
 * The holder id is the ZSET *member* in `ACQUIRE_LUA` (sandbox-lease.ts), not a payload, so a repeated
 * value is one lease rather than two: `ZADD` on an existing member updates its score and leaves
 * `ZCARD` unchanged. A session id is stable across every turn of a session by design (that is what
 * lets `:openFromCheckpoint` reopen one), so deriving the holder from it would have made the RESUME
 * path — the one the supervisor exists to serve — the path that shares leases, and broken the pool
 * two ways:
 *
 *  - **The cap undercounts.** N concurrent turns of one session occupy ONE slot, so with
 *    `KAGENTI_SANDBOX_CAP=20` a single session can pile arbitrarily many turns onto one pod while the
 *    pool still reports headroom — deflating the very saturation accounting `SandboxPoolSaturatedError`
 *    and its new 503 are computed from.
 *  - **The first turn to finish releases a sandbox another is still using.** `release` is `zRem`, so
 *    one turn's `finally` removes the shared member while its sibling is mid-execution; the pod then
 *    reads as free for new work, and the sibling's heartbeat (`zAdd`) resurrects the member seconds
 *    later, so `load()` returns a different answer depending on where in the heartbeat interval it is
 *    sampled.
 *
 * The session id is prefixed for greppability only — nothing reads the holder back, and the UUID is
 * what carries the uniqueness. The session id itself still reaches `selectPoolSandbox` separately,
 * because it is what keys the microVM workspace and must stay stable across a session's turns.
 */
export function turnLeaseHolder(sessionId?: string): string {
  return `${sessionId ?? 'anon'}:${randomUUID()}`;
}

/**
 * Decide which sandbox a turn runs its tools in, and lease it when it comes from a pool.
 *
 * A caller that has already leased one (a prompt leaf, which must reach the very sandbox it holds
 * a lease on — including a remote one behind the relay) injects it, and resolution is skipped.
 *
 * `/turn` injects nothing, and this is where its behavior CHANGED. It used to call
 * `resolveSandboxConfig` alone — the single-pod path — so it ignored
 * `KAGENTI_SANDBOX_POOL_SELECTOR`, `SH_SANDBOX_DISCOVERY` and `SH_REMOTE_SANDBOX` entirely, and on
 * a deployment that configured a pool it ran the turn's tool calls in the harness process itself
 * (ADR 0028 deferred this as "prompt leaves inherit /turn's sandbox routing"; run-leaf.ts closed
 * it for leaves only). Proven on hardware: a tool call's file landed in the supervisor unit's own
 * PrivateTmp namespace, never in any sandbox container, while a direct probe of the relay's Exec
 * RPC reached the pool fine at the same moment.
 *
 * Going through `selectPoolSandbox` is what makes the no-pool path safe **by construction** rather
 * than by care: with no `KAGENTI_SANDBOX_POOL_SELECTOR` it returns null — the caller runs local
 * tools (or fails in server mode) — and a stale `KAGENTI_SANDBOX_POD` throws instead of quietly
 * selecting nothing. No future caller of `executeTurn` can bypass this seam to get a single-pod
 * path back.
 *
 * One intended behavior change beyond routing: with a selector set and NO candidates,
 * `selectPoolSandbox` throws rather than falling back. Previously such a deployment silently ran
 * tools locally, which is the failure §5.4 exists to prevent — a turn that cannot reach the
 * sandbox it is configured to use is not a turn that should quietly succeed.
 */
export async function acquireTurnSandbox(
  injected: TurnSandbox | undefined,
  env: NodeJS.ProcessEnv,
  headCwd: string,
  sessionId: string | undefined,
  deps: SelectDeps = {},
  tier?: string,
  template?: { id: string; seed?: string; seedSource?: 'build' | 'declared'; build?: string },
): Promise<AcquiredTurnSandbox> {
  const noop = async () => {};
  if (injected) return { sandbox: injected, leased: false, heartbeat: noop, release: noop };

  // Same knobs and defaults as every leaf's call, deliberately: two lease conventions for one lease
  // store is how a cap means different things depending on which path took it. That is now ONE shared
  // reader rather than the same `Number(env.X ?? …)` repeated at each of the four lease-taking paths,
  // so hardening it (an empty or unparseable value no longer becoming 0/NaN) could not harden this
  // path and leave a leaf behind.
  const { cap, ttlMs } = leaseTimings(env);
  // The holder is derived HERE rather than taken from the caller, so a per-turn id cannot be forgotten
  // at one of several call sites — the M1 defect was exactly one such expression.
  const holderId = turnLeaseHolder(sessionId);
  const selected = await selectPoolSandbox(
    env,
    headCwd,
    // An anonymous turn has no session, so there is no continuity to preserve and no shared workspace
    // it should join: keying it by its unique holder gives it its own, which is the correct answer for
    // a one-off. Sharing a literal 'anon' workspace across unrelated turns would be the cross-turn
    // bleed spec §2.3 is about, and an EMPTY key is refused outright by microvm-worker (§3.4).
    sessionId ?? holderId,
    {
      cap,
      ttlMs,
      holderId,
      remoteSandbox: env.SH_REMOTE_SANDBOX === '1',
      tier,
      ...(template ? { template: template.id } : {}),
      ...(template?.build ? { build: template.build } : {}),
    },
    deps,
  );
  if (!selected) return { sandbox: null, leased: false, heartbeat: noop, release: noop };
  // A templated workspace is seeded before the turn's first tool call (session-templates spec §5).
  // The lease is held: a seed that throws must return it, as every other failure after the acquire.
  if (template?.seed) {
    // The seed may outlast the lease TTL (a clone, an install): renew while it runs, as executeTurn
    // renews for the turn, or the slot is reaped and over-filled under a still-running seed.
    const renew = setInterval(
      () => void selected.heartbeat().catch(() => {}),
      leaseTimings(env).heartbeatMs,
    );
    try {
      await seedWorkspace(selected.transport, template.id, template.seed, selected.podCwd);
    } catch (err) {
      await selected.release().catch(() => {});
      throw err;
    } finally {
      clearInterval(renew);
    }
  }

  // `leased` comes from the seam rather than from re-reading the environment here. It is
  // false for an injected sandbox (the caller owns that lease) and true only when this call
  // took one, which is what makes arming a renewal timer correct: arming it for someone
  // else's lease would renew or release a sandbox another turn is still executing in.
  return {
    sandbox: {
      transport: selected.transport,
      podCwd: selected.podCwd,
      sandboxId: selected.sandboxId,
    },
    leased: true,
    heartbeat: selected.heartbeat,
    release: selected.release,
    placement: {
      sandboxId: selected.sandboxId,
      tier: selected.tier ?? '',
      ...(template?.seed ? { seed: seedOrigin(template) } : {}),
      ...(selected.workspaceReset ? { workspaceReset: selected.workspaceReset } : {}),
    },
  };
}

/** A seeded template's TurnSeed: an absent source is a control plane from before it was sent. */
export function seedOrigin(t: { seedSource?: 'build' | 'declared'; build?: string }): TurnSeed {
  const source = t.seedSource ?? 'declared';
  return { source, ...(source === 'build' && t.build ? { buildId: t.build } : {}) };
}

/**
 * The marker a seeded workspace carries (session-templates spec §5), relative to the workspace (the
 * session's podCwd: `/workspace` on a microVM, `/workspace/<sid>` on a container worker), so it
 * travels with that workspace and no other session's.
 */
export const SEED_MARKER = '.moca-seeded';
/**
 * The seed's own output, kept in the workspace for the operator: never in the turn's output, but in
 * the agent's own workspace, where the agent can read it, so a seed must not print a secret.
 */
export const SEED_LOG = '.moca-seed.log';
/** The lock that holds concurrent first turns of one session to one seed run. */
export const SEED_LOCK = '.moca-seed.lock';
/**
 * The commit the seed left the workspace at (`git rev-parse HEAD` right after it), relative to the
 * workspace like the marker: the base a turn's patch is taken against (spec §5.1). Absent when the
 * seed left no git repository; the capture then uses HEAD.
 */
export const SEED_BASELINE = '.moca-baseline';

/** A template's seed failed: the turn cannot start on a workspace that is not the template's. */
export class SandboxSeedError extends Error {
  constructor(template: string, why: number | null | string) {
    super(
      `seeding the workspace of sandbox template '${template}' failed (${typeof why === 'string' ? why : `exit ${why ?? 'none: signal'}`}; see ${SEED_LOG} in the workspace)`,
    );
    this.name = 'SandboxSeedError';
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs a template's seed in the session's workspace (`workspace`, its podCwd) unless the marker
 * says it has run (spec §5). An exclusive `flock` on the marker's lock file holds concurrent first
 * turns of one session to one seed run: the second waits, then finds the marker. A failed seed
 * leaves no marker, so the next turn runs it again on whatever it left: a seed must be safe to
 * re-run (`cp -a` is; a bare `git clone` into the workspace is not). A workspace reset has no
 * marker and is seeded again. The seed's output goes to SEED_LOG, never into the turn: only the
 * exit code is read, so a chatty seed cannot trip the output cap. Right after the seed, the commit it
 * left the workspace at is written to SEED_BASELINE (best effort), the base of the turn's patch. When
 * the workspace is a git repository (a seeded checkout), the seed's own files, the baseline among
 * them, are added to its `info/exclude`, so a patch taken with `git add -A` or
 * `git status --porcelain` never carries them.
 */
export async function seedWorkspace(
  transport: {
    exec: (command: string, opts?: { timeout?: number }) => Promise<{ exitCode: number | null }>;
  },
  template: string,
  seed: string,
  workspace = '/workspace',
): Promise<void> {
  // The baseline is best effort: a seed that leaves no repository still seeds, with no baseline.
  const baseline = `{ git rev-parse --verify -q HEAD >${SEED_BASELINE} 2>/dev/null || rm -f ${SEED_BASELINE}; true; }`;
  const files = [SEED_MARKER, SEED_LOG, SEED_LOCK, SEED_BASELINE];
  // Best-effort: no git, or not a repository, skips it; it never fails the seed.
  const exclude =
    `{ x="$(git rev-parse --git-path info/exclude 2>/dev/null)" && mkdir -p "$(dirname "$x")" && ` +
    `for f in ${files.map((f) => `/${f}`).join(' ')}; do grep -qxF "$f" "$x" 2>/dev/null || echo "$f" >>"$x"; done; true; }`;
  const body = `[ -e ${SEED_MARKER} ] || { bash -c ${shq(seed)} >${SEED_LOG} 2>&1 && ${baseline} && ${exclude} && touch ${SEED_MARKER}; }`;
  // flock(1) is util-linux, in every shipped sandbox image; without it the guard still runs, unlocked.
  const command =
    `cd ${shq(workspace)} && if command -v flock >/dev/null 2>&1; then ` +
    `flock ${SEED_LOCK} bash -c ${shq(body)}; else ${body}; fi`;
  let res: { exitCode: number | null };
  try {
    res = await transport.exec(command, { timeout: 600 });
  } catch (err) {
    // A transport failure or the worker's timeout (`timeout:600`): still the seed's failure.
    throw new SandboxSeedError(template, (err as Error)?.message ?? String(err));
  }
  if (res.exitCode !== 0) throw new SandboxSeedError(template, res.exitCode);
}

/** The patch cap's default (SH_TURN_PATCH_MAX_BYTES): 4 MiB, half the transport's output cap. */
export const DEFAULT_PATCH_MAX_BYTES = 4 * 1024 * 1024;

/** SH_TURN_PATCH_MAX_BYTES, a positive whole number, at most the transport's output cap. */
export function patchMaxBytes(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SH_TURN_PATCH_MAX_BYTES);
  const v =
    env.SH_TURN_PATCH_MAX_BYTES && Number.isInteger(n) && n > 0 ? n : DEFAULT_PATCH_MAX_BYTES;
  return Math.min(v, DEFAULT_OUTPUT_CAP - 4096);
}

/**
 * Moca's own files in a workspace, left out of its patch: the seed's (`.moca-*`), and a promoted
 * config's while a turn holds it (config-overlay.ts), which the capture runs before releasing: the
 * shared cache `.sh-config/` with its lock `.sh-config.lock`, and a session's link to it
 * `leaves/<sid>/.sh-config` (on a microVM the workspace is the seed's checkout, so they are in it).
 */
export const PATCH_EXCLUDES = [
  ':(exclude).moca-*',
  ':(exclude).sh-config*',
  ':(exclude,glob)leaves/*/.sh-config',
];

/**
 * The diff's output fixed against the workspace's and the image's git config, which the template
 * or the agent controls: no color, no external diff or textconv, `a/` and `b/` prefixes, no renames
 * (one patch for one end state), so the patch applies like a stock agent's `git diff` output.
 */
const PATCH_DIFF =
  'git -c color.ui=never -c color.diff=never -c diff.noprefix=false -c diff.mnemonicPrefix=false ' +
  '-c diff.relative=false diff --cached --binary --no-color --no-ext-diff --no-textconv ' +
  '--no-renames --src-prefix=a/ --dst-prefix=b/';

/**
 * The capture (spec §5.1), run in the session's workspace: the baseline on the first line, then
 * the diff (PATCH_DIFF) from it to the whole workspace now, staged in a throwaway index so the
 * workspace's own index is untouched. Moca's own files (PATCH_EXCLUDES) are left out; the
 * workspace's .gitignore applies, as in a stock agent's `git add -A`. The baseline is read from a
 * file the agent can write, so it must be a full commit id (40 or 64 hex), never an option or a rev
 * name of the agent's choosing: anything else exits 93, reported as an error.
 */
export function buildPatchCaptureScript(workspace: string): string {
  return [
    `cd ${shq(workspace)} || exit 90`,
    `BASE=$(cat ${SEED_BASELINE} 2>/dev/null || git rev-parse --verify -q HEAD) && [ -n "$BASE" ] || exit 91`,
    `case "$BASE" in *[!0-9a-f]*) exit 93 ;; esac`,
    `[ "\${#BASE}" -eq 40 ] || [ "\${#BASE}" -eq 64 ] || exit 93`,
    `D=$(mktemp -d) || exit 92`,
    `export GIT_INDEX_FILE="$D/index"`,
    `git read-tree "$BASE" && git add -A -- . ${PATCH_EXCLUDES.map(shq).join(' ')} && printf '%s\\n' "$BASE" && ${PATCH_DIFF} "$BASE"`,
    `rc=$?; rm -rf "$D"; exit $rc`,
  ].join('\n');
}

/**
 * Takes a templated session's patch after its turn (spec §5.1). Never throws: a capture that fails
 * is reported as `{ error }` on the result, and the turn's own outcome stands.
 */
export async function captureTurnPatch(
  transport: Pick<SandboxTransport, 'exec'>,
  workspace: string,
  maxBytes: number,
): Promise<TurnWorkspace> {
  try {
    const { stdout, exitCode, truncated } = await transport.exec(
      buildPatchCaptureScript(workspace),
      { timeout: 120 },
    );
    if (truncated) return { patchRefused: 'too_large' };
    if (exitCode !== 0) {
      const why =
        exitCode === 91
          ? 'no baseline commit in the workspace'
          : exitCode === 93
            ? 'the baseline is not a commit id'
            : `capture exited ${exitCode ?? 'none: signal'}`;
      return { error: why };
    }
    const nl = stdout.indexOf(0x0a);
    if (nl < 0) return { error: 'capture printed no baseline' };
    const baseline = stdout.subarray(0, nl).toString('utf8').trim();
    const patch = stdout.subarray(nl + 1);
    const facts = {
      baseline,
      patchSha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
      patchBytes: patch.byteLength,
    };
    if (patch.byteLength > maxBytes) return { ...facts, patchRefused: 'too_large' };
    const text = patch.toString('utf8');
    return Buffer.from(text, 'utf8').equals(patch)
      ? { ...facts, patch: text }
      : { ...facts, patchBase64: patch.toString('base64') };
  } catch (err) {
    return { error: `capture failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

/**
 * The result with a templated session's patch (spec §5.1): only for a turn that leased its sandbox
 * (an injected one is its caller's; a leaf takes its own patch) on a session with a template.
 */
export async function withWorkspacePatch(
  result: TurnResult,
  acquired: Pick<AcquiredTurnSandbox, 'leased' | 'sandbox'>,
  template: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<TurnResult> {
  if (!acquired.leased || !acquired.sandbox || !template) return result;
  const workspace = await captureTurnPatch(
    acquired.sandbox.transport,
    acquired.sandbox.podCwd,
    patchMaxBytes(env),
  );
  return { ...result, workspace };
}

/** The `workspace_reset` frame for a placement that moved the session, else null (P6.3 spec §6). */
export function placementFrame(
  sessionId: string,
  p: TurnPlacement | undefined,
): TurnStreamFrame | null {
  if (!p?.workspaceReset) return null;
  return {
    type: 'workspace_reset',
    sessionId,
    from: p.workspaceReset.from,
    tier: p.tier,
    reason: p.workspaceReset.reason,
  };
}

/** Where a turn ran, in the shape a result carries it (`TurnResult.sandbox`) and `onPlacement` gets. */
function placementView(p: TurnPlacement): NonNullable<TurnResult['sandbox']> {
  return {
    id: p.sandboxId,
    tier: p.tier,
    ...(p.seed ? { seed: p.seed } : {}),
    ...(p.workspaceReset ? { workspaceReset: p.workspaceReset } : {}),
  };
}

/** The result, plus where the turn ran -- what a JSON caller and the runtime report read. */
export function withPlacement(result: TurnResult, p: TurnPlacement | undefined): TurnResult {
  if (!p) return result;
  return { ...result, sandbox: placementView(p) };
}

/**
 * Which header a caller's credential travels in (#368), chosen by the control plane from the
 * credential's binding. A gateway reads `Authorization: Bearer`; api.anthropic.com reads an API key
 * only from `x-api-key`. Absent means `authorization`: what an older control plane sends, and what
 * placeholder mode always uses (the injector picks the upstream header there).
 */
export type InferenceAuthHeader = 'authorization' | 'x-api-key';

/**
 * The caller's credential as it rides upstream — TAGGED, because the same field carries two
 * incompatible things (MU1 spec §3.6):
 *
 *   placeholder — an inert, subject-derived stand-in; RC1's `static-inject` rewrites it to the real
 *                 credential from a mounted secret_dir (P5 §3.1-§3.2).
 *   direct      — the real token, resolved per subject by the control plane, with no injector in the
 *                 path. MU1's interim mode; MU3 deletes it.
 *
 * A bare string would make the two indistinguishable, and both failure directions are silent: a
 * placeholder-mode deployment with a misconfigured injector sends the placeholder upstream and gets an
 * opaque auth error, while a direct-mode deployment that later grows an injector has its REAL key
 * rewritten. The tag makes the mode assertable rather than inferred. `header` is which of the two
 * headers it goes in (see InferenceAuthHeader).
 */
export type UpstreamCredential =
  | { mode: 'placeholder'; value: string; header?: InferenceAuthHeader }
  | { mode: 'direct'; value: string; header?: InferenceAuthHeader };

/**
 * The model a control-plane session names, with the limits its catalog reported (per-session model
 * spec §4.5). Plain data from the exchange; sessionModelFor turns it into a pi model.
 */
export interface SessionModelSpec {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export interface TurnConfig {
  redisUrl?: string;
  cwd?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  /**
   * The per-request credential the control plane resolved for THIS turn's subject (MU1 spec §3.4).
   * Takes precedence over `anthropicAuthToken` and the environment. Absent for every existing caller
   * (leaf, CLI, unauthenticated `/turn`), which is what keeps this change additive.
   */
  upstreamCredential?: UpstreamCredential;
  model?: string;
  provider?: string;
  /**
   * Set by the server entry points (startServer, the P6 worker). A server-mode turn must run its tools
   * in a sandbox and uses a locked-down resource loader (MI1 §5 R3, R4). Absent for the CLI.
   */
  serverMode?: boolean;
  /** Server mode only: allow local tools when no sandbox resolves. SH_LOCAL_TOOLS=1; refused under multi tenancy. */
  allowLocalTools?: boolean;
  /**
   * The session's sandbox tier, as the control plane's exchange returned it (P6.3 spec §3.4). Absent
   * for every caller without a control plane; selectPoolSandbox then uses SH_SANDBOX_DEFAULT_TIER.
   */
  sandboxTier?: string;
  /**
   * The session's sandbox template and its seed, from the exchange (session-templates spec §3.4).
   * Absent: the session runs only on untemplated workers, and nothing is seeded.
   */
  sandboxTemplate?: string;
  sandboxSeed?: string;
  /** Where sandboxSeed came from, from the exchange: the pinned build's spec, or the declared list. */
  sandboxSeedSource?: 'build' | 'declared';
  /**
   * The build the session's template resolved to (`sha256:…`, combined control plane spec §3.4).
   * Set: only workers labelled `moca.dev/build=<it>` serve the turn.
   */
  sandboxBuildId?: string;
  /**
   * The session's model, from the exchange (per-session model spec §5.1). Read by executeTurn only:
   * `model` above is also read by /runs, which must not inherit an id pi's registry may not know.
   */
  sessionModel?: SessionModelSpec;
}

export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** Resolve model + provider as runtime inputs: config > env > default. */
export function resolveModelSelection(
  config?: { model?: string; provider?: string },
  env: NodeJS.ProcessEnv = process.env,
): ModelSelection {
  return {
    provider: config?.provider ?? env.SH_MODEL_PROVIDER ?? 'anthropic',
    modelId: config?.model ?? env.SH_MODEL ?? 'claude-opus-4-8',
  };
}

/**
 * Synthesize a model object for an endpoint that speaks the Anthropic Messages wire format
 * but serves a model id NOT in pi-ai's built-in registry — e.g. an in-cluster vLLM/llm-d
 * server whose /v1/messages is Anthropic-compatible but which requires its own served model
 * name (meta-llama/Llama-3.1-8B-Instruct) verbatim in the request body.
 *
 * Opt-in via SH_MODEL_CUSTOM=1. SH_MODEL is used as-is (id + name), ANTHROPIC_BASE_URL is the
 * endpoint. applyModelGateway() still layers Bearer auth + the gateway compat flags on top,
 * so this only supplies the pieces requireModel() otherwise reads from the registry. The
 * cost/context numbers are placeholders (self-hosted, not billed); contextWindow/maxTokens are
 * conservative defaults — override via SH_MODEL_CONTEXT_WINDOW / SH_MODEL_MAX_TOKENS if needed.
 */
/**
 * Parse SH_MODEL_HEADERS — a JSON object of extra request headers to send to a custom endpoint
 * (e.g. `{"RITS_API_KEY":"${RITS_API_KEY}"}`) — into a header map. Empty/absent ⇒ {}. Throws on
 * non-object JSON.
 *
 * String values support `${VAR}` interpolation from `env`, so a secret header value can be supplied
 * via a secretKeyRef env var (e.g. RITS_API_KEY) rather than an inline literal in the manifest.
 * An unset `${VAR}` interpolates to the empty string.
 */
function parseModelHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.SH_MODEL_HEADERS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `SH_MODEL_HEADERS must be a JSON object of header name→value pairs (got: ${raw}).`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`SH_MODEL_HEADERS must be a JSON object of header name→value pairs.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] =
      typeof v === 'string'
        ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '')
        : String(v);
  }
  return out;
}

function synthesizeCustomModel(
  modelId: string,
  env: NodeJS.ProcessEnv,
): Model<'anthropic-messages'> {
  // SH_MODEL_BASE_URL is the protocol-neutral knob; ANTHROPIC_BASE_URL is the back-compat fallback.
  const baseUrl = env.SH_MODEL_BASE_URL || env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      `SH_MODEL_CUSTOM=1 (anthropic) requires SH_MODEL_BASE_URL or ANTHROPIC_BASE_URL (the Anthropic-compatible endpoint to send "${modelId}" to).`,
    );
  }
  const contextWindow = Number(env.SH_MODEL_CONTEXT_WINDOW) || 131072;
  const maxTokens = Number(env.SH_MODEL_MAX_TOKENS) || 8192;
  // Typed as Model<"anthropic-messages"> (not `as ReturnType<typeof getModel>`) so tsc checks
  // the shape — if pi-ai's Model type gains a required field, this fails to compile instead of
  // silently omitting it.
  const model: Model<'anthropic-messages'> = {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    // provider MUST be "anthropic" (not a synthetic tag): pi resolves the request API key by
    // provider name — authStorage.getApiKey(provider) maps "anthropic" -> ANTHROPIC_API_KEY
    // (which applyModelGateway seeds only with a constant sentinel when a Bearer token is in
    // play, never with the token itself), whereas an unknown provider like "custom" has no
    // env-key mapping and fails with `No API key found for "custom"`. Request routing is by
    // baseUrl + api, not provider, so tagging it "anthropic" sends traffic to the custom baseUrl
    // while satisfying the key lookup. Overridable via SH_MODEL_PROVIDER.
    provider: (env.SH_MODEL_PROVIDER ?? 'anthropic') as Model<'anthropic-messages'>['provider'],
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return model;
}

/**
 * Synthesize an OpenAI Chat Completions model for an OpenAI-compatible endpoint (RITS / vLLM /
 * OpenAI / Azure / most OSS gateways), reached via SH_MODEL_CUSTOM=1 +
 * SH_MODEL_API=openai-completions. Pi's openai-completions provider reads `model.baseUrl` and
 * spreads `model.headers` into the request; the API key is resolved from OPENAI_API_KEY.
 *
 * Auth (SH_MODEL_AUTH):
 *   - "bearer" (default): pi sends `Authorization: Bearer <OPENAI_API_KEY>` (standard OpenAI/vLLM).
 *   - "custom-header": the endpoint authenticates via a header in SH_MODEL_HEADERS (e.g. RITS's
 *     `RITS_API_KEY`); strip the default Authorization so the SDK Bearer isn't also sent. pi's
 *     client still requires a non-empty OPENAI_API_KEY, so seed a placeholder when unset.
 *   - "none": no auth header.
 */
function synthesizeOpenAICompletionsModel(
  modelId: string,
  env: NodeJS.ProcessEnv,
): Model<'openai-completions'> {
  const baseUrl = env.SH_MODEL_BASE_URL || env.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      `SH_MODEL_CUSTOM=1 with SH_MODEL_API=openai-completions requires SH_MODEL_BASE_URL or OPENAI_BASE_URL (the OpenAI-compatible endpoint to send "${modelId}" to).`,
    );
  }
  const contextWindow = Number(env.SH_MODEL_CONTEXT_WINDOW) || 131072;
  const maxTokens = Number(env.SH_MODEL_MAX_TOKENS) || 8192;
  const auth = env.SH_MODEL_AUTH ?? 'bearer';
  const headers: Record<string, string | null> = { ...parseModelHeaders(env) };
  if (auth === 'custom-header' || auth === 'none') {
    // Endpoint authenticates via a custom header (already in `headers`) or not at all — strip the
    // SDK's default Authorization Bearer so an unknown/empty Bearer isn't sent. pi's openai client
    // still requires a non-empty api key even when the Bearer is unused, so seed a placeholder.
    // Read and written on process.env because that is where pi looks. The one recorded exception
    // to R2's "the multi scrub leaves no OPENAI_API_KEY" (MI1 §5): like ANTHROPIC_API_KEY's
    // sentinel, the value is a constant that authenticates nothing.
    headers.Authorization = null;
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'unused';
  }
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    // provider "openai" so pi resolves the api key from OPENAI_API_KEY (env-api-keys.ts). Request
    // routing is by baseUrl + api; provider only drives the key lookup. Overridable via SH_MODEL_PROVIDER.
    provider: (env.SH_MODEL_PROVIDER ?? 'openai') as Model<'openai-completions'>['provider'],
    baseUrl,
    headers: headers as unknown as Record<string, string>,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return model;
}

/**
 * Resolve a model from the pi-ai registry, throwing a clear error when the id is unknown.
 * getModel() returns undefined for an unknown provider/model (e.g. the dotted
 * "claude-sonnet-4.6" is a github-copilot key, not an anthropic one) — without this guard
 * the caller crashes later on `baseModel.headers`. Returns the model object on success.
 *
 * SH_MODEL_CUSTOM=1 bypasses the registry entirely and synthesizes a model for a custom endpoint.
 * SH_MODEL_API selects the wire protocol (default "anthropic"):
 *   - "anthropic"          → Anthropic Messages via SH_MODEL_BASE_URL/ANTHROPIC_BASE_URL (default;
 *                            covers direct Anthropic + LiteLLM Anthropic-format). synthesizeCustomModel().
 *   - "openai-completions" → OpenAI Chat Completions via SH_MODEL_BASE_URL/OPENAI_BASE_URL + headers/auth
 *                            (RITS/vLLM/OpenAI/Azure). synthesizeOpenAICompletionsModel().
 *   - "openai-responses"   → deferred (see docs/specs/2026-08-20-multi-protocol-model-provider-design.md).
 * See that spec for the config schema.
 */
export function requireModel(
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.SH_MODEL_CUSTOM === '1') {
    const api = env.SH_MODEL_API ?? 'anthropic';
    switch (api) {
      case 'anthropic':
      case 'anthropic-messages':
        return synthesizeCustomModel(modelId, env);
      case 'openai-completions':
        return synthesizeOpenAICompletionsModel(modelId, env);
      case 'openai-responses':
        throw new Error(
          `SH_MODEL_API=openai-responses is not yet implemented (deferred; see docs/specs/2026-08-20-multi-protocol-model-provider-design.md §7). Use openai-completions.`,
        );
      default:
        throw new Error(
          `Unknown SH_MODEL_API "${api}". Expected: anthropic | openai-completions | openai-responses.`,
        );
    }
  }
  const model = getModel(provider as never, modelId as never);
  if (model) return model;
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(
      `Unknown model provider "${provider}". Known providers: ${providers.join(', ')}.`,
    );
  }
  const ids = (getModels(provider as never) as Array<{ id: string }>).map((m) => m.id);
  // Surface the dot-vs-dash (or case) twin if one exists — the common mistake.
  const norm = (s: string) => s.replace(/[.\-]/g, '').toLowerCase();
  const suggestions = ids.filter((id) => norm(id) === norm(modelId));
  const hint = suggestions.length
    ? `Did you mean: ${suggestions.join(', ')}?`
    : `Known "${provider}" ids include: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ', …' : ''}.`;
  throw new Error(`Unknown model "${provider}/${modelId}" — not in the pi-ai registry. ${hint}`);
}

/**
 * Build a session's model (per-session model spec §5.2). `api.anthropic.com` keeps pi's registry,
 * exactly as today. Any other endpoint is a gateway (LiteLLM) whose names pi may not know, so the
 * model is always synthesized -- through requireModel's own SH_MODEL_CUSTOM path, with the session's
 * limits overlaid on the environment's -- even when the registry happens to know the id.
 */
export function sessionModelFor(
  m: SessionModelSpec,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof requireModel> {
  if (baseUrl && URL.parse(baseUrl)?.hostname === 'api.anthropic.com') {
    const { SH_MODEL_CUSTOM: _custom, ...registryEnv } = env;
    return requireModel('anthropic', m.id, registryEnv);
  }
  const base = requireModel(env.SH_MODEL_PROVIDER ?? 'anthropic', m.id, {
    ...env,
    SH_MODEL_CUSTOM: '1',
    ...(baseUrl ? { SH_MODEL_BASE_URL: baseUrl } : {}),
    ...(m.contextWindow ? { SH_MODEL_CONTEXT_WINDOW: String(m.contextWindow) } : {}),
    ...(m.maxTokens ? { SH_MODEL_MAX_TOKENS: String(m.maxTokens) } : {}),
  });
  return {
    ...base,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.vision ? { input: ['text', 'image'] } : {}),
  } as typeof base;
}

export interface TurnResult {
  sessionId: string;
  response: string;
  stopReason: string;
  errorMessage?: string;
  usage?: LeafUsage;
  sandbox?: { id: string; tier: string; seed?: TurnSeed; workspaceReset?: WorkspaceReset };
  /** A templated session's workspace patch after the turn (session-templates spec §5.1). */
  workspace?: TurnWorkspace;
}

/**
 * Apply the LLM-gateway transform to a pi-ai model object.
 *
 * When a gateway base URL or auth token is in play (config or env), rewrite the model to
 * call the gateway with Bearer auth and strip `x-api-key` (the gateway authenticates via
 * Authorization) -- or, for a caller credential whose header is `x-api-key` (a raw Anthropic API
 * key, #368), send it as `x-api-key` and strip Authorization instead. Also seeds `ANTHROPIC_API_KEY` with a constant sentinel when unset, since some
 * pi-ai code paths still read the env var. Returns the base model unchanged when neither a
 * gateway base nor a token is configured (direct-key mode).
 *
 * Shared by runTurn (interactive) and runLeaf (job mode) so both honor the same credentials.
 */
export function applyModelGateway<M extends { headers?: Record<string, unknown> }>(
  baseModel: M,
  config?: Pick<TurnConfig, 'anthropicBaseUrl' | 'anthropicAuthToken' | 'upstreamCredential'>,
): M {
  // The Anthropic gateway rewrite (Bearer + strip x-api-key + seed ANTHROPIC_API_KEY, and the
  // litellm compat-flag disables) applies ONLY to the Anthropic-messages path. OpenAI-compatible
  // models carry their own baseUrl/headers/auth from synthesizeOpenAICompletionsModel — leave
  // them untouched (else we'd clobber baseUrl with ANTHROPIC_BASE_URL and inject a wrong Bearer).
  // An absent `api` IS the Anthropic path: pi's own Anthropic models and this file's synthesized
  // one both carry 'anthropic-messages', and the fixtures and callers that omit the field mean it.
  // Anything else -- including an empty string -- is some other wire protocol.
  const api = (baseModel as { api?: string }).api ?? 'anthropic-messages';
  if (api !== 'anthropic-messages') {
    // A caller's own credential can only be applied on this path. Returning the model unchanged
    // would discard it silently and send the turn on the shared operator credential instead --
    // spending one principal's turn on another's key (MI1 §5 R2). Fail the turn rather than that.
    if (config?.upstreamCredential) {
      throw new Error(
        `a per-caller upstream credential cannot be applied to a '${api}' model: only anthropic-messages models carry it`,
      );
    }
    return baseModel;
  }
  // `||` (not `??`) so an empty-string config value falls back to the env var rather than
  // suppressing it — "" is a "not set" sentinel here, not a meaningful credential.
  const upstream = config?.upstreamCredential?.value ? config.upstreamCredential : undefined;
  const authToken =
    upstream?.value || config?.anthropicAuthToken || process.env.ANTHROPIC_AUTH_TOKEN;
  // Only a caller's own credential carries a header choice. The deployment's token is a gateway
  // Bearer, so an empty upstream credential that falls through to it must not bring its header along.
  const authHeader = upstream?.header ?? 'authorization';
  // Pi resolves the request key BY PROVIDER NAME, so ANTHROPIC_API_KEY must exist whenever a Bearer
  // token is in play. It is seeded with a constant that names no one, never with the caller's
  // token: no caller's credential becomes process-wide (MI1 §5 R2). The Bearer header below carries
  // the real token and `x-api-key: null` strips the sentinel.
  if (authToken && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = AMBIENT_KEY_SENTINEL;
  }
  const gatewayBase = config?.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!gatewayBase && !authToken) return baseModel;
  return {
    ...baseModel,
    ...(gatewayBase ? { baseUrl: gatewayBase } : {}),
    ...(gatewayBase
      ? {
          // Anthropic-compatible gateways (e.g. litellm) reject the per-tool extras the
          // direct Anthropic API accepts. Without this, tool-bearing requests fail with
          // "tools.0.custom.eager_input_streaming: Extra inputs are not permitted". Disable
          // the gateway-incompatible compat flags so convertTools() omits those fields.
          compat: {
            ...(baseModel as { compat?: Record<string, unknown> }).compat,
            supportsEagerToolInputStreaming: false,
            supportsCacheControlOnTools: false,
            supportsLongCacheRetention: false,
          },
        }
      : {}),
    ...(authToken
      ? {
          headers: (authHeader === 'x-api-key'
            ? {
                ...baseModel.headers,
                // Replaces the sentinel the SDK would send from ANTHROPIC_API_KEY; the caller's key
                // lives in this model's headers only, never in the environment (MI1 §5 R2).
                'x-api-key': authToken,
                Authorization: null,
              }
            : {
                ...baseModel.headers,
                Authorization: `Bearer ${authToken}`,
                'x-api-key': null, // strip x-api-key when using gateway Bearer auth
                // pi merges model.headers OVER its OAuth defaults with a plain Object.assign, so a
                // model-level anthropic-beta replaces the betas pi computes for an sk-ant-oat key —
                // including oauth-2025-04-20, without which the token 401s (PR #658 review). Keep
                // the model's betas and append the one the token needs. (The claude-code beta and
                // pi's per-request betas are lost to such an override either way; auth survives.)
                ...(isAnthropicOauthToken(authToken) && carriesAnthropicBeta(baseModel.headers)
                  ? {
                      'anthropic-beta': appendOauthBeta(
                        (baseModel.headers as Record<string, unknown>)['anthropic-beta'],
                      ),
                    }
                  : {}),
              }) as unknown as Record<string, string>,
        }
      : {}),
  };
}

/** An Anthropic OAuth (Claude Pro/Max subscription) token; the one Bearer value api.anthropic.com reads (#595). */
function isAnthropicOauthToken(token: string): boolean {
  return token.startsWith('sk-ant-oat');
}

/** Whether the model's own headers name anthropic-beta, which would override pi's OAuth betas. */
function carriesAnthropicBeta(headers: Record<string, unknown> | undefined): boolean {
  return typeof headers?.['anthropic-beta'] === 'string';
}

/** The model's beta list plus the oauth beta, unless it already carries it. */
function appendOauthBeta(beta: unknown): string {
  const list = beta as string;
  return list.includes('oauth-2025-04-20') ? list : `${list},oauth-2025-04-20`;
}

/**
 * The per-session auth storage for a caller credential that is an Anthropic OAuth token (#595).
 *
 * pi-ai's Anthropic client enables its OAuth wire shape — Authorization: Bearer plus the
 * `anthropic-beta: oauth-2025-04-20` header and the Claude Code identity it sends for its own
 * Claude Pro logins — only when the API key IT resolves (authStorage.getApiKey, not a header)
 * is an sk-ant-oat token. A caller's credential normally rides model.headers, which cannot carry
 * any of that; this hands pi the token through an IN-MEMORY AuthStorage scoped to the session's
 * own registry instead. Nothing is persisted and nothing is written to the environment, so no
 * caller's credential becomes process-wide (MI1 §5 R2 — the same boundary the env sentinel holds).
 *
 * Beyond the auth header, pi's OAuth path changes the turn's requests (PR #658 review): it
 * prepends the Claude Code system prompt ("You are Claude Code…") ahead of the harness's own,
 * renames tools to Claude Code's wire names (toClaudeCodeName), and drops the session-affinity
 * headers the API-key branch sends. A subscription token therefore only ever runs as a Claude
 * Code-shaped session — which is also the terms question the reviewer flagged: consumer OAuth
 * tokens are meant for Anthropic's own apps.
 *
 * Undefined for every other credential, which keeps today's model.headers path unchanged.
 */
export function oauthAuthStorage(
  model: { provider: string },
  config?: Pick<TurnConfig, 'upstreamCredential'>,
): AuthStorage | undefined {
  const credential = config?.upstreamCredential;
  // Bearer-bound sk-ant-oat only: placeholders never reach upstream as themselves, and the control
  // plane refuses an OAuth token on an x-api-key binding at PUT (credential-store.ts).
  if (!isAnthropicOauthToken(credential?.value ?? '')) return undefined;
  if (credential!.header === 'x-api-key') return undefined;
  const storage = AuthStorage.inMemory();
  // Keyed on the provider pi resolves the request key by, so a synthesized model's overridden
  // provider name (SH_MODEL_PROVIDER) resolves the same override.
  storage.setRuntimeApiKey(model.provider, credential!.value);
  return storage;
}

/**
 * Best-effort cumulative token usage summed off a session's loaded branch.
 * Mirrors the defensive pattern budget-voter.ts uses: pi's getSessionStats()
 * reads message.usage non-defensively and throws on this build, so we walk
 * getBranch() directly. Always returns a LeafUsage (zeros for an empty branch);
 * callers wrap the call in try/catch so a usage hiccup never fails the turn.
 */
export function sumBranchUsage(sm: unknown): LeafUsage {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const branch = (sm as { getBranch?: () => unknown[] }).getBranch?.() ?? [];
  for (const entry of branch as Array<{
    type?: string;
    message?: {
      role?: string;
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
  }>) {
    if (entry?.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
      const m = entry.message.usage;
      u.input += m.input;
      u.output += m.output;
      u.cacheRead += m.cacheRead;
      u.cacheWrite += m.cacheWrite;
    }
  }
  return { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite };
}

export interface BaseLoaderInputs {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  extensionFactories: unknown[];
}

/**
 * Assemble DefaultResourceLoader's options.
 *
 * Extracted as a pure function so the back-compat guarantee is assertable: with no promoted
 * bundle the result has EXACTLY the four base keys, which is what makes an absent `configRef`
 * byte-identical to today rather than merely intended to be.
 */
export function resourceLoaderOptionsFor(
  base: BaseLoaderInputs,
  promoted?: PromotedConfig,
): Record<string, unknown> {
  return { ...base, ...promotedLoaderOptions(promoted) };
}

/**
 * Everything the Pi resource loader is built from, in one place so the server-mode lockdown is
 * assertable (MI1 §5 R4). Outside server mode the result is exactly today's: `SettingsManager.create`
 * with default options and `resourceLoaderOptionsFor`'s keys.
 *
 * In server mode: discovered extension FILES are off (the harness's own extensions arrive as
 * extensionFactories, which noExtensions does not affect); the project is untrusted, so no project
 * settings and no <cwd>/.pi/SYSTEM.md or APPEND_SYSTEM.md are read; no ancestor AGENTS.md/CLAUDE.md
 * walk happens; and no skill, prompt template or theme is discovered from $HOME, the agent directory
 * or the project. A promoted bundle still supplies its context through agentsFilesOverride and its
 * skills and prompt templates through additionalSkillPaths/additionalPromptTemplatePaths, which pi
 * loads even when discovery is off.
 */
export function turnLoaderInputs(opts: {
  config?: TurnConfig;
  cwd: string;
  extensionFactories: unknown[];
  promotedConfig?: PromotedConfig;
}): { agentDir: string; settingsManager: SettingsManager; loaderOptions: Record<string, unknown> } {
  const locked = opts.config?.serverMode === true;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(
    opts.cwd,
    agentDir,
    locked ? { projectTrusted: false } : {},
  );
  const loaderOptions = {
    ...resourceLoaderOptionsFor(
      { cwd: opts.cwd, agentDir, settingsManager, extensionFactories: opts.extensionFactories },
      opts.promotedConfig,
    ),
    ...(locked
      ? {
          noExtensions: true,
          noContextFiles: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        }
      : {}),
  };
  return { agentDir, settingsManager, loaderOptions };
}

export interface ExecuteTurnInput {
  prompt: string;
  sessionId?: string;
  config?: TurnConfig;
  createIfAbsent: boolean; // session-open policy: false = /turn 404 contract; true = create-or-resume
  selection?: ModelSelection; // pre-resolved model/provider; default: resolveModelSelection(config)
  onEvent?: (frame: TurnStreamFrame) => void; // present ⇒ append sseExtension(onEvent) to the stack
  signal?: AbortSignal; // present ⇒ signal → session.abort() (client disconnect)
  sandbox?: TurnSandbox; // pre-leased sandbox; absent ⇒ resolve from the environment (/turn)
  /** Resolved promoted Claude Code config; absent ⇒ the loader is built exactly as before. */
  promotedConfig?: PromotedConfig;
  /** A session's config bundle digest (ADR-0038); resolved and overlaid here unless promotedConfig is given. */
  configRef?: string;
  /**
   * Where a leased turn runs (P6.3 spec §6), called once, as soon as the lease is taken and before any
   * model work -- with exactly what the result's `sandbox` would carry. It exists because a turn that
   * THROWS returns no result: a caller reporting placement from `result.sandbox` alone would never
   * record that a session which fell back to a fresh sandbox, and then failed, lost its workspace.
   * Not called when nothing was leased (an injected sandbox, the single-pod path, no pool).
   */
  onPlacement?: (p: NonNullable<TurnResult['sandbox']>) => void;
}

/**
 * Shared turn entry point: opens (or, when createIfAbsent, creates) a session, leases a sandbox for
 * the turn's tool calls, then hands both to the core, which wires the extension stack, resolves the
 * model, runs one Pi turn, and extracts text + best-effort usage.
 *
 * runTurn (`/turn`) binds createIfAbsent:false — a missing session id 404s ("no session in
 * backend"). A prompt leaf binds createIfAbsent:true — a fresh id creates, a re-dispatched id
 * resumes — and may pass a pre-resolved `selection` (leaf precedence over /turn's config default).
 *
 * The two steps are in that order on purpose, and the order is pinned: see the note below.
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<TurnResult> {
  const cwd = input.config?.cwd ?? process.cwd();

  // Open the session BEFORE acquiring, because the two failures are not equal: a missing session is
  // permanent (404 `session_not_found`) and no capacity is transient (503). Acquiring first threw the
  // capacity error before the 404 could be raised, so a `/turn` for a session that will never exist
  // was told to retry — every such request, in `records` mode with nothing attached yet — and it did
  // a pod list, N `lease.load()`s and an acquire/release on the way to failing. Ordering is the whole
  // fix; `turnErrorStatus` already prefers the 404, it just never got the chance to.
  const opened = await openTurnSession(input, cwd);

  // The lease lifecycle stays HERE rather than in executeTurnCore so that every exit path returns it:
  // a normal return, a throw, and an abort (input.signal → session.abort(), which resolves the prompt
  // and unwinds through this finally). A leaked lease would hold a pool slot for its full TTL and, at
  // E8's concurrency, starve the pool it is meant to measure.
  // The OPENED session's id, not input.sessionId: a /turn that omitted it has just been given one by
  // openTurnSession, and leasing under `undefined` keyed the workspace by the per-turn lease holder
  // (`anon:<uuid>`) -- a key the microVM tier refuses, and one no later turn of the session reuses.
  const acquired = await acquireTurnSandbox(
    input.sandbox,
    process.env,
    cwd,
    opened.sessionManager.getSessionId(),
    {},
    input.config?.sandboxTier,
    input.config?.sandboxTemplate
      ? {
          id: input.config.sandboxTemplate,
          ...(input.config.sandboxSeed ? { seed: input.config.sandboxSeed } : {}),
          ...(input.config.sandboxSeedSource ? { seedSource: input.config.sandboxSeedSource } : {}),
          ...(input.config.sandboxBuildId ? { build: input.config.sandboxBuildId } : {}),
        }
      : undefined,
  );

  // A null sandbox would leave Pi's built-in tools running LOCALLY, in this process (MI1 §5 R3). Both
  // ways a turn gets here — no pool resolved, or a leaf's injected sandbox — meet at this line.
  try {
    assertServerSandbox(input.config, acquired.sandbox);
  } catch (err) {
    await acquired.release();
    throw err;
  }

  let leaseRenewal: ReturnType<typeof setInterval> | undefined;
  if (acquired.leased) {
    // leaseTimings, not Number(env.X ?? …): an empty or unparseable KAGENTI_SANDBOX_HEARTBEAT_MS
    // yielded 0/NaN, which setInterval clamps to 1 ms — ~1000 renewals a second per in-flight turn,
    // against the Redis this change exists to relieve. It also clamps the interval inside the TTL.
    leaseRenewal = setInterval(() => {
      // Best-effort: a failed renewal must not reject into an unhandled rejection and kill the
      // worker. The lease's TTL expiring is the safe outcome — the sandbox returns to the pool.
      void acquired.heartbeat().catch(() => {});
    }, leaseTimings(process.env).heartbeatMs);
  }

  let attached: AttachedPromotedConfig | undefined;
  try {
    // First, so a turn that fails anywhere after this still has its placement recorded -- see
    // `onPlacement`. Inside the try for the same reason as the frame below: a throwing callback must
    // still release the lease.
    if (acquired.placement) input.onPlacement?.(placementView(acquired.placement));
    // After the renewal timer is armed: fetching and overlaying a multi-MB bundle can outlast a lease.
    // Before the reset frame: that frame flushes the SSE headers, and a missing bundle must still be a
    // plain 410, not an error frame.
    if (input.configRef && !input.promotedConfig) {
      const sessionId = opened.sessionManager.getSessionId();
      attached = await attachPromotedConfig({
        digest: input.configRef,
        sessionId,
        // Per turn: concurrent turns of one session must not release each other's overlay.
        refId: `${sessionId}.${randomUUID().replace(/-/g, '')}`,
        sandbox: acquired.sandbox,
        redisUrl: input.config?.redisUrl,
      });
    }
    // Before any model output, so the notice precedes the turn it explains. It also flushes the SSE
    // headers: a later pre-content failure then degrades to an error frame instead of a status code,
    // which is the same regime as any failure after the first token. Inside the try, so a sink that
    // throws still releases the lease below.
    const resetFrame = placementFrame(opened.sessionManager.getSessionId(), acquired.placement);
    if (resetFrame) input.onEvent?.(resetFrame);
    const result = withPlacement(
      await executeTurnCore(
        attached ? { ...input, promotedConfig: attached.promotedConfig } : input,
        acquired.sandbox,
        opened,
      ),
      acquired.placement,
    );
    // A templated session's end state, while the lease is still held and renewed (spec §5.1).
    return await withWorkspacePatch(result, acquired, input.config?.sandboxTemplate, process.env);
  } finally {
    // Detach while the lease is still renewed: it is a remote exec that can outlast the lease TTL.
    // Then clear before release, so a throwing release never leaves the interval running.
    await attached?.detach().catch(() => {});
    if (leaseRenewal) clearInterval(leaseRenewal);
    await acquired.release().catch(() => {});
  }
}

/** The session a turn runs in, plus the store and buffered backend its extensions are wired to. */
interface OpenedTurnSession {
  store: RedisSessionBackend<FileEntry>;
  backend: BufferedRedisBackend;
  sessionManager: Awaited<ReturnType<typeof SessionManager.openFromCheckpoint>>;
}

/**
 * Open (or, when createIfAbsent, create) the turn's session.
 *
 * Split out of executeTurnCore so `executeTurn` can run it ahead of the pool acquire — see the note
 * there. Everything it builds is handed on, so the split adds no second store or backend.
 */
async function openTurnSession(input: ExecuteTurnInput, cwd: string): Promise<OpenedTurnSession> {
  const { sessionId, config, createIfAbsent } = input;
  const redisUrl = config?.redisUrl ?? 'redis://localhost:6379';

  // Shared per process, not per turn — see sharedSessionStore's note. One connection per turn leaked
  // to maxclients and killed every worker simultaneously on a sustained run.
  const store = sharedSessionStore(redisUrl);
  const backend = new BufferedRedisBackend(store);

  let sessionManager;
  if (sessionId) {
    if (createIfAbsent) {
      // create-or-resume: resume the durable session if present, else create a fresh one under the
      // supplied id. openFromCheckpoint throws "no session in backend" for a missing checkpoint;
      // fall back to create in that case, but re-throw any other error.
      try {
        sessionManager = await SessionManager.openFromCheckpoint(sessionId, backend, cwd);
      } catch (err) {
        if (err instanceof Error && err.message.includes('no session in backend')) {
          sessionManager = SessionManager.create(cwd, undefined, { id: sessionId }, backend);
        } else {
          throw err;
        }
      }
    } else {
      // /turn contract: a supplied id MUST already exist — openFromCheckpoint 404s otherwise.
      sessionManager = await SessionManager.openFromCheckpoint(sessionId, backend, cwd);
    }
  } else {
    sessionManager = SessionManager.create(cwd, undefined, undefined, backend);
  }

  return { store, backend, sessionManager };
}

async function executeTurnCore(
  input: ExecuteTurnInput,
  turnSandbox: TurnSandbox | null,
  opened: OpenedTurnSession,
): Promise<TurnResult> {
  const { prompt, config } = input;
  const cwd = config?.cwd ?? process.cwd();
  // Opened by executeTurn ahead of the pool acquire, so a missing session 404s before any lease work.
  const { store, backend, sessionManager } = opened;

  const budgetLimit = Number(process.env.SH_BUDGET_TOKENS);
  const budgetMargin = Number(process.env.SH_BUDGET_MARGIN);
  // acquireTurnSandbox (called by executeTurn, which owns the lease lifecycle) hands back exactly
  // k8sSandboxExtension's argument, and it is passed on untransformed below — so a leased
  // transport cannot be dropped by a field-by-field rebuild here.
  const sandbox = turnSandbox;
  // Surface whether sandbox routing actually resolved: a null sandbox means tool calls run in
  // the harness pod's own filesystem (local), not a sandbox — a common cause of "the file
  // never appeared in the sandbox". Cheap one-line signal in container logs.
  if (process.env.SH_MODEL_CUSTOM === '1') {
    const how = sandbox
      ? `${input.sandbox ? 'injected' : 'leased'} relay transport`
      : 'NULL (tools run LOCAL)';
    console.error(`[sandbox] resolved: ${how}`);
  }
  // One latch per turn, never shared: a replica serves many turns concurrently against
  // different hosts, and a module-level flag would fail one session's turn because some
  // other session's host filled up (#452).
  const capacity = createCapacityLatch();
  const extensionFactories = [
    flushExtension(backend),
    // Null sandbox ⇒ no extension ⇒ Pi's built-in tools run locally.
    ...(sandbox ? [k8sSandboxExtension({ ...sandbox, capacity })] : []),
    checkpointExtension(store, sessionManager),
    toolChoiceExtension(),
  ];
  if (Number.isFinite(budgetLimit) && budgetLimit > 0) {
    // session_start is not emitted in the headless path, so compute the pre-turn baseline
    // (cumulative spend already on the loaded branch) here and inject it into the voter.
    const budgetBaseline = branchSpend(sessionManager) ?? 0;
    extensionFactories.push(
      budgetVoterExtension(sessionManager, {
        limit: budgetLimit,
        baseline: budgetBaseline,
        ...(Number.isFinite(budgetMargin) && budgetMargin > 0 ? { margin: budgetMargin } : {}),
      }),
    );
  }

  if (input.onEvent) {
    // Streaming sink: same factory seam as flushExtension. Appended only when a caller wants
    // live frames; absent ⇒ /turn behaves exactly as today.
    extensionFactories.push(sseExtension(input.onEvent));
  }

  const { settingsManager, loaderOptions } = turnLoaderInputs({
    config,
    cwd,
    extensionFactories,
    promotedConfig: input.promotedConfig,
  });
  const resourceLoader = new DefaultResourceLoader(loaderOptions as never);
  await resourceLoader.reload();

  const { provider, modelId } = input.selection ?? resolveModelSelection(config);
  const baseModel = config?.sessionModel
    ? sessionModelFor(config.sessionModel, config.anthropicBaseUrl)
    : requireModel(provider, modelId);
  const model = applyModelGateway(baseModel, config);

  // An Anthropic OAuth token takes pi's own OAuth client path, not model.headers alone (#595).
  const authStorage = oauthAuthStorage(model, config);
  const { session } = await createAgentSession({
    sessionManager,
    model,
    resourceLoader,
    settingsManager,
    ...(authStorage ? { authStorage } : {}),
  });

  // Per-session model spec §5.3: a switch to a smaller window compacts here, not after a failed request.
  await compactIfOverflowing(session as never, input.signal);

  if (input.signal) wireAbort(input.signal, session);

  let response = '';
  let stopReason = 'end_turn';
  let errorMessage: string | undefined;

  // An abort that landed before the prompt (e.g. during pre-prompt compaction) cannot reach a run
  // that has not started: wireAbort's session.abort() is a no-op then. Report it, and spend nothing.
  if (input.signal?.aborted) {
    stopReason = 'aborted';
    errorMessage = 'Request aborted';
  } else {
    // After the pre-prompt compaction, so a compaction stays the branch's last entry for its check;
    // only on a turn that runs, so an aborted one records no switch it never made (R11).
    recordModelSwitch(sessionManager, model);
    await session.prompt(prompt);
    const lastMessage = session.state.messages.at(-1) as AssistantMessage | undefined;
    if (lastMessage?.role === 'assistant') {
      stopReason = lastMessage.stopReason ?? 'end_turn';
      if (stopReason === 'error' || stopReason === 'aborted') {
        errorMessage = lastMessage.errorMessage || `Request ${stopReason}`;
      } else {
        for (const content of lastMessage.content) {
          if (content.type === 'text') {
            response += content.text;
          }
        }
      }
    }
  }

  await backend.flush();

  // AFTER the flush, deliberately. The turn really did happen — entries, tool results and
  // the partial assistant message are all part of this session's history, and a session
  // whose checkpoint is missing the turn that hit the ceiling cannot be resumed cleanly
  // once the host has room again. So: persist, then fail.
  //
  // THROWN, not folded into stopReason. A capacity refusal is not this turn's outcome, it
  // is the absence of one: the caller must answer 503 with Retry-After and the SAME prompt
  // must be retryable, which a `{ stopReason: 'error' }` result does not express — every
  // reader of that treats the turn as spent (#452). Pi's own loop cannot do this for us,
  // because a tool throw becomes `isError: true` content and the loop continues.
  capacity.throwIfRefused();

  // Best-effort per-turn cumulative token usage; a usage hiccup must never fail a completed turn.
  let usage: LeafUsage | undefined;
  try {
    usage = sumBranchUsage(sessionManager);
  } catch {
    usage = undefined;
  }

  return {
    sessionId: sessionManager.getSessionId(),
    response,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Bridge an AbortSignal to a session's abort(): fire immediately if already aborted, else once on
 * the abort event. Pure and unit-testable — the server owns creating the signal (client disconnect
 * → AbortController), the core just bridges it to Pi's abort. (§3.2, §3.6)
 */
export function wireAbort(signal: AbortSignal, session: { abort: () => void }): void {
  if (signal.aborted) {
    session.abort();
    return;
  }
  signal.addEventListener('abort', () => session.abort(), { once: true });
}

/**
 * Thin wrapper preserving the `/turn` public signature and its 404-on-missing-session contract:
 * createIfAbsent:false makes a supplied-but-absent sessionId throw "no session in backend".
 */
export async function runTurn(
  prompt: string,
  sessionId?: string,
  config?: TurnConfig,
): Promise<TurnResult> {
  return executeTurn({ prompt, sessionId, config, createIfAbsent: false });
}
