# Demo: "The sandbox that isn't in your cluster"

A ~10-minute walkthrough of **SandboxTransport**: the harness dispatches a leaf's tool calls to a
sandbox running as a plain `docker run` **on your laptop** — outside the cluster, with **zero
inbound rules**, holding no cluster credential.

The task — read a file and say what it contains — is just a vehicle. The real show is _which
machine's filesystem answers_. You will send the same free-form prompt twice and watch the model
name a different OS each time, then plant a secret in a container by hand and watch the cluster
read it back.

```
laptop
|- kind cluster:  Knative + Redis + harness (ksvc) + sandbox-relay
|                     ^                                    ^
|                     | harness -> relay                   | worker -> relay
|                     | sandbox-relay.default.svc:8443     | host.docker.internal:8443
\- docker run:    remote-worker  --------- dials out ------/
```

Neither address is inbound to the laptop.

| Act                             | What a normal remote sandbox needs                                       | What SandboxTransport needs                                                                        |
| ------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **1 — Inverted connectivity**   | An inbound port, a firewall rule, a public address the cluster can reach | **Nothing.** The worker dials _out_ and parks a stream. `docker run` with no `-p` at all           |
| **2 — Provable placement**      | Trust that the config routed where you think                             | A **fingerprint** and a **structural guard** — a green run on the wrong backend is made impossible |
| **3 — Zero standing authority** | A kubeconfig, or an agent with cluster reach                             | One bearer token. No LLM key, no kubeconfig, no orchestration                                      |

Prefer it non-interactive? `make demo-remote-sandbox` does all of this in one command and asserts
every step. This document is the version you drive by hand so you can explain each move.

---

## Act 0: Install

You need a **warm** harness cluster — this demo adds the remote path to it, it does not build it.
If you do not have one:

```bash
git clone --recurse-submodules https://github.com/rossoctl/moca.git
cd moca

export ANTHROPIC_API_KEY=sk-...    # ...or a gateway: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN

./deploy/knative/setup-kind.sh
```

> The model must be reachable **from the cluster** — the leaf's answer is a real model call.
> See [`../../deploy/knative/README-kind.md`](../../deploy/knative/README-kind.md) for setup
> options and [`../../deploy/knative/README-worker.md`](../../deploy/knative/README-worker.md)
> for the worker/relay reference.

Set the convenience vars used throughout:

```bash
export NS=default KSVC=moca
export HOSTHDR='Host: moca.default.example.com'
export BASE=http://localhost:8080
mkdir -p /tmp/demo-remote
```

### Check nothing else holds :8080

A leftover port-forward pointing at a **different** cluster will silently take your dispatches,
while your `kubectl` assertions run against this one:

```bash
pgrep -fl 'kubectl port-forward'   # expect empty
```

### Open two terminals

**T1 — the star. Watch the presence record appear and vanish here:**

```bash
while sleep 2; do kubectl exec deploy/redis -n default -- redis-cli HGETALL sh:sandbox:records; echo ---; done
```

**T2 — the driver. Port-forward Kourier:**

```bash
kubectl port-forward -n kourier-system svc/kourier 8080:80
```

In a second T2 shell (leave the port-forward running), confirm the harness answers:

```bash
curl -s -o /dev/null -w 'harness HTTP %{http_code}\n' --max-time 5 -H "$HOSTHDR" $BASE/
# => harness HTTP 404
```

> **`404` is success.** This is a transport check, not a health check: any response proves the
> tunnel and Host header reach the harness. Skipping it is a trap — an empty `/runs` reply later
> is indistinguishable from an unreachable _model_, and the two have completely different fixes.

### Build the worker image

```bash
docker build --load -f remote-worker/Dockerfile -t dev.local/remote-worker:demo .
```

> **No local Go toolchain** — the Dockerfile builds the binary in a `golang:1.25-alpine` builder
> stage. And this image is **never** `kind load`ed: it runs on the host, so its architecture need
> not match the kind node. That caveat only ever applied to the in-cluster worker pod.

---

# Act 1: A sandbox with no inbound route

**The claim a normal remote sandbox can't make:** _nothing can reach me, and I am still serving
your cluster's tool calls._

### 1a. Bring up the relay

```bash
kubectl apply -f deploy/knative/relay-deployment.yaml
kubectl -n $NS rollout status deploy/sandbox-relay --timeout=90s
```

> The relay is the only thing the worker will dial. It is **inert** until both a worker attaches
> _and_ the harness is switched to the remote path — so nothing is routed anywhere yet.

### 1b. Generate the registration token

```bash
TOKEN=$(openssl rand -hex 16); echo "TOKEN=$TOKEN"
kubectl set env deploy/sandbox-relay -n $NS "SH_RELAY_TOKEN=$TOKEN"
kubectl -n $NS rollout status deploy/sandbox-relay --timeout=90s
```

> Relay auth is **fail-closed**: a token mismatch rejects the Attach before the stream is ever
> parked. We mint a fresh token per run rather than using `relay-deployment.yaml`'s `dev-token`,
> because that value is a repo constant and therefore public. Patch _before_ waiting on the
> rollout, so the pod that becomes Ready is already the one holding this token.

> **Kind only.** This demo applies `relay-deployment.yaml` directly, so `set env` is the right
> tool here. On an OCP overlay deployment the relay reads `SH_RELAY_TOKEN` from the
> `sh-relay-token` Secret instead, and `set env` would replace that `secretKeyRef` with a
> literal — putting the token back into the Deployment spec, which is what #173 removed. There,
> rotate the Secret and `oc rollout restart deploy/sandbox-relay`.

### 1c. Open the tunnel — and prove the relay is really serving

```bash
kubectl port-forward -n $NS svc/sandbox-relay 8443:8443 >/tmp/demo-remote/relay-pf.log 2>&1 &
sleep 5
(exec 3<>/dev/tcp/127.0.0.1/8443) 2>/dev/null && echo "connect OK" || echo "connect FAILED"
sleep 1
grep -qE 'error forwarding|connection refused|lost connection' /tmp/demo-remote/relay-pf.log \
  && echo "RELAY DEAD" || echo "relay is serving"
```

> **A bare TCP connect is not enough.** `kubectl port-forward` accepts your local connection
> first and only _then_ tries the pod, so a dead relay still gives you a successful connect.
> Reading the forward log is what separates "the relay is dead" from "a container can't route
> here" — two failures with completely different fixes. The relay also needs ~4s after `Running`
> to bind, because `node --import tsx` compiles its TypeScript at startup; probing immediately is
> a race that looks exactly like breakage.

### 1d. Register the sandbox — `docker run`, no ports

```bash
docker run -d --name sh-demo-remote-worker \
  -e SANDBOX_ID=sbx-laptop-demo \
  -e RELAY_ADDR=host.docker.internal:8443 \
  -e SANDBOX_TOKEN="$TOKEN" \
  dev.local/remote-worker:demo

docker port sh-demo-remote-worker      # prints NOTHING
```

> **This is the headline.** No `-p`, no `--publish`, no inbound rule, no firewall change. The
> worker dials **out** through the tunnel and parks a stream. Show what it was handed:

```bash
docker inspect sh-demo-remote-worker --format '{{range .Config.Env}}{{println .}}{{end}}'
```

> A bearer token, a sandbox id, a relay address. **No LLM key, no kubeconfig, no
> orchestration.** If this container is stolen, the attacker gets a scoped token to one relay.

### 1e. Registration _is_ the live stream

**Look at T1** — the record just appeared:

```
sbx-laptop-demo
{"sandboxId":"sbx-laptop-demo","labels":{},"capabilities":["bash","base64","file"],"capacityMax":4,"transport":"grpc"}
```

> Nothing polled. Nothing heartbeated a URL. Redis holds this record **only while the Attach
> stream is open** — the registration _is_ the stream. `"transport":"grpc"` is how the harness
> knows to route over the relay instead of `kubectl exec`. We come back to T1 in Act 3.

---

# Act 2: Prove which machine ran the command

**The claim a config change can't make on its own:** _the exec provably ran there, not here._

### 2a. Establish the discriminator first

```bash
kubectl exec sandbox-0 -n $NS -- grep '^PRETTY_NAME' /etc/os-release
docker exec sh-demo-remote-worker grep '^PRETTY_NAME' /etc/os-release
```

```
PRETTY_NAME="Alpine Linux v3.20"                    <- in-cluster pool
PRETTY_NAME="Red Hat Enterprise Linux 9.8 (Plow)"   <- remote host container
```

> The pool is Alpine, the worker is RHEL. So one free-form question — _what does
> `/etc/os-release` say?_ — gets a different answer depending on which machine ran it, and the
> model **names the OS it read** rather than handing you a flag you have to trust. Verify the
> fingerprint _before_ anything relies on it; an unverified discriminator makes every later
> assertion meaningless.

Set the prompt you will send unchanged to both backends:

```bash
OS_PROMPT='Using your read tool, read the file /etc/os-release and tell me in one sentence exactly which OS distribution and version it reports.'
```

> **"read tool" and the absolute path are load-bearing.** The agent's tools execute in the
> sandbox, so a relative path would be resolved against the harness process cwd instead — the
> same reason `buildLeafPrompt` in
> [`harness/src/run-leaf.ts`](../../harness/src/run-leaf.ts) spells out an absolute path for the
> review path.

### 2b. Run A — the in-cluster pod

```bash
BODY=$(jq -nc --arg p "$OS_PROMPT" '{sessionId:"demo-pod-1", model:"claude-haiku-4-5",
                kind:"prompt", prompt:$p}')
curl -s --max-time 120 -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$BODY" $BASE/runs | jq -r '.status, .text'
```

```
responded
The file /etc/os-release reports Alpine Linux v3.20.
```

> Baseline. This ran on an in-cluster pod via `kubectl exec`. Nothing remote yet — the relay and
> worker are up but the harness has not been told to use them.
>
> `kind:"prompt"` is what makes this a free-form leaf: the reply comes back as `.text`, the
> model's own words, with `status: "responded"`. No verdict schema, no `submit_verdict` tool —
> which is why the answer can _name_ what it read.

### 2c. Flip to the remote path — and make a pod win _impossible_

Snapshot the env first. **Look at what has to survive the flip:**

```bash
kubectl get ksvc $KSVC -n $NS -o json \
  | jq -c '.spec.template.spec.containers[0].env' > /tmp/demo-remote/env-snapshot.json
jq -r '.[] | "\(.name)  \(if .valueFrom then "<secretKeyRef>" else "="+(.value|tostring) end)"' \
  /tmp/demo-remote/env-snapshot.json
```

```
ANTHROPIC_API_KEY     <secretKeyRef>
ANTHROPIC_BASE_URL    <secretKeyRef>
ANTHROPIC_AUTH_TOKEN  <secretKeyRef>
```

Now upsert the three remote-path vars **by name**, preserving everything else:

```bash
NEWENV=$(jq -c '
  map(select(.name | IN("SH_REMOTE_SANDBOX","SH_RELAY_ADDR","KAGENTI_SANDBOX_POOL_SELECTOR") | not))
  + [{name:"SH_REMOTE_SANDBOX",value:"1"},
     {name:"SH_RELAY_ADDR",value:"sandbox-relay.default.svc:8443"},
     {name:"KAGENTI_SANDBOX_POOL_SELECTOR",value:"sh.kagenti.io/sandbox-pool=demo-remote-only"}]
' /tmp/demo-remote/env-snapshot.json)

kubectl patch ksvc $KSVC -n $NS --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env\",\"value\":$NEWENV}]"
```

**The structural guard — the most important line in the demo:**

```bash
kubectl get pods -n $NS -l sh.kagenti.io/sandbox-pool=demo-remote-only \
  --field-selector=status.phase=Running --no-headers | grep -c .
# => 0
```

> **Say this carefully.** `SH_REMOTE_SANDBOX=1` _alone does not route to the worker._
> `select-sandbox.ts` builds `candidates = [...pods, ...grpcRecs]` and leases least-loaded-first,
> so an idle in-cluster pod can still win the lease — and you would get a green demo that proved
> nothing. Pointing the selector at a label **no pod carries** means a pod cannot win a lease it
> is not a candidate for. Structural, not merely detected.

> **This is also why the demo needs a harness new enough to lease on the prompt path.** Until the
> [ADR-0028 amendment](../adrs/0028-async-prompt-dispatch.md#amendment-2026-09-01-prompt-leaves-lease-a-pool-sandbox)
> a `kind:"prompt"` leaf never took a lease at all: it resolved its own sandbox from the
> environment, ignored `SH_REMOTE_SANDBOX`, and on a pool-only deployment like this one ran its
> tool calls **in the harness container** — which is itself Alpine, so Act 2b would have looked
> exactly this green while proving nothing whatsoever. If your reply below names Alpine on both
> backends, that is the first thing to check.

Wait for the new revision — a `spec.template` change mints one:

```bash
for i in $(seq 1 40); do
  C=$(kubectl get ksvc $KSVC -n $NS -o jsonpath='{.status.latestCreatedRevisionName}')
  R=$(kubectl get ksvc $KSVC -n $NS -o jsonpath='{.status.latestReadyRevisionName}')
  [ -n "$C" ] && [ "$C" = "$R" ] && { echo "ready: $R"; break; }; sleep 3
done
```

### 2d. Why that wasn't just `kubectl set env`

Worth explaining if anyone asks — the patch above is an **upsert-by-name** computed client-side,
then written back in one atomic operation. Two halves:

**The jq half — delete, then append:**

```
map(select(.name | IN("A","B","C") | not))   # keep everything NOT named A, B, or C
+ [ {A}, {B}, {C} ]                          # append the three you want
```

`IN(...)` is jq's set-membership test and `| not` inverts it, so the `map(select(...))` **drops**
any existing entry with one of those names and the `+` appends fresh ones. The delete step is what
makes it an upsert rather than a blind append: `KAGENTI_SANDBOX_POOL_SELECTOR` **already exists**
with `…pool=default`. Watch it leave the middle of the array and return at the end with the new
value — append without the filter and you get two entries of the same name, which is invalid:

```
BEFORE (8)                          AFTER (10)
0: HOME                             0: HOME
1: REDIS_URL                        1: REDIS_URL
2: SH_MODEL                         2: SH_MODEL
3: KAGENTI_SANDBOX_POOL_SELECTOR    3: LEAF_RESULT_TTL_SECONDS
4: LEAF_RESULT_TTL_SECONDS          4: ANTHROPIC_API_KEY      <secretKeyRef>
5: ANTHROPIC_API_KEY      <ref>     5: ANTHROPIC_BASE_URL     <secretKeyRef>
6: ANTHROPIC_BASE_URL     <ref>     6: ANTHROPIC_AUTH_TOKEN   <secretKeyRef>
7: ANTHROPIC_AUTH_TOKEN   <ref>     7: SH_REMOTE_SANDBOX                <- new
                                    8: SH_RELAY_ADDR                    <- new
                                    9: KAGENTI_SANDBOX_POOL_SELECTOR    <- re-added, new value
```

**The property that matters:** untouched entries are passed through as **whole objects**, never
reconstructed — which is what preserves those three `secretKeyRef`s. `kubectl set env` does not
work on a Knative `Service` at all (_"no kind Service is registered"_), and anything that rebuilds
the array from name/value pairs flattens `valueFrom` to an empty string. The model call then fails
looking exactly like an unreachable endpoint. Order shifts, which is harmless: Kubernetes only
cares about env ordering for `$(VAR)` interpolation, which this env does not use.

**The kubectl half — replace the whole array.** JSON Patch has no "upsert by name": array ops
address elements by _index_, and indices shift as you add and remove. Computing the final array in
jq and replacing `/spec/template/spec/containers/0/env` once sidesteps that arithmetic and lands
atomically. `containers/0` is the first (user) container in the revision template.

**And what the three values do:**

| Var                                                    | Effect                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `SH_REMOTE_SANDBOX=1`                                  | enables the remote-sandbox code path at all                                                         |
| `SH_RELAY_ADDR=sandbox-relay.default.svc:8443`         | where the _harness_ dials the relay — in-cluster DNS, the other end of the worker's outbound tunnel |
| `KAGENTI_SANDBOX_POOL_SELECTOR=…pool=demo-remote-only` | a label no pod carries, so the pod candidate set is empty                                           |

The third is the load-bearing one for the demo's honesty. The first two alone would leave idle
Alpine pods in the candidate set, and least-loaded-first could hand the exec to one.

### 2e. Run B — the same prompt, a different machine

Byte-for-byte the request from 2b, with only the session id changed:

```bash
BODY=$(jq -nc --arg p "$OS_PROMPT" '{sessionId:"demo-remote-1", model:"claude-haiku-4-5",
                kind:"prompt", prompt:$p}')
REPLY=$(curl -s --max-time 120 -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$BODY" $BASE/runs | jq -r '.text')
echo "$REPLY"
```

```
The file /etc/os-release reports Red Hat Enterprise Linux 9.8 (Plow).
```

> Same prompt as 2b, **different OS named.** Now check it in both directions — the reply must say
> `Red Hat` **and** must not say `Alpine`. Assert against the reply you already captured; a second
> `curl` with the same `sessionId` would _resume_ that session rather than ask afresh:

```bash
grep -qi 'red hat' <<<"$REPLY" && echo "ok: named Red Hat"  || echo "FAIL: did not name Red Hat"
grep -qi 'alpine'  <<<"$REPLY" && echo "FAIL: named Alpine" || echo "ok: did not name Alpine"
```

> Both directions on purpose: a free-form reply has no flag to flip, so "it landed on an Alpine
> pod" is ruled out by asserting the OS it must _not_ have read is absent too. This is the one
> place the free-form version is weaker than a `CLEAR`/`FLAGGED` verdict — a reply that mentions
> neither OS fails the first check rather than being caught as nonsense. Act 3 is what closes
> that gap, and it is the stronger proof anyway.

---

# Act 3: The closer — plant a secret, watch the cluster read it back

**The claim that ends the argument:** _you created this evidence thirty seconds ago, on this
laptop, and the cluster just read it._

### 3a. Write a marker only your laptop has

```bash
MARK="tuscan-lentils-$RANDOM"; echo "$MARK"
docker exec sh-demo-remote-worker sh -c "echo 'secret marker: $MARK' > /tmp/proof.txt"

kubectl exec sandbox-0 -n $NS -- cat /tmp/proof.txt
# => cat: /tmp/proof.txt: No such file or directory
```

> The file exists **only** in the container on your laptop. The in-cluster pool has never seen it.

### 3b. Ask the cluster for it

```bash
BODY=$(jq -nc '{sessionId:"demo-proof-1", model:"claude-haiku-4-5", kind:"prompt",
        prompt:"Using your read tool, read the file /tmp/proof.txt and tell me exactly what marker string it contains."}')
PROOF=$(curl -s --max-time 120 -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$BODY" $BASE/runs | jq -r '.text')
echo "$PROOF"
```

```
The file /tmp/proof.txt contains the marker string: tuscan-lentils-29765
```

> **Note what the free-form reply buys you here.** It does not confirm a string you already
> supplied — it _reads one back to you_. Check it against the `$MARK` you printed thirty seconds
> ago:

```bash
grep -qF "$MARK" <<<"$PROOF" \
  && echo "ok: the cluster read the marker planted on this laptop" || echo "FAIL"
```

> There is no `kubectl exec` anywhere in that path, no inbound route to this machine, and the
> worker holds no cluster credential — only a token it used to dial _out_. An answer about
> `/etc/os-release` can be argued with — image drift, a lucky guess from context. A random string
> you generated yourself, echoed back verbatim, cannot be.

### 3c. Presence vanishes with the stream

```bash
docker stop sh-demo-remote-worker
```

**Watch T1.** The record clears on its own:

> Nothing deleted it. The Attach stream closed and the record went with it. That is what
> "registration _is_ the live stream" means — and why the harness never routes to a sandbox that
> has quietly gone away.

> `make demo-remote-sandbox` asserts this act too — the planted marker _and_ this teardown. The
> one exception is `--keep`, which promises the worker is still running when the run ends: proving
> the record clears means closing the stream, so the script skips this step and tells you to do it
> by hand instead.

---

# What just happened

You drove a sandbox that:

1. **Had no inbound route** — `docker run` with no `-p`, no firewall rule, reachable by nothing
   (Act 1d).
2. **Registered by existing** — its presence record _was_ its open stream, and vanished with it
   (Act 1e, 3c).
3. **Provably ran the exec** — same prompt, and the model named a different OS each time, with a
   pool selector that made a pod win structurally impossible (Act 2).
4. **Held no standing authority** — one scoped bearer token; no LLM key, no kubeconfig (Act 1d).
5. **Read back a secret you planted by hand**, which the cluster had no other way to see, in the
   model's own words rather than as a yes/no on a string you supplied (Act 3b).

That is the SandboxTransport headline: the sandbox is a **pool peer**, not a replacement — the
same contract as an in-cluster pod, on a machine the cluster cannot reach.

To replay all of it non-interactively with every step asserted:

```bash
make demo-remote-sandbox DEMO_ARGS=--reuse-cluster
```

---

# Cleanup

**Restore the harness env first — this one is non-negotiable.** A harness left pointed at a
selector matching nothing breaks every later run on the cluster:

```bash
SNAP=$(cat /tmp/demo-remote/env-snapshot.json)
kubectl patch ksvc $KSVC -n $NS --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env\",\"value\":$SNAP}]"
```

Then the rest:

```bash
docker rm -f sh-demo-remote-worker
kubectl delete -f deploy/knative/relay-deployment.yaml --ignore-not-found
pkill -f 'kubectl port-forward -n default svc/sandbox-relay'
pkill -f 'kubectl port-forward -n kourier-system svc/kourier'
```

Or let the script do all of it, including the built image:

```bash
make demo-remote-sandbox-teardown   # asks before deleting the cluster; DEMO_ARGS=--yes skips the prompt
```

---

# Notes and limits

- **`docker logs sh-demo-remote-worker` does not show individual execs.** It logs the attach and
  then only anomalies — dedup, req-id reuse, dropped terminal frames. Do not promise a live exec
  log; Act 3 is the stronger proof anyway.
- **On native Linux Docker** the relay tunnel may need `--address 0.0.0.0` plus
  `--add-host=host.docker.internal:host-gateway` on the worker, because `host.docker.internal`
  resolves to the bridge IP rather than host loopback. That makes the relay port briefly
  LAN-visible — which is exactly why Act 1b mints a fresh token instead of using the repo's public
  `dev-token`. macOS and Docker Desktop take the clean loopback path. `demo-remote-worker.sh`
  probes for this and escalates automatically, with a warning.
- **Live streaming, abort mid-stream, dual-ended timeout and reconnect→dedup** are implemented and
  unit-tested but not shown here — tracked in
  [#198](https://github.com/rossoctl/moca/issues/198). The honest line: _the
  transport does it, this demo doesn't show it yet._

Reference: [`../../deploy/knative/README-worker.md`](../../deploy/knative/README-worker.md)
§"Laptop demo" and [`../../deploy/knative/demo-remote-worker.sh`](../../deploy/knative/demo-remote-worker.sh).
