# Sandbox templates for agent sessions — Design

Version: 1.0 — November 2026
Status: Proposed — issue rossoctl/moca#731
Builds on (reuse, no redesign): [P6.3](2026-10-04-p6-on-kubernetes-slice3-design.md) (sandbox tiers
and session-to-sandbox affinity), [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (its
templates: one `microvm-worker` per snapshot).

> **The one-sentence thesis.** A session can name a sandbox template at creation, as it names a
> tier; every turn then runs on a worker that serves that template's snapshot, and the harness
> seeds the session's workspace from the template the first time it is used. A session that names
> none never lands on a templated worker.

---

## 0. Decisions taken during design

| Question                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a template is, to selection       | **A second presence label, `moca.dev/template`**, next to `moca.dev/tier`. A worker advertises it from `SANDBOX_TEMPLATE`. The deployment declares its templates (`SH_SANDBOX_TEMPLATES`, the same JSON list SBX0's control plane reads, with an optional `seed`). Rejected: matching on the snapshot name (it carries a digest and changes with every version); matching on `Hello.image` (a container reference, not an id clients choose). |
| Who picks a session's template         | **The user, at session creation**, fixed for the session's life, like its tier.                                                                                                                                                                                                                                                                                                                                                               |
| Where a session with no template lands | **Only on untemplated workers.** A plain session never gets a benchmark image (often without network, with another toolchain) by accident.                                                                                                                                                                                                                                                                                                    |
| Who seeds a templated workspace        | **The harness, once, on the session's first turn that uses the workspace**, so a stock agent starts in the template's repository. SBX0 clients run the seed themselves; agents in Moca sessions do not know to.                                                                                                                                                                                                                               |
| How the template reaches the selector  | **On the exchange response**, beside the tier, as P6.3 does.                                                                                                                                                                                                                                                                                                                                                                                  |
| Trust                                  | **As the tier.** The label is the worker's word, from its own environment. A workload sandbox's signed attach binding (`AttachBinding`) has no template: workload sandboxes are not templated in this design, and the relay removes a `moca.dev/template` label from any worker attached with a binding.                                                                                                                                      |

## 1. Scope

**In scope:** the worker label, the relay pass-through (and its removal under a binding), the
control plane's session field, validation, storage, exchange and discovery, the harness's filter,
affinity and seed, mocactl's session option, the VM path's templated worker, configuration, and
tests.

**Out of scope:** templates for workload sandboxes (Kubernetes provisioner); several templates per
worker (one worker serves one snapshot, as in SBX0); a per-subject template allow-list; changing a
session's template after creation; building snapshots (`deploy/microvm/build-snapshot.sh` does that).

## 2. Current state

A session's sandbox is chosen by tier only. The presence record (`sh:sandbox:records`) holds
`labels`, `capabilities` and `capacityMax`; `labels` carries `moca.dev/tier` and, for workload
sandboxes, `moca.dev/workload` and `moca.dev/owner`. A P4 `microvm-worker` serves one snapshot
(`SH_SNAPSHOT_DIR/SH_SNAPSHOT_IMAGE`), but nothing in its record says which. SBX0 has templates, but
maps each straight to a worker's `sandbox_id` in its own control-plane profile; Moca sessions do not
use it.

## 3. Data model and wire

### 3.1 Workers (`remote-worker`)

`SANDBOX_TEMPLATE` (both `cmd/worker` and `cmd/microvm-worker`): set and non-blank, the worker's
Hello labels gain `moca.dev/template: <value>`, trimmed. Unset or blank: no label. There is no
default. `TemplateLabels` sits beside `TierLabels` in `internal/session/labels.go`; `Labels` merges
the two.

### 3.2 Relay (`packages/sandbox-relay`)

The label passes through like any other. With attach keys, `trustedLabels` deletes
`moca.dev/template` when the worker has a binding (a workload sandbox), and keeps it otherwise: a
shared-pool worker's labels are its own word today, the tier included.

### 3.3 Control plane (`packages/control-plane`)

- **Configuration.** `SH_SANDBOX_TEMPLATES` in the harness profile is the same JSON list SBX0 reads,
  `[{id, worker, description, tools, seed?}]`; `worker` is ignored here (selection is by label), and
  `seed` is an optional string. Unset or blank: no templates, and nothing below changes.
- **`POST /v1/sessions`** accepts `sandbox.template: string`. A non-string is a 400
  `invalid_request`. With templates declared, an id not in the list is a 400 whose message lists
  the declared ids; with none declared, any template is a 400 (`this deployment declares no sandbox
templates`). Omitted: `''`, no template.
- **`SessionRecord.sandboxTemplate: string`**, stored in the session hash beside `sandboxTier`.
- **`ExchangeResponse.sandboxTemplate?`** and **`sandboxSeed?`**: the stored template, and its seed
  while the deployment declares it. Omitted when the session named none, so a deployment without
  templates sends byte-identical responses. **Fail closed:** a template dropped from
  `SH_SANDBOX_TEMPLATES` (or the variable unset) is still named, without a seed. Unlike a tier there
  is no default template, so the data plane finds no worker of it and refuses the turn, rather than
  moving the session to an untemplated worker on an empty workspace. The data plane refuses a
  present `sandboxTemplate` that is not a non-empty string, and a non-string `sandboxSeed`.
- **Views** (`GET /v1/sessions`, `GET /v1/sessions/{id}`) include `sandboxTemplate` on a deployment
  that declares templates (`null` when none), and for any session that named one.
- **`GET /v1/discovery`** gains `sandboxTemplates: [{id, description, tools}] | null`.

### 3.4 Data plane (`packages/knative-server`, `harness`)

`TurnAuth` gains `sandboxTemplate` and `sandboxSeed`; `executeTurn` passes them to
`acquireTurnSandbox`, which passes `opts.template` to `selectPoolSandbox` and runs the seed (§5).
Leaf paths and unauthenticated turns pass no template. The async turn exchange
(`POST /internal/turn-credentials`, ADR-0047) does not carry the template in this change: an async
drain that runs a templated session's turns must add it there first.

### 3.5 Affinity

The affinity entry is unchanged (a sandbox id and a tier). What changes is how a present affine
sandbox is judged: one that now serves another template (or none) is outside the session's
filtered set, and is handled as one moved to another declared tier (§4).

## 4. Selection (`selectPoolSandbox`)

After P6.3's tier filter, a **template filter**:

- `opts.template` set: keep only records with `labels["moca.dev/template"] === opts.template`.
- `opts.template` unset or `''`: keep only records **without** a `moca.dev/template` label.

The empty-set error (`SandboxPoolEmptyError`) names the template when one was asked
(`no attached sandbox for sandbox template 'X' …; check that a worker of this template sets
SANDBOX_TEMPLATE=X`). Affinity: an affine sandbox that is present but now serves another template
(or none) is handled exactly like one moved to another declared tier: an immediate reset, no
grace, with the existing reason `'retiered'`, so the turn stream's `workspace_reset` frame is
unchanged on the wire. Everything else in P6.3 §4 is unchanged.

The template filter needs no deployment setting: a deployment whose workers carry no template label
is unaffected.

**Leaves and unauthenticated turns** pass no template, so they too run only on untemplated
workers. A deployment that templates some workers must keep at least one untemplated worker (per
tier it uses) for them, as the tier design keeps a default tier; with every worker templated, a
leaf fails with `SandboxPoolEmptyError`, which names no template.

## 5. The seed

When the session has a template with a seed, `acquireTurnSandbox` runs it in the selected sandbox,
through the same relay exec client, before the turn's first tool call, **in the session's
workspace** (the selection's `podCwd`: `/workspace` on a microVM, `/workspace/<sessionId>` on a
container worker), and only if that workspace is not seeded yet:

    cd <workspace> && flock .moca-seed.lock bash -c \
      '[ -e .moca-seeded ] || { bash -c <seed> >.moca-seed.log 2>&1 && touch .moca-seeded; }'

- **The marker** (`.moca-seeded`) lives in the workspace, so it travels with it: a session that keeps
  its sandbox is seeded once; a workspace reset (a new, empty workspace) is seeded again.
- **`flock`** holds concurrent first turns of one session (affinity puts them on one workspace) to
  one run; the second waits and finds the marker. Without `flock(1)` in the image the guard runs
  unlocked.
- **A failed seed leaves no marker**, so the next turn runs it again on whatever it left: a seed must
  be safe to re-run (`cp -a` is; a bare `git clone` into the workspace is not).
- **Output** goes to `.moca-seed.log` in the workspace, never into the turn, so a chatty seed cannot
  trip the output cap. Only the exit code is read.
- **The lease is renewed** while the seed runs, as for the turn, since a seed (a clone, an install) may
  outlast the lease TTL. The worker's timeout is 600 s.
- **A failed seed** fails the turn with `SandboxSeedError` (a 500, not retryable: the template's image
  cannot serve the session), naming the template, the exit code or the error, and the log. The lease
  is returned.

## 6. User surface

- mocactl: `--option sandboxTemplate=<id>` (a `SESSION_OPTION_FIELDS` entry; its choices from
  `/v1/discovery`), shown in the session list beside the tier. A value that is not among those
  choices is sent as given, for a control plane that resolves template references itself (for
  example `id:tag` or `id@<build>`); its refusals are shown as the control plane words them, and a
  `409 template_not_active` (a template being activated on first use) is waited out after its
  `Retry-After`, up to 10 minutes.
- `mocactl run` refuses an empty `--session` (a script whose id lookup came back empty) and says why
  it waits on a capacity refusal, up to a bound.

## 7. Configuration and deployment

- Control plane: `SH_SANDBOX_TEMPLATES` (harness profile), alongside `SH_SANDBOX_TIERS`.
- Workers: `SANDBOX_TEMPLATE=<id>` in a templated worker's env file. One worker per template.
- On the VM path, a templated worker is a **second** P4 worker beside the untemplated main one:
  `deploy/microvm/setup-microvm.sh --template <id> --snapshot <dir> [--budget-mb N] [--egress]`
  installs it from a template unit (`microvm-worker@.service`, instance `tpl_<id>`) in its own slice
  (a worker sweeps its parent cgroup at start, so two never share one), with its own relay token,
  env file, and workspace and jail roots; `--uninstall-template <id>` removes exactly that.
  **Egress on one worker per host:** moca-egress keys VM listeners by id, which every worker reuses
  (`vm-1`, …), so `--egress` is refused while another worker uses it, until moca-egress scopes ids
  per worker.

## 8. Testing

- **Workers, Go unit:** `SANDBOX_TEMPLATE` → the label, blank, unset, merged with the tier.
- **Relay, unit:** the label passes through; it is removed under a binding. **Integration** (Redis):
  templated and untemplated workers through a real relay; every session stays on a worker of its
  own kind across turns.
- **Control plane, unit:** parse (the seed optional and a string), create (unknown, none declared,
  non-string, omitted), the stored field, the exchange (present only with a template, fail closed),
  discovery.
- **Harness, unit:** the template filter both ways, the error wording, affinity across a template
  change (an immediate reset), the seed (runs once, skipped with the marker, re-run after a reset,
  failure, the lease renewed and returned).
- **mocactl, unit:** the option field and request shape, values passed through, the activation
  wait, the session list.
- **VM deploy:** `deploy/microvm/tests/setup-microvm.test.sh` covers `--template` and
  `--uninstall-template` with stubbed system commands.
- **Acceptance, on a KVM host:** one untemplated P4 worker and one templated worker; a session with
  the template lands on the templated worker and finds the repository seeded, and its second turn
  does not seed again; a session without lands on the untemplated one; an unknown template is
  refused at creation. `deploy/microvm/mock-anthropic.mjs`'s `TPL-SMOKE-LOOK` prompt makes that check
  deterministic without a model.
