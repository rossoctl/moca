"""Offline tests for the example client and sbx.py: no network, no relay. Run from docs/api/examples,
after generating the stubs (see sandbox_v1_client.py):
    python -m unittest test_sandbox_v1_client
"""

import base64
import contextlib
import io
import json
import subprocess
import sys
import time
import unittest
from unittest import mock

import grpc

import sbx
from sandbox.v1 import sandbox_pb2
from sandbox_v1_client import Sandbox, SandboxBusy, SandboxError, TokenExpiredDuringExec, TokenSource


def jwt(exp: int, iat: int | None = None) -> str:
    seg = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
    claims = {"exp": exp} if iat is None else {"exp": exp, "iat": iat}
    return f"{seg({'alg': 'EdDSA', 'typ': 'moca-sandbox+jwt'})}.{seg(claims)}.sig"


def cmd(token: str) -> str:
    return f"{sys.executable} -c 'print(\"{token}\")'"


class TokenSourceTest(unittest.TestCase):
    def test_runs_the_command_and_caches_until_near_expiry(self):
        far = jwt(int(time.time()) + 900)
        ts = TokenSource(command=cmd(far))
        self.assertEqual(ts.get(), far)
        ts._command = cmd("other")  # a second run would return this
        self.assertEqual(ts.get(), far)

    def test_refreshes_within_60_seconds_of_expiry(self):
        soon = jwt(int(time.time()) + 30)
        ts = TokenSource(command=cmd(soon))
        ts.get()
        fresh = jwt(int(time.time()) + 900)
        ts._command = cmd(fresh)
        self.assertEqual(ts.get(), fresh)

    def test_force_refreshes(self):
        far = jwt(int(time.time()) + 900)
        ts = TokenSource(command=cmd(far))
        ts.get()
        other = jwt(int(time.time()) + 901)
        ts._command = cmd(other)
        self.assertEqual(ts.get(force=True), other)

    def test_a_static_token_is_never_refreshed(self):
        ts = TokenSource(static="tok")
        self.assertEqual(ts.get(force=True), "tok")

    def test_a_failing_command_raises_without_the_output(self):
        # The marker only exists in the OUTPUT ('sec' + 'retish'); the message may name the command.
        ts = TokenSource(command=f"{sys.executable} -c 'import sys; print(\"sec\" + \"retish\"); sys.exit(3)'")
        with self.assertRaises(RuntimeError) as e:
            ts.get()
        self.assertNotIn("secretish", str(e.exception))

    def test_the_token_commands_stderr_is_not_captured(self):
        # mocactl's reason ("log in first") must reach the user: only stdout, the token, is piped.
        with mock.patch("sandbox_v1_client.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 4, stdout="secretish")
            with self.assertRaises(RuntimeError) as e:
                TokenSource(command="mocactl sbx token sbx-0f3a").get()
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs.get("stdout"), subprocess.PIPE)
        self.assertNotIn("stderr", kwargs)
        self.assertNotIn("capture_output", kwargs)
        self.assertNotIn("secretish", str(e.exception))

    def test_refreshes_when_the_token_has_less_life_left_than_needed(self):
        now = int(time.time())
        ts = TokenSource(command=cmd(jwt(now + 300, now - 600)))
        ts.get()
        fresh = jwt(now + 900, now)
        ts._command = cmd(fresh)
        self.assertNotEqual(ts.get(need=200), fresh)  # 300 s left covers 200
        self.assertEqual(ts.get(need=400), fresh)

    def test_lifetime_is_exp_minus_iat(self):
        now = int(time.time())
        ts = TokenSource(command=cmd(jwt(now + 400, now - 500)))
        self.assertEqual(ts.lifetime(), 900)


class FakeRpcError(grpc.RpcError):
    def __init__(self, code: grpc.StatusCode, details: str):
        self._code, self._details = code, details

    def code(self):
        return self._code

    def details(self):
        return self._details


def chunk(data: bytes, stream=sandbox_pb2.STREAM_STDOUT):
    return sandbox_pb2.ExecEvent(chunk=sandbox_pb2.Chunk(data=data, stream=stream))


def end(code: int = 0):
    return sandbox_pb2.ExecEvent(end=sandbox_pb2.End(exit_code=code))


def error(message: str):
    return sandbox_pb2.ExecEvent(error=sandbox_pb2.ExecError(message=message))


class FakeStub:
    """Stands in for SandboxExecStub. Each script is a list of events, or an exception to raise
    after them; one script per Exec call, in order."""

    def __init__(self, *scripts):
        self.scripts, self.calls = list(scripts), []

    def Exec(self, request, metadata):
        self.calls.append((request, dict(metadata)["authorization"].removeprefix("Bearer ")))
        script = self.scripts.pop(0)

        def events():
            for item in script:
                if isinstance(item, Exception):
                    raise item
                yield item

        return events()

    def Abort(self, request, metadata):
        return sandbox_pb2.AbortResponse()


def sandbox(stub: FakeStub, tokens: TokenSource) -> Sandbox:
    # An insecure channel to an unresolvable name: grpc connects lazily, and the fake stub means it
    # never does.
    s = Sandbox("example.invalid:443", "sbx_py312", "sbx-0f3a", tokens, tls=False)
    s._stub = stub
    return s


def fresh_tokens(life_left: int = 900, lifetime: int = 900) -> TokenSource:
    now = int(time.time())
    return TokenSource(command=cmd(jwt(now + life_left, now + life_left - lifetime)))


INTERNAL_AFTER_ERROR = FakeRpcError(grpc.StatusCode.INTERNAL, "timeout:5")


class SandboxExecTest(unittest.TestCase):
    def test_sends_the_ids_exactly_with_a_53_bit_req_id(self):
        stub = FakeStub([end(0)])
        sandbox(stub, fresh_tokens()).exec("true")
        req = stub.calls[0][0]
        self.assertEqual(req.sandbox_id, "sbx_py312")
        self.assertEqual(req.exec.workspace_key, "sbx-0f3a")
        self.assertTrue(req.exec.streaming)
        self.assertLess(req.exec.req_id, 2**53)

    def test_an_end_event_is_the_commands_outcome(self):
        stub = FakeStub([chunk(b"out"), chunk(b"err", sandbox_pb2.STREAM_STDERR), end(3)])
        r = sandbox(stub, fresh_tokens()).exec("exit 3")
        self.assertEqual((r.stdout, r.stderr, r.exit_code, r.timed_out), (b"out", b"err", 3, False))

    def test_exec_error_timeout_is_a_timeout_not_a_failure(self):
        stub = FakeStub([chunk(b"partial"), error("timeout:5"), INTERNAL_AFTER_ERROR])
        r = sandbox(stub, fresh_tokens()).exec("sleep 10", timeout_s=5)
        self.assertTrue(r.timed_out)
        self.assertEqual(r.exit_code, 124)
        self.assertEqual(r.stdout, b"partial")

    def test_any_other_exec_error_is_a_machinery_failure(self):
        stub = FakeStub([error("vm boot failed"), FakeRpcError(grpc.StatusCode.INTERNAL, "vm boot failed")])
        with self.assertRaises(SandboxError) as e:
            sandbox(stub, fresh_tokens()).exec("true")
        self.assertIn("vm boot failed", str(e.exception))

    def test_deadline_exceeded_means_the_token_expired_during_the_exec(self):
        details = "sandbox token expired during the Exec"
        stub = FakeStub([chunk(b"x"), FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, details)])
        with self.assertRaises(TokenExpiredDuringExec) as e:
            sandbox(stub, fresh_tokens()).exec("sleep 900")
        self.assertIn("sandbox token expired during the Exec", str(e.exception))

    def test_resource_exhausted_means_the_sandbox_is_busy(self):
        details = "sandbox busy: 2 Execs already in flight"
        stub = FakeStub([FakeRpcError(grpc.StatusCode.RESOURCE_EXHAUSTED, details)])
        with self.assertRaises(SandboxBusy) as e:
            sandbox(stub, fresh_tokens()).exec("true")
        self.assertIn("sandbox busy", str(e.exception))
        self.assertEqual(len(stub.calls), 1)  # never retried

    # iat and exp are whole seconds, so by the time an Exec is prepared a just-minted token may have
    # up to a second or two less than its lifetime left; the client then cuts that too.
    def test_timeout_defaults_to_the_token_lifetime_minus_60(self):
        stub = FakeStub([end(0)])
        r = sandbox(stub, fresh_tokens(lifetime=900)).exec("true")
        self.assertIn(stub.calls[0][0].exec.timeout_s, (838, 839, 840))
        self.assertEqual((r.timeout_s, r.capped), (stub.calls[0][0].exec.timeout_s, False))

    def test_a_longer_timeout_is_capped_and_says_so(self):
        stub = FakeStub([end(0)])
        r = sandbox(stub, fresh_tokens(lifetime=900)).exec("true", timeout_s=1800)
        self.assertIn(stub.calls[0][0].exec.timeout_s, (838, 839, 840))
        self.assertEqual((r.timeout_s, r.capped), (stub.calls[0][0].exec.timeout_s, True))

    def test_the_cap_holds_when_the_local_clock_is_behind_the_issuer(self):
        # iat 100 s in the local future: the token has 1000 s left by this clock, but its lifetime is
        # still 900, so the cap is 840.
        now = int(time.time())
        stub = FakeStub([end(0)])
        r = sandbox(stub, TokenSource(command=cmd(jwt(now + 1000, now + 100)))).exec("true", timeout_s=1800)
        self.assertEqual(stub.calls[0][0].exec.timeout_s, 840)
        self.assertTrue(r.capped)

    def test_a_token_that_cannot_be_refreshed_cuts_the_timeout_to_its_life_left(self):
        # A static token (SBX_TOKEN) with 300 s left: the Exec gets at most 240 s, and says so.
        now = int(time.time())
        stub = FakeStub([end(0)])
        r = sandbox(stub, TokenSource(static=jwt(now + 300, now - 600))).exec("true", timeout_s=600)
        self.assertLessEqual(stub.calls[0][0].exec.timeout_s, 240)
        self.assertGreaterEqual(stub.calls[0][0].exec.timeout_s, 238)
        self.assertTrue(r.capped)

    def test_the_cap_is_the_lifetime_minus_60_not_what_is_left(self):
        # A token with 500 s left of a 900 s lifetime: the cap is still 840, so a default Exec needs
        # a fresh token rather than a shorter timeout.
        tokens = fresh_tokens(life_left=500, lifetime=900)
        tokens.get()
        now = int(time.time())
        tokens._command = cmd(jwt(now + 900, now))
        stub = FakeStub([end(0)])
        r = sandbox(stub, tokens).exec("true")
        self.assertGreaterEqual(r.timeout_s, 838)
        self.assertEqual(tokens.mints, 2)

    def test_mints_a_fresh_token_when_the_exec_needs_more_time_than_is_left(self):
        tokens = fresh_tokens(life_left=300, lifetime=900)
        stale = tokens.get()
        now = int(time.time())
        fresh = jwt(now + 900, now)
        tokens._command = cmd(fresh)
        stub = FakeStub([end(0)], [end(0)])
        s = sandbox(stub, tokens)
        s.exec("true", timeout_s=200)  # 300 s left covers 200 + 60
        self.assertEqual(stub.calls[0][1], stale)
        s.exec("true", timeout_s=600)  # it does not cover 600 + 60
        self.assertEqual(stub.calls[1][1], fresh)

    def test_the_default_timeout_does_not_mint_twice_for_a_just_minted_token(self):
        now = int(time.time())
        tokens = TokenSource(command=cmd(jwt(now + 900, now)))
        stub = FakeStub([end(0)])
        with mock.patch("sandbox_v1_client.subprocess.run", wraps=subprocess.run) as run:
            r = sandbox(stub, tokens).exec("true")
        self.assertEqual(run.call_count, 1)
        # What is sent always leaves 60 s of the token's life spare.
        self.assertLessEqual(stub.calls[0][0].exec.timeout_s + 60, 900)
        self.assertGreaterEqual(r.timeout_s, 838)
        self.assertFalse(r.capped)

    def test_a_token_capped_at_the_sandboxs_expiry_caps_the_timeout_and_says_so(self):
        # The sandbox expires in 200 s, so every minted token has at most 200 s left.
        now = int(time.time())
        tokens = TokenSource(command=cmd(jwt(now + 200, now)))
        stub = FakeStub([end(0)])
        r = sandbox(stub, tokens).exec("true", timeout_s=600)
        self.assertLessEqual(stub.calls[0][0].exec.timeout_s, 140)
        self.assertTrue(r.capped)

    def test_unauthenticated_before_any_event_refreshes_and_retries_once(self):
        tokens = fresh_tokens()
        first = tokens.get()
        now = int(time.time())
        second = jwt(now + 901, now + 1)
        tokens._command = cmd(second)
        stub = FakeStub([FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "exec authentication failed")], [end(0)])
        r = sandbox(stub, tokens).exec("true", timeout_s=60)  # short enough not to need a fresh token
        self.assertEqual(r.exit_code, 0)
        self.assertEqual([c[1] for c in stub.calls], [first, second])
        self.assertEqual(stub.calls[0][0].exec.req_id, stub.calls[1][0].exec.req_id)

    def test_a_second_unauthenticated_after_the_refresh_is_a_sandbox_error(self):
        u = FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "exec authentication failed")
        stub = FakeStub([u], [u])
        with self.assertRaises(SandboxError) as e:
            sandbox(stub, fresh_tokens()).exec("true", timeout_s=60)
        self.assertEqual(str(e.exception),
                         "exec failed: UNAUTHENTICATED: exec authentication failed (after one token refresh)")
        self.assertEqual(len(stub.calls), 2)

    def test_a_started_command_is_never_re_run(self):
        stub = FakeStub([chunk(b"x"), FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "exec authentication failed")])
        with self.assertRaises(SandboxError):
            sandbox(stub, fresh_tokens()).exec("true")
        self.assertEqual(len(stub.calls), 1)


class FromEnvTest(unittest.TestCase):
    def test_reads_what_mocactl_sbx_env_prints(self):
        env = {
            "SBX_ADDR": "example.invalid:443",
            "SBX_TLS": "1",
            "SBX_SANDBOX_ID": "sbx_py312",
            "SBX_WORKSPACE_KEY": "sbx-0f3a",
            "SBX_TOKEN_CMD": "mocactl sbx token --control-plane-url 'https://example.invalid' sbx-0f3a",
        }
        s = Sandbox.from_env(env)
        self.assertEqual((s._sandbox_id, s._key), ("sbx_py312", "sbx-0f3a"))
        self.assertEqual(s._tokens._command, env["SBX_TOKEN_CMD"])
        with mock.patch("sandbox_v1_client.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout=jwt(int(time.time()) + 900))
            s._tokens.get()
        self.assertEqual(run.call_args.args[0], [
            "mocactl", "sbx", "token", "--control-plane-url", "https://example.invalid", "sbx-0f3a"])

    def test_the_token_command_wins_over_a_leftover_static_token(self):
        env = {"SBX_ADDR": "example.invalid:443", "SBX_SANDBOX_ID": "w", "SBX_WORKSPACE_KEY": "k",
               "SBX_TOKEN_CMD": "mocactl sbx token sbx-0f3a", "SBX_TOKEN": "stale"}
        s = Sandbox.from_env(env)
        self.assertEqual((s._tokens._command, s._tokens._static), (env["SBX_TOKEN_CMD"], None))

    def test_a_static_token_alone_is_used(self):
        env = {"SBX_ADDR": "example.invalid:443", "SBX_SANDBOX_ID": "w", "SBX_WORKSPACE_KEY": "k",
               "SBX_TOKEN": "one-off"}
        self.assertEqual(Sandbox.from_env(env)._tokens.get(), "one-off")


class SbxCliTest(unittest.TestCase):
    def run_sbx(self, *scripts):
        stub = FakeStub(*scripts)
        out, err = io.TextIOWrapper(io.BytesIO()), io.TextIOWrapper(io.BytesIO())
        with mock.patch.object(sbx, "sandbox", lambda: sandbox(stub, fresh_tokens())), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sbx.run("cmd")
        err.flush()
        return code, err.buffer.getvalue().decode()

    def test_exits_with_the_commands_exit_code(self):
        self.assertEqual(self.run_sbx([end(7)])[0], 7)

    def test_a_timeout_exits_124(self):
        code, err = self.run_sbx([error("timeout:5"), INTERNAL_AFTER_ERROR])
        self.assertEqual(code, 124)
        self.assertIn("timed out", err)

    def test_a_busy_sandbox_exits_125_saying_so(self):
        code, err = self.run_sbx([FakeRpcError(grpc.StatusCode.RESOURCE_EXHAUSTED, "sandbox busy: 2 Execs already in flight")])
        self.assertEqual(code, 125)
        self.assertIn("sandbox busy", err)

    def test_a_token_expiring_mid_exec_exits_125_saying_so(self):
        details = "sandbox token expired during the Exec"
        code, err = self.run_sbx([FakeRpcError(grpc.StatusCode.DEADLINE_EXCEEDED, details)])
        self.assertEqual(code, 125)
        self.assertIn("sandbox token expired during the Exec", err)

    def test_a_second_unauthenticated_exits_125(self):
        u = FakeRpcError(grpc.StatusCode.UNAUTHENTICATED, "exec authentication failed")
        code, err = self.run_sbx([u], [u])
        self.assertEqual(code, 125)
        self.assertIn("after one token refresh", err)

    def test_a_signal_exits_128_plus_its_number(self):
        self.assertEqual(self.run_sbx([end(-15)])[0], 128 + 15)
        self.assertEqual(self.run_sbx([end(-9)])[0], 128 + 9)

    def test_a_machinery_failure_exits_125(self):
        code, _ = self.run_sbx([FakeRpcError(grpc.StatusCode.UNKNOWN, "no live worker for sandbox 'sbx_py312'")])
        self.assertEqual(code, 125)


if __name__ == "__main__":
    unittest.main()
