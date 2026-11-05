# Sandbox binary inventories

Each file declares the commands one sandbox image provides. The promote CLI (`cd harness && pnpm promote`; see
[`../../docs/specs/2026-09-02-claude-code-workflow-promotion-design.md`](../../docs/specs/2026-09-02-claude-code-workflow-promotion-design.md) §4.5)
preflights a workflow's detected binaries against these **without cluster access**, so a
promotion can be checked on a laptop.

- **Filename** is the image ref with `:` and `/` replaced by `_`, plus `.json`.
- **Contract:** `{ "image": "<ref>", "binaries": ["<sorted, unique>"] }`.
- `tar`, `base64`, `flock` and `git` are required by `converge.ts` and `config-overlay.ts`.

Two checks guard these files, because they catch different failures:

| Check                                                | Runs                   | Catches                                                                |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| the shipped-inventory tests (`test/promote.test.ts`) | every PR, no cluster   | malformed JSON, wrong filename, unsorted list, a missing required tool |
| `../../scripts/verify-sandbox-inventory.sh`          | where the image exists | **drift** — the file claiming something the image does not have        |

A file that has drifted makes preflight lie, and a lying preflight is worse than none because
people stop checking it. Re-run the verify script whenever the sandbox Dockerfile changes.

## Provenance

The inventories live with the harness (moved from `deploy/knative/sandbox-inventory/` when the
Knative deployment path was removed, ADR-0041) because `resolveInventoryPath` walks up from the
harness module to find them — a promote preflight run from a user's project must never depend on
a deploy directory existing.

`ghcr.io_rossoctl_moca-remote-worker_latest.json` was generated from the real published image,
not curated by hand:

- Image: `ghcr.io/rossoctl/moca-remote-worker:latest`, the container-tier sandbox image the P6
  deployments run (`remote-worker/Dockerfile`).
- amd64 manifest digest: `sha256:5bf4d766d84a27d0f7bbefd81e87e5697b5ca2844bc781fe00eda0383146c7ee`
- 445 binaries
- Enumerated 2026-11-05 by pulling the image's layers from the registry and listing every
  executable under `/bin`, `/usr/bin`, `/usr/local/bin`, `/usr/sbin` and `/sbin`, following
  symlinks and whiteouts the way a container runtime would. `unix_update` (mode `0700 root`) was
  then dropped: the image runs as uid 1001, which cannot execute it, so `command -v` does not
  resolve it -- an inventory lists what the sandbox user can run, not what is on disk. `scripts/verify-sandbox-inventory.sh`
  remains the drift check against the live image.
