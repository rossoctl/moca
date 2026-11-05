# Promoting a local Claude Code workflow

> **Preview.** Workflow promotion is implemented but not yet declared Stable; interfaces and limits
> may change. Design: [ADR-0038](../adrs/0038-mocactl-config-bundle-promotion.md) and the
> [promotion spec](../specs/2026-10-06-mocactl-config-bundle-promotion-design.md); the bundle format is
> [ADR-0030](../adrs/0030-claude-code-workflow-promotion.md).

Promotion packages the skills and commands you iterated on locally in Claude Code into a
content-addressed **config bundle**, uploads it through the multi-user control plane, and starts a
session that runs with those skills. You need no cluster credentials: `mocactl` talks only to the
control plane's `/v1` API.

## Before you start

- `mocactl` installed and logged in to a control plane (`mocactl login`; install steps in
  [Get started](../get-started/index.md)).
- A directory with a `.claude/skills` and/or `.claude/commands` tree. `mocactl promote DIR` uploads
  those two trees; this guide covers only what [`mocactl`'s README](../../packages/mocactl/README.md)
  documents.
- Upgrade the harness before the control plane. An older harness ignores the bundle reference, so
  turns would run without the skills and report no error.

## Headless

```bash
mocactl promote DIR --dry-run     # build and print what would be uploaded; needs no login
mocactl promote DIR               # print the preflight report, upload, print the bundle digest
mocactl run "prompt" --config DIGEST   # start a new session on that bundle
```

`promote` prints what it built and the preflight report (warnings go to stderr) **before**
uploading, then the digest to pass to `run --config`. The same credential scan as ADR-0030 runs on
your machine before anything leaves it. `--json` gives machine-readable output.

Exit codes for `promote`:

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Uploaded (or built, with `--dry-run`)                                  |
| `2`  | Refused before upload: usage error, not logged in, or preflight errors |
| `3`  | A structural credential match in the bundle; nothing was uploaded      |
| `1`  | Anything else                                                          |

## In the TUI

Inside `mocactl`, `/promote DIR` builds and uploads the bundle and **attaches it to the next session
you create**; a toast counts skills, commands and warnings. With exactly one inference credential
and no presets, the new-session overlay creates the session as soon as it opens, so `/promote DIR`
starts the session right away.

## What to know

- **A session's bundle is fixed when it is created.** `--config` cannot be combined with
  `--session`, and the client never sends the bundle reference to the harness, so it cannot change
  mid-session. To use a different bundle, start a new session.
- **A missing or expired bundle fails the turn** (`410 config_bundle_not_found`); the turn never
  runs without its skills.
- **Budget.** Stored bundles count against a per-account and a deployment-wide byte budget; the
  upload fails with `429` when full. `mocactl bundles delete DIGEST` deletes a bundle you promoted
  and frees its share (an admin may delete anyone's). Sessions created on a deleted bundle fail
  their next turn as for an expired one.
- **A digest is a bearer capability.** Bundles are not owned records; preflight keeps them
  secret-free (ADR-0038, Consequences).

## Dispatching a promoted run from an orchestrator

A batch leaf can use the same bundle by adding one field to a prompt leaf:

```json
{ "sessionId": "run-1/item-1", "kind": "prompt", "prompt": "…", "configRef": "sha256:…" }
```

Memory in a promoted run is read-only
([ADR-0031](../adrs/0031-promoted-memory-read-only.md)). MCP servers and subagents are not promoted;
see the [original design](../specs/2026-09-02-claude-code-workflow-promotion-design.md) §2, §9.

## The older harness-side path

Before ADR-0038 the only uploader was a Claude Code slash command
([`deploy/claude/commands/promote.md`](../../deploy/claude/commands/promote.md)) that runs
`pnpm --dir <harness> promote` and writes straight to Redis over a tunnel you hold open. It needs
cluster access, so it does not fit a multi-user control plane, and this guide does not cover it. The
command and CLI remain in the repository. How they work is documented in
[`deploy/claude/commands/promote.md`](../../deploy/claude/commands/promote.md);
ADR-0030 only mentions the slash command.
