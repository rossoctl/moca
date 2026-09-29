# ST4 — Go reference worker: design

**Issue:** [#87](https://github.com/rossoctl/moca/issues/87) ·
**Epic:** #89 · **Parent spec:** [`2026-07-08-sandbox-transport-grpc-design.md`](2026-07-08-sandbox-transport-grpc-design.md) §7, §8 ·
**Date:** 2026-08-26

## 1. Problem

`remote-worker/` today is the HELLO WORLD proof-of-connectivity stub. It dials
`SandboxWorker.Attach`, sends `Hello`, heartbeats, and keeps a `req_id → End` map — but it
**runs no commands**. For every `Exec` it fabricates the literal bytes `HELLO WORLD` and
returns `End{exit_code: 0}` (`remote-worker/main.go:146-153`). `Abort` is a stub with
nothing to kill (`main.go:128`); `timeout_s` is ignored.

That blocks the #88 live gate: no leaf can complete through the remote path until the
worker actually executes commands.

This design turns the stub into the §7 reference worker — a thin static binary holding no
LLM key and no orchestration, which only executes commands and returns bytes — and stands
up the Go test infrastructure the acceptance battery needs.

## 2. Scope

**In:** real `bash -c` execution with stdout/stderr split, per-frame chunk cap, local
`timeout_s` enforcement, `Abort` killing the process group, bounded dedup cache,
honest `Hello`, in-process reconnect, and the Go unit + contract test tiers.

**Out:** the relay and `GrpcRelayTransport` (ST3, merged); mTLS/SPIFFE (§9 — bearer token
only day-one); persistent-shell semantics; the ST5 live gate (#88); any change to
`sandbox/v1`; anything touching harness leasing.

## 3. Findings that shaped this design

Three discrepancies surfaced while reading the current code against §7/§8. Each is
recorded here and reported on #87 rather than silently absorbed.

### 3.1 `req_id` is not unique per worker

`select-sandbox.ts:60` deliberately shares sandboxes — "pick least-loaded under the soft
cap" (P2/P3). Each leaf builds its own `GrpcRelayTransport` for the same `sandbox_id`, and
`grpc-relay-transport.ts:22` seeds `reqCounter = 0` at **module scope**, i.e. per harness
process. Knative scales the harness to multiple replicas, and the relay multiplexes all of
them onto the one Attach stream (`relay.ts:119`).

So two replicas both send `req_id: 1, 2, 3…` to the same worker. A cache keyed on `req_id`
alone would hand replica B's `cat /a` the cached terminal frame from replica A's unrelated
command — a **silent wrong result**, the worst failure class available.

Meanwhile the hazard dedup was written for does not exist yet: the relay never redelivers
(it fails in-flight execs on stream close, `relay.ts:89-93`) and the harness never retries a
`req_id`.

**Resolution:** keep the `req_id` key but guard it with a fingerprint of
`command` + `stdin` (§6.3). A genuine redelivery is byte-identical and still re-emits the
cached frame, satisfying the acceptance; a cross-replica collision has a different
fingerprint and is handled by whether the original is still running. If the original has
already completed, the collider runs fresh and logs a warning. If the original is still
in flight, running the collider would mean two concurrent execs under one id, so it is
refused instead — an `ExecError`, also logged — rather than run. The real fix — globally
unique `req_id` — is proposed upstream on ST1/ST3; this guard is defense-in-depth, not a
substitute.

> **Status 2026-08-28 — the upstream fix landed.** `grpc-relay-transport.ts` now draws
> `req_id` from a per-process salted source (21-bit `node:crypto` salt in the high bits,
> 32-bit counter in the low bits — `req-id.ts`), so the finding above no longer describes
> current behaviour: two replicas do **not** both send `1, 2, 3…`. Collision is now
> probabilistic rather than certain — two replicas collide only on drawing the same salt,
> ≈4.8e-6 across five replicas. The fingerprint guard is retained unchanged, still as
> defense-in-depth, for exactly that residual case. The finding is left as written because
> it is the record of what shaped this design.

### 3.2 §7's non-streaming shape is not expressible in `sandbox/v1`

§7 and §8 say non-streaming ops return "a single `End` carrying full stdout", but
`End { req_id, exit_code }` has no data field. `GrpcRelayTransport` also always sends
`streaming: true`, so the flag is currently dead on the wire.

**Resolution:** honor the flag's observable intent — no incremental delivery — without a
proto change: buffer output and emit exactly one `Chunk` per stream at exit, then the
terminal frame. Adding `bytes stdout` to `End` was rejected: it changes a published
contract other tracks build against, for a field the harness never reads, and creates two
ways to return the same bytes. Reported on #87 so ST1's author can correct the prose.

### 3.3 Neither runtime image has a shell

`remote-worker/Dockerfile` builds on `gcr.io/distroless/static-debian12:nonroot` — no
`bash`, no coreutils. `Dockerfile.runtime` uses `ubi9/ubi-micro`. With real execution,
**every exec would fail with ENOENT** in these images.

This does not contradict the "static binary, no runtime deps" requirement: the binary
itself stays CGO-free with no dynamic dependencies. `bash` is a dependency of the
_commands_, not of the worker — and in production the binary drops into a sandbox image
that already has a shell. It is the two **standalone demo images** built here that need a
shell-bearing base.

**Resolution:** switch the demo images to a base providing `bash` + coreutils (`base64`,
`file`) — `ubi9/ubi-minimal` is the candidate. Whether `ubi-micro` already ships `bash`
must be verified empirically before choosing; the plan carries that as an explicit step.

## 4. Decisions

| #   | Decision                                                                                         | Rationale                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Per-exec `bash -c` child; **no** persistent shell                                                | Every harness command is self-contained (`cd 'cwd' && …`, `env K=v bash -c …`), so no state must persist. Decisive: `base64 -d > f` only terminates on stdin EOF, which a shared shell cannot give per-exec.                                                                                                            |
| D2  | Timeout → `ExecError{"timeout:<n>"}`                                                             | All three existing transports reject with exactly this string (`exec.ts:79`, `persistent-exec.ts:129`, and `GrpcRelayTransport`'s own deadline). The worker's timer normally fires first, so its choice is what the caller sees; `End{-1}` would make a timeout resolve as a success with partial output.               |
| D3  | `streaming: false` → buffer, one `Chunk` + terminal                                              | §3.2.                                                                                                                                                                                                                                                                                                                   |
| D4  | Dedup keyed `req_id` + fingerprint guard                                                         | §3.1.                                                                                                                                                                                                                                                                                                                   |
| D5  | Bounded concurrency, `capacity_max = N` (default 4)                                              | Sandboxes are shared, so concurrent execs are real; strict serialization head-of-line blocks one leaf behind another's slow `bash`. §7's "one in flight" describes the ordering guarantee, not a worker cap.                                                                                                            |
| D6  | Contract battery against an in-process **Go** fake relay; real TS relay behind `SH_LIVE_RELAY=1` | The battery's subjects are all worker-side (SIGKILL, process groups, dedup); the relay is a pure bridge and contributes nothing to them. Decisively, dedup can _only_ be tested against a relay that misbehaves on purpose — the real one has no redelivery path. Keeps the existing CI Go job free of node/pnpm/redis. |
| D7  | Delete the HELLO WORLD path; rewrite its docs                                                    | Once bash runs, a mode that fabricates output is a liability in a component whose security story is "only executes commands and returns bytes". The demo becomes strictly better: the FLAGGED verdict comes from real file content.                                                                                     |
| D8  | Reconnect in-process, cache preserved                                                            | Today the worker returns on `recv` error and exits; a pod restart wipes the cache, making "reconnect → dedup" unreachable by construction.                                                                                                                                                                              |

## 5. Architecture

```
remote-worker/
  cmd/worker/main.go          # env → config, dial, signals, reconnect loop, wiring
  internal/exec/runner.go     # bash -c child: pipes, chunk cap, timeout, kill process group
  internal/session/loop.go    # Hello, heartbeat, dispatch pool, abort routing
  internal/session/cache.go   # bounded LRU: req_id → {fingerprint, terminal frame}
  internal/relaytest/relay.go # test-only in-process relay: parks Attach, drives Exec/Abort
```

Two interfaces carry the design.

```go
// internal/exec — what it means to run one command.
type Spec struct {
    ReqID     uint64
    Command   string
    Stdin     []byte
    TimeoutS  uint32
    Streaming bool
}

// Sink receives output as produced; the session turns calls into Chunk frames.
type Sink interface {
    Chunk(stream pb.Stream, data []byte) error
}

type Runner interface {
    // Returns the child's exit code, or ErrTimeout / a spawn-or-pipe error.
    // ctx cancellation means Abort: SIGKILL the process group.
    Run(ctx context.Context, s Spec, sink Sink) (exitCode int32, err error)
}
```

```go
// internal/session — what a connection can do. Satisfied directly by the generated
// SandboxWorker_AttachClient, so production needs no adapter.
type Stream interface {
    Send(*pb.WorkerFrame) error
    Recv() (*pb.ServerFrame, error)
}

func New(cfg Config, r exec.Runner) *Session
func (s *Session) Serve(ctx context.Context, st Stream) error  // one connection's lifetime
```

**`Serve` owns one connection; `Session` owns state that outlives connections.** The dedup
cache lives on `Session`, so the reconnect loop calls `Serve` again with a fresh stream and
the cache survives (D8). `Serve` wraps its stream in a mutex-guarded sender before sharing
it with the heartbeat and per-exec goroutines, since gRPC streams are not safe for
concurrent `Send`.

### Terminal-frame mapping

| Outcome               | Frame                                      |
| --------------------- | ------------------------------------------ |
| child exited normally | `End{req_id, exit_code: N}`                |
| killed by `Abort`     | `End{req_id, exit_code: -1}` (signal/none) |
| `timeout_s` expired   | `ExecError{req_id, "timeout:<n>"}`         |
| spawn / pipe failure  | `ExecError{req_id, message}`               |
| queue overflow        | `ExecError{req_id, "busy: queue full"}`    |

The cache stores whichever terminal frame was produced, not strictly an `End` — a superset
of the acceptance wording, so a redelivered `req_id` whose first run timed out re-emits the
timeout instead of re-running.

## 6. Component behavior

### 6.1 `internal/exec` — the runner

```go
cmd := exec.CommandContext(ctx, "bash", "-c", spec.Command)
cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
cmd.WaitDelay = 2 * time.Second
```

**Process group, not process.** `CommandContext`'s default kill signals only the direct
`bash`, but real commands are pipelines with grandchildren (`cd 'x' && rg --files … | head
-n 200`). `Setpgid` + `Kill(-pid, SIGKILL)` is what makes abort and timeout stop the work
instead of orphaning it. `WaitDelay` bounds the post-kill pipe drain so a wedged
grandchild cannot hang the goroutine.

**stdin is always closed.** `writeFile` sends `base64 -d > 'path'` with the payload on
stdin, and `base64 -d` only terminates at EOF. Symmetrically, a command given no stdin must
still see EOF or anything reading stdin blocks forever. So: write `spec.Stdin` if present,
then close unconditionally.

**Two pipes, 32 KiB reads.** Independent goroutines drain stdout and stderr into 32 KiB
buffers; each read emits one `Chunk` on the matching `Stream` enum. The read size _is_ the
per-frame cap, satisfying §8 backpressure with no extra buffering layer.

A `Sink.Chunk` error means the stream is gone: the runner cancels its context (killing
the process group) and returns that error, and the session emits no terminal frame —
there is nowhere to send it.

_Known property:_ relative ordering **between** stdout and stderr is not preserved, since
they are independent pipes. The harness does not depend on it — it collects stdout and
replays both to `onData` — but interleaving is not a guarantee this worker makes.

**Timeout is distinguishable from abort.** `context.WithTimeout` when `timeout_s > 0`; on
return, `errors.Is(ctx.Err(), context.DeadlineExceeded)` → `ErrTimeout` (D2), while
`context.Canceled` → abort. Same SIGKILL, different frame.

**Non-streaming** buffers both streams and emits one `Chunk` each at exit, capped at 8 MiB
(matching the harness's `DEFAULT_OUTPUT_CAP`) with truncation beyond it.

### 6.2 `internal/session` — the loop

**Dispatch is a fixed pool, not a semaphore.** `Serve` runs N = `capacity_max` goroutines
reading one bounded queue channel. A semaphore with a goroutine per exec does not preserve
arrival order; a pool reading a single channel does.

**The recv loop must never block.** If dispatch blocked on a full queue, an `Abort` frame
queued behind it in the stream could never be read — and that abort is what would free the
queue. Deadlock. So the queue is bounded (64) and overflow replies
`ExecError{"busy: queue full"}` immediately instead of blocking.

**The cache is consulted in the recv loop, before enqueue — but the in-flight map is
checked first.** A redelivery must not consume a queue slot or a pool goroutine, so a
fingerprint hit re-emits the cached terminal frame inline and never reaches the pool. The
in-flight check that precedes it is deliberate, not redundant: it is what stops a
duplicate that arrives in the window between `cache.Put` and the slot's release from being
answered twice — once by the original's own terminal frame, once by the cache, which the
completed-only lookup below cannot see while that window is still open.

**Abort reaches queued execs.** An `inflight` map `req_id → cancel` is populated at
_enqueue_, not at start, so aborting a not-yet-started exec cancels its context and the
pool drops it without spawning `bash`. `Abort` for an unknown `req_id` is a no-op (§8).

**On disconnect, in-flight execs are cancelled.** Their output has nowhere to go and the
relay has already failed them harness-side (`relay.ts:89-93`); keeping the children alive
only orphans work. _Consequence, stated plainly:_ a killed-in-flight exec leaves no cached
terminal frame, so a redelivery re-runs it. Dedup protects **completed** execs only — which
is precisely at-least-once, and honest about it.

**`Hello` tells the truth.** `capacity_max` is the real N; capabilities come from
`exec.LookPath` over a fixed list (`bash`, `rg`, `base64`, `file`, `python3`, `git`) instead
of today's hardcoded `["hello-world"]`.

### 6.3 `internal/session/cache.go` — dedup

Bounded LRU, 256 entries, `req_id → {fingerprint, terminal frame}` where fingerprint is
SHA-256 over `command` + `stdin`.

| Case                                                          | Behavior                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| unknown `req_id`                                              | run it                                                                                              |
| known `req_id`, fingerprint matches                           | re-emit cached terminal frame, do **not** run                                                       |
| known `req_id`, fingerprint differs, original completed       | run it fresh, log a warning (§3.1 collision)                                                        |
| known `req_id`, fingerprint differs, original still in flight | refuse it with `ExecError`, log a warning — running it would mean two concurrent execs under one id |

### 6.4 `cmd/worker` — wiring

| Env var                 | Default          | Feeds                             |
| ----------------------- | ---------------- | --------------------------------- |
| `RELAY_ADDR`            | `localhost:8443` | dial target                       |
| `SANDBOX_ID`            | `sbx-laptop-1`   | `Hello.sandbox_id`                |
| `SANDBOX_TOKEN`         | `dev-token`      | `authorization: Bearer …`         |
| `RELAY_TLS`             | `0`              | TLS vs h2c                        |
| `WORKER_MAX_CONCURRENT` | `4`              | pool size N, `Hello.capacity_max` |
| `SANDBOX_IMAGE`         | `""`             | `Hello.image`                     |
| `SANDBOX_TRUST`         | `untrusted`      | `Hello.trust`                     |

`Hello.arch` comes from `runtime.GOARCH`, `Hello.capabilities` from `exec.LookPath` (§6.2).
`Hello.labels` is left empty: nothing consumes it yet (`relay.ts:74` defers `capacityMax`
and label matching to a later slice), and inventing an env encoding for a map before there
is a consumer is speculative.

Dial, then loop: `Serve` until the stream errors,
then re-dial with exponential backoff 500 ms → 30 s cap with jitter, `Session` preserved.
SIGINT/SIGTERM cancels the root context and exits.

## 7. Testing

Three tiers, each covering what only it can reach.

**Unit — no processes, no gRPC** (`internal/session`, fake `Runner` + `Stream`): LRU evicts
at 256; fingerprint mismatch re-runs; matching fingerprint re-emits without invoking the
Runner; queue overflow → `ExecError`; abort of a queued exec never starts it; abort of an
unknown `req_id` is a no-op; the terminal-frame mapping table; `Hello` contents.

**Runner — real processes, no gRPC** (`internal/exec`): stdout/stderr land on the correct
`Stream` enum; `exit 7` → 7; stdin EOF via a real `base64 -d > f` round-trip; a command
given no stdin still terminates; 40 KiB of output arrives as ≥2 chunks; `timeout_s: 1`
against `sleep 30` returns `ErrTimeout` in ~1 s; **abort kills a grandchild** — the command
spawns a subshell appending to a sentinel file and the assertion is that the file stops
growing (this is the test that fails without `Setpgid`); `streaming: false` yields exactly
one chunk per stream.

**Contract — real runner, real gRPC, `relaytest`** — the acceptance battery:

| Item              | Shape                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read              | `cat f` → stdout bytes, `End{0}`                                                                                                                                                                                                |
| write             | `base64 -d > f` + stdin → content on disk, `End{0}`                                                                                                                                                                             |
| bash              | `echo hi; echo oops >&2; exit 7` → STDOUT chunk + STDERR chunk + `End{7}`                                                                                                                                                       |
| grep              | `rg pat f` (falls back to `grep` when `rg` is absent) → multiple STDOUT chunks                                                                                                                                                  |
| abort mid-stream  | emitter, `Abort` after chunk 1 → `End{-1}`, no further chunks, group gone                                                                                                                                                       |
| timeout           | `sleep 30`, `timeout_s: 1` → `ExecError{"timeout:1"}`                                                                                                                                                                           |
| reconnect → dedup | `req_id 4` runs `echo x >> log` and completes; drop the stream; re-Attach; resend `req_id 4` → cached `End` re-emitted **and `log` still has one line** — the marker is what proves "no re-run" rather than merely "same frame" |

**Gated live** — `SH_LIVE_RELAY=1` runs read/write/bash/grep/abort against the real TS relay
at `RELAY_ADDR`; `t.Skip` otherwise, per the repo's `M3_LIVE_SMOKE` convention.

## 8. CI

The existing `proto` job already has `setup-go`. Add after the stub test:

```yaml
- name: Build and test remote-worker
  run: cd remote-worker && gofmt -l . && go vet ./... && go test ./...
```

No new tooling: `gofmt` and `vet` ship with the toolchain, so there is no golangci-lint
config to maintain. `make test` runs `pnpm -r test` only and would silently skip Go, so it
gains the same `go test` line. `ubuntu-latest` provides `bash` and `base64`; `rg` is
covered by the fallback.

## 9. Deliverables

- `cmd/worker/main.go`, `internal/exec/`, `internal/session/`, `internal/relaytest/` + tests.
- `remote-worker/DESIGN.md` rewritten: real-`grep` demo replacing HELLO WORLD; the
  "Limitations (by design)" section replaced with actual behavior and the honest caveats
  (stdout/stderr interleaving, dedup covers completed execs only, `req_id` collision).
- Demo image bases fixed per §3.3; `build-image.sh`, `deploy-incluster.sh`,
  `run-local.sh`, `worker-deployment.yaml` otherwise unchanged.
- Three findings reported on #87 (§3.1, §3.2, §3.3).

## 10. Risks

| Risk                                                                      | Mitigation                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake relay encodes _my reading_ of the contract, not the relay's behavior | The `SH_LIVE_RELAY=1` tier runs the same battery against the real relay; ST5 (#88) is the true interop gate.                                                           |
| `req_id` collision persists until ST1/ST3 fix it                          | Fingerprint guard converts a silent wrong result into a correct re-run plus a warning (§3.1).                                                                          |
| Worker runs arbitrary commands — that is the job                          | No credentials and no orchestration in the worker (§7); bounded concurrency and queue caps limit resource exhaustion; trust boundary is the sandbox itself, unchanged. |
| `ubi-micro` may lack `bash`, blocking the demo image                      | Verified empirically as an explicit plan step before choosing the base (§3.3).                                                                                         |
