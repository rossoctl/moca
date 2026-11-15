# Template governance: gating, provenance and the process

> **Preview.** Template gating and provenance is implemented but not yet declared Stable; interfaces
> and limits may change.

How a container image becomes a Moca sandbox template that may be deployed, and how every deployed
image and template stays traceable. The tools are one level up, in
[`deploy/sbx/template-onboarding/`](../README.md); this folder holds what governs their use.

| Document                             | What                                                                                                                                                    | Owner             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`GATING-RULES.md`](GATING-RULES.md) | the gating rules for images and templates: Moca's own (M) plus the image builder's extensions (X), each with its tier, evidence, record and enforcement | the image builder |
| [`PROCESS.md`](PROCESS.md)           | the process, written while it is built: onboarding, gating, provenance, activation                                                                      | the operator      |

**Changing a rule.** A rule changes by a pull request to `GATING-RULES.md` that its owner reviews,
and the code that enforces it (`packages/control-plane/src/template-policy.ts`, `template-build.sh`)
changes in the same pull request. A deployment's own choices (which profiles it offers, which
registries and repositories it admits, whose gate records it trusts, its quotas) are not rule
changes: an admin sets them in the stored policy (`PUT /v1/policy`), and each change is a `policy`
provenance record naming who made it ([`PROCESS.md`](PROCESS.md), step 0). A change that widens
the policy (a trusted gate record, a registry or repository, a profile added or loosened) needs an
admin named in the settings (`SBX_ADMIN_SUBJECTS`); an admin granted through the API may only narrow
it or change quotas.

## Why here

- **The process and the rules sit next to the tools that apply them** (`template-build.sh`,
  `template-register.sh`): Moca's documentation rule puts how to run a deployment path next to its
  scripts ([`docs/CONTRIBUTING-DOCS.md`](../../../../docs/CONTRIBUTING-DOCS.md), "Where things go").
- **The design** (its reasoning and alternatives) is a spec in `docs/specs/`, as that rule says:
  template lifecycle, readiness and provenance,
  `docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md`.

**This folder is movable.** Other documents link only to this README (the documentation map and the
design spec); the documents here link to each other by relative path. If Moca's admin team wants it
elsewhere, moving it is one `git mv` and those links.
