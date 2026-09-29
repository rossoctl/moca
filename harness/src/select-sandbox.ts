import { credentials } from '@grpc/grpc-js';
import {
  listPoolPods,
  resolveSandboxConfig,
  GrpcRelayTransport,
  SandboxExecClient,
  type RunKubectl,
  type K8sSandboxConfig,
  type SandboxTransport,
  type ExecClientLike,
} from '@moca/k8s-sandbox';
import { RedisLeaseStore, type LeaseStore } from './sandbox-lease.js';
import { RedisRecordStore, type RecordStore, type SandboxRecord } from './pool-records.js';

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
 * Named for BOTH memos, not just records — it always reset the lease store too, and the old
 * `resetSharedRecords` left the next reader to assume leases survived it.
 */
export function resetSharedStores(): void {
  if (recordsMemo) void recordsMemo.store.close().catch(() => {});
  if (leaseMemo) void leaseMemo.store.close().catch(() => {});
  recordsMemo = null;
  leaseMemo = null;
}

/** Pure: pods ordered ascending by active load (stable — ties keep input order). */
export function orderByLoad(loads: { pod: string; active: number }[]): string[] {
  return loads
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.active - b.active || a.i - b.i)
    .map((l) => l.pod);
}

/** Which sandbox inventories `selectPoolSandbox` consults. */
export type DiscoverySource = 'pods' | 'records' | 'both';

/**
 * Resolve `SH_SANDBOX_DISCOVERY`. Unset ⇒ `both`, which is byte-for-byte today's behaviour
 * (pods always listed; records only read when the remote flag is on).
 *  - `pods`    — kubectl listing only; mirrored grpc records are ignored even with the flag on.
 *  - `records` — mirrored grpc records only; never shells out to kubectl. This is what lets a
 *                bare VM (no cluster, no kubeconfig) reach a relay-fronted sandbox.
 *  - `both`    — the historical default.
 */
export function resolveDiscoverySource(
  env: NodeJS.ProcessEnv,
  remoteSandbox: boolean,
): DiscoverySource {
  const raw = env.SH_SANDBOX_DISCOVERY?.trim();
  if (!raw) return 'both';
  if (raw !== 'pods' && raw !== 'records' && raw !== 'both') {
    throw new Error(`SH_SANDBOX_DISCOVERY='${raw}' is not one of pods|records|both`);
  }
  if (raw === 'records' && !remoteSandbox) {
    // Blame the flag, not the pool: without this the caller sees "no Running pods for pool
    // selector '…'", which sends them debugging a healthy pool.
    throw new Error(
      'SH_SANDBOX_DISCOVERY=records requires SH_REMOTE_SANDBOX=1 (records are only read when the remote flag is on)',
    );
  }
  return raw;
}

/** Thrown when a pool is configured but every pod is at the soft cap. */
export class SandboxPoolSaturatedError extends Error {
  constructor(selector: string) {
    super(`sandbox pool '${selector}' saturated: all pods at capacity`);
    this.name = 'SandboxPoolSaturatedError';
  }
}

/**
 * Thrown when a pool is configured but has no candidate sandbox YET — pods rolling, an HPA scaling
 * from zero, presence records not re-mirrored after a restart.
 *
 * A named class purely so callers can tell this apart from a generic failure. It used to be a plain
 * `Error`, which since /turn started leasing from the pool meant an empty pool surfaced as a 500 —
 * "this can never succeed" — while a FULL pool got the 503 it deserves. Same underlying fact from the
 * caller's side (no capacity available right now, retry), so the two now map identically
 * (`turnErrorStatus`). The async path already agreed: `classifyOutcome` keeps both retryable.
 *
 * The message is phrased per DISCOVERY SOURCE, because one wording cannot be true of all three. In
 * `records` mode no pod listing happens at all — `pods` is forced to `[]` — so blaming the pool
 * selector sent an operator to debug a healthy pool, the exact misdirection `resolveDiscoverySource`'s
 * own guard was added to prevent. That mode is the shipped VM default
 * (`env/supervisor.env.example`), where "no sandbox has attached to the relay yet" is the likeliest
 * first-run state, so it is the message operators actually hit.
 *
 * The pods wording is unchanged, which is what keeps existing log greps and the `/pool selector/`
 * assertions matching; only the source that never produced it truthfully says something else.
 */
export class SandboxPoolEmptyError extends Error {
  constructor(selector: string, source: DiscoverySource = 'both') {
    super(
      source === 'records'
        ? `no sandbox presence records (SH_SANDBOX_DISCOVERY=records — no sandbox has attached to the relay yet)`
        : `no Running pods for pool selector '${selector}'`,
    );
    this.name = 'SandboxPoolEmptyError';
  }
}

export interface SelectedSandbox {
  config: K8sSandboxConfig;
  /** Present ONLY for a leased grpc presence record; undefined for pods. */
  transport?: SandboxTransport;
  /**
   * Whether a lease was actually TAKEN, reported here rather than re-derived by the caller.
   *
   * `heartbeat`/`release` cannot answer it: the no-selector branch returns no-op closures that are
   * indistinguishable from real ones, so `acquireTurnSandbox` used to re-evaluate this function's own
   * `if (!selector)` condition against the environment to decide whether to arm a renewal timer. That
   * agreed today and was pinned by a test, but it put one predicate in two files — and a change here
   * (trimming the selector, say, as `resolveDiscoverySource` already does for its own value) would
   * have made them disagree silently, arming or skipping a renewal against the truth.
   */
  leased: boolean;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

export interface SelectDeps {
  listPods?: (
    selector: string,
    namespace: string,
    context?: string,
    run?: RunKubectl,
  ) => Promise<string[]>;
  lease?: LeaseStore;
  run?: RunKubectl;
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
    opts?: { workspaceKey?: string },
  ) => SandboxTransport;
}

/** Lazily builds a real gRPC exec client — only reached on the grpc branch when the flag is on. */
function defaultExecClient(_sandboxId: string, env: NodeJS.ProcessEnv): ExecClientLike {
  const addr = env.SH_RELAY_ADDR ?? 'sandbox-relay.default.svc.cluster.local:8443';
  return new SandboxExecClient(addr, credentials.createInsecure()) as unknown as ExecClientLike;
}

/**
 * Choose a sandbox pod for a leaf.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ fall back to single-pod resolution
 *    (`KAGENTI_SANDBOX_POD`/`_NAME`); returns null if that too is unset (run local tools).
 *  - Pool configured ⇒ list Running pods (plus mirrored grpc records when `opts.remoteSandbox`
 *    is true), pick least-loaded under the soft cap, acquire a lease. Throws
 *    SandboxPoolSaturatedError if every candidate is full.
 *  - `SH_SANDBOX_DISCOVERY` narrows which inventories are consulted (see resolveDiscoverySource).
 *
 * TWO identities arrive here and they are not interchangeable. `sessionId` keys the microVM WORKSPACE
 * and must be stable across the turns of a session; `opts.holderId` is the lease's ZSET member and
 * must be unique per concurrent holder. They are equal for a leaf (one session executing once) and
 * differ for `/turn` (many concurrent turns of one session), which is why the holder is a separate,
 * optional argument that defaults to the session id rather than something derived here.
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  sessionId: string,
  opts: { cap: number; ttlMs: number; remoteSandbox?: boolean; holderId?: string },
  deps: SelectDeps = {},
): Promise<SelectedSandbox | null> {
  // Defaults to the session id, which is exactly what every leaf path wants and what this function
  // did before /turn began leasing here — so a caller that passes no holder keeps today's behaviour.
  const holderId = opts.holderId ?? sessionId;
  const selector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  if (!selector) {
    const config = await resolveSandboxConfig(env, headCwd, deps.run);
    return config
      ? { config, leased: false, heartbeat: async () => {}, release: async () => {} }
      : null;
  }

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? 'default';
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;
  const podCwd = env.KAGENTI_SANDBOX_CWD ?? '/workspace';
  const list = deps.listPods ?? listPoolPods;
  const lease = deps.lease ?? sharedLease(env.REDIS_URL);

  const source = resolveDiscoverySource(env, opts.remoteSandbox === true);
  const pods = source === 'records' ? [] : await list(selector, namespace, context, deps.run);

  // Inertness: when the flag is off, never construct a RedisRecordStore or call .list() —
  // the pod path must stay byte-for-byte identical to today (no extra Redis connection).
  const remoteOn = opts.remoteSandbox === true && source !== 'pods';
  let grpcRecs: SandboxRecord[] = [];
  if (remoteOn) {
    const injected = deps.records;
    grpcRecs = injected ? await injected.list() : await sharedRecords(env.REDIS_URL).list();
  }
  const grpcById = new Map(grpcRecs.map((r) => [r.sandboxId, r]));

  const candidates = [...pods, ...grpcRecs.map((r) => r.sandboxId)];
  if (candidates.length === 0) throw new SandboxPoolEmptyError(selector, source);

  const loads = await Promise.all(
    candidates.map(async (name) => ({ pod: name, active: await lease.load(name) })),
  );
  for (const name of orderByLoad(loads)) {
    if (await lease.acquire(name, opts.cap, holderId, opts.ttlMs)) {
      const config: K8sSandboxConfig = { pod: name, namespace, context, podCwd, headCwd };
      const rec = grpcById.get(name);
      const make = deps.makeTransport ?? GrpcRelayTransport;
      const transport = rec
        ? make(
            name,
            (deps.makeExecClient ?? ((id: string) => defaultExecClient(id, env)))(name),
            // The SESSION id becomes the Exec's workspace_key -- never the lease holder id. This is
            // the ONLY harness change the microVM tier needs, and it is required for correctness
            // rather than convenience: without it, consecutive leaseholders of one sandbox_id inherit
            // the previous session's workspace (spec §3.4).
            //
            // It has to be the session id specifically, because the key is also what makes a session
            // CONTINUOUS: `WorkspaceRoot/<workspace_key>` is created on the first Exec for an unseen
            // key and lives until an idle Reclaim (§4.4), so keying it per turn would open turn 2 of a
            // session in an empty workspace and give it its own standby VM pool (§4.3) -- continuity
            // lost and standbys multiplied per turn rather than per session.
            { workspaceKey: sessionId },
          )
        : undefined;
      return {
        config,
        transport,
        leased: true,
        heartbeat: () => lease.heartbeat(name, holderId, opts.ttlMs),
        release: () => lease.release(name, holderId),
      };
    }
  }
  throw new SandboxPoolSaturatedError(selector);
}
