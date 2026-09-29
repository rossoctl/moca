# P1 — FS-Free Harness (two-tier rearchitecture) — Design

Version: 1.0 — July 2, 2026
Status: Design (approved for implementation planning)
Scope: **Phase 1 (P1)** of the [two-tier FS-free harness epic](https://github.com/rossoctl/moca/issues/49)
([P1 issue #45](https://github.com/rossoctl/moca/issues/45)). Make the credentialed
**harness** perform **no filesystem I/O**: move the leaf envelope (inputs, verdict, done-marker) and
the human-gate markers off the shared `/work` PVC, and move the sandbox working set from `emptyDir`
to durable storage via the agent-sandbox `Sandbox` CR. Single sandbox / RWO is fine here.
Builds on (reuse, no redesign): the leaf-session contract + `runLeaf`
([MVP](2026-06-26-mvp-leaf-session-contract-design.md), PR #10/#11), async completion
([KEDA `ScaledJob` + Redis Streams](2026-06-27-async-leaf-completion-design.md), PR #12), human-gate
([Archetype B](2026-06-28-human-gate-design.md), PR #14), M2/M3 sandbox delegation, M4 Knative,
M5 Redis session backend.
Substrate: **Redis** (already a hard dependency) for the result record; **agent-sandbox**
(`agents.x-k8s.io/v1alpha1`, kubernetes-sigs) for the durable sandbox.

> **What this slice is NOT.** Not the shared sandbox pool or N:M routing (P2 — `SandboxWarmPool` /
> `SandboxClaim`). Not RWX / multi-sandbox storage (P2). Not Kata isolation or ratio experiments
> (P3, deferred). Not the OpenShift deployment cutover as a deliverable (P0′ threads through, but
> P1's manifests are written OCP-aware). Model tool ops are **already** fully sandboxed (7/7 Pi ops,
> `packages/k8s-sandbox/src/extension.ts`) — unchanged.

---

## 1. Goal & motivation

The head/hands invariant of the two-tier architecture: **only the sandbox touches a filesystem; the
harness does network I/O only** (LLM, Redis, sandbox exec API). Today the harness violates it for the
**leaf envelope** and the **human-gate markers**:

- `harness/src/run-leaf.ts:116` — `readItem()` reads `inputsRef` via `node:fs` (`readFileSync`).
- `harness/src/run-leaf.ts:160-161` — writes the verdict via `mkdirSync` + `writeFileSync(resultRef)`.
- `harness/src/run-leaf.ts:146` — `writeGateMarker(gateRef, …)` writes the gate marker to `/work`.
- `harness/src/run-leaf.ts:215` — `readDecision(decisionRef)` reads the resume decision from `/work`.
- `harness/src/leaf-job-runner.ts:63` — the async worker writes the verdict + done-marker to `/work`.
- `packages/knative-server/src/server.ts:106-131` — `/runs/status` reads done/gate marker **files**.

Because the harness and the async worker both read/write the same `/work` PVC, and (in the epic's
target) many harness pods would share it across nodes, this file coupling is what forces cross-node
**RWX** on OpenShift. The OCP RWX pain is a _symptom_; the root cause is harness filesystem I/O.

P1 removes that I/O. Once the envelope and markers are inline-or-Redis and the working set is on the
sandbox's own durable volume, the harness (Service **and** async worker) mounts **no shared writable
volume**, and RWX no longer applies to the harness tier at all.

## 2. Threat model (locked — from epic #49, not relitigated)

There is **no agent in the sandbox**; it is a passive `kubectl exec` target. The threat is a
**compromised/injected harness** (malicious skill, prompt injection) and **kernel exploits**. Blast
radius is contained by giving the harness zero FS/exec surface (this phase) and Kata-isolating only
the sandboxes (P3). "Verdict integrity via the filesystem" is a **non-issue** — a compromised harness
can forge a verdict regardless of transport, so moving the verdict from a file to an HTTP response or
a Redis key changes nothing about integrity. P1 is an FS-surface reduction, not an integrity control.

## 3. The `/runs` wire contract (clean break)

No live external consumer exists (the in-repo callers — `cron-dispatch.ts`, the smoke drivers — are
updated in the same change; the planned BugStone Archetype-A consumer is designed but unbuilt). A
transitional "accept both shapes" is not available _to the harness_: honoring the old
`inputsRef`/`resultRef` fields would require keeping the `/work` mount, defeating P1. So the file
paths are removed outright.

### 3.1 Request — `LeafEnvelope`

Drops `inputsRef`, `resultRef`, `doneMarkerRef`, `gateRef`, `decisionRef`. Inputs and the resume
decision move inline. `sessionId` remains the correlation + idempotency key. `workspaceRef` remains —
it is a path **inside the sandbox pod** (where the agent's tools run), never opened by the harness
process, so it does not violate FS-free.

```jsonc
{
  "sessionId": "run-123/i1", // correlation + idempotency key (unchanged)
  "item": {
    // NEW — was the JSON body of the inputsRef file
    "item_id": "i1",
    "file": "src/foo.ts", // relative to workspaceRef, resolved in the sandbox
    "pattern": "eval(",
    "require_approval": false,
  },
  "decision": { "gateId": 1, "action": "approve" }, // NEW, resume/approve only — was the decisionRef file
  "model": "claude-haiku-4-5", // unchanged optionals
  "provider": "anthropic",
  "workspaceRef": "/workspace/run-123/repo", // absolute path INSIDE the sandbox (unchanged)
  "maxTurns": 20,
  "async": false,
  "tenant": "team1",
}
```

`isLeafEnvelope()` becomes: `sessionId` is a string **and** `item` is a well-formed `LeafItem`
(`item_id`/`file`/`pattern` strings, optional boolean `require_approval`). An envelope carrying the
removed `inputsRef`/`resultRef` fields (and no inline `item`) is rejected `400 envelope_invalid` —
`bad_inputs` semantics move to envelope validation.

### 3.2 Sync response (`200`)

The verdict is returned **inline** instead of a `resultRef` pointer. The union mirrors the internal
`LeafResult`, with the file path replaced by the value:

```jsonc
{ "status": "done",    "verdict": { "item_id": "i1", "verdict": "FLAGGED", "reason": "…" } }
{ "status": "paused",  "gateId": 1, "gate": { "summary": "…", "proposed_action": "…" } }
{ "status": "aborted" }
{ "status": "failed",  "reason": "no_verdict|invalid_verdict|bad_inputs|error", "message": "…" }
```

### 3.3 Async response (`202`)

No path to poll — just the key:

```jsonc
{ "status": "accepted", "sessionId": "run-123/i1" }
```

### 3.4 Status — `GET /runs/status?sessionId=<id>[&tenant=<t>]`

Replaces `?doneMarker=<path>&gateMarker=<path>`. The endpoint recomputes the record key with the same
`leafSessionId({ sessionId, tenant })` helper the writers use (§4), so a `tenant` query param is
**required iff** the envelope was dispatched with a `tenant` (the caller already knows it — it set
it). Reads the Redis result record (§4) and returns the same union as §3.2 (plus
`{ "status": "queued" }` when no record exists yet). The `WORK_ROOT` path-traversal guard
(`confineToWorkRoot`, `server.ts:99-104`) is **removed** — there are no paths to confine.

## 4. Redis result store

One record per leaf, written by the sync HTTP layer or the async worker, read by `/runs/status`.
Keyed by the sanitized leaf session id (`leafSessionId(env)` — tenant-prefixed then sanitized), so it
aligns 1:1 with the existing session-backend key: a retry/resume of the same envelope maps to the
same record.

- **Key:** `leaf:result:<leafSessionId>`
- **Value:** a JSON string (single `SET` — atomic write/read, one round-trip; not a hash):

```jsonc
{
  "status": "done",             // done | failed | aborted | paused
  "verdict": { … } | null,      // present iff status=done
  "gate": { "gateId": 1, "summary": "…", "proposed_action": "…" } | null,  // present iff status=paused
  "reason": "no_verdict" | null,// present iff status=failed
  "sessionId": "run-123/i1",    // RAW (un-sanitized) id, for caller correlation
  "ts": "2026-07-02T12:00:00Z"
}
```

- **Write:** `SET leaf:result:<id> <json> EX <ttl>` — value + expiry in one call.
  - **Sync path:** the HTTP layer writes the record _and_ returns the union, so a sync result is also
    queryable via `/runs/status` for the TTL window (matches today, where the sync verdict file was
    also readable).
  - **Async path:** the worker (`leaf-job-runner.ts`) writes the record instead of
    `writeDoneMarker(<resultRef>.status)` + `writeFileSync(resultRef)`.
- **TTL:** env `LEAF_RESULT_TTL_SECONDS`, default `86400` (24h). Replaces the orchestrator's old file
  cleanup — records self-expire, no unbounded growth. A `paused` record carries the same TTL and is
  overwritten (fresh TTL) on approve/resume, so a long human-gate wait is bounded by the TTL; set it
  higher for long gates (documented caveat).
- **Concurrency:** single writer per `sessionId` in practice (one sync request _or_ one queue
  consumer owns a leaf at a time — the work-queue `claim` guarantees a single in-flight consumer), so
  last-write-wins is safe; no CAS at P1.

New module `harness/src/leaf-result-store.ts` exposes `writeResult(redis, id, record, ttl)` /
`readResult(redis, id)`, reusing the existing `REDIS_URL` client config. `done-marker.ts` and
`gate-marker.ts` are deleted once the leaf path no longer references them; the async `classifyOutcome`
mapping is retargeted from marker files to the result record.

## 5. Human-gate off the filesystem

The gate path is folded into the same rearchitecture (required for the no-mount acceptance to hold
with gates enabled):

- **Gate marker → Redis.** A paused leaf writes a `status:"paused"` result record (§4) carrying the
  `gate` object, instead of `writeGateMarker(gateRef)`. `/runs/status` surfaces `paused` from that
  record.
- **Decision → inline.** The resume/approve invocation supplies the decision in the `decision`
  envelope field (§3.1) instead of a `decisionRef` file; `readDecision` is replaced by reading
  `env.decision`. The gate-decision-recording, seed logic, and the verdict-tool-withholding guarantee
  (`run-leaf.ts:237-238`) are otherwise unchanged — only the transport of the decision changes.

## 6. Sandbox tier — agent-sandbox `Sandbox` CR

Replace the bare `sandbox-0` Pod (`emptyDir` `/workspace`) with a **`Sandbox` CR**
(`agents.x-k8s.io/v1alpha1`, kubernetes-sigs/agent-sandbox) — the primitive kagenti already
standardizes on (`kagenti_feature_flag_agent_sandbox`, OpenShell e2e). It is purpose-built for "a
long-running, stateful, singleton container with a stable identity and persistent storage that
survives restarts," explicitly as an alternative to a size-1 StatefulSet, and its
`SandboxWarmPool`/`SandboxClaim` extensions are exactly the P2 shared pool.

### 6.1 Manifest

`deploy/knative/sandbox.yaml` becomes a `Sandbox` CR; durable storage comes from the CRD's dedicated
`spec.volumeClaimTemplates` field (the controller creates the PVC from the template):

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: Sandbox
metadata:
  name: sandbox-0 # the name is the config handle now (see §6.2)
spec:
  volumeClaimTemplates: # durable working set (survives pod restart)
    - metadata: { name: workspace }
      spec:
        accessModes: ['ReadWriteOnce'] # RWO fine at P1 (single sandbox)
        resources: { requests: { storage: 1Gi } }
  podTemplate:
    spec:
      containers:
        - name: sandbox
          image: <sandbox-image>
          volumeMounts:
            - { name: workspace, mountPath: /workspace } # durable, was emptyDir
```

### 6.2 Harness exec resolution — `@moca/k8s-sandbox`

Today the client execs by a **fixed** pod name (`config.ts:20` `KAGENTI_SANDBOX_POD`; `exec.ts:21-22`
`kubectl exec -i -n <ns> <pod>`). agent-sandbox assigns the pod name (kagenti discovers it by
substring-matching the Sandbox name — `conftest.py:490-497`), so a fixed name is brittle. P1 resolves
the pod from a **label selector**, authoritatively, from the CR's own status:

- Config becomes **Sandbox name + namespace**: `KAGENTI_SANDBOX_NAME` (+ existing
  `KAGENTI_SANDBOX_NAMESPACE`). `KAGENTI_SANDBOX_POD` is still honored as a fallback so nothing breaks
  mid-migration; if set, it short-circuits resolution.
- Resolution: read `Sandbox/<name>` `.status.selector` (the CRD documents it as _"the label selector
  for pods"_), then `kubectl get pod -l <selector> -o jsonpath='{.items[0].metadata.name}'` → pod
  name → the existing `kubectl exec` path is otherwise unchanged.
- **When** it resolves: once **per leaf-session**, at extension init. The k8s-sandbox extension
  factory is synchronous, so the pod name is resolved in the async `runLeaf`/`runTurn` setup and the
  concrete name is handed to the extension (`k8sSandboxExtension({ config })`). A leaf's exec calls
  reuse that resolved name for the session's lifetime. A sandbox pod restart is picked up on the
  **next invocation/retry** (a leaf whose sandbox dies mid-run fails and is retried, re-resolving) —
  sufficient at P1's single-sandbox granularity, since the durable PVC means the restarted pod holds
  the same working set. This avoids parsing kubectl errors to distinguish a stale-pod failure from a
  normal non-zero command exit. It is the same resolve-from-a-selector shape P2's pool will reuse.
- `.status.selector` is assumed to be a **string** label selector (the k8s scale-subresource
  convention, matching the CRD's "label selector for pods" wording). If the deployed CRD serializes
  it as a `LabelSelector` object, only the one jsonpath needs adjusting — the live Kind smoke
  verifies the real shape.

### 6.3 Carried scope decisions

1. **P1 uses one core `Sandbox` CR only.** `SandboxWarmPool` / `SandboxClaim` are P2.
2. **The agent-sandbox controller + CRDs become a harness deploy dependency**, installed in the Kind
   and OCP deploy paths alongside Knative / KEDA / Redis.

## 7. Deploy changes (`deploy/knative/`)

- `service.yaml` — **remove** the `/work` volume + volumeMount and `LEAF_WORK_DIR`; add
  `KAGENTI_SANDBOX_NAME` and `LEAF_RESULT_TTL_SECONDS`. The harness Service mounts only its own
  `emptyDir` `/tmp`.
- `leaf-scaledjob.yaml` — **remove** the `/work` mount; the worker keeps `REDIS_URL` and writes the
  result record to Redis.
- `leaf-pvc.yaml` (the `leaf-work` RWO PVC) — **deleted**; no consumer remains.
- `sandbox.yaml` — becomes the `Sandbox` CR (§6.1).
- **New install step** for the agent-sandbox controller + CRDs (Kind + OCP overlays), added to the
  deploy driver.
- OCP overlay: the sandbox PVC binds an EBS RWO volume (fine for a single sandbox); the harness and
  worker no longer need `fsGroup` / PVC-write permissions, since they write nothing to disk.

## 8. Callers we own (updated in the same cut)

- `packages/knative-server/src/cron-dispatch.ts` — build the inline-`item` envelope; on async, stop
  deriving/returning a `doneMarker` path.
- `deploy/knative/leaf-smoke.sh`, `leaf-async-smoke.sh`, `lib.sh` — construct inline `item` (no
  `inputsRef` file writes to `/work`); read the verdict from the `/runs` response (sync) or
  `/runs/status?sessionId=…` (async). Drop the `oexec … jq .status <file>` polling and the
  `seed_work_dirs` / chmod helpers. The repo is still seeded **only** into the sandbox — **Claim 0
  holds** (no repo copy on the harness).

## 9. Testing

- **Unit.**
  - `leaf-result-store`: write/read/TTL round-trip; missing key → null.
  - `run-leaf`: returns the verdict inline; `bad_inputs` when `item` is absent/malformed; paused/gate
    path writes a `paused` record and reads `env.decision`.
  - `server`: parses inline `item`/`decision`; rejects the old `inputsRef`/`resultRef` shape with
    `400`; `/runs/status?sessionId` reads the record.
  - `@moca/k8s-sandbox`: given a `.status.selector`, builds the correct `kubectl get pod` args;
    re-resolves after an exec failure; `KAGENTI_SANDBOX_POD` fallback short-circuits.
- **Live smoke (Kind).**
  - Existing sync + async leaf smoke, adapted to the inline/Redis contract.
  - **Red-team grep:** no `/work` mount in the harness/worker manifests; no `writeFileSync` /
    `readFileSync` / `mkdirSync` in the leaf envelope path.
  - **Durability check:** write a file into the sandbox workspace, delete the sandbox pod, confirm it
    survives on the recreated pod (`volumeClaimTemplates`).
  - Gate smoke (Archetype B): inline `decision` + Redis `paused` → resume.

## 10. Acceptance mapping (issue #45)

| Acceptance                                                                                                                       | Met by                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Harness/worker mount no shared writable volume; red-team grep finds no `/work` mount and no `writeFileSync` in the envelope path | §7 deploy edits + §9 red-team grep                     |
| `leaf-smoke.sh` passes with inputs inline + verdict from response/Redis; Claim 0 still holds                                     | §3, §8 driver rewrite                                  |
| Async path drains via Redis; verdict retrievable via `/runs/status`                                                              | §4 worker writes `leaf:result:*`; §3.4 status reads it |
| Sandbox repo survives a sandbox pod restart (durable PVC)                                                                        | §6.1 `volumeClaimTemplates` + §9 durability smoke      |

## 11. Non-goals (this phase)

Sandbox pool / routing (P2); RWX / multi-sandbox storage (P2); Kata + ratio experiments (P3);
per-user identity / credential plane (Phase 2 `Z`-track); the OCP deployment cutover as a shipped
deliverable (P0′ — manifests here are written OCP-aware, but the cutover is its own phase).

## 12. Superseded / doc updates

- **Supersedes** the local un-pushed `docs/archetype-a-ocp-support` branch (NFS-RWX-for-harness) —
  after P1 the harness mounts nothing; reference only.
- **Amends** [`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md)
  (§ volume envelope → inline + Redis) and
  [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md)
  (done-marker file → Redis result record), each with a dated "Superseded by P1" pointer to this
  spec — the Option-1 convention used for the run-leaf→/runs rename.
- Registry row added to [`docs/specs/README.md`](README.md) under a new **Two-tier Rearchitecture
  (`P`-prefix)** section.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
