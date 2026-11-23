#!/bin/bash
# Prepare OpenShift/Kubernetes egress credentials for a moca sandbox, end to
# end: a service account and token on the cluster, the token stored as the
# sandbox's egress credential, a placeholder kubeconfig in the sandbox, and an
# in-situ test. See docs/sandbox/how-to/egress-credentials.md, "Kubernetes and
# OpenShift clusters".
#
# Run it on YOUR machine, in a repository bound to a sandbox (mocactl sbx up),
# with the cluster's kubeconfig in the environment. Not in the sandbox.
#
# The service account is read-only by default and the token lives a week; both
# are environment overrides:
#   SVCACCT=name          the service account (default moca-svcaccount)
#   SVCACCT_ROLE=role     its cluster role (default cluster-reader)
#   TOKEN_DURATION=168h   the token's lifetime (default: 7 days)
set -euo pipefail

SVCACCT=${SVCACCT:-moca-svcaccount}
SVCACCT_ROLE=${SVCACCT_ROLE:-cluster-reader}
TOKEN_DURATION=${TOKEN_DURATION:-168h}

SERVER_URI=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
SERVER_HOSTPORT=${SERVER_URI#https://}
CREDNAME=ocp-$(echo "${SERVER_HOSTPORT%%:*}" | tr . -)
NS=$(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}'); NS=${NS:-default}

echo "--> egress credentials for ${SERVER_URI}"

# the service account and its binding, idempotent
kubectl -n "$NS" get serviceaccount "$SVCACCT" >/dev/null 2>&1 \
  || kubectl -n "$NS" create serviceaccount "$SVCACCT" >/dev/null
kubectl get clusterrolebinding "$SVCACCT-role" >/dev/null 2>&1 \
  || kubectl create clusterrolebinding "$SVCACCT-role" \
       --clusterrole="$SVCACCT_ROLE" --serviceaccount="$NS:$SVCACCT" >/dev/null

# a token for it, verified before it is stored
TOKEN=$(kubectl -n "$NS" create token "$SVCACCT" --duration="$TOKEN_DURATION")
kubectl get nodes --token="$TOKEN" --server="$SERVER_URI" --insecure-skip-tls-verify >/dev/null

# the egress credential: the proxy swaps this token into every request the
# sandbox makes to the cluster's API server
printf %s "$TOKEN" | mocactl sbx credentials add "$CREDNAME" \
  --host "$SERVER_HOSTPORT" --kind bearer

# a placeholder kubeconfig: kubectl and oc refuse to run without credentials
# of their own, and the placeholder is replaced in flight. No
# certificate-authority-data is needed -- the sandbox trusts the proxy's CA,
# which is what presents the server certificate.
mocactl sbx put kubeconfig.yaml <<EOF
apiVersion: v1
kind: Config
clusters:
- name: sandbox-egress
  cluster:
    server: ${SERVER_URI}
users:
- name: via-egress
  user:
    token: moca-placeholder # replaced by the proxy, never seen upstream
contexts:
- name: sandbox-egress
  context:
    cluster: sandbox-egress
    user: via-egress
current-context: sandbox-egress
EOF

# prove it, in the sandbox
mocactl sbx run -- bin/kubectl --kubeconfig kubeconfig.yaml get nodes
echo "--> done: the agent can now run kubectl --kubeconfig kubeconfig.yaml in the sandbox"
