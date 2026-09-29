# M2 Design: K8sSandboxClient (Operations → pod)

Version: 1.0 — June 17, 2026
Status: Design (approved for implementation planning)
Scope: Milestone 2 of MOCA — route Pi tool execution to a remote Kubernetes pod
Parent plan: [MOCA: Revised Plan](../../../docs/research/2026-06-10-moca-revised-plan.md) §4, §6 (M2), §7.3
Predecessor: [M1 Design — Redis SessionStorageBackend](2026-06-16-m1-redis-session-backend-design.md)

---

## 1. Goal & scope

Route Pi's tool execution — the agent's "hands" — to a **remote Kubernetes pod**
instead of the harness head, using Pi's native pluggable `Operations` interfaces.

The parent plan's feasibility table records this as **native, no fork**: Pi exposes
`ReadOperations` / `WriteOperations` / `EditOperations` / `BashOperations` (+ `Ls` /
`Grep` / `Find`), every `create*Tool(cwd, { operations })` factory accepts an override,
and the shipped SSH example (`packages/coding-agent/examples/extensions/ssh.ts`)
demonstrates the exact delegation pattern. M2 swaps the transport (`ssh user@host` →
`kubectl exec` into a pod) and the wiring (SSH uses CLI flags + `session_start`; the
headless `cli.ts` uses `extensionFactories` + env, no flags).

M2 is **done** when an agent turn driven through the headless `cli.ts` reads, writes,
and execs **in the pod** — proven by deterministic fake-exec unit tests for all seven
operations plus one real `kubectl exec` smoke on a kind cluster.

### In scope

- A standalone `@moca/k8s-sandbox` package: an injectable `execInPod` transport seam,
  seven Operations factories, and a Pi extension that registers/wraps the tools.
- Env-gated wiring into `harness/cli.ts` (inert unless sandbox env is set).
- A checked-in plain `Deployment + PVC` manifest used as the smoke/experiment fixture.
- **Full seven-operation routing** — read/write/edit/bash **and** ls/grep/find run in
  the pod, so every filesystem view the model sees is the pod's, not the head's.

### Out of scope (later milestones / tracks)

- Pod **provisioning / lifecycle** (create-on-demand, teardown) — deferred sandbox track;
  M2 targets an already-running pod.
- Sandbox **snapshot/restore** (gVisor / CRIU / microVM) — separate parallel track (§9).
- Knative serverless wrapper + `user_message` trigger (M3).
- Compaction-checkpoint write path (M4).
- **In-cluster auth** (ServiceAccount / in-pod exec via the K8s API) — M2 uses the
  developer's local `kubectl` + kubeconfig; in-cluster auth is an M3 concern.

---

## 2. Key decisions (resolved during brainstorming)

| #   | Decision                | Choice                                                                                                                                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Transport to the pod    | **`kubectl exec` shell-out**, behind an injectable `execInPod` seam. Zero new runtime deps; a near-verbatim port of the SSH example's `sshExec`.                                                      |
| D2  | Operation coverage      | **Route all seven** (`read/write/edit/bash/ls/grep/find`). The SSH example leaves `ls/grep/find` local; for a real sandbox that silently shows the head's FS, so M2 closes the gap.                   |
| D3  | Pod lifecycle           | **Client targets an existing pod** identified by env (`namespace` + `pod`); ship one plain `Deployment + PVC` manifest as the fixture, applied out-of-band. No dynamic create/teardown in the client. |
| D4  | Verification gate       | **Injectable seam + deterministic fake-exec unit tests (all 7 ops) + one real kind smoke.** Direct mirror of M1's gate.                                                                               |
| D5  | Code placement          | **New `@moca/k8s-sandbox` package + thin env-gated `cli.ts` wiring.** **No pi-fork change** — the Operations seam is already native.                                                                  |
| D6  | Headless config surface | **Env vars / factory argument, not CLI flags.** `KAGENTI_SANDBOX_POD` is the on/off gate; unset ⇒ extension inert, all tools local.                                                                   |
| D7  | Path mapping            | **Mirror the SSH example:** announce the pod cwd in the system prompt via `before_agent_start`; map head-cwd → pod-cwd in the operations (naive `path.replace`, fragility accepted for M2).           |

---

## 3. Architecture & package layout

The split mirrors M1 (reusable package + thin harness wiring) but is **entirely
harness-side** — `pi-fork` is untouched.

```
packages/k8s-sandbox/
  src/
    exec.ts         # injectable transport seam + default kubectl impl
    config.ts       # K8sSandboxConfig + env resolution + the on/off gate
    operations.ts   # 7 factories: createPod{Read,Write,Edit,Bash,Ls,Grep,Find}Ops
    extension.ts    # k8sSandboxExtension() — registers/wraps the 7 tools
    index.ts
  deploy/
    sandbox.yaml    # plain Deployment + PVC fixture
  test/             # fake-exec unit tests (no cluster)
  package.json
harness/src/cli.ts  # + k8sSandboxExtension() in extensionFactories (env-gated)
```

### 3.1 The transport seam (`exec.ts`) — the testability lever

```ts
export type ExecInPod = (
  command: string, // run as: bash -c <command> inside the pod
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds, mirrors BashOperations
  },
) => Promise<{ stdout: Buffer; exitCode: number | null }>;
```

The default implementation spawns:

```
kubectl exec -i [-n <namespace>] [--context <ctx>] <pod> -- bash -c <command>
```

— the verbatim analog of the SSH example's `sshExec`. A buffered convenience
(`stdout` collected) serves the file ops; the streaming `onData` path serves bash.
Unit tests inject a **fake** `ExecInPod` that records the command string and returns
canned `stdout` / `exitCode`, so no test touches a cluster.

### 3.2 Configuration (`config.ts`)

Resolved at construction from the factory argument or env (env wins for headless runs):

| Env var                     | Meaning                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `KAGENTI_SANDBOX_POD`       | Pod name — **the on/off gate.** Unset ⇒ extension inert; all tools run locally (default headless behavior unchanged). |
| `KAGENTI_SANDBOX_NAMESPACE` | Namespace (default `default`).                                                                                        |
| `KAGENTI_SANDBOX_CONTEXT`   | Kube context (optional; omit to use current-context).                                                                 |
| `KAGENTI_SANDBOX_CWD`       | Pod working directory, e.g. `/workspace`. The cwd announced to the model; head-cwd → this is the path map.            |

---

## 4. The seven Operations → pod

File transfer mirrors the SSH example's `cat` / `base64` approach. All paths are
mapped head-cwd → pod-cwd before the command is built, and shell-quoted.

| Op        | In-pod implementation                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**  | `readFile` → `cat <p>` (buffered); `access` → `test -r <p>`; `detectImageMimeType` → `file --mime-type -b <p>` (whitelist jpeg/png/gif/webp, else null)     |
| **Write** | `writeFile` → `echo <b64> \| base64 -d > <p>`; `mkdir` → `mkdir -p <d>`                                                                                     |
| **Edit**  | compose Read + Write; `access` → `test -r <p> && test -w <p>`                                                                                               |
| **Bash**  | stream `cd <cwd> && <command>` through `execInPod` with `onData` / `signal` / `timeout` (mirrors `createRemoteBashOps`)                                     |
| **Ls**    | `exists` → `test -e <p>`; `stat.isDirectory()` → `test -d <p>`; `readdir` → `ls -1A <p>` split on newline                                                   |
| **Grep**  | `isDirectory` → `test -d <p>`; `readFile` (string) → `cat <p>` (context lines)                                                                              |
| **Find**  | `exists` → `test -e <p>`; `glob` → run `fd` / `find` **in-pod** (Pi's default fd path is local; supplying a custom `glob` is the documented override point) |

### 4.1 Load-bearing risk — grep/find search routing (proven first, not assumed)

For `read/write/edit/bash/ls` the search/exec clearly flows through `operations`.
For **grep** and **find**, Pi's tool may run `rg` / `fd` _locally in `execute()`_ and
use `operations` only for ancillary reads — `find.ts` comments: _"Actual fd execution
happens in execute() when no custom glob is provided."_

The implementation plan's **first task is a spike** that confirms whether supplying a
custom `glob` (find) and the grep operations actually reroutes the **search itself** to
the pod. If a tool's search is hardwired to a local binary, the fallback is to override
that tool's `execute` to run `grep` / `rg` / `find` in-pod (the same wrap-and-delegate
shape the SSH example uses for the four it covers). This is the one place "all seven"
could leak to the head; the plan proves it before building the rest.

---

## 5. Extension wiring & headless config (`extension.ts`, `cli.ts`)

`k8sSandboxExtension(config?)` follows the SSH example's structure: register each tool
wrapping the local one; per-execute, when the sandbox is active, construct a fresh tool
with the pod operations and delegate; intercept `user_bash`; and rewrite the announced
cwd in `before_agent_start`.

**Deliberate divergence from the SSH example:** that example resolves config from **CLI
flags** in `session_start`. The headless `cli.ts` has no flags and wires extensions via
`extensionFactories` (the M1-established injection point). So config is resolved from the
**factory argument or env at construction**; `session_start` only sets the status line.

`cli.ts` adds `k8sSandboxExtension()` to `extensionFactories` alongside `flushExtension`.
With no sandbox env set, **Config A** (monolithic / local) runs exactly as today; setting
`KAGENTI_SANDBOX_POD` switches a run to **Config B/C** (remote hands). One detail the
spike confirms: that `before_agent_start` fires on the headless `createAgentSession`
path (M1 proved `turn_end` / `session_shutdown` do).

---

## 6. Manifest fixture (`deploy/sandbox.yaml`)

A plain single-replica `Deployment` + `PVC`. A generic image carrying `bash`,
`coreutils` (`base64`, `file`, `stat`), `findutils` / `fd`, and `ripgrep`, with the PVC
mounted at `/workspace` (= `KAGENTI_SANDBOX_CWD`). Applied out-of-band before the smoke.
No dynamic create/teardown in the client — the deferred sandbox track owns lifecycle.

---

## 7. Verification gate (mirrors M1)

- **Deterministic unit tests (no cluster).** Inject a fake `execInPod`; one test per op
  asserting (a) the exact command string built and (b) correct parsing of stdout into the
  Operations return shape. Plus bash `signal` (abort) and `timeout` behavior.
- **One real kind smoke.** Apply the manifest, set the env, drive a turn through `cli.ts`
  that (1) writes a file via the agent → assert it exists in the pod
  (`kubectl exec … -- cat`), and (2) runs `hostname` / `uname -n` → assert the output is
  the **pod's**, not the head's. Step (2) proves isolation actually happened — not merely
  that a command ran somewhere.

---

## 8. Residual risks

| Risk                                                                                | Mitigation                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| grep/find search hardwired to a local binary                                        | **Task 1 spike** proves routing; fallback = override the tool's `execute` to run the search in-pod.                        |
| Per-op `kubectl exec` latency (each op = a new exec)                                | Acceptable for M2 (not the perf milestone); flagged for M3 — a persistent in-pod channel or API-exec is the upgrade path.  |
| Abort/timeout kills the local `kubectl`, but the remote command may linger (no TTY) | Accepted for M2; noted for the lifecycle track. Kill the local process on `signal`/timeout as the SSH example does.        |
| `base64 -d` vs `--decode` (busybox) and binary-file safety                          | Mirror the SSH example's base64 flow; the smoke includes a binary-file round-trip.                                         |
| Naive `path.replace` cwd mapping (inherited from SSH)                               | Kept for M2; fragility documented. Revisit if paths outside the announced cwd appear.                                      |
| `before_agent_start` may not fire on the headless path                              | Spike confirms; if absent, announce the pod cwd by other means (status line + system-prompt edit at session construction). |

---

## 9. Relationship to the parent plan

This realizes Milestone 2 ("K8sSandboxClient (Operations → pod)") and the §7.3 control
seam ("forcing a remote sandbox"). It is the **second** of the three serverless
externalizations (trigger / session / sandbox); M1 delivered the session seam. With M1 +
M2, Config B (persistent decoupled: external Redis log + remote pod hands) is fully
expressible; M3 adds the Knative trigger to reach Config C (serverless).

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
