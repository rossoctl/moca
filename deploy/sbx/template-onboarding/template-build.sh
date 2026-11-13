#!/usr/bin/env bash
# deploy/sbx/template-onboarding/template-build.sh -- on the KVM host, turn a container image into an SBX0 template's
# golden snapshot, checked in a microVM before it is published, and its template record (RUNBOOK §5).
#
#   sudo deploy/sbx/template-onboarding/template-build.sh SPEC --kernel PATH [--agent DIR] [--vmm firecracker]
#                                     [--registry HOST] [--egress-ca PATH] [--gate-record FILE [--gate-commit SHA]]
#                                     [--keep-image] [--force]
#
# The rule ids below (M3, X1, X5, X10, X12, X16) are governance/GATING-RULES.md's.
#
# --gate-record FILE is the image's gate record from its builder (a family record such as
# `<builder>/<family>/1`; governance/GATING-RULES.md §3). The build refuses unless the record's
# gate passed (X1), its image digest is the spec's, and the spec's `source_record_digest` is that
# digest (X10); for a spec that skips the git identity check, the record must show commits refused
# (X5, X12). The template record then carries `gate_record`: the evidence, the record's sha256 and,
# with --gate-commit, the builder's commit that holds it, so the chain can be checked offline.
# A spec that names a `source_record_digest` must be built with its gate record.
#
# --egress-ca PATH bakes the KVM host's TLS-interception CA (the public certificate, from
# `install-host.sh --egress-ca-out`) into the snapshot, for a template whose sandboxes use egress
# credentials (RUNBOOK, guest egress). Only for a spec with egress true. The record keeps its
# fingerprint (egress_ca_sha256), and a snapshot built with another CA, or none, is rebuilt.
#
# --registry HOST pulls a spec image that names no registry (`team/image@sha256:...`, as image
# builders write them so that no registry host is committed) from HOST. An image that names one
# (its first part has a dot or a colon, or is localhost) is pulled as it is. The host is used for
# the pull only: build-rootfs.sh --source-name records the spec's own reference in the guest, and
# the template record keeps it too, so neither names the registry host (X16).
#
# SPEC is a template spec, JSON (schema moca-sbx-template-spec/1):
#   id                       the template id clients ask for, ^[a-z0-9][a-z0-9-]{0,30}$
#   image                    the container image, pinned: repository@sha256:<64 hex>
#   guest_ram_mb, vcpus      the guest's size (build-snapshot.sh --guest-ram-mb, --vcpus)
#   guest_home               optional, a writable HOME under /tmp (build-snapshot.sh --guest-home)
#   skip_git_identity_check  optional, true for an image that refuses agent commits on purpose
#   guest_home_gitconfig     optional, true: copy the image's /root/.gitconfig into guest_home (an
#                            identity set in the image applies). Refused with skip_git_identity_check:
#                            an image that refuses commits must not get its root identity
#   egress                   true or false: whether the worker gets guest egress (false: --no-egress,
#                            no network at all, e.g. a benchmark whose upstream fix must stay out of
#                            reach)
#   seed                     a bash command that fills a new sandbox's empty /workspace ("" for none).
#                            SBX0 does not run it: the client runs it as its first command
#   probe                    {cmd, timeout_s, expect_rc, expect}: a bash command run after the seed,
#                            in /workspace; it passes when it exits expect_rc and its output matches
#                            every extended regex in expect
#   description, tools       the template's entry, as clients see it (GET /v1/templates)
#   etc_hosts_sha256         optional: the sha256 the image's /etc/hosts must have in the rootfs (an
#                            image builder's own check; a mismatch stops the build)
#   source_record_digest     optional: the digest of the image's gate record (X10; --gate-record)
#   probe_status             optional: how the probe's expectation was measured; `unmeasured` or
#                            `none` is refused, since such a probe cannot be checked
#
# The probe's command and counts must be ones that may be shared: for a benchmark, a public test
# target, never the tests that grade a fix (their counts would be answer-key material).
#
# What it does, each step failing the whole build:
#   1. checks the spec, and that $SBX_SRV has SBX_MIN_FREE_GB free (default 50: a snapshot holds the
#      guest's whole RAM and its rootfs, and the rootfs tree and the image are on top while it builds);
#   2. pulls the image by digest and checks the digest it got;
#   3. deploy/microvm/build-rootfs.sh (then, with etc_hosts_sha256, that check on the tree), then
#      deploy/microvm/build-snapshot.sh with the spec's flags and
#      --verify-command: the seed and the probe, run in the restored VM. A probe that fails publishes
#      nothing;
#   4. writes the template record, $SBX_SRV/templates/<snapshot>.json (schema moca-sbx-template/1): the
#      spec plus the snapshot, its worker id and its manifest hash. deploy/sbx/template-onboarding/template-register.sh
#      reads it on the operator's machine; a client may read the seed from it;
#   5. removes the rootfs tree and (unless --keep-image) the pulled image.
#
# Names: the snapshot is <id>-<first 12 hex of the image digest>, and its worker id is
# sbx_<id with - as _>_<the same 12 hex>, so a new image of a template is a new snapshot and a new
# worker, and the old worker keeps serving until it is retired. A snapshot that already exists with the same record is not
# rebuilt: the same spec, CA, --vmm and --kernel (its sha256 in the manifest). --force rebuilds it,
# and is needed after a change to the guest agent's source (--agent), which is not compared.
#
# It touches nothing else: no worker, no unit, no cluster. Installing the worker is
# deploy/sbx/install-host.sh, after template-register.sh and setup.sh; it finds the record beside the
# snapshot and sets the worker's SH_TEMPLATE_RECORD and SANDBOX_TEMPLATE, so the worker checks the
# record against its snapshot at every start.
#
# Exit: 0 built (or already built); 1 a step failed; 2 a usage or spec error.
set -euo pipefail

TPL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TPL_DIR/../../.." && pwd)"
: "${SBX_SRV:=/srv/sbx}"
: "${SBX_MIN_FREE_GB:=50}"
# The verify cache's seed: SBX0's own worker binary, never Moca's /usr/local/bin one (an SBX0
# build runs no Moca binary), and the cache under SBX0's own tree, where install-host.sh points each
# worker, so removing SBX_SRV removes it too. A missing binary only skips the seed.
: "${SBX_WORKER_BIN:=/usr/local/libexec/sbx/microvm-worker}"
: "${SH_VERIFY_CACHE_DIR:=$SBX_SRV/verify-cache}"
export SH_VERIFY_CACHE_DIR
# The two builders, overridable for the tests only.
: "${SBX_BUILD_ROOTFS:=$REPO_ROOT/deploy/microvm/build-rootfs.sh}"
: "${SBX_BUILD_SNAPSHOT:=$REPO_ROOT/deploy/microvm/build-snapshot.sh}"
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
# install-host.sh's sizing (sbx-worker@.service's standby depth 2, the 1024 MiB reserve, the VMM's
# 32 MiB per VM), so the record can say what --budget-mb one session needs.
STANDBY_DEPTH=2 MEMORY_RESERVE_MB=1024 VM_OVERHEAD_MB=32

log() { printf '==> %s\n' "$*"; }
die() { echo "deploy/sbx/template-onboarding/template-build.sh: $*" >&2; exit 1; }
usage() {
  echo 'usage: template-build.sh SPEC --kernel PATH [--agent DIR] [--vmm firecracker|cloud-hypervisor] [--registry HOST] [--egress-ca PATH] [--gate-record FILE [--gate-commit SHA]] [--keep-image] [--force]' >&2
  exit 2
}
spec_error() { echo "deploy/sbx/template-onboarding/template-build.sh: $SPEC: $*" >&2; exit 2; }

SPEC='' KERNEL='' AGENT="$REPO_ROOT/remote-worker" VMM=firecracker REGISTRY='' EGRESS_CA='' KEEP_IMAGE='' FORCE=''
GATE_RECORD='' GATE_COMMIT=''
while (($#)); do
  case "$1" in
  --kernel) [[ $# -ge 2 ]] || usage; KERNEL="$2"; shift 2 ;;
  --agent) [[ $# -ge 2 ]] || usage; AGENT="$2"; shift 2 ;;
  --vmm) [[ $# -ge 2 ]] || usage; VMM="$2"; shift 2 ;;
  --registry) [[ $# -ge 2 && "$2" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || usage; REGISTRY="$2"; shift 2 ;;
  --egress-ca) [[ $# -ge 2 ]] || usage; EGRESS_CA="$2"; shift 2 ;;
  --gate-record) [[ $# -ge 2 ]] || usage; GATE_RECORD="$2"; shift 2 ;;
  --gate-commit) [[ $# -ge 2 && "$2" =~ ^[0-9a-f]{7,40}$ ]] || usage; GATE_COMMIT="$2"; shift 2 ;;
  --keep-image) KEEP_IMAGE=1; shift ;;
  --force) FORCE=1; shift ;;
  -h | --help) usage ;;
  -*) echo "template-build.sh: unknown argument $1" >&2; usage ;;
  *) [[ -z "$SPEC" ]] || usage; SPEC="$1"; shift ;;
  esac
done
[[ -n "$SPEC" && -n "$KERNEL" ]] || usage
[[ -f "$SPEC" ]] || { echo "template-build.sh: no spec file $SPEC" >&2; exit 2; }
[[ "$VMM" == firecracker || "$VMM" == cloud-hypervisor ]] || usage
command -v jq >/dev/null || die 'needs jq'

# 1. The spec. Every field is checked here, before anything is pulled or built.
jq -e 'type == "object"' "$SPEC" >/dev/null 2>&1 || spec_error 'is not a JSON object'
field() { jq -r --arg k "$1" '.[$k] // empty | tostring' "$SPEC"; }
ID="$(field id)"
[[ "$ID" =~ $TEMPLATE_ID_RE ]] || spec_error "id '$ID' must match $TEMPLATE_ID_RE"
IMAGE="$(field image)"
[[ "$IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || spec_error "image must be pinned as repository@sha256:<64 hex>, got '$IMAGE'"
DIGEST="${IMAGE##*@}"
# What podman pulls: the spec's image, or with --registry and no registry in it, HOST/image. The
# record keeps the spec's own reference, so it carries no registry host either.
PULL="$IMAGE"
first="${IMAGE%%/*}"
if [[ -n "$REGISTRY" && "$IMAGE" == */* && "$first" != *.* && "$first" != *:* && "$first" != localhost ]]; then
  PULL="$REGISTRY/$IMAGE"
fi
RAM="$(field guest_ram_mb)" VCPUS="$(field vcpus)"
[[ "$RAM" =~ ^[1-9][0-9]*$ && "$RAM" -ge 128 ]] || spec_error "guest_ram_mb must be a whole number of MiB, at least 128, got '$RAM'"
[[ "$VCPUS" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]] || spec_error "vcpus must be 1-32, got '$VCPUS'"
GUEST_HOME="$(field guest_home)"
[[ -z "$GUEST_HOME" || "$GUEST_HOME" =~ ^/tmp(/[A-Za-z0-9._-]+)+$ ]] || spec_error "guest_home must be a path under /tmp, got '$GUEST_HOME'"
jq -e '(.skip_git_identity_check // false | type) == "boolean"' "$SPEC" >/dev/null || spec_error 'skip_git_identity_check must be true or false'
jq -e '(.guest_home_gitconfig // false | type) == "boolean"' "$SPEC" >/dev/null || spec_error 'guest_home_gitconfig must be true or false'
if [[ "$(jq -r '.guest_home_gitconfig // false' "$SPEC")" == true ]]; then
  [[ -n "$GUEST_HOME" ]] || spec_error 'guest_home_gitconfig needs guest_home'
  [[ "$(jq -r '.skip_git_identity_check // false' "$SPEC")" != true ]] ||
    spec_error 'guest_home_gitconfig with skip_git_identity_check: an image that refuses commits must not get its root identity'
fi
jq -e '(.egress | type) == "boolean"' "$SPEC" >/dev/null || spec_error 'egress must be true or false (false: the worker is installed with --no-egress)'
[[ -z "$EGRESS_CA" ]] || [[ "$(jq -r .egress "$SPEC")" == true ]] ||
  spec_error '--egress-ca is for a template with egress true (this one has no network)'
jq -e '(.seed | type) == "string"' "$SPEC" >/dev/null || spec_error 'seed must be a string ("" for none)'
jq -e '(.probe | type) == "object" and (.probe.cmd | type) == "string" and (.probe.cmd | length) > 0
  and (.probe.expect_rc | type) == "number" and (.probe.expect_rc | floor) == .probe.expect_rc
  and .probe.expect_rc >= 0 and .probe.expect_rc <= 255
  and (.probe.timeout_s | type) == "number" and .probe.timeout_s >= 1 and .probe.timeout_s <= 86400
  and (.probe.expect // [] | type) == "array" and all(.probe.expect // [] | .[]; type == "string" and length > 0)' \
  "$SPEC" >/dev/null || spec_error 'probe must be {cmd (non-empty), timeout_s (1-86400), expect_rc (0-255), expect: [extended regexes]}'
jq -e '(.description | type) == "string" and (.description | length) > 0
  and (.tools | type) == "array" and all(.tools[]; type == "string") and (.tools | unique | length) == (.tools | length)' \
  "$SPEC" >/dev/null || spec_error 'description must be a non-empty string and tools a list of distinct strings'
for re in $(jq -r '.probe.expect // [] | .[] | @base64' "$SPEC"); do
  re="$(printf '%s' "$re" | base64 --decode)"
  rc=0; printf '' | grep -Eq -- "$re" 2>/dev/null || rc=$?
  ((rc <= 1)) || spec_error "probe.expect has an invalid extended regex: $re"
done
case "$(field probe_status)" in
unmeasured | none) spec_error "probe_status is '$(field probe_status)': its expected result has not been measured, so it cannot be checked (measure it first)" ;;
esac
HOSTS_SHA="$(field etc_hosts_sha256)"
[[ -z "$HOSTS_SHA" || "$HOSTS_SHA" =~ ^[0-9a-f]{64}$ ]] || spec_error "etc_hosts_sha256 must be 64 hex digits, got '$HOSTS_SHA'"

# The gate evidence (X1, X5, X10, X12). Checked here, with the spec, so a
# refusal costs no pull.
SRC_DIGEST="$(field source_record_digest)"
[[ -z "$GATE_COMMIT" || -n "$GATE_RECORD" ]] || spec_error '--gate-commit needs --gate-record'
if [[ -n "$SRC_DIGEST" ]]; then
  [[ "$SRC_DIGEST" == "$DIGEST" ]] ||
    spec_error "source_record_digest $SRC_DIGEST is not the image's digest $DIGEST (X10): the spec does not name its image's gate record"
  [[ -n "$GATE_RECORD" ]] || spec_error 'the spec names a gate record (source_record_digest): build it with --gate-record FILE (X10)'
fi
GATE_JSON='null'
if [[ -n "$GATE_RECORD" ]]; then
  [[ -f "$GATE_RECORD" ]] || spec_error "no gate record $GATE_RECORD"
  jq -e 'type == "object"' "$GATE_RECORD" >/dev/null 2>&1 || spec_error "$GATE_RECORD is not a JSON object"
  [[ "$(jq -r '.gate.passed // false' "$GATE_RECORD")" == true ]] || spec_error "the gate record's gate did not pass (X1)"
  [[ "$(jq -r '.image.digest // empty' "$GATE_RECORD")" == "$DIGEST" ]] ||
    spec_error "the gate record is for image $(jq -r '.image.digest // "none"' "$GATE_RECORD"), not $DIGEST"
  if [[ "$(jq -r '.skip_git_identity_check // false' "$SPEC")" == true ]]; then
    # A spec that skips the identity check says the image refuses agent commits on purpose; the gate
    # must have seen that (X5), or skipping the check would hide an image that commits.
    jq -e '.observed.testbed.agent_can_commit == "no" and .observed.guest.git_identity == "none"' \
      "$GATE_RECORD" >/dev/null ||
      spec_error 'skip_git_identity_check, but the gate record does not show commits refused (X5: agent_can_commit no, git_identity none, both measured) (X12)'
  fi
  GATE_SHA="$({ sha256sum "$GATE_RECORD" 2>/dev/null || shasum -a 256 "$GATE_RECORD"; } | cut -d' ' -f1)"
  GATE_JSON="$(jq -c --arg sha "sha256:$GATE_SHA" --arg commit "$GATE_COMMIT" '{
    schema, passed: .gate.passed, kind: .gate.kind, network: .gate.network, user: .gate.user,
    base_digest: (.testbed_image.digest // .environment_image.digest // .base_image.digest // null),
    recipe, builder, built_at, sha256: $sha}
    + (if $commit == "" then {} else {commit: $commit} end)
    + (if .observed.testbed.agent_can_commit then {commits_refused: (.observed.testbed.agent_can_commit == "no")} else {} end)' \
    "$GATE_RECORD")"
fi

TAG12="${DIGEST#sha256:}"; TAG12="${TAG12:0:12}"
NAME="$ID-$TAG12"
WORKER="sbx_${ID//-/_}_$TAG12"
OUT="$SBX_SRV/snapshots/$NAME"
RECORD="$SBX_SRV/templates/$NAME.json"
BUDGET_MIN=$(((RAM + VM_OVERHEAD_MB) * (1 + STANDBY_DEPTH) + MEMORY_RESERVE_MB))

# The command the restored VM runs (build-snapshot.sh --verify-command): in /workspace, the seed,
# then the probe with its output in a log, its exit code and its patterns checked in the guest, so
# the build passes only on the expected result (an instance whose baseline fails tests exits
# nonzero). Each part is quoted with printf %q for the guest's bash.
verify_command() {
  local seed cmd want re
  seed="$(jq -r '.seed' "$SPEC")"
  cmd="$(jq -r '.probe.cmd' "$SPEC")"
  want="$(jq -r '.probe.expect_rc' "$SPEC")"
  if [[ -n "$seed" ]]; then
    printf 'bash -c %q || { echo "template-build: the seed failed ($?)"; exit 90; }\n' "$seed"
  fi
  printf 'bash -c %q >/tmp/.template-probe.log 2>&1; rc=$?\n' "$cmd"
  # Test runners colour their summaries (pytest: ESC[32m8 passed ESC[0m), so the patterns are
  # matched against the log with ANSI escapes stripped, and the tail shown is the plain text too.
  printf '%s\n' "sed 's/\x1b\[[0-9;]*[A-Za-z]//g' /tmp/.template-probe.log >/tmp/.template-probe.txt"
  # The guest's shell expands $rc, not this one.
  # shellcheck disable=SC2016
  printf '%s\n' 'tail -c 12288 /tmp/.template-probe.txt' 'echo "template-build: the probe exited $rc"'
  # shellcheck disable=SC2016
  printf '[ "$rc" = %q ] || { echo "template-build: want exit %s"; exit 91; }\n' "$want" "$want"
  for re in $(jq -r '.probe.expect // [] | .[] | @base64' "$SPEC"); do
    re="$(printf '%s' "$re" | base64 --decode)"
    printf 'grep -Eq -- %q /tmp/.template-probe.txt || { echo %q; exit 92; }\n' "$re" "template-build: no match for $re"
  done
  printf '%s\n' 'echo "template-build: the probe passed"'
}

# The record, from the spec and the built manifest: everything template-register.sh needs, and the
# seed a client runs. No secret is in either.
write_record() {
  local hash built
  hash="$(jq -r '.hash' "$OUT/manifest.json")"
  built="$(jq -r '.built_at // empty' "$OUT/manifest.json")"
  mkdir -p "$SBX_SRV/templates"
  jq -S --arg snapshot "$NAME" --arg worker "$WORKER" --arg hash "$hash" --arg built "$built" \
    --argjson budget "$BUDGET_MIN" --arg ca "$(jq -r '.egress_ca_sha256 // empty' "$OUT/manifest.json")" \
    --argjson gate "$GATE_JSON" \
    '{schema: "moca-sbx-template/1", id, worker: $worker, snapshot: $snapshot, image, guest_ram_mb,
      vcpus, egress, seed, probe, description, tools, guest_home_gitconfig: (.guest_home_gitconfig // false),
      manifest_hash: $hash, built_at: $built,
      min_budget_mb: $budget}
    + (if $ca == "" then {} else {egress_ca_sha256: $ca} end)
    + (if .skip_git_identity_check then {skip_git_identity_check: true} else {} end)
    + (if .guest_home then {guest_home} else {} end)
    + (if .etc_hosts_sha256 then {etc_hosts_sha256} else {} end)
    + (if .source_record_digest then {source_record_digest} else {} end)
    + (if .probe_status then {probe_status} else {} end)
    + (if .proved_in_vm != null then {proved_in_vm} else {} end)
    + (if $gate == null then {} else {gate_record: $gate} end)' "$SPEC" >"$RECORD.tmp"
  mv "$RECORD.tmp" "$RECORD"
}

# The spec's part of a record, for "already built": the same spec on the same snapshot. Every
# spec field that changes the snapshot or its checks is here, with its default, so a record from
# before a field was recorded reads as that default and a spec that sets it rebuilds.
spec_key() { jq -S '{id, image, guest_ram_mb, vcpus, egress, seed, probe, description, tools,
  guest_home_gitconfig: (.guest_home_gitconfig // false), guest_home: (.guest_home // null),
  skip_git_identity_check: (.skip_git_identity_check // false),
  etc_hosts_sha256: (.etc_hosts_sha256 // null)}' "$1"; }
# The gate evidence the existing record carries, for "already built": a build against another gate
# record (or none) rewrites the record.
gate_key() { jq -c '.gate_record.sha256 // null' "$1"; }

[[ -n "${SBX_SKIP_ROOT_CHECK:-}" || "$(id -u)" == 0 ]] || die 'must run as root (build-rootfs.sh and build-snapshot.sh do)'
[[ -f "$KERNEL" ]] || die "no kernel at $KERNEL"
[[ -d "$AGENT" ]] || die "no guest agent source at $AGENT (the remote-worker module)"
# The CA's fingerprint as build-snapshot.sh records it (sha256 of the DER), for "already built".
CA_SHA=''
if [[ -n "$EGRESS_CA" ]]; then
  [[ -f "$EGRESS_CA" ]] || die "no egress CA at $EGRESS_CA (install-host.sh --egress-ca-out prints its path)"
  ! grep -q 'PRIVATE KEY' "$EGRESS_CA" || die "$EGRESS_CA holds a private key: pass the public certificate"
  CA_SHA="$(openssl x509 -in "$EGRESS_CA" -outform DER | { sha256sum 2>/dev/null || shasum -a 256; })" ||
    die "$EGRESS_CA is not a PEM certificate"
  CA_SHA="sha256:${CA_SHA%% *}"
fi

# The build inputs that are not in the spec, for "already built": the VMM and the guest kernel are
# compared with the snapshot's manifest. The guest agent is built from --agent's source by
# build-snapshot.sh, so it cannot be compared without a build: after an agent change, pass --force.
KERNEL_SHA="sha256:$({ sha256sum "$KERNEL" 2>/dev/null || shasum -a 256 "$KERNEL"; } | cut -d' ' -f1)"
if [[ -z "$FORCE" && -f "$OUT/manifest.json" && -f "$RECORD" ]] &&
  [[ "$(spec_key "$SPEC")" == "$(spec_key "$RECORD")" ]] &&
  [[ "$(jq -r .manifest_hash "$RECORD")" == "$(jq -r .hash "$OUT/manifest.json")" ]] &&
  [[ "$(jq -r '.egress_ca_sha256 // empty' "$OUT/manifest.json")" == "$CA_SHA" ]] &&
  [[ "$(jq -r '.vmm // empty' "$OUT/manifest.json")" == "$VMM" ]] &&
  [[ "$(jq -r '.kernel_sha256 // empty' "$OUT/manifest.json")" == "$KERNEL_SHA" ]]; then
  if [[ "$(gate_key "$RECORD")" != "$(jq -c '.sha256 // null' <<<"$GATE_JSON")" ]]; then
    # The same snapshot, cited against another gate record (or newly against one): the snapshot
    # stands, only the record's evidence changes.
    write_record
    log "already built: snapshot $NAME; its record now cites the given gate record ($RECORD)"
    exit 0
  fi
  log "already built: snapshot $NAME, record $RECORD (--force rebuilds; it is needed after a guest agent change)"
  exit 0
fi

mkdir -p "$SBX_SRV/snapshots"
free_kb="$(df -Pk "$SBX_SRV/snapshots" | awk 'NR == 2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] || die "could not read the free space of $SBX_SRV/snapshots"
((free_kb >= SBX_MIN_FREE_GB * 1024 * 1024)) ||
  die "$SBX_SRV/snapshots has $((free_kb / 1024 / 1024)) GiB free; a build needs $SBX_MIN_FREE_GB (SBX_MIN_FREE_GB). Drop an unused snapshot first."

BUILD="$SBX_SRV/build/$NAME"
cleanup() {
  rm -rf "$BUILD"
  [[ -n "$KEEP_IMAGE" || -z "${PULLED:-}" ]] || podman rmi "$PULL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 2. The image, by digest. podman resolves a digest reference to exactly that manifest; the check
# makes a registry or a local tag that says otherwise fail here, not in a sandbox.
log "pulling $IMAGE"
PULLED=''
if ! podman image exists "$PULL"; then
  podman pull "$PULL" >/dev/null || die "could not pull $PULL"
  PULLED=1
fi
got="$(podman image inspect --format '{{.Digest}}' "$PULL")"
[[ "$got" == "$DIGEST" ]] || die "pulled $IMAGE but its digest is $got"

# 3. The rootfs and the snapshot, with the seed and the probe as the verify step.
rm -rf "$BUILD"
mkdir -p "$BUILD"
log "building the rootfs of $NAME"
# The tools this template's image must carry (M3): its spec's `tools` plus what the
# guest agent itself runs (bash for every command; base64, cat, ls and file for the harness's file
# operations). Not Moca's whole sandbox toolchain, which benchmark images do not carry.
required="$(jq -r '[.tools[]] + ["bash","ls","cat","base64","file"] | unique | join(" ")' "$SPEC")"
"$SBX_BUILD_ROOTFS" --out "$BUILD/rootfs" --image "$PULL" --source-name "$IMAGE" --require "$required"
if [[ -n "$HOSTS_SHA" ]]; then
  got="$(sha256sum "$BUILD/rootfs/etc/hosts" 2>/dev/null || shasum -a 256 "$BUILD/rootfs/etc/hosts")" || die "the rootfs has no /etc/hosts"
  [[ "${got%% *}" == "$HOSTS_SHA" ]] || die "the rootfs's /etc/hosts has sha256 ${got%% *}, not the spec's $HOSTS_SHA"
  log 'etc/hosts as the spec says'
fi
args=(--kernel "$KERNEL" --rootfs "$BUILD/rootfs" --agent "$AGENT" --image "$NAME" --vmm "$VMM"
  --guest-ram-mb "$RAM" --vcpus "$VCPUS" --out "$OUT"
  --verify-command "$(verify_command)" --verify-timeout-s "$(jq -r '.probe.timeout_s' "$SPEC")")
args+=(--worker-bin "$SBX_WORKER_BIN")
[[ -z "$GUEST_HOME" ]] || args+=(--guest-home "$GUEST_HOME")
[[ -z "$EGRESS_CA" ]] || args+=(--egress-ca "$EGRESS_CA")
[[ "$(jq -r '.skip_git_identity_check // false' "$SPEC")" != true ]] || args+=(--skip-git-identity-check)
[[ "$(jq -r '.guest_home_gitconfig // false' "$SPEC")" != true ]] || args+=(--guest-home-gitconfig)
log "building and checking the snapshot $NAME (the probe runs in the restored VM)"
"$SBX_BUILD_SNAPSHOT" "${args[@]}"
[[ -f "$OUT/manifest.json" ]] || die "build-snapshot.sh left no $OUT/manifest.json"
[[ "$(jq -r '.egress_ca_sha256 // empty' "$OUT/manifest.json")" == "$CA_SHA" ]] ||
  die "the snapshot's egress_ca_sha256 is not the CA's ($CA_SHA)"

# 4. The record.
write_record
egress_flag=''
[[ "$(jq -r .egress "$SPEC")" == true ]] || egress_flag=' --no-egress'
log "built template $ID: snapshot $NAME, worker $WORKER"
log "record: $RECORD (copy it to the operator's machine for deploy/sbx/template-onboarding/template-register.sh)"
log "then, after setup.sh: sudo deploy/sbx/install-host.sh <bundle of $WORKER> --snapshot $NAME --budget-mb <at least $BUDGET_MIN>$egress_flag"
log "install-host.sh wires $RECORD into the worker (SH_TEMPLATE_RECORD, SANDBOX_TEMPLATE=$ID), so the worker checks it at every start"
