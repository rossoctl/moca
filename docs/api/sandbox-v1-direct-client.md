# Calling the sandbox/v1 API from your own code

How to run commands in an SBX0 sandbox from your own code (a script, an SDK, a local tool) by
calling `SandboxExec` over gRPC. `mocactl sbx` is the supported command line; this guide is for
everything else. The design is
[the SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md), §7.

## What it is

[`proto/sandbox/v1/sandbox.proto`](../../proto/sandbox/v1/sandbox.proto) is one self-contained
file with no imports. A client uses one service, served by the SBX0 sandbox service's relay:

```proto
service SandboxExec {
  rpc Exec(ExecRequest) returns (stream ExecEvent);   // run one command, stream its output
  rpc Abort(AbortRequest) returns (AbortResponse);    // cancel a running command
  rpc LeaseControl(LeaseControlRequest) returns (LeaseControlResponse);       // lease mode only
  rpc LeaseKeepalive(LeaseKeepaliveRequest) returns (LeaseKeepaliveResponse); // lease mode only
}
```

The two lease calls matter only for a sandbox in a lease mode: see [Lease mode](#lease-mode).

`SandboxWorker.Attach` in the same file is the workers' side; clients never call it.

**A call:**

```
ExecRequest { sandbox_id, exec: Exec { req_id, command, stdin, timeout_s, streaming, workspace_key } }
  -> stream ExecEvent  chunk { req_id, data, stream: STDOUT | STDERR }   zero or more
                       lease { req_id, state, reason, at_unix_ms, ... }   lease mode only
                       end   { req_id, exit_code, truncated }             then exactly one
                       error { req_id, message }                          of end / error
```

- **Every `Exec` runs `bash -c <command>`** with `/workspace` as the working directory, in a fresh
  Firecracker VM. That is the default mode, `per-exec`; in a lease mode the VM is kept between
  Execs ([Lease mode](#lease-mode)).
- **Files under `/workspace` persist** between calls, for the sandbox's lifetime. Nothing else does:
  no process, and no file outside `/workspace`, survives the call.
- **There is no network** in the VM.
- **There is no file RPC.** Files are commands: write with `cat > path` and the bytes on `stdin`,
  read with `cat -- path`.

## Getting access

```bash
mocactl sbx login --control-plane-url https://<api host>   # GitHub device flow, once
mocactl sbx templates                                      # what a sandbox can be created from
mocactl sbx create --template <id>                         # prints the sandbox id and its expiry
eval "$(mocactl sbx env <sandbox id>)"
```

`mocactl sbx env` prints `export` lines for a direct client, never a token:

| Variable            | Is                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `SBX_ADDR`          | Where to dial: `<exec host>:443`                                                         |
| `SBX_TLS`           | `1`: always TLS                                                                          |
| `SBX_CA_FILE`       | Only when the exec endpoint's certificate is self-issued: the CA to trust, as a PEM file |
| `SBX_SANDBOX_ID`    | The **worker** serving your sandbox's template (the token's `wrk`), not your sandbox id  |
| `SBX_WORKSPACE_KEY` | **Your sandbox's workspace** (the token's `wsk`)                                         |
| `SBX_TOKEN_CMD`     | The command that prints a fresh token: `mocactl sbx token <sandbox id>`                  |

`SBX_TOKEN_CMD` may also carry `--control-plane-url '<url>'`, when the URL came from a flag or
`MOCACTL_SBX_URL`, so that it works in a shell that has neither. Run it with a shell-style split,
as the example client does.

## What a client sets

- **TLS** to `SBX_ADDR`: against the default roots, or, when `SBX_CA_FILE` is set, against that CA
  only. In grpcio, `root_certificates` replaces the default roots rather than adding to them.
- **`authorization: Bearer <sandbox token>`** as metadata on every call, `Abort` included.
- **`ExecRequest.sandbox_id = SBX_SANDBOX_ID`** and **`Exec.workspace_key = SBX_WORKSPACE_KEY`**,
  exactly. The relay compares both for equality with the token's `wrk` and `wsk`: never a prefix,
  never a case-folded match.
- **`req_id`** unique within the sandbox, and below 2^53. The proto says `uint64`, but the relay
  decodes it as a JavaScript number and refuses larger values. The relay namespaces `req_id` per
  sandbox, so your ids cannot collide with another user's, and `Abort` reaches only your own Execs.
  Use a fresh random 53-bit id for every call. Reusing an id that is still in flight in your
  sandbox is refused with `ALREADY_EXISTS`. Reusing the id of a call that has **completed** replays
  it: the worker keeps its last 256 completed results, keyed by id plus a fingerprint of `command`,
  `stdin`, `timeout_s` and `streaming`, and answers a match with the cached `end` (or timeout
  `error`) without running the command or sending its output again. The one deliberate reuse is
  the retry after `UNAUTHENTICATED` (see [Tokens](#tokens)), and nothing ran before it.
- **`timeout_s`**: the worker kills the command when it runs out. **Always send it.** The relay
  passes it through unchanged, and the worker treats 0 or an absent value as its own default,
  30 minutes, which is longer than a 15-minute token. Send at most what the token has left minus
  60 s, and never more than its lifetime (`exp − iat`) minus 60 s: 840 s with the default tokens.
  Otherwise a command that runs past the token's `exp` is cancelled at `exp` + 30 s with
  `DEADLINE_EXCEEDED`, possibly after it has already changed the workspace. See [Tokens](#tokens).
- **`streaming: true`**, so output arrives as it is produced. `false` buffers it until the end.
- **Keepalive every 20 s** (`grpc.keepalive_time_ms = 20000`, and permitted without calls). The
  relay pings too. Without it, a command that prints nothing for minutes can lose its connection to
  a load balancer's idle cut.
- **`stdin`**: raw bytes, sent once with the call. Keep it well under the 16 MiB message limit.

## Tokens

A sandbox token is an Ed25519-signed JWT (`typ: moca-sandbox+jwt`) bound to one sandbox: its
`wrk`, its `wsk`, and the `exec` scope.

- **It lives 15 minutes by default** (the deployment sets it), and never past the sandbox's own
  expiry.
- **Get one by running `SBX_TOKEN_CMD`.** Keep it in memory; never write it to disk or a log.
- **Run the command again:**
  - when the token is within 60 s of its `exp`;
  - once, on `UNAUTHENTICATED`, if no event of that call had arrived yet; then retry the call with
    the same `req_id`;
  - before an Exec that needs more time than the token has left.
- **Never re-run a command that started.** An `UNAUTHENTICATED` (or any failure) after the first
  event means the command may have run; report it instead.

**No Exec outlives its token.** The relay checks the token when it accepts an Exec, and cancels the
Exec at the token's `exp` (plus a 30 s leeway), ending the call with `DEADLINE_EXCEEDED`. So,
before each Exec, a client:

1. makes sure its token has at least `timeout_s` + 60 s left, and mints a fresh one if not;
2. sends a `timeout_s` of at most what the token has left minus 60 s, so that the worker's own
   timeout fires before the relay's cancel. When it cuts a longer request, it says so.

Asking for the whole cap on every call would mint a token before every call but the first, since a
held token always has a little less than its lifetime left. The example client therefore keeps a
held token for a call that names no timeout while the token has at least half the cap plus 60 s
left (480 s by default), and cuts that call's timeout to what the token has left minus 60 s. A call
that names a timeout the held token cannot cover still gets a fresh token.

The longest single command is therefore one token lifetime. Split longer work into several calls.

**Delete and de-enrollment are not immediate.** A token already issued keeps working until its
`exp`, plus the relay's 30 s leeway: up to one token lifetime plus 30 s (15.5 minutes by default)
after `mocactl sbx rm`, or after an operator removes your account. An Exec still running at that
point is cancelled (`DEADLINE_EXCEEDED`). No new token is issued after either.

You can decode the token's payload (base64url, the middle segment) to read `iat` and `exp`; do not
verify it, which is the relay's job.

## Outcomes versus failures

**The command's outcome:**

- `end` ends a command that ran, whatever its exit code. A non-zero `exit_code` is an outcome, not
  an error.
  - `exit_code < 0`: the command was killed by a signal (your abort, an out-of-memory kill).
  - `truncated`: stdout went over the 8 MiB cap, and the rest was dropped.
- An `error` event whose message is `timeout:<n>` means the command ran out of `timeout_s` (`n`
  seconds). That is the command timing out, not a failure of the sandbox; `sbx.py` exits 124 for it.
  The call then ends with `INTERNAL`, which a client ignores once it has seen the timeout.

**The machinery's failure:** any other `error` event (the VM did not boot, the worker went away), or
a non-OK status. There is no exit status to report. Two have an SBX0 meaning of their own:

- **`DEADLINE_EXCEEDED`, "sandbox token expired during the Exec":** the command outlived its token
  and was cancelled. Give it a shorter timeout, or split it.
- **`RESOURCE_EXHAUSTED`, "sandbox busy: \<n> Execs already in flight":** the sandbox already has
  its cap of Execs in flight (2 by default: one running, one waiting). Nothing ran; retry once one
  finishes.

**gRPC status codes:**

| Code                                                                     | Cause                                                                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`                                                        | Missing, expired or invalid token. Refresh once, as above                                                                              |
| `PERMISSION_DENIED`                                                      | `sandbox_id` is not the token's worker; `workspace_key` is not its workspace; or `Abort` of an Exec that is not yours, or has finished |
| `ALREADY_EXISTS`                                                         | The `req_id` is already in flight in this sandbox                                                                                      |
| `RESOURCE_EXHAUSTED`                                                     | The sandbox is busy                                                                                                                    |
| `DEADLINE_EXCEEDED`                                                      | The token expired during the Exec                                                                                                      |
| `INVALID_ARGUMENT`                                                       | No `exec` in the request, or `req_id` out of range                                                                                     |
| `UNKNOWN` today (`UNAVAILABLE` is reserved) with `no live worker for...` | The template's worker is not attached: the template is unavailable (`Exec`; `LeaseControl` answers `UNAVAILABLE`)                      |
| `INTERNAL`                                                               | An `error` event, as above, including a timeout                                                                                        |

## Lease mode

A sandbox in a lease mode keeps its VM between Execs, so the page cache stays warm and `/tmp` and
`/var` survive until the lease ends. Every process is still killed at the end of each Exec, and each
Exec gets a fresh shell. The design is
[the lease-mode spec](../specs/2026-11-08-sbx-lease-mode-design.md) (SBX0.3); the modes are `per-exec`
(the default), `lease` and `lease+processes`, and the deployment decides which of them a user may
pick. A sandbox's mode is set on the control plane: `mode` and `idleTimeoutS` on
`POST /v1/sandboxes`, and `PUT /v1/sandboxes/{id}/mode` to change them ([openapi.yaml](openapi.yaml)).

**The mode reaches the worker in your token.** A sandbox token carries the claims `mode`,
`mode_epoch` and `idle_timeout_s`, and the relay writes them into every `Exec` it routes, over
whatever the client sent. Leave `Exec.mode`, `mode_epoch` and `idle_timeout_s` unset. After a mode
change, mint a fresh token: the old one still carries the old epoch. For a sandbox created
`per-exec`, a token from before its first mode change carries epoch 0, and it is not refused: the
worker serves an epoch-0 Exec per-`Exec`, and that ends a live lease. A sandbox created in a lease
mode starts at epoch 1 (below), so none of its tokens carries 0.

- **`Exec.keepalive`** is the one lease field that is yours. Setting it, or calling
  `LeaseKeepalive`, turns the keepalive rule on for the rest of the lease: the lease then ends when
  no keepalive has arrived for 120 s (the worker's default). Use either only from a program that
  calls `LeaseKeepalive` every 30 s while it runs. Without them, the lease ends by its idle timeout,
  which a keepalive never resets.
- **The first `set_mode`.** A sandbox created in a lease mode is at epoch 1, and the worker runs its
  Execs per-`Exec` until a `LeaseControl set_mode` makes its epoch known. After the create, fetch a
  set-mode token with `POST /v1/sandboxes/{id}/mode-token` and send it in a `set_mode`. Send it again
  whenever `LeaseControl status` answers `epoch_known: false` (after a worker lost its state file).

**Lease events.** A lease Exec's response can carry `ExecEvent.lease` events, after the output and
before the `end` or the `error`. `state` is `start`, `end` (with an end `reason` such as `idle`,
`reset` or `mode_change`) or `expiring` (the lease ends at its next idle).

- **They are best-effort notices.** An event is delivered once, on the next lease Exec's response,
  and the worker counts it as delivered when it queues it to send, not when you read it. If the connection
  breaks in between, the event is lost; `LeaseControl status` still shows the lease's state. Rarely,
  the same event arrives twice: dedupe on `at_unix_ms`.
- **`expiring`** repeats on every lease Exec until the lease ends, with the same `at_unix_ms` (the
  lease's start plus its maximum duration) and `reason` `max_duration`. Its `ends_by_unix_ms` is the
  lease's hard end, when it ends even mid-Exec: `at_unix_ms` plus the grace limit (30 minutes by
  default). It is 0 on every other state, and from a worker that predates the field.
- **`mocactl sbx` and its MCP server show each event as one line** (the copy is in
  [the lease-mode spec](../specs/2026-11-08-sbx-lease-mode-design.md) §5), for example
  `[sandbox] guest restarted (idle, 14:02): ...` for an idle end.
- **A per-exec Exec never carries one.** A downgrade's `mode_change` end therefore comes back in the
  `set_mode` result's `status.pending`.

**The lease errors**, as an `error` event's message (and in a failed `LeaseControl`'s details):

| Message                    | Means                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `lease_ended(<reason>)`    | The lease ended while this Exec was queued or running (`grace_limit`, `reset`, `mode_change`, ...)                     |
| `stale_mode: <detail>`     | Your token predates a mode change. Mint a fresh token; nothing ran. An epoch-0 token is never refused this way (above) |
| `lease_unsupported: <...>` | A microVM worker whose snapshot has no lease mode (no `lease-v1`), or one that does not know the mode; nothing ran     |

The container tier and workers older than lease mode never refuse a lease-mode Exec: they ignore
the mode and run it per-`Exec`, without lease events. On `LeaseControl`, the container tier answers
`lease_unsupported` and an older worker does not answer (`DEADLINE_EXCEEDED`, below).

**`LeaseControl {sandbox_id, op, set_mode_token}`** reads the lease (`LEASE_OP_STATUS`), ends it
(`LEASE_OP_RESET`), applies a mode change (`LEASE_OP_SET_MODE`), or ends it because you are about to
delete the sandbox (`LEASE_OP_SANDBOX_DELETED`, the end reason `sandbox_deleted`; send it before
`DELETE /v1/sandboxes/{id}`, as `mocactl sbx rm` does, so the guest does not idle on after the
record is gone). It carries your sandbox token, and
`set_mode` also a set-mode token (`typ: moca-sandbox-mode+jwt`, valid 300 s) from
`PUT .../mode` or `POST .../mode-token`. The answer is a `LeaseStatus {mode, epoch_known, state,
age_ms, idle_timeout_s, pending}`, read after the op. `reset`, `sandbox_deleted` and a downgrade wait
for the lease to end, which can take as long as an Exec in flight needs (up to 30 minutes).

| Code                  | Cause                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`     | Missing, expired or invalid sandbox token                                                                                                                                                   |
| `PERMISSION_DENIED`   | A harness exec token (the harness never uses leases); `sandbox_id` is not the token's worker or is a workload sandbox; or the set-mode token was refused (one message, whatever the reason) |
| `INVALID_ARGUMENT`    | No `op`                                                                                                                                                                                     |
| `RESOURCE_EXHAUSTED`  | `sandbox busy`: the sandbox already has 4 `LeaseControl` calls in flight. Nothing was sent                                                                                                  |
| `FAILED_PRECONDITION` | The worker refused the op; the details are its message (above, or `busy: too many lease calls in flight`, below)                                                                            |
| `DEADLINE_EXCEEDED`   | The worker did not answer within 15 s (`status`) or 31 minutes (`reset`, `set_mode`, `sandbox_deleted`): it may predate lease mode                                                          |
| `UNAVAILABLE`         | The template's worker is not attached, or it went away before answering                                                                                                                     |
| `CANCELLED`           | You cancelled the call before the worker answered. The relay frees its place at once, but a `reset` or `set_mode` already sent runs on at the worker: read the outcome with `status`        |

On a `PERMISSION_DENIED` from `set_mode`, fetch a fresh set-mode token once and retry. A worker
runs at most 2 `reset`, `set_mode` or `sandbox_deleted` calls per sandbox, and 16 in all, and
answers `busy` past either. It runs at most 32 `status` calls at once, apart from those, and answers
`busy` past that; calls blocked in a `reset` or `set_mode` never make a `status` busy.

**`LeaseKeepalive {sandbox_id}`** answers OK once the token checks pass, even when no worker is
attached; it does nothing without a live lease. The relay does not audit it, and it passes on at
most one keepalive per sandbox per second: the others are answered OK and dropped. Every 30 s is
enough (`mocactl sbx mcp` sends one every 30 s while its token's mode is a lease mode).

## Limits

- **One command at a time per sandbox.** A second concurrent call waits at the worker until the
  first finishes; a third is refused as busy.
- **16 MiB** per message, so send large trees as several calls.
- **8 MiB** of stdout per call.
- **The longest command** is one token lifetime minus 60 s (14 minutes by default).
- **A sandbox lives 7 days by default**, then it is gone with its workspace. There is no
  extension: pull your work out before then. `mocactl sbx ls` shows each sandbox's expiry.

## The stability promise

Changes to `sandbox/v1` are additive only, under
[ADR-0024](../adrs/0024-sandbox-transport-remote-exec.md)'s rules: no field is removed or renumbered,
and no meaning changes. Nothing else is promised: the relay's status details, the limits above and
the token's lifetime may change.

## The examples

[`examples/sandbox_v1_client.py`](examples/sandbox_v1_client.py) is a small client with every rule
above: TLS with keepalive, a `TokenSource` that re-runs `SBX_TOKEN_CMD`, token freshness and the
timeout cap, the retry-once-if-not-started rule, and the outcome and failure mapping
(`SandboxBusy`, `TokenExpiredDuringExec`, `SandboxError`). `Sandbox.from_env()` reads what
`mocactl sbx env` prints. `SBX_TOKEN`, a one-off static token that is never refreshed, is used
only when `SBX_TOKEN_CMD` is unset.

[`examples/sbx.py`](examples/sbx.py) is an example of a thin command line on top of it, for one
sandbox. It is an example only: `mocactl sbx run` and `put` (increment 1c) are the supported CLI.

| Command              | Does                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sbx run [COMMAND…]` | Runs `COMMAND`, or with no arguments the script on stdin, in `/workspace`. Exits with its exit code: 124 timed out, 125 the sandbox failed, 75 refused at capacity (nothing ran) |
| `sbx put PATH`       | Writes stdin to `PATH`, creating parent directories                                                                                                                              |
| `sbx push [DIR]`     | Replaces `/workspace` with `DIR`'s git working tree and commits it as a baseline                                                                                                 |
| `sbx pull`           | Prints every change since the push as a git patch                                                                                                                                |

A token that expired during the Exec also exits 125, with its own message.

**A command refused at capacity is retried, then exits 75.** The worker refuses an Exec before
anything of it runs when its template's memory budget or run count is full (`memory-budget:`,
`max-runs:`, `busy: queue full`), and the relay does when the sandbox already has its cap of Execs
in flight (`RESOURCE_EXHAUSTED` `sandbox busy`). Since nothing ran, `sbx` sends the command again,
each time as a new Exec with a new `req_id`, after about 1, 2, 4, 8 and then 8 s (with jitter), until
`SBX_BUSY_RETRY_S` seconds of waiting are spent (default 30; `0` turns retries off, and the refusal
exits 125 as before). Then it exits **75**, nothing having run. A refusal after any output, and every
other failure, is never retried. Both `sbx.py` and the Go `sbx` do this, and write the same `SBX_LOG`
keys besides `{t, op, ms, exit}`:

- `attempt`: the attempt number, from 1, on every record;
- `refused` and `reason`: a refused attempt's class (`memory_budget`, `max_runs`, `queue_full`,
  `relay_busy`) and its text, cut to 300 characters;
- `busy_wait_ms`: the total wait between retries, on the call's final record only.

Both need Python 3.10 or later and `grpcio`. From `docs/api/examples`:

```bash
python3 -m venv .venv && .venv/bin/pip install grpcio grpcio-tools
.venv/bin/python -m grpc_tools.protoc -I ../../../proto --python_out=. --grpc_python_out=. \
    sandbox/v1/sandbox.proto                      # writes sandbox/v1/, which git ignores
eval "$(mocactl sbx env <sandbox id>)"
.venv/bin/python sandbox_v1_client.py             # writes a file, reads it back, runs it
.venv/bin/python sbx.py run 'uname -a; ls -la'
.venv/bin/python -m unittest test_sandbox_v1_client   # offline: no network, no relay
```

**From the shell, with `grpcurl`:**

```bash
REQ_ID="$(od -An -N6 -tu8 /dev/urandom | tr -d ' ')"   # a fresh random 48-bit id for every call
SBX_BEARER="$(eval "$SBX_TOKEN_CMD")" grpcurl -import-path proto -proto sandbox/v1/sandbox.proto \
  ${SBX_CA_FILE:+-cacert "$SBX_CA_FILE"} \
  -expand-headers -H 'authorization: Bearer ${SBX_BEARER}' \
  -d "{\"sandbox_id\":\"$SBX_SANDBOX_ID\",\"exec\":{\"req_id\":\"$REQ_ID\",\"command\":\"ls -la\",
       \"timeout_s\":60,\"streaming\":true,\"workspace_key\":\"$SBX_WORKSPACE_KEY\"}}" \
  "$SBX_ADDR" sandbox.v1.SandboxExec/Exec
```

The token travels in grpcurl's environment, which `-expand-headers` reads, not on its command
line: anything in argv is visible to every user of the machine through `ps`. Chunk `data` comes
back base64-encoded in grpcurl's JSON.

**Other languages:** generate a client from the one proto file with `buf generate` or `protoc`.
Moca's own TypeScript client is generated in `packages/k8s-sandbox/src/gen/`.
