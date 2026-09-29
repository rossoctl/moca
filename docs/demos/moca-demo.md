# Demo: "The agent that isn't there"

A 10-minute walkthrough that shows what a **serverless** AI agent does that a
normal always-on agent _can't_. The task — a small security review of a repo —
is just a vehicle. The real show is in your pod-watch pane: watch the agent
**cold-start from zero, drop back to zero, resume with full memory, and then
fan out into a fleet of worker pods that appear on demand and vanish when the
work drains.**

Two differentiators, two acts:

| Act                       | What a plain agent does                                | What the harness does                                                                          |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **1 — Durable resume**    | Stays resident (burning compute) or forgets on restart | Scales to **zero**, then cold-starts and **remembers** — state lives in Redis, not the process |
| **2 — Fan-out from zero** | Grinds a batch serially in one resident process        | Materializes **N worker pods on demand**, drains the queue, collapses back to **zero**         |

---

## Act 0: Install

```bash
git clone --recurse-submodules https://github.com/rossoctl/moca.git && cd moca
./deploy/knative/setup-kind.sh
```

> By default `setup-kind.sh` **pulls the published image**
> (`ghcr.io/rossoctl/moca:latest`) and loads it into the cluster — a first-time
> run needs no local Docker build (it falls back to a build only if the pull is unavailable).
> Testing local source changes? Pass `--build` to build from this checkout; `--skip-build`
> reuses an image you already loaded as `dev.local/moca:local`.
> See [`deploy/knative/README-kind.md`](../../deploy/knative/README-kind.md) for more setup options.

`setup-kind.sh` installs everything Act 1 needs (Knative + Kourier, Redis, the
sandbox pod) **and** KEDA, which Act 2's fan-out rides on.

**Set up inferencing** — a direct key or a Bearer-token gateway (e.g. LiteLLM):

```bash
export ANTHROPIC_API_KEY=sk-...
# ...or a gateway:
# export ANTHROPIC_BASE_URL=https://your-gateway
# export ANTHROPIC_AUTH_TOKEN=<token>
```

The default model is `claude-haiku-4-5` (fast, cheap — ideal for a live demo).

### Open two terminals

**T1 — the star. Watch pods appear and vanish here:**

```bash
watch -n2 'kubectl get pods'
```

**T2 — the driver. Port-forward Kourier, then set two convenience vars:**

```bash
kubectl port-forward -n kourier-system svc/kourier 8080:80
```

In a second T2 shell (leave the port-forward running):

```bash
export HOST="moca.default.example.com"
export BASE="http://localhost:8080"
```

---

# Act 1: Durable resume across a true zero

**The claim a plain agent can't make:** _I cost nothing while idle, and I still
remember everything._

### 1a. Confirm you're at zero

T1 should show no `moca-...` pod. Confirm in T2:

```bash
kubectl get pods -l serving.knative.dev/service=moca
# => No resources found  (a normal agent is a resident process — never at zero)
```

### 1b. Start a session — watch T1 cold-start a pod

Hand the agent a task-relevant fact and capture the session id:

```bash
curl -s -H "Host: $HOST" -H "Content-Type: application/json" \
  -d '{"prompt":"You are the reviewer for the acme-auth repo. Our security policy flags two code patterns: any use of eval( and any use of subprocess. Acknowledge by replying only: POLICY LOADED."}' \
  "$BASE/turn" | jq .
```

Expected:

```json
{ "sessionId": "019ed8e8-...", "response": "POLICY LOADED" }
```

```bash
export SID="<paste sessionId from above>"
```

In **T1** a `moca-...` pod flips to `Running` in under a second.

### 1c. Walk away — watch it scale to zero

Wait ~30–90s. In **T1** the pod goes `Terminating` → gone.

> **This is the moment.** You are now paying for **nothing** — no agent process,
> no held context. An always-on agent would still be resident here, billing you
> for idle time. The session itself is safe: it's an append-only log in Redis.

### 1d. Resume on the same session — new pod, same memory

With the pod at zero, ask it to recall the policy:

```bash
curl -s -H "Host: $HOST" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"prompt\":\"Which two code patterns does our security policy flag? Answer in one line.\"}" \
  "$BASE/turn" | jq .
```

Watch **T1** cold-start a **fresh** pod that answers correctly — it names
`eval(` and `subprocess`.

> A brand-new pod with no memory of its own just recalled the policy. The state
> survived the trip to zero in Redis. That's **durable resume across a cold
> start** — scale-to-zero economics _without_ amnesia.

---

# Act 2: A fleet from zero

**The claim a plain agent can't make:** _I run your batch in parallel by
conjuring workers on demand, then I disappear._

We'll review five files in the repo at once. Each file becomes an independent
**async leaf**: the harness accepts it instantly (`202`), pushes it onto a Redis
Stream, and idles back toward zero. KEDA watches the queue depth and scales
`leaf-worker` pods **0→N** to drain it.

### 2a. One-time: enable the async worker

`setup-kind.sh` installs KEDA but not the leaf ScaledJob. Apply it once:

```bash
kubectl apply -f deploy/knative/leaf-scaledjob.yaml
kubectl get scaledjob leaf-worker   # => NAME leaf-worker ... (must exist before 2d)
```

> The ScaledJob is what KEDA scales `0→N` on. If this `get` returns
> `No resources found`, 2d will accept the batch but **no `leaf-worker` pods
> ever start** and 2e polls forever — confirm it exists here first. Note a
> ScaledJob does not survive a `kind delete`/recreate, so re-apply it on a
> fresh cluster.

### 2b. Seed a small repo into the sandbox

Two files carry a flagged pattern; three are clean. (The scan reads these files
**inside the sandbox pod**, not in the agent process — brain/hands isolation.)

```bash
kubectl wait --for=condition=Ready pod/sandbox-0 --timeout=90s
export RUN="review-$(date +%s)"
export REPO="/workspace/$RUN/repo"
kubectl exec sandbox-0 -- sh -c "mkdir -p $REPO"

kubectl exec -i sandbox-0 -- sh -c "cat > $REPO/auth.py" <<'PY'
def login(raw_token):
    # legacy: evaluates the posted token expression
    return eval(raw_token)
PY

kubectl exec -i sandbox-0 -- sh -c "cat > $REPO/payments.py" <<'PY'
import subprocess
def refund(order_id):
    subprocess.run(["/usr/bin/refund", order_id])
PY

kubectl exec -i sandbox-0 -- sh -c "cat > $REPO/models.py" <<'PY'
class User:
    def __init__(self, name):
        self.name = name
PY

kubectl exec -i sandbox-0 -- sh -c "cat > $REPO/config.py" <<'PY'
SETTINGS = {"timeout": 30, "retries": 3}
PY

kubectl exec -i sandbox-0 -- sh -c "cat > $REPO/utils.py" <<'PY'
def slugify(s):
    return s.strip().lower().replace(" ", "-")
PY
```

### 2c. (Optional) narrow T1 to just the fleet

For the clearest view of the swarm, point **T1** at the workers:

```bash
watch -n2 'kubectl get pods -l scaledjob.keda.sh/name=leaf-worker'
```

### 2d. Fire the batch — watch the fleet materialize

Dispatch all five as async leaves. Each returns immediately with
`status: accepted`:

```bash
for spec in \
  "auth:auth.py:eval(" \
  "payments:payments.py:subprocess" \
  "models:models.py:eval(" \
  "config:config.py:eval(" \
  "utils:utils.py:subprocess"; do
  IFS=: read -r id file pat <<<"$spec"
  body=$(jq -nc --arg s "$RUN/$id" --arg m "claude-haiku-4-5" --arg ws "$REPO" \
                --arg id "$id" --arg f "$file" --arg p "$pat" \
          '{sessionId:$s, model:$m, workspaceRef:$ws, item:{item_id:$id, file:$f, pattern:$p}, async:true}')
  curl -s -H "Host: $HOST" -H "Content-Type: application/json" -d "$body" "$BASE/runs" \
    | jq -c "{id:\"$id\", accepted:.status}"
done
```

Expected — five instant accepts:

```
{"id":"auth","accepted":"accepted"}
{"id":"payments","accepted":"accepted"}
{"id":"models","accepted":"accepted"}
{"id":"config","accepted":"accepted"}
{"id":"utils","accepted":"accepted"}
```

> **Watch T1.** `leaf-worker-...` pods appear (up to 5; KEDA caps at 10), each
> `Running` a single leaf. On a small laptop the scheduler may run them a few at
> a time rather than all five at once — that's fine. The point is that the
> parallelism **exists only while there's work**: no batch runner was sitting
> resident waiting for it.

### 2e. Collect the verdicts

Each leaf is a full agent turn: it reads its file in the sandbox and calls a
`submit_verdict` tool with `FLAGGED` or `CLEAR`. Poll `/runs/status` for each:

```bash
for id in auth payments models config utils; do
  sid="$RUN/$id"
  for _ in $(seq 1 60); do
    resp=$(curl -s -H "Host: $HOST" "$BASE/runs/status?sessionId=$(jq -rn --arg s "$sid" '$s|@uri')")
    st=$(echo "$resp" | jq -r '.status')
    case "$st" in done|failed|aborted) break;; esac
    sleep 2
  done
  printf '%-10s %s\n' "$id" "$(echo "$resp" | jq -c '{status, verdict: .verdict.verdict, reason: .verdict.reason}')"
done
```

Expected — `auth` and `payments` flagged, the rest clear:

```
auth       {"status":"done","verdict":"FLAGGED","reason":"..."}
payments   {"status":"done","verdict":"FLAGGED","reason":"..."}
models     {"status":"done","verdict":"CLEAR","reason":"..."}
config     {"status":"done","verdict":"CLEAR","reason":"..."}
utils      {"status":"done","verdict":"CLEAR","reason":"..."}
```

### 2f. Watch it collapse back to zero

Once the queue drains, KEDA scales the workers back down. In **T1** the
`leaf-worker` pods finish and disappear — you're back to the resting footprint.

> Between turns and between batches, the only things resident are **Redis and
> the sandbox** — two pods. Everything expensive (the agent process, the worker
> fleet) exists only while a turn is actively running.

---

# What just happened

You drove an agent that:

1. **Cost nothing at rest** — scaled to a true zero between turns (Act 1c).
2. **Resumed with full memory** from a cold start, because state lives in Redis,
   not process memory (Act 1d).
3. **Fanned out into a worker fleet on demand** and collapsed back to zero when
   the work drained (Act 2d/2f).
4. **Never ran a tool in its own process** — every file read happened in the
   isolated `sandbox-0` pod (Act 2e).

That's the README's headline in action: **four dispatch modes, ~2 pods at
rest.** You've now seen two of them (sync `/turn`, async fan-out `/runs`). The
same `/runs` endpoint also does:

- **Human gates** — a leaf pauses at `awaiting_approval`, scales to zero while it
  waits, and resumes on an external approve/reject/abort. Try it:
  `GATE_LIVE_SMOKE=1 bash deploy/knative/leaf-gate-smoke.sh`
- **Scheduled dispatch** — a CronJob posts async leaves on a schedule
  (`cron-dispatch`).

To replay Act 2 non-interactively (with a crash-resume beat added), run the
automated version:

```bash
ASYNC_LIVE_SMOKE=1 bash deploy/knative/leaf-async-smoke.sh
```

---

# Cleanup

```bash
kind delete cluster --name sh-knative
```
