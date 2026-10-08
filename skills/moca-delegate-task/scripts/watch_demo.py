#!/usr/bin/env python3
"""Show a concise live view of the MOCA delegation demo."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any


def size(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if amount < 1024 or unit == "GiB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{int(value)} B"


class Display:
    def __init__(self, task_count: int) -> None:
        self.task_count = task_count
        self.submitted = 0
        self.completed = 0
        self.batch_complete = False

    def event(self, item: dict[str, Any]) -> None:
        event = item.get("event")
        if event == "context_exported":
            print(
                f"  ✓ Context packed into one bundle: {item.get('files', 0)} files, "
                f"{size(int(item.get('bundleBytes', 0)))} compressed",
                flush=True,
            )
        elif event == "workload_created":
            print(
                f"  ✓ Moca workload: {item.get('workloadId')} "
                f"({item.get('sandboxes', 0)} Sandboxes requested)",
                flush=True,
            )
        elif event == "context_uploaded":
            revision = str(item.get("revision", ""))
            print(
                f"  ✓ Bundle uploaded once: {item.get('files', 0)} files, "
                f"{size(int(item.get('bytes', 0)))} → revision {revision[:12]}…",
                flush=True,
            )
        elif event == "workload_ready":
            print(
                f"  ✓ Shared read-only workspace: {item.get('readySandboxes', 0)}/"
                f"{item.get('sandboxes', 0)} Sandboxes ready",
                flush=True,
            )
        elif event == "submitted":
            self.submitted += 1
            if self.submitted == 1:
                print(f"  ◉ Task dispatch started ({self.task_count} total)", flush=True)
            if self.submitted == self.task_count:
                print(f"  ✓ Tasks submitted: {self.submitted}/{self.task_count}", flush=True)
        elif event == "completed":
            self.completed += 1
            task_id = item.get("taskId") or item.get("sessionId") or "task"
            succeeded = item.get("status") in {"responded", "done", "solved"}
            mark = "✓" if succeeded else "✗"
            if self.task_count <= 25 or self.completed % 10 == 0 or self.completed == self.task_count:
                print(
                    f"  {mark} {task_id}: {item.get('status', 'unknown')} "
                    f"({self.completed}/{self.task_count})",
                    flush=True,
                )
        elif event == "workload_cleanup_requested":
            print("  ✓ Transient Moca workload cleanup requested", flush=True)
        elif event == "batch_completed":
            self.batch_complete = True
            elapsed = float(item.get("totalElapsedMs", 0)) / 1000
            print(
                f"  ✓ Batch complete: {item.get('completed', 0)}/{item.get('tasks', 0)} "
                f"tasks in {elapsed:.1f}s",
                flush=True,
            )
        elif event == "cleanup_succeeded":
            print("  ✓ Transient Moca workload removed", flush=True)
        elif event == "cleanup_failed":
            print(f"  ✗ Workload cleanup failed: {item.get('error', 'unknown error')}", flush=True)


def show_files(files_directory: Path) -> None:
    files = sorted(path.name for path in files_directory.glob("*.txt"))
    print("\nBEHIND THE SCENES", flush=True)
    print(f"  ✓ Selected local context: {len(files)} incident files", flush=True)
    for start in range(0, len(files), 4):
        print("    " + "  ".join(files[start : start + 4]), flush=True)


def watch(telemetry: Path, files_directory: Path, done: Path, task_count: int) -> int:
    show_files(files_directory)
    display = Display(task_count)
    offset = 0
    idle_after_done = 0
    while True:
        if telemetry.exists():
            with telemetry.open(encoding="utf-8") as stream:
                stream.seek(offset)
                for line in stream:
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict):
                        display.event(item)
                offset = stream.tell()
        if done.exists():
            idle_after_done += 1
            if idle_after_done >= 2:
                break
        time.sleep(0.1)
    status = int(done.read_text(encoding="utf-8").strip() or "1")
    if status and not display.batch_complete:
        print("  ✗ Demo stopped before the batch completed. See remote-task.log.", flush=True)
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latest", action="store_true", help="follow the newest local demo run")
    parser.add_argument("--telemetry", type=Path)
    parser.add_argument("--files", type=Path)
    parser.add_argument("--done", type=Path)
    parser.add_argument("--tasks", type=int)
    args = parser.parse_args()
    if args.latest:
        root = Path(os.environ.get("OUTPUT_ROOT", "/tmp/moca-delegate-demo"))
        runs = [path for path in root.iterdir() if path.is_dir()] if root.is_dir() else []
        if not runs:
            parser.error(f"no demo runs found in {root}")
        run = max(runs, key=lambda path: path.stat().st_mtime)
        tasks_file = run / "tasks.jsonl"
        if not tasks_file.is_file():
            parser.error(f"the latest demo run is incomplete: {run}")
        task_count = sum(1 for line in tasks_file.read_text(encoding="utf-8").splitlines() if line.strip())
        return watch(run / "telemetry.jsonl", run / "incidents", run / "demo.done", task_count)
    if args.telemetry is None or args.files is None or args.done is None or args.tasks is None:
        parser.error("use --latest or provide --telemetry, --files, --done, and --tasks")
    return watch(args.telemetry, args.files, args.done, args.tasks)


if __name__ == "__main__":
    raise SystemExit(main())
