# MOCA

## Overview

Cloud-native runtime for AI agent sessions. Wraps the Pi AI framework with a P6
process-manager supervisor (warm worker pool, L4 socket hand-off), Redis-backed session
persistence, remote sandbox execution over a gRPC relay (container and per-`Exec` microVM
tiers), and budget-aware compaction checkpoints. The legacy Knative/KEDA deployment was
removed in November 2026 (ADR-0041).

## Repository Structure

```
moca/
├── harness/              # Core harness runtime (@moca/harness)
├── packages/
│   ├── k8s-sandbox/      # Sandbox transports over the gRPC relay (@moca/k8s-sandbox; name historical)
│   ├── knative-server/   # HTTP server + P6 worker entrypoints (@moca/knative-server; name historical — P6-load-bearing)
│   ├── session-backend/  # Redis session storage (@moca/session-backend)
│   ├── sandbox-relay/    # gRPC relay between control plane and remote-worker sandboxes (@moca/sandbox-relay)
│   ├── supervisor/       # P6 VM process manager / socket-handoff supervisor (@moca/supervisor)
│   ├── control-plane/    # Multi-user control plane, credential issuance (@moca/control-plane)
│   ├── config-bundle/    # Promoted config bundle loading (@moca/config-bundle)
│   ├── ibac-stub/        # IBAC stub (@moca/ibac-stub)
│   └── mocactl/          # MOCA terminal client for the control plane (@moca/mocactl)
├── remote-worker/        # Go module: container + microVM sandbox workers, vmpoolctl
├── deploy/
│   ├── k8s/              # P6 on Kubernetes/OpenShift (first-class, ADR-0037)
│   ├── vm/               # P6 single-VM systemd deployment
│   ├── microvm/          # P4 Firecracker microVM deployment
│   ├── compose/          # Docker Compose trial of the P6 runtime (no root, five minutes)
│   └── claude/           # Claude Code workflow-promotion tooling (the /promote command)
├── scripts/              # install-mocactl.sh: the one-line mocactl installer (curl | sh)
├── pi-fork/              # Git submodule: Pi AI framework (must be built)
└── Dockerfile            # Container image (node:24-alpine)
```

## Key Commands

| Task                | Command                                 |
| ------------------- | --------------------------------------- |
| Install deps        | `pnpm install`                          |
| Build pi-fork types | `cd pi-fork && npm ci && npm run build` |
| Lint                | `make lint`                             |
| Format              | `make fmt`                              |
| Test (all)          | `make test`                             |
| Typecheck           | `make typecheck`                        |
| Pre-commit install  | `pre-commit install`                    |

## Development Setup

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca

# Build pi-fork (required for type declarations)
cd pi-fork && npm ci && npm run build && cd ..

# Install workspace deps
pnpm install

# Install pre-commit hooks
pre-commit install
```

## Code Style

- TypeScript (strict mode), Node.js 22+
- pnpm 9+ workspace monorepo
- Prettier for formatting (see .prettierrc)
- Shellcheck for shell scripts in deploy/
- Pre-commit hooks enforce lint on commit
- DCO sign-off required: `git commit -s`

## Testing

- vitest 2.x for all test suites
- Redis required for session-backend and knative-server workload tests
- Live smoke tests gated by env vars (M3_LIVE_SMOKE, etc.)

## Context Budget

Redirect long command output to files — never pollute conversation context:

```bash
export LOG_DIR=/tmp/kagenti/tdd/moca
mkdir -p $LOG_DIR
command > $LOG_DIR/name.log 2>&1; echo "EXIT:$?"
```

## DCO Sign-Off

All commits require sign-off:

```bash
git commit -s -m "feat: description"
```

## Commit Attribution

Use `Assisted-By` (not `Co-Authored-By`) for AI attribution:

    Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>

Never add `Co-authored-by`, `Made-with`, or similar trailers that GitHub parses as
co-authorship. A `commit-msg` hook in `scripts/hooks/commit-msg` enforces this
automatically (it rewrites AI co-author trailers to `Assisted-By`); the standard
`pre-commit install` sets it up via `default_install_hook_types` in
`.pre-commit-config.yaml`.

## PR Description Attribution

In PR descriptions, summaries, and any PR metadata, acknowledge AI assistance with a
single `Assisted-By: Claude Code` line — never `Generated with Claude Code`,
`Created with Claude Code`, or the 🤖 footer line. The work is the developer's;
Claude Code assists. The same rule applies to auto-generated changelogs and release
notes. A CI check (`.github/workflows/pr-attribution.yml`) rejects PR bodies that
contain the prohibited footers.
