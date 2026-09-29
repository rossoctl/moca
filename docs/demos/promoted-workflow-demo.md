# Demo: "The workflow you built on your laptop, running in the cluster"

A ~8-minute walkthrough of **workflow promotion**: you author an agent workflow in Claude Code — a
skill, a `CLAUDE.md`, a memory file, a slash command — and run it **unchanged** in the harness by
adding one field to a dispatch.

The task — write a ship note — is just a vehicle. The real show is **what the remote agent knows**.
You will send the same prompt twice, to the same cluster, differing only by `configRef`, and watch
one run ask what a ship note even is while the other cites an incident id that exists nowhere but
your laptop's memory directory.

```
laptop                                    cluster
------                                    -------
/tmp/sh-demo               promote        harness pod (fs-free)      sandbox pod
  CLAUDE.md          --> canonical tar -->  /tmp/sh-config/<digest>/   /workspace/.sh-config/<digest>/
  .claude/skills/          sha256 in           skills/  context/            skills/
  .claude/commands/         Redis              (system prompt)         (what `read` can see)
  .claude/projects/*/memory/
```

One digest names both halves. The dispatch carries the digest and nothing else about the workflow.

| Act                    | What "move my workflow to the server" normally needs               | What promotion needs                                                                                  |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **1 — Author small**   | A hand-written manifest listing what to ship, kept in sync by hand | **One env var.** `HOME=$SH_DEMO_SANDBOX` makes the sandbox its own user scope                         |
| **2 — Promote**        | An image rebuild, a redeploy, a registry push                      | **`/promote`, inside Claude Code** — a 12 KB tar, content-addressed; re-promotion uploads **nothing** |
| **3 — Run it**         | A bespoke endpoint that knows about your skills                    | **One field.** `"configRef": "sha256:…"` on the existing prompt envelope                              |
| **4 — Know it landed** | Read the pod logs and hope                                         | The run cites a fact only your memory holds, and a token only the sandbox can read                    |

Promotion runs from **inside Claude Code** as `/promote`, in the same session you authored the
workflow in — Act 0 installs it. Prefer it non-interactive? `make demo-promoted-workflow` does all of
this and asserts every claim, driving the CLI directly since it has no Claude session to run in. This
document is the version you drive by hand so you can explain each move.

---

## Act 0: Install

You need a **warm** harness cluster whose image contains the promotion feature (merged in
[#214](https://github.com/rossoctl/moca/pull/214)). If you do not have one:

```bash
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca
cd pi-fork && npm ci && npm run build && cd ..
pnpm install

export ANTHROPIC_API_KEY=sk-...    # ...or a gateway: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
./deploy/knative/setup-kind.sh
```

> The model must be reachable **from the cluster** — both runs are real model calls.

If your cluster is already warm but predates #214, rebuild and **force a new Revision**. The image
tag is mutable, so re-applying an unchanged spec rolls nothing and you would keep serving the old
code:

```bash
docker build --load -t dev.local/moca:local .
kind load docker-image dev.local/moca:local --name sh-knative
kubectl -n default patch ksvc moca --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"$(date +%s)\"}}}}}"
kubectl wait ksvc/moca -n default --for=condition=Ready --timeout=180s
```

Set the convenience vars used throughout:

```bash
export NS=default KSVC=moca
export HOSTHDR='Host: moca.default.example.com'
export BASE=http://localhost:8080

# The SH_* names are the ones demo-promoted-workflow.sh and the make targets read, so the
# hand-driven and scripted halves of this walkthrough stay on the same sandbox and port.
export SH_DEMO_SANDBOX=/tmp/sh-demo
export SH_DEMO_REDIS_PORT=16379
export SH_MODEL=claude-haiku-4-5

# Where this repo is checked out. `/promote` reads this, because from Act 1b onward your shell's
# cwd is the sandbox, not the checkout -- and the CLI has no installed binary.
export SH_HARNESS_DIR=$(pwd)
```

### Install the `/promote` command

Act 2 runs promotion from **inside** Claude Code, and there are two places to install it. They differ
in one thing that matters for this demo: whether the session you author in resembles the one that
runs remotely.

**Option A — real user scope. Simpler; use this if you are just following along.**

```bash
mkdir -p ~/.claude/commands
cp deploy/claude/commands/promote.md ~/.claude/commands/promote.md
```

Claude Code sees `/promote` in every project, and `promote` — reading the sandbox as user scope —
never sees it, so it cannot travel. The cost: your authoring session also loads your real
`~/.claude`, so locally the agent has every skill you own while the promoted run gets the sandbox's
one.

**Option B — in the sandbox, for actual parity.** Put the command in the sandbox, so the local agent
can be made to see _exactly_ what the promoted run will:

```bash
mkdir -p $SH_DEMO_SANDBOX/.claude/commands
cp deploy/claude/commands/promote.md $SH_DEMO_SANDBOX/.claude/commands/promote.md
```

Installing is all that happens here. The matching launch (`HOME=$SH_DEMO_SANDBOX claude`) belongs in
**Act 1b**, and only after Act 1a has populated the sandbox: run it now and Claude Code would start
on an empty sandbox with no tunnels open, and your shell would be left in `$SH_DEMO_SANDBOX`, where
Act 1a's repo-relative `cp` paths cannot resolve.

> **This is what `--exclude-prompt` is for.** With user scope pointed at the sandbox, that
> `.claude/commands/` _is_ promote's prompts directory, and every markdown file in it travels — so
> without the flag the command would ship itself into every bundle as a prompt template. `/promote`
> detects that it lives in the project and adds `--exclude-prompt promote` itself; you do not pass
> it by hand. It adds the flag **only** in that case, because an exclusion matching nothing warns —
> the flag's own typo guard.
>
> The trade: a fresh `HOME` means Claude Code re-authenticates, and you lose your own skills for the
> duration. That is the standard dev/prod-parity cost, and parity is the whole claim this demo makes,
> so Option B is the more honest way to perform it.
>
> **Either option produces the same bundle**, so every digest quoted below holds for both. Measured:
> Option B without the exclusion is 19456 bytes (the command itself travelling); with it, 12288 bytes
> and `sha256:43b8c4c0…` — byte-identical to Option A.

### Open the two tunnels

```bash
kubectl port-forward -n kourier-system svc/kourier 8080:80 &
kubectl port-forward -n default svc/redis 16379:6379 &
export REDIS_URL=redis://localhost:16379
```

> **Why 16379 and not 6379.** A listener on 6379 is not evidence it is _this cluster's_ Redis. This
> repo's own test container (`sh-tdd-redis`) publishes `0.0.0.0:6379`; promote will happily upload
> into it, print `uploaded`, and then the harness — reading the cluster's Redis — fails with
> `config bundle not found` for the digest sitting right there in your terminal. Bind a private port
> instead. This cost the author two model calls before the failure surfaced.

### 0a. Prove the cluster implements promotion before you trust anything else

An unknown digest must fail **before** any model call. An image without the feature ignores the
field and answers normally — which would make Act 3's contrast look like a model mood swing rather
than a missing deployment:

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d '{"sessionId":"probe-1","kind":"prompt","prompt":"say hi",
       "configRef":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' \
  $BASE/runs | jq -c .
```

```json
{ "status": "failed", "reason": "error", "message": "config bundle not found: sha256:ffff…" }
```

> If you get `{"status":"responded", …}` instead, the cluster is serving a pre-#214 image. Stop and
> do the forced roll above. A green demo on the wrong image proves nothing.

---

## Act 1: Author in a sandbox, not in your whole `~/.claude`

> **Say this out loud, because it is the part people get wrong.** The tempting demo is "promote my
> real Claude Code setup". Don't. Measured on the author's laptop: a real `~/.claude` resolves **62
> skills**, 56 of which travel, into an ~8.6 MB bundle with dozens of preflight warnings — nearly
> all from skills the workflow never uses. A curated sandbox ships **one** skill in **12 KB** with
> **zero** findings. That is the design's own recommendation ([spec §11]) and this act is it.

### 1a. Build the workflow

Four files. A skill that defines a format, a `CLAUDE.md` that sets a house rule, a memory file
holding a fact, and a slash command as the entry point:

```bash
mkdir -p $SH_DEMO_SANDBOX/.claude/skills/ship-note/references $SH_DEMO_SANDBOX/.claude/commands
cp -R deploy/knative/fixtures/promoted-demo/skills/. $SH_DEMO_SANDBOX/.claude/skills/
cp -R deploy/knative/fixtures/promoted-demo/commands/. $SH_DEMO_SANDBOX/.claude/commands/
cp deploy/knative/fixtures/promoted-demo/CLAUDE.md $SH_DEMO_SANDBOX/CLAUDE.md

# Claude Code's own memory layout: every path separator in the project path becomes '-'
MEM="$SH_DEMO_SANDBOX/.claude/projects/-$(echo "${SH_DEMO_SANDBOX#/}" | tr '/' '-')/memory"
mkdir -p "$MEM" && cp deploy/knative/fixtures/promoted-demo/memory/*.md "$MEM/"

git -C $SH_DEMO_SANDBOX init -q

# Claim this directory as the demo's own. demo-promoted-workflow.sh gates every destructive
# touch -- including `--teardown` -- on this marker, so without it the scripted teardown will
# (correctly) refuse to remove the sandbox you just built.
touch $SH_DEMO_SANDBOX/.sh-demo-sandbox
```

> **Why `git init`.** `promote` bounds its `CLAUDE.md` walk at a `.git` entry. Without one it climbs
> past your sandbox into ancestor directories and sweeps their context files — including a personal
> `~/CLAUDE.md` — into a bundle bound for a shared store.

The memory file is the one to read aloud, because it is what makes Act 3 undeniable:

```bash
cat "$MEM/auth-timeout-incident.md"
```

It records that the regression is tracked as **KAG-4471** and ships behind
`auth.idle_reaper_v2`. Nothing else in the demo knows that.

### 1b. Watch it work locally first

```bash
cd $SH_DEMO_SANDBOX && claude --allowedTools "Bash(pnpm --dir $SH_HARNESS_DIR/harness promote:*)"
```

Under **Option B**, launch it this way instead — a sandbox `HOME` is what makes the local agent's
configuration identical to the promoted run's:

```bash
cd $SH_DEMO_SANDBOX && HOME=$SH_DEMO_SANDBOX \
  claude --allowedTools "Bash(pnpm --dir $SH_HARNESS_DIR/harness promote:*)"
```

> **Why the `--allowedTools` on the launch line.** `/promote`'s own `allowed-tools` frontmatter grants
> the CLI, but **only for the turn the slash command creates**. If that turn ends before the CLI runs
> — you interrupt it, or a guard makes it stop and ask — then answering "go ahead" starts a _new_ turn
> where the grant is gone, and under `defaultMode: dontAsk` the promotion is refused with no
> explanation beyond "denied". Measured: the grant is what permits `pnpm` (there is no `pnpm` rule in
> a default install), so the failure looks exactly like a broken command.
>
> Putting the rule on the launch line makes it session-level, so it outlives any turn. Your shell
> expands `$SH_HARNESS_DIR`, which is why this line is portable as written. It stays narrow: only the
> `promote` script, only in that one checkout — `pnpm --dir $SH_HARNESS_DIR/harness <other-script>` is
> still refused.
>
> Prefer it permanent? Add the same rule to `permissions.allow` in `~/.claude/settings.json`, with the
> path written out in full. Two caveats, both measured: a `*` inside the pattern
> (`Bash(pnpm --dir * promote:*)`) matches **nothing**, so the literal path is required; and the same
> rule in a project's `.claude/settings.json` is **ignored until you accept the trust dialog** for
> that directory, which for a throwaway sandbox is easy to miss — it prints one warning and then
> behaves as if the rule were absent. If you would rather not configure anything, run Act 2a in
> `manual` mode (Shift+Tab) and approve the one prompt.
>
> Append `Skill` to that flag list — `--allowedTools "Bash(…promote:*)" Skill` — if you would rather
> not see the harmless denial described under **Notes and limits**.

Ask it: `Write the ship note for the auth timeout fix.` You get the house `SHIP NOTE` block with
the ticket and the risk line. This is the "works on my laptop" baseline — the thing that normally
does not survive the trip.

> Leave this Claude Code session open. You will drive the rest of the demo _from it_: it is the
> terminal where the workflow was authored, so promoting and dispatching from here is the point.

---

## Act 2: Promote

### 2a. One slash command, from the session you authored in

In the Claude Code session from Act 1b — still in the sandbox — run:

```
/promote ship-note
```

Claude checks the three guards, starts the Redis tunnel if it is not up, and runs the CLI for you.
**Let that turn finish.** If it stops early — you interrupt it, or it pauses to ask — re-run
`/promote ship-note` rather than replying "go ahead": a follow-up turn has weaker permissions than the
command's own, and unless you launched with the `--allowedTools` line above, the CLI call is refused
there. Expect output like:

```
project:    /tmp/sh-demo
user scope: /tmp/sh-demo (--home)
inventory:  …/sandbox-inventory/ghcr.io_rossoctl_moca-sandbox_latest.json (347 binaries)
  resolved   1 skills
  travels    1
  dropped    0
  context    2 file(s), 1 memory file(s)
  secrets    no blocking findings
  entry      ship-note

preflight: no findings

  bundle     sha256:43b8c4c0…  (12288 bytes, uploaded)
  lockfile   .claude/promoted.lock.json

dispatch with:  {"sessionId":"<run>/<item>","kind":"prompt","prompt":"…","configRef":"sha256:43b8c4c0…"}
```

> **The user-scope override is the demo, not a shortcut** — `/promote` passes it for you, but say
> what it does. `promote` reads _user_ scope from `$HOME/.claude`; pointing that at the sandbox makes
> the sandbox its own user scope, so the bundle holds this workflow and nothing else. It is also what
> makes this project's **entry prompt** travel at all, since `promote` reads prompts from user scope
> only. The command it runs is:
>
> ```bash
> pnpm --dir /path/to/moca/harness promote --entry ship-note \
>   --project /tmp/sh-demo --home /tmp/sh-demo --redis-url redis://localhost:16379
> #   ...plus --exclude-prompt promote under Option B, which /promote adds for you
> ```
>
> That trailing flag is not cosmetic: under Option B the command is in the sandbox, so without it the
> bundle is 19456 bytes rather than the 12288 printed above.
>
> `--project` looks redundant next to `--home` and is not: without it the CLI promotes the directory
> the process started in, which through `pnpm --dir` is the harness checkout. Measured — it reports
> `project: …/moca/harness`.
>
> **Why every path is written out in full.** `--home /tmp/sh-demo` is doing what `HOME="$PWD"` did
> here, and `--redis-url` what `REDIS_URL=` did — same bundle, byte for byte, digest for digest.
> They are flags because the env form cannot be _permitted_. Claude Code statically parses each Bash
> command and matches it against `allowed-tools` only if it can analyse it: a `$PWD` argument is
> classified unanalyzable, and an inline `HOME=… pnpm …` prefix moves the first word away from the
> granted one. Neither matches any grant, so the best case is a permission prompt on every run and
> the common case is worse — with `defaultMode: dontAsk` the slash command is refused before you see
> its Context, and in `auto` it is denied as `Contains expansion`. Written out literally, the whole
> promotion needs no prompt in any permission mode. That is what makes "one slash command" true
> rather than aspirational.
>
> Note `travels 1`, `preflight: no findings`, and `12288 bytes`. Those three numbers are the
> argument for sandbox-first authoring, and the last line hands you the exact dispatch envelope.

The lockfile is committable, and it is also the most convenient place to read the digest back from:

```bash
export DIGEST=$(jq -r .digest $SH_DEMO_SANDBOX/.claude/promoted.lock.json)
echo $DIGEST
# => sha256:43b8c4c04fc084ed0df724572082ab35b381cd803d86675b8e52a2efb5e7cee6
```

### 2b. Verify it landed in the cluster's Redis, not somewhere else

Read the key back through the cluster's **own** client rather than your port-forward. A forward
pointing at the wrong Redis passes every check up to here:

```bash
kubectl exec -n $NS deploy/redis -- redis-cli EXISTS "config:bundle:$DIGEST"
# => 1
```

### 2c. Re-promotion is free

Run it again, unchanged:

```
/promote ship-note
```

```
  bundle     sha256:43b8c4c0…  (12288 bytes, unchanged — upload skipped)
```

> Same digest, no upload. The bundle is content-addressed over a **canonical** tar — sorted paths,
> normalised mtimes and modes — so re-promoting unchanged configuration is a no-op, and the digest
> does not even depend on which directory you authored in.

---

## Act 3: The same prompt, one field apart

Both dispatches are byte-identical but for `configRef`. Same cluster, same model, same prompt.

### 3a. Check the shared cache is empty, or your control is not a control

The overlay materialises the bundle into a digest-keyed cache inside the **shared pool sandbox**. It
is world-readable and contains `context/agents/0-CLAUDE.md` and `memory/`, so a bare leaf that found
one on disk could read another run's workflow and answer from it. The cache is refcounted, and
reclaimed when the last leaf using it releases — so between runs there should be nothing there:

```bash
# The leaf may have leased ANY pool sandbox, so ask the pool rather than guessing a pod.
export POOL=$(kubectl get pods -n $NS -l 'sh.kagenti.io/sandbox-pool=default' -o name | sed 's|pod/||')
# `sh -c` so the glob expands in the POD. Without it kubectl sends `sha256-*` literally, which
# matches nothing remotely and prints nothing whether or not a bundle is cached.
for p in $POOL; do
  kubectl exec -n $NS "$p" -- sh -c 'find /workspace/.sh-config/sha256-* -type f 2>/dev/null'
done | sed 's|.*/sha256-[0-9a-f]*/||'
# (no output — the cache is empty)
```

> **Scoped to `sha256-*` on purpose.** A bare `find /workspace/.sh-config -type f` also prints the
> refcount files under `.refs/`, and one of those can legitimately exist here — a concurrent leaf, or
> a stale ref from a harness pod that died mid-leaf. The callout below says a filename means a bug to
> report, so an unscoped listing would point you at the wrong one.

> **Verify, do not purge.** Earlier versions of this walkthrough had you `rm -rf` the cache here,
> because it used to outlive its leaf ([#216](https://github.com/rossoctl/moca/issues/216)).
> Don't reintroduce that: an `rm` cleans up after a teardown regression and hides it, and the
> control's honesty goes back to depending on you running the right command rather than on the
> harness. If the command above prints file names, that is a **bug to report**, not a step to repeat.

> **This bit the author, which is why the check is still here.** Before the cache was refcounted,
> the second run of this demo had its _bare_ arm cite both the ticket and the sandbox token, and
> open with "following the house rules" — having been told none of it.
> The A/B still looked plausible; it had just stopped proving anything. Note also that _any_ cached
> bundle carrying the same memory fact does that, not only the digest you are about to dispatch — a
> bundle built from this same fixture before Prettier normalised one emphasis marker in the memory
> file has a different content digest and would sit alongside. So the check counts every `sha256-*`
> directory, not just yours.

### Before you dispatch: two preconditions, or Run B lies to you

Both runs below create **persistent** sessions, and `$DIGEST` alone decides whether Run B is promoted
at all. Check one and clear the other:

```bash
[ -n "$DIGEST" ] || echo "DIGEST is EMPTY — re-run the jq line at the end of Act 2a before dispatching"

# The two ids below are single-use. Clear them before any retry (or use fresh ids).
kubectl exec -n $NS deploy/redis -- redis-cli DEL \
  session:demo-bare-1 session:demo-bare-1:seq session:demo-promoted-1 session:demo-promoted-1:seq
```

> **Why to check `$DIGEST` anyway.** `jq --arg c "$DIGEST"` happily sends `configRef: ""`. Since
> issue #222 that is an **error**, not a silent bare run: `/runs` answers `400` with error
> `configRef_invalid`, and a leaf reached by any other route fails outright, naming the field.
> Before the fix it ran bare and answered exactly like Run A — nothing failed, nothing
> warned, and Run B appeared to prove the opposite of what it proves. The check above just saves you
> the round trip; the usual way in is dispatching from a second terminal where `DIGEST` was never
> exported.
>
> **Why the session ids are single-use.** Sessions are Redis streams; re-dispatching the same id
> _appends a turn_ rather than starting over, and the earlier turns stay in context. Measured on a real
> session: a bare turn at 19:49 answered "the workspace appears empty, could you provide…", and the
> promoted turn at 20:41 — which demonstrably received the overlay and the injected `Skill files:` /
> `Memory files:` paths — asked for the same information again instead of reading them, having been
> taught by its own transcript that these files are unavailable. The same prompt and digest in a
> **fresh** session produced the block below on the first try. So a Run B that asks you for the
> incident id is a session to delete before it is a bug to report.

### 3b. Run A — bare

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$SH_MODEL" '{sessionId:"demo-bare-1", kind:"prompt", model:$m,
        prompt:"Write the ship note for the auth timeout fix."}')" \
  $BASE/runs | jq -r .text
```

```
The workspace appears to be empty. Could you provide me with:

1. **Where is the code/project?** …
3. **Format for the ship note:**
   - Is there an existing SHIP_NOTES, CHANGELOG, or similar file I should follow?
```

> It does not know what a ship note is here, has no incident to cite, and asks you. This is the
> harness's normal behaviour, unchanged — which is the back-compat guarantee, stated as output.

### 3c. Run B — the same prompt, plus the digest

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$SH_MODEL" --arg c "$DIGEST" '{sessionId:"demo-promoted-1", kind:"prompt", model:$m,
        prompt:"Write the ship note for the auth timeout fix.", configRef:$c}')" \
  $BASE/runs | jq -r .text
```

```
SHIP NOTE · auth-idle-reaper-fix
WHAT:   Fixed sessions disconnecting after 30 seconds of inactivity
WHY:    The idle reaper was measuring time since connection open instead of last activity
TICKET: KAG-4471
RISK:   low — fix is reversible behind auth.idle_reaper_v2 feature flag
TOKEN:  SHIPNOTE-7F3A-SANDBOX-OK
```

> **Pause here and read the four lines back one at a time.** Each one is a different channel
> arriving, and each is separately checkable:
>
> - **The format** came from the skill. Pi puts only a skill's _name and description_ in the system
>   prompt and tells the model to `read` the body when it matches — and that read runs in the
>   **sandbox pod**.
> - **`TICKET: KAG-4471`** came from your memory directory. The model cannot guess it; Run A
>   demonstrably did not produce it. Memory travels **read-only**
>   ([ADR-0031](../adrs/0031-promoted-memory-read-only.md)), so a promoted run consumes what you
>   taught it and stays replayable.
> - **`RISK:`** came from `CLAUDE.md`, injected as an agents file — the deterministic channel.
> - **`TOKEN:`** is the load-bearing one. It lives in `references/release-token.md` _inside_ the
>   skill's own directory. Producing it means the bundle materialised on the **sandbox** side of the
>   fs-free split **and** a relative sibling path resolved against the absolute skills root the leaf
>   injects. The skill even says "if you cannot read that file, write `TOKEN: unavailable`", so a
>   failed read shows up as an honest gap instead of a hallucinated token.

### 3d. Prove the sandbox half on the filesystem, not in the model's prose

The `TOKEN:` line is the model _telling_ you it read the file. Now check the claim directly — this
holds even on a run where the model declines to read.

**Catch it while the leaf is running.** The cache lives exactly as long as a leaf holds a ref on it,
so a `kubectl exec` _after_ Run B returned will correctly find nothing. Dispatch in the background
and watch for the file to appear underneath it:

```bash
TOKEN_PATH="/workspace/.sh-config/sha256-${DIGEST#sha256:}/skills/ship-note/references/release-token.md"

# A fresh session id: 3c's is single-use (see "Why the session ids are single-use" above).
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$SH_MODEL" --arg c "$DIGEST" '{sessionId:"demo-overlay-1", kind:"prompt", model:$m,
        prompt:"Write the ship note for the auth timeout fix.", configRef:$c}')" \
  $BASE/runs > /tmp/overlay-run.json &

# Bounded in both directions, like the scripted demo: give up after 240s, and stop early once the
# run has written its result — past that point the cache is legitimately gone. An unbounded `until`
# here spins forever when the dispatch writes nothing at all (wrong Host header, $BASE unset).
for _ in $(seq 1 240); do
  for p in $POOL; do
    kubectl exec -n $NS "$p" -- cat "$TOKEN_PATH" 2>/dev/null && echo "  ^ in $p" && break 2
  done
  [ -s /tmp/overlay-run.json ] && break
  sleep 1
done
# => SHIPNOTE-7F3A-SANDBOX-OK
#      ^ in sandbox-0
```

> Which pod it lands in is not fixed — the leaf leases whichever pool sandbox is free, which is why
> this loops instead of naming `sandbox-0`. A hardcoded pod here fails as "broken feature" when it
> was only a wrong guess.

> You verified this path was empty in 3a and dispatched nothing but a digest. It is there,
> `references/` and all, because the overlay put it there under `flock` and made it read-only with
> `chmod -R a-w` — which is how [ADR-0031](../adrs/0031-promoted-memory-read-only.md)'s read-only
> guarantee is enforced by the filesystem rather than by convention.

Now wait for that run to finish and look again. The same path is gone — which is the other half of the
same invariant, and the reason 3a needs no `rm`:

```bash
wait
for p in $POOL; do kubectl exec -n $NS "$p" -- test -e "$TOKEN_PATH" && echo "STILL THERE in $p"; done
# (no output — reclaimed when the leaf released its ref)
```

### 3e. Status is durable, not just a response body

```bash
curl -s -H "$HOSTHDR" "$BASE/runs/status?sessionId=demo-promoted-1" | jq -c '{status, reason}'
# => {"status":"responded","reason":null}
```

> The verdict is persisted under the session id, so a re-dispatch of the same id resumes rather than
> re-pays, and a fan-out driver can collect results after the fact. This is the existing leaf
> idempotency contract; promotion did not change it.

---

## What just happened

You moved a workflow off your laptop without writing a manifest:

1. **Authored small** — one skill, a `CLAUDE.md`, one memory file, one slash command, in a
   throwaway sandbox. Promoting it as its own user scope — `--home $SH_DEMO_SANDBOX`, which
   `/promote` passes for you — gave **1 skill, 12 KB, zero preflight findings**, against 56 skills
   and ~8.6 MB for a real `~/.claude` (Act 1, 2a).
2. **Promoted with one slash command, without leaving Claude Code** — `/promote ship-note`, in the
   same session you authored the workflow in. Content-addressed over a canonical tar, so the second
   promotion uploaded nothing and the digest was identical (Act 2a, 2c).
3. **Dispatched with one field** — `configRef` on the existing prompt envelope. No new endpoint, no
   redeploy, no image rebuild (Act 3c).
4. **Proved all three channels arrived** — the skill's format, the `CLAUDE.md` rule, and an
   incident id that exists only in your memory directory, with a bare run standing next to it as a
   control the harness keeps honest by reclaiming the shared cache with its leaf (Act 3a, 3b, 3c).
5. **Proved the sandbox half twice** — once in the model's words (a token readable only by a `read`
   executed in the separate sandbox pod, through a path the leaf translated) and once on the
   filesystem, which does not depend on the model cooperating (Act 3c, 3d).
6. **Kept the old contract** — the bare run behaved exactly as the harness always did, and
   `/runs/status` replayed the verdict (Act 3b, 3e).

To replay all of it non-interactively with every claim asserted:

```bash
make demo-promoted-workflow
```

---

## Cleanup

```bash
make demo-promoted-workflow-teardown        # removes the sandbox (needs the Act 1a marker)
pkill -f 'kubectl port-forward -n kourier-system svc/kourier'
pkill -f 'kubectl port-forward -n default svc/redis'
```

The bundle stays in Redis under a 30-day TTL. It is immutable and content-addressed, so leaving it
costs 12 KB and makes the next run of this demo skip the upload. To drop it:

```bash
kubectl exec -n $NS deploy/redis -- redis-cli DEL "config:bundle:$DIGEST"
```

---

## Notes and limits

- **Option A's authoring session is not what runs remotely.** With your real `HOME`, Claude Code
  loads your whole `~/.claude` while the promoted run gets the sandbox's one skill — so "it behaved
  the same locally" is weaker evidence than it looks. Option B closes that with
  `HOME=$SH_DEMO_SANDBOX` plus `--exclude-prompt`, at the cost of a re-auth. Say which one you ran
  if someone asks whether local matched remote.
- **A denied `Skill(/promote)` in Act 2a is harmless — keep going.** Claude Code lists user-scope
  slash commands as invocable skills, so some sessions try to "load" `/promote` through the `Skill`
  tool before doing anything. Under `dontAsk` that call is refused, because `Skill` has no allow rule.
  Nothing is lost: Claude Code has **already inlined the command body**, which is what the agent then
  follows — a real run showed the denial, shrugged, and promoted correctly. Append `Skill` to the
  launch line's `--allowedTools` to silence it (measured: `DENIED` without, `ALLOWED` with). Whether
  you see it at all depends on the session — the same command replayed non-interactively made no
  `Skill` call — and on your plugins; a `SessionStart` hook that tells the agent it must invoke a
  matching skill first makes it much more likely.
- **The `TOKEN:` line is the one model-dependent claim.** The format and the token both require the
  model to choose to `read` the skill body. `CLAUDE.md` says it MUST, and the deterministic channel
  carries that instruction, so it is reliable in practice — but it is not a mechanical guarantee the
  way `TICKET:` is. If it ever comes back `unavailable`, that is the skill being honest, not the
  overlay silently failing.
- **The shared config cache is visible to other leaves _running at the same time_, and that is worth
  saying out loud.** The digest-keyed directory in the pool sandbox is what makes reuse cheap, and the
  overlay makes it read-only — but read-only is not invisible. A leaf leasing that sandbox while
  another holds a ref can read that workflow's promoted `CLAUDE.md` and `memory/`, with or without a
  `configRef` of its own. That much is an accepted non-goal (P2 §9, one trust domain; Kata isolation
  is P3/[#48](https://github.com/rossoctl/moca/issues/48)).
  [#216](https://github.com/rossoctl/moca/issues/216) was the narrower part and is
  fixed: the cache used to outlive the leaf that made it, so a `configRef`-less leaf dispatched
  _later_ could answer from it, making spec §2 goal 6 ("absent a promoted bundle, harness behavior is
  unchanged") true in the harness process but not observably true. It is now refcounted and reclaimed
  when its last leaf releases, which is what 3a verifies and 3d shows both halves of. The accepted
  cost: a dispatch that arrives after the pool has gone idle re-transfers the bundle instead of
  finding it cached.
- **This demo does not show MCP servers or subagents.** Both are explicitly out of scope for
  promotion (spec §2, §9). Do not let a room infer that a promoted workflow carries its MCP config.
- **Memory is read-only in the promoted run.** The remote agent cannot write back what it learns;
  discoveries surface in the leaf result instead. That is deliberate
  ([ADR-0031](../adrs/0031-promoted-memory-read-only.md)) and it is what keeps leaf replay
  reproducible.
- **`promote` reads slash commands from user scope only.** A project-scope `.claude/commands/` file
  does not travel unless `HOME` points at that project — which the sandbox pattern does anyway, but
  it will surprise someone promoting a real repo.
- **Preflight blocks on facts and warns on heuristics.** The secret scan refuses the upload only on
  structural credential formats (AWS key ids, PEM blocks, GitHub/Slack/OpenAI tokens); prose-shaped
  matches warn. Do not promise that promotion cannot leak a pasted password — it can, and it warns.
  A curated sandbox like this one yields zero findings, which is the state in which blocking
  preflight would become safe to restore (spec §6 D10, §11).
- **`--dry-run` shows you the bundle without uploading it**, which is the safe way to inspect what a
  real `~/.claude` would ship before you ship it.

[spec §11]: ../specs/2026-09-02-claude-code-workflow-promotion-design.md

Reference: [`../../deploy/knative/demo-promoted-workflow.sh`](../../deploy/knative/demo-promoted-workflow.sh),
[ADR-0030](../adrs/0030-claude-code-workflow-promotion.md),
[ADR-0031](../adrs/0031-promoted-memory-read-only.md).
