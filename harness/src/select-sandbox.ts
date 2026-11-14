import { credentials, InterceptingCall, type Interceptor } from '@grpc/grpc-js';
import {
  GrpcRelayTransport,
  SandboxExecClient,
  type SandboxTransport,
  type ExecClientLike,
} from '@moca/k8s-sandbox';
import { RedisLeaseStore, type LeaseStore } from './sandbox-lease.js';
import { stripTrailingSlashes } from './strip-trailing-slashes.js';
import { RedisRecordStore, type RecordStore, type SandboxRecord } from './pool-records.js';
import {
  affinityTimings,
  forLog,
  parseSandboxTiers,
  RedisAffinityStore,
  OWNER_LABEL,
  TIER_LABEL,
  TEMPLATE_LABEL,
  BUILD_LABEL,
  WORKLOAD_LABEL,
  type AffinityStore,
} from './sandbox-affinity.js';

/**
 * Process-wide Redis-backed stores, reused across selections instead of built per call.
 *
 * Both stores used to be constructed inside `selectPoolSandbox` on every call. That was harmless
 * while only prompt leaves reached this code — a leaf is a process, so "per call" was "once". The
 * moment `/turn` began selecting from the pool it became per TURN, and the two failed differently:
 *
 *  - `RedisRecordStore` was constructed AND closed, so it churned: measured on a real run, ~10k
 *    turns produced **35,654** connections.
 *  - `RedisLeaseStore` was constructed and **never closed** (its constructor connects eagerly), so
 *    it LEAKED one live connection per turn — monotonically, to the `maxclients 10000` ceiling.
 *
 * Redis then answered `ERR max number of clients reached`, node-redis raised that as an `'error'`
 * event on a client with no listener, and all four workers exited code 1 **simultaneously**,
 * mid-rung, stranding every in-flight turn (the driver's own curl has no timeout, so those turns
 * hung indefinitely rather than failing). It took ~13 minutes at 27-54 turns/s to accumulate, which
 * is why two complete E8 ladders passed before it appeared.
 *
 * Each memo holds the STORE, not a promise of one, and is dropped when a call through it rejects:
 * caching a broken client would turn one transient Redis blip into a permanent failure for the life
 * of the process — for the record store a permanent "no sandboxes", for the lease store a permanent
 * inability to acquire. Neither is closed on the happy path; they are process-lived by design and
 * the process exiting is what releases them.
 */
type Closable = { close(): Promise<void> };
let recordsMemo: { url: string | undefined; store: RecordStore & Closable } | null = null;
let leaseMemo: { url: string | undefined; store: LeaseStore & Closable } | null = null;
let affinityMemo: { url: string | undefined; store: AffinityStore & Closable } | null = null;

/**
 * Resolve the memoised store, building one if there is none or the URL changed.
 *
 * Split out of the wrappers below because they must call it PER COMMAND rather than once — see
 * `sharedLease`. Kept as two concrete functions rather than one generic helper so each `new` stays
 * lexically inside its memo assignment, which is what `redis-client-per-turn.test.ts` asserts.
 */
function recordsStore(url: string | undefined): RecordStore & Closable {
  if (!recordsMemo || recordsMemo.url !== url) {
    // A changed REDIS_URL means a different Redis; drop the old client rather than silently talking
    // to the wrong one. Closing is best-effort — it is being replaced either way.
    if (recordsMemo) void recordsMemo.store.close().catch(() => {});
    recordsMemo = { url, store: new RedisRecordStore(url) };
  }
  return recordsMemo.store;
}

function leaseStore(url: string | undefined): LeaseStore & Closable {
  if (!leaseMemo || leaseMemo.url !== url) {
    if (leaseMemo) void leaseMemo.store.close().catch(() => {});
    leaseMemo = { url, store: new RedisLeaseStore(url) };
  }
  return leaseMemo.store;
}

function affinityStore(url: string | undefined): AffinityStore & Closable {
  if (!affinityMemo || affinityMemo.url !== url) {
    if (affinityMemo) void affinityMemo.store.close().catch(() => {});
    affinityMemo = { url, store: new RedisAffinityStore(url) };
  }
  return affinityMemo.store;
}

function sharedRecords(url: string | undefined): RecordStore {
  const call = <T>(fn: (store: RecordStore) => Promise<T>): Promise<T> => {
    const store = recordsStore(url);
    return guard(fn(store), () =>
      dropMemo(
        store,
        () => recordsMemo,
        () => (recordsMemo = null),
      ),
    );
  };
  return {
    put: (rec) => call((s) => s.put(rec)),
    remove: (id) => call((s) => s.remove(id)),
    list: () => call((s) => s.list()),
  };
}

/**
 * The wrapper resolves the memo PER COMMAND, not once when the wrapper is built.
 *
 * That distinction is the whole point, because `selectPoolSandbox` hands its caller CLOSURES over
 * this wrapper (`heartbeat`/`release`, below) and every caller ticks them for the life of the turn or
 * leaf — `run-leaf.ts`'s three `setInterval`s, `run-turn.ts`'s renewal. Binding one store instance
 * here meant those closures could not see the memo's own recovery: `dropMemo` closes the failed store
 * and clears the memo, the next `selectPoolSandbox` gets a healthy one, but the captured closure still
 * points at the closed client — whose every command rejects `ClientClosedError` for the life of the
 * process, and whose further drops are no-ops because `dropMemo` identity-checks against a memo that
 * now holds a different store.
 *
 * A one-command blip therefore cost the lease for the entire turn: renewals stop, the TTL lapses, and
 * the pod goes back in the pool while the turn is still executing in it — over-subscribing the soft
 * cap `ACQUIRE_LUA` enforces. Each later tick was also a fresh rejection, which is what made an
 * unguarded `void lease.heartbeat()` a repeat process-killer rather than a one-off.
 *
 * Recovery deliberately comes from the memo and NOT from an `arm()`/`open()` re-arm inside
 * `RedisLeaseStore` (the shape `RedisSessionBackend`, `RedisWorkQueue` and `RedisResultStore` use).
 * Those four are memoised for the process's life and never closed on any path that keeps using them,
 * so reconnecting in place is right there. This store is different: `dropMemo` CLOSES it on purpose,
 * and node-redis will happily reopen a closed client (probed on the pinned redis 6.2.1 — `close()`
 * then `connect()` yields `isOpen: true` and PINGs). A re-arm would therefore resurrect a store that
 * no memo references and nothing will ever close again: one orphaned connection per outage, in the
 * code that exists to keep connections off the `maxclients` ceiling. Re-entering the memo has the
 * self-healing without the orphan, and it makes the exemption `redis-errors.ts` claims for these two
 * stores unconditional — it no longer depends on the caller re-entering `sharedLease()` by hand.
 */
function sharedLease(url: string | undefined): LeaseStore {
  const call = <T>(fn: (store: LeaseStore) => Promise<T>): Promise<T> => {
    const store = leaseStore(url);
    return guard(fn(store), () =>
      dropMemo(
        store,
        () => leaseMemo,
        () => (leaseMemo = null),
      ),
    );
  };
  return {
    load: (pod) => call((s) => s.load(pod)),
    acquire: (pod, cap, holderId, ttlMs) => call((s) => s.acquire(pod, cap, holderId, ttlMs)),
    heartbeat: (pod, holderId, ttlMs) => call((s) => s.heartbeat(pod, holderId, ttlMs)),
    release: (pod, holderId) => call((s) => s.release(pod, holderId)),
  };
}

/** The affinity store behind the same per-command memo and drop-guard as `sharedLease`. */
function sharedAffinity(url: string | undefined): AffinityStore {
  const call = <T>(fn: (store: AffinityStore) => Promise<T>): Promise<T> => {
    const store = affinityStore(url);
    return guard(fn(store), () =>
      dropMemo(
        store,
        () => affinityMemo,
        () => (affinityMemo = null),
      ),
    );
  };
  return {
    get: (s) => call((st) => st.get(s)),
    claim: (s, e, ttl) => call((st) => st.claim(s, e, ttl)),
    replace: (s, e, ttl) => call((st) => st.replace(s, e, ttl)),
    detachedSince: (id, now, ttl) => call((st) => st.detachedSince(id, now, ttl)),
  };
}

/**
 * Evict `store` from its memo, but ONLY if it is still the memoised one.
 *
 * `guard` can call this long after the call was issued, and unconditionally nulling the memo has two
 * failure modes that a two-line check removes:
 *
 *  - **It could drop a healthy store.** A command on store₁ hangs; `REDIS_URL` changes (or
 *    `resetSharedStores` runs) and the memo is rebuilt with a healthy store₂; store₁'s command
 *    finally rejects and the drop discards **store₂**, which never failed. The next call builds
 *    store₃ and store₂ is orphaned — connected, unreferenced, never closed. The window is small, but
 *    it is exactly the situation the guard exists for (Redis misbehaving, commands in flight), and
 *    under a flapping Redis it chains.
 *  - **It leaked the store it dropped.** The memo was the last reference, so nulling it alone
 *    abandons a live connection — one per distinct failure, permanently, in the code whose purpose is
 *    keeping connections from accumulating to `maxclients`. The URL-change path four lines up already
 *    closes for this reason; the failure path deserves it more, being the one that can fire
 *    repeatedly.
 *
 * Closing is safe even though the store is SHARED with concurrent callers: redis 6's `close()` is
 * documented as "Close the client. Wait for pending commands" (`destroy()` is the one that rejects
 * them), so in-flight commands drain rather than failing. And no NEW caller can reach this store —
 * the memo is cleared first, so the next `shared*()` builds a fresh one.
 *
 * Clearing before closing is deliberate, and reuses the shape settled on in #249 (`turn-auth.ts:318`):
 * a throwing close must not be able to skip the rebuild.
 */
function dropMemo<S extends Closable>(
  store: S,
  read: () => { store: S } | null,
  clear: () => void,
): void {
  if (read()?.store !== store) return;
  clear();
  void store.close().catch(() => {});
}

/** Run `p`, and drop the shared store's memo if it rejects so the next call rebuilds it. */
async function guard<T>(p: Promise<T>, drop: () => void): Promise<T> {
  try {
    return await p;
  } catch (err) {
    drop();
    throw err;
  }
}

/**
 * Test-only: drop the cached stores so a test can inject its own or force a reconnect.
 *
 * Named for ALL the memos, not just records — it always reset the lease store too, and the old
 * `resetSharedRecords` left the next reader to assume leases survived it. The affinity memo (P6.3)
 * is the third, and is reset here for the same reason.
 */
export function resetSharedStores(): void {
  if (recordsMemo) void recordsMemo.store.close().catch(() => {});
  if (leaseMemo) void leaseMemo.store.close().catch(() => {});
  if (affinityMemo) void affinityMemo.store.close().catch(() => {});
  recordsMemo = null;
  leaseMemo = null;
  affinityMemo = null;
}

/** Pure: pods ordered ascending by active load (stable — ties keep input order). */
export function orderByLoad(loads: { pod: string; active: number }[]): string[] {
  return loads
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.active - b.active || a.i - b.i)
    .map((l) => l.pod);
}

/**
 * Which sandbox inventory `selectPoolSandbox` consults. Records only since the pod listing
 * was removed with the Knative/KEDA deployment path (ADR-0041); the type survives so
 * `SH_SANDBOX_DISCOVERY`'s validation and the pool-empty wording can name it.
 */
export type DiscoverySource = 'records';

/**
 * Resolve `SH_SANDBOX_DISCOVERY`. Unset or `records` ⇒ records. `pods`/`both` throw: they
 * named the kubectl pod listing removed with the Knative/KEDA deployment path (ADR-0041),
 * and a deployment still carrying one must fail loudly, not quietly change behavior.
 * `records` additionally requires `SH_REMOTE_SANDBOX=1`, because records are only read
 * when the remote flag is on.
 */
export function resolveDiscoverySource(
  env: NodeJS.ProcessEnv,
  remoteSandbox: boolean,
): DiscoverySource {
  const raw = env.SH_SANDBOX_DISCOVERY?.trim();
  if (!raw || raw === 'records') {
    if (raw === 'records' && !remoteSandbox) {
      // Blame the flag, not the pool: without this the caller sees "no sandbox presence
      // records", which sends them debugging a healthy relay.
      throw new Error(
        'SH_SANDBOX_DISCOVERY=records requires SH_REMOTE_SANDBOX=1 (records are only read when the remote flag is on)',
      );
    }
    return 'records';
  }
  // Loud, not silent: a deployment still carrying a pods/both setting would otherwise
  // quietly change behavior (records-only) the moment the pod inventory is gone.
  throw new Error(
    `SH_SANDBOX_DISCOVERY='${raw}' was removed with the Knative/KEDA deployment path (ADR-0041); ` +
      "records is the only discovery source — unset the variable (or set it to 'records')",
  );
}

/** Thrown when a pool is configured but every pod is at the soft cap. */
export class SandboxPoolSaturatedError extends Error {
  constructor(selector: string, detail?: string) {
    super(
      detail
        ? `sandbox pool '${selector}' saturated: ${detail}`
        : `sandbox pool '${selector}' saturated: all pods at capacity`,
    );
    this.name = 'SandboxPoolSaturatedError';
  }
}

/**
 * Thrown when the sandbox that served this session's previous turn is not attached, and has been
 * gone for less than SH_SANDBOX_AFFINITY_GRACE_SECONDS (P6.3 spec §4 step 4). Usually a relay
 * restart: every worker reattaches under the same id within seconds, and moving the session meanwhile
 * would lose a workspace that is about to come back.
 *
 * A SUBCLASS of SandboxPoolSaturatedError on purpose: the three leaf paths classify by `instanceof
 * SandboxPoolSaturatedError` (run-leaf.ts) and must treat this as the same retryable no-capacity
 * outcome. `name` is its own, for knative-server's NO_CAPACITY set (server.ts), which matches names.
 */
export class SandboxAffinityPendingError extends SandboxPoolSaturatedError {
  constructor(
    readonly sandboxId: string,
    readonly retryInMs: number,
  ) {
    super('');
    this.message =
      `this session's sandbox '${sandboxId}' is not attached; waiting up to ` +
      `${Math.ceil(retryInMs / 1000)}s for it to return before moving the session within its tier`;
    this.name = 'SandboxAffinityPendingError';
  }
}

/**
 * Thrown when a pool is configured but has no candidate sandbox YET — presence records not
 * (re-)mirrored after a relay or worker restart.
 *
 * A named class purely so callers can tell this apart from a generic failure. It used to be a plain
 * `Error`, which since /turn started leasing from the pool meant an empty pool surfaced as a 500 —
 * "this can never succeed" — while a FULL pool got the 503 it deserves. Same underlying fact from the
 * caller's side (no capacity available right now, retry), so the two now map identically
 * (`turnErrorStatus`). `classifyOutcome` keeps both retryable.
 *
 * The records wording blames neither the pool selector nor the operator: "no sandbox has attached
 * to the relay yet" is the likeliest first-run state on a fresh VM deployment
 * (`env/supervisor.env.example`), so it is the message operators actually hit.
 *
 * With a tier given, that wording is not used: records of OTHER tiers may well be attached, so
 * "no sandbox has attached" would be false too. The message names the tier and the fix instead,
 * because an empty TIER on a healthy relay is the commonest misconfiguration (P6.3 spec §5).
 */
export class SandboxPoolEmptyError extends Error {
  constructor(selector: string, tier?: string, template?: string) {
    super(
      template
        ? `no attached sandbox for sandbox template '${template}'${tier ? ` in tier '${tier}'` : ''} (check that a worker of this template sets SANDBOX_TEMPLATE=${template})`
        : tier
          ? `no attached sandbox in sandbox tier '${tier}' (SH_SANDBOX_TIERS is set; check that the workers of this tier set SANDBOX_TIER=${tier})`
          : `no sandbox presence records (no sandbox has attached to the relay yet)`,
    );
    this.name = 'SandboxPoolEmptyError';
  }
}

/**
 * Thrown when a run names a workload and none of that workload's sandboxes can serve it (workload
 * sandboxes spec §3.3). Never answered by falling back to the shared pool: that would run one
 * user's workload on a sandbox shared with everyone. A session whose workload sandbox served an
 * earlier turn first waits out the P6.3 grace (SandboxAffinityPendingError), as any affine session
 * does; this is what follows when there is nothing left to wait for.
 *
 * A subclass of SandboxPoolEmptyError, so every path that treats an empty pool as "no capacity
 * right now" treats this the same way. `code` is the stable error the HTTP layer will answer with.
 */
export class WorkloadSandboxUnavailableError extends SandboxPoolEmptyError {
  readonly code = 'workload_sandbox_unavailable';
  constructor(
    readonly workload: string,
    detail = 'no sandbox of this workload is attached',
  ) {
    super('');
    this.message = `workload '${forLog(workload)}': ${detail}`;
    this.name = 'WorkloadSandboxUnavailableError';
  }
}

/**
 * Thrown when a run names a workload but this deployment could never serve it: the run carries no
 * owner scope, or the worker has no relay sandbox pool. A misconfiguration, not "none attached right
 * now", so deliberately NOT a SandboxPoolEmptyError: like SandboxRequiredError, a retry cannot
 * succeed, and run-leaf maps it to a terminal `error`.
 */
export class WorkloadSandboxMisconfiguredError extends Error {
  constructor(
    readonly workload: string,
    detail: string,
  ) {
    super(`workload '${forLog(workload)}': ${detail}`);
    this.name = 'WorkloadSandboxMisconfiguredError';
  }
}

/**
 * The only sandbox tier workload sandboxes are provisioned in. /workloads and the provisioner
 * hardcode the same restriction; there is no shared constant today.
 */
const WORKLOAD_SANDBOX_TIER = 'container';

/**
 * Thrown when a server-mode turn has no sandbox to run tools in (MI1 §5 R3). Without it, a `null`
 * sandbox config leaves Pi's built-in tools running locally in the worker process. Deliberately NOT
 * in turnErrorStatus's NO_CAPACITY set: this is a deployment that has no sandbox configured at all,
 * so a retry cannot succeed, and it surfaces as a 500 naming the fix.
 */
export class SandboxRequiredError extends Error {
  constructor() {
    super(
      'no sandbox resolved for this turn; a server refuses to run tools in its own process ' +
        '(configure a sandbox pool, or set SH_LOCAL_TOOLS=1 for single-tenant development)',
    );
    this.name = 'SandboxRequiredError';
  }
}

/**
 * Shared MI1 §5 R3 gate: throws {@link SandboxRequiredError} when a server-mode caller has no
 * resolvable sandbox config and has not explicitly opted into local tools. Every path that can
 * wire up `k8sSandboxExtension` (executeTurn, and the converge, solve and prompt leaves) must call this — with the
 * config it received and the sandbox config it resolved — before it builds a resource loader or
 * session, so a null sandbox never reaches the extension.
 */
export function assertServerSandbox(
  config: { serverMode?: boolean; allowLocalTools?: boolean } | undefined,
  sandboxConfig: unknown,
): void {
  if (config?.serverMode && !config.allowLocalTools && !sandboxConfig) {
    throw new SandboxRequiredError();
  }
}

/**
 * The Hello capability a container worker advertises when it honours `workspace_key` with a
 * per-key directory, `<its root>/<key>` (remote-worker/internal/exec/workspace.go, #408).
 */
export const WORKSPACE_SUBDIR_CAPABILITY = 'workspace-subdir';

/**
 * The sandbox cwd for one session on one leased sandbox.
 *
 * A worker advertising {@link WORKSPACE_SUBDIR_CAPABILITY} runs each Exec in `<root>/<session id>`
 * (the session id is the Exec's `workspace_key`, see `take` below), so the session's cwd moves there
 * too. It has to move HERE, not only on the worker: every path the sandbox tools send is absolute
 * under podCwd (`cd '/workspace' && …`), so a worker-side directory alone would leave every session
 * on the shared tree. KAGENTI_SANDBOX_CWD must therefore equal the worker's SH_WORKSPACE_ROOT.
 *
 * Anything else keeps podCwd unchanged: pods, workers that predate the capability, and the microVM
 * tier, whose guest already mounts the session's own workspace AT `/workspace`.
 *
 * Not a security boundary — the same container and Unix user, so `cd ..` reaches the others. It
 * removes concurrent-clone collisions and one session seeing another's files.
 */
export function sessionPodCwd(
  podCwd: string,
  rec: SandboxRecord | undefined,
  sessionId: string,
): string {
  if (!rec?.capabilities.includes(WORKSPACE_SUBDIR_CAPABILITY)) return podCwd;
  return `${stripTrailingSlashes(podCwd)}/${sessionId}`;
}

export interface WorkspaceReset {
  from: string;
  reason: 'detached' | 'retiered';
}

export interface SelectedSandbox {
  /** The leased sandbox's exec channel — always the relay transport (ADR-0041 removed pod-exec). */
  transport: SandboxTransport;
  /** The sandbox-side cwd for this session; head paths under the harness cwd map here. */
  podCwd: string;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
  /** The leased sandbox's id (its presence-record id). */
  sandboxId: string;
  /** The effective tier this selection ran in; '' when the deployment declares none. */
  tier?: string;
  /** Present when this selection moved the session off its previous sandbox (P6.3 spec §4, §6). */
  workspaceReset?: WorkspaceReset;
}

export interface SelectDeps {
  lease?: LeaseStore;
  /** Mirrored grpc presence records; defaults to a RedisRecordStore. Only consulted when opts.remoteSandbox is true. */
  records?: RecordStore;
  /** Builds the exec client for a leased grpc record; defaults to a real SandboxExecClient at SH_RELAY_ADDR. */
  makeExecClient?: (sandboxId: string) => ExecClientLike;
  /**
   * Builds the transport for a leased grpc record; defaults to GrpcRelayTransport.
   * Injectable so a test can assert what the leased transport was built with — there
   * is no other way to observe it without a real gRPC client.
   */
  makeTransport?: (
    sandboxId: string,
    client: ExecClientLike,
    opts?: { workspaceKey?: string; workload?: string },
  ) => SandboxTransport;
  /** Session-to-sandbox affinity (P6.3); defaults to a RedisAffinityStore. Only consulted when remoteOn. */
  affinity?: AffinityStore;
  /** Clock for the grace period; injectable so tests do not wait in real time. */
  now?: () => number;
}

/** Adds the worker's relay credential to every SandboxExec call (MI1 §5 R5). */
function execTokenInterceptor(token: string): Interceptor {
  return (options, nextCall) =>
    new InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        metadata.set('authorization', `Bearer ${token}`);
        next(metadata, listener);
      },
    });
}

export function makeRelayExecClient(addr: string, token: string): ExecClientLike {
  return new SandboxExecClient(addr, credentials.createInsecure(), {
    interceptors: [execTokenInterceptor(token)],
  }) as unknown as ExecClientLike;
}

/** Lazily builds a real gRPC exec client — only reached on the grpc branch when the flag is on. */
function defaultExecClient(_sandboxId: string, env: NodeJS.ProcessEnv): ExecClientLike {
  const addr = env.SH_RELAY_ADDR ?? 'sandbox-relay.default.svc.cluster.local:8443';
  const token = env.MOCA_RELAY_EXEC_TOKEN;
  if (!token) {
    // Named here rather than surfacing as the relay's UNAUTHENTICATED on the first exec.
    throw new Error(
      'MOCA_RELAY_EXEC_TOKEN is not set: the relay refuses unauthenticated SandboxExec',
    );
  }
  return makeRelayExecClient(addr, token);
}

/**
 * Sandbox ids already reported as unlabelled or mislabelled, so a misconfigured worker logs once, not
 * per turn.
 */
const warnedUnlabelled = new Set<string>();

/** Test-only: forget which unlabelled or mislabelled sandboxes were reported. */
export function resetTierWarnings(): void {
  warnedUnlabelled.clear();
}

/**
 * Whether a presence record is in `tier`. With tiers declared an UNLABELLED record is in none: it
 * would otherwise serve whichever tier asked first, which is exactly the cross-tier hop this slice
 * removes (P6.3 spec §4 step 1). A record labelled with a tier that is not one of `declared` (a typo
 * in SANDBOX_TIER, say `microvn`) is in none either, and is reported the same way: dropping it with
 * no log would leave the operator a worker that is attached, healthy and never used (spec §5,
 * "An unlabelled or mislabelled worker"). Reported once per id, naming its labels, so the operator
 * can see which worker to fix.
 */
function recordInTier(r: SandboxRecord, tier: string, declared: readonly string[]): boolean {
  const t = r.labels?.[TIER_LABEL];
  if (t && declared.includes(t)) return t === tier;
  if (!warnedUnlabelled.has(r.sandboxId)) {
    warnedUnlabelled.add(r.sandboxId);
    const labels = JSON.stringify(r.labels ?? {});
    console.warn(
      t
        ? `sandbox '${forLog(r.sandboxId)}' advertises ${TIER_LABEL}='${forLog(t)}', which is not one of SH_SANDBOX_TIERS ` +
            `(${declared.join(', ')}) (labels ${forLog(labels)}); excluded — fix SANDBOX_TIER on its worker`
        : `sandbox '${forLog(r.sandboxId)}' advertises no ${TIER_LABEL} label (labels ${forLog(labels)}); ` +
            'excluded while SH_SANDBOX_TIERS is set — set SANDBOX_TIER on its worker',
    );
  }
  return false;
}

/**
 * An affinity WRITE after the lease is taken: best effort (P6.3 spec §5). The sandbox is right and
 * the lease is held, so failing the turn here would turn a Redis blip into a lost turn for nothing;
 * the next turn simply finds the old entry or none. Returns undefined on failure.
 */
async function remember<T>(
  write: () => Promise<T>,
  sessionId: string,
  sandboxId: string,
): Promise<T | undefined> {
  try {
    return await write();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `sandbox affinity: could not record '${forLog(sandboxId)}' for session ${forLog(sessionId)}: ${forLog(message)}`,
    );
    return undefined;
  }
}

/**
 * Choose a sandbox for a leaf or turn.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ returns null (run local tools). A stale
 *    `KAGENTI_SANDBOX_POD` (the removed single-pod path, ADR-0041) throws instead.
 *  - Pool configured ⇒ read the relay presence records (when `opts.remoteSandbox` is
 *    true), pick least-loaded under the soft cap, acquire a lease. Throws
 *    SandboxPoolSaturatedError if every candidate is full.
 *
 * TWO identities arrive here and they are not interchangeable. `sessionId` keys the microVM WORKSPACE
 * and must be stable across the turns of a session; `opts.holderId` is the lease's ZSET member and
 * must be unique per concurrent holder. They are equal for a leaf (one session executing once) and
 * differ for `/turn` (many concurrent turns of one session), which is why the holder is a separate,
 * optional argument that defaults to the session id rather than something derived here.
 *
 * **Tiers and affinity (P6.3).** The candidates are the session's tier, and the sandbox that
 * served its previous turn is preferred: saturated → `SandboxPoolSaturatedError`, absent
 * within the grace → `SandboxAffinityPendingError`, absent past it (or retiered) →
 * least-loaded in the tier, with `workspaceReset` set. See spec §4.
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  sessionId: string,
  opts: {
    cap: number;
    ttlMs: number;
    remoteSandbox?: boolean;
    holderId?: string;
    /**
     * The session's sandbox tier (P6.3). `''` or absent means the deployment default; ignored when
     * no tiers are declared.
     */
    tier?: string;
    /**
     * The session's sandbox template (session-templates spec §4). Set: only records labelled
     * `moca.dev/template=<it>` are candidates, and pods are not. Absent or '': only records WITHOUT
     * the label, so an untemplated session never lands on a templated worker.
     */
    template?: string;
    /**
     * The build the session's template resolved to (combined control plane spec §3.4). Set: only
     * records labelled `moca.dev/build=<it>` are candidates, so a session pinned to a build never
     * runs on another. Absent: any build of the template, as before.
     */
    build?: string;
    /**
     * The workload key (`w-<32 hex>`) the run names (workload sandboxes spec §3.3). Set: only
     * records labelled `moca.dev/workload=<key>` are candidates, and there is no fallback to the
     * shared pool. Absent or '': records carrying any workload label are never candidates.
     */
    workload?: string;
    /**
     * The run owner's `recordScope` (32 hex, the hash knative-server's workloads.ts keys the owner's
     * Redis records by). Required with `workload`: a candidate must also carry
     * `moca.dev/owner=<ownerScope>`, a second check on the same signed binding (spec §3.3).
     */
    ownerScope?: string;
    /**
     * True when the leaf's only writable directory is the workload context view (a copy overlay
     * or a writable mount), so a per-session `<WorkspaceRoot>/<sessionId>` dir on the worker is
     * unused and need not be created. Honoured only for records that advertise
     * `WORKSPACE_SUBDIR_CAPABILITY` (the container worker): other records keep the session key.
     */
    agentWritesInContext?: boolean;
  },
  deps: SelectDeps = {},
): Promise<SelectedSandbox | null> {
  return select(env, headCwd, sessionId, opts, deps, false);
}

/**
 * The body of `selectPoolSandbox`, with `raced` saying whether this is the one permitted re-run
 * after losing a first-turn claim race (spec §4 step 6). Split out so that retry can recurse exactly
 * once while the exported signature stays unchanged.
 */
async function select(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  sessionId: string,
  opts: Parameters<typeof selectPoolSandbox>[3],
  deps: SelectDeps,
  raced: boolean,
): Promise<SelectedSandbox | null> {
  // Defaults to the session id, which is exactly what every leaf path wants and what this function
  // did before /turn began leasing here — so a caller that passes no holder keeps today's behaviour.
  const holderId = opts.holderId ?? sessionId;
  const selector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  const workload = opts.workload || undefined;
  const ownerScope = opts.ownerScope || undefined;
  const agentWritesInContext = opts.agentWritesInContext === true;
  // Without the owner a workload run could not apply the owner half of the filter; refuse rather
  // than fall back to matching on the workload alone.
  if (workload && !ownerScope) {
    throw new WorkloadSandboxMisconfiguredError(workload, 'the run names no owner scope');
  }
  // Workload sandboxes are relay records only; no other inventory can serve a workload run.
  const noRecords = () =>
    new WorkloadSandboxMisconfiguredError(
      workload!,
      'workload sandboxes need the relay sandbox pool (KAGENTI_SANDBOX_POOL_SELECTOR, SH_REMOTE_SANDBOX=1)',
    );
  if (!selector) {
    if (workload) throw noRecords();
    // ADR-0041: the single-pod fallback went with the pod-exec path. A stale
    // KAGENTI_SANDBOX_POD or KAGENTI_SANDBOX_NAME (its two inputs) must not quietly mean
    // "no sandbox" — the tools would then run in the harness process, MI1 §5 R3's hazard.
    const stale = ['KAGENTI_SANDBOX_POD', 'KAGENTI_SANDBOX_NAME'].find((k) => env[k]);
    if (stale) {
      throw new Error(
        `${stale} was removed with the Knative/KEDA deployment path (ADR-0041); ` +
          'a pool (KAGENTI_SANDBOX_POOL_SELECTOR) of relay-attached sandboxes is required',
      );
    }
    return null;
  }

  const podCwd = env.KAGENTI_SANDBOX_CWD ?? '/workspace';
  const lease = deps.lease ?? sharedLease(env.REDIS_URL);

  const source = resolveDiscoverySource(env, opts.remoteSandbox === true);
  if (workload && opts.remoteSandbox !== true) throw noRecords();
  // Read per call, like every other knob here; a bad value fails the selection naming the variable.
  const tiers = parseSandboxTiers(env);
  // `||`, not `??`: a session stored with '' (created before tiers were declared) gets the default.
  const tier = tiers ? opts.tier || tiers.default : '';
  // Workload sandboxes are container-only: /workloads and the provisioner refuse any other
  // tier (packages/knative-server/src/workloads.ts sandboxesSpec, packages/provisioner).
  // An incompatible session tier can never be served, so fail as a misconfiguration rather
  // than WorkloadSandboxUnavailableError (a 503 with Retry-After).
  if (workload && tier && tier !== WORKLOAD_SANDBOX_TIER) {
    throw new WorkloadSandboxMisconfiguredError(
      workload,
      `workload sandboxes do not support sandbox tier '${forLog(tier)}' (they are container-only)`,
    );
  }

  // Inertness: when the flag is off, never construct a RedisRecordStore or call .list() —
  // a deployment without the remote flag keeps today's no-extra-Redis-connection behaviour.
  const remoteOn = opts.remoteSandbox === true;
  let grpcRecs: SandboxRecord[] = [];
  if (remoteOn) {
    const injected = deps.records;
    grpcRecs = injected ? await injected.list() : await sharedRecords(env.REDIS_URL).list();
  }
  const allRecs = grpcRecs;
  // A record "retiered" away from this session is one labelled with ANOTHER declared tier; see the
  // affinity block. With no tiers declared nothing is.
  const inOtherDeclaredTier = (r: SandboxRecord): boolean => {
    const t = r.labels?.[TIER_LABEL];
    return !!tiers && !!t && t !== tier && tiers.names.includes(t);
  };
  if (tiers) grpcRecs = grpcRecs.filter((r) => recordInTier(r, tier, tiers.names));
  // The template filter (session-templates spec §4): a session with a template sees only workers
  // serving it, and pods never (no pod carries the label); a session without one sees only
  // untemplated workers. A deployment whose workers carry no template label keeps every record.
  const template = opts.template || '';
  const ofTemplate = (r: SandboxRecord): boolean => (r.labels?.[TEMPLATE_LABEL] || '') === template;
  grpcRecs = grpcRecs.filter(ofTemplate);
  // The build filter: only with a template and a pinned build; a worker reporting no
  // build label never serves a pinned session.
  const build = template && opts.build ? opts.build : '';
  const ofBuild = (r: SandboxRecord): boolean => !build || r.labels?.[BUILD_LABEL] === build;
  if (build) grpcRecs = grpcRecs.filter(ofBuild);
  // The workload filter (spec §3.3): a workload run sees only its own workload's sandboxes, of its own
  // owner, and a run
  // without one never sees any workload's. A deployment with no workload sandboxes has no record
  // carrying the label (no shipped worker sends it, and a relay with attach keys strips it from
  // shared-pool Hellos), so for it this keeps every record, exactly as before.
  // A workload run also requires the record's owner to be the run's (spec §3.3).
  const inScope = (r: SandboxRecord): boolean =>
    (r.labels?.[WORKLOAD_LABEL] || undefined) === workload &&
    (!workload || r.labels?.[OWNER_LABEL] === ownerScope);
  grpcRecs = grpcRecs.filter(inScope);
  const grpcById = new Map(grpcRecs.map((r) => [r.sandboxId, r]));

  const candidates = grpcRecs.map((r) => r.sandboxId);
  const empty = () =>
    workload
      ? new WorkloadSandboxUnavailableError(workload)
      : new SandboxPoolEmptyError(selector, tiers ? tier : undefined, template || undefined);

  // Acquire `name`, then build what the caller gets; a throw after the acquire releases the lease
  // before the original error propagates (unchanged from before -- it is just shared by two paths now).
  const take = async (
    name: string,
    workspaceReset?: WorkspaceReset,
  ): Promise<SelectedSandbox | null> => {
    if (!(await lease.acquire(name, opts.cap, holderId, opts.ttlMs))) return null;
    // The lease is held from here on: every step after the acquire runs inside this try, so a
    // throw (an exec client that cannot be built, a transport constructor) releases it before the
    // original error propagates, rather than holding a slot until the lease TTL expires.
    try {
      // Every candidate is a presence-record id, so the record is always found; `rec` stays
      // optional only because `sessionPodCwd` takes `SandboxRecord | undefined`.
      const rec = grpcById.get(name);
      const make = deps.makeTransport ?? GrpcRelayTransport;
      const transport = make(
        name,
        (deps.makeExecClient ?? ((id: string) => defaultExecClient(id, env)))(name),
        // The SESSION id becomes the Exec's workspace_key -- never the lease holder id. This
        // is the ONLY harness change the microVM tier needs, and it is required for
        // correctness rather than convenience: without it, consecutive leaseholders of one
        // sandbox_id inherit the previous session's workspace (spec §3.4).
        //
        // It has to be the session id specifically, because the key is also what makes a
        // session CONTINUOUS: `WorkspaceRoot/<workspace_key>` is created on the first Exec for
        // an unseen key and lives until an idle Reclaim (§4.4), so keying it per turn would
        // open turn 2 of a session in an empty workspace and give it its own standby VM pool
        // (§4.3) -- continuity lost and standbys multiplied per turn rather than per session.
        // The key is dropped only when the agent's only writable dir is the context view AND
        // the record advertises WORKSPACE_SUBDIR_CAPABILITY. The microVM worker does not
        // advertise it and refuses an empty key; today's workload deployments default to the
        // container tier, but the capability gate protects correctness regardless of default.
        {
          workspaceKey:
            agentWritesInContext && rec?.capabilities.includes(WORKSPACE_SUBDIR_CAPABILITY)
              ? ''
              : sessionId,
          ...(workload ? { workload } : {}),
        },
      );
      return {
        transport,
        podCwd: sessionPodCwd(podCwd, rec, sessionId),
        sandboxId: name,
        tier,
        ...(workspaceReset ? { workspaceReset } : {}),
        heartbeat: () => lease.heartbeat(name, holderId, opts.ttlMs),
        release: () => lease.release(name, holderId),
      };
    } catch (err) {
      // Best effort: a failed release must not replace the error that explains the failure.
      await lease.release(name, holderId).catch(() => {});
      throw err;
    }
  };
  const leastLoaded = async (): Promise<string[]> =>
    orderByLoad(
      await Promise.all(
        candidates.map(async (name) => ({ pod: name, active: await lease.load(name) })),
      ),
    );

  // Pool mode has read records only since the pod listing was removed (ADR-0041), and records
  // are read only with the remote flag on. A selector without the flag is therefore a stale
  // deployment: say so, rather than answering "no sandbox has attached" for a healthy relay.
  if (!remoteOn) {
    throw new Error(
      'KAGENTI_SANDBOX_POOL_SELECTOR is set but SH_REMOTE_SANDBOX is not "1": pool mode reads ' +
        'relay presence records, which require SH_REMOTE_SANDBOX=1 (the pod listing was removed, ADR-0041)',
    );
  }

  // P6.3 spec §4 steps 2-4. A READ failure propagates (the turn fails rather than scattering the
  // session across sandboxes on a Redis blip, §5); only the WRITE after a lease is best effort.
  const affinity = deps.affinity ?? sharedAffinity(env.REDIS_URL);
  const { ttlMs: affinityTtlMs, graceMs } = affinityTimings(env);
  const now = (deps.now ?? Date.now)();
  const prior = await affinity.get(sessionId);
  let reset: WorkspaceReset | undefined;
  // ANY entry is honoured, whatever tier it was recorded under (spec §4 step 2). Ignoring an entry
  // from another tier would drop every session PR 1 recorded under '' the moment tiers are switched
  // on (or a '' session's default changes), and lose its workspace with no frame, field or log. This
  // cannot cross tiers: `candidates` is already the session's tier, so the entry is only ever
  // followed to a sandbox in it.
  if (prior) {
    if (candidates.includes(prior.sandboxId)) {
      const got = await take(prior.sandboxId);
      // Saturated means alive and holding the workspace, just busy: wait, never move (spec §0).
      if (!got) {
        throw new SandboxPoolSaturatedError(
          selector,
          `this session's sandbox '${prior.sandboxId}' is at capacity`,
        );
      }
      const entry = { sandboxId: prior.sandboxId, tier };
      // Same tier: refresh. Another tier: re-record under the session's tier with a REPLACE, since a
      // claim would keep the old entry in force. The workspace is intact either way: no reset.
      await remember<unknown>(
        () =>
          prior.tier === tier
            ? affinity.claim(sessionId, entry, affinityTtlMs)
            : affinity.replace(sessionId, entry, affinityTtlMs),
        sessionId,
        prior.sandboxId,
      );
      return got;
    }
    // Present but outside this run's workload scope (a session moved between a workload and the
    // shared pool) is the same case as retiered: waiting cannot bring it into scope.
    if (
      allRecs.some(
        (r) =>
          r.sandboxId === prior.sandboxId &&
          (inOtherDeclaredTier(r) || !inScope(r) || !ofTemplate(r) || !ofBuild(r)),
      )
    ) {
      // Present, but advertising another DECLARED tier (or serving another template, or none: an
      // operator re-templated it, session-templates spec §4; or, for a session pinned to a build,
      // another build of its template, or no build label): an operator re-tiered the worker. It will not
      // come back to this tier by waiting, so the grace would only delay the same outcome (Review
      // Focus 3). An UNLABELLED record, or one labelled with an undeclared tier, is not "another tier"
      // (spec §4 step 4): it is a worker whose SANDBOX_TIER is missing or mistyped, most likely by
      // mistake, so it takes the grace path below like an absent one. Resetting at once would cost
      // every affine session its workspace before the operator could read the warning and fix it.
      reset = { from: prior.sandboxId, reason: 'retiered' };
    } else {
      const since = await affinity.detachedSince(prior.sandboxId, now, affinityTtlMs);
      // The store replaces a mark in the future (relay clock ahead) with `now`, so the grace runs
      // from this turn. The REPORTED wait stays clamped to the grace regardless, so a store that
      // returned a future mark anyway could never tell the client to wait longer than the grace.
      const left = graceMs - (now - since);
      if (left > 0) {
        const retryInMs = Math.min(left, graceMs);
        console.warn(
          `sandbox affinity: session ${forLog(sessionId)} waits for '${forLog(prior.sandboxId)}' ` +
            `(absent; ${Math.ceil(retryInMs / 1000)}s of grace left)`,
        );
        throw new SandboxAffinityPendingError(prior.sandboxId, retryInMs);
      }
      reset = { from: prior.sandboxId, reason: 'detached' };
    }
  }

  // Step 5: least-loaded within the tier. Step 6: record the choice.
  //
  // The empty check lives HERE on the records path, after affinity, not before it (spec §5, "Relay
  // restart"): while a restarted relay has no records yet, a session with affinity must get the
  // pending 503 above -- which also starts its grace clock -- rather than an empty-pool error. Only a
  // session with no entry, or one past its grace, reaches this point with nothing to choose from.
  // Checked before `leastLoaded`, so an empty set never costs a lease read.
  if (candidates.length === 0) throw empty();
  for (const name of await leastLoaded()) {
    const got = await take(name, reset);
    if (!got) continue;
    const entry = { sandboxId: name, tier };
    if (prior) {
      // A fallback (detached or retiered): deliberately overwrite the abandoned sandbox.
      await remember(() => affinity.replace(sessionId, entry, affinityTtlMs), sessionId, name);
      if (reset) {
        console.warn(
          `sandbox affinity: session ${forLog(sessionId)} moved from '${forLog(reset.from)}' to '${forLog(name)}' in tier ` +
            `'${forLog(tier)}' (${reset.reason}); its workspace starts empty`,
        );
      }
      return got;
    }
    const winner = await remember(
      () => affinity.claim(sessionId, entry, affinityTtlMs),
      sessionId,
      name,
    );
    if (!winner || winner.sandboxId === name) return got;
    // Another first turn of this session claimed a different sandbox between our read and our claim.
    // Converge on it, once: two concurrent turns of one session must share one workspace.
    await got.release().catch(() => {});
    if (raced) throw new SandboxAffinityPendingError(winner.sandboxId, 0);
    return select(env, headCwd, sessionId, opts, deps, true);
  }
  throw new SandboxPoolSaturatedError(selector);
}
