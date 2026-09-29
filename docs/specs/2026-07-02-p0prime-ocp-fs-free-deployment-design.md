# P0′ — OpenShift Deployment of the FS-Free Harness (P1 slice) — Design

Version: 1.0 — July 2, 2026
Status: Design (approved for implementation planning)
Scope: **P0′** of the [two-tier FS-free harness epic](https://github.com/rossoctl/moca/issues/49)
([P0′ issue #47](https://github.com/rossoctl/moca/issues/47)) — **the P1 slice only**.
Deploy the now-merged FS-free harness ([P1](2026-07-02-p1-fs-free-harness-design.md), #45) plus a
**single durable RWO sandbox** on the live OpenShift 4.20.8 cluster, and prove it with the existing
full leaf smoke through the OCP Route. Realize on OCP exactly what `setup-kind.sh` already does on
Kind post-P1.
Builds on (reuse, no redesign): the P1 manifests (`deploy/knative/service.yaml`, `sandbox.yaml`),
the `lib.sh` Route contract, `leaf-smoke.sh`, and the existing (pre-P1, speculative) OCP overlay +
`setup-ocp.sh` scaffolding from issue #41 (PR #43).
Substrate: OpenShift Serverless (Knative Serving v1.17, **installed**), KEDA (**installed**),
**agent-sandbox** controller (`sandboxes.agents.x-k8s.io`, kubernetes-sigs **v0.5.0** — **not yet
installed on the cluster**), AWS EBS `gp3-csi`/`gp2-csi` (RWO only, no RWX), Redis.

> **What this slice is NOT.** Not the shared sandbox pool or N:M routing, and **not** RWX on the
> sandbox tier (P2 — [#46](https://github.com/rossoctl/moca/issues/46); RWX, if ever
> needed, relocates there, not to the harness). Not Kata isolation or ratio experiments
> (P3 — [#48](https://github.com/rossoctl/moca/issues/48), deferred). Not
> `leaf-orchestrator.yaml` or the gate/cron smokes (a separate P1 follow-up — they still reference
> removed envelope files; **do not expand into them here**). Not the superseded
> `docs/archetype-a-ocp-support` branch (NFS-RWX-for-harness) — after P1 the harness mounts nothing,
> so **do not implement its plan**.

---

## 1. Goal & motivation

P1 made the harness filesystem-free: the leaf envelope is inline-in / inline-or-Redis-out, the
sandbox working set moved from `emptyDir` to an agent-sandbox `Sandbox` CR with a durable PVC, and
the harness Service mounts only `/tmp`. That work is **merged and Kind-verified** but has **never run
on OpenShift**. P0′ (this slice) closes that gap: a real, durable, non-root deployment on OCP 4.20.8,
verified end-to-end with the model-in-the-loop leaf smoke.

The OCP overlay and `setup-ocp.sh` were written **before** P1 landed (issue #41 / PR #43), as
speculative "OCP-aware" scaffolding, and were **never applied to a live cluster**. Post-P1 they are
broken in four independent ways (§3). P0′ reframes them to the Sandbox-CR world and proves them.

## 2. Threat model & security posture (inherited, not relitigated)

Same as epic #49 / P1: the sandbox is a **passive `kubectl exec` target** (no agent in it); the
threat is a compromised/injected **harness** and kernel exploits, contained by giving the harness
zero FS/exec surface (done in P1) and — eventually — Kata-isolating the sandbox (P3, deferred). On
OCP the incremental posture decisions are only about **satisfying the platform's SCCs without
weakening this model**: run both tiers **non-root** under `nonroot-v2` (harness already does; the
sandbox will too — §5.2). No `anyuid`, no privileged pods.

## 3. Current state — what P0′ must fix

Verified against `main` @ `d199484` and a read-only inspection of the live cluster.

### 3.1 Live cluster (ready substrate)

- OCP **4.20.8** / k8s 1.33.6; kubeconfig authenticates as cluster-admin.
- OpenShift Serverless **KnativeServing v1.17 Ready**; KEDA Ready (`openshift-keda`).
- StorageClasses `gp3-csi` (default) + `gp2-csi` — both AWS EBS, **RWO, `WaitForFirstConsumer`**, no RWX.
- Knative/ingress domain `apps.rosso1.kubestellar.org`. SCCs `nonroot-v2` + `restricted-v2` present.
- **agent-sandbox `Sandbox` CRD is NOT installed** (only unrelated kagenti `agentcards`/`agentruntimes`).
- No existing harness namespace — clean slate.

### 3.2 The four breakages (post-P1)

1. **Stale resource reference.** `deploy/knative/overlays/ocp/kustomization.yaml` still lists the
   **deleted** `../../leaf-pvc.yaml` → `kustomize build` fails outright. (P1 removed `leaf-pvc.yaml`.)
2. **Wrong patch target.** `overlays/ocp/patch-sandbox.yaml` is `kind: Pod, name: sandbox-0`, but the
   base (`sandbox.yaml`) defines a **`Sandbox` CR**, not a Pod. The agent-sandbox controller creates
   the pod from the CR's `podTemplate`; a strategic-merge Pod patch against a base with no Pod is a
   no-op/error. Security context must be patched **onto the `Sandbox` CR's `podTemplate`**.
3. **Durability defeated.** That same patch overrides `/workspace` to `emptyDir: {}`, which
   **contradicts the entire point of P0′** (durable sandbox storage, #47/#49). The Sandbox CR's
   `volumeClaimTemplates` (RWO 1Gi) must back `/workspace`. `emptyDir` also silently breaks the
   smoke's crash/resume claim (a pod restart would wipe the seeded repo).
4. **Missing `ripgrep`.** `deploy/knative/sandbox.Dockerfile` installs `bash coreutils findutils
grep` but **not `ripgrep`**. The leaf's `find`/`grep` tools route to `rg` inside the sandbox
   (`packages/k8s-sandbox/src/operations.ts`, `grep-tool.ts`), so the full leaf smoke crashes on the
   first search. Kind avoids this because its base `sandbox.yaml` does `apk add … ripgrep` at startup;
   the OCP image pre-bakes tools (no root `apk add` under `restricted-v2`) and omitted `rg`.

### 3.3 `setup-ocp.sh` gaps (vs. the working `setup-kind.sh`)

- **Never installs the agent-sandbox controller** (Kind applies the v0.5.0 `manifest.yaml` +
  `kubectl wait` the CRD Established).
- **Never applies/awaits the Sandbox CR** — no `.status.selector` poll → pod-Ready (Kind polls up to
  120s before waiting on the pod).
- No SA / SCC grant for the **sandbox** pod (only the harness SA gets `nonroot-v2`).
- `README-ocp.md` still references a `leaf-work` PVC that no longer exists.

## 4. Approach decision — sandbox image source

The sandbox image can be **built in-cluster** (existing BuildConfig → internal registry) or **pulled
from GHCR** (`build.yaml` publishes `ghcr.io/rossoctl/moca-sandbox` on every push to
`main`, explicitly "instead of building it in-cluster").

**Decision: keep the in-cluster build (Option A) for P0′.** We live-verify **before** merging, and
GHCR `:latest` only rebuilds on merge — so the `ripgrep` fix (§3.2.4) cannot reach GHCR in time for a
pre-merge smoke. The in-cluster BuildConfig honors the local Dockerfile fix immediately and keeps the
phase self-contained (no dependency on GHCR freshness/pullability). The harness image stays
GHCR-pulled (`ghcr.io/rossoctl/moca:latest`, auto-published post-P1).

> **Follow-up (not P0′).** Once the `ripgrep` fix merges and CI republishes the GHCR sandbox image,
> switching the OCP overlay to pull it (Option B, symmetric with the harness, drops the BuildConfig)
> is a clean simplification. Tracked as a note, not implemented here.

## 5. Design

### 5.1 Target topology (P1 architecture, realized on OCP)

- **Harness** — Knative Service, image `ghcr.io/rossoctl/moca:latest`, runs **non-root**
  (UID 65532, `nonroot-v2`), mounts only `/tmp` (emptyDir). Resolves the sandbox pod via
  `KAGENTI_SANDBOX_NAME=sandbox-0` → the `Sandbox` CR's `.status.selector` label query → `kubectl
exec`s all 7 Pi tool ops into it. External access via the Knative **Route** (`KSVC_URL` contract in
  `lib.sh`: Route host, `-k`, no Host header).
- **Sandbox** — one `Sandbox` CR (`sandbox-0`, `agents.x-k8s.io`), managed by the agent-sandbox
  **v0.5.0** controller. `/workspace` backed by a **durable RWO EBS PVC** from the CR's
  `volumeClaimTemplates` (`gp3-csi`, 1Gi). Image = the in-cluster-built `moca-sandbox`
  (alpine + `bash coreutils findutils grep ripgrep`), `command: [sleep infinity]`, non-root.
- **Redis** — `deploy/knative/redis.yaml` (result record + async queue), unchanged.

### 5.2 Sandbox SCC / non-root model (the OCP-specific core)

Chosen approach: **non-root + `fsGroup`, bound under `nonroot-v2`.** Realized by patching the
**`Sandbox` CR `podTemplate`** in `overlays/ocp/patch-sandbox.yaml`:

- Pod `securityContext`: `runAsUser: 65532`, `runAsNonRoot: true`, **`fsGroup: 65532`**,
  `seccompProfile.type: RuntimeDefault`.
- Container `securityContext`: `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`.
- `serviceAccountName: moca-sandbox` (a dedicated SA, distinct from the harness SA),
  granted `nonroot-v2` (`oc adm policy add-scc-to-user nonroot-v2 -z moca-sandbox …` in
  `setup-ocp.sh`).
- **Keep** the durable PVC from `volumeClaimTemplates` (remove the `emptyDir` override). `fsGroup:
65532` makes the EBS volume group-owned/writable, so the sandbox — and the smoke's `sexec`
  repo-seeding (`leaf-smoke.sh` writes `/workspace/<run>/repo` via `kubectl exec`) — writes as 65532.

**Kustomize mechanism.** Patching a container inside a CRD's `podTemplate` via strategic-merge is a
known kustomize gotcha (no merge-key openapi for the CR's container list). Use a **JSON6902 patch**
targeting `group: agents.x-k8s.io, kind: Sandbox, name: sandbox-0` with explicit paths, or a
strategic-merge patch of `kind: Sandbox` (not `Pod`) if the field-level merge is confirmed correct.
The plan picks one after a quick render check; either way the patch is **onto the `Sandbox` CR**.

### 5.3 Concrete changeset (P1-slice only)

| File                                             | Change                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/knative/sandbox.Dockerfile`              | Add `ripgrep` to the `apk add` line.                                                                                                                                                                                                                                                                                       |
| `deploy/knative/overlays/ocp/kustomization.yaml` | Remove the `../../leaf-pvc.yaml` resource; keep the `images:` transformer (alpine → internal-registry image); wire the corrected sandbox patch.                                                                                                                                                                            |
| `deploy/knative/overlays/ocp/patch-sandbox.yaml` | Rewrite to patch the **`Sandbox` CR** `podTemplate` (§5.2): security context, `serviceAccountName`, `command: [sleep infinity]`; **drop the `emptyDir` override** so `volumeClaimTemplates` backs `/workspace`.                                                                                                            |
| `deploy/knative/setup-ocp.sh`                    | Add: agent-sandbox v0.5.0 controller install (`kubectl apply --server-side -f …/v0.5.0/manifest.yaml` + `kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io`); Sandbox CR apply + `.status.selector` poll → pod Ready; sandbox SA + `nonroot-v2` grant; pre-smoke check that `llm-credentials` exists. |
| `deploy/knative/README-ocp.md`                   | Remove `leaf-work` PVC references; document durable-PVC-via-CR + in-cluster sandbox image + the controller-install step.                                                                                                                                                                                                   |

Log output for all long commands → `/tmp/sh/p0prime/*.log` (per repo Context Budget rules).

### 5.4 Deploy sequence (`setup-ocp.sh`, post-change)

1. OpenShift Serverless operator + `KnativeServing` CR (PVC/securitycontext feature flags) — **exists**.
2. **NEW:** agent-sandbox v0.5.0 controller + CRD (`kubectl wait … Established`).
3. Optional KEDA (`--with-keda`) — exists; **not required** for this slice (sync `/runs` smoke).
4. In-cluster **sandbox image** build (BuildConfig, ripgrep-fixed Dockerfile) → internal registry.
5. `llm-credentials` secret — **user-provisioned**; script **verifies presence**, does not create it.
6. SCC grants: `nonroot-v2` to the harness SA (exists) **+ the new sandbox SA**.
7. `kustomize build overlays/ocp | oc apply -f -` (post-render sed for image/namespace as today).
8. **NEW:** await `Sandbox` `.status.selector` populated → `kubectl wait pod -l <selector> Ready`.
9. Await ksvc Ready → print the Route URL (`KSVC_URL`).

## 6. Verification

**Definition of done:** the **full leaf smoke passes on the live OCP cluster.**

Executed in two stages to de-risk the largest unknown first:

**Stage 1 — walking skeleton (sandbox tier alone).** Install the controller and apply _only_ the
Sandbox CR. Confirm: the PVC binds (`gp3-csi`, `WaitForFirstConsumer` → binds on pod schedule); the
pod runs **non-root** as 65532; `/workspace` is writable (`kubectl exec sandbox-0 -- sh -c 'touch
/workspace/.probe'`). This proves the v0.5.0 controller propagates `volumeClaimTemplates` + the
`podTemplate` `fsGroup`/`runAsUser`/`serviceAccountName` **before** any harness wiring.

**Stage 2 — full deploy + leaf smoke.** Full `setup-ocp.sh`, then `leaf-smoke.sh` with
`KSVC_URL=<route>` and `SH_MODEL=claude-haiku-4-5` (cheap; the M7 live-run convention — overridable).
Assert its existing claims: FS-free envelope; workspace isolation (repo in sandbox only); parallel
fan-out (i1→FLAGGED, i2→CLEAR, i3→CLEAR); per-call model routing (bogus→failed); input validation
(malformed→HTTP 400); **crash/resume** (mid-run pod kill → resume from Redis → verdict still
produced, which now genuinely exercises durable-PVC survival); scale-to-zero.

All long smoke/kubectl output → `/tmp/sh/p0prime/*.log`, analyzed via subagents (never read whole
logs into the main context).

## 7. Risks & mitigations

| Risk                                                                                                                   | Mitigation                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-sandbox v0.5.0 controller may not propagate `podTemplate` `fsGroup`/`runAsUser`/`serviceAccountName` from the CR | **Stage-1 walking skeleton catches it first**, before any harness work. If not propagated, patch the generated pod directly or fall back to a Sandbox-CR field the controller does honor. |
| Kustomize can't cleanly merge a container inside a CRD `podTemplate`                                                   | Use a **JSON6902** patch with explicit paths (§5.2); verify with `kustomize build` render before applying.                                                                                |
| EBS `WaitForFirstConsumer` → PVC `Pending` until pod schedules                                                         | The readiness poll tolerates the `Pending` → `Bound` window (matches Kind's selector-then-Ready poll shape).                                                                              |
| GHCR harness image stale (pre-P1)                                                                                      | `build.yaml` publishes `moca` on **every push to `main`**; P1 is merged, so `:latest` is post-P1. Confirm image digest/date in Stage 2 if the smoke misbehaves.                           |
| `restricted-v2` didn't cleanly inject a UID for the harness (ocp-setup memory)                                         | We **pin** `runAsUser: 65532` and bind under **`nonroot-v2`** (not `restricted-v2`), sidestepping SCC UID injection entirely.                                                             |

## 8. Out of scope / explicit non-goals

- Shared sandbox pool, N:M routing, RWX on the sandbox tier (P2, #46).
- Kata isolation, ratio experiments (P3, #48).
- `leaf-orchestrator.yaml`, gate/cron smokes (separate P1 follow-up).
- Switching the sandbox to the GHCR image (post-merge follow-up, §4).
- The superseded `docs/archetype-a-ocp-support` NFS-RWX-for-harness branch.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
