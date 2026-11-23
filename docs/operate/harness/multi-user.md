---
sidebar_position: 5
---

# Manage multi-user sessions

> **Preview.** For the single-VM deployment ([`deploy/vm`](single-vm.md)), the path the multi-user demos
> were run on. Commands are taken from [`docs/demos/vm-two-user-acceptance.md`](../../demos/vm-two-user-acceptance.md) and
> [`vm-multi-user-demo.md`](../../demos/vm-multi-user-demo.md), which were run by one person with two GitHub accounts on
> one laptop. Two people on two laptops was not tried. I have not re-run them. Read the
> [security model](../../reference/security-model.md) and [multi-user concepts](../../harness/concepts/multi-user.md) first: ownership is enforced at the API, but sandboxes are not
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

Each `XDG_CONFIG_HOME` holds one identity. See the [`mocactl` reference](../../harness/reference/cli-mocactl.md) for flags.

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
`not_mine` are defined in Act 2 of [`vm-two-user-acceptance.md`](../../demos/vm-two-user-acceptance.md); copy them from there.

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
host's proxy ([Sandboxes and tiers](../../harness/concepts/sandboxes-and-tiers.md)).

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
unverified. See [Configuration: control plane](../../reference/configuration.md#control-plane).

## 6. Revoke access

| To remove...               | Do this                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One login                  | `mocactl logout` ends this login on the server and deletes the local file. `mocactl logout --all` ends all of that user's logins                                                                                                                                                                                                                                |
| A credential               | `mocactl credentials delete NAME`. A session on a deleted credential has its next turn refused                                                                                                                                                                                                                                                                  |
| Admin rights               | Remove the subject from `SH_ADMIN_SUBJECTS` and restart the control plane (it reads the list only at boot); it then takes effect within the 15-minute API token lifetime, or at the subject's next request with a template store (`SH_PROVENANCE_DIR`). An API grant is revoked with `DELETE /v1/subjects/{subject}/roles/admin`, effective at the next request |
| A user's network path      | Close their tunnel (`ssh -S ~/.ssh/moca-tunnel -O exit <account>@<vm>`), `sudo userdel -r <account>`, remove their `Match` block, then `sshd -t` and reload                                                                                                                                                                                                     |
| Their GitHub authorization | The user revokes the app under Settings, Applications, Authorized OAuth Apps. The control plane keeps no GitHub token                                                                                                                                                                                                                                           |

API tokens last 15 minutes and are never revoked, so a logged-out client can keep calling the control plane until its
token expires. An already-open SSH tunnel keeps its rights until it closes.

**There is no way to remove a user** from a harness control plane: login is open to any account that reaches it, and
sessions are not gated by enrollment, so `DELETE /v1/subjects/{subject}` changes nothing a harness user can do.
Removal means closing the network path. The only cleanup the demos document is deleting a smoke-test subject's record
file by hand. What stays behind on each profile is in
[Users, enrollment and roles](../../reference/users-and-roles.md#when-a-user-leaves).

## 7. Get notified when a subagent pauses or finishes

Off until the operator sets `MOCA_NOTIFY_ALLOW` ([#394](https://github.com/rossoctl/moca/issues/394)):
a comma-separated `host[:port][/prefix]` allowlist, the only control against a user-supplied sink
URL reaching your instance metadata service, Redis, or the kube API from inside the control plane.
A malformed entry refuses to boot, the same contract `SH_MODEL_CATALOG_HOSTS` has. It is re-checked
on every delivery, not only at the `PUT` that stores a sink, so taking a host back out of the list
also stops the sinks already saved under it. What the owner then sees: that sink is skipped and
their other sink, if its host is still listed, keeps being delivered to. With no listed sink left
the delivery fails, so their cursor stops advancing and after `MOCA_NOTIFY_FAIL_MAX` passes they are
muted for an hour; `failures` and `mutedUntil` on `GET /v1/notifications` say so, and the way back is
a re-`PUT` naming a host still on the list -- which also mints a **new** `webhookSecret`, so install
that at the receiver before counting the mute as over, or every delivery fails verification and the
subject is muted again. An owner left with one working sink is told nothing: `GET` does not expose
the allowlist, and only the operator who narrowed it can widen it again.

Each user configures their own sink with `PUT /v1/notifications`:

```bash
curl -s -X PUT "$MOCA_URL/v1/notifications" -H "authorization: Bearer $TOKEN" -d '{
  "sinks": [{"kind": "webhook", "url": "https://hooks.example.com/moca"}],
  "states": ["paused", "failed", "lost"]
}'
```

The response's `webhookSecret` is shown **exactly once**, at the PUT that mints it; there is no
route that reads it back, and a later PUT rotates it. An `ntfy` sink takes `topic` instead of (and
`token` alongside) a signing key:

```bash
curl -s -X PUT "$MOCA_URL/v1/notifications" -H "authorization: Bearer $TOKEN" -d '{
  "sinks": [{"kind": "ntfy", "url": "https://ntfy.sh", "topic": "my-moca-abc123"}]
}'
```

ntfy publishes anonymously unless `token` is given -- on a public server the topic name alone is
the password, so pick one that is hard to guess. A re-`PUT` that omits `token` keeps the stored
one, but one that also points the sink at a **different host** is refused: the token was authorized
for the old server and is not sent to the new one. Resend `token` when you move an authenticated
sink (a self-hosted ntfy to `ntfy.sh`, say), or `DELETE /v1/notifications` first if you want the
sink on the new host **anonymously** -- omitting `token` keeps the old one rather than clearing it,
so it is the refusal above and not a way to drop it. `GET /v1/notifications` reads the config back
(never the secret); `DELETE /v1/notifications` removes it and both stored secrets.

A webhook receiver verifies a delivery by recomputing
`HMAC-SHA256(key, "<timestamp>.<rawBody>")` over the exact bytes received, comparing it to the hex
in `X-Moca-Signature: sha256=<hex>` with a constant-time compare (`timingSafeEqual`), and rejecting
a `X-Moca-Timestamp` more than a few minutes old -- the timestamp is inside the signed string so a
captured body cannot be replayed later under a fresh header.

Two deployment-wide limits, beyond the allowlist:

- `MOCA_NOTIFY_MIN_INTERVAL_S` (default `5`) and `MOCA_NOTIFY_PER_HOUR` (default `60`) bound how
  often one subject is paged; past the hourly cap the subject is muted for the rest of the fixed
  window rather than paged with an hour-old backlog.
- `MOCA_NOTIFY_FAIL_MAX` (default `10`) mutes a subject for an hour after that many _consecutive_
  failed deliveries to their sink (a wrong URL, a dead receiver). Re-`PUT`ting the config is the
  documented way back from either kind of mute.

A push with a gate on it links to an approval page the push itself cannot carry a credential to --
**that page 404s until [#467/B8b](https://github.com/rossoctl/moca/issues/467) lands**; until then,
answer the gate from `mocactl` or the TUI as usual.

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
