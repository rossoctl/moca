# shellcheck shell=bash
# deploy/sbx/lib.sh -- shared by deploy/sbx/setup.sh, deploy/sbx/status.sh and
# deploy/sbx/template-onboarding/template-register.sh, which source it.
# Not executable on its own. The caller defines die() (its own message prefix) and USAGE (its one
# usage line) before calling parse_args.

# A worker id (the relay looks a worker up by it) and a Kubernetes namespace name.
# shellcheck disable=SC2034 # used by the scripts that source this file
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'
# shellcheck disable=SC2034 # used by the scripts that source this file
NS_RE='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'

# parse_args "$@": `--env-file FILE`, any number of times, sources FILE with `set -a` (the
# operator's own settings, the same file for every script here); anything else is refused.
parse_args() {
  while (($#)); do
    case "$1" in
    --env-file)
      [[ $# -ge 2 && -f "$2" ]] || die '--env-file needs a readable file'
      set -a
      # shellcheck disable=SC1090 # the operator's own settings file
      . "$2"
      set +a
      shift 2
      ;;
    *) die "unknown argument: $1 (usage: $USAGE)" ;;
    esac
  done
}
