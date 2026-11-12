#!/usr/bin/env bash
# deploy/microvm/tests/setup-microvm.test.sh
#
# Root-free, KVM-free test for setup-microvm.sh. podman, systemctl, id and go are mocked onto PATH
# and log their argv; the installer runs against a temp SH_UNIT_DIR/SH_ENV_DIR/SH_BIN_DIR seeded with
# the two P6 files it reads. Asserts: refusals happen before anything is written, the token is
# generated once and shared by exactly the two files that need it, a host that also runs container
# sandboxes is tiered (P6.3), and a re-run changes nothing.
#
# sleep is NOT mocked: --remote's attach wait is bounded by the wall clock (bash's SECONDS), which a
# mocked sleep would turn into a busy loop. MICROVM_ATTACH_TIMEOUT=1 and MICROVM_ATTACH_SETTLE=1
# (the least the installer accepts) keep it short: about 1 s per attached --remote run, 2-3 s for one
# that is refused, and exactly one poll (one settle) for a worker that churns.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/setup-microvm.sh"
# The bash that launched this suite, not the first one on PATH (#440), as in
# deploy/k8s/tests/setup.test.sh: `/bin/bash setup-microvm.test.sh` on macOS must exercise bash
# 3.2. $BASH is the running interpreter's own path; the fallback is for a sourced run.
REAL_BASH="${BASH:-$(command -v bash)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
case "$1" in
  ps) [ -n "${MOCK_PODMAN_PS:-}" ] && printf '%s\n' $MOCK_PODMAN_PS
      # Stopped containers are listed only with -a, as podman does.
      [[ " $* " == *" -a "* && -n "${MOCK_PODMAN_PS_STOPPED:-}" ]] && printf '%s\n' $MOCK_PODMAN_PS_STOPPED ;;
  # exec sh-redis redis-cli <cmd> ...: MOCK_REDIS_DOWN=1 is a Redis that cannot be reached. HGET
  # answers a presence record per MOCK_RECORDS ("<id>=<tier> ..."; "<id>=" is a record with no tier
  # label, as a pre-P6.3 worker writes); an id not listed has none (not attached), an empty reply.
  exec)
    if [ -n "${MOCK_REDIS_DOWN:-}" ]; then echo 'Could not connect to Redis at 127.0.0.1:6379: Connection refused' >&2; exit 1; fi
    case "$4" in
      PING) echo PONG ;;
      HGET)
        for r in ${MOCK_RECORDS:-}; do
          [ "${r%%=*}" = "$6" ] || continue
          if [ -n "${r#*=}" ]; then labels="{\"moca.dev/tier\":\"${r#*=}\"}"; else labels='{}'; fi
          printf '{"sandboxId":"%s","labels":%s,"capabilities":["bash"],"transport":"grpc"}\n' "$6" "$labels"
        done ;;
      HDEL) echo 0 ;;
      *) echo "${MOCK_HEXISTS:-1}" ;; # HEXISTS sh:sandbox:records <id>
    esac ;;
  inspect) echo "${MOCK_IMAGE:-ghcr.io/rossoctl/moca-remote-worker:latest}" ;; # --format '{{.ImageName}}'
esac
exit 0
MOCK
cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
# is-active answers MOCK_IS_ACTIVE's exit code (0 = active, 3 = inactive/failed, as systemd does).
[ "$1" = is-active ] && exit "${MOCK_IS_ACTIVE:-0}"
# MOCK_EGRESS_START_FAILS=1: a Type=notify start of moca-egress that exits before READY=1, which
# systemd reports by failing the start/restart job itself (exit 1).
if [ -n "${MOCK_EGRESS_START_FAILS:-}" ] && { [ "$1" = start ] || [ "$1" = restart ]; } && [ "$2" = moca-egress.service ]; then
  echo "Job for moca-egress.service failed because the control process exited with error code." >&2; exit 1
fi
[ "$1" = show ] && { echo "${MOCK_INVOCATION:-inv-1}"; exit 0; } # show -p InvocationID --value <unit>
# try-restart of a unit systemd cannot find is refused, exit 5, as systemd does: a P6 host installed
# before #366 has no sh-control-plane.service. The installed units are the files under SH_UNIT_DIR.
if [ "$1" = try-restart ] && [ ! -f "$SH_UNIT_DIR/$2" ]; then echo "Failed to try-restart $2: Unit $2 not found." >&2; exit 5; fi
exit 0
MOCK
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
[ "$*" = "-u" ] && echo 0
MOCK
# go build -o <out> ...: write a deterministic fake binary so re-runs compare equal.
cat >"$TMP/bin/go" <<'MOCK'
#!/usr/bin/env bash
printf 'go %s\n' "$*" >>"$MOCK_LOG"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { printf 'fake-%s\n' "$(basename "$2")" >"$2"; }; shift; done
MOCK
# journalctl -o cat _SYSTEMD_INVOCATION_ID=<id>: the worker's attach line, only for the invocation that
# logged it (MOCK_JOURNAL_INV; default the current one), so a test can stage a line the PREVIOUS
# process left behind. MOCK_JOURNAL_TAIL, when set, is printed after the attached line: what the
# worker logs when the relay ends the stream (a wrong or revoked token is refused on the first frame).
# MOCK_JOURNAL_CHURN=1: a worker reconnecting in a loop -- call N (counted in journal-calls next to
# MOCK_LOG) returns N attached+stream-ended pairs, then an attached line, so every read ends "attached".
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
want="${MOCK_JOURNAL_INV:-${MOCK_INVOCATION:-inv-1}}"
if [[ " $* " == *" _SYSTEMD_INVOCATION_ID=$want "* ]]; then
  if [ -n "${MOCK_JOURNAL_CHURN:-}" ]; then
    calls="${MOCK_LOG%/*}/journal-calls"
    n=$(($(cat "$calls" 2>/dev/null || echo 0) + 1)); echo "$n" >"$calls"
    for ((j = 0; j < n; j++)); do
      echo 'microvm-worker: attached, serving execs'
      echo 'microvm-worker: stream ended (rpc error: code = Unavailable); reconnecting in 1s'
    done
  fi
  echo 'microvm-worker: attached, serving execs'
  [ -n "${MOCK_JOURNAL_TAIL:-}" ] && printf '%s\n' "$MOCK_JOURNAL_TAIL"
fi
exit 0
MOCK
# awk logs its argv like the other mocks, so a test can prove no token is ever an argument.
real_awk="$(command -v awk)"
# shellcheck disable=SC2016 # $* and $MOCK_LOG are for the mock to expand, not this shell
printf '#!/bin/sh\nprintf "awk %%s\\n" "$*" >>"$MOCK_LOG"\nexec %s "$@"\n' "$real_awk" >"$TMP/bin/awk"
# The bash mocks above are heredocs with `#!/usr/bin/env bash`, which resolves against the PATH
# below -- $TMP/bin first, then the caller's, so it would find Homebrew's 5.x even when this suite
# was launched with /bin/bash. Pin them to $REAL_BASH so the mocks run on the same interpreter as
# the script under test (#440). The awk shim needs no pin: it is sh and execs an absolute binary.
for m in podman systemctl id go journalctl; do
  { printf '#!%s\n' "$REAL_BASH"; tail -n +2 "$TMP/bin/$m"; } >"$TMP/bin/$m.new"
  mv "$TMP/bin/$m.new" "$TMP/bin/$m"
done
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"

reset_host() { # a fresh P6 install: relay.env + its three units, a snapshot, nothing of ours
  rm -rf "${TMP:?}/units" "${TMP:?}/etc" "${TMP:?}/usrbin" "${TMP:?}/snap"
  mkdir -p "$TMP/units" "$TMP/etc" "$TMP/usrbin" "$TMP/snap"
  printf 'SH_RELAY_PORT=9443\nSH_RELAY_TOKEN=container-token\nMOCA_RELAY_EXEC_TOKEN=exec-secret\n' \
    >"$TMP/etc/relay.env"
  local u
  for u in sh-relay sh-supervisor sh-control-plane; do printf '[Service]\nExecStart=/bin/true\n' >"$TMP/units/$u.service"; done
  printf '{}\n' >"$TMP/snap/manifest.json"
  : >"$MOCK_LOG"
}
# moca-egress's control socket: a real Unix socket, bound once for the whole file, so every run sees
# a ready proxy. The egress-readiness section below points the script elsewhere to test the failure.
EGRESS_SOCK="$TMP/egress.sock"
python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$EGRESS_SOCK"
export SH_UNIT_DIR="$TMP/units" SH_ENV_DIR="$TMP/etc" SH_BIN_DIR="$TMP/usrbin" \
  MICROVM_SNAPSHOT_DIR="$TMP/snap" MICROVM_ATTACH_TIMEOUT=1 MICROVM_ATTACH_SETTLE=1 \
  MOCA_EGRESS_SOCKET="$EGRESS_SOCK" MOCA_EGRESS_READY_TIMEOUT=2
run() { "$REAL_BASH" "$SCRIPT" >"$TMP/run.log" 2>&1; echo $?; }
val() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2-; }
hash_tree() { (cd "$TMP" && find units etc usrbin -type f -exec cksum {} + | sort); }

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck "$SCRIPT"; check "shellcheck clean" "$?" "0"
fi

echo "== sourcing has no side effects"
reset_host
# shellcheck source=/dev/null
( SH_SOURCE_ONLY=1 source "$SCRIPT" )
check "no commands ran" "$(wc -l <"$MOCK_LOG" | tr -d ' ')" "0"

echo "== helpers"
# shellcheck source=/dev/null
SH_SOURCE_ONLY=1 source "$SCRIPT"
set +e # the script's own `set -euo pipefail` must not govern the rest of this test
check "underscore id accepted" "$(validate_sandbox_id moca_microvm_0 2>/dev/null && echo yes || echo no)" "yes"
check "dashed id refused (systemd drops the SH_RELAY_TOKEN_<id> line)" \
  "$(validate_sandbox_id sbx-microvm-1 2>/dev/null && echo yes || echo no)" "no"
check "DIR refused, naming why (SH_RELAY_TOKEN_DIR is the relay's token-directory setting)" \
  "$(validate_sandbox_id DIR 2>&1 >/dev/null | grep -c 'reserved.*SH_RELAY_TOKEN_DIR')" "1"
printf 'SH_RELAY_PORT=9443\n' >"$TMP/p1"; check "plain port" "$(relay_port "$TMP/p1")" "9443"
printf 'SH_RELAY_PORT="9555"\n' >"$TMP/p2"; check "quoted port, as systemd strips it" "$(relay_port "$TMP/p2")" "9555"
printf 'REDIS_URL=x\n' >"$TMP/p3"; check "missing port falls back to the relay's 8443" "$(relay_port "$TMP/p3")" "8443"
printf 'SH_RELAY_PORT=abc\n' >"$TMP/p4"
check "non-numeric port refused" "$(relay_port "$TMP/p4" >/dev/null 2>&1 && echo yes || echo no)" "no"

echo "== first install"
reset_host
check "exit 0" "$(run)" "0"
W="$TMP/etc/microvm-worker.env"; R="$TMP/etc/microvm-relay.env"
tok="$(val SANDBOX_TOKEN "$W")"
check "a token was generated (64 hex chars)" "$(printf '%s' "$tok" | grep -cE '^[0-9a-f]{64}$')" "1"
check "the relay holds the SAME token under the per-sandbox name" "$(val SH_RELAY_TOKEN_moca_microvm_0 "$R")" "$tok"
check "worker dials the relay's attach port on loopback" "$(val RELAY_ADDR "$W")" "127.0.0.1:9443"
check "worker sandbox id" "$(val SANDBOX_ID "$W")" "moca_microvm_0"
check "workspace idle default" "$(val SH_WORKSPACE_IDLE "$W")" "8h"
check "worker env never carries the exec token" "$(grep -c 'MOCA_RELAY_EXEC_TOKEN' "$W")" "0"
check "worker env never carries the container token" "$(grep -c '^SH_RELAY_TOKEN' "$W")" "0"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; } # GNU first: GNU `stat -f` is filesystem status
check "worker env is 0600" "$(mode "$W")" "600"
check "relay env is 0600" "$(mode "$R")" "600"
check "P6's relay.env untouched" "$(val SH_RELAY_TOKEN "$TMP/etc/relay.env")" "container-token"
check "relay drop-in loads the new env file" \
  "$(grep -c "^EnvironmentFile=$TMP/etc/microvm-relay.env\$" "$TMP/units/sh-relay.service.d/50-moca-microvm.conf")" "1"
check "worker drop-in loads its env file" \
  "$(grep -c "^EnvironmentFile=$TMP/etc/microvm-worker.env\$" "$TMP/units/microvm-worker.service.d/50-moca-p6.conf")" "1"
check "worker is ordered after the relay" \
  "$(grep -c '^After=sh-relay.service$' "$TMP/units/microvm-worker.service.d/50-moca-p6.conf")" "1"
check "shipped unit installed verbatim" "$(cmp -s "$DIR/microvm-worker.service" "$TMP/units/microvm-worker.service" && echo yes || echo no)" "yes"
check "slice installed" "$([ -f "$TMP/units/microvm-vms.slice" ] && echo yes || echo no)" "yes"
check "binary installed" "$(cat "$TMP/usrbin/microvm-worker")" "fake-microvm-worker"
check "daemon-reload" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "relay restarted to load the token" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"
check "worker enabled" "$(grep -c '^systemctl enable microvm-worker.service$' "$MOCK_LOG")" "1"
check "worker stopped, its presence record cleared, then started -- in that order (I4)" \
  "$(grep -nE '^systemctl stop microvm-worker.service$|HDEL sh:sandbox:records moca_microvm_0$|^systemctl start microvm-worker.service$' "$MOCK_LOG" | cut -d: -f2- | sed 's/^podman exec sh-redis redis-cli //' | tr '\n' '|')" \
  "systemctl stop microvm-worker.service|HDEL sh:sandbox:records moca_microvm_0|systemctl start microvm-worker.service|"
check "attach verified against the presence records" \
  "$(grep -c 'podman exec sh-redis redis-cli HEXISTS sh:sandbox:records moca_microvm_0' "$MOCK_LOG")" "1"

echo "== moca-egress (P4.1): binary, unit, allowlist seed, start order"
E="$TMP/etc/moca-egress.env"
check "egress binary installed" "$(cat "$TMP/usrbin/moca-egress")" "fake-moca-egress"
check "egress binary is 0755" "$(mode "$TMP/usrbin/moca-egress")" "755"
check "egress built from its own cmd" "$(grep -c 'go build .*-o .*moca-egress ./cmd/moca-egress$' "$MOCK_LOG")" "1"
check "egress unit installed verbatim" "$(cmp -s "$DIR/moca-egress.service" "$TMP/units/moca-egress.service" && echo yes || echo no)" "yes"
check "egress env seeded with the default allowlist" "$(val MOCA_EGRESS_ALLOW "$E")" \
  "api.github.com,github.com,codeload.github.com,objects.githubusercontent.com"
check "egress env is 0644 (no secret in it)" "$(mode "$E")" "644"
check "egress enabled" "$(grep -c '^systemctl enable moca-egress.service$' "$MOCK_LOG")" "1"
check "egress started before the worker" \
  "$(grep -nE '^systemctl (re)?start moca-egress.service$|^systemctl start microvm-worker.service$' "$MOCK_LOG" | cut -d: -f2- | tr '\n' '|')" \
  "systemctl restart moca-egress.service|systemctl start microvm-worker.service|"

echo "== an operator's moca-egress.env survives a re-run; MOCA_EGRESS_ALLOW seeds only a fresh file"
printf 'MOCA_EGRESS_ALLOW=example.test\n' >"$E"
: >"$MOCK_LOG"
check "exit 0" "$(MOCA_EGRESS_ALLOW=other.test run)" "0"
check "the planted allowlist is untouched" "$(val MOCA_EGRESS_ALLOW "$E")" "example.test"
check "an operator-edited env is not overwritten and does not restart moca-egress" \
  "$(grep -c '^systemctl restart moca-egress.service$' "$MOCK_LOG")" "0"
rm -f "$E"
: >"$MOCK_LOG"
check "exit 0" "$(MOCA_EGRESS_ALLOW=seed.test run)" "0"
check "a fresh file takes MOCA_EGRESS_ALLOW from the environment" "$(val MOCA_EGRESS_ALLOW "$E")" "seed.test"
check "and egress is restarted for it, worker untouched" \
  "$(grep -cE '^systemctl restart moca-egress.service$' "$MOCK_LOG")/$(grep -cE 'systemctl (stop|start) microvm-worker' "$MOCK_LOG")" "1/0"

echo "== a re-run changes nothing"
before="$(hash_tree)"; : >"$MOCK_LOG"
check "exit 0" "$(run)" "0"
check "every file byte-identical" "$(hash_tree)" "$before"
check "no daemon-reload" "$(grep -c 'daemon-reload' "$MOCK_LOG")" "0"
check "no restart" "$(grep -c 'restart' "$MOCK_LOG")" "0"
check "a running worker is not stopped or started" "$(grep -cE 'systemctl (stop|start) microvm-worker' "$MOCK_LOG")" "0"

echo "== a re-run starts a worker that is stopped or failed, restarting nothing (I1)"
: >"$MOCK_LOG"
check "exit 0" "$(MOCK_IS_ACTIVE=3 run)" "0"
check "files still byte-identical" "$(hash_tree)" "$before"
check "failed state cleared" "$(grep -c '^systemctl reset-failed microvm-worker.service$' "$MOCK_LOG")" "1"
check "worker started" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
check "stale presence record cleared first" "$(grep -c 'HDEL sh:sandbox:records moca_microvm_0$' "$MOCK_LOG")" "1"
check "nothing restarted" "$(grep -c 'restart' "$MOCK_LOG")" "0"

echo "== an operator's edit survives a re-run (Review Focus 1)"
sed -i.bak 's/^SH_WORKSPACE_IDLE=.*/SH_WORKSPACE_IDLE=12h/' "$W" && rm -f "$W.bak"
printf 'SH_DIAG_STATS_ADDR=127.0.0.1:9900\n' >>"$W"
: >"$MOCK_LOG"
check "exit 0" "$(run)" "0"
check "edited idle kept" "$(val SH_WORKSPACE_IDLE "$W")" "12h"
check "operator's extra line kept" "$(val SH_DIAG_STATS_ADDR "$W")" "127.0.0.1:9900"
check "token not rotated" "$(val SANDBOX_TOKEN "$W")" "$tok"
check "no restart (the installer did not change the file)" "$(grep -c 'restart' "$MOCK_LOG")" "0"

echo "== a changed sandbox id leaves no stale token at the relay"
: >"$MOCK_LOG"
check "exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MOCK_HEXISTS=1 run)" "0"
check "only the new id's token line" "$(grep -c '^SH_RELAY_TOKEN_' "$R")" "1"
check "it names the new id" "$(grep -c '^SH_RELAY_TOKEN_moca_microvm_1=' "$R")" "1"
check "the relay was restarted to drop the old one" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"

echo "== MICROVM_MAX_COMMITTED_MB: a budget for a host smaller than the shipped unit assumes"
M="$TMP/units/microvm-worker.service.d/60-moca-memory.conf"
: >"$MOCK_LOG"
check "exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MICROVM_MAX_COMMITTED_MB=8192 run)" "0"
check "the budget reaches the worker" "$(grep -c '^Environment=SH_MAX_COMMITTED_MB=8192$' "$M")" "1"
# Same band systemd-units.test.sh holds the shipped unit to: AssertMemory at 90% of the budget.
check "the shipped AssertMemory is reset first" "$(grep -c '^AssertMemory=$' "$M")" "1"
check "then re-asserted at 90% of the budget" "$(grep -c '^AssertMemory=>=7372M$' "$M")" "1"
# `AssertMemory=` (empty) resets the WHOLE assertion list, not just AssertMemory (systemd.unit(5),
# verified on the rig: a unit asserting a missing path started once the reset was in a drop-in). So
# every other assertion the shipped unit makes -- /dev/kvm above all -- must be re-stated after it.
# Process substitution, not a pipe: `check` must run in THIS shell or its failure count is lost.
while read -r a; do
  check "the drop-in re-states the shipped $a" "$(grep -cxF "$a" "$M")" "1"
done < <(grep -E '^Assert[A-Za-z]+=' "$DIR/microvm-worker.service" | grep -v '^AssertMemory=')
check "the shipped unit has a non-memory assertion to re-state (else this test proves nothing)" \
  "$(grep -cE '^Assert[A-Za-z]+=' "$DIR/microvm-worker.service" | awk '{print ($1 > 1) ? "yes" : "no"}')" "yes"
check "reset precedes the new assertion" "$(grep -nE '^AssertMemory=' "$M" | cut -d: -f1 | tr '\n' ' ')" "4 5 "
check "the reset precedes every re-stated assertion" \
  "$(awk '/^AssertMemory=$/{r=NR} /^Assert/ && !/^AssertMemory=$/{if (!r || NR < r) bad=1} END{print bad ? "no" : "yes"}' "$M")" "yes"
check "daemon-reload" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "worker started with the new budget" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
mem_before="$(hash_tree)"; : >"$MOCK_LOG"
check "re-run exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MICROVM_MAX_COMMITTED_MB=8192 run)" "0"
check "re-run changes nothing" "$(hash_tree)" "$mem_before"
check "re-run restarts nothing" "$(grep -cE 'restart|systemctl (stop|start)' "$MOCK_LOG")" "0"
: >"$MOCK_LOG"
check "unset again: exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 run)" "0"
check "unset again: the override is removed" "$([ -e "$M" ] && echo present || echo absent)" "absent"
check "unset again: the worker picks up the shipped budget" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
# 0100000: bash arithmetic reads a leading zero as octal (32768) while Go parses 100000 -- the
# assertion and the budget would silently disagree.
for bad in abc 0 4096 -1 0100000; do
  reset_host
  check "MICROVM_MAX_COMMITTED_MB=$bad refused" "$(MICROVM_MAX_COMMITTED_MB="$bad" run)" "1"
  check "MICROVM_MAX_COMMITTED_MB=$bad: nothing written" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
done
reset_host; MICROVM_MAX_COMMITTED_MB=4096 run >/dev/null
check "the refusal names the reserve it must exceed" "$(grep -c 'MICROVM_MAX_COMMITTED_MB.*SH_MEMORY_RESERVE_MB' "$TMP/run.log")" "1"

echo "== MICROVM_ATTACH_TIMEOUT / MICROVM_ATTACH_SETTLE: whole seconds, the settle at least 1"
for bad in SETTLE=0 SETTLE=x TIMEOUT=x; do
  reset_host
  check "MICROVM_ATTACH_$bad refused" "$(env "MICROVM_ATTACH_$bad" "$REAL_BASH" "$SCRIPT" >"$TMP/run.log" 2>&1; echo $?)" "1"
  check "MICROVM_ATTACH_$bad: nothing written" "$(find "$TMP/etc" "$TMP/units" -name '*microvm*' | wc -l | tr -d ' ')" "0"
  check "MICROVM_ATTACH_$bad: the refusal names the variable" "$(grep -c "MICROVM_ATTACH_${bad%%=*}='${bad#*=}' must be" "$TMP/run.log")" "1"
done
reset_host; MICROVM_ATTACH_SETTLE=0 run >/dev/null
check "the settle refusal names the worker's first backoff it must outlast" "$(grep -c 'MICROVM_ATTACH_SETTLE.*750ms' "$TMP/run.log")" "1"

echo "== refusals write nothing"
for case in no-p6 no-snapshot dashed-id reserved-id bad-default; do
  reset_host
  case "$case" in
    no-p6) rm -f "$TMP/etc/relay.env" ;;
    no-snapshot) rm -f "$TMP/snap/manifest.json" ;;
    dashed-id) export MICROVM_SANDBOX_ID=sbx-microvm-1 ;;
    reserved-id) export MICROVM_SANDBOX_ID=DIR ;; # the relay refuses it before any lookup
    # On a mixed host, so the refusal is proven to come before install_tiers writes anything.
    bad-default) export SH_SANDBOX_DEFAULT_TIER=gpu MOCK_PODMAN_PS="sh-sandbox-0" ;;
  esac
  check "$case: exit 1" "$(run)" "1"
  check "$case: no microvm env files" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
  check "$case: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
  unset MOCK_PODMAN_PS MOCK_PODMAN_PS_STOPPED MICROVM_SANDBOX_ID SH_SANDBOX_DEFAULT_TIER
done
reset_host; SH_SANDBOX_DEFAULT_TIER=gpu run >/dev/null
check "bad-default: the refusal names the variable and its choices" \
  "$(grep -c "SH_SANDBOX_DEFAULT_TIER='gpu' must be container or microvm" "$TMP/run.log")" "1"

echo "== a host with container sandboxes too is tiered, not refused (P6.3, spec §7)"
TE="$TMP/etc/microvm-tiers.env"
TS="$TMP/units/sh-supervisor.service.d/50-microvm-tiers.conf"
TC="$TMP/units/sh-control-plane.service.d/50-microvm-tiers.conf"
tiers_files() { echo "$([ -e "$TE" ] && echo env)$([ -e "$TS" ] && echo +sup)$([ -e "$TC" ] && echo +cp)"; }
for case in containers stopped-containers; do
  reset_host
  case "$case" in
    containers) export MOCK_PODMAN_PS="sh-sandbox-0 sh-sandbox-1" MOCK_RECORDS="sh-sandbox-0=container sh-sandbox-1=container" ;;
    # I3: a stopped --restart=always container comes back at boot (podman-restart.service), so
    # it counts: the host is mixed again after the next boot.
    stopped-containers) export MOCK_PODMAN_PS_STOPPED="sh-sandbox-0" ;;
  esac
  check "mixed host ($case): exit 0 (no longer refused)" "$(run)" "0"
  check "mixed host ($case): tiers env" "$(val SH_SANDBOX_TIERS "$TE")" "container,microvm"
  check "mixed host ($case): default tier" "$(val SH_SANDBOX_DEFAULT_TIER "$TE")" "container"
  check "mixed host ($case): supervisor drop-in" \
    "$(grep -c "^EnvironmentFile=$TE$" "$TS")" "1"
  check "mixed host ($case): control-plane drop-in" \
    "$(grep -c "^EnvironmentFile=$TE$" "$TC")" "1"
  check "mixed host ($case): supervisor try-restarted" "$(grep -c '^systemctl try-restart sh-supervisor.service$' "$MOCK_LOG")" "1"
  check "mixed host ($case): control plane try-restarted" "$(grep -c '^systemctl try-restart sh-control-plane.service$' "$MOCK_LOG")" "1"
  check "mixed host ($case): never a plain restart of either" "$(grep -cE '^systemctl restart sh-(supervisor|control-plane)\.service$' "$MOCK_LOG")" "0"
  check "mixed host ($case): logged" "$(grep -c 'two sandbox tiers on this host' "$TMP/run.log")" "1"
  check "mixed host ($case): supervisor.env and control-plane.env never written" \
    "$(find "$TMP/etc" -name 'supervisor.env' -o -name 'control-plane.env' | wc -l | tr -d ' ')" "0"
  unset MOCK_PODMAN_PS MOCK_PODMAN_PS_STOPPED MOCK_RECORDS
done
check "mixed host (stopped-containers): warned that its tier cannot be checked" \
  "$(grep -c 'sh-sandbox-0 is not running, so its tier cannot be checked; it must be P6.3 or later' "$TMP/run.log")" "1"
check "mixed host (stopped-containers): Redis not asked about a stopped container" "$(grep -c 'HGET' "$MOCK_LOG")" "0"

echo "== a mixed host whose running containers are not P6.3 is refused, writing nothing (I1)"
# setup-vm.sh never pulls (podman run --replace), so an old host keeps its old image: its containers
# advertise no moca.dev/tier, the tiered harness excludes them, and every container session fails.
for case in unlabelled other-tier not-attached redis-down; do
  reset_host
  export MOCK_PODMAN_PS="sh-sandbox-0 sh-sandbox-1"
  case "$case" in
    unlabelled) export MOCK_RECORDS="sh-sandbox-0=container sh-sandbox-1=" ;;
    other-tier) export MOCK_RECORDS="sh-sandbox-0=container sh-sandbox-1=microvm" ;;
    not-attached) export MOCK_RECORDS="sh-sandbox-0=container" ;;
    redis-down) export MOCK_REDIS_DOWN=1 ;;
  esac
  check "$case: exit 1" "$(run)" "1"
  check "$case: nothing written" "$(find "$TMP/etc" "$TMP/units" "$TMP/usrbin" -name '*microvm*' | wc -l | tr -d ' ')" "0"
  check "$case: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
  case "$case" in
    unlabelled | other-tier)
      check "$case: names the container" "$(grep -c 'sh-sandbox-1' "$TMP/run.log")" "1"
      check "$case: names the pull of its image" \
        "$(grep -c 'podman pull ghcr.io/rossoctl/moca-remote-worker:latest' "$TMP/run.log")" "1"
      check "$case: then setup-vm.sh, whose --replace recreates the containers" \
        "$(grep -c 'deploy/vm/setup-vm.sh.*--replace' "$TMP/run.log")" "1"
      check "$case: the image is read from that container" \
        "$(grep -c '^podman inspect --format {{.ImageName}} sh-sandbox-1$' "$MOCK_LOG")" "1" ;;
    not-attached)
      check "$case: says it is not attached, so its tier cannot be checked" \
        "$(grep -c 'sh-sandbox-1 is running but not attached.*tier cannot be checked' "$TMP/run.log")" "1" ;;
    redis-down)
      check "$case: says Redis cannot be reached" "$(grep -c 'cannot reach Redis' "$TMP/run.log")" "1" ;;
  esac
  unset MOCK_PODMAN_PS MOCK_RECORDS MOCK_REDIS_DOWN
done
reset_host
got="$(MOCK_PODMAN_PS="sh-sandbox-0" MOCK_RECORDS="sh-sandbox-0=" MOCK_IMAGE=registry.example/moca-worker:v6.2 run)"
check "an image other than the default: exit 1, and the pull names the image the container runs" \
  "$got $(grep -c 'podman pull registry.example/moca-worker:v6.2,' "$TMP/run.log")" "1 1"
reset_host
export MOCK_PODMAN_PS="sh-sandbox-0" MOCK_PODMAN_PS_STOPPED="sh-sandbox-1" MOCK_RECORDS="sh-sandbox-0=container"
check "one running (labelled), one stopped: exit 0, tiered" "$(run)" "0"
check "one running (labelled), one stopped: tiers env" "$(val SH_SANDBOX_TIERS "$TE")" "container,microvm"
check "one running (labelled), one stopped: the stopped one is named in a warning" \
  "$(grep -c 'sh-sandbox-1 is not running, so its tier cannot be checked' "$TMP/run.log")" "1"
check "one running (labelled), one stopped: only the running one is looked up" \
  "$(grep -c 'HGET sh:sandbox:records sh-sandbox-0$' "$MOCK_LOG") $(grep -c 'HGET sh:sandbox:records sh-sandbox-1' "$MOCK_LOG")" "1 0"
unset MOCK_PODMAN_PS MOCK_PODMAN_PS_STOPPED MOCK_RECORDS
reset_host
check "a P4-only host never asks Redis about containers: exit 0" "$(run)" "0"
check "a P4-only host never asks Redis about containers: no HGET, no PING" "$(grep -cE 'HGET|PING' "$MOCK_LOG")" "0"

export MOCK_PODMAN_PS="sh-sandbox-0 sh-sandbox-1" MOCK_RECORDS="sh-sandbox-0=container sh-sandbox-1=container" # mixed
reset_host; run >/dev/null
before="$(hash_tree)"; : >"$MOCK_LOG"
check "mixed re-run: exit 0" "$(run)" "0"
check "mixed re-run: every file byte-identical" "$(hash_tree)" "$before"
check "mixed re-run: no daemon-reload" "$(grep -c 'daemon-reload' "$MOCK_LOG")" "0"
check "mixed re-run: neither unit try-restarted" "$(grep -cE 'restart sh-(supervisor|control-plane)' "$MOCK_LOG")" "0"

: >"$MOCK_LOG"
check "SH_SANDBOX_DEFAULT_TIER=microvm: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm run)" "0"
check "SH_SANDBOX_DEFAULT_TIER=microvm: written" "$(val SH_SANDBOX_DEFAULT_TIER "$TE")" "microvm"
check "SH_SANDBOX_DEFAULT_TIER=microvm: the tiers unchanged" "$(val SH_SANDBOX_TIERS "$TE")" "container,microvm"
check "SH_SANDBOX_DEFAULT_TIER=microvm: both units try-restarted" \
  "$(grep -cE '^systemctl try-restart sh-(supervisor|control-plane)\.service$' "$MOCK_LOG")" "2"
# An env file is re-read at every start; only a changed unit or drop-in needs a reload.
check "SH_SANDBOX_DEFAULT_TIER=microvm: no daemon-reload (only the env file changed)" \
  "$(grep -c 'daemon-reload' "$MOCK_LOG")" "0"

# Sticky (as deploy/k8s/setup.sh's input is): unset keeps the stored value; set but empty clears it.
before="$(hash_tree)"; : >"$MOCK_LOG"
check "sticky default, re-run without it: exit 0" "$(run)" "0"
check "sticky default, re-run without it: microvm kept" "$(val SH_SANDBOX_DEFAULT_TIER "$TE")" "microvm"
check "sticky default, re-run without it: every file byte-identical" "$(hash_tree)" "$before"
check "sticky default, re-run without it: nothing restarted" "$(grep -c 'restart' "$MOCK_LOG")" "0"
: >"$MOCK_LOG"
check "SH_SANDBOX_DEFAULT_TIER= (set, empty): exit 0" "$(SH_SANDBOX_DEFAULT_TIER='' run)" "0"
check "SH_SANDBOX_DEFAULT_TIER= (set, empty): cleared to container" "$(val SH_SANDBOX_DEFAULT_TIER "$TE")" "container"
check "SH_SANDBOX_DEFAULT_TIER= (set, empty): both units try-restarted" \
  "$(grep -cE '^systemctl try-restart sh-(supervisor|control-plane)\.service$' "$MOCK_LOG")" "2"

unset MOCK_PODMAN_PS MOCK_RECORDS; : >"$MOCK_LOG"
check "back to P4-only: exit 0" "$(run)" "0"
check "back to P4-only: the tiers env and both drop-ins are gone" "$(tiers_files)" ""
# S2: going P4-only drops the stored default with the file; a non-container one is named.
check "back to P4-only: the dropped default is not named (the stored default is container)" \
  "$(grep -c "stored SH_SANDBOX_DEFAULT_TIER=microvm in $TE is dropped with it" "$TMP/run.log")" "0"
check "back to P4-only: daemon-reload (the drop-ins went)" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "back to P4-only: supervisor try-restarted" "$(grep -c '^systemctl try-restart sh-supervisor.service$' "$MOCK_LOG")" "1"
check "back to P4-only: control plane try-restarted" "$(grep -c '^systemctl try-restart sh-control-plane.service$' "$MOCK_LOG")" "1"
check "back to P4-only: never a plain restart of either" "$(grep -cE '^systemctl restart sh-(supervisor|control-plane)\.service$' "$MOCK_LOG")" "0"
: >"$MOCK_LOG"
check "P4-only re-run: exit 0" "$(run)" "0"
check "P4-only re-run: neither unit try-restarted" "$(grep -cE 'restart sh-(supervisor|control-plane)' "$MOCK_LOG")" "0"
check "P4-only re-run: not logged as tiered" "$(grep -c 'two sandbox tiers' "$TMP/run.log")" "0"

echo "== an attach that never shows up fails the install, naming the journal"
reset_host
check "exit 1" "$(MOCK_HEXISTS=0 run)" "1"
check "points at journalctl" "$(grep -c 'journalctl -u microvm-worker' "$TMP/run.log")" "1"

echo "== --remote: a P4 host attached to a relay in a cluster (k8s slice 2 spec §5)"
BTOK=0a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d4e5f6071 # 64 hex, as setup.sh issues
mkbundle() { # mkbundle DIR [RELAY_ADDR] [with-ca|no-ca]
  mkdir -p "$1"
  printf 'RELAY_ADDR=%s\nRELAY_TLS=true\nSANDBOX_ID=moca_microvm_0\nSANDBOX_TOKEN=%s\n' "${2:-moca-relay-moca.apps.example.test:443}" "$BTOK" >"$1/worker.env"
  if [[ "${3:-with-ca}" == with-ca ]]; then
    printf -- '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n' >"$1/relay-ca.crt"
  else
    rm -f "$1/relay-ca.crt"
  fi
}
reset_remote_host() { # no P6 at all: just a snapshot
  reset_host
  rm -f "$TMP/etc/relay.env" "$TMP/units/"sh-*.service
}
runr() { "$REAL_BASH" "$SCRIPT" --remote "$1" >"$TMP/run.log" 2>&1; echo $?; }
B="$TMP/bundle"; CA="$TMP/etc/microvm-relay-ca.crt"; RD="$TMP/units/microvm-worker.service.d/50-moca-remote.conf"
W="$TMP/etc/microvm-worker.env"; R="$TMP/etc/microvm-relay.env"

reset_remote_host; mkbundle "$B"
check "exit 0, with no P6 on this host" "$(runr "$B")" "0"
check "worker dials the relay Route" "$(val RELAY_ADDR "$W")" "moca-relay-moca.apps.example.test:443"
check "over TLS" "$(val RELAY_TLS "$W")" "true"
check "as the bundle's sandbox" "$(val SANDBOX_ID "$W")" "moca_microvm_0"
check "with the bundle's token" "$(val SANDBOX_TOKEN "$W")" "$BTOK"
check "trusting the bundle's CA" "$(val RELAY_CA_FILE "$W")" "$CA"
check "workspace idle default" "$(val SH_WORKSPACE_IDLE "$W")" "8h"
check "worker env is 0600" "$(mode "$W")" "600"
check "the CA is installed 0644, verbatim" "$(mode "$CA") $(cmp -s "$B/relay-ca.crt" "$CA" && echo same)" "644 same"
check "remote drop-in loads the worker env" "$(grep -c "^EnvironmentFile=$W\$" "$RD")" "1"
check "remote drop-in waits for the network" "$(grep -c '^Wants=network-online.target$' "$RD")" "1"
check "remote drop-in never names the local relay" "$(grep -c 'sh-relay' "$RD")" "0"
check "no local-relay worker drop-in" "$([ -e "$TMP/units/microvm-worker.service.d/50-moca-p6.conf" ] && echo present || echo absent)" "absent"
check "no relay drop-in, no relay env" "$([ -e "$TMP/units/sh-relay.service.d" ] || [ -e "$R" ] && echo present || echo absent)" "absent"
check "no podman (no local Redis, no container check)" "$(grep -c '^podman' "$MOCK_LOG")" "0"
check "worker started" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
# Two reads: the poll that sees the attach, and the re-read after the settle window. Both are the
# current invocation's journal, never the unit's whole history.
check "attach read from the current invocation's journal, then re-read after the settle" \
  "$(grep -c '^journalctl ' "$MOCK_LOG") $(grep -c '^journalctl .*_SYSTEMD_INVOCATION_ID=inv-1' "$MOCK_LOG")" "2 2"
check "the token never reached an argv" "$(grep -c "$BTOK" "$MOCK_LOG")" "0"

before="$(hash_tree)"; : >"$MOCK_LOG"
check "re-run: exit 0" "$(runr "$B")" "0"
check "re-run: every file byte-identical" "$(hash_tree)" "$before"
check "re-run: nothing stopped, started or restarted" "$(grep -cE 'restart|systemctl (stop|start)' "$MOCK_LOG")" "0"

# Review Focus 3: the only attach line belongs to an earlier invocation (inv-1); the unit's current
# one (inv-2: the worker restarted, say, and is failing its TLS handshake) has logged none.
: >"$MOCK_LOG"
check "a stale attach line: exit 1" "$(MOCK_INVOCATION=inv-2 MOCK_JOURNAL_INV=inv-1 runr "$B")" "1"
check "it names the current invocation's journal" "$(grep -c 'journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=inv-2' "$TMP/run.log")" "1"

# The worker logs "attached" as soon as its stream opens; the relay checks the token on the first frame
# and ends the stream, and the worker logs "stream ended" within milliseconds and reconnects.
: >"$MOCK_LOG"
check "a token the relay rejects (attached, then stream ended): exit 1" \
  "$(MOCK_JOURNAL_TAIL='microvm-worker: stream ended (rpc error: code = Unavailable); reconnecting in 1s' runr "$B")" "1"
check "the rejection names the current invocation's journal" "$(grep -c 'journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=inv-1' "$TMP/run.log")" "1"
check "the rejection names the token as a cause" "$(grep -c 'wrong or revoked token' "$TMP/run.log")" "1"
# The race the count closes: a rejected worker loops attached -> stream ended -> backoff -> attached,
# and a re-read just after a fresh attached line ends "attached" too.
rm -f "$TMP/journal-calls"; : >"$MOCK_LOG"
check "a worker reconnecting through the settle window (churn): exit 1" "$(MOCK_JOURNAL_CHURN=1 runr "$B")" "1"
check "churn: the journal was re-read after the settle" "$(cat "$TMP/journal-calls")" "2"
# The wait is bounded by the wall clock: TIMEOUT=3 SETTLE=2 ends within about 3 + 2 + 1 s. The old
# count of polls took 3 x (1 + 2) = 9 s, since each churning poll spends a whole settle window.
rm -f "$TMP/journal-calls"; t0=$SECONDS
MICROVM_ATTACH_TIMEOUT=3 MICROVM_ATTACH_SETTLE=2 MOCK_JOURNAL_CHURN=1 runr "$B" >/dev/null
check "churn, TIMEOUT=3 SETTLE=2: refused within TIMEOUT + SETTLE + 1 (+1 s slack), not 9 s" \
  "$( ((SECONDS - t0 <= 7)) && echo bounded || echo "took $((SECONDS - t0))s")" "bounded"
check "churn: the refusal names the current invocation's journal" "$(grep -c 'journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=inv-1' "$TMP/run.log")" "1"
check "an attach after a stream that ended counts (a reconnect): exit 0" \
  "$(MOCK_JOURNAL_TAIL="$(printf 'microvm-worker: stream ended (EOF); reconnecting in 1s\nmicrovm-worker: attached, serving execs')" runr "$B")" "0"

mkbundle "$B" moca-relay-moca.apps.example.test:443 no-ca; : >"$MOCK_LOG"
check "a bundle without a CA: exit 0" "$(runr "$B")" "0"
check "RELAY_CA_FILE removed" "$(grep -c '^RELAY_CA_FILE=' "$W")" "0"
check "the old CA file removed" "$([ -e "$CA" ] && echo present || echo absent)" "absent"

echo "== --remote refuses a bad bundle, writing nothing"
for case in no-env no-port tls-false dashed-id short-token bad-ca no-value; do
  reset_remote_host; rm -rf "${B:?}"; mkbundle "$B"
  arg="$B"
  case "$case" in
    no-env) rm -f "$B/worker.env" ;;
    no-port) mkbundle "$B" moca-relay-moca.apps.example.test ;; # Review Focus 4
    tls-false) sed -i.bak 's/^RELAY_TLS=.*/RELAY_TLS=false/' "$B/worker.env" ;;
    dashed-id) sed -i.bak 's/^SANDBOX_ID=.*/SANDBOX_ID=moca-microvm-0/' "$B/worker.env" ;;
    short-token) sed -i.bak 's/^SANDBOX_TOKEN=.*/SANDBOX_TOKEN=abc/' "$B/worker.env" ;;
    bad-ca) printf 'not a certificate\n' >"$B/relay-ca.crt" ;;
    no-value) arg='' ;;
  esac
  if [[ -n "$arg" ]]; then got="$(runr "$arg")"; else got="$("$REAL_BASH" "$SCRIPT" --remote >"$TMP/run.log" 2>&1; echo $?)"; fi
  check "$case: exit 1" "$got" "1"
  check "$case: no microvm env files" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
  check "$case: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
  check "$case: the token is not echoed" "$(grep -c "$BTOK" "$TMP/run.log")" "0"
done
reset_remote_host; mkbundle "$B" moca-relay-moca.apps.example.test; runr "$B" >/dev/null
check "no-port: the refusal names host:443" "$(grep -c 'must be host:port.*:443' "$TMP/run.log")" "1"
reset_remote_host; mkbundle "$B"
check "MICROVM_SANDBOX_ID disagreeing with the bundle: exit 1" "$(MICROVM_SANDBOX_ID=moca_microvm_9 runr "$B")" "1"

echo "== switching back: local mode after --remote restores the local relay's token"
reset_host
check "local install: exit 0" "$(run)" "0"
ltok="$(val SANDBOX_TOKEN "$W")"
mkbundle "$B"; : >"$MOCK_LOG"
check "then --remote: exit 0" "$(runr "$B")" "0"
check "--remote: the bundle's token replaces the local one" "$(val SANDBOX_TOKEN "$W")" "$BTOK"
check "--remote: the relay's copy is left in place" "$(val SH_RELAY_TOKEN_moca_microvm_0 "$R")" "$ltok"
check "--remote: the local relay is not restarted" "$(grep -c 'restart sh-relay' "$MOCK_LOG")" "0"
check "--remote: 50-moca-p6.conf replaced by 50-moca-remote.conf" \
  "$([ -e "$TMP/units/microvm-worker.service.d/50-moca-p6.conf" ] && echo p6)$([ -e "$RD" ] && echo remote)" "remote"
: >"$MOCK_LOG"
check "back to local: exit 0" "$(run)" "0"
check "local: the local token is back" "$(val SANDBOX_TOKEN "$W")" "$ltok"
check "local: loopback relay again" "$(val RELAY_ADDR "$W")" "127.0.0.1:9443"
check "local: no RELAY_TLS, no RELAY_CA_FILE" "$(grep -cE '^(RELAY_TLS|RELAY_CA_FILE)=' "$W")" "0"
check "local: the CA file is gone" "$([ -e "$CA" ] && echo present || echo absent)" "absent"
check "local: 50-moca-p6.conf back, 50-moca-remote.conf gone" \
  "$([ -e "$TMP/units/microvm-worker.service.d/50-moca-p6.conf" ] && echo p6)$([ -e "$RD" ] && echo remote)" "p6"
check "local: the relay is not restarted (its drop-in and env did not change)" "$(grep -c 'restart sh-relay' "$MOCK_LOG")" "0"
check "local: attach verified against the local presence records" "$(grep -c 'HEXISTS sh:sandbox:records moca_microvm_0' "$MOCK_LOG")" "1"
check "local: no token on any argv" "$(grep -cE "$BTOK|$ltok" "$MOCK_LOG")" "0"

echo "== a P6 installed before the control plane (#366): try-restart only the units that exist"
reset_host; rm -f "$TMP/units/sh-control-plane.service"; export MOCK_PODMAN_PS="sh-sandbox-0" MOCK_RECORDS="sh-sandbox-0=container"
check "no control-plane unit: exit 0" "$(run)" "0"
check "no control-plane unit: the supervisor try-restarted" "$(grep -c '^systemctl try-restart sh-supervisor.service$' "$MOCK_LOG")" "1"
check "no control-plane unit: no try-restart of the missing unit" "$(grep -c 'try-restart sh-control-plane' "$MOCK_LOG")" "0"
check "no control-plane unit: the worker started" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
check "no control-plane unit: its drop-in is still written, for a later setup-vm.sh install" \
  "$(grep -c "^EnvironmentFile=$TE$" "$TC")" "1"
unset MOCK_PODMAN_PS MOCK_RECORDS

echo "== a bad default stored in microvm-tiers.env is refused, writing nothing"
reset_host; export MOCK_PODMAN_PS="sh-sandbox-0" MOCK_RECORDS="sh-sandbox-0=container"
run >/dev/null
sed -i.bak 's/^SH_SANDBOX_DEFAULT_TIER=.*/SH_SANDBOX_DEFAULT_TIER=gpu/' "$TE" && rm -f "$TE.bak"
before="$(hash_tree)"; : >"$MOCK_LOG"
check "stored garbage: exit 1" "$(run)" "1"
check "stored garbage: every file byte-identical" "$(hash_tree)" "$before"
check "stored garbage: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
check "stored garbage: the refusal names the value and the file" \
  "$(grep -c "SH_SANDBOX_DEFAULT_TIER='gpu' in $TE must be container or microvm" "$TMP/run.log")" "1"
check "stored garbage: the refusal names how to clear it" \
  "$(grep -c "or set SH_SANDBOX_DEFAULT_TIER= (empty) to clear it" "$TMP/run.log")" "1"
: >"$MOCK_LOG"
check "stored garbage, an explicit value overrides it: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm run)" "0"
check "stored garbage, an explicit value overrides it: written" "$(val SH_SANDBOX_DEFAULT_TIER "$TE")" "microvm"
unset MOCK_PODMAN_PS MOCK_RECORDS

echo "== --remote: this host's own P6 is container-only, so it is untiered (P6.3, spec §7)"
reset_remote_host; mkbundle "$B"
check "remote with containers: exit 0" "$(MOCK_PODMAN_PS="sh-sandbox-0" runr "$B")" "0"
check "remote with containers: no tiers env, no drop-ins" "$(tiers_files)" ""
check "remote with containers: neither unit try-restarted" "$(grep -cE 'restart sh-(supervisor|control-plane)' "$MOCK_LOG")" "0"
reset_remote_host; mkbundle "$B"
check "remote, bad SH_SANDBOX_DEFAULT_TIER: exit 1 (preflight checks it on both paths)" \
  "$(SH_SANDBOX_DEFAULT_TIER=gpu runr "$B")" "1"
check "remote, bad SH_SANDBOX_DEFAULT_TIER: no microvm env files" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
check "remote, bad SH_SANDBOX_DEFAULT_TIER: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
# S1: the host's only microVM worker now attaches to the cluster's relay, so the local stack must stop
# declaring a microvm tier it can no longer serve.
reset_host; export MOCK_PODMAN_PS="sh-sandbox-0" MOCK_RECORDS="sh-sandbox-0=container"
check "a mixed local install: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm run)" "0"
: >"$MOCK_LOG"
check "then --remote: exit 0" "$(runr "$B")" "0"
check "then --remote: the tiers env and both drop-ins are removed" "$(tiers_files)" ""
check "then --remote: daemon-reload (the drop-ins went)" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "then --remote: supervisor try-restarted" "$(grep -c '^systemctl try-restart sh-supervisor.service$' "$MOCK_LOG")" "1"
check "then --remote: control plane try-restarted" "$(grep -c '^systemctl try-restart sh-control-plane.service$' "$MOCK_LOG")" "1"
check "then --remote: never a plain restart of either" "$(grep -cE '^systemctl restart sh-(supervisor|control-plane)\.service$' "$MOCK_LOG")" "0"
check "then --remote: the dropped stored default is named" \
  "$(grep -c "stored SH_SANDBOX_DEFAULT_TIER=microvm in $TE is dropped with it" "$TMP/run.log")" "1"
: >"$MOCK_LOG"
check "--remote re-run: exit 0" "$(runr "$B")" "0"
check "--remote re-run: neither unit try-restarted" "$(grep -cE 'restart sh-(supervisor|control-plane)' "$MOCK_LOG")" "0"
check "--remote re-run: nothing dropped twice" "$(grep -c 'is dropped with it' "$TMP/run.log")" "0"
# A host whose P6 has since been uninstalled: the stale tier files go, and no try-restart is attempted
# of a unit that is not there (systemd would refuse it, exit 5).
reset_host; run >/dev/null; rm -f "$TMP/units/"sh-*.service; : >"$MOCK_LOG"
check "--remote, tier files but no P6 units: exit 0" "$(runr "$B")" "0"
check "--remote, tier files but no P6 units: the files are removed" "$(tiers_files)" ""
check "--remote, tier files but no P6 units: no try-restart" "$(grep -c 'try-restart' "$MOCK_LOG")" "0"
check "--remote, tier files but no P6 units: a container stored default is not named" \
  "$(grep -c 'is dropped with it' "$TMP/run.log")" "0"
unset MOCK_PODMAN_PS MOCK_RECORDS

echo "== S2: a default tier given on a host that is not tiered is named as ignored"
ignored() { grep -c "SH_SANDBOX_DEFAULT_TIER=$1 ignored: this host is not tiered (only a host with container sandboxes AND a local P4 worker is), so it is not recorded" "$TMP/run.log"; }
reset_host
check "P4-only, SH_SANDBOX_DEFAULT_TIER=microvm: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm run)" "0"
check "P4-only, SH_SANDBOX_DEFAULT_TIER=microvm: warned" "$(ignored microvm)" "1"
check "P4-only, SH_SANDBOX_DEFAULT_TIER=microvm: not recorded" "$(tiers_files)" ""
check "P4-only, unset: not warned" "$(run >/dev/null; grep -c 'ignored: this host is not tiered' "$TMP/run.log")" "0"
reset_remote_host; mkbundle "$B"
check "--remote, SH_SANDBOX_DEFAULT_TIER=microvm: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm runr "$B")" "0"
check "--remote, SH_SANDBOX_DEFAULT_TIER=microvm: warned" "$(ignored microvm)" "1"
reset_host; export MOCK_PODMAN_PS="sh-sandbox-0" MOCK_RECORDS="sh-sandbox-0=container"
check "mixed, SH_SANDBOX_DEFAULT_TIER=microvm: exit 0" "$(SH_SANDBOX_DEFAULT_TIER=microvm run)" "0"
check "mixed, SH_SANDBOX_DEFAULT_TIER=microvm: not warned (it is recorded)" "$(grep -c 'ignored: this host is not tiered' "$TMP/run.log")" "0"
unset MOCK_PODMAN_PS MOCK_RECORDS
check "mixed -> P4-only: the stored microvm default is named as dropped" \
  "$(run >/dev/null; grep -c "stored SH_SANDBOX_DEFAULT_TIER=microvm in $TE is dropped with it" "$TMP/run.log")" "1"

echo "== moca-egress readiness: setup waits for the control socket and names moca-egress if it never comes"
reset_host
: >"$MOCK_LOG"
check "exit 1 when the control socket never appears" \
  "$(MOCA_EGRESS_SOCKET="$TMP/no-such.sock" MOCA_EGRESS_READY_TIMEOUT=1 run)" "1"
check "the failure names journalctl -u moca-egress" \
  "$(grep -cF 'journalctl -u moca-egress' "$TMP/run.log")" "1"
check "and the worker is never started against a missing proxy" \
  "$(grep -cE 'systemctl (start|restart) microvm-worker' "$MOCK_LOG")" "0"
check "a changed moca-egress is reset-failed before its restart (it may have hit its start limit)" \
  "$(grep -nE 'systemctl (reset-failed|restart) moca-egress.service' "$MOCK_LOG" | head -2 | sed -E 's/^[0-9]+:systemctl ([a-z-]+).*/\1/' | tr '\n' ' ')" "reset-failed restart "
check "a non-numeric MOCA_EGRESS_READY_TIMEOUT is refused" "$(MOCA_EGRESS_READY_TIMEOUT=soon run)" "1"
reset_host
: >"$MOCK_LOG"
check "exit 1 when the moca-egress start job itself fails (a notify unit that exits before READY=1)" \
  "$(MOCK_EGRESS_START_FAILS=1 run)" "1"
check "that failure also names journalctl -u moca-egress (set -e must not pre-empt the hint)" \
  "$(grep -cF 'moca-egress failed to start; the reason is in: journalctl -u moca-egress' "$TMP/run.log")" "1"
check "and the worker is not started after it" \
  "$(grep -cE 'systemctl (start|restart) microvm-worker' "$MOCK_LOG")" "0"
echo "== --template: a second, templated P4 worker beside the main one (session templates)"
reset_host
check "the main install first: exit 0" "$(run)" "0"
mkdir -p "$TMP/tpl-snap/django-django-11133-3d3e705ff379"
printf '{"guest_ram_mb": 4096, "hash": "x"}\n' >"$TMP/tpl-snap/django-django-11133-3d3e705ff379/manifest.json"
SNAP="$TMP/tpl-snap/django-django-11133-3d3e705ff379"
# The default root is beside the snapshot (<snapshot dir>/.tpl/t<12 hex>); a temp dir here (63
# characters on macOS) is too long for the VMs' API socket path, so the installer would rightly refuse it.
# The default is exercised once below with a short snapshot path; elsewhere a short root on the same
# filesystem stands in.
TPLROOT="$(mktemp -d /tmp/tpl.XXXX)"; export MICROVM_TPL_SRV="$TPLROOT"
trun() { "$REAL_BASH" "$SCRIPT" "$@" >"$TMP/run.log" 2>&1; echo $?; }
: >"$MOCK_LOG"
main_before="$(cd "$TMP" && cksum units/microvm-worker.service etc/microvm-worker.env etc/microvm-relay.env units/sh-relay.service.d/50-moca-microvm.conf | sort)"
check "--template exit 0" "$(trun --template django-django-11133 --snapshot "$SNAP")" "0"
SID=tpl_django_django_11133
# The roots' key: t + 12 hex of the sid's sha256, short whatever the template id.
tkey() { printf 't%s' "$(printf '%s' "$1" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12)"; }
KEY="$(tkey "$SID")"
TE="$TMP/etc/microvm-worker-$SID.env" TR="$TMP/etc/microvm-relay-$SID.env"
check "the template unit is installed" "$([ -f "$TMP/units/microvm-worker@.service" ] && echo yes)" "yes"
check "each instance runs in its own slice" "$(grep -c '^Slice=microvm-tpl-%i.slice$' "$TMP/units/microvm-worker@.service")" "1"
check "its VMs' parent cgroup is that slice, never the main worker's" \
  "$(grep -c '^Environment=SH_PARENT_CGROUP=microvm.slice/microvm-tpl.slice/microvm-tpl-%i.slice$' "$TMP/units/microvm-worker@.service")" "1"
check "the main unit is unchanged" "$(cd "$TMP" && cksum units/microvm-worker.service etc/microvm-worker.env etc/microvm-relay.env units/sh-relay.service.d/50-moca-microvm.conf | sort)" "$main_before"
check "the worker env names the template" "$(val SANDBOX_TEMPLATE "$TE")" "django-django-11133"
check "and its sandbox id" "$(val SANDBOX_ID "$TE")" "$SID"
check "the snapshot by directory and name" "$(val SH_SNAPSHOT_DIR "$TE")/$(val SH_SNAPSHOT_IMAGE "$TE")" "$SNAP"
check "the guest RAM is the manifest's" "$(val SH_GUEST_RAM_MB "$TE")" "4096"
check "the default budget holds one session: (4096+32)x3+1024" "$(val SH_MAX_COMMITTED_MB "$TE")" "13408"
check "no egress by default" "$(val MOCA_EGRESS_CONTROL_SOCK "$TE")" ""
check "its own workspace and jail roots" "$(val SH_WORKSPACE_ROOT "$TE") $(val SH_CHROOT_BASE "$TE")" \
  "$TPLROOT/$KEY/workspaces $TPLROOT/$KEY/jail"
check "the same token in the worker env and the relay env" "$(val SANDBOX_TOKEN "$TE")" "$(val "SH_RELAY_TOKEN_$SID" "$TR")"
check "a token unlike the main worker's" "$([ "$(val SANDBOX_TOKEN "$TE")" != "$(val SANDBOX_TOKEN "$TMP/etc/microvm-worker.env")" ] && echo yes)" "yes"
check "both env files are 0600" "$(mode "$TE") $(mode "$TR")" "600 600"
check "the relay loads its token through its own drop-in" "$(grep -c "^EnvironmentFile=$TR$" "$TMP/units/sh-relay.service.d/51-moca-$SID.conf")" "1"
check "the instance loads its env through its drop-in" "$(grep -c "^EnvironmentFile=$TE$" "$TMP/units/microvm-worker@$SID.service.d/50-moca-template.conf")" "1"
check "the token is never in argv" "$(grep -c "$(val SANDBOX_TOKEN "$TE")" "$MOCK_LOG")" "0"
check "the relay is restarted for the token" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"
check "the instance is enabled and started" "$(grep -c -E "^systemctl (enable|start) microvm-worker@$SID.service$" "$MOCK_LOG")" "2"
check "its stale presence record is dropped first" "$(grep -c "HDEL sh:sandbox:records $SID" "$MOCK_LOG")" "1"
check "the main worker is not restarted" "$(grep -c -E '^systemctl (restart|stop|start) microvm-worker.service$' "$MOCK_LOG")" "0"

echo "== --template re-run: nothing changes, the token is kept"
tok1="$(val SANDBOX_TOKEN "$TE")"; : >"$MOCK_LOG"
check "exit 0" "$(trun --template django-django-11133 --snapshot "$SNAP")" "0"
check "nothing to change" "$(grep -c 'nothing to change' "$TMP/run.log")" "1"
check "the token is kept" "$(val SANDBOX_TOKEN "$TE")" "$tok1"
check "no relay restart" "$(grep -c 'restart sh-relay' "$MOCK_LOG")" "0"

echo "== --template refusals, before anything is written"
for c in "--template Bad_Id --snapshot $SNAP|must match" "--template ok-id|needs --snapshot" \
  "--template ok-id --snapshot $TMP/nope|no snapshot" "--template ok-id --snapshot $SNAP --budget-mb 2000|at least 13408" \
  "--snapshot $SNAP|go with --template"; do
  args="${c%%|*}" want="${c#*|}"
  # shellcheck disable=SC2086 # the cases are word lists on purpose
  rc="$(trun $args)"
  check "refused: $args (exit 1)" "$rc" "1"
  check "  says: $want" "$(grep -c -- "$want" "$TMP/run.log")" "1"
done
check "a refused id wrote no env file" "$(find "$TMP/etc" -name '*tpl_ok_id*' | wc -l | tr -d ' ')" "0"
check "--remote with --template refused" "$(trun --remote "$TMP" --template ok-id --snapshot "$SNAP")" "1"
check "--uninstall-template with --snapshot refused" "$(trun --uninstall-template ok-id --snapshot "$SNAP")" "1"
# A root too deep for the VMs' API socket, wherever it comes from: MICROVM_TPL_SRV here (the default
# would be the same check under <snapshot dir>/.tpl).
LONG="$TMP/$(printf 'd%.0s' {1..40})"; mkdir -p "$LONG/s"; printf '{"guest_ram_mb": 256}\n' >"$LONG/s/manifest.json"
check "a jail path too long for the API socket refused" "$(MICROVM_TPL_SRV="$LONG" trun --template scikit-learn-scikit-learn-13142 --snapshot "$LONG/s")" "1"
check "  says to set MICROVM_TPL_SRV" "$(grep -c 'MICROVM_TPL_SRV' "$TMP/run.log")" "1"
reset_host
check "no main install: refused" "$(trun --template ok-id --snapshot "$SNAP")" "1"
check "  says: install the main P4 worker first" "$(grep -c 'install the main P4 worker first' "$TMP/run.log")" "1"

echo "== --egress: refused beside another egress-on worker (moca-egress keys VMs by id across workers)"
reset_host; run >/dev/null
check "refused while the main worker uses egress (exit 1)" "$(trun --template django-django-11133 --snapshot "$SNAP" --egress)" "1"
check "  says why" "$(grep -c 'already uses moca-egress' "$TMP/run.log")" "1"
check "  wrote nothing" "$([ -e "$TE" ] && echo written || echo none)" "none"
printf 'MOCA_EGRESS_CONTROL_SOCK=\n' >>"$TMP/etc/microvm-worker.env"   # the main worker with egress off
check "allowed when no other worker uses egress, with a larger budget" \
  "$(trun --template django-django-11133 --snapshot "$SNAP" --budget-mb 40960 --egress)" "0"
check "the budget given" "$(val SH_MAX_COMMITTED_MB "$TE")" "40960"
check "egress wired to moca-egress's socket" "$(val MOCA_EGRESS_CONTROL_SOCK "$TE")" "$EGRESS_SOCK"
: >"$MOCK_LOG"
check "a bare re-run keeps the stored budget and egress (exit 0)" "$(trun --template django-django-11133 --snapshot "$SNAP")" "0"
check "  budget kept" "$(val SH_MAX_COMMITTED_MB "$TE")" "40960"
check "  egress kept" "$(val MOCA_EGRESS_CONTROL_SOCK "$TE")" "$EGRESS_SOCK"
check "  and nothing restarted" "$(grep -c -E "^systemctl (stop|start) microvm-worker@" "$MOCK_LOG")" "0"
mkdir -p "$TMP/tpl-snap/django-django-11133-bbbbbbbbbbbb"; printf '{"guest_ram_mb": 4096}\n' >"$TMP/tpl-snap/django-django-11133-bbbbbbbbbbbb/manifest.json"
check "a new snapshot under the same id is refused (a new image is a new worker)" \
  "$(trun --template django-django-11133 --snapshot "$TMP/tpl-snap/django-django-11133-bbbbbbbbbbbb")" "1"
check "  says so" "$(grep -c 'a new snapshot is a new template worker' "$TMP/run.log")" "1"

echo "== --uninstall-template removes exactly what --template wrote"
mkdir -p "$TPLROOT/$KEY/workspaces/s-1"; : >"$TPLROOT/$KEY/workspaces/s-1/kept"
: >"$MOCK_LOG"
check "exit 0" "$(trun --uninstall-template django-django-11133)" "0"
for f in "etc/microvm-worker-$SID.env" "etc/microvm-relay-$SID.env" "units/sh-relay.service.d/51-moca-$SID.conf" \
  "units/microvm-worker@$SID.service.d/50-moca-template.conf" "units/microvm-worker@.service" "units/microvm-tpl.slice"; do
  check "removed $f" "$([ -e "$TMP/$f" ] && echo present || echo gone)" "gone"
done
kept=0
for f in units/microvm-worker.service etc/microvm-worker.env etc/microvm-relay.env; do
  if [[ -e "$TMP/$f" ]]; then kept=$((kept + 1)); fi
done
check "the main worker's files stay" "$kept" "3"
check "workspace data is kept" "$([ -f "$TPLROOT/$KEY/workspaces/s-1/kept" ] && echo kept)" "kept"
check "the instance's slice is stopped too (its VMs are siblings of the unit)" "$(grep -c "^systemctl stop microvm-tpl-$SID.slice$" "$MOCK_LOG")" "1"
check "the instance is disabled and stopped" "$(grep -c "^systemctl disable --now microvm-worker@$SID.service$" "$MOCK_LOG")" "1"
check "the relay drops the token" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"
check "a second uninstall changes nothing" "$(trun --uninstall-template django-django-11133; grep -c 'nothing to change' "$TMP/run.log")" "0
1"

echo "== the default root is beside the snapshot, on its filesystem"
reset_host; run >/dev/null
SHORT="$(mktemp -d /tmp/snp.XXXX)"; mkdir -p "$SHORT/py312-aaaaaaaaaaaa"; printf '{"guest_ram_mb": 256}\n' >"$SHORT/py312-aaaaaaaaaaaa/manifest.json"
check "exit 0" "$(env -u MICROVM_TPL_SRV "$REAL_BASH" "$SCRIPT" --template py312 --snapshot "$SHORT/py312-aaaaaaaaaaaa" >"$TMP/run.log" 2>&1; echo $?)" "0"
check "the roots are <snapshot dir>/.tpl/t<12 hex>" "$(val SH_CHROOT_BASE "$TMP/etc/microvm-worker-tpl_py312.env")" "$SHORT/.tpl/$(tkey tpl_py312)/jail"
# The overflow case: /srv/sbx/snapshots/.tpl/<sid> was 116 bytes of API socket path for this
# id; the key keeps it at 101 under a 23-character snapshot directory.
p="/srv/sbx/snapshots/.tpl/$(tkey tpl_django_django_11133)/jail/firecracker/vm-99999999999999999999/root/run/firecracker.socket"
check "the worst-case API socket path under /srv/sbx/snapshots fits" "$([ "${#p}" -lt 108 ] && echo yes || echo "no (${#p})")" "yes"
rm -rf "$SHORT"

echo "== two templates: removing one keeps the other and the shared unit"
reset_host; run >/dev/null
mkdir -p "$TMP/tpl-snap/py312-aaaaaaaaaaaa"; printf '{"guest_ram_mb": 256}\n' >"$TMP/tpl-snap/py312-aaaaaaaaaaaa/manifest.json"
trun --template django-django-11133 --snapshot "$SNAP" >/dev/null
check "a second template: exit 0" "$(trun --template py312 --snapshot "$TMP/tpl-snap/py312-aaaaaaaaaaaa")" "0"
check "its budget for a 256 MiB guest" "$(val SH_MAX_COMMITTED_MB "$TMP/etc/microvm-worker-tpl_py312.env")" "1888"
trun --uninstall-template py312 >/dev/null
check "the shared template unit stays for the other" "$([ -f "$TMP/units/microvm-worker@.service" ] && echo yes)" "yes"
check "the other's env stays" "$([ -f "$TE" ] && echo yes)" "yes"
reset_host
rm -rf "$TPLROOT"

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
