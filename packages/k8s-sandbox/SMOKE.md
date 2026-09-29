# M2 K8sSandboxClient — real kind smoke

End-to-end proof that the `@moca/k8s-sandbox` extension routes Pi tool execution
into a remote Kubernetes pod (not the harness head). This is the real-cluster
half of the M2 gate. It is a **manual runbook** (cluster + model gateway
dependent); run once and record the result below.

## Prerequisites

- A kind cluster with a `kubectl` context (`kubectl config current-context`).
- The same model-gateway env used for the M1 smoke:
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
- The `sh-redis` container from M1 on `:6379`.
- Pi built (M1 build order). Note: pi-fork is unchanged in M2, so an existing
  `packages/*/dist` from the M1 build is valid — a rebuild is only needed if the
  submodule moved. Build (from **inside** pi-fork so its own `node_modules/.bin`
  with `tsgo` is on PATH):
  ```bash
  cd pi-fork
  for p in ai agent tui coding-agent; do pnpm -C packages/$p build; done
  ```
  (Running the build from the outer workspace root fails with
  `tsgo: command not found` — the outer `.bin` lacks tsgo.)

## Runbook

```bash
# 1. Apply the sandbox fixture and wait for Ready
kubectl apply -f packages/k8s-sandbox/deploy/sandbox.yaml
kubectl -n default rollout status deploy/sandbox --timeout=150s
POD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}')
kubectl -n default exec "$POD" -- sh -c 'command -v bash base64 file rg find && echo TOOLS_OK'

# 2. Baseline: the bare transport reaches the pod
kubectl -n default exec -i "$POD" -- bash -c 'hostname'   # = $POD

# 3. Drive one agent turn with the sandbox enabled
cd harness
export KAGENTI_SANDBOX_POD="$POD"
export KAGENTI_SANDBOX_NAMESPACE=default
export KAGENTI_SANDBOX_CWD=/workspace
unset PI_SESSION_ID
pnpm exec tsx src/cli.ts "Create a file proof.txt in the current directory containing the output of \`hostname\`. Then tell me the hostname."

# 4. Assert side effects landed in the POD, not the head
kubectl -n default exec "$POD" -- cat /workspace/proof.txt   # = $POD hostname
test ! -e harness/proof.txt && echo HEAD_CLEAN                # no leak to head
hostname                                                      # differs from $POD

# 5. (this file) record the result and commit
# 6. Tear down
kubectl delete -f packages/k8s-sandbox/deploy/sandbox.yaml
```

## Result (2026-06-17)

Cluster context `kind-kagenti` (cluster `kagenti`), `sh-redis` up, gateway env
set, existing pi-fork dist @ submodule `7acc67a`.

- **Pod:** `sandbox-77f89448f6-h8249` — Ready, `TOOLS_OK` (bash, base64, file, rg, find present).
- **Bare transport baseline:** `kubectl exec -i $POD -- bash -c 'hostname'` →
  `sandbox-77f89448f6-h8249`.
- **Agent turn:** EXIT 0. Assistant reply:
  _"Created `proof.txt` in the current directory. The hostname is
  **sandbox-77f89448f6-h8249**."_ `SESSION_ID=019ed6b2-8d97-7e78-9489-4792b4fe720d`.
- **(a) file written in the pod:** `kubectl exec $POD -- cat /workspace/proof.txt`
  → `sandbox-77f89448f6-h8249` (the pod's hostname).
- **(b) head clean:** `HEAD_CLEAN` for `harness/proof.txt`, repo-root `proof.txt`,
  and head `/workspace/proof.txt` — nothing leaked to the head.
- **(c) hostnames differ:** reported/pod hostname `sandbox-77f89448f6-h8249` ≠
  head hostname `dhcp-9-74-9-107.watson.ibm.com`.

**Conclusion: PASS.** Both the write tool and the bash tool executed inside the
sandbox pod, not on the harness head — M2 isolation is proven end-to-end.

---

# M3 persistent channel + env injection + find — real kind smoke

Proves the three M3 changes on a real cluster, plus the post-fix write/edit path
and close. Unlike M2's `cli.ts` runbook, M3's smoke is an **automated,
skip-by-default vitest suite** that drives the real M3 transports/ops directly
against a live pod — deterministic and gateway-independent (no model needed).
The suite lives at `test/m3-live-smoke.test.ts` and is gated on `M3_LIVE_SMOKE`,
so `pnpm test`/CI never runs it.

## Runbook

```bash
# 1. Apply the sandbox fixture and wait for Ready (tools install via apk at start;
#    give it a few seconds — `rg` appears once `apk add` finishes).
kubectl apply -f packages/k8s-sandbox/deploy/sandbox.yaml
kubectl -n default rollout status deploy/sandbox --timeout=180s
POD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}')

# 2. (No longer needed — the suite seeds its own fixtures.)
#    The find fixtures (a .gitignore plus seeded .ts files under src/, node_modules/pkg/,
#    .git/ and dist/) are now created by a `beforeAll` in m3-live-smoke.test.ts, so the
#    suite is self-contained and survives a pod restart. Skipping the old manual step used
#    to fail Claims 1/4/5 with `Read failed in pod (cat exited 1): /head/.gitignore` and
#    `glob result: []` — symptoms that point at the read/glob code rather than at absent
#    fixtures. Kept here only as a record of what the suite seeds:
#
#      cd /workspace && mkdir -p src node_modules/pkg .git dist &&
#      printf "node_modules/\ndist/\n" > .gitignore &&
#      : > src/keep.ts && : > node_modules/pkg/skip.ts && : > .git/cfg.ts &&
#      : > dist/bundle.ts && : > top.ts

# 3. Run the gated live smoke (real cluster; no model gateway required)
M3_LIVE_SMOKE=1 KAGENTI_SANDBOX_POD="$POD" KAGENTI_SANDBOX_CONTEXT=kind-kagenti \
  KAGENTI_SANDBOX_NAMESPACE=default \
  pnpm -C packages/k8s-sandbox exec vitest run test/m3-live-smoke.test.ts

# 4. (this file) record the result and commit. 5. Tear down:
kubectl delete -f packages/k8s-sandbox/deploy/sandbox.yaml
```

## Result (2026-06-17)

Cluster context `kind-kagenti` (k8s v1.35.0), pod image `alpine:3.20`, **ripgrep
14.1.0**. Pod `sandbox-77f89448f6-s66x8`. All 6 gated tests passed, EXIT 0.
Suite is skipped without the gate (`pnpm test` → 47 passed | 6 skipped).

- **Claim 1 — single persistent process:** a burst of 4 fast ops (read, ls, find,
  read) over `persistentExecInPod` with a counting `spawn` recorded
  **`spawnCount=1`** — one `kubectl exec -i -- bash` served the whole burst.
- **Claim 2 (TOP) — write/edit over the persistent channel:** wrote 63-byte
  multi-line content with `"quotes"`, `$dollar`, and `` `backtick` `` to
  `/workspace/m3-write.txt` via the persistent channel. It **did not hang** (the
  pre-fix `\x01H` heredoc-delimiter bug); read-back over the channel and an
  independent `kubectl exec … cat` both matched byte-for-byte. Confirms the
  `KAGENTI_EOF_<n>` delimiter fix live.
- **Claim 3 — env injection:** bash op `echo MARKER=$M3_SMOKE` with
  `env={M3_SMOKE:"works-42"}` → captured **`MARKER=works-42`**, exit 0.
- **Claim 4 — find ignore-list + gitignored directories:** `glob('*.ts',
ignore=['**/node_modules/**','**/.git/**'])` → **`["top.ts","src/keep.ts"]`**.
  Excluded: `node_modules/pkg/skip.ts`, `.git/cfg.ts` (ignore list), and
  **`dist/bundle.ts`** — the gitignored _directory_ `dist/` is pruned by rg even
  though `-g '*.ts'` matches inside it (`.gitignore` honoured for dirs).
- **Claim 4b — file-level gitignore nuance (verified):** in an isolated
  `/workspace/ovr` with `.gitignore` = `a.ts`, `glob('*.ts', ignore=[])` →
  **`["a.ts","keep2.ts"]`**. The individually-gitignored _file_ `a.ts` **is
  re-included** — a positive `-g <pattern>` whitelist-overrides a _file-level_
  ignore (minor divergence from Pi's `fd`; see design D5). Net: directory-level
  gitignore parity; only individually-ignored files matching the glob can leak.
- **Claim 5 — close:** `fastExec.close()` non-throwing; the persistent
  `kubectl exec -- bash` is torn down (best-effort process probe, informational).

**Conclusion: PASS.** The persistent channel serves fast-op bursts with one
kubectl process, write/edit round-trip correctly over it (delimiter fix holds),
env injection reaches the pod, and find honours `.gitignore` for ignored
directories + Pi's ignore list — with the documented file-level override nuance.
