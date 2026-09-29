# remote-worker — SandboxTransport reference worker (Go)

A thin Go static binary that connects to the moca **relay** and runs
the commands it receives in a local `bash -c`, streaming stdout and stderr back as
`Chunk` frames and terminating every exec with `End` or `ExecError`.

It holds **no LLM key and no orchestration** — it only executes commands and returns
bytes, which is the property that makes the "central brain" trust model correct
(spec §7). Design: [`docs/specs/2026-08-26-st4-go-reference-worker-design.md`](../docs/specs/2026-08-26-st4-go-reference-worker-design.md).

## How a worker connects (wire contract per sandbox.proto)

The worker **dials out** to the relay and keeps ONE full-duplex gRPC stream open
(`SandboxWorker.Attach`, `proto/sandbox/v1/sandbox.proto`):

```
 harness ──SandboxExec.Exec──▶ relay ──ServerFrame{Exec}──▶ worker
   ▲                            (parks the worker's Attach stream)   │
   └────────── Chunk(stdout/stderr) … + End(exit_code) ◀────────────┘
```

- **worker → relay** (`WorkerFrame`): `Hello` (sent first), then `Heartbeat`,
  `Chunk`, `End`, `ExecError`.
- **relay → worker** (`ServerFrame`): `Exec` (run one command), `Abort` (cancel).
- **Auth** is fail-closed: the worker sends gRPC metadata
  `authorization: Bearer <SANDBOX_TOKEN>`; it must match the relay's
  `SH_RELAY_TOKEN` (or `SH_RELAY_TOKEN_<SANDBOX_ID>`).
- **Registration = the live stream.** When `Attach` succeeds after a valid
  `Hello`, the relay writes the worker into the Redis presence hash
  (`sh:sandbox:records`) keyed by `sandbox_id`, and removes it on stream close.
- **No matching in the relay.** It only bridges `SandboxExec.Exec/Abort`
  (harness side) ⇄ the parked `Attach` stream (worker side), keyed by
  `sandbox_id`. Leasing/selection stays in the harness pool.

### Wire contract the worker must honor (proto §8)

| Rule                                                                                     | This worker                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Hello` first, with `sandbox_id`                                                         | ✅ before anything else; capabilities probed from PATH       |
| stdout → `Chunk{STREAM_STDOUT}`, stderr → `STREAM_STDERR`                                | ✅ separate pipes, separate frames                           |
| `Chunk` capped so one frame stays small                                                  | ✅ 32 KiB, which is also the pipe read size                  |
| terminate each exec with `End{req_id, exit_code}`                                        | ✅ real child exit code; `-1` when signalled                 |
| failures → `ExecError{req_id, message}`                                                  | ✅ spawn failures, and `timeout:<n>` on expiry               |
| `Abort` → SIGKILL the in-flight child                                                    | ✅ kills the whole process group (`Setpgid`)                 |
| worker-side `timeout_s`                                                                  | ✅ SIGKILL at expiry → `ExecError{"timeout:<n>"}`            |
| dedup / at-least-once: cache `req_id →` terminal frame (`End`, or a timeout `ExecError`) | ✅ bounded LRU (256), guarded by a command+stdin fingerprint |
| `Heartbeat` for liveness                                                                 | ✅ every 15s                                                 |

## What it does on each Exec

1. Checks whether that `req_id` is still **in flight**, before the cache. Same
   command+stdin → the duplicate is coalesced silently, because the original
   already owes exactly one terminal frame. Different command+stdin → it is a
   `req_id` collision rather than a redelivery, so it is refused with an
   `ExecError` instead of being swallowed (see the `req_id` bullet below).
2. Then checks the dedup cache: a redelivered `req_id` with the same command+stdin
   re-emits its cached terminal frame and does **not** re-run (spec §8).
3. Otherwise queues it for the dispatch pool (`WORKER_MAX_CONCURRENT`, default 4).
4. Runs `bash -c <command>` as a new process group, feeding `stdin` and closing it —
   `base64 -d > file` only terminates at EOF.
5. Streams stdout and stderr back as 32 KiB `Chunk` frames tagged with their stream.
   With `streaming: false` it buffers output and emits it at exit in the same
   32 KiB-capped `Chunk` frames — one burst rather than incremental delivery. The
   guarantee is _when_ output is sent, not that it is a single frame: the cap
   still applies, since an 8 MiB frame would exceed gRPC's default receive limit.
6. Terminates with `End{exit_code}`, or `ExecError{"timeout:<n>"}` if `timeout_s`
   expired, or `End{-1}` if aborted.

There is no persistent shell: every command the harness sends is self-contained
(`cd 'cwd' && …`), and a shared shell could not give each exec its own stdin EOF.

## Running locally on this laptop, against ykt1 ← the interesting part

The worker **dials the relay**; the relay never dials the worker. So a laptop
worker does **not** need any inbound route — we just need the laptop to reach the
relay. In-cluster that's the ClusterIP `sandbox-relay.default.svc:8443`; from a
laptop we tunnel to it with `oc port-forward`. The harness→relay→worker execs
then ride _back down_ the worker-initiated stream through the same tunnel.

```
 laptop:  remote-worker ──dial──▶ localhost:8443 ─┐
                                                   │  oc port-forward (h2c tunnel)
 ykt1:                            sandbox-relay:8443 ◀┘   ◀── harness SandboxExec.Exec
```

Prereqs: harness + relay already deployed in ykt1 `default` (they are — see the
project CLAUDE.md "MOCA" section). Then:

```bash
export KUBECONFIG=.kube/config-ykt1

# 1. Relay token (fail-closed). Global token covers all sandbox ids.
oc set env deploy/sandbox-relay SH_RELAY_TOKEN=dev-token -n default

# 2. Enable the remote-sandbox path on the harness (rolls a new revision).
oc set env ksvc/moca \
  SH_REMOTE_SANDBOX=1 SH_RELAY_ADDR=sandbox-relay.default.svc:8443 -n default

# 3. Tunnel the relay to the laptop (leave running).
oc port-forward svc/sandbox-relay 8443:8443 -n default &

# 4. Run the worker on the laptop, dialing the tunnel (plaintext h2c).
cd remote-worker
RELAY_ADDR=localhost:8443 SANDBOX_ID=sbx-laptop-1 SANDBOX_TOKEN=dev-token \
  go run ./cmd/worker
```

Verify:

```bash
# Presence — the live Attach registered the worker:
oc exec deploy/redis -n default -- redis-cli HGETALL sh:sandbox:records
#   → field "sbx-laptop-1" present

# Drive an exec straight through the relay (separate terminal; reuse the port-forward):
grpcurl -plaintext -proto proto/sandbox/v1/sandbox.proto \
  -d '{"sandbox_id":"sbx-laptop-1","exec":{"req_id":1,"command":"echo hi; echo oops >&2; exit 7","timeout_s":10,"streaming":true}}' \
  localhost:8443 sandbox.v1.SandboxExec/Exec
#   → Chunk{stdout:"hi\n"}, Chunk{stderr:"oops\n"}, End{exit_code:7}

# End to end: POST /turn to the harness Route so a leaf leases sbx-laptop-1.
# (NOTE: /turn's LLM step needs LiteLLM egress, currently blocked from ykt1 —
#  the worker path itself is exercised by the grpcurl check above.)
```

`run-local.sh` wraps steps 1–4.

### Running it as an in-cluster pod — the verified full path (2026-07-16)

For the full **harness → leaf → relay → worker** path, run the worker as a pod
(relay→worker stays in-cluster). Automated by the scripts here:

```bash
./build-image.sh          # cross-compile linux/amd64 + OpenShift internal-registry build
./deploy-incluster.sh     # SA + nonroot-v2 SCC + Deployment; verifies Redis presence
# drive a leaf:
curl -sk -H 'Content-Type: application/json' \
  -d '{"sessionId":"leaf-1","item":{"item_id":"i1","file":"/workspace/README.md","pattern":"hello"},"maxTurns":2}' \
  https://moca-default.<domain>/runs
```

The leaf's file tools (`test -r …`, `file --mime-type …`, `cat …`) now run for real
on the worker pod — the worker executes them via `bash -c` and streams back the
actual file content, so the leaf verdict reflects what is really in
`/workspace/README.md` rather than a fabricated string. Confirm the worker side
directly with the `grpcurl` exec above; the worker pod log shows the matching
`exec req_id=…` frames.

> **Required egress rule (upstream gap).** The harness `moca-egress`
> NetworkPolicy is default-deny egress. As shipped it allows DNS, Redis, and
> :443/:6443 — but **not the relay**, so with `SH_REMOTE_SANDBOX=1` every remote
> exec is silently default-denied (harness→relay blocked) and times out. This repo's
> `deploy/knative/harness-egress-policy.yaml` now adds the missing rule
> (`app=sandbox-relay` :8443). If you deployed before that fix, patch it live:
>
> ```bash
> oc patch networkpolicy moca-egress -n default --type=json \
>   -p '[{"op":"add","path":"/spec/egress/-","value":{"ports":[{"port":8443,"protocol":"TCP"}],"to":[{"podSelector":{"matchLabels":{"app":"sandbox-relay"}}}]}}]'
> ```

**Laptop via port-forward** (the earlier section) is a quick transport check
(presence + a `grpcurl` exec) — the same egress rule is still required for a
harness-driven leaf, since the block is on the harness→relay leg regardless of
where the worker runs.

For a worker on _other_ infrastructure (not this cluster), expose the relay via an
OpenShift Route on :443 with TLS + HTTP/2 and point `RELAY_ADDR` at the Route
host; the worker then dials with TLS (`RELAY_TLS=1`) instead of `insecure`. No
code or binary changes are needed — the same worker image and the env vars in
the table below cover both the in-cluster (`RELAY_TLS=0`, ClusterIP address) and
outside-the-cluster (`RELAY_TLS=1`, Route host) cases.

## Environment variables

| Var                     | Default          | Meaning                                                                                                                                                                                                   |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ADDR`            | `localhost:8443` | relay address (tunnel, ClusterIP, or Route host)                                                                                                                                                          |
| `SANDBOX_ID`            | `sbx-laptop-1`   | stable id; one live Attach per id                                                                                                                                                                         |
| `SANDBOX_TOKEN`         | `dev-token`      | Bearer token; must match the relay                                                                                                                                                                        |
| `RELAY_TLS`             | `0`              | `1`/`true` to dial with TLS (for a Route :443); `0`/`false` = plaintext h2c. Anything else is **fatal** — it gates whether the bearer token crosses the wire in cleartext, so the worker refuses to guess |
| `WORKER_MAX_CONCURRENT` | `4`              | dispatch pool size; also advertised as `Hello.capacity_max`                                                                                                                                               |
| `SANDBOX_IMAGE`         | (empty)          | advertised in `Hello`; informational, not enforced by the worker                                                                                                                                          |
| `SANDBOX_TRUST`         | `untrusted`      | advertised in `Hello`; informational, not enforced by the worker                                                                                                                                          |

## Files

- `cmd/worker/main.go` — env, dial, signals, reconnect loop.
- `internal/exec/` — the `bash -c` child: pipes, chunk cap, timeout, process-group kill.
- `internal/session/` — frame loop, dispatch pool, dedup cache.
- `internal/relaytest/` — test-only in-process relay (not built into the binary).
- `go.mod` — module; uses the in-repo stubs via `replace … => ../gen/go`.
- `run-local.sh` — laptop setup (relay token, enable path, port-forward, run).
- `build-image.sh` — cross-compile linux/amd64 + package via OpenShift internal-registry
  binary build (or `--push <ref>` for an external registry).
- `deploy-incluster.sh` — create the shared relay-token Secret, SA + `nonroot-v2` SCC, apply
  the Deployment, verify presence.
- `worker-deployment.yaml` — in-cluster Deployment template (filled by `deploy-incluster.sh`;
  the token is not substituted in, it is read from the `sh-relay-token` Secret).
- `Dockerfile` — multi-stage build from repo root (builds Go in-cluster).
- `Dockerfile.runtime` — packages the prebuilt binary (used by `build-image.sh`).

## Known properties and limits

- **stdout/stderr interleaving is not preserved.** They are independent pipes, so
  their relative order across frames is not guaranteed. The harness does not depend
  on it — it collects stdout and replays both to `onData`.
- **Dedup covers completed execs only.** A real exit status and a timeout are
  cached; an abort, a signalled exit (`End{-1}` from an OOM-kill or an external
  `SIGKILL`), and a dead-stream failure are not. An exec killed mid-flight by a
  disconnect leaves no cached frame, so a redelivery re-runs it — at-least-once, as
  specified. Caching a signal would poison the `req_id`: every later redelivery
  would answer `-1` without ever re-running.
- **A cache hit re-emits ONLY the terminal frame — no `Chunk`s.** A redelivered
  `req_id` gets the cached `End`/`ExecError` and nothing else, so a redelivered
  `cat file` answers `End{0}` with EMPTY output. This is the right trade for the
  harness — re-running a mutating command is worse than an empty read, and its
  redelivery paths are retries of writes — but a consumer that needs output
  alongside the terminal frame must not redeliver a completed `req_id`.
- **`req_id` is only probabilistically unique across harness replicas.** The harness
  salts its ids per process (21-bit crypto salt in the high bits, 32-bit counter in the
  low bits — spec §3.1), so two replicas sharing a sandbox no longer collide by
  construction; they collide only on drawing the same salt, ≈4.8e-6 across five
  replicas. The worker keeps its fingerprint guard for exactly that residual case: the
  cache also compares a command+stdin fingerprint and re-runs on a mismatch rather than
  returning another exec's output. While the original is still in flight the cache
  cannot see it at all, so the same fingerprint is carried on the in-flight slot and a
  mismatch there is refused with an `ExecError` — coalescing it would drop another
  replica's command silently, with no frame ever emitted.
- **Bearer token only.** mTLS/SPIFFE slots into the same `Attach` endpoint later
  (spec §9); there is no client certificate today.
- **The demo image is not a sandbox image.** It carries `bash`, `base64`, and `file`
  so the standalone demo runs; production drops the binary into a real sandbox image.
