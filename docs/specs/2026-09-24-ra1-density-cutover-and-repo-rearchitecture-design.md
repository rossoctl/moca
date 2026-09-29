# RA1 — Density Cutover & Repository Re-architecture — Design

Version: 1.0 — September 24, 2026 (amended September 25, 2026 — see §0.3)
Status: Proposed
Scope: Plan (not yet execute) a phased migration: rename to **MOCA**, split out an experiments
repo, make the P4/P6 high-density substrate the _primary_ deployment model, and only then
**deprecate** (not remove) the Kubernetes/Knative/KEDA deployment path. This document is the plan
artifact only — no code, docs, or directory structure changes are made by writing it.
Milestone: **RA1**, a new `RA` (Repository Re-architecture) track. Distinct from the `P`-numbered
technical density work it depends on and packages for shipment — the way `RC` and `MU` took their
own prefixes for being different _kinds_ of tracks (integration, product surface) rather than
linear continuations of `Z`. Source of truth for numbering: [Milestone Registry](README.md).
Builds on: **P4** ([spec](2026-09-09-p4-microvm-sandbox-design.md), [ADR-0035](../adrs/0035-per-exec-microvm-warm-standby.md)),
**P4.1** ([spec](2026-09-15-p4-1-microvm-egress-transport-design.md)),
**P6** ([spec](2026-09-08-p6-vm-process-manager-design.md), [ADR-0034](../adrs/0034-vm-process-manager-socket-handoff.md)),
**P5** ([spec](2026-09-06-p5-session-isolation-design.md), [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md)),
**MU1** ([spec](2026-09-08-multi-user-control-plane-design.md), [ADR-0033](../adrs/0033-multi-user-control-plane.md)),
**ST/SandboxTransport** ([spec](2026-07-08-sandbox-transport-grpc-design.md), [ADR-0024](../adrs/0024-sandbox-transport-remote-exec.md)).
Decision record: none yet — this is a plan, not an accepted decision. §9 lists the ADRs this
work should produce once execution starts.

> **The one-sentence thesis.** P4 and P6 already prove the high-density direction works; RA1 makes
> it the repo's _primary_ direction — renamed, documented, and default — while retiring the
> Kubernetes path on a deliberate glide path instead of a single cutover commit.

---

## 0.1 Amendment — September 24, 2026

The final name is decided: **MOCA** (Micro Orchestrator for Cloud Agents). §1, §7, §11, and §13
were updated accordingly, and the CLI-naming convention (`moca`/`mocactl`-style) was confirmed
shortly after.

## 0.2 Correction — September 24, 2026

An earlier draft of §3.4 mischaracterized "DeepSeek Harness" in the original ask as referring to
the DeepSeek _model_ (already solved in this repo as a model provider). It's a distinct, real
project — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), a
separate agent-runtime framework — and the original ask was well-formed, not a layer conflation.
§3.4 and §9.2 are corrected.

## 0.3 Amendment — September 25, 2026

The user changed both the **phase order** and the **disposition of the Kubernetes/Knative/KEDA
code**, reversing two decisions this document originally made:

- **Was:** restructure and remove K8s under the current name first, rename last (§4, original).
  **Now:** **rename to MOCA first**, then split experiments, then make P4/P6 primary, then
  deprecate K8s.
- **Was:** full cutover — K8s/Knative/KEDA code deleted, no legacy path retained (§1, original).
  **Now:** **deprecate, don't delete.** The old deployment path stays in the tree, functional,
  clearly marked deprecated, once P4/P6 is proven primary. Actual removal is out of RA1's scope.

Every section below reflects the new order and disposition. See §4 for the sequencing rationale
and §12 for one open question this change raises about §2's execution gate.

## 0.4 Amendment — September 25, 2026 (later same day)

§0.3 raised an open question about whether §2's execution gate should apply to Phases 1–2. The
user has now resolved it for **Phase 2 only**: the `moca-experiments` split is ungated, cleared to
start independent of both the #336–#274 roadmap and Phase 1 (rename). Phase 1's own gate status
remains open. §1, §2, §4, §7, §12, and §13 are updated accordingly. Whether "cleared to start"
means _begin real repo/file changes now_ or _only the plan's policy is resolved_ is itself flagged
as unresolved in §12 — this document still has not produced, and this amendment does not
authorize, any actual file move, repo creation, or git history rewrite.

## 0.5 Amendment — September 25, 2026 (later still)

§0.4 left Phase 1 (rename)'s gate status open. The user has now confirmed **Phase 1 is also
ungated** — cleared to start independent of the #336–#274 roadmap, same as Phase 2. Only Phases 3
and 4 (making P4/P6 primary, deprecating K8s — the phases that actually touch control-plane's
deployment and the K8s/Knative/KEDA code) remain blocked on that roadmap. §1, §2, §12, and §13 are
updated accordingly. The second question raised in §0.4 — whether "ungated" means _begin real
execution now_ or _only the plan's policy is resolved_ — remains open; this amendment still does
not itself authorize any file move, repo creation, or git history rewrite.

## 0.6 Amendment — September 25, 2026 (final, this round)

Both remaining open items are resolved: **Phase 1 is confirmed ungated** (§0.5), and the user has
confirmed **real execution of Phase 2 is authorized** — not just the plan's policy. Per §13, the
required next step is to invoke `writing-plans` for Phase 2 (the `moca-experiments` split) before
any file move or repo creation happens. §12/§13 updated to drop the now-resolved bullets.

## 0.7 Correction — September 25, 2026 (found while planning Phase 2)

Verification while drafting the Phase 2 implementation plan found three errors in §6/§7's content
list for `moca-experiments`:

1. **`remote-worker/internal/relaytest` does not move.** It's a five-file-sized fake-relay test
   harness imported by two _production_ test files (`cmd/microvm-worker/attach_test.go`,
   `internal/session/contract_test.go`) — shared test infrastructure, not experiment tooling.
   Moving it would break the main module's own test suite.
2. **`remote-worker/cmd/vmpoolctl` does not move.** It imports `internal/vmpool`, a Go `internal/`
   package — Go's own import-visibility rule means _no other module can ever import it_, so
   `vmpoolctl` cannot physically live in a separate repo without first making `vmpool` a public
   package (a distinct, larger refactor, out of scope here). Its own code comments also describe
   it as a legitimate production diagnostic CLI ("a diagnostic CLI run against the same host" as
   `microvm-worker`), not experiment-only code that happens to get used in experiments too.
3. **`deploy/knative/demo-{remote-worker,promoted-workflow,multiuser}.sh` do not move.** They are
   real consumer-facing walkthrough automation (`make demo-*`, with `--teardown` support), paired
   with `docs/demos/remote-sandbox-demo.md` and `docs/demos/promoted-workflow-demo.md`, which §6
   already keeps in the main repo. Moving the scripts but not the docs would orphan both. These
   are exactly what the original ask's own rule keeps in the "consumer" main repo — not research
   clutter. They may be rewritten/relocated in Phases 1/3/4 as the deployment model changes, but
   they do not go to `moca-experiments`.

§6 and §7 are corrected below. What _does_ move to `moca-experiments` in Phase 2 is now: the
`e1`–`e7` scripts and `EXPERIMENTS.md` under `deploy/knative/`, and the `e10`–`e13` scripts,
`EXPERIMENTS.md`, `METAL-RUNBOOK.md`, and `predictions.json` under `deploy/microvm/` — pure
measurement/research artifacts with no Go-import entanglement and no consumer-facing doc
counterpart.

## 0.8 Amendment — September 25, 2026 (Phase 2 executed; this document predates that work)

This spec was written, and its §3.5/§6/§7 content-list claims made, **before** Phase 2 actually
ran. Phase 2 has since executed (the same day) — this document's status line and a few of its
own factual claims are now stale relative to that:

- **§3.5/§6 said "no top-level `experiments/` directory exists."** That was true when written;
  it is no longer true of the repo (Phase 2 moved it to `rossoctl/moca-experiments`, git history
  preserved) — but it is also no longer true of what actually moved that §7's own table below
  ever recorded: §7 still lists only the original 21-file scope (the `deploy/knative/`
  E1/E3/E4/E6/E7 + `deploy/microvm/` E10-E13 content) from before planning found the
  `experiments/` package, `run-experiments.sh`, the two SWE-bench scripts, and
  `scripts/gen_swebench_deck.py` also needed to move. **§7 is left as the original planning-time
  table, not retro-edited** (this repo's own "don't retro-edit, note the correction" convention)
  — the actual, final 57-file scope is recorded in the commit that executed Phase 2 (its own
  message) and in `moca-experiments`' README, not here. A reader wanting the
  authoritative "what moved" list should use those, not §7.
- **The registry row in `docs/specs/README.md` said "plan only — execution gated."** Phase 2 is
  no longer gated (§0.4–§0.6) and has run — that row, and the track's own intro paragraph, are
  updated in this same commit to say so.
- §11's CLI-binary-name row wrongly said `vmpoolctl` was "moving to `moca-experiments`" — that
  contradicted §0.7's own correction two sections earlier and is now fixed in place.

Treat §7 (as corrected across §0.7 and the actual Phase 2 execution — see the commit that adds
this amendment) as the authoritative record of what moved, not the original §3.5/§6 prose, which
is left as-is rather than rewritten, consistent with this repo's own "don't retro-edit, note the
correction" convention for specs.

## 0.9 Amendment — September 28, 2026 (Phase 1 executed)

Phase 1 (the rename to MOCA) has executed. This document's own §11 table — describing exactly this
rename — was itself swept by the mechanical rename pass that carried it out, which briefly
overwrote its "Current" column with post-rename values before this amendment restored them. §11's
table below reflects the pre-Phase-1 state again, consistent with this document's own §0.7/§0.8
convention of never retro-editing original text. The actual rename is recorded in the commits on
`feat/ra1-phase1-moca-rename` (base `rossoctl/main` @ `23d288f`), not by editing this table.

## 0. How this document came to be

Written by an assistant session at the user's request, after: (a) reading the P4, P4.1, and P6
specs directly; (b) reading `moca-density-and-architecture.pptx` (an internal
architecture review deck, held outside this repo); (c) three parallel audits — of every code
subsystem, of every file in `docs/specs/` and `docs/adrs/`, and of external OSS repo-organization
conventions; (d) a check of the user's own working notes outside this repo
(`/Users/paolo/Projects/aiplatform/docs/serverless-harness/`) for any pre-existing rename/split
plan (none found — that area's own 2026-09-23 next-steps doc is entirely narrow engineering:
#336/#337/#338/#274/#261, no rename or repo split anticipated there); (e) several rounds of
clarifying questions and corrections with the user, resolving the scope decisions recorded in §1
and amended in §0.1–§0.3.

## 1. Resolved scope decisions

| Question                                  | Decision                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Touch code now?                           | **No.** This document is the only artifact this round produces.                                                                                                                                                                                                                                                                         |
| K8s/Knative/KEDA fate                     | **Deprecate, then remove later (§0.3).** No code is deleted by RA1. Once P4/P6 is the primary deployment model (Phase 3, §4), the Kubernetes/Knative/KEDA path is marked deprecated — present, functional, clearly labeled — not deleted. Actual removal is future work, out of RA1's scope.                                            |
| Phase order                               | **Rename → split experiments → make P4/P6 primary → deprecate K8s (§0.3).** See §4 for the full rationale and what this ordering costs relative to the original recommendation.                                                                                                                                                         |
| Plugin/adapter scope                      | **Elevate what exists; design, don't build, the rest.** The sandbox-execution adapter (container vs. microVM) already works and gets renamed/promoted in Phase 3. The agent-runtime ("swap Pi") adapter has no precedent in this codebase — write it as a design-only ADR/spec, not implemented; independent of the four phases (§9.2). |
| Sequencing vs. live PR roadmap            | **Resolved 2026-09-25.** Phases 1 (rename) and 2 (`moca-experiments` split) are both **ungated** — neither touches K8s code or the microVM restore/destroy path the roadmap is changing, and both can proceed independent of #336/#337/#338/#274/#261 landing. Phases 3–4 remain blocked on that roadmap. See §2.                       |
| Final name                                | **Decided — `MOCA`** (Micro Orchestrator for Cloud Agents). §11 shows the full blast radius with concrete values.                                                                                                                                                                                                                       |
| CLI naming convention                     | **Decided — `moca`/`mocactl`-style.** Exact binary name(s) chosen at execution time.                                                                                                                                                                                                                                                    |
| Experiments repo name                     | **`moca-experiments`**, cross-linked (README on each side links to the other).                                                                                                                                                                                                                                                          |
| Git history for relocated experiment code | **Preserved** — `git filter-repo` or an equivalent subtree split, not a clean copy. The measurement-methodology lineage in those commits (E1–E13, the throughput campaign) is valuable enough to carry over.                                                                                                                            |

## 2. Execution gate — do not start moving code until this clears

**Phases 1 and 2 are exempt from this gate as of 2026-09-25** (§0.5) — both can proceed
independent of the roadmap below. Neither touches K8s/Knative/KEDA code, the harness, or the
microVM restore/destroy path #336/#337/#274 are actively changing. Real execution of Phase 2 is
authorized (§0.6) — the required next step is `writing-plans` (§13) before any file move or repo
creation.

Phases 3 and 4 remain **blocked from execution**, not just sequenced after other work. The
blocking condition, concretely:

- [ ] PR #336 (defer VM reap off `execGate`) merged to `main`.
- [ ] PR #337 (decompose `Resume`, stacked on #336) merged to `main`.
- [ ] #338 (HITL workspace-TTL silent data loss — a live correctness bug, unrelated to
      throughput) has at least a committed fix, per the user's own next-steps-handoff:
      observability first, then the explicit `Release` path.
- [ ] #274 (per-Exec VM lifetime) has its design review resolved one way or the other — it
      doesn't need to be _built_, but the isolation-argument question it raises needs an answer
      before this plan's `docs/adrs/` cleanup (§8) can correctly describe P4's current isolation
      claim.
- [ ] #261 (a real model in the loop) — not a hard blocker on RA1 itself, but its results may
      change what "the shipped ceiling" number is that this plan's README/docs rewrite should cite.

A future session picking this up: **check these before doing anything else.** If they haven't
landed, the correct action is to say so and stop, not to proceed on stale assumptions — this is
the same discipline the user's own next-steps-handoff doc asks of itself.

**Question raised by §0.3's reordering — fully resolved 2026-09-25** (§0.4–§0.6): this gate was
written when Phase 1 meant "restructure and remove K8s." Now Phase 1 is a rename and Phase 2 is
an experiments-repo split — neither touches K8s/Knative/KEDA code or the live PR roadmap's subject
matter (the microVM restore/destroy path) at all. Both are ungated, and real execution of Phase 2
is authorized. Phases 3–4 remain gated per the checklist above.

## 3. Ground truth this plan is built on

Condensed from the three parallel audits (full detail lives in this conversation's transcript,
not repeated here to avoid drift from the source files themselves — re-run the audits rather than
trusting this summary if meaningful time has passed):

### 3.1 P6/P4 status, precisely

Both are **implemented and measured on bare metal**, but per the architecture-review deck itself,
**"not yet the default production path."** Knative+KEDA remains **"the shipped Phase-1 deployment
model"** today. Named blockers ahead of full removal, as understood _before_ this plan (see §2 for
the actual gate as of execution time): MU2/#248 (control-plane out of the harness's K8s namespace,
gates turning on session tokens at all), P4.1 (designed, zero lines of transport code built),
#274 (VM-reuse-across-Execs, explicitly "design idea, not built").

### 3.2 K8s/Knative/KEDA coupling — narrower than the framing suggests, but real

No `package.json` anywhere in the repo declares a Kubernetes/Knative/KEDA npm dependency — every
interaction goes through shelling the `kubectl` CLI or reading YAML manifests. It is concentrated
in:

- `packages/k8s-sandbox/src/resolve-pod.ts`, `KubectlTransport` — the K8s-specific sandbox
  transport implementation.
- `packages/control-plane/src/kubectl.ts`, `k8s-secret-store.ts` — `K8sSecretStore` is the
  **only** `CredentialStore` implementation wired into `main.ts` today.
- `packages/knative-server/src/server.ts` (reads Knative env vars), `leaf-job.ts` (KEDA
  `ScaledJob` pod-name parsing).
- `deploy/knative/*.yaml`, `kustomization.yaml`, `setup-ocp.sh`, `setup-k8s.sh`.
- `.github/workflows/build.yaml` (builds/publishes an OpenShift-targeted sandbox image).
- `Dockerfile` (installs the `kubectl` binary, ships `knative-server` as the entrypoint).

Everything else audited — `harness/`, `packages/sandbox-relay`, `session-backend`, `work-queue`,
`supervisor`, `config-bundle`, the entire `remote-worker/` Go module, `deploy/vm/`,
`deploy/microvm/`'s systemd units, and CI's `ci.yml`/`microvm-kvm-gates.yml` — has **zero**
Kubernetes coupling already.

### 3.3 The sandbox-execution plugin boundary already exists

Confirmed at the code level, in three matched layers:

1. **Interface** (`harness/src/select-sandbox.ts`): `SandboxTransport`, two implementations —
   `KubectlTransport` (K8s-specific) and `GrpcRelayTransport` (substrate-agnostic). Selected by
   env var, not a code branch.
2. **Wire contract** (`proto/sandbox/v1/sandbox.proto` → `gen/go/sandbox/v1/*.pb.go`, re-exported
   as TS types): `SandboxWorker.Attach` (bidi stream), `SandboxExec.Exec/Abort`. `sandbox_id` is
   opaque; `workspace_key` is P4's one additive field.
3. **Reference implementations**, already built: `remote-worker/cmd/worker` (plain container) and
   `remote-worker/cmd/microvm-worker` (Firecracker) — two binaries in one Go module sharing the
   Attach-protocol client code. This is the literal "image swap, not a fork" the architecture deck
   describes.

Both `SandboxTransport` implementations and the shared proto types currently live inside
`@moca/k8s-sandbox`, which is why that package **cannot be split into "elevated" vs. "deprecated"
halves for free** — see §6.

### 3.4 No existing seam for swapping the agent-runtime framework

`harness/package.json` links `@earendil-works/pi-ai` directly (`link:../pi-fork/packages/ai`).
Pi's own `Operations` extension point is a tool-execution plugin _within_ Pi, not a way to swap
Pi itself.

**Correction (§0.2):** the original ask's framing — Pi / Open Code / DeepSeek Harness as swappable
agent-runtime frameworks — is well-formed, not a layer conflation.
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is a real, separate
open-source agent-harness/runtime project from DeepSeek AI (an "everything-is-a-plugin"
architecture built on a framework called Cordis; developer preview) — comparable in category to
Pi, Open Code, or Claude Code, not an LLM.

One real distinction still holds and is worth keeping straight: **DeepSeek the LLM is already
supported in this repo as a model _provider_** inside pi-fork
(`docs/specs/2026-08-20-multi-protocol-model-provider-design.md`) — a different, already-solved
layer from "swap the whole agent-harness framework," and unrelated to DeepSeek Harness the
competing agent runtime. Don't confuse the two when reading this repo's existing multi-provider
support as if it already addressed the harness-swap ask — it doesn't.

No mention of "Open Code" or "DeepSeek Harness" as agent-runtime projects exists anywhere in this
repo's own code or docs — confirming there's genuinely no existing seam here, not that the ask
was misconceived.

### 3.5 Where "experiments" actually live today

No top-level `experiments/` directory exists — `CLAUDE.md`'s "Repository Structure" section is
stale (it also lists only 4 of the current 9 `packages/*`). Real experiment content is
**interleaved inside production directories**: `deploy/knative/{e1-e7*.sh, EXPERIMENTS.md,
demo-*.sh}` sit next to `kustomization.yaml`; `deploy/microvm/{e10-e13*.sh, METAL-RUNBOOK.md,
predictions.json}` sit next to the production systemd units. `remote-worker/cmd/vmpoolctl` and
`internal/relaytest` are experiment-driving tooling embedded in the production Go module.
Narrative result docs (`docs/notes/*`) are a third, separate thing — decision-record prose, not
runnable code — and are **not** part of the experiments-repo split (§7).

### 3.6 Docs/specs conventions are already good

`docs/specs/` + `docs/adrs/` is a disciplined, milestone-tracked registry (this very document
follows its conventions) with a "never delete, mark `Superseded`" policy. External research
(containerd, backstage, Cluster API, Kubernetes KEPs, CNI/CSI, go-plugin, langchain) surfaced no
convention obviously better for a single-repo project of this size — recommendation is to keep
it, not replace it. See §8.

## 4. Sequencing approach

**Rename first. Split experiments second. Make P4/P6 primary third. Deprecate K8s fourth.** (§0.3
reverses this document's original recommendation, which was restructure/remove-K8s-first,
rename-last.)

1. **Rename to MOCA.** Every surface in §11 — package scope, repo name, Docker image, CLI
   convention, docs/branding — changes in one pass, while the K8s/Knative/KEDA code is still
   present and still shipping. This means the rename must also touch code that Phase 4 will later
   deprecate (`packages/knative-server`, `deploy/knative/`, etc., don't disappear until Phase 4,
   and don't disappear even then) — a real cost of doing the rename first, accepted in exchange
   for never having a half-renamed repo to reason about mid-migration.
2. **Split out `moca-experiments`** (§7). **Cleared to start independent of both the roadmap
   gate (§2) and Phase 1** (2026-09-25) — the target repo name is already fixed regardless of
   when the main repo's own rename lands, so there's no hard dependency forcing this to wait.
   Numbered second here for narrative tidiness (cross-links read cleanest if `moca` already
   exists when `moca-experiments` is created), not because anything breaks if it happens first.
3. **Make P4/P6 the primary deployment model for MOCA.** Elevate `packages/sandbox-transport`
   (§9.1); build the non-K8s `CredentialStore` (§10.1) so `control-plane` can run without K8s;
   update README/docs/CI defaults so `deploy/vm/` + `deploy/microvm/` are _the_ documented path —
   while the Kubernetes/Knative/KEDA path keeps running, untouched, as the still-current fallback.
4. **Deprecate the Kubernetes/Knative/KEDA deployment.** Only after step 3 is real — P4/P6
   genuinely primary, not just present — does the old path get marked deprecated: in docs, in
   README, and (where practical) with a CI-level or startup-time deprecation notice. **The code
   is not deleted in this plan.** Actual removal is future work, out of RA1's scope (§1, §6).

**Why this order, and what it trades away.** This document originally recommended the opposite —
restructure/remove K8s first, rename last — to keep the rename a small, mechanical final step and
avoid ever renaming code about to be deleted. The user deliberately chose the reverse: rename once
and never revisit the naming question, and don't retire the fallback until its replacement has
_earned_ primary status rather than merely existing. This is a recognizable, sound migration
pattern (sometimes called "expand and contract," or a strangler-fig migration): keep the old path
alive and working, under the new name, while the new path proves itself, then retire the old path
from a position of confidence instead of urgency. The honest cost: the rename in step 1 touches
code that step 4 will later deprecate anyway, and the repo carries two working deployment models
side by side for the whole span between steps 1 and 4, rather than for a short window ending at
one cutover commit.

## 5. Target directory structure (end of RA1 — renamed, restructured, K8s deprecated but present)

This shows the state **at the end of RA1's four phases** — not a hypothetical future state after
K8s is actually removed (that's out of scope; see §1).

```
moca/
├── harness/                       # core agent runtime; primary sandbox transport is
│                                     sandbox-transport; the K8s transport is still selectable,
│                                     marked deprecated (Phase 4)
├── packages/
│   ├── sandbox-transport/         # NEW, PRIMARY (Phase 3) — extracted from k8s-sandbox's
│   │                                 non-K8s half: SandboxTransport interface, proto-derived
│   │                                 types, GrpcRelayTransport. THE existing adapter boundary,
│   │                                 elevated.
│   ├── k8s-sandbox/                # DEPRECATED (Phase 4) — narrowed to KubectlTransport +
│   │                                 resolve-pod.ts once sandbox-transport is extracted; kept,
│   │                                 not deleted, in RA1
│   ├── knative-server/             # DEPRECATED (Phase 4) — kept, not deleted, in RA1; diffed
│   │                                 against supervisor's sh-worker first (§10.3)
│   ├── sandbox-relay/             # unchanged
│   ├── session-backend/           # unchanged
│   ├── work-queue/                # unchanged
│   ├── supervisor/                # PRIMARY (Phase 3) — P6 process manager + load balancer
│   ├── control-plane/             # gains a non-K8s CredentialStore (Phase 3, §10.1);
│   │                                 K8sSecretStore remains available, no longer the only option
│   ├── config-bundle/             # unchanged
│   └── ibac-stub/                 # unchanged pending a short review (§12)
├── remote-worker/                 # unchanged (Go) — container + microVM workers, vmpool,
│                                     vmpoolctl, and internal/relaytest all stay (§0.7 — Go's
│                                     internal-import rule and production test dependents block
│                                     moving vmpoolctl/relaytest to a separate repo/module)
├── gen/, proto/                   # unchanged — the wire contract itself
├── deploy/
│   ├── vm/                        # PRIMARY (Phase 3) — P6 systemd deployment
│   ├── microvm/                   # PRIMARY (Phase 3) — P4 systemd deployment (experiment
│   │                                 scripts moved to moca-experiments, Phase 2)
│   ├── knative/                   # DEPRECATED (Phase 4) — kept, not deleted; docs/README point
│   │                                 elsewhere as the recommended path
│   └── claude/                    # unrelated dev tooling, unchanged
├── docs/
│   ├── specs/, adrs/, plans/, notes/, demos/, api/   # convention kept (§8)
├── pi-fork/                        # unchanged submodule
├── Dockerfile                      # MOCA branding (Phase 1); both entrypoints documented,
│                                     the K8s/knative-server one marked deprecated (Phase 4)
├── Makefile                        # MOCA branding (Phase 1); kind-based demo targets marked
│                                     deprecated alongside deploy/knative/ (Phase 4)
├── .github/workflows/build.yaml    # MOCA branding (Phase 1); still builds the OpenShift image
│                                     until Phase 4, then clearly labeled deprecated, not removed
└── CLAUDE.md, README.md, etc.      # rewritten — MOCA, P4/P6 documented as primary (Phase 3),
                                       K8s path documented as deprecated with no removal date set
                                       (Phase 4)
```

**Load-bearing distinction, unchanged from the original draft:** containers-as-a-sandbox-backend
**survive** regardless of K8s's fate. `remote-worker/cmd/worker` has zero Kubernetes imports — it
is substrate-agnostic "run a command in a container" code. What gets deprecated is _Kubernetes as
orchestrator_ (`kubectl exec` into a pod, Knative/KEDA scheduling, K8s Secrets) — not containers as
a sandbox technology. Container-backed and microVM-backed sandboxes both remain valid
`SandboxTransport` implementations throughout and after RA1.

## 6. Migration map

Phase numbers refer to §4. "Deprecate" means: kept in the tree, functional, clearly labeled — not
deleted. Nothing in this table is deleted by RA1.

| Path                                                                                                                                            | Phase(s)                                                                              | Action                                                                                                                                                                           | Reason                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/`                                                                                                                                      | 1, 3                                                                                  | Rename branding; add `sandbox-transport` import alongside the existing `KubectlTransport` import                                                                                 | Core; both transports remain selectable through Phase 4                                                                                                                                               |
| `packages/k8s-sandbox`                                                                                                                          | 3 (split), 4 (deprecate remnant)                                                      | Split: shared half → new `packages/sandbox-transport`; K8s-specific remnant (`resolve-pod.ts`, `KubectlTransport`) stays as `packages/k8s-sandbox`, marked deprecated in Phase 4 | The shared proto types/`GrpcRelayTransport` must be elevated before P4/P6 can be primary; the K8s remnant persists, deprecated, not deleted                                                           |
| `packages/knative-server`                                                                                                                       | 4 (deprecate, after a diff)                                                           | Diff `worker.ts` against `supervisor`'s `sh-worker` to confirm parity, then mark deprecated — not deleted                                                                        | `worker.ts` is the literal ancestor `sh-worker` was forked from (per that code's own comments)                                                                                                        |
| `packages/sandbox-relay`, `session-backend`, `work-queue`, `supervisor`, `config-bundle`                                                        | 1                                                                                     | Rename branding only                                                                                                                                                             | No K8s dependency, already substrate-agnostic                                                                                                                                                         |
| `packages/control-plane`                                                                                                                        | 3                                                                                     | Keep; add a new, non-K8s `CredentialStore` implementation                                                                                                                        | Needed for P4/P6 to be genuinely primary (§10.1); `K8sSecretStore` remains available, not removed                                                                                                     |
| `packages/ibac-stub`                                                                                                                            | 1                                                                                     | Rename branding only, pending review                                                                                                                                             | Small, unaudited surface (§12)                                                                                                                                                                        |
| `remote-worker/` (worker, microvm-worker, vmpool, guest-agent, exec-driver, null-responder)                                                     | 1                                                                                     | Rename branding only                                                                                                                                                             | Already K8s-free                                                                                                                                                                                      |
| `remote-worker/cmd/vmpoolctl`                                                                                                                   | 1 (rename branding only)                                                              | **Does not move (§0.7).** Stays in the main repo                                                                                                                                 | Imports `internal/vmpool`; Go's internal-package rule forbids any other module importing it. Also a legitimate production diagnostic CLI, not experiment-only code                                    |
| `remote-worker/internal/relaytest`                                                                                                              | —                                                                                     | **Does not move (§0.7).** Stays in the main repo                                                                                                                                 | Shared fake-relay test harness imported by production tests (`attach_test.go`, `contract_test.go`) — moving it breaks the main test suite                                                             |
| `deploy/knative/*.yaml`, `kustomization.yaml`, `setup-ocp.sh`, `setup-k8s.sh`, `overlays/`, `shipwright/`, `echo-target/`, `sandbox-inventory/` | 1 (rename branding), 4 (deprecate)                                                    | Keep and rename now; mark deprecated once P4/P6 is primary                                                                                                                       | Still the shipping fallback until Phase 3 proves the replacement                                                                                                                                      |
| `deploy/knative/authbridge/`                                                                                                                    | 4                                                                                     | Mark the K8s PoC deployment deprecated; the credential mechanism it PoC'd survives elsewhere                                                                                     | RC1's underlying design (static-inject plugin, egress control-plane pattern) is reused by P4.1/P5/MU1 and documented in specs/ADRs that stay active — only the Kind/OCP deployment code is deprecated |
| `deploy/knative/demo-remote-worker.sh`, `demo-promoted-workflow.sh`, `demo-multiuser.sh`                                                        | 1 (rename branding), 3/4 (rewrite for the new deployment model)                       | **Does not move (§0.7).** Consumer-facing walkthrough automation (`make demo-*`), stays in the main repo                                                                         | Paired with `docs/demos/remote-sandbox-demo.md`/`promoted-workflow-demo.md`, which already stay per this table — moving the scripts alone would orphan both docs                                      |
| `deploy/knative/e1-e7*.sh`, `EXPERIMENTS.md`                                                                                                    | 2                                                                                     | Move to `moca-experiments`                                                                                                                                                       | Runnable research/measurement code, no consumer-facing doc counterpart                                                                                                                                |
| `deploy/microvm/` (systemd units, production config)                                                                                            | 3                                                                                     | Becomes primary                                                                                                                                                                  | P4 production deploy                                                                                                                                                                                  |
| `deploy/microvm/e10-e13*.sh`, `METAL-RUNBOOK.md`, `predictions.json`                                                                            | 2                                                                                     | Move to `moca-experiments`                                                                                                                                                       | Same interleaving as knative's experiment scripts                                                                                                                                                     |
| `deploy/vm/`                                                                                                                                    | 3                                                                                     | Becomes primary                                                                                                                                                                  | P6 production deploy — cleanest of the three, no experiment scripts mixed in                                                                                                                          |
| `deploy/claude/`                                                                                                                                | 1                                                                                     | Rename branding only                                                                                                                                                             | Orthogonal (Claude Code workflow-promotion tooling), unrelated to this axis                                                                                                                           |
| `Dockerfile`                                                                                                                                    | 1 (rebrand), 4 (mark the `kubectl`/`knative-server` entrypoint deprecated)            | Update, don't remove either entrypoint yet                                                                                                                                       | Both paths must stay buildable through the deprecation window                                                                                                                                         |
| `Makefile`                                                                                                                                      | 1 (rebrand), 4 (mark `kind`-based demo targets deprecated)                            | Update                                                                                                                                                                           | Same reasoning                                                                                                                                                                                        |
| `.github/workflows/build.yaml`                                                                                                                  | 1 (rebrand), 4 (label the OpenShift build job deprecated)                             | Update, don't remove                                                                                                                                                             | Still builds the OpenShift image until Phase 4, then clearly labeled, not deleted                                                                                                                     |
| `.github/workflows/ci.yml`, `microvm-kvm-gates.yml`, `security-scans.yml`, `scorecard.yml`, `dependabot.yml`                                    | 1 (rebrand references only)                                                           | Keep as-is otherwise                                                                                                                                                             | Already cluster-free                                                                                                                                                                                  |
| `docs/specs/`, `docs/adrs/`                                                                                                                     | 4                                                                                     | Update statuses (§8)                                                                                                                                                             | Design-level supersession happens once P4/P6 is confirmed primary, independent of when code is actually removed                                                                                       |
| `docs/notes/`                                                                                                                                   | —                                                                                     | Keep as-is                                                                                                                                                                       | Narrative decision records — stay in main repo, distinct from runnable experiment scripts                                                                                                             |
| `docs/demos/moca-demo.md`                                                                                                                       | 1 (rename refs), 3–4 (rewrite to feature P4/P6 as primary and note K8s as deprecated) | Read fully first, then rewrite across phases                                                                                                                                     | Probably the primary onboarding doc, likely Knative-flavored — it's user-facing, unlike the internal specs                                                                                            |
| `docs/plans/`                                                                                                                                   | —                                                                                     | No action                                                                                                                                                                        | Already gitignored/local-only                                                                                                                                                                         |
| `CLAUDE.md`                                                                                                                                     | 1                                                                                     | Rewrite                                                                                                                                                                          | Stale today independent of this plan (missing 5 of 9 packages, describes a nonexistent top-level `experiments/`)                                                                                      |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`                                                                                     | 1, 3, 4                                                                               | Rewrite incrementally across phases                                                                                                                                              | Content should reflect each phase's actual state, not jump ahead of it                                                                                                                                |
| `pi-fork/`                                                                                                                                      | —                                                                                     | No action                                                                                                                                                                        | Submodule, internals out of scope                                                                                                                                                                     |
| `gen/`, `proto/`                                                                                                                                | 1 (rename only if it embeds the old name)                                             | Keep                                                                                                                                                                             | The wire contract                                                                                                                                                                                     |
| `/Users/paolo/Projects/aiplatform/docs/serverless-harness/` (the user's personal working-notes area)                                            | —                                                                                     | Out of scope                                                                                                                                                                     | Not part of the tracked git repository                                                                                                                                                                |

## 7. Experiments repo (Phase 2 of §4)

- **Name:** `moca-experiments`, cross-linked — a README section on each repo pointing at the
  other.
- **Content (corrected §0.7):** `deploy/knative/{e1-e7*.sh, EXPERIMENTS.md}`,
  `deploy/microvm/{e10-e13*.sh, EXPERIMENTS.md, METAL-RUNBOOK.md, predictions.json}`.
- **Not moving:** `docs/notes/*` (narrative results/decision docs — cross-referenced by specs and
  ADRs, prose records, not runnable harnesses); `remote-worker/cmd/vmpoolctl` and
  `remote-worker/internal/relaytest` (§0.7 — both have real dependents in the main Go module);
  `deploy/knative/demo-*.sh` (§0.7 — consumer-facing demo automation, paired with docs that also
  stay).
- **History:** preserved via `git filter-repo` (or an equivalent subtree split) rather than a
  clean copy — the E1–E13 and throughput-campaign commit lineage has real value.
- **Extraction is genuine file-level surgery**, not a directory move: experiment scripts and
  production manifests/units currently share directories (`deploy/knative/`, `deploy/microvm/`).
- **No longer strictly sequenced after the rename (Phase 1)** — cleared to start independent of
  it and of the roadmap gate (§2), as of 2026-09-25. Doing it after Phase 1 remains the tidier
  option (cross-links read cleanest if `moca` already exists), but is a preference, not a
  dependency.

## 8. Specs/ADRs — keep the existing convention, update statuses in Phase 4

Recommendation, per §3.6: **keep `docs/specs/` + `docs/adrs/` structurally unchanged.** Status
updates happen in **Phase 4** (once P4/P6 is confirmed primary), not before — this reflects
_design_ supersession, which is a real fact as soon as P4/P6 is primary, independent of when the
underlying K8s _code_ is actually removed (which RA1 doesn't do at all):

**Mark `Status: Superseded by RA1` (or by the specific successor spec/ADR):**

- Specs: `2026-06-17-m2-k8s-sandbox-client-design.md`, `2026-06-17-m3-persistent-channel-design.md`,
  `2026-06-17-m4-knative-serverless-wrapper-design.md`, `2026-06-25-m7-cluster-experiments-design.md`,
  `2026-06-27-async-leaf-completion-design.md` (the KEDA half),
  `2026-06-28-scheduled-leaf-dispatch-design.md` (the CronJob half),
  `2026-07-02-p0prime-ocp-fs-free-deployment-design.md`,
  `2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`.
- ADRs: 0002, 0003, 0004, 0009, 0015, 0018, 0019, 0023.

**Leave conditional on how #274/#261 resolve (see §2) before finalizing:** ADR-0017
(securityContext hardening) and ADR-0025/0027 (RC1/AuthBridge topology) — these matter only to
the extent K8s-shaped deployment detail survives anywhere; likely `Superseded` too, but confirm
against whatever RC1's successor mechanism looks like once P4.1 has real code.

**Stay `Active`/`Implemented`, unchanged:** everything tagged core-new-direction in the audits —
P1, P2, E6/P3.1, ST, P4, P4.1, P5, P6, MU1, and their ADRs (0020, 0021, 0022, 0024, 0032, 0033,
0034, 0035).

**New ADRs this work should produce, once execution starts (not now):**

1. The RA1 phased migration decision itself (supersedes 0002/0004/0015/0018 collectively at the
   design level, once Phase 4 lands).
2. The `sandbox-transport` package extraction/rename (Phase 3) — formalizes what ADR-0024/0035
   already describe as a seam, into a directory-level decision.
3. The agent-runtime ("swap Pi") interface — recorded as a **design-only** decision: "we will
   define this interface; we are not implementing it now." That's a legitimate ADR (a decision
   _not_ to build something yet is still a decision worth recording).
4. The deprecation itself (Phase 4) — worth its own short ADR distinct from #1: "we deprecate but
   do not remove Kubernetes/Knative/KEDA as of `<date>`; removal is tracked separately." Future
   readers should not have to infer removal timing from absence of evidence.

## 9. Plugin/adapter design

### 9.1 Elevate (Phase 3, real, low-risk)

Rename/extract the existing `SandboxTransport` seam into `packages/sandbox-transport`. No new
runtime code needed — `remote-worker/cmd/worker` (container) and `remote-worker/cmd/microvm-worker`
(Firecracker) already implement it. This becomes the documented, flagship example of "how a
backend plugs into this system" — because it already works, on real hardware, in production.

### 9.2 Design only — the agent-runtime interface (not implemented, independent of §4's phases)

Write a spec + design-only ADR for an interface capturing what `harness/` currently calls directly
on `pi-fork` — approximately: start a turn, resume a session, compact/checkpoint. Pi becomes the
in-tree **reference implementation** of this interface rather than a hard-linked dependency; a
future Open Code or DeepSeek Harness adapter would implement the same interface the same way. This
work doesn't depend on, or block, any of §4's four phases — it can happen whenever there's
bandwidth for it.

**Precedent, from the external research:**

- **containerd/containerd**: `core/` holds interfaces (runtime, snapshots, content...), `plugins/`
  holds implementations that register against them — one repo, directory-level separation. Closest
  match to "swap Pi in-tree" since there's no reason to force a repo split for this.
- **langchain-ai/langchain**: `libs/core` (abstractions) + `libs/partners/*` (in-tree reference
  integrations, graduating to their own repo once large enough) — the graduation path a future
  Open Code/DeepSeek-Harness adapter could follow if it starts small.
- **hashicorp/go-plugin**: the reference pattern _if_ this interface ever needs to become a real
  subprocess/cross-language boundary rather than a same-process TS interface — not needed now,
  worth citing for future-proofing.
- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**: directly
  in-domain rather than an analogy — a real, competing agent-runtime harness built on an
  "everything-is-a-plugin" architecture (the Cordis framework). Worth a direct look when this
  interface is actually designed, since it's a concrete existing answer to "what must an
  agent-runtime plugin boundary look like" from a project solving the same problem this repo
  would be solving, not an adjacent-domain borrow like the other three citations above.

**Naming/placement:** interfaces live in descriptively-named packages close to their consumers
(`sandbox-transport`, a future `agent-runtime-contract`), not in a generic top-level `adapters/`
or `drivers/` bucket directory — this matches how the repo already organizes itself by concern,
and the containerd precedent more than a flat convention would.

## 10. Real engineering gaps this plan surfaces (new code, not moves)

1. **`packages/control-plane` needs a non-K8s `CredentialStore`.** Today's only implementation is
   `K8sSecretStore`. This is a **Phase 3 prerequisite** — P4/P6 cannot be genuinely primary while
   the credential tier still requires K8s to function. (MU1's spec already documents
   `CredentialStore` as an interface with Vault/External Secrets as a stated future backend — this
   is "build the next implementation," not new design.) `K8sSecretStore` itself is **not removed**
   — it stays available for whatever still runs on the deprecated K8s path.
2. **The #248/MU2 namespace-collocation problem does _not_ automatically dissolve under this
   plan**, unlike the original draft assumed. That draft reasoned "removing K8s removes the RBAC
   reachability risk" — but RA1 doesn't remove K8s, it deprecates it while keeping it present. Once
   control-plane's _primary_ deployment (Phase 3) is non-K8s, the new deployment path has no
   #248-shaped risk on its own. But if the deprecated K8s deployment of control-plane is still
   reachable by anyone, its original namespace-collocation risk is unchanged by this plan — #248's
   actual fix (or an equivalent) is still needed for that path, not obtained for free. Flag this
   explicitly wherever session-token enablement is discussed during the deprecation window.
3. **`packages/knative-server/src/worker.ts` vs. `supervisor`'s `sh-worker`**: diff before marking
   `knative-server` deprecated (Phase 4) — confirm nothing the ancestor did is missing from the
   fork, since "deprecated" should mean "safe to stop recommending," not "silently missing a
   feature no one checked for."

## 11. Naming — blast radius (decided: MOCA)

**MOCA** — Micro Orchestrator for Cloud Agents. Every surface the name touches, applied in
**Phase 1** (§4) — first, not last:

| Surface                                                                                                                   | Current                                                                                   | Becomes                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo name (GitHub)                                                                                                        | `rossoctl/serverless-harness`                                                             | `rossoctl/moca` (GitHub redirects the old URL automatically — no discoverability loss, per the user's own reasoning for renaming in place rather than creating a fresh repo) |
| `package.json` `name` fields (workspace root + each `@sh/*` package, **including the ones Phase 4 will later deprecate**) | `@sh/*`                                                                                   | `@moca/*`                                                                                                                                                                    |
| Go module path (`remote-worker/go.mod`)                                                                                   | current module path                                                                       | updated to match, if it embeds the old name                                                                                                                                  |
| CLI binary name(s), if any ship                                                                                           | none currently named beyond `vmpoolctl` (stays in `remote-worker/`, §0.7 — does not move) | **decided — `moca`/`mocactl`-style naming** for any new supervisor/worker CLI (exact binary name(s) chosen at execution time, following this convention)                     |
| Docker image name/tags                                                                                                    | (currently unnamed generic build)                                                         | `moca` image name in `build.yaml` and any push targets — applies to **both** the primary and (until Phase 4 marks it deprecated) the K8s-targeted image                      |
| Import path prefixes, if npm-scoped                                                                                       | `@sh/...`                                                                                 | `@moca/...`                                                                                                                                                                  |
| `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`                                                                | "Serverless Harness" throughout                                                           | "MOCA" throughout, spelling out "Micro Orchestrator for Cloud Agents" on first mention in the README                                                                         |
| Experiments repo name                                                                                                     | n/a                                                                                       | `moca-experiments` (§7, Phase 2)                                                                                                                                             |
| Any docs site / domain                                                                                                    | none found                                                                                | n/a unless one exists elsewhere                                                                                                                                              |

Because Phase 1 is now first (§0.3), this rename touches more of the tree than the original plan
anticipated — including code that Phase 4 will later mark deprecated. That's an accepted cost of
the new ordering (§4), not an oversight.

## 12. Open items flagged for a human decision (not resolved by research)

- **Resolved 2026-09-25** (§0.4–§0.6): both Phase 1 and Phase 2 are ungated, and real execution of
  Phase 2 is authorized. No open item remains here.
- **`packages/ibac-stub`** — small surface, not deeply audited. Five-minute look before deciding
  its classification.
- **`docs/demos/moca-demo.md`** — likely the primary onboarding doc and likely
  Knative-flavored. Read fully before rewriting; it's user-facing, unlike the internal design
  specs.
- **RC1/AuthBridge** (spec + ADR-0025/0026/0027) sits between "load-bearing credential mechanism
  the new direction depends on" and "PoC built and run entirely on K8s (Kind+OCP)." §6/§8 above
  assume the _mechanism_ survives and the _K8s PoC deployment_ is what gets deprecated — confirm
  this reading holds once P4.1 has real code.
- **`docs/registry-hardening-hygiene-design.md` / ADR-0017** — conditional on whether any
  Kubernetes-shaped deployment detail survives anywhere in the repo, which under this plan it does
  (deprecated, not removed) — so its `Superseded` marking in Phase 4 should say so explicitly
  rather than implying the underlying concern is moot.

## 13. Next steps

1. ~~User reviews this document~~ — done through several rounds of feedback (§0.1–§0.6).
2. **Phases 3–4 do not proceed until §2's execution gate clears for them** (unchanged).
3. **Phase 2 execution starts now** (§0.6): invoke `writing-plans` to turn the `moca-experiments`
   split into an ordered, reviewable-commit-per-step implementation plan (per the user's original
   ask: "execute the migration incrementally, with a clear commit per logical step") — this
   document has not itself produced that task-by-task plan (§14); that happens next, outside this
   file.
4. Phase 1 (rename) is also ungated but not yet explicitly requested for execution the way Phase 2
   was — confirm before starting it the same way, or fold it into the same `writing-plans` pass if
   that's more natural given Phase 2 references the final name throughout.
5. Names are already chosen (§11: **MOCA**, CLI binaries follow a `moca`/`mocactl`-style
   convention) — apply them whenever Phase 1 actually runs.

## 14. Spec self-review notes

- **Placeholders:** none remain.
- **Internal consistency:** §4's phase order, §5's target tree, §6's migration map (with its Phase
  column), §7's experiments-repo timing, and §11's naming section now all agree that rename is
  Phase 1 and K8s deprecation (not deletion) is Phase 4. §10 was corrected so its #2 no longer
  claims K8s removal as a free byproduct — it isn't, since RA1 doesn't remove K8s.
- **Scope:** this document still does not include a detailed implementation plan (task-by-task,
  file-by-file edit sequence) — deliberately deferred to the `writing-plans` skill per §13, once
  §2's gate (scope pending §12) clears.
- **Ambiguity:** §12 now carries five flagged items. Two are new as of §0.4: whether Phase 1
  (rename) is also ungated (only Phase 2 is resolved so far), and whether "cleared to start" means
  real execution can begin now or only that the plan's gate _policy_ is settled — this document
  has still not authorized any actual file move, repo creation, or git history rewrite. The
  K8s-vs-mechanism split for RC1/AuthBridge and ADR-0017's exact wording remain the other
  substantive open calls; all are flagged rather than silently decided.

---

_Assisted-By: Claude Sonnet 5 <noreply@anthropic.com>_
