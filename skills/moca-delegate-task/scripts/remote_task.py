#!/usr/bin/env python3
"""Delegate bounded tasks to MOCA with an uploaded local context."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path, PurePosixPath
from typing import Any


NAME = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL = {"responded", "done", "solved", "failed", "aborted", "paused"}
SUCCESS_TERMINAL = {"responded", "done", "solved"}
CONTEXT_CONTENT_TYPE = "application/vnd.rossoctl.context"


class RemoteTaskError(RuntimeError):
    pass


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RemoteTaskError(f"{' '.join(args[:3])}: {detail}")
    return result


def contextctl(*args: str) -> dict[str, Any]:
    executable = os.environ.get("CONTEXTCTL", "contextctl")
    result = run_command([executable, *args, "--json"])
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RemoteTaskError("contextctl did not return JSON") from exc
    if not isinstance(value, dict):
        raise RemoteTaskError("contextctl returned an unexpected JSON value")
    return value


def request(
    base_url: str,
    method: str,
    path: str,
    body: Any | None = None,
    timeout: float = 30,
) -> Any:
    """Call MOCA using its ordinary host override and session token."""
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
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RemoteTaskError(f"MOCA {method} {path} returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RemoteTaskError(f"MOCA {method} {path} failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RemoteTaskError(f"MOCA {method} {path} timed out after {timeout:g} seconds") from exc
    return json.loads(raw) if raw else None


def upload_bundle(
    upload_url: str,
    token: str,
    bundle: Path,
    method: str,
    content_type: str,
    max_bytes: int,
) -> dict[str, Any]:
    """PUT a bundle directly using only the one-time upload capability."""
    parsed_url = urllib.parse.urlparse(upload_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise RemoteTaskError("MOCA returned an invalid context upload URL")
    if method != "PUT":
        raise RemoteTaskError("MOCA returned an unsupported context upload method")
    if content_type != CONTEXT_CONTENT_TYPE:
        raise RemoteTaskError("MOCA returned an unsupported context upload content type")
    bundle_size = bundle.stat().st_size
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
        raise RemoteTaskError("MOCA returned an invalid context upload size limit")
    if bundle_size > max_bytes:
        raise RemoteTaskError(
            f"context bundle is {bundle_size} bytes; upload limit is {max_bytes} bytes"
        )
    try:
        with bundle.open("rb") as stream:
            req = urllib.request.Request(
                upload_url,
                data=stream,
                headers={
                    "accept": "application/json",
                    "authorization": f"Bearer {token}",
                    "content-length": str(bundle_size),
                    "content-type": content_type,
                },
                method=method,
            )
            with urllib.request.urlopen(req, timeout=300) as response:
                raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RemoteTaskError(f"context upload returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RemoteTaskError(f"context upload failed: {exc.reason}") from exc
    try:
        result = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise RemoteTaskError("context upload did not return JSON") from exc
    if not isinstance(result, dict):
        raise RemoteTaskError("context upload returned an unexpected JSON value")
    relative_path = result.get("workspacePath", result.get("path"))
    if not isinstance(relative_path, str) or not relative_path:
        raise RemoteTaskError("context upload response did not include a workspace path")
    parsed_path = PurePosixPath(relative_path)
    if parsed_path.is_absolute() or ".." in parsed_path.parts:
        raise RemoteTaskError("context upload returned an invalid workspace path")
    revision = result.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
        raise RemoteTaskError("context upload returned an invalid revision")
    expected_path = PurePosixPath(".context-service") / "materialized" / revision
    if parsed_path != expected_path:
        raise RemoteTaskError("context upload returned a workspace path for a different revision")
    result["workspacePath"] = "/workspace"
    return result


def export_context(context: str, bundle: Path) -> dict[str, Any]:
    result = contextctl("ctx", "export", context, "--output", str(bundle))
    if not bundle.is_file():
        raise RemoteTaskError("contextctl did not create the exported context bundle")
    return result


def exported_bundle_bytes(bundle: Path, exported: dict[str, Any]) -> int:
    return bundle.stat().st_size if bundle.is_file() else int(exported.get("bytes") or 0)


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


def create_workload(
    base_url: str,
    workload_id: str,
    sandboxes: int,
    shared: bool,
    timeout: float,
    interval: float,
    context_type: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": workload_id,
        "sandboxes": sandboxes,
        "contextUpload": True,
        "workspace": {"shared": shared, "readOnly": True},
    }
    # Context Service accepts an upload only into a Context of the bundle's type.
    if context_type:
        body["contextType"] = "state" if context_type == "history" else context_type
    workload = request(base_url, "POST", "/workloads", body)
    return workload


def activate_ready_workload(
    base_url: str,
    workload_id: str,
    revision: str,
    timeout: float,
    interval: float,
) -> dict[str, Any]:
    workload = request(
        base_url, "POST", f"/workloads/{workload_id}/activate", {"revision": revision}
    )
    deadline = time.monotonic() + timeout
    while str(workload.get("status", "")).lower() != "ready" or workload.get("readyReplicas", 0) < 1:
        if time.monotonic() >= deadline:
            raise RemoteTaskError(f"timed out waiting for workload {workload_id}")
        time.sleep(interval)
        workload = request(base_url, "GET", f"/workloads/{workload_id}")
    return workload


def upload_context(
    capability: dict[str, Any],
    context: str,
    bundle: Path,
    exported: dict[str, Any],
    delegation_id: str,
    telemetry: Path,
    started: float,
) -> tuple[str, int, int, str]:
    upload_url = capability.get("uploadUrl")
    token = capability.get("token")
    if not isinstance(upload_url, str) or not upload_url or not isinstance(token, str) or not token:
        raise RemoteTaskError("MOCA returned an incomplete upload capability")
    method = capability.get("method")
    content_type = capability.get("contentType")
    max_bytes = capability.get("maxBytes")
    uploaded = upload_bundle(
        upload_url,
        token,
        bundle,
        method,
        content_type,
        max_bytes,
    )
    workspace_path = str(uploaded["workspacePath"])
    files = int(uploaded.get("fileCount", uploaded.get("files", exported.get("files", 0))))
    byte_count = int(uploaded.get("byteCount", uploaded.get("bytes", exported.get("bytes", 0))))
    revision = str(uploaded.get("revision", ""))
    emit(telemetry, {
        "event": "context_uploaded", "delegationId": delegation_id,
        "context": context, "revision": revision, "files": files, "bytes": byte_count,
        "elapsedMs": round((time.time() - started) * 1000),
    })
    return workspace_path, files, byte_count, revision


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


def base_url(args: argparse.Namespace) -> str:
    value = args.sh_url or os.environ.get("SH_URL", "")
    if not value:
        raise RemoteTaskError("SH_URL or --sh-url is required")
    return value


def cleanup_workload(url: str, workload_id: str, delegation_id: str, telemetry: Path) -> bool:
    emit(telemetry, {
        "event": "workload_cleanup_requested", "delegationId": delegation_id,
        "workloadId": workload_id,
    })
    try:
        request(url, "DELETE", f"/workloads/{workload_id}", timeout=90)
    except RemoteTaskError as cleanup_error:
        emit(telemetry, {
            "event": "cleanup_failed", "delegationId": delegation_id,
            "workloadId": workload_id, "error": str(cleanup_error),
        })
        return False
    else:
        emit(telemetry, {
            "event": "cleanup_succeeded", "delegationId": delegation_id,
            "workloadId": workload_id,
        })
        return True


def run_task(args: argparse.Namespace) -> int:
    if args.sandboxes < 1:
        raise RemoteTaskError("--sandboxes must be at least 1")
    url = base_url(args)
    delegation_id = f"d-{uuid.uuid4().hex[:12]}"
    session_id = validate_session_id(args.session_id or f"remote-{delegation_id[2:]}")
    telemetry = Path(args.telemetry).expanduser()
    workload_id = f"delegate-{delegation_id[2:]}"
    started = time.time()
    cleanup_ok = True

    with tempfile.TemporaryDirectory(prefix="moca-context-") as directory:
        bundle = Path(directory) / "context.context"
        upload_started = time.time()
        exported = export_context(args.context, bundle)
        emit(telemetry, {
            "event": "context_exported", "delegationId": delegation_id,
            "context": args.context, "files": int(exported.get("files") or 0),
            "bundleBytes": exported_bundle_bytes(bundle, exported),
        })
        try:
            workload = create_workload(
                url, workload_id, args.sandboxes, False, args.timeout, args.poll_interval,
                context_type=exported.get("type"),
            )
            emit(telemetry, {
                "event": "workload_created", "delegationId": delegation_id,
                "workloadId": workload_id, "sandboxes": args.sandboxes,
            })
            capability = workload.get("upload")
            if not isinstance(capability, dict):
                raise RemoteTaskError("MOCA did not return an upload capability")
            workspace_path, files, byte_count, revision = upload_context(
                capability, args.context, bundle, exported, delegation_id, telemetry,
                upload_started,
            )
            ready_workload = activate_ready_workload(
                url, workload_id, revision, args.timeout, args.poll_interval,
            )
            emit(telemetry, {
                "event": "workload_ready", "delegationId": delegation_id,
                "workloadId": workload_id,
                "readySandboxes": int(ready_workload.get("readyReplicas", 0)),
                "sandboxes": args.sandboxes,
            })
            prompt = task_prompt(args.task, workspace_path)
            body = {"sessionId": session_id, "kind": "prompt", "prompt": prompt, "workloadId": workload_id}
            if args.async_run:
                body["async"] = True
            dispatch_start = time.time()
            result = request(url, "POST", "/runs", body)
            emit(telemetry, {
                "event": "submitted", "delegationId": delegation_id, "sessionId": session_id,
                "workloadId": workload_id, "async": args.async_run,
            })
            if args.async_run:
                result = wait_for_result(url, session_id, args.timeout, args.poll_interval)
            if isinstance(result, dict) and result.get("status") in TERMINAL:
                emit(telemetry, {
                    "event": "completed", "delegationId": delegation_id, "sessionId": session_id,
                    "status": result.get("status"), "transportedFiles": files,
                    "transportedBytes": byte_count, "revision": revision,
                    "selfReportedFilesUsed": used_files(result),
                    "dispatchElapsedMs": round((time.time() - dispatch_start) * 1000),
                    "totalElapsedMs": round((time.time() - started) * 1000),
                })
        finally:
            if not args.keep_workload:
                cleanup_ok = cleanup_workload(url, workload_id, delegation_id, telemetry)

    print(json.dumps({
        "delegationId": delegation_id, "sessionId": session_id, "workloadId": workload_id,
        "workspacePath": workspace_path, "revision": revision, "result": result,
        "telemetry": str(telemetry),
    }, indent=2))
    status_name = str(result.get("status", "")) if isinstance(result, dict) else ""
    return 0 if status_name in SUCCESS_TERMINAL and cleanup_ok else 1


def run_batch(args: argparse.Namespace) -> int:
    if args.sandboxes < 1:
        raise RemoteTaskError("--sandboxes must be at least 1")
    tasks = load_tasks(args.tasks)
    if len(tasks) > 25 and not args.allow_large_batch:
        raise RemoteTaskError(f"{len(tasks)} tasks require --allow-large-batch because each task makes a model call")
    url = base_url(args)
    telemetry = Path(args.telemetry).expanduser()
    delegation_id = f"d-{uuid.uuid4().hex[:12]}"
    workload_id = f"delegate-{delegation_id[2:]}"
    started = time.time()
    session_ids: dict[str, str] = {}
    results: dict[str, Any] = {}
    cleanup_ok = True

    with tempfile.TemporaryDirectory(prefix="moca-context-") as directory:
        bundle = Path(directory) / "context.context"
        upload_started = time.time()
        exported = export_context(args.context, bundle)
        emit(telemetry, {
            "event": "context_exported", "delegationId": delegation_id,
            "context": args.context, "files": int(exported.get("files") or 0),
            "bundleBytes": exported_bundle_bytes(bundle, exported),
        })
        try:
            workload = create_workload(
                url, workload_id, args.sandboxes, True, args.timeout, args.poll_interval,
                context_type=exported.get("type"),
            )
            emit(telemetry, {
                "event": "workload_created", "delegationId": delegation_id,
                "workloadId": workload_id, "sandboxes": args.sandboxes,
            })
            capability = workload.get("upload")
            if not isinstance(capability, dict):
                raise RemoteTaskError("MOCA did not return an upload capability")
            workspace_path, files, byte_count, revision = upload_context(
                capability, args.context, bundle, exported, delegation_id, telemetry,
                upload_started,
            )
            ready_workload = activate_ready_workload(
                url, workload_id, revision, args.timeout, args.poll_interval,
            )
            emit(telemetry, {
                "event": "workload_ready", "delegationId": delegation_id,
                "workloadId": workload_id,
                "readySandboxes": int(ready_workload.get("readyReplicas", 0)),
                "sandboxes": args.sandboxes,
            })
            for item in tasks:
                session_id = validate_session_id(f"batch-{delegation_id[2:]}-{item['id']}")
                session_ids[item["id"]] = session_id
                request(url, "POST", "/runs", {
                    "sessionId": session_id, "kind": "prompt",
                    "prompt": task_prompt(item["task"], workspace_path),
                    "workloadId": workload_id, "async": True,
                })
                emit(telemetry, {
                    "event": "submitted", "delegationId": delegation_id,
                    "sessionId": session_id, "workloadId": workload_id,
                    "taskId": item["id"], "async": True,
                })

            pending = set(session_ids)
            deadline = time.monotonic() + args.timeout
            while pending and time.monotonic() < deadline:
                for task_id in list(pending):
                    query = urllib.parse.urlencode({"sessionId": session_ids[task_id]})
                    result = request(url, "GET", f"/runs/status?{query}")
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
                cleanup_ok = cleanup_workload(url, workload_id, delegation_id, telemetry)

    status_counts: dict[str, int] = {}
    for result in results.values():
        status_name = str(result.get("status", "unknown"))
        status_counts[status_name] = status_counts.get(status_name, 0) + 1
    failed = len(pending) + sum(count for name, count in status_counts.items() if name not in SUCCESS_TERMINAL)
    summary = {
        "delegationId": delegation_id, "workloadId": workload_id,
        "workspacePath": workspace_path, "revision": revision,
        "transportedFiles": files, "transportedBytes": byte_count,
        "tasks": len(tasks), "completed": len(results), "failed": failed,
        "statusCounts": status_counts, "timedOut": bool(pending),
        "cleanup": "retained" if args.keep_workload else ("succeeded" if cleanup_ok else "failed"),
        "unfinishedTasks": sorted(pending),
        "totalElapsedMs": round((time.time() - started) * 1000),
        "results": results, "telemetry": str(telemetry),
    }
    emit(telemetry, {"event": "batch_completed", **{k: v for k, v in summary.items() if k != "results"}})
    print(json.dumps(summary, indent=2))
    return 1 if failed or not cleanup_ok else 0


def status(args: argparse.Namespace) -> int:
    result = request(base_url(args), "GET", "/runs/status?" + urllib.parse.urlencode({"sessionId": args.session_id}))
    print(json.dumps(result, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="remote_task.py", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="upload context and dispatch a remote task")
    run.add_argument("--context", required=True, help="local filesystem context")
    run.add_argument("--task", required=True)
    run.add_argument("--session-id")
    run.add_argument("--sh-url")
    run.add_argument("--async", dest="async_run", action="store_true")
    run.add_argument("--sandboxes", type=int, default=1)
    run.add_argument("--keep-workload", action="store_true")
    run.add_argument("--timeout", type=float, default=900)
    run.add_argument("--poll-interval", type=float, default=2)
    run.add_argument("--telemetry", default="~/.contexts/telemetry/moca-delegation.jsonl")
    run.set_defaults(handler=run_task)
    batch = commands.add_parser("batch", help="upload context once and dispatch JSONL tasks")
    batch.add_argument("--context", required=True, help="local filesystem context")
    batch.add_argument("--tasks", required=True, help="JSONL file with id and task fields")
    batch.add_argument("--sandboxes", type=int, default=3)
    batch.add_argument("--allow-large-batch", action="store_true", help="confirm more than 25 model calls")
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
