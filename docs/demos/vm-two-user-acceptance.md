# Two users, one VM — `mocactl` login and session ownership on P6

> **The claim:** two people, each on their own laptop with their own GitHub account, log in to the
> same P6 VM with `mocactl`. Each creates and resumes sessions, and neither can see or reach the
> other's. Another user's session is not "forbidden". It **does not exist** (404), and a session
> token for one session cannot drive a turn in another. The claim holds through the API. A
> participant who can reach the VM's loopback services can write the ownership index directly, so
> 0a restricts the participants' SSH accounts to the two forwarded ports.

This is the acceptance run for VM demo B (#367), and the first manual run of the real GitHub device
flow (#362 item 4). It is written as a demo, so it can be performed. The epic's full walkthrough
(`vm-multi-user-demo.md`, after items A–D of #370) builds on it.

| A shared deployment usually needs                                | This needs                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| An identity provider, per-user accounts, an admin to create them | One GitHub OAuth app (device flow enabled, no client secret). Anyone with a GitHub account logs in.   |
| Access checks in every handler                                   | One ownership choke point in the control plane, plus the harness's `token.sid == body.sessionId` rule |
| A way to hide other users' objects                               | Nothing extra: a non-owner gets the same 404 as for a session id that never existed                   |

**Tenancy: `MOCA_TENANCY` unset (`single`), as `deploy/vm` ships it, at `v0.5.1`.** That release
has no first-subject pin, so a second subject is served like the first. MI1 S2 adds the pin (MI1
§6.6): from then on `single` serves the first subject and refuses every later one with
`403 single_tenant_deployment`. `MOCA_TENANCY=multi` is not the fix until MI1 S5 binds each
container sandbox to one owner, because until then users share sandbox containers. So (#407):

- **Before S5,** run this page against `v0.5.1`: `git checkout v0.5.1` on the VM before
  `setup-vm.sh` (0a). If the tag is not there yet, check out #465's merge commit, which it marks.
  A `main` past S2 refuses user 2's first session, at 1d.
- **From S5,** run it on `main` with `MOCA_TENANCY=multi`. This page is re-pinned then.

Record the commit you ran against (Act 3).

**Automated sibling.** The same properties, without GitHub, with two minted subjects:
`packages/control-plane/test/two-subject.test.ts` and
`packages/knative-server/test/two-subject-turn.test.ts` (#371). Prefer them for a pass/fail; this
run proves the real login.

## Act 0 — Preconditions

### 0a. The VM (operator)

A VM brought up by `deploy/vm/setup-vm.sh` (item A, #366), with the control plane running and the
supervisor started. Use a GitHub OAuth app with **Enable Device Flow** ticked
(`deploy/vm/README.md`, "The GitHub OAuth app"). On the default SSH-tunnel topology, run setup
with both control-plane settings. On a fresh VM this is the **second** run, once `SH_RELAY_TOKEN`
is set; the first stops at that check (README, "Bring it up"):

```bash
sudo env SH_GITHUB_CLIENT_ID=Ov23li... SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
  ./deploy/vm/setup-vm.sh
```

Then check what the **running** supervisor was started with, not what its env file says now. A
supervisor that was never restarted, or a systemd drop-in, would make the file lie:

```bash
curl -s 127.0.0.1:8090/readyz; echo
sudo sh <<'EOF'
pid=$(systemctl show -p MainPID --value sh-supervisor.service)
[ "${pid:-0}" -gt 0 ] || { echo 'sh-supervisor is not running' >&2; exit 1; }
env=$(tr '\0' '\n' <"/proc/$pid/environ") || exit 1
printf '%s\n' "$env" | grep -E '^SH_REQUIRE_AUTH=' || echo 'SH_REQUIRE_AUTH unset'
printf '%s\n' "$env" | grep -E '^MOCA_TENANCY=' || echo 'MOCA_TENANCY unset'
pid=$(systemctl show -p MainPID --value sh-control-plane.service)
[ "${pid:-0}" -gt 0 ] || { echo 'sh-control-plane is not running' >&2; exit 1; }
env=$(tr '\0' '\n' <"/proc/$pid/environ") || exit 1
printf '%s\n' "$env" | grep -E '^SH_ALLOW_OPERATOR_FALLBACK=' || echo 'SH_ALLOW_OPERATOR_FALLBACK unset'
EOF
curl -s -w ' %{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"sessionId":"sess-does-not-exist","prompt":"hello"}' 127.0.0.1:8080/v1/turn
```

Expected output:

```
ok
SH_REQUIRE_AUTH=true
MOCA_TENANCY unset
SH_ALLOW_OPERATOR_FALLBACK unset
{"error":"token_required","message":"this deployment requires a token","sessionId":"sess-does-not-exist"} 401
```

The script exits before printing anything more if it cannot read a process, so "unset" always
means "read, and not there". The fallback is on only at `SH_ALLOW_OPERATOR_FALLBACK=true`, so
`=false` passes too. The last line is the behaviour itself: a turn with no token is refused.

> Say: `SH_REQUIRE_AUTH=true` is what makes the harness demand a session token on every turn.
> Without it, that last turn would pass authentication and fail only because no such session
> exists (`session_not_found`, 404). 2c's `session_mismatch` would still appear (a token that is
> presented is always checked), so this line is the only proof that the harness refuses a turn
> with no token at all.

**Restrict the participants' SSH accounts to the tunnel.** An SSH account reaches every service
bound to the VM's loopback, and two of them have no authentication: Redis on `127.0.0.1:6379`,
which holds the control plane's session-ownership index, and the supervisor's admin listener on
`127.0.0.1:8081`. A participant who forwards 6379 can rewrite a session's owner to themselves,
after which the ownership check lets them read, delete or drive the other user's session. So
give each participant an account that can forward the two demo ports and nothing else, appended
to the **end** of `/etc/ssh/sshd_config` (a `Match` block runs to the end of the file), with your
participants' user names:

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

`ForceCommand` refuses a shell, a command and `sftp` alike. `PermitOpen` matches the destination
as written, so `localhost:6379` or `[::1]:6379` is refused as well. 0b checks it from each
laptop. A participant who also holds an ordinary shell account on the VM is outside this
demo's claim, as is the operator.

The VM needs outbound HTTPS to `github.com` and `api.github.com`. On a cloud host, **require IMDSv2
with hop limit 1**: container sandboxes have open egress in this round (#357).

### 0b. Each laptop (both users)

- `mocactl` installed (`packages/mocactl/README.md`), plus `curl` and `jq` for Act 2.
- A browser that reaches `https://github.com/login/device`.
- The SSH account 0a restricted, and the tunnel open. **Both users forward the same local
  ports**, because the control plane advertises one harness URL to everyone:

  ```bash
  ssh -f -N -M -S ~/.ssh/moca-tunnel -o ExitOnForwardFailure=yes \
    -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <vm>
  export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
  ```

  `-f` puts ssh in the background once both forwards are up, so the `export` runs.
  `ExitOnForwardFailure` makes it fail if something on the laptop already holds 8090 or 8080,
  instead of warning and leaving that port pointing at a local service. `-S` names the tunnel, so
  Cleanup can close it.

- Proof that the account is restricted. Each user runs both commands:

  ```bash
  ssh <vm> true
  printf 'PING\r\n' | ssh -W 127.0.0.1:6379 <vm>
  ```

  Expected: `This account is currently not available.`, then a line ending
  `administratively prohibited: open failed`, and `stdio forwarding failed`. No message from the first, or `+PONG` (Redis answering) from the
  second, means 0a's `Match` block does not apply to this account: stop and fix it before Act 1.
  A tunnel opened before 0a's reload keeps its old rights, so reopen it after.

- An inference credential of your own: a gateway token or an Anthropic API key.

> Trap: to rehearse both users on **one** machine, give each its own `XDG_CONFIG_HOME` (e.g.
> `export XDG_CONFIG_HOME=/tmp/user1`). `mocactl` caches one identity per config directory, so a
> second login in the same one replaces the first. Open the tunnel once: a second one fails,
> because the first already holds the ports.

## Act 1 — Each user logs in and runs a turn

Do all of Act 1 as user 1, then as user 2. The steps are identical.

### 1a. Log in

```bash
mocactl login
```

Expected: `mocactl` prints a code and waits. Open the URL, type the code, and approve the app:

```
Open https://github.com/login/device and enter the code ABCD-1234
logged in as Ada Lovelace
```

> If it prints `login failed: the control plane cannot log anyone in until its operator fixes it`,
> the rest of the line names the fix: `device_flow_disabled` means the OAuth app's **Enable Device
> Flow** box is unticked, and `GitHub knows no OAuth app with client id …` means
> `SH_GITHUB_CLIENT_ID` is mistyped. Both are VM-side fixes: nothing the user does helps.

### 1b. Store an inference credential

Start `mocactl` and open **Credentials** with `ctrl+x k` (or run `mocactl --setup` for the
onboarding flow; a plain `mocactl` with a control-plane URL and a login goes straight to chat).
Add one credential with consumer `inference`:

- **A gateway token** (LiteLLM and the like): kind `bearer`, with the fields in
  `packages/mocactl/QUICKSTART.md`, step 4.
- **An Anthropic API key** (`sk-ant-api…`): kind `api-key`, destination host `api.anthropic.com`,
  gateway endpoint `https://api.anthropic.com` (no `/v1`), and the key itself, pasted as is into
  the **API key** field. The form stores that field verbatim, so a `key=` prefix would become part
  of the key, and only 1d's model call would notice. The form refuses an API key stored as
  `bearer`, because the key is sent as `x-api-key`.

Or, from a script, with the key on stdin (never on the command line):

```bash
printf 'API key: ' >&2; read -rs KEY; echo >&2
```

Paste the key at the prompt; nothing echoes. Then the rest, in a block of its own, so a shell
without bracketed paste (macOS's `/bin/bash` 3.2) cannot take its first line as the key:

```bash
printf %s "$KEY" | mocactl credentials add anthropic --kind api-key \
  --host api.anthropic.com --endpoint https://api.anthropic.com
unset KEY
mocactl credentials
```

The same checks apply: a `bearer` kind for an `sk-ant-api…` key is refused before anything is
sent, and so is a key pasted with a `key=` prefix.

> Say: each user's turns spend **their own** credential. The operator-key fallback is off (0a).

### 1c. Doctor

```bash
mocactl doctor
```

Expected: all seven checks green:

```
✓ 1 control plane reachable
✓ 2 control plane ready
✓ 3 logged in
✓ 4 inference credential present
✓ 5 harness located — http://127.0.0.1:8080 (advertised by the control plane)
✓ 6 harness reachable
✓ 7 harness trusts this control plane
```

Doctor stops at the first failure and names the fix. Check 7 creates a scratch session and deletes
it, so it proves the harness verifies this control plane's tokens without running a model turn.

### 1d. One turn

```bash
mocactl run "hello — reply with one short sentence"
```

Expected: `session <id>` on stderr, then the reply. **Write the session id down.** Act 2 swaps
them between users. Run a second turn on the same session to show resume:

```bash
mocactl run "what did I just say?" --session <id>
```

## Act 2 — Neither can see or reach the other's

Both users set up a header file from `mocactl auth token`, which prints their own API token and
renews it when it is due. The file keeps the token off every command line, and `api_hdr` rewrites
it, so a token that lapsed during a long act is replaced instead of answering 401:

```bash
CP=http://127.0.0.1:8090 HARNESS=http://127.0.0.1:8080
API_HDR="$(mktemp)"
api_hdr() { mocactl auth token | sed 's/^/Authorization: Bearer /' >"$API_HDR" && [ -s "$API_HDR" ]; }
api_hdr && curl -s -H @"$API_HDR" "$CP/v1/me"; echo
```

Expected: `{"subject":"github:<numeric id>","tenant":"github:<numeric id>","roles":[]}`. The two
users' subjects differ.

Three helpers. `probe <method> <session id> [suffix]` refreshes the header file, then prints the response body (which carries
the error code) and then the HTTP status. `ids_set` refuses an empty or unedited `MINE` or
`THEIRS`, and a `THEIRS` that is your own `MINE`. `not_mine` runs `probe GET "$THEIRS"` and fails
unless the answer is a 404, so 2b's DELETE never runs against a session you own. (The blocks on
this page have no `#` comments, so they paste cleanly into macOS's default zsh.)

```bash
ids_set() {
  for id in "$MINE" "$THEIRS"; do
    case "$id" in '' | *'<'*) echo 'set MINE and THEIRS to real session ids first' >&2; return 1 ;; esac
  done
  [ "$MINE" != "$THEIRS" ] || { echo 'THEIRS is your own id: use the one the other user sent' >&2; return 1; }
}
probe() {
  case "$2" in '' | *'<'*) echo 'set MINE and THEIRS to real session ids first' >&2; return 1 ;; esac
  api_hdr || { echo 'no API token: run mocactl login' >&2; return 1; }
  curl -s -w ' %{http_code}\n' -H @"$API_HDR" -X "$1" "$CP/v1/sessions/$2${3:-}"
}
not_mine() {
  out=$(probe GET "$THEIRS") || return 1
  printf '%s\n' "$out"
  case "$out" in *' 404') ;; *) echo 'THEIRS answers you, so it is yours: stop before the DELETE' >&2; return 1 ;; esac
}
```

> Trap: every check below names a session id, and a wrong one fails exactly like a refusal. With
> an **empty** id the URL matches no route, and the router's own 404 (`{"error":"not_found"}`)
> would look like a pass, so `probe` refuses one. With a **mistyped** id, the ownership check
> answers `session_not_found` because no such session exists, which is the very result 2b is
> trying to prove. So the ids are exchanged only after their owners have shown them working.

Each user sets `MINE` to their own session id from 1d and proves it is real:

```bash
MINE='<your session id>'
probe GET "$MINE"
```

Expected: the session's summary, `"sessionId":"<your id>"`, and `200`. **Copy the `sessionId`
value from that output** (not from memory) and send it to the other user. Each user then sets
the id they received:

```bash
THEIRS='<their session id>'
```

### 2a. Session lists are disjoint

```bash
mocactl sessions --json | jq -r '.sessions[].sessionId'
```

Also open **Sessions** in `mocactl` (`ctrl+x l`). Expected: each user sees only the sessions they
created in Act 1. `$THEIRS` appears in neither view.

### 2b. Another user's session is 404, for reading and deleting

```bash
ids_set && not_mine &&
  probe DELETE "$THEIRS" &&
  probe POST "$THEIRS" /token &&
  probe GET sess-does-not-exist
```

Expected: `session_not_found` and `404` four times. That code comes from the control plane's
ownership check, not from the router. Compare the `sessionId` echoed in the first three lines with
the one the other user just showed answering `200`: they must be the same string.

```
{"error":"session_not_found","sessionId":"<theirs>"} 404
{"error":"session_not_found","sessionId":"<theirs>"} 404
{"error":"session_not_found","sessionId":"<theirs>"} 404
{"error":"session_not_found","sessionId":"sess-does-not-exist"} 404
```

Then the other user checks that the DELETE did nothing: `probe GET "$MINE"` on **their** laptop
still prints their session's summary and `200`, exactly as it did before the exchange.

> Say: the fourth line is the point. Another user's session and a session that never existed get
> the same answer, so the API cannot be used to learn which session ids exist. A 403 would confirm
> the id is real.

### 2c. A token for my session cannot drive a turn in theirs

Mint a session token for **your own** session, then present it for the other user's session id:

```bash
TURN_HDR="$(mktemp)"
ids_set &&
  probe POST "$MINE" /token | sed 's/ [0-9]*$//' |
  jq -r '.token // empty | "Authorization: Bearer " + .' >"$TURN_HDR" &&
  [ -s "$TURN_HDR" ] &&
  curl -s -w '\n%{http_code}\n' -H @"$TURN_HDR" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$THEIRS" '{sessionId: $s, prompt: "hello"}')" "$HARNESS/v1/turn"
```

If it prints nothing, the mint failed: run `probe POST "$MINE" /token` to see why.

Expected (HTTP 400, and no model call is made):

```
{"error":"session_mismatch","message":"token does not name this session","sessionId":"<theirs>"}
400
```

The same token with `sessionId: $MINE` runs a normal turn, within the token's lifetime (300 s,
`SH_SESSION_TOKEN_TTL_SECONDS`). After a pause longer than that, expect `401 token_expired`
instead; mint a fresh one. The harness checks exactly one rule,
`token.sid == body.sessionId`, and the control plane mints a token only for a session its caller
owns (2b's third line).

## Act 3 — Record the run

Copy this into the run's report (the issue, or the PR that closes it):

| Item                                                        | User 1 | User 2 |
| ----------------------------------------------------------- | ------ | ------ |
| Commit / release on the VM                                  |        |        |
| `MOCA_TENANCY`                                              | unset  | unset  |
| 0a `SH_ALLOW_OPERATOR_FALLBACK` not `true`                  |        |        |
| 0a token-less turn → `token_required` 401                   |        |        |
| 0b SSH: no shell, Redis forward administratively prohibited |        |        |
| 1a `mocactl login` (subject)                                |        |        |
| 1c `doctor` all seven green                                 |        |        |
| 1d `run` + resume                                           |        |        |
| 2 own id → 200 before the exchange                          |        |        |
| 2a own list excludes the other's sessions                   |        |        |
| 2b GET / DELETE / token / unknown → `session_not_found` 404 |        |        |
| 2c cross-session turn → 400 mismatch                        |        |        |
| Anything unexpected (add to the fix list)                   |        |        |

## What just happened

1. Two real GitHub identities logged in through the device flow. The subject is each account's
   numeric id, and the control plane stored no GitHub token.
2. Each user's session list is scoped to its owner at the index (`listByOwner`), not filtered
   after the fact.
3. Every session-scoped route goes through one ownership check that answers 404, so another user's
   session looks exactly like a session that does not exist.
4. The harness refuses a turn whose token names a different session, so a leaked session token
   reaches one session, not the deployment.

## Notes and limits — what this run does **not** claim

- **Session ownership is enforced. Sandbox isolation between users is not.** On the container
  tier, every user's turns lease the same shared sandbox containers
  (`harness/src/select-sandbox.ts:376-434` has no owner filter). The container worker ignores
  `workspace_key` (`remote-worker/internal/exec/runner.go:98`), so all users share `/workspace`,
  the Unix user and the process list. A file user 1's agent writes is readable by user 2's agent.
  The fix is MI1 S5, owner binding (`docs/specs/2026-09-28-moca-multi-user-isolation-design.md`
  §9).
- **Direct credential mode.** With no injector on this VM, a user's real inference secret reaches
  the shared worker for the duration of a turn. MI1 S2's grants replace this.
- **Open egress.** Sandboxes reach the internet, including cloud instance metadata unless IMDSv2
  with hop limit 1 is enforced on the host (#357).
- **Plain HTTP.** The tunnel is the confidentiality. The allowlist topology sends tokens in clear.
- **Anyone with a GitHub account who can reach the control plane can log in.** There is no user
  allowlist. The tunnel (SSH accounts) or the firewall allowlist is the gate.
- **Ownership holds only at the API.** The ownership index lives in Redis on `127.0.0.1:6379`,
  which has no password, ACL or TLS, and the supervisor's admin listener on `:8081` is
  unauthenticated too. Anyone who can reach the VM's loopback can rewrite a session's owner, and
  then the ownership check lets them in. That is why 0a restricts the tunnel accounts and 0b checks
  it. An SSH user with a shell, or with unrestricted forwarding, is trusted with every session on
  the VM.
- **Tenancy:** `MOCA_TENANCY` unset, at `v0.5.1`. On a `main` past MI1 S2, user 2 gets
  `403 single_tenant_deployment`. See the top of this page.

## Fix list

Found while preparing this run, checked against `main` @ 6836941. Add what the live run finds.

| #   | Finding                                                                                                                                                                                                                                                                                                                                | Status                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **`/resources` without kubectl.** On a VM, `/v1/sessions/{id}/resources` answers `sandbox.phase: "unknown"`, and `mocactl` never calls the route, so nothing breaks. The route also reports `harness.mode: "knative"` on P6: `resources.ts` guesses the mode from the pod name.                                                        | Cosmetic. Make the mode honest when the route gains a VM consumer.             |
| 2   | **Token expiry mid-demo.** Session tokens (5 min) re-mint on their own. The API token lasts 15 minutes and `mocactl` renews it by itself for 30 days after last use (90 at most). Only a lapsed refresh token makes the TUI open its login overlay and replay the prompt, and makes headless `mocactl run` say to run `mocactl login`. | Works as designed. A long demo needs no setting.                               |
| 3   | **One identity per `XDG_CONFIG_HOME`.** Two users on one machine overwrite each other's `auth.json`.                                                                                                                                                                                                                                   | #404: `mocactl --profile`.                                                     |
| 4   | **Login misconfiguration had no hint.** The login error was GitHub's, verbatim: `device_flow_disabled` (device flow off) or `Not Found` (mistyped client id). It is diagnosable with this page or the QUICKSTART, but not on its own.                                                                                                  | Fixed (#405): mocactl names the operator's fix.                                |
| 5   | **No headless `sessions` or `credentials` command.** Act 2 lists sessions with `curl`, and credentials can be added only in the TUI.                                                                                                                                                                                                   | Fixed (#406): `mocactl sessions [--json]`, `mocactl credentials add` (2a, 1b). |
| 6   | **MI1 S2 first-subject pin.** Once it lands, this run under `MOCA_TENANCY=single` refuses user 2 with `403 single_tenant_deployment`.                                                                                                                                                                                                  | Sequenced (#407): run at `v0.5.1` until S5, then on `main` under `multi`.      |
| 7   | **Shared `/workspace` on the container tier.** User 2's agent can see user 1's clone ("Notes and limits").                                                                                                                                                                                                                             | #408: per-session directory (not a boundary).                                  |

## Cleanup

On each laptop: `rm -f "$API_HDR" "$TURN_HDR"`, and close the tunnel with
`ssh -S ~/.ssh/moca-tunnel -O exit <vm>`. Delete this run's sessions in **Sessions**
(`ctrl+x l`, then `d`), and run `mocactl logout` (it revokes the login on the control plane and deletes `auth.json`). On GitHub, each user can revoke the app under **Settings → Applications → Authorized OAuth
Apps**. The operator can delete the OAuth app when the demo is over. The control plane keeps no
GitHub token, so there is nothing to revoke on the VM.
