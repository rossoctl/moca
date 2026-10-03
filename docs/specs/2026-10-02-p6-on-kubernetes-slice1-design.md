# P6 on Kubernetes, slice 1: the P6 process model on a cluster, container tier — Design

Version: 1.1 — October 2026 (v1.1: corrections from the implementation plan)
Status: Proposed
Milestone: **P6.1** (registered in [the milestone registry](README.md)); slice 1 of epic rossoctl/moca#426,
issue rossoctl/moca#423.
Builds on (reuse, no redesign): [P6](2026-09-08-p6-vm-process-manager-design.md) and
[ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md) (supervisor, socket hand-off, admission);
[MU1](2026-09-08-multi-user-control-plane-design.md) (control plane, session tokens, exchange hop);
[MI1](2026-09-28-moca-multi-user-isolation-design.md) §5 R5/R8 (exec token, brain/hands network split);
`deploy/compose/` (the same processes, containerized) and `deploy/vm/` (the hardening and secret
discipline this design translates).
Decision record: ADR-0037 (written in this slice; see §11).

> **The one-sentence thesis.** P6 already runs in containers (`deploy/compose`), so putting it on
> Kubernetes changes no process and no wire. It is a translation of the VM's isolation, secret and
> lifecycle guarantees into namespaces, NetworkPolicy, Secrets and pod lifecycle. Plus two small code
> changes, and one hard rule the cluster must not break: the supervisor is reached over **L4 only**.

---

## 0. Decisions taken during design

| Question                              | Decision                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target cluster                        | **Kind first, with an OpenShift overlay.** Kind is the dev and CI target; OCP is where the multi-user demo is shown.                                                                                                                                                                                                                                                                  |
| What "done" means                     | **#370 demo parity on the container tier:** GitHub device-flow login, two users with disjoint sessions, per-user inference credentials, `curl`/`git` research turns, `SH_REQUIRE_AUTH=true`. Plus an automated smoke in CI.                                                                                                                                                           |
| How users reach the supervisor on OCP | **A ghostunnel L4 TLS sidecar behind a passthrough Route.**                                                                                                                                                                                                                                                                                                                           |
| Packaging                             | **A new standalone kustomization, `deploy/k8s/`** (base + `overlays/kind` + `overlays/ocp`) with one `setup.sh`. Rejected: an overlay inside `deploy/knative/` (its base is the Knative path RA1 deprecates, so the overlay would be mostly deletions and coupled to that path), and Helm (nothing in the repo uses it, and it is harder to test statically than rendered kustomize). |
| Credential store                      | `K8sSecretStore` (the control plane's default), in its own namespace.                                                                                                                                                                                                                                                                                                                 |
| Redis                                 | AUTH (through the URL) and a PVC.                                                                                                                                                                                                                                                                                                                                                     |
| Sandbox egress                        | Open internet **except** private, CGNAT and link-local ranges.                                                                                                                                                                                                                                                                                                                        |

### 0.1 v1.1 implementation notes

What the implementation added to this design, each with its reason. The sections below are
corrected to match.

- **The control plane reconnects to Redis forever, and its `/readyz` fails fast** while the client
  is not ready. `setup.sh` applies everything at once, so the control plane often starts before
  Redis, and it used to sit unready for good (Kind spike).
- **The relay retries presence writes** with backoff until they land or the sandbox detaches, and
  the runtime reporter's Redis client has an `error` listener. A late Redis lost presence for good,
  and a Redis restart crashed workers mid-turn (Kind end-to-end run).
- **`setup.sh` reads Secrets with `--ignore-not-found`**, so only "absent" counts as missing and a
  transient API error aborts. Treating any read failure as absent would rotate a Secret, the KEK
  included (§4.2 "never rotated").
- **The control plane rolls on a `moca.dev/settings-hash` pod-template annotation**, rendered by the
  generated overlay, not on an explicit restart. A run that wrote new settings and then failed
  would otherwise lose the restart.
- **The key generator waits for the attach before it writes.** `kubectl run -i` attaches late on a
  busy node, and an attach does not replay earlier output (Kind end-to-end run).
- **The `kind-ci` mock model is a native sidecar** (an init container with `restartPolicy: Always`)
  that exits on SIGTERM. As a plain container it held every deleted pod for the full 120 s grace,
  or, exiting with the supervisor, vanished under the turn claim 9 drains.
- **ghostunnel comes from `docker.io/ghostunnel/ghostunnel`**, pinned by digest. Docker Hub is the
  project's official channel; it does not publish to GHCR.
- **Claim 7 probes `kubernetes.default.svc:443` and enforces it on OCP only.** Single-node kindnet
  does not filter pod-to-own-node traffic, so on Kind the result is printed as a note.

## 1. Scope

**In scope:** everything in §2–§10. The supervisor and its forked workers, the relay, Redis, the MU1
control plane and `remote-worker` container sandboxes, as Kubernetes workloads, on Kind and on OCP.
Two code changes (§6), tests at four layers (§9), a README, and ADR-0037.

**Not in scope:**

- P4 (slice 2, rossoctl/moca#424).
- Tier selection and session-to-sandbox affinity (slice 3, rossoctl/moca#425).
- Autoscaling (HPA/KEDA), Vault, cert-manager integration, a relay health endpoint.
- MI1 owner binding (S5) and grants (S2). The container tier still shares sandboxes between users, as
  on the VM; the README says so, in the same words `docs/demos/vm-multi-user-demo.md` uses.
- Prebuilt JavaScript images (dropping tsx at runtime).

**Not this path:** the Knative/KEDA deployment, `KubectlTransport` and pod-exec sandboxes. Nothing in
`deploy/k8s/` references `deploy/knative/`, and nothing there changes.

## 2. Topology

### 2.1 Namespaces

| Namespace          | Contents                                | Why it is separate                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moca`             | supervisor, relay, Redis, control plane | the brain side                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `moca-sandbox`     | the sandbox StatefulSet only            | Pod Security `restricted`, `automountServiceAccountToken: false`, default-deny NetworkPolicy. **The only Secret any MOCA object references in it is the attach token** (§4.2): the exec token, the Redis password and the MU1 keys never exist in it. (OpenShift adds its own per-ServiceAccount pull Secrets to every namespace; nothing MOCA renders references them.) On the VM this is a convention (MI1 §5 R5/R8); here it is structural. |
| `moca-credentials` | per-user credentials (`K8sSecretStore`) | as `deploy/knative/control-plane.yaml` has it, renamed from `sh-credentials` so both paths can coexist on one cluster                                                                                                                                                                                                                                                                                                                          |

All three names come from the base and can be changed by the overlay; `setup.sh` takes no namespace
flag in this slice.

### 2.2 Services and ports

| Service (namespace `moca`)       | Port | Backs                                      | Reached by                                                           |
| -------------------------------- | ---- | ------------------------------------------ | -------------------------------------------------------------------- |
| `moca-supervisor`                | 8080 | supervisor data listener                   | users: `port-forward` on Kind; on OCP, via the sidecar (§7.2)        |
| `moca-supervisor`                | 8081 | supervisor admin listener                  | the kubelet (probes); in-namespace scrapers                          |
| `moca-supervisor-tls` (OCP only) | 8443 | the ghostunnel sidecar                     | the OCP router (passthrough Route)                                   |
| `sandbox-relay-attach`           | 9443 | relay Attach (`SH_RELAY_PORT`)             | sandbox pods; the P4 CIDR in slice 2                                 |
| `sandbox-relay-exec`             | 9444 | relay SandboxExec (`MOCA_RELAY_EXEC_ADDR`) | supervisor pods only                                                 |
| `redis`                          | 6379 | Redis                                      | supervisor, relay, control plane                                     |
| `moca-control-plane`             | 8080 | control plane                              | users (port-forward / edge Route), and the supervisor's exchange hop |

The relay gets **two Services rather than one with two ports.** A Service cannot restrict who
reaches it (only NetworkPolicy can, §5), but two Services mean the address a sandbox is told to dial
has no route to the exec port, and a manifest test (§9.2) can say so.

### 2.3 Request flow

Unchanged from the VM; only the addresses change.

```
mocactl ──login/sessions/token mint──▶ control-plane ──▶ Redis; kube API (moca-credentials)
mocactl ──/v1/turn + session token──▶ supervisor ──fd hand-off──▶ worker
worker ──exchange──▶ control-plane        worker ──SandboxExec :9444──▶ relay
sandbox ──Attach :9443 (dials out)──▶ relay ──presence──▶ Redis (sh:sandbox:records)
worker ──▶ model API (443)                sandbox ──▶ internet (research turns, §5)
```

## 3. Workloads

All brain-side pods share these settings:

- the harness image (`ghcr.io/rossoctl/moca`);
- `workingDir: /app/packages/<pkg>`, `command: [node, --import, tsx, src/main.ts]`, exactly as Compose
  has them (tsx resolves from the package directory, never the repo root);
- `runAsNonRoot`, an explicit UID, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`,
  seccomp `RuntimeDefault`, `readOnlyRootFilesystem: true`;
- an `emptyDir` at `/tmp` with `HOME=/tmp`;
- `automountServiceAccountToken: false`, except the control plane, which needs the kube API.

### 3.1 Supervisor: Deployment `moca-supervisor`

- **One container holds the supervisor and its whole worker pool.** `fork()` cannot cross
  containers (ADR-0034). W is `SH_WORKERS`; capacity beyond one pod is `replicas`.
- `replicas: 1` by default. More are allowed and documented. With `leastInFlight` the W workers are
  already separate processes sharing Redis, so more pods add no new kind of concurrency.
  `stickyBySession` affinity holds only within one pod; the README says so.
- **W is pinned, not inferred.** The base sets these together:
  - `SH_WORKERS=2`;
  - `resources.limits.cpu: "2"`;
  - `resources.requests.memory` / `limits.memory` of at least W × 256Mi plus 256Mi headroom
    (`768Mi` / `1Gi`). This is the per-process tsx footprint measured in
    `deploy/knative/relay-deployment.yaml`.

  Leaving `SH_WORKERS` unset would be correct (`availableParallelism()` honours the CPU limit,
  #341), but then a CPU-limit change silently changes the memory needed. A manifest test (§9.2)
  fails when memory < W × 256Mi.

- `SH_TURNS_PER_WORKER=4`, labelled as a **trial value**, as in Compose (`install.sh`). Its real
  value is still an output of E8.
- The env mirrors `deploy/vm/env/supervisor.env.example` variable for variable; only the addressing
  differs:
  - `SH_RELAY_ADDR=sandbox-relay-exec.moca.svc:9444`
  - `REDIS_URL` from Secret `moca-redis`
  - `SH_CONTROL_PLANE_URL=http://moca-control-plane.moca.svc:8080`
  - `SH_SANDBOX_DISCOVERY=records`, `SH_REMOTE_SANDBOX=1`
  - `SH_REQUIRE_AUTH=true`
  - `SH_SESSION_TOKEN_PUBLIC_KEYS` as env (it is public)
  - `MOCA_RELAY_EXEC_TOKEN` from Secret `moca-relay`
- **`SH_EXCHANGE_TOKEN` is a file, not env.** Secret `moca-mu1`'s `SH_EXCHANGE_TOKEN` key, and only
  that key (a volume with `items:`, so the private key and KEK are never projected into this pod),
  is mounted read-only at `/run/credentials/SH_EXCHANGE_TOKEN` (`defaultMode: 0400`), with
  `CREDENTIALS_DIRECTORY=/run/credentials`. `credentialValue()`
  (`packages/control-plane/src/systemd-credentials.ts`) already resolves it from there for the
  workers (`server-process.ts:54`, `turn-auth.ts:104`), so the token stays out of the environment
  and out of `kubectl describe`. This is the closest analogue to `LoadCredential=`. Setting it in env
  as well would make the workers refuse to boot, so the manifests never do.
- `SH_ADMIN_HOST=0.0.0.0` (§6.1). The admin listener becomes reachable on the pod IP, and §5 limits
  who can reach it.
- **Probes**, all on admin port 8081:
  - startup: `GET /readyz`, `failureThreshold` × `periodSeconds` ≥ 120s, because tsx compiles every
    worker at boot;
  - readiness: `GET /readyz`;
  - liveness: `GET /healthz`.
- **Lifecycle:**
  - `terminationGracePeriodSeconds: 120`, matching `TimeoutStopSec` in `sh-supervisor.service`.
    Kubernetes sends SIGTERM to PID 1 only, which is the `KillMode=mixed` behaviour `main.ts::close()`
    relies on: drain, stop accepting, `awaitIdle(SHUTDOWN_GRACE_MS)`.
  - `preStop: exec: [sleep, "5"]`, so the endpoint is removed from the Service before `drainAll()`
    stops accepting.
  - The rollout strategy is the default `RollingUpdate`, with `maxUnavailable: 0`.
- UID 65532.

### 3.2 Relay: Deployment `sandbox-relay`

- `replicas: 1`, `strategy: Recreate`. The relay is presence-only: each Attach stream is held by
  exactly one process, so two replicas would split the sandboxes between them, and an exec could
  reach the wrong one.
- Env:
  - `SH_RELAY_PORT=9443`
  - `MOCA_RELAY_EXEC_ADDR=0.0.0.0:9444` (the split-listener mode `main.ts:314-322` already supports)
  - `SH_RELAY_TOKEN` and `MOCA_RELAY_EXEC_TOKEN` from Secret `moca-relay`
  - `REDIS_URL` from Secret `moca-redis`
- Probes: `tcpSocket` on 9443 (readiness and liveness). The relay has no health endpoint (§1).
- Resources: requests `256Mi`/`50m`, limit `512Mi`, the values already measured.
- `terminationGracePeriodSeconds: 120`. UID 65532.

### 3.3 Sandboxes: StatefulSet `moca-sandbox` (namespace `moca-sandbox`)

- Image `ghcr.io/rossoctl/moca-remote-worker`. `replicas: 2` (the VM's `SH_SANDBOX_COUNT` default),
  `podManagementPolicy: Parallel`, and a headless Service `moca-sandbox` for `serviceName` (no ports).
- **`SANDBOX_ID` comes from `metadata.name`** through the downward API, giving `moca-sandbox-0`, `-1`,
  … Each pod has a unique, stable id, so no two pods ever share one `sh:sandbox:records` entry
  (the collision `deploy/compose/README.md` warns about).
- `RELAY_ADDR=sandbox-relay-attach.moca.svc:9443`; `SANDBOX_TOKEN` from Secret `moca-relay-attach`
  (the only Secret any MOCA object references in its namespace).
- UID 1001 (the image's `USER`), `fsGroup: 0`. The image's `/workspace` and `/home/sandbox` are
  `1001:0`, mode 775.
- No PVC. The workspace is container-local and lost on restart, matching the VM's sandbox
  containers.
- Resources: requests `10m`/`64Mi`, limit `512Mi`. The limit is raised from
  `worker-deployment.yaml`'s 256Mi because research turns run `git clone`.

### 3.4 Redis: StatefulSet `redis`

- `redis:7-alpine`, run as `redis-server /etc/redis/redis.conf`. The config file is Secret
  `moca-redis`'s `redis.conf` key (`requirepass <password>`, `appendonly yes`, `dir /data`), mounted
  read-only. The password is therefore never in the process's argv. `--requirepass` on the command
  line would put it in `/proc/<pid>/cmdline` and in `ps` on the node.
- A `volumeClaimTemplate` of 1Gi (default storage class) mounted at `/data`. Sessions and presence
  survive a Redis restart, which fixes the VM pain recorded in #410 for this path.
- Readiness and liveness: `exec: [sh, -c, 'redis-cli ping | grep -q PONG']`, with `REDISCLI_AUTH`
  set from the Secret's `REDIS_PASSWORD` key in the container's env. The `grep` is needed because
  `redis-cli` exits 0 on a `NOAUTH` error reply too. `redis-cli` reads that variable, so no
  `-a <password>` appears in argv.
- UID 999 (the image's `redis` user), with `runAsGroup` and `fsGroup` 1000 (the image's `redis`
  group).
- **Every client gets `REDIS_URL=redis://:<password>@redis.moca.svc:6379`** from the same Secret.
  node-redis parses credentials from the URL, and no client builds them separately (§6.2 covers the
  one place a URL is logged).

### 3.5 Control plane: Deployment `moca-control-plane`

Adapted from `deploy/knative/control-plane.yaml`:

- **Kept:** the ServiceAccount, the `credentials` Role and RoleBinding (secrets
  get/create/update/patch/delete, no list), the security context, and the existing `/healthz` and
  `/readyz` probes.
- **Dropped:** the `sh-control-plane-pods` Role and binding. It serves only
  `GET /v1/sessions/{id}/resources` for a harness that reports `sandboxPod`/`sandboxSelector`, which a
  relay-attached harness never does, and its absence fails soft (`resources.ts:30-31,42-45`). Also
  dropped: the unbound maintenance Role.
- `SH_CREDENTIAL_STORE=kubernetes`, set explicitly (today it is only the default);
  `SH_CREDENTIAL_NAMESPACE=moca-credentials`.
- **Secrets as files:** `SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_CREDENTIAL_KEK` and `SH_EXCHANGE_TOKEN` are
  mounted from `moca-mu1` under `CREDENTIALS_DIRECTORY` (`withCredentials`, `main.ts:17`).
- Non-secret settings come from ConfigMap `moca-settings`: `SH_GITHUB_CLIENT_ID`, `SH_ADMIN_SUBJECTS`,
  `SH_PUBLIC_HARNESS_URL`, `SH_ALLOW_OPERATOR_FALLBACK`.
- UID 65532. Its ServiceAccount token is mounted (it needs the kube API).

## 4. Secrets and `setup.sh`

### 4.1 `deploy/k8s/setup.sh`

```
deploy/k8s/setup.sh --target kind|kind-ci|ocp [--image IMG] [--sandbox-image IMG] [--build|--skip-build]
                    [--tls-cert FILE --tls-key FILE]        # ocp only
env: SH_GITHUB_CLIENT_ID, SH_ADMIN_SUBJECTS, SH_ALLOW_OPERATOR_FALLBACK, SH_SANDBOX_COUNT,
     SH_WAIT_SECONDS
     SH_SOURCE_ONLY=1   # define functions and stop (tests)
```

Steps, in order. Every step is idempotent.

**Inputs are sticky.** A re-run keeps every input it is not given, so changing one input never
resets the others. `SH_GITHUB_CLIENT_ID`, `SH_ADMIN_SUBJECTS` and `SH_ALLOW_OPERATOR_FALLBACK` are
read back from the ConfigMap `moca-settings` when the variable is unset; a variable set to empty
clears its value. `SH_SANDBOX_COUNT`, and on `ocp` `--image` and `--sandbox-image`, are kept in a
non-secret ConfigMap `moca-setup` in `moca` and reused when not given (Kind always runs the locally
loaded images, so it stores none). Both ConfigMaps are read with `--ignore-not-found`; any other
API error aborts the run instead of resetting the inputs.

1. **Preflight.**
   - Common: `kubectl`, `openssl`, `jq`.
   - `kind`: `kind` ≥ 0.24.0, the first release whose default CNI enforces NetworkPolicy (via
     kube-network-policies), and `docker`. An older `kind` is refused with a message saying why.
   - `ocp`: `oc`, logged in.
   - `--tls-*` with `--target kind` is refused.
2. **Images.**
   - `kind`: create cluster `moca` if it is missing. Then pull, or else build, and `kind load` both
     images, the pattern of `setup-kind.sh::ensure_harness_image`. `--build` forces the build;
     `--skip-build` assumes the images are loaded.
   - `ocp`: GHCR images, through the overlay's `images:`.
3. **Namespaces** (`kubectl apply` of the base's Namespace objects alone, so Secrets can land before
   the workloads).
4. **Secrets, generated once** (§4.2).
5. **`kubectl apply -k deploy/k8s/.generated/<target>`**, a generated overlay whose only resource
   is `../../overlays/<target>`, plus the per-run patches. On OCP, setup first substitutes the Route
   host (from `ingresses.config/cluster`'s apps domain, `.spec.domain`) into
   `SH_PUBLIC_HARNESS_URL`, and grants `nonroot-v2` to each ServiceAccount (`moca-supervisor`,
   `sandbox-relay`, `redis`, `moca-control-plane`, and `moca-sandbox` in its namespace). That is the
   `setup-ocp.sh:460-475` precedent, for the same reason: restricted-v2 does not reliably accept an
   explicit UID.
6. **Wait.**
   - `kubectl rollout status` for every workload.
   - Then for `SH_SANDBOX_COUNT` (default 2) presence records:
     `kubectl exec redis-0 -- sh -c 'redis-cli HLEN sh:sandbox:records'`. The container's own
     `REDISCLI_AUTH` supplies the password, so it never crosses the command line. Timeout 120s, with
     a diagnosis naming the relay log on failure.
   - With no `SH_GITHUB_CLIENT_ID`, the control plane is **rendered** with `replicas: 0`: setup adds
     a kustomize patch to the render before `apply`, rather than scaling down afterwards, so it never
     starts into a crash-loop. Setup says so. This mirrors `setup-vm.sh`'s "installed but not
     started"; a re-run with the client id renders `replicas: 1`, and so does every later re-run
     without it, because the stored client id is sticky.
7. **Print how to reach it.**
   - Kind: the two `kubectl port-forward` commands, and
     `mocactl --control-plane-url http://127.0.0.1:8090 login`.
   - OCP: both Route URLs, and `mocactl --control-plane-url https://<control-plane host> login`.

### 4.2 Secrets

**Rules**, all tested (§9.3):

- Generated once and never rotated. A Secret that exists but lacks a key gets that key patched in,
  as `setup-ocp.sh::gen_relay_token` does.
- **No secret value ever appears on a command line.** Values are built in shell variables and
  applied as Secret YAML on stdin (`kubectl apply -f -`).
- 32-byte random values come from `openssl rand -hex 32`.
- The MU1 keys come from a one-shot
  `kubectl run moca-genkeys --rm -i --restart=Never --image=<harness> -n moca -- node --import tsx src/genkeys.ts`
  (working directory `/app/packages/control-plane`), parsed from stdout, and validated by the same
  regexes `deploy/compose/install.sh` uses. It needs only the image, so OCP needs no local Docker or
  Node.

| Secret                | Namespace    | Keys                                                                                                     | Consumed by                                                                                                                    |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `moca-relay`          | moca         | `SH_RELAY_TOKEN`, `MOCA_RELAY_EXEC_TOKEN`                                                                | relay (both, env); supervisor (`MOCA_RELAY_EXEC_TOKEN` only, env)                                                              |
| `moca-redis`          | moca         | `REDIS_PASSWORD`, `REDIS_URL`, `redis.conf`                                                              | Redis (`redis.conf` as a file; `REDIS_PASSWORD` as `REDISCLI_AUTH` for probes); supervisor, relay, control plane (`REDIS_URL`) |
| `moca-mu1`            | moca         | `SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN` | control plane (private key, KEK, exchange token as files); supervisor (exchange token as a file, public keyset as env)         |
| `moca-relay-attach`   | moca-sandbox | `SH_RELAY_TOKEN` (copied from `moca-relay`)                                                              | sandboxes                                                                                                                      |
| `moca-supervisor-tls` | moca (OCP)   | `tls.crt`, `tls.key`                                                                                     | ghostunnel sidecar                                                                                                             |

The relay already refuses to boot when `MOCA_RELAY_EXEC_TOKEN` equals any sandbox token
(`main.ts:78-103`), so a copy-paste mistake between the two fails loudly.

## 5. NetworkPolicy

**This is what replaces `isolate=strict` and nftables.**

Each namespace has a policy selecting all pods with `policyTypes: [Ingress, Egress]` and no rules
(default deny). Then:

| Pod           | Ingress allowed                                                                                                                                                                                                                                                                                                                   | Egress allowed                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| supervisor    | 8080: nothing from the pod network. Kind users arrive via `port-forward` and the OCP sidecar via loopback, and NetworkPolicy filters neither. 8443 (OCP): from the router namespace (`policy-group.network.openshift.io/ingress`). 8081: from pods in `moca`; the kubelet's probes are admitted by the CNI (see the risk in §10). | DNS; `redis` 6379; `sandbox-relay` **9444**; `moca-control-plane` 8080; `0.0.0.0/0` TCP 443 (model API)                                                    |
| relay         | **9443 from pods in `moca-sandbox`**; **9444 from `moca-supervisor` pods only**                                                                                                                                                                                                                                                   | DNS; `redis` 6379                                                                                                                                          |
| Redis         | 6379 from supervisor, relay, control plane                                                                                                                                                                                                                                                                                        | none                                                                                                                                                       |
| control plane | 8080 from `moca-supervisor` pods; from the router namespace (OCP edge Route). Kind users arrive via `port-forward`.                                                                                                                                                                                                               | DNS; `redis` 6379; `0.0.0.0/0` TCP 443 and 6443 (kube API, GitHub), as `deploy/knative/harness-egress-policy.yaml` does                                    |
| sandbox       | **none**                                                                                                                                                                                                                                                                                                                          | DNS; `sandbox-relay` 9443 in `moca`; `0.0.0.0/0` **except** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16` (all ports) |

DNS means `kube-system` UDP/TCP 53 in the base; the OCP overlay adds `openshift-dns` 5353.

**The sandbox rule** lets research turns reach the internet (`curl`, `git` over 443 and 80) while
blocking every cluster-internal address, including Pod and Service CIDRs, which sit inside the
private ranges on Kind and OCP. It also blocks cloud instance metadata, which the VM path leaves open
(#357). The only cluster destination a sandbox has is the relay's attach port, allowed by a
pod-selector rule.

## 6. Code changes

Both changes leave the VM and Compose paths behaving exactly as before.

### 6.1 Supervisor admin listener (`packages/supervisor/src/admin.ts`, `config.ts`)

- **`SH_ADMIN_HOST`**: the admin listener's bind address.
  - The default is `127.0.0.1`, today's hard-coded value.
  - `readConfig` validates it as an IPv4 or IPv6 literal (`net.isIP`), and refuses anything else with
    a message naming the variable. Hostnames are refused so the bind is never subject to DNS.
  - It is added to `SupervisorConfig` as `adminHost` and passed to `startAdminServer`.
- **`GET /healthz`**: 200 `ok` whenever the admin server is answering.
- **`GET /readyz`**: 200 when at least one worker in `pool.views()` is `healthy`, otherwise 503. The
  body is JSON either way: `{ "ready": bool, "workers": W, "healthy": n }`.
  - **Saturation does not affect readiness.** A saturated pod still answers 200. The 429 at the data
    port is the overload signal (§3.5 of the P6 spec); tying readiness to it would make pods flap out
    of the Service under exactly the load they exist to absorb.
- Everything else still answers 404 as now.
- `/metrics` is unchanged, and so is the env allowlist pinned by `admin-allowlist.test.ts`. A wider
  bind exposes nothing new: the NetworkPolicy (§5) limits who can reach the port.
- `deploy/vm/env/supervisor.env.example` gets a commented `#SH_ADMIN_HOST=127.0.0.1` line with one
  sentence on when to change it. Compose leaves it unset.

### 6.2 Redact Redis credentials from errors (`harness/src/pool-records.ts:84`)

The URL now carries a password, and `redis at ${this.url} unreachable…` would log it. Add
`redactUrl(url)`, exported for reuse. It lives in `@moca/session-backend`, the lowest layer that
logs Redis URLs, and `harness/src/redact-url.ts` re-exports it (v1.1). For a parseable URL with
credentials it returns the URL with `user:password@` replaced by `***@`; it returns any other input
unchanged. Apply it there, and at every other site a Redis URL reaches a log line or error message.
The plan's first task greps for them; the survey found only this one.

## 7. Overlays

### 7.1 `overlays/kind`

- `images:` swaps to `dev.local/moca:local` and `dev.local/moca-remote-worker:local`.
- `SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080` in `moca-settings`.
- No sidecar and no Route.
- **`overlays/kind-ci`** builds on `overlays/kind` and adds only:
  - a `mock-model` sidecar in the supervisor pod running `mock-anthropic.mjs`, from a ConfigMap
    generated from the file, on `127.0.0.1:18099` (its default `--port`). The mock is loopback-only
    by design, and a sidecar keeps it so;
  - `SH_MODEL_BASE_URL` (and related settings) pointing at it;
  - a placeholder `SH_GITHUB_CLIENT_ID` (`Iv1.k8s-smoke-unused`, as Compose's smoke does).

  The mock needs new scripted prompts for this smoke (§9.4). It is not a general mock: anything
  unscripted gets a 400.

  **Decided (v1.1):** the scripts are added in place, to `deploy/microvm/mock-anthropic.mjs`, under
  new keys. `setup.sh --target kind-ci` loads the file into ConfigMap `moca-mock-model`
  (`kubectl create configmap --from-file … --dry-run=client | kubectl apply -f -`), so no
  kustomization reads a file outside its root. The P4 smoke keeps passing unchanged.

### 7.2 `overlays/ocp`

- `images:` to GHCR.
- **A ghostunnel sidecar** in the supervisor pod (`docker.io/ghostunnel/ghostunnel`, pinned by
  digest):
  - command: `server --listen 0.0.0.0:8443 --target 127.0.0.1:8080 --cert /tls/tls.crt --key /tls/tls.key --disable-authentication`
  - `moca-supervisor-tls` mounted at `/tls`; UID 65532; `readOnlyRootFilesystem`;
  - resources about `10m`/`32Mi`.

  It is a byte-for-byte TCP proxy, so **each client connection maps to exactly one supervisor
  connection.** The supervisor's per-connection hand-off, routing and admission see the same
  connections they would see without it. The supervisor itself still listens on 0.0.0.0:8080, but
  §5 gives that port no ingress from the pod network.

- Service `moca-supervisor-tls` (8443) and **Route `moca` with `tls.termination: passthrough`** to
  it.
- **Route `moca-control-plane` with `tls.termination: edge`**. The control plane is ordinary HTTP,
  and connection reuse there is harmless.
- `SH_PUBLIC_HARNESS_URL=https://<moca route host>`, substituted by `setup.sh` (§4.1 step 5).
- NetworkPolicy additions: the router-namespace ingress rules in §5, and `openshift-dns` 5353 for
  DNS.
- **The cert:**
  - A passthrough Route needs a cert valid for the Route hostname, which `service-ca` cannot issue.
    So `--tls-cert`/`--tls-key`, a cert for that host, is the supported path.
  - Without them, `setup.sh` generates a self-signed cert for the host (`openssl req -x509`, 825
    days) and prints a warning plus the `NODE_EXTRA_CA_CERTS=<file>` line `mocactl` users need.
  - An existing `moca-supervisor-tls` is never replaced unless `--tls-cert` is given.

## 8. What stays the same, on purpose

- **Processes and wire contracts:** no change to the Attach/SandboxExec protos, the `/v1` API, or
  token formats.
- **Images:** the two existing images. The one new image, ghostunnel, is third-party, OCP only, and
  pinned by digest.
- **The VM and Compose paths:** byte-identical behaviour. Their tests pass unchanged, apart from the
  new commented env line in §6.1.
- **The container tier's documented non-claims carry over verbatim:**
  - no sandbox isolation between users (MI1 S5);
  - direct credential mode (MI1 S2);
  - sandbox egress open to the internet, though no longer to metadata or cluster ranges.

## 9. Testing

### 9.1 Unit (vitest)

- `packages/supervisor/test/config.test.ts`: `SH_ADMIN_HOST` default, IPv4, IPv6, and refusal of a
  hostname and garbage; a blank value means the default, as for every other supervisor knob.
- `packages/supervisor/test/admin.test.ts`:
  - the bind honours `adminHost`;
  - `/healthz` is 200;
  - `/readyz` is 200 with one of two workers healthy, 503 with none, and **200 with every worker
    saturated**;
  - unknown paths still 404.
- `harness/test/redact-url.test.ts`: credentials redacted, a credential-less URL unchanged, an
  unparseable string unchanged, a username-only URL redacted.
- The `pool-records` unreachable error contains no password.

### 9.2 Manifest tests (vitest, over `kubectl kustomize` output of each overlay)

They live in `packages/supervisor/test/k8s/`, the package that owns P6. There is no root vitest
config: `make test` is `pnpm -r test` over the workspace packages. They skip with a visible reason
when `kubectl` is absent (GitHub's Ubuntu runners have it).

They assert:

- **Env parity:** every variable in `deploy/vm/env/supervisor.env.example` and `relay.env.example`
  is set on the matching container, except an explicit, commented list of addressing and
  credential-transport differences. This is `compose.test.sh`'s rule.
- **Sandbox namespace contents:** the only Secret any MOCA object references in `moca-sandbox` is
  `moca-relay-attach` (key `SH_RELAY_TOKEN` only), and no object there references `MOCA_RELAY_EXEC_TOKEN`, `moca-redis`
  or `moca-mu1`.
- The relay has `replicas: 1` and `strategy: Recreate`.
- **The fork constraint:** the supervisor Deployment has exactly one container whose command runs
  the supervisor, and no other workload runs `src/worker.ts` or the supervisor.
- Supervisor memory request ≥ `SH_WORKERS` × 256Mi.
- `terminationGracePeriodSeconds` ≥ 120 on the supervisor and relay.
- **L4 only:** no `Ingress` object, no `serving.knative.dev` object, and on OCP the Route to the
  supervisor is `passthrough` and targets the sidecar's port.
- **NetworkPolicy coverage:** every pod template's namespace has a default deny on both directions;
  the relay's 9444 ingress rule selects only supervisor pods; the sandbox egress `except` list
  contains all five ranges.
- `SANDBOX_ID` comes from `fieldRef: metadata.name`.
- `SH_EXCHANGE_TOKEN` is never an env var on any container.

### 9.3 Script tests (bash, `deploy/k8s/tests/setup.test.sh`, added to `make test-deploy`)

Mocked `kubectl`, `kind`, `docker`, `oc` and `openssl` on `PATH` write an argv call log, the pattern
of `deploy/knative/tests/`. They cover:

- target validation;
- the `kind` version gate;
- `--tls-*` refused with kind;
- secrets created on a first run and untouched on a second;
- a missing key patched in without touching the others;
- **no generated secret value appears anywhere in the argv log**;
- `genkeys` output validated, with a malformed line refused;
- OCP SCC grants for every ServiceAccount;
- the control plane scaled to 0 without a client id;
- the self-signed cert path, and never replacing an existing TLS Secret.

shellcheck covers `setup.sh` and `smoke.sh` through the existing lint (`-x -S warning`).

### 9.4 Live smoke (`deploy/k8s/smoke.sh`, gated by `K8S_LIVE_SMOKE=1`)

Run against a deployed stack: `kind-ci` in CI, or any overlay by hand with a real model. Sessions
are authenticated by an API token the smoke mints inside the control-plane pod with the pod's own
signing key, which never leaves the pod, as `deploy/compose/smoke.sh` does. The device flow is exercised only in the OCP demo
(§9.6).

The claims:

1. `/readyz` reports W workers, all healthy.
2. `sh:sandbox:records` holds `moca-sandbox-0` and `moca-sandbox-1`.
3. An authenticated `/v1/turn` runs a command in a sandbox and streams over SSE.
4. The session persists, and a second turn sees it.
5. The control plane's `/readyz` passes, and `/v1/discovery` advertises the harness URL.
6. An unauthenticated `/turn` is refused.
7. **Isolation, from inside a sandbox pod:** TCP connects to `redis.moca.svc:6379`,
   `sandbox-relay-exec.moca.svc:9444` and `169.254.169.254:80` each fail. A connect to
   `sandbox-relay-attach.moca.svc:9443` succeeds. On OCP, a connect to `kubernetes.default.svc:443`
   fails too; on Kind its result is only a note (§0.1).
8. **A research turn:** `curl -sI https://example.com` and `git ls-remote https://github.com/rossoctl/moca`
   from the sandbox both succeed (scripted through the mock in CI).
9. **Drain:** a turn in flight across the deletion of its supervisor pod (a rollout with
   `maxUnavailable: 0` may not signal the old pod before the turn ends) completes, and its SSE
   stream ends with the turn's normal terminal event.
10. **Persistence:** after `kubectl delete pod redis-0`, the session from claim 4 is still readable.
11. **No restarts:** no container in `moca` or `moca-sandbox` has a restart count above 0 (no OOM
    kill, no crash), apart from the pods the smoke deleted. §10's OOM row relies on it.

### 9.5 CI

A new job, `k8s-kind-e2e`, in its own workflow, `.github/workflows/k8s-e2e.yml` (path filters are
per workflow): `setup.sh --target kind-ci --build`, then `K8S_LIVE_SMOKE=1 deploy/k8s/smoke.sh`
under `pipefail`, uploading the pod logs on failure. It runs on pull requests touching
`deploy/k8s/**`, the mock model, `packages/**`, `harness/**`, `remote-worker/**`, `pi-fork`, the
Dockerfile or the lockfile, and on pushes to `main`. **It is not a required check** until it has
passed ten consecutive `main` runs; the README records that rule.

### 9.6 Demo parity on OCP (manual, recorded)

A "Demo on OpenShift" section in `deploy/k8s/README.md` walks through the container-tier acts of
`docs/demos/vm-multi-user-demo.md` against the OCP overlay:

- two GitHub accounts log in through the device flow;
- `mocactl doctor` passes for both;
- their session lists are disjoint, and a cross-owner session is refused like a nonexistent one;
- each user's turns spend their own inference credential;
- each user runs a `curl`/`git` research turn.

It is performed once live, and the results are posted on rossoctl/moca#423. That run is the slice's
acceptance gate, alongside green §9.1–§9.5.

## 10. Risks and things to verify early

| Risk                                                                                                                        | Verification                                                                                                                                                                                                                                                               | Fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubelet probes are filtered by NetworkPolicy on kube-network-policies (Kind) or OVN-Kubernetes (OCP).                       | The first plan task deploys the base with default deny and checks the probes.                                                                                                                                                                                              | Per-overlay ingress allow from the node CIDR to 8081 (supervisor) and the control plane's port.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `port-forward` traffic is filtered on some CNI.                                                                             | Smoke claims 1, 3 and 5 exercise it.                                                                                                                                                                                                                                       | Document it; add an allow from the node CIDR on Kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The OCP router's passthrough path keeps the TCP connection 1:1. It should: passthrough is SNI-routed TCP.                   | During the OCP demo, count the established connections inside the supervisor pod on 8443 against 8080 (both `/proc/net/tcp` and `/proc/net/tcp6`) while turns run concurrently. `/metrics` has no per-connection counter; a `handoffs` counter there would be a follow-up. | An L4 LoadBalancer Service for the sidecar's port.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenShift's restricted-v2 rejects the explicit UIDs even with `nonroot-v2` granted.                                         | Applying `overlays/ocp`.                                                                                                                                                                                                                                                   | The precedent in `setup-ocp.sh` already works for 65532. Redis's 999 is the new case; the fallback is a patch in `overlays/ocp` that drops `runAsUser`, `runAsGroup` **and** `fsGroup` from Redis's pod `securityContext`, so restricted-v2 assigns all of them from the namespace's range (README §9.1). Keeping `fsGroup: 1000` does not work: restricted-v2 refuses an fsGroup outside the range, so `nonroot-v2` admits the pod with no UID and the image runs as root (`CreateContainerConfigError`). |
| The W=2 supervisor pod is OOM-killed at its memory limit (nothing has yet run W tsx-compiled workers under a memory limit). | `kind-ci` runs the real W=2 pod, and the smoke fails on any restart count above 0.                                                                                                                                                                                         | Raise the requests and limit; the manifest test enforces the floor, not the value.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The default storage class is missing (Kind has one; some OCP clusters don't).                                               | `setup.sh` preflight warns when no default class exists.                                                                                                                                                                                                                   | `--redis-storage-class` is a later addition, if needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 11. Deliverables

```
deploy/k8s/
├── base/                    # namespaces, workloads (§3), Services (§2.2), NetworkPolicy (§5), RBAC (§3.5)
├── overlays/kind/
├── overlays/kind-ci/        # mock-model sidecar, placeholder client id
├── overlays/ocp/            # ghostunnel, Routes, router + openshift-dns rules, GHCR images
├── setup.sh
├── smoke.sh
├── tests/setup.test.sh
└── README.md                # what runs, L4-only rule, replicas vs W, non-claims, Demo on OpenShift
packages/supervisor/src/{admin,config}.ts (+ tests)       # §6.1
packages/supervisor/test/k8s/                             # manifest tests (§9.2)
harness/src/redact-url.ts, harness/src/pool-records.ts (+ tests)   # §6.2
deploy/vm/env/supervisor.env.example                      # one commented line
.github/workflows/k8s-e2e.yml                             # k8s-kind-e2e
Makefile                                                  # test-deploy includes deploy/k8s/tests
docs/adrs/0037-p6-on-kubernetes-substrate.md
docs/specs/README.md                                      # P6.1 row
```

**ADR-0037**, "P6 on Kubernetes is a substrate, not the deprecated Knative path", records:

- RA1 deprecates the Knative/KEDA path, `KubectlTransport` and pod-exec sandboxes, **not
  Kubernetes as a substrate**;
- P6.1 runs the P6 process model and `GrpcRelayTransport` there, and shares no code or manifest
  with `deploy/knative/`;
- the L4-only rule for the supervisor, and why.
