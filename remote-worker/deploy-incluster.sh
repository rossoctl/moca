#!/usr/bin/env bash
# Deploy the remote-worker as an in-cluster pod and verify it registers with the
# relay. This closes the port-forward latency gap: relay->worker execs stay in the
# cluster, so harness leaf execs reach the worker within their deadline.
#
#   ./build-image.sh && ./deploy-incluster.sh
#   NS=default SANDBOX_ID=sbx-worker-1 ./deploy-incluster.sh
#   IMAGE=quay.io/aslomnet/remote-worker:dev ./deploy-incluster.sh   # external image
set -euo pipefail
cd "$(dirname "$0")"

NS="${NS:-default}"
SANDBOX_ID="${SANDBOX_ID:-sbx-worker-1}"
TOKEN="${SANDBOX_TOKEN:-dev-token}"
IMAGE="${IMAGE:-image-registry.openshift-image-registry.svc:5000/$NS/remote-worker:latest}"

# One Secret, two keys. SH_RELAY_TOKEN is read by both the relay and the worker (SANDBOX_TOKEN,
# see worker-deployment.yaml): auth is fail-closed and the two values must be equal, so sourcing
# both from one key makes that structural. MOCA_RELAY_EXEC_TOKEN is the harness's SandboxExec
# credential (MI1 R5): the relay refuses to boot without it, and only the relay and the harness
# read it -- never the worker, which is a sandbox.
SECRET_NAME="sh-relay-token"
SECRET_KEY="SH_RELAY_TOKEN"
EXEC_KEY="MOCA_RELAY_EXEC_TOKEN"

echo "==> relay token Secret (fail-closed auth)"
# Each key is written on its own, so a re-run never drops a key this step does not manage: a
# whole-object `apply` of a manifest naming only SH_RELAY_TOKEN would delete the exec key. The
# token is still on this process's argv -- visible to `ps` on this machine for the life of the
# command -- but it does not land in either Deployment spec (#173).
if oc get secret "$SECRET_NAME" -n "$NS" >/dev/null 2>&1; then
  oc patch secret "$SECRET_NAME" -n "$NS" --type=merge \
    -p "{\"stringData\":{\"$SECRET_KEY\":\"$TOKEN\"}}" >/dev/null
else
  oc create secret generic "$SECRET_NAME" -n "$NS" --from-literal="$SECRET_KEY=$TOKEN" >/dev/null
fi
# The exec token is generated once and never rotated by a re-run: the harness reads it from this
# Secret, so rotating it here would leave a running harness presenting the old value.
# The read's own status is checked first: inside `[ -z "$(...)" ]` a failed get (an API error, an
# expired login) reads as "key absent", and would rotate the token this branch exists to keep.
if ! current_exec="$(oc get secret "$SECRET_NAME" -n "$NS" -o "jsonpath={.data.$EXEC_KEY}")"; then
  echo "could not read $SECRET_NAME to check for $EXEC_KEY; not generating a new one" >&2
  exit 1
fi
if [ -z "$current_exec" ]; then
  exec_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  [ -n "$exec_token" ] || { echo "could not generate $EXEC_KEY from /dev/urandom" >&2; exit 1; }
  oc patch secret "$SECRET_NAME" -n "$NS" --type=merge \
    -p "{\"stringData\":{\"$EXEC_KEY\":\"$exec_token\"}}" >/dev/null
  unset exec_token
  echo "    added $EXEC_KEY to $SECRET_NAME (value not shown)"
fi

echo "==> point the relay at the Secret"
# Replaces any literal SH_RELAY_TOKEN a previous run of this script set with a secretKeyRef, and
# gives the relay both keys -- it needs the sandbox token and the exec token.
oc set env deploy/sandbox-relay --from="secret/$SECRET_NAME" -n "$NS" >/dev/null
# Then force a new pod. Env from a secretKeyRef is resolved once, at container start, so
# rewriting the Secret above does NOT reach a running relay -- and on a re-run the `set env`
# is a no-op (the spec already names the Secret), so nothing else would trigger a rollout.
# Left out, a rotated token leaves the relay serving the previous one: both sides stay stale
# and keep matching, until either pod restarts on its own and they disagree, at which point
# fail-closed auth rejects every Attach for a reason nothing in the specs explains.
oc rollout restart deploy/sandbox-relay -n "$NS" >/dev/null
oc rollout status deploy/sandbox-relay -n "$NS" --timeout=120s

echo "==> ServiceAccount + nonroot-v2 SCC (image declares USER 1001)"
oc create serviceaccount remote-worker -n "$NS" --dry-run=client -o yaml | oc apply -f - >/dev/null
oc adm policy add-scc-to-user nonroot-v2 -z remote-worker -n "$NS" >/dev/null

echo "==> apply Deployment (image=$IMAGE sandbox_id=$SANDBOX_ID)"
sed -e "s#__IMAGE__#${IMAGE}#g" -e "s#__SANDBOX_ID__#${SANDBOX_ID}#g" \
    -e "s#__NS__#${NS}#g" \
    worker-deployment.yaml | oc apply -f - >/dev/null

# Same reason as the relay restart above: the rendered Deployment is byte-identical between
# runs, so a rotated token would not otherwise reach the worker's running pod either.
oc rollout restart deploy/remote-worker -n "$NS" >/dev/null
oc rollout status deploy/remote-worker -n "$NS" --timeout=120s

echo "==> presence in Redis (worker registered via its live Attach stream)"
for _ in $(seq 1 20); do
  rec="$(oc exec deploy/redis -n "$NS" -- redis-cli HGET sh:sandbox:records "$SANDBOX_ID" 2>/dev/null || true)"
  [ -n "$rec" ] && { echo "$rec"; break; }
  sleep 1
done
[ -n "${rec:-}" ] || { echo "NOT registered — check: oc logs deploy/remote-worker -n $NS"; exit 1; }
echo "==> worker log:"; oc logs deploy/remote-worker -n "$NS" --tail=5 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g'
echo "OK. Enable the remote-sandbox path on the harness -- it reads $EXEC_KEY from $SECRET_NAME"
echo "    by a single-key secretKeyRef -- then drive a leaf: POST a LeafEnvelope to the"
echo "    harness /runs (see DESIGN.md)."
