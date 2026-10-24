# Two-user Kind demo: workloads with sandboxes of their own

Two users, Alice and Bob, each upload their own small repo as a MOCA workload with sandboxes of
its own ([#476](https://github.com/rossoctl/moca/issues/476), per-workload sandboxes and storage;
built in [#588](https://github.com/rossoctl/moca/pull/588), the provisioner, and
[#600](https://github.com/rossoctl/moca/pull/600), a volume per workload). Their tasks run, and
`run.sh` checks where each ran, what each could see and write, and that deleting the workloads
leaves nothing behind. It prints a PASS/FAIL table and exits non-zero if any check fails. The
design and its acceptance list are in
[`docs/specs/2026-10-16-workload-sandboxes-design.md`](../../../docs/specs/2026-10-16-workload-sandboxes-design.md)
§1.2; the single-user flow is the [phase 1 demo](../demo/README.md).

## Prerequisites

- Docker, [Kind](https://kind.sigs.k8s.io/) 0.24 or newer, `kubectl`, `jq`, `git`, `curl`,
  `openssl`, Node 22 or newer
- Go, to build `contextctl` from the pinned Context Service commit (or a `contextctl` with
  `ctx pack` on `PATH`)
- `pnpm install` in this checkout: the demo runs this checkout's `mocactl`, which has
  `workloads create --sandboxes/--mount`, and the image build copies its `node_modules`
- Free host ports 8180, 8181 and 8190 on 127.0.0.1 (the phase 1 demo's ports are left free)

## Run

```bash
skills/moca-delegate-task/demo-two-users/setup.sh --build   # cluster moca-two-users, about 10 minutes
skills/moca-delegate-task/demo-two-users/run.sh
skills/moca-delegate-task/demo-two-users/setup.sh --delete  # the cluster and the demo's local state
```

`setup.sh` creates the Kind cluster from [`kind.yaml`](kind.yaml) (127.0.0.1 port mappings to
NodePorts, no port-forwarding), installs MOCA P6 (the process-manager runtime) with
`deploy/k8s/setup.sh --target kind-ci` and `SH_WORKLOAD_SANDBOXES=1` (which adds
`moca-provisioner`, the component that creates each workload's pods and volume), installs Context
Service as the phase 1 demo does, and logs in two demo users. `--skip-build` reuses the images
already on the cluster. It restores your current Kubernetes context when it exits.

**Demo-only logins.** There is no device login on Kind. `setup.sh` mints one API token per user
inside the control-plane pod with its own signing key, for the subjects `demo:alice` and
`demo:bob`, and writes each to its own `auth.json` under `~/.local/state/moca-two-users-demo`
(`MOCA_DEMO_STATE`). Your own `mocactl` login is untouched. The tokens expire after 8 hours
(`DEMO_TOKEN_TTL`); re-run `setup.sh` for new ones. Never do this on a real deployment.

**The mock model.** The tasks run on the scripted mock model in the supervisor pod
(`deploy/microvm/mock-anthropic.mjs`, markers `MOCA-DEMO2-*`), so no model key is needed. Each
step prints `$HOSTNAME`, which is the sandbox pod's name and its sandbox id.

## What `run.sh` checks

The numbers are the acceptance items of the design (§1.2).

| #   | What it does                                                                                                                                                       | What it proves                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Alice creates `alice-repo` with `--sandboxes 2 --mount writable`, Bob `bob-repo` with `--sandboxes 1 --mount read-only`, each from his or her own repo             | Each user gets a ready workload, with pods of its own (`kubectl`, by the owner label)                                          |
| 2   | Tasks on each workload, one task with no workload                                                                                                                  | Alice's tasks ran only on her pods, Bob's on his; the task with no workload ran on the shared pool                             |
| 3   | Bob reads, runs on and deletes `alice-repo`; tasks on both workloads search every readable path for the other user's `SECRET-` line; two forged sandboxes register | `404` for Bob each time; neither user's task finds the other's files; the relay refuses both forged Hellos                     |
| 4   | Alice writes a file in one task, then two tasks at once read it back; Bob's task tries to write                                                                    | Alice's tree persists across tasks and across her two pods; Bob's mount refuses writes; tasks start in the mount, with no copy |
| 5   | `mocactl workloads delete` for every workload                                                                                                                      | No StatefulSet, Service, attach Secret, PVC or pod of either workload is left, and no Context                                  |
| 6   | Alice also creates `alice-phase1` without `--sandboxes`                                                                                                            | It runs on the shared pool, in a per-run copy of its context, as before                                                        |

The forged sandboxes (item 3) are stock worker pods started in `moca-sandbox` with Alice's
sandbox id: one with the shared pool's token, one with Bob's own attach token (signed, but for
Bob's workload). The relay's log must show it refused both. The per-field token checks are unit
tests (`packages/sandbox-relay/test/relay-workload-labels.test.ts`), and the admission policy has
its own Kind check (`deploy/k8s/tests/workload-admission.sh`).

**Not shown.** A failed step during delete leaving no orphans (the second half of item 5) needs
the reconciler, a later PR. The kernel, the workers and operators are still not boundaries
(design §9).

Results land in `~/.local/state/moca-two-users-demo/results/<time>/`.
