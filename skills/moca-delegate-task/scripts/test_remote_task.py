import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, patch


MODULE_PATH = Path(__file__).with_name("remote_task.py")
SPEC = importlib.util.spec_from_file_location("moca_remote_task", MODULE_PATH)
remote_task = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(remote_task)

CAPABILITY = {
    "uploadUrl": "https://context.example.test/upload",
    "token": "one-time-token",
    "expiresAt": "2026-09-30T12:00:00Z",
    "method": "PUT",
    "contentType": remote_task.CONTEXT_CONTENT_TYPE,
    "maxBytes": 1024,
}


class Response:
    def __init__(self, value):
        self.raw = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.raw


def task_args(directory: str, **overrides):
    values = {
        "context": "local",
        "task": "Summarize the decision.",
        "session_id": "test-session",
        "sh_url": "https://moca.example.test",
        "telemetry": str(Path(directory) / "events.jsonl"),
        "timeout": 1,
        "poll_interval": 0,
        "async_run": False,
        "sandboxes": 1,
        "keep_workload": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class RemoteTaskTest(unittest.TestCase):
    @patch.object(remote_task, "request")
    def test_create_workload_requests_initial_upload_capability(self, request):
        request.return_value = {"workloadId": "workload", "upload": CAPABILITY}

        result = remote_task.create_workload(
            "https://moca.example.test", "workload", 2, True, 1, 0
        )

        self.assertEqual(result["upload"], CAPABILITY)
        request.assert_called_once_with("https://moca.example.test", "POST", "/workloads", {
            "name": "workload",
            "sandboxes": 2,
            "contextUpload": True,
            "workspace": {"shared": True, "readOnly": True},
        })

    @patch.object(remote_task, "request")
    def test_create_workload_declares_the_exported_context_type(self, request):
        remote_task.create_workload(
            "https://moca.example.test", "workload", 1, False, 1, 0, context_type="artifacts"
        )

        self.assertEqual(request.call_args.args[3]["contextType"], "artifacts")

    @patch.object(remote_task, "request")
    def test_create_workload_normalizes_legacy_history_type(self, request):
        remote_task.create_workload(
            "https://moca.example.test", "workload", 1, False, 1, 0, context_type="history"
        )

        self.assertEqual(request.call_args.args[3]["contextType"], "state")

    def test_used_files_are_explicitly_self_reported(self):
        result = {"text": "Done.\nCONTEXT_FILES_USED: harnesses/a.jsonl, memory/MEMORY.md"}
        self.assertEqual(
            remote_task.used_files(result),
            ["harnesses/a.jsonl", "memory/MEMORY.md"],
        )

    def test_emit_appends_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            remote_task.emit(path, {"event": "one"})
            remote_task.emit(path, {"event": "two"})
            self.assertEqual(
                [json.loads(line)["event"] for line in path.read_text().splitlines()],
                ["one", "two"],
            )

    @patch.object(remote_task, "request")
    def test_cleanup_failure_is_reported(self, request):
        request.side_effect = remote_task.RemoteTaskError("context still in use")
        with tempfile.TemporaryDirectory() as directory:
            telemetry = Path(directory) / "events.jsonl"
            self.assertFalse(
                remote_task.cleanup_workload(
                    "https://moca.example.test", "workload", "delegation", telemetry
                )
            )
            events = [json.loads(line) for line in telemetry.read_text().splitlines()]

        self.assertEqual([event["event"] for event in events], [
            "workload_cleanup_requested", "cleanup_failed",
        ])

    @patch.object(remote_task.urllib.request, "urlopen")
    def test_upload_uses_only_capability_headers(self, urlopen):
        captured = {}

        def receive(request, timeout):
            captured["body"] = request.data.read()
            captured["timeout"] = timeout
            revision = "a" * 64
            return Response({
                "workspacePath": f".context-service/materialized/{revision}",
                "files": 2,
                "bytes": 42,
                "revision": revision,
            })

        urlopen.side_effect = receive
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "context.context"
            bundle.write_bytes(b"portable-context")
            with patch.dict(os.environ, {"SH_TOKEN": "moca-token", "SH_HOST": "moca.internal"}):
                result = remote_task.upload_bundle(
                    "https://context.example.test/upload",
                    "one-time-token",
                    bundle,
                    "PUT",
                    remote_task.CONTEXT_CONTENT_TYPE,
                    1024,
                )

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "PUT")
        self.assertEqual(captured["body"], b"portable-context")
        self.assertEqual(request.get_header("Content-length"), str(len(b"portable-context")))
        self.assertEqual(request.get_header("Authorization"), "Bearer one-time-token")
        self.assertEqual(request.get_header("Content-type"), remote_task.CONTEXT_CONTENT_TYPE)
        self.assertIsNone(request.get_header("Host"))
        self.assertNotIn(b"moca-token", captured["body"])
        self.assertEqual(result["workspacePath"], "/workspace")

    @patch.object(remote_task.urllib.request, "urlopen")
    def test_upload_rejects_workspace_path_for_another_revision(self, urlopen):
        urlopen.return_value = Response({
            "workspacePath": f".context-service/materialized/{'b' * 64}",
            "files": 1,
            "bytes": 1,
            "revision": "a" * 64,
        })
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "context.context"
            bundle.write_bytes(b"x")
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "different revision"):
                remote_task.upload_bundle(
                    "https://context.example.test/upload",
                    "one-time-token",
                    bundle,
                    "PUT",
                    remote_task.CONTEXT_CONTENT_TYPE,
                    1024,
                )

    @patch.object(remote_task, "upload_bundle")
    @patch.object(remote_task, "export_context")
    def test_upload_context_uses_create_capability(self, export_context, upload_bundle):
        def export(_name, path):
            path.write_bytes(b"bundle")
            return {"file": str(path), "files": 2, "bytes": 42}

        export_context.side_effect = export
        upload_bundle.return_value = {
            "workspacePath": "/workspace",
            "files": 2,
            "bytes": 42,
            "revision": "a" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "context.context"
            telemetry = Path(directory) / "events.jsonl"
            exported = remote_task.export_context("local", bundle)
            result = remote_task.upload_context(
                CAPABILITY, "local", bundle, exported,
                "d-123", telemetry, 0,
            )
            events = [json.loads(line) for line in telemetry.read_text().splitlines()]

        self.assertEqual(result, ("/workspace", 2, 42, "a" * 64))
        upload_bundle.assert_called_once_with(
            "https://context.example.test/upload",
            "one-time-token",
            bundle,
            "PUT",
            remote_task.CONTEXT_CONTENT_TYPE,
            1024,
        )
        self.assertEqual(events[0]["event"], "context_uploaded")

    @patch.object(remote_task.urllib.request, "urlopen")
    def test_upload_rejects_bundle_larger_than_capability(self, urlopen):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "context.context"
            bundle.write_bytes(b"too-large")
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "upload limit"):
                remote_task.upload_bundle(
                    "https://context.example.test/upload",
                    "one-time-token",
                    bundle,
                    "PUT",
                    remote_task.CONTEXT_CONTENT_TYPE,
                    3,
                )
        urlopen.assert_not_called()

    @patch.object(remote_task.time, "monotonic", side_effect=[0, 2])
    @patch.object(remote_task, "request")
    def test_workload_timeout_leaves_cleanup_to_the_caller(self, request, _monotonic):
        request.return_value = {"status": "provisioning", "readyReplicas": 0}
        with self.assertRaisesRegex(remote_task.RemoteTaskError, "timed out"):
            remote_task.activate_ready_workload(
                "https://moca.example.test", "workload", "a" * 64, 1, 0
            )
        self.assertEqual(request.call_args_list[0].args[1:3], (
            "POST", "/workloads/workload/activate"
        ))
        self.assertEqual(len(request.call_args_list), 1)

    @patch.object(remote_task, "upload_context", return_value=("/workspace", 2, 42, "a" * 64))
    @patch.object(
        remote_task, "export_context",
        return_value={"files": 2, "bytes": 42, "type": "artifacts"},
    )
    @patch.object(remote_task, "activate_ready_workload")
    @patch.object(remote_task, "create_workload")
    @patch.object(remote_task, "request")
    def test_run_task_uses_managed_workspace_upload_and_cleans_up(
        self, request, create_workload, activate_workload, export_context, upload_context
    ):
        create_workload.return_value = {"upload": CAPABILITY}
        request.side_effect = [
            {"status": "responded", "text": "ok\nCONTEXT_FILES_USED: reports/a.txt"},
            None,
        ]
        with tempfile.TemporaryDirectory() as directory:
            args = task_args(directory)
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_task(args), 0)
            events = [json.loads(line) for line in Path(args.telemetry).read_text().splitlines()]

        create_workload.assert_called_once_with(
            "https://moca.example.test", ANY, 1, False, 1, 0, context_type="artifacts"
        )
        activate_workload.assert_called_once_with(
            "https://moca.example.test", ANY, "a" * 64, 1, 0
        )
        bundle = upload_context.call_args.args[2]
        self.assertFalse(bundle.exists())
        export_context.assert_called_once_with("local", bundle)
        prompt_body = request.call_args_list[0].args[3]
        self.assertIn("/workspace", prompt_body["prompt"])
        self.assertEqual(prompt_body["sessionId"], "test-session")
        self.assertEqual(request.call_args_list[-1].args[1], "DELETE")
        completed = next(event for event in events if event["event"] == "completed")
        self.assertEqual(completed["selfReportedFilesUsed"], ["reports/a.txt"])
        self.assertEqual(events[-1]["event"], "cleanup_succeeded")

    @patch.object(remote_task, "upload_context")
    @patch.object(remote_task, "export_context")
    @patch.object(remote_task, "activate_ready_workload")
    @patch.object(remote_task, "create_workload")
    def test_run_task_rejects_session_id_before_creating_workload(
        self, create_workload, activate_workload, export_context, upload_context
    ):
        with tempfile.TemporaryDirectory() as directory:
            args = task_args(directory, session_id="bad/id")
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "slashes are not allowed"):
                remote_task.run_task(args)
        create_workload.assert_not_called()
        activate_workload.assert_not_called()
        export_context.assert_not_called()
        upload_context.assert_not_called()

    @patch.object(remote_task, "upload_context", return_value=("/workspace", 1, 10, "b" * 64))
    @patch.object(remote_task, "export_context", return_value={"files": 1, "bytes": 10})
    @patch.object(remote_task, "activate_ready_workload")
    @patch.object(remote_task, "create_workload")
    @patch.object(remote_task, "request")
    def test_run_task_returns_nonzero_for_remote_failure(
        self, request, create_workload, _activate, _export, _upload
    ):
        create_workload.return_value = {"upload": CAPABILITY}
        request.side_effect = [{"status": "failed", "reason": "error"}, None]
        with tempfile.TemporaryDirectory() as directory:
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_task(task_args(directory)), 1)

    def test_load_tasks_reads_jsonl_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.jsonl"
            path.write_text('{"id":"one","task":"First"}\n{"id":"two","task":"Second"}\n')
            self.assertEqual(
                remote_task.load_tasks(str(path)),
                [{"id": "one", "task": "First"}, {"id": "two", "task": "Second"}],
            )
            path.write_text('{"id":"one","task":"First"}\n{"id":"one","task":"Again"}\n')
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "duplicate id one"):
                remote_task.load_tasks(str(path))

    def test_run_batch_requires_explicit_large_batch_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text("".join(
                json.dumps({"id": f"task-{number}", "task": "Check it"}) + "\n"
                for number in range(26)
            ))
            args = SimpleNamespace(
                context="local", tasks=str(tasks), sandboxes=2, allow_large_batch=False
            )
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "--allow-large-batch"):
                remote_task.run_batch(args)

    @patch.object(remote_task, "upload_context", return_value=("/workspace", 3, 20, "c" * 64))
    @patch.object(remote_task, "export_context", return_value={"files": 3, "bytes": 20})
    @patch.object(remote_task, "activate_ready_workload")
    @patch.object(remote_task, "create_workload")
    @patch.object(remote_task, "request")
    def test_run_batch_uploads_once_and_reuses_shared_workload(
        self, request, create_workload, activate_workload, export_context, upload_context
    ):
        create_workload.return_value = {"upload": CAPABILITY}
        request.side_effect = [
            {"status": "accepted"},
            {"status": "accepted"},
            {"status": "responded", "text": "one\nCONTEXT_FILES_USED: reports/one"},
            {"status": "responded", "text": "two\nCONTEXT_FILES_USED: reports/two"},
            None,
        ]
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text('{"id":"one","task":"First"}\n{"id":"two","task":"Second"}\n')
            args = SimpleNamespace(
                context="local", tasks=str(tasks), sandboxes=2, allow_large_batch=False,
                sh_url="https://moca.example.test", keep_workload=False,
                timeout=1, poll_interval=0,
                telemetry=str(Path(directory) / "events.jsonl"),
            )
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_batch(args), 0)
            events = [json.loads(line) for line in Path(args.telemetry).read_text().splitlines()]

        create_workload.assert_called_once_with(
            "https://moca.example.test", ANY, 2, True, 1, 0, context_type=None
        )
        activate_workload.assert_called_once()
        export_context.assert_called_once()
        upload_context.assert_called_once()
        posts = [call for call in request.call_args_list if call.args[1:3] == ("POST", "/runs")]
        self.assertEqual(len(posts), 2)
        self.assertTrue(all("/workspace" in call.args[3]["prompt"] for call in posts))
        self.assertTrue(all("/" not in call.args[3]["sessionId"] for call in posts))
        self.assertEqual(request.call_args_list[-1].args[1], "DELETE")
        event_names = [event["event"] for event in events]
        self.assertIn("context_exported", event_names)
        self.assertIn("workload_created", event_names)
        self.assertIn("workload_ready", event_names)
        self.assertEqual(event_names.count("submitted"), 2)
        self.assertEqual(event_names.count("completed"), 2)
        self.assertIn("cleanup_succeeded", event_names)
        self.assertEqual(event_names[-1], "batch_completed")

    @patch.object(remote_task, "upload_context", return_value=("/workspace", 3, 20, "c" * 64))
    @patch.object(remote_task, "export_context", return_value={"files": 3, "bytes": 20})
    @patch.object(remote_task, "activate_ready_workload")
    @patch.object(remote_task, "create_workload")
    @patch.object(remote_task, "request")
    def test_run_batch_prints_partial_summary_on_timeout(
        self, request, create_workload, _activate, _export, _upload
    ):
        create_workload.return_value = {"upload": CAPABILITY}
        request.side_effect = [{"status": "accepted"}, None]
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text('{"id":"one","task":"First"}\n')
            args = SimpleNamespace(
                context="local", tasks=str(tasks), sandboxes=1, allow_large_batch=False,
                sh_url="https://moca.example.test", keep_workload=False,
                timeout=0, poll_interval=0,
                telemetry=str(Path(directory) / "events.jsonl"),
            )
            with patch("builtins.print") as output:
                self.assertEqual(remote_task.run_batch(args), 1)
            summary = json.loads(output.call_args_list[-1].args[0])
        self.assertTrue(summary["timedOut"])
        self.assertEqual(summary["unfinishedTasks"], ["one"])

    def test_removed_cluster_arguments_are_not_accepted(self):
        parser = remote_task.parser()
        with patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                parser.parse_args([
                    "run", "--context", "local", "--task", "check",
                    "--remote-context", "remote", "--namespace", "default",
                ])


if __name__ == "__main__":
    unittest.main()
