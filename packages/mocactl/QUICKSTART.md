# mocactl quickstart

From a fresh checkout to a streamed reply in `mocactl`, on a local kind + Knative cluster. Most of
the time goes into the first image build. `mocactl` itself needs one URL; one script does the
cluster wiring behind it.

## What you need

- Docker, [kind](https://kind.sigs.k8s.io/), `kubectl`, `jq` and `curl`.
- OpenSSL 3 (`openssl version`). Older LibreSSL can't make the ed25519 signing key; on a Mac,
  `brew install openssl@3` and put it first on your `PATH`.
- Node 22 and pnpm 9.
- A GitHub account, and a model you can reach: an API key plus the base URL of an
  Anthropic-compatible gateway (e.g. LiteLLM). The cluster's pods reach it through your machine,
  so a gateway on a private network needs your VPN up. It must be HTTPS on port 443: the harness's
  egress policy (`deploy/knative/harness-egress-policy.yaml`) allows no other outbound port.

## 1. Build and deploy the harness

```bash
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca
pnpm install

kind create cluster --name sh-knative
# setup-kind.sh needs a model credential for the harness's own default.
export ANTHROPIC_AUTH_TOKEN=<your key> ANTHROPIC_BASE_URL=<your gateway base URL>
bash deploy/knative/setup-kind.sh --build
```

`--build` builds the image from this checkout. The default pulls the published image, which only
serves `mocactl` once it includes `GET /v1/discovery`.

To pick up a later change on the same cluster, rebuild and reload, then run the next step's
script again. It rolls both the control plane and the harness onto the new image:

```bash
docker build --load -t dev.local/moca:local .
kind load docker-image dev.local/moca:local --name sh-knative
```

## 2. Register a GitHub OAuth app (once)

`mocactl` logs you in with GitHub's device flow. No client secret is involved.

1. Open <https://github.com/settings/applications/new> (or an org's Settings → Developer
   settings → OAuth Apps).
2. **Application name**: anything, e.g. `mocactl (local)`. **Homepage URL** and **Authorization
   callback URL**: any valid URL, e.g. `http://localhost:18080`. The device flow never redirects.
3. Tick **Enable Device Flow**. It's off by default, and without it every login fails with
   a message naming `device_flow_disabled`.
4. **Register application**, then copy the **Client ID** (`Ov23li…`). Don't generate a secret.

The control plane asks GitHub for no scopes: logging in shares your numeric user ID and display
name, and grants no access to your repositories.

## 3. Wire the cluster for mocactl

```bash
SH_GITHUB_CLIENT_ID=Ov23li... make mocactl-quickstart
```

Leave it running. [`deploy/knative/mocactl-quickstart.sh`](../../deploy/knative/mocactl-quickstart.sh)
does four things:

- creates the control plane's Secrets, reusing an existing signing key;
- deploys the control plane, telling it to advertise the harness at `http://localhost:18081`;
- has the harness trust the control plane's tokens, and keeps one harness pod up;
- holds port-forwards to both, checked end to end.

It prints `Ready.` when `mocactl` can connect. Every step is safe to re-run, and re-running also
reconnects dropped port-forwards. Ports: `MOCACTL_CP_PORT` (18080) and `MOCACTL_HARNESS_PORT` (18081).

## 4. Run mocactl

In a second terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | MOCACTL_VERSION=edge sh
export SH_CONTROL_PLANE_URL=http://localhost:18080   # the only URL mocactl needs

mocactl login     # open the printed URL, enter the code
mocactl           # first run: onboarding
```

`MOCACTL_VERSION=edge` matches a cluster built from `main`, as this one is. Against a released
server, drop it. Working on `mocactl` itself? Run `node packages/mocactl/bin/mocactl.mjs` from the
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

## 5. When something fails: `mocactl doctor`

`mocactl doctor` runs seven checks in order, stops at the first failure, and prints one fix. The
common first-run failures:

| Doctor says                                            | Do this                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| cannot reach the control plane                         | the quickstart script isn't running, or its port-forward died: run it again  |
| not logged in                                          | `mocactl login`                                                              |
| no inference credential                                | add one with `ctrl+x k` (step 4)                                             |
| this control plane predates /v1/discovery              | the cluster runs an older image: rebuild with `--build` (step 1)             |
| the control plane advertises no harness URL            | re-run the quickstart script, which sets `SH_PUBLIC_HARNESS_URL`             |
| cannot reach the harness                               | the harness pod was replaced: re-run the quickstart script                   |
| the harness does not trust this control plane's tokens | re-run the quickstart script, which publishes the signing key to the harness |

And outside doctor:

| Symptom                                        | Cause and fix                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| login fails with `device_flow_disabled`        | tick **Enable Device Flow** on the OAuth app (step 2)                                                         |
| login fails with `GitHub knows no OAuth app …` | `SH_GITHUB_CLIENT_ID` is mistyped (GitHub answered `Not Found`)                                               |
| a turn fails with `endpoint_unresolved`        | the credential has no **Gateway endpoint**: edit it with `ctrl+x k`                                           |
| a turn fails on the model call                 | check the credential's key, host and endpoint; a private gateway needs your VPN; only port 443 is allowed out |
| the script asks "is port … free?"              | stop whatever holds 18080/18081, or set `MOCACTL_CP_PORT` / `MOCACTL_HARNESS_PORT`                            |

## 6. Clean up

```bash
make mocactl-quickstart-teardown
```

This removes the control plane, its Secrets and **every credential stored through it**, and returns
the harness to scale-to-zero. `kind delete cluster --name sh-knative` removes everything else.
`mocactl`'s own files are in `~/.config/mocactl/` and `~/.local/state/mocactl/`.
