# Optional: build the worker as an in-cluster pod image.
# Build from the REPO ROOT so the proto stubs (../gen/go, referenced via a
# `replace` in go.mod) are in the build context:
#
#   docker build -f remote-worker/Dockerfile -t quay.io/aslomnet/remote-worker:dev .
#
# Then set that image in ../deploy/knative/worker-example.yaml with
# RELAY_ADDR=sandbox-relay.default.svc:8443 (no port-forward needed in-cluster).
FROM golang:1.26-alpine AS build
WORKDIR /src
# go.work first: it is what lets the two modules be bumped independently (see #212).
# Without it the build here resolves each go.mod on its own and fails on a stale one.
COPY go.work ./
COPY gen/go/ ./gen/go/
COPY remote-worker/ ./remote-worker/
WORKDIR /src/remote-worker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/remote-worker ./cmd/worker

# ripgrep is vendored because it is the IMPLEMENTATION of two registered tools, not a scheduling
# label. The Find/Glob tool runs `rg --files --hidden` (k8s-sandbox operations.ts's glob) and the
# Grep tool runs `rg` directly (`createPodGrepTool`), and both land in THIS container whenever a
# leased gRPC presence record supplies a relay transport: extension.ts's `opts?.transport ??`
# overrides the fast AND the stream transport, so every pod operation runs over the relay. Without
# `rg` on PATH the model's Glob returns "glob failed in pod (rg exited 127)" and its Grep "rg failed
# in pod (exit 127)" -- the same attached-and-healthy-yet-every-tool-fails signature as the
# /workspace bug below. Both other sandbox images in the repo install it (sandbox.Dockerfile,
# k8s-sandbox/deploy/sandbox.yaml).
#
# It is genuinely not in the UBI 9 repositories (verified: `microdnf install ripgrep` -> "No package
# matches"), and EPEL would add a third-party repository to an image that executes model-authored
# commands. So: the upstream static musl build, pinned by version and checked against the sha256 the
# release publishes. Static, so it needs no libc from this base. Fetched in its own stage, so the
# tar/gzip needed to unpack it never reach the runtime image.
#
# The version is not free to choose. `createPodFindOps`.glob leans on two documented .gitignore
# nuances -- gitignored DIRECTORIES stay pruned even when `-g` matches inside them, while an
# individually-gitignored FILE matching a positive `-g` IS re-included -- and those were originally
# characterised on rg 14.1.0, the version alpine:3.20 ships and therefore the one both other sandbox
# images and the k8s-sandbox SMOKE.md run used. 15.2.0 crosses a major boundary, so if it diverged
# there, Glob's ignore semantics would differ by which sandbox image an operator happened to build --
# silently, and only for gitignored paths. Both nuances were re-verified against these exact pinned
# tarballs, on both arches, before pinning: they hold unchanged. operations.ts and the M3 spec's D5
# note record that.
#
# Pinning back to 14.1.0 instead is NOT available: that release publishes no
# aarch64-unknown-linux-musl asset (only -gnu), so it would either break the arm64 build or give up
# the static property this stage exists for.
#
# To bump: change RG_VERSION and BOTH digests together, AND re-check those two nuances on the new
# version. The digests are per-arch and `sha256sum -c` fails the build closed if either is wrong.
# Arch comes from `uname -m` rather than TARGETARCH because buildah / `oc new-build
# --strategy=docker` do not populate BuildKit's automatic args.
# hadolint ignore=DL3007
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest AS rg
ARG RG_VERSION=15.2.0
ARG RG_SHA256_X86_64=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c
ARG RG_SHA256_AARCH64=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915
# hadolint ignore=DL3041
RUN microdnf install -y --nodocs tar gzip \
    && microdnf clean all
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  target=x86_64-unknown-linux-musl;  sha="$RG_SHA256_X86_64" ;; \
      aarch64) target=aarch64-unknown-linux-musl; sha="$RG_SHA256_AARCH64" ;; \
      *) echo "no pinned ripgrep build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    tarball="ripgrep-${RG_VERSION}-${target}.tar.gz"; \
    curl -fsSL -o "/tmp/${tarball}" \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${tarball}"; \
    printf '%s  %s\n' "${sha}" "/tmp/${tarball}" > /tmp/rg.sha256; \
    sha256sum -c /tmp/rg.sha256; \
    tar -xzf "/tmp/${tarball}" -C /tmp; \
    install -m 755 "/tmp/ripgrep-${RG_VERSION}-${target}/rg" /usr/local/bin/rg; \
    rm -rf "/tmp/${tarball}" /tmp/rg.sha256 "/tmp/ripgrep-${RG_VERSION}-${target}"; \
    /usr/local/bin/rg --version

# gh (the GitHub CLI) is vendored for the same reason as rg: docs/sbx/user-guide.md promises `gh`
# works in a sandbox (`gh pr create` under the sbx credentials feature), it is not in the UBI 9
# repositories, and adding GitHub's own dnf repo would put a third-party repository into an image
# that executes model-authored commands. Upstream release tarball, pinned by version and checked
# against the sha256 the release publishes (gh_<version>_checksums.txt). The upstream binary is
# a static, CGO-free Go build, so it needs nothing from ubi-minimal's libc; the `gh --version`
# at the end of the RUN still fails the build closed if a release ever ships a binary that does
# not run on the built arch.
#
# To bump: change GH_VERSION and BOTH digests together, taking the new values from the release's
# checksums file. Arch comes from `uname -m` for the same reason as the rg stage.
# hadolint ignore=DL3007
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest AS gh
ARG GH_VERSION=2.103.3
ARG GH_SHA256_X86_64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_SHA256_AARCH64=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
# hadolint ignore=DL3041
RUN microdnf install -y --nodocs tar gzip \
    && microdnf clean all
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  distro=linux_amd64;  sha="$GH_SHA256_X86_64" ;; \
      aarch64) distro=linux_arm64;  sha="$GH_SHA256_AARCH64" ;; \
      *) echo "no pinned gh build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    tarball="gh_${GH_VERSION}_${distro}.tar.gz"; \
    curl -fsSL -o "/tmp/${tarball}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${tarball}"; \
    printf '%s  %s\n' "${sha}" "/tmp/${tarball}" > /tmp/gh.sha256; \
    sha256sum -c /tmp/gh.sha256; \
    tar -xzf "/tmp/${tarball}" -C /tmp; \
    install -m 755 "/tmp/gh_${GH_VERSION}_${distro}/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${tarball}" /tmp/gh.sha256 "/tmp/gh_${GH_VERSION}_${distro}"; \
    /usr/local/bin/gh --version

# The worker execs `bash -c <command>`, so the runtime image needs a shell and the
# coreutils the harness's ops call: base64 (writeFile), file (image mime sniffing).
# distroless/static ships none of them — every exec would fail with ENOENT.
# In production the binary drops into a real sandbox image instead; this stage
# exists so the standalone demo image works on its own.
#
# These are standalone demo images that track the current UBI 9 minor; a pinned
# digest would go stale silently, and microdnf package pinning breaks on minor
# bumps for the same reason .hadolint.yaml already ignores DL3018 for Alpine.
# hadolint ignore=DL3007
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest
# git, python3 and gh are here because cmd/worker/main.go's `probed` list advertises
#   bash, rg, base64, file, python3, git, gh
# as this worker's Hello.capabilities, and its comment says "the pool will eventually match on
# these, so they must be true". Three of the original six were not: on a real VM the leaf reported
# `caps=[bash base64 file]`, so it advertised a set it could not honour. All seven are now installed
# (`rg` and `gh` from the stages above), and dockerfile_parity_test.go fails if that stops being true.
#
# git also matters for measurement. Spec §2.3's duty bases were derived from workloads whose git
# operations cost ~470ms; without git in the sandbox, an E8 tool call can only be a ~0ms no-op, so
# the hands tier is exercised structurally but carries no load and the measured duty cycle describes
# a cheaper workload than the basis it is compared against.
#
# curl-minimal and ca-certificates are here for the sandbox research turn (#368): the agent's bash
# tool fetches live pages with `curl -o` and clones over HTTPS with git, and both need the CA bundle.
# ubi-minimal already ships both (verified 2026-09-30: curl-minimal-7.76.1, ca-certificates-2025.2.80),
# so this adds no bytes to the image; it turns an inheritance into a guarantee. It is curl-MINIMAL
# because the full `curl` package conflicts with it on UBI 9, and -minimal speaks HTTP(S), which is
# all the research turn needs. curl is NOT in `probed`: it is not an advertised capability.
#
# tar, gzip and util-linux-core (flock) are what the promoted-config overlay runs in this sandbox
# (harness/src/config-overlay.ts: `base64 -d | tar -x -z` under `flock`). tar was absent, so every
# turn of a session started with a config bundle failed "config overlay failed (exit 127)"
# (ADR-0038); gzip and util-linux-core were inherited from the base and are listed so they stay.
# The workload context overlay (harness/src/context-overlay.ts) needs the same three.
# hadolint ignore=DL3041
RUN microdnf install -y --nodocs bash coreutils-single findutils file git python3 curl-minimal ca-certificates tar gzip util-linux-core \
    && microdnf clean all
COPY --from=build /out/remote-worker /usr/local/bin/remote-worker
COPY --from=rg /usr/local/bin/rg /usr/local/bin/rg
COPY --from=gh /usr/local/bin/gh /usr/local/bin/gh
# The harness execs every tool call from its sandbox working directory, which defaults to
# /workspace (KAGENTI_SANDBOX_CWD, select-sandbox.ts). Without this directory the worker's
# `bash -c` fails before running anything the caller asked for:
#   bash: line 1: cd: /workspace: No such file or directory
#   Command exited with code 1
# and the harness reports a tool error for a sandbox that is otherwise healthy and attached --
# observed on a real VM run, where the exec reached the leaf correctly and died on the cd. Owned by
# 1001:0 because that is the uid this image runs as (gid 0, matching the nonroot-v2 SCC below), so
# the agent can actually write in its own workspace. One `install -d` states owner, group and mode in
# one place, as build-swebench-sandbox.sh's generated Dockerfile already does.
#
# WORKDIR because BashRunner's "every command the harness sends is self-contained (`cd 'cwd' &&
# ...`)" is today the only thing making the process cwd irrelevant. Any exec path that ever sends a
# bare command -- or an operator running `podman exec` to debug a sandbox -- would otherwise land in
# /, which is a second round of the bug documented directly above. Both sandbox images that came
# before this one set it.
RUN install -d -o 1001 -g 0 -m 775 /workspace
WORKDIR /workspace
# HOME is set explicitly because uid 1001 has no passwd entry, and what a runtime then picks differs:
# podman uses the WORKDIR (so dotfiles land in the shared /workspace, where Glob/Grep's
# `rg --hidden` walks them), Docker and containerd use / (unwritable, so `git config --global` fails).
# A dedicated directory, created exactly like /workspace so any gid-0 uid under nonroot-v2 can write
# it, rather than a passwd entry that names one fixed uid (#368).
RUN install -d -o 1001 -g 0 -m 775 /home/sandbox
ENV HOME=/home/sandbox
# #415: a SYSTEM gitconfig, not a user one. Without any identity, an agent's first
# `git commit` dies with exit 128 ("Please tell me who you are") -- observed live on the
# VM demo (docs/demos/vm-multi-user-demo.md, fix list 5) and on the P4 tier, whose rootfs
# is exported from this image by deploy/microvm/build-rootfs.sh. /etc/gitconfig is the
# one place that applies to ANY uid, including the arbitrary gid-0 uid under nonroot-v2
# that #372's writable HOME prepares but cannot pre-configure, and a user's or agent's
# own higher-precedence config still overrides both fields, so this is a floor, not a
# ceiling. printf writes the file directly -- `git config` would work too but drags the
# whole git machinery in just to emit two lines.
RUN printf '[user]\n\tname = MOCA sandbox\n\temail = sandbox@moca.invalid\n' > /etc/gitconfig
# Matches the nonroot-v2 SCC deploy-incluster.sh applies.
USER 1001
ENTRYPOINT ["/usr/local/bin/remote-worker"]
