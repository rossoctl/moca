"""sbx: an EXAMPLE of a thin command-line client for one sandbox, built on sandbox_v1_client.py.

The supported CLI is `mocactl sbx run` and `put` (SBX0 1c); this file shows how little a client
needs. Every command runs in a fresh microVM over the workspace, and nothing runs on the local
machine. See sandbox-v1-direct-client.md.

    sbx run [COMMAND...]      run COMMAND (or, with no arguments, the script on stdin) in /workspace
    sbx put PATH              write stdin to PATH in the workspace (parent directories created)
    sbx push [DIR]            replace /workspace with DIR's git working tree; commit it as the baseline
    sbx pull                  print every change since the push as a git patch

Environment: what `mocactl sbx env <id>` prints (SBX_ADDR, SBX_TLS, SBX_CA_FILE, SBX_SANDBOX_ID,
SBX_WORKSPACE_KEY, SBX_TOKEN_CMD). Optional: SBX_TIMEOUT (seconds per command, default 600),
SBX_LOG (append one JSON line per call), SBX_BUSY_RETRY_S (seconds, default 30: how long in all to
wait and retry a command the sandbox refused at capacity before it started; 0 never retries).
`sbx run` exits with the command's own exit code (128 + n when killed by signal n); 124 means it
timed out, 125 that the sandbox failed or cancelled a command that outlived its token, 75 that it
refused the command at capacity until SBX_BUSY_RETRY_S ran out (nothing ran).
"""

import io
import json
import os
import random
import subprocess
import sys
import tarfile
import time

from sandbox_v1_client import RefusedAtCapacity, Sandbox

EXIT_REFUSED = 75  # EX_TEMPFAIL: refused at capacity until SBX_BUSY_RETRY_S ran out; nothing ran
EXIT_INTERRUPTED = 130

# The sandbox image has python3 and git but not tar/gzip, so the archive is extracted with tarfile.
PUSH = (
    "cd /workspace && find . -mindepth 1 -delete && "
    "python3 -W ignore -c 'import sys,tarfile; tarfile.open(fileobj=sys.stdin.buffer, mode=\"r|gz\").extractall(\".\")' && "
    "git init -q && "
    "printf '%s\\n' __pycache__/ '*.pyc' node_modules/ .venv/ venv/ .pytest_cache/ .mypy_cache/ > .git/info/exclude && "
    "git add -A && git -c user.name=sbx -c user.email=sbx@localhost commit -q --no-verify -m sbx-baseline && "
    "git ls-files | wc -l"
)
PULL = "cd /workspace && git add -A -N . && git diff --binary HEAD"


def sandbox() -> Sandbox:
    return Sandbox.from_env()


def log(op: str, started: float, code: int, **extra) -> None:
    """sbx.py's SBX_LOG record, {t, op, ms, exit}, plus the keys the busy retry added, as the Go sbx writes them: "attempt"
    (every record, from 1); "refused" and "reason" (a refused attempt's record, and the final one when the retries
    ran out: the class, and the refusal's text sanitized and cut to 300 characters); "busy_wait_ms" (the final
    record of a call only: the total slept between retries, 0 when none)."""
    if path := os.environ.get("SBX_LOG"):
        with open(path, "a") as f:
            rec = {"t": time.time(), "op": op, "ms": round((time.time() - started) * 1000), "exit": code}
            if extra.get("reason") is not None:
                extra["reason"] = sanitize(extra["reason"])
            rec.update({k: v for k, v in extra.items() if v is not None and v != ""})
            f.write(json.dumps(rec) + "\n")


def sanitize(text: str) -> str:
    text = "".join(" " if ord(c) < 0x20 or ord(c) == 0x7F else c for c in text)
    return text[:300] + "…" if len(text) > 300 else text


def busy_retry_s() -> int:
    raw = os.environ.get("SBX_BUSY_RETRY_S", "30")
    if not raw.isdigit() or int(raw) > 3600:
        raise ValueError(f"SBX_BUSY_RETRY_S must be a whole number of seconds from 0 to 3600, got {raw!r}")
    return int(raw)


def backoff(attempt: int) -> float:
    """The delay before retry `attempt` (1-based): about 1, 2, 4, 8, then 8 s."""
    return float(1 << (min(attempt, 4) - 1))


def jitter(d: float) -> float:
    return d * (0.75 + 0.5 * random.random())


def run(command: str, stdin: bytes = b"", op: str = "run", sleep=time.sleep) -> int:
    """Run one command. A command the sandbox refused at capacity before anything of it ran (RefusedAtCapacity) is
    sent again, with backoff, until SBX_BUSY_RETRY_S of waiting is spent; nothing else is ever retried, so a
    command that may have started never runs twice. Each retry is a new Exec with a new req_id (Sandbox.exec draws
    one per call): the refused one never ran, and the worker dedups by req_id, so a fresh id is admitted afresh."""
    started = time.time()
    try:
        budget = busy_retry_s()
    except ValueError as e:
        print(f"sbx: {e}", file=sys.stderr)
        return 2
    waited, attempt, attempt_start = 0.0, 1, started
    sb = None  # one Sandbox (one channel, one TokenSource) for every attempt: a retry needs only a new req_id
    while True:
        try:
            if sb is None:
                sb = sandbox()  # inside the try, so a failed token command is reported as before
            r = sb.exec(command, stdin=stdin, timeout_s=int(os.environ.get("SBX_TIMEOUT", "600")))
            break
        except RefusedAtCapacity as e:
            nxt = min(jitter(backoff(attempt)), budget - waited)
            if budget == 0:
                print(f"sbx: {e}", file=sys.stderr)
                log(op, started, 125, attempt=attempt, busy_wait_ms=0)
                return 125
            if nxt < 0.1:
                print(f"sbx: {e.refused}: nothing ran; gave up after {attempt} attempts / {round(waited)}s", file=sys.stderr)
                log(op, started, EXIT_REFUSED, attempt=attempt, refused=e.refused, reason=e.reason,
                    busy_wait_ms=round(waited * 1000))
                return EXIT_REFUSED
            log(op, attempt_start, EXIT_REFUSED, attempt=attempt, refused=e.refused, reason=e.reason)
            print(f"sbx: {e.refused}: nothing ran; retrying in {nxt:.1f}s (attempt {attempt + 1})", file=sys.stderr)
            try:
                sleep(nxt)
            except KeyboardInterrupt:
                print("sbx: interrupted while waiting to retry; nothing ran", file=sys.stderr)
                log(op, started, EXIT_INTERRUPTED, attempt=attempt, busy_wait_ms=round(waited * 1000))
                return EXIT_INTERRUPTED
            waited += nxt
            attempt, attempt_start = attempt + 1, time.time()
        except RuntimeError as e:
            # SandboxError and its kinds -- machinery, a command that outlived its token ("sandbox token expired
            # during the Exec") -- or a failed token command. The message says which.
            print(f"sbx: {e}", file=sys.stderr)
            log(op, started, 125, attempt=attempt, busy_wait_ms=round(waited * 1000))
            return 125
    sys.stdout.buffer.write(r.stdout)
    sys.stderr.buffer.write(r.stderr)
    if r.capped:
        print(f"sbx: timeout capped at {r.timeout_s} s, the sandbox token's lifetime minus 60 s", file=sys.stderr)
    if r.truncated:
        print("sbx: stdout exceeded 8 MiB and was cut", file=sys.stderr)
    final = {"attempt": attempt, "busy_wait_ms": round(waited * 1000)}
    if r.timed_out:
        print(f"sbx: command timed out after {r.timeout_s} s", file=sys.stderr)
        log(op, started, 124, **final)
        return 124
    code = r.exit_code if r.exit_code >= 0 else 128 - r.exit_code  # killed by signal n: 128 + n
    log(op, started, code, **final)
    return code


def push(directory: str) -> int:
    files = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=directory, check=True, capture_output=True,
    ).stdout.split(b"\0")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in filter(None, files):
            path = os.path.join(directory, name.decode())
            if os.path.lexists(path):  # tracked but deleted locally: skip
                tar.add(path, arcname=name.decode(), recursive=False)
    data = buf.getvalue()
    if len(data) > 12 << 20:
        print(f"sbx: tree is {len(data) >> 20} MiB compressed; the limit is 12", file=sys.stderr)
        return 1
    return run(PUSH, stdin=data, op="push")


def main(argv: list) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cmd, args = argv[0], argv[1:]
    if cmd == "run":
        return run(" ".join(args) if args else sys.stdin.read())
    if cmd == "put" and len(args) == 1:
        q = "'" + args[0].replace("'", "'\\''") + "'"
        return run(f'mkdir -p "$(dirname -- {q})" && cat > {q}', stdin=sys.stdin.buffer.read(), op="put")
    if cmd == "push":
        return push(args[0] if args else ".")
    if cmd == "pull":
        return run(PULL, op="pull")
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
