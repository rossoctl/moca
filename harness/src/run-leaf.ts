import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import { RedisSessionBackend } from '@moca/session-backend';
import { k8sSandboxExtension, KubectlTransport } from '@moca/k8s-sandbox';
import {
  selectPoolSandbox,
  SandboxPoolSaturatedError,
  type SelectedSandbox,
} from './select-sandbox.js';
import { leaseTimings } from './lease-timings.js';
import { convergeWorkspace, cleanupWorkspace, captureWorkspaceDiff } from './converge.js';
import {
  setupSwebenchWorkspace,
  captureSwebenchDiff,
  cleanupSwebench,
  swebenchVenvDir,
  buildSwebenchSolvePrompt,
} from './swebench-setup.js';
import {
  executeTurn,
  resolveModelSelection,
  requireModel,
  applyModelGateway,
  sumBranchUsage,
  type TurnConfig,
  type TurnResult,
} from './run-turn.js';
import { BufferedRedisBackend } from './buffered-redis-backend.js';
import { flushExtension } from './flush-extension.js';
import { checkpointExtension } from './checkpoint-extension.js';
import {
  submitVerdictExtension,
  VERDICT_ENTRY_TYPE,
  type VerdictCapture,
} from './submit-verdict-tool.js';
import { verdictTerminationExtension } from './verdict-termination-extension.js';
import { validateVerdict, type Verdict } from './verdict.js';
import type { GateCapture } from './request-approval-tool.js';
import {
  computeGateState,
  decideSeed,
  validateDecision,
  type Decision,
  GATE_DECISION_ENTRY_TYPE,
} from './gate.js';
import { requestApprovalExtension } from './request-approval-tool.js';
import { gzipSync } from 'node:zlib';
import { createClient } from 'redis';
import { canonicalTar } from '@moca/config-bundle';
import { resolvePromotedConfig, type PromotedConfig } from './config-resolver.js';
import { overlayConfig, buildConfigCleanupScript } from './config-overlay.js';
import type { BundleRedisLike } from './config-store.js';

/**
 * Recover a verdict from a persisted `verdict` custom session entry (written by
 * submitVerdictExtension). Returns the validated verdict, or null if the entry is not a
 * verdict marker or its data is not schema-valid. Used to recover a verdict on resume when
 * the in-memory capture was lost to a crash.
 */
export function verdictFromCustomEntry(entry: unknown): Verdict | null {
  const e = entry as { type?: string; customType?: string; data?: unknown } | null;
  if (!e || e.type !== 'custom' || e.customType !== VERDICT_ENTRY_TYPE) return null;
  const r = validateVerdict(e.data);
  return r.ok ? r.value : null;
}

/**
 * Map an envelope session_id (the idempotency key, e.g. "<run>/<item>") to a valid Pi session
 * id: Pi requires it to contain only [A-Za-z0-9._-] and to start/end alphanumeric. Slashes (used
 * by the spec's "<run_id>/<item_id>" convention) and other separators become "-". Deterministic,
 * so a retry/resume of the same envelope id maps to the same session.
 */
export function toSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
  // Trim leading/trailing non-alphanumerics with a linear scan instead of a `^…+|…+$` trim regex,
  // which CodeQL flags as polynomial (js/polynomial-redos) on inputs with many separators.
  const isAlnum = (c: number) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  let start = 0;
  let end = cleaned.length;
  while (start < end && !isAlnum(cleaned.charCodeAt(start))) start++;
  while (end > start && !isAlnum(cleaned.charCodeAt(end - 1))) end--;
  return cleaned.slice(start, end) || 'leaf';
}

export interface LeafItem {
  item_id: string;
  file: string;
  pattern: string;
  require_approval?: boolean;
}

export interface LeafEnvelope {
  sessionId: string;
  /** Pool selected by the workload-facing control plane; falls back to the process default. */
  sandboxPoolSelector?: string;
  item: LeafItem; // inputs inline (was inputsRef)
  decision?: Decision; // resume/approve only (was decisionRef)
  model?: string;
  provider?: string;
  workspaceRef?: string; // derived from the worktree in P2 when repoUrl+ref are given
  repoUrl?: string; // P2: git remote to converge the sandbox repo copy from
  ref?: string; // P2: commit/branch/tag the leaf's worktree is pinned to
  maxTurns?: number;
  async?: boolean; // when true, the HTTP layer enqueues instead of running inline
  tenant?: string; // namespaces the session id
  /**
   * Digest of a promoted Claude Code config bundle (`sha256:…`). Absent ⇒ no promoted config and
   * behavior is exactly as before. Flows through the server and the work queue untouched, because
   * both pass the envelope through whole.
   */
  configRef?: string;
  kind?: 'converge' | 'solve' | 'prompt'; // absent/"converge" => existing behavior; "solve" => runSolveLeaf
  problemStatement?: string; // required when kind === "solve": the task the agent must implement
  prompt?: string; // required when kind === "prompt": the free-form prompt to run
  env_key?: string; // swebench solve: triggers the contained swebench-setup path (Plan C)
}

/** Apply a request-scoped pool selector without mutating the process-wide environment. */
function sandboxEnvironment(env: LeafEnvelope): NodeJS.ProcessEnv {
  if (!env.sandboxPoolSelector) return process.env;
  return { ...process.env, KAGENTI_SANDBOX_POOL_SELECTOR: env.sandboxPoolSelector };
}

/**
 * Lazily-created Redis client for the bundle store. Kept separate from the session backend's client
 * so a bundle fetch cannot interfere with session buffering.
 *
 * Caches the in-flight PROMISE, not the resolved client, mirroring RedisLeaseStore
 * (sandbox-lease.ts:38-45). Caching only the resolved value is a check-then-act race: two leaves
 * arriving before the first connect() settles would both pass the `!client` test, each create and
 * connect a client, and the loser's connection would be silently leaked — never closed, never
 * referenced again. Awaiting one shared promise makes concurrent callers converge on one client.
 */
let bundleRedisPromise: Promise<BundleRedisLike> | undefined;
function getBundleRedis(redisUrl?: string): Promise<BundleRedisLike> {
  if (!bundleRedisPromise) {
    bundleRedisPromise = (async () => {
      const client = createClient({ url: redisUrl ?? process.env.REDIS_URL });
      await client.connect();
      return client as unknown as BundleRedisLike;
    })().catch((err) => {
      // Do not cache a failed connect: clear the slot so the next leaf retries rather than
      // inheriting a permanently rejected promise.
      bundleRedisPromise = undefined;
      throw err;
    });
  }
  return bundleRedisPromise;
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

/** True when a solve envelope carries a non-empty env_key, triggering the contained swebench path. */
export function isSwebenchEnvelope(env: { kind?: string; env_key?: string }): boolean {
  return env.kind === 'solve' && typeof env.env_key === 'string' && env.env_key.length > 0;
}

// Cumulative token usage for a solve leaf (summed across all agent turns), for run cost pricing.
export type LeafUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type LeafResult =
  | { status: 'done'; verdict: Verdict }
  | { status: 'paused'; gateId: number; gate: { summary: string; proposed_action: string } }
  | { status: 'aborted' }
  | { status: 'solved'; patch: string; usage?: LeafUsage }
  | { status: 'responded'; text: string; usage?: LeafUsage }
  | {
      status: 'failed';
      reason: 'no_verdict' | 'invalid_verdict' | 'bad_inputs' | 'error' | 'saturated';
      message?: string;
    };

/**
 * Strip trailing "/" from a workspace root with a linear scan.
 *
 * Deliberately not `/\/+$/`: CodeQL flags that as polynomial (js/polynomial-redos), and the input
 * is caller-controlled -- workspaceRef arrives on the LeafEnvelope, i.e. straight off the request
 * body with no normalisation in between. The regex retries from every position on a long run of
 * slashes, so `/w` + 100k slashes + a non-slash costs ~15s of CPU per call; this costs ~0.005ms.
 *
 * Shared by both prompt builders on purpose. 8efd213 rewrote the same regex in buildSolvePrompt
 * but missed the copy in buildLeafPrompt; one implementation means there is no second copy to miss.
 */
function stripTrailingSlashes(ref: string): string {
  let end = ref.length;
  while (end > 0 && ref.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return ref.slice(0, end);
}

export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  // The file/grep tools run in the sandbox pod; give the agent the absolute path so it does
  // not resolve a relative path against the harness process cwd (which the sandbox maps away).
  const filePath = workspaceRef ? `${stripTrailingSlashes(workspaceRef)}/${item.file}` : item.file;
  const lines = [
    `You are reviewing one candidate finding in a sandboxed workspace.`,
    `Item id: ${item.item_id}`,
    `File (read this exact absolute path with the read tool): ${filePath}`,
    `Pattern of interest: ${item.pattern}`,
    `Read the file, decide whether the pattern is present and relevant.`,
  ];
  if (item.require_approval) {
    // Gated turn: steer the agent to request_approval ONLY, and withhold the submit_verdict
    // instruction — otherwise the model takes the simpler path and submits a verdict directly,
    // skipping the gate. The verdict instruction is delivered later by the approve continuation.
    lines.push(
      `A human MUST approve before you finish. Your FIRST and ONLY action now is to call the`,
      `request_approval tool exactly once, with a short summary of what you found and a`,
      `proposed_action stating the verdict you intend to submit. Do NOT submit your verdict yet —`,
      `you will be asked to submit it after the human responds. Call request_approval, then stop.`,
    );
  } else {
    lines.push(
      `Report by calling the submit_verdict tool exactly once with item_id="${item.item_id}". Do not do anything else.`,
    );
  }
  return lines.join('\n');
}

export function buildSolvePrompt(problemStatement: string, workspaceRef: string): string {
  // The agent's tools run in the sandbox pod and its session cwd is a harness-local path, so the
  // worktree root must be given as an absolute in-pod path the model edits under (cf. buildLeafPrompt).
  const root = stripTrailingSlashes(workspaceRef);
  return [
    `You are fixing a software issue in a checked-out repository.`,
    `Repository root (an absolute path in your sandbox): ${root}`,
    `Use your bash, read, and edit tools with absolute paths under that root. You may run the`,
    `project's own tests to check your work.`,
    ``,
    `## Issue`,
    problemStatement,
    ``,
    `Implement a fix by editing files under ${root}. When you are confident the fix is complete,`,
    `stop — do not ask questions and do not call any reporting tool.`,
  ].join('\n');
}

export type LeafCapture = VerdictCapture & GateCapture;

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: LeafCapture,
) => Promise<void>;

export type SolveCapture = { patch?: string; usage?: LeafUsage };
export type ProduceSolve = (
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: SolveCapture,
) => Promise<void>;

export function validateItem(o: unknown): LeafItem | null {
  if (typeof o !== 'object' || o === null) return null;
  const x = o as Record<string, unknown>;
  if (
    typeof x.item_id === 'string' &&
    typeof x.file === 'string' &&
    typeof x.pattern === 'string'
  ) {
    return {
      item_id: x.item_id,
      file: x.file,
      pattern: x.pattern,
      require_approval: x.require_approval === true,
    };
  }
  return null;
}

export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: {
    produceVerdict?: ProduceVerdict;
    produceSolve?: ProduceSolve;
    executeTurn?: typeof executeTurn;
    resolvePromotedConfig?: typeof resolvePromotedConfig;
    overlayConfig?: typeof overlayConfig;
    bundleRedis?: BundleRedisLike;
  },
): Promise<LeafResult> {
  if (env.kind === 'solve') return runSolveLeaf(env, config, deps);
  if (env.kind === 'prompt') return runPromptLeaf(env, config, deps);
  const item = validateItem(env.item);
  if (!item) return { status: 'failed', reason: 'bad_inputs' };

  const capture: LeafCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    // Saturation is a distinct, transient signal: the sync /runs path bounded-waits and returns
    // 503 Retry-After on it (spec §4.3), and classifyOutcome keeps it retryable for the async
    // path (drains as leases free). Every other throw is a generic "error".
    if (err instanceof SandboxPoolSaturatedError) {
      return { status: 'failed', reason: 'saturated', message: err.message };
    }
    return {
      status: 'failed',
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Gate outcomes take precedence over verdict handling.
  if (capture.aborted) return { status: 'aborted' };
  if (capture.gate) {
    return {
      status: 'paused',
      gateId: capture.gate.gateId,
      gate: { summary: capture.gate.summary, proposed_action: capture.gate.proposed_action },
    };
  }

  if (!capture.verdict) return { status: 'failed', reason: 'no_verdict' };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: 'failed', reason: 'invalid_verdict', message: v.error };
  return { status: 'done', verdict: v.value };
}

export async function runSolveLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceSolve?: ProduceSolve },
): Promise<LeafResult> {
  if (!env.problemStatement || !env.repoUrl || !env.ref)
    return { status: 'failed', reason: 'bad_inputs' };
  const capture: SolveCapture = {};
  const produce = deps?.produceSolve ?? realProduceSolve;
  try {
    await produce(env, config, capture);
  } catch (err) {
    if (err instanceof SandboxPoolSaturatedError)
      return { status: 'failed', reason: 'saturated', message: err.message };
    return {
      status: 'failed',
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { status: 'solved', patch: capture.patch ?? '', usage: capture.usage };
}

async function runPromptLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: {
    executeTurn?: typeof executeTurn;
    resolvePromotedConfig?: typeof resolvePromotedConfig;
    overlayConfig?: typeof overlayConfig;
    bundleRedis?: BundleRedisLike;
  },
): Promise<LeafResult> {
  if (!env.prompt) return { status: 'failed', reason: 'bad_inputs' };
  const cwd = config?.cwd ?? process.cwd();
  const sid = leafSessionId(env);
  const selection = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const exec = deps?.executeTurn ?? executeTurn;

  // Lease a pool sandbox the way the verdict and solve paths do, then hand it to the turn, so a
  // prompt leaf's tool calls land in the sandbox it actually holds a lease on — including a remote
  // one reached over the relay. ADR 0028 deferred this ("prompt leaves inherit /turn's sandbox
  // routing"), which left SH_REMOTE_SANDBOX unreachable from a prompt leaf and, on a deployment
  // that sets only a pool selector, ran its tools in the harness container itself.
  //
  // Substituting selectPoolSandbox for executeTurn's own resolveSandboxConfig is a superset, not a
  // behavior swap: with no KAGENTI_SANDBOX_POOL_SELECTOR set it falls back to exactly that same
  // single-pod resolution and returns null when nothing is configured.
  let selected: SelectedSandbox | null;
  // Read once and reuse, as the solve and verdict paths do: the heartbeat interval below is armed
  // outside this try, and two separate reads of the environment can disagree if it is mutated
  // between them.
  const promptTimings = leaseTimings(process.env);
  try {
    selected = await selectPoolSandbox(sandboxEnvironment(env), cwd, sid, {
      cap: promptTimings.cap,
      ttlMs: promptTimings.ttlMs,
      remoteSandbox: process.env.SH_REMOTE_SANDBOX === '1',
    });
  } catch (err) {
    // Saturation stays a distinct transient signal, as for the other kinds: the sync /runs path
    // bounded-waits then 503s on it, and classifyOutcome keeps it retryable for the async queue.
    if (err instanceof SandboxPoolSaturatedError) {
      return { status: 'failed', reason: 'saturated', message: err.message };
    }
    return {
      status: 'failed',
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // The digest whose overlay was ATTEMPTED in the sandbox, so the finally block below knows there is
  // a per-leaf /workspace/leaves/<sid>/.sh-config link to tear down AND a ref on that digest's
  // shared cache to release. runPromptLeaf never converges a workspace (it has no repoUrl/ref and
  // never calls convergeWorkspace/cleanupWorkspace), so without this nothing else ever removes
  // either -- they leak on every promoted prompt leaf on a long-lived pooled pod.
  //
  // Attempted, not succeeded (#216): overlayConfig's first exec claims the ref before it can push
  // any bytes, so an overlay that throws partway has already left one behind. Keying teardown on
  // success would pin that digest's cache forever and restore the very bug the refcount fixes. The
  // release script is idempotent, so running it after a failure is free. Declared here (not inside
  // the try below) so the finally block -- a sibling block, not nested inside try -- can see it.
  let overlayDigest: string | undefined;
  try {
    if (selected) {
      const lease = selected;
      heartbeat = setInterval(() => {
        // Best-effort: a failed renewal must not reject into an unhandled rejection and kill the
        // leaf. The lease's TTL expiring is the safe outcome -- the sandbox returns to the pool.
        void lease.heartbeat().catch(() => {});
      }, promptTimings.heartbeatMs);
    }
    // Promoted config: resolve the prose half into this pod's /tmp and mirror the bundle into the
    // sandbox we hold a lease on. Both halves come from one digest, and a failure of either fails
    // the leaf — running a turn with silently-absent configuration produces plausible-but-wrong
    // work, which is exactly the remote failure this design exists to prevent (spec §4.4). Resolving
    // this AFTER the heartbeat starts (not before) matters operationally: resolve+overlay fetches a
    // multi-MB bundle from Redis and pushes it into the pod over up to three kubectl execs, and with
    // no heartbeat running during that window a slow cluster could have the lease reclaimed mid-overlay.
    let promotedConfig: PromotedConfig | undefined;
    // Presence, not truthiness (issue #222). `if (env.configRef)` made `""` indistinguishable from
    // "no config requested", so a dispatch built from an unset shell variable ran BARE and returned
    // status: responded — plausible-but-wrong work, which is precisely the failure the paragraph
    // above says this design exists to prevent. A field that is present is a REQUEST for promoted
    // config; if it names no bundle, that request cannot be honoured, so fail it out loud.
    //
    // `null` is the deliberate exception: it is present, yet treated as absent. JSON null reads as
    // "no value" for producers that emit it, `""` is the failure actually observed, and the API
    // boundary agrees (`configRefValid` in knative-server's server.ts). Pinned by a test in both
    // layers so the exception stays a choice.
    if (env.configRef !== undefined && env.configRef !== null) {
      if (String(env.configRef).trim() === '') {
        return {
          status: 'failed',
          reason: 'error',
          message:
            'configRef is present but empty: it must name a bundle digest (sha256:…). ' +
            'Omit the field entirely to run without promoted configuration.',
        };
      }
      const resolveFn = deps?.resolvePromotedConfig ?? resolvePromotedConfig;
      const overlayFn = deps?.overlayConfig ?? overlayConfig;
      try {
        promotedConfig = await resolveFn(
          deps?.bundleRedis ?? (await getBundleRedis(config?.redisUrl)),
          env.configRef,
        );
        if (selected) {
          // SelectedSandbox.transport is present ONLY for a leased grpc presence record and is
          // undefined for pods (select-sandbox.ts:33-34), which is the DEFAULT deployment. Guarding
          // on `selected.transport` would therefore skip the overlay entirely on pods: the sandbox
          // half of the bundle would never arrive, so skill sibling files and memory would be
          // unreadable — and a unit test injecting a fake transport could not detect it. Use the
          // same fallback the converge path uses (run-leaf.ts:579-584): build a KubectlTransport
          // when none is leased, and close only what we created.
          const overlayTransport = selected.transport ?? KubectlTransport(selected.config);
          // Set BEFORE the call, not after: see the declaration above. The first thing the overlay
          // does in the sandbox is claim a ref on this digest.
          overlayDigest = env.configRef;
          try {
            const paths = await overlayFn(
              overlayTransport,
              env.configRef,
              sid,
              gzipSync(canonicalTar(promotedConfig.entries)),
            );
            promotedConfig = {
              ...promotedConfig,
              // The overlay landed, so the skills are now readable from the sandbox — tell the
              // resolver, which rewrites the path pi ADVERTISES for each skill to this one
              // (issue #222). Set here and nowhere else: it is only true once the link exists.
              sandboxSkillsDir: paths.skillsDir,
              promptFragments: [
                ...promotedConfig.promptFragments,
                // Self-describing and multi-line on purpose: this is the ONLY place the absolute
                // sandbox paths exist (the bundle is content-addressed and built before any leaf
                // or sandbox does, so notes.ts's skillsRootNote() cannot bake them in — it instead
                // points back at these two lines). A single-line string here would also risk
                // pi-fork's resolvePromptInput treating it as a file path when existsSync(input)
                // is true.
                [
                  'The following are absolute sandbox paths for this session:',
                  '',
                  `Skill files: ${paths.skillsDir}`,
                  `Memory files: ${paths.memoryDir}`,
                ].join('\n'),
              ],
            };
          } finally {
            if (!selected.transport) await overlayTransport.close();
          }
        }
      } catch (err) {
        return {
          status: 'failed',
          reason: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const r: TurnResult = await exec({
      prompt: env.prompt,
      sessionId: env.sessionId,
      config,
      createIfAbsent: true,
      selection,
      sandbox: { config: selected?.config ?? null, transport: selected?.transport },
      ...(promotedConfig ? { promotedConfig } : {}),
    });
    if (r.stopReason === 'aborted') return { status: 'aborted' };
    if (r.stopReason === 'error')
      return { status: 'failed', reason: 'error', message: r.errorMessage };
    return { status: 'responded', text: r.response, usage: r.usage };
  } catch (err) {
    // A throw from the turn must not escape past the finally: a lease held past a crashed turn
    // shrinks pool capacity until its TTL expires.
    return {
      status: 'failed',
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (overlayDigest && selected) {
      // Best-effort, matching cleanupWorkspace (converge.ts): swallow errors so a teardown hiccup
      // never masks the leaf's actual verdict. Follows the same transport fallback used above and
      // at run-leaf.ts:579-584 -- reuse a leased grpc transport if present, otherwise build a
      // KubectlTransport, and close only the transport we created ourselves.
      const cleanupTransport = selected.transport ?? KubectlTransport(selected.config);
      try {
        await cleanupTransport.exec(buildConfigCleanupScript(sid, overlayDigest), { timeout: 60 });
      } catch {
        /* ignore */
      } finally {
        if (!selected.transport) await cleanupTransport.close();
      }
    }
    if (selected) await selected.release();
    if (selected?.transport) await selected.transport.close();
  }
}

// Real solve runner: lease a sandbox, converge the per-leaf worktree, run the agent with ONLY the
// sandbox tools (no verdict/gate extensions), then capture the staged diff. Mirrors realProduceVerdict's
// session/pool wiring. Exercised by the Kind smoke, not unit tests.
export const realProduceSolve: ProduceSolve = async (env, config, capture) => {
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  const sid = leafSessionId(env);

  // A solve leaf MUST have a real sandbox worktree — fail fast (before any Redis/session work) if the
  // pool is unconfigured. selectPoolSandbox returns null when no sandbox is configured (see select-sandbox.ts).
  const solveTimings = leaseTimings(process.env);
  const selected = await selectPoolSandbox(sandboxEnvironment(env), cwd, sid, {
    cap: solveTimings.cap,
    ttlMs: solveTimings.ttlMs,
  });
  if (!selected) throw new Error('solve leaf requires a configured sandbox pool');

  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? 'redis://localhost:6379');
  const backend = new BufferedRedisBackend(store);
  const prior = await store.read(sid);
  const sessionManager =
    prior.length > 0
      ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
      : SessionManager.create(cwd, undefined, { id: sid }, backend);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const transport = KubectlTransport(selected.config);
    const swebench = isSwebenchEnvelope(env);
    let workspaceRef: string;
    if (swebench) {
      const t0 = Date.now();
      workspaceRef = await setupSwebenchWorkspace(transport, {
        repoUrl: env.repoUrl!,
        baseCommit: env.ref!,
        envKey: env.env_key!,
        sessionId: sid,
      });
      // Separate setup-duty from solve-duty (spec §4): the driver reads this line for setup ms,
      // and solve-duty = total exec-timing delta − setupMs.
      const safeSid = sid.replace(/[\r\n]+/g, '');
      console.error(`[swebench-phase] sid=${safeSid} setupMs=${Date.now() - t0}`);
    } else {
      workspaceRef = await convergeWorkspace(transport, env.repoUrl!, env.ref!, sid);
    }
    // A solve leaf edits files in its worktree; point the agent's sandbox cwd at that worktree so the
    // model's edits (relative or absolute) land where captureWorkspaceDiff reads them.
    const agentConfig = { ...selected.config, podCwd: workspaceRef };
    heartbeat = setInterval(() => {
      // Best-effort, as in runPromptLeaf: an unhandled rejection here would end the leaf, whereas
      // letting the lease lapse just returns the sandbox to the pool.
      void selected.heartbeat().catch(() => {});
    }, solveTimings.heartbeatMs);

    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        k8sSandboxExtension({ config: agentConfig }),
        flushExtension(backend),
        checkpointExtension(store, sessionManager),
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      sessionManager,
      model: model as never,
      resourceLoader,
      settingsManager,
    });

    try {
      const prompt = swebench
        ? buildSwebenchSolvePrompt(
            env.problemStatement!,
            workspaceRef,
            `${swebenchVenvDir(sid)}/bin/python`,
          )
        : buildSolvePrompt(env.problemStatement!, workspaceRef);
      await session.prompt(prompt);
      // Per-leaf token usage (cumulative across all solve turns) for run cost pricing. Sum assistant
      // usage off the session branch — the same defensive pattern budget-voter.ts:branchSpend uses
      // (session.getSessionStats() accesses message.usage non-defensively and throws on this pi build).
      // Best-effort: never let a usage hiccup fail an otherwise-solved leaf.
      try {
        capture.usage = sumBranchUsage(sessionManager);
      } catch {
        /* usage is best-effort */
      }
      capture.patch = swebench
        ? await captureSwebenchDiff(transport, sid)
        : await captureWorkspaceDiff(transport, sid);
    } finally {
      await backend.flush();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (isSwebenchEnvelope(env)) await cleanupSwebench(KubectlTransport(selected.config), sid);
    else await cleanupWorkspace(KubectlTransport(selected.config), sid);
    await selected.release();
  }
};

// Real Pi session runner — mirrors harness/src/run-turn.ts session setup, made resumable
// (MVP spec §7 gate 7, §2.4 idempotency). The session is persisted to Redis under env.sessionId;
// re-invoking the same sessionId after a crash resumes from the durable log (M5) instead of
// starting fresh. Exercised by the Kind smoke, not the unit tests.
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  // Session cwd is a harness-local path (NOT workspaceRef): the agent's file/search tools run in
  // the sandbox pod, and workspaceRef is an absolute path inside that pod (see buildLeafPrompt).
  // Pointing the session cwd at workspaceRef would make the harness try to load a path it does not
  // have. The k8sSandboxExtension uses process.cwd() as its head cwd regardless.
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  // Honor the LLM gateway (base URL + Bearer auth) exactly as runTurn does, so leaf model calls
  // reach the same endpoint with the same credentials.
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  // Durable, resumable session keyed by the (sanitized) session id. BufferedRedisBackend drains
  // writes continuously, so a mid-run crash preserves progress up to the last drained entry.
  const sid = leafSessionId(env);
  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? 'redis://localhost:6379');
  const backend = new BufferedRedisBackend(store);
  const isVerdictEntry = (e: unknown) =>
    (e as { type?: string }).type === 'custom' &&
    (e as { customType?: string }).customType === VERDICT_ENTRY_TYPE;

  // Resume the session if one already exists under this id (retry / post-crash); otherwise create
  // a fresh session persisted under the sanitized id.
  const prior = await store.read(sid);
  const resuming = prior.length > 0;
  const sessionManager = resuming
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  // Verdict fast-path (unchanged, M5): if a verdict was already submitted and persisted before a
  // crash, recover it from the durable log and skip re-running the agent entirely.
  if (resuming) {
    const row = await store.latestWhere(sid, isVerdictEntry);
    const recovered = verdictFromCustomEntry(row?.entry);
    if (recovered) {
      capture.verdict = recovered;
      await backend.flush();
      return;
    }
  }

  // --- P2: choose a sandbox pod (pool lease) before building the prompt/session. Placed after the
  // verdict fast-path so a recovered verdict does not lease a pod. Returns null ⇒ no sandbox
  // configured (local tools). Throws SandboxPoolSaturatedError when a configured pool is full.
  const remoteSandbox = process.env.SH_REMOTE_SANDBOX === '1';
  const verdictTimings = leaseTimings(process.env);
  const selected = await selectPoolSandbox(sandboxEnvironment(env), cwd, sid, {
    cap: verdictTimings.cap,
    ttlMs: verdictTimings.ttlMs,
    remoteSandbox,
  });
  const converging = selected != null && !!env.repoUrl && !!env.ref;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    // Ref-pinned lazy converge (spec §5): fetch the ref into the shared object store and add this
    // leaf's worktree; workspaceRef becomes the derived worktree path. All FS work happens in the
    // pod via exec — the harness opens nothing.
    let workspaceRef = env.workspaceRef;
    if (converging) {
      // Reuse the leased grpc transport (Task 8) when present; otherwise build a fresh
      // KubectlTransport exactly as before. For pods, KubectlTransport.close() is a no-op and
      // each exec spawns fresh, so building + closing per phase stays observationally identical
      // to today. For grpc, this is the SAME transport instance used by the agent extension and
      // cleanup below — closed exactly once, in the outer finally.
      const convergeTransport = selected?.transport ?? KubectlTransport(selected!.config);
      try {
        workspaceRef = await convergeWorkspace(convergeTransport, env.repoUrl!, env.ref!, sid);
      } finally {
        if (!selected?.transport) await convergeTransport.close();
      }
    }
    if (selected) {
      heartbeat = setInterval(() => {
        // Best-effort, as in runPromptLeaf: an unhandled rejection here would end the leaf, whereas
        // letting the lease lapse just returns the sandbox to the pool.
        void selected.heartbeat().catch(() => {});
      }, verdictTimings.heartbeatMs);
    }

    // Gate front-end (design §3): decide whether to pause, abort, or seed a prompt.
    const gateState = computeGateState(prior.map((p) => p.entry));
    const dv = env.decision ? validateDecision(env.decision) : null;
    const decision = dv && dv.ok ? dv.value : null;
    const seed = decideSeed(gateState, decision, buildLeafPrompt(item, workspaceRef));

    if (seed.kind === 'abort') {
      if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);
      capture.aborted = true;
      await backend.flush();
      return;
    }
    if (seed.kind === 'paused') {
      capture.gate = seed.gate;
      await backend.flush();
      return;
    }
    if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);

    const allowVerdict =
      !item.require_approval || gateState.gateDecisions.length > 0 || seed.record != null;

    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        ...(allowVerdict ? [submitVerdictExtension(capture, sessionManager)] : []),
        requestApprovalExtension(capture, sessionManager, gateState.nextGateId),
        k8sSandboxExtension({ config: selected?.config ?? null, transport: selected?.transport }),
        flushExtension(backend),
        checkpointExtension(store, sessionManager),
        verdictTerminationExtension(capture, { maxTurns: env.maxTurns }),
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      sessionManager,
      model: model as never,
      resourceLoader,
      settingsManager,
    });

    try {
      await session.prompt(seed.prompt);
      if (!capture.verdict && !capture.gate) {
        const row = await store.latestWhere(sid, isVerdictEntry);
        const recovered = verdictFromCustomEntry(row?.entry);
        if (recovered) capture.verdict = recovered;
      }
    } finally {
      await backend.flush();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (converging) {
      const cleanupTransport = selected?.transport ?? KubectlTransport(selected!.config);
      try {
        await cleanupWorkspace(cleanupTransport, sid);
      } finally {
        if (!selected?.transport) await cleanupTransport.close();
      }
    }
    if (selected) await selected.release();
    // The shared grpc transport (Task 8) is leased once and used by converge + the agent
    // extension + cleanup above; close it exactly once here, never per-phase.
    if (selected?.transport) await selected.transport.close();
  }
};
