# Deploying on OpenShift

`deploy/knative/setup-ocp.sh` stands up the moca stack on
**OpenShift 4.20+** — the OpenShift-native sibling of [`setup-kind.sh`](setup-kind.sh).
It installs OpenShift Serverless (Knative + Kourier), Redis, the sandbox pod, the
LLM-credentials secret, and the harness Knative Service, reachable over its
**auto-created OpenShift Route**.

Base bring-up only — see [Scope](#scope) for what is deferred.

## Prerequisites

- **`oc`**, logged in to an OpenShift **4.20+** cluster as **cluster-admin**
  (operator installs + SCC assignment require it).
- A default **StorageClass** for the sandbox's durable `/workspace` PVC (the script fails fast if
  none exists). See the [storage caveat](#storage--scc).
- A model credential:
  - `ANTHROPIC_API_KEY` (direct), **or**
  - `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (Bearer-token gateway, e.g. LiteLLM).
- The harness image. By default the script pulls the published
  `ghcr.io/rossoctl/moca:latest`; override with `--image`.
- **agent-sandbox controller** (kubernetes-sigs v0.5.0) is installed by the script
  (`sandboxes.agents.x-k8s.io`); it creates the `sandbox-0` pod from the Sandbox CR
  and provisions its durable `/workspace` PVC. The harness resolves the pod via the
  CR's `.status.selector` and `kubectl exec`s tool calls into it.

## Quick start

```bash
# 1. Clone (the Pi agent is a submodule)
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca

# 2. Log in to your OpenShift 4.20+ cluster as cluster-admin
oc login --token=... --server=https://api.<cluster>:6443

# 3. Provide a model credential — direct key...
export ANTHROPIC_API_KEY=sk-...
#    ...or a Bearer-token gateway:
# export ANTHROPIC_BASE_URL=https://your-gateway
# export ANTHROPIC_AUTH_TOKEN=...

# 4. Preview without touching the cluster (optional)
./deploy/knative/setup-ocp.sh --dry-run

# 5. Install
./deploy/knative/setup-ocp.sh
```

When it finishes, the script prints the Route URL and a ready-to-run `curl`:

```bash
curl -sk -H 'Content-Type: application/json' \
     -d '{"prompt": "Remember the secret word: pineapple. Reply only with OK."}' \
     https://moca-default.apps.<cluster-domain>/turn | jq .
# => { "sessionId": "019...", "response": "OK" }
```

No Kourier port-forward and no `Host` header are needed — OpenShift Serverless
creates a real Route per Knative Service (`oc get ksvc moca -o jsonpath='{.status.url}'`).

## What it installs

| Component                   | How                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knative Serving (+ Kourier) | **Red Hat OpenShift Serverless Operator** (OLM Subscription in `openshift-serverless`) + a `KnativeServing` CR in `knative-serving`. Kourier is bundled.                                                                     |
| Knative config              | Autoscaler tuning + the `podspec-persistent-volume-claim`/`-write`/`-securitycontext` feature flags are set in the **`KnativeServing` CR spec** (the operator reverts direct `config-*` ConfigMap patches).                  |
| Redis                       | Lightweight in-repo Deployment (`redis:7-alpine`), runs under `restricted-v2`.                                                                                                                                               |
| Sandbox                     | Pre-baked image ([`sandbox.Dockerfile`](sandbox.Dockerfile), `USER 65532`), pulled from GHCR (`ghcr.io/rossoctl/moca-sandbox:latest`, republished by `build.yaml` on every push to `main`; override with `--sandbox-image`). |
| Sandbox `/workspace` PVC    | `ReadWriteOnce` (Sandbox CR `volumeClaimTemplates`), cluster-default StorageClass.                                                                                                                                           |
| Harness                     | Knative Service applied via the [`overlays/ocp`](overlays/ocp) kustomize overlay; SA granted the `nonroot-v2` SCC.                                                                                                           |
| Ingress                     | Auto-created OpenShift Route.                                                                                                                                                                                                |

Manifests are shared with Kind via the `overlays/ocp` overlay — OpenShift tweaks
are kustomize patches, not forked YAMLs.

## Options

```
--namespace <ns>         Target namespace (default: default)
--image <ref>            Harness image (default: ghcr.io/rossoctl/moca:latest)
--sandbox-image <ref>    Sandbox image to pull (default: ghcr.io/rossoctl/moca-sandbox:latest)
--serverless-channel <c> OpenShift Serverless subscription channel (default: stable)
--with-keda              Install KEDA (Custom Metrics Autoscaler Operator) for async leaf
--keda-channel <c>       Custom Metrics Autoscaler channel (default: stable)
--skip-keda              Skip KEDA (default)
--dry-run                Print the commands without executing
-h, --help               Show help
```

> **Pinning a release:** `:latest` tracks `main`, not any specific tag — to install a
> specific release, pass the versioned image tag explicitly (e.g. `:0.3.0`) via `--image`/
> `--sandbox-image` rather than relying on `:latest`. See
> [README-k8s.md](README-k8s.md#image-tags-latest-vs-pinned-releases) for why `:latest` +
> `imagePullPolicy: IfNotPresent` can leave you on a stale image.

The script is **idempotent** — safe to re-run; it skips operators/CRs that already exist.

## Choosing the model

The harness model is set via the `SH_MODEL` environment variable in
[`service.yaml`](service.yaml) (line 37). The default is `claude-haiku-4-5`.

To use a different model, edit `service.yaml` before running the setup script:

```yaml
- name: SH_MODEL
  value: 'claude-sonnet-4-6' # or claude-opus-4-6, claude-haiku-4-5, etc.
```

Or patch the running Knative Service after deployment:

```bash
oc set env ksvc/moca SH_MODEL=claude-sonnet-4-6
```

This triggers an automatic revision rollout. Available model IDs:

| Model      | ID                  | Notes                    |
| ---------- | ------------------- | ------------------------ |
| Haiku 4.5  | `claude-haiku-4-5`  | Default — fast, low cost |
| Sonnet 4.6 | `claude-sonnet-4-6` | Balanced                 |
| Opus 4.6   | `claude-opus-4-6`   | Most capable             |

When using a gateway (LiteLLM, etc.), the model ID must match what the gateway
accepts — consult your gateway's model routing configuration.

### Custom / self-hosted endpoints

For a model id not in the built-in registry, set `SH_MODEL_CUSTOM=1` and select the wire
protocol with `SH_MODEL_API`:

- **Anthropic-compatible** (`/v1/messages`; direct Anthropic or LiteLLM Anthropic-format) —
  the default. Point `ANTHROPIC_BASE_URL` (or `SH_MODEL_BASE_URL`) at the endpoint.
- **OpenAI-compatible** (`/v1/chat/completions`; RITS / vLLM / OpenAI / Azure) — set
  `SH_MODEL_API=openai-completions` and point `SH_MODEL_BASE_URL` (or `OPENAI_BASE_URL`) at it:

```yaml
- name: SH_MODEL
  value: 'ibm-granite/granite-4.1-8b'
- name: SH_MODEL_CUSTOM
  value: '1'
- name: SH_MODEL_API
  value: 'openai-completions'
- name: SH_MODEL_BASE_URL
  value: 'https://<host>/granite-4-1-8b/v1'
- name: OPENAI_API_KEY
  value: '<key>' # standard Bearer auth (default)
```

For custom-header auth (e.g. IBM RITS's `RITS_API_KEY`), keep the secret in a `secretKeyRef`
env and reference it from `SH_MODEL_HEADERS` via `${VAR}` (the default Bearer is stripped):

```yaml
- name: SH_MODEL_AUTH
  value: 'custom-header'
- name: SH_MODEL_HEADERS
  value: '{"RITS_API_KEY":"${RITS_API_KEY}"}' # RITS_API_KEY from a secretKeyRef env
```

> Tool-calling is a per-endpoint capability: only routes with the vLLM tool-call parser
> enabled return structured tool calls. Sniff a new model with a tool-requiring prompt first.

## Smoke test

Run the repo's smoke suite against the Route by exporting `KSVC_URL`:

```bash
KSVC_URL=$(oc get ksvc moca -n default -o jsonpath='{.status.url}') \
  ./deploy/knative/smoke.sh
```

For the **AuthBridge two-hop egress-control** demo on OpenShift (`SH_AUTHBRIDGE=1` +
the [`rc1-ocp-gate.sh`](rc1-ocp-gate.sh) live gate) — credential injection + allow/deny
control on both harness egress hops — see [`README-authbridge.md`](README-authbridge.md).

See [`SMOKE.md`](SMOKE.md#smoke-test-on-openshift) for details. Claims that assert
on the **LLM `/turn` response** require the harness to reach its configured
Anthropic endpoint _from the cluster_; health, scale-to-zero/-up, Redis session
recall, and the 404 path do not.

## Connecting a worker

`setup-ocp.sh` also deploys the **relay** (`sandbox-relay.<ns>.svc:8443`) that a
[SandboxTransport](../../proto/sandbox/v1/sandbox.proto) worker attaches to. To
connect your own worker — set the relay token (auth is fail-closed), enable the
remote-sandbox path on the harness, and deploy the worker pod — see
[`README-worker.md`](README-worker.md). A ready-to-edit worker Deployment is in
[`worker-example.yaml`](worker-example.yaml).

To prove the remote path actually served the work — rather than an idle sandbox pod
winning the lease — run the live gate. On OpenShift it needs the harness Route plus
two pullable images, since its defaults assume kind:

```bash
KSVC_URL=$(oc get ksvc moca -n default -o jsonpath='{.status.url}') \
RELAY_IMAGE=<registry>/moca:latest \
WORKER_IMAGE=image-registry.openshift-image-registry.svc:5000/default/remote-worker:latest \
RELAY_LIVE_SMOKE=1 bash deploy/knative/relay-leaf-smoke.sh
# => Results: 6 passed, 0 failed
```

Its teardown deletes the relay this script installed. See
[README-worker.md](README-worker.md#running-the-live-gate-on-a-real-cluster) for what
each assertion proves and the full list of caveats.

## Enabling KEDA (async leaf)

Base bring-up skips KEDA. To install the Red Hat **Custom Metrics Autoscaler
Operator** (needed by the async-leaf `ScaledJob`, [`leaf-scaledjob.yaml`](leaf-scaledjob.yaml)):

```bash
./deploy/knative/setup-ocp.sh --with-keda
```

This creates a Subscription in `openshift-keda` and a `KedaController` CR. Wiring
and verifying the async-leaf path itself on OpenShift is a further step.

## Storage & SCC

- **Storage / RWX.** The sandbox's `/workspace` PVC is `ReadWriteOnce`. On block storage (e.g. AWS EBS
  `gp3-csi`) it binds to a single node — fine for a single harness consumer.
  Concurrent multi-node scale-out, or co-mounting with the leaf-orchestrator, needs
  a **RWX** StorageClass (a filesystem provisioner). The base bring-up does not deploy
  the orchestrator. Set a specific class by making it the cluster default before install.
  RWX, if ever needed for a shared sandbox pool, lives on the sandbox tier (P2) — never the harness.
- **SCC.** The published harness image declares no `USER` (defaults to root), so it
  runs as an explicit non-root UID (65532) and the script grants the harness
  ServiceAccount the `nonroot-v2` SCC (`oc adm policy add-scc-to-user nonroot-v2 -z
moca`). The sandbox image sets `USER 65532` itself and needs no grant.

## Image delivery

Both images default to the published GHCR builds. `build.yaml` republishes
`ghcr.io/rossoctl/moca` **and**
`ghcr.io/rossoctl/moca-sandbox` (from [`sandbox.Dockerfile`](sandbox.Dockerfile))
on every push to `main`, so OpenShift pulls them directly — no in-cluster build step.

- **Harness:** pull the published `ghcr.io/rossoctl/moca` image; pin a
  tag with `--image ghcr.io/rossoctl/moca:<tag>`.
- **Sandbox:** pull the published `ghcr.io/rossoctl/moca-sandbox` image;
  override with `--sandbox-image ghcr.io/rossoctl/moca-sandbox:<tag>`.
- **Build the harness from source in-cluster** (no external registry) against the
  OpenShift internal registry:
  ```bash
  oc new-build --name moca --binary --strategy=docker -n default
  oc start-build moca --from-dir=. --follow -n default
  ./deploy/knative/setup-ocp.sh \
    --image image-registry.openshift-image-registry.svc:5000/default/moca:latest
  ```
  (Requires the pi-fork submodule to be checked out: `git submodule update --init pi-fork`.)

## Troubleshooting

| Symptom                                                                                                     | Cause / fix                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ksvc` never Ready, pod `CreateContainerConfigError: container has runAsNonRoot and image will run as root` | The `nonroot-v2` SCC grant didn't apply. Re-run the script, or `oc adm policy add-scc-to-user nonroot-v2 -z moca -n <ns>`.                                                                                |
| `ksvc` never Ready, pod `CrashLoopBackOff` with `ERR_MODULE_NOT_FOUND`                                      | The harness image is broken/stale. Use a newer `--image` (the fix shipped in the image build; see the repo history).                                                                                      |
| Sandbox `/workspace` PVC stuck `Pending`                                                                    | No (default) StorageClass. Set one, or ensure a provisioner is installed.                                                                                                                                 |
| `oc apply -k overlays/ocp` fails with a load-restrictor / "not in or below" error                           | The overlay references shared base YAMLs one level up. Render with `oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp \| oc apply -f -` — `setup-ocp.sh` does this for you. |
| `/turn` returns `"Connection error"`                                                                        | The harness can't reach its configured Anthropic endpoint from the cluster (egress/gateway reachability). `/health` and session creation still work.                                                      |

## Cleanup

```bash
oc delete ksvc moca -n default
oc delete -k <(oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp) 2>/dev/null || true
oc delete sandbox sandbox-0 deployment/redis svc/redis secret/llm-credentials -n default
# The durable /workspace PVC is provisioned StatefulSet-style from the Sandbox CR's
# volumeClaimTemplates and is NOT garbage-collected when the CR is deleted — remove it
# explicitly to reclaim the backing EBS volume:
oc delete pvc workspace-sandbox-0 -n default
# Operators (optional): oc delete knativeserving knative-serving -n knative-serving; oc delete subscription serverless-operator -n openshift-serverless
```

## Scope

Base bring-up. **Deferred** (see issue #41): KEDA-driven async-leaf verification on
OpenShift, the E1–E5 experiment drivers, the optional certified Redis Enterprise
Operator, and folding this into the main Kagenti installer.
