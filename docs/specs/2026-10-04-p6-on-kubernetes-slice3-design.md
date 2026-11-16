# P6 on Kubernetes, slice 3: sandbox tiers and session-to-sandbox affinity — Design

Version: 1.4 — October 2026 (v1.1: corrections from the implementation plan; v1.2: corrections from
the implementation and its final review; v1.3: corrections from PR 2; v1.4: corrections from PR 3)
Status: Implemented — PRs #442, #444 and #454; accepted on the KVM rig and OpenShift 4.20.8 (#425)
Milestone: **P6.3**, registered in [the milestone registry](README.md). This is slice 3 of epic
rossoctl/moca#426, issue rossoctl/moca#425.
Builds on (reuse, no redesign): [P6.1](2026-10-02-p6-on-kubernetes-slice1-design.md) (the P6 stack on
Kubernetes), [P6.2](2026-10-04-p6-on-kubernetes-slice2-design.md) (external P4 hosts attached to the
in-cluster relay), [MU1](2026-09-08-multi-user-control-plane-design.md) (sessions, the per-turn
exchange), and `deploy/microvm/P4-ON-P6.md` (the P4 tier on the P6 relay).

> **The one-sentence thesis.** A session picks a sandbox tier once, at creation, and from then on
> every turn lands in that tier and, whenever it can, on the same sandbox as the turn before. A turn
> never moves to another tier, and never silently loses its workspace: it waits (503) for its
> sandbox, or, if that sandbox has been gone longer than a grace period, moves within the tier and
> records the reset.

**Not specific to Kubernetes.** The VM path (`deploy/vm` + `deploy/microvm`) has the same limits, and
this slice lifts them there too. Only the harness, the relay, the workers, the control plane and
mocactl change; the deployment paths only set configuration.

---

## 0. Decisions taken during design

| Question                          | Decision                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is driving this slice        | **Mixed tiers behind one relay**: container sandboxes and P4 microVM workers on one stack, each session pinned to one tier. Horizontal P4 scale comes with it (affinity), but is secondary.                                                                                                                                                    |
| Who picks a session's tier        | **The user, at session creation**, with a deployment default. Fixed for the session's life, like `credentialName`. A per-subject allow-list is out of scope; it can be layered on later without changing the shape.                                                                                                                            |
| What a tier is                    | **An operator-defined name**, advertised by a worker as the presence label `moca.dev/tier`. The deployment declares its names and default (`SH_SANDBOX_TIERS`, `SH_SANDBOX_DEFAULT_TIER`). Rejected: a fixed enum in code (a GPU or regional pool would need a code change); arbitrary per-session selectors (MU2's `poolSelector` territory). |
| The previous sandbox is saturated | **503, retryable.** Never another sandbox: that trades a short wait for a lost workspace.                                                                                                                                                                                                                                                      |
| The previous sandbox is absent    | **503 for a grace period (default 60 s), then fall back within the tier and record a workspace reset.** Rejected: strict (a decommissioned host strands its sessions until an operator acts) and soft (today's bug, at a lower rate).                                                                                                          |
| Where affinity lives              | **Data-plane Redis, beside the leases** (`sh:sandbox:affinity:<sessionId>`). Rejected: the control plane's `SessionRecord` (couples it to placement, needs a per-turn write-back, does nothing without a control plane); shared workspace storage per tier (§9).                                                                               |
| How the tier reaches the selector | **On the exchange response**, which every authenticated turn already fetches from the control plane. Unauthenticated turns and leaves use the deployment default.                                                                                                                                                                              |

### 0.1 v1.1 corrections

1. **Durations are integer seconds:** `SH_SANDBOX_AFFINITY_TTL_SECONDS` and `SH_SANDBOX_AFFINITY_GRACE_SECONDS`. The TypeScript side has no Go-duration parser, and the repo's knobs are `*_SECONDS` / `*_MS` integers read through `intEnv`.
2. **The relay overwrites the detach mark** (plain `SET` with TTL); only the harness writes it conditionally (v1.2: also replacing a future mark). Otherwise a stale mark can survive and cause early grace-period expiry.
3. **Affinity applies only on the records path** (`remoteOn`). The pods-only path stays byte-for-byte unchanged. Pods listed alongside records (`both`) take part in affinity like records.
4. **Placement is reported at turn end**, from the result, not at turn start: the sandbox is not known when `server.ts` reports `start`.
5. **§10's first risk is resolved:** mocactl already parses an unknown SSE `event:` as an `UnknownFrame`. Older clients ignore `workspace_reset`. The mocactl contract test requires `KNOWN_FRAME_TYPES` to change in the same PR as the harness union.
6. **Retiered sandboxes:** an affine sandbox present under another tier falls back immediately (reason `'retiered'`). §4 step 4 covered only "absent".
7. **`SandboxAffinityPendingError` extends `SandboxPoolSaturatedError`,** so the three leaf paths' existing `instanceof SandboxPoolSaturatedError` checks classify it `saturated` (retryable) with no edit. Its own `name` joins knative-server's `NO_CAPACITY` set.

### 0.2 v1.2 corrections

1. **The JSON turn result (§6)** carries `sandbox?: { id, tier, workspaceReset?: { from, reason } }` (where the turn ran, and the reset if any), not a bare `workspaceReset`; an empty tier is omitted.
2. **An affinity entry recorded under another tier is honoured, not ignored (§4 step 2).** Every entry written while tiers are unset has tier `''`; ignoring those when tiers are switched on would lose every such session's workspace with no frame, field or log. The entry is followed only to a sandbox in the session's tier, so it never crosses tiers.
3. **"Retiered" means labelled with another DECLARED tier (§4 step 4).** A record that is unlabelled, or labelled with a name not in `SH_SANDBOX_TIERS` (a typo), takes the grace path, and is excluded from selection with one log line naming its ID and labels (§5).
4. **A detach mark in the future is replaced by now (§3.5, §4 step 4).** A mark ahead of the harness clock (relay skew, or a huge integer) would otherwise hold the session pending until the key's TTL; replaced, the grace runs from now.
5. **The store's method names and the relay's write** are corrected to what shipped (§3.2, §3.5, §4, §8), and the concurrency claim at the end of §4 is narrowed.

### 0.3 v1.3 corrections

1. **mocactl has no `new` command (§1, §6).** The tier is a session option field (`sandboxTier`) in
   `SESSION_OPTION_FIELDS` (`packages/mocactl/src/core/session-options.ts`, whose comment names "a
   sandbox selector" as the intended extension). The New Session overlay, presets and
   `mocactl run --new --option sandboxTier=<name>` all work from that one entry. Non-interactively,
   an omitted tier is left to the server's default; it is never a "choose with --option" refusal.
2. **mocactl has no resources view (§1, §6).** Placement is exposed by
   `GET /v1/sessions/{id}/resources` as a new top-level `placement` object, and mocactl shows the
   tier in its Sessions list.
3. **§4 step 1 excludes a mislabelled record too.** It named only a record with no tier label as
   excluded and logged; the code also excludes, and logs once per sandbox ID, a record whose label
   is not in `SH_SANDBOX_TIERS` (as §0.2 item 3 and §5 already say). Step 1 now names both.
4. **A session view shows the tier the session runs in (§3.3).** For a record that names no tier --
   written before P6.3 (no field) or created while no tiers were declared (`''`) -- that is today's
   deployment default; the view is `null` only when the deployment declares no tiers. The exchange
   names that same default for such a session (it does not leave the data plane to apply its own),
   so the view and the placement come from one value. A `sandbox` body that is not an object is a
   400 `invalid_request`.

### 0.4 v1.4 corrections

1. **Tiers only on a mixed stack (§7).** `setup-microvm.sh` and `deploy/k8s/setup.sh` set
   `SH_SANDBOX_TIERS=container,microvm` only when both tiers run, with `SH_SANDBOX_DEFAULT_TIER`
   defaulting to `container`; a single-tier stack stays untiered. Why: a pre-P6.3
   worker advertises no tier and a tiered selector excludes it.
2. **An untiered deployment ignores a stored tier (§3.3).** The exchange omits it and the views
   show `null`.
3. **The data plane validates the tier settings at worker boot (§3.4)** and exits 2, like
   `SH_SANDBOX_DISCOVERY`.
4. **The env-parity test is two checks (§7, §8):** the k8s manifest test (supervisor and control
   plane read the same `moca-settings` keys) and `compose.test.sh`. On the VM, `setup-microvm.sh`
   writes ONE env file loaded by both units.
5. **`SH_SANDBOX_DEFAULT_TIER` is a sticky `setup.sh` input (§7).**
6. **A relay restart is graceful (§5), since #462.** On SIGTERM the relay removes each parked worker's record before ending its stream, within a 10 s deadline. A hard kill still leaves the records, and a turn in the gap still gets an in-turn tool error rather than a 503 (#453).

## 1. Scope

**In scope**

- A tier label on presence records, set by the workers; a detach timestamp written by the relay.
- `selectPoolSandbox`: filter by tier, prefer the affine sandbox, the grace-period fallback.
- The tier on the control plane's session (create, store, exchange, list, discovery).
- mocactl's `sandboxTier` session option (the New Session overlay, presets, and
  `run --new --option sandboxTier=<name>`), and the tier in its Sessions list.
- A top-level `placement` object in `GET /v1/sessions/{id}/resources`.
- A `workspace_reset` turn-stream frame.
- Configuration on every deployment path; the rewrite of `P4-ON-P6.md`'s "A P4-only host" and of
  slice 2's one-tier-per-stack guard.

**Not in scope**

- Per-subject tier allow-lists, tier quotas, and tier-aware admission in the supervisor.
- Moving a session to another tier, or changing a session's tier after creation.
- Shared workspace storage (§9), and any change to how the container tier stores its workspace.
- Using `capacityMax` for leasing (the soft cap stays the lease store's `opts.cap`).
- MU2's tenant-labelled `poolSelector`.

## 2. Current state (what this slice changes)

- **Selection re-runs on every turn** over **every** presence record: the least-loaded one under the
  soft cap (`harness/src/select-sandbox.ts`, `selectPoolSandbox`). Nothing remembers which sandbox
  served a session.
- **The labels already have a wire.** `Hello` has `map<string,string> labels` and `string trust`
  (`proto/sandbox/v1/sandbox.proto`), and the relay copies `labels` into the presence record
  (`packages/sandbox-relay/src/relay.ts`, `onAttach`). Neither worker sets `labels`
  (`remote-worker/internal/session/loop.go`, the `Hello` send), and nothing reads them. **No proto
  change is needed.**
- **Continuity today is only the workspace key.** `workspaceKey = sessionId` goes to whichever
  sandbox is picked. On P4 the workspace is `SH_WORKSPACE_ROOT/<sessionId>` on the worker's host, so
  a second P4 host opens an empty one. The container tier ignores the key: one container-local,
  shared workspace per container (`remote-worker/internal/exec/runner.go`, `Spec.WorkspaceKey`). So
  **with two container sandboxes a session already loses its files when turn 2 lands on the other
  one.** Affinity fixes that too.
- **The control plane already reserves a placement field.** `SessionRecord.poolSelector` is always
  `null`, kept for MU2 (`packages/control-plane/src/handlers.ts`, `createSession`). This slice adds a
  separate field and leaves `poolSelector` alone.
- **The exchange is the trusted hop.** `resolveTurnAuth` (`packages/knative-server/src/turn-auth.ts`)
  verifies the session token and calls the control plane's exchange on every authenticated turn. A
  tier carried there cannot be set by a request body.

## 3. Data model and wire

### 3.1 Workers (`remote-worker`)

Both workers read `SANDBOX_TIER` and, when it is non-empty, send `labels["moca.dev/tier"] = <value>`
in `Hello`. Defaults: `microvm-worker` → `microvm`, `worker` → `container`. An explicitly empty
`SANDBOX_TIER=` sends no label. `session.Config` gains `Labels map[string]string`, which the `Hello`
send copies.

### 3.2 Relay (`packages/sandbox-relay`)

- `sh:sandbox:records` keeps its shape; `labels` are now populated.
- **New key `sh:sandbox:detached:<sandboxId>`** = epoch milliseconds, with a TTL equal to
  `SH_SANDBOX_AFFINITY_TTL_SECONDS` (§3.5). `teardown` writes it with a plain `SET` and TTL, after the
  record is removed. A successful Hello deletes it, before the presence put.
- The detach write and delete are best effort, like the presence remove: a failure is logged and
  changes nothing else. A missing key is handled by the selector (§4, step 4).
- The relay reads `SH_SANDBOX_AFFINITY_TTL_SECONDS` for the TTL. It has no other tier logic: it stays a
  bridge keyed by `sandboxId`.

### 3.3 Control plane (`packages/control-plane`)

- `SessionRecord` gains `sandboxTier: string`, stored in the session hash beside `credentialName`.
  `''` means "no tiers declared at creation".
- `POST /v1/sessions` accepts an optional `sandbox: { tier: string }`. A `sandbox` that is not an
  object, or a `tier` that is not a string, is a 400 `invalid_request`.
  - With `SH_SANDBOX_TIERS` set, a tier not in the list is a **400 `invalid_request`** whose message
    lists the declared names. An omitted tier stores `SH_SANDBOX_DEFAULT_TIER`. The default is
    resolved and **stored at creation**, so changing the default later does not move an existing
    session.
  - With `SH_SANDBOX_TIERS` unset, a requested tier is a 400 (`this deployment declares no sandbox
tiers`), and `''` is stored.
- At startup the control plane refuses a `SH_SANDBOX_DEFAULT_TIER` that is not in
  `SH_SANDBOX_TIERS`, and a `SH_SANDBOX_TIERS` without a default (unless it names exactly one tier,
  which is then the default).
- `ExchangeResponse` gains `sandboxTier?: string`: the stored tier, or, for a record stored with
  `''` or written before this slice (no field), the current default. It is omitted whenever the
  deployment declares no tiers, so the untiered response is byte-identical to before.
- **An untiered deployment ignores a stored tier.** A record that stored a tier while tiers were
  declared keeps it, but once the deployment declares none the data plane runs untiered and
  filters nothing, so the exchange omits the tier and the views show `null`. Declaring the tiers
  again brings the stored tier back.
- Session listings, `GET /v1/sessions/{id}` and `GET /v1/sessions/{id}/resources`
  (`session.sandboxTier`) include `sandboxTier`: the tier the session runs in, by the exchange's
  rule; `null` whenever the deployment declares no tiers.
- `GET /v1/discovery` gains `sandboxTiers: { names: string[]; default: string } | null`.
- `docs/api/openapi.yaml` and the client spec are updated with all of the above.

### 3.4 Data plane (`packages/knative-server`, `harness`)

- `TurnAuth` gains `sandboxTier`, from the exchange. `executeTurn` passes it to
  `acquireTurnSandbox`, which passes it to `selectPoolSandbox` as `opts.tier`.
- With no `TurnAuth` (an unauthenticated turn on a deployment that allows it) and on every leaf
  path (`run-leaf.ts`), `opts.tier` is `SH_SANDBOX_DEFAULT_TIER` from the process environment.
- On a deployment that declares tiers, an `opts.tier` of `''` or undefined gets
  `SH_SANDBOX_DEFAULT_TIER`; only on an untiered deployment is there no tier filter. A session turn
  normally carries a tier (the exchange names the default for a session that recorded none, §3.3);
  this fallback covers the unauthenticated and leaf paths above.
- **The P6 worker validates `SH_SANDBOX_TIERS` and `SH_SANDBOX_DEFAULT_TIER` at boot**
  (`worker.ts`, `parseSandboxTiers`), with the control plane's startup refusals (§3.3): a
  duplicate, a bad name, several tiers with no default, or a default outside the list. It exits 2
  before `ready`, like a bad `SH_SANDBOX_DISCOVERY`. The selection still reads the settings per
  call; the boot check exists so a typo fails the bring-up, not the first turn.

### 3.5 Affinity (new, harness)

- **Key `sh:sandbox:affinity:<sessionId>`** = JSON `{ "sandboxId": string, "tier": string }`, with
  TTL `SH_SANDBOX_AFFINITY_TTL_SECONDS` (integer seconds, default `86400`), refreshed on every lease.
- **The TTL must be at least `SH_WORKSPACE_IDLE`** (P4's idle reclaim, default 30 min). Affinity
  outliving the workspace is harmless: the session returns to its sandbox and finds an empty
  workspace, which is what a fallback gives it anyway. Affinity expiring first loses a workspace
  that still exists. Container workspaces live until the pod restarts, hence the long default.
- Served by a new `AffinityStore`, memoised and guarded exactly like the lease store
  (`select-sandbox.ts`, `sharedLease` / `dropMemo`), on the same `REDIS_URL`:
  - `get` — the session's entry, or none (a corrupt value reads as none, and is logged);
  - `claim` — set the entry unless a valid one exists, refresh the TTL either way, and return the
    entry in force;
  - `replace` — overwrite the entry;
  - `detachedSince` — the relay's detach mark for a sandbox, or else now, written so the grace clock
    starts at the first turn that noticed. A mark that is not an integer, or is in the future, is
    replaced by now.

## 4. The selection algorithm (`selectPoolSandbox`)

The inputs gain `opts.tier?: string`. The no-selector path, the pods path, the lease, `holderId` and
`workspaceKey` are unchanged.

1. **List and filter.** List the records. When tiers are declared (`SH_SANDBOX_TIERS` set in the
   worker's environment), keep only records with `labels["moca.dev/tier"] === opts.tier`. A record
   with **no** tier label, or with a label that is not in `SH_SANDBOX_TIERS`, is excluded, with one
   log line per sandbox ID per process naming the ID and its labels, so a misconfigured worker fails
   loudly instead of serving either tier. When no tiers are declared, nothing is filtered. Pods (the
   `pods` and `both` discovery sources) are container tier: they pass the filter only when
   `opts.tier` is the default tier.
2. **Read affinity** for `sessionId`. An entry recorded under another tier (for instance `''`,
   written before tiers were declared) is **not** ignored: if its sandbox is in the filtered set it
   is used as in step 3 and re-recorded under `opts.tier` (`replace`), with no workspace reset —
   the workspace is intact. Otherwise it goes through step 4 like any other entry. This never
   crosses tiers: the entry is only followed to a sandbox in the filtered set.
3. **The affine sandbox is in the filtered set:** `acquire` that sandbox **only**. If the cap
   refuses it, throw `SandboxPoolSaturatedError` (503). Do not try another sandbox.
4. **The affine sandbox is absent from the filtered set.** If it is present labelled with
   **another declared tier** (an operator re-tiered its worker): continue to step 5 immediately with
   `workspaceReset = { from: <id>, reason: 'retiered' }` — no detach-key read, no grace. A record that
   is unlabelled, or labelled with a name not in `SH_SANDBOX_TIERS`, is not "another tier": it is a
   worker whose `SANDBOX_TIER` is missing or mistyped, and it takes the grace path like an absent
   one. Otherwise read `sh:sandbox:detached:<id>` (`detachedSince`):
   - **Missing, not an integer, or in the future:** write it now (`detachedSince`, atomically). This
     starts the grace clock at the first turn that noticed the absence. It covers a relay that
     restarted, and so never wrote the key, while the host was gone for good; and a mark ahead of
     the harness clock, which would otherwise hold the session pending until the key's TTL. Then
     treat the sandbox as just detached.
   - **Detached for less than `SH_SANDBOX_AFFINITY_GRACE_SECONDS`** (integer seconds, default `60`): throw
     the new **`SandboxAffinityPendingError`** (503, retryable), naming the sandbox and the time left.
   - **Detached for longer:** continue to step 5, carrying
     `workspaceReset = { from: <id>, reason: 'detached' }`.
5. **No affinity, or the fallback:** today's least-loaded loop over the filtered set. If the set is
   empty, throw `SandboxPoolEmptyError`, its message naming the tier; if every sandbox is full,
   throw `SandboxPoolSaturatedError`.
6. **After a successful lease:**
   - **Without a prior entry:** `claim({sandboxId, tier})`. If another turn of the same session
     won the write and chose a **different** sandbox, release this lease and re-run from step 2 against
     the winner's entry, **once**. A second disagreement throws `SandboxAffinityPendingError`.
   - **With a prior entry for this sandbox:** `claim` it, which refreshes the TTL; if the entry was
     recorded under another tier, `replace` it with `{sandboxId, opts.tier}` instead.
   - **After a fallback:** overwrite the entry with the new sandbox (`replace`).
   - `SelectedSandbox` gains `sandboxId`, `tier` and `workspaceReset?`, for §6.

Concurrent **first** turns of one session converge on one sandbox (step 6 closes their race), and
concurrent turns that find their affine sandbox present all take it. Two concurrent turns that both
find the affine sandbox gone past the grace may each pick and `replace` a different sandbox, the
later write winning; the workspace was already reset, so nothing more is lost, but the session's
next turn may not be on the sandbox either of them reported. Closing that race is a follow-up.

## 5. Failure modes

| Situation                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay restart                                                | On SIGTERM/SIGINT (`systemctl restart sh-relay`, a pod deletion or rollout) the relay stops accepting new streams, runs every parked session's teardown -- record removed, detach mark written, both awaited -- then ends the streams and exits, bounded by a 10 s deadline under the 120 s `TimeoutStopSec`/`terminationGracePeriodSeconds` (#453). Workers then re-Hello (measured 1.8–4.7 s); a turn in the gap finds its affine sandbox absent within the grace and gets 503 `SandboxAffinityPendingError` with `Retry-After`, then returns to the same sandbox ID. A hard-killed relay (SIGKILL, node crash) still leaves stale records: a turn may lease one until the worker reattaches and fail in-turn with `no live worker for sandbox '<id>'`, which the model retries. |
| Worker or pod restart                                        | P4: the workspace is on host disk and survives. Container tier: the pod returns under the same StatefulSet name, but its workspace is container-local and **lost by the existing design** (`deploy/k8s/base/sandbox.yaml`). Affinity still returns the session to the same ID, and no reset is recorded: the harness cannot see that loss. A documented limit.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Host gone for good                                           | 503 for the grace period, then the fallback within the tier, with the reset recorded (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The session's tier is empty or saturated                     | 503, as today. A session **never** moves to another tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reading affinity or the detach key fails                     | The turn fails, as a failed lease read does today. It does not fall back to an unpinned selection: a Redis blip must not scatter sessions across sandboxes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Writing affinity fails after the lease was taken             | The turn **proceeds**, with a warning. The lease is held and the sandbox is right. The next turn finds the old entry or none, and selects as in §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The session's tier is removed from `SH_SANDBOX_TIERS`        | The exchange returns the stored tier; nothing matches it; `SandboxPoolEmptyError`, naming the tier. The control plane does not rewrite stored tiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| An unlabelled or mislabelled worker                          | Excluded while tiers are declared, with one log line per ID naming its ID and labels — for a missing label and for a label not in `SH_SANDBOX_TIERS` alike. An affine session waiting on it takes the grace path, not `retiered`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SH_SANDBOX_TIERS` differs between control plane and workers | A session's tier may match no record (`SandboxPoolEmptyError`, naming the tier). Every deployment path sets both from one source, and an env-parity test guards it (§7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Error mapping.** `SandboxAffinityPendingError` joins `turnErrorStatus`'s NO_CAPACITY set (503) and
stays retryable in `classifyOutcome`, beside `SandboxPoolSaturatedError` and `SandboxPoolEmptyError`.

## 6. User surface and observability

- **Discovery and creation.** mocactl reads `sandboxTiers` from `GET /v1/discovery`. The tier is
  the session option field `sandboxTier` (`packages/mocactl/src/core/session-options.ts`), so the
  New Session overlay, presets and `run --option` all offer it from that one entry. mocactl has no
  `new` command.
  - Headless: `mocactl run --new --option sandboxTier=<name>`. An omitted tier is left to the
    server's default, never a "choose with --option" refusal. A name that is not declared is
    refused locally, naming it and listing the declared names, as the control plane's 400 would.
    With `sandboxTiers: null`, a given tier is refused locally: "this deployment declares no
    sandbox tiers".
  - TUI: the New Session overlay shows a tier picker only when more than one tier is declared, with
    the default preselected (or the tier used last).
  - The control plane's session listings and `GET /v1/sessions/{id}` carry the tier, and mocactl
    shows it in its Sessions list.
- **Placement.** The data plane's runtime report (`runtimeFieldsForTurn`, `reportRuntime`) gains
  `sandboxId` and `sandboxTier` at turn end, from the lease actually taken, and
  `workspaceResetAt` / `workspaceResetFrom` after a fallback. `sandboxTier` is written even as `''`
  (no tiers declared): the hash write merges, so omitting it would keep a previous turn's tier
  beside the new `sandboxId`. `projectResources` exposes them as the
  top-level `placement` object of `GET /v1/sessions/{id}/resources`
  (`{ sandboxId, tier, workspaceReset: { at, from } | null } | null`, null until a leased turn has
  reported), which shows where the session runs and when it last lost its workspace. mocactl has no
  resources view.
- **The turn itself.** After a fallback, a streamed turn emits a new frame before any other:
  `{ type: 'workspace_reset'; sessionId; from; tier; reason }` (`harness/src/turn-stream.ts`,
  `TurnStreamFrame`). A JSON turn result gains
  `sandbox?: { id, tier, workspaceReset?: { from, reason } }` (where the turn ran, and the reset if
  any). mocactl prints the frame as a notice. Clients that do not know the frame type must ignore it (§10).
- **Logs.** One structured line for each non-trivial decision: affinity pending, fallback, a record
  excluded for having no tier label or a label not in `SH_SANDBOX_TIERS` (once per sandbox ID), an
  affinity write failed. No new metrics in this slice.

## 7. Configuration and deployment paths

| Variable                            | Read by                                | Default                 | Meaning                                                                      |
| ----------------------------------- | -------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `SH_SANDBOX_TIERS`                  | control plane, supervisor, worker boot | unset                   | Comma-separated tier names. Unset: no tiers, no filtering.                   |
| `SH_SANDBOX_DEFAULT_TIER`           | control plane, supervisor, worker boot | unset                   | Required with more than one tier; must be one of them.                       |
| `SH_SANDBOX_AFFINITY_TTL_SECONDS`   | supervisor, relay                      | `86400`                 | Affinity and detach-key TTL in seconds. Keep ≥ `SH_WORKSPACE_IDLE`.          |
| `SH_SANDBOX_AFFINITY_GRACE_SECONDS` | supervisor                             | `60`                    | How long an absent affine sandbox is waited for before fallback, in seconds. |
| `SANDBOX_TIER`                      | `worker`, `microvm-worker`             | `container` / `microvm` | The worker's `moca.dev/tier` label. Empty: no label.                         |

**Tiers only on a mixed stack.** Both setup scripts declare tiers only when both tiers run, and
leave a single-tier stack untiered: a pre-P6.3 worker advertises no tier, and a tiered selector
would exclude it.

- **`deploy/vm`, `deploy/compose`:** the env templates gain the variables, unset by default. A
  stack that sets nothing behaves as before, plus affinity.
- **`deploy/microvm/setup-microvm.sh`:** on a mixed host (it attaches a P4 worker to a co-located
  P6 stack that also runs containers; a stopped `sh-sandbox-*` counts), it writes ONE env file,
  `microvm-tiers.env`, with `SH_SANDBOX_TIERS=container,microvm` and
  `SH_SANDBOX_DEFAULT_TIER` set to its `SH_SANDBOX_DEFAULT_TIER` input, else the stored one, else
  `container`, loaded by drop-ins into both `sh-supervisor` and `sh-control-plane`. A P4-only host
  stays untiered, and so does a `--remote` host's own P6 (its only P4 worker attaches to the
  cluster's relay): `--remote` removes the tier files a mixed local run wrote. The default is
  sticky in `microvm-tiers.env` itself, so going P4-only removes that file and the stored
  default with it; `deploy/k8s/setup.sh` keeps its default in `moca-setup`, through a
  single-tier run. `P4-ON-P6.md`'s "A P4-only host"
  section and its entry in the limits list are rewritten.
- **`deploy/k8s/setup.sh`:** sets `SH_SANDBOX_TIERS=container,microvm` only when the stack runs
  both (`SH_SANDBOX_COUNT>0` and `SH_P4_SANDBOX_IDS` non-empty), with `SH_SANDBOX_DEFAULT_TIER`
  defaulting to `container`; otherwise both settings are `''`. It writes them to
  `moca-settings`, which the control plane and the supervisor both read, and **removes slice 2's
  one-tier-per-stack guard** (`setup.sh`, the `SH_SANDBOX_COUNT=0` requirement). P6.2's
  single-host limit is rewritten. `SH_SANDBOX_DEFAULT_TIER` is a **sticky input**: stored in
  `moca-setup` and reused when a re-run does not give it.
- **Env parity** is two checks: the k8s manifest test (the supervisor and the control plane read
  the same `moca-settings` keys) and `deploy/compose/tests/compose.test.sh`. The
  `setup-microvm.sh` path needs no third: it writes one env file loaded by both units. A
  hand-tiered `deploy/vm` stack does not have that file: its units load `control-plane.env` and
  `supervisor.env` separately, so it must set both variables in both.

## 8. Testing

- **Harness, unit.** A table test over `selectPoolSandbox` with fake record, lease and affinity
  stores, one case per row of §5 and per step of §4: tier filtering, unlabelled exclusion, affine
  saturated, affine absent within and past the grace, the harness-started grace clock, the
  first-turn `claim` race (win, lose-and-converge, lose twice), a failed affinity write, a failed
  affinity read, no tiers declared.
- **Relay, unit.** The detach key is written on teardown with a plain `SET` (overwriting any earlier
  mark), and deleted on Hello before the presence put. Its failures are logged and change nothing
  else.
- **Workers, Go unit.** `SANDBOX_TIER` → `Hello.labels`, the defaults, and the empty value.
- **Control plane, unit.** Validation at creation, the stored default surviving a later default
  change, the exchange carrying the tier, an old record getting the default, a stored tier ignored
  once the deployment declares none, discovery, the startup refusals.
- **Data plane, boot.** `worker-boot.test.ts` forks the real worker: a duplicate tier and a
  default outside the list each exit 2 before `ready`, naming the variable; a valid pair boots.
- **Env parity.** The k8s manifest test and `compose.test.sh` (§7).
- **mocactl, unit.** `--option sandboxTier=…`, the picker, the notice for `workspace_reset`,
  ignoring an unknown frame type.
- **Integration, real Redis.** Two fake workers in each of two tiers behind a real relay. Across many
  sessions every turn stays in its tier and on its affine sandbox, and new sessions still spread by
  load. A relay restart mid-run moves no session.
- **Acceptance (#425's criteria).**
  1. **KVM rig, VM path:** one relay with container sandboxes and a P4 worker. P4 sessions land only
     on P4, container sessions only on containers.
  2. **KVM rig, two P4 workers** (two IDs, two workspace roots): a session's turn 2 sees turn 1's
     files across many sessions, and load spreads over both.
  3. **OpenShift, after P6.2 merges:** the mixed stack, with the one-tier guard gone.
  4. **CI (`k8s-kind-e2e`):** a new smoke claim with two container sandboxes, where every turn of a
     session sees the previous turn's files. Kind has no P4; this is the part CI can prove.

## 9. Alternative considered: shared workspace storage per tier

Put every tier's workspaces on storage all its sandboxes share (NFS or a ReadWriteMany PVC for P4,
`workspace_key`-scoped directories on a shared volume for containers), so any sandbox can serve any
turn. It spreads load best and survives a lost host without a reset. It is not this slice: P4
workspaces are host-side disks attached to Firecracker guests, so it needs a new storage substrate
plus locking for concurrent turns; the container tier would first have to honour `workspace_key`;
and it does not remove the need for tier filtering. Affinity is compatible with it later: a shared
store would make the grace period and the fallback lossless, and nothing else.

## 10. Risks and things to verify early

- ~~**Unknown SSE frame types in older clients.** Verify that the shipped mocactl ignores an unknown
  `event:` type.~~ **Resolved (v1.1):** mocactl already parses an unknown `event:` as `UnknownFrame` and ignores it. Older clients will ignore `workspace_reset`.
- **Pods in `both` discovery.** The pods path is the Knative-era inventory; treating pods as the
  default tier is a compatibility choice. Confirm no live deployment mixes pods with tiered records.
- **The grace default.** 60 s must exceed the worker's reattach backoff after a relay restart.
  Measure it on Kind and on the rig, and record the value.
- **Affinity holds a session on a busy sandbox.** Load spreads only across new sessions; a hot
  sandbox's sessions 503 rather than move. Accepted (§0), but watch it in the two-P4 acceptance run.

## 11. Delivery

Three PRs, in order:

1. **Harness, relay, workers:** `SANDBOX_TIER`, the detach key, `AffinityStore`, the §4 algorithm,
   `SandboxAffinityPendingError`, the `workspace_reset` frame, the runtime fields. With
   `SH_SANDBOX_TIERS` unset this is safe on its own, and it fixes the container-tier hop. It does not
   depend on P6.2.
2. **Control plane and mocactl:** the session's tier, the exchange, discovery, the API docs,
   `--option sandboxTier=…`, the picker, the notice.
3. **Deployment wiring and docs:** `deploy/vm`, `deploy/compose`, `deploy/microvm`, `deploy/k8s`
   (after P6.2 merges: it edits `setup.sh`), `P4-ON-P6.md`, the README runbook, the env-parity test,
   the Kind smoke claim, and the acceptance runs recorded on rossoctl/moca#425.
