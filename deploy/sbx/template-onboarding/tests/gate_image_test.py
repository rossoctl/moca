"""Tests for deploy/sbx/template-onboarding/gate-image.py, the general gate (GUIDE.md §4b.5).

The contract, the verdict, the record the control plane reads (X1, X1.image, X1.offline, X12), the
template spec it writes, and one run of the CLI end to end against a fake podman on PATH (so no
engine, image or network is needed). Python 3's standard library only:

    python3 -m unittest discover -s deploy/sbx/template-onboarding/tests -p 'gate_image_test.py'
"""

import copy
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from pathlib import Path

TPL = Path(__file__).resolve().parent.parent
TOOL = TPL / "gate-image.py"
_spec = importlib.util.spec_from_file_location("gate_image", TOOL)
gg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gg)

DIGEST = "sha256:" + "a" * 64
CONTRACT = {"schema": gg.INPUT_SCHEMA, "image": f"team/app@{DIGEST}", "workdir": "/app",
            "test_cmd": "pytest -q tests/", "floor": {"rc": 0, "passed_at_least": 10}}
NET = {**CONTRACT, "network_needed": True}


def good_obs():
    return {"etc_hosts_exported_sha256": gg.HOSTS_SHA256,
            "guest": {"id": "root 0", "missing_tools": [], "rootfs": "readonly", "credential_env_names": [],
                      "git_identity": "none"},
            "testbed": {"git_tree": "true", "commit_count": "1", "git_status_lines": "0", "agent_can_commit": "no"},
            "run": {"rc": 0, "passed": 12, "failed": None, "ms": 900}}


def rec(obs=None, c=CONTRACT):
    o = obs or good_obs()
    return gg.record(c, o, gg.check(o, c), builder={"arch": "x86_64", "engine": "podman 5"},
                     built_at="2026-11-20T00:00:00Z", tool={"name": "gate-image.py", "commit": None})


class Contract(unittest.TestCase):
    def test_a_good_contract_is_accepted(self):
        self.assertEqual(gg.contract_problems(CONTRACT), [])

    def test_a_bad_contract_is_refused(self):
        for change, says in [
            ({"image": "team/app:latest"}, "pinned"),
            ({"workdir": "app"}, "workdir"),
            ({"workdir": "/"}, "workdir"),
            ({"workdir": "/workspace"}, "workdir"),
            ({"workdir": "/a/../b"}, "workdir"),
            ({"test_cmd": " "}, "test_cmd"),
            ({"floor": {}}, "floor"),
            ({"floor": {"rc": -1}}, "floor"),
            ({"floor": {"rc": True}}, "floor"),
            ({"floor": {"pass": 3}}, "floor"),
            ({"absent_sha256": ["nothex"]}, "absent_sha256"),
            ({"probe": {"cmd": "pytest x"}}, "public"),
            ({"tools": ["bash", "bash"]}, "tools"),
            ({"tools": ["rm -rf"]}, "tools"),
            ({"extra": 1}, "unknown"),
            ({"schema": "x"}, "schema"),
            ({"network_needed": False}, "network_needed"),
            ({"network_needed": "yes"}, "network_needed"),
        ]:
            with self.subTest(change=change):
                self.assertTrue(any(says in p for p in gg.contract_problems({**CONTRACT, **change})))

    def test_the_required_tools_are_the_listed_ones_plus_the_guest_agents_minimum(self):
        self.assertEqual(gg.required_tools(CONTRACT),
                         sorted({"bash", "git", "python3", "rg", "ls", "cat", "base64", "file"}))
        self.assertNotIn("gh", gg.required_tools(CONTRACT))                     # GATING-RULES.md M3

    def test_the_minimum_is_template_builds(self):
        # template-build.sh's required tools are the spec's plus the guest agent's minimum (M3).
        text = (TPL / "template-build.sh").read_text()
        want = "[.tools[]] + " + json.dumps(list(gg.MINIMUM_TOOLS), separators=(",", ":"))
        self.assertTrue(want in text, f"template-build.sh no longer adds {want}")


class Verdict(unittest.TestCase):
    def test_a_good_image_passes(self):
        self.assertEqual(gg.check(good_obs(), CONTRACT), [])

    def test_the_gate_refuses(self):
        for mutate, says in [
            (lambda o: o.update(etc_hosts_exported_sha256="0" * 64), "/etc/hosts"),
            (lambda o: o["guest"].update(id="nobody 65534"), "root 0"),
            (lambda o: o["guest"].update(rootfs="writable"), "writable"),
            (lambda o: o["guest"].update(missing_tools=["rg"]), "missing"),
            (lambda o: o["guest"].update(credential_env_names=["API_KEY"]), "credential"),
            (lambda o: o["guest"].update(git_identity="Bot"), "identity"),
            (lambda o: o["testbed"].update(agent_can_commit="yes"), "commit"),
            (lambda o: o["testbed"].update(git_status_lines="3"), "not clean"),
            (lambda o: o["run"].update(rc=1), "exited 1"),
            (lambda o: o["run"].update(passed=9), "at least 10"),
            (lambda o: o["run"].update(passed=None), "at least 10"),
        ]:
            with self.subTest(says=says):
                o = good_obs()
                mutate(o)
                self.assertTrue(any(says in p for p in gg.check(o, CONTRACT)))

    def test_a_tree_that_is_not_git_is_not_held_to_a_clean_status(self):
        o = good_obs()
        o["testbed"].update(git_tree="no", git_status_lines="0")
        self.assertEqual(gg.check(o, CONTRACT), [])

    def test_an_rc_only_floor_ignores_the_counts(self):
        o = good_obs()
        o["run"].update(passed=None)
        self.assertEqual(gg.check(o, {**CONTRACT, "floor": {"rc": 0}}), [])

    def test_absent_files_are_counted_never_listed(self):
        c = {**CONTRACT, "absent_sha256": ["b" * 64]}
        o = good_obs()
        self.assertTrue(any("must be absent" in p for p in gg.check(o, c)))      # not scanned: refused
        o["absence"] = {"files_scanned": 4000, "absent_hits": 0}
        self.assertEqual(gg.check(o, c), [])
        o["absence"]["absent_hits"] = 2
        self.assertTrue(any("2 files" in p for p in gg.check(o, c)))

    def test_the_scan_takes_its_shas_from_a_file_not_the_command_line(self):
        cmd = gg.scan_cmd("/tmp/.gate-absent")
        self.assertNotIn("b" * 64, cmd)
        self.assertIn("grep -cFxf /tmp/.gate-absent", cmd)

    def test_a_timed_out_test_or_probe_is_a_stated_reason(self):
        o = good_obs()
        o["run"] = {**gg.run_counts(None, ""), "timed_out_s": 2400}
        self.assertIn("the test command timed out after 2400 s", gg.check(o, CONTRACT))
        c = {**CONTRACT, "probe": {"cmd": "x", "public": True}}
        o = good_obs()
        o["probe"] = {**gg.run_counts(None, ""), "timed_out_s": 900}
        self.assertIn("the probe timed out after 900 s", gg.check(o, c))

    def test_run_rc_turns_a_timeout_into_a_record_not_a_traceback(self):
        g = gg.Guest.__new__(gg.Guest)                     # no container: ex is replaced
        def ex(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
        g.ex = ex
        self.assertEqual(g.run_rc("sleep 9", 5), {"rc": None, "passed": None, "failed": None,
                                                    "summary_lines": [], "timed_out_s": 5})

    def test_a_contracted_probe_must_have_run(self):
        c = {**CONTRACT, "probe": {"cmd": "pytest -q tests/test_public.py", "public": True}}
        self.assertTrue(any("probe" in p for p in gg.check(good_obs(), c)))


class Guest(unittest.TestCase):
    def test_guest_commands_drop_the_image_env_and_run_in_the_workspace(self):
        cmd = gg.guest("pytest -q")
        self.assertTrue(cmd.startswith(f"env -i PATH={gg.GUEST_PATH} HOME={gg.GUEST_HOME} "))
        self.assertIn("cd /workspace && pytest -q", cmd)

    def test_the_emulation_is_offline_read_only_and_root(self):
        f = gg.EMULATION_FLAGS
        self.assertIn("--read-only", f)
        self.assertEqual(f[f.index("--network") + 1], "none")
        self.assertEqual(f[f.index("--user") + 1], "0")

    def test_parse_reads_the_probes(self):
        raw = {"id": "root 0\n", "env_names": "HOME\nPATH\nGITHUB_TOKEN\n", "missing_tools": "rg\n",
               "rootfs": "readonly\n", "git_identity": "none\n", "git_tree": "true\n", "commit_count": "1\n",
               "git_status_lines": "0\n", "agent_can_commit": "no\n"}
        o = gg.parse(raw)
        self.assertEqual(o["credential_env_names"], ["GITHUB_TOKEN"])
        self.assertEqual(o["missing_tools"], ["rg"])
        self.assertEqual(gg.parse_testbed(raw)["agent_can_commit"], "no")


class Counts(unittest.TestCase):
    def test_counts_come_from_pytest_or_unittest_and_never_default_to_zero(self):
        self.assertEqual(gg.run_counts(0, "== 12 passed in 0.5s =="),
                         {"rc": 0, "passed": 12, "failed": None, "summary_lines": ["== 12 passed in 0.5s =="]})
        self.assertEqual(gg.run_counts(0, "Ran 7 tests in 0.1s\n\nOK\n")["passed"], 7)
        self.assertIsNone(gg.run_counts(2, "ERROR: collection failed")["passed"])

    def test_the_last_pytest_summary_wins(self):
        # A suite that runs pytest in-process prints inner summaries; the outer, last one is read.
        self.assertEqual(gg.parse_pytest_counts("== 1 failed, 3 passed in 0.1s ==\n== 20 passed in 1.20s =="),
                         (None, 20))

    def test_a_wrapped_sympy_summary_is_read(self):
        out = ("============ tests finished: 30 passed, 1 skipped, 2 expected to fail,\n"
               "3 exceptions, in 1.50 seconds ============")
        self.assertEqual(gg.parse_pytest_counts(out), (3, 30))

    def test_unittest_skips_are_not_passes_and_an_interrupted_run_has_no_count(self):
        self.assertEqual(gg.parse_unittest_counts("Ran 10 tests in 1s\n\nFAILED (failures=1, skipped=2)\n"), (1, 7))
        self.assertEqual(gg.parse_unittest_counts("Ran 10 tests in 1s\n"), (None, None))

    def test_a_unittest_expectation_is_what_the_runner_printed_not_the_passed_count(self):
        # 10 passed, printed as `Ran 12 tests` and `OK (skipped=2)`: an expectation rebuilt from the count
        # ("10 passed") would fail the in-VM probe.
        out = "test_x (basic.tests.T) ... ok\n----\nRan 12 tests in 0.06s\n\nOK (skipped=2)\n"
        r = gg.run_counts(0, out)
        self.assertEqual(r["passed"], 10)
        self.assertEqual(r["summary_lines"], ["Ran 12 tests in 0.06s", "OK (skipped=2)"])
        self.assertEqual(gg.expectations(r["summary_lines"]), [r"^Ran 12 tests?\b", r"^OK\b"])

    def test_a_coloured_summary_is_kept_plain_so_its_expectation_matches(self):
        line = "\x1b[32m=== \x1b[1m8 passed\x1b[0m, \x1b[33m1 skipped\x1b[0m in 0.06s ===\x1b[0m"
        r = gg.run_counts(0, line)
        self.assertEqual(r["summary_lines"], ["=== 8 passed, 1 skipped in 0.06s ==="])
        self.assertEqual(gg.expectations(r["summary_lines"]), [r"\b8 passed\b"])

    def test_pytests_failed_items_never_reach_the_summary(self):
        # Its short summary names failing tests and their errors: judging material, never in a record.
        out = ("____ test_x ____\nE   AssertionError: boom\n"
               "=========================== short test summary info ============================\n"
               "FAILED tests/test_a.py::test_target - AssertionError: boom\n"
               "FAILED tests/test_a.py::test_other\n"
               "ERROR tests/test_b.py::test_setup - RuntimeError\n"
               "\x1b[31mFAILED\x1b[0m tests/test_a.py::test_coloured - x\n"
               "=================== 3 failed, 5 passed, 1 error in 0.20s ===================\n")
        r = gg.run_counts(1, out)
        self.assertEqual(r["summary_lines"], ["=================== 3 failed, 5 passed, 1 error in 0.20s ==================="])
        self.assertFalse(any("::" in ln or "Error" in ln for ln in r["summary_lines"]))
        self.assertEqual(gg.expectations(r["summary_lines"]), [r"\b3 failed\b", r"\b5 passed\b"])

    def test_unittests_verdict_is_kept_with_its_counts_only(self):
        out = "Ran 4 tests in 0.1s\n\nFAILED (failures=1)\nFAILED: something else\nOK then\n"
        self.assertEqual(gg.run_counts(1, out)["summary_lines"], ["Ran 4 tests in 0.1s", "FAILED (failures=1)"])

    def test_a_probe_with_no_summary_line_expects_its_rc_alone(self):
        self.assertEqual(gg.expectations([]), [])


class Record(unittest.TestCase):
    def test_the_record_has_the_fields_the_control_plane_reads(self):
        # packages/control-plane/src/template-policy.ts: X1, X1.image, X1.offline, X12.
        r = rec()
        self.assertEqual(r["schema"], "moca-gate-record/1")        # the default SH_GATE_RECORD_SCHEMA
        self.assertIs(r["gate"]["passed"], True)
        self.assertEqual(r["image"]["digest"], DIGEST)
        self.assertIs(r["gate"]["floor_checked_offline"], True)
        self.assertEqual(r["observed"]["testbed"]["agent_can_commit"], "no")
        self.assertEqual(r["observed"]["guest"]["git_identity"], "none")

    def test_a_failing_gate_writes_passed_false_and_its_reasons(self):
        o = good_obs()
        o["run"]["rc"] = 1
        r = rec(o)
        self.assertIs(r["gate"]["passed"], False)
        self.assertTrue(r["problems"])

    def test_the_record_never_carries_a_private_registry_host_or_the_test_command(self):
        r = rec(c={**CONTRACT, "image": f"registry.example.com:5000/team/app@{DIGEST}"})
        text = json.dumps(r)
        self.assertNotIn("registry.example.com", text)
        self.assertEqual(r["image"]["repository"], "team/app")
        self.assertNotIn(CONTRACT["test_cmd"], text)
        self.assertRegex(r["test_cmd_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(r["gate"]["network"], "none")

    def test_the_record_bytes_are_deterministic(self):
        # The control plane hashes the bytes (gateRecord): the same record, built twice, is the same bytes.
        a = gg.record_bytes(rec())
        reordered = dict(reversed(list(json.loads(a).items())))               # the same record, keys reordered
        self.assertEqual(gg.record_bytes(reordered), a)
        self.assertTrue(a.endswith("}\n") and not a.endswith("\n\n"))
        self.assertEqual(a, json.dumps(json.loads(a), indent=2, sort_keys=True) + "\n")

    def test_the_record_names_no_submitter(self):
        # Who submitted it is the control plane's to record (GATING-RULES.md §2.3).
        self.assertFalse({"subject", "signature", "submitter", "signed_by"} & set(rec()))

    def test_the_contract_hash_moves_with_any_input(self):
        self.assertNotEqual(rec()["contract_sha256"], rec(c={**CONTRACT, "floor": {"rc": 0}})["contract_sha256"])

    def test_the_contract_is_not_mutated(self):
        c = copy.deepcopy(CONTRACT)
        rec(c=c)
        self.assertEqual(c, CONTRACT)

    def test_a_public_registry_is_kept_and_any_other_host_dropped(self):
        for ref, kept in [
            (f"docker.io/library/python@{DIGEST}", "docker.io/library/python"),   # the allowlist names the host
            (f"ghcr.io/org/app@{DIGEST}", "ghcr.io/org/app"),
            (f"localhost:5056/app@{DIGEST}", "app"),                               # a test registry: dropped
            (f"registry.internal.example/team/x@{DIGEST}", "team/x"),              # a private one: dropped
            (f"team/app@{DIGEST}", "team/app"),                                    # no host named
        ]:
            with self.subTest(ref=ref):
                self.assertEqual(gg.repository(ref), kept)


class NetworkNeeded(unittest.TestCase):
    """network_needed: general-self only; the benchmark profiles refuse it (X1.offline)."""

    def test_without_it_the_floor_is_checked_offline_and_says_so(self):
        g = rec()["gate"]
        self.assertIs(g["floor_checked_offline"], True)
        self.assertIs(g["network_needed"], False)
        self.assertNotIn("floor_met_offline", g)

    def test_with_it_a_floor_missed_offline_does_not_fail_the_gate_and_the_record_says_so(self):
        o = good_obs()
        o["run"].update(rc=1, passed=0)                  # no network in the gate: the tests could not pass
        self.assertEqual(gg.contract_problems(NET), [])
        self.assertEqual(gg.check(o, NET), [])
        r = rec(o, NET)
        self.assertIs(r["gate"]["passed"], True)
        self.assertIs(r["gate"]["floor_checked_offline"], False)
        self.assertIs(r["gate"]["network_needed"], True)
        self.assertIs(r["gate"]["floor_met_offline"], False)
        self.assertEqual(r["observed"]["run"]["rc"], 1)
        self.assertEqual(r["gate"]["network"], "none")   # the gate itself still ran offline

    def test_it_relaxes_only_the_floor(self):
        o = good_obs()
        o["testbed"]["agent_can_commit"] = "yes"
        o["guest"]["credential_env_names"] = ["API_TOKEN"]
        probs = gg.check(o, NET)
        self.assertTrue(any("commit" in p for p in probs))
        self.assertTrue(any("credential" in p for p in probs))


class Spec(unittest.TestCase):
    def test_without_a_probe_the_spec_is_unmeasured_so_moca_refuses_it(self):
        s = gg.template_spec(CONTRACT, rec(), "team-app")
        self.assertEqual(s["probe_status"], "unmeasured")
        self.assertNotIn("probe", s)

    def test_with_a_public_probe_the_spec_carries_the_measured_expectation(self):
        c = {**CONTRACT, "probe": {"cmd": "pytest -q tests/test_public.py", "public": True}}
        o = good_obs()
        o["probe"] = {"rc": 0, "passed": 5, "failed": None, "summary_lines": ["===== 5 passed in 0.10s ====="]}
        s = gg.template_spec(c, rec(o, c), "team-app")
        self.assertEqual(s["probe_status"], "emulation")
        self.assertEqual((s["probe"]["expect_rc"], s["probe"]["expect"]), (0, [r"\b5 passed\b"]))

    def test_the_spec_meets_the_benchmark_profiles_rules(self):
        s = gg.template_spec(CONTRACT, rec(), "team-app")
        self.assertEqual(s["schema"], "moca-sbx-template-spec/1")
        self.assertEqual(s["source_record_digest"], DIGEST)                          # X10
        self.assertTrue(s["image"].endswith("@" + DIGEST))
        self.assertIs(s["egress"], False)                                             # X11
        self.assertIs(s["skip_git_identity_check"], True)                             # X12
        self.assertIs(s["guest_home_gitconfig"], False)                               # M8
        self.assertEqual((s["guest_ram_mb"], s["vcpus"]), (4096, 2))                  # X15
        self.assertEqual(s["etc_hosts_sha256"], gg.HOSTS_SHA256)                      # M10
        self.assertNotIn("profile", s)                                                # the create names it

    def test_the_spec_gets_egress_only_with_network_needed(self):
        self.assertIs(gg.template_spec(CONTRACT, rec(), "a")["egress"], False)
        self.assertIs(gg.template_spec(NET, rec(c=NET), "a")["egress"], True)

    def test_a_docker_hub_spec_names_its_host_as_the_allowlist_needs(self):
        c = {**CONTRACT, "image": f"docker.io/library/python@{DIGEST}"}
        self.assertEqual(gg.template_spec(c, rec(c=c), "py")["image"], f"docker.io/library/python@{DIGEST}")

    def test_the_hosts_file_is_the_guides(self):
        # GUIDE.md §4b.5.4's `hosts`, exactly: two lines, tab-separated.
        self.assertEqual(gg.HOSTS, "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n")
        self.assertIn("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n",
                      (TPL / "GUIDE.md").read_text())


# --- the CLI, end to end, against a fake podman -----------------------------------------------------

FAKE_PODMAN = textwrap.dedent(r'''
    #!/usr/bin/env python3
    # A fake podman for gate_image_test.py: canned answers, keyed by the subcommand and, for exec, by
    # what the gate's probe asks. Every call is logged to $FAKE_LOG.
    import io, json, os, sys, tarfile
    a = sys.argv[1:]
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps(a) + "\n")
    cfg = json.loads(os.environ["FAKE_CFG"])
    out = sys.stdout.write
    if a[:2] == ["image", "exists"]:
        sys.exit(0 if cfg.get("had") else 1)
    if a[0] == "pull":
        sys.exit(0)
    if a[:2] == ["image", "inspect"]:
        out(cfg["digest"] + "\n"); sys.exit(0)
    if a[0] == "create":
        out("ctr-export\n"); sys.exit(0)
    if a[0] == "export":
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as t:
            data = cfg["hosts"].encode()
            i = tarfile.TarInfo("etc/hosts"); i.size = len(data); t.addfile(i, io.BytesIO(data))
        sys.stdout.buffer.write(buf.getvalue()); sys.exit(0)
    if a[0] in ("rm", "rmi", "cp"):
        sys.exit(0)
    if a[0] == "--version":
        out("podman version 5.0.0\n"); sys.exit(0)
    if a[0] == "run":
        out("ctr-guest\n"); sys.exit(0)
    if a[0] == "exec":
        cmd = a[-1]
        answers = [("id -un", "root 0"), ("env | cut", "HOME\nPATH\nTERM"), ("command -v", ""),
                   ("touch /opt", "readonly"), ("rev-parse", "true"), ("rev-list", "1"),
                   ("status --porcelain", "0"), ("GIT_COMMITTER_IDENT", "no"), ("user.name", "none"),
                   ("__RC__", cfg["run"])]
        for key, answer in answers:
            if key in cmd:
                out(answer + "\n"); sys.exit(0)
        sys.exit(0)  # the seed, the workspace reset
    sys.exit(f"fake podman: unexpected {a}")
''').lstrip()


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        (bin_ / "podman").write_text(FAKE_PODMAN)
        (bin_ / "podman").chmod(0o755)
        self.log = self.tmp / "calls.log"
        self.env = {**os.environ, "PATH": f"{bin_}{os.pathsep}{os.environ['PATH']}", "FAKE_LOG": str(self.log)}

    def run_gate(self, contract, *, digest=DIGEST, hosts=gg.HOSTS, run="Ran 3 tests in 0.1s\n\nOK\n\n__RC__0",
                 extra=(), had=False):
        cpath = self.tmp / "contract.json"
        cpath.write_text(json.dumps(contract))
        env = {**self.env, "FAKE_CFG": json.dumps({"digest": digest, "hosts": hosts, "run": run, "had": had})}
        return subprocess.run([sys.executable, str(TOOL), str(cpath), "--out", str(self.tmp / "gate.json"),
                               *extra], capture_output=True, text=True, env=env, timeout=120)

    def calls(self):
        return [json.loads(ln) for ln in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_a_passing_image_gets_a_record_and_a_spec(self):
        c = {**CONTRACT, "floor": {"rc": 0, "passed_at_least": 3},
             "probe": {"cmd": "./runtests.py basic", "public": True}}
        p = self.run_gate(c, extra=["--template-id", "team-app", "--spec-out", str(self.tmp / "spec.json")])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        text = (self.tmp / "gate.json").read_text()
        self.assertEqual(text, gg.record_bytes(json.loads(text)))             # the stated serialisation
        self.assertIn(f"GATE PASS: {self.tmp / 'gate.json'} sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                      p.stdout)
        r = json.loads(text)
        self.assertEqual((r["schema"], r["gate"]["passed"], r["observed"]["run"]["passed"]),
                         ("moca-gate-record/1", True, 3))
        s = json.loads((self.tmp / "spec.json").read_text())
        self.assertEqual((s["id"], s["probe_status"], s["probe"]["expect"]),
                         ("team-app", "emulation", [r"^Ran 3 tests?\b", r"^OK\b"]))
        calls = self.calls()
        pull = next(a for a in calls if a[0] == "pull")
        self.assertEqual(pull[pull.index("--platform") + 1], "linux/amd64")
        guest = next(a for a in calls if a[0] == "run")
        for flag in ("--read-only", "--no-hosts"):
            self.assertIn(flag, guest)
        self.assertEqual(guest[guest.index("--network") + 1], "none")
        self.assertTrue(any(a[0] == "rmi" for a in calls))                    # a pulled image is removed

    def test_an_image_the_operator_already_had_is_kept(self):
        p = self.run_gate({**CONTRACT, "floor": {"rc": 0}}, had=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse(any(a[0] == "rmi" for a in self.calls()))

    def test_a_failing_image_still_gets_a_record_with_its_reasons_and_exit_1(self):
        p = self.run_gate({**CONTRACT, "floor": {"rc": 0}}, hosts="")         # an empty /etc/hosts
        self.assertEqual(p.returncode, 1)
        self.assertIn("GATE FAIL", p.stdout)
        r = json.loads((self.tmp / "gate.json").read_text())
        self.assertIs(r["gate"]["passed"], False)
        self.assertTrue(any("/etc/hosts" in x for x in r["problems"]))

    def test_a_pulled_digest_that_is_not_the_contracts_is_refused(self):
        p = self.run_gate(CONTRACT, digest="sha256:" + "b" * 64)
        self.assertEqual(p.returncode, 1)
        self.assertIn("is not the contract's", p.stderr)
        self.assertFalse((self.tmp / "gate.json").exists())

    def test_a_bad_contract_is_refused_before_any_engine_call(self):
        p = self.run_gate({**CONTRACT, "image": "team/app:latest"})
        self.assertEqual(p.returncode, 2)
        self.assertIn("pinned", p.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_registry_host_from_the_command_line_is_pulled_but_never_recorded(self):
        p = self.run_gate({**CONTRACT, "floor": {"rc": 0}}, extra=["--registry", "registry.internal.example"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertTrue(any(a[0] == "pull" and a[-1] == f"registry.internal.example/team/app@{DIGEST}"
                            for a in self.calls()))
        self.assertNotIn("registry.internal.example", (self.tmp / "gate.json").read_text())


if __name__ == "__main__":
    unittest.main()
