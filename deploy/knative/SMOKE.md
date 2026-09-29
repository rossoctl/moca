# M4 Smoke Test Results

**Date:** 2026-06-18
**Cluster:** Kind (`sh-knative`), Kubernetes v1.34.0
**Knative Serving:** v1.14.0 + Kourier v1.14.0
**Image:** `dev.local/moca:local` (667MB)
**Gateway:** LiteLLM at `https://ete-litellm.bx.cloud9.ibm.com`

## Results: 6/6 PASS

```
--- Claim 1: Health endpoint responds ---
  PASS

--- Claim 2: POST /turn creates a new session ---
  PASS
  sessionId=019ed8eb-4757-71a3-bc0a-468150f6120b

--- Claim 3: Pod scales to zero after idle ---
  Waiting for scale-to-zero (up to 90s)...
  Scaled to zero after ~90s
  PASS

--- Claim 4: Cold-start resume recalls session state from Redis ---
  PASS

--- Claim 5: Pod scaled up from zero for claim 4 ---
  PASS

--- Claim 6: 404 on unknown session ---
  PASS

=== Results: 6 passed, 0 failed ===
```

## What Was Proven

1. Knative Serving scales the harness pod to zero after idle (stable-window 20s + grace 10s)
2. Cold-start from zero: Knative spins up a fresh pod on inbound request
3. Redis-backed session storage survives pod termination — session state recalled across cold starts
4. `containerConcurrency: 1` ensures single-tenant pod execution
5. Gateway bridge pattern (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) works inside the container

## Autoscaler Tuning (dev/testing)

```yaml
stable-window: '20s' # default 60s
scale-to-zero-grace-period: '10s' # default 30s
```

For production, use defaults or tune based on cold-start latency tolerance.

## Findings During Setup

1. **Kourier repo moved:** `knative/net-kourier` → `knative-extensions/net-kourier` (kubectl doesn't follow 301 redirects)
2. **Image tag resolution:** Local Kind images need `dev.local/` prefix + `config-deployment` skip-tag-resolving
3. **tsx resolution:** `node --import tsx` requires tsx in the CWD's node_modules — fixed by setting `WORKDIR /app/packages/knative-server`
4. **config-domain:** Must explicitly set `example.com` domain for Kourier routing to work with Host headers

---

# OpenShift (`setup-ocp.sh`)

`setup-ocp.sh` is the OpenShift-native sibling of `setup-kind.sh`. It targets
**OpenShift 4.20+** and stands up the same stack, but the OpenShift way (issue #41):

| Concern     | Kind (`setup-kind.sh`)                | OpenShift (`setup-ocp.sh`)                                                                                                                                |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knative     | raw upstream YAML + Kourier           | **Red Hat OpenShift Serverless Operator** (OLM Subscription) + `KnativeServing` CR (Kourier bundled)                                                      |
| Config      | `kubectl patch configmap config-*`    | feature flags + autoscaler tuning in the `KnativeServing` **CR spec** (the operator reverts ConfigMap patches)                                            |
| Ingress     | Kourier port-forward + Host header    | auto-created **OpenShift Route** (`ksvc` `status.url`)                                                                                                    |
| Harness UID | hard-coded `runAsUser/fsGroup: 65532` | kept at 65532; the SA is granted the `nonroot-v2` SCC so that explicit non-root UID is admitted (the GHCR image declares no `USER`, so a UID must be set) |
| Sandbox     | `alpine` + `apk add` as root          | **pre-baked** image (`sandbox.Dockerfile`, sets `USER 65532`) built in-cluster, restricted-v2 compatible                                                  |
| Image       | `docker build` + `kind load`          | published GHCR image (`--image`); sandbox built to the internal registry                                                                                  |

Manifests are shared with Kind via the `deploy/knative/overlays/ocp` kustomize
overlay (OCP tweaks are patches, not forked YAMLs).

See **[`README-ocp.md`](README-ocp.md)** for the full install guide — prerequisites,
`setup-ocp.sh` options, what gets installed, storage/SCC notes, image delivery, and
troubleshooting.

## Smoke test on OpenShift

The Kind smoke/experiment drivers run against the Route — export `KSVC_URL`
(instead of starting a Kourier port-forward):

```bash
KSVC_URL=$(oc get ksvc moca -n default -o jsonpath='{.status.url}') \
  ./deploy/knative/smoke.sh
```

`lib.sh` then targets the Route directly (no port-forward, no `Host` header, `-k`
for the router cert; Kind behavior is unchanged). Claims that assert on the **LLM
`/turn` response** require the harness to reach its configured Anthropic endpoint
_from the cluster_; health, scale-to-zero/-up, Redis session recall, and the 404
path do not.

Observed on OpenShift 4.20 (with private-gateway egress unavailable): **4/6 claims
pass** — health, scale-to-zero, scale-up-from-zero, 404, plus Redis session recall
(matching `sessionId` across a cold start). The two failures are the LLM `/turn`
response text only, not the harness or the setup.

For storage/SCC, KEDA, Redis and kustomize notes, see [`README-ocp.md`](README-ocp.md).

---

# Multi-user demo (`MULTIUSER_LIVE_SMOKE=1`)

`deploy/knative/demo-multiuser.sh` (`make demo-multiuser`) proves MU1's slice-1 claims against a warm
cluster: two GitHub device-flow logins, a credential per user, owner-filtered session lists, a 404
across tenants, `session_mismatch` when a valid token names another session, `token_required` under
`SH_REQUIRE_AUTH=true`, a `/resources` projection, and — the load-bearing one — `credential_required`
for a subject with no stored key **while the deployment's own `ANTHROPIC_AUTH_TOKEN` is mounted on the
Service**.

Gated three ways, and it **skips rather than fails** when any gate is unset:

| Gate                     | Why                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `MULTIUSER_LIVE_SMOKE=1` | needs a live cluster and two model calls                                           |
| `SH_GITHUB_CLIENT_ID`    | a GitHub OAuth app with **device flow enabled** (off by default); no client secret |
| two GitHub accounts      | the subject is attested by GitHub, so the script cannot fabricate two of them      |

It sets `SH_REQUIRE_AUTH=true` for the run — so the property demonstrated is the real one, not the
permissive default — and restores `false` on exit, including on an aborted run.

**What it does not show:** slice 1's sandbox pool is **shared**. Two users' leaves can be placed on the
same pod; isolation holds at the API, the session store and the inference credential, not the sandbox.
The tenant-labelled partition is MU2 (spec §8.2). The script says this out loud.
