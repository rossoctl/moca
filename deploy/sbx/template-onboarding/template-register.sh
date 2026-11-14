#!/usr/bin/env bash
# deploy/sbx/template-onboarding/template-register.sh -- on the operator's machine, add a built template to SBX0's inputs,
# or retire a worker from them (RUNBOOK §5, steps 2-4, for deployments without a host agent).
#
#   deploy/sbx/template-onboarding/template-register.sh --env-file FILE RECORD [--apply]
#   deploy/sbx/template-onboarding/template-register.sh --env-file FILE --retire WORKER_ID [--apply]
#   deploy/sbx/template-onboarding/template-register.sh --env-file FILE --remove TEMPLATE_ID [--apply]
#
# FILE is setup.sh's env file. It must assign SBX_WORKERS on one line of its own and name
# SBX_TEMPLATES_FILE; this script edits that line and that file, nothing else. RECORD is the
# template record deploy/sbx/template-onboarding/template-build.sh wrote on the KVM host
# ($SBX_SRV/templates/<snapshot>.json, schema moca-sbx-template/1), copied here.
#
#   RECORD          adds the record's worker to SBX_WORKERS and its {id, worker, description, tools}
#                   to the templates file. A template id already listed is an update, versioned
#                   (RUNBOOK §5): its entry moves to the new worker, and the old worker STAYS in
#                   SBX_WORKERS so its live sandboxes keep working until it is retired.
#   --retire W      drops worker W from SBX_WORKERS once no template names it (its token is revoked by
#                   the next setup.sh; its sandboxes stop working at once: retire it only when it
#                   serves no live sandbox, RUNBOOK §5).
#   --remove T      drops template T's entry and its worker (the reverse of adding it).
#
# A re-run with nothing to change changes nothing and says so. Without --apply it prints the
# setup.sh to run; with --apply it runs it (the cluster side: a template change rolls the control
# plane only). Installing or uninstalling the worker on its KVM host is install-host.sh's.
#
# Exit: 0 done (or nothing to do); 1 refused; 2 usage.
set -euo pipefail

# SBX0's own scripts are one level up (deploy/sbx/): lib.sh and setup.sh.
SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/sbx/lib.sh
. "$SBX_DIR/lib.sh"
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
: "${SBX_SETUP:=$SBX_DIR/setup.sh}"

log() { printf '==> %s\n' "$*"; }
die() { echo "deploy/sbx/template-onboarding/template-register.sh: $*" >&2; exit 1; }
usage() {
  echo 'usage: template-register.sh --env-file FILE (RECORD | --retire WORKER_ID | --remove TEMPLATE_ID) [--apply]' >&2
  exit 2
}

ENV_FILE='' RECORD='' RETIRE='' REMOVE='' APPLY=''
while (($#)); do
  case "$1" in
  --env-file) [[ $# -ge 2 ]] || usage; ENV_FILE="$2"; shift 2 ;;
  --retire) [[ $# -ge 2 ]] || usage; RETIRE="$2"; shift 2 ;;
  --remove) [[ $# -ge 2 ]] || usage; REMOVE="$2"; shift 2 ;;
  --apply) APPLY=1; shift ;;
  -h | --help) usage ;;
  -*) echo "template-register.sh: unknown argument $1" >&2; usage ;;
  *) [[ -z "$RECORD" ]] || usage; RECORD="$1"; shift ;;
  esac
done
[[ -n "$ENV_FILE" ]] || usage
(( (${RECORD:+1} + 0) + (${RETIRE:+1} + 0) + (${REMOVE:+1} + 0) == 1 )) || usage
[[ -f "$ENV_FILE" ]] || die "no env file $ENV_FILE"
command -v jq >/dev/null || die 'needs jq'

# Only an SBX_WORKERS this script can rewrite: one plain assignment line, nothing else on it. Checked
# before the file is read, so a line it would misread is refused, not sourced.
n="$(grep -c -E '^[[:space:]]*(export[[:space:]]+)?SBX_WORKERS=' "$ENV_FILE" || true)"
[[ "$n" == 1 ]] || die "$ENV_FILE must assign SBX_WORKERS on exactly one line (found $n); edit it by hand"
grep -q -E '^SBX_WORKERS=("[A-Za-z0-9_ ]*"|[A-Za-z0-9_]*)[[:space:]]*$' "$ENV_FILE" ||
  die "$ENV_FILE's SBX_WORKERS line is not a plain SBX_WORKERS=\"id id ...\"; edit it by hand"
# The env file's inputs, read the way setup.sh reads them (sourced, without nounset), in a subshell
# so nothing else of it reaches this script.
env_value() {
  (
    set +u -a
    # shellcheck disable=SC1090 # the operator's own settings file
    . "$ENV_FILE"
    eval "printf '%s' \"\${$1:-}\""
  )
}
TEMPLATES="$(env_value SBX_TEMPLATES_FILE)"
WORKERS="$(env_value SBX_WORKERS)"
[[ -n "$TEMPLATES" && -f "$TEMPLATES" ]] || die "SBX_TEMPLATES_FILE in $ENV_FILE does not name a file"
jq -e 'type == "array"' "$TEMPLATES" >/dev/null 2>&1 || die "$TEMPLATES is not a JSON list"
[[ -z "$(env_value SBX_EGRESS_HOSTS)" ]] ||
  die "$ENV_FILE sets SBX_EGRESS_HOSTS, which names template workers by host: change templates there by hand (RUNBOOK §5)"

has_worker() { [[ " $WORKERS " == *" $1 "* ]]; }
# Unquoted on purpose: SBX_WORKERS is a space-separated list of ids (WORKER_RE: no glob characters).
# shellcheck disable=SC2086
NEW_WORKERS="$(printf '%s ' $WORKERS)"
NEW_WORKERS="${NEW_WORKERS% }"
NEW_TEMPLATES="$(jq -c . "$TEMPLATES")"
CHANGES=()

if [[ -n "$RECORD" ]]; then
  [[ -f "$RECORD" ]] || die "no record $RECORD"
  jq -e --arg tre "$TEMPLATE_ID_RE" --arg wre "$WORKER_RE" '.schema == "moca-sbx-template/1"
    and (.id | type == "string" and test($tre))
    and (.worker | type == "string" and test($wre) and . != "DIR")
    and (.description | type == "string") and (.tools | type == "array" and all(.[]; type == "string"))
    and (.egress | type == "boolean") and (.snapshot | type == "string")' "$RECORD" >/dev/null 2>&1 ||
    die "$RECORD is not a template record (schema moca-sbx-template/1, from template-build.sh)"
  ID="$(jq -r .id "$RECORD")" W="$(jq -r .worker "$RECORD")"
  ENTRY="$(jq -c '{id, worker, description, tools}' "$RECORD")"
  other="$(jq -r --arg w "$W" --arg id "$ID" '[.[] | select(.worker == $w and .id != $id) | .id] | join(" ")' <<<"$NEW_TEMPLATES")"
  [[ -z "$other" ]] || die "worker $W already serves template $other (one worker per template)"
  old="$(jq -r --arg id "$ID" '.[] | select(.id == $id) | .worker' <<<"$NEW_TEMPLATES")"
  if [[ -z "$old" ]]; then
    NEW_TEMPLATES="$(jq -c --argjson e "$ENTRY" '. + [$e]' <<<"$NEW_TEMPLATES")"
    CHANGES+=("template $ID added, served by $W")
  elif [[ "$(jq -c --arg id "$ID" '.[] | select(.id == $id)' <<<"$NEW_TEMPLATES")" != "$ENTRY" ]]; then
    NEW_TEMPLATES="$(jq -c --argjson e "$ENTRY" --arg id "$ID" 'map(if .id == $id then $e else . end)' <<<"$NEW_TEMPLATES")"
    if [[ "$old" != "$W" ]]; then
      CHANGES+=("template $ID moves from $old to $W: $old stays in SBX_WORKERS so its sandboxes keep working; retire it with --retire $old once it serves none (RUNBOOK §5)")
    else
      CHANGES+=("template $ID's description or tools updated")
    fi
  fi
  has_worker "$W" || { NEW_WORKERS="${NEW_WORKERS:+$NEW_WORKERS }$W"; CHANGES+=("worker $W added to SBX_WORKERS"); }
elif [[ -n "$RETIRE" ]]; then
  [[ "$RETIRE" =~ $WORKER_RE ]] || die "'$RETIRE' is not a worker id"
  used="$(jq -r --arg w "$RETIRE" '[.[] | select(.worker == $w) | .id] | join(" ")' <<<"$NEW_TEMPLATES")"
  [[ -z "$used" ]] || die "worker $RETIRE still serves template $used: register its new version first, or --remove the template"
  if has_worker "$RETIRE"; then
    # shellcheck disable=SC2086 # the id list, split on purpose
    NEW_WORKERS="$(printf '%s\n' $NEW_WORKERS | grep -vx -- "$RETIRE" | tr '\n' ' ')"
    NEW_WORKERS="${NEW_WORKERS% }"
    CHANGES+=("worker $RETIRE retired: the next setup.sh revokes its token and deletes its bundle")
  fi
else
  [[ "$REMOVE" =~ $TEMPLATE_ID_RE ]] || die "'$REMOVE' is not a template id"
  W="$(jq -r --arg id "$REMOVE" '.[] | select(.id == $id) | .worker' <<<"$NEW_TEMPLATES")"
  if [[ -n "$W" ]]; then
    NEW_TEMPLATES="$(jq -c --arg id "$REMOVE" 'map(select(.id != $id))' <<<"$NEW_TEMPLATES")"
    [[ "$(jq 'length' <<<"$NEW_TEMPLATES")" -gt 0 ]] || die "template $REMOVE is the only one: SBX0 needs at least one"
    # shellcheck disable=SC2086 # the id list, split on purpose
    NEW_WORKERS="$(printf '%s\n' $NEW_WORKERS | grep -vx -- "$W" | tr '\n' ' ')"
    NEW_WORKERS="${NEW_WORKERS% }"
    CHANGES+=("template $REMOVE removed, and its worker $W: its sandboxes stop working at once")
  fi
fi

if ((${#CHANGES[@]} == 0)); then
  log "nothing to change in $ENV_FILE or $TEMPLATES"
  [[ -z "$APPLY" ]] || log 'not running setup.sh: nothing changed'
  exit 0
fi
[[ -n "$NEW_WORKERS" ]] || die 'SBX_WORKERS would be empty'

# Write both files whole, through a temporary file beside each, keeping their modes: a failure part
# way leaves the previous file, never half of one. A path that is a symlink is written through to the
# file it names, with that file's mode, so the link stays a link: replacing the link itself would
# leave a regular file with the link's own mode (0777 on Linux) in its place.
resolve_link() {
  local p="$1" l n=0
  while [[ -L "$p" ]]; do
    ((n++ < 40)) || die "$1: too many levels of symbolic links"
    l="$(readlink "$p")"
    if [[ "$l" == /* ]]; then p="$l"; else p="$(dirname "$p")/$l"; fi
  done
  printf '%s' "$p"
}
write_file() {
  local path tmp mode
  path="$(resolve_link "$1")"
  [[ -f "$path" ]] || die "$1: not a regular file (or a link to one)"
  mode="$(stat -L -c '%a' "$path" 2>/dev/null || stat -L -f '%Lp' "$path")"
  tmp="$(mktemp "$path.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$path"
}
jq . <<<"$NEW_TEMPLATES" | write_file "$TEMPLATES"
awk -v line="SBX_WORKERS=\"$NEW_WORKERS\"" '/^SBX_WORKERS=/ { print line; next } { print }' "$ENV_FILE" | write_file "$ENV_FILE"
for c in "${CHANGES[@]}"; do log "$c"; done
log "SBX_WORKERS=\"$NEW_WORKERS\" in $ENV_FILE; the templates in $TEMPLATES"

if [[ -n "$APPLY" ]]; then
  log "running $SBX_SETUP --env-file $ENV_FILE"
  "$SBX_SETUP" --env-file "$ENV_FILE"
else
  log "next: $SBX_SETUP --env-file $ENV_FILE (or re-run this with --apply)"
fi
if [[ -n "$RECORD" ]]; then
  egress=''
  [[ "$(jq -r .egress "$RECORD")" == true ]] || egress=' --no-egress'
  log "then on the KVM host: sudo deploy/sbx/install-host.sh <bundle of $W> --snapshot $(jq -r .snapshot "$RECORD") --budget-mb <at least $(jq -r '.min_budget_mb // "see RUNBOOK §1"' "$RECORD")>$egress"
elif [[ -n "$RETIRE$REMOVE" && -n "${W:-$RETIRE}" ]]; then
  log "then on its KVM host: sudo deploy/sbx/install-host.sh --uninstall ${W:-$RETIRE}"
fi
