# AuthBridge Two-Hop Egress Control (RC1)

This demo shows **Rosso Cortex / AuthBridge** acting as the zero-trust credential
plane on MOCA: it does both **credential injection** and
**action control** on the harness's two HTTP egress hops, and the real credential
is **never held by any model-influenced workload** — only a placeholder is, and the
real value is swapped in at the proxy, _after_ an allow/deny gate.

The path is gated behind the **`SH_AUTHBRIDGE`** feature flag (off by default). It
runs the same way on Kind and OpenShift; only the enable/run entrypoints differ.

- Design: [`../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md`](../specs/2026-07-10-authbridge-egress-control-plane-poc-design.md) · [ADR-0025](../adrs/0025-authbridge-deployment-topology.md)
- Base deploy guides: [`README-kind.md`](README-kind.md) · [`README-ocp.md`](README-ocp.md)

## The two hops

One AuthBridge role per egress hop; on each hop the **control plugin runs before
injection**, so a denied action never receives a real credential.

```
Hop 1 (Profile A) — harness → LLM. SHARED gateway.
  harness pod ──Bearer PLACEHOLDER──▶ AB1 (Deployment+Service)
                                        inference-parser → IBAC(allow/deny) → static-inject(real key)
                                      ──x-api-key REAL──▶ api.anthropic.com
  The harness holds only a placeholder + ANTHROPIC_BASE_URL=http://authbridge-ab1:8080.

Hop 2 (Profile B) — sandbox → external API. PER-SANDBOX forward-proxy sidecar.
  sandbox code ──http(s)_proxy=localhost:8081──▶ AB2 (sidecar in the sandbox pod)
                                                   mcp-parser → IBAC(allow/deny) → static-inject(real token)
                                                 ──Authorization REAL──▶ echo-target (external API stand-in)
  The sandbox holds only ECHO_CRED=PLACEHOLDER-TOKEN.
```

The real credentials live only in the `ab1-llm-cred` / `ab2-egress-cred` secrets
(mounted into AB1 / AB2), never in the harness or sandbox pod env.

## Prerequisites

- A real Anthropic API key exported as `ANTHROPIC_API_KEY` — AB1 injects it on Hop 1.
- **Kind:** the [`README-kind.md`](README-kind.md) prerequisites (Docker, `kind`, `kubectl`).
- **OpenShift:** the [`README-ocp.md`](README-ocp.md) prerequisites (`oc` logged in, an
  OCP 4.x cluster). Both OVN-Kubernetes (OCP) and modern kindnet (Kind) enforce the
  tightened egress `NetworkPolicy`, so the harness DNS rule must cover both CoreDNS
  backends — `openshift-dns:5353` (OCP, post-DNAT) and `kube-system:53` (Kind); see
  [`authbridge/harness-egress-ab1.yaml`](authbridge/harness-egress-ab1.yaml) and #126.

## Quick start

### Kind

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# 1. Stand up the stack WITH the AuthBridge two-hop path (AB1 + AB2 + ibac-stub + echo-target)
SH_AUTHBRIDGE=1 ./deploy/knative/setup-kind.sh
# fast re-run against an existing cluster with images already loaded:
#   SH_AUTHBRIDGE=1 ./deploy/knative/setup-kind.sh --skip-build --cluster-name sh-knative

# 2. Run the demo/smoke — proves all six claims below (auto port-forwards Kourier)
LEAF_LIVE_SMOKE=1 SH_AUTHBRIDGE=1 NS=default SH_MODEL=claude-haiku-4-5 \
  bash deploy/knative/leaf-smoke.sh
# => ... === Results: 16 passed, 0 failed ===   /   LEAF SMOKE PASS
```

On Kind, leave `KSVC_URL` unset: the smoke talks to `http://localhost:8080` with a
`Host:` header and starts the Kourier port-forward itself. `NS` **must** be `default`
(the AB1 manifests are pinned to that namespace).

### OpenShift

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# 1. Stand up the stack WITH the AuthBridge path (uses the published GHCR images via overlays/ocp-authbridge)
SH_AUTHBRIDGE=1 ./deploy/knative/setup-ocp.sh

# 2. Run the live gate: applies the AB path, runs the smoke via the Route, then RESTORES to base
./deploy/knative/rc1-ocp-gate.sh gate
# => ... === Results: 16 passed, 0 failed ===   /   SMOKE_EXIT:0   /   RESTORE COMPLETE
```

`rc1-ocp-gate.sh` targets an **already-deployed** stack in `default` and has four
modes: `up` (apply the AB path), `smoke` (run leaf-smoke against the Route), `restore`
(return to the base direct-Anthropic state), and `gate` (= `up` → `smoke` →
`restore`, the default). To keep the AB path applied for manual inspection, run
`RC1_GATE_KEEP=1 ./deploy/knative/rc1-ocp-gate.sh gate` (then `restore` when done).
The gate resolves the Route automatically (`oc get ksvc moca -n default -o jsonpath='{.status.url}'`).

## What it installs

| Component                | Manifest                                                                                                     | Role                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **AB1** LLM gateway      | [`authbridge/ab1-deployment.yaml`](authbridge/ab1-deployment.yaml)                                           | Shared reverse-proxy `Deployment`+`Service`; Hop-1 gate + key injection                                    |
| **ibac-stub**            | [`ibac-stub.yaml`](ibac-stub.yaml)                                                                           | Canned allow/deny policy decision (both hops)                                                              |
| tightened egress         | [`authbridge/harness-egress-ab1.yaml`](authbridge/harness-egress-ab1.yaml)                                   | `NetworkPolicy` — harness may reach only AB1 (overwrites the base policy)                                  |
| **AB2** sidecar + config | [`authbridge/ab2-config.yaml`](authbridge/ab2-config.yaml), [`sandbox-pool-ab2.yaml`](sandbox-pool-ab2.yaml) | Per-sandbox forward proxy on loopback `:8081`; Hop-2 gate + token injection                                |
| **echo-target**          | [`echo-target.yaml`](echo-target.yaml)                                                                       | External-API stand-in that reflects the `Authorization` it received                                        |
| secrets                  | (created by the setup script)                                                                                | `ab1-llm-cred` (real key), `ab2-egress-cred` (real token); `llm-credentials` repointed to AB1 placeholders |

On OpenShift these are wired via [`overlays/ocp-authbridge`](overlays/ocp-authbridge)
(image remaps + SCC/securityContext patches over the shared manifests); the base,
non-AuthBridge state is [`overlays/ocp`](overlays/ocp).

## The six claims

`leaf-smoke.sh` (with `SH_AUTHBRIDGE=1`) proves these before the base leaf claims —
Hop-2 first, then Hop-1:

| Claim              | What it proves                                          | PASS message                                                                  |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **H2-secret-free** | sandbox holds only the AB2 placeholder                  | `sandbox spec env holds only the AB2 placeholder + proxy vars, no real cred`  |
| **H2-inject**      | AB2 allow-path injects the real token at the proxy      | `echo reflected the real cred (injected at AB2), sandbox never held it`       |
| **H2-deny**        | a `tools/call`-shaped request is blocked pre-egress     | `denied pre-egress (ibac.no_session or ibac.no_intent ...), no injection`     |
| **H1-secret-free** | harness holds only the AB1 placeholder                  | `harness env holds only the AB1 placeholder + base URL, no real key`          |
| **H1-allow**       | a leaf completes only because AB1 injected the real key | `allow-path leaf completed (real key injected at AB1)`                        |
| **H1-deny**        | a denylisted call is 403'd at AB1 before injection      | `deny-before-inject proven (AB1 returned 403 at ibac, pre-static-inject ...)` |

## See it yourself (manual checks)

These require the AuthBridge path to be **applied** — on Kind, after step 1 above;
on OpenShift, after `rc1-ocp-gate.sh up` (or `RC1_GATE_KEEP=1 ... gate`). Commands
use `kubectl`; on OpenShift `oc` works identically.

**Hop 2 — the sandbox never holds the real egress credential:**

```bash
# Sandbox env has only the placeholder:
kubectl -n default exec sandbox-0 -c sandbox -- printenv ECHO_CRED
# => PLACEHOLDER-TOKEN

# The real value lives ONLY in the AB2 secret (not in any sandbox pod):
kubectl -n default get secret ab2-egress-cred -o jsonpath='{.data.echo-target}' | base64 -d; echo
# => REAL-ECHO-EGRESS-CRED-rc1demo   (the default; whatever RC1_ECHO_REAL_CRED was set to)

# Allow-path: a request through the sandbox's proxy reaches echo-target, which reflects
# the Authorization it received = the REAL token, injected at AB2 — the sandbox never had it.
# The request must carry the placeholder token ($ECHO_CRED) for AB2's static-inject to swap,
# and must use the short host `echo-target` — static-inject keys the credential off the Host
# (key_by: host), which matches the secret key `echo-target`, NOT the FQDN.
kubectl -n default exec sandbox-0 -c sandbox -- \
  sh -c 'curl -s http://echo-target/ -H "Authorization: Bearer $ECHO_CRED" | grep -i authorization'
# => {"method":"GET","path":"/","authorization":"Bearer REAL-ECHO-EGRESS-CRED-rc1demo"}
```

**Hop 1 — the harness never holds the real provider key:**

```bash
# The harness reads its provider creds from the llm-credentials secret, which holds
# only placeholders + the in-cluster gateway URL:
kubectl -n default get secret llm-credentials \
  -o jsonpath='{.data.api-key}' | base64 -d; echo    # => AB1-PLACEHOLDER
kubectl -n default get secret llm-credentials \
  -o jsonpath='{.data.base-url}' | base64 -d; echo    # => http://authbridge-ab1:8080

# The real key lives ONLY in the AB1 secret:
kubectl -n default get secret ab1-llm-cred -o jsonpath='{.data.api\.anthropic\.com}' | base64 -d | head -c 8; echo '...'

# On a running harness revision pod, the injected env is the placeholder too:
POD=$(kubectl -n default get pod -l serving.knative.dev/service=moca -o name | head -1)
kubectl -n default exec "$POD" -c user-container -- printenv ANTHROPIC_BASE_URL   # => http://authbridge-ab1:8080
```

(Knative scales the harness to zero when idle; send a request first, or run the
`leaf-smoke.sh` smoke, to have a pod to exec into. The smoke reads the pod **spec**
env via `jsonpath` instead of `exec` to sidestep exec flakiness on loaded single-node
clusters.)

## Troubleshooting

| Symptom                                                                                          | Cause / fix                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness can't resolve `authbridge-ab1` / DNS times out; LLM calls fail with `Connection timeout` | The egress `NetworkPolicy` is enforced on **both** Kind (modern kindnet) and OCP (OVN-K), so its DNS rule must cover both CoreDNS backends: `kube-system:53` (Kind) and `openshift-dns:5353` (OCP — OVN-K enforces post-DNAT, so 5353 not 53). Both entries are present in [`authbridge/harness-egress-ab1.yaml`](authbridge/harness-egress-ab1.yaml) — see #102 (OCP) and #126 (Kind). |
| `leaf-smoke.sh` exits `SKIP`                                                                     | Set `LEAF_LIVE_SMOKE=1`.                                                                                                                                                                                                                                                                                                                                                                |
| Smoke aborts with an `NS` error                                                                  | The AuthBridge path requires `NS=default` (AB1 manifests are namespace-pinned).                                                                                                                                                                                                                                                                                                         |
| H2 checks see the old sandbox image / no sidecar                                                 | The sandbox controller does not roll pods on CR change; the setup/gate force-`delete pod`s the pool and waits. If stale, `kubectl -n default delete pod -l sh.kagenti.io/sandbox-pool=default`.                                                                                                                                                                                         |
| `curl` in the sandbox ignores the proxy for `http://` URLs                                       | It honors lowercase `http_proxy` — the pool sets both cases; use lowercase in ad-hoc curls.                                                                                                                                                                                                                                                                                             |
| sandbox-relay `CrashLoopBackOff` (`ERR_MODULE_NOT_FOUND: tsx`)                                   | Unrelated to AuthBridge; the relay must run from its package dir. Fixed in [`relay-deployment.yaml`](relay-deployment.yaml).                                                                                                                                                                                                                                                            |

## Cleanup / restore

- **OpenShift:** `./deploy/knative/rc1-ocp-gate.sh restore` returns `default` to the
  base direct-Anthropic state (removes AB resources, restores `llm-credentials`,
  re-applies [`overlays/ocp`](overlays/ocp)). `gate` mode does this automatically on exit.
- **Kind:** re-run `./deploy/knative/setup-kind.sh` **without** `SH_AUTHBRIDGE=1` to
  redeploy the base stack, or delete the cluster (`kind delete cluster --name sh-knative`).

## Scope

RC1 is a **single-tenant, static-credential** PoC: real injection + real control
pipeline, with a canned (`ibac-stub`) judge. Per-user identity, RFC 8693
token-exchange, a real SPARC/IBAC judge, and baked-CA HTTPS interception are
deferred (see the design doc §10). The bring-your-own / remote-sandbox variant
(RC1-3) is a stretch gated on the SandboxTransport live gate (ST5, #88).
