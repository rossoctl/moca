#!/usr/bin/env bash
# deploy/sbx/sbx-read-ahead.sh -- the kernel read-ahead of the block device holding a path (SBX0's
# $SBX_SRV, where the snapshots live), so a worker's cold start reads its memory file in larger
# requests. Installed by deploy/sbx/install-host.sh as $SBX_LIBEXEC_DIR/sbx-read-ahead.sh and run at
# boot by sbx-read-ahead.service (a sysfs write does not survive a reboot); see deploy/sbx/RUNBOOK.md
# (Snapshot read-ahead).
#
#   sbx-read-ahead.sh resolve PATH     print the read_ahead_kb file of the device holding PATH
#   sbx-read-ahead.sh set PATH KB      write KB there, read it back, say what the device kept
#
# The device is found by path at every run, never by a recorded name (a disk's kernel name can change
# across reboots): findmnt's MAJ:MIN for PATH, then /sys/dev/block/MAJ:MIN. A device with its own queue
# (a disk, dm/LVM, md, loop) is set itself; a partition's read-ahead is its parent disk's. A filesystem
# with no block device (tmpfs, overlay, btrfs's anonymous device) is not resolvable: `resolve` exits 1
# and `set` warns and exits 0, so a boot never fails over it. A value the device does not take is a
# warning too. SBX_SYSFS (default /sys) is a test seam.
set -euo pipefail
: "${SBX_SYSFS:=/sys}"

warn() { printf 'WARNING: sbx-read-ahead: %s\n' "$*" >&2; }

# queue_file PATH -> the read_ahead_kb file, or a reason on stderr and exit 1.
queue_file() {
  local majmin dir
  command -v findmnt >/dev/null || { warn 'no findmnt on PATH'; return 1; }
  majmin="$(findmnt -n -o MAJ:MIN --target "$1" 2>/dev/null | head -1 | tr -d '[:space:]')" || majmin=''
  [[ "$majmin" =~ ^[0-9]+:[0-9]+$ ]] || { warn "no mount found for $1"; return 1; }
  dir="$(cd -P "$SBX_SYSFS/dev/block/$majmin" 2>/dev/null && pwd)" ||
    { warn "$1 is not on a block device ($majmin: not in $SBX_SYSFS/dev/block; tmpfs, overlay or similar)"; return 1; }
  if [[ -f "$dir/queue/read_ahead_kb" ]]; then
    printf '%s\n' "$dir/queue/read_ahead_kb"
  elif [[ -f "$dir/partition" && -f "$dir/../queue/read_ahead_kb" ]]; then
    printf '%s\n' "$(cd -P "$dir/.." && pwd)/queue/read_ahead_kb"
  else
    warn "the device of $1 ($(basename "$dir")) has no queue/read_ahead_kb"
    return 1
  fi
}

# device_of QUEUE_FILE -> the device's kernel name, for messages.
device_of() { basename "$(dirname "$(dirname "$1")")"; }

case "${1:-}" in
resolve)
  [[ $# -eq 2 ]] || { echo 'usage: sbx-read-ahead.sh resolve PATH' >&2; exit 2; }
  queue_file "$2"
  ;;
set)
  [[ $# -eq 3 && "$3" =~ ^[0-9]{1,5}$ ]] || { echo 'usage: sbx-read-ahead.sh set PATH KB' >&2; exit 2; }
  q="$(queue_file "$2")" || { warn "read-ahead not set for $2"; exit 0; }
  dev="$(device_of "$q")"
  old="$(cat "$q" 2>/dev/null)" || old='?'
  # The write may fail (EINVAL) or be rounded to whole pages: what the device kept is what counts.
  (printf '%s\n' "$((10#$3))" >"$q") 2>/dev/null || true
  now="$(cat "$q" 2>/dev/null)" || now='?'
  if [[ "$now" == "$((10#$3))" ]]; then
    printf 'sbx-read-ahead: %s read_ahead_kb %s -> %s (%s)\n' "$dev" "$old" "$now" "$q"
  else
    warn "$dev did not take read_ahead_kb $3; it is $now ($q)"
  fi
  ;;
*)
  echo 'usage: sbx-read-ahead.sh resolve PATH | set PATH KB' >&2
  exit 2
  ;;
esac
