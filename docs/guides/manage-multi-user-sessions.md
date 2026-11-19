# Manage multi-user sessions

> **Preview.** For the single-VM deployment ([`deploy/vm`](../operate/harness/single-vm.md)), the path the multi-user demos
> were run on. Commands are taken from [`docs/demos/vm-two-user-acceptance.md`](../demos/vm-two-user-acceptance.md) and
> [`vm-multi-user-demo.md`](../demos/vm-multi-user-demo.md), which were run by one person with two GitHub accounts on
> one laptop. Two people on two laptops was not tried. I have not re-run them. Read the
> [security model](../reference/security-model.md) and [multi-user concepts](../harness/concepts/multi-user.md) first: ownership is enforced at the API, but sandboxes are not
> isolated between users.

## Before you start

- Anyone with a GitHub account who can reach the control plane can log in; there is **no allowlist**. Your control is
  the network path, so restrict who can reach ports 8090 (control plane) and 8080 (harness).
- Keep `SH_REQUIRE_AUTH=true` (the VM template sets it) and leave `SH_ALLOW_OPERATOR_FALLBACK` off unless a one-key trial
  needs it.
- The demos recommend running at `v0.5.1` until the owner-binding slice (MI1 S5) lands, and expect a second user to be
  served: the `403 single_tenant_deployment` the VM README mentions is not in the code.

## 1. Onboard a user

### Operator, once

1. **Create a GitHub OAuth app** with **Device Flow enabled** (it is off by default) and no client secret: GitHub
   Settings, Developer settings, OAuth Apps, New OAuth App. The URLs can be anything. Copy the client ID.
2. **Start the control plane** by giving setup the client ID and the URL clients use to reach the harness:

   ```bash
   sudo env SH_GITHUB_CLIENT_ID=Ov23li... SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
     ./deploy/vm/setup-vm.sh
   ```

   With only the client ID the control plane stays stopped. `SH_PUBLIC_HARNESS_URL` is what `GET /v1/discovery`
   advertises, so users need only the control plane's URL. Behind an SSH tunnel it is the tunnel's local end, and every
   user must forward the same local port.

3. **Check it is up and refusing anonymous turns:**

   ```bash
   curl -s 127.0.0.1:8090/readyz; echo
   curl -s -w ' %{http_code}\n' -H 'Content-Type: application/json' \
     -d '{"sessionId":"sess-does-not-exist","prompt":"hello"}' 127.0.0.1:8080/v1/turn
   ```

   Expect `ok`, then `{"error":"token_required",...} 401`.

4. **Restrict each participant's SSH account** to the two forwarded ports. Redis (6379, the ownership index) and the
   supervisor admin port (8081) have no authentication, so a user with a shell or unrestricted forwarding is trusted with
   every session:

   ```bash
   sudo tee -a /etc/ssh/sshd_config >/dev/null <<'EOF'

   Match User user1,user2
     AllowTcpForwarding local
     PermitOpen 127.0.0.1:8090 127.0.0.1:8080
     AllowStreamLocalForwarding no
     AllowAgentForwarding no
     X11Forwarding no
     PermitTTY no
     ForceCommand /usr/sbin/nologin
   EOF
   sudo sshd -t && { sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd; }
   ```

5. **Optionally make an admin:** set `SH_ADMIN_SUBJECTS=github:<numeric id>` in `control-plane.env`, restart the
   control plane (it reads the list only at boot). The role reaches the user on their next token refresh, within 15
   minutes, so logging in again is not required. `GET /v1/me` shows `"roles":["admin"]` (`[]` for everyone else).

### Each user, on their laptop

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh   # Node 22+
ssh -f -N -M -S ~/.ssh/moca-tunnel -o ExitOnForwardFailure=yes \
  -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <vm>
export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
mocactl login
```

`mocactl login` prints a code and the GitHub device URL, then `logged in as <name>`. In a terminal on your own machine
it also copies the code to the clipboard and opens the URL in your browser: that needs stdin and stderr to both be
terminals, no SSH or sudo, and, on anything but macOS and Windows, a `DISPLAY` or `WAYLAND_DISPLAY`. `--no-browser` turns
it off. Login failures that are fixed on the VM or GitHub rather than by the user: `device_flow_disabled` (the Device
Flow box is unticked) and `GitHub knows no OAuth app with client id ...` (a mistyped `SH_GITHUB_CLIENT_ID`).

Add an inference credential, with the secret on stdin so it stays out of shell history:

```bash
printf 'API key: ' >&2; read -rs KEY; echo >&2
printf %s "$KEY" | mocactl credentials add anthropic --kind api-key \
  --host api.anthropic.com --endpoint https://api.anthropic.com
unset KEY
mocactl credentials
```

A gateway token uses `--kind bearer` (the default). Then check everything and start a session:

```bash
mocactl doctor                                           # seven checks, ending "harness trusts this control plane"
mocactl run "hello, reply with one short sentence"       # prints "session <id>" on stderr, then the reply
mocactl run "what did I just say?" --session <id>
```

Each `XDG_CONFIG_HOME` holds one identity. See the [`mocactl` reference](../harness/reference/cli-mocactl.md) for flags.

### Optional: an operator fallback key

Off by default. To let users without their own credential spend a shared key (each use is audited as
`operator_fallback_used`):

```bash
sudo install -m 0600 /dev/null /etc/serverless-harness/credentials/operator-inference-token
sudoedit /etc/serverless-harness/credentials/operator-inference-token   # the key
sudoedit /etc/serverless-harness/control-plane.env
#   SH_ALLOW_OPERATOR_FALLBACK=true
#   Anthropic API key:  SH_DEFAULT_INFERENCE_ENDPOINT=https://api.anthropic.com
#                       SH_OPERATOR_INFERENCE_HEADER=x-api-key
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
```

A session's credential is fixed at creation in both directions: a session that named one never falls back, and one
created on the fallback keeps using it.

## 2. Verify isolation

Each user runs these against their own session, then swaps ids with the other. The helpers `ids_set`, `probe` and
`not_mine` are defined in Act 2 of [`vm-two-user-acceptance.md`](../demos/vm-two-user-acceptance.md); copy them from there.

- **Session lists are disjoint:** `mocactl sessions --json | jq -r '.sessions[].sessionId'` shows only your own.
- **Another user's session answers 404**, the same as one that never existed, for a read, a delete and a token mint:

  ```text
  {"error":"session_not_found","sessionId":"<theirs>"} 404
  ```

  A 403 would confirm the id exists, so there is none.

- **Headless refusal:** `mocactl run "..." --session <other user's id>` prints `that session no longer exists, or is not
yours` and exits 1.
- **A session token cannot drive another session.** Mint a token for your session, then send a turn that names theirs:
  you get HTTP 400 `session_mismatch` and no model call. The harness checks only that the token's session equals the
  request's.
- **Which user spent which credential** (operator):

  ```bash
  sudo podman exec sh-redis redis-cli XREVRANGE sh:cp:audit + - COUNT 6
  ```

  Per session you should see `session_created` then `credential_issued` with that user's subject and credential name.
  The audit records names, never values.

## 3. List and delete sessions

```bash
mocactl sessions [--json]            # every session you own
mocactl sessions delete ID [--json]  # also drops the local history
```

Deleting a session also removes its log and any stored leaf result. The text output is `deleted session ID`, or
`deleting session ID; the control plane finishes in the background` if a turn was in flight (`--json` reports
`status` as `deleted` or `accepted`). In the TUI it is `ctrl+x l`, then `d`.

**An admin can list another user's sessions** with the `?owner=` query on `GET /v1/sessions`; a non-admin gets 403. An
admin still cannot read, delete or mint a token for another user's session. `mocactl` has no `--owner` option, so use the
API. This request is inferred from the other examples and was not run:

```bash
curl -s -H "Authorization: Bearer $(mocactl auth token)" "http://127.0.0.1:8090/v1/sessions?owner=github:<id>"
```

## 4. Choose a sandbox tier

A deployment that offers more than one tier declares the same `SH_SANDBOX_TIERS` and `SH_SANDBOX_DEFAULT_TIER` on the
control plane and the supervisor (`setup-microvm.sh` writes them when the host also runs container sandboxes). A user
picks a tier when creating a session:

```bash
mocactl run --new --option sandboxTier=microvm "In your sandbox: ..."
```

`--option` is ignored when resuming. The tier is fixed for the session's life and never crosses tiers. With several tiers
and no choice, the server default applies. The container tier has network access and per-session directories under one `/workspace`, which are not isolated from
each other; the microVM tier has no network device and reaches only an allowlist of hosts, through the
host's proxy ([Sandboxes and tiers](../harness/concepts/sandboxes-and-tiers.md)).

## 5. Choose a model

A session runs on the deployment's default model unless it names one. Name it when creating the session:

```bash
mocactl run --new --option model=claude-opus-4-8 "…"
```

`mocactl` lists the models from the session credential's endpoint, with the deployment default first. The TUI's New
Session form asks (the deployment default preselected); `mocactl run` never asks, and with no `model` given it leaves
the deployment default. `mocactl run --option model=ID` with an id the catalog does not list exits 2 (`unknown model
'ID'; declared: …`). That includes an id a LiteLLM wildcard route (such as `anthropic/*`) would accept: the catalog
lists only concrete models. Pick such an id with `/model ID` in the TUI instead, which the server checks against the
routes too. In the TUI, `/model` (or `ctrl+x m`) lists the session's models and
switches to the one you pick, `/model ID` switches directly, and `/model default` returns to the deployment default. A
switch applies from the next turn; the status line shows `model <id>` or `model default`.

A LiteLLM key's own model access decides which models are listed: a key limited to some models lists only those.

A switch to a model with a smaller context window compacts the conversation first. If the conversation is already much
larger than the new model's whole window, it cannot be compacted and every turn fails: switch back with `/model`, or
start a new session.

Operator note: listing or choosing a model makes the control plane call the credential's endpoint, with the endpoint's
own scheme (`<endpoint>/v1/models` when its host is `api.anthropic.com`, `<endpoint>/model/info` for any other host).
It calls only `api.anthropic.com`, the default endpoint's host, and the hosts in `SH_MODEL_CATALOG_HOSTS`: add each
other gateway host your users' credentials name. Egress policies must allow those calls. A host outside the
allow-list, or a call that fails, lists nothing (`model_catalog_unavailable`), and a chosen model is accepted
unverified. See [Configuration: control plane](../reference/configuration.md#control-plane).

## 6. Revoke access

| To remove...               | Do this                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One login                  | `mocactl logout` ends this login on the server and deletes the local file. `mocactl logout --all` ends all of that user's logins                                         |
| A credential               | `mocactl credentials delete NAME`. A session on a deleted credential has its next turn refused                                                                           |
| Admin rights               | Remove the subject from `SH_ADMIN_SUBJECTS` and restart the control plane (it reads the list only at boot); it then takes effect within the 15-minute API token lifetime |
| A user's network path      | Close their tunnel (`ssh -S ~/.ssh/moca-tunnel -O exit <account>@<vm>`), `sudo userdel -r <account>`, remove their `Match` block, then `sshd -t` and reload              |
| Their GitHub authorization | The user revokes the app under Settings, Applications, Authorized OAuth Apps. The control plane keeps no GitHub token                                                    |

API tokens last 15 minutes and are never revoked, so a logged-out client can keep calling the control plane until its
token expires. An already-open SSH tunnel keeps its rights until it closes.

**There is no way to remove a user** from the control plane: no route deletes a subject, and there is no allowlist.
Removal means closing the network path. The only cleanup the demos document is deleting a smoke-test subject's record
file by hand.

## What this does not give you

- **Ownership holds at the API only.** Redis and port 8081 are unauthenticated.
- **Users share the container sandboxes**, their Unix user, filesystem and process list, until owner binding lands.
  Each session has its own directory under `/workspace`, but the directories are not isolated from each other. The microVM tier reaches only an allowlist of hosts, but has no grant binding either.
- **A user's inference key reaches the shared harness process** for the length of a turn (direct mode). It never reaches
  the sandbox.
- **Egress is open** from container sandboxes, including to cloud metadata (require IMDSv2 with a hop limit of 1).
- **The tunnel is the only confidentiality**: the control plane and harness speak plain HTTP.
- **Re-running `setup-vm.sh` forgets all sessions.**
- The VM demos say the worker ignores the workspace key; the code now gives each session its own directory under the
  workspace root, but it is not a security boundary.
