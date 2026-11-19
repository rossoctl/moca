---
sidebar_position: 7
---

# Make your own templates

> **Preview.** The sandbox service is implemented, but not yet declared Stable; interfaces and
> limits may change.

New to templates? [Make a template from a container image](template-from-image.md) walks through a
first one, step by step; this page is the reference for every command.

A template is the image a sandbox's VM boots: its tools, and its seed (what fills `/workspace`).
Beyond the ones your operator provides, you can make your own from an image pinned by digest
(`repository@sha256:<64 hex>`) and a spec (`moca-sbx-template-spec/1`; samples in
[the onboarding examples](../../../deploy/sbx/template-onboarding/examples)). A policy, not a person,
admits or refuses each create; the rules it names are in
[the gating rules](../../../deploy/sbx/template-onboarding/governance/GATING-RULES.md). Every command
below takes `--json` (the API's answer, never a token).

**What you may do.** `mocactl sbx quota` shows your template quotas and use, and your live-sandbox
cap; `mocactl sbx policy` the profiles a create can name, each with its size envelope, egress and
rules, the registries an image may come from, and the policy's digest; `mocactl sbx hosts` each
KVM host's active slots, start line and memory.

**Create, and follow the build:**

```bash
mocactl sbx templates create --spec my-python.json --dry-run   # the checks needing only the inputs
mocactl sbx templates create --spec my-python.json             # prints: my-python b-<handle> queued
mocactl sbx templates follow my-python                         # exit 0 once registered
```

- `--spec` is a spec file or a gate record (whose `template` block is the spec); the id and image
  are the spec's own (`--id`, `--image` must equal them). `--profile P` names a policy profile,
  `--gate-record F` sends its gate record byte for byte (the `benchmark` profile needs one; at most
  1 MiB, with one `--spec`),
  `--visibility private` keeps a new template to yourself.
- `--dry-run` creates nothing: it reads the policy (`mocactl sbx policy`, so it needs your login
  and the control plane, exit 3 or 4 without them) and names the policy rule a create would fail
  (`M7.id`, `M1`, `X10`, …). Whether the policy trusts a gate record, whether the image's registry
  is allowed, and your quotas, only the server decides: its answer is still the decision.
- Several `--spec` make one create each. When your `buildsQueued` quota is full, the next waits for
  a slot ("N waiting for a queue slot") rather than failing, up to `--timeout` (default 3600 s).
  Ctrl-C stops it with exit 130: the specs not yet posted are not posted.
- A create on an id already yours is a new build of it. The same create again (same image, spec,
  profile and gate record) answers the build it already made (`reused`), not a second one; a
  changed spec, image or profile queues a new build. An id someone else owns is refused with its
  owner's name.
- `follow` polls until the build is `registered` (exit 0), `failed` or `rejected` (exit 1, with
  its reason). `templates show ID` prints it once; `templates cancel ID --build B` withdraws one not
  yet built. `templates build ID --spec F` is a new build of your template.

**Use it:**

```bash
mocactl sbx templates activate my-python --wait     # until active, saying why it waits
mocactl sbx create --template my-python --seed      # the build's seed first, then a clean-tree check
mocactl sbx templates deactivate my-python --stop-now
```

`activate --wait` prints why a start waits (queued at position N, no slot, memory, or a memory
file to rebuild); a refusal other than a full slot fails at once.
`create --template ID@BUILD` pins one build. `create --seed` runs the build's seed as the sandbox's
first command, then checks that `/workspace` is a clean git tree; a failure keeps the sandbox, for
you to look at. The seeded tree becomes the sandbox's baseline, so `sbx pull` returns only what
changed after the seed, and `sbx rm` deletes an unchanged seeded sandbox with no `--force`.
**A probe sandbox you then changed needs `sbx rm --force`:** a sandbox created with `--seed` to try
a template, in which you ran something that wrote to `/workspace` (a test run's caches, a build),
has changes not yet pulled, so a plain `rm` refuses it. Pull what you want to keep, then
`mocactl sbx rm --force <id>`. `deactivate --stop-now` skips the host's idle grace.

**Change and retire it:** `mocactl sbx templates tag ID default --build B` points new creates at
another build; `templates edit ID` changes its description and visibility. `mocactl sbx templates
retire my-python --wait` returns once no host holds it; `--build B` retires one build. A retire is
refused while a live sandbox runs on the build, or an active Moca Pi session is pinned to it
(`409 build_in_use`): delete those first. A sandbox create naming a retired build answers
`410 template_retired`. A `templates create` of your own retired id is not refused: it queues a
new build of it.

**Waits and their exit.** `follow` waits up to 3600 s, `retire --wait` 900 s (past the 600 s a
host keeps shipping an ended sandbox's egress before it removes the build, plus a few host polls);
`activate --wait` at least 1800 s, more for a build queued behind its host's start limit:
(position ÷ starts at once, rounded up, plus 1) × the host's measured start time × 1.25, read at
the first poll, and at most 4 h. `--timeout S` sets another. Past it they exit **5**; nothing is undone.

**What your sandbox reached.** For a template with egress, `mocactl sbx egress <sandbox>` lists the
hosts the sandbox connected to, from the KVM host's egress proxy, and the sandbox's end record names
the log's digest.

**A record of every call.** `--record calls.ndjson` on these commands (and every other command that
calls the API, but `token`, `login`, `logout` and `credentials`) appends one JSON line per HTTP
attempt: the command, the path, the status, both bodies and their times. The file is created `0600`.
Tokens and gate records are kept only as their sha256, and hosts and build-log text only as their
length, so a record can be shared. `mocactl run "prompt" --record F` writes the same record for a
Moca Pi session's calls ([CLI reference](../../harness/reference/cli-mocactl.md)). When you report a
problem, your operator may ask you to rerun the command with `--record` and send the file
([the runbook](../../operate/sandbox-service/runbook.md#reproducing-a-members-issue) says what they collect
besides it).

**For admins.** `mocactl sbx admin subjects enroll|unenroll|grant|revoke` reads the current value
first and prints `old -> new` and the record written; if the value changed between that read and
the write (another admin at the same time), it says so and exits 1: check it and write again.
`mocactl sbx templates quota TARGET …` sets a subject's template quotas, and `templates transfer ID
SUBJECT` hands a template to another owner.

## Pin a session to a build

A Moca Pi session (`mocactl run`, not a `mocactl sbx` sandbox) can name a template too, on a
deployment whose control plane serves sessions and keeps a template store, such as one on the
`combined` route profile. Name it once, when the session is created, in the same forms a sandbox
takes (`ID`, `ID:TAG` or `ID@BUILD`):

```bash
mocactl sbx templates activate my-python --wait
mocactl run "fix the failing test" --option sandboxTemplate=my-python@sha256:<64 hex>
```

- The reference resolves to one registered build at creation, kept for the session's life: the
  session shows `sandboxTemplate`, `sandboxBuildId` and `templateManifestHash`. `mocactl` sends a
  value its list does not show as given, and the control plane judges it (`400 unknown_template`).
  `--option` is ignored when resuming a session.
- Its turns run only on workers of that build. With none attached, a turn is refused
  `503 sandbox_unavailable`, which a retry can clear. On an inactive build, the session create answers
  `409 template_not_active`, and on the `combined` profile it starts the activation only for a
  subject enrolled for sandboxes (`403 not_enrolled` otherwise), so activate it first, as above.
- The harness runs the build's own seed once in the session's workspace, before the first tool
  call; the turn's `sandbox.seed` says `{source: build, buildId}`. After every turn, the
  result's `workspace` holds the whole diff from the seed's baseline commit; a diff over
  `SH_TURN_PATCH_MAX_BYTES` (4 MiB by default) is left out, `patchRefused: too_large`, never cut
  ([Sandboxes and tiers](../../harness/concepts/sandboxes-and-tiers.md#templates)).
- An active session pinned to a build blocks its retire (`409 build_in_use`): delete it when you
  are done (`mocactl sessions delete ID`).

## From your own code

A client that calls the REST API directly sees the same templates, builds and leases. Every route,
error code, policy rule id and quota is in the [Template API](../reference/templates-api.md), and
what each build status and readiness means is in
[Templates, builds and activation](../concepts/templates.md).

All the flags: [`mocactl sbx` reference](../reference/cli-sbx.md).
