# Deploying on Kind

`deploy/knative/setup-kind.sh` stands up the moca stack on a
**Kind** (Kubernetes-in-Docker) cluster — Knative Serving + Kourier, KEDA,
Redis, the sandbox pod, the `leaf-work` PVC, the LLM-credentials secret, and
the harness Knative Service.

## Prerequisites

- **Docker** running
- **kind** CLI installed
- **kubectl** configured to the Kind cluster (or the script creates one)
- A model credential:
  - `ANTHROPIC_API_KEY` (direct), **or**
  - `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (Bearer-token gateway, e.g. LiteLLM).

## Quick start

```bash
# 1. Clone (the Pi agent is a submodule)
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca

# 2. Provide a model credential — direct key...
export ANTHROPIC_API_KEY=sk-...
#    ...or a Bearer-token gateway:
# export ANTHROPIC_BASE_URL=https://your-gateway
# export ANTHROPIC_AUTH_TOKEN=...

# 3. Install (creates cluster if needed, builds image, deploys everything)
./deploy/knative/setup-kind.sh
```

When it finishes, the script prints Kourier access instructions:

```bash
# In a separate terminal:
kubectl port-forward -n kourier-system svc/kourier 8080:80

# Send a request with the Host header:
curl -H 'Host: moca.default.example.com' \
     -H 'Content-Type: application/json' \
     -d '{"prompt": "Remember the secret word: pineapple. Reply only with OK."}' \
     http://localhost:8080/turn | jq .
# => { "sessionId": "019...", "response": "OK" }
```

#### Streaming responses (SSE)

`POST /turn` also streams the turn live when the client asks for it with
`Accept: text/event-stream`. The default (no `Accept`, or any other value) is unchanged — the same
single JSON body. Streaming is a _representation_ of `/turn` chosen by content negotiation, not a
separate route.

```bash
curl -N -H 'Host: moca.default.example.com' \
     -H 'Content-Type: application/json' \
     -H 'Accept: text/event-stream' \
     -d '{"prompt":"Count from 1 to 5, one number per line."}' \
     http://localhost:8080/turn
```

`-N` disables curl's output buffering so frames print as they arrive. Each event is
`event: <type>\ndata: <JSON>\n\n`:

- `event: text` — an assistant-text delta (`{"type":"text","delta":"..."}`)
- `event: thinking` — a reasoning delta (best-effort; may never fire for some models)
- `event: tool_use` — a tool call started (`id`, `name`, verbatim `args`)
- `event: tool_result` — a tool call ended (`id`, `isError`, a byte-capped `preview`)
- `event: done` — clean finish; carries `sessionId`, `stopReason`, and `usage`
- `event: error` — the turn ended in an error stop-reason; carries `errorMessage`

The stream ends with exactly one terminal `done` (or `error`) frame. Use the `sessionId` from that
frame to continue the conversation on a later turn (streaming or not). A client disconnect (Ctrl-C
on `curl -N`) aborts the in-flight turn; the session still persists to its last durable checkpoint,
so it resumes identically to a completed turn.

An unknown `sessionId` or a missing `prompt` still returns a real HTTP `404`/`400` with the same JSON
body as the non-streaming path — the `200` + SSE headers are only sent once the first frame is ready.

Tuning knobs (env): `SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES` (tool-result `preview` byte cap,
default `2048`) and `SH_TURN_STREAM_KEEPALIVE_MS` (heartbeat interval, default `20000`).

> **Deployment note (Knative):** annotate the streaming revision with
> `autoscaling.knative.dev/target-burst-capacity: "0"` so the Knative activator drops out of the
> request path — otherwise it may buffer the response and batch all deltas to the end. The gated
> smoke `deploy/knative/turn-stream-smoke.sh` (`TURN_STREAM_LIVE_SMOKE=1`) asserts inter-frame
> timing to catch exactly that.

## Options

```
--build                  Force a local harness build from this checkout
--skip-build             Do not build/pull the harness image (use existing dev.local tag)
--image <ref>            Published harness image to pull (default: ghcr.io/rossoctl/moca:latest)
--cluster-name <name>    Kind cluster name (default: sh-knative)
```

By default (no `--build`/`--skip-build`) the script **pulls the published harness image** and
loads it into the cluster, falling back to a local build only if the pull is unavailable
(offline or image missing). Use `--build` to always build from source.

Environment variables:

| Variable          | Default                        | Description                                                   |
| ----------------- | ------------------------------ | ------------------------------------------------------------- |
| `CLUSTER_NAME`    | `sh-knative`                   | Kind cluster name                                             |
| `KNATIVE_VERSION` | `v1.14.0`                      | Knative Serving version                                       |
| `SH_IMAGE`        | `ghcr.io/rossoctl/moca:latest` | Published harness image pulled by default (same as `--image`) |
| `FORCE_BUILD`     | `false`                        | Force a local build (same as `--build`)                       |
| `KEDA_VERSION`    | `v2.14.0`                      | KEDA version                                                  |

> **Pinning a release:** `:latest` tracks `main`, not any specific tag — to install a
> specific release, pass the versioned image tag explicitly (e.g. `:0.3.0`) via `--image`/
> `SH_IMAGE` rather than relying on `:latest`. See
> [README-k8s.md](README-k8s.md#image-tags-latest-vs-pinned-releases) for why `:latest` +
> `imagePullPolicy: IfNotPresent` can leave you on a stale image.

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
kubectl set env ksvc/moca SH_MODEL=claude-sonnet-4-6
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

## What it installs

| Component                 | How                                                                             |
| ------------------------- | ------------------------------------------------------------------------------- |
| Knative Serving + Kourier | Direct YAML apply from upstream releases                                        |
| KEDA                      | Direct YAML apply (async leaf ScaledJob support)                                |
| Knative config            | Autoscaler tuning (20s stable-window), PVC feature flags, security-context flag |
| Redis                     | Lightweight in-repo Deployment (`redis:7-alpine`)                               |
| Sandbox                   | Pre-baked image (`sandbox.yaml`, `USER 65532`)                                  |
| `leaf-work` PVC           | `ReadWriteOnce`, default StorageClass                                           |
| Harness                   | Knative Service (`service.yaml`)                                                |
| Ingress                   | Kourier + port-forward from host                                                |

## Smoke test

Run the smoke suite (requires the Kourier port-forward to be active):

```bash
./deploy/knative/smoke.sh
```

See [`SMOKE.md`](SMOKE.md) for detailed results and what each claim proves.

For the **AuthBridge two-hop egress-control** demo (`SH_AUTHBRIDGE=1`) — credential
injection + allow/deny control on both harness egress hops — see
[`README-authbridge.md`](README-authbridge.md).

## Troubleshooting

| Symptom                                    | Cause / fix                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ksvc` never Ready, pod `CrashLoopBackOff` | Check `kubectl logs` — likely missing `llm-credentials` secret or broken image.                               |
| `/turn` returns `"Connection error"`       | The harness can't reach its Anthropic endpoint from the cluster (gateway unreachable). `/health` still works. |
| Image not found after `--skip-build`       | Load the image manually: `kind load docker-image dev.local/moca:local --name sh-knative`                      |
| Scale-to-zero doesn't happen               | Verify `config-autoscaler` settings: `kubectl get cm config-autoscaler -n knative-serving -o yaml`            |

## Cleanup

```bash
kind delete cluster --name sh-knative
```
