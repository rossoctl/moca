# mocactl quickstart

From nothing to a streamed reply in `mocactl`, on the Docker Compose trial of the P6 runtime.
Most of the time goes into the first image pull. `mocactl` itself needs one URL; the compose
trial's control plane serves it.

## What you need

- Docker (or podman's `docker` CLI) with Compose (`docker compose` or `docker-compose`), and
  `curl`.
- A GitHub account, and a model you can reach: an API key plus the base URL of an
  Anthropic-compatible gateway (e.g. LiteLLM). A gateway on a private network needs your VPN up.

## 1. Bring up the compose trial with the control plane

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | ANTHROPIC_API_KEY=sk-ant-... SH_GITHUB_CLIENT_ID=Ov23li... sh
```

The client ID is the one from step 2; passing it adds the MU1 control plane
(`COMPOSE_PROFILES=control-plane`) and generates its secrets. Everything else — the supervisor
with its worker pool, the sandbox relay, Redis, one remote-worker sandbox — comes up as part of
the trial. The control plane is published on `http://localhost:8090` (`SH_CP_PORT`).

Details, configuration and the trial's limits:
[`deploy/compose/README.md`](../../deploy/compose/README.md).

## 2. Register a GitHub OAuth app (once)

`mocactl` logs you in with GitHub's device flow. No client secret is involved.

1. Open <https://github.com/settings/applications/new> (or an org's Settings → Developer
   settings → OAuth Apps).
2. **Application name**: anything, e.g. `mocactl (local)`. **Homepage URL** and **Authorization
   callback URL**: any valid URL, e.g. `http://localhost:8090`. The device flow never redirects.
3. Tick **Enable Device Flow**. It's off by default, and without it every login fails with
   a message naming `device_flow_disabled`.
4. **Register application**, then copy the **Client ID** (`Ov23li…`). Don't generate a secret.

The control plane asks GitHub for no scopes: logging in shares your numeric user ID and display
name, and grants no access to your repositories.

## 3. Run mocactl

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | MOCACTL_VERSION=edge sh
export SH_CONTROL_PLANE_URL=http://localhost:8090   # the only URL mocactl needs

mocactl login     # open the printed URL, enter the code
mocactl           # first run: onboarding
```

`MOCACTL_VERSION=edge` matches images pulled from `main`, as these are. Against a released
server, drop it. Working on `mocactl` itself? Run `node packages/mocactl/bin/mocactl.mjs` from a
checkout instead.

You stay logged in for 30 days after you last used `mocactl`, and 90 days at most. `mocactl logout`
ends the login.

Onboarding asks for the server URL (already filled in; press Enter). It skips login if you're
already logged in, and then asks for an **inference credential**: the key and gateway your
sessions use. For a LiteLLM-style gateway at `https://litellm.example.com`:

| Field             | Value                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| Name              | `litellm` (lower-case letters, digits, dashes)                                  |
| Kind              | `bearer`                                                                        |
| Consumer          | `inference`                                                                     |
| Destination hosts | `litellm.example.com` (hostname only)                                           |
| Gateway endpoint  | `https://litellm.example.com`: what you'd set as `ANTHROPIC_BASE_URL`, no `/v1` |
| Token             | your key, as is (the field is stored verbatim: no `token=` prefix)              |

The key is stored encrypted and is never shown again, not even in the credential list. Then type
a message. The first one creates a session and streams the reply.

| To…                                 | Press                 |
| ----------------------------------- | --------------------- |
| open the command palette            | `ctrl+p`              |
| start a new session                 | `ctrl+x n`            |
| resume a session (history included) | `ctrl+x l`            |
| stop a turn                         | `esc`                 |
| manage credentials                  | `ctrl+x k`            |
| see every key                       | `?` on an empty input |
| quit                                | `ctrl+c`              |

Headless, for scripts: `mocactl run "hello" --json`. More in the [README](README.md).

## 4. When something fails: `mocactl doctor`

`mocactl doctor` runs seven checks in order, stops at the first failure, and prints one fix. The
common first-run failures:

| Doctor says                                            | Do this                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| cannot reach the control plane                         | the compose stack isn't up: `docker compose ps`, then `docker compose up -d`    |
| not logged in                                          | `mocactl login`                                                                 |
| no inference credential                                | add one with `ctrl+x k` (step 3)                                                |
| this control plane predates /v1/discovery              | the images are old: `docker compose pull`, then `up -d`                         |
| the control plane advertises no harness URL            | the stack came up without the control-plane profile: pass `SH_GITHUB_CLIENT_ID` |
| cannot reach the harness                               | `docker compose logs supervisor`, then restart the stack                        |
| the harness does not trust this control plane's tokens | regenerate the stack's secrets: re-run install.sh in a fresh `SH_COMPOSE_DIR`   |

And outside doctor:

| Symptom                                        | Cause and fix                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| login fails with `device_flow_disabled`        | tick **Enable Device Flow** on the OAuth app (step 2)                           |
| login fails with `GitHub knows no OAuth app …` | `SH_GITHUB_CLIENT_ID` is mistyped (GitHub answered `Not Found`)                 |
| a turn fails with `endpoint_unresolved`        | the credential has no **Gateway endpoint**: edit it with `ctrl+x k`             |
| a turn fails on the model call                 | check the credential's key, host and endpoint; a private gateway needs your VPN |

## 5. Clean up

```bash
docker compose -d down   # in ~/.serverless-harness (SH_COMPOSE_DIR)
```

This removes the stack and **every credential stored through the control plane**. `mocactl`'s own
files are in `~/.config/mocactl/` and `~/.local/state/mocactl/`.
