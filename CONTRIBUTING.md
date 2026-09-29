# Contributing

## Development Setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- Redis (for work-queue tests)
- Docker (for container builds, and for the hadolint pre-commit hook)
- [pre-commit](https://pre-commit.com/#install) (git hooks)

### Getting Started

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca

# Build pi-fork type declarations
cd pi-fork && npm ci && npm run build && cd ..

# Install workspace dependencies
pnpm install

# Install the git hooks (formatting, shellcheck, secret scanning)
pre-commit install

# Run tests
pnpm -r test

# Typecheck
cd harness && pnpm exec tsc --noEmit
```

`pre-commit install` is not optional in practice: the same hooks run in CI as the `lint`
job, so skipping it just moves the failure later. Run them over the whole tree at any time
with `make lint`, and format without linting with `make fmt`. Both drive the single Prettier
version pinned in the root `package.json`, so local and CI formatting cannot diverge.

### Workspace Structure

```
moca/
├── harness/              # Core harness (@moca/harness)
├── packages/
│   ├── k8s-sandbox/      # K8s sandbox client (@moca/k8s-sandbox)
│   ├── knative-server/   # Knative HTTP server (@moca/knative-server)
│   ├── session-backend/  # Redis session backend (@moca/session-backend)
│   └── work-queue/       # Redis work queue (@moca/work-queue)
├── deploy/knative/       # Deployment scripts and smoke tests (experiment drivers moved to
│                         # rossoctl/moca-experiments, 2026-09-25)
├── pi-fork/              # Submodule: Pi AI framework
└── Dockerfile            # Container build
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes with tests
4. Ensure `pnpm -r test` passes
5. Ensure `tsc --noEmit` passes in all packages with tsconfigs
6. Ensure `make lint` passes (or commit with the hooks installed, which is equivalent)
7. Submit a pull request

### CI Checks

All PRs must pass:

- **Typecheck**: `tsc --noEmit` across harness, k8s-sandbox, knative-server
- **Tests**: `pnpm -r test` (requires Redis for work-queue)
- **Lint**: `make lint` -- every pre-commit hook over all files (Prettier, shellcheck,
  hadolint, gitleaks, YAML and whitespace checks)
- **DCO**: All commits must be signed off

## Commit Messages

Use conventional commit format:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `ci:` CI/CD changes
- `chore:` Maintenance tasks
- `test:` Test additions or fixes

All commits must include DCO sign-off:

```bash
git commit -s -m "feat: Add new feature"
```

## Code of Conduct

This project follows the [Kagenti Code of Conduct](https://github.com/kagenti/kagenti/blob/main/CODE_OF_CONDUCT.md).
