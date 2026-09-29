# Docker Compose trial (P6 process-manager runtime)

A five-minute, no-root way to run the P6 runtime on a dev machine: the supervisor (with its worker
pool), the sandbox relay, Redis and one remote-worker sandbox, under Docker Compose.

**This is the trial path, not the production one.** For a dedicated VM or bare metal, use
[`deploy/vm/`](../vm/README.md) (`setup-vm.sh`, systemd units, podman). That path is the
production path: it carries the systemd hardening, reboot handling and E8 run discipline this one
deliberately leaves out. The two run the same processes with the same environment. Only the
process manager and the addressing differ.

## Try it

Needs Docker (or podman's `docker` CLI) with Compose (`docker compose` or `docker-compose`), and
`curl`. A turn needs a model, so pass a credential through:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | ANTHROPIC_API_KEY=sk-ant-... sh
```

`install.sh`:

1. fetches `docker-compose.yml` into `~/.moca` (`SH_COMPOSE_DIR` overrides the
   location),
2. writes `~/.moca/.env` (mode 0600) **once**. A re-run never overwrites it. It
   holds:
   - `SH_RELAY_TOKEN`: yours if you set it, otherwise 32 random bytes from `/dev/urandom`. It
     reaches the relay and the sandbox through `.env` only, never a command line.
   - `SH_TURNS_PER_WORKER=4`: a trial value (see "Configuration" below).
   - whichever model variables were set in your shell (`ANTHROPIC_*`, `OPENAI_*`, `SH_MODEL*`).
3. runs `docker compose up -d` in that directory.

The token isn't prompted for, because under `curl | sh` the script _is_ stdin. Set
`SH_RELAY_TOKEN` in the environment to choose your own.

Then:

```bash
curl -s -H 'Content-Type: application/json' -d '{"prompt":"Run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
cd ~/.moca && docker compose logs -f     # watch it
cd ~/.moca && docker compose down        # stop it (Redis state goes with it)
```

## What runs, and the one constraint on its shape

| Service         | What it is                                                                     | Reachable from the host |
| --------------- | ------------------------------------------------------------------------------ | ----------------------- |
| `supervisor`    | `packages/supervisor` and its `SH_WORKERS` forked turn workers                 | `127.0.0.1:8080` only   |
| `sandbox-relay` | `packages/sandbox-relay`: sandboxes attach here and it mirrors them into Redis | no                      |
| `sandbox`       | one `remote-worker` (`SANDBOX_ID=sh-sandbox-0`) dialing the relay              | no                      |
| `redis`         | `docker.io/redis:7-alpine`, the image `setup-vm.sh` pins                       | no                      |

**The supervisor and its whole worker pool are one container.** The supervisor starts its
workers with `child_process.fork()` and hands accepted sockets to them over IPC (ADR-0034), and
`fork()` can't create a process in another container. So scale W with `SH_WORKERS` inside the
`supervisor` service. Don't add replicas or per-worker services. For more capacity than one
container's CPUs give you, run another copy of the whole stack (its own `SH_COMPOSE_DIR`,
`SH_PORT` and project name) behind whatever fronts them. `tests/compose.test.sh` fails if the
compose file ever grows a second worker-bearing service or a replica count.

Redis is unpublished for the same reason `setup-vm.sh` binds it to loopback: it has no auth and
holds `sh:sandbox:records`, so anyone who can write to it chooses the executor for every turn.
The supervisor's unauthenticated admin listener (`8081`, `/metrics`) is unpublished too. Reach it
from inside the container:

```bash
docker compose exec supervisor wget -qO- http://127.0.0.1:8081/metrics
```

## Configuration

Every service's environment mirrors [`deploy/vm/env/*.env.example`](../vm/env) var-for-var.
Only the addressing changes: `REDIS_URL=redis://redis:6379` and
`SH_RELAY_ADDR=sandbox-relay:<port>` name compose services instead of `127.0.0.1`. Set these in
`.env`:

| Variable                               | Default                                         | Notes                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SH_RELAY_TOKEN`                       | **required**                                    | The relay's validation is fail-closed, so `docker compose` refuses to start without it.                                                                                                                                                                                 |
| `SH_TURNS_PER_WORKER`                  | **required**                                    | `install.sh` writes `4`. The VM template ships none on purpose, because for E8 this value is a _measured output_. Treat `4` as a trial setting, not a result.                                                                                                           |
| `SH_WORKERS`                           | CPUs this container may use                     | `os.availableParallelism()`, which respects a CPU limit since #341. Set it to pin W.                                                                                                                                                                                    |
| `SH_RELAY_PORT`                        | `9443`                                          | Moves the relay's bind port and both dial addresses (`SH_RELAY_ADDR`, the sandbox's `RELAY_ADDR`) together. That's the `relay.env.example` "must agree" footgun, removed by construction.                                                                               |
| `SH_PORT`                              | `8080`                                          | Host port for the supervisor (always bound to `127.0.0.1`).                                                                                                                                                                                                             |
| `SH_HARNESS_IMAGE`, `SH_SANDBOX_IMAGE` | `ghcr.io/rossoctl/moca{,-remote-worker}:latest` | Published by `.github/workflows/build.yaml` on every push to `main`.                                                                                                                                                                                                    |
| model variables                        | unset                                           | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `SH_MODEL`, `SH_MODEL_PROVIDER`, `SH_MODEL_API`, `SH_MODEL_BASE_URL`, `SH_MODEL_AUTH`, `SH_MODEL_CUSTOM`. An unset one stays unset in the container, not empty. |

After editing `.env`, run `docker compose up -d` again to apply it.

## From a checkout

To run images built from your working tree instead of the published ones (needs
`git submodule update --init --recursive`; the image builds pi-fork itself):

```bash
cd deploy/compose
cp /path/to/your/.env .   # or write one: SH_RELAY_TOKEN=... and SH_TURNS_PER_WORKER=...
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Tests

- `tests/install.test.sh`: runs `install.sh` from a pipe under `sh`, with docker, compose and
  curl mocked and every other external command wrapped in a logging shim. It asserts that the
  relay token never appears in any process's argv, that `.env` is 0600 and never clobbered, that
  the script fails closed on a missing token, and that it falls back to `docker-compose`.
- `tests/compose.test.sh`: renders the compose file through `docker compose config` (no daemon
  needed) and asserts on the resolved result: a single worker-pool owner, env parity with
  `deploy/vm/env`, one port source, required inputs, and what gets published.
- `tests/images.test.sh`: the default images are ones `build.yaml` publishes, the harness image
  installs every package compose runs, and the remote-worker builder's Go satisfies `go.work`.
- `smoke.sh`: the live gate. `COMPOSE_LIVE_SMOKE=1 SH_COMPOSE_BUILD=1 ANTHROPIC_API_KEY=... ./smoke.sh`
  brings up a throwaway stack. It checks that `SH_WORKERS=2` healthy workers are running, that the
  sandbox is recorded in Redis, that a `/turn` runs a command in the sandbox, and that the session
  is persisted. Then it tears the stack down.

The first three run in CI through `make test-deploy`.

## What the trial does not claim

- **No persistence.** Redis has no volume, the same as the VM path. `docker compose down` (or
  removing the container) loses sessions, the ownership index and the lease store.
- **No hardening parity.** None of the systemd `[Service]` sandboxing in `deploy/vm/systemd/`
  applies here. Containers run as uid 1000 with Docker's defaults, and there's no egress control.
- **One sandbox.** To add another, copy the `sandbox` service with a new `SANDBOX_ID`. Replicas
  would all share one id and collide on a single `sh:sandbox:records` entry.
- **No Firecracker/KVM tier.** P4 stays bare-metal/systemd-only.
