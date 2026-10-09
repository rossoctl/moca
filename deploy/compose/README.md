# Docker Compose trial (P6 process-manager runtime)

A five-minute, no-root way to run the P6 runtime on a dev machine: the supervisor (with its worker
pool), the sandbox relay, Redis and one remote-worker sandbox, under Docker Compose. Optionally, add
the MU1 control plane that [`mocactl`](../../packages/mocactl) logs in through (see
"[Using mocactl](#using-mocactl-the-control-plane)").

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

1. fetches `docker-compose.yml` into `~/.serverless-harness` (`SH_COMPOSE_DIR` overrides the
   location),
2. writes `~/.serverless-harness/.env` (mode 0600) **once**. A re-run never overwrites it. It
   holds:
   - `SH_RELAY_TOKEN`: yours if you set it, otherwise 32 random bytes from `/dev/urandom`. It
     reaches the relay and the sandbox through `.env` only, never a command line.
   - `MOCA_RELAY_EXEC_TOKEN`: 32 random bytes from `/dev/urandom`, the supervisor's credential for
     the relay's `SandboxExec`. It reaches the relay and the supervisor through `.env` only, never
     the sandbox. A re-run adds it to an existing `.env` that lacks it, and never replaces it.
   - `SH_TURNS_PER_WORKER=4`: a trial value (see "Configuration" below).
   - whichever model variables were set in your shell (`ANTHROPIC_*`, `OPENAI_*`, `SH_MODEL*`).
   - when you pass `SH_GITHUB_CLIENT_ID` (see "Using mocactl"): that client ID,
     `COMPOSE_PROFILES=control-plane`, and the control plane's four secrets
     (`SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CREDENTIAL_KEK`,
     `SH_EXCHANGE_TOKEN`). The harness image's own key generator
     (`docker run --rm --network none ... genkeys.ts`) makes the secrets, so the host needs no
     `openssl`, but it does need the `docker` CLI. They reach `.env` through stdout, never a command
     line. A re-run adds any that are missing and never replaces one. Without a client ID, none of
     this runs.
3. runs `docker compose up -d` in that directory.

The token isn't prompted for, because under `curl | sh` the script _is_ stdin. Set
`SH_RELAY_TOKEN` in the environment to choose your own.

Then:

```bash
curl -s -H 'Content-Type: application/json' -d '{"prompt":"Run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
cd ~/.serverless-harness && docker compose logs -f     # watch it
cd ~/.serverless-harness && docker compose down        # stop it (Redis state goes with it)
```

## What runs, and the one constraint on its shape

| Service         | What it is                                                                     | Network                       | Reachable from the host |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------- | ----------------------- |
| `supervisor`    | `packages/supervisor` and its `SH_WORKERS` forked turn workers                 | `moca-brain`                  | `127.0.0.1:8080` only   |
| `sandbox-relay` | `packages/sandbox-relay`: sandboxes attach here and it mirrors them into Redis | `moca-brain` + `moca-sandbox` | no                      |
| `sandbox`       | one `remote-worker` (`SANDBOX_ID=sh-sandbox-0`) dialing the relay              | `moca-sandbox`                | no                      |
| `redis`         | `docker.io/redis:7-alpine`, the image `setup-vm.sh` pins                       | `moca-brain`                  | no                      |
| `control-plane` | `packages/control-plane` (MU1), only under the `control-plane` profile         | `moca-brain`                  | `127.0.0.1:8090` only   |

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

**Two networks keep the sandbox off everything it must not reach (MI1 R8).** `redis` and
`supervisor` join `moca-brain` only; `sandbox` joins `moca-sandbox` only; `sandbox-relay` bridges
both, and binds its `SandboxExec` listener (`MOCA_RELAY_EXEC_ADDR`) to its `moca-brain` address
alone: `SandboxExec` is not served on the `moca-sandbox` network, and the exec token is the
control. `tests/compose.test.sh` asserts each service's network membership and that the exec
listener binds only the brain side. The separation between the two networks is the Docker
engine's, which isolates its bridge networks from each other. Under podman-compose the two networks
are **not** isolated from each other, so this separation does not hold there; the exec token still
guards `SandboxExec`. `moca-brain` uses a fixed subnet (`MOCA_BRAIN_SUBNET`, default
`172.31.250.0/24`); override it in `.env` if that range collides with another network already on
your machine.

## Configuration

Every service's environment mirrors [`deploy/vm/env/*.env.example`](../vm/env) var-for-var.
Only the addressing changes: `REDIS_URL=redis://redis:6379` and
`SH_RELAY_ADDR=sandbox-relay:<port>` name compose services instead of `127.0.0.1`. Set these in
`.env`:

| Variable                               | Default                                          | Notes                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SH_RELAY_TOKEN`                       | **required**                                     | The relay's validation is fail-closed, so `docker compose` refuses to start without it.                                                                                                                                                                                                                                                |
| `MOCA_RELAY_EXEC_TOKEN`                | **required**                                     | The supervisor's credential for the relay's `SandboxExec`, distinct from `SH_RELAY_TOKEN`. `install.sh` generates it; the relay refuses to boot without it, and `docker compose` refuses to start without it. Never give it to the sandbox.                                                                                            |
| `SH_TURNS_PER_WORKER`                  | **required**                                     | `install.sh` writes `4`. The VM template ships none on purpose, because for E8 this value is a _measured output_. Treat `4` as a trial setting, not a result.                                                                                                                                                                          |
| `SH_WORKERS`                           | CPUs this container may use                      | `os.availableParallelism()`, which respects a CPU limit since #341. Set it to pin W.                                                                                                                                                                                                                                                   |
| `SH_RELAY_PORT`                        | `9443`                                           | Moves the relay's ATTACH bind port and the sandbox's dial address (`RELAY_ADDR`) together. A different wire from `MOCA_RELAY_EXEC_PORT` below.                                                                                                                                                                                         |
| `MOCA_RELAY_EXEC_PORT`                 | `9444`                                           | Moves the relay's `SandboxExec` bind port and the supervisor's dial address (`SH_RELAY_ADDR`) together. That's the `relay.env.example` "must agree" footgun, removed by construction.                                                                                                                                                  |
| `MOCA_BRAIN_SUBNET`                    | `172.31.250.0/24`                                | The `moca-brain` network's fixed subnet. Override it if this range collides with another network on your machine.                                                                                                                                                                                                                      |
| `MOCA_RELAY_BRAIN_IP`                  | `172.31.250.10`                                  | The relay's fixed address on `moca-brain`, and where `MOCA_RELAY_EXEC_ADDR` binds. Must stay inside `MOCA_BRAIN_SUBNET`.                                                                                                                                                                                                               |
| `SH_PORT`                              | `8080`                                           | Host port for the supervisor (always bound to `127.0.0.1`).                                                                                                                                                                                                                                                                            |
| `SH_CP_PORT`                           | `8090`                                           | Host port for the control plane (always bound to `127.0.0.1`).                                                                                                                                                                                                                                                                         |
| `COMPOSE_PROFILES`                     | unset                                            | `control-plane` runs the control plane. `install.sh` sets it when given `SH_GITHUB_CLIENT_ID`.                                                                                                                                                                                                                                         |
| `SH_GITHUB_CLIENT_ID`                  | unset                                            | The control plane's GitHub OAuth app (device flow enabled). The control plane refuses to boot without it.                                                                                                                                                                                                                              |
| MU1 secrets                            | generated by `install.sh` with the control plane | `SH_SESSION_TOKEN_PRIVATE_KEY` and `SH_CREDENTIAL_KEK` reach the control plane only. `SH_SESSION_TOKEN_PUBLIC_KEYS` and `SH_EXCHANGE_TOKEN` reach the supervisor too. Never change one on a running stack (see "Using mocactl").                                                                                                       |
| `SH_REQUIRE_AUTH`                      | `false`                                          | `true` makes every supervisor turn need a control-plane session token, which turns plain `curl /turn` off.                                                                                                                                                                                                                             |
| `SH_ALLOW_OPERATOR_FALLBACK`           | unset (off)                                      | Exactly `true`, with `SH_OPERATOR_INFERENCE_TOKEN` and `SH_DEFAULT_INFERENCE_ENDPOINT` (and `SH_OPERATOR_INFERENCE_HEADER=x-api-key` for an Anthropic API key), lets a user with no inference credential of their own run on the operator's. The control plane refuses to boot on a combination that cannot work. See "Using mocactl". |
| `SH_HARNESS_IMAGE`, `SH_SANDBOX_IMAGE` | `ghcr.io/rossoctl/moca{,-remote-worker}:latest`  | Published by `.github/workflows/build.yaml` on every push to `main`.                                                                                                                                                                                                                                                                   |
| model variables                        | unset                                            | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `SH_MODEL`, `SH_MODEL_PROVIDER`, `SH_MODEL_API`, `SH_MODEL_BASE_URL`, `SH_MODEL_AUTH`, `SH_MODEL_CUSTOM`. An unset one stays unset in the container, not empty.                                                                |

After editing `.env`, run `docker compose up -d` again to apply it.

## Using mocactl: the control plane

`mocactl` needs a control plane for login, sessions, credentials and session tokens. It's the
`control-plane` profile, and it needs one thing from you: a **GitHub OAuth app with device flow
enabled**. Device flow is off by default, and forgetting to enable it is the likeliest first-run
failure.

1. On GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**. Any homepage
   and callback URL will do; the device flow doesn't use them. Tick **Enable Device Flow**, then
   save. No client secret is needed: the device flow treats the app as a public client.
2. Install, or re-run the install, with its client ID:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
     | SH_GITHUB_CLIENT_ID=Ov23li... sh
   ```

3. Point `mocactl` at the control plane. It's the only URL you give it: the control plane
   advertises the harness (`GET /v1/discovery` returns `http://127.0.0.1:$SH_PORT`).

   ```bash
   mocactl --control-plane-url http://127.0.0.1:8090 login
   mocactl --control-plane-url http://127.0.0.1:8090 doctor
   mocactl --control-plane-url http://127.0.0.1:8090 run "hello"
   ```

**Credentials are yours, not the operator's.** Under MU1 each user stores their own inference
credential, and `mocactl` onboarding asks for it. The control plane hands it to the harness per
turn, as `Authorization: Bearer` to the credential's endpoint, so it must be a gateway token (or
another Bearer-accepted token) for that endpoint. The operator's `ANTHROPIC_*` in `.env` still
serves plain, unauthenticated `curl /turn`.

**Operator-key fallback (opt-in).** For a one-key trial, uncomment these in `.env` and run
`docker compose up -d`:

```bash
SH_ALLOW_OPERATOR_FALLBACK=true
SH_OPERATOR_INFERENCE_TOKEN=<a Bearer token for the endpoint below>
SH_DEFAULT_INFERENCE_ENDPOINT=https://your-gateway.example
# Or, for an Anthropic API key (sk-ant-api…), which api.anthropic.com reads from x-api-key only:
#SH_OPERATOR_INFERENCE_TOKEN=sk-ant-api…
#SH_DEFAULT_INFERENCE_ENDPOINT=https://api.anthropic.com
#SH_OPERATOR_INFERENCE_HEADER=x-api-key
```

The control plane refuses to boot on a token, header and endpoint that cannot work together, and
`docker compose logs control-plane` names the setting to fix.

When it's on, **every user who has not stored an inference credential spends the operator's key.**
It's off by default, and `install.sh` never turns it on.

**Where credentials live.** The control plane uses the file credential store
(`SH_CREDENTIAL_STORE=file`) on the `moca-credentials` named volume. Each subject has one file,
named by the hash of its login, and holds ciphertext sealed under `SH_CREDENTIAL_KEK`. Credentials
survive `docker compose down && up`. They don't survive `down -v`, which removes the volume, or
losing `.env`, which holds the KEK. Never change `SH_CREDENTIAL_KEK` or the signing keypair in
`.env` on a stack that has users. A new KEK makes every stored credential undecryptable, and a new
signing key invalidates every live token. The file store is for this single-host trial. For a VM
deployment (test, staging, production), use the Vault store (`SH_CREDENTIAL_STORE=vault`, see
[`packages/control-plane`](../../packages/control-plane/README.md)).

**Auth on the supervisor.** It verifies session tokens against `SH_SESSION_TOKEN_PUBLIC_KEYS` and
reaches the control plane at `http://control-plane:8080`. A present-but-invalid token is refused
even with `SH_REQUIRE_AUTH=false`, which is why the two tiers' keys must come from the same
`install.sh` run. `SH_REQUIRE_AUTH=true` in `.env` closes plain `/turn` too.

## Upgrading

Re-run `install.sh` (the same `curl … | sh` line). It fetches the current `docker-compose.yml`,
keeps your `.env`, adds any credential the current stack requires (`MOCA_RELAY_EXEC_TOKEN`, and the
control plane's four secrets once it is enabled) and then runs `docker compose up -d`. A bare `docker compose pull && docker compose up -d` in an existing
directory runs the new images under the old compose file, which does not hand the relay
`MOCA_RELAY_EXEC_TOKEN`, and the relay refuses to boot without it.

## From a checkout

To run images built from your working tree instead of the published ones (needs
`git submodule update --init --recursive`; the image builds pi-fork itself):

```bash
cd deploy/compose
cp /path/to/your/.env .   # or write one: SH_RELAY_TOKEN, MOCA_RELAY_EXEC_TOKEN, SH_TURNS_PER_WORKER
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Tests

- `tests/install.test.sh`: runs `install.sh` from a pipe under `sh`, with docker, compose and
  curl mocked and every other external command wrapped in a logging shim. It asserts that the
  relay token never appears in any process's argv, that `.env` is 0600 and never clobbered, that
  the script fails closed on a missing token, and that it falls back to `docker-compose`. It also
  covers the control plane's secrets: generated only when the control plane is on, once, in the
  image and offline, never in argv, never replaced on a re-run, refused as half a keypair or as
  garbled generator output. It checks that `SH_GITHUB_CLIENT_ID` turns the profile on, that an
  operator's own `COMPOSE_PROFILES` is respected, and that a `docker-compose`-only machine still
  installs without a control plane.
- `tests/compose.test.sh`: renders the compose file through `docker compose config` (no daemon
  needed) and asserts on the resolved result: a single worker-pool owner, env parity with
  `deploy/vm/env`, one port source, required inputs, and what gets published. It also checks the
  control plane: off without its profile, the file store on a named volume, the signing key and KEK
  reaching it alone, the supervisor holding the matching public keys and exchange token, and
  discovery tracking `SH_PORT`.
- `tests/images.test.sh`: the default images are ones `build.yaml` publishes, the harness image
  installs every package compose runs, and the remote-worker builder's Go satisfies `go.work`.
- `smoke.sh`: the live gate. `COMPOSE_LIVE_SMOKE=1 SH_COMPOSE_BUILD=1 ANTHROPIC_API_KEY=... ./smoke.sh`
  brings up a throwaway stack. It checks that `SH_WORKERS=2` healthy workers are running, that the
  sandbox is recorded in Redis, that a `/turn` runs a command in the sandbox, and that the session
  is persisted. With the control plane on, it checks that discovery advertises the harness, that an
  authenticated `POST /v1/turn` streams SSE on a stored per-user credential (the api token is minted
  inside the control plane container, in place of a GitHub login), and that after `down && up` the
  stored credential still decrypts for a fresh session's authenticated turn. Then it tears the stack down. The per-user credential is `ANTHROPIC_AUTH_TOKEN`
  (else `ANTHROPIC_API_KEY`) for `ANTHROPIC_BASE_URL`.

The first three run in CI through `make test-deploy`.

## What the trial does not claim

- **No persistence, except credentials.** Redis has no volume, the same as the VM path.
  `docker compose down` (or removing the container) loses sessions, the ownership index and the
  lease store. Only the control plane's credentials, on their own volume, survive.
- **No offline login.** Logging in goes through GitHub's device flow, so it needs internet access
  and an OAuth app. A loopback-only development identity provider is a possible follow-up; it is
  security-sensitive enough to need its own ADR.
- **No hardening parity.** None of the systemd `[Service]` sandboxing in `deploy/vm/systemd/`
  applies here. Containers run as uid 1000 with Docker's defaults, and there's no egress control.
- **No network separation under podman-compose.** `moca-brain` and `moca-sandbox` are isolated
  from each other on the Docker engine only (see "What runs" above).
- **One sandbox.** To add another, copy the `sandbox` service with a new `SANDBOX_ID`. Replicas
  would all share one id and collide on a single `sh:sandbox:records` entry.
- **No Firecracker/KVM tier.** P4 stays bare-metal/systemd-only.

## Detachable turns

`SH_TURN_DETACH=1` (the default here) lets a `mocactl` turn outlive its client: quit mid-turn, reopen,
resume the session, and the turn's output is replayed, then streamed live. `GET /v1/turn?sessionId=`
re-attaches (send `Last-Event-ID` to resume after a frame), `POST /v1/turn/cancel` cancels. A turn
nobody watches ends after `SH_TURN_DETACHED_MAX_S` (1800); a finished turn stays replayable for
`SH_TURN_LOG_TTL_S` (86400). See `docs/specs/2026-10-09-turn-reattach-design.md`.
