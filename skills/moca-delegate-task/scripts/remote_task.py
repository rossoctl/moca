#!/usr/bin/env python3
"""Delegate a bounded prompt to MOCA with context transported by Context Service."""

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
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL = {"responded", "done", "solved", "failed", "aborted", "paused"}
SUCCESS_TERMINAL = {"responded", "done", "solved"}


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
    host = os.environ.get("SH_HOST", "").strip()
    if host:
        headers["host"] = host
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


def stage_context(
    context: str,
    remote_context: str,
    namespace: str,
    delegation_id: str,
    telemetry: Path,
) -> tuple[str, str, int, int]:
    """Capture local context and materialize it as remote context."""
    local = contextctl("ctx", "get", context, "--backend", "filesystem")
    context_type = "state" if local.get("type") == "history" else local.get("type")
    try:
        remote = contextctl(
            "ctx", "get", remote_context, "--backend", "pvc", "--namespace", namespace
        )
    except RemoteTaskError as exc:
        if "not found" not in str(exc).lower() and "404" not in str(exc):
            raise
        remote = contextctl(
            "ctx", "create", remote_context, "--type", str(context_type),
            "--backend", "pvc", "--namespace", namespace,
        )

    sync_start = time.time()
    run_command([
        os.environ.get("CONTEXTCTL", "contextctl"), "ctx", "sync", "push", context,
        "--remote-name", remote_context, "--namespace", namespace,
    ])
    remote = contextctl(
        "ctx", "get", remote_context, "--backend", "pvc", "--namespace", namespace
    )
    revision, files, byte_count = latest_stats(
        contextctl("ctx", "get", context, "--backend", "filesystem")
    )
    remote_namespace = str(remote.get("namespace") or namespace)
    claim = claim_name(remote)
    workspace_path = materialize(remote_namespace, claim, delegation_id)
    emit(telemetry, {
        "event": "context_staged", "delegationId": delegation_id,
        "context": context, "remoteContext": remote_context, "revision": revision,
        "files": files, "bytes": byte_count,
        "elapsedMs": round((time.time() - sync_start) * 1000),
    })
    return claim, workspace_path, files, byte_count


def create_ready_workload(
    base_url: str,
    workload_id: str,
    claim: str,
    sandboxes: int,
    timeout: float,
    interval: float,
    cleanup_on_failure: bool = True,
) -> dict[str, Any]:
    workload = request(base_url, "POST", "/workloads", {
        "name": workload_id,
        "sandboxes": sandboxes,
        "workspace": {"claimName": claim, "readOnly": True},
    })
    try:
        deadline = time.monotonic() + timeout
        while str(workload.get("status", "")).lower() != "ready" or workload.get("readyReplicas", 0) < 1:
            if time.monotonic() >= deadline:
                raise RemoteTaskError(f"timed out waiting for workload {workload_id}")
            time.sleep(interval)
            workload = request(base_url, "GET", f"/workloads/{workload_id}")
    except Exception:
        if cleanup_on_failure:
            try:
                request(base_url, "DELETE", f"/workloads/{workload_id}")
            except RemoteTaskError:
                pass
        raise
    return workload


def task_prompt(task: str, workspace_path: str) -> str:
    return (
        f"{task.rstrip()}\n\n"
        f"Relevant captured context is mounted read-only at {workspace_path}. "
        "Inspect only the files needed for this task. End your answer with exactly one line "
        "`CONTEXT_FILES_USED: path1, path2` (or `CONTEXT_FILES_USED: none`)."
    )


def load_tasks(path: str) -> list[dict[str, str]]:
    tasks: list[dict[str, str]] = []
    seen: set[str] = set()
    with Path(path).open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RemoteTaskError(f"{path}:{line_number}: invalid JSON") from exc
            task_id = item.get("id") if isinstance(item, dict) else None
            prompt = item.get("task") if isinstance(item, dict) else None
            if not isinstance(task_id, str) or not NAME.fullmatch(task_id):
                raise RemoteTaskError(f"{path}:{line_number}: id must be a lowercase Kubernetes name")
            if task_id in seen:
                raise RemoteTaskError(f"{path}:{line_number}: duplicate id {task_id}")
            if not isinstance(prompt, str) or not prompt.strip():
                raise RemoteTaskError(f"{path}:{line_number}: task must be a non-empty string")
            seen.add(task_id)
            tasks.append({"id": task_id, "task": prompt})
    if not tasks:
        raise RemoteTaskError(f"{path}: no tasks found")
    return tasks


def validate_session_id(value: str) -> str:
    if not SESSION_ID.fullmatch(value):
        raise RemoteTaskError(
            "session ID must be 1-128 letters, numbers, dots, underscores, or hyphens; slashes are not allowed"
        )
    return value


def run_task(args: argparse.Namespace) -> int:
    if not NAME.fullmatch(args.remote_context):
        raise RemoteTaskError("--remote-context must be a lowercase Kubernetes name")
    if args.sandboxes < 1:
        raise RemoteTaskError("--sandboxes must be at least 1")
    base_url = args.sh_url or os.environ.get("SH_URL", "")
    if not base_url:
        raise RemoteTaskError("SH_URL or --sh-url is required")
    delegation_id = f"d-{uuid.uuid4().hex[:12]}"
    session_id = validate_session_id(args.session_id or f"remote-{delegation_id[2:]}")
    telemetry = Path(args.telemetry).expanduser()
    workload_id = f"delegate-{delegation_id[2:]}"
    started = time.time()
    claim, workspace_path, files, byte_count = stage_context(
        args.context, args.remote_context, args.namespace, delegation_id, telemetry
    )
    create_ready_workload(
        base_url, workload_id, claim, args.sandboxes, args.timeout, args.poll_interval,
        cleanup_on_failure=not args.keep_workload,
    )
    terminal = False
    try:
        prompt = task_prompt(args.task, workspace_path)
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
    status_name = str(result.get("status", "")) if isinstance(result, dict) else ""
    return 0 if status_name in SUCCESS_TERMINAL else 1


def run_batch(args: argparse.Namespace) -> int:
    if not NAME.fullmatch(args.remote_context):
        raise RemoteTaskError("--remote-context must be a lowercase Kubernetes name")
    if args.sandboxes < 1:
        raise RemoteTaskError("--sandboxes must be at least 1")
    tasks = load_tasks(args.tasks)
    if len(tasks) > 25 and not args.allow_large_batch:
        raise RemoteTaskError(
            f"{len(tasks)} tasks require --allow-large-batch because each task makes a model call"
        )
    base_url = args.sh_url or os.environ.get("SH_URL", "")
    if not base_url:
        raise RemoteTaskError("SH_URL or --sh-url is required")

    telemetry = Path(args.telemetry).expanduser()
    delegation_id = f"d-{uuid.uuid4().hex[:12]}"
    workload_id = f"delegate-{delegation_id[2:]}"
    started = time.time()
    claim, workspace_path, files, byte_count = stage_context(
        args.context, args.remote_context, args.namespace, delegation_id, telemetry
    )
    create_ready_workload(
        base_url, workload_id, claim, args.sandboxes, args.timeout, args.poll_interval,
        cleanup_on_failure=not args.keep_workload,
    )

    session_ids: dict[str, str] = {}
    results: dict[str, Any] = {}
    try:
        for item in tasks:
            session_id = validate_session_id(f"batch-{delegation_id[2:]}-{item['id']}")
            session_ids[item["id"]] = session_id
            request(base_url, "POST", "/runs", {
                "sessionId": session_id,
                "kind": "prompt",
                "prompt": task_prompt(item["task"], workspace_path),
                "workloadId": workload_id,
                "async": True,
            })
            emit(telemetry, {
                "event": "submitted", "delegationId": delegation_id,
                "sessionId": session_id, "workloadId": workload_id, "taskId": item["id"],
                "async": True,
            })

        pending = set(session_ids)
        deadline = time.monotonic() + args.timeout
        while pending and time.monotonic() < deadline:
            for task_id in list(pending):
                query = urllib.parse.urlencode({"sessionId": session_ids[task_id]})
                result = request(base_url, "GET", f"/runs/status?{query}")
                if isinstance(result, dict) and result.get("status") in TERMINAL:
                    results[task_id] = result
                    pending.remove(task_id)
                    emit(telemetry, {
                        "event": "completed", "delegationId": delegation_id,
                        "sessionId": session_ids[task_id], "workloadId": workload_id,
                        "taskId": task_id, "status": result.get("status"),
                        "selfReportedFilesUsed": used_files(result),
                    })
            if pending:
                print(f"Completed {len(results)}/{len(tasks)} tasks", file=sys.stderr)
                time.sleep(args.poll_interval)
    finally:
        if not args.keep_workload:
            try:
                request(base_url, "DELETE", f"/workloads/{workload_id}")
            except RemoteTaskError as cleanup_error:
                emit(telemetry, {
                    "event": "cleanup_failed", "delegationId": delegation_id,
                    "workloadId": workload_id, "error": str(cleanup_error),
                })

    status_counts: dict[str, int] = {}
    for result in results.values():
        status_name = str(result.get("status", "unknown"))
        status_counts[status_name] = status_counts.get(status_name, 0) + 1
    failed = len(pending) + sum(
        count for status_name, count in status_counts.items() if status_name not in SUCCESS_TERMINAL
    )
    summary = {
        "delegationId": delegation_id,
        "workloadId": workload_id,
        "workspacePath": workspace_path,
        "transportedFiles": files,
        "transportedBytes": byte_count,
        "tasks": len(tasks),
        "completed": len(results),
        "failed": failed,
        "statusCounts": status_counts,
        "timedOut": bool(pending),
        "unfinishedTasks": sorted(pending),
        "totalElapsedMs": round((time.time() - started) * 1000),
        "results": results,
        "telemetry": str(telemetry),
    }
    emit(telemetry, {"event": "batch_completed", **{k: v for k, v in summary.items() if k != "results"}})
    print(json.dumps(summary, indent=2))
    return 1 if failed else 0


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
    run.add_argument("--remote-context", required=True, help="remote context name")
    run.add_argument("--task", required=True)
    run.add_argument("--session-id")
    run.add_argument("--namespace", default=os.environ.get("CS_NAMESPACE", "serverless-harness"))
    run.add_argument("--sh-url")
    run.add_argument("--async", dest="async_run", action="store_true")
    run.add_argument("--sandboxes", type=int, default=1)
    run.add_argument("--keep-workload", action="store_true")
    run.add_argument("--timeout", type=float, default=900)
    run.add_argument("--poll-interval", type=float, default=2)
    run.add_argument("--telemetry", default="~/.contexts/telemetry/moca-delegation.jsonl")
    run.set_defaults(handler=run_task)
    batch = commands.add_parser("batch", help="stage context once and dispatch JSONL tasks")
    batch.add_argument("--context", required=True, help="local filesystem context")
    batch.add_argument("--remote-context", required=True, help="remote context name")
    batch.add_argument("--tasks", required=True, help="JSONL file with id and task fields")
    batch.add_argument("--sandboxes", type=int, default=3)
    batch.add_argument(
        "--allow-large-batch", action="store_true",
        help="confirm intentional dispatch of more than 25 model calls",
    )
    batch.add_argument("--namespace", default=os.environ.get("CS_NAMESPACE", "serverless-harness"))
    batch.add_argument("--sh-url")
    batch.add_argument("--keep-workload", action="store_true")
    batch.add_argument("--timeout", type=float, default=1800)
    batch.add_argument("--poll-interval", type=float, default=2)
    batch.add_argument("--telemetry", default="~/.contexts/telemetry/moca-delegation.jsonl")
    batch.set_defaults(handler=run_batch)
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
