# SandboxTransport: language-neutral remote exec over gRPC

**Date:** 2026-07-08
**Status:** Design — approved for planning
**Scope:** The interface between the harness and the sandbox(es), enabling sandboxes to
run outside the harness's cluster (self-hosted / laptop / on-prem / other cloud /
bring-your-own), while keeping the in-cluster `kubectl-exec` path unchanged.
**Supersedes:** the Redis-Streams transport previously proposed in this PR
(`2026-07-07-sandbox-transport-remote-exec-design.md`). See §12 for why.

## 1. Problem & goal

Today the harness executes every Pi tool call (read / write / bash / grep) inside a
sandbox pod via `kubectl exec` (`packages/k8s-sandbox/src/exec.ts`,
`ExecInPod = (command, opts) => Promise<{ stdout, exitCode }>`). The **harness initiates
the connection into the pod through the kube API**. This only works when the harness can
reach the sandbox's API server, which rules out sandboxes behind NAT, on-prem, on a
laptop, or in another cloud.

**Goal:** let a sandbox live anywhere by inverting connectivity — the sandbox dials _out_
to a broker the harness also talks to — with a protocol that is **language-neutral**
(any runtime can host a worker) and **firewall-friendly** (a single outbound TLS
connection on `:443`), without changing the Pi orchestration loop, the session backend,
or the leaf queue.

### Drivers (priority order)

1. **Bring-your-own (untrusted 3rd-party) sandbox** — external parties host their own
   sandbox and register it. _Top priority._
2. **Decoupling / heterogeneity** — a clean, language-independent harness↔sandbox
   contract so a sandbox can be any runtime (VM, Firecracker, remote Docker) in any
   language.
3. **Bursting to external compute** — latency-tolerant overflow onto owned capacity.
4. **Reachability** — sandboxes the harness cannot dial into.

## 2. Key decisions (settled during brainstorming)

- **Brain stays central.** The Pi loop + LLM calls remain in the harness; only command
  execution is delegated. This is the _trust-correct_ choice for driver #1: the LLM key
  and control loop never leave the harness; an untrusted sandbox only ever receives
  commands and returns bytes.
- **The contract is a Protobuf IDL, not a TypeScript interface.** Any language with gRPC
  codegen (Go, Python, Rust, Java, TS, …) can implement a worker. The `.proto` is the
  source of truth; TypeScript is just one generated client. This is what makes driver #2
  real.
- **gRPC-native over HTTP/2 on `:443`.** One outbound TLS connection carrying a
  full-duplex bidirectional stream. HTTP/2-on-443 traverses most modern egress and NAT.
  _(Connect / HTTP-1.1 fallback was considered and rejected — see §5 — because our
  streaming core is full-duplex, which requires HTTP/2 regardless.)_
- **A single-replica relay, presence-only.** A new in-cluster process bridges the
  worker's outbound stream to the harness's in-cluster calls. It does **not** own
  matching or leasing — it mirrors connected workers into the **existing sandbox pool**,
  and the existing `select-sandbox` logic does the matching unchanged.
- **One reference worker, in Go.** A single static binary with no runtime dependencies,
  droppable into any sandbox image — and the honest proof that the contract is genuinely
  language-neutral rather than secretly TS-shaped.
- **Per-sandbox bearer token at the edge.** The worker authenticates on connect;
  SPIFFE/mTLS for untrusted BYO upgrades into the _same_ seam later.
- **Latency posture: mixed.** `kubectl-exec` stays as the fast in-cluster implementation;
  the remote path is added behind the same interface and degrades gracefully.

## 3. Architecture

```
Sandbox (laptop / on-prem / other cloud / same cluster)
   worker (Go static binary) — implements SandboxWorker.Attach client
      │  outbound only, TLS :443, HTTP/2
      │  ServerFrame{Exec|Abort} ↓   WorkerFrame{Hello|Heartbeat|Chunk|End|Error} ↑
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Kubernetes                                                             │
│   relay (Deployment, 1 replica)                                        │
│     SandboxWorker.Attach     ← workers dial in (bidi stream)           │
│     SandboxExec.Exec/Abort   ← harness calls (in-cluster)              │
│     in-memory session table: sandbox_id → live Attach stream           │
│     mirrors presence → existing Redis sandbox pool                     │
│        │ in-cluster gRPC                    │ presence write/remove     │
│        ▼                                    ▼                           │
│   Harness (central brain, Pi loop + LLM)   Redis sandbox pool          │
│     SandboxTransport.exec(...)  ← the ONE seam                         │
│       ├─ [local]  KubectlTransport   (existing kubectlExecInPod)       │
│       └─ [remote] GrpcRelayTransport (new; calls SandboxExec)          │
│     select-sandbox → leases pod OR remote record → returns a transport │
└──────────────────────────────────────────────────────────────────────┘
```

### Component boundaries

| Unit                           | Purpose                                                                                           | Depends on              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------- |
| `SandboxTransport` (interface) | The exec seam Pi sees. No transport knowledge above it.                                           | —                       |
| `KubectlTransport`             | Local/in-cluster fast path. Rename of today's `kubectlExecInPod`.                                 | kubectl                 |
| `GrpcRelayTransport`           | Harness side: turn one `exec()` into a `SandboxExec.Exec` call + stream reassembly + correlation. | relay (in-cluster gRPC) |
| `relay`                        | Bridge worker's outbound `Attach` stream ↔ harness `Exec`; mirror presence into the pool.         | gRPC, Redis pool        |
| Go worker (reference)          | Sandbox side: dial `Attach`, run commands locally, stream frames, honor abort.                    | local shell             |
| `select-sandbox` (existing)    | Now returns a **transport**, not a pod name. Sees pods + remote records; leases least-loaded.     | pool/lease logic        |

### The harness-facing interface (unchanged from PR #78)

```ts
interface SandboxTransport {
  exec(
    command: string,
    opts?: {
      stdin?: Buffer;
      onData?: (chunk: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number; // seconds
    },
  ): Promise<{ stdout: Buffer; exitCode: number | null }>;
  close(): Promise<void>;
}
```

This is today's `ExecInPod` capability surface verbatim, plus `close()`. Pi depends on all
of it (streaming via `onData`; abort via `signal`; `timeout`; `stdin` for writes), so the
interface preserves all of it. `GrpcRelayTransport` and `KubectlTransport` are two
implementations of this one interface.

### Architectural invariants

- **Single worker per sandbox; one exec in flight per sandbox.** Preserves
  shell/cwd/env/filesystem ordering and makes req order == execution order. Mirrors
  today's `persistent-exec.ts`.
- **Everything above `select-sandbox` is transport-blind.** `run-leaf`, `run-turn`,
  `converge` receive a `SandboxTransport` and never learn how bytes reach the sandbox.
  `converge` (repo sync) already goes through exec, so it rides the transport for free.
- **The relay is a stateless byte-bridge.** It parses only enough to route by
  `sandbox_id`; the exec is effectively end-to-end between harness and worker.

### What does NOT change

The Pi orchestration loop, `run-turn`, the session backend (`RedisSessionBackend`), the
leaf queue (`@moca/work-queue`), and the sandbox **pool/lease** logic. The change slots
strictly _below_ the current `ExecInPod` call sites (`converge.ts`, `run-leaf.ts`,
`run-turn.ts`, `select-sandbox.ts`).

## 4. The Protobuf contract (`sandbox/v1`)

Two services. No registry service and no `Selector` message — matching stays in the
harness pool (§6).

```protobuf
syntax = "proto3";
package sandbox.v1;

// Worker (any language) dials the relay and holds ONE bidi stream.
// worker→relay carries results/liveness; relay→worker carries commands.
service SandboxWorker {
  rpc Attach(stream WorkerFrame) returns (stream ServerFrame);
}

// Harness asks the relay to run a command on a connected sandbox and
// streams the output back. The relay bridges to the worker's Attach
// stream, keyed by sandbox_id. In-cluster only.
service SandboxExec {
  rpc Exec(ExecRequest) returns (stream ExecEvent);   // server-streaming output
  rpc Abort(AbortRequest) returns (AbortResponse);
}

// ---- worker → relay ----
message WorkerFrame {
  oneof msg {
    Hello     hello     = 1;   // sent first: identity + capabilities
    Heartbeat heartbeat = 2;   // liveness; also keeps NAT/proxy state open
    Chunk     chunk     = 3;   // streamed stdout for an exec
    End       end       = 4;   // terminal success for an exec
    ExecError error     = 5;   // exec/channel failure
  }
}

// ---- relay → worker ----
message ServerFrame {
  oneof msg {
    Exec  exec  = 1;           // run one command
    Abort abort = 2;           // cancel an in-flight exec
  }
}

message Hello {
  string sandbox_id            = 1;
  map<string,string> labels    = 2;   // team=alpha, env=prod, region=us-east
  repeated string capabilities = 3;   // ["python3","kubectl","gpu","node20"]
  string image                 = 4;   // sandbox image tag/digest
  string arch                  = 5;   // amd64 | arm64
  uint32 capacity_max          = 6;   // max concurrent execs the worker allows
  string trust                 = 7;   // "trusted" | "untrusted"
}

message Heartbeat {}                   // liveness/keepalive only; harness owns lease counts

message Exec {
  uint64 req_id    = 1;                // salt+counter, unique across processes; correlation + dedup key
  string command   = 2;
  bytes  stdin     = 3;                // raw bytes (protobuf is binary — no base64)
  uint32 timeout_s = 4;
  bool   streaming = 5;                // true for bash/grep; false for read/write
}
message Abort     { uint64 req_id = 1; }
message Chunk     { uint64 req_id = 1; bytes data = 2; }        // 0..n, only if streaming
message End       { uint64 req_id = 1; sint32 exit_code = 2; }  // exit_code < 0 = signal/none
message ExecError { uint64 req_id = 1; string message = 2; }

// ---- harness ↔ relay (SandboxExec) ----
message ExecRequest { string sandbox_id = 1; Exec exec = 2; }   // sandbox_id from the lease
message ExecEvent   { oneof event { Chunk chunk = 1; End end = 2; ExecError error = 3; } }
message AbortRequest  { string sandbox_id = 1; uint64 req_id = 2; }
message AbortResponse {}
```

**Notes**

- **Binary, not base64.** `bytes stdin` / `bytes data` ride protobuf's native binary
  encoding — smaller and faster than the JSON+base64 frames of the superseded design.
- **The worker does not self-report `capacity_in_use`.** The harness owns the leases (the
  pool ZSET already tracks how many it has granted each sandbox), so `Hello` carries only
  `capacity_max`, and `Heartbeat` is pure liveness/keepalive.

## 5. Connectivity: one bidi `Attach` stream, worker-dialed

The constraint: the **worker can only dial out**, but the **harness must push commands to
the worker**. A single **bidirectional streaming RPC where the worker is the client**
resolves this — commands flow to the worker on the _server→client_ half of the stream the
worker itself opened:

```
Worker (client, dials OUT :443)                     Relay (server, in-cluster)
   │  Attach(stream WorkerFrame) ───────────────────────▶│  worker→relay: results & liveness
   │◀─────────────────────────── returns (stream ServerFrame)  relay→worker: commands
```

The worker opens one long-lived bidi stream and **never listens for inbound
connections**. Commands arrive on the response side of its own outbound call — the
outbound-only property we want, expressed in a standard RPC primitive.

**Why gRPC-native and not Connect.** Connect's headline advantage is a plain-HTTP/1.1
fallback that traverses HTTP-inspecting proxies. But **full-duplex bidi streaming
requires HTTP/2 regardless of framework** — Connect only offers unary + server-streaming
over HTTP/1.1. Since our core _is_ a full-duplex stream, Connect buys us little for the
part that matters while adding a second toolchain. We therefore use gRPC-native over
HTTP/2 on `:443`. If a concrete "must traverse HTTP/1.1-only proxy" requirement ever
appears, the fallback is to decompose `Attach` into a server-streaming "receive commands"
call plus unary "post results" calls — a future protocol variant behind the same seam,
explicitly out of scope here.

## 6. The relay (single-replica, presence-only)

A new in-cluster `Deployment`, **one replica**. It is a matchmaker-free byte bridge:

1. **Accepts `Attach`.** On `Hello`, validates the bearer token ↔ `sandbox_id` binding
   (§8), then parks the live stream in an in-memory session table `sandbox_id → stream`.
2. **Mirrors presence into the existing Redis sandbox pool.** It writes a lightweight
   record (`sandbox_id`, labels, capabilities, `capacity_max`, `transport:"grpc"`) into
   the same pool store `select-sandbox` already reads, and **removes it when the stream
   closes**. The live `Attach` stream _is_ the registration — no separate heartbeat key,
   no reaper.
3. **Routes `SandboxExec.Exec`.** Looks up the live stream by `sandbox_id`, sends
   `ServerFrame{Exec}`, and forwards the worker's `Chunk`/`End`/`Error` back as the
   `stream ExecEvent` response. `Abort` is routed the same way.

**Why single-replica.** With exactly one replica there is no "which replica holds this
worker's stream" problem, so the relay needs **no presence glue** (no K8s-API watch, no
Redis pub/sub) beyond the pool mirror above. This is the deliberate day-one simplification
(§13).

**Relay restart = in-flight execs fail.** When the single replica restarts, all parked
streams drop; workers reconnect and re-register; any `Exec` in flight fails. This degrades
into existing recovery: the leaf fails and re-leases a healthy sandbox on retry (see the
error table, §10). There is **no mid-exec durability** — stated plainly so nobody expects
it.

### Harness integration: `select-sandbox` barely moves

`select-sandbox` already leases from the pool via Redis. It now:

```
lease from pool (in-cluster pods + mirrored remote records) →
  record.transport == "kubectl" → KubectlTransport(config)      (local, fast — unchanged)
  record.transport == "grpc"    → GrpcRelayTransport(sandbox_id) (routes via the relay)
```

The pool remains the single source of truth for matching; a remote sandbox is just
another pool entry that happens to resolve to a different transport.

## 7. The Go worker (reference implementation)

A thin, single-purpose static binary. It holds **no LLM key and no orchestration** — it
only executes commands and returns bytes (the property that makes "central brain"
trust-correct). It:

1. On start: read `SANDBOX_ID`, `RELAY_ADDR`, `SANDBOX_TOKEN` from env; dial
   `SandboxWorker.Attach` over TLS `:443` with `Authorization: Bearer <token>`.
2. Send `Hello` (id, labels, capabilities, `capacity_max`, `trust`).
3. Loop on `ServerFrame`:
   - `Exec` → run `bash -c <command>` locally (feeding `stdin`), streaming stdout back as
     `Chunk`* then `End{exit_code}`. When `streaming` is false the worker buffers instead of
     delivering incrementally, but the output still leaves as `Chunk` frames at exit —
     `End` has no data field, so "one `End` carrying full stdout" is not expressible in
     `sandbox/v1`, and frames remain `ChunkSize`-capped either way. Enforce `timeout_s`
     locally (SIGKILL on expiry).
   - `Abort` → SIGKILL the in-flight child for that `req_id`.
4. Send `Heartbeat` periodically (liveness + NAT/proxy keepalive).
5. Maintain a bounded `req_id → End` dedup cache; **re-emit the cached result** instead of
   re-running on a redelivered `req_id` (§9).

Persistent-shell semantics (a single long-lived `bash` preserving cwd/env across execs)
are an implementation choice inside the worker; the wire contract only requires ordered,
one-in-flight execs.

## 8. Wire semantics (correlation, dedup, timeout, output cap, abort)

The frame _semantics_ are carried from the superseded design verbatim — only the encoding
(protobuf) and transport (gRPC bidi) changed.

- **Correlation & ordering.** Each `exec()` gets a `req_id` unique across harness
  processes, not merely within one: `[21-bit random salt][32-bit counter]`, kept inside
  `Number.MAX_SAFE_INTEGER` because the generated client maps `uint64` through
  `longToNumber`. Per-process counters are **not** sufficient — `select-sandbox` shares one
  sandbox across replicas at a lease cap of 20, and the relay keys its per-exec sinks by
  `req_id` within a session, so colliding ids detach one caller and interleave both execs'
  output. The relay rejects a duplicate in-flight `req_id` rather than overwrite a live
  sink. One exec in flight per `req_id` ⇒ req order == execution order; `req_id` doubles as
  the idempotency key.
- **Streaming vs one-shot.** Streaming ops (bash/grep) emit `Chunk`* then `End`; the
  harness replays each `Chunk` into `opts.onData`, matching today's `ExecInPod` contract
  byte-for-byte. Non-streaming ops (read/write) differ only in _when_ bytes leave: the
  worker withholds them until exit and then emits `ChunkSize`-capped `Chunk` frames
  followed by `End`. `streaming: false` means "no incremental delivery", not "exactly one
  frame" — `End` carries no output bytes (it does carry the exit status and, since #189, a
  `truncated` flag; output only ever travels in `Chunk`).
- **At-least-once → dedup.** A reconnect mid-exec can redeliver a command. The worker's
  bounded `req_id → End` cache re-emits the cached terminal result rather than re-running.
  **A cache hit therefore returns the exit code with no output** — a redelivered streaming
  `cat file` yields exit 0 and empty stdout, because `End` has nowhere to put the bytes and
  the `Chunk`s were consumed by the original delivery. This is a known asymmetry with
  `KubectlTransport`, which keeps no cache and so re-runs and returns output. Callers must
  not treat a dedup hit as a content read. _Honest limitation:_ if the worker died mid-write,
  exactly-once is impossible — the contract is at-least-once + dedup-by-`req_id`, and partial
  filesystem effects on crash are possible (same risk class as a leaf re-run today).
- **Dual-ended timeout.** The worker kills its local child at `timeout_s`; the harness has
  its own deadline and synthesizes a timeout `error` if no `End` arrives — it never hangs
  on a silent or malicious worker.

  A caller that names no `timeout` gets `DEFAULT_EXEC_TIMEOUT_S` (`transport.ts`, 30
  minutes), applied by **all three** implementations and sent as this request's `timeout_s`,
  so both ends hold the same budget independently. An explicit `timeout: 0` means unbounded,
  on both ends, everywhere. The ceiling is deliberately generous: it exists so an exec
  cannot leak a sandbox slot forever, not to bound how long legitimate work may take — a
  cold `npm ci`, a full test suite or a container build routinely outruns a short budget.

  This was an accepted divergence until #182: the two kubectl transports armed no timer at
  all while `GrpcRelayTransport` applied 120 s, so _the same_ model-issued `bash` with no
  timeout ran unbounded on the pod path and died after two minutes on the remote path. Pi's
  bash tool declares `timeout` optional and documents "no default timeout", so the
  unspecified case is the ordinary one — which made the two kubectl paths the ones matching
  Pi, and the relay the outlier. Both defaults are now pinned for every implementation by
  the conformance battery, which previously could not see either: its timeout case only ever
  passed an explicit `timeout`. The wire value is pinned separately
  (`grpc-relay-transport.test.ts`), since a transport-blind battery cannot distinguish a
  ceiling both ends enforce from one only the harness does.

- **Poisoned-output defense.** **All three** `SandboxTransport` implementations enforce a
  total-returned-output cap per exec, so Pi cannot tell which backend served a flood. Each
  truncates, appends `[output truncated]`, sets `truncated: true`, and returns a null exit
  code; `truncated === true ⇒ exitCode === null` is an invariant the shared conformance
  battery asserts for every implementation. `truncated` exists because a null exit code
  alone is ambiguous — it also means "signalled, no status" — and callers must be able to
  tell those apart. This is the concrete mitigation for the driver-#1 threat of a malicious
  sandbox flooding the model's context. `Chunk` size is separately capped so a single frame
  stays small (backpressure).

  **The stop mechanism differs by transport, and each declares which one it uses:**

  | Transport             | Mechanism                                                       | What it guarantees                             |
  | --------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
  | `GrpcRelayTransport`  | `remote-abort` — `Abort` for the exec's `req_id`                | the worker kills the process group             |
  | `KubectlTransport`    | `local-kill` — SIGKILL its `kubectl exec` client                | the in-pod process stops on EPIPE, if at all   |
  | `persistentExecInPod` | `producer-side-cap` — pod-side `head -c` in the framed pipeline | raw output cannot exceed the cap at the source |

  The battery asserts the _declared_ mechanism rather than accepting any truthy "stopped"
  signal, so a transport cannot claim one and perform another, and a deleted stop fails
  loudly. Neither kubectl mechanism defends against a producer that traps or ignores
  SIGPIPE and keeps burning CPU after we stop reading; that residual threat belongs to
  VM-level isolation (#57), not to the cap.

  **The worker has a cap of its own, and declares it.** On the non-streaming path the Go
  worker buffers output to `BufferCap` and drops the rest, which the harness **cannot**
  infer: `BufferCap` and `DEFAULT_OUTPUT_CAP` are the same 8 MiB and the harness trips on
  `bytes > cap`, strictly greater, so a worker delivering exactly the cap reads as complete.
  Until #189 that resolved as `{truncated: false, exitCode: <real code>}` over cut output —
  the last path where this contract was violated rather than merely qualified.

  `End` therefore carries **`truncated`**, set by any worker that dropped **stdout**.
  `exit_code` stays the command's **real** status: a worker reports what the command did, and
  the harness applies `truncated ⇒ exitCode === null` when it resolves the exec, so the
  invariant above holds unchanged for callers. A worker that never drops stdout never sets the
  field, and proto3's `false` default is the correct reading for it. Reachability is the reason
  this needed a wire field at all rather than a client-side rule: `streaming` is relay-supplied
  and `false` is its proto3 default, so any third-party relay or client reaches the buffered
  path with no privilege, and `sandbox/v1` is a language-neutral contract for workers this repo
  does not own.

  **`truncated` is about stdout, and only stdout.** A worker may cap stderr separately — the Go
  one does, at the same `BufferCap` — but the seam returns stdout and applies its cap to stdout
  alone, so a flag set for a cut stderr would null a valid `exit_code` and glue the marker onto
  output that was never cut. That is the mirror of the defect above: under-reporting traded for
  over-reporting. There is deliberately **no** wire signal for a truncated stderr; giving the
  seam a second truncation concept for bytes it does not return would buy nothing, and the Go
  worker logs the event instead.

- **Message-size ceiling, and why it is derived rather than chosen.** gRPC defaults every
  receive limit to 4 MiB on both implementations (grpc-js
  `DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH`, grpc-go `defaultClient/ServerMaxReceiveMessageSize`);
  send limits default to unlimited. 4 MiB is **smaller than this contract's own write path
  needs.** A write travels as base64 in `Exec.stdin`, inflating the file by 4/3, so the
  largest _readable_ file — `DEFAULT_OUTPUT_CAP`, 8 MiB — becomes a ~10.7 MiB `Exec`. Left at
  the default, every file between ~3 MiB and 8 MiB was **readable but not writable**, and Pi's
  Edit composes read with write, so editing one succeeded at reading and then failed.
  `KubectlTransport` pipes base64 through `kubectl exec` stdin with no such ceiling, making
  this one more divergence decided by which backend was leased.

  The ceiling is therefore **16 MiB**, clearing
  `base64EncodedLength(DEFAULT_OUTPUT_CAP) + EXEC_FRAMING_HEADROOM` = 11,184,812 + 65,536, so
  write capacity ≥ read capacity by construction. It is `MAX_EXEC_MESSAGE_BYTES`
  (`transport.ts`) and `session.MaxRecvMsgBytes` (`dial.go`), pinned equal by
  `message-size-coupling.test.ts` — which also asserts the derivation, so raising the output
  cap alone cannot silently restore the asymmetry. The floor uses the **exact** encoded
  length `4·⌈n/3⌉`, not the ×4/3 ratio: the ratio gives 11,184,810.67, which sits _below_ the
  real payload and would admit a ceiling too small to carry an 8 MiB file.

  **Memory budget.** Raising a receive limit raises worst-case ingress buffering with it, 4×
  here, so it is stated as a formula the way `BufferCap` states its own:
  `concurrently decoding ExecRequests × MAX_EXEC_MESSAGE_BYTES`. It is a **transient, not a
  residency** — the relay forwards `exec` onto the Attach stream and keeps no copy — so the
  peak is however many oversized requests are mid-decode, not however many execs are in
  flight. Nothing in the contract bounds that count (the relay is single-replica and serves
  every harness replica), so this is a ceiling to size the relay against rather than a proof.
  For scale, one such request costs a quarter of the worker's own 64 MiB
  (`2 × MaxConcurrent × BufferCap`) budget, and only a write near the read cap reaches it.

  **Both ends must move together, and the worker's must not be lower.** The relay's ingress
  limit rejects an oversized `ExecRequest` with `RESOURCE_EXHAUSTED`, and that failure is
  contained to one exec. A relay that accepts more than the worker forwards a payload the
  worker then refuses **on the Attach stream**, whose death takes every concurrent and queued
  exec with it and forces a re-dial — strictly worse than both sitting at the default. That
  ordering is why the limits are pinned as an equality rather than as a floor.

- **Abort/end races.** A late `End` for an aborted `req_id` is dropped; an `Abort` for an
  already-ended `req_id` is a no-op.

## 9. Security & reachability

**Mode A — public relay on `:443` (the only mode day-one).** The worker dials
`https://relay.<domain>` with TLS and `Authorization: Bearer <per-sandbox token>`. The
relay validates the token ↔ `sandbox_id` binding on `Attach` before parking the stream.
The worker-facing `Attach` endpoint is the **single public attack surface**; the
harness-facing `SandboxExec` service is **in-cluster only**, guarded by NetworkPolicy.

| Property                  | Value                                            |
| ------------------------- | ------------------------------------------------ |
| Inbound rules on sandbox  | none (outbound only)                             |
| Egress required           | `:443` only                                      |
| Encryption                | TLS 1.3                                          |
| Worker identity (day-one) | per-sandbox bearer token, scoped to `sandbox_id` |
| Public attack surface     | relay `Attach` on `:443`                         |

**Upgrade path for untrusted BYO.** SPIFFE/SPIRE **mTLS** with per-connection identity
slots into the _same_ `Attach` endpoint — same protocol, stronger credential on the TLS
handshake, no wire change. Deferred (§13); the bearer token is the seam it replaces.

**Reachability is pluggable beneath the RPC.** A private-mesh mode (self-hosted
**Headscale** / plain **WireGuard**) for fleets that refuse any public relay endpoint can
be added later without a protocol change. No paid external dependency is introduced;
Tailscale is explicitly out of scope.

## 10. Error handling & lifecycle

| Failure                                | Detection                                         | Behavior                                                                                                                               |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Worker disconnects (crash / network)   | `Attach` stream closes                            | Presence record removed from pool; worker reconnects and re-registers. In-flight `Exec` fails; leaf retry re-leases a healthy sandbox. |
| Command redelivered after reconnect    | duplicate `req_id` at worker                      | Dedup cache re-emits cached `End`; else re-run (at-least-once). Partial-write risk documented (§8).                                    |
| Relay restart                          | all parked streams drop                           | Workers reconnect; in-flight execs fail → leaf retry. No mid-exec durability.                                                          |
| Worker never connects / gone           | no live stream for `sandbox_id`; harness deadline | Pool entry absent or evicted; `Exec` rejects; leaf retry re-leases elsewhere.                                                          |
| In-flight exec exceeds timeout         | dual deadline (§8)                                | Worker SIGKILLs local child; harness synthesizes timeout — never hangs on a silent worker.                                             |
| Output cap exceeded (poisoned/runaway) | harness byte counter on `ExecEvent`               | Harness `Abort`s, truncates, surfaces `[output truncated]` to Pi.                                                                      |
| Abort races with `End`                 | `req_id` correlation                              | Late `End` for an aborted `req_id` dropped; `Abort` for an ended `req_id` is a no-op.                                                  |
| Bad / missing token                    | relay validates on `Attach`                       | Stream rejected before it is parked; no pool entry created.                                                                            |

**Lifecycle.** The `GrpcRelayTransport` is created at lease time; `close()` on leaf
completion stops reading the `ExecEvent` stream. The worker's lifetime is independent — it
outlives individual leases and serves whatever the pool assigns, matching the existing
shared-pool model.

## 11. Testing

| Layer       | What                                                                                               | How                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pure unit   | Frame reassembly, dedup cache, output-cap counter, timeout math, transport selection               | Plain vitest / Go test, no I/O.                                                                                                         |
| Contract    | `GrpcRelayTransport` + Go worker against a real relay, worker pointed at a local bash              | Round-trip every op (read/write/bash/grep), abort mid-stream, timeout, reconnect→dedup, output-cap. Core suite.                         |
| Conformance | The _same_ battery run against **both** `KubectlTransport` and `GrpcRelayTransport`                | One shared spec proving identical `SandboxTransport` contract — this is what makes them safely swappable (driver #2).                   |
| Live gate   | Real Go worker pod dialing the in-cluster relay over `:443`; one leaf end-to-end on Kind, then OCP | Follows the existing leaf-smoke pattern; manifest-shape vitest parses the relay + worker Deployment YAML directly (no kustomize in CI). |

## 12. Why this supersedes the Redis-Streams design

The previous revision of this PR inverted connectivity correctly but tied down two things
that limited reach and portability:

1. **Language lock-in.** The contract was a TypeScript `SandboxTransport` interface with
   JSON+base64 frames; a worker had to be TS (or hand-reimplement the frames). Driver #2
   (heterogeneity / BYO in any language) could not be met.
2. **Redis as the wire.** Redis Streams carried the RPC. Redis on its port is commonly
   blocked by egress firewalls that allow only `:443`, and it forced a Redis availability
   dependency into the exec path.

This design keeps the outbound-dial insight and the frame _semantics_ (`req_id`, dedup,
dual timeout, output cap — §8) **verbatim**, and changes only the encoding and transport:
protobuf over one gRPC bidi stream on `:443`. What survives unchanged from the earlier
work is the `SandboxTransport` interface and the `KubectlTransport` rename (a pure,
behavior-preserving refactor). What is **dropped** is the Redis-specific machinery — the
`RedisChannelTransport` and the TS `@moca/sandbox-worker` are **not built**; Redis returns
to being only the pool/session/leaf-queue substrate, never the exec wire.

## 13. Rollout & scope

**Flagged, off by default, sequenced by trust:**

1. `SandboxTransport` interface + `KubectlTransport` rename. **Pure refactor, zero
   behavior change** — ships first, provably inert (conformance suite green, existing e2e
   green).
2. `sandbox/v1` proto + relay (single replica) + `GrpcRelayTransport` + Go worker +
   presence mirror, behind a flag (`SH_REMOTE_SANDBOX`, off by default). No effect until a
   worker connects.
3. Enable on Kind/OCP for **trusted-unreachable** workers (per-sandbox bearer token +
   `:443` relay endpoint).
4. **Deferred (explicit non-goals for this spec):**
   - Untrusted-BYO isolation → SPIFFE/SPIRE **mTLS** per-connection identity on the same
     `Attach` endpoint.
   - **Multi-replica relay / HA** → adds a presence map (K8s API or Redis pub/sub) to
     route across replicas; unnecessary until relay load or availability demands it.
   - **Private-mesh reachability** (Headscale / WireGuard) for fleets that refuse a public
     endpoint.
   - **Additional-language workers** (e.g. Python for ML/data sandboxes) — the proto
     already permits them; only the Go reference worker ships now.
   - **HTTP/1.1-only proxy traversal** → the Connect / split-stream variant of §5.

**Scope boundaries (YAGNI):** no multi-replica relay, no presence glue beyond the pool
mirror, no Tailscale, no registry/matching service, no `Selector`, no changes to the Pi
loop or leaf queue. This spec is exactly: the interface + the `GrpcRelayTransport` + the
single-replica relay + the Go worker + the presence mirror.

## 14. References

- Superseded PR revision — `2026-07-07-sandbox-transport-remote-exec-design.md` (Redis
  Streams; removed in this update).
- Shared sandbox pool — `2026-07-02-p2-shared-sandbox-pool-design.md`
- Identity spine (SPIFFE/SPIRE + AuthBridge) — `2026-06-26-identity-spine-design.md`
- Protobuf / gRPC — https://protobuf.dev , https://grpc.io
- SPIFFE / SPIRE — https://spiffe.io

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
