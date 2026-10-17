# SBX0 front door (increment 1a)

The sandbox relay and Redis in one namespace of a shared OpenShift cluster, reached through two
passthrough Routes: **attach** (KVM hosts' workers dial in) and **exec** (clients). Design:
[`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md).

## 1. Cluster side

Needs `kubectl` logged in with edit rights in an **existing** namespace, `jq` and `openssl`. The
namespace must be **dedicated to SBX0**: the overlay's default-deny and relay NetworkPolicies would cut
off anything else running in it. Keep the inputs in a file outside the repo:

    SBX_NAMESPACE=<namespace>
    SBX_ATTACH_HOST=<attach route host>
    SBX_EXEC_HOST=<exec route host>
    SBX_IMAGE=<relay image ref>
    SBX_WORKERS="sbx_default"            # one worker id per template
    SBX_CLIENTS="<name> <name>"          # increment 1a only: static client tokens, no '-' in a name

    deploy/sbx/setup.sh --env-file <file>

A client name may not contain `-`: its token admits workspace keys under `sbx-exec-<name>-`, which
would otherwise also prefix the keys of another client (`bob` and `bob-x`).

Re-run it after any change; tokens and certificates are kept. A change to `SBX_CLIENTS` or
`SBX_WORKERS` that changes the client tokens rolls the relay, since it reads them only at boot. Without
`SBX_*_TLS_CERT/KEY` the Routes use self-signed certificates, shipped in every bundle.

## 2. KVM host side

The host needs what `deploy/microvm/P4-ON-P6.md` lists for P4 (`/dev/kvm`, Firecracker, jailer,
`microvm-worker`) and outbound TCP 443 to the attach host. Build each template's snapshot under
`/srv/sbx/snapshots/<image>` with `deploy/microvm/build-snapshot.sh`, then per worker:

    scp -r deploy/sbx/.generated/workers/<id> <host>:sbx-<id>
    ssh <host> sudo <checkout>/deploy/sbx/install-host.sh sbx-<id> --snapshot <image> [--budget-mb N]
    ssh <host> rm -r sbx-<id>

The script waits up to `SBX_ATTACH_TIMEOUT` (120 s) for the worker's attach to hold. A newly added
worker's token reaches the relay only when the kubelet syncs the Secret, about a minute, so the first
attaches may be refused. Re-running it restarts the worker once, with the new env file.
`install-host.sh --uninstall <id>` is the undo: it removes everything the install recorded in
`/etc/sbx/manifest` for that worker (its unit instance, slice, env file and CA). The last uninstall on
a host also removes the shared `sbx-worker@.service` and `sbx.slice`. Workspace data under
`/srv/sbx/workspaces/<id>` and `/srv/sbx/jail/<id>` is kept; remove it by hand when no sandbox needs
it.

## 3. Clients (increment 1a)

Each `deploy/sbx/.generated/clients/<name>/` holds `client.env` and, with a self-signed certificate,
`exec-ca.crt`. Hand it to its owner and delete the copy. The owner loads it from inside the bundle
directory, making the CA path absolute so it holds from anywhere:

    cd <bundle directory>
    set -a; . ./client.env; set +a
    [ -f exec-ca.crt ] && export SBX_CA_FILE="$PWD/exec-ca.crt"

In 1a a client token reaches the **first** worker in `SBX_WORKERS` only: that is the one its bundle
names (`SBX_SANDBOX_ID`), and setup.sh mints and keeps no token for any other worker. So changing
which worker is first in `SBX_WORKERS` re-issues every client token, and every client bundle already
handed out must be replaced. Increment 1b's per-sandbox tokens replace these.

These static client tokens work only with the team-only 1a relay image. Build it from
`sbx/relay-1a`: the prototype's client-token commits rebased onto this change's relay keepalive
commit (spec §3.1, §11), never merged. A relay built from `main` ignores the tokens, and an image
built from the prototype branch alone has no keepalive, so the 1a exit check (a command silent for
5 minutes, spec §10.6 step 3) passes only with the rebuilt image. Increment 1b replaces the tokens
with `mocactl sbx login`.
