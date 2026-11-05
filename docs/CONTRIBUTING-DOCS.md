# Writing and maintaining MOCA docs

Conventions for anything under `docs/`, the READMEs and `deploy/*/README*.md`. They exist so the
docs survive the move from the Knative/KEDA deployment to P6/P4 without another restructure. The
plan behind them is [`REORG-PLAN.md`](REORG-PLAN.md).

## Where things go

| Content                                        | Home                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| How to install or run one deployment path      | Next to its scripts: `deploy/<path>/README.md`                                        |
| Which path to pick, cross-path overview        | `docs/get-started/`                                                                   |
| One decision and its alternatives              | An ADR in `docs/adrs/` (immutable apart from the Status line and a Revisions section) |
| A design and its reasoning                     | A spec in `docs/specs/`, registered in `docs/specs/README.md`                         |
| Throwaway implementation checklist             | A plan; plans are local and gitignored (`docs/plans/README.md`)                       |
| Working notes, runbooks, measurement write-ups | `docs/notes/`                                                                         |

Do not put design reasoning in a how-to or install steps in a spec. Keep concept and reference
content free of Knative/KEDA specifics: put substrate differences in a per-path table, or in a
clearly marked "Legacy" note, so removing the Legacy path deletes a row instead of rewriting a page.

## Maturity labels and banners

Every install path, guide and reference page states **Stable**, **Preview** or **Legacy** (meanings
in the [documentation map](index.md#maturity-labels)). The label must agree with the milestone
registry; if it does not, fix the registry in the same change.

Use this banner verbatim, changing only the bracketed parts.

Preview:

```markdown
> **Preview.** <What this page describes> is implemented but not yet declared Stable; interfaces
> and limits may change. Known limits: <link to the limits section or issues>.
```

Do not state a support commitment the ADRs do not state.

## Page conventions

- **Prerequisites first.** A short block listing tools, versions and credentials. Do not repeat
  another page's prerequisites; link to it and list only what differs.
- **Verify and uninstall.** Every install page ends with a command whose output proves it works,
  and a teardown.
- **Tested-on stamp.** One line, `Tested on <environment>, <date>`, only for steps you ran.
  Mark anything you did not run as _(unverified)_ rather than leaving it out.
- **Command blocks.** One fenced block per step, `bash` language tag, copy-pasteable, no `$` prompt,
  secrets as obvious placeholders. Show expected output separately.
- **Environment variables.** Name the file each one lives in. Never document a secret as an env
  line when the deployment loads it as a credential.
- **Cite the source.** Claims about behavior name the file, spec section or issue they come from.

## Terminology

Use [the glossary](glossary.md) terms as defined: `session` (durable, owned, resumable), `turn`
(one exchange), and not `run`. The product is **MOCA**; packages are `@moca/*`. Legacy names
(`serverless-harness`, `SH_*`, `KAGENTI_*`, `@sh/*`) appear only where a variable or path still has
that name, never in new prose. "P6" and "P4" are milestone IDs (process manager and microVM
sandboxes); introduce them with that gloss on first use in a page.

## Links

- Use relative links to files that exist in this repository. Do not link into a parent monorepo.
- Moving a file: `git mv` it, leave a one-line stub at the old path if anything links to it, and
  fix inbound links in the same change.
- Run `make check-links` before pushing; CI runs the same check.

## Status vocabulary

Specs and ADRs use `Proposed`, `Accepted`, `Implemented`, `Superseded by <link>` or `Deprecated`.
When a design is replaced, mark the old one Superseded instead of deleting it.
