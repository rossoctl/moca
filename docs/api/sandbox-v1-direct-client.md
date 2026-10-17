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
}
```

`SandboxWorker.Attach` in the same file is the workers' side; clients never call it.

**A call:**

```
ExecRequest { sandbox_id, exec: Exec { req_id, command, stdin, timeout_s, streaming, workspace_key } }
  -> stream ExecEvent  chunk { req_id, data, stream: STDOUT | STDERR }   zero or more
                       end   { req_id, exit_code, truncated }             then exactly one
                       error { req_id, message }                          of end / error
```

- **Every `Exec` runs `bash -c <command>`** with `/workspace` as the working directory, in a fresh
  Firecracker VM.
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
  Reusing an id that is still in flight in your sandbox is refused with `ALREADY_EXISTS`. A random
  53-bit id is enough.
- **`timeout_s`**: the worker kills the command when it runs out. It defaults to, and is capped at,
  the token's lifetime (`exp − iat`) minus 60 s: 840 s with the default 15-minute tokens. See
  [Tokens](#tokens) for why.
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
2. sends a `timeout_s` of at most the token lifetime minus 60 s, so that the worker's own timeout
   fires before the relay's cancel. When it cuts a longer request, it says so.

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
| `UNKNOWN` today (`UNAVAILABLE` is reserved) with `no live worker for...` | The template's worker is not attached: the template is unavailable                                                                     |
| `INTERNAL`                                                               | An `error` event, as above, including a timeout                                                                                        |

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

| Command              | Does                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sbx run [COMMAND…]` | Runs `COMMAND`, or with no arguments the script on stdin, in `/workspace`. Exits with its exit code: 124 timed out, 125 the sandbox failed |
| `sbx put PATH`       | Writes stdin to `PATH`, creating parent directories                                                                                        |
| `sbx push [DIR]`     | Replaces `/workspace` with `DIR`'s git working tree and commits it as a baseline                                                           |
| `sbx pull`           | Prints every change since the push as a git patch                                                                                          |

A busy sandbox and a token that expired during the Exec also exit 125, each with its own message.

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
SBX_BEARER="$(eval "$SBX_TOKEN_CMD")" grpcurl -import-path proto -proto sandbox/v1/sandbox.proto \
  ${SBX_CA_FILE:+-cacert "$SBX_CA_FILE"} \
  -expand-headers -H 'authorization: Bearer ${SBX_BEARER}' \
  -d "{\"sandbox_id\":\"$SBX_SANDBOX_ID\",\"exec\":{\"req_id\":\"42\",\"command\":\"ls -la\",
       \"timeout_s\":60,\"streaming\":true,\"workspace_key\":\"$SBX_WORKSPACE_KEY\"}}" \
  "$SBX_ADDR" sandbox.v1.SandboxExec/Exec
```

The token travels in grpcurl's environment, which `-expand-headers` reads, not on its command
line: anything in argv is visible to every user of the machine through `ps`. Chunk `data` comes
back base64-encoded in grpcurl's JSON.

**Other languages:** generate a client from the one proto file with `buf generate` or `protoc`.
MOCA's own TypeScript client is generated in `packages/k8s-sandbox/src/gen/`.
