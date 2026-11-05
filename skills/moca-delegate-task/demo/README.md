# Kind demo for moca-delegate-task

Runs the skill's flow end to end on a local Kind cluster: pack `example_repo/`, upload it as a
workload, run a read-only and a writable task on it, collect both answers, delete the workload.
`example_repo/` has a bug: `./test.sh` fails until `src/greet.py` returns `Hello, Ada!`.

## Prerequisites

- Docker, [Kind](https://kind.sigs.k8s.io/) 0.24 or newer, `kubectl`, `jq`, `git`, `curl`, `openssl`
- Go, to build `contextctl` from the pinned Context Service commit (or a `contextctl` with
  `ctx pack` on `PATH`)
- `mocactl` on `PATH` (`scripts/install-mocactl.sh`), from a Moca with #534 (runs start in their
  context)
- Free host ports 8080, 8081 and 8090 on 127.0.0.1

## Run

```bash
skills/moca-delegate-task/demo/setup.sh --build    # cluster moca-demo, about 10 minutes
skills/moca-delegate-task/demo/run.sh
```

`setup.sh`:

1. Creates the Kind cluster `moca-demo` from [`kind.yaml`](kind.yaml), or reuses it when its port
   mappings match. Host ports bind to 127.0.0.1: 8080 harness, 8090 control plane, 8081 Context
   Service. There is no port-forwarding.
2. Installs Moca P6 with `deploy/k8s/setup.sh --target kind-ci`, which adds a scripted mock model
   in the supervisor pod, so no model key is needed. `--build` builds the images from this
   checkout; without it they are pulled from `ghcr.io`. Build from a fresh clone, or run
   `pnpm install` first: the image build copies `packages/*/node_modules` from the checkout, and
   stale ones break the image.
3. Builds Context Service and `contextctl` at the pinned commit (`CONTEXT_SERVICE_REF`, exported
   with `git archive` from GitHub or from a local clone named by `CONTEXT_SERVICE_REPO`).
4. Creates the `moca-context-service` ConfigMap and Secret, which turn on
   `MOCA_CONTEXT_WORKLOADS_ENABLED`, then the NodePorts and a NetworkPolicy that admits host
   traffic to the supervisor and control plane.
5. Logs `mocactl` in (demo only, see below) and stores the mock model's credential.

It restores your current Kubernetes context when it exits.

`run.sh` uses only the skill's commands: `contextctl ctx pack`, `mocactl workloads create`, two
`mocactl spawn --kind prompt --workload ID --tag demo` (the second with `--writable`),
`mocactl subagents --tag demo`, `mocactl get`, and `mocactl workloads delete`, which also runs after
a failure.

### Demo-only login

There is no device login on Kind. `setup.sh` mints an API token inside the control-plane pod with its
own signing key, as `deploy/k8s/smoke.sh` does, and writes it to `auth.json` in a demo-only
`XDG_CONFIG_HOME` under `~/.local/state/moca-kind-demo` (`MOCA_DEMO_STATE`). Your own `mocactl`
login is untouched. The token has no refresh token and expires after 8 hours (`DEMO_TOKEN_TTL`);
re-run `setup.sh` to mint another. Never do this on a real deployment: use `mocactl login`.

### The mock model

The mock (`deploy/microvm/mock-anthropic.mjs`) answers only prompts it has a script for, by their
marker, and runs fixed commands: `MOCA-DEMO-READ` and `MOCA-DEMO-FIX` are the demo's. The prompts
also spell the task out in words, so a real model can run them on a `--target kind` stack with your
own credential.

## Expected output

- `ctx pack` lists `workspace/src/greet.py` and `workspace/test.sh` (`-rwxr-xr-x`).
- `workloads create` prints `"status":"ready"`.
- The read-only task reports its working directory under `/workspace/.moca-context/runs/`, `src`
  and `test.sh` in it, `write=refused` for `src/greet.py`, and `./test.sh` failing.
- The writable task reports `./test.sh` failing, then `PASS` after its fix, and a diff against the
  cached copy, which still has the bug.
- `mocactl subagents --tag demo` shows both `done`; the results land in
  `~/.local/state/moca-kind-demo/results/<time>/results/`.

## Teardown

```bash
skills/moca-delegate-task/demo/setup.sh --delete
```

This deletes the `moca-demo` cluster and the demo state directory.
