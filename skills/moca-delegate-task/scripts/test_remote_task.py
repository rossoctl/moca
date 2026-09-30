import importlib.util
import json
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


class RemoteTaskTest(unittest.TestCase):
    def test_latest_stats_selects_current_revision(self):
        manifest = {
            "currentRevision": "b",
            "revisions": [
                {"id": "a", "files": 1, "bytes": 2},
                {"id": "b", "files": 3, "bytes": 5},
            ],
        }
        self.assertEqual(remote_task.latest_stats(manifest), ("b", 3, 5))

    def test_claim_name_rejects_non_pvc_context(self):
        with self.assertRaisesRegex(remote_task.RemoteTaskError, "not backed by a PVC"):
            remote_task.claim_name({"attachment": {"kind": "filesystem"}})

    def test_used_files_are_explicitly_self_reported(self):
        result = {"text": "Done.\nCONTEXT_FILES_USED: harnesses/claude/a.jsonl, memory/MEMORY.md"}
        self.assertEqual(
            remote_task.used_files(result),
            ["harnesses/claude/a.jsonl", "memory/MEMORY.md"],
        )

    @patch.object(remote_task.subprocess, "run")
    @patch.object(remote_task, "run_command")
    def test_materialize_uses_context_bundle_object_name(self, run_command, cleanup):
        digest = "a" * 64
        run_command.side_effect = [
            SimpleNamespace(stdout=""),
            SimpleNamespace(stdout=""),
            SimpleNamespace(stdout=digest + "\n"),
        ]
        path = remote_task.materialize("team1", "context-demo", "d-123456789abc")

        exec_args = run_command.call_args_list[2].args[0]
        self.assertIn("/context/.context-service/objects/$digest.context", exec_args[-1])
        self.assertEqual(path, f"/workspace/.context-service/materialized/{digest}")
        cleanup.assert_called_once()

    def test_emit_appends_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            remote_task.emit(path, {"event": "one"})
            remote_task.emit(path, {"event": "two"})
            self.assertEqual(
                [json.loads(line)["event"] for line in path.read_text().splitlines()],
                ["one", "two"],
            )

    @patch.object(remote_task, "materialize", return_value="/workspace/.context-service/materialized/abc")
    @patch.object(remote_task, "run_command")
    @patch.object(remote_task, "contextctl")
    @patch.object(remote_task, "request")
    def test_run_task_orchestrates_context_workload_and_prompt(
        self, request, contextctl, run_command, materialize
    ):
        local = {
            "name": "local",
            "type": "state",
            "currentRevision": "rev",
            "revisions": [{"id": "rev", "files": 2, "bytes": 10}],
        }
        remote = {"attachment": {"kind": "pvc", "claimName": "context-cloud"}}
        contextctl.side_effect = [local, remote, remote, local]
        request.side_effect = [
            {"status": "ready", "readyReplicas": 1},
            {"status": "responded", "text": "ok\nCONTEXT_FILES_USED: harnesses/a.jsonl"},
            None,
        ]
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(
                context="local",
                remote_context="cloud",
                task="Summarize the decision.",
                session_id="test/session",
                namespace="serverless-harness",
                sh_url="https://sh.example.test",
                telemetry=str(Path(directory) / "events.jsonl"),
                timeout=1,
                poll_interval=0,
                async_run=False,
                keep_workload=False,
            )
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_task(args), 0)
            events = [json.loads(line) for line in Path(args.telemetry).read_text().splitlines()]

        materialize.assert_called_once_with("serverless-harness", "context-cloud", ANY)
        self.assertEqual([event["event"] for event in events], ["context_staged", "submitted", "completed"])
        self.assertEqual(events[-1]["selfReportedFilesUsed"], ["harnesses/a.jsonl"])
        self.assertEqual(request.call_args_list[-1].args[:3], ("https://sh.example.test", "DELETE", ANY))


if __name__ == "__main__":
    unittest.main()
