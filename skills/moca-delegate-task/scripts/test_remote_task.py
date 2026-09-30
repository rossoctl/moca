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

    @patch.object(remote_task, "materialize", return_value="/workspace/revision")
    @patch.object(remote_task, "run_command")
    @patch.object(remote_task, "contextctl")
    def test_stage_context_syncs_and_materializes_exactly_once(self, contextctl, run_command, materialize):
        local = {
            "type": "artifacts", "currentRevision": "rev",
            "revisions": [{"id": "rev", "files": 4, "bytes": 40}],
        }
        remote = {
            "namespace": "default",
            "attachment": {"kind": "pvc", "claimName": "context-cloud"},
        }
        contextctl.side_effect = [local, remote, remote, local]
        with tempfile.TemporaryDirectory() as directory:
            result = remote_task.stage_context(
                "local", "cloud", "default", "d-123", Path(directory) / "events.jsonl"
            )
        self.assertEqual(result, ("context-cloud", "/workspace/revision", 4, 40))
        self.assertEqual(run_command.call_count, 1)
        materialize.assert_called_once_with("default", "context-cloud", "d-123")

    def test_emit_appends_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            remote_task.emit(path, {"event": "one"})
            remote_task.emit(path, {"event": "two"})
            self.assertEqual(
                [json.loads(line)["event"] for line in path.read_text().splitlines()],
                ["one", "two"],
            )

    @patch.object(remote_task.time, "monotonic", side_effect=[0, 2])
    @patch.object(remote_task, "request")
    def test_workload_timeout_triggers_cleanup(self, request, monotonic):
        request.side_effect = [
            {"status": "provisioning", "readyReplicas": 0},
            None,
        ]
        with self.assertRaisesRegex(remote_task.RemoteTaskError, "timed out"):
            remote_task.create_ready_workload(
                "https://moca.example.test", "workload", "claim", 1, 1, 0
            )
        self.assertEqual(request.call_args_list[-1].args[1:3], ("DELETE", "/workloads/workload"))

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
                session_id="test-session",
                namespace="serverless-harness",
                sh_url="https://sh.example.test",
                telemetry=str(Path(directory) / "events.jsonl"),
                timeout=1,
                poll_interval=0,
                async_run=False,
                sandboxes=1,
                keep_workload=False,
            )
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_task(args), 0)
            events = [json.loads(line) for line in Path(args.telemetry).read_text().splitlines()]

        materialize.assert_called_once_with("serverless-harness", "context-cloud", ANY)
        self.assertEqual([event["event"] for event in events], ["context_staged", "submitted", "completed"])
        self.assertEqual(events[-1]["selfReportedFilesUsed"], ["harnesses/a.jsonl"])
        prompt_body = request.call_args_list[1].args[3]
        self.assertEqual(prompt_body["sessionId"], "test-session")
        self.assertEqual(request.call_args_list[-1].args[:3], ("https://sh.example.test", "DELETE", ANY))

    @patch.object(remote_task, "stage_context")
    def test_run_task_rejects_session_id_with_slash_before_staging(self, stage_context):
        args = SimpleNamespace(
            context="local", remote_context="cloud", task="Check it", session_id="bad/id",
            sandboxes=1, sh_url="https://moca.example.test",
        )
        with self.assertRaisesRegex(remote_task.RemoteTaskError, "slashes are not allowed"):
            remote_task.run_task(args)
        stage_context.assert_not_called()

    @patch.object(remote_task, "create_ready_workload")
    @patch.object(remote_task, "stage_context", return_value=("context-cloud", "/workspace/rev", 1, 10))
    @patch.object(remote_task, "request")
    def test_run_task_returns_nonzero_for_remote_failure(self, request, stage_context, create_workload):
        request.side_effect = [
            {"status": "failed", "reason": "error"},
            None,
        ]
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(
                context="local", remote_context="cloud", task="Check it", session_id=None,
                namespace="default", sh_url="https://moca.example.test", sandboxes=1,
                timeout=1, poll_interval=0, async_run=False, keep_workload=False,
                telemetry=str(Path(directory) / "events.jsonl"),
            )
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_task(args), 1)

    def test_load_tasks_reads_jsonl_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.jsonl"
            path.write_text(
                '{"id":"one","task":"First"}\n{"id":"two","task":"Second"}\n',
                encoding="utf-8",
            )
            self.assertEqual(
                remote_task.load_tasks(str(path)),
                [{"id": "one", "task": "First"}, {"id": "two", "task": "Second"}],
            )
            path.write_text(
                '{"id":"one","task":"First"}\n{"id":"one","task":"Again"}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "duplicate id one"):
                remote_task.load_tasks(str(path))

    def test_run_batch_requires_explicit_large_batch_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text(
                "".join(
                    json.dumps({"id": f"task-{number}", "task": "Check it"}) + "\n"
                    for number in range(26)
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                context="local", remote_context="cloud", tasks=str(tasks), sandboxes=2,
                allow_large_batch=False,
            )
            with self.assertRaisesRegex(remote_task.RemoteTaskError, "--allow-large-batch"):
                remote_task.run_batch(args)

    @patch.object(remote_task, "create_ready_workload")
    @patch.object(remote_task, "stage_context", return_value=("context-cloud", "/workspace/rev", 3, 20))
    @patch.object(remote_task, "request")
    def test_run_batch_stages_once_and_reuses_one_workload(self, request, stage_context, create_workload):
        request.side_effect = [
            {"status": "accepted"},
            {"status": "accepted"},
            {"status": "responded", "text": "one\nCONTEXT_FILES_USED: artifacts/one"},
            {"status": "responded", "text": "two\nCONTEXT_FILES_USED: artifacts/two"},
            None,
        ]
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text(
                '{"id":"one","task":"First"}\n{"id":"two","task":"Second"}\n',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                context="local", remote_context="cloud", tasks=str(tasks), sandboxes=2,
                allow_large_batch=False,
                namespace="default", sh_url="https://moca.example.test", keep_workload=False,
                timeout=1, poll_interval=0, telemetry=str(Path(directory) / "events.jsonl"),
            )
            with patch("builtins.print"):
                self.assertEqual(remote_task.run_batch(args), 0)

        stage_context.assert_called_once()
        create_workload.assert_called_once_with(
            "https://moca.example.test", ANY, "context-cloud", 2, 1, 0,
            cleanup_on_failure=True,
        )
        posts = [call for call in request.call_args_list if call.args[1:3] == ("POST", "/runs")]
        self.assertEqual(len(posts), 2)
        self.assertEqual({call.args[3]["workloadId"] for call in posts}, {posts[0].args[3]["workloadId"]})
        self.assertTrue(all("/workspace/rev" in call.args[3]["prompt"] for call in posts))
        self.assertTrue(all("/" not in call.args[3]["sessionId"] for call in posts))
        self.assertEqual(request.call_args_list[-1].args[1], "DELETE")

    @patch.object(remote_task, "create_ready_workload")
    @patch.object(remote_task, "stage_context", return_value=("context-cloud", "/workspace/rev", 3, 20))
    @patch.object(remote_task, "request")
    def test_run_batch_prints_partial_summary_on_timeout(self, request, stage_context, create_workload):
        request.side_effect = [{"status": "accepted"}, None]
        with tempfile.TemporaryDirectory() as directory:
            tasks = Path(directory) / "tasks.jsonl"
            tasks.write_text('{"id":"one","task":"First"}\n', encoding="utf-8")
            args = SimpleNamespace(
                context="local", remote_context="cloud", tasks=str(tasks), sandboxes=1,
                allow_large_batch=False, namespace="default", sh_url="https://moca.example.test",
                keep_workload=False, timeout=0, poll_interval=0,
                telemetry=str(Path(directory) / "events.jsonl"),
            )
            with patch("builtins.print") as output:
                self.assertEqual(remote_task.run_batch(args), 1)
            summary = json.loads(output.call_args_list[-1].args[0])
        self.assertTrue(summary["timedOut"])
        self.assertEqual(summary["unfinishedTasks"], ["one"])
        self.assertEqual(summary["completed"], 0)


if __name__ == "__main__":
    unittest.main()
