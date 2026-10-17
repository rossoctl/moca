"""A minimal direct client for MOCA's sandbox/v1 SandboxExec API, for the SBX0 sandbox service.

See docs/api/sandbox-v1-direct-client.md. Needs Python 3.10+ and grpcio. Generate the stubs first,
from this directory:

    python -m grpc_tools.protoc -I ../../../proto --python_out=. --grpc_python_out=. sandbox/v1/sandbox.proto

Then, with a sandbox created by `mocactl sbx create`:

    eval "$(mocactl sbx env <sandbox id>)"
    python sandbox_v1_client.py
"""

import base64
import json
import math
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass

import grpc

from sandbox.v1 import sandbox_pb2, sandbox_pb2_grpc

# The relay pings every connection every 20 s (SBX0 §3.4); the client does too, so a command that
# prints nothing for minutes keeps its connection through a load balancer's idle cut.
CHANNEL_OPTIONS = [
    ("grpc.max_receive_message_length", 16 << 20),
    ("grpc.keepalive_time_ms", 20_000),
    ("grpc.keepalive_timeout_ms", 10_000),
    ("grpc.keepalive_permit_without_calls", 1),
]

# A token is refreshed within this many seconds of its `exp`, and an Exec's timeout leaves this
# much of the token's life spare, so the worker's own timeout fires before the relay cancels the
# Exec at `exp` (SBX0 §3.6, §6.5).
MARGIN_S = 60

# The worker's ExecError message when the command ran out of `timeout_s`.
TIMEOUT_MESSAGE = re.compile(r"timeout:\d+")


@dataclass
class Result:
    stdout: bytes
    stderr: bytes
    exit_code: int  # < 0: killed by a signal (an abort, a crash); 124: timed out
    truncated: bool  # stdout hit the worker's 8 MiB cap
    timed_out: bool = False  # the command ran out of timeout_s (ExecError "timeout:<n>")
    timeout_s: int = 0  # the timeout actually sent
    capped: bool = False  # the requested timeout was cut to the token lifetime minus 60 s


class SandboxError(RuntimeError):
    """The machinery failed (an ExecError other than a timeout, or a non-OK status): the command has
    no exit status to report."""


class SandboxBusy(SandboxError):
    """RESOURCE_EXHAUSTED: the sandbox already has its cap of Execs in flight. Nothing ran."""


class TokenExpiredDuringExec(SandboxError):
    """DEADLINE_EXCEEDED: the command outlived its token, and the relay cancelled it."""


class TokenSource:
    """A sandbox token, fetched by running a command (`mocactl sbx token <id>`) and kept until it is
    within 60 s of its `exp`, or until a caller needs more life than it has left. Sandbox tokens live
    15 minutes by default, so a long-running client re-runs the command; a static token (SBX_TOKEN)
    is for one-off use and is never refreshed."""

    def __init__(self, command: str | None = None, static: str | None = None):
        if not command and not static:
            raise ValueError("TokenSource needs a command or a static token")
        self._command, self._static = command, static
        self._token, self._iat, self._exp = None, 0, 0
        self.mints = 0  # how many times the command has run
        if static:
            self._iat, self._exp = _times_of(static)

    def get(self, force: bool = False, need: int = 0) -> str:
        """The token, minted afresh if forced, if none is held yet, or if it has less than
        max(60, `need`) seconds left."""
        if self._static:
            return self._static
        if force or self._token is None or self._exp - time.time() < max(MARGIN_S, need):
            # Only stdout is piped: stderr carries mocactl's reason ("log in first") to the user.
            r = subprocess.run(shlex.split(self._command), stdout=subprocess.PIPE, text=True)
            if r.returncode != 0:
                # Never echo stdout: on success it IS the token.
                raise RuntimeError(f"token command failed with exit {r.returncode}: {self._command}")
            self._token = r.stdout.strip()
            self._iat, self._exp = _times_of(self._token)
            self.mints += 1
        return self._token

    def lifetime(self) -> int:
        """`exp - iat` of the token held (fetching one if none is); 0 if it cannot be read."""
        if self._token is None:
            self.get()
        return self._exp - self._iat if self._iat and self._exp > self._iat else 0

    def remaining(self) -> float | None:
        """Seconds until the held token's `exp`, by this machine's clock; None if it cannot be read."""
        return self._exp - time.time() if self._exp else None


def _times_of(token: str) -> tuple[int, int]:
    """(iat, exp), read without verifying: the relay verifies, the client only schedules."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return int(claims.get("iat", 0)), int(claims["exp"])
    except (IndexError, KeyError, TypeError, ValueError):
        return 0, 0  # unreadable: treat as already expiring, so the next get() refreshes


class Sandbox:
    """One sandbox: one workspace on one worker. Every exec runs `bash -c` in /workspace, in a fresh VM."""

    def __init__(self, addr: str, sandbox_id: str, workspace_key: str, tokens: TokenSource,
                 tls: bool = True, ca_file: str | None = None):
        if tls:
            # root_certificates REPLACES the default roots: SBX_CA_FILE alone when set, else the defaults.
            roots = None
            if ca_file:
                with open(ca_file, "rb") as f:
                    roots = f.read()
            channel = grpc.secure_channel(addr, grpc.ssl_channel_credentials(root_certificates=roots), options=CHANNEL_OPTIONS)
        else:
            channel = grpc.insecure_channel(addr, options=CHANNEL_OPTIONS)
        self._stub = sandbox_pb2_grpc.SandboxExecStub(channel)
        self._sandbox_id, self._key, self._tokens = sandbox_id, workspace_key, tokens

    @classmethod
    def from_env(cls, env=os.environ) -> "Sandbox":
        """The variables `mocactl sbx env <id>` prints. SBX_TOKEN (a one-off static token) is used
        only when there is no SBX_TOKEN_CMD, so a leftover one never stops the refresh."""
        command = env.get("SBX_TOKEN_CMD") or None
        tokens = TokenSource(command=command, static=None if command else env.get("SBX_TOKEN"))
        return cls(env["SBX_ADDR"], env["SBX_SANDBOX_ID"], env["SBX_WORKSPACE_KEY"], tokens,
                   tls=env.get("SBX_TLS", "1") == "1", ca_file=env.get("SBX_CA_FILE") or None)

    def _md(self, force: bool = False, need: int = 0):
        return [("authorization", f"Bearer {self._tokens.get(force, need)}")]

    def _prepare(self, requested: int | None) -> tuple[list, int, bool]:
        """Token freshness (SBX0 §6.5): the metadata, the timeout to send, and whether a requested
        timeout was cut. `timeout_s` defaults to, and is capped at, the token lifetime minus 60 s,
        and the token must have the timeout plus 60 s left, or the relay cancels the Exec at its
        `exp` (§3.6)."""
        before = self._tokens.mints
        life = self._tokens.lifetime()
        if life:
            cap = max(1, life - MARGIN_S)
            timeout, capped = (cap, False) if requested is None else (min(requested, cap), requested > cap)
        else:
            timeout, capped = (requested or 120), False  # a token without iat: no lifetime to cap at
        # Mint at most once per Exec: a token minted just now is as fresh as one can be.
        token = self._tokens.get(need=0 if self._tokens.mints > before else timeout + MARGIN_S)
        # Even a fresh token may not cover it: one minted near the sandbox's expiry is shorter, and
        # clocks differ. Then the timeout is cut to what the token has left, less 60 s.
        left = self._tokens.remaining()
        if left is not None and timeout + MARGIN_S > left:
            cut = max(1, math.ceil(left) - MARGIN_S)  # ceil: a token minted this instant keeps its full cap
            if cut < timeout:
                timeout, capped = cut, capped or requested is not None
        return [("authorization", f"Bearer {token}")], timeout, capped

    def exec(self, command: str, stdin: bytes = b"", timeout_s: int | None = None) -> Result:
        md, timeout, capped = self._prepare(timeout_s)
        # Unique within the sandbox; it is also what abort() targets. The relay namespaces it per
        # sandbox, so it cannot collide with another user's. The proto says uint64, but the relay
        # decodes it as a JavaScript number, so keep it below 2**53 or the call is refused.
        req_id = secrets.randbits(53)
        try:
            r = self._exec(req_id, command, stdin, timeout, md)
        except _NotStarted:
            # The token was refused before anything ran: refresh once and retry. A command that had
            # STARTED is never re-run (SBX0 §6.5) -- that path raises SandboxError instead.
            try:
                r = self._exec(req_id, command, stdin, timeout, self._md(force=True))
            except _NotStarted:
                raise SandboxError(
                    "exec failed: UNAUTHENTICATED: exec authentication failed (after one token refresh)") from None
        r.timeout_s, r.capped = timeout, capped
        return r

    def _exec(self, req_id, command, stdin, timeout_s, md) -> Result:
        events = self._stub.Exec(
            sandbox_pb2.ExecRequest(
                sandbox_id=self._sandbox_id,
                exec=sandbox_pb2.Exec(req_id=req_id, command=command, stdin=stdin, timeout_s=timeout_s,
                                      streaming=True, workspace_key=self._key),
            ),
            metadata=md,
        )
        out, err, started = bytearray(), bytearray(), False
        try:
            for ev in events:
                started = True
                kind = ev.WhichOneof("event")
                if kind == "chunk":
                    (err if ev.chunk.stream == sandbox_pb2.STREAM_STDERR else out).extend(ev.chunk.data)
                elif kind == "end":
                    return Result(bytes(out), bytes(err), ev.end.exit_code, ev.end.truncated)
                elif kind == "error":
                    if TIMEOUT_MESSAGE.fullmatch(ev.error.message):
                        # An outcome, not a failure: the command ran out of time.
                        return Result(bytes(out), bytes(err), 124, False, timed_out=True)
                    # The machinery failed (VM boot, worker gone): not the command's exit status.
                    raise SandboxError(f"exec failed: {ev.error.message}")
        except KeyboardInterrupt:
            self.abort(req_id)
            raise
        except grpc.RpcError as e:
            code, details = e.code(), e.details() or ""
            if code == grpc.StatusCode.UNAUTHENTICATED and not started:
                raise _NotStarted() from None
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                raise TokenExpiredDuringExec(
                    f"{details or 'sandbox token expired during the Exec'}: the command outlived its "
                    f"token and was cancelled; give it a shorter timeout") from None
            if code == grpc.StatusCode.RESOURCE_EXHAUSTED and details.startswith("sandbox busy"):
                raise SandboxBusy(
                    f"{details}: nothing ran; retry once a running command finishes") from None
            raise SandboxError(f"exec failed: {code.name}: {details}") from None
        raise SandboxError("exec stream ended without an End event")

    def abort(self, req_id: int) -> None:
        self._stub.Abort(sandbox_pb2.AbortRequest(sandbox_id=self._sandbox_id, req_id=req_id), metadata=self._md())

    # Files are just commands: there is no file RPC in sandbox/v1.
    def write_file(self, path: str, data: bytes) -> None:
        r = self.exec(f'mkdir -p "$(dirname -- {_q(path)})" && cat > {_q(path)}', stdin=data, timeout_s=120)
        if r.exit_code != 0:
            raise SandboxError(f"write {path} failed: {r.stderr.decode(errors='replace')}")

    def read_file(self, path: str) -> bytes:
        r = self.exec(f"cat -- {_q(path)}", timeout_s=120)
        if r.exit_code != 0 or r.truncated:
            raise SandboxError(f"read {path} failed: {r.stderr.decode(errors='replace')}")
        return r.stdout


class _NotStarted(Exception):
    pass


def _q(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    sbx = Sandbox.from_env()
    sbx.write_file("hello.py", b"print('hello from the sandbox')\n")
    print(sbx.read_file("hello.py").decode(), end="")
    r = sbx.exec("python3 hello.py; ls -la; exit 3", timeout_s=120)
    print(r.stdout.decode(), end="")
    print(f"exit={r.exit_code} truncated={r.truncated} timed_out={r.timed_out}", file=sys.stderr)
