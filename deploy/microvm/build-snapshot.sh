#!/usr/bin/env bash
# deploy/microvm/build-snapshot.sh
#
# Builds ONE golden VM snapshot: a paused, restorable microVM whose memory and
# device state (vmstate, memfile) sit alongside the exact kernel, rootfs and guest
# agent that produced them, plus a manifest.json pinning it all together. This is
# the artifact remote-worker's microvm-worker verifies at start and every real Exec
# then restores FROM — it is never built per run (spec §2.4, §5.2, §5.5).
#
# Deliberately linear, and each step fails the whole build rather than limping on
# with a partial artifact:
#
#   1. preflight   -- confirm THIS host can produce a snapshot THIS host (or one
#                      identical to it) can later restore: /dev/kvm, cgroups v2, no
#                      swap, kernel new enough for what the VMM needs. Restore
#                      requires identical hardware and software (spec §2.4), so the
#                      snapshot is built on the target instance type, not cross-built.
#                      For --vmm cloud-hypervisor specifically, also confirms the
#                      supplied --kernel was actually built with virtio-fs support
#                      (CONFIG_VIRTIO_FS): Firecracker's own CI kernels do not carry
#                      it (Firecracker has no virtio-fs, so its kernel config has no
#                      reason to enable the driver), and a snapshot built against
#                      such a kernel would boot and quiesce fine, then fail much
#                      later as a lost write once a real Exec tries to use the
#                      workspace share -- exactly the empty-workspace symptom this
#                      check exists to catch at build time instead. See fix-round-
#                      12's virtio-fs preflight block, below, for the detection
#                      method and why the Firecracker arm has no inverse check.
#   2. build_agent  -- the guest agent, static (CGO_ENABLED=0), because the rootfs
#                      is minimal and a dynamically-linked agent would need a libc
#                      the image may not carry.
#   3. assemble_rootfs -- layer the agent and a minimal init onto the caller's base
#                      rootfs. Nothing that identifies a run may enter here or at any
#                      later step: no bearer credential, no per-VM secret. The agent
#                      reads its per-run identity over vsock from the host at Exec
#                      time, never from a file baked into the image (spec §5.2).
#   4. boot_quiesce_snapshot -- boot cold, wait for the agent to park in accept(),
#                      quiesce the guest, then ask the VMM to serialize memory and
#                      device state to vmstate/memfile.
#   5. write_manifest -- record image, vmm, instance type, kernel release, guest RAM,
#                      the capabilities probed INSIDE the guest before snapshotting,
#                      and the three component digests + their combined hash, in the
#                      exact kernel/rootfs/agent order vmpool.Manifest.ComputeHash
#                      hashes them in. kernel_sha256 is expected to legitimately
#                      DIFFER between a firecracker-arm and a cloud-hypervisor-arm
#                      manifest for the same --image: the two arms need different
#                      kernels (see preflight's virtio-fs check, item 1 above, and
#                      fix-round-12's report section), so any A/B measurement
#                      between the two arms is a VMM-PLUS-KERNEL swap, not a pure
#                      VMM swap -- a caveat for the experiment write-up (Tasks
#                      20/21), not a defect in this script. Two more differences
#                      were found chasing that one down, none of them chosen, all
#                      three consequences of the SAME decision (using virtio-fs at
#                      all, which is what makes SerializesExecsPerRun() false and
#                      D>1 standbys viable -- spec section referenced in fix-round-
#                      12's report). Recorded together here so a reader finds all
#                      three in one place instead of one at a time:
#                        1. Different guest kernels (above): Firecracker's CI kernel
#                           has no CONFIG_VIRTIO_FS.
#                        2. No copy-on-write restore mode on the installed cloud-
#                           hypervisor v53.0: `ch-remote restore --help` and a live
#                           API call both show memory_restore_mode enumerates only
#                           copy|ondemand, not CopyOnWrite (see docs/notes/cloud-
#                           hypervisor-snapshot-facts.md row 4, hardware-tested: an
#                           OnDemand restore of one snapshot into three processes
#                           showed NO RSS/PSS gap at all -- each process's Pss was
#                           ~99% of its own VmRSS -- the opposite of Firecracker's
#                           measured ~3x gap).
#                        3. Different guest memory backing (fix-round-13): --fs is a
#                           vhost-user device, and vhost-user devices are driven by
#                           an external daemon (virtiofsd) that needs direct access
#                           to guest RAM, which cloud-hypervisor's config validator
#                           only allows when the guest's memory is MAP_SHARED --
#                           hence this file's --memory ...,shared=on (see fix-round-
#                           13's comment on that flag for the exact failure this
#                           fixes). Firecracker's workspace is a plain disk image,
#                           not virtio-fs, so it has no vhost-user device and keeps
#                           private (MAP_PRIVATE) guest memory throughout.
#                      Item 3 lands squarely on spec section 7.3's memory
#                      arithmetic -- the basis for the standby-density claim and the
#                      cost argument built on it. A footprint comparison is now
#                      private-memory Firecracker against shared-memory Cloud
#                      Hypervisor, and "sum PSS, not RSS" may not mean the same
#                      thing on both sides of that comparison. Not resolved here --
#                      a Task 21 measurement question -- but written down now, next
#                      to items 1 and 2, while all three are fresh from the same
#                      investigation.
#   6. lock_down    -- root-owned, read-only. Only a 64-bit CRC guards vmstate and the
#                      VMM trusts these files (spec §2.4); the filesystem permissions
#                      are the next line of defence after that. Seals into $PENDING, a
#                      sibling of $OUT on the same device -- NOT into $OUT itself, see
#                      step 8.
#   7. verify_restore -- restore ONE VM from the artifact just produced (from $PENDING)
#                      and run a trivial command in it. A snapshot can hash correctly
#                      and still not restore on this host, and that must be caught
#                      here, not on a worker's first user request (spec §6).
#   8. publish_snapshot -- the ONLY step that touches $OUT, and it runs last, after
#                      verify_restore has passed. This order is load-bearing, not
#                      tidiness: lock_down used to seal straight into $OUT before
#                      verify_restore ran, so a snapshot that failed verification was
#                      left published, sealed and self-consistent -- its manifest hash
#                      matches its own bytes, so every worker's startup verification
#                      passes and the tier boots on an artifact known not to restore.
#                      Nothing rolled it back either ($OUT was never a cleanup target),
#                      and because a rebuild overwrote $OUT in place, a failed rebuild
#                      left the host WORSE off than before it ran. Publishing by rename
#                      after verification means a failed build leaves the previous
#                      good snapshot exactly where it was.
#
# Needs a KVM host with the chosen VMM installed; it cannot run in CI. What CAN run
# everywhere is deploy/microvm/tests/build-snapshot.test.sh, which pins this script's
# contract (flags, permissions, no secrets, static build) without touching a
# hypervisor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

KERNEL=""
ROOTFS=""
AGENT_SRC=""
IMAGE=""
INSTANCE_TYPE=""
VMM="firecracker"
GUEST_RAM_MB=256
OUT=""

usage() {
  cat >&2 <<'USAGE'
build-snapshot.sh --kernel PATH --rootfs PATH --agent PATH --image NAME
                  [--instance-type TYPE] [--vmm firecracker|cloud-hypervisor]
                  [--guest-ram-mb 256] [--out DIR]

Builds one golden snapshot, ON THE INSTANCE TYPE THAT WILL RUN IT (spec §2.4:
restore requires identical hardware and software). --instance-type is an OVERRIDE:
left unset, the script auto-detects this host's identity (cloud metadata first,
then /sys/class/dmi/id/product_name -- see detect_host_instance_type) using the
SAME precedence remote-worker/cmd/microvm-worker/main.go's detectHostInstanceType
uses to verify the snapshot at start, so builder and verifier agree by
construction. Only pass --instance-type when you deliberately want the manifest to
name something other than what this host reports. Writes vmstate, memfile and a
manifest.json the worker verifies at start, then restores one VM to prove the
artifact works.
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --kernel)
      KERNEL="${2:-}"
      shift 2
      ;;
    --rootfs)
      ROOTFS="${2:-}"
      shift 2
      ;;
    --agent)
      AGENT_SRC="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --instance-type)
      INSTANCE_TYPE="${2:-}"
      shift 2
      ;;
    --vmm)
      VMM="${2:-}"
      shift 2
      ;;
    --guest-ram-mb)
      GUEST_RAM_MB="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

if [ -z "$KERNEL" ] || [ -z "$ROOTFS" ] || [ -z "$AGENT_SRC" ] || [ -z "$IMAGE" ]; then
  # Fix-round-2 item C: --instance-type is deliberately NOT required here -- it is
  # an override over detect_host_instance_type's auto-detection, checked in
  # preflight() once all the detection helpers below are defined.
  usage
fi
case "$VMM" in
  firecracker | cloud-hypervisor) ;;
  *)
    echo "build-snapshot.sh: --vmm must be firecracker or cloud-hypervisor, got '$VMM'" >&2
    exit 2
    ;;
esac

OUT="${OUT:-$REPO_ROOT/.build/microvm-snapshots/$IMAGE}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/build-snapshot.XXXXXX")"
# PENDING is where lock_down seals the finished snapshot and where verify_restore
# restores it FROM. It is created by lock_down (as a sibling of $OUT, so that
# publish_snapshot's mv is a same-device rename rather than a copy of the whole guest
# RAM image) and is renamed onto $OUT only after verification passes.
PENDING=""

# Fix-round-7 item 2: every phase below runs a VMM in the background and/or holds
# a device-mounted jail open, and each used to arm ITS OWN `trap '...' EXIT`
# string referencing that phase's own `local` pid/jail variable by name (e.g.
# `trap 'kill "$fc_pid" ...' EXIT`, with `local fc_pid=""` declared just above
# it). That looked safe -- fix-round-2 item A even documents arming it early,
# before the mount, for exactly this reason -- but it was not: an EXIT trap
# fires when the WHOLE SCRIPT's process exits, not when the function that armed
# it returns, and bash pops a function's locals off as soon as `set -e` unwinds
# out of that function's call frame, which for a mid-function failure happens
# BEFORE the (already-armed, already pointing at that now-gone local) trap body
# gets to run. Referencing a popped local under `set -u` is itself instantly
# fatal ("fc_pid: unbound variable") -- and that failure happens INSIDE the
# trap, aborting it, so the rest of the trap body (the kill/wait, the unmount,
# the final rm -rf) never runs either. This bit every one of the four functions
# that did it (both boot_quiesce_snapshot_* arms, both verify_restore_* arms);
# the ones that "worked" up to this round only did so by luck of where the real
# failure happened to land.
#
# The fix: nothing this trap touches is ever a function local. These four are
# script-scope, set (never `local`-shadowed anywhere in this file) by whichever
# phase is currently live, and reset back to "" by that same phase once its own
# normal-path teardown has already run -- so cleanup_on_exit only re-does work
# for a phase that is still mid-flight when the trap fires, never for one that
# already finished cleanly. The relevant functions run strictly sequentially,
# never concurrently, so there is exactly one writer of each field at a time and
# nothing for one phase to stomp on another's behalf.
CLEANUP_PID=""       # pid of the currently-running VMM subprocess, if any
CLEANUP_JAIL=""       # jail directory with an active /dev bind-mount, if any
CLEANUP_EXTRA_DIR=""  # extra directory (beyond $STAGE) to remove, if any
# Fix-round-12: pid of the currently-running build-time virtiofsd, if any -- a
# SECOND backgrounded process a cloud-hypervisor jail can now have, alongside
# CLEANUP_PID's VMM. Kept as its own named global rather than folded into
# CLEANUP_PID/teardown_jail because the two processes have a required teardown
# ORDER (VMM before virtiofsd, never the reverse -- see teardown_virtiofsd's own
# comment), which a single shared pid variable cannot express.
CLEANUP_FS_PID=""
# The sealed-but-not-yet-published snapshot directory ($PENDING), if one exists. Set by
# lock_down and cleared by publish_snapshot once the rename has happened, so any exit
# between those two points -- a failed verify_restore above all -- removes the unverified
# artifact instead of leaving a root-owned, read-only, self-consistent snapshot lying
# next to $OUT for someone to find and deploy.
CLEANUP_PENDING_DIR=""

cleanup_on_exit() {
  # Runs once, however deep whatever phase was mid-flight when the script exited
  # happened to be. Every name referenced here is either this function's OWN
  # local (declared and consumed within this one invocation, so it can never be
  # popped out from under itself the way the old per-function traps were) or one
  # of the four script-scope globals above. The ${VAR:-} defaults are
  # belt-and-braces -- set -u never actually needs them for a global that is
  # always assigned above -- so that a future global added the same way without
  # the default does not quietly reintroduce this bug's class.
  kill "${CLEANUP_PID:-}" 2>/dev/null || true
  wait "${CLEANUP_PID:-}" 2>/dev/null || true
  # Fix-round-12: reap the build-time virtiofsd, if any, AFTER the VMM above --
  # same order teardown_virtiofsd documents and launcher_chv.go's Destroy already
  # uses ("VMM first, then virtiofsd"), kept here too since this trap can fire
  # mid-flight, before either phase's own normal-path teardown call has run.
  kill "${CLEANUP_FS_PID:-}" 2>/dev/null || true
  wait "${CLEANUP_FS_PID:-}" 2>/dev/null || true
  if [ -n "${CLEANUP_JAIL:-}" ]; then
    jail_unmount_dev "$CLEANUP_JAIL"
  fi
  local rm_targets=("$STAGE")
  if [ -n "${CLEANUP_EXTRA_DIR:-}" ]; then
    rm_targets+=("$CLEANUP_EXTRA_DIR")
  fi
  # An unpublished snapshot is removed on every exit path. $OUT deliberately is NOT a
  # cleanup target and never was: by the time it exists, it has been verified, and the
  # previous good snapshot lives there until that moment.
  if [ -n "${CLEANUP_PENDING_DIR:-}" ]; then
    rm_targets+=("$CLEANUP_PENDING_DIR")
  fi
  rm_rf_jail "${rm_targets[@]}"
}
trap cleanup_on_exit EXIT

log() { echo "build-snapshot.sh: $*" >&2; }

# ---------------------------------------------------------------------------
# instance-type auto-detection (fix-round-2 item C)
# ---------------------------------------------------------------------------
# --instance-type used to be a required, operator-typed argument written verbatim
# into the manifest. microvm-worker's detectHostInstanceType (remote-worker/cmd/
# microvm-worker/main.go) never reads that string back from the operator -- at
# verify time it PROBES the host itself (cloud metadata, then a DMI fallback) and
# compares its own answer to the manifest. On the EC2 dev box IMDS answers and a
# hand-typed --instance-type naturally agrees with it, so the two never disagree
# there; on the real bare-metal deployment target no cloud metadata answers, the
# worker falls all the way to /sys/class/dmi/id/product_name (something like
# "PowerEdge R760"), and a hand-typed manifest string will not match it --
# verifyInstanceType then refuses to start every worker on the fleet, and the only
# escape (SH_ALLOW_INSTANCE_TYPE_MISMATCH=true) disables the check entirely.
#
# detect_host_instance_type below MUST use the exact same precedence as
# detectHostInstanceType in remote-worker/cmd/microvm-worker/main.go: EC2 IMDSv2,
# then GCP metadata, then Azure IMDS, then DMI product_name. If you change the
# order (or add/remove a probe) on either side, change it on both -- this pairing
# IS the contract, not just a comment. --instance-type remains available as a
# deliberate OVERRIDE (e.g. a documented compatible substitute type), applied
# after detection and before anything reads $INSTANCE_TYPE.
metadata_get() {
  # $1: URL, remaining args: extra curl flags/headers. 300ms mirrors
  # metadataTimeout in main.go: these services answer in single-digit
  # milliseconds or not at all (wrong cloud, or none present).
  local url="$1"
  shift
  curl -fs -S --max-time 0.3 "$@" "$url" 2>/dev/null || true
}

ec2_instance_type() {
  # IMDSv2: a token must be minted (PUT /latest/api/token) before EC2's metadata
  # service answers any meta-data GET -- mirrors ec2InstanceType in main.go.
  local token
  token="$(curl -fs -S --max-time 0.3 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)"
  [ -n "$token" ] || return 0
  metadata_get "http://169.254.169.254/latest/meta-data/instance-type" \
    -H "X-aws-ec2-metadata-token: $token"
}

gcp_machine_type() {
  # GCE answers "projects/<num>/machineTypes/<type>"; take the trailing segment
  # so this is comparable to what EC2/Azure return -- mirrors gcpMachineType.
  local raw
  raw="$(metadata_get "http://metadata.google.internal/computeMetadata/v1/instance/machine-type" \
    -H "Metadata-Flavor: Google")"
  printf '%s\n' "${raw##*/}"
}

azure_vm_size() {
  # Mirrors azureVMSize: Azure IMDS answers any request carrying its required
  # header without further auth.
  metadata_get "http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01" \
    -H "Metadata: true"
}

stable_host_identity() {
  # Mirrors stableHostIdentity: /sys/class/dmi/id/product_name is set by
  # firmware/the hypervisor and stable across reboots on real hardware and most
  # non-cloud hypervisors alike. uname is this script's equivalent of main.go's
  # runtime.GOOS/GOARCH last resort, so this always returns SOMETHING.
  local pn
  if [ -r /sys/class/dmi/id/product_name ]; then
    pn="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
    if [ -n "$pn" ]; then
      printf '%s\n' "$pn"
      return
    fi
  fi
  printf '%s/%s\n' "$(uname -s)" "$(uname -m)"
}

detect_host_instance_type() {
  local t
  t="$(ec2_instance_type)"
  if [ -n "$t" ]; then
    printf '%s\n' "$t"
    return
  fi
  t="$(gcp_machine_type)"
  if [ -n "$t" ]; then
    printf '%s\n' "$t"
    return
  fi
  t="$(azure_vm_size)"
  if [ -n "$t" ]; then
    printf '%s\n' "$t"
    return
  fi
  stable_host_identity
}

# ---------------------------------------------------------------------------
# 1. preflight
# ---------------------------------------------------------------------------
kernel_at_least() {
  # $1: running release, e.g. "6.8.0-45-generic"; $2: minimum "major.minor".
  local have want
  have="${1%%-*}"
  want="$2"
  [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n1)" = "$want" ]
}

preflight() {
  log "preflight: checking this host can build AND restore a snapshot"

  if [ -z "$INSTANCE_TYPE" ]; then
    # Fix-round-2 item C: detect using the same precedence the worker verifies
    # with, instead of demanding the operator type (and keep in sync by hand)
    # something the worker will independently re-derive at start.
    INSTANCE_TYPE="$(detect_host_instance_type)"
    log "preflight: --instance-type not given, detected '$INSTANCE_TYPE'"
  fi

  if [ ! -e /dev/kvm ]; then
    echo "build-snapshot.sh: /dev/kvm is not present on this host. A golden snapshot" >&2
    echo "  must be built on the SAME instance type that will restore it (spec §2.4)," >&2
    echo "  so this cannot be cross-built on a non-KVM machine." >&2
    exit 1
  fi

  local cgroup_type
  cgroup_type="$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
  if [ "$cgroup_type" != "cgroup2fs" ]; then
    echo "build-snapshot.sh: cgroups v2 is required (/sys/fs/cgroup is '$cgroup_type', want cgroup2fs)" >&2
    exit 1
  fi

  if [ -n "$(swapon --show 2>/dev/null || true)" ]; then
    echo "build-snapshot.sh: swap must be off on a snapshot-build host; a swapped-out" >&2
    echo "  guest page would make the memory digest and the restore behaviour disagree" >&2
    exit 1
  fi

  local release
  release="$(uname -r)"
  if ! kernel_at_least "$release" "5.18"; then
    echo "build-snapshot.sh: kernel $release is older than the minimum 5.18" >&2
    exit 1
  fi

  # Fix-round-12: cloud-hypervisor only, no inverse check on the firecracker arm.
  # Firecracker has no virtio-fs support at all, so absence of CONFIG_VIRTIO_FS
  # in a firecracker-arm --kernel is simply irrelevant there. The cloud-hypervisor
  # arm's whole reason to exist (spec §4.3, workspace shared over virtio-fs
  # instead of serialized per-run) depends on the GUEST kernel actually having the
  # driver; --fs on the cloud-hypervisor command line only creates the DEVICE, it
  # does not make the guest able to mount it. Firecracker's own CI kernels (the
  # ones every build so far has pointed --kernel at) are built without the driver
  # -- there is no reason for a Firecracker-oriented kernel config to carry it --
  # so pointing the cloud-hypervisor arm at one of those kernels would boot and
  # quiesce fine, then fail much later and confusingly, as a lost write, the
  # first time a real Exec tries to use the workspace share. Catch it here
  # instead, at build time, naming the kernel and what is missing.
  #
  # Detection: `strings | grep -c virtio_fs`, hardware-validated against two real
  # kernel images -- 0 hits on a Firecracker CI kernel, 68 on cloud-hypervisor's
  # own recommended kernel -- which discriminates cleanly with no build tooling
  # (no need for the kernel's own .config, which a prebuilt image often lacks)
  # and no guest boot required. It is a string-presence heuristic, not a proof:
  # false positives (a string mentioning virtio_fs without the driver built in)
  # are possible in principle but were not seen on either rig kernel this was
  # validated against.
  if [ "$VMM" = "cloud-hypervisor" ]; then
    if [ ! -r "$KERNEL" ]; then
      echo "build-snapshot.sh: --kernel $KERNEL is missing or unreadable" >&2
      exit 1
    fi
    if ! command -v strings >/dev/null 2>&1; then
      echo "build-snapshot.sh: 'strings' is required to preflight a --vmm" >&2
      echo "  cloud-hypervisor --kernel for virtio-fs support (binutils package)" >&2
      exit 1
    fi
    local virtiofs_hits
    virtiofs_hits="$(strings "$KERNEL" 2>/dev/null | grep -c 'virtio_fs' || true)"
    if [ "${virtiofs_hits:-0}" -eq 0 ]; then
      echo "build-snapshot.sh: --kernel $KERNEL has no virtio-fs support" >&2
      echo "  (CONFIG_VIRTIO_FS): 'strings $KERNEL | grep -c virtio_fs' returned 0." >&2
      echo "  --vmm cloud-hypervisor's whole point is a workspace shared over" >&2
      echo "  virtio-fs (spec §4.3); a kernel without the driver will boot and" >&2
      echo "  quiesce fine and only fail later, as a lost write, when a real Exec" >&2
      echo "  tries to use /workspace." >&2
      echo "  Firecracker's CI kernels (the ones the firecracker arm's --kernel" >&2
      echo "  has been pointed at) do not carry this driver -- Firecracker has no" >&2
      echo "  virtio-fs, so there is no reason for that kernel's config to enable" >&2
      echo "  it. Use cloud-hypervisor's own recommended kernel instead (e.g. the" >&2
      echo "  vmlinux built from https://github.com/cloud-hypervisor/cloud-hypervisor" >&2
      echo "  docs' recommended config, which does enable CONFIG_VIRTIO_FS)." >&2
      exit 1
    fi
    log "preflight: --kernel $KERNEL has virtio-fs support ($virtiofs_hits strings hits)"
  fi

  log "preflight: ok (kernel $release)"
}

# ---------------------------------------------------------------------------
# 2. build_agent
# ---------------------------------------------------------------------------
build_agent() {
  log "building the guest agent statically from $AGENT_SRC"
  if [ ! -d "$AGENT_SRC/cmd/guest-agent" ]; then
    echo "build-snapshot.sh: --agent $AGENT_SRC has no cmd/guest-agent; pass the" >&2
    echo "  remote-worker module root (the directory containing go.mod)" >&2
    exit 1
  fi
  (
    cd "$AGENT_SRC"
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' \
      -o "$STAGE/agent" ./cmd/guest-agent
  )
}

# ---------------------------------------------------------------------------
# 3. assemble_rootfs
# ---------------------------------------------------------------------------
assemble_rootfs() {
  log "assembling the rootfs from $ROOTFS"
  rm -rf "$STAGE/rootfs-tree"
  mkdir -p "$STAGE/rootfs-tree"
  # ROOTFS is a base tree (sandbox toolchain, no per-run identity of any kind) that
  # this build layers the agent and init onto. It is copied, never mutated in place,
  # so a failed build never corrupts the caller's base image.
  cp -a "$ROOTFS/." "$STAGE/rootfs-tree/"
  mkdir -p "$STAGE/rootfs-tree/usr/local/bin" "$STAGE/rootfs-tree/sbin" \
    "$STAGE/rootfs-tree/tmp" "$STAGE/rootfs-tree/var" "$STAGE/rootfs-tree/workspace"
  install -m 0555 "$STAGE/agent" "$STAGE/rootfs-tree/usr/local/bin/agent"

  # A minimal init: mount the ephemeral filesystems every run needs writable, then
  # EXEC (not fork) the agent as PID 1 so the agent's own exit tears the VM down
  # instead of leaving an orphaned init for the next restore. /tmp and /var are
  # tmpfs so nothing a run writes there survives past this VM's destruction.
  cat >"$STAGE/rootfs-tree/sbin/init" <<'INIT'
#!/bin/sh
set -e
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t tmpfs -o mode=1777 tmpfs /tmp
mount -t tmpfs tmpfs /var

# Fix-round-4 item 1: the kernel hands init an essentially empty environment --
# no PATH at all. This script never needed one (every command above is called
# by absolute path), but the agent below resolves the commands it execs
# (bash, python3, curl, ...) by NAME via exec.LookPath, and an unset PATH makes
# every one of those fail to resolve even though the binary is sitting right
# there in the image. DO NOT DELETE THIS LINE: without it the agent still
# boots and parks in accept() -- the build looks successful -- but the first
# real Exec a user runs, and every one after it, fails "command not found"
# for a tool that is actually present, which gets diagnosed days later by
# someone with no reason to suspect init. List both the merged-/usr paths and
# the split /bin, /sbin paths so this init works on either kind of tree (this
# ROOTFS has /bin and /sbin symlinked into /usr, but that is a property of
# this base image, not something init should assume).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Fail loudly here rather than let a missing/non-executable agent binary reach
# `exec` and communicate only as a bare kernel panic ("Attempted to kill
# init!") with nothing on the console saying why. This is a different failure
# than the PATH bug above (the build never installed the agent at all) and
# deserves a different, explicit message.
if [ ! -x /usr/local/bin/agent ]; then
  echo "init: /usr/local/bin/agent is missing or not executable -- the" >&2
  echo "init: build did not install the guest agent into this rootfs" >&2
  exit 1
fi

exec /usr/local/bin/agent --listen vsock:1024 --workdir /workspace
INIT
  chmod 0555 "$STAGE/rootfs-tree/sbin/init"

  # A single ext4 image is what the VMM's block device backend wants; building it
  # here (rather than shipping a directory tree) is also what makes the "rootfs"
  # file hashable as one artifact in the manifest.
  local mb
  mb="$(du -sm "$STAGE/rootfs-tree" | cut -f1)"
  truncate -s "$((mb + 256))M" "$STAGE/rootfs"
  mkfs.ext4 -q -F -d "$STAGE/rootfs-tree" "$STAGE/rootfs"
}

# ---------------------------------------------------------------------------
# 4. boot_quiesce_snapshot
#
# guest_client.go is generated here rather than committed: it is a thin, one-shot
# wrapper around the ALREADY-EXPORTED guestagent framed-protocol primitives
# (WriteFrame/ReadFrame/Request/End — see internal/guestagent/protocol.go), so the
# wire format has exactly one implementation in this repo rather than a second,
# hand-rolled one in shell. It never becomes a repo file: cmd/guest-agent and
# internal/guestagent stay untouched, and this script is the only caller.
#
# Fix-round-3: the generated file is written under $AGENT_SRC (inside the module),
# not $STAGE. Go's internal-package rule keys off the IMPORTING FILE's own
# directory, not the process's working directory, so building from $STAGE via
# `cd "$AGENT_SRC" && go build .../$STAGE/guest_client.go` stayed illegal
# regardless of the cd -- $STAGE sits outside the module tree, so importing
# internal/guestagent from a file there is never allowed. The temp package
# directory is dot-prefixed so `go build ./...`, `go vet ./...`, and `gofmt -l .`
# (which this repo's own checks run) skip it even if cleanup below is somehow
# skipped, and its cleanup is armed (folded into the same EXIT trap $STAGE
# already uses) BEFORE the directory is created -- same discipline as
# fix-round-2 item A for the /dev bind mounts, because this directory lives
# inside the user's SOURCE TREE, not /tmp, so leaking it is worse than an
# ordinary $STAGE leak, and the script runs as root, so anything left behind
# would be root-owned in what is normally a non-root user's checkout.
# ---------------------------------------------------------------------------
write_guest_client() {
  local tmp_pkg="$AGENT_SRC/.build-snapshot-tmp-$$"
  # Fix-round-7 item 2: CLEANUP_EXTRA_DIR (script-scope, see cleanup_on_exit at
  # the top of the script) replaces what used to be a one-off
  # `trap '...' EXIT` embedding this function's own local $tmp_pkg. That
  # particular embedding happened to be safe (the value was baked into the trap
  # string literally, at arm time, not evaluated as a variable at fire time) --
  # but the pid-referencing traps elsewhere in this file were not safe, and
  # having two different trap idioms side by side was itself a hazard. One
  # mechanism for the whole file now.
  CLEANUP_EXTRA_DIR="$tmp_pkg"
  if ! mkdir -p "$tmp_pkg"; then
    echo "build-snapshot.sh: cannot create $tmp_pkg -- is --agent $AGENT_SRC" \
      "writable? (guest_client.go must be generated inside the module tree so its" \
      "internal/guestagent import is legal; see the comment above write_guest_client)" >&2
    exit 1
  fi
  cat >"$tmp_pkg/guest_client.go" <<'GOEOF'
// Command guest_client is a build-time-only helper: it speaks the same framed
// protocol internal/vmpool/guestconn.go speaks at serve time, but from a
// throwaway process instead of the pool, because build-snapshot.sh has no pool.
//
// Firecracker's and Cloud Hypervisor's Unix-socket vsock backends both proxy a
// host connection into the guest's listener on a fixed port via a one-line
// handshake: the host writes "CONNECT <port>\n" on the VMM-created Unix socket and,
// once the guest has accept()ed, the socket becomes a raw duplex stream to the
// guest side. That handshake is VMM-and-version-specific; verify it against the
// VMM's current vsock documentation when this runs for real (Task 12's KVM gate),
// since it cannot be exercised without a hypervisor.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	ga "github.com/rossoctl/moca/remote-worker/internal/guestagent"
)

func main() {
	uds := flag.String("uds", "", "path to the VMM's vsock unix socket")
	port := flag.Uint("port", 1024, "guest vsock port the agent listens on")
	command := flag.String("command", "", "command to run in the guest; empty means probe-only")
	timeoutS := flag.Uint("timeout-s", 30, "guest-side command timeout")
	probeOnly := flag.Bool("probe-only", false, "just prove the guest is accepting; run nothing")
	dialTimeout := flag.Duration("dial-timeout", 10*time.Second, "how long to wait for the CONNECT handshake")
	flag.Parse()

	if *uds == "" {
		fmt.Fprintln(os.Stderr, "guest_client: -uds is required")
		os.Exit(2)
	}

	conn, err := dialGuest(*uds, uint32(*port), *dialTimeout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "guest_client: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	if *probeOnly {
		return
	}

	req := ga.Request{Command: *command, TimeoutS: uint32(*timeoutS), CapBytes: ga.MaxFrame, HostUnixNanos: time.Now().UnixNano()}
	if err := ga.WriteJSON(conn, ga.KindRequest, req); err != nil {
		fmt.Fprintf(os.Stderr, "guest_client: send request: %v\n", err)
		os.Exit(1)
	}
	if err := ga.WriteFrame(conn, ga.KindStdinEOF, nil); err != nil {
		fmt.Fprintf(os.Stderr, "guest_client: send stdin-eof: %v\n", err)
		os.Exit(1)
	}

	for {
		kind, payload, err := ga.ReadFrame(conn)
		if err != nil {
			fmt.Fprintf(os.Stderr, "guest_client: read: %v\n", err)
			os.Exit(1)
		}
		switch kind {
		case ga.KindStdout:
			os.Stdout.Write(payload)
		case ga.KindStderr:
			os.Stderr.Write(payload)
		case ga.KindEnd:
			var e ga.End
			if err := json.Unmarshal(payload, &e); err != nil {
				fmt.Fprintf(os.Stderr, "guest_client: undecodable End: %v\n", err)
				os.Exit(1)
			}
			os.Exit(int(e.ExitCode))
		case ga.KindError:
			fmt.Fprintf(os.Stderr, "guest_client: guest error: %s\n", payload)
			os.Exit(1)
		}
	}
}

// dialGuest performs the VMM's vsock Unix-socket CONNECT handshake and returns the
// resulting stream. See the package comment for what is and is not verified here.
func dialGuest(uds string, port uint32, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.Dial("unix", uds)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", uds, err)
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, fmt.Errorf("send CONNECT: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	line, err := readLine(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read CONNECT ack: %w", err)
	}
	if !strings.HasPrefix(line, "OK") {
		conn.Close()
		return nil, fmt.Errorf("CONNECT %d refused: %q", port, line)
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, nil
}

func readLine(conn net.Conn) (string, error) {
	buf := make([]byte, 0, 64)
	one := make([]byte, 1)
	for {
		if _, err := conn.Read(one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return string(buf), nil
		}
		buf = append(buf, one[0])
	}
}
GOEOF
  (cd "$AGENT_SRC" && go build -o "$STAGE/guest_client" "$tmp_pkg/guest_client.go")
  rm -rf "$tmp_pkg"
  CLEANUP_EXTRA_DIR=""
}

# save_and_print_console_log copies $1 (a VMM's console log) to a
# $TMPDIR-rooted path that outlives this script's own cleanup, prints that
# saved path, and tails an excerpt directly to stderr so the reader does not
# have to go find it.
#
# Fix-round-4 item 2: $console_log lives under $STAGE (or a verify_root), and
# both are deleted by this script's own EXIT trap the instant a caller's
# `exit 1` runs -- so the ONLY artifact that explains why a VMM never came up
# was about to be destroyed by the same failure it would have diagnosed.
#
# Fix-round-11 item 2: originally this logic was inlined only in
# wait_for_agent's own timeout path. wait_for_socket's timeout path (fix-
# round-10) grew the identical need -- the coordinator's own rig failure (a
# broken jail binary that only wait_for_socket's timeout caught) could only be
# diagnosed by manually defeating this script's cleanup to read the console
# log, because wait_for_socket swallowed it instead of surrendering it. Rather
# than write a second, independent copy of this save/tail logic (exactly the
# "one implementation, N callers" mistake fix-rounds 9 and 10 already fixed
# for prepare_jail/teardown_jail and wait_for_socket itself), this was
# extracted here so both timeout paths call the same helper. Every place this
# script gives up waiting for something should surrender its evidence, not
# swallow it: a bounded timeout with no output is better than an unbounded
# hang, but it is still a failure that destroys what would explain it. Keep
# this whole helper off every success path: nobody wants a kernel log dumped
# on a good build.
save_and_print_console_log() {
  local console_log="$1"
  local saved_console="${TMPDIR:-/tmp}/build-snapshot-console-$$.log"
  if [ -f "$console_log" ]; then
    cp "$console_log" "$saved_console" 2>/dev/null || true
    echo "build-snapshot.sh: guest console log saved to $saved_console (survives this script's cleanup)" >&2
    echo "build-snapshot.sh: look there for 'Kernel panic', 'init:', or 'guest-agent: exec:' -- or an empty" \
      "file, which means the VMM itself never started" >&2
    echo "build-snapshot.sh: --- last 40 lines of the guest console ---" >&2
    tail -n 40 "$console_log" >&2
    echo "build-snapshot.sh: --- end of guest console excerpt ---" >&2
  else
    echo "build-snapshot.sh: no guest console log exists at $console_log --" \
      "the VMM itself likely never started" >&2
  fi
}

wait_for_agent() {
  local uds="$1" console_log="$2"
  log "waiting for the guest agent to park in accept()"
  local waited=0
  while [ "$waited" -lt 120 ]; do
    if [ -f "$console_log" ] && grep -q "parked in accept()" "$console_log" 2>/dev/null; then
      return 0
    fi
    if "$STAGE/guest_client" -uds "$uds" -port 1024 -probe-only -dial-timeout 1s 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  save_and_print_console_log "$console_log"
  echo "build-snapshot.sh: guest agent never became reachable on vsock:1024 within 120s" >&2
  exit 1
}

# probe_capabilities asks the ALREADY-BOOTED guest what its sandboxed toolchain can
# do, so the manifest advertises exactly what this rootfs carries rather than a
# hand-maintained guess that drifts from the image (spec §5.5).
probe_capabilities() {
  local uds="$1"
  local out
  out="$("$STAGE/guest_client" -uds "$uds" -port 1024 -timeout-s 10 \
    -command 'for c in python3 node git ripgrep rg curl; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done' \
    2>/dev/null || true)"
  printf '%s\n' "$out" | sed '/^$/d' | sort -u
}

quiesce_guest() {
  local uds="$1"
  log "quiescing the guest before snapshotting"
  "$STAGE/guest_client" -uds "$uds" -port 1024 -timeout-s 10 -command 'sync' >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Jail helpers (fix-round items 1, 2, 9): both VMM arms boot and restore
# chrooted into a directory whose ONLY structure is the fixed, jail-relative
# basenames baked into their configs -- /kernel, /rootfs, /workspace.img,
# /vsock.sock, /run/<api-sock> -- because that is the one thing that makes a
# recorded path still resolve after the process that recorded it, and the
# directory it was chrooted into, are both gone. This is not invented here: it
# is remote-worker/internal/vmpool/launcher_firecracker.go's own jailer
# convention (apiSockRelPath, vsockRelPath, the fileVMState/fileMemory/
# fileKernel/fileRootfs/fileAgent hardlink set, workspace.img), copied
# verbatim rather than re-derived, per this round's own instruction that the
# launcher wins on any disagreement. No disagreement was found.
# ---------------------------------------------------------------------------

# DefaultWorkspaceImageBytes in launcher_firecracker.go: 2 GiB, "matches the
# brief's own test fixtures". Kept identical here so a golden snapshot built
# by this script presents the guest the same /dev/vdb capacity the production
# launcher's lazily-created workspace.img would.
WORKSPACE_IMAGE_BYTES=$((2 * 1024 * 1024 * 1024))

require_root() {
  # Item 4: the API socket either VMM creates is root-owned the moment the VMM
  # creates it, and both boot/verify paths now chroot and bind-mount /dev/kvm
  # into a jail -- both need root. Failing loudly here beats failing confusingly
  # at the first `curl --unix-socket`/`mount --bind` permission error.
  if [ "$(id -u)" -ne 0 ]; then
    echo "build-snapshot.sh: must run as root (needed for chroot, mount --bind" >&2
    echo "  /dev/kvm, and the VMM's own root-owned API socket)" >&2
    exit 1
  fi
}

# api_request issues an HTTP request with method $1 and JSON body $4 to path $3
# on the VMM's Unix-socket API $2, and treats a transport failure OR a non-2xx
# response as fatal (item 4). The previous form (`curl -s ... >/dev/null`)
# swallowed both kinds of failure and let the build limp on to a snapshot
# silently missing whatever the call configured. api_put and api_patch below are
# both thin wrappers around this single copy of that status-checking logic --
# duplicating it per-verb would let the two copies drift.
api_request() {
  local method="$1" sock="$2" path="$3" body="$4" resp status
  resp="$(curl -s -S --unix-socket "$sock" -w '\n%{http_code}' -X "$method" "http://localhost${path}" -d "$body")" || {
    echo "build-snapshot.sh: $method $path: curl could not reach $sock" >&2
    exit 1
  }
  status="${resp##*$'\n'}"
  case "$status" in
    2??) ;;
    *)
      echo "build-snapshot.sh: $method $path returned HTTP $status: ${resp%$'\n'*}" >&2
      exit 1
      ;;
  esac
}

# api_put creates/sets a resource -- Firecracker's convention for everything
# configured before or during boot (/boot-source, /drives/{id} pre-boot, /vsock,
# /machine-config pre-boot, /actions, /snapshot/create, /snapshot/load), and
# cloud-hypervisor's convention uniformly (its RPC-style API has no PATCH verb
# at all, e.g. /api/v1/vm.restore).
api_put() {
  api_request PUT "$1" "$2" "$3"
}

# api_patch updates an EXISTING resource's state -- Firecracker's convention for
# everything that acts on an already-running VM. /vm is PATCH-only: Firecracker
# defines no PUT method for it at all. Confirmed against the real v1.17.0 binary:
# `PUT /vm` returns HTTP 400 "Invalid request method and/or path: PUT vm.", while
# `PATCH /vm` (even pre-boot, so it fails for an unrelated reason) returns "The
# requested operation is not supported before starting the microVM." -- a state
# complaint, proving PATCH is the method the route actually accepts.
api_patch() {
  api_request PATCH "$1" "$2" "$3"
}

# Fix-round-10: wait_for_socket is the one place that waits for a just-started
# VMM's API socket to actually be accept()ing connections. Call it right after
# backgrounding the VMM (right after CLEANUP_PID is set) and before the very first
# api_put/api_patch/ch-remote call in ALL FOUR functions that start a VMM
# (boot_quiesce_snapshot_firecracker, boot_quiesce_snapshot_cloud_hypervisor,
# verify_restore_firecracker, verify_restore_cloud_hypervisor) -- one
# implementation, four callers, no room to drift, same shape as prepare_jail/
# teardown_jail above.
#
# THE BUG this fixes: nothing sat between "VMM process started" and "first API
# call" in any of the four call sites. cloud-hypervisor lost that race every
# time on the rig -- curl: (7) Failed to connect to ... after 0 ms: Could not
# connect to server -- because verify_restore_cloud_hypervisor's own
# link_snapshot_file staging all happens BEFORE the chroot, so api_put is the
# very next statement after CLEANUP_PID is set. verify_restore_firecracker only
# happened to pass: it has several statements (link_snapshot_file x3,
# ensure_workspace_image) between backgrounding firecracker and its first
# api_put, and firecracker itself binds its socket unusually fast (probe: ~4e-4s)
# -- FC was winning a race by statement order and daemon speed, not by design.
# Both arms are racy; only one of them had been losing yet.
#
# THE SHAPE mirrors remote-worker/internal/vmpool/launcher_firecracker.go's own
# waitForUnixSocket (see its comment: "File existence alone is not enough:
# Firecracker creates the socket file before it is actually accept()ing on
# it"), per this round's own instruction that the launcher wins whenever it and
# this script disagree. That comment is why this helper does NOT check
# `[ -e "$sock" ]` -- a bare existence check would still race, for exactly the
# reason the launcher's comment gives, and cloud-hypervisor's rig failure is
# independent confirmation: its socket file exists (srwx------ root root)
# immediately, well before curl can talk to it. This helper instead attempts a
# REAL connection with curl (the same tool and the same --unix-socket mechanism
# every other API call in this script already uses, so this is not a second
# code path for talking to these sockets, just an earlier, throwaway use of the
# first one) and only returns once curl can complete a round trip. Any HTTP
# response counts as success (no -f) -- even a 404 proves the daemon is
# accept()ing, which is the only thing this helper is asked to prove; a
# connection-refused/no-such-socket curl exit (7) is the failure this loop
# polls past.
#
# No fixed `sleep $N`: a fixed delay is either wasted time on an idle host
# (this round's probe: firecracker bound in ~0.0004s) or too short on a loaded
# one (cloud-hypervisor's rig failure), and either way a fixed sleep reports
# nothing when it guesses wrong -- it just moves the same unguarded race a few
# hundred milliseconds later and calls it fixed. Poll on a short, bounded
# interval instead, and fail loudly -- naming the socket path and the elapsed
# timeout bound, not a bare "curl: (7)" -- if the deadline passes.
#
# Noted, not acted on: cloud-hypervisor's socket is mode 0700 versus
# firecracker's 0755 (both root:root). Harmless here -- require_root already
# guarantees this whole script, including this curl, runs as root -- but
# worth recording so a future reader porting this probe to run as a
# non-root/different-uid caller does not get a silent EACCES and mistake it
# for the daemon simply not being up yet.
wait_for_socket() {
  local sock="$1" console_log="$2" timeout_s="${3:-5}" proto="${4:-http}"
  # 100ms poll interval -> timeout_s * 10 attempts.
  local attempts=$((timeout_s * 10))
  local i=0
  # Fix-round-12: added the "raw" proto for virtiofsd's vhost-user socket, which
  # does not speak HTTP the way the firecracker/cloud-hypervisor API sockets do
  # (all 3 pre-existing call sites are unaffected -- they omit $4 and keep
  # getting "http", unchanged). "raw" only checks that the socket file exists
  # and is a socket (`[ -S ]`), the same protocol-agnostic check
  # launcher_firecracker.go's own waitForUnixSocket does with a raw
  # net.DialTimeout -- a plain existence check is weaker than an actual connect,
  # but this host has no guaranteed nc/socat/python3 to dial a vhost-user socket
  # with, and virtiofsd creates the socket file only once it is ready to accept
  # the vhost-user handshake, so existence is already the meaningful signal.
  while [ "$i" -lt "$attempts" ]; do
    case "$proto" in
      raw)
        if [ -S "$sock" ]; then
          return 0
        fi
        ;;
      *)
        if curl -s -S --unix-socket "$sock" -o /dev/null "http://localhost/" 2>/dev/null; then
          return 0
        fi
        ;;
    esac
    i=$((i + 1))
    sleep 0.1
  done
  # Fix-round-11 item 2: this timeout path used to swallow the VMM's console
  # log exactly the way wait_for_agent's did before fix-round-4 fixed it there
  # -- and it has now cost a real diagnosis: the coordinator's own rig hit
  # this exact timeout (a jail binary that chroot could not execve -- see
  # hardlink_or_copy_bin's own fix-round-11 comment) and could only read the
  # console log by manually defeating this script's cleanup, because this
  # function was throwing it away. save_and_print_console_log (see its own
  # comment, next to wait_for_agent) is reused here rather than reimplemented.
  save_and_print_console_log "$console_log"
  echo "build-snapshot.sh: timed out after ${timeout_s}s waiting for $sock to accept connections" >&2
  exit 1
}

# hardlink_or_copy_bin resolves $1 on PATH and hardlinks (falling back to a copy
# across filesystems) it into $2, so a chrooted VMM process can execve it from
# inside its own jail -- chroot resolves the command it execs AFTER changing
# root, so the binary must physically exist inside the jail, not just on $PATH.
hardlink_or_copy_bin() {
  local name="$1" dst="$2" src resolved
  src="$(command -v "$name")" || {
    echo "build-snapshot.sh: $name not found on PATH" >&2
    exit 1
  }
  # Fix-round-11: resolve $src to its real, non-symlink target BEFORE linking
  # or copying it. GNU `ln SRC DST` hardlinks whatever inode SRC names -- if
  # SRC is itself a symlink (an entirely ordinary shape: Debian's alternatives
  # system makes /usr/bin/<tool> a symlink into /etc/alternatives/, versioned
  # installs and package managers do the same, and so does a maintainer's own
  # `ln -s` housekeeping, which is exactly how this broke on the coordinator's
  # rig), the hardlink duplicates the SYMLINK, not its target -- `readlink
  # $dst` inside the jail still shows the original target path, which does
  # not exist inside the chroot. The jail then looks correct in a plain `ls`
  # (the entry is right there) but chroot's own execve fails with a confusing
  # "No such file or directory" about a file that is plainly present in the
  # listing. `realpath -e` (not `readlink -f`) is used deliberately: -e
  # requires the resolved target to actually exist, so a dangling symlink
  # fails LOUDLY right here, at the actual bug, instead of producing a jail
  # that only fails later, much less clearly, at chroot.
  resolved="$(realpath -e "$src")" || {
    echo "build-snapshot.sh: $name resolved via PATH to $src, but that could not be" \
      "resolved to an existing file (broken/dangling symlink?)" >&2
    exit 1
  }
  if [ ! -x "$resolved" ]; then
    echo "build-snapshot.sh: $name resolved to $resolved, which is not executable" >&2
    exit 1
  fi
  rm -f "$dst"
  ln "$resolved" "$dst" 2>/dev/null || cp -p "$resolved" "$dst"
  chmod 0555 "$dst"
}

# jail_mount_dev bind-mounts /dev/kvm (mandatory -- the VMM cannot start without
# it) and /dev/urandom (best-effort) into $1/dev, so a process chrooted into $1
# can still reach them by their normal absolute device paths.
jail_mount_dev() {
  local jail="$1"
  mkdir -p "$jail/dev"
  : >"$jail/dev/kvm"
  if ! mount --bind /dev/kvm "$jail/dev/kvm"; then
    echo "build-snapshot.sh: could not bind-mount /dev/kvm into the jail at $jail" >&2
    exit 1
  fi
  : >"$jail/dev/urandom" 2>/dev/null || true
  mount --bind /dev/urandom "$jail/dev/urandom" 2>/dev/null || true
}

# jail_unmount_dev is the inverse of jail_mount_dev, and MUST run before rm -rf on
# the jail: an active bind mount is a live mountpoint, and rm -rf through one
# fails (or worse, on some setups silently no-ops) rather than actually clearing
# the directory. Best-effort and safe to call even if nothing was mounted.
jail_unmount_dev() {
  local jail="$1"
  umount "$jail/dev/urandom" 2>/dev/null || true
  umount "$jail/dev/kvm" 2>/dev/null || true
}

# Fix-round-9: prepare_jail is the one place that builds a jail skeleton --
# $jail/run plus any caller-supplied extra directories (e.g. cloud-hypervisor's
# $jail/ch-snapshot, which ch-remote snapshot/restore require to already exist),
# the chrooted binary itself, and the device bind-mounts -- so the four build/
# verify functions can no longer retype this sequence and drift apart on it the
# way boot_quiesce_snapshot_cloud_hypervisor and verify_restore_cloud_hypervisor
# did (the build arm never created $jail/ch-snapshot; the verify arm did).
# Sets CLEANUP_JAIL so the EXIT trap can still unmount/remove on early failure.
prepare_jail() {
  local bin="$1" jail="$2"
  shift 2
  mkdir -p "$jail/run" "$@"
  hardlink_or_copy_bin "$bin" "$jail/$bin"
  CLEANUP_JAIL="$jail"
  jail_mount_dev "$jail"
}

# Fix-round-9: teardown_jail is prepare_jail's inverse -- stop the backgrounded
# VMM process (if one was started; CLEANUP_PID may be empty on an early-failure
# path, so kill/wait are best-effort) and unmount the jail's device bind mounts.
# It does NOT remove the jail directory itself: build functions leave $STAGE for
# write_manifest/lock_down to read from, and verify functions separately call
# rm_rf_jail on their own verify_root. Clears CLEANUP_PID/CLEANUP_JAIL so the
# EXIT trap does not redo work this function already did.
#
# Fix-round-10: also removes any "$jail/run"/*.sock.lock left behind. Cloud
# Hypervisor creates a <socket>.lock file right next to its API socket
# (confirmed on the rig: probe.sock and probe.sock.lock together); Firecracker
# creates no such file, so this glob is a no-op for that arm rather than
# something that needs its own VMM-specific branch. A stale .lock blocking a
# later restart (the project's own cloud-hypervisor tutorial documents that
# failure shape for a stale UDS on sequential restores) is not actually a live
# risk FOR THIS SCRIPT: every jail this script ever chroots into lives under a
# freshly mktemp'd directory (STAGE itself, or new_verify_dir's per-call
# verify_root), never reused across runs or even across calls within one run,
# so there is no directory a previous run's .lock could still be sitting in
# when the next chroot starts. Removing it here is still correct hygiene --
# nothing should assume a launcher_chv.go-style long-lived VMM host, which DOES
# reuse jail paths, will get the same freshness for free -- and it is one line
# to not have to reason about again per VMM arm.
teardown_jail() {
  local jail="$1"
  kill "$CLEANUP_PID" 2>/dev/null || true
  wait "$CLEANUP_PID" 2>/dev/null || true
  CLEANUP_PID=""
  jail_unmount_dev "$jail"
  rm -f "$jail"/run/*.sock.lock
  CLEANUP_JAIL=""
}

# Fix-round-12: shared by boot_quiesce_snapshot_cloud_hypervisor and
# verify_restore_cloud_hypervisor (one implementation, N callers -- same
# principle as prepare_jail/teardown_jail, wait_for_socket, and
# save_and_print_console_log before it), rather than duplicating this
# start/wait dance inline in both places.
#
# This is a BUILD-TIME virtiofsd, not the runtime one launcher_chv.go starts
# per-run: it exists only so the golden snapshot's config.json (baked by
# --fs, at the cloud-hypervisor invocation right after this call returns) has
# a real virtio-fs device attached when cloud-hypervisor snapshots it. It
# does NOT need to be the SAME virtiofsd process a real restore later talks
# to -- launcher_chv.go's rewriteSnapshotConfig rewrites fs[].socket (never
# fs[].tag) to point at whatever fresh virtiofsd IT starts at actual restore
# time. Only the device and its tag need to survive into the snapshot; the
# socket path baked in here is jail-relative and gone with this jail.
#
# Unlike the cloud-hypervisor/firecracker binaries, virtiofsd is never
# hardlinked into the jail via hardlink_or_copy_bin: it is not chrooted at
# all. It runs as an ordinary host process serving $jail/workspace over a
# UDS that the chrooted cloud-hypervisor (started by the caller, right after
# this function returns) connects to as a vhost-user CLIENT -- so it only
# needs to resolve on PATH, the same bare-name-via-command-v convention this
# script already uses for firecracker/cloud-hypervisor, not the fixed
# /usr/libexec/virtiofsd default main.go's runtime flags fall back to.
#
# Runs as whatever this whole (already require_root'd) script runs as,
# deliberately NOT privilege-dropped the way launcher_chv.go's runtime
# virtiofsd is required to be (CHVOptions.validate() rejects UID/GID 0
# there): that requirement exists to confine a MULTI-TENANT restore path
# against a real per-run workspace directory. This build has exactly one
# tenant -- itself -- so there is no second party here to confine against.
# --sandbox=namespace (never --sandbox=none, which the plan doc rules out
# outright) and --cache=never (not --cache=auto, which the installed
# virtiofsd build disconnects the virtio-fs session under almost immediately
# -- see launcher_chv_test.go's own TestVirtiofsdArgvCarriesItsSandbox and its
# fix-round comment) match the runtime virtiofsd's own argv choices exactly;
# only the privilege and jail/chroot treatment differ, and both differences
# are explained above.
start_workspace_virtiofsd() {
  local jail="$1" console_log="$2"
  local workspace_dir="$jail/workspace" sock="$jail/fs.sock"
  command -v virtiofsd >/dev/null 2>&1 || {
    echo "build-snapshot.sh: virtiofsd not found on PATH (required to bake a" >&2
    echo "  virtio-fs device into a --vmm cloud-hypervisor golden snapshot)" >&2
    exit 1
  }
  mkdir -p "$workspace_dir"
  rm -f "$sock"
  virtiofsd \
    --socket-path="$sock" \
    --shared-dir="$workspace_dir" \
    --sandbox=namespace \
    --cache=never \
    </dev/null >/dev/null 2>&1 &
  CLEANUP_FS_PID=$!
  # "raw" proto: virtiofsd's vhost-user socket does not speak HTTP the way the
  # firecracker/cloud-hypervisor API sockets wait_for_socket's other three
  # call sites wait on do. See wait_for_socket's own fix-round-12 comment.
  wait_for_socket "$sock" "$console_log" 5 raw
}

# Paired with start_workspace_virtiofsd above. Ordering is the caller's
# responsibility, not this function's: cloud-hypervisor (the vhost-user
# MASTER, connecting to virtiofsd's socket at its own startup) must be torn
# down FIRST, virtiofsd (the vhost-user server) second -- the exact reverse of
# start order, and the same "VMM first, then virtiofsd" order
# launcher_chv.go's own Destroy already uses at real restore time. Both call
# sites below call teardown_jail (which reaps CLEANUP_PID, the VMM) before
# calling this function, never the other way around.
teardown_virtiofsd() {
  kill "${CLEANUP_FS_PID:-}" 2>/dev/null || true
  wait "${CLEANUP_FS_PID:-}" 2>/dev/null || true
  CLEANUP_FS_PID=""
}

# rm_rf_jail is a GUARDED rm -rf: before removing any of $@, it checks the host's
# live mount table (/proc/mounts -- no `mountpoint`/`findmnt` binary required,
# and this whole script is already Linux/KVM-only) and refuses, loudly, if
# anything is still mounted at or under one of them, rather than silently
# recursing rm -rf through a live mountpoint.
#
# Fix-round-5 item 2: today the only bind mounts under a jail are the two device
# nodes jail_mount_dev creates, so a leftover mount here means jail_unmount_dev
# ran too early (or failed) and the blast radius is a failed rm printing "Device
# or resource busy" -- annoying, but not destructive. The shape of the bug is one
# small change away from being destructive, though: if a directory (rather than
# a bare device node) were ever bind-mounted into a jail and its unmount call
# silently failed (jail_unmount_dev's umounts are deliberately best-effort, `||
# true`), `rm -rf` would recurse straight through the mount and delete whatever
# is on the other side of it -- the operator's own files, not the jail's. This
# check is written generically (against the live mount table, not against the
# two device-node paths by name) precisely so it keeps covering that case too.
rm_rf_jail() {
  local dir leftover
  for dir in "$@"; do
    leftover="$(awk -v d="$dir" '$2 == d || index($2, d "/") == 1 {print $2}' /proc/mounts)"
    if [ -n "$leftover" ]; then
      echo "build-snapshot.sh: refusing to rm -rf $dir: still mounted under it:" >&2
      echo "$leftover" >&2
      return 1
    fi
  done
  rm -rf "$@"
}

# new_verify_dir creates a fresh directory ON THE SAME DEVICE AS $OUT -- a
# SIBLING of $OUT, not a subdirectory of it -- so that link_snapshot_file below
# can hard-link the sealed snapshot's own files into the verify jail instead of
# copying them. $PENDING, which is what verify_restore actually links out of,
# is a sibling of $OUT too and therefore on that same device; it is locked
# read-only by lock_down before verify_restore ever runs, so nothing writes
# inside it either.
#
# Fix-round-7 item 1: the verify jail used to nest under $STAGE, which lives
# under ${TMPDIR:-/tmp} -- tmpfs on the rig -- while $OUT is normally on
# persistent disk. ln(1) between two different filesystems always fails EXDEV
# ("Invalid cross-device link") no matter what permissions say, and this path
# had never executed against a real disk-backed $OUT before this round, which
# is why it surfaced only now, in verify, not in the boot/snapshot phase (whose
# jail *is* $STAGE, and never links anything in from $OUT). A sibling of $OUT is
# still a different absolute path than the one the golden snapshot was built
# under, so this does not weaken the portability guarantee verify_restore
# exists to check -- only the DEVICE needs to match $OUT's, not the directory.
new_verify_dir() {
  local base
  base="$(dirname "$OUT")"
  mktemp -d "$base/.build-snapshot-verify.XXXXXX"
}

# link_snapshot_file hard-links $1 (a file inside $PENDING, i.e. a component of
# the golden snapshot just sealed by lock_down and not yet published to $OUT)
# into $2. Deliberately NOT the same
# shape as hardlink_or_copy_bin: that helper's quiet cp fallback is fine for the
# firecracker/cloud-hypervisor binaries it places (small, and a cross-device
# fallback there is the normal, expected case on most hosts), but is NOT fine
# here. $1 and $2 are arranged (see new_verify_dir) to share a device precisely
# so this ln always succeeds without copying, because one of these files
# (memfile) is the guest's ENTIRE RAM image, sized by --guest-ram-mb -- a silent
# copy fallback would turn "verify a hard link" into "duplicate a whole guest's
# memory into host RAM" on exactly the resource this design rations (spec's
# whole premise, and the thing Task 21's density measurements will be counting).
# If ln still fails -- a host where $OUT's own device genuinely cannot be shared
# with a sibling directory, e.g. --out pointed at something that does not
# support hard links at all -- fall back to a copy, but say so LOUDLY: a quiet
# success here is exactly the kind of thing that gets diagnosed as a mysterious
# memory ceiling three weeks later, not today, by someone with no reason to
# suspect this script.
link_snapshot_file() {
  local src="$1" dst="$2"
  if ln "$src" "$dst" 2>/dev/null; then
    return 0
  fi
  echo "build-snapshot.sh: WARNING: could not hard-link $src -> $dst (cross-device," >&2
  echo "  or a filesystem without hard-link support) -- COPYING instead. This" >&2
  echo "  duplicates the file's full bytes onto $(dirname "$dst")'s filesystem; for" >&2
  echo "  memfile that is the ENTIRE guest RAM image (guest_ram_mb=$GUEST_RAM_MB)," >&2
  echo "  consuming that much additional host disk/RAM on top of the original copy" >&2
  echo "  in \$OUT. See build-snapshot.sh's fix-round-7 item 1 for why this is a" >&2
  echo "  last-resort fallback, not the normal path." >&2
  cp -p "$src" "$dst"
}

# ensure_workspace_image creates $1 as a sparse ext4 filesystem of
# WORKSPACE_IMAGE_BYTES -- the exact recipe (truncate, then mkfs.ext4 -F) of
# launcher_firecracker.go's ensureWorkspaceImage, so the golden snapshot's second
# drive is byte-for-byte the kind of image the production launcher creates.
ensure_workspace_image() {
  local path="$1"
  truncate -s "$WORKSPACE_IMAGE_BYTES" "$path"
  mkfs.ext4 -q -F "$path" >/dev/null
}

boot_quiesce_snapshot_firecracker() {
  local jail="$STAGE"
  local api_sock="$jail/run/firecracker.socket" vsock_uds="$jail/vsock.sock" console_log="$STAGE/console.log"
  log "preparing the firecracker build jail at $jail (items 1, 2: jail-relative paths only)"
  # Fix-round-9: jail skeleton (mkdir, binary staging, CLEANUP_JAIL, device
  # bind-mounts) now lives in the shared prepare_jail helper -- see its
  # definition, next to jail_mount_dev, for why (this is the same sequence
  # verify_restore_firecracker needs, and retyping it independently is exactly
  # how build and verify drifted apart in fix-rounds 8 and 9). The firecracker
  # arm passes no extra directories: its only per-run storage is the workspace
  # drive below, not a directory ch-remote-style tool needs pre-created.
  prepare_jail firecracker "$jail"
  # Item 2: a second, non-root, read-write drive so a restored VM has something
  # for the per-run workspace to mount -- launcher_firecracker.go's Restore hard-
  # links a workspace.img into every jail at this exact path expecting the golden
  # snapshot to already have a matching drive configured; without one there is no
  # PUT /drives/workspace at restore time (Firecracker's snapshot/load has no such
  # call), so the drive has to already exist in the snapshotted config.
  #
  # Deliberate build-vs-verify asymmetry (not drift): verify_restore_firecracker
  # does NOT call ensure_workspace_image again here. It links the SAME
  # workspace.img this call produces (via link_snapshot_file) into the verify
  # jail instead of building a fresh one, because launcher_firecracker.go's
  # Restore path expects the golden snapshot's own workspace drive file to be
  # present byte-for-byte, not a freshly-formatted lookalike.
  ensure_workspace_image "$jail/workspace.img"

  log "starting firecracker chrooted into $jail ($api_sock)"
  # Item 3: stdin redirected -- a backgrounded VMM that inherits this script's
  # controlling terminal can be sent SIGTTIN and hang forever the moment it
  # touches stdin, indistinguishable from a slow boot from the outside.
  chroot "$jail" /firecracker --api-sock /run/firecracker.socket \
    </dev/null >"$console_log" 2>&1 &
  CLEANUP_PID=$!

  # Fix-round-10: wait for the API socket to actually accept connections before
  # the very first api_put below -- see wait_for_socket's own comment for why
  # this was missing on both VMM arms and why FC's own speed, not correctness,
  # is the only reason this call site had not yet been seen to lose the race.
  wait_for_socket "$api_sock" "$console_log"

  # Item 1: kernel_image_path and the rootfs drive's path_on_host are now
  # jail-relative ("/kernel", "/rootfs"), exactly like launcher_firecracker.go's
  # own hardlink set -- not "$STAGE/kernel"/"$STAGE/rootfs", which is this bug in
  # the first place: $STAGE is deleted by this script's own EXIT trap the moment
  # the build finishes, and every subsequent LoadSnapshot would fail.
  #
  # Deliberate build-vs-verify asymmetry (not drift, and NOT to be copied): this
  # whole block -- boot-source, both drives, vsock, machine-config, InstanceStart
  # -- configures a FRESH BOOT's resources. verify_restore_firecracker below
  # must NOT call any of these: a restored VM's boot-source/drives/vsock/machine-
  # config all come back out of the snapshot itself via the single
  # /snapshot/load call, and re-declaring them before or after that call is
  # rejected by the real binary (fix-round-8's rig failure: a stray PUT /vsock
  # copied from here into the verify function, forbidden before a restore).
  # `ro` is required alongside the read-only rootfs drive below. Without it the kernel
  # mounts its root rw by default, and a rw mount of a read-only block device fails --
  # which surfaces as an early boot failure, not as a clear message. With it the kernel
  # mounts ro and init's tmpfs mounts supply every writable path the guest needs.
  api_put "$api_sock" /boot-source \
    "{\"kernel_image_path\":\"/kernel\",\"boot_args\":\"console=ttyS0 ro reboot=k panic=1 pci=off\"}"
  # is_read_only TRUE. A writable root device silently CORRUPTS THIS SNAPSHOT: the
  # launcher hardlinks the golden rootfs into every jail (os.Link, one shared inode), so
  # anything the guest writes to /dev/vda lands on the golden file itself. Measured on the
  # rig -- an Exec whose command was literally `true` changed the rootfs hash, because
  # merely MOUNTING ext4 rw rewrites the superblock's mount count and last-mount time.
  # After that, microvm-worker's own Manifest.Verify refuses to start ("rootfs drifted"),
  # which is how this was found, and vmpoolctl (which had no such check until this change)
  # went on measuring against a mutating image.
  #
  # Nothing legitimate is lost. sbin/init mounts tmpfs on /tmp and /var (see assemble_
  # rootfs) so everything a run writes there is ephemeral by design, and /workspace is a
  # SEPARATE rw drive. The Cloud Hypervisor path in this same script already passed
  # `readonly=on` for its rootfs -- this makes the Firecracker arm agree with it.
  api_put "$api_sock" /drives/rootfs \
    "{\"drive_id\":\"rootfs\",\"path_on_host\":\"/rootfs\",\"is_root_device\":true,\"is_read_only\":true}"
  api_put "$api_sock" /drives/workspace \
    "{\"drive_id\":\"workspace\",\"path_on_host\":\"/workspace.img\",\"is_root_device\":false,\"is_read_only\":false}"
  api_put "$api_sock" /vsock \
    "{\"vsock_id\":\"vsock0\",\"guest_cid\":3,\"uds_path\":\"/vsock.sock\"}"
  api_put "$api_sock" /machine-config \
    "{\"mem_size_mib\":$GUEST_RAM_MB,\"vcpu_count\":1}"
  api_put "$api_sock" /actions '{"action_type":"InstanceStart"}'

  wait_for_agent "$vsock_uds" "$console_log"
  MANIFEST_CAPABILITIES="$(probe_capabilities "$vsock_uds")"
  quiesce_guest "$vsock_uds"

  log "snapshotting (PATCH /vm to pause, then PUT /snapshot/create; the VM stays paused because create has no resume field at all)"
  # Fix-round-5 item 1: /vm has no PUT method in Firecracker's own spec -- see the
  # api_patch comment above for the real-binary evidence that settled this.
  api_patch "$api_sock" /vm '{"state":"Paused"}'
  # Fix-round-6 item 1: resume_vm belongs to /snapshot/load's SnapshotLoadParams, not
  # /snapshot/create's SnapshotCreateParams -- confirmed against v1.17.0's own
  # firecracker.yaml, whose SnapshotCreateParams accepts only snapshot_path,
  # mem_file_path, snapshot_type and sync_snapshot_files, and against the real
  # binary's error text when this was run on the rig: "unknown field `resume_vm`,
  # expected one of `snapshot_type`, `snapshot_path`, `mem_file_path`,
  # `sync_snapshot_files`". The invariant this field used to spell out ("don't
  # resume after snapshotting") is not lost by removing it: the VM is already
  # paused by the PATCH /vm above, and /snapshot/create has no code path that
  # would resume it -- resuming is something ONLY /snapshot/load's own resume_vm
  # can do, on the restore side, not here.
  api_put "$api_sock" /snapshot/create \
    "{\"snapshot_path\":\"/vmstate\",\"mem_file_path\":\"/memfile\",\"snapshot_type\":\"Full\"}"

  teardown_jail "$jail"
}

boot_quiesce_snapshot_cloud_hypervisor() {
  local jail="$STAGE"
  local api_sock="$jail/run/ch-api.sock" vsock_uds="$jail/vsock.sock" console_log="$STAGE/console.log"
  log "preparing the cloud-hypervisor build jail at $jail (item 9: same jail-relative convention as the firecracker arm)"
  # Fix-round-9 BUG FIX: this call now passes "$jail/ch-snapshot" as an extra
  # directory for prepare_jail to mkdir -p, matching verify_restore_cloud_
  # hypervisor's call below. Previously this function only did `mkdir -p
  # "$jail/run"` and never created ch-snapshot, so `ch-remote snapshot
  # "file:///ch-snapshot"` further down failed on real hardware with "Destination
  # is not a directory: \"/ch-snapshot\"" -- the verify arm got this right and
  # the build arm, which runs first, did not. Routing both calls through
  # prepare_jail (see its definition, next to jail_mount_dev) means the two
  # functions now share one call pattern for this directory instead of each
  # retyping mkdir independently, which is what let them drift apart the first
  # time.
  #
  # Deliberate build-vs-verify asymmetry (not drift): this arm never calls
  # ensure_workspace_image, unlike the firecracker arm above. Cloud Hypervisor's
  # per-run workspace is NOT a block-device drive at all -- launcher_chv.go
  # serves it over virtio-fs via a separate virtiofsd daemon pointed at the
  # run's WorkspaceDir, so there is no workspace.img file for this script to
  # create or for the golden snapshot to embed. Neither the build nor the
  # verify function for cloud-hypervisor stages a workspace image; that part
  # of the original symmetry claim still holds.
  #
  # Fix-round-12: what is NOT symmetric with the firecracker arm any more is
  # whether a workspace-serving device exists in the golden snapshot at all.
  # Before this round, boot_quiesce_snapshot_cloud_hypervisor never passed
  # --fs to cloud-hypervisor, so the snapshot's config.json had no virtio-fs
  # device, and a restored guest's /workspace was empty -- the two §8 gates
  # this fix-round exists to close (TestGateWriteDurability,
  # TestGateNoCrossRunBleed). "$jail/workspace" is now an extra prepare_jail
  # directory (parallel to "$jail/ch-snapshot") for start_workspace_virtiofsd,
  # below, to serve.
  prepare_jail cloud-hypervisor "$jail" "$jail/ch-snapshot" "$jail/workspace"

  # Fix-round-12: virtiofsd must be up and its socket confirmed live BEFORE
  # cloud-hypervisor starts -- cloud-hypervisor is virtio-fs's vhost-user
  # MASTER and connects to virtiofsd's socket at its OWN startup (confirmed
  # against launcher_chv.go's own restore-path ordering: fsCmd.Start(), then
  # waitForUnixSocket on the fs socket, THEN vmmCmd.Start()). See
  # start_workspace_virtiofsd's own comment for what this build-time daemon
  # is for and is not for.
  start_workspace_virtiofsd "$jail" "$console_log"

  log "starting cloud-hypervisor chrooted into $jail ($api_sock)"
  # Item 7: Cloud Hypervisor has no is_root_device-style flag the way Firecracker
  # does -- without an explicit root= the guest kernel panics looking for its root
  # device (docs/notes/cloud-hypervisor-tutorial.md, hands-on reproduced there).
  # pci=off is Firecracker's own arg (its virtio devices are MMIO-only) and is
  # deliberately DROPPED here: Cloud Hypervisor's virtio devices default to the
  # PCI transport and need PCI enumerated to be found at all -- confirmed by the
  # tutorial's own hands-on-tested, working boot cmdline, which never passes
  # pci=off either.
  #
  # Item 8: readonly=on verified against the installed cloud-hypervisor v53.0's
  # own `--disk` help text (full grammar includes
  # "path=...,readonly=on|off,...,lock_granularity=byte-range|full"). Cloud
  # Hypervisor holds an advisory per-disk write lock that Firecracker does not, so
  # a writable disk here would block every concurrent restore against the same
  # rootfs file. lock_granularity is the documented alternative for a future case
  # that needs the disk writable under concurrency; not used here.
  #
  # Item 9: path=/rootfs is jail-relative, exactly like the firecracker arm's
  # path_on_host, chrooted into $jail -- "$STAGE/rootfs" is the same
  # gone-once-the-script-exits bug items 1/2 fix for firecracker.
  #
  # Item 3/10: stdin redirected -- same SIGTTIN hazard as the firecracker launch.
  #
  # Deliberate build-vs-verify asymmetry (not drift, and NOT to be copied): like
  # the firecracker arm above, this CLI-flag-heavy invocation configures a
  # FRESH BOOT's resources (kernel, cmdline, disk, vsock, memory, cpus,
  # console). verify_restore_cloud_hypervisor below starts cloud-hypervisor
  # bare -- no --kernel/--disk/--vsock/etc -- because there is no documented
  # --restore CLI flag; the tutorial's own restore procedure starts the process
  # with only --api-socket and then replays everything, this block included,
  # via a single PUT /api/v1/vm.restore call against the snapshotted
  # ch-config.json (see verify_restore_cloud_hypervisor's own comment on that
  # bare start for the source).
  # Fix-round-12: --fs tag=workspace,socket=/fs.sock bakes a real virtio-fs
  # device into this snapshot's config.json (schema confirmed against
  # launcher_chv_test.go's own fixtures: tag/socket/num_queues/queue_size,
  # num_queues and queue_size left to cloud-hypervisor's own defaults here).
  # /fs.sock is jail-relative, same convention as --vsock's socket=/vsock.sock
  # above (resolves on the host to "$jail/fs.sock", which
  # start_workspace_virtiofsd, called just above, already listens on).
  #
  # The tag is "workspace" -- matching the in-guest mount point (/workspace),
  # matching the firecracker arm's own workspace.img naming, and what a reader
  # of `mount -t virtiofs workspace /workspace` would expect. This is the one
  # and only place the tag is set on the build side; verify_restore_cloud_
  # hypervisor never sets it directly because it restores the golden
  # config.json verbatim, tag and all. NOT rewritten at real restore time
  # either: launcher_chv.go's rewriteSnapshotConfig rewrites fs[].socket but
  # never fs[].tag, so this literal is also what a real restore's rewritten
  # config.json still carries.
  # Fix-round-13: shared=on on the very --memory flag the --fs device above
  # depends on. THE DEFECT this round started from: cloud-hypervisor refused
  # to start at all -- "Fatal error: ParsingConfig(Validation(
  # VhostUserRequiresSharedMemory))" -- a config-validation failure at 0.001s,
  # before any boot, identical whether or not virtiofsd's socket exists. The
  # causal chain: --fs above is a vhost-user device (virtiofsd is a standalone
  # daemon, not code linked into cloud-hypervisor); vhost-user devices are
  # driven by that external daemon reading/writing guest RAM directly, which
  # only works if the guest's memory is mapped MAP_SHARED; cloud-hypervisor's
  # own default for --memory is MAP_PRIVATE (shared=off), which is exactly
  # what the validator now refuses to pair with a vhost-user device. None of
  # "virtio-fs", "vhost-user", or "shared memory" appears near a bare
  # `--memory "size=...M"`, which is why round 12 shipped this defect: adding
  # --fs has a side effect on --memory that is invisible at the --fs call site.
  # Spelling confirmed against cloud-hypervisor's own docs/memory.md (fetched
  # from the project's GitHub at fix time, not guessed): the documented
  # example is literally `--memory size=1G,shared=on`; the doc's own words for
  # what `shared` is for are "when running vhost-user devices as part of the
  # VM device model, as they will be driven by standalone daemons" needing
  # "access to the guest RAM content" -- i.e. this exact situation.
  # CH-ARM ONLY: the firecracker arm (boot_quiesce_snapshot_firecracker, this
  # file) has no vhost-user device -- its workspace is a plain disk image, not
  # a virtio-fs mount -- and configures memory via PUT /machine-config's
  # mem_size_mib, a wholly different mechanism with no shared-memory concept
  # at all. Do not add shared=on (or anything like it) over there: it has
  # nothing to do with this defect and nothing needing it.
  chroot "$jail" /cloud-hypervisor \
    --api-socket /run/ch-api.sock \
    --kernel /kernel \
    --cmdline "console=ttyS0 root=/dev/vda rw reboot=k panic=1" \
    --disk "path=/rootfs,readonly=on" \
    --vsock "cid=3,socket=/vsock.sock" \
    --fs "tag=workspace,socket=/fs.sock" \
    --memory "size=${GUEST_RAM_MB}M,shared=on" \
    --cpus boot=1 \
    --console "file=/console.log" \
    --serial off \
    </dev/null >/dev/null 2>&1 &
  CLEANUP_PID=$!

  # Fix-round-10: wait for the API socket before anything touches it. This
  # arm's first real API call (ch-remote pause, below) does not run until
  # after wait_for_agent's own vsock-boot wait, which in practice already
  # buys plenty of time -- but wait_for_socket is the thing that actually
  # proves the API is ready, and the whole point of this round's fix is one
  # implementation at all four start sites, not "skip the ones that seem to
  # already have enough of a delay by accident" (that reasoning is exactly
  # how verify_restore_firecracker ended up racy-but-lucky in the first
  # place).
  wait_for_socket "$api_sock" "$console_log"

  wait_for_agent "$vsock_uds" "$console_log"
  MANIFEST_CAPABILITIES="$(probe_capabilities "$vsock_uds")"
  quiesce_guest "$vsock_uds"

  log "snapshotting (ch-remote pause + snapshot, no resume afterwards)"
  ch-remote --api-socket "$api_sock" pause
  ch-remote --api-socket "$api_sock" snapshot "file:///ch-snapshot"
  # Cloud Hypervisor writes one snapshot directory (config.json, state.json,
  # memory-ranges) rather than separate vmstate/memfile files. config.json is kept
  # (as ch-config.json) rather than discarded: vm.restore replays the WHOLE
  # directory, config.json included, and the tutorial documents it as the vehicle
  # for editing a restored snapshot's paths between snapshot and restore (§9a) --
  # dropping it, as the previous form of this script did, left restore with no
  # config to replay at all. state.json/memory-ranges are split out under the
  # vmstate/memfile names so both VMMs feed write_manifest identically.
  cp "$jail/ch-snapshot/config.json" "$STAGE/ch-config.json"
  mv "$jail/ch-snapshot/state.json" "$STAGE/vmstate"
  mv "$jail/ch-snapshot/memory-ranges" "$STAGE/memfile"

  teardown_jail "$jail"
  # Fix-round-12: VMM first (teardown_jail above reaps CLEANUP_PID), then
  # virtiofsd -- see teardown_virtiofsd's own comment for why this order is
  # not optional.
  teardown_virtiofsd
}

boot_quiesce_snapshot() {
  write_guest_client
  # The kernel is copied into $STAGE BEFORE booting (not in write_manifest, where
  # it used to happen): both VMM arms above now need it in place, at the
  # jail-relative name "/kernel", before they ever start the VMM.
  cp "$KERNEL" "$STAGE/kernel"
  case "$VMM" in
    firecracker) boot_quiesce_snapshot_firecracker ;;
    cloud-hypervisor) boot_quiesce_snapshot_cloud_hypervisor ;;
  esac
}

# ---------------------------------------------------------------------------
# 5. write_manifest
# ---------------------------------------------------------------------------
write_manifest() {
  log "writing manifest.json"
  # $STAGE/kernel is copied by boot_quiesce_snapshot, before either VMM arm
  # boots -- both now need it in place at the jail-relative name "/kernel"
  # pre-boot, not just afterwards for hashing.

  local khash rhash ahash hash caps_json built_at
  khash="sha256:$(sha256sum "$STAGE/kernel" | cut -d' ' -f1)"
  rhash="sha256:$(sha256sum "$STAGE/rootfs" | cut -d' ' -f1)"
  ahash="sha256:$(sha256sum "$STAGE/agent" | cut -d' ' -f1)"
  # Hashed in this exact order -- kernel, then rootfs, then agent -- to match
  # vmpool.Manifest.ComputeHash byte for byte; a different order here would make
  # every worker's startup verification fail against a perfectly good snapshot.
  hash="sha256:$(printf 'kernel:%s\nrootfs:%s\nagent:%s\n' "$khash" "$rhash" "$ahash" | sha256sum | cut -d' ' -f1)"

  caps_json="$(printf '%s\n' "${MANIFEST_CAPABILITIES:-}" | sed '/^$/d' | awk '{printf "%s\"%s\"", sep, $0; sep=","}')"
  built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat >"$STAGE/manifest.json" <<MANIFEST
{
  "image": "$IMAGE",
  "vmm": "$VMM",
  "instance_type": "$INSTANCE_TYPE",
  "kernel_release": "$(uname -r)",
  "guest_ram_mb": $GUEST_RAM_MB,
  "capabilities": [$caps_json],
  "built_at": "$built_at",
  "kernel_sha256": "$khash",
  "rootfs_sha256": "$rhash",
  "agent_sha256": "$ahash",
  "hash": "$hash"
}
MANIFEST
}

# ---------------------------------------------------------------------------
# 6. lock_down
# ---------------------------------------------------------------------------
# Seals the finished snapshot into $PENDING, NOT into $OUT. $PENDING is a sibling of
# $OUT, which buys two things at once:
#
#   - publish_snapshot's `mv` is a same-device rename, not a copy. memfile is the
#     guest's ENTIRE RAM image (--guest-ram-mb), so publishing across devices would
#     duplicate it -- the same reasoning link_snapshot_file spells out for its `ln`.
#   - verify_restore's own jail (new_verify_dir) is a sibling of both, so its hard
#     links out of $PENDING stay same-device too.
#
# Everything else about this function is unchanged: the artifact is root-owned and
# 0444/0555 BEFORE it is verified, so what gets published is byte-for-byte and
# permission-for-permission the thing that was proven to restore.
lock_down() {
  mkdir -p "$(dirname "$OUT")"
  PENDING="$(mktemp -d "$(dirname "$OUT")/.build-snapshot-pending.XXXXXX")"
  CLEANUP_PENDING_DIR="$PENDING"
  log "sealing the snapshot in $PENDING (root-owned, read-only) before verifying it"
  files=(vmstate memfile kernel rootfs agent manifest.json)
  # cloud-hypervisor's snapshot is a directory (config.json, state.json,
  # memory-ranges), not just the vmstate/memfile pair -- config.json has to ship
  # too, or vm.restore's source_url has nothing to replay at restore time.
  if [ "$VMM" = "cloud-hypervisor" ]; then
    files+=(ch-config.json)
  fi
  for f in "${files[@]}"; do
    install -m 0644 "$STAGE/$f" "$PENDING/$f"
  done
  chown -R root:root "$PENDING"
  for f in "${files[@]}"; do
    chmod 0444 "$PENDING/$f"
  done
  chmod 0555 "$PENDING"
}

# ---------------------------------------------------------------------------
# 7. verify_restore
# ---------------------------------------------------------------------------
verify_restore() {
  log "verifying: restoring one VM from $PENDING and running \`true\` in it"
  case "$VMM" in
    firecracker) verify_restore_firecracker ;;
    cloud-hypervisor) verify_restore_cloud_hypervisor ;;
  esac
  log "verify: ok"
}

verify_restore_firecracker() {
  # Items 1/2/9's whole point: prove the sealed snapshot is portable by restoring
  # it into a FRESH jail at a DIFFERENT absolute path than the one it was built
  # under -- if it still baked in an absolute, build-time path, this jail would
  # never see it and LoadSnapshot would fail exactly like the original bug this
  # round fixes. The bytes come from $PENDING rather than $OUT: they are the same
  # bytes with the same permissions (publish_snapshot only renames the
  # directory), and verifying BEFORE publishing is what stops a snapshot that
  # cannot restore from ever appearing at $OUT at all.
  # Fix-round-7 item 1: the verify jail can no longer live under $STAGE (tmpfs)
  # if it is going to hard-link vmstate/memfile/rootfs out of the sealed
  # snapshot (ext4, or whatever device --out points at) -- ln across
  # tmpfs<->ext4 is EXDEV, always, unconditionally, no matter permissions.
  # new_verify_dir allocates a sibling directory of $OUT itself, which is also a
  # sibling of $PENDING and therefore on the same device, so link_snapshot_file's
  # `ln` below is a same-device link and actually succeeds; see new_verify_dir's
  # own comment for why a sibling (not "inside" -- lock_down has already chmod'd
  # $PENDING to 0555 by the time verify_restore runs) and why this doesn't weaken
  # the cross-path portability check the surrounding comment describes.
  # CLEANUP_EXTRA_DIR ensures this directory is removed on any exit path, same as
  # $STAGE.
  local verify_root
  verify_root="$(new_verify_dir)"
  CLEANUP_EXTRA_DIR="$verify_root"
  local jail="$verify_root/verify-jail"
  local api_sock="$jail/run/verify-api.sock" vsock_uds="$jail/vsock.sock" \
    console_log="$STAGE/verify-console.log"
  # Fix-round-9: jail skeleton via the shared prepare_jail helper -- see its
  # definition next to jail_mount_dev. Same call shape as
  # boot_quiesce_snapshot_firecracker's (no extra directories): a failing `ln`
  # (e.g. cross-device) or ensure_workspace_image's mkfs.ext4 below used to be
  # able to run inside a leak window before CLEANUP_JAIL was set; see the
  # matching comment in boot_quiesce_snapshot_firecracker for the full
  # rationale, and prepare_jail's own comment for why this is no longer typed
  # out independently per function.
  prepare_jail firecracker "$jail"
  # Fix-round-7 item 1: hard-link, not bare `ln` -- see link_snapshot_file's own
  # comment for why a silent copy fallback (hardlink_or_copy_bin's pattern) is
  # wrong specifically for these three files, memfile above all.
  link_snapshot_file "$PENDING/vmstate" "$jail/vmstate"
  link_snapshot_file "$PENDING/memfile" "$jail/memfile"
  link_snapshot_file "$PENDING/rootfs" "$jail/rootfs"
  ensure_workspace_image "$jail/workspace.img"

  chroot "$jail" /firecracker --api-sock /run/verify-api.sock \
    </dev/null >"$console_log" 2>&1 &
  CLEANUP_PID=$!

  # Fix-round-10: wait for the API socket before the /snapshot/load call
  # below -- this is the arm the coordinator's own probe caught NOT racing
  # only by accident (more statements between start and first call, plus a
  # fast-binding daemon); see wait_for_socket's comment for the full story.
  # This also matches launcher_firecracker.go's own Restore, which calls
  # waitForUnixSocket before setVsockOverride/LoadSnapshot -- see the next
  # comment block's own reference to that call order.
  #
  # Fix-round-11 item 2: $console_log is now a named local (it used to be
  # only the literal string "$STAGE/verify-console.log" inlined in the
  # redirection above) so it can be passed to wait_for_socket -- this is one
  # of the two call sites (the other is verify_restore_cloud_hypervisor) that
  # had no console-log variable in scope, and is exactly where the
  # coordinator had to manually intervene to read the console log, because
  # wait_for_socket's timeout path had nothing to print it from.
  wait_for_socket "$api_sock" "$console_log"

  # Fix-round-8: a restoring instance must be FRESH. The real binary enforces
  # this -- the rig's own failure was PUT /snapshot/load returning HTTP 400
  # "Loading a microVM snapshot not allowed after configuring boot-specific
  # resources." This function used to PUT its own vsock device here first
  # (copying boot_quiesce_snapshot_firecracker's *fresh-boot* sequence, item
  # 3's PUT /vsock), reasoning that since the UDS path does not move
  # (both build-time and here are jail-relative /vsock.sock) a same-value PUT
  # was harmless. It is not harmless: /snapshot/load's ONE call is the only
  # configuration a restoring instance gets at all, no matter whether the
  # value being configured matches what the snapshot already carries.
  #
  # launcher_firecracker.go's Restore is the reference for the correct shape:
  # after waitForUnixSocket it calls exactly fc.setVsockOverride(vsockRelPath)
  # then fc.LoadSnapshot(...) -- no PUT /vsock, /boot-source, /drives/... or
  # /machine-config anywhere in that function. setVsockOverride itself (see
  # fcapi.go) does not touch the wire at all; it just records a string field
  # that LoadSnapshot's own request body includes as vsock_override. That is
  # Firecracker's *only* restore-time path override -- there is no equivalent
  # for drives (see boot_quiesce_snapshot_firecracker's item 2 comment), which
  # is exactly why /workspace.img has to already be staged into this jail
  # (done above, via ensure_workspace_image) rather than configured here.
  #
  # Wire format confirmed against fcapi.go's loadSnapshotRequest struct:
  # snapshot_path is top-level, the memory file nests under mem_backend as
  # {backend_path, backend_type} -- NOT the flat mem_file_path field, which
  # belongs to the separate /snapshot/create request. resume_vm IS a valid
  # field here (unlike on /snapshot/create, see the fix-round-6 comment
  # above) -- confirmed against v1.17.0's SnapshotLoadParams.
  #
  # Fix-round-6 item 2: vsock_override is an object ({"uds_path": ...}), not a
  # bare string -- confirmed against v1.17.0's firecracker.yaml VsockOverride
  # schema (single required property uds_path) and against Firecracker's own
  # docs/vsock.md "Unix Domain Socket Renaming" section, whose worked example
  # is `"vsock_override": {"uds_path": "./v.sock.2"}`.
  #
  # This is the ONLY Firecracker API call verify_restore_firecracker makes
  # after starting the VMM -- see the test asserting exactly that.
  api_put "$api_sock" /snapshot/load \
    "{\"snapshot_path\":\"/vmstate\",\"mem_backend\":{\"backend_path\":\"/memfile\",\"backend_type\":\"File\"},\"vsock_override\":{\"uds_path\":\"/vsock.sock\"},\"resume_vm\":true}"

  local exit_code=0
  "$STAGE/guest_client" -uds "$vsock_uds" -port 1024 -timeout-s 30 -command true || exit_code=$?
  teardown_jail "$jail"
  rm_rf_jail "$verify_root"
  CLEANUP_EXTRA_DIR=""
  if [ "$exit_code" -ne 0 ]; then
    echo "build-snapshot.sh: the fresh snapshot restored but \`true\` exited $exit_code" >&2
    exit 1
  fi
}

verify_restore_cloud_hypervisor() {
  # Same portability check as the firecracker arm, restoring into a fresh jail
  # at a different absolute path than the one used to build the snapshot, and out
  # of $PENDING rather than $OUT for the same reason -- see that function's first
  # comment block.
  #
  # Self-discovered 11th finding: the previous form of this function passed
  # `--restore source_url=file://$OUT` as a CLI flag. cloud-hypervisor has no
  # such flag -- docs/notes/cloud-hypervisor-tutorial.md's own hands-on-tested
  # restore procedure (Sec 6a-6c) always starts a BARE cloud-hypervisor process
  # against only --api-socket, then issues `PUT /api/v1/vm.restore` with body
  # {"source_url":..., "resume":true}; a web search for a --restore CLI flag
  # found no confirmation either. Rebuilt on the API-call pattern below.
  # Fix-round-7 item 1: same EXDEV problem as the firecracker arm -- see that
  # function's comment and new_verify_dir's own comment for the full
  # rationale. The verify jail moves off $STAGE (tmpfs) onto a sibling
  # directory of $OUT so link_snapshot_file's `ln` below is same-device.
  local verify_root
  verify_root="$(new_verify_dir)"
  CLEANUP_EXTRA_DIR="$verify_root"
  local jail="$verify_root/verify-jail"
  local api_sock="$jail/run/verify-ch-api.sock" vsock_uds="$jail/vsock.sock" \
    console_log="$STAGE/verify-console.log"
  # Fix-round-9: jail skeleton via the shared prepare_jail helper -- see its
  # definition next to jail_mount_dev. This call's "$jail/ch-snapshot" extra
  # directory is the one this function already got right; the fix this round
  # is making boot_quiesce_snapshot_cloud_hypervisor's build-side call pass the
  # same argument, through the same helper, so the two can no longer
  # independently drift on whether ch-snapshot exists before ch-remote needs
  # it.
  # Fix-round-12: "$jail/workspace" is a new extra prepare_jail directory,
  # parallel to boot_quiesce_snapshot_cloud_hypervisor's own build-side call --
  # the restored guest's config.json (replayed verbatim below, tag "workspace"
  # included) declares a virtio-fs device, so this verify jail needs a
  # virtiofsd of its own for cloud-hypervisor to connect to, the same as the
  # build side did. See start_workspace_virtiofsd's own comment.
  prepare_jail cloud-hypervisor "$jail" "$jail/ch-snapshot" "$jail/workspace"
  # Fix-round-7 item 1: hard-link via link_snapshot_file, not bare `ln` -- see
  # that function's comment for why a silent copy fallback is wrong here,
  # memfile (shipped here as memory-ranges) above all.
  link_snapshot_file "$PENDING/rootfs" "$jail/rootfs"
  # vm.restore replays the whole snapshot directory, not just memory state, so
  # config.json (shipped as ch-config.json, see lock_down/item 9's corollary)
  # has to be put back next to the state files under their original names
  # before the restore call.
  link_snapshot_file "$PENDING/ch-config.json" "$jail/ch-snapshot/config.json"
  link_snapshot_file "$PENDING/vmstate" "$jail/ch-snapshot/state.json"
  link_snapshot_file "$PENDING/memfile" "$jail/ch-snapshot/memory-ranges"

  # Fix-round-12: same ordering requirement as the build side -- virtiofsd up
  # and its socket confirmed live BEFORE cloud-hypervisor starts, since the
  # restored config.json's fs[] device makes cloud-hypervisor try to connect
  # to /fs.sock as soon as it starts. No --fs CLI flag needed here: the golden
  # config.json (linked in above, replayed verbatim by vm.restore below)
  # already carries the device, tag "workspace" included.
  start_workspace_virtiofsd "$jail" "$console_log"

  chroot "$jail" /cloud-hypervisor --api-socket /run/verify-ch-api.sock \
    </dev/null >"$console_log" 2>&1 &
  CLEANUP_PID=$!

  # Fix-round-10: THE call site the rig's own failure came from -- all of this
  # function's link_snapshot_file staging happens BEFORE the chroot above, so
  # without this wait, api_put /api/v1/vm.restore is the very next statement
  # after the process is backgrounded, with nothing at all between "started"
  # and "first call". See wait_for_socket's own comment for the exact curl
  # error this reproduced ("after 0 ms: Could not connect to server").
  #
  # Fix-round-11: THE call site the coordinator's actual round-11 bug (a jail
  # binary chroot could not execve, see hardlink_or_copy_bin's own comment)
  # reproduced at, and also THE call site whose wait_for_socket timeout used
  # to swallow the console log that was the entire diagnosis. $console_log is
  # now a named local (previously only the literal string inlined in the
  # redirection above) so it can be passed through to wait_for_socket, which
  # now preserves and prints it on timeout via save_and_print_console_log.
  wait_for_socket "$api_sock" "$console_log"

  api_put "$api_sock" /api/v1/vm.restore \
    '{"source_url":"file:///ch-snapshot","resume":true}'

  local exit_code=0
  "$STAGE/guest_client" -uds "$vsock_uds" -port 1024 -timeout-s 30 -command true || exit_code=$?
  teardown_jail "$jail"
  # Fix-round-12: VMM first (teardown_jail above), then virtiofsd -- see
  # teardown_virtiofsd's own comment. Must run before rm_rf_jail: virtiofsd
  # still has $jail/workspace open until it is killed.
  teardown_virtiofsd
  rm_rf_jail "$verify_root"
  CLEANUP_EXTRA_DIR=""
  if [ "$exit_code" -ne 0 ]; then
    echo "build-snapshot.sh: the fresh snapshot restored but \`true\` exited $exit_code" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 8. publish_snapshot
# ---------------------------------------------------------------------------
# The only step that writes $OUT, and it runs only after verify_restore has passed.
#
# Publishing is a rename, not a copy: $PENDING is a sibling of $OUT (see lock_down), so
# `mv` is a single same-device rename of the directory -- no second copy of memfile, and
# no window in which $OUT holds half a snapshot. A previously-good $OUT is renamed ASIDE
# first rather than deleted in place, so the only moment $OUT does not exist is between
# two renames, and it is removed only once the new snapshot is in place.
#
# rename(2) needs write permission on the PARENT of each path, not on the directories
# being moved, so $PENDING's own 0555 and root ownership (set by lock_down, verified by
# verify_restore) survive publication untouched -- which is the point: what lands in
# $OUT is the exact artifact that was proven to restore.
publish_snapshot() {
  log "publishing the verified snapshot to $OUT"
  local retired=""
  if [ -e "$OUT" ]; then
    retired="$(dirname "$OUT")/.build-snapshot-retired.$$"
    rm_rf_jail "$retired"
    mv "$OUT" "$retired"
  fi
  mv "$PENDING" "$OUT"
  # $PENDING no longer exists under that name; clearing this keeps cleanup_on_exit from
  # trying to remove a path that is now $OUT.
  CLEANUP_PENDING_DIR=""
  PENDING=""
  if [ -n "$retired" ]; then
    rm_rf_jail "$retired"
  fi
}

# ---------------------------------------------------------------------------
main() {
  require_root
  preflight
  build_agent
  assemble_rootfs
  boot_quiesce_snapshot
  write_manifest
  # lock_down seals into $PENDING, verify_restore restores from $PENDING, and
  # publish_snapshot renames it onto $OUT last. Sealing straight into $OUT and verifying
  # afterwards (the previous order) left a failed verification published, sealed and
  # self-consistent, so every worker's startup hash check passed on an artifact known
  # not to restore -- see publish_snapshot and the header's step 8.
  lock_down
  verify_restore
  publish_snapshot
  log "done: $OUT"
}

main
