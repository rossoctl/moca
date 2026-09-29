# Registry + Hardening Hygiene — Design

Version: 1.0 — June 28, 2026
Status: Design (approved for implementation planning)
Scope: A consolidation/hardening bundle after all three leaf-session archetypes shipped (A #12, C #13,
B #14). Three items: (1) register the built leaf-session backend track in the milestone registry;
(2) align `server.ts`'s `isMainModule` idiom with the rest of the package; (3) apply the
cron-dispatch securityContext hardening to the leaf-worker `ScaledJob` and the Knative service.
Purely additive/non-behavioral — no change to `runLeaf`, the gate, the contract, the queue, or KEDA
scaling logic.
Builds on: [Milestone Registry](README.md), [Async Leaf Completion](2026-06-27-async-leaf-completion-design.md), [Scheduled Leaf Dispatch](2026-06-28-scheduled-leaf-dispatch-design.md) (the cron-dispatch securityContext pattern this generalizes), [Human-Gate](2026-06-28-human-gate-design.md).
Out of scope (deferred): reclaimer-churn tuning (no observed problem; the async dual-trigger
lagCount+pendingEntriesCount already prevents the deadlock it guarded — speculative, YAGNI).

> **One-line goal.** Make the repo's roadmap honest about what shipped, remove a fragile
> entrypoint-detection idiom, and bring the two agent-running pods up to the same non-root,
> least-privilege baseline the cron-dispatch pod already has — all verified by the existing gate smoke.

---

## 1. Registry update (`docs/specs/README.md`) — docs only

**Problem.** The registry has Phase-1 (`M1–M7`, built) and Phase-2 (`Z1–Z7`, design-only) tables, but
the **actually-shipped leaf-session backend** — the MVP contract and the three archetypes — is not
recorded in any table. The roadmap is stale w.r.t. what merged.

**Change.** Add a new section **"Leaf-Session Backend (BUILT)"** between the Phase-1 and Phase-2
sections, with a table:

| Slice                                            | Spec                                             | PR                       |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------ |
| MVP leaf-session invocation contract             | `2026-06-26-mvp-leaf-session-contract-design.md` | #10, #11 (gate-7 resume) |
| Async leaf completion (KEDA `ScaledJob` + queue) | `2026-06-27-async-leaf-completion-design.md`     | #12                      |
| Scheduled leaf dispatch (cron trigger on-ramp)   | `2026-06-28-scheduled-leaf-dispatch-design.md`   | #13                      |
| Human-gate (gate-while-idle, Archetype B)        | `2026-06-28-human-gate-design.md`                | #14                      |

A short paragraph notes: these realize the [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md)
§5 MVP core + §8 promote-post-MVP (human-gate, cron trigger), sit **outside** the `M`/`Z` numbering
(they are the MVP/charter track, not the credential plane), and that all three archetypes from the
[Pipeline Archetypes](2026-06-26-pipeline-archetypes-requirements.md) evidence base are now built.

No existing registry rows change. PR numbers are recorded as-merged.

---

## 2. `isMainModule` idiom alignment (`packages/knative-server/src/server.ts`)

**Problem.** `server.ts:184-186` detects "run as entrypoint" with a fragile substring match:
`process.argv[1] && process.argv[1].includes("knative-server")`. `cron-dispatch.ts:75` and
`leaf-job.ts` use the exact, canonical idiom: `process.argv[1] === fileURLToPath(import.meta.url)`.
The substring match would misfire for any argv path containing "knative-server" (e.g. a test runner
or wrapper invoked from such a directory).

**Change.** Add `import { fileURLToPath } from "node:url";` and replace the guard with:

```ts
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
```

**Invariant to preserve:** the server must NOT auto-start when imported (the `server.test.ts` and
route tests import `startServer`). With the exact idiom, `process.argv[1]` during a vitest run is the
vitest binary, not `server.ts`, so the guard is `false` and no listener starts — same effective
behavior as today, verified by the existing server suite staying green.

---

## 3. securityContext hardening (`deploy/knative/leaf-scaledjob.yaml` + `deploy/knative/service.yaml`)

**Problem.** The cron-dispatch pod (`leaf-cron.yaml`) is hardened (non-root, no priv-esc, read-only
rootfs, dropped caps, seccomp). The **leaf-worker `ScaledJob`** and the **Knative service** — both of
which run the harness image — have **no securityContext at all** (only a `/work` mount). They run as
root with default capabilities.

**Change.** Apply the cron-dispatch baseline to both pods:

- **Pod-level:** `runAsNonRoot: true`, `runAsUser: 65532` (the image has no `USER`/runs as root, so
  `runAsNonRoot` alone would refuse to start), `seccompProfile: { type: RuntimeDefault }`.
- **Container-level:** `allowPrivilegeEscalation: false`, `capabilities: { drop: ["ALL"] }`,
  `readOnlyRootFilesystem: true` with a writable `/tmp` `emptyDir` (tsx/node need a temp dir), plus a
  writable `emptyDir` at the agent's home/config dir **if** the Pi session writes there
  (`getAgentDir()` / `SettingsManager` — determined during live verification).

**Knative wrinkle (the service only).** A Knative `Service` gates several `securityContext` fields
behind feature flags. The two PVC flags are already enabled in `setup-kind.sh`
(`kubernetes.podspec-persistent-volume-claim` / `-write`). Hardening the ksvc may additionally
require `kubernetes.podspec-securitycontext` (and possibly `kubernetes.containerspec-add-capabilities`
for the drop). `setup-kind.sh` gets an **idempotent** patch enabling whatever the service manifest
needs; the exact flag set is pinned against the live cluster in the plan. The `ScaledJob` is a plain
Kubernetes Job template — no feature flag needed there.

**`readOnlyRootFilesystem` is decided empirically (Option 1).** Attempt `true` on both pods with the
writable mounts above; if the live gate smoke shows the worker/service need un-redirectable root-fs
writes (e.g. the agent writes outside `/tmp` and the home mount), fall back to
`readOnlyRootFilesystem: false` **on that pod only** (keep `true` on cron-dispatch) and document the
reason inline. The non-fs hardening (non-root, runAsUser, seccomp, no-priv-esc, dropped caps) is
applied unconditionally regardless.

**Risks this surfaces (all caught by the live smoke):**

- `runAsUser: 65532` must be able to **write the `/work` PVC** (the gate writes `result_ref`/markers
  there). `fsGroup: 65532` makes the harness's own writes group-owned, **but** `fsGroup` does NOT
  make a _result directory created by a different (root) writer_ group-writable. **Operational
  contract (confirmed in live verification — EACCES writing the gate marker):** because `/work` is
  the orchestrator's store (charter G3) and the harness now runs as uid 65532, the **orchestrator
  must provision the per-run result directories writable by uid 65532** (e.g. world-writable, or
  created under a shared `fsGroup: 65532` with group-write). The live smoke models this by
  `chmod 0777` on the run dir it provisions. Document this in the operator runbook for non-root
  deployments. (The agent itself runs cleanly under the hardened context — only the cross-writer
  `/work` directory ownership needs this coordination.)
- The leaf-worker performs `kubectl exec` into `sandbox-0`; a non-root uid + dropped caps must still
  do that (it is an API call, not a privileged syscall — confirmed working in live verification).

---

## 4. Verification

- **Unit:** `@moca/harness` and `@moca/knative-server` suites stay green (the only code change is the
  `isMainModule` guard; the server suite proves no auto-start on import).
- **Live gate (the gate that matters):** rebuild the image (it includes the `isMainModule` change)
  with **`docker buildx build --load` and verify the image actually contains the change before
  `kind load`** (a prior session wasted cycles on a buildx `docker-container` driver that never loaded
  the result into the local store); redeploy the `ScaledJob` + service + any `setup-kind.sh` flag
  patch; run `GATE_LIVE_SMOKE=1 deploy/knative/leaf-gate-smoke.sh`. **All 6 claims must still pass**
  with the hardened pods (this exercises the leaf-worker running the full agent under the new
  securityContext, writing `/work`, and `kubectl exec` into the sandbox). The controller runs this
  live gate, never a subagent.
- If `readOnlyRootFilesystem: true` breaks a pod, record the fallback to `false` (that pod only) and
  re-run until the smoke is green.

---

## 5. Scope / YAGNI — explicitly NOT doing

- Reclaimer-churn tuning (no observed symptom; dual-trigger already prevents the guarded deadlock).
- Any change to `runLeaf`, the gate state machine, the leaf-session contract, the queue, KEDA scaling
  metadata, or `submit_verdict`.
- Hardening any pod other than the leaf-worker `ScaledJob` and the Knative service (cron-dispatch and
  sandbox-0 are out — cron-dispatch is already hardened; sandbox-0 is a separate concern).
- A new container image (reuses the harness image).

---

## 6. References

- [Milestone Registry](README.md) — the doc §1 updates.
- [Scheduled Leaf Dispatch](2026-06-28-scheduled-leaf-dispatch-design.md) — the cron-dispatch securityContext + the `isMainModule` exact idiom this generalizes; the deferred-follow-up note this closes.
- [Human-Gate](2026-06-28-human-gate-design.md) — the live gate smoke (`leaf-gate-smoke.sh`) used as the verification harness.
- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — the MVP/promote-post-MVP framing the registry section records.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
