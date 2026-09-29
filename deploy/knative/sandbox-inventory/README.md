# Sandbox binary inventories

Each file declares the commands one sandbox image provides. The promote CLI (`cd harness && pnpm promote`; see
[`../../../docs/specs/2026-09-02-claude-code-workflow-promotion-design.md`](../../../docs/specs/2026-09-02-claude-code-workflow-promotion-design.md) §4.5)
preflights a workflow's detected binaries against these **without cluster access**, so a
promotion can be checked on a laptop.

- **Filename** is the image ref with `:` and `/` replaced by `_`, plus `.json`.
- **Contract:** `{ "image": "<ref>", "binaries": ["<sorted, unique>"] }`.
- `tar`, `base64`, `flock` and `git` are required by `converge.ts` and `config-overlay.ts`.

Two checks guard these files, because they catch different failures:

| Check                             | Runs                   | Catches                                                                |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `tests/sandbox-inventory.test.sh` | every PR, no cluster   | malformed JSON, wrong filename, unsorted list, a missing required tool |
| `../verify-sandbox-inventory.sh`  | where the image exists | **drift** — the file claiming something the image does not have        |

A file that has drifted makes preflight lie, and a lying preflight is worse than none because
people stop checking it. Re-run the verify script whenever the sandbox Dockerfile changes.

## Provenance

`ghcr.io_rossoctl_moca-sandbox_latest.json` was generated from the real
published image, not curated by hand:

- Image: `ghcr.io/rossoctl/moca-sandbox:latest`
- Digest: `sha256:0683379d6368ab14c41d9bb46683178946091abba47b1832756d89f39afcdb9f`
- 347 binaries
- Enumerated 2026-09-03 by listing every executable on `PATH` inside the image
