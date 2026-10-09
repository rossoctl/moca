# P6 on Kubernetes (Kind and OpenShift)

The P6 runtime as ordinary Kubernetes workloads: the supervisor and its forked workers, the sandbox
relay, Redis, the MU1 control plane and `remote-worker` container sandboxes. It is milestone P6.1,
slice 1 of epic rossoctl/moca#426 (issue rossoctl/moca#423). The design is
[`docs/specs/2026-10-02-p6-on-kubernetes-slice1-design.md`](../../docs/specs/2026-10-02-p6-on-kubernetes-slice1-design.md).

## 1. What this is

This is the sibling of [`deploy/vm/`](../vm/README.md) (systemd and podman on one VM) and
[`deploy/compose/`](../compose/README.md) (the same processes under Docker Compose). All three run
the same processes, the same environment and the same wire. Only the process manager, the
addressing and the way isolation is enforced differ. Here, isolation comes from namespaces,
NetworkPolicy, Secrets and pod lifecycle.

**This is not the Knative path.** `deploy/knative/` (the Knative Service, KEDA, `KubectlTransport`
and pod-exec sandboxes) is the deployment model RA1 deprecates. This directory shares no code and no
manifest with it, and uses `GrpcRelayTransport` and records-based discovery exactly as `deploy/vm/`
does. [ADR-0037](../../docs/adrs/0037-p6-on-kubernetes-substrate.md) records the distinction.

| Workload                        | Namespace          | Ports                                        | Reached by                                                                     |
| ------------------------------- | ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Deployment `moca-supervisor`    | `moca`             | 8080 data; 8081 admin; 8443 ghostunnel (OCP) | users: `port-forward` on Kind, the passthrough Route on OCP; kubelet on 8081   |
| Deployment `sandbox-relay`      | `moca`             | 9443 Attach; 9444 SandboxExec                | sandboxes on 9443 only; supervisor pods on 9444 only                           |
| StatefulSet `redis`             | `moca`             | 6379                                         | supervisor, relay, control plane                                               |
| Deployment `moca-control-plane` | `moca`             | 8080                                         | users (`port-forward` on Kind, an edge Route on OCP); the supervisor's workers |
| StatefulSet `moca-sandbox`      | `moca-sandbox`     | none                                         | nothing: each sandbox dials out to the relay                                   |
| per-user credentials (Secrets)  | `moca-credentials` | none                                         | the control plane, through the kube API (`K8sSecretStore`)                     |

The relay has two Services, `sandbox-relay-attach` (9443) and `sandbox-relay-exec` (9444), so the
address a sandbox is given has no route to the exec port. The supervisor's Service is
`moca-supervisor` (8080, 8081), and on OCP `moca-supervisor-tls` (8443).

```
deploy/k8s/
├── base/                 namespaces, workloads, Services, NetworkPolicy, RBAC
├── overlays/kind/        local images (dev.local/...:local), port-forward access
├── overlays/kind-ci/     kind + a loopback mock model in the supervisor pod (CI)
├── overlays/ocp/         ghostunnel sidecar, Routes, router and openshift-dns rules
├── setup.sh              bring it up; idempotent
├── smoke.sh              the live smoke (K8S_LIVE_SMOKE=1)
└── tests/setup.test.sh   setup.sh with every external command mocked
```

The manifest tests are in [`packages/supervisor/test/k8s/`](../../packages/supervisor/test/k8s)
and run with `make test`.

## 2. Try it on Kind

You need:

- **kind 0.24.0 or newer.** It is the first release whose default CNI (kindnet, through
  kube-network-policies) enforces NetworkPolicy, and this deployment's isolation _is_
  NetworkPolicy. `setup.sh` refuses an older `kind` and says why.
- **Docker**, or podman's `docker` CLI.
- `kubectl`, `jq`, `openssl`, and `sha256sum` or `shasum`.
- For `--build`, a checkout with its submodules (`git submodule update --init --recursive`). The
  image builds pi-fork itself.

```bash
SH_GITHUB_CLIENT_ID=<client id> deploy/k8s/setup.sh --target kind --build
```

`setup.sh` creates the kind cluster `moca` if it is missing, builds both images and loads them,
creates the namespaces, generates the Secrets once, applies the overlay, and waits until every
workload is rolled out and every sandbox is attached to the relay. Every kube call is pinned to the
context `kind-moca`, never the shell's current one.

> **`kind create cluster` switches your current context.** When `setup.sh` creates the cluster,
> kind sets the current kube context to `kind-moca`, as it always does. `setup.sh` itself never
> uses the current context, but your next bare `kubectl` will talk to kind until you switch back
> (`kubectl config use-context <previous>`).

Image choice, for `--target kind`:

- `--build` builds both images from this checkout.
- With neither flag, it pulls `ghcr.io/rossoctl/moca:latest` and
  `ghcr.io/rossoctl/moca-remote-worker:latest` (or the refs given with `--image` and
  `--sandbox-image`), and builds only if the pull fails. Until this slice is published to `latest`,
  the published harness image has no `/readyz`, and the supervisor never becomes ready: use
  `--build`.
- `--skip-build` assumes both images are already loaded, which makes a re-run take seconds.

Each run stamps the loaded images' IDs on the pod templates (`moca.dev/image-id`). A rebuilt image
keeps its `:local` tag, so without that the apply would see no change and the pods would keep
running the old image. With it, a new image rolls the workloads that run it, and an unchanged image
rolls nothing.

Other settings come from the environment: `SH_ADMIN_SUBJECTS`, `SH_ALLOW_OPERATOR_FALLBACK`
(default `false`), `SH_SANDBOX_COUNT` (default 2, at most 4 digits; 0 runs no container sandboxes) and
`SH_WAIT_SECONDS` (default 120, the wait for sandboxes to attach). `--help` prints the synopsis.

When it finishes, it prints how to reach the stack:

```
P6 is up on kind (context kind-moca). Reach it with two port-forwards:
  kubectl --context kind-moca -n moca port-forward svc/moca-supervisor 8080:8080
  kubectl --context kind-moca -n moca port-forward svc/moca-control-plane 8090:8080
then:  mocactl --control-plane-url http://127.0.0.1:8090 login
```

Run the two port-forwards in their own terminals, then log in. Export the URL in the terminal you
run `mocactl` from, so every later command uses the same one (`mocactl` keys its cached login on
the control-plane URL):

```bash
export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
mocactl login
```

The control plane advertises the harness as `http://127.0.0.1:8080`, so the supervisor's forward
must use local port 8080. `mocactl`
runs from a checkout ([`packages/mocactl/QUICKSTART.md`](../../packages/mocactl/QUICKSTART.md)). The
GitHub OAuth app needs **Enable Device Flow** ticked ([`deploy/vm/README.md`](../vm/README.md), "The
GitHub OAuth app").

**Without `SH_GITHUB_CLIENT_ID`,** the control plane is installed with 0 replicas, because nobody
can log in without one, and `setup.sh` says so. It is rendered that way, not scaled down later, so
it never starts into a crash-loop. To fix it, re-run with the client id set:

```bash
SH_GITHUB_CLIENT_ID=<client id> deploy/k8s/setup.sh --target kind --skip-build
```

The settings change rolls the control plane, and the supervisor with it: `setup.sh` stamps a hash
of its settings on both pod templates (`moca.dev/settings-hash`), so the apply itself restarts them
exactly when they change, even if an earlier run failed after writing them. The supervisor is in it
because it reads the sandbox tiers from the same ConfigMap (§11.1); it drains on the roll, with a
120 s grace.

**The first apply of a P6.3 release disrupts every session, so run it at a quiet time.** It does
more than roll the supervisor and the control plane once:

- **It recreates the relay.** `base/relay.yaml` gains `SH_SANDBOX_AFFINITY_TTL_SECONDS`, and the
  relay is `strategy: Recreate`. While it is down, every sandbox and every P4 host is detached, and
  in-flight turns fail and are retried.
- **It rolls every `moca-sandbox` pod**, even on an untiered stack: `base/sandbox.yaml` gains
  `SANDBOX_TIER`. A container sandbox's workspace is local to its pod, so every container session's
  workspace is reset. This happens **silently**: the pod names do not change, so affinity returns
  each session to the same sandbox id, and no `workspace reset` notice is shown.

A re-run with nothing changed converges without restarting any pod or touching any Secret. To
remove everything: `kind delete cluster --name moca`.

**Inputs are sticky.** A re-run keeps every input it is not given, so you change one input by
re-running with just that one:

- `SH_GITHUB_CLIENT_ID`, `SH_ADMIN_SUBJECTS`, `SH_ALLOW_OPERATOR_FALLBACK`,
  `SH_API_TOKEN_TTL_SECONDS` and `SH_SESSION_TOKEN_TTL_SECONDS` live in the ConfigMap
  `moca-settings`. A variable that is **unset** keeps the stored value. A variable set to empty
  **clears** it: `SH_ADMIN_SUBJECTS= deploy/k8s/setup.sh ...` removes every admin,
  `SH_GITHUB_CLIENT_ID=` takes the control plane back to 0 replicas, and an empty token lifetime is
  the control plane's default (900 seconds for the API token a login gets, 300 for a session
  token). A lifetime is a whole number of seconds; a change rolls the control plane.
- `SH_SANDBOX_COUNT`, and on OpenShift `--image` and `--sandbox-image`, live in the ConfigMap
  `moca-setup` (namespace `moca`, nothing secret in it). A given value replaces the stored one.
  To go back to a default, pass it explicitly (`SH_SANDBOX_COUNT=2`,
  `--image ghcr.io/rossoctl/moca:latest`), or delete the stored key:
  `kubectl -n moca patch configmap moca-setup --type=json -p '[{"op":"remove","path":"/data/IMAGE"}]'`.
  On Kind the images are never stored: the stack always runs the locally loaded `dev.local` tags.
- `SH_SANDBOX_EGRESS_EXCEPT` (§6) lives in `moca-setup` on every target. On OpenShift,
  `SH_P4_SANDBOX_IDS` and `SH_SANDBOX_DEFAULT_TIER` (§11) live there too, and on
  `--target ocp-single` so do `SH_ROUTE_DOMAIN` and `--tls-secret` (§12.5). For the variables, as
  for the settings, one set to empty clears the stored value.

`kubectl -n moca get configmap moca-settings moca-setup -o yaml` shows what the next run will reuse.
A failed read of either ConfigMap aborts the run rather than resetting the inputs.

**The CI variant** is `--target kind-ci`. It adds a scripted mock model to the supervisor pod and a
placeholder client id, so the smoke can drive real turns with no model key and no login:

```bash
deploy/k8s/setup.sh --target kind-ci --build
K8S_LIVE_SMOKE=1 deploy/k8s/smoke.sh --target kind-ci
```

## 3. The front door is L4

**Nothing that speaks HTTP may sit in front of the supervisor's port 8080.** That rules out an
Ingress, an OpenShift edge or re-encrypt Route, a service-mesh sidecar, and Knative's queue-proxy.

The reason is that the supervisor works per connection. It accepts a TCP connection, reads the
request head, picks a worker (`leastInFlight` or `stickyBySession`), admits or refuses the
connection against that worker's capacity, and hands the socket itself to the worker (ADR-0034). An
L7 proxy terminates the client's connection and pools its own upstream connections, so many users'
turns would arrive over a few long-lived connections. Routing, admission and stickiness would then
apply to the proxy's connections, not the users', and they would silently stop meaning anything.
Nothing would fail visibly.

On Kind, users reach 8080 by `kubectl port-forward`, which is a byte stream to the pod.

On OpenShift, TLS is terminated inside the supervisor pod by a **ghostunnel sidecar**, a
byte-for-byte TCP proxy on 8443 that forwards to `127.0.0.1:8080`. The **Route `moca` is
`passthrough`**, so the OpenShift router routes on SNI and never decrypts. Each client connection
becomes exactly one supervisor connection. The control plane is ordinary HTTP, so it gets an edge
Route; connection reuse there is harmless.

The image is `docker.io/ghostunnel/ghostunnel:v1.11.3`, pinned by digest in
`overlays/ocp/kustomization.yaml`. Docker Hub is the project's official channel; it does not
publish to GHCR.

The manifest tests fail on any `Ingress` or `serving.knative.dev` object, and on an OCP supervisor
Route that is not `passthrough` to the sidecar's port. Replacing the sidecar with an HTTP proxy
would need an ADR superseding point 3 of ADR-0037.

## 4. Scaling

**W, the worker count, is pinned, not inferred.** `base/supervisor.yaml` sets three values together:

| Setting                       | Value                 | Why                                                                     |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `SH_WORKERS`                  | `2`                   | W                                                                       |
| `resources.limits.cpu`        | `"2"`                 | one CPU per worker                                                      |
| `resources.requests.memory`   | `768Mi` (limit `1Gi`) | at least W × 256Mi (the per-process tsx footprint), plus 256Mi headroom |
| `SH_TURNS_PER_WORKER` (trial) | `4`, as in Compose    | a trial value; its real value is an output of E8                        |

Change them together. The manifest tests fail when the memory request is below W × 256Mi. Leaving
`SH_WORKERS` unset would follow the CPU limit (#341), but then a CPU change would silently change
the memory needed.

**The supervisor and its whole pool are one container.** The workers are `fork()`ed and receive
sockets over IPC, which cannot cross containers. Never split the workers into their own containers
or Deployments; the manifest tests check that only the supervisor container runs the supervisor.

**More supervisor pods are allowed.** Set `replicas` in an overlay. With `leastInFlight` (the
default `SH_ROUTING_POLICY`), the workers already share nothing but Redis, so more pods add no new
kind of concurrency. With `stickyBySession`, affinity holds only within one pod: the Service spreads
connections across pods without looking at the session.

**The relay stays at one replica** (`strategy: Recreate`). It is presence-only: each Attach stream
is held by one process, so two replicas would split the sandboxes between them and an exec could
reach the wrong one.

**Sandboxes:** `SH_SANDBOX_COUNT` for `setup.sh` sets the StatefulSet's replicas. Each pod's
`SANDBOX_ID` is its name (`moca-sandbox-0`, `-1`, ...), so replicas never collide on one
`sh:sandbox:records` entry.

## 5. Secrets

`setup.sh` generates every Secret on its first run and **never rotates one**. A re-run keeps every
existing value, and fills in only a key that is missing. It reads each Secret with
`--ignore-not-found`, so "absent" is the only state that counts as missing: any other API error
(a timeout, an RBAC denial, an expired login) aborts the run instead of looking like a missing
Secret and replacing it. No value is ever put on a command line. Values travel through pipes and
through the environment of the one `jq` that writes each Secret, and are applied on stdin.

| Secret                | Namespace      | Keys                                                                                                     | Consumed by                                                                                                                    |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `moca-relay`          | `moca`         | `SH_RELAY_TOKEN`, `MOCA_RELAY_EXEC_TOKEN`                                                                | relay (both, env); supervisor (`MOCA_RELAY_EXEC_TOKEN` only, env)                                                              |
| `moca-redis`          | `moca`         | `REDIS_PASSWORD`, `REDIS_URL`, `redis.conf`                                                              | Redis (`redis.conf` as a file; `REDIS_PASSWORD` as `REDISCLI_AUTH` for probes); supervisor, relay, control plane (`REDIS_URL`) |
| `moca-mu1`            | `moca`         | `SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN` | control plane (private key, KEK, exchange token as files); supervisor (exchange token as a file, public keyset as env)         |
| `moca-relay-attach`   | `moca-sandbox` | `SH_RELAY_TOKEN` (copied from `moca-relay`)                                                              | sandboxes                                                                                                                      |
| `moca-supervisor-tls` | `moca` (OCP)   | `tls.crt`, `tls.key`                                                                                     | ghostunnel sidecar                                                                                                             |

- The tokens and the Redis password are `openssl rand -hex 32`.
- `REDIS_URL` and `redis.conf` are re-derived from `REDIS_PASSWORD` on every run, so the three never
  disagree.
- The MU1 keys come from the control plane's own generator, run once in the harness image as the
  pod `moca-genkeys`. They are validated with `deploy/compose/install.sh`'s regexes before anything
  is written, so a garbled generator never leaves half a set. See Troubleshooting for where those
  values sit while the pod runs.
- `moca-supervisor-tls` is replaced only when `--tls-cert` is given (section 9).

**To rotate on purpose,** delete the Secret, re-run `setup.sh`, then restart what consumes it. The
re-run needs no other input: settings, the sandbox count and (on OpenShift) the images are sticky
(section 2), so it does not reset them. For example, the relay tokens on Kind:

```bash
kubectl --context kind-moca -n moca delete secret moca-relay
deploy/k8s/setup.sh --target kind --skip-build
kubectl --context kind-moca -n moca rollout restart deployment/sandbox-relay deployment/moca-supervisor
kubectl --context kind-moca -n moca-sandbox rollout restart statefulset/moca-sandbox
```

The consumers are in the table. For `moca-redis`, restart `redis` as well. For `moca-mu1`, restart
the control plane and the supervisor.

> **Rotating `moca-mu1` logs everyone out**: a new signing key invalidates every API and session
> token. If the KEK changes, **every stored credential becomes unreadable**: the per-user
> credentials in `moca-credentials` are sealed under `SH_CREDENTIAL_KEK`, and there is no way back
> without the old KEK. A half keypair (a private key without its public keyset, or the reverse) is
> refused: delete both keys to regenerate the pair.

## 6. Isolation

Each namespace has a default-deny NetworkPolicy, both directions. Each workload's own policy then
allows exactly its edges. This replaces the VM's podman `isolate=strict` and nftables.

| Pod           | Ingress allowed                                                                                                                                                                                                   | Egress allowed                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| supervisor    | 8080: nothing from the pod network (`port-forward` and the OCP sidecar's loopback are not filtered). 8443 (OCP): the router namespace. 8081: pods in `moca`; kubelet probes are admitted by the CNI (section 10). | DNS; `redis` 6379; `sandbox-relay` 9444; `moca-control-plane` 8080; `0.0.0.0/0` TCP 443 (model API)                                              |
| relay         | 9443 from pods in `moca-sandbox`; 9444 from `moca-supervisor` pods only                                                                                                                                           | DNS; `redis` 6379                                                                                                                                |
| Redis         | 6379 from supervisor, relay, control plane                                                                                                                                                                        | none                                                                                                                                             |
| control plane | 8080 from `moca-supervisor` pods; the router namespace (OCP edge Route)                                                                                                                                           | DNS; `redis` 6379; `0.0.0.0/0` TCP 443 and 6443 (kube API, GitHub)                                                                               |
| sandbox       | none                                                                                                                                                                                                              | DNS; `sandbox-relay` 9443; `0.0.0.0/0` **except** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16` (all ports) |

DNS is `kube-system` port 53; the OCP overlay adds `openshift-dns` port 5353.

The sandbox rule lets research turns reach the internet while blocking every cluster-internal
address: Pod and Service CIDRs sit inside the private ranges on Kind and OCP. It also blocks cloud
instance metadata, which the VM path leaves open (#357).

**A publicly routable node or infrastructure network is not covered.** The rule assumes everything
that is not the internet uses one of those ranges. Some clusters put their nodes on a publicly
routable range, and there the rule admits them: a sandbox can reach its node's kubelet (10250) and
SSH (22), and other hosts on that network (§12.3, #446). Add those ranges with
`SH_SANDBOX_EGRESS_EXCEPT`, a comma-separated list of IPv4 CIDRs appended to the `except` list on
every target:

```bash
SH_SANDBOX_EGRESS_EXCEPT=203.0.113.0/24,198.51.100.0/24 deploy/k8s/setup.sh --target ocp ...
```

It is empty by default, so the rule is the one in the table. Each entry must be a canonical CIDR
(network address, prefix 1-32) not already in the built-in list; setup.sh refuses anything else
before it touches the cluster. It is sticky (section 2): a re-run keeps the list, and
`SH_SANDBOX_EGRESS_EXCEPT=` clears it. Find the node network with
`kubectl get nodes -o wide` (the `INTERNAL-IP` column) when you have node read access, or ask the
cluster administrator when you do not (`--target ocp-single`).

The only Secret any MOCA object references
in the sandbox namespace is the attach token (OpenShift adds its own per-ServiceAccount pull Secrets
there): the exec token, the Redis password and the MU1 keys never exist there. The manifest tests
check that nothing in it references any other Secret.

**What the smoke's claim 7 proves.** From inside `moca-sandbox-0`, TCP connects to
`redis.moca.svc:6379`, `sandbox-relay-exec.moca.svc:9444` and `169.254.169.254:80` are blocked, and
`sandbox-relay-attach.moca.svc:9443` is open. On `--target ocp` it also requires
`kubernetes.default.svc:443` to be blocked. On Kind it only prints that probe's result as a note:
single-node kindnet does not filter traffic to its own node (section 10).

**A CNI that enforces NetworkPolicy is a hard requirement.** On a CNI that ignores NetworkPolicy,
every row above is open, and nothing else stands in. kind ≥ 0.24.0 and OpenShift's OVN-Kubernetes
enforce it.

## 7. What this does not claim

These are the container tier's non-claims, the same as on the VM
([`docs/demos/vm-multi-user-demo.md`](../../docs/demos/vm-multi-user-demo.md), "Notes and limits").

- **No sandbox isolation between users.** Every user's turns lease the same sandbox pods, which
  share `/workspace`, the Unix user and the process list (`remote-worker/internal/exec/runner.go`
  ignores `workspace_key`, #408). The fix is MI1 S5, owner binding.
- **Direct credential mode.** With no injector, a user's real inference secret reaches the shared
  harness worker for the length of a turn, which puts it in the model request's headers. The
  sandbox never receives it: an Exec carries only the command, stdin, timeout and workspace key. So
  the agent's bash cannot read a user's key, but one harness process holds every user's key during
  their turns. MI1 S2's grants replace this.
- **Open egress from sandboxes,** to the whole internet. Unlike the VM, not to instance metadata
  and not to cluster ranges (section 6). Egress control is MI1 S5's `moca-egress`.

## 8. CI

[`.github/workflows/k8s-e2e.yml`](../../.github/workflows/k8s-e2e.yml), job `k8s-kind-e2e`, runs on
pushes to `main` and on pull requests touching `deploy/k8s/**`, the mock model, `packages/**`,
`harness/**`, `remote-worker/**`, `pi-fork`, the Dockerfile or the lockfile. It installs kind
v0.33.0 (checked by sha256), runs `setup.sh --target kind-ci --build`, then
`K8S_LIVE_SMOKE=1 smoke.sh --target kind-ci` under `pipefail`, so a failed claim fails the job. On
failure it uploads the artifact `k8s-kind-e2e-logs`: pods, `describe`, every container's log,
events, the smoke's output and its kept log directory, with every token header file deleted first.

**It is not a required check until it has passed ten consecutive runs on `main`.** Until then, a
red run is investigated, not waved through, but it does not block a merge.

## 9. Demo on OpenShift

This is the slice's acceptance run: the container-tier acts of
[`docs/demos/vm-multi-user-demo.md`](../../docs/demos/vm-multi-user-demo.md), against
`--target ocp`. It is performed by a person and recorded on rossoctl/moca#423. Every outward step
(pushing an image, creating objects on a shared cluster, posting on the issue) needs that person's
go-ahead.

You need:

- an OpenShift 4.x cluster where you can grant SCCs (cluster-admin or equivalent), and `oc login`
  done;
- a harness image built from this branch, pushed to a registry the cluster can pull from (the
  published `latest` predates `/readyz`);
- a GitHub OAuth app with **Enable Device Flow** ticked;
- two GitHub accounts, two laptops (or one laptop with two `XDG_CONFIG_HOME` directories and a
  private browser window, as the VM demo's 1a trap describes), and two inference credentials;
- optionally, a certificate and key valid for the supervisor Route's host,
  `moca-moca.<apps domain>`.

The cluster pulls ghostunnel and `redis:7-alpine` from Docker Hub, so it needs access to
`docker.io`.

### 9.1 Bring it up

Without a certificate of your own (`setup.sh` generates a self-signed one, see below):

```bash
export LOG_DIR=/tmp/kagenti/tdd/moca; mkdir -p "$LOG_DIR"
SH_GITHUB_CLIENT_ID=<client id> SH_ADMIN_SUBJECTS= \
  deploy/k8s/setup.sh --target ocp --image <registry>/moca:<branch-tag> \
  >"$LOG_DIR/t19-setup.log" 2>&1; echo "EXIT:$?"
tail -6 "$LOG_DIR/t19-setup.log"
```

With a certificate and key valid for `moca-moca.<apps domain>`:

```bash
export LOG_DIR=/tmp/kagenti/tdd/moca; mkdir -p "$LOG_DIR"
SH_GITHUB_CLIENT_ID=<client id> SH_ADMIN_SUBJECTS= \
  deploy/k8s/setup.sh --target ocp --image <registry>/moca:<branch-tag> \
  --tls-cert <fullchain.pem> --tls-key <key.pem> >"$LOG_DIR/t19-setup.log" 2>&1; echo "EXIT:$?"
tail -6 "$LOG_DIR/t19-setup.log"
```

`setup.sh --target ocp` checks `oc whoami` and prints the target context. It reads the apps domain
from `ingresses.config/cluster`, grants `nonroot-v2` to each ServiceAccount before the apply, and
sets both Route hosts: `moca-moca.<apps domain>` (supervisor, passthrough) and
`moca-control-plane-moca.<apps domain>` (control plane, edge). `--sandbox-image` overrides the
sandbox image the same way `--image` overrides the harness.

**Without `--tls-cert`,** it generates a self-signed certificate for the supervisor host (825 days)
and prints a warning. Every run then writes the file `mocactl` users trust, and prints the line
they need:

```
export NODE_EXTRA_CA_CERTS=<checkout>/deploy/k8s/.generated/ocp/moca-ca.crt
```

`moca-ca.crt` holds the supervisor's certificate when it is self-issued, and the cluster's default
ingress CA (`ca-bundle.crt` of `openshift-config-managed/default-ingress-cert`), which signs the
control plane's edge Route and is usually not publicly trusted either. Both are read back from the
cluster on every run, so a re-run, or a run from a second checkout, prints the line and rebuilds the
file too. If the ingress CA cannot be read, the run warns and the file holds the supervisor's
certificate alone. With an issued `--tls-cert`, the file holds only the ingress CA.

Copy that file to both laptops and export it there before running `mocactl`.

**Look for:** `EXIT:0`, `N sandbox(es) attached to the relay`, and the two Route URLs.

**If `redis-0` is never created,** check for the SCC:

```bash
kubectl -n moca get events | grep -i 'security context constraint'
```

`unable to validate against any security context constraint` means the explicit Redis UID 999 (or
its fsGroup 1000) is refused, even with `nonroot-v2`. The fallback (spec §10) is a patch in
`overlays/ocp` that drops `runAsUser`, `runAsGroup` **and** `fsGroup` from the Redis pod's
`securityContext`, so restricted-v2 assigns both the UID and the fsGroup from the namespace's
range:

```yaml
# overlays/ocp/kustomization.yaml, under patches:
- target: { kind: StatefulSet, name: redis }
  patch: |-
    - { op: remove, path: /spec/template/spec/securityContext/runAsUser }
    - { op: remove, path: /spec/template/spec/securityContext/runAsGroup }
    - { op: remove, path: /spec/template/spec/securityContext/fsGroup }
```

Keeping `fsGroup: 1000` does not work: restricted-v2 refuses it (its fsGroup must lie in the
namespace's range), so `nonroot-v2` admits the pod with no UID at all, and the image runs as root.
The symptom is `redis-0` in `CreateContainerConfigError`, with
`container has runAsNonRoot and image will run as root` in `kubectl -n moca describe pod redis-0`.

Commit it, re-run `setup.sh`, and record that it was needed.

### 9.2 Live smoke on OpenShift

With a real model. Put the token in the environment from a password manager, never typed on a
command line (the smoke reads it from the environment only):

```bash
export SMOKE_MODEL_TOKEN="$(<your password manager's CLI>)"
K8S_LIVE_SMOKE=1 SMOKE_MODEL_URL=https://api.anthropic.com SMOKE_MODEL_KIND=api-key \
  deploy/k8s/smoke.sh --target ocp 2>&1 | tee "$LOG_DIR/t19-smoke.log"
unset SMOKE_MODEL_TOKEN
```

`SMOKE_MODEL_KIND` is `api-key` for a raw Anthropic key and `bearer` (the default) for a gateway
token. The smoke reaches everything by `port-forward`, as on Kind; the Route path is the demo's.

**Look for:** `PASS=12 FAIL=0`. On OCP, claim 7 must also report `kube API ... BLOCKED`. Run the
smoke before the acts: claim 9 deletes the supervisor pod and claim 10 deletes `redis-0`.

**Re-check two things that Kind could not prove,** because OVN-Kubernetes behaves differently from
kindnet:

- **Probes.** On Kind, kubelet probes are admitted because kindnet accepts all traffic the node's
  root originates. If the supervisor or control plane is not Ready under OVN-Kubernetes, and
  `kubectl -n moca describe pod` shows probe timeouts, apply the node-CIDR fallback (section 10).
- **The kube API and the kubelet from a sandbox.** Claim 7 probes `kubernetes.default.svc:443`.
  Also probe the API server's endpoint address and a node's kubelet port directly, which is how
  the Kind spike found the gap:

  ```bash
  kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].addresses[0].ip}'; echo
  kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}'; echo
  for t in <apiserver ip>:6443 <node ip>:10250; do
    kubectl -n moca-sandbox exec moca-sandbox-0 -c sandbox -- bash -c \
      'timeout 3 bash -c "</dev/tcp/${0%:*}/${0#*:}" 2>/dev/null && echo "$0 OPEN" || echo "$0 BLOCKED"' "$t"
  done
  ```

  Both must be `BLOCKED`.

### 9.3 The acts

One user per laptop. On each, `mocactl` runs from a checkout
([`packages/mocactl/QUICKSTART.md`](../../packages/mocactl/QUICKSTART.md)):

```bash
alias mocactl="node $PWD/packages/mocactl/bin/mocactl.mjs"
export NODE_EXTRA_CA_CERTS=<the CA file>
export SH_CONTROL_PLANE_URL=https://moca-control-plane-moca.<apps domain>
```

`mocactl` renews its API token by itself, for 30 days after its last use (90 at most), so one
login before the acts is enough. The token lasts 15 minutes unless `setup.sh` was run with
`SH_API_TOKEN_TTL_SECONDS` (§2's sticky settings). A longer value buys nothing with a renewing
login and costs revocation latency: `mocactl logout` stops new tokens at once, but a token already
minted stays valid for its whole lifetime. `MOCA_TENANCY` is unset, as on the VM demo; see its note
on tenancy.

**L4 baseline (operator), before act 1.** Record the supervisor's counters:

```bash
kubectl -n moca exec deploy/moca-supervisor -c supervisor -- wget -qO- 127.0.0.1:8081/metrics |
  jq '.counters'
```

**Act 1. Log in, and doctor.** Both users:

```bash
mocactl login
mocactl doctor
```

Look for: `logged in as <GitHub name>` (the device flow approves for whichever account the browser
is signed into), and every doctor check green. `--control-plane-url URL` on each command does the
same as `SH_CONTROL_PLANE_URL`.

**Act 2. Each user's own credential.** Each user stores theirs, under a name of their own (the
secret is read from stdin), then runs a turn:

```bash
mocactl credentials add anthropic-user1 --host api.anthropic.com --kind api-key \
  --endpoint https://api.anthropic.com </path/to/a/0600/file/holding/the/key
mocactl run "Run uname -a in your sandbox and reply with its output only."
```

A gateway token is `--kind bearer` with its own host and endpoint. Then the operator shows whose
credential each turn spent:

```bash
kubectl -n moca exec redis-0 -- sh -c 'redis-cli XREVRANGE sh:cp:audit + - COUNT 6'
```

Look for: for each user's session, `session_created` and `credential_issued` entries with that
user's `subject` and their own credential **name**. The audit records names, never values.

**Act 3. Disjoint sessions, and another user's session does not exist.** Each user:

```bash
mocactl sessions
```

Each list holds only that user's sessions. User 1 sends a session id to user 2, who tries it, then
an id that never existed:

```bash
mocactl run "what did you find?" --session <user 1's session id>; echo "exit $?"
mocactl run "what did you find?" --session sess-does-not-exist; echo "exit $?"
```

Look for the same answer both times, `that session no longer exists, or is not yours` and `exit 1`.
User 1 then resumes it, to show it was real.

**Act 4. Research from the sandbox.** Each user runs the VM demo's 2a prompt, with
`D=research-user1` or `D=research-user2`, and then its 2b check on any machine
(`git ls-remote https://github.com/rossoctl/moca HEAD | cut -c1-12` and the `nodejs.org` index).
Look for the agent's `COMMIT=`, `NODE_VERSION=` and `NODE_DATE=` lines matching the world. Then the
honest beat, where the two research directories landed:

```bash
for i in 0 1; do echo "moca-sandbox-$i:"; kubectl -n moca-sandbox exec moca-sandbox-$i -c sandbox -- ls /workspace; done
```

Both users' turns lease the same pods (section 7).

**L4 check (operator), after the acts.** This is spec §10's third risk: the passthrough path must
keep connections 1:1. Read the counters again (as in the baseline), and while two users' turns are
running at once, count the established connections inside the supervisor pod, on 8443 (from the
router) and on 8080 (from the sidecar). Read both socket tables: ghostunnel is a Go program, and
its `0.0.0.0:8443` listener is a dual-stack IPv6 socket, so the router's connections appear in
`/proc/net/tcp6` (as `::ffff:` addresses), not in `/proc/net/tcp`:

```bash
kubectl -n moca exec deploy/moca-supervisor -c supervisor -- awk \
  '$4 == "01" { split($2, a, ":"); if (a[2] == "20FB") s++; if (a[2] == "1F90") d++ }
   END { print "8443:", s + 0, "8080:", d + 0 }' /proc/net/tcp /proc/net/tcp6
```

Look for: the two numbers equal, and as many as the clients connected (two concurrent turns from
two laptops give at least 2). A router that pooled would show fewer 8443 connections than clients.
Take two readings a few seconds apart: the sidecar's `tcpSocket` readiness probe and keep-alive
connections come and go. Stop any `port-forward` to the supervisor first, since its connections
count on 8080 too.

`/metrics` has no per-connection hand-off counter, so record `handoff_retries`, `handoff_failures`
and `over_admission` before and after as context only. `over_admission` is not a pooling signal on
its own: in the Kind spike it rose once per turn, with no proxy in front at all. If the connections
are not 1:1, the fallback is an L4 `LoadBalancer` Service for the sidecar's port.

### 9.4 Record

Post on rossoctl/moca#423, with the go-ahead: the commit and image, the setup tail, the smoke
summary, the probe and kube-API re-checks, each act's result, the connection counts and counters,
and any fallback applied (the Redis SCC patch, the node-CIDR policy). Then tick slice 1 in epic
#426.

### 9.5 Cleanup

**The smoke's residue.** `smoke.sh` stores a credential `smoke-inference` and creates sessions,
all under the subject `smoke:1`, and deletes none of them. Deleting the namespaces (below) removes
them. To keep the stack, delete them through the control plane with a token minted the way the
smoke mints it, inside the control-plane pod:

```bash
kubectl -n moca port-forward svc/moca-control-plane 18090:8080 >/dev/null 2>&1 &
PF=$!; sleep 3
HDR="$(mktemp)"
kubectl -n moca exec deploy/moca-control-plane -c control-plane -- \
  node --import tsx --input-type=module -e \
  "import { readFileSync } from 'node:fs'; import { makeSigner } from './src/token.ts';
   const s = makeSigner(readFileSync('/run/credentials/SH_SESSION_TOKEN_PRIVATE_KEY', 'utf8'));
   process.stdout.write(s.mint({ sub: 'smoke:1', tenant: 'smoke:1', roles: [], scope: ['api'], ttlSeconds: 900 }));" |
  sed 's/^/Authorization: Bearer /' >"$HDR"
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H @"$HDR" http://127.0.0.1:18090/v1/credentials/smoke-inference
for id in $(curl -s -H @"$HDR" http://127.0.0.1:18090/v1/sessions | jq -r '.sessions[].sessionId'); do
  curl -s -o /dev/null -w "$id %{http_code}\n" -X DELETE -H @"$HDR" "http://127.0.0.1:18090/v1/sessions/$id"
done
rm -f "$HDR"; kill "$PF"
```

Each delete answers 204.

**On each laptop,** delete the run's sessions (`mocactl sessions delete ID`) and credentials
(`mocactl credentials delete NAME`), and run
`mocactl logout` (it revokes the login on the control plane and deletes `auth.json`). On the cluster, delete the
three namespaces (`moca`, `moca-sandbox`, `moca-credentials`); deleting `moca` deletes the Redis
PVC with it. The `nonroot-v2` grants are cluster objects:
`oc adm policy remove-scc-from-user nonroot-v2 -z <sa> -n <ns>` for each ServiceAccount.

## 10. Troubleshooting

The commands here are written for Kind (`--context kind-moca`, as `setup.sh` and `smoke.sh` always
pin it). On OpenShift, drop `--context kind-moca`.

**Kind on macOS with Podman.** Both workarounds were needed on the Task 16 run (macOS arm64, Podman
5.7.1 behind the `docker` CLI). Neither is expected on Linux with Docker.

- **A proxy in your shell.** `kind create` copies `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` into the
  node's containerd. A proxy on `127.0.0.1` then points at the node itself, and in-cluster pulls
  (`redis:7-alpine`) fail with `proxyconnect tcp: dial tcp 127.0.0.1:...`. Create the cluster
  without them, then run `setup.sh` as usual (it reuses an existing `moca` cluster):

  ```bash
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u NO_PROXY -u no_proxy \
    kind create cluster --name moca
  ```

  A cluster already created with the proxy has to be deleted and recreated.

- **Flaky DNS from pods.** The node's `/etc/resolv.conf` from the Podman network lists an IPv6
  nameserver first that is unreachable, and the IPv4 one timed out under load. Research turns then
  fail with `Could not resolve host`. Point CoreDNS at public resolvers:

  ```bash
  kubectl --context kind-moca -n kube-system get configmap coredns -o yaml |
    sed 's#forward . /etc/resolv.conf#forward . 1.1.1.1 8.8.8.8#' |
    kubectl --context kind-moca apply -f -
  kubectl --context kind-moca -n kube-system rollout restart deployment/coredns
  ```

  Before suspecting the egress policy, look at
  `kubectl --context kind-moca -n kube-system logs -l k8s-app=kube-dns` for upstream errors.

**Where the smoke keeps its logs.** On any failed claim, `smoke.sh` keeps its working directory
and prints `logs kept in <dir>` (a `mktemp -d` directory, mode 0700). It holds the port-forward
logs and each turn's SSE stream; the files holding tokens are deleted first. A run that passes
removes it. A smoke that stops before the claims (`port-forward to the supervisor never came up`)
prints the port-forward log itself and keeps nothing. In CI, the directory is in the
`k8s-kind-e2e-logs` artifact.

**The generated MU1 keys sit in the `moca-genkeys` pod's log until `--rm` deletes it.** The
generator writes the four values to its stdout, which `setup.sh` reads over the attach, so for the
pod's few seconds of life they are also in its container log on the node, readable by anyone with
`pods/log` in `moca`. `--rm` deletes the pod and its log when the run completes. If `setup.sh` is
killed in that window, delete it yourself:
`kubectl --context kind-moca -n moca delete pod moca-genkeys --ignore-not-found` (`setup.sh` also deletes a leftover one before it starts).

**On single-node Kind, a sandbox can reach the kube API and its own node's kubelet.**
`kubernetes.default.svc:443` and the node's port 10250 are open from a sandbox, although the
egress rule excepts `10.0.0.0/8`. kindnet enforces NetworkPolicy only in the forwarding path, and
pod-to-own-node traffic never passes it. The exposure is anonymous only: sandboxes mount no
ServiceAccount token, so `/version` answers and `secrets` is forbidden. No manifest change can fix
it on kindnet, so the smoke reports it as a note on Kind and enforces it on `--target ocp`
(section 9.2). Kind CI therefore does not prove the kube-API carve-out; the OpenShift run does.
kindnet also accepts all UDP/53, so the DNS policies are not exercised on Kind either.

**Kubelet probes and the node-CIDR fallback.** If NetworkPolicy filtered the kubelet's probes, the
supervisor (8081) and control plane (8080) would never become Ready, with probe timeouts in
`kubectl describe pod`. The fallback (spec §10) is a per-overlay policy allowing ingress from the
node CIDR to those two ports:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: probes-from-nodes, namespace: moca }
spec:
  podSelector:
    {
      matchExpressions: [{ key: app, operator: In, values: [moca-supervisor, moca-control-plane] }],
    }
  policyTypes: [Ingress]
  ingress:
    - from: [{ ipBlock: { cidr: <node CIDR> } }]
      ports: [{ protocol: TCP, port: 8081 }, { protocol: TCP, port: 8080 }]
```

**It was not needed on Kind:** kindnet accepts traffic originated by the node's root user before
any policy, which covers the kubelet. It is still to be checked on OVN-Kubernetes (section 9.2).

**The control plane stays 0/1.** It reconnects to Redis forever, with a bounded backoff, and its
`/readyz` fails fast while Redis is down, so it recovers by itself once Redis is up (the common case
on a first apply, since everything is applied at once). If it stays unready, its log shows
`[control-plane] redis client error: ...`; check `redis-0`. Two smokes run back to back can catch
claim 5 inside that 5–10 s reconnect window after the previous run's Redis restart: wait for
`/readyz`, or re-run `setup.sh`, in between.

**`only 0 of N sandboxes attached to the relay`.** The relay retries each sandbox's presence write
until it lands or the sandbox detaches, so a late Redis delays the records but no longer loses
them. If the count stays short, the message names the two logs to read:
`kubectl --context kind-moca -n moca logs deployment/sandbox-relay` (`presence put failed ...`)
and `kubectl --context kind-moca -n moca-sandbox logs statefulset/moca-sandbox`.

**`redis-0` stays Pending.** Its PVC binds only through a default StorageClass. `setup.sh` warns
when the cluster has none: mark one default (`storageclass.kubernetes.io/is-default-class=true`).

**A container restarted.** Smoke claim 11 fails on any restart in either namespace. The likeliest is
the supervisor OOM-killed at its 1Gi limit (`kubectl --context kind-moca -n moca describe pod` shows `OOMKilled`):
raise the memory request and limit together (section 4). A worker that dies inside the pod is not a
container restart: look for `worker_exit` in the supervisor's log.

**Claim 12 notes `could not tell affinity from luck`.** Its four first turns run at once so the
least-loaded choice spreads them over the sandboxes; when they all land on one, every second turn
matches by luck too. The claim still passes; re-run the smoke for a run that proves affinity. A
claim 12 FAIL names the session that moved and both pod names.

**The supervisor never becomes Ready on a pulled image.** The published `latest` may predate
`/readyz`, so the startup probe fails. Use `--build` on Kind, or a branch image with `--image` on
OCP.

**`port-forward` is filtered.** Not seen on Kind (port 8080 has no ingress rule at all, yet answers
through `port-forward`). On a CNI that does filter it, smoke claims 1, 3 and 5 fail; the fallback is
an allow from the node CIDR on that overlay, as for the probes.

## 11. P4 on Kubernetes: microVM hosts outside the cluster

P6 runs in the cluster; only the P4 microVM tier needs a KVM host (bare metal or a nested-virt VM).
Each such host runs `microvm-worker` and attaches to the in-cluster relay over TLS, through an L4
sidecar (ghostunnel) behind the passthrough Route `moca-relay`. The cluster issues each host's
token; the relay reads it from a mounted Secret on every attach, so adding a host restarts nothing.
Design:
[`docs/specs/2026-10-04-p6-on-kubernetes-slice2-design.md`](../../docs/specs/2026-10-04-p6-on-kubernetes-slice2-design.md).

**OpenShift only**: `setup.sh` refuses `SH_P4_SANDBOX_IDS` on kind and on `ocp-single`. A stack
may run P4 hosts beside its container sandboxes, and several P4 hosts: since P6.3 (#425) a session
returns to the sandbox that holds its workspace
([`docs/specs/2026-10-04-p6-on-kubernetes-slice3-design.md`](../../docs/specs/2026-10-04-p6-on-kubernetes-slice3-design.md)).

### 11.1 Container sandboxes and P4 together, or P4 only

```bash
# A mixed stack: two container sandboxes and one P4 host.
SH_SANDBOX_COUNT=2 SH_P4_SANDBOX_IDS=moca_microvm_0 deploy/k8s/setup.sh --target ocp
# P4 only.
SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0 deploy/k8s/setup.sh --target ocp
```

**A mixed stack is tiered** (`SH_SANDBOX_COUNT` above 0 and `SH_P4_SANDBOX_IDS` not empty):
`setup.sh` writes `SH_SANDBOX_TIERS=container,microvm` to `moca-settings`, which the supervisor and
the control plane both read, and logs `two sandbox tiers`. A session is created in a tier and every
turn of it runs there. A user picks the tier at creation, in mocactl's New Session overlay or with
`mocactl run --new --option sandboxTier=microvm`; a session that names none gets the default tier.

- **`SH_SANDBOX_DEFAULT_TIER`** (`container` or `microvm`, default `container`) sets that default.
  It is sticky, stored in `moca-setup`; `SH_SANDBOX_DEFAULT_TIER=` clears it back to `container`.
  Any other value is refused before anything is stored. Kind is never tiered and stores none, but it
  refuses a bad value too.
- **A single-tier stack stays untiered** (containers only, or P4 only): both tier settings are
  empty, and a stored `SH_SANDBOX_DEFAULT_TIER` is kept but unused. Untiered on purpose: a worker
  older than P6.3 advertises no tier, and a tiered supervisor would exclude it.
- **On a mixed stack every worker must be P6.3 or later** (the container sandboxes' image and each
  P4 host's `microvm-worker`): an older one advertises no tier and receives no sessions.
- **Any settings change now rolls the supervisor too** (section 2): a change of client id or admins
  restarts both Deployments, and the first run of a P6.3 `setup.sh` on an existing stack rolls both
  once, because the settings it hashes gained the two tier keys.
- **That first run also recreates the relay and rolls the container sandboxes** (section 2), on
  every stack, tiered or not. Every sandbox and P4 host detaches while the relay is down, and every
  container session's workspace is reset with no `workspace reset` notice, since each session
  returns to a sandbox of the same name. Run it at a quiet time.

The rest applies to every stack with P4 hosts:

- IDs match `^[A-Za-z_][A-Za-z0-9_]*$` (no dashes: the relay looks each up by name), comma-separated,
  each listed once.
- `DIR` is reserved and refused: `SH_RELAY_TOKEN_DIR` is the relay's token-directory setting, so
  the relay refuses that ID before any lookup.
- The list is sticky like every other input; `SH_P4_SANDBOX_IDS=` (empty) clears it (see 11.4 for
  the objects that clearing leaves behind).
- `--relay-tls-cert FILE --relay-tls-key FILE` installs an operator certificate for
  `moca-relay-moca.<apps domain>`. Without them a self-signed one is generated once and kept.
- Every bundle carries the relay certificate as `relay-ca.crt` whenever it is **self-issued**
  (`setup.sh`'s own, or a self-signed one you supplied). A certificate issued by another CA is not
  shipped: that CA must be one the hosts already trust system-wide.

`setup.sh` ends by printing, per ID, the bundle path and the commands to install it:

```
P4 hosts attach to https://moca-relay-moca.<apps domain> (the relay, TLS passthrough). One bundle each -- it holds
that host's relay token, so copy it straight to the host, install it, then delete the copy:
  moca_microvm_0:  <checkout>/deploy/k8s/.generated/ocp/p4/moca_microvm_0
    ssh <kvm-host> rm -r moca-p4-moca_microvm_0   (an earlier copy, if any: scp -r would nest into it)
    scp -r <checkout>/deploy/k8s/.generated/ocp/p4/moca_microvm_0 <kvm-host>:moca-p4-moca_microvm_0
    on <kvm-host>, from a moca checkout:  sudo deploy/microvm/setup-microvm.sh --remote ~/moca-p4-moca_microvm_0
```

The bundle (`worker.env` and `relay-ca.crt`, mode 0600, in a 0700 directory) holds that host's relay
token. Copy it straight to its host and delete the copy once installed.

**Re-copying a bundle** (after a new certificate, or an ID removed and added again): first remove
`~/moca-p4-<id>` on the host, as the printed `ssh <kvm-host> rm -r moca-p4-<id>` does.
`scp -r <dir> <kvm-host>:moca-p4-<id>` into an existing directory nests the copy as
`moca-p4-<id>/<id>`, and `--remote` would then install the stale bundle left at the top. On a first
copy the `rm` only reports that nothing is there.

### 11.2 Install a host

The host needs what `deploy/microvm/P4-ON-P6.md` lists for P4 (`/dev/kvm`, Firecracker and jailer,
a golden snapshot, Go or `MICROVM_BIN`) and outbound TCP 443 to the relay Route host. Check that
first with `curl -v https://moca-relay-moca.<apps domain>`: a completed TLS handshake proves it is
reachable, even when curl then stops at a certificate verification error (as it does with the
default self-signed certificate); a timeout or `Connection refused` does not. It does **not** need
P6 installed.

`setup-microvm.sh --remote <bundle>` installs the worker with the bundle's address, TLS, ID and
token (the cluster's token replaces any local one), installs `relay-ca.crt` as
`/etc/serverless-harness/microvm-relay-ca.crt`, and swaps the worker's drop-in to
`50-moca-remote.conf`. Of a local P6 it touches only the tier files: on a host an earlier mixed
local run tiered, it removes `microvm-tiers.env` and both drop-ins
(`sh-supervisor.service.d/50-microvm-tiers.conf`, `sh-control-plane.service.d/50-microvm-tiers.conf`)
and try-restarts the installed `sh-supervisor` and `sh-control-plane`, because the host's own P6 is
container-only from then on (P6.3 spec §7).

It finishes only once the worker's **current** process has logged `attached, serving execs` and the
attach has then held for `MICROVM_ATTACH_SETTLE` seconds (default 5, at least 1) with no reconnect,
all within `MICROVM_ATTACH_TIMEOUT` (default 60; a hold that starts before then may finish). The
hold matters because the worker logs `attached` when its stream opens, before the relay checks the
token; a refused token ends the stream milliseconds later. Otherwise it dies naming that process's
journal (`journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=…`), which carries the TLS or token
error.

Running `setup-microvm.sh` again **without** `--remote` switches the host back to its local P6
relay, restoring its local token.

### 11.3 Verify

```bash
K8S_LIVE_SMOKE=1 SMOKE_MODEL_URL=… SMOKE_MODEL_TOKEN=… deploy/k8s/smoke.sh --target ocp --tier p4
```

Claims 1, 5 and 6 are the container tier's. P2: every P4 ID is attached. On a P4-only (untiered)
stack no container sandbox may be; on a tiered stack container sandboxes may be attached beside
them, and each P4 ID's record must advertise the `microvm` tier (`moca.dev/tier`). P3: a turn runs
on a kernel that is no node's and writes a file. P4: a second turn reads it back. P6: through the relay Route, a wrong attach token is refused at the relay, and SandboxExec is
not served even with the exec token. P7 (only with `SMOKE_P4_ADD_ID=<scratch id>`): `setup.sh` adds
that ID and removes it again, both runs keeping the sticky `SH_SANDBOX_COUNT` (so a mixed stack
keeps its container sandboxes), and the relay pod is the same one, with the same start time and no
restart. Claims 7–12 do not run on this tier. On a tiered stack every smoke session asks for its tier
(`microvm` here, `container` without `--tier p4`) and the smoke prints a `note` naming the stack's
tiers, so both smokes test the right tier whatever the default; on an untiered stack sessions name
none. A `moca-settings` the smoke cannot read is a FAIL, not "untiered".

### 11.4 Add, revoke, and their timing

- **Add** an ID to the list and re-run `setup.sh`: the new token reaches the relay's directory
  within the kubelet's Secret sync (about a minute; P7 prints the measured time), and the host's
  next attach succeeds. Attached hosts stay attached.
- **Revoke** by removing the ID: its token and bundle are deleted, and once the removal reaches
  the relay's directory (the same kubelet Secret sync, about a minute) its **next** attach is
  refused. A host already attached stays attached until its stream drops; to cut it off at once,
  restart the relay (`kubectl -n moca rollout restart deployment/sandbox-relay`), which drops every
  attached sandbox.
- **Clear** every ID (`SH_P4_SANDBOX_IDS=`; on a P4-only stack, with `SH_SANDBOX_COUNT` back above
  0 to return to container sandboxes; a mixed stack becomes untiered): the relay pod loses its TLS
  sidecar, so nothing listens on 8444 any more. `setup.sh` applies with a non-pruning
  `kubectl apply -k`, though, so four objects of the p4-relay component stay behind. Delete them
  by hand:

  ```bash
  kubectl -n moca delete route/moca-relay service/sandbox-relay-tls \
    networkpolicy/sandbox-relay-from-router secret/moca-relay-tls
  ```

  Secret `moca-relay-sandbox-tokens` stays, emptied, on purpose: an emptied Secret revokes every
  host deterministically. Deleting `moca-relay-tls` means a later switch back to P4 generates a new
  self-signed certificate (unless `--relay-tls-cert` is given), so every bundle is then re-copied.

### 11.5 Troubleshooting

The relay pod has two containers here, and the `tls` sidecar is listed first. The pod's
`kubectl.kubernetes.io/default-container: sandbox-relay` annotation sends plain `kubectl logs` and
`kubectl exec` to the relay; name the sidecar to read it:
`kubectl -n moca logs deployment/sandbox-relay -c tls`.

**`setup-microvm.sh --remote` dies with `did not stay attached`.** The message names the worker
journal to read. A wrong or revoked token shows there as `attached, serving execs` followed at once
by `stream ended (…); reconnecting`: the bundle is stale, or its ID is no longer listed. Re-run
`setup.sh`, copy the fresh bundle and install it again.

**The worker journal says `missing selected ALPN property`.** The relay sidecar is not negotiating
`h2` (`--alpn h2` in `overlays/ocp/p4-relay`); grpc-go 1.67+ requires it.

**`x509: certificate signed by unknown authority`.** The bundle's `relay-ca.crt` was not installed
(re-run `--remote` with the full bundle), or an operator certificate does not chain to a CA the host
trusts.

**The worker attaches, then drops every few minutes.** The router's idle timeout is shorter than the
stream's quiet periods. The Route carries `haproxy.router.openshift.io/timeout: 5m`, above the
worker's 30 s keepalive; check the annotation survived.

**`P2` fails with a P4 ID missing.** The host's worker is not attached; read its journal on the
host (`journalctl -u microvm-worker`).

## 12. Single-namespace dev/test target (`--target ocp-single`)

For a developer or CI tenant on a shared OpenShift cluster where you have **edit rights in one
namespace and nothing else**: no cluster-scope RBAC, no SCC grants, no permission to read
cluster-scoped objects. The whole stack -- supervisor, relay, control plane, Redis, the container
sandbox pool, every Secret, the credential Role -- runs in that one namespace, reached by
`port-forward` as on Kind -- or, when your tenant has a custom domain, by opt-in Routes (§12.5).

```bash
export LOG_DIR=/tmp/kagenti/tdd/moca; mkdir -p "$LOG_DIR"
SH_GITHUB_CLIENT_ID=<client id> SH_SINGLE_NAMESPACE=<your-namespace> \
  deploy/k8s/setup.sh --target ocp-single >"$LOG_DIR/t-single-setup.log" 2>&1; echo "EXIT:$?"
tail -4 "$LOG_DIR/t-single-setup.log"
```

The namespace must already exist (creating one needs cluster scope, which this target assumes you
lack); `SH_SINGLE_NAMESPACE` defaults to `moca-single`. A ResourceQuota of 8 CPU / 32 Gi covers the
default stack several times over (§4). The one requirement the cluster must meet anyway: a default
StorageClass, for the Redis PVC.

### 12.1 How it stays within the namespace

Everything the `ocp` target does outside the namespace is skipped or replaced:

| The `ocp` target                                                  | `ocp-single`                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| creates the `moca`, `moca-sandbox`, `moca-credentials` namespaces | uses your existing namespace (existence checked, never created)                                                                                                       |
| grants `nonroot-v2` to each ServiceAccount (`oc adm`)             | no SCC: every explicit UID/GID is stripped, restricted-v2 assigns from the namespace's range                                                                          |
| Routes, `ingresses.config/cluster` read, TLS secrets              | no Routes by default (`kubectl port-forward`, like Kind); opt-in Routes with `SH_ROUTE_DOMAIN` (§12.5), which needs no cluster-scope read because you give the domain |
| requires `oc`                                                     | kubectl only                                                                                                                                                          |

The isolation the base draws from the namespace boundary moves to pod-label NetworkPolicies: the
default-deny, the sandbox's egress (relay attach port and the public internet only), the relay's
exec-port rule (supervisor only) are all enforced per pod label. The sandbox's egress policy is
the one that carries the isolation: a tenant's own namespace policies can widen ingress (§12.3).
The sandboxes mount no ServiceAccount token, so the kube API refuses them even where the cluster
leaves it reachable (§12.3).

Three consequences of the collapse, accepted for a dev/test tenant:

- The secrets the base keeps out of `moca-sandbox` (the exec token, the Redis password, the MU1
  keys) share the namespace with the sandbox pods -- anyone who can edit the namespace can read
  them.
- The control plane's Secret Role (`moca-control-plane-credentials`: get, create, update, patch,
  delete; no list) is scoped to `moca-credentials` in the base, so it reaches user credentials
  only. In one namespace it reaches **every** Secret: the relay attach and exec tokens, the Redis
  password, the MU1 keys. A compromised control plane can read and overwrite platform secrets by
  name, not just user credentials.
- The sandbox workspace and home are `emptyDir`s, so they are lost when a sandbox pod restarts
  (they are container-local in the base too).

### 12.2 Smoke

```bash
K8S_LIVE_SMOKE=1 SMOKE_MODEL_URL=<endpoint> SMOKE_MODEL_TOKEN=<token> \
  deploy/k8s/smoke.sh --target ocp-single >"$LOG_DIR/t-single-smoke.log" 2>&1; echo "EXIT:$?"
```

There is no in-pod mock model on this target (the `kind-ci` one rides the dev.local image), so the
smoke needs a real model credential, like `--target ocp`. The claims are the container tier's:
pods up, sandboxes attached, authenticated turns in a sandbox, isolation (redis, relay exec,
metadata BLOCKED; relay attach OPEN), drain, Redis-restart persistence, no restarts, and a session
staying on its sandbox (claim 12). The kube API
probe is reported as a `note`, not a claim (§12.3). For a custom namespace, export the same
`SH_SINGLE_NAMESPACE` you installed with; without it, smoke reads the `moca-setup` ConfigMap in the
kubeconfig's current namespace, so it finds the stack only when the context is already set to it.

### 12.3 Verified

Brought up and smoked (11/11) on a shared OpenShift 4.x tenant with edit-only namespace rights, an
8 CPU / 32 Gi quota, RHACS image admission active, and no SCC grants: restricted-v2 assigned
UID/GID/fsGroup 1002610000 from the namespace's range, the emptyDirs over `/workspace` and
`/home/sandbox` were owned by the assigned fsGroup, and the cluster's CNI (Calico, on IBM Cloud
ROKS) enforced the pod-label policies, with the exceptions below.

**The kube-API Service VIP was reachable** from the sandbox. The VIP (`172.21.0.1:443`) is
DNAT'd to ROKS's node-local apiserver proxy, `172.20.0.1:2040`, and the sandbox reaches that
address directly too, although it is inside the excepted `172.16.0.0/12`; other ports on it, other
private IPs, and the DNS VIP were blocked. The namespace's own policies do not explain it, so a
cluster-level allowance does (not readable with namespace rights). The sandboxes mount no
ServiceAccount token, so the API refuses them; treat it as defence-in-depth lost, not as an
escape.

**The node network is outside the egress `except` list.** That tenant's nodes sit on a
publicly routable (non-RFC 1918) range, so the sandbox's internet rule admits it: the sandbox
reached its node's kubelet (10250) and SSH (22). The `except` list covers RFC 1918, CGNAT and
link-local only; on a cluster whose node or infrastructure network is publicly routable, add
those CIDRs with `SH_SANDBOX_EGRESS_EXCEPT` (§6, #446).

**A tenant `allow-same-namespace` policy** (ingress from any pod in the namespace, to every pod)
was preinstalled. Policies are additive, so the overlay's ingress rules (the relay's
supervisor-only exec port, Redis) admit any pod in the namespace there. The sandboxes stay
isolated because their own egress policy is enforced: Redis and the relay exec port were BLOCKED
from a sandbox.

### 12.4 What does not work here

**P4 microVM hosts** cannot attach: their path is the relay's OpenShift Route (§11), which this
target does not render. Container sandboxes only, so this target is never tiered; a given
`SH_SANDBOX_DEFAULT_TIER` is stored in `moca-setup` but unused.

**Renaming on re-run**: `SH_SINGLE_NAMESPACE` is not sticky -- it is validated and applied fresh
every run. Pointing it at a different namespace installs a second stack there; the first one stays
until its namespace is deleted.

### 12.5 Routes, opt-in (`SH_ROUTE_DOMAIN`)

The port-forwards are the default because the target cannot learn a Route hostname on its own:
reading the cluster's apps domain (`ingresses.config/cluster`) is a cluster-scoped read, which this
target assumes you lack. But a tenant whose operator set up a custom domain -- a wildcard DNS
record and certificate for `*.<namespace>.<domain>`, plus an ingress controller -- can be reached
properly. Opt in with the domain:

```bash
SH_GITHUB_CLIENT_ID=<client id> SH_SINGLE_NAMESPACE=<ns> SH_ROUTE_DOMAIN=<domain> \
  deploy/k8s/setup.sh --target ocp-single [--tls-secret NAME]
```

Two Routes render, in the namespace: `moca.<domain>` (the supervisor, TLS **passthrough** to a
ghostunnel L4 sidecar, exactly §11's shape -- an edge Route there would silently break the
supervisor's per-connection routing) and `moca-control-plane.<domain>` (the control plane, ordinary
edge). `moca-settings`'s `SH_PUBLIC_HARNESS_URL` becomes the supervisor's Route, so `/v1/discovery`
advertises it and mocactl needs no port-forward:

```bash
mocactl --control-plane-url https://moca-control-plane.<domain> login
```

The supervisor's certificate comes from one of three sources, in this order:

| Source                           | What setup.sh does                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `--tls-secret NAME`              | references a preinstalled `kubernetes.io/tls` Secret by name; never copies it          |
| `--tls-cert FILE --tls-key FILE` | installs the pair as the `moca-supervisor-tls` Secret                                  |
| neither                          | generates a self-signed one, and says so (`NODE_EXTRA_CA_CERTS`, as on `--target ocp`) |

The edge Route embeds no certificate: the ingress controller serves its own (on a custom-domain
tenant, that is the operator's wildcard; on a standard cluster, the router's default for the apps
domain).

`SH_ROUTE_DOMAIN` and `--tls-secret` are sticky like every input: a re-run without them keeps the
Routes (and the certificate) it finds in `moca-setup`; `SH_ROUTE_DOMAIN=` set-but-empty turns the
Routes off and returns to port-forward access. The three certificate sources are mutually
exclusive per run (`--tls-secret` with `--tls-cert` is refused), and `--tls-cert`/`--tls-key` on a
re-run _replaces_ a saved `--tls-secret` rather than being silently beaten by it -- the saved name
is dropped from `moca-setup`, so a later re-run with no certificate input cannot resurrect it over
what the pair installed. The smoke still reaches the stack by port-forward, Routes or not.

The §12.3 tenant verified all of it: the operator's Let's Encrypt wildcard for
`*.moca-ns.vpc-int.res.ibm.com` (served by `--tls-secret`, and also covering the edge Route as the
controller's default certificate), a namespace-scoped ingress controller admitted by the
`policy-group.network.openshift.io/ingress` selector, and mocactl logins and turns over the Routes.
