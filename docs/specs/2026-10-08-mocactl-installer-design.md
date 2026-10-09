# `mocactl` one-line install — a bundled release asset and a `curl | sh` installer — Design

**Date:** 2026-10-08 · **Status:** Implemented · **Issue:** none yet
**Builds on (reuse, no redesign):** [ADR-0036](../adrs/0036-tui-decoupled-http-client.md) /
[mocactl-control-plane-client-design](2026-09-25-mocactl-control-plane-client-design.md) (`mocactl`
is a standalone HTTP client that needs one URL); the `curl | sh` conventions of
`deploy/compose/install.sh` (#342) and its mocked-`PATH` test, `deploy/compose/tests/install.test.sh`.

## 1. Problem

A user with nothing but a cluster URL should type one line, then `mocactl`.

Today (`rossoctl/main` @ `4482def`):

- The only way to run `mocactl` is from a checkout: `pnpm install`, then
  `alias mocactl="node $PWD/packages/mocactl/bin/mocactl.mjs"` (`packages/mocactl/QUICKSTART.md` §4).
- `bin/mocactl.mjs` registers the `tsx` loader and runs `src/main.ts`, so it needs the whole
  workspace's `node_modules` and the package's `tsconfig.json` beside it.
- `v*` releases are cut by hand and carry no assets; `build.yaml` publishes container images only.
- `mocactl` has no `--version`, so a user cannot say which build they are running.

### Acceptance

1. On a macOS or Linux machine with Node 22 and no checkout,
   `curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh`
   leaves a `mocactl` that runs by name (given its directory is on `PATH`).
2. `MOCACTL_VERSION=edge` installs the build of the current `main`; `MOCACTL_VERSION=vX.Y.Z` installs
   that release; the default is the latest release.
3. A download whose SHA-256 does not match installs nothing.
4. Re-running the installer upgrades in place.
5. `mocactl --version` names the installed build.

## 2. Decision summary

- **One artifact for every OS and architecture:** `mocactl.mjs`, an esbuild bundle of the package and
  every runtime dependency, run by the user's own Node 22. Standalone, Node-free binaries are a
  follow-up (§8); the installer's interface does not change when they land.
- **Two channels.** Each published `v*` release gets `mocactl.mjs` and `mocactl.mjs.sha256` attached.
  A rolling **prerelease** `mocactl-edge` carries the same pair, rebuilt on every push to `main`.
  Being a prerelease, it never becomes "Latest", so `releases/latest/download/…` stays stable.
- **The installer** is POSIX `sh` at `scripts/install-mocactl.sh`, written to the conventions of
  `deploy/compose/install.sh`. It verifies the checksum, installs to `~/.local/bin`, and never edits a
  shell rc file.

## 3. Alternatives considered

| Option                                            | Why not (now)                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone binaries (`bun --compile`, Node SEA)   | Four OS/arch builds of 60–100 MB each, and ad-hoc code signing on macOS arm64. Worth it, but later (§8): the bundle unblocks users today.                                     |
| Publish `@moca/mocactl` to npm                    | Needs an npm org and publishing credentials, and `@moca/config-bundle` would have to be published or inlined anyway. `npm i -g` also lands in a Node-version-specific prefix. |
| Installer clones the repo and runs `pnpm install` | Needs git and pnpm, pulls the whole monorepo and its submodule, and still needs an alias or wrapper.                                                                          |
| Edge as the default channel                       | Every `main` commit would reach every new install. Edge stays opt-in.                                                                                                         |

## 4. The bundle

`packages/mocactl/build.mjs` (run by a new `build` script, `pnpm --filter @moca/mocactl build`):

- esbuild, `entryPoints: ['src/main.ts']`, `bundle`, `format: 'esm'`, `platform: 'node'`,
  `target: 'node22'`, `jsx: 'automatic'`, output `dist/mocactl.mjs`, banner `#!/usr/bin/env node`
  plus a `createRequire` shim so bundled CommonJS can still `require` Node built-ins.
- `esbuild` becomes an explicit devDependency of `@moca/mocactl`; it is already in the lockfile.
- `define: { MOCACTL_VERSION: JSON.stringify(version) }`. The version comes from `MOCACTL_VERSION` in
  the build's environment (CI sets it, §5). Otherwise it is `dev`. Under `tsx` (the checkout path),
  `src/version.ts` falls back to `dev` when the constant is undefined.
- Ink's optional `react-devtools-core` import is aliased to an empty module. It is loaded only when
  `DEV=true`, and bundling it would pull in a large dependency for nothing.
- `clipboardy` is bundled. On macOS it calls `pbcopy`. On Linux it calls `wl-copy`/`xsel` from the
  system first; its own fallback `xsel` binary, resolved relative to its package directory, does not
  exist in the bundle. The copy path in `os.ts` already throws on failure and the TUI reports it, so
  the bundle's only change is to that fallback. The build test (§7) checks that a failing copy is
  still reported, not fatal.
- `main.ts`'s lazy `import('./start.js')` stays lazy: without code splitting, esbuild wraps the module
  in a deferred initialiser, so headless commands still never evaluate Ink or React.
- `dist/` is git-ignored. `bin/mocactl.mjs` (the tsx path) is unchanged and stays the from-source route.

`mocactl --version` (also `-V`): `cli.ts` prints the version and exits 0 before any config is
read or network touched. `USAGE` gains the line.

## 5. CI: `.github/workflows/mocactl-release.yml`

Triggers: `release: { types: [published] }` and `push: { branches: [main] }`. Actions are pinned
by SHA, as in the other workflows. The workflow's token is `contents: read`. Only `publish` gets
`contents: write`, and it runs nothing from the repository or its dependencies: a dependency's
install script or test code runs in `build`, where it can at worst spoil that job's output, never
push a tag or edit a release.

**`build`** (`contents: read`; checkout with `persist-credentials: false`):

1. Checkout (no submodules: `mocactl` uses nothing from pi-fork), pnpm, Node 22,
   `pnpm install --frozen-lockfile --filter '@moca/mocactl...'`.
2. `MOCACTL_VERSION` = the release tag on `release`, otherwise `edge-<short sha>`. Build, then run
   `test/bundle.test.ts` against this build.
3. **Smoke, away from the workspace:** copy `dist/mocactl.mjs` to a temp dir and run `--version`
   (must print exactly `MOCACTL_VERSION`) and `--help` from there with `NODE_PATH` unset. A
   dependency left unbundled fails here, not on a user's machine.
4. `sha256sum mocactl.mjs > mocactl.mjs.sha256`, in the `sha256sum` format the installer verifies.
   Both files are uploaded as the `mocactl-asset` workflow artifact.

**`publish`** (`contents: write`; no checkout, no pnpm, only `gh`), after downloading the artifact:

- `release`: `gh release upload "$TAG" mocactl.mjs mocactl.mjs.sha256 --clobber`.
- `push`: move the `mocactl-edge` tag to `$GITHUB_SHA` through the git refs API (create it if it is
  missing), create the `mocactl-edge` release as `--prerelease` if it is missing, then
  `gh release upload mocactl-edge … --clobber`. The release notes name the commit.

Concurrency group `mocactl-release-${{ github.ref }}`, with `cancel-in-progress` on the edge channel
only: an older `main` build must never overwrite a newer one, but a release upload is never cancelled.

## 6. The installer: `scripts/install-mocactl.sh`

```sh
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
```

POSIX `sh`, not bash, for the same reason as `deploy/compose/install.sh`: it is piped into whatever
`sh` the machine has. It uses the same `log`/`die` helpers and the same header style that documents
every environment variable.

Environment (all optional):

| Variable              | Default                                     | Meaning                                             |
| --------------------- | ------------------------------------------- | --------------------------------------------------- |
| `MOCACTL_VERSION`     | `latest`                                    | `latest`, `edge`, or a release tag such as `v0.6.0` |
| `MOCACTL_INSTALL_DIR` | `$HOME/.local/bin`                          | Where `mocactl` is written                          |
| `MOCACTL_BASE_URL`    | `https://github.com/rossoctl/moca/releases` | Release host, for tests and mirrors (https only)    |

Steps:

1. **Preflight.** Needs `curl`. Needs `node`, with a major version of 22 or more from
   `node -p 'process.versions.node'`. Otherwise it dies naming the version found and pointing to
   <https://nodejs.org>. Needs `sha256sum` or `shasum`.
2. **Resolve the URL.** `latest` → `$BASE/latest/download/mocactl.mjs`; `edge` →
   `$BASE/download/mocactl-edge/mocactl.mjs`; a tag → `$BASE/download/$TAG/mocactl.mjs`. A tag not
   matching `^v[0-9]` and not `latest` or `edge` is refused before any download.
3. **Download** both files, over https only (`curl --proto '=https'`, which bounds redirects too), into a `mktemp -d` directory, removed by an `EXIT` trap. A 404 dies naming
   the version, with a hint that fits the channel. For `latest`, the newest release may predate this
   workflow, so the hint is `MOCACTL_VERSION=edge`. For edge, the prerelease may be mid-update. For a
   tag, the release may predate the asset.
4. **Verify.** Compare the first field of `mocactl.mjs.sha256` with the local digest. On mismatch it
   dies and nothing is installed.
5. **Install.** `mkdir -p` the directory, copy to `mocactl.mjs.tmp`, `chmod 755`, then `mv` it over
   `mocactl.mjs`. Then `mocactl` is made a relative symlink to `mocactl.mjs`, the same way: link to
   `mocactl.tmp`, then `mv`. The bundle must keep its `.mjs` name, because Node takes a main script's
   module type from its real path. An extensionless copy loads as CommonJS on Node 22.0–22.6, or under
   a `"type": "commonjs"` `package.json` above it, and prints nothing. Each rename is atomic, so a
   running `mocactl` is never half-overwritten and a re-run upgrades in place.
6. **Report.** Print `"$dir/mocactl" --version`. Empty output fails the install. If `$dir` is not on `PATH`, print the exact
   `export PATH="$dir:$PATH"` line and the rc file it usually goes in, without editing anything. Then
   print the next step: `export SH_CONTROL_PLANE_URL=<your cluster URL>` and `mocactl`.

Uninstall is `rm ~/.local/bin/mocactl ~/.local/bin/mocactl.mjs` plus, if wanted, `~/.config/mocactl`. It is documented, not
scripted.

## 7. Testing

- **`scripts/tests/install-mocactl.test.sh`**, using the method of `deploy/compose/tests/install.test.sh`:
  `PATH` limited to a shim dir, with mocks for `curl` (serving fixture files by URL) and `node`
  (reporting a configurable version). It runs the script under `sh` from a pipe. Cases:
  - the default, edge and pinned-tag URLs;
  - an invalid tag is refused;
  - a checksum mismatch leaves no `mocactl` and no temp file;
  - Node 20 and missing Node both die with the documented message;
  - `curl` returning 404 dies naming the version;
  - an install dir off `PATH` prints the hint;
  - a re-run replaces the file.
- **`Makefile` `test-deploy`** gains `scripts/tests/*.test.sh`. **`security-scans.yml`'s shellcheck**
  step gains `scripts/` beside `deploy/` (the pre-commit hook already matches every `*.sh`).
- **vitest (`packages/mocactl/test/cli.test.ts`):** `--version` and `-V` print the version, exit 0, and
  touch neither config nor network.
- **`packages/mocactl/test/bundle.test.ts`:** builds the bundle into a temp dir, then runs
  `node <bundle> --version` and `--help` from outside the workspace. It is the same check as CI step
  3, so a broken bundle fails `make test` locally too.

## 8. Scope: explicitly not building

- Node-free standalone binaries. This is the follow-up: per-OS/arch assets with
  `mocactl-<os>-<arch>` names. The installer then prefers a binary for `uname -s`/`uname -m` and falls
  back to `mocactl.mjs` when Node 22 is present.
- Windows.
- A `mocactl upgrade` subcommand; re-running the installer is the upgrade.
- Editing shell rc files or installing Node.
- Signing beyond the SHA-256 published beside the asset over the same HTTPS origin. This catches
  corrupt or truncated downloads, not a compromised release; Sigstore/cosign provenance can be added
  with the binaries.

## 9. Docs

- `packages/mocactl/README.md` and `QUICKSTART.md` §4 lead with the one-liner and
  `export SH_CONTROL_PLANE_URL=…`; the alias is removed. "From a checkout"
  (`node packages/mocactl/bin/mocactl.mjs`) stays as the contributor path.
- The `deploy/compose/install.sh` closing message, which tells the user how to run `mocactl`, points
  at the one-liner.
