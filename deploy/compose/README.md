# Docker Compose trial (P6 process-manager runtime)

> **Preview, trial only.** This path is a trial by design and will not be promoted to Stable. For production see
> [`deploy/vm/`](../vm/README.md) or [`deploy/k8s/`](../../docs/operate/harness/kubernetes.md); labels are explained in [Maturity and lifecycle](../../docs/reference/maturity-and-lifecycle.md).

A five-minute, no-root way to run the P6 runtime on a dev machine: the supervisor (with its worker
pool), the sandbox relay, Redis and one remote-worker sandbox, under Docker Compose. Optionally, add
the MU1 control plane that [`mocactl`](../../packages/mocactl) logs in through (see
"[Using mocactl](../../docs/operate/harness/compose.md#using-mocactl-the-control-plane)").

**This is the trial path, not the production one.** For a dedicated VM or bare metal, use
[`deploy/vm/`](../vm/README.md) (`setup-vm.sh`, systemd units, podman). That path is the
production path: it carries the systemd hardening, reboot handling and E8 run discipline this one
deliberately leaves out. The two run the same processes with the same environment. Only the
process manager and the addressing differ.

**How to run it, configure it and use `mocactl` against it** is now on the documentation site:
[Docker Compose (trial)](../../docs/operate/harness/compose.md). This file keeps what applies to
working on the trial from a checkout.

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
  installs without a control plane. It also pins the pull (#349): that it runs from the project
  directory before both `up -d` and the key generator, that a failed one starts nothing, and that
  `SH_SKIP_PULL` skips it and still comes up.
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
