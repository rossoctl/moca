#!/usr/bin/env python3
"""The general gate: one OCI image and its input contract to a gate record (GUIDE.md §4b.5).

    python3 deploy/sbx/template-onboarding/gate-image.py CONTRACT.json --out RECORD.json
        [--engine podman|docker] [--registry HOST] [--template-id ID --spec-out SPEC.json] [--keep-image]

A GATE TESTS THE ENVIRONMENT. It runs the image's own test command once, unmodified (no edit, no fix,
no patch), as Moca's microVM guest would run it, and asks that the result meet the stated floor. Whether
an agent's change is right is grading's question, asked later; nothing here judges a fix.

CONTRACT is a JSON file, schema moca-gate-input/1:

    image            repository@sha256:<64 hex>: the image, pinned
    workdir          the work tree, an absolute path (where the test command runs; seeded to /workspace)
    test_cmd         a bash command, run in the work tree
    floor            {"rc": N} and/or {"passed_at_least": N}: what the run must meet
    absent_sha256    optional: sha256s no file in the image may have (a task's tests, its solution)
    probe            optional: {"cmd": ..., "public": true}, a shareable check for the template spec
    tools            optional: tools the template will list (default bash git python3 rg)
    network_needed   optional, true: the test command cannot pass offline. The gate still runs offline and
                     checks everything else; the floor is RECORDED, not enforced, and the record says so
                     (gate.floor_checked_offline false). For the general-self profile only; the benchmark
                     profiles refuse such a record (X1.offline)

The image is pulled BY DIGEST, linux/amd64 (with --registry HOST for a repository that names none), and
the digest it got must be the contract's. Then, in Moca's microVM guest EMULATED in one container (a
read-only root, --network none, root, tmpfs /workspace /tmp /var, `env -i` with init's PATH):

  1. the work tree is seeded into the empty /workspace (`cp -a`, as a client's seed does);
  2. the probes: who runs, the tools, the root file system, credential-shaped variables, git's
     identity and whether a commit would be refused;
  3. the test command, once, unmodified, and its rc and counts against the floor;
  4. with absent_sha256: every file of the image by sha256, only the count of matches kept;
  5. with a public probe: it runs too, on a fresh seed, and what it printed becomes the template
     spec's expectation.

The image's own /etc/hosts is read from an export, as deploy/microvm/build-rootfs.sh sees it.

THE RECORD (schema moca-gate-record/1, the control plane's default SH_GATE_RECORD_SCHEMA) carries the
fields the control plane reads, at the paths it reads them (packages/control-plane/src/template-policy.ts):
gate.passed (X1), image.digest (X1.image), gate.floor_checked_offline (X1.offline), and
observed.testbed.agent_can_commit with observed.guest.git_identity (X12). It is written whether the gate
passed or not, and the exit is 0 only when it passed. Its bytes are deterministic, since the control plane
hashes them; they are defined as Python's `json.dumps(record, indent=2, sort_keys=True) + "\n"` (so the
separators are `","` at a line's end and `": "`, and ensure_ascii stays on: non-ASCII is escaped). Send
them unchanged. It is unsigned bytes whose sha256 is its identity;
WHO submitted it is the control plane's to record, not the record's to claim. A public registry stays in
the image's name (`docker.io/library/python@...`), as the per-repository allowlist needs; any other host
is dropped. Never in a record: a private registry host, a credential, the test command (only its
sha256), its output (only counts), or a sha from absent_sha256.

Needs Python 3's standard library and podman or docker. Exit: 0 the gate passed; 1 it failed (each
reason printed); 2 usage, or a contract that cannot be gated.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform as host_platform
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCHEMA = "moca-gate-record/1"
INPUT_SCHEMA = "moca-gate-input/1"
SPEC_SCHEMA = "moca-sbx-template-spec/1"
TOOL = "deploy/sbx/template-onboarding/gate-image.py"
KIND = f"general gate: the image's own test command in Moca's microVM guest emulation ({TOOL})"
DIGEST_REF = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")

WORKSPACE = "/workspace"
GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"   # the guest's init
GUEST_HOME = "/tmp/home"
# The guest agent's minimum (governance/GATING-RULES.md M3) plus what a template lists by default.
MINIMUM_TOOLS = ("bash", "ls", "cat", "base64", "file")
DEFAULT_TOOLS = ("bash", "git", "python3", "rg")
HOSTS = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n"
HOSTS_SHA256 = hashlib.sha256(HOSTS.encode()).hexdigest()
CREDENTIAL_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH", re.I)
TEST_TIMEOUT_S = 2400
PROBE_TIMEOUT_S = 900
# The gate's envelope, and the one the written spec asks for (X15: the benchmark profiles' exact size).
CPUS, MEMORY, GUEST_RAM_MB, VCPUS = "2", "4096m", 4096, 2

# The guest's /workspace is a disk image of at most the golden snapshot's workspace drive (deploy/sbx/setup.sh
# SNAPSHOT_WORKSPACE_MB, SBX_WORKSPACE_IMAGE_MB's ceiling), so a work tree that does not fit there fails here too.
WORKSPACE_MB = 2048
# The guest, emulated in one container: a read-only root, no network, root, tmpfs /workspace /tmp /var. The
# guest's /var is the image's own /var made writable (build-snapshot.sh's init: an overlay with a tmpfs on top,
# or, without overlayfs, a copy into a tmpfs), so the tmpfs here is SEEDED with the image's /var (seed_var):
# a plain tmpfs would hide what the image put there, such as a prebuilt TeX format under /var/lib/texmf.
EMULATION_FLAGS = ("--read-only", "--network", "none", "--user", "0",
                   "--tmpfs", f"{WORKSPACE}:rw,exec,size={WORKSPACE_MB}m", "--tmpfs", "/tmp:rw,exec,mode=1777",
                   "--tmpfs", "/var:rw")

# Public registries are KEPT in a record and a spec: the policy allows them per repository, and needs the
# image written with its host (`docker.io/library/python@sha256:...`). Any other host (a private registry,
# a localhost test registry) is dropped: never recorded.
PUBLIC_REGISTRIES = ("docker.io", "ghcr.io", "quay.io", "registry.k8s.io", "gcr.io", "mcr.microsoft.com",
                     "public.ecr.aws")


# --- the contract ---------------------------------------------------------------------------------

def contract_problems(c: dict) -> list[str]:
    """Every reason the input contract cannot be gated; [] means it can."""
    p = []
    if c.get("schema") != INPUT_SCHEMA:
        p.append(f"schema must be {INPUT_SCHEMA}")
    if not DIGEST_REF.match(str(c.get("image", ""))):
        p.append("image must be pinned: repository@sha256:<64 hex>")
    w = c.get("workdir")
    if not (isinstance(w, str) and w.startswith("/") and w not in ("/", WORKSPACE) and ".." not in w.split("/")):
        p.append(f"workdir must be an absolute path other than / and {WORKSPACE}")
    if not (isinstance(c.get("test_cmd"), str) and c["test_cmd"].strip()):
        p.append("test_cmd must be a non-empty bash command")
    f = c.get("floor")
    if not (isinstance(f, dict) and f and set(f) <= {"rc", "passed_at_least"}
            and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in f.values())):
        p.append('floor must be {"rc": N} and/or {"passed_at_least": N}, whole numbers')
    a = c.get("absent_sha256", [])
    if not (isinstance(a, list) and all(isinstance(x, str) and SHA256.match(x) for x in a)):
        p.append("absent_sha256 must be a list of 64-hex sha256s")
    pr = c.get("probe")
    if pr is not None and not (isinstance(pr, dict) and isinstance(pr.get("cmd"), str) and pr["cmd"].strip()
                               and pr.get("public") is True):
        p.append('probe must be {"cmd": ..., "public": true}: a shareable command, never a grading one')
    t = c.get("tools", list(DEFAULT_TOOLS))
    if not (isinstance(t, list) and t and all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9._+-]+", x) for x in t)
            and len(set(t)) == len(t)):
        p.append("tools must be a list of distinct tool names")
    if "network_needed" in c and c["network_needed"] is not True:
        p.append("network_needed must be true, or absent")
    unknown = set(c) - {"schema", "image", "workdir", "test_cmd", "floor", "absent_sha256", "probe", "tools",
                        "network_needed"}
    if unknown:
        p.append(f"unknown fields: {sorted(unknown)}")
    return p


def digest(c: dict) -> str:
    return c["image"].split("@", 1)[1]


def required_tools(c: dict) -> list[str]:
    return sorted(set(c.get("tools", DEFAULT_TOOLS)) | set(MINIMUM_TOOLS))


# --- what runs in the guest -------------------------------------------------------------------------

def guest(cmd: str) -> str:
    """A command as Moca's guest runs it: no image ENV, init's PATH, the guest HOME, in /workspace."""
    return (f"env -i PATH={GUEST_PATH} HOME={GUEST_HOME} TERM=linux bash -c "
            f"{shlex.quote(f'cd {WORKSPACE} && {cmd}')}")


def seed_cmd(c: dict) -> str:
    """The work tree copied into the empty /workspace, owners kept, as a client's seed does."""
    return f"mkdir -p {GUEST_HOME} && cp -a {shlex.quote(c['workdir'])}/. {WORKSPACE}/"


def probe_cmds(c: dict) -> dict[str, str]:
    tools = " ".join(required_tools(c))
    return {
        "id": "echo \"$(id -un) $(id -u)\"",
        "env_names": "env | cut -d= -f1 | LC_ALL=C sort",
        "missing_tools": f"for t in {tools}; do command -v $t >/dev/null || echo $t; done",
        "rootfs": "touch /opt/.gate-probe 2>/dev/null && echo writable || echo readonly",
        "git_tree": "git rev-parse --is-inside-work-tree 2>/dev/null || echo no",
        "commit_count": "git rev-list --all --count 2>/dev/null || echo none",
        "git_status_lines": "git status --porcelain 2>/dev/null | wc -l | tr -d ' '",
        "agent_can_commit": "git var GIT_COMMITTER_IDENT >/dev/null 2>&1 && echo yes || echo no",
        "git_identity": "git config --get user.name || git config --get user.email || echo none",
    }


def scan_cmd(want_file: str) -> str:
    """Every regular file on the image's own file system, by sha256, against the absent list (passed IN
    as a file, so no sha appears on a command line); only counts come back. Coreutils only."""
    q = shlex.quote(want_file)
    return ("set -o pipefail; n=$(find / -xdev -type f 2>/dev/null | wc -l | tr -d ' '); "
            f"h=$(find / -xdev -type f -print0 2>/dev/null | xargs -0 -r sha256sum 2>/dev/null | cut -c1-64 "
            f"| grep -cFxf {q} || true); echo \"scanned $n\"; echo \"hits $h\"")


def parse(raw: dict[str, str]) -> dict:
    lines = {k: (v or "").strip().splitlines() for k, v in raw.items()}
    first = {k: (v[0] if v else None) for k, v in lines.items()}
    return {
        "id": first.get("id"),
        "missing_tools": lines.get("missing_tools", []),
        "rootfs": first.get("rootfs"),
        "credential_env_names": [n for n in lines.get("env_names", []) if CREDENTIAL_NAME.search(n)],
        "git_identity": first.get("git_identity"),
    }


def parse_testbed(raw: dict[str, str]) -> dict:
    """The work tree's git facts, under the names the control plane's X12 reads."""
    g = {k: ((raw.get(k) or "").strip().splitlines() or [None])[0] for k in raw}
    return {"git_tree": g.get("git_tree"), "commit_count": g.get("commit_count"),
            "git_status_lines": g.get("git_status_lines"), "agent_can_commit": g.get("agent_can_commit")}


def parse_scan(text: str) -> dict:
    kv = dict(ln.split(None, 1) for ln in (text or "").splitlines() if " " in ln)
    return {"files_scanned": int(kv.get("scanned", "-1")), "absent_hits": int(kv.get("hits", "-1"))}


# --- the test runner's counts ------------------------------------------------------------------------

# pytest's summary line, and sympy's runner's: a count, then a duration, on one line. Three spellings:
# pytest's "in 1.20s" and "in 75.00s (0:01:15)", and sympy's "tests finished: 5 passed, in 0.10
# seconds". Anchoring on `s` alone would read no pass count from a healthy sympy run.
_PYTEST_SUMMARY = re.compile(
    r"\d+\s+(?:failed|passed|error|errors|exceptions?)\b.*\bin \d[\d.]*\s*(?:s|secs?|seconds?)\b")
# sympy's runner wraps its summary at 80 columns when its output is a pipe, so a long one puts
# "in N seconds" on the next line; it pads a short one with `=`, so the start is not anchored.
_SYMPY_SUMMARY_START = re.compile(r"tests finished: ")
_DURATION = re.compile(r"\bin \d[\d.]*\s*seconds\b")
# unittest's own summary keys carry spaces ("expected failures=1"), so the key half cannot be \w+.
_UNITTEST_DETAIL = re.compile(r"([a-z]+(?: [a-z]+)*)=(\d+)")


def _unwrap_sympy_summary(text: str) -> str:
    """sympy's summary as one line: from `tests finished:` up to the line with its duration."""
    out = text
    for m in reversed(list(_SYMPY_SUMMARY_START.finditer(text))):
        lines = text[m.start():].split("\n")
        for n in range(min(len(lines), 4)):
            if _DURATION.search(lines[n]):
                if n:
                    span = "\n".join(lines[: n + 1])
                    out = out[: m.start()] + "".join(lines[: n + 1]) + out[m.start() + len(span):]
                break
    return out


def parse_pytest_counts(text: str) -> tuple[int | None, int | None]:
    """(failed, passed) from pytest's summary line, None when there is none (a collection error is not
    "0 failed"). Read from the LAST summary line only, never scanned out of the whole output: a suite
    that runs pytest in-process prints inner summaries, and mixing counts from two of them invents a
    result neither stated. Collection errors (and sympy's exceptions) count as failures."""
    lines = [ln for ln in _unwrap_sympy_summary(text or "").splitlines() if _PYTEST_SUMMARY.search(ln)]
    failed = passed = None
    for m in re.finditer(r"(\d+)\s+(failed|passed|error|errors|exceptions?)\b", lines[-1] if lines else ""):
        n, what = int(m.group(1)), m.group(2)
        if what == "passed":
            passed = n
        elif what == "failed":
            failed = n
        else:
            failed = (failed or 0) + n
    return failed, passed


def parse_unittest_counts(text: str) -> tuple[int | None, int | None]:
    """(failed, passed) from unittest's summary: `Ran N tests in Xs`, then `OK`, `OK (skipped=M)` or
    `FAILED (failures=F, errors=E, ...)`. Skips, expected failures and unexpected successes are not
    passes. None with no `Ran` line, or a `Ran` with no verdict (an interrupted run): never 0."""
    m = re.search(r"^Ran (\d+) tests?\b", text or "", re.M)
    if m is None:
        return None, None
    verdict = re.search(r"^(OK|FAILED)\b[ \t]*(?:\(([^)]*)\))?", text[m.end():], re.M)
    if verdict is None:
        return None, None
    detail = {k: int(v) for k, v in _UNITTEST_DETAIL.findall(verdict.group(2) or "")}
    failed = detail.get("failures", 0) + detail.get("errors", 0)
    not_passed = (failed + detail.get("skipped", 0) + detail.get("expected failures", 0)
                  + detail.get("unexpected successes", 0))
    return failed, max(int(m.group(1)) - not_passed, 0)


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
# unittest's verdict is ANCHORED: `OK`, `FAILED`, optionally with its parenthesised counts, and nothing else on
# the line. Unanchored, `FAILED` also matched pytest's short-summary items (`FAILED path::test - message`),
# which name failing tests (for a benchmark's baseline, often the very ones a fix must make pass) and carry
# their error text: neither may reach a record.
_SUMMARY = re.compile(r"^(Ran \d+ tests?\b.*|(OK|FAILED)(\s+\([^)]*\))?|=+ .*\b(passed|failed|error|errors)\b.*=+|.*\btests finished:.*)$")


def summary_lines(text: str) -> list[str]:
    """The runner's summary lines as printed, colour codes stripped (as template-build.sh strips them
    before it matches): pytest's count line, unittest's `Ran N` and its verdict, sympy's `tests finished:`."""
    plain = [ANSI.sub("", ln).rstrip() for ln in (text or "").splitlines()]
    return [ln for ln in plain if _SUMMARY.match(ln.strip()) or _PYTEST_SUMMARY.search(ln)][-4:]


def run_counts(rc: int | None, text: str) -> dict:
    """The run's rc, counts (pytest's summary, else unittest's; never defaulted to 0) and the summary
    lines it printed, which a template's expectation is built from and checked against."""
    failed, passed = parse_pytest_counts(text)
    if passed is None:
        failed, passed = parse_unittest_counts(text)
    return {"rc": rc, "passed": passed, "failed": failed, "summary_lines": summary_lines(text)}


def expectations(lines: list[str]) -> list[str]:
    """Extended regexes for what the runner PRINTED, never rebuilt from counts: unittest's `Ran N` counts
    skipped tests too, so a passed count is not what it prints (`Ran 12 tests`, `OK (skipped=2)`: 10
    passed). Each regex is checked to match the lines it came from."""
    exp: list[str] = []
    for ln in lines:
        m = re.match(r"^Ran (\d+) tests?\b", ln)
        if m:
            exp.append(rf"^Ran {m.group(1)} tests?\b")
        elif re.match(r"^(OK|FAILED)(\s+\([^)]*\))?$", ln):
            exp.append(r"^OK\b" if ln.startswith("OK") else r"^FAILED\b")
        else:
            for n, word in re.findall(r"\b(\d+) (passed|failed)\b", ln):
                exp.append(rf"\b{n} {word}\b")
    exp = list(dict.fromkeys(exp))
    if not all(any(re.search(e, ln) for ln in lines) for e in exp):
        raise ValueError(f"an expectation does not match the lines it came from: {exp} {lines}")
    return exp


# --- the verdict ------------------------------------------------------------------------------------

def check(observed: dict, c: dict) -> list[str]:
    """Every reason this image must not get a passing gate record; [] means it passes."""
    p = []
    if observed.get("etc_hosts_exported_sha256") != HOSTS_SHA256:
        p.append("the image's /etc/hosts does not resolve localhost as Moca's guest needs "
                 f"(want sha256 {HOSTS_SHA256[:12]}…; a microVM guest boots with no runtime-written file)")
    o = observed.get("guest", {})
    v = observed.get("var", {})
    if not v.get("seeded"):
        p.append("the image's /var could not be copied into the guest's /var (a guest keeps the image's /var, "
                 "made writable)")
    elif v.get("guest_files") != v.get("image_files"):
        p.append(f"the guest's /var holds {v.get('guest_files')} files, the image's {v.get('image_files')}")
    if o.get("id") != "root 0":
        p.append(f"guest commands ran as {o.get('id')!r}, want root 0 (the emulation is wrong)")
    if o.get("rootfs") != "readonly":
        p.append("the root file system was writable: the emulation is not Moca's guest")
    if o.get("missing_tools"):
        p.append(f"tools the template needs are missing: {o['missing_tools']}")
    if o.get("credential_env_names"):
        p.append(f"credential-shaped variables in the guest: {o['credential_env_names']}")
    if o.get("git_identity") != "none":
        p.append(f"git has an identity in the guest ({o.get('git_identity')!r}): an agent could commit")
    t = observed.get("testbed", {})
    if t.get("agent_can_commit") != "no":
        p.append(f"git in the work tree would commit (agent_can_commit={t.get('agent_can_commit')!r})")
    if t.get("git_tree") == "true" and t.get("git_status_lines") not in ("0", 0):
        p.append(f"the seeded work tree is not clean ({t.get('git_status_lines')} lines of git status)")
    if observed.get("run", {}).get("timed_out_s"):
        p.append(f"the test command timed out after {observed['run']['timed_out_s']} s")
    elif not c.get("network_needed"):       # with it, the offline run's result is recorded, not enforced
        p += floor_problems(observed.get("run", {}), c["floor"])
    if c.get("absent_sha256"):
        a = observed.get("absence", {})
        if a.get("files_scanned", -1) <= 0 or a.get("absent_hits") != 0:
            p.append(f"{a.get('absent_hits')} files carry a sha256 that must be absent "
                     f"({a.get('files_scanned')} scanned)")
    pr = observed.get("probe")
    if c.get("probe") and pr and pr.get("timed_out_s"):
        p.append(f"the probe timed out after {pr['timed_out_s']} s")
    elif c.get("probe") and (pr is None or pr.get("rc") is None):
        p.append("the probe did not run")
    return p


def floor_problems(r: dict, f: dict) -> list[str]:
    p = []
    if "rc" in f and r.get("rc") != f["rc"]:
        p.append(f"the test command exited {r.get('rc')}, the floor says {f['rc']}")
    if "passed_at_least" in f and (r.get("passed") is None or r["passed"] < f["passed_at_least"]):
        p.append(f"the test command passed {r.get('passed')}, the floor says at least {f['passed_at_least']}")
    return p


# --- the record and the spec ----------------------------------------------------------------------------

def repository(image_ref: str) -> str:
    """The image's repository as a record keeps it: with its host if public, without it otherwise."""
    repo = image_ref.split("@", 1)[0]
    first, _, rest = repo.partition("/")
    if not rest or not ("." in first or ":" in first or first == "localhost"):
        return repo                                    # no host named
    return repo if first in PUBLIC_REGISTRIES else rest


def record(c: dict, observed: dict, problems: list[str], *, builder: dict, built_at: str,
           tool: dict) -> dict:
    """The gate record. Never: a private registry host, a credential, the test command's output."""
    return {
        "schema": SCHEMA,
        "image": {"repository": repository(c["image"]), "digest": digest(c)},
        "contract_sha256": hashlib.sha256(json.dumps(c, sort_keys=True).encode()).hexdigest(),
        # floor_checked_offline and network_needed are ALWAYS present, so a reader can fail closed on them.
        "gate": {"passed": not problems, "kind": KIND, "network": "none", "rootfs": "read-only",
                 "user": "root", "floor": c["floor"],
                 "floor_checked_offline": not c.get("network_needed"),
                 "network_needed": bool(c.get("network_needed")),
                 **({"floor_met_offline": not floor_problems(observed.get("run", {}), c["floor"])}
                    if c.get("network_needed") else {})},
        "observed": observed,
        "problems": problems,
        "test_cmd_sha256": hashlib.sha256(c["test_cmd"].encode()).hexdigest(),
        "workdir": c["workdir"],
        "tools": list(c.get("tools", DEFAULT_TOOLS)),
        "builder": builder,
        "built_at": built_at,
        "tool": tool,
    }


def record_bytes(rec: dict) -> str:
    """The record as written, and the DEFINITION of its bytes (the control plane hashes them): this call,
    with ensure_ascii at its default (True), plus one newline. The same record is always the same bytes."""
    return json.dumps(rec, indent=2, sort_keys=True) + "\n"


def template_spec(c: dict, rec: dict, template_id: str) -> dict:
    """A moca-sbx-template-spec/1 for this image, for a self-attested create. Its probe is the contract's
    public one with the expectation the gate measured; without one, probe_status is unmeasured, which
    template-build.sh and the control plane refuse until it is measured. It names no profile: the create
    does (benchmark-self or general-self)."""
    spec = {
        "schema": SPEC_SCHEMA, "id": template_id,
        "image": f"{rec['image']['repository']}@{rec['image']['digest']}",
        "guest_ram_mb": GUEST_RAM_MB, "vcpus": VCPUS, "guest_home": GUEST_HOME,
        # egress only for a contract whose tests need the network (general-self, the host's allowlist)
        "skip_git_identity_check": True, "guest_home_gitconfig": False, "egress": bool(c.get("network_needed")),
        "seed": f"cp -a {shlex.quote(c['workdir'] + '/.')} {WORKSPACE}/",
        "description": f"{rec['image']['repository']} (gated by Moca's general gate)",
        "tools": list(c.get("tools", DEFAULT_TOOLS)),
        "etc_hosts_sha256": HOSTS_SHA256,
        "source_record_digest": rec["image"]["digest"],
        "proved_in_vm": False,
        "probe_status": "unmeasured",
    }
    pr = rec["observed"].get("probe")
    if c.get("probe") and pr and pr.get("rc") is not None:
        exp = expectations(pr.get("summary_lines") or [])
        spec["probe"] = {"cmd": c["probe"]["cmd"], "timeout_s": PROBE_TIMEOUT_S, "expect_rc": pr["rc"],
                         "expect": exp}
        spec["probe_status"] = "emulation"
    return spec


# --- the engine -------------------------------------------------------------------------------------

ENGINE = ["podman"]
ROOT = Path(__file__).resolve().parent


def sh(args, timeout=600, check=True):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        die(f"{' '.join(args[:3])} … failed (rc {p.returncode}): {(p.stderr or p.stdout).strip()[-400:]}", 1)
    return p


def die(msg: str, code: int = 2):
    print(f"gate-image.py: {msg}", file=sys.stderr)
    sys.exit(code)


def git_commit() -> str | None:
    """This file's commit, or None from a checkout where it is modified (the record must not claim a
    commit whose code did not run)."""
    p = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True)
    dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", Path(__file__).name],
                           capture_output=True, text=True)
    return None if p.returncode or dirty.returncode or dirty.stdout.strip() else p.stdout.strip()


def pulled_digest(ref: str) -> str:
    if ENGINE[0] == "docker":   # docker reports RepoDigests, not .Digest
        out = sh([*ENGINE, "image", "inspect", "--format", "{{join .RepoDigests \" \"}}", ref]).stdout.strip()
        return next((d.split("@", 1)[1] for d in out.split() if "@" in d), "")
    return sh([*ENGINE, "image", "inspect", "--format", "{{.Digest}}", ref]).stdout.strip()


def exported_hosts_sha256(cid: str) -> str:
    """The image's own /etc/hosts, from an export of a created (never started) container, as the rootfs
    builder sees it."""
    data = subprocess.run(f"{shlex.quote(ENGINE[0])} export {shlex.quote(cid)} | tar -xO etc/hosts",
                          shell=True, capture_output=True, timeout=1800).stdout
    return hashlib.sha256(data).hexdigest()


# Every entry under /var but its directories (files, symlinks such as /var/run, devices), counted the same way
# on both sides: from the image's tar stream, and in the guest after the copy.
VAR_ENTRIES = "find /var -xdev -mindepth 1 ! -type d 2>/dev/null | wc -l | tr -d ' '"


def seed_var(cid: str, g: "Guest") -> dict:
    """The image's /var into the guest's tmpfs /var, owners and modes kept (init's copy fallback): streamed
    from the created container, extracted by root in the guest. Its file counts, image and guest, say it
    arrived whole (entries but directories, VAR_ENTRIES)."""
    e, q = shlex.quote(ENGINE[0]), shlex.quote
    image = subprocess.run(f"{e} cp {q(cid)}:/var - | tar -tvf - 2>/dev/null | grep -vc '^d' || true", shell=True,
                           capture_output=True, text=True, timeout=1800).stdout.strip()
    p = subprocess.run(f"{e} cp {q(cid)}:/var - | {e} exec -i {q(g.cid)} tar -xf - -C /", shell=True,
                       capture_output=True, text=True, timeout=1800)
    guest_files = g.ex(VAR_ENTRIES, in_guest=False).stdout.strip()
    return {"seeded": p.returncode == 0, "image_files": int(image or 0),
            "guest_files": int(guest_files) if guest_files.isdigit() else None}


class Guest:
    """One container emulating Moca's guest, and the gate's way into it."""

    def __init__(self, ref: str):
        flags = list(EMULATION_FLAGS) + (["--no-hosts"] if ENGINE[0] == "podman" else [])
        self.cid = sh([*ENGINE, "run", "-d", "--platform", "linux/amd64", *flags, "--cpus", CPUS,
                       "--memory", MEMORY, "--entrypoint", "sleep", ref, "infinity"], timeout=1800).stdout.strip()

    def ex(self, cmd: str, *, in_guest: bool = True, timeout: int = 600):
        c = guest(cmd) if in_guest else cmd
        return subprocess.run([*ENGINE, "exec", self.cid, "bash", "-c", c], capture_output=True, text=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)

    def put(self, text: str, path: str):
        with tempfile.NamedTemporaryFile("w") as f:
            f.write(text)
            f.flush()
            sh([*ENGINE, "cp", f.name, f"{self.cid}:{path}"])

    def run_rc(self, cmd: str, timeout: int) -> dict:
        try:
            r = self.ex(f"( {cmd} ) 2>&1; printf '\\n__RC__%d\\n' \"$?\"", timeout=timeout)
        except subprocess.TimeoutExpired:
            # No rc and no counts: a stated reason in the record, not a traceback with no record.
            return {**run_counts(None, ""), "timed_out_s": timeout}
        text, rc = r.stdout or "", None
        i = text.rfind("__RC__")
        if i >= 0:
            rc, text = int(text[i + 6:].split()[0]), text[:i]
        return run_counts(rc, text)

    def close(self):
        subprocess.run([*ENGINE, "rm", "-f", self.cid], capture_output=True)


def observe(ref: str, c: dict) -> dict:
    cid = sh([*ENGINE, "create", "--platform", "linux/amd64", ref, "true"]).stdout.strip()
    try:
        obs = {"etc_hosts_exported_sha256": exported_hosts_sha256(cid)}
        g = Guest(ref)
        try:
            obs["var"] = seed_var(cid, g)
            return _observe_in(g, c, obs)
        finally:
            g.close()
    finally:
        subprocess.run([*ENGINE, "rm", "-f", cid], capture_output=True)


def _observe_in(g: "Guest", c: dict, obs: dict) -> dict:
    seed = g.ex(seed_cmd(c), in_guest=False, timeout=1800)
    if seed.returncode != 0:
        die(f"the seed failed ({seed.stderr.strip()[-300:]}): is workdir right?", 1)
    raw = {k: g.ex(cmd).stdout for k, cmd in probe_cmds(c).items()}
    obs["guest"] = parse(raw)
    obs["testbed"] = parse_testbed(raw)
    t0 = time.monotonic()
    obs["run"] = g.run_rc(c["test_cmd"], TEST_TIMEOUT_S)
    obs["run"]["ms"] = round((time.monotonic() - t0) * 1000)
    if c.get("absent_sha256"):
        g.put("\n".join(sorted(c["absent_sha256"])) + "\n", "/tmp/.gate-absent")
        obs["absence"] = parse_scan(g.ex(scan_cmd("/tmp/.gate-absent"), in_guest=False, timeout=3600).stdout)
    if c.get("probe"):
        g.ex(f"rm -rf {WORKSPACE}/* {WORKSPACE}/.[!.]* 2>/dev/null; true", in_guest=False)
        g.ex(seed_cmd(c), in_guest=False, timeout=1800)      # a fresh seed, as a new sandbox has
        obs["probe"] = g.run_rc(c["probe"]["cmd"], PROBE_TIMEOUT_S)
    return obs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("contract", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--engine", choices=("podman", "docker"), default="podman")
    ap.add_argument("--registry", help="for a repository naming no host; never recorded")
    ap.add_argument("--template-id", help="also write a template spec with this id")
    ap.add_argument("--spec-out", type=Path)
    ap.add_argument("--keep-image", action="store_true")
    ap.add_argument("--insecure-registry", action="store_true",
                    help="podman only: pull over plain HTTP (a local test registry); never for a real one")
    args = ap.parse_args()
    ENGINE[:] = [args.engine]
    try:
        c = json.loads(args.contract.read_text())
    except (OSError, ValueError) as e:
        die(f"cannot read the contract: {e}")
    bad = contract_problems(c) if isinstance(c, dict) else ["the contract must be a JSON object"]
    if bad:
        die("the contract is refused:\n  " + "\n  ".join(bad))
    if bool(args.template_id) != bool(args.spec_out):
        die("--template-id and --spec-out go together")
    ref = c["image"] if not args.registry else f"{args.registry}/{c['image']}"
    # An image the operator already had is kept (unless pulled here, it is not the gate's to remove).
    probe_had = [*ENGINE, "image", "exists", ref] if ENGINE[0] == "podman" else [*ENGINE, "image", "inspect", ref]
    had = subprocess.run(probe_had, capture_output=True).returncode == 0
    tls = ["--tls-verify=false"] if args.insecure_registry and ENGINE[0] == "podman" else []
    for _ in range(4):
        # linux/amd64, always: Moca's microVM guests are amd64, and an amd64-only image has no match for an
        # arm64 host's default platform. Off amd64 the gate runs emulated, which is slow.
        try:
            if subprocess.run([*ENGINE, "pull", "-q", "--platform", "linux/amd64", *tls, ref], capture_output=True,
                              timeout=3600).returncode == 0:
                break
        except subprocess.TimeoutExpired:
            pass                                # an attempt that hung counts as a failed one
        time.sleep(5)
    else:
        die("could not pull the image (4 attempts, each up to 3600 s)", 1)
    try:
        got = pulled_digest(ref)
        if got != digest(c):
            die(f"pulled digest {got} is not the contract's {digest(c)}", 1)
        obs = observe(ref, c)
    finally:
        if not had and not args.keep_image:
            subprocess.run([*ENGINE, "rmi", ref], capture_output=True)
    problems = check(obs, c)
    eng = sh([*ENGINE, "--version"]).stdout.strip()
    rec = record(c, obs, problems,
                 builder={"arch": host_platform.machine(), "engine": eng, "network": "none for the gate"},
                 built_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 tool={"name": f"moca {TOOL}", "commit": git_commit()})
    text = record_bytes(rec)
    args.out.write_text(text)
    print(f"{'GATE PASS' if not problems else 'GATE FAIL'}: {args.out} "
          f"sha256:{hashlib.sha256(text.encode()).hexdigest()}")
    for x in problems:
        print(f"  - {x}")
    if args.spec_out and not problems:
        args.spec_out.write_text(json.dumps(template_spec(c, rec, args.template_id), indent=2) + "\n")
        print(f"template spec: {args.spec_out}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
