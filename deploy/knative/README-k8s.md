# Deploying on generic Kubernetes

`deploy/knative/setup-k8s.sh` stands up the moca stack on a **vanilla
Kubernetes cluster** — the sibling of `setup-kind.sh` (Kind) and `setup-ocp.sh`
(OpenShift). It installs Knative Serving + Kourier, the agent-sandbox controller,
Redis, the sandbox pool, the LLM-credentials secret, and the harness Knative Service,
reusing the shared base manifests (`deploy/knative/*.yaml`) with cluster-specifics
injected via flags — no forked per-cluster YAMLs.

## When to use this vs. setup-kind.sh / setup-ocp.sh

|                 | `setup-kind.sh`              | `setup-k8s.sh` (this)                                                                    | `setup-ocp.sh`                          |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| Target          | local Kind (single node)     | any real/vanilla K8s cluster                                                             | OpenShift 4.x                           |
| Knative install | raw manifests                | raw manifests                                                                            | OLM operator (OpenShift Serverless)     |
| KEDA install    | raw manifests                | raw manifests (`--with-keda`)                                                            | OLM operator (`--with-keda`)            |
| Images          | builds locally + `kind load` | **prebuilt refs** (`--image`); optional in-cluster build via `setup-shipwright-build.sh` | prebuilt refs / built-in `oc new-build` |
| Namespace       | `default`                    | `--namespace`                                                                            | `--namespace`                           |
| StorageClass    | cluster default              | `--storage-class` (default: cluster default)                                             | cluster default                         |
| Ingress         | Kourier port-forward         | port-forward or `--ingress nodeport`                                                     | auto-created Route                      |

Use `setup-kind.sh` for local dev, `setup-ocp.sh` on OpenShift (where OLM manages the
operators and Routes are automatic), and **`setup-k8s.sh` for any other Kubernetes** —
where there is no OLM (so operators install via raw manifests) and no automatic
ingress domain (so you reach the service by port-forward or NodePort).

## Prerequisites

- **kubectl** configured to the target cluster (`--context` or current-context)
- A **default StorageClass**, or pass `--storage-class`
- **Prebuilt images** for the harness + sandbox (this script does not build — see below)
- A model credential:
  - `ANTHROPIC_API_KEY` (direct), **or**
  - `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (Bearer-token gateway or self-hosted endpoint)

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-...
./deploy/knative/setup-k8s.sh \
  --namespace moca \
  --image ghcr.io/rossoctl/moca:latest \
  --sandbox-image ghcr.io/rossoctl/moca-sandbox:latest
```

When it finishes it prints how to reach the service (port-forward by default):

```bash
kubectl port-forward -n kourier-system svc/kourier 8080:80
curl -H 'Host: moca.moca.example.com' \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"Hello"}' http://localhost:8080/turn
```

Preview everything without applying: add `--dry-run` (prints the rendered manifests).

## Options

```
--namespace <ns>       Target namespace (default: default)
--image <ref>          Harness image, prebuilt
--sandbox-image <ref>  Sandbox image, prebuilt
--storage-class <sc>   StorageClass for sandbox /workspace PVCs (default: cluster default)
--ingress <mode>       none (port-forward) | nodeport   (default: none)
--with-keda            Install KEDA for the async-leaf ScaledJob path (default: off)
--context <ctx>        kubectl context (default: current-context)
--dry-run              Print rendered manifests without applying
```

Environment: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`;
`SH_MODEL`, `SH_MODEL_CUSTOM`; `KNATIVE_VERSION`, `KEDA_VERSION`.

## Image tags: `:latest` vs. pinned releases

The `:latest` default tracks whatever `build.yaml` last pushed from `main` — fine for
day-to-day dev, but don't rely on it to install a specific release. Two traps:

- **Tag-name mismatch**: pushing git tag `v0.3.0` publishes image tag `0.3.0` (no `v`
  prefix) — `docker/metadata-action`'s `semver` pattern strips it.
- **Stale Revisions**: every manifest here sets `imagePullPolicy: IfNotPresent`. Knative
  only cuts a new Revision when the rendered manifest text changes, so if you stay on
  `:latest` and only the underlying digest changes, `kubectl apply` sees no diff, no new
  Revision is created, and nodes can keep serving the previously cached image.

To install a specific release, pass the versioned tag explicitly instead of relying on
the default:

```bash
--image ghcr.io/rossoctl/moca:0.3.0 \
--sandbox-image ghcr.io/rossoctl/moca-sandbox:0.3.0
```

## Building the images

Unlike Kind, this script takes **prebuilt** images — build and push them yourself,
then pass the refs via `--image` / `--sandbox-image`. Any registry the cluster can pull
from works, including an in-cluster registry (pass its address as the image ref).

Why not build in the script: OpenShift has a built-in builder (`oc new-build`) that
`setup-ocp.sh` can assume, but vanilla Kubernetes has no standard in-cluster build
system, so this script stays builder-agnostic and just consumes an image ref.

### Rebuilding images (including in-cluster)

Building is decoupled from deploy, so use whatever fits — this is handy for iterating on
harness code for testing/experimentation. Whatever you pick, pass the resulting ref via
`--image`/`--sandbox-image`:

- **Local build + push** to any registry the cluster can reach:
  ```bash
  docker build -t <registry>/moca:dev .            # harness (repo root)
  docker build -f deploy/knative/sandbox.Dockerfile -t <registry>/moca-sandbox:dev deploy/knative
  docker push <registry>/moca:dev && docker push <registry>/moca-sandbox:dev
  ./deploy/knative/setup-k8s.sh --image <registry>/moca:dev \
      --sandbox-image <registry>/moca-sandbox:dev ...
  ```
- **In-cluster build with Shipwright** — if your cluster has the
  [Shipwright](https://shipwright.io) Build controller installed, use
  `deploy/knative/setup-shipwright-build.sh` to build straight from a git branch to an
  in-cluster (or any) registry, with no local Docker daemon and nothing pushed over the
  internet:
  ```bash
  ./deploy/knative/setup-shipwright-build.sh \
    --image-repo registry.cr-system.svc.cluster.local:5000/moca \
    --namespace moca --with-sandbox
  ```
  It prints `HARNESS_IMAGE=`/`SANDBOX_IMAGE=` lines — pass those straight to
  `setup-k8s.sh --image`/`--sandbox-image`. Requires a `ClusterBuildStrategy` already on
  the cluster that can push to your registry (`--strategy`, default `buildah`; use an
  insecure-registry variant like `buildah-insecure-direct` for a plain-HTTP in-cluster
  registry — see [Shipwright's sample strategies](https://github.com/shipwright-io/build/tree/main/samples/buildstrategy)).
  Note: an in-cluster registry referenced by ClusterIP/`.svc` must be reachable _and
  trusted_ by the node container runtime (e.g. listed as an insecure mirror in the node's
  registry config) for the kubelet to pull the image back — this is a cluster-level setting,
  not something either script manages.

## Storage: default class vs. GPFS (IBM Storage Scale)

The sandbox pool's `/workspace` PVCs bind to whatever StorageClass you pick:

- **Default (no flag):** uses the cluster's default StorageClass — works on any cluster.
- **GPFS / IBM Storage Scale:** `--storage-class ibm-scale-csi`. GPFS is a high-performance,
  cluster-wide parallel filesystem — attractive for agent workspaces (fast shared I/O, and
  an eventual path to a shared RWX workspace across sandboxes). Requires the IBM Storage
  Scale CSI driver installed and healthy on the cluster; the pool uses per-sandbox RWO
  volumes on it today.

## Choosing the model

Set the harness model via `SH_MODEL` (default is the harness's built-in default). To target
a **self-hosted, Anthropic-compatible endpoint** (e.g. vLLM / llm-d serving `/v1/messages`)
whose model id is not a built-in Anthropic id, set `SH_MODEL_CUSTOM=1` and point
`ANTHROPIC_BASE_URL` at the endpoint:

```bash
export SH_MODEL=meta-llama/Llama-3.3-70B-Instruct
export SH_MODEL_CUSTOM=1
export ANTHROPIC_AUTH_TOKEN=...            # or a placeholder if the endpoint needs none
export ANTHROPIC_BASE_URL=http://my-model.my-ns.svc.cluster.local:8000
```

To target an **OpenAI-compatible endpoint** (RITS / vLLM / OpenAI / Azure serving
`/v1/chat/completions`), set `SH_MODEL_API=openai-completions` and point
`SH_MODEL_BASE_URL` (or `OPENAI_BASE_URL`) at it:

```bash
export SH_MODEL=ibm-granite/granite-4.1-8b
export SH_MODEL_CUSTOM=1
export SH_MODEL_API=openai-completions
export SH_MODEL_BASE_URL=https://<host>/granite-4-1-8b/v1
export OPENAI_API_KEY=<key>                # standard Bearer auth (default)
```

For an endpoint that authenticates via a **custom header** instead of a Bearer token
(e.g. IBM RITS's `RITS_API_KEY`), keep the secret in a `secretKeyRef` env var and
reference it from `SH_MODEL_HEADERS` via `${VAR}` — the default `Authorization` Bearer
is then stripped:

```bash
export SH_MODEL_AUTH=custom-header
export SH_MODEL_HEADERS='{"RITS_API_KEY":"${RITS_API_KEY}"}'   # RITS_API_KEY supplied via secretKeyRef
```

> Tool-calling is a per-endpoint capability: only routes with the vLLM tool-call parser
> enabled return structured tool calls. Sniff a new model with a tool-requiring prompt first.

## Reaching the service without a port-forward

`--ingress nodeport` patches the Kourier service to `NodePort`, so you can reach the
harness at `http://<node-ip>:<nodeport>` (with the `Host` header) instead of a
port-forward. For a real public endpoint with TLS/auth, put your cluster's ingress
controller or gateway in front of Kourier — that layer is cluster-specific and out of
scope for this generic script.

## What it installs

| Component                 | How                                                                       |
| ------------------------- | ------------------------------------------------------------------------- |
| Knative Serving + Kourier | raw manifests + config patches (autoscaler, PVC/securityContext features) |
| KEDA (optional)           | raw manifest (`--with-keda`)                                              |
| agent-sandbox controller  | `kubectl apply --server-side` (v0.5.0)                                    |
| Redis                     | in-repo Deployment (`redis.yaml`)                                         |
| Sandbox pool              | `sandbox-pool.yaml`, namespaced + storageClass injected                   |
| Harness                   | Knative Service (`service.yaml`) + SA/RBAC                                |

## Cleanup

```bash
kubectl delete namespace <namespace>
```

Cluster-scoped installs shared with other workloads (Knative CRDs/controller, Kourier,
agent-sandbox controller, KEDA) are left in place.
