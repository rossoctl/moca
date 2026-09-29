# MOCA

## Overview

Cloud-native serverless runtime for AI agent sessions. Wraps the Pi AI framework
with Knative Serving, Redis-backed session persistence, K8s sandbox execution,
and budget-aware compaction checkpoints.

## Repository Structure

```
moca/
├── harness/              # Core harness runtime (@moca/harness)
├── packages/
│   ├── k8s-sandbox/      # K8s pod exec client (@moca/k8s-sandbox)
│   ├── knative-server/   # Knative HTTP entrypoint (@moca/knative-server)
│   ├── session-backend/  # Redis session storage (@moca/session-backend)
│   ├── mocactl/          # MOCA terminal client for the control plane (@moca/mocactl)
│   └── work-queue/       # Redis Streams work queue (@moca/work-queue)
├── deploy/knative/       # Deployment scripts and smoke tests (experiment drivers moved to
│                         # rossoctl/moca-experiments, 2026-09-25)
├── pi-fork/              # Git submodule: Pi AI framework (must be built)
└── Dockerfile            # Container image (node:22-alpine)
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
- Redis required for work-queue and session-backend tests
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
