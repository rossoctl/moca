# M3 Design: Persistent in-pod channel + env injection + find ignore-list

Version: 1.0 — June 17, 2026
Status: Design (approved for implementation planning)
Scope: Sandbox-track hardening increment of the serverless harness — cut per-op
`kubectl exec` latency, close the `BashOperations.env` gap, and honour find's ignore list
Parent plan: [MOCA: Revised Plan](../../../docs/research/2026-06-10-moca-revised-plan.md) §8 (residual risks — "flagged for M3 — a persistent in-pod channel")
Predecessor: [M2 Design — K8sSandboxClient](2026-06-17-m2-k8s-sandbox-client-design.md)

---

## 1. Goal & scope

M2 routed all seven Pi tool operations to a remote pod, but each operation spawns a
**fresh `kubectl exec`** — every read/test/mkdir pays a full apiserver TLS handshake +
pod exec + bash startup. M2 also left two correctness gaps it documented in code:
`BashOperations.env` is dropped (`operations.ts:67-68`), and find ignores Pi's `ignore`
list and `.gitignore` (`operations.ts:98-100`).

M3 closes all three, **harness-side only** (`pi-fork` untouched, as in M2):

1. **Persistent channel** — a long-lived in-pod `bash` session reused across the small
   request/response operations, so a burst of file ops costs **one** `kubectl exec`
   instead of N.
2. **Env injection** — Pi's per-command `env` (passed only to the bash tool) is applied
   inside the pod.
3. **find ignore-list** — find honours the `ignore` patterns (negated globs) AND `.gitignore`
   for ignored **directories** (verified on the pod's ripgrep 14.1.0; re-verified on 15.2.0,
   which the leaf sandbox images vendor). Minor divergence from Pi's `fd`: an
   individually-gitignored _file_ matching the positive `-g <pattern>` is re-included by the
   glob whitelist — see D5 caveat below.

M3 is **done** when: a burst of fast ops in one agent turn is served by a single reused
kubectl process (proven on a real kind cluster); an env var set on a bash tool call is
visible to the command in the pod; and find excludes gitignored directories
(`dist/` via `.gitignore`) plus Pi's `ignore`-list entries (`node_modules`/`.git`) — all
backed by cluster-free unit tests plus one real kind smoke.

### In scope

- A new `persistentExecInPod` transport (an `ExecInPod`) behind the **existing M2 seam**,
  with a pure framing protocol and a one-in-flight command queue.
- Two-tier routing in the extension: persistent channel for fast request/response ops;
  M2's per-call `kubectl exec` retained for the streaming/long-running ops.
- Transparent fallback to per-call exec when the persistent channel is unavailable.
- Env injection at the bash-ops layer (transport-agnostic).
- find re-implemented on `rg --files` (ripgrep is already in the pod image).
- Disposal of the persistent process on `session_shutdown`.

### Out of scope (later milestones / tracks)

- Streaming the **bash tool / grep** over the persistent channel (S-all) — deferred; they
  keep M2's per-call streaming path (see D2).
- Pod **provisioning / lifecycle**, **snapshot/restore** — unchanged from M2 (deferred tracks).
- **Knative serverless wrapper / `user_message` trigger** and the **compaction-checkpoint**
  — the parent plan's later milestones; independent of this increment.
- **In-cluster auth** — still the developer's local `kubectl` + kubeconfig.
- Pod-image changes — none; M3 adds no new in-pod binary.

---

## 2. Key decisions (resolved during brainstorming)

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Persistent transport | **T1 — long-lived `kubectl exec -i … -- bash`** with a framed stdin/stdout protocol. Zero new deps/infra; same kubectl shell-out and same injectable `ExecInPod` seam as M2. (Rejected: T2 pod-side RPC server + port-forward — breaks the plain-Deployment posture; T3 SPDY via `@kubernetes/client-node` — heavy dep, same framing problem.)                                                                                                                                                                                                                                                                                                                                                                                                       |
| D2  | Channel scope        | **S-fast — persistent channel for the small request/response ops only** (read, write, edit, ls, stat, mkdir, find, mime). **bash, grep, and `user_bash` keep M2's per-call `kubectl exec`** — they stream via `onData`, honour `signal` abort, run long, and already amortize the exec overhead. Captures the bulk of the latency win while the framing protocol only ever handles the simple case.                                                                                                                                                                                                                                                                                                                                                  |
| D3  | Wire framing         | **Sentinel-bracketed, base64-encoded payload + trailing exit code.** base64's alphabet cannot contain the marker bytes ⇒ collision-free framing and binary-safe stdout. One command in flight at a time (a queue), since the ops are synchronous request/response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D4  | Env injection site   | **Bash-ops layer, as an `env VAR=val … bash -c <cmd>` prefix** — transport-agnostic (works for both kubectl and persistent transports) and non-leaking (scoped to the one invocation). **No `ExecInPod` signature change.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D5  | find implementation  | **`rg --files -g <pattern> -g '!<ignore>'`** — reuses the ripgrep already in the image, honours `.gitignore`, and applies the `ignore` negations. **Verified behavior on rg 14.1.0 (nuanced):** gitignored _directories_ (e.g. `node_modules/`, `dist/`) are pruned and stay excluded even when `-g` matches files inside them; but an individually-gitignored _file_ matching the positive `-g <pattern>` IS re-included (the glob whitelist-overrides a file-level ignore) — a minor divergence from Pi's `fd --glob`. The `ignore` list (negated `-g '!<ig>'`) always excludes its entries. Accepted for M3; closing the individual-file edge is a low-priority follow-up. (Rejected: keep `find` + translate globs to `-path -prune` — brittle.) |
| D6  | Resilience           | **Transparent fallback.** A failed spawn or a session that dies mid-command degrades that op to a one-shot `kubectl exec` (`kubectlExecInPod`), and the session re-spawns lazily. A dead channel never hard-fails — it reverts to M2 behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D7  | Lifecycle            | **Dispose on `session_shutdown`** (fires on quit/reload/new/resume/fork) — end stdin and kill the kubectl process so it is never leaked. Spawn is **lazy** (first fast op), so an inert run spawns nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D8  | Verification gate    | **Pure framing unit tests + fake-`spawn` persistent-exec tests + operations tests + one real kind smoke.** Direct mirror of M2's D4 — cluster-free and build-free except the single smoke.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 3. Architecture & package layout

Entirely within `packages/k8s-sandbox/`; `pi-fork` untouched. New files marked **new**;
M2 files edited in place.

```
packages/k8s-sandbox/
  src/
    framing.ts          # NEW (pure) — wire protocol: wrapCommand() + FrameParser
    persistent-exec.ts  # NEW — persistentExecInPod(): long-lived bash + queue + fallback + dispose
    exec.ts             # unchanged — kubectlExecInPod() is now BOTH the stream transport and the fallback
    operations.ts       # edit — createPodBashOps (env prefix); createPodFindOps (rg --files)
    extension.ts        # edit — build fastExec + streamExec; route; dispose on session_shutdown
    config.ts           # unchanged
    paths.ts            # unchanged (shQuote, mapPath reused)
    grep-tool.ts        # unchanged (stays on streamExec)
  deploy/sandbox.yaml   # unchanged — ripgrep already present
  test/
    framing.test.ts          # NEW
    persistent-exec.test.ts  # NEW
    operations.test.ts       # edit — add env + find cases
    (config/exec/paths)      # unchanged
```

### 3.1 The framing protocol (`framing.ts`) — the testability lever

A long-lived bash reads commands from stdin and writes all their output to one stdout
stream, so each command's output must be delimited, exit-code-tagged, and binary-safe.

`wrapCommand(nonce, command)` produces the line written to the bash's stdin:

```
printf '\x01B%s\n' <nonce>; { <command>; } | base64; printf '\x01E%s %d\n' <nonce> "${PIPESTATUS[0]}"
```

- `<command>` is the already-built, already-quoted op command (e.g. `cd <qcwd> && cat <qp>`).
- Payload is piped through `base64` ⇒ the body contains only `[A-Za-z0-9+/=\n]`, which
  **cannot** contain the `\x01`-prefixed `B`/`E` markers ⇒ framing is collision-proof and
  stdout is binary-safe after decode.
- The reported exit code **must be the command's, not base64's.** Since `<command>` is the
  first stage of the pipeline, the wrapper uses bash's `${PIPESTATUS[0]}` (not `$?`, which
  would capture base64's status — almost always 0 — and silently break every op that keys
  off exit codes: `access`→`test -r`, `stat`, mkdir, …). The session is a bare `bash`, so
  `PIPESTATUS` is available.

`FrameParser` is a chunk-fed state machine: `push(chunk: Buffer)` accumulates bytes and
emits `{ nonce, stdout: Buffer, exitCode: number }` for each complete `B…E` frame, where
`stdout` is the base64-decoded payload. It handles markers split across chunk boundaries,
multiple frames in one chunk, and a partial trailing frame. **Pure — no process, no
cluster** — so the gnarly parsing is unit-tested in isolation.

### 3.2 The persistent transport (`persistent-exec.ts`)

```ts
export function persistentExecInPod(
  config: K8sSandboxConfig,
  deps: { fallback: ExecInPod; spawn?: typeof import('node:child_process').spawn },
): ExecInPod & { dispose: () => void };
```

It implements the **same `ExecInPod` type** as M2, so `operations.ts` is agnostic to which
transport it gets. Internals:

- **Lazy spawn** on first call: `kubectl exec -i [-n ns] [--context ctx] <pod> -- bash`
  (a bare `bash` reading from stdin — **not** `bash -c`). A single `FrameParser` consumes
  its stdout.
- **One-in-flight queue.** `exec(command, opts)` enqueues; when its turn comes it generates
  a nonce, writes `wrapCommand(nonce, command)` to stdin, and resolves `{ stdout, exitCode }`
  when the parser emits that nonce's frame. `command` is wrapped **verbatim** — the
  operations already include their own `cd` where needed (read/ls/stat use absolute mapped
  paths with no `cd`), exactly as M2's `kubectlExecInPod` runs `bash -c <command>` verbatim.
- **Per-command stdin via heredoc.** The `ExecInPod` contract carries `opts.stdin` (used only
  by `writeFile`'s `base64 -d > <path>`). A per-call `kubectl exec -i` feeds that as the
  command's stdin, but a shared session's stdin _is_ the command stream. So when `opts.stdin`
  is set, the transport appends a nonce-delimited heredoc to the command — `<command> <<'<H>'\n<stdin>\n<H>` — and bash reads the heredoc body from the same stream and feeds it to
  the command. Binary-safe (writeFile's payload is already base64) and ARG_MAX-safe (data is
  not an argv). Contract: when `stdin` is provided, `command` must be a single pipeline whose
  first stage consumes stdin (holds for `base64 -d > <path>`).
- **`opts.timeout` / `opts.signal`** → kill + re-spawn the session and reject with the
  M2-compatible `timeout:<n>` / `aborted` errors. (Killing the session is acceptable: fast
  ops are short, and the next call re-spawns lazily.)
- **Session death** (child `error`/`close` before a frame settles) → reject the in-flight
  command and mark the session dead.
- **`dispose()`** → end stdin, kill the child, clear the queue.

Crucially, the persistent transport is wrapped so that **any rejection caused by channel
unavailability is retried once via `deps.fallback`** (D6) — the file op still succeeds via
a one-shot `kubectl exec`. Genuine command failures (non-zero exit codes) are _not_ retried;
they pass through unchanged.

### 3.3 No new config

M3 adds **no new env vars**. `K8sSandboxConfig` and `resolveConfig` are unchanged — the
persistent channel is purely a transport upgrade behind the existing `KAGENTI_SANDBOX_POD`
gate. (Rationale: fewer knobs; the fallback makes the channel safe-by-default, so there is
nothing for an operator to tune or disable.)

---

## 4. The three changes in detail

### 4.1 Two-tier routing (`extension.ts`)

M2 built one `exec` and gave it to all seven tools. M3 builds two and routes by op shape:

```ts
const streamExec = opts?.exec ?? kubectlExecInPod(config); // M2 path (per-call)
const fastExec =
  opts?.exec ??
  persistentExecInPod(config, {
    // M3 path (persistent)
    fallback: kubectlExecInPod(config),
  });

// fast request/response ops → persistent channel
registerTool(createReadTool(localCwd, { operations: createPodReadOps(fastExec, config) }));
registerTool(createWriteTool(localCwd, { operations: createPodWriteOps(fastExec, config) }));
registerTool(createEditTool(localCwd, { operations: createPodEditOps(fastExec, config) }));
registerTool(createLsTool(localCwd, { operations: createPodLsOps(fastExec, config) }));
registerTool(createFindTool(localCwd, { operations: createPodFindOps(fastExec, config) }));

// streaming / long-running ops → per-call kubectl exec (unchanged from M2)
registerTool(createBashTool(localCwd, { operations: createPodBashOps(streamExec, config) }));
registerTool(createPodGrepTool(localCwd, streamExec, config));
pi.on('user_bash', () => ({ operations: createPodBashOps(streamExec, config) }));

pi.on('session_shutdown', () => {
  if ('dispose' in fastExec) fastExec.dispose();
});
```

When `opts.exec` is supplied (tests / alternate auth), it is used for **both** tiers, so
existing M2 fake-exec tests keep working and a single fake can still observe every op.
`before_agent_start` (cwd announcement) is unchanged.

### 4.2 Env injection (`createPodBashOps`)

Pi passes `env` only to the bash tool. When present, prefix a non-leaking, per-invocation
`env`:

```ts
exec: async (command, cwd, { onData, signal, timeout, env }) => {
  const prefix = env
    ? 'env ' +
      Object.entries(env)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${shQuote(String(v))}`)
        .join(' ') +
      ' '
    : '';
  const wrapped = prefix
    ? `cd ${q(cwd)} && ${prefix}bash -c ${shQuote(command)}`
    : `cd ${q(cwd)} && ${command}`; // M2's exact form when env is absent (no behavior change)
  const r = await exec(wrapped, { onData, signal, timeout });
  return { exitCode: r.exitCode };
};
```

`env VAR=val … cmd` scopes the variables to that one command; keys with `undefined` values
are skipped. The empty-`env` branch is byte-identical to M2, so unrelated bash behavior is
untouched.

### 4.3 find ignore-list (`createPodFindOps.glob`)

Replace `find . -type f -name <pattern>` with `rg --files`:

```ts
glob: async (pattern, cwd, { ignore, limit }) => {
  const globs = [`-g ${shQuote(pattern)}`, ...ignore.map((ig) => `-g ${shQuote('!' + ig)}`)];
  const r = await exec(`cd ${q(cwd)} && rg --files --hidden ${globs.join(' ')} | head -n ${limit}`);
  return r.stdout
    .toString()
    .split('\n')
    .filter((x) => x.length > 0)
    .map((rel) => rel.replace(/^\.\//, ''));
};
```

`rg --files` lists files under cwd honouring `.gitignore`; `--hidden` keeps dotfiles in
view; each `ignore` pattern becomes a negated glob. **Verified nuance (rg 14.1.0, re-verified
on 15.2.0):** gitignored _directories_ (e.g. `node_modules/`, `dist/`) are pruned and stay
excluded even when `-g` matches files inside; but an individually-gitignored _file_ matching
the positive `-g <pattern>` is re-included (the glob whitelist-overrides a file-level ignore)
— a minor divergence from Pi's `fd --glob`. The `ignore`-list negated globs (`-g '!<ig>'`)
always exclude their entries. Output shape (relative paths, `./` stripped, `limit`-capped)
matches M2. `exists` is unchanged.

---

## 5. Error handling & resilience

| Condition                                        | Behavior                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Persistent spawn fails (no kubectl, bad context) | Op transparently retried via `fallback` (one-shot exec); session re-spawn attempted lazily next call. |
| Session dies mid-command (pod restart, net blip) | In-flight command rejects → retried once via `fallback`; session marked dead and re-spawned lazily.   |
| `opts.timeout` on a fast op                      | Kill + re-spawn session; reject `timeout:<n>` (M2-compatible).                                        |
| `opts.signal` aborted                            | Kill + re-spawn session; reject `aborted` (M2-compatible).                                            |
| Genuine non-zero exit code                       | Passed through unchanged (**not** treated as channel failure; no retry).                              |
| `session_shutdown`                               | `dispose()` — end stdin, kill child; no leaked process.                                               |

Streaming ops (bash/grep) retain M2's exact error handling because their transport is
unchanged.

---

## 6. Verification gate (mirrors M2's D4)

- **`framing.ts` (pure unit tests).** `wrapCommand` output shape; `FrameParser` across
  chunk splits (mid-marker and mid-payload), multiple frames per chunk, exit-code parse,
  partial trailing frame, and a **binary payload round-trip** (base64 safety).
- **`persistent-exec.ts` (fake injected `spawn` → fake duplex streams).** Queue
  serialization/ordering (second command waits for the first's frame); resolve-on-frame;
  reject-on-early-close; **`fallback` invoked** on spawn failure and on mid-command death;
  timeout/abort kill the child; `dispose()` kills the child.
- **`operations.ts` (fake `exec`).** Env prefix emitted (`env K=…`) **only** when `env`
  present, and absent branch byte-identical to M2; find emits `rg --files` with the
  `-g <pattern>` and `-g '!<ignore>'` globs and the `head -n <limit>` cap.
- **All M2 suites stay green** (paths, config, exec, the existing operations cases).
- **One real kind smoke** (recorded in `SMOKE.md`): drive a turn through `cli.ts` against a
  real pod and assert (1) a burst of reads/ls is served by a **single** reused kubectl
  process — not N (observable via the session / a process count); (2) an env var set on a
  bash tool call is visible to the command; (3) find excludes `node_modules`/`.git` and
  honours a `.gitignore`.

---

## 7. Residual risks

| Risk                                                                                 | Mitigation                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framing parser mis-handles an edge (huge output, marker-like bytes)                  | base64 makes payloads marker-free by construction; `FrameParser` is pure and exhaustively unit-tested incl. chunk-boundary splits and large/binary payloads.                         |
| Shared bash accumulates state across commands (cwd drift, leaked vars)               | Each fast op is fully self-contained (`cd <qcwd> && …`); env is injected per-command via `env …`, never `export`. No op relies on prior-command state.                               |
| Persistent session masks a real connectivity problem by always falling back          | Fallback is logged; the smoke asserts the channel is actually used (single process), so a silent permanent-fallback regression is caught.                                            |
| `rg --files` semantics differ subtly from `fd`/`find` (e.g. symlinks, no-match exit) | Output shape pinned by unit tests; no-match returns empty list (rg `--files` exits 0 with no output); smoke verifies gitignore + ignore-list behavior end-to-end.                    |
| `head -n <limit>` closing the pipe early sends SIGPIPE to `rg`                       | Acceptable — rg's partial output is the intended truncation; exit status of the op is the wrapper's `$?` of the pipeline's last stage, which M2 already tolerates for capped output. |
| Per-call streaming bash still pays per-op exec cost                                  | Accepted (D2): bash amortizes exec over real work; S-all (stream over the channel) is a deferred follow-up if profiling shows bash exec overhead dominates.                          |

---

## 8. Relationship to the parent plan

The parent plan flagged exactly this work in M2's residual-risk table (§8): _"Per-op
`kubectl exec` latency … flagged for M3 — a persistent in-pod channel or API-exec is the
upgrade path."_ M3 takes the **persistent in-pod channel** branch (T1), not API-exec,
because it preserves M2's whole posture (kubectl shell-out, no pod server, no new deps).

This is a **sandbox-track hardening increment** that makes Config B (persistent decoupled:
external Redis log + remote pod hands) genuinely low-latency and correct, ahead of the
parent plan's serverless-trigger and checkpoint work. It does not touch the trigger or
session layers and adds no new external surface.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
