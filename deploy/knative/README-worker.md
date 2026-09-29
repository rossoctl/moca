# Connecting a worker

How to connect your own **SandboxTransport worker** to a harness running on
OpenShift. This picks up where [`README-ocp.md`](README-ocp.md) leaves off:
`setup-ocp.sh` already deployed the harness, Redis, and the **relay** — this
guide covers the three steps that make a worker reachable, plus how to verify it.

> **The pool-selection trap:** setting `SH_REMOTE_SANDBOX=1` does **not**, by
> itself, route execs to your worker. The worker joins the shared sandbox pool
> as a peer — `select-sandbox` leases whichever candidate (pod or worker) is
> least loaded, and an idle in-cluster sandbox pod wins by default. A leaf can
> succeed against a pod while looking exactly like a successful remote run. To
> actually target your worker, narrow `KAGENTI_SANDBOX_POOL_SELECTOR` so it
> matches no local pods, or run against a pool with none. See
> [`relay-leaf-smoke.sh`](relay-leaf-smoke.sh) for a live gate that proves the
> distinction using an OS-fingerprint discriminator (sandbox pods run Alpine,
> the reference worker image runs RHEL) — a green leaf alone proves nothing
> about which backend served it.

## Background

A worker executes commands inside a sandbox and returns bytes. It holds **no LLM
key and no orchestration** — the harness keeps the brain (the agent loop + model)
central and delegates only command execution. This is what lets an untrusted,
bring-your-own sandbox run anywhere, in any language.

The worker dials the relay's `SandboxWorker.Attach` and keeps one full-duplex
gRPC stream open: it sends a `Hello`, then loops on server frames (`Exec`,
`Abort`), returning output chunks and a terminal `End`. The wire contract is
`proto/sandbox/v1/sandbox.proto` (message/service definitions in §4, semantics in
§8). The reference worker is a single Go static binary, but any language that
speaks the proto works.

```
 harness ──SandboxExec.Exec──▶ relay ──ServerFrame{exec}──▶ worker ──▶ bash
   ▲                             (park)                        │
   └─────────── stdout/stderr chunks + End ◀───────────────────┘
```

The relay is single-replica and presence-only: it bridges the worker's `Attach`
to the harness's `SandboxExec.Exec`/`Abort`, mirrors connected workers into the
Redis sandbox pool (`sh:sandbox:records`), and removes them on stream close. It
does no matching — leasing stays in the harness pool / `select-sandbox`.

## Prerequisites

- A harness deployed on OpenShift via [`setup-ocp.sh`](setup-ocp.sh) (see
  [`README-ocp.md`](README-ocp.md)). That already runs the relay as a ClusterIP
  Service `sandbox-relay.<ns>.svc:8443` (plaintext h2c) and a Redis the relay
  writes presence into.
- Your worker image, published where the cluster can pull it.

## Step 1 — Set the relay token (required)

The relay auth is **fail-closed**. It ships with no token set, so until you
provide one it rejects _every_ Attach before parking the stream. Set a token on
the relay Deployment:

```bash
oc set env deploy/sandbox-relay SH_RELAY_TOKEN=dev-token -n default
```

> **Not on an OCP overlay deployment.** `setup-ocp.sh` deploys the relay through
> `overlays/ocp`, which reads `SH_RELAY_TOKEN` from the `sh-relay-token` Secret so the
> token never sits in the Deployment spec (#173). `oc set env` replaces the whole env
> entry rather than merging into it, so the command above would swap that `secretKeyRef`
> back for a literal — putting a live token into the spec. Rotate the Secret instead, and
> restart the relay so it re-reads it (env from a Secret is resolved only at pod start):
>
> ```bash
> oc create secret generic sh-relay-token -n default \
>   --from-literal=SH_RELAY_TOKEN=<token> --dry-run=client -o yaml | oc apply -f -
> oc rollout restart deploy/sandbox-relay -n default
> ```

Use a per-sandbox token instead if you want each worker to authenticate
separately — `SH_RELAY_TOKEN_<SANDBOX_ID>` takes precedence over the global
`SH_RELAY_TOKEN` for that sandbox id:

```bash
oc set env deploy/sandbox-relay SH_RELAY_TOKEN_sbx-dev-1=dev-token -n default
```

## Step 2 — Enable the remote-sandbox path on the harness

The relay is inert until the harness opts in. Point the harness at the relay and
turn the path on:

```bash
oc set env ksvc/moca \
  SH_REMOTE_SANDBOX=1 \
  SH_RELAY_ADDR=sandbox-relay.default.svc:8443 \
  -n default
```

This rolls a new Knative revision. With `SH_REMOTE_SANDBOX=1` and a worker
present in the pool, `select-sandbox` can lease the remote sandbox and drive a
leaf through `GrpcRelayTransport`.

## Step 3 — Deploy your worker

Copy [`worker-example.yaml`](worker-example.yaml), drop in your image, and apply
it. The worker reads three environment variables:

| Variable        | Value                            | Notes                                                           |
| --------------- | -------------------------------- | --------------------------------------------------------------- |
| `SANDBOX_ID`    | e.g. `sbx-dev-1`                 | Stable id; the pool record and presence key are keyed on it.    |
| `RELAY_ADDR`    | `sandbox-relay.default.svc:8443` | In-cluster relay Service. Plaintext h2c — no TLS in-cluster.    |
| `SANDBOX_TOKEN` | `dev-token`                      | Sent as `authorization: Bearer <token>`. **Must** match Step 1. |

```bash
# edit worker-example.yaml: set image, SANDBOX_ID, SANDBOX_TOKEN
oc apply -f deploy/knative/worker-example.yaml -n default
```

Run one worker per `SANDBOX_ID` — the relay rejects a second live Attach for the
same id. To run several, give each its own `SANDBOX_ID` (and matching
`SH_RELAY_TOKEN_<id>` on the relay).

## Step 4 — Verify

**Presence** — the live Attach stream _is_ the registration. Once the worker
connects, its id appears in the Redis presence hash and disappears when the
stream closes:

```bash
oc exec deploy/redis -n default -- redis-cli HGETALL sh:sandbox:records
# → field "sbx-dev-1" = {"transport":"grpc",...}
```

**Drive an exec** without the full harness, straight through the relay — port-
forward the relay Service and use `grpcurl` (the relay does not register gRPC
reflection, so pass the proto):

```bash
oc port-forward svc/sandbox-relay 8443:8443 -n default &
grpcurl -plaintext -proto proto/sandbox/v1/sandbox.proto \
  -d '{"sandbox_id":"sbx-dev-1","exec":{"req_id":1,"command":"echo hi","timeout_s":10,"streaming":true}}' \
  localhost:8443 sandbox.v1.SandboxExec/Exec
```

**End to end** — with the path enabled (Step 2), send the harness a `/turn` whose
work lands a leaf on the sandbox; the leaf executes through your worker. See the
smoke test in [`README-ocp.md`](README-ocp.md#smoke-test).

## Live transport cases (no cluster required)

[`packages/k8s-sandbox/test/live-relay.test.ts`](../../packages/k8s-sandbox/test/live-relay.test.ts)
drives the real `GrpcRelayTransport` against a real relay and a real Go worker
on your laptop — no cluster, no kind. This is the only independent check on the
hermetic conformance battery (`grpc-relay-transport.test.ts`,
`transport-conformance.test.ts`): those tests script fakes authored by the same
person who wrote the transport, so their agreement is not independent evidence.
It also covers three cases the OS-fingerprint leaf smoke above cannot reach,
because a leaf's request shape is a grep verdict — it cannot ask for a sleep, a
flood, or a mid-exec disconnect:

- the **dual-ended timeout** actually cuts a real `sleep 30` short at `timeout:2`
  rather than running it to completion;
- a real multi-chunk flood through real 32 KiB `Chunk` frames is truncated at
  `outputCapBytes` and marked, not just a scripted single frame pretending to be
  one;
- an in-flight exec **rejects** — rather than hanging — when the relay's Attach
  teardown pushes `worker disconnected` into every live sink for that sandbox.

Gated on `SH_LIVE_RELAY=1`, following the Go worker's own `SH_LIVE_RELAY`
convention (`remote-worker/internal/session/live_test.go`) and the harness's
`M3_LIVE_SMOKE` convention. With the gate off, the suite skips cleanly — it adds
no cost to `make test`. Start a relay and a worker, then run it:

```bash
# Redis — pick a free port; something else on this machine may already hold 6379.
docker run --rm -d -p 6380:6379 --name sh-live-relay-redis redis:7

# Relay
SH_RELAY_TOKEN=dev-token SH_RELAY_PORT=8443 REDIS_URL=redis://127.0.0.1:6380 \
  pnpm --filter @moca/sandbox-relay start &

# Reference worker, under the default SANDBOX_ID the test expects
cd remote-worker && SANDBOX_ID=sbx-dev-1 RELAY_ADDR=localhost:8443 \
  SANDBOX_TOKEN=dev-token go run ./cmd/worker &
cd ..

# The live cases
SH_LIVE_RELAY=1 pnpm --filter @moca/k8s-sandbox test live-relay

# Teardown
kill %1 %2   # relay, worker (job numbers from your shell)
docker stop sh-live-relay-redis   # started with --rm; stop also removes it
```

`RELAY_ADDR`, `SANDBOX_ID`, and `SANDBOX_TOKEN` are all overridable env vars if
you want to point the first two cases at a relay/worker running elsewhere.

The third case (worker disconnect) does **not** use the worker started above —
it builds the worker binary itself in a `beforeAll` (`go build -o <tmp> ./cmd/worker`)
and spawns/kills its own copy under a distinct `<SANDBOX_ID>-disconnect` id, so
the case is fully automated and safe to re-run rather than needing a manual
`kill -9` on the shared worker mid-test. (`go run` itself isn't killed directly for
this: it forks the compiled binary as its own child, and `SIGKILL` on the `go run`
wrapper doesn't reliably propagate to that child — so the case spawns the
already-built binary directly, where `SIGKILL` is unambiguous.)

## Running the live gate on a real cluster

[`relay-leaf-smoke.sh`](relay-leaf-smoke.sh) automates the verification above: it
deploys a relay + reference worker, drives real leaves, and asserts the work ran on
the worker rather than on an in-cluster sandbox pod. It settles the ambiguity noted
at the top of this page — a green leaf alone does not tell you which backend served
it, because `select-sandbox.ts` leases least-loaded-first and an idle pod can win.

It discriminates by OS fingerprint: sandbox pods run Alpine, the reference worker
image runs RHEL. A leaf grepping `/etc/os-release` for `Alpine` is CLEAR on the
worker and FLAGGED on a pod; for `Red Hat` it is the reverse. Both directions are
asserted, and the discriminator itself is verified before being relied on, so a leaf
that quietly landed on a pod is caught either way.

On **kind** (after `setup-kind.sh`) the defaults are correct:

```bash
RELAY_LIVE_SMOKE=1 bash deploy/knative/relay-leaf-smoke.sh
```

On a **real cluster** the script's kind assumptions do not hold — the harness is
reached through a Route rather than a `kourier` port-forward, and images must come
from a registry the cluster can pull rather than a kind node's image store. Set three
overrides:

| Variable       | Why                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KSVC_URL`     | The harness Route. `lib.sh` then targets it directly, drops the `Host` header, and adds `curl -k` for the router's cert.                                                                                     |
| `RELAY_IMAGE`  | `relay-deployment.yaml` pins `dev.local/moca:local`, which exists only in kind. Without this the apply **replaces a working relay with an unpullable one** and aborts at the rollout.                        |
| `WORKER_IMAGE` | A pre-published worker image; skips the `kind load` path. Build one with [`build-image.sh`](../../remote-worker/build-image.sh), which packages a `linux/amd64` binary into the OpenShift internal registry. |

```bash
export KUBECONFIG=/path/to/kubeconfig
KSVC_URL=https://moca-default.apps.<domain> \
RELAY_IMAGE=<registry>/moca:latest \
WORKER_IMAGE=image-registry.openshift-image-registry.svc:5000/default/remote-worker:latest \
RELAY_LIVE_SMOKE=1 bash deploy/knative/relay-leaf-smoke.sh
```

Expect `Results: 8 passed, 0 failed`. Verified 8/8 on kind (twice consecutively) and
8/8 on OpenShift at `api.rosso1.kubestellar.org`, with the worker image built into
that cluster's internal registry. Also verified on OpenShift 4.20.8 (AWS): all
assertions pass, including both fingerprint directions and the post-teardown presence
check.

Four things to know before running it:

- **A reachable model credential is required.** Every assertion drives a real leaf,
  so the harness must be able to call the model. If the cluster cannot reach the
  endpoint baked into `llm-credentials`, the leaves time out — see
  [`README-ocp.md`](README-ocp.md#choosing-the-model).
- **Teardown removes the relay.** Cleanup runs
  `kubectl delete -f relay-deployment.yaml`, so a relay that `setup-ocp.sh` created is
  deleted with it. Recover by re-running `setup-ocp.sh` — do **not** re-apply
  `relay-deployment.yaml` directly. On OpenShift the relay is a resource of the
  `overlays/ocp` kustomization, whose `images:` transformer rewrites the pin and whose
  render pipeline then substitutes `$HARNESS_IMAGE`; applying the raw manifest puts
  back `image: dev.local/moca:local`, reproducing the exact
  `ImagePullBackOff` this override exists to avoid. Rendering the overlay by hand has
  the same trap in a different form — it emits the `ghcr.io/rossoctl/…` path, which
  currently 403s (see #177) — so it needs the image substituted too:

  ```bash
  oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp \
    | sed "s#ghcr.io/rossoctl/moca:latest#<pullable-image>#g" \
    | oc apply -f -
  ```

- **The harness env is flipped, then restored.** The script snapshots the ksvc env,
  points the pool selector at a label matching no pods so only the worker can be
  leased, then restores the snapshot exactly. Restore is `trap`-driven on `EXIT`, so
  an interrupted run does not leave the harness stranded with a selector matching
  nothing.
- **`NS` must stay `default`.** `lib.sh` honors `NS`, but `relay-deployment.yaml`
  hardcodes `namespace: default` and this script performs no namespace rewrite (unlike
  `setup-ocp.sh`, which seds both `namespace:` and `redis.default.svc` when the target
  namespace differs). With `NS=foo` the relay lands in `default` while the rollout wait
  watches `-n foo`, and the run aborts.

## The wire contract your worker must satisfy

From `proto/sandbox/v1/sandbox.proto` (§8) and what the harness-side
`GrpcRelayTransport` ([`packages/k8s-sandbox/src/grpc-relay-transport.ts`](../../packages/k8s-sandbox/src/grpc-relay-transport.ts))
expects:

- **stdout/stderr split** — stdout → `Chunk{stream: STREAM_STDOUT}`; stderr →
  `Chunk{stream: STREAM_STDERR}`. The harness collects stdout into the returned
  buffer and streams stderr to `onData` (excluded from stdout).
- **terminate** each exec with `End{req_id, exit_code}`. `exit_code < 0` means
  signal/none (mapped to `null`). Failures → `ExecError{req_id, message}`.
- **abort** — on `ServerFrame{abort}`, SIGKILL the child and emit a terminal
  frame for that `req_id`.
- **timeout** — kill the child at `exec.timeout_s` (the harness enforces its own
  deadline too — dual-ended).
- **dedup / at-least-once** — cache `req_id → End`; on a redelivered `req_id`
  after a reconnect, re-emit the cached terminal result rather than re-running.
- **stdin** — feed `exec.stdin` bytes to the child's stdin. `Heartbeat` frames
  are liveness-only; the harness owns lease counts.

## Laptop demo: worker as a host container (one command)

Everything above runs the worker as a **pod**. That demonstrates the plumbing but not the
driver: the headline claim is a sandbox _outside_ the cluster, with **zero inbound rules**,
executing a leaf's tool calls. One command shows that on a laptop:

```bash
make demo-remote-sandbox                                  # no cluster -> passing A/B
make demo-remote-sandbox DEMO_ARGS=--reuse-cluster        # skip setup on a warm cluster
make demo-remote-sandbox-teardown                         # remove the container, relay and image
```

Teardown removes everything the demo creates, but **asks before deleting the kind cluster**:
`--reuse-cluster` exists so the demo can run against a long-lived dev cluster, and a fresh
`--teardown` process cannot know which kind it is looking at. Answer `y`, or pass
`--yes` to skip the prompt (`DEMO_ARGS=--yes`). With no terminal to ask on, the cluster is
kept. A run that _did_ create the cluster says so on exit and points at `--teardown`; a run
against a pre-existing cluster does not.

```
laptop
|- kind cluster:  Knative + Redis + harness (ksvc) + sandbox-relay
|                     ^                                    ^
|                     | harness -> relay                   | worker -> relay
|                     | sandbox-relay.default.svc:8443     | host.docker.internal:8443
|                     |  (in-cluster DNS)                  |  (outbound, through a port-forward)
\- docker run:    remote-worker  --------- dials out ------/
```

Neither address is inbound to the laptop. The worker publishes no ports — `docker run` with
no `-p` at all — and reaches the relay only by dialing _out_ through
`kubectl port-forward`. The demo proves the container can reach the tunnel before it starts
the worker, and adapts the bind (`--add-host`, then `--address 0.0.0.0`) for runtimes where
`host.docker.internal` maps to a bridge IP rather than host loopback.

### Why a green run is not enough

`SH_REMOTE_SANDBOX=1` alone does **not** route to the worker — see the pool-selection trap
at the top of this file. The demo defends against it twice:

1. **Structurally.** Before the remote runs it asserts `KAGENTI_SANDBOX_POOL_SELECTOR`
   matches **zero Running pods**, so `select-sandbox`'s candidate list contains nothing but
   the worker. A pod cannot win a lease it is not a candidate for.
2. **By fingerprint.** The in-cluster pool runs Alpine and the worker image runs RHEL, so a
   leaf grepping `/etc/os-release` flips its verdict with the backend — and both directions
   are asserted, so an exec that landed on a pod fails one check or the other:

   | backend                | pattern `Alpine` | pattern `Red Hat` | model's stated reason           |
   | ---------------------- | ---------------- | ----------------- | ------------------------------- |
   | in-cluster sandbox pod | `FLAGGED`        | `CLEAR`           | "…running Alpine Linux"         |
   | remote host container  | `CLEAR`          | `FLAGGED`         | "…Red Hat Enterprise Linux 9.8" |

The discriminator itself is verified before anything relies on it, and the summary prints
the model's own stated reason — so you see the OS it actually read, rather than inferring it
from a green check.

### Trust model

Inspect what the worker was given:

```bash
docker inspect sh-demo-remote-worker --format '{{range .Config.Env}}{{println .}}{{end}}'
```

A bearer token, a sandbox id, and a relay address. **No LLM key, no kubeconfig, no
orchestration.** The token must equal the relay's `SH_RELAY_TOKEN`; auth is fail-closed, so
a mismatch rejects the Attach before the stream is ever parked.

The demo generates that token **fresh per run** and patches it onto the relay, rather than
reusing `relay-deployment.yaml`'s `dev-token`. That value is a repo constant, and therefore
public — which matters because on native Linux Docker the demo may bind the relay port to
`0.0.0.0` (see above), and a LAN-reachable port guarded by a credential anyone can read from
the repo would let a network peer Attach as a sandbox and receive the leaf's exec payloads.
So what `docker inspect` shows is a credential scoped to this one run. Set `SANDBOX_TOKEN` to
pin a value instead. A later `kubectl apply -f relay-deployment.yaml` restores the declared
dev value, so nothing is left patched for other callers.

### Requirements and limits

- `docker` (or `podman`) + `kind` + `kubectl` + `jq`. **No local Go toolchain** —
  `remote-worker/Dockerfile` builds the binary in a builder stage. The image is built for
  the _host_, never `kind load`ed, so its architecture need not match the kind node.
- A model the **cluster** can reach (`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` +
  `ANTHROPIC_BASE_URL`). The leaf's verdict is a real model call; the demo fails with an
  explicit "model endpoint unreachable" message rather than timing out mysteriously.
- The harness ksvc env is snapshotted and restored from an `EXIT` trap, so an interrupted
  run never leaves the cluster pointed at a selector matching nothing.

## Running the worker outside the cluster

The steps above assume the worker runs as a pod in the same cluster, dialing the
relay's ClusterIP over plaintext h2c. To run it on your own infrastructure
instead, expose the relay through an OpenShift **Route on :443** with TLS and
**HTTP/2 enabled on the router** — full-duplex bidi Attach needs HTTP/2
end-to-end — and point `RELAY_ADDR` at the Route host. This is noticeably more
fiddly; start in-cluster and graduate only if you need external reachability.

## Reference

- **Proto (source of truth):** `proto/sandbox/v1/sandbox.proto` — §4 messages/
  services, §8 wire semantics.
- **Go stubs:** `gen/go/sandbox/v1/` (module
  `github.com/rossoctl/moca/gen/go`); a `contract_test.go` lives
  alongside them.
- **Relay behavior to interoperate with:** `packages/sandbox-relay/src/relay.ts`
  (park / presence / routing), `main.ts` (fail-closed token validator).
- **Harness-side expectations:** `packages/k8s-sandbox/src/grpc-relay-transport.ts`
  (reqId correlation, `Chunk.stream` split, dedup, deadline, per-exec output cap).

## Troubleshooting

| Symptom                                                 | Cause / fix                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker connects but the Attach is immediately closed    | Token unset or mismatched. Set `SH_RELAY_TOKEN` on the relay (Step 1) and give the worker the same value as `SANDBOX_TOKEN`. Auth is fail-closed. On an OCP overlay deployment, rotate the `sh-relay-token` Secret and `oc rollout restart deploy/sandbox-relay` instead of using `oc set env` — see the note in Step 1. |
| No field in `sh:sandbox:records`                        | The Attach never succeeded (see above), the worker isn't sending `authorization: Bearer <token>` metadata, or it isn't sending `Hello` with `sandbox_id` as the first frame.                                                                                                                                             |
| Presence is there but the harness never uses the worker | `SH_REMOTE_SANDBOX` / `SH_RELAY_ADDR` not set on the harness ksvc (Step 2). Confirm with `oc set env ksvc/moca --list -n default`.                                                                                                                                                                                       |
| A second worker for the same id won't connect           | Expected — one live Attach per `SANDBOX_ID`. Give each worker a distinct id.                                                                                                                                                                                                                                             |
| `exit_code` comes back `null`                           | The child was signalled (or the worker sent `exit_code < 0`). Not an error by itself.                                                                                                                                                                                                                                    |
