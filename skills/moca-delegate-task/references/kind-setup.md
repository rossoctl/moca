# Set up the MOCA context delegation demo

This setup creates one local Kind cluster for MOCA and Context Service. Complete it once before you
run the [MOCA context delegation demo](./demo.md).

The localhost endpoints do not use authentication. Do not expose them to other machines.

## Requirements

- Docker, Kind, `kubectl`, `curl`, and Python 3
- An Anthropic-compatible model credential
- [`contextctl`](https://github.com/rossoctl/context-service#install)
- Checkouts of this experimental MOCA branch and
  [`rossoctl/context-service`](https://github.com/rossoctl/context-service)
- The [skill installed for Claude Code](../README.md#claude-code)

Place the repositories next to each other:

```text
rossoctl/
├── context-service/
└── moca/
```

## 1. Start MOCA

Run these commands from the MOCA checkout:

```sh
export ANTHROPIC_API_KEY=<your-key>
kind get clusters | grep -qx sh-knative || kind create cluster --name sh-knative
kubectl config use-context kind-sh-knative
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
kubectl -n local-path-storage rollout status deployment/local-path-provisioner --timeout=2m

./deploy/knative/setup-kind.sh --build
kubectl apply -f deploy/knative/leaf-scaledjob.yaml
```

These commands create or reuse the `sh-knative` cluster. MOCA uses Claude Haiku for remote tasks by
default.

## 2. Add Context Service

MOCA and Context Service share the cluster. MOCA can then mount the remote context into each
sandbox.

Run these commands from the MOCA checkout:

```sh
export CONTEXT_SERVICE_REPO="$(cd ../context-service && pwd)"
docker build --load -t dev.local/context-service:demo "$CONTEXT_SERVICE_REPO"
kind load docker-image dev.local/context-service:demo --name sh-knative

sed \
  -e 's/namespace: serverless-harness/namespace: default/g' \
  -e 's#ghcr.io/rossoctl/context-service:latest#dev.local/context-service:demo#' \
  -e 's#ghcr.io/rossoctl/serverless-harness-sandbox:latest#ghcr.io/rossoctl/moca-sandbox:latest#' \
  "$CONTEXT_SERVICE_REPO/deploy/context-service.yaml" | kubectl apply -f -

kubectl rollout status deployment/context-service --timeout=2m
```

The namespace substitution places MOCA workers and Context Service sandboxes in `default`.

Allow the MOCA control plane to call Context Service on port 8080:

```sh
kubectl apply -f - <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: moca-to-context-service
  namespace: default
spec:
  podSelector:
    matchLabels:
      serving.knative.dev/service: serverless-harness
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: context-service
      ports:
        - {protocol: TCP, port: 8080}
YAML

kubectl patch kservice serverless-harness --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"CONTEXT_SERVICE_URL","value":"http://context-service.default.svc.cluster.local:8080"}}]'
kubectl wait kservice/serverless-harness --for=condition=Ready --timeout=2m
```

## 3. Connect the local tools

Start two temporary localhost connections:

```sh
kubectl port-forward service/context-service 8081:8080 >/tmp/context-service-demo.log 2>&1 &
export CS_FORWARD_PID=$!
kubectl port-forward -n kourier-system service/kourier 8080:80 >/tmp/moca-demo.log 2>&1 &
export MOCA_FORWARD_PID=$!

export CS_URL=http://127.0.0.1:8081
export CS_NAMESPACE=default
export CS_STORAGE_CLASS=local-path
export SH_URL=http://127.0.0.1:8080
export SH_HOST="$(kubectl get kservice serverless-harness -o jsonpath='{.status.url}' | sed -E 's#^https?://##')"

curl -fsS "$CS_URL/healthz"
curl -fsS -H "Host: $SH_HOST" "$SH_URL/health"
```

Both health checks must succeed before you run the demo.

## Clean up the cluster

Stop the temporary connections. Delete the network policy and cluster.

```sh
kill "$CS_FORWARD_PID" "$MOCA_FORWARD_PID"
kubectl delete networkpolicy moca-to-context-service
kind delete cluster --name sh-knative
```
