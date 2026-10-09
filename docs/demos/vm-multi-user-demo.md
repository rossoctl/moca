# Two users, one VM, two sandbox tiers: the MOCA VM demo

> **The claim:** one Linux VM runs the whole stack: the P6 supervisor, relay, control plane and
> Redis, container sandboxes, and the P4 Firecracker microVM worker. Two people, each on their own
> laptop with their own GitHub account, log in with `mocactl`. Each one's agent researches live
> internet content with `curl` and `git` in its sandbox, spending that user's own inference
> credential, and neither user can see or reach the other's sessions. Then the same VM switches
> to the microVM tier, and every tool call runs in a fresh Firecracker VM over a per-session
> workspace.

**Performed 2026-10-01** on the shared KVM rig (`m8i.xlarge`, Amazon Linux 2023, 16 GiB), at
`main` @ 03d2ee8 plus this page. Every act held; Act 5 is the record. One person played both
users, with two GitHub accounts on one laptop (two `XDG_CONFIG_HOME` directories, one tunnel).
Two people on two laptops is the same set of steps, and was not tried. The outputs shown below are
that run's, trimmed.

The steps come from three verified pieces: the two-user acceptance runbook
([`vm-two-user-acceptance.md`](./vm-two-user-acceptance.md), #403), the P4 tier on a P6 host
([`deploy/microvm/P4-ON-P6.md`](../../deploy/microvm/P4-ON-P6.md), #376 and #409), and the
research turn ("A research turn" in [`deploy/vm/README.md`](../../deploy/vm/README.md), and
`deploy/vm/research-smoke.sh`, #411).

| A shared agent deployment usually needs                          | This needs                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A Kubernetes cluster, an identity provider, per-user accounts    | One VM under systemd, and one GitHub OAuth app (device flow on, no client secret)            |
| A shared model key, or a secrets service to hand out user keys   | Each user stores their own credential; the control plane resolves it per turn, and audits it |
| A separate fleet, or a separate deployment, for VM-grade sandbox | The P4 microVM worker on the same host, attached to the same relay under its own relay token |
| Access checks in every handler                                   | One ownership check in the control plane: another user's session answers 404, like a bad id  |

**Roles.** The **operator** has a shell on the VM. **User 1** and **user 2** each have a laptop, a
GitHub account, and an SSH account restricted to the tunnel (0c). The operator can also play
user 1, and one person with two GitHub accounts can play both (1a, the trap).

**Order matters.** The container tier comes first (Acts 1 to 3), the microVM tier last (Act 4).
A host may run both tiers at once: each session then stays in the tier it was created in and
returns to its sandbox (`deploy/microvm/P4-ON-P6.md`, "Container sandboxes and P4 on one host").
This demo still switches the host to P4 only for Act 4. Going back to containers means re-running
`setup-vm.sh`, which recreates Redis and forgets every session (#410). Switching to P4 needs no
re-run, so it is the one switch made during the demo.

**Tenancy: `MOCA_TENANCY` unset (`single`), as `deploy/vm` ships it, at `v0.5.1`.** That release
has no first-subject pin, so user 2 is served like user 1. Once MI1 S2's pin lands, `single`
refuses every subject after the first (`403 single_tenant_deployment`). `MOCA_TENANCY=multi` is not
the fix until MI1 S5's sandbox owner binding, because until then users share sandbox containers.
So run this demo against `v0.5.1` until S5 (#465's merge commit, if the tag is not there yet), and
on `main` under `multi` from S5 (#407; MI1 §6.6).
Record the commit you ran against (Act 5).

**Automated siblings.** Prefer these for a pass/fail; the demo is for convincing a room.

- Two subjects, no GitHub: `packages/control-plane/test/two-subject.test.ts` and
  `packages/knative-server/test/two-subject-turn.test.ts` (#371).
- The research turn: `deploy/vm/research-smoke.sh` (#411, `VM_RESEARCH_SMOKE=1`).
- The P4 tier with auth on: `deploy/microvm/p4-turn-smoke.sh --auth` (#409).

**`sudo` must find podman.** The rig's `secure_path` includes `/usr/local/bin`, where podman-static
installs, so the commands on this page run as written. If `sudo podman version` says
`command not found` on your host, put `env PATH="/usr/local/bin:$PATH"` **after** `sudo` in every
`sudo` command here, as in `sudo env PATH="/usr/local/bin:$PATH" podman …`. Before `sudo` it does
nothing, because sudo looks commands up in its `secure_path`, not the caller's `PATH`. That includes
4b's `sudo timeout … sh -c '… podman …'`. Without it, that loop prints
`podman: not found` for 60 s and exits 124 (`deploy/microvm/P4-ON-P6.md`, "Prerequisites").

## Act 0 — Preparation (operator, the day before)

### 0a. P6 with the control plane and the GitHub OAuth app

Bring the VM up with `deploy/vm/setup-vm.sh` and a GitHub OAuth app with **Enable Device Flow**
ticked (`deploy/vm/README.md`, "Bring it up" and "The GitHub OAuth app"). On the SSH-tunnel
topology, pass both control-plane settings. On a fresh VM this is the **second** run, once
`SH_RELAY_TOKEN` is set:

```bash
cd /opt/serverless-harness
sudo env SH_GITHUB_CLIENT_ID=<client id> SH_PUBLIC_HARNESS_URL=http://127.0.0.1:8080 \
  ./deploy/vm/setup-vm.sh
```

**Pull the current sandbox image first.** `setup-vm.sh` runs whatever
`ghcr.io/rossoctl/moca-remote-worker:latest` the host already has, and never pulls. The rig's copy
predated #372, so its `HOME` was the shared `/workspace` instead of `/home/sandbox`:

```bash
sudo podman pull ghcr.io/rossoctl/moca-remote-worker:latest
sudo podman run --rm --entrypoint sh ghcr.io/rossoctl/moca-remote-worker:latest -c 'echo $HOME; command -v curl git'
```

Expected: `/home/sandbox`, `/usr/bin/curl`, `/usr/bin/git`. The containers pick the new image up at
0b's `setup-vm.sh` re-run.

**The login needs no lengthening.** An API token lasts 15 minutes, and `mocactl` renews it by itself
for 30 days after its last use (90 days at most), so one device-flow login in Act 1 carries the whole
demo and `SH_API_TOKEN_TTL_SECONDS` stays unset.
Session tokens (300 s) re-mint on their own and need nothing.

**On a cloud host, require IMDSv2 with a hop limit of 1.** Container sandboxes have open egress in
this round, instance metadata included (#357). The research act depends on that egress, so this is
not optional. The VM also needs outbound HTTPS to `github.com` and `api.github.com`, and the
sandboxes to `github.com` and `nodejs.org`.

### 0b. Install the P4 tier, rehearse it, then park it

The microVM worker is installed now, while nobody depends on the sessions, and stopped until
Act 4. Follow `deploy/microvm/P4-ON-P6.md`:

1. **Build the golden snapshot** ("Build the golden snapshot"), from the image 0a pulled. The
   container sandboxes can keep running for this.
2. **Remove the container sandboxes and install the worker.** The demo removes them so that Act 4
   shows a P4-only host. A host may keep both tiers instead (`P4-ON-P6.md`, "Container sandboxes
   and P4 on one host"), and `setup-microvm.sh` then makes it tiered:

   ```bash
   sudo podman rm -f $(sudo podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-')
   cd /opt/serverless-harness
   sudo deploy/microvm/setup-microvm.sh                                  # a >= 24 GiB host
   sudo MICROVM_MAX_COMMITTED_MB=8192 deploy/microvm/setup-microvm.sh    # a smaller host (16 GiB here)
   ```

   Use one of the two. The shipped unit asserts at least 23G of memory and refuses to start on a
   smaller host, so a 16 GiB host needs the budget. 8192 is the 16 GiB rig's value. On another
   size, the script's two bounds decide it:
   - the budget must be above the unit's 4096 MiB reserve, or the script refuses it;
   - the drop-in it writes asserts 90% of the budget as physical memory, so the host needs at least
     that much.

3. **Rehearse it:** `p4-turn-smoke.sh --auth --failure-paths` ("Automated check"). Then do **both**
   of its cleanups:
   - **Point the supervisor back at the real model:** remove
     `sh-supervisor.service.d/90-p4-smoke.conf` and `/etc/serverless-harness/p4-smoke.env`, restart
     `sh-supervisor`, and stop `p4-mock-anthropic` ("Afterwards, point the supervisor back at the
     real model"). Step 4's `setup-vm.sh` re-run does not undo this, and 0d does not check it, so a
     missed step leaves the supervisor on `mock-p4`, and the research rehearsal below fails for no
     obvious reason.
   - **Delete the run's sessions, credentials, subject records and workspaces**, with the deletes
     block that follows.

   The run passed 34/34, and the four deletes answered 204.

4. **Park it, and bring the containers back.** This `setup-vm.sh` re-run recreates Redis and so
   forgets every session (#410). That is harmless now, and is why it happens today:

   ```bash
   sudo systemctl disable --now microvm-worker.service
   sudo podman exec sh-redis redis-cli HDEL sh:sandbox:records moca_microvm_0
   cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
   ```

   The `HDEL` answered `0` on the run: the worker's record was already gone, removed when it
   disconnected. It is a no-op here either way, because the `setup-vm.sh` re-run on the next line
   recreates Redis and with it `sh:sandbox:records`. It matters only for a switch made without a
   re-run.

The relay keeps the worker's token: `setup-vm.sh` leaves `setup-microvm.sh`'s relay drop-in in
place. So in Act 4, starting the worker is enough to attach it.

**Rehearse the research turn** on the container tier ("A research turn" in `deploy/vm/README.md`),
with a key of your own. The key file holds exactly one line, the key alone:

```bash
cd /opt/serverless-harness
sudo install -m 0600 /dev/null /root/inference-key && sudoedit /root/inference-key
sudo VM_RESEARCH_SMOKE=1 RESEARCH_CREDENTIAL_FILE=/root/inference-key ./deploy/vm/research-smoke.sh
sudo rm -f /root/inference-key
```

The run passed 13/13 on a raw Anthropic key. It leaves its minted subject's empty record in
`/var/lib/moca-control-plane/` (fix list): delete it in Cleanup.

> Trap: from here until Cleanup, **do not re-run `setup-vm.sh`.** Every re-run loses every user's
> sessions (#410), and a re-run while the microVM worker is enabled starts the containers next to
> it, so both tiers attach. Until a `setup-microvm.sh` re-run makes the host tiered, a new session
> may land in either tier (each still returns to its sandbox); after it, each session stays in the
> tier it was created in (`deploy/microvm/P4-ON-P6.md`, "Container sandboxes and P4 on one host").
> Either way the host is no longer the P4-only one Act 4 shows.

### 0c. The participants' SSH accounts

Restrict each participant's account to the two forwarded ports: `vm-two-user-acceptance.md`, 0a,
"Restrict the participants' SSH accounts to the tunnel". Loopback Redis holds the ownership index
with no authentication, so an unrestricted account could take over any session. The run used two
accounts, `user1` and `user2`, created with `useradd -m -s /usr/sbin/nologin` and an
`authorized_keys` each.

**Then rehearse one real login** from a laptop, through one of those accounts (1a, 1b). This comes
after the restriction, so 1a's own check passes. The smokes mint their tokens and never touch
GitHub, so without this step a device-flow misconfiguration would show up first in front of the
room. Close the rehearsal tunnel afterwards, with `ssh -S ~/.ssh/moca-tunnel -O exit <account>@<vm>`.
Left open overnight, it still holds local ports 8090 and 8080 on the day, and 1a's tunnel exits on
the bind failure (`ExitOnForwardFailure=yes`).

### 0d. Check what is running (operator, on the day)

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
systemctl is-enabled microvm-worker.service
sudo podman exec sh-redis redis-cli HKEYS sh:sandbox:records
```

Expected output (the two records come in either order):

```
ok
SH_REQUIRE_AUTH=true
MOCA_TENANCY unset
SH_ALLOW_OPERATOR_FALLBACK unset
disabled
sh-sandbox-1
sh-sandbox-0
```

The script reads the **running** processes, not their env files, and exits before printing more
if it cannot. `SH_ALLOW_OPERATOR_FALLBACK=false` passes too: the fallback is on only at `true`,
and with it off every turn has to spend its user's own credential. The last lines are the tier:
two container sandboxes, and no `moca_microvm_0`.

## Act 1 — Two users log in

Do all of Act 1 as user 1, then as user 2. Each laptop needs:

- `jq` and a browser;
- an inference credential of its user's own: a gateway token or an Anthropic API key;
- `mocactl`, which runs from a checkout. There's no installed `mocactl` command. Follow
  `packages/mocactl/QUICKSTART.md`: Node 22 and pnpm 9, `pnpm install` in the checkout, and in each
  terminal, from the checkout:

  ```bash
  alias mocactl="node $PWD/packages/mocactl/bin/mocactl.mjs"
  ```

  Every bare `mocactl` on this page assumes that alias.

(The blocks run on the laptops have no `#` comments, so they paste cleanly into macOS's default
zsh.)

### 1a. Open the tunnel

```bash
ssh -f -N -M -S ~/.ssh/moca-tunnel -o ExitOnForwardFailure=yes \
  -L 8090:127.0.0.1:8090 -L 8080:127.0.0.1:8080 <account>@<vm>
export SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
```

Both users forward the **same** local ports, because the control plane advertises one harness URL
(`http://127.0.0.1:8080`) to everyone. Prove the account is restricted before going on
(`vm-two-user-acceptance.md`, 0b):

```bash
ssh <account>@<vm> true
printf 'PING\r\n' | ssh -W 127.0.0.1:6379 <account>@<vm>
```

Expected, as on the run for both accounts:

```
This account is currently not available.
channel 0: open failed: administratively prohibited: open failed
stdio forwarding failed
```

A `+PONG` means 0c does not apply to this account: stop and fix it.

> Trap: to play both users on one machine, open the tunnel once only, and give user 2's terminal
> its own config directory **and** the control-plane URL. That terminal skips 1a's block, which is
> where the URL is exported, and a fresh `XDG_CONFIG_HOME` has no saved URL, so `mocactl login`
> would stop with `missing control-plane URL`. In user 2's terminal, after the alias:
>
> ```bash
> export XDG_CONFIG_HOME=/tmp/user2 SH_CONTROL_PLANE_URL=http://127.0.0.1:8090
> ```
>
> `mocactl` keeps one identity per config directory (#404).

### 1b. Log in

```bash
mocactl login
```

Expected: a code, then, once it is entered at `https://github.com/login/device` and the app
approved:

```
Open https://github.com/login/device and enter the code 7950-E495
logged in as <your GitHub name>
```

> Trap: the device flow approves for **whichever GitHub account the browser is signed into**. One
> person playing both users approves user 2's code in a private window signed in as the second
> account. Approving it in the first account's window logs user 2 in as user 1, and every
> cross-user check after that passes for the wrong reason.

> If it prints `login failed: the control plane cannot log anyone in until its operator fixes it`,
> the rest of the line names the fix (#405): `device_flow_disabled` means the OAuth app's **Enable
> Device Flow** box is unticked, and `GitHub knows no OAuth app with client id …` means
> `SH_GITHUB_CLIENT_ID` is mistyped. Both are fixed on the VM and on GitHub; nothing the user does
> helps. 0c's rehearsal login catches both.

### 1c. Store your own inference credential

Start `mocactl`, open **Credentials** with `ctrl+x k`, and add one with consumer `inference`:

- **An Anthropic API key** (`sk-ant-api…`): kind `api-key`, destination host `api.anthropic.com`,
  gateway endpoint `https://api.anthropic.com` (no `/v1`), and the key pasted as is into the
  **API key** field.
- **A gateway token:** kind `bearer`, with the fields in `packages/mocactl/QUICKSTART.md`, step 4.

Give the two users' credentials different names (the run used `anthropic` and `anthropic-dev`), so
2c's audit tells them apart at a glance.

> Say: this key is yours, not the operator's. The control plane stores it encrypted, and resolves
> it for each of your turns. There is no shared model key on this VM: the operator-key fallback is
> off (0d).

### 1d. Doctor

```bash
mocactl doctor
```

Expected: all seven checks green, ending `✓ 7 harness trusts this control plane`. Doctor stops at
the first failure and names the fix.

## Act 2 — Research from the sandbox

The agent's bash tool runs in a container sandbox on the VM. The sandbox reaches the internet, so
the agent can clone a repository and fetch a file, and answer from what it found rather than from
memory.

### 2a. User 1 asks a question only the live internet can answer

The prompt is `deploy/vm/README.md`'s, with the directory made per user: on the container tier
the users share `/workspace` (2d), and `git clone` refuses a directory that already exists. User 1
uses `research-user1`, user 2 `research-user2`:

```bash
D=research-user1
P="This is a research task. Use your bash tool for every step, and do not answer from memory.
1. Run: git clone --depth 1 https://github.com/rossoctl/moca /workspace/$D/moca
2. Run: curl -fsSL -o /workspace/$D/node-releases.json https://nodejs.org/dist/index.json
   The file is large: do not print it. Read what you need from it with head, grep or python3.
3. Find the commit the clone checked out, and the newest Node.js release in the fetched file (its
   first entry) with its release date.
Reply with one short paragraph saying what you found, then end with exactly these three lines:
COMMIT=<the first 12 characters of the commit hash>
NODE_VERSION=<the version, for example v1.2.3>
NODE_DATE=<its date, YYYY-MM-DD>"
mocactl run "$P" --json | jq -j '
  if .type == "tool_use" then "\n$ \(.args.command // .args)\n"
  elif .type == "tool_result" and .isError then "  (that command failed)\n"
  elif .type == "text" then .delta
  elif .type == "error" then "\nerror: \(.errorMessage // .stopReason)\n"
  else empty end'
```

`--json` streams the turn's frames, so the room sees each command as the agent runs it. Plain
`mocactl run` prints only the answer. On the run:

```
session 7ce498ad-6776-40f2-b0c0-2b3166e3f49c
I'll run the steps using bash.
$ git clone --depth 1 https://github.com/rossoctl/moca /workspace/research-user1/moca 2>&1; echo "---EXIT: $?"
$ curl -fsSL -o /workspace/research-user1/node-releases.json https://nodejs.org/dist/index.json 2>&1; echo "---EXIT: $?"; ls -la /workspace/research-user1/node-releases.json
$ cd /workspace/research-user1/moca && git rev-parse HEAD
$ python3 -c "import json;d=json.load(open('/workspace/research-user1/node-releases.json'));print(d[0]['version'],d[0]['date'])"
I cloned the `rossoctl/moca` repository (shallow clone), which checked out commit `03d2ee8c067d`. I
then downloaded the Node.js release index and read its first entry, which is the newest release:
Node.js v26.10.0, released on 2026-09-21.

COMMIT=03d2ee8c067d
NODE_VERSION=v26.10.0
NODE_DATE=2026-09-21
```

The agent words its commands its own way; what matters is that the clone and the fetch ran in the
sandbox. **Write the session id down** (`session <id>`, on stderr). Act 3 uses it.

### 2b. Check the answer against the world

On any machine:

```bash
git ls-remote https://github.com/rossoctl/moca HEAD | cut -c1-12
curl -fsSL https://nodejs.org/dist/index.json | jq -r '.[0] | "\(.version) \(.date)"'
```

Expected: the same commit and release as the agent's last three lines. On the run,
`03d2ee8c067d` and `v26.10.0 2026-09-21`.

> Say: neither value can come from a model's memory. The clone's HEAD changes with every merge, and
> the newest Node.js release every few weeks. The file is about 330 KB, past the 50 KB of output
> the agent is shown, which is why the prompt says `curl -o` and then `grep`: the agent reads the
> file in pieces, as a person would.

### 2c. User 2 does the same, on their own key

User 2 runs 2a with `D=research-user2`, then 2b. On the run, user 2's agent read the file with
`head -c 400` instead of `python3`, and reached the same three values. Then the operator shows
whose credential each turn spent:

```bash
sudo podman exec sh-redis redis-cli XREVRANGE sh:cp:audit + - COUNT 6
```

Expected: for each user's session, a `session_created` entry and then a `credential_issued` one,
each with that user's `subject` and their own credential **name**. On the run (newest first, one
line per entry):

```
github:228572680  credential_issued  a961ec51-…  anthropic-dev
github:228572680  session_created    a961ec51-…  anthropic-dev
github:6678093    credential_issued  7ce498ad-…  anthropic
github:6678093    session_created    7ce498ad-…  anthropic
```

`redis-cli` prints each field on its own line. A `session_created` and `session_deleted` pair with
no turn between them is `doctor`'s check 7, which creates a scratch session and deletes it. The
audit stream records names, never values.

> Say: two users, two subjects, two keys. Each turn resolved its owner's credential at the control
> plane, and with the operator-key fallback off, a user with no credential gets no turn at all.

### 2d. The honest beat: the container tier shares one filesystem

```bash
for c in sh-sandbox-0 sh-sandbox-1; do echo "$c:"; sudo podman exec "$c" ls /workspace; done
```

Expected: the users' research directories, each in whichever container its turn leased. On the
run, both landed in one:

```
sh-sandbox-0:
sh-sandbox-1:
research-user1
research-user2
```

> Say: this is the limit to say out loud. Session **ownership** is enforced (Act 3), but the
> container tier has no sandbox isolation between users. Both users' turns lease the same
> containers, which share `/workspace`, the Unix user and the process list, so user 2's agent could
> read user 1's clone. Act 4's tier gives each session its own workspace. The real fix, owner
> binding, is MI1 S5.

## Act 3 — Neither can see or reach the other's sessions

### 3a. Session lists are disjoint

**Sessions** in `mocactl` (`ctrl+x l`) titles each session by its first prompt, and both users ran
the same prompt, so the two lists look alike. Show the ids instead. Each user, with the API token
`mocactl auth token` prints (renewed if it lapsed):

```bash
API_HDR="$(mktemp)"; mocactl auth token | sed 's/^/Authorization: Bearer /' >"$API_HDR"
curl -s -H @"$API_HDR" "$SH_CONTROL_PLANE_URL/v1/sessions" | jq -r '.sessions[].sessionId'
rm -f "$API_HDR"
```

Expected: each user's own sessions from Act 2, and nothing of the other user's. (This `curl` is
the acceptance doc's; the run checked the lists at the owner index instead.) On the run each
user held exactly one session:

```bash
for k in $(sudo podman exec sh-redis redis-cli --scan --pattern 'sh:cp:owner:*'); do
  echo "$k:"; sudo podman exec sh-redis redis-cli ZRANGE "$k" 0 -1
done
```

```
sh:cp:owner:f4cd8a8c45409c53:sessions:
7ce498ad-6776-40f2-b0c0-2b3166e3f49c
sh:cp:owner:53ac7ade737ad301:sessions:
a961ec51-d77f-4c63-9b74-ccc73b6c5d93
```

The key names a subject by the first 16 hex digits of its hash, not by name.

### 3b. Another user's session does not exist

User 1 sends their session id from 2a to user 2. User 2 tries to resume it, and then a session id
that never existed:

```bash
mocactl run "what did you find?" --session <user 1's session id>; echo "exit $?"
mocactl run "what did you find?" --session sess-does-not-exist; echo "exit $?"
```

Expected, and on the run, both times:

```
that session no longer exists, or is not yours
exit 1
```

Then user 1 resumes it, to show it was real:

```bash
mocactl run "In one sentence: what did you find?" --session <your session id>
```

Expected: an answer that recalls the commit and the Node.js release.

> Say: another user's session and a session that never existed get the same answer, a 404 from the
> control plane's ownership check. A 403 would confirm the id is real. The full API-level checks
> (DELETE, token re-mint, and a session token presented against another session) are
> `vm-two-user-acceptance.md`, Act 2. Run them here if the room wants the proof at the wire.

## Act 4 — The same VM, a microVM per tool call

### 4a. One question on the container tier

User 1:

```bash
mocactl run "Run uname -a in your sandbox and reply with its output only."
```

Expected: the **VM's own kernel**, because a container shares its host's. On the run:

```
Linux 975fcff1af5d 6.18.44-99.149.amzn2023.x86_64 #2 SMP PREEMPT_DYNAMIC Tue Aug 25 21:16:03 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
```

### 4b. Switch the host to the microVM tier (operator)

Both users stay idle: removing the containers fails any turn running in them.

```bash
sudo podman rm -f sh-sandbox-0 sh-sandbox-1
sudo systemctl enable --now microvm-worker.service
sudo timeout 60 sh -c 'until [ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records moca_microvm_0)" = 1 ]; do sleep 1; done' &&
  sudo podman exec sh-redis redis-cli HKEYS sh:sandbox:records
```

Expected: `moca_microvm_0`, alone. On the run it attached in two seconds. A container's presence
record goes when its worker disconnects, so no record of the removed containers is left behind to
be leased.

> Say: nothing was reinstalled, and no session was lost. The users stay logged in, and their
> sessions and credentials are where they were. Only the place where tool calls run changed.

### 4c. The same question, on a microVM

User 1, as in 4a. On the run:

```
Linux (none) 6.18.44+ #1 SMP PREEMPT_DYNAMIC Wed Sep  9 03:29:40 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
```

> Say: point at the hostname and the suffix, not the version. The guest kernel the snapshot was
> built with happens to be the same 6.18.44 as the VM's. But the hostname is `(none)`, not a
> container id, and the kernel is Firecracker's own build (`+`, built Sep 9), not Amazon Linux's
> (`-99.149.amzn2023`, built Aug 25).

### 4d. A session's workspace outlives its VMs

User 1 starts a new session with a multi-tool turn, then resumes it:

```bash
mocactl run "In your sandbox: write uname -a and python3 --version to notes.txt, git init, commit it, and tell me the hash."
mocactl run "Show git log --oneline and notes.txt." --session <the id it printed>
```

Expected: turn 2 shows turn 1's commit and file. On the run, turn 1 committed `6dcad49` and turn 2
printed `6dcad49 Add system info to notes.txt` and the file. That run's guest had no git identity,
so the agent's first `git commit` failed, and it set a local identity and retried (fix list 5).
Since #463 the image bakes one into `/etc/gitconfig`, so the first commit succeeds. Then the
operator shows where the tool calls ran:

```bash
sudo journalctl -u microvm-worker --since -10min | grep 'vmpool: exec' | grep 'workspace_key="<the id>"'
sudo ls /srv/workspaces/
```

Expected: one line per tool call, each with its own `vm=`, all under the session's id, and the
session's directory under `/srv/workspaces`. The line names the workspace and the VM, never the
command. On the run (`exit=128` is the failed commit, which #463 removes):

```
vmpool: exec req=… workspace_key="c3bb0aa1-d61a-42d1-a1be-4f46efafb392" vm=vm-5 cold="first-exec" exit=128 err=<nil>
vmpool: exec req=… workspace_key="c3bb0aa1-d61a-42d1-a1be-4f46efafb392" vm=vm-7 cold="" exit=0 err=<nil>
vmpool: exec req=… workspace_key="c3bb0aa1-d61a-42d1-a1be-4f46efafb392" vm=vm-8 cold="" exit=0 err=<nil>
```

> Say: every tool call got a fresh Firecracker VM, which was destroyed when the call returned. The
> session's files live in a workspace the next VM mounts, so turn 2 picks up where turn 1 left off.

### 4e. User 2 gets a workspace of their own

User 2 runs 4d's turns in a new session of their own, asking turn 2 to list the workspace too:

```bash
mocactl run "In your sandbox: write uname -a and python3 --version to notes.txt, git init, commit it, and tell me the hash."
mocactl run "Show git log --oneline and notes.txt, and list everything in your current directory." --session <the id it printed>
```

Expected: user 2's own commit and file, and nothing of user 1's. On the run, turn 2 showed
`c8f6851 Add notes.txt with system info`, and `/workspace` held only `.git/`, `notes.txt` and
`lost+found/` (the workspace is a filesystem image of its own). The operator's `ls /srv/workspaces/`
shows a directory per session, and user 2's journal lines (`vm-10`, `vm-12`, `vm-13` on the run)
name only user 2's id.

> Say: compare 2d. On this tier each session has its own workspace, so user 2's agent cannot see
> user 1's files. It is not yet a security boundary: anyone holding the relay's exec token can name
> any workspace (no grant binding, MI1 S4).

### 4f. The microVM has no network

User 1:

```bash
mocactl run "Run: curl -sS -o /dev/null -w '%{http_code}' https://nodejs.org/dist/index.json; then tell me the exact output or error."
```

Expected, as on the run:

```
curl: (6) Could not resolve host: nodejs.org
000 (exit: 6)
```

The guest has no network device, no DNS and no NAT (#277). Act 2's research works only on the
container tier, and this tier works on local content.

## Act 5 — The record

The 2026-10-01 run. Copy the table, empty, into the report for a later run.

| Item                                                          | Result                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Commit on the VM; instance type; Firecracker version          | `main` @ 03d2ee8 + this page (`a2a5254`); `m8i.xlarge`, AL2023, 16 GiB; Firecracker v1.17.0 (#376's install) |
| 0a sandbox image                                              | pulled `102ed4c1cfb9` (`HOME=/home/sandbox`); the host had a pre-#372 image                                  |
| 0b `p4-turn-smoke.sh --auth --failure-paths` (n/n)            | 34/34; cleanup 4 × 204. f2: `vsock-short-response: vmpool: guest closed before End: EOF`                     |
| 0b `research-smoke.sh` (n/n)                                  | 13/13, raw Anthropic key                                                                                     |
| 0d running config as expected; two container records only     | as expected; records listed `sh-sandbox-1`, `sh-sandbox-0`                                                   |
| 1a both accounts: no shell, Redis forward prohibited          | both                                                                                                         |
| 1b user 1 / user 2 subjects                                   | `github:6678093` / `github:228572680`: one person, two accounts, one laptop                                  |
| 1d both `doctor` all seven green                              | yes                                                                                                          |
| 2a/2b user 1's answer equals `ls-remote` and `index.json`     | `03d2ee8c067d`, `v26.10.0`, `2026-09-21`: equal                                                              |
| 2c user 2's answer equals them; audit shows two own creds     | equal; audit: `anthropic` (user 1), `anthropic-dev` (user 2), two different keys                             |
| 2d where the two research directories landed                  | both in `sh-sandbox-1`                                                                                       |
| 3a lists disjoint; 3b both refusals identical, owner resumes  | disjoint (one session each, owner index checked); both refusals identical, exit 1; owner resumed             |
| 4a container `uname -a`; 4c guest `uname -a`                  | `Linux 975fcff1af5d 6.18.44-99.149.amzn2023…` / `Linux (none) 6.18.44+…`                                     |
| 4b switch                                                     | `moca_microvm_0` alone, attached in 2 s; no re-login                                                         |
| 4d turn 2 saw turn 1's commit; Execs and distinct `vm=` count | yes (`6dcad49`); 3 Execs, 3 VMs                                                                              |
| 4e two workspaces, user 2's lines name only user 2's id       | yes; 3 Execs, 3 VMs; user 2 saw only its own `c8f6851`                                                       |
| 4f the guest's curl error                                     | `curl: (6) Could not resolve host: nodejs.org`                                                               |
| Elapsed time; anything unexpected (add to the fix list)       | not timed; fix list 4 to 9                                                                                   |

## What just happened

1. One VM ran the whole stack under systemd: no cluster, and no extra service per user.
2. Two real GitHub identities logged in through the device flow. Each subject is the account's
   numeric id, and the control plane kept no GitHub token.
3. Each agent researched live content from its sandbox, and its answer matched the world, not a
   model's memory.
4. Each user's turns spent that user's own credential, resolved per turn and audited by name.
5. Another user's session is indistinguishable from one that never existed.
6. The same host switched to the microVM tier without reinstalling or losing a session. Every tool
   call ran in its own Firecracker VM, and each session kept its own workspace across them.

## Notes and limits — what this demo does **not** claim

Say these in the room. They are what stops someone over-promising.

- **No sandbox isolation between users on the container tier.** Every user's turns lease the same
  sandbox containers, which share `/workspace`, the Unix user and the process list (2d;
  `remote-worker/internal/exec/runner.go` ignores `workspace_key`, #408). The fix is MI1 S5, owner
  binding.
- **Direct credential mode.** With no injector on this VM, a user's real inference secret reaches
  the shared harness worker for the length of a turn. That is the `knative-server` process
  `sh-supervisor` runs for every user, and it puts the secret in the model request's headers. The
  sandbox never receives it: an Exec carries only the command, stdin, timeout and workspace key, and
  the sandbox's environment allowlist is `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ`. So the agent's bash
  cannot read a user's key, but one harness process holds every user's key during their turns. MI1
  S2's grants replace this.
- **Open egress.** Container sandboxes reach the whole internet, including cloud instance metadata
  unless the host enforces IMDSv2 with hop limit 1 (#357). Egress control is MI1 S5's
  `moca-egress`.
- **P4 has no internet** (#277) **and no grant binding** (MI1 S4). Its workspaces are per session,
  but any holder of the relay's exec token can target any of them.
- **A session returns to its sandbox.** Each turn goes back to the sandbox that served the previous
  one. If that sandbox is saturated, or briefly absent (a relay restart) for up to
  `SH_SANDBOX_AFFINITY_GRACE_SECONDS` (60 s), the turn answers 503 with `Retry-After` and the client
  retries: the session waits and never moves. Only a sandbox gone past the grace moves the session,
  to the least-loaded sandbox of its tier, on an empty workspace, and the turn says so
  (`workspace reset: …`); it never crosses tiers.
- **Both tiers on one host are not shown.** A host may run both: each session stays in the tier it
  was created in (`sandboxTier`) and returns to its sandbox (`deploy/microvm/P4-ON-P6.md`,
  "Container sandboxes and P4 on one host"). This demo switches to P4 only for Act 4 instead.
- **Plain HTTP.** The SSH tunnel is the confidentiality. There is no TLS.
- **Ownership holds at the API only.** Redis (`127.0.0.1:6379`) and the supervisor's admin listener
  (`:8081`) have no authentication. Anyone with a shell on the VM, or unrestricted forwarding, is
  trusted with every session. That is why 0c restricts the participants' accounts.
- **Anyone with a GitHub account who reaches the control plane can log in.** There is no user
  allowlist: the SSH accounts are the gate.
- **Tenancy:** `MOCA_TENANCY` unset, at `v0.5.1`, with no first-subject pin. On a `main` past MI1
  S2, user 2 gets `403 single_tenant_deployment`. See the top of this page (#407).
- **A `setup-vm.sh` re-run forgets every session** (#410).
- **Not performed:** two people on two laptops. The run was one person with two GitHub accounts.

## Fix list

Found while writing and running this demo, on top of `vm-two-user-acceptance.md`'s list. Items 4
to 9 come from the 2026-10-01 run.

| #   | Finding                                                                                                                                                                                                                                                                                                                      | Status                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | **Login expiry mid-demo.** The API token lasts 15 minutes and `mocactl` renews it by itself for 30 days after last use (90 at most), so a long demo needs one login. Only a lapsed refresh token asks for another: the TUI recovers by itself (login overlay, prompt replayed); headless `mocactl run` says to log in again. | Works as designed. Nothing to set.                                                 |
| 2   | **`device_flow_disabled` and `Not Found` carried no hint.** The login error was GitHub's, verbatim.                                                                                                                                                                                                                          | Fixed (#405, #413): mocactl names the operator's fix.                              |
| 3   | **The switch back to containers loses every session.** It needs a `setup-vm.sh` re-run, which recreates `sh-redis` with no volume.                                                                                                                                                                                           | #410. The demo switches once, to P4, and only Cleanup goes back.                   |
| 4   | **`setup-vm.sh` never pulls the sandbox image.** A host keeps running whatever `:latest` it pulled first. The rig's predated #372 (`HOME=/workspace`).                                                                                                                                                                       | #414. 0a pulls by hand meanwhile.                                                  |
| 5   | **The guest has no git identity.** On the P4 tier, the agent's first `git commit` fails (`exit=128`) until it sets one. The container tier's #372 image has a writable `HOME`, but no identity either.                                                                                                                       | Fixed (#463): `/etc/gitconfig` in the image.                                       |
| 6   | **Sessions show only their first prompt.** Two users running the same prompt get identical-looking lists, so 3a cannot be shown in the TUI. The rows also read `0 turns · local history` after a headless `mocactl run`.                                                                                                     | #417: show a short session id; count turns from the server. #406 adds `sessions`.  |
| 7   | **`research-smoke.sh` leaves its minted subject's empty record** in `/var/lib/moca-control-plane/`. It deletes the credential, session and files, but not the record.                                                                                                                                                        | #418: delete it on exit, as `P4-ON-P6.md`'s cleanup does by hand for its subjects. |
| 8   | **No headless view of a turn's tool calls.** 2a needs `--json` and `jq` to show the room the commands.                                                                                                                                                                                                                       | #419: a `mocactl run --show-tools` would replace the filter.                       |
| 9   | **One identity per `XDG_CONFIG_HOME`**, and the device flow approves for whichever account the browser is signed into. Playing two users on one machine needs two config directories and a private browser window (1a, 1b).                                                                                                  | #404: `mocactl --profile`.                                                         |
| 10  | **MI1 S2's first-subject pin** will refuse user 2 under `single`.                                                                                                                                                                                                                                                            | #407: `v0.5.1` until S5, then `multi`.                                             |

## Cleanup

**On each laptop:** delete this run's sessions in **Sessions** (`ctrl+x l`, then `d`), run
`mocactl logout` (it revokes the login on the control plane and deletes `auth.json`), and close the tunnel with
`ssh -S ~/.ssh/moca-tunnel -O exit <account>@<vm>`. 3a's block already removed its header file.
Each user can delete their credential in **Credentials** first, and revoke the app on GitHub under
**Settings → Applications → Authorized OAuth Apps**.

**On the VM, first delete the run's microVM workspaces.** Nothing else will. Idle reclaim walks only
the running worker's in-memory list. The worker restarts with an empty list and never sweeps a
directory it doesn't know about, and deleting a session touches only Redis. So the users' files
(notes, commits) would stay on the host indefinitely. Use the session ids from 4c to 4f. To find
any others from the run, list the directory newest first: on a host that ran P4 before the demo,
it also holds earlier workspaces, which this sorts apart from the run's before anything is deleted:

```bash
sudo ls -lt /srv/workspaces/
sudo rm -rf /srv/workspaces/<session id>
```

On a host that stays P4-only (below), idle reclaim does run after 8 h, but only if the worker isn't
restarted in that time. Delete them anyway.

**Then put the container tier back.** Stop the worker **first**, so the re-run does not start the
containers next to it. The re-run recreates Redis, which also drops whatever sessions are left
(#410):

```bash
sudo systemctl disable --now microvm-worker.service
cd /opt/serverless-harness && sudo ./deploy/vm/setup-vm.sh
```

**Delete the research smoke's leftover subject record** (fix list 7). The file store names a
subject's record by the first 16 hex digits of the subject's `sha256`, with `.json` after it. Use
the subject the smoke printed (`a minted user (research-smoke:research-…)`):

```bash
S='research-smoke:research-<id>'
sudo rm -f "/var/lib/moca-control-plane/$(printf %s "$S" | sha256sum | cut -c1-16).json"
```

**Remove the participants' SSH accounts**, one `userdel` per account (it takes a single login):

```bash
sudo userdel -r user1
sudo userdel -r user2
```

`userdel` refuses an account that still has a process, such as an open tunnel, so do this after the
laptops' `-O exit` above. Then delete their `Match` block from `/etc/ssh/sshd_config` and apply it
with `sudo sshd -t && { sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd; }`.

The research directories went with the containers, which the re-run recreated. To remove the P4
tier entirely, follow `deploy/microvm/P4-ON-P6.md`, "Uninstall". Delete the OAuth app when the
demo is over.

A host that was P4-only before the demo goes back to P4-only instead: skip the re-run above, and
leave the worker enabled.
