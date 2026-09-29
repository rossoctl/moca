# M4 Design: Knative Serverless Wrapper

Version: 1.0 — June 17, 2026
Status: Design (approved for implementation planning)
Scope: Wrap MOCA as a Knative Serving service that scales to zero,
triggered by HTTP requests carrying a user message.
Parent plan: [MOCA: Revised Plan](../../../docs/research/2026-06-10-moca-revised-plan.md) §6 M3 (Knative serverless wrapper + `user_message` trigger)
Predecessor: [M3 Design — Persistent Channel](2026-06-17-m3-persistent-channel-design.md)

---

## 1. Goal & scope

M1–M3 built the foundational pieces: Redis-backed session storage (M1), remote sandbox
execution (M2), and a persistent in-pod channel for low-latency tool ops (M3). The harness
runs headless via `cli.ts` — one prompt per process invocation.

M4 delivers the **serverless wrapper**: an HTTP server that accepts user messages, runs a
single turn via the existing harness logic, and returns the response. Deployed as a
**Knative Serving** service, it scales to zero when idle and wakes on demand — proving the
core thesis of the parent plan (§3): idle-cost economics via scale-to-zero with acceptable
interactive latency.

M4 is **done** when:

1. A `POST /turn` request to a scaled-to-zero service returns a correct assistant response
   (cold start works).
2. Session state survives the scale-to-zero gap — a resumed session recalls prior context
   from Redis alone.
3. The pod actually scales 0→1→0 (observable via `kubectl get pods`).
4. All proven on a local Kind cluster with Knative Serving installed.

### In scope

- Extract reusable `runTurn()` function from `cli.ts` into `harness/src/run-turn.ts`.
- New `@moca/knative-server` package with a minimal HTTP server (`POST /turn`, `GET /health`).
- Multi-stage Dockerfile at repo root.
- Knative Service manifest (`deploy/knative/service.yaml`).
- Kind + Knative setup script (`deploy/knative/setup-kind.sh`).
- Unit tests (HTTP layer), integration test (`runTurn` + Redis), live smoke (scale 0→1→0).

### Out of scope (later milestones)

- **Streaming / SSE** — M4 uses simple request/response. Streaming is a follow-up once the
  basic serverless loop is proven.
- **Compaction-checkpoint fast path** — the parent plan's next milestone after the wrapper.
  M4 reconstructs from the full Redis log on cold start; checkpoint optimizes this later.
- **Pod provisioning / lifecycle** — the sandbox pod is pre-provisioned out-of-band.
- **In-cluster auth** — still the developer's kubeconfig / Kubernetes service account.
- **Multi-pod sandbox topology** — single sandbox pod per session.
- **S-all (stream bash/grep over persistent channel)** — deferred optimization.

---

## 2. Key decisions

| #   | Decision          | Choice                                                                                                                                                                                           |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Response model    | **Simple request/response.** `POST /turn` blocks until the LLM turn completes, returns the full assistant message. No streaming, no fire-and-forget. Simplest proof of the serverless lifecycle. |
| D2  | Sandbox model     | **Pre-provisioned.** The sandbox pod already exists; the Knative service receives `KAGENTI_SANDBOX_POD` as an env var. Sandbox lifecycle is a separate concern.                                  |
| D3  | Deployment target | **Kind cluster + Knative Serving** (Kourier networking). Proves real scale-to-zero locally.                                                                                                      |
| D4  | Container build   | **Multi-stage Dockerfile.** Node 20 alpine, pnpm workspace install, pi-fork build chain, kubectl for sandbox exec.                                                                               |
| D5  | Package structure | **New `@moca/knative-server`** package for the HTTP server. Shared `runTurn()` extracted to `harness/src/run-turn.ts`. `cli.ts` becomes a thin wrapper.                                          |
| D6  | HTTP framework    | **Node built-in `http` module.** Zero additional deps, keeps the image small.                                                                                                                    |
| D7  | Concurrency       | **`containerConcurrency: 1`** on the Knative Service. One request per pod; Knative scales horizontally for concurrent sessions. Avoids shared-state complexity.                                  |
| D8  | Session lifecycle | **Single endpoint.** Omit `sessionId` to create a new session; include it to resume. Response always includes `sessionId` for the caller to capture.                                             |

---

## 3. Architecture & package layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Client (curl / test script)                                      │
│  POST /turn { sessionId?, prompt } ──────────────────────────►    │
└───────────────────────────────────────────┬───────────────────────┘
                                            │ HTTP (:$PORT)
┌───────────────────────────────────────────▼───────────────────────┐
│  Knative Pod (scale-to-zero)                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ @moca/knative-server  (server.ts)                              │  │
│  │   ↓ calls                                                    │  │
│  │ harness/src/run-turn.ts  (shared turn logic)                 │  │
│  │   ↓ uses                                                     │  │
│  │ @moca/session-backend  (Redis read/write)                      │  │
│  │ @moca/k8s-sandbox      (remote pod tools, if env set)          │  │
│  │ pi-fork              (session.prompt, model, etc.)            │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
         │                              │
         ▼ Redis                        ▼ kubectl exec
   ┌──────────┐                  ┌──────────────┐
   │ Redis    │                  │ Sandbox Pod  │
   │ (session │                  │ (pre-provis.)│
   │  log)    │                  └──────────────┘
   └──────────┘
```

### File layout

```
moca/
  harness/
    src/
      cli.ts               # edit — thin wrapper calling runTurn()
      run-turn.ts          # NEW — extracted reusable turn logic
      flush-extension.ts   # unchanged
      buffered-redis-backend.ts  # unchanged (imported by run-turn)
    test/
      run-turn.test.ts     # NEW — integration test (runTurn + Redis)
      integration.test.ts  # unchanged
      buffered-redis-backend.test.ts  # unchanged
  packages/
    knative-server/
      package.json         # NEW
      src/
        server.ts          # NEW — HTTP server
        index.ts           # NEW — export for programmatic use
      test/
        server.test.ts     # NEW — unit tests (mocked runTurn)
    session-backend/       # unchanged
    k8s-sandbox/           # unchanged
  deploy/
    knative/
      service.yaml         # NEW — Knative Service manifest
      setup-kind.sh        # NEW — install Knative + Redis + deploy
      smoke.sh             # NEW — live smoke test script
  Dockerfile               # NEW — multi-stage build
  pi-fork/                 # unchanged (submodule)
```

---

## 4. The `runTurn()` function (`harness/src/run-turn.ts`)

Extracted from `cli.ts`, this is the reusable core:

```ts
export interface TurnConfig {
  redisUrl?: string; // default: "redis://localhost:6379"
  cwd?: string; // default: process.cwd()
  anthropicBaseUrl?: string; // gateway bridge (optional)
  anthropicAuthToken?: string; // gateway bridge (optional)
}

export interface TurnResult {
  sessionId: string;
  response: string; // assistant's final text content
  stopReason: string; // "end_turn" | "error" | "aborted" | ...
  errorMessage?: string; // present when stopReason is "error"
}

export async function runTurn(
  prompt: string,
  sessionId: string | undefined,
  config?: TurnConfig,
): Promise<TurnResult>;
```

Internals (same logic as current `cli.ts`):

1. Create `RedisSessionBackend` + `BufferedRedisBackend`.
2. `SessionManager.openFromBackend(sessionId)` if resuming, else `SessionManager.create()`.
3. Wire `DefaultResourceLoader` with `flushExtension` + `k8sSandboxExtension`.
4. Configure model (gateway bridge if env vars set).
5. `createAgentSession()` → `session.prompt(prompt)`.
6. Extract response from `session.state.messages`.
7. `backend.flush()` (belt-and-suspenders).
8. Return `{ sessionId, response, stopReason }`.

`cli.ts` becomes:

```ts
const result = await runTurn(process.argv[2]!, process.env.PI_SESSION_ID, {
  redisUrl: process.env.REDIS_URL,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
});
console.log(result.response);
console.log(`SESSION_ID=${result.sessionId}`);
```

---

## 5. HTTP server (`packages/knative-server/src/server.ts`)

Minimal Node `http` — no framework:

```ts
import { createServer } from 'node:http';
import { runTurn } from '@moca/harness/run-turn';

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/turn') {
    const body = await readBody(req);
    const { sessionId, prompt } = JSON.parse(body);

    if (!prompt) {
      res.writeHead(400, headers).end(JSON.stringify({ error: 'prompt_required' }));
      return;
    }

    try {
      const result = await runTurn(prompt, sessionId, {
        redisUrl: process.env.REDIS_URL,
        anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
        anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
      });
      res.writeHead(200, headers).end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('not_found') ? 404 : 500;
      res.writeHead(status, headers).end(
        JSON.stringify({
          error: message,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    }
    return;
  }

  res.writeHead(404).end();
});

// Graceful shutdown (Knative sends SIGTERM before killing)
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

server.listen(PORT);
```

---

## 6. Dockerfile

```dockerfile
# Stage 1: install + build
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY pi-fork/ ./pi-fork/
COPY packages/ ./packages/
COPY harness/ ./harness/
RUN pnpm install --frozen-lockfile
# Pi-fork requires ordered build (M1 gotcha)
RUN pnpm -C pi-fork/packages/ai build && \
    pnpm -C pi-fork/packages/agent build && \
    pnpm -C pi-fork/packages/tui build && \
    pnpm -C pi-fork/packages/coding-agent build

# Stage 2: slim runtime
FROM node:20-alpine
RUN apk add --no-cache kubectl
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--import", "tsx", "packages/knative-server/src/server.ts"]
```

Notes:

- `kubectl` in the runtime image for `@moca/k8s-sandbox` pod exec.
- Source-only packages (`harness/`, `packages/`) run via `tsx` (no compile step needed).
- Pi-fork is pre-built in stage 1 (ships compiled JS).
- Image size ~200MB (node:20-alpine + kubectl binary).

---

## 7. Knative manifests

### `deploy/knative/service.yaml`

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: moca
  namespace: default
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: '0'
        autoscaling.knative.dev/max-scale: '5'
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: '30s'
    spec:
      containerConcurrency: 1
      timeoutSeconds: 300
      containers:
        - image: moca:local
          ports:
            - containerPort: 8080
          env:
            - name: REDIS_URL
              value: 'redis://redis.default.svc:6379'
            - name: KAGENTI_SANDBOX_POD
              value: 'sandbox-0'
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llm-credentials
                  key: api-key
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          resources:
            requests:
              memory: '256Mi'
              cpu: '100m'
            limits:
              memory: '512Mi'
              cpu: '500m'
```

### `deploy/knative/setup-kind.sh`

The setup script performs:

1. Install Knative Serving CRDs + core (v1.14 or latest stable).
2. Install Kourier as the networking layer (lightest for local Kind).
3. Configure Knative to use Kourier (`config-network` ConfigMap).
4. Deploy Redis (single-pod Deployment + Service, port 6379).
5. Deploy the sandbox pod (alpine + ripgrep, same as M3's `deploy/sandbox.yaml`).
6. Build the harness Docker image locally.
7. Load image into kind (`kind load docker-image moca:local`).
8. Create `llm-credentials` Secret from `$ANTHROPIC_API_KEY` env var.
9. Apply `service.yaml`.
10. Wait for Knative Service to become Ready.
11. Print access instructions (port-forward or Kourier ingress).

---

## 8. Session lifecycle

```
Client                          Knative                    Redis
  │                                │                         │
  │ POST /turn {prompt:"Hello"}    │                         │
  │──────────────────────────────►│ (scale 0→1)             │
  │                                │── create session ──────►│
  │                                │── session.prompt() ────►│ (LLM call)
  │                                │── flush() ────────────►│
  │ 200 {sessionId:"abc", resp}    │                         │
  │◄──────────────────────────────│                         │
  │                                │                         │
  │        ... idle timeout ...    │ (scale 1→0)             │
  │                                │                         │
  │ POST /turn {sessionId:"abc",   │                         │
  │             prompt:"Recall?"}  │                         │
  │──────────────────────────────►│ (scale 0→1, fresh pod)  │
  │                                │── resume from Redis ───►│
  │                                │── session.prompt() ────►│
  │                                │── flush() ────────────►│
  │ 200 {sessionId:"abc", resp}    │                         │
  │◄──────────────────────────────│                         │
```

Error responses:

| Condition                      | HTTP status | Body                                            |
| ------------------------------ | ----------- | ----------------------------------------------- |
| Missing `prompt`               | 400         | `{ "error": "prompt_required" }`                |
| `sessionId` not found in Redis | 404         | `{ "error": "session_not_found" }`              |
| LLM / turn failure             | 500         | `{ "error": "<message>", "sessionId": "<id>" }` |
| Invalid JSON body              | 400         | `{ "error": "invalid_json" }`                   |

---

## 9. Verification gate

### Unit tests (`packages/knative-server/test/server.test.ts`)

Mock `runTurn()` and test the HTTP layer in isolation:

- POST /turn with valid prompt → 200, JSON body with sessionId + response
- POST /turn without prompt → 400
- POST /turn where runTurn throws "not_found" → 404
- POST /turn where runTurn throws generic error → 500
- GET /health → 200 "ok"
- Unknown route → 404
- Invalid JSON → 400
- SIGTERM → graceful shutdown (server closes, in-flight completes)

### Integration test (`harness/test/run-turn.test.ts`)

Test `runTurn()` with a real Redis (extends existing integration pattern):

- New session: call with no sessionId → returns a valid sessionId + response
- Resume session: call again with the returned sessionId → context preserved
- Invalid sessionId → throws with "not_found" in message
- Verify Redis contains session entries after the turn

### Live smoke (`deploy/knative/smoke.sh`)

Proves the full serverless lifecycle on Kind:

1. **Turn 1** — curl `POST /turn { prompt: "Remember the number 7777" }` → assert 200, capture sessionId.
2. **Verify scale-down** — wait for idle timeout (30s + buffer), assert 0 running pods for the revision.
3. **Turn 2 (cold start)** — curl `POST /turn { sessionId, prompt: "What number did I ask you to remember?" }` → assert response contains "7777".
4. **Verify scale-up** — confirm pod count went 0→1 between steps 2 and 3.
5. **Sandbox check** (if KAGENTI_SANDBOX_POD deployed) — curl `POST /turn { sessionId, prompt: "List files in /tmp" }` → assert tool execution happened (response references file listing).

**Success criteria:**

- Steps 1–4 all pass (the serverless thesis holds).
- All existing test suites remain green (harness, session-backend, k8s-sandbox).

---

## 10. Residual risks

| Risk                                                                         | Impact                      | Mitigation                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cold-start latency too high (Knative + Node startup + Redis read + LLM call) | Poor interactive UX         | M4 measures but does not optimize — compaction-checkpoint (M5) addresses this. Acceptable for PoC.                                |
| Knative idle timeout too aggressive (kills pod mid-LLM-call)                 | Dropped request             | `timeoutSeconds: 300` on the Knative revision gives LLM calls up to 5 minutes.                                                    |
| kubectl in-container cannot reach sandbox pod (RBAC)                         | Sandbox tools fail          | Setup script creates a ServiceAccount with pod exec permissions; fallback: run without sandbox (tools are inert without env var). |
| Pi-fork build fragility (build order, version drift)                         | Dockerfile breaks           | Pinned pi-fork commit (submodule); explicit ordered build; CI will catch drift.                                                   |
| Redis not reachable from Knative pod (DNS/network)                           | Session create/resume fails | Redis deployed in same namespace; smoke test validates connectivity end-to-end.                                                   |
| `containerConcurrency: 1` limits throughput                                  | Slow under load             | Acceptable for PoC; `max-scale: 5` allows 5 concurrent sessions. Production tuning is out of scope.                               |

---

## 11. Relationship to the parent plan

This is the parent plan's **Milestone 3** (§6): "Knative serverless wrapper + `user_message`
trigger." It validates the core serverless thesis — that the harness is a stateless pure
function `(session_log, user_message) → (new_entries, response)` that can scale to zero
between turns with no state loss.

The parent plan's M4 (compaction-checkpoint) becomes the natural follow-up: once M4 proves
scale-to-zero works, M5 optimizes the cold-start path so it stays fast at scale.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
