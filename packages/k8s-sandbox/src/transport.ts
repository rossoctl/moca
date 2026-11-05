/**
 * The exec seam Pi sees (spec §3). Everything above `select-sandbox`
 * (`run-leaf`, `run-turn`, `converge`) depends only on `SandboxTransport` and
 * never learns how bytes reach the sandbox. Implementation: `GrpcRelayTransport`,
 * capped at DEFAULT_OUTPUT_CAP (spec §8). The kubectl-exec implementations were
 * removed with the Knative/KEDA deployment path (ADR-0041).
 */

/**
 * The result of one exec through the seam.
 *
 * `truncated` is REQUIRED, not optional. An optional field lets a fourth transport omit
 * it and read as "not truncated", silently reintroducing the divergence #180/#185 are
 * about; required, it is a compile error. The invariant `truncated === true ⇒
 * exitCode === null` is asserted for every implementation by test/conformance.ts.
 *
 * `exitCode: null` is retained on truncation for backward compatibility: every caller
 * that checks `!== 0` keeps failing closed, so there is no flag day. The flag adds
 * precision — `truncated: false` with `exitCode: null` now unambiguously means "no exit
 * status, and NOT because of our cap" (a signalled process; gRPC `end.exitCode < 0`; a
 * stream that ended without an `End` frame).
 */
export interface ExecResult {
  stdout: Buffer;
  exitCode: number | null;
  /**
   * The seam's output cap tripped (spec §8). `stdout` is incomplete and ends with
   * OUTPUT_TRUNCATED_MARKER, the producer was stopped, and `exitCode` is null.
   */
  truncated: boolean;
}

/**
 * One command run in the sandbox (`bash -c <command>`). stdout is collected and
 * returned; stderr is streamed to `onData` (with stdout) but NOT included in the
 * returned `stdout`, so file ops get clean bytes. `stdin` feeds data (e.g. base64
 * for writes); `onData` streams output for bash; `signal` aborts; `timeout` is seconds.
 */
export type ExecInPod = (
  command: string,
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds
  },
) => Promise<ExecResult>;

/** A transport-blind exec channel to one sandbox (spec §3). */
export interface SandboxTransport {
  exec: ExecInPod;
  /** Release any long-lived resource (persistent channel, connection). Idempotent. */
  close(): Promise<void>;
  /**
   * Whether a burst of small file ops costs ONE reused shell or N round trips (#245).
   * See FastTier. REQUIRED for the reason `ExecResult.truncated` is: optional, a fourth
   * transport omits it and reads as the safe-looking default, which is how this
   * divergence existed unrecorded in the first place.
   */
  fastTier: FastTier;
}

/**
 * What the sandbox tools need besides a transport: where head paths map inside the
 * sandbox, and what to call the sandbox in prompts and logs.
 *
 * The pod-exec path (ADR-0041) carried this as a full `K8sSandboxConfig` — pod name,
 * namespace, kubectl context — because the harness built `kubectl exec` arguments from
 * it. With sandboxes reached over the relay, only the path mapping and a display name
 * remain.
 */
export interface SandboxContext {
  /** Sandbox-side working directory; head paths under `headCwd` map here. */
  podCwd: string;
  /** Harness-side cwd; head paths under it map to `podCwd`. */
  headCwd: string;
  /** The sandbox's id (a relay presence-record id), for prompts and logs. */
  sandboxId?: string;
}

/**
 * Whether a transport amortizes a burst of small ops over ONE reused shell, or pays a
 * round trip and a fresh process for each (#245).
 *
 * WHY THIS IS ON THE SEAM AND NOT A COMMENT. `truncated` is on `ExecResult` because the
 * alternative — an optional field a fourth transport can omit — is how the #180/#185
 * divergence survived. Fast-tier availability is the same shape of fact and was in the
 * worse state: not even optional, just absent. `extension.ts` runs a two-tier transport
 * precisely because file ops are the highest-frequency tool calls, and `opts.transport`
 * overrode BOTH tiers — so on the gRPC path (`run-leaf.ts`, which passes a leased
 * transport) the fast tier silently did not exist and every read/write/edit/ls/find
 * became a full `SandboxExec.Exec` ending in a fresh `bash -c`. A caller above the seam
 * could not see that, let alone choose it.
 *
 * `'persistent-channel'` is a CLAIM ABOUT COST, not about correctness: it says a burst of
 * N fast ops costs one reused shell rather than N. It does not promise streaming — the
 * one implementation that makes the claim today declares `streams: false` to the
 * conformance battery, which is exactly why the fast tier serves `read`/`write`/`edit`/
 * `ls`/`find` and never `bash`/`grep`.
 *
 * Pinned PER TRANSPORT by test/conformance.ts, in the same discipline `producerStop`
 * uses: every implementation makes a positive claim, so a fourth cannot ship without one.
 * That takes TWO tests, because the required field and the battery each cover only half.
 * The field makes OMITTING the claim a compile error; the battery asserts the claim a
 * caller reads matches the one the transport makes, both raw and through the capacity
 * latch that wraps it on a harness turn. Neither can see a fourth transport that declares
 * a tier and simply never enrols in the battery — type-correct, unasserted, which is the
 * state this whole divergence was already in. test/fast-tier-coverage.test.ts closes it by
 * pinning the declaration sites against the enrolments.
 */
export type FastTier = 'persistent-channel' | 'per-call-exec';

/**
 * Total returned-stdout cap per exec (spec §8, "poisoned-output defense"). Enforced by
 * the `SandboxTransport` implementation, by its own mechanism, which it declares to
 * the shared battery (test/conformance.ts):
 *
 *  - `GrpcRelayTransport`   `remote-abort`      `Abort` → the worker kills the process group
 *
 * On a trip it truncates, appends OUTPUT_TRUNCATED_MARKER, and sets
 * `truncated: true` with a null exit code. The battery asserts the invariant and the
 * declared mechanism, so it cannot regress alone.
 *
 * The Go worker's BufferCap (remote-worker/internal/exec/runner.go) is pinned to this
 * value — change one and change the other; test/output-cap-coupling.test.ts enforces it.
 */
export const DEFAULT_OUTPUT_CAP = 8 * 1024 * 1024; // 8 MiB

/** Appended to returned stdout when the cap trips, so Pi sees the truncation. */
export const OUTPUT_TRUNCATED_MARKER = '\n[output truncated]';

/**
 * base64EncodedLength is what a write costs on the wire, EXACTLY. `createPodWriteOps`
 * sends file content as base64 in `Exec.stdin` (operations.ts), and base64 emits 4
 * bytes per 3 consumed, padding the final group — so the length is `4·⌈n/3⌉`, which is
 * up to 2 bytes more than the ×4/3 ratio suggests.
 *
 * The ratio is fine for prose and wrong for a bound: at DEFAULT_OUTPUT_CAP the two
 * differ by 1.33 bytes, and 8 MiB × 4/3 = 11184810.67 sits BELOW the real 11184812. A
 * guard written against the ratio therefore admits a ceiling that cannot actually carry
 * the largest readable file — it fails to certify the one property it exists for, at
 * exactly its own boundary. Use this instead of multiplying.
 */
export const base64EncodedLength = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/**
 * EXEC_FRAMING_HEADROOM is what an `Exec` costs BEYOND its base64 stdin: the command
 * string, the protobuf field tags and length prefixes, and `ExecRequest`'s `sandbox_id`.
 *
 * Measured, not guessed: a 4 MiB write arrived as 5592440 bytes against a base64 payload
 * of 5592408 — a delta of **32 bytes**. 64 KiB is three orders of magnitude above that,
 * which is deliberate: the command string is the only unbounded term (`base64 -d > <path>`
 * today, a few dozen bytes) and nothing in the contract caps it.
 */
export const EXEC_FRAMING_HEADROOM = 64 * 1024;

/**
 * MAX_EXEC_MESSAGE_BYTES raises gRPC's 4 MiB default receive limit, which is smaller
 * than this contract's own write path needs (#173 item 2).
 *
 * THE DERIVATION, because the number must not be arbitrary. The largest readable file
 * is DEFAULT_OUTPUT_CAP, and writing it back costs
 * `base64EncodedLength(DEFAULT_OUTPUT_CAP) + EXEC_FRAMING_HEADROOM` = 11184812 + 65536
 * ≈ 10.7 MiB of `Exec`. At the 4 MiB default, every file between ~3 MiB and 8 MiB was
 * READABLE BUT NOT WRITABLE — and Pi's Edit composes read with write, so editing one
 * succeeded at reading and then failed. 16 MiB clears that floor with ~5 MiB to spare,
 * making write capacity >= read capacity by construction. `KubectlTransport` pipes
 * base64 through `kubectl exec` stdin with no such ceiling, so this also removes a
 * divergence where the same write succeeded or failed depending on which backend was
 * leased.
 *
 * The floor is asserted against the EXACT encoded length, not the ×4/3 ratio — see
 * base64EncodedLength for why the ratio cannot certify this property at its own
 * boundary.
 *
 * BOTH ENDS MUST MOVE TOGETHER, and the worker's limit must be at least this one.
 * The relay's ingress is what rejects an oversized `ExecRequest` today, and that
 * rejection is contained to a single exec. Raising the relay alone would forward the
 * payload and move the rejection onto the worker's Attach stream, whose death takes
 * every concurrent and queued exec with it. The Go side is
 * `session.MaxRecvMsgBytes`, pinned to this value by
 * test/message-size-coupling.test.ts — change one and change the other.
 *
 * MEMORY BUDGET — raising a receive limit raises worst-case ingress buffering with it,
 * 4x here, so state it the way `BufferCap` states its own (runner.go):
 *
 *	concurrently decoding ExecRequests × MAX_EXEC_MESSAGE_BYTES
 *
 * It is a TRANSIENT, not a residency: the relay forwards `exec` to the Attach stream and
 * keeps no copy (relay.ts routeExec), so the peak is however many oversized requests are
 * mid-decode at once rather than however many execs are in flight. Nothing in the
 * contract bounds that count — the relay is single-replica and serves every harness
 * replica — so this is a ceiling to size the relay's limits against, not a proof. For
 * scale: one such request costs a quarter of the worker's own 64 MiB
 * (2 × MaxConcurrent × BufferCap) budget, and only a write near the read cap reaches it.
 *
 * Send limits need no change: grpc-js defaults max_send_message_length to -1 and
 * grpc-go defaults MaxCallSendMsgSize to MaxInt32, both effectively unlimited.
 */
export const MAX_EXEC_MESSAGE_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Ceiling on one exec when the caller names no `timeout` (spec §3; issue #182). Shared by
 * every implementation, for the same reason DEFAULT_OUTPUT_CAP is: an exec that
 * behaves differently depending on which transport happened to serve it is a divergence
 * the caller above the seam cannot see or control.
 *
 * The transports used to disagree. The kubectl-exec transports armed no timer at all, so
 * a command with no timeout ran unbounded; `GrpcRelayTransport` applied 120 s.
 * Pi's bash tool declares `timeout` optional and tells the model there is "no default
 * timeout", so omitting it is the ordinary case, not an edge one — the same model-issued
 * `bash` ran forever on a pod and died after two minutes through a relay.
 *
 * This is deliberately generous. It exists to stop an exec leaking a slot forever, NOT to
 * police how long a command may legitimately take: a cold `npm ci`, a full test suite or a
 * container build can all outrun a two-minute budget, and the relay's 120 s default was low
 * enough to fail those on the remote path only. Callers that know better still pass their
 * own `timeout`, and `timeout: 0` explicitly opts out (the ceiling applies only when the
 * option is absent).
 *
 * `GrpcRelayTransport` also sends this as the request's `timeout_s`, so the worker holds the
 * same budget independently. It is the only transport whose process is remote: the other two
 * time out a child in their own process, which cannot outlive the timer, whereas a harness
 * that exits mid-exec would otherwise leave a remote process with nothing left to stop it.
 *
 * Pinned for every implementation by test/conformance.ts (and, for the wire value,
 * test/grpc-relay-transport.test.ts), so none can drift back.
 */
export const DEFAULT_EXEC_TIMEOUT_S = 30 * 60; // 30 minutes

/**
 * The worker's ExecError messages that mean "this host is at capacity", not "your
 * command failed" (#452).
 *
 * WHY A PREFIX MATCH ON PROSE IS THE ONLY OPTION HERE. There is no "busy" frame in the
 * wire contract — remote-worker/internal/vmpool/errors.go says exactly that, and draws
 * the consequence: "a refusal can only be an error". So a refusal travels as
 * `ExecError{req_id, message}`, the same frame a failed command uses, and the message
 * is the entire signal. That is a wire-contract gap and this regex is the workaround
 * for it, not a design; the durable fix is a typed refusal on the wire, at which point
 * this goes away.
 *
 * The three prefixes, and where each is built:
 *
 *  - `memory-budget:`   vmpool `RefuseMemoryBudget` — committing one more VM would
 *                       cross `MaxCommittedBytes - MemoryReserveBytes` (budget.go)
 *  - `max-runs:`        vmpool `RefuseMaxRuns` — the backstop under the lease cap
 *  - `busy: queue full` the session loop's own refusal (session/loop.go)
 *
 * The first two are `RefusalError.Error()`'s `"<reason>: <detail>"` rendering, so the
 * colon is part of the contract rather than incidental. PINNED AGAINST THE GO SOURCE by
 * test/refusal-vocabulary-coupling.test.ts, in the same house idiom DEFAULT_OUTPUT_CAP
 * uses for `BufferCap` — change one and change the other.
 *
 * `@moca/sandbox-client` carries this vocabulary as its own `TEMPLATE_BUSY`
 * (exec-conn.ts), where it was first established. It is DUPLICATED rather than imported
 * because neither this package nor `@moca/harness` depends on that one, and adding the
 * dependency to share a three-branch regex would couple this transport seam to the
 * relay client's whole surface. The coupling test is what keeps the copies honest: both
 * are pinned to the same Go constants, so the Go source is the single definition and
 * neither copy is the other's authority.
 */
export const CAPACITY_REFUSAL = /^(?:memory-budget:|max-runs:|busy: queue full)/;

/**
 * Thrown by a transport when the worker REFUSED an exec for capacity rather than
 * failing it (#452). Carries no extra data — its whole payload is its identity.
 *
 * THE NAME IS THE CONTRACT, not a label. `knative-server`'s `turnErrorStatus` maps
 * errors to HTTP status by `err.name`, deliberately: `instanceof` is only sound within
 * one package instance, which is false whenever a test mocks a harness module wholesale
 * (server.test.ts does). A test there also pins that a saturation-shaped MESSAGE still
 * yields 500 — so prose must never be the signal above this seam, which is exactly why
 * this class exists. It converts the one place where prose IS the signal
 * (CAPACITY_REFUSAL, at the wire) into a type the rest of the stack can carry.
 *
 * It does NOT extend `SandboxPoolSaturatedError`. That means "no sandbox could be
 * leased", is raised in select-sandbox.ts before any exec, and is caught at lease time
 * in all three leaf paths. This means "a leased sandbox's host refused the work" and
 * arrives mid-turn, long after those catches have been passed. Sharing a type would
 * route it through `catch` blocks unreachable from here while implying the two are
 * interchangeable. What they genuinely share is the OUTCOME — 503 with `Retry-After` —
 * and that is expressed by both names sitting in server.ts's NO_CAPACITY set.
 */
export class SandboxCapacityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    // Set explicitly rather than left to the constructor name: `name` is what the
    // status mapper reads, and a minifier renames the class.
    this.name = 'SandboxCapacityRefusedError';
  }
}
