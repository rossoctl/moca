#!/usr/bin/env python3
"""Stage Context Service state and run a bounded prompt in MOCA."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


NAME = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")
TERMINAL = {"responded", "done", "solved", "failed", "paused"}


class RemoteTaskError(RuntimeError):
    pass


def run_command(args: list[str], *, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, input=stdin, text=True, capture_output=True, check=False)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RemoteTaskError(f"{' '.join(args[:3])}: {detail}")
    return result


def contextctl(*args: str) -> dict[str, Any]:
    executable = os.environ.get("CONTEXTCTL", "contextctl")
    result = run_command([executable, *args, "--json"])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RemoteTaskError("contextctl did not return JSON") from exc


def request(base_url: str, method: str, path: str, body: Any | None = None) -> Any:
    headers = {"accept": "application/json"}
    token = os.environ.get("SH_TOKEN", "").strip()
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RemoteTaskError(f"MOCA {method} {path} returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RemoteTaskError(f"MOCA {method} {path} failed: {exc.reason}") from exc
    return json.loads(raw) if raw else None


def latest_stats(local: dict[str, Any]) -> tuple[str, int, int]:
    revisions = local.get("revisions") or []
    if not revisions:
        return "", 0, 0
    current = local.get("currentRevision")
    revision = next((item for item in reversed(revisions) if item.get("id") == current), revisions[-1])
    return str(revision.get("id", "")), int(revision.get("files", 0)), int(revision.get("bytes", 0))


def claim_name(remote: dict[str, Any]) -> str:
    claim = (remote.get("attachment") or {}).get("claimName")
    if not isinstance(claim, str) or not claim:
        raise RemoteTaskError("remote context is not backed by a PVC")
    return claim


def materialize(namespace: str, claim: str, delegation_id: str) -> str:
    pod = f"context-stage-{delegation_id[-12:]}"
    manifest = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": pod, "namespace": namespace, "labels": {"app": "context-stage"}},
        "spec": {
            "restartPolicy": "Never",
            "containers": [{
                "name": "stage",
                "image": os.environ.get("CS_HELPER_IMAGE", "busybox:1.36"),
                "command": ["sh", "-c", "sleep 300"],
                "volumeMounts": [{"name": "context", "mountPath": "/context"}],
            }],
            "volumes": [{"name": "context", "persistentVolumeClaim": {"claimName": claim}}],
        },
    }
    run_command(["kubectl", "create", "-f", "-"], stdin=json.dumps(manifest))
    try:
        run_command(["kubectl", "wait", "-n", namespace, f"pod/{pod}", "--for=condition=Ready", "--timeout=120s"])
        script = (
            "set -eu; digest=$(cat /context/.context-service/current); "
            "case \"$digest\" in *[!0-9a-f]*|'') exit 21;; esac; "
            "test ${#digest} -eq 64 || exit 21; "
            "destination=/context/.context-service/materialized/$digest; "
            "if [ ! -d \"$destination\" ]; then "
            f"temporary=/context/.context-service/materialized/.{delegation_id}; "
            "mkdir -p \"$temporary\"; "
            "tar -xzf /context/.context-service/objects/$digest.context -C \"$temporary\"; "
            "mv \"$temporary\" \"$destination\"; fi; "
            "printf '%s\\n' \"$digest\""
        )
        result = run_command(["kubectl", "exec", "-n", namespace, pod, "--", "sh", "-c", script])
    finally:
        subprocess.run(
            ["kubectl", "delete", "pod", "-n", namespace, pod, "--wait=true", "--timeout=60s"],
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    digest = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RemoteTaskError("materialized context returned an invalid bundle digest")
    return f"/workspace/.context-service/materialized/{digest}"


def emit(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")


def used_files(result: Any) -> list[str]:
    text = result.get("text", "") if isinstance(result, dict) else ""
    match = re.search(r"(?im)^CONTEXT_FILES_USED:\s*(.+)$", text)
    if not match:
        return []
    value = match.group(1).strip()
    return [] if value.lower() == "none" else [item.strip() for item in value.split(",") if item.strip()]


def wait_for_result(base_url: str, session_id: str, timeout: float, interval: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    query = urllib.parse.urlencode({"sessionId": session_id})
    while time.monotonic() < deadline:
        result = request(base_url, "GET", f"/runs/status?{query}")
        if isinstance(result, dict) and result.get("status") in TERMINAL:
            return result
        time.sleep(interval)
    raise RemoteTaskError(f"timed out waiting for session {session_id}")


def run_task(args: argparse.Namespace) -> int:
    if not NAME.fullmatch(args.remote_context):
        raise RemoteTaskError("--remote-context must be a lowercase Kubernetes name")
    base_url = args.sh_url or os.environ.get("SH_URL", "")
    if not base_url:
        raise RemoteTaskError("SH_URL or --sh-url is required")
    telemetry = Path(args.telemetry).expanduser()
    delegation_id = f"d-{uuid.uuid4().hex[:12]}"
    session_id = args.session_id or f"remote/{delegation_id}"
    workload_id = f"delegate-{delegation_id[2:]}"
    started = time.time()

    local = contextctl("ctx", "get", args.context, "--backend", "filesystem")
    context_type = "state" if local.get("type") == "history" else local.get("type")
    try:
        remote = contextctl(
            "ctx", "get", args.remote_context, "--backend", "pvc", "--namespace", args.namespace
        )
    except RemoteTaskError as exc:
        if "not found" not in str(exc).lower() and "404" not in str(exc):
            raise
        remote = contextctl(
            "ctx", "create", args.remote_context, "--type", str(context_type),
            "--backend", "pvc", "--namespace", args.namespace,
        )

    sync_start = time.time()
    run_command([
        os.environ.get("CONTEXTCTL", "contextctl"), "ctx", "sync", "push", args.context,
        "--remote-name", args.remote_context, "--namespace", args.namespace,
    ])
    remote = contextctl(
        "ctx", "get", args.remote_context, "--backend", "pvc", "--namespace", args.namespace
    )
    revision, files, byte_count = latest_stats(contextctl("ctx", "get", args.context, "--backend", "filesystem"))
    remote_namespace = str(remote.get("namespace") or args.namespace)
    workspace_path = materialize(remote_namespace, claim_name(remote), delegation_id)
    emit(telemetry, {
        "event": "context_staged", "delegationId": delegation_id, "sessionId": session_id,
        "context": args.context, "remoteContext": args.remote_context, "revision": revision,
        "files": files, "bytes": byte_count, "elapsedMs": round((time.time() - sync_start) * 1000),
    })

    workload = request(base_url, "POST", "/workloads", {
        "name": workload_id,
        "sandboxes": 1,
        "workspace": {"claimName": claim_name(remote), "readOnly": True},
    })
    terminal = False
    try:
        deadline = time.monotonic() + args.timeout
        while str(workload.get("status", "")).lower() != "ready" or workload.get("readyReplicas", 0) < 1:
            if time.monotonic() >= deadline:
                raise RemoteTaskError(f"timed out waiting for workload {workload_id}")
            time.sleep(args.poll_interval)
            workload = request(base_url, "GET", f"/workloads/{workload_id}")

        prompt = (
            f"{args.task.rstrip()}\n\n"
            f"Relevant captured context is mounted read-only at {workspace_path}. "
            "Inspect only the files needed for this task. End your answer with exactly one line "
            "`CONTEXT_FILES_USED: path1, path2` (or `CONTEXT_FILES_USED: none`)."
        )
        body = {"sessionId": session_id, "kind": "prompt", "prompt": prompt, "workloadId": workload_id}
        if args.async_run:
            body["async"] = True
        dispatch_start = time.time()
        result = request(base_url, "POST", "/runs", body)
        emit(telemetry, {
            "event": "submitted", "delegationId": delegation_id, "sessionId": session_id,
            "workloadId": workload_id, "async": args.async_run,
        })
        if args.async_run:
            result = wait_for_result(base_url, session_id, args.timeout, args.poll_interval)

        terminal = isinstance(result, dict) and result.get("status") in TERMINAL
        if terminal:
            emit(telemetry, {
                "event": "completed", "delegationId": delegation_id, "sessionId": session_id,
                "status": result.get("status"), "transportedFiles": files, "transportedBytes": byte_count,
                "selfReportedFilesUsed": used_files(result),
                "dispatchElapsedMs": round((time.time() - dispatch_start) * 1000),
                "totalElapsedMs": round((time.time() - started) * 1000),
            })
    finally:
        if not args.keep_workload:
            try:
                request(base_url, "DELETE", f"/workloads/{workload_id}")
            except RemoteTaskError as cleanup_error:
                emit(telemetry, {
                    "event": "cleanup_failed", "delegationId": delegation_id,
                    "workloadId": workload_id, "error": str(cleanup_error),
                })

    print(json.dumps({
        "delegationId": delegation_id, "sessionId": session_id, "workloadId": workload_id,
        "workspacePath": workspace_path, "result": result, "telemetry": str(telemetry),
    }, indent=2))
    return 0


def status(args: argparse.Namespace) -> int:
    base_url = args.sh_url or os.environ.get("SH_URL", "")
    if not base_url:
        raise RemoteTaskError("SH_URL or --sh-url is required")
    result = request(base_url, "GET", "/runs/status?" + urllib.parse.urlencode({"sessionId": args.session_id}))
    print(json.dumps(result, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="remote_task.py", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="stage context and dispatch a remote task")
    run.add_argument("--context", required=True, help="local filesystem context")
    run.add_argument("--remote-context", required=True, help="PVC context name")
    run.add_argument("--task", required=True)
    run.add_argument("--session-id")
    run.add_argument("--namespace", default=os.environ.get("CS_NAMESPACE", "serverless-harness"))
    run.add_argument("--sh-url")
    run.add_argument("--async", dest="async_run", action="store_true")
    run.add_argument("--keep-workload", action="store_true")
    run.add_argument("--timeout", type=float, default=900)
    run.add_argument("--poll-interval", type=float, default=2)
    run.add_argument("--telemetry", default="~/.contexts/telemetry/moca-delegation.jsonl")
    run.set_defaults(handler=run_task)
    get = commands.add_parser("status", help="read an asynchronous task status")
    get.add_argument("session_id")
    get.add_argument("--sh-url")
    get.set_defaults(handler=status)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        return args.handler(args)
    except RemoteTaskError as exc:
        print(f"remote-task: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
