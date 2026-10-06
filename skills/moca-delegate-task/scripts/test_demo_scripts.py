import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


def load_script(name: str):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


generator = load_script("generate_incident_demo.py")
validator = load_script("validate_incident_demo.py")
watcher = load_script("watch_demo.py")


class DemoScriptsTest(unittest.TestCase):
    def test_generator_creates_exact_requested_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generator.generate(5, root)
            generator.generate(2, root)
            self.assertEqual(len(list((root / "incidents").glob("incident-*.txt"))), 2)
            self.assertEqual(len((root / "tasks.jsonl").read_text().splitlines()), 2)

    def test_validator_finds_json_inside_agent_text(self):
        text = 'Result:\n```json\n{"incident":"incident-001","severity":"sev1"}\n```'
        self.assertEqual(
            validator.first_object(text),
            {"incident": "incident-001", "severity": "sev1"},
        )

    def test_kind_demo_help_has_no_cluster_side_effects(self):
        script = Path(__file__).with_name("run-kind-demo.sh")
        result = subprocess.run(
            [str(script), "--help"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("Generate synthetic incidents", result.stdout)
        self.assertIn("--allow-large-batch", result.stdout)
        self.assertIn("--quiet", result.stdout)

    def test_kind_setup_reuses_the_existing_context_service_token(self):
        script = Path(__file__).with_name("setup-kind-demo.sh").read_text(encoding="utf-8")
        self.assertIn("context-service-control-plane", script)
        self.assertIn("existing_token", script)
        self.assertIn("differs from the existing demo token", script)

    def test_demo_removes_only_its_local_contexts(self):
        script = Path(__file__).with_name("run-kind-demo.sh").read_text(encoding="utf-8")
        self.assertIn('ctx delete "$artifact_context" --backend filesystem', script)
        self.assertIn('ctx delete "$source_context" --backend filesystem', script)
        self.assertIn('CONTEXTCTL="${CONTEXTCTL:-contextctl}"', script)

    def test_watcher_formats_sizes(self):
        self.assertEqual(watcher.size(512), "512 B")
        self.assertEqual(watcher.size(1536), "1.5 KiB")

    def test_watcher_reports_context_and_task_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = root / "incidents"
            files.mkdir()
            (files / "incident-001.txt").write_text("one", encoding="utf-8")
            (files / "incident-002.txt").write_text("two", encoding="utf-8")
            telemetry = root / "telemetry.jsonl"
            events = [
                {"event": "context_exported", "files": 3, "bundleBytes": 1536},
                {"event": "workload_created", "workloadId": "delegate-test", "sandboxes": 2},
                {"event": "context_uploaded", "files": 3, "bytes": 2048, "revision": "a" * 64},
                {"event": "workload_ready", "readySandboxes": 2, "sandboxes": 2},
                {"event": "submitted", "taskId": "incident-001"},
                {"event": "submitted", "taskId": "incident-002"},
                {"event": "completed", "taskId": "incident-001", "status": "done"},
                {"event": "completed", "taskId": "incident-002", "status": "done"},
                {"event": "workload_cleanup_requested"},
                {"event": "cleanup_succeeded"},
                {"event": "batch_completed", "completed": 2, "tasks": 2, "totalElapsedMs": 1200},
            ]
            telemetry.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )
            done = root / "done"
            done.write_text("0\n", encoding="utf-8")
            result = subprocess.run(
                [
                    "python3", str(Path(__file__).with_name("watch_demo.py")),
                    "--telemetry", str(telemetry), "--files", str(files),
                    "--done", str(done), "--tasks", "2",
                ],
                check=True, capture_output=True, text=True,
            )
            self.assertIn("Selected local context: 2 incident files", result.stdout)
            self.assertIn("Bundle uploaded once: 3 files, 2.0 KiB", result.stdout)
            self.assertIn("Shared read-only workspace: 2/2 Sandboxes ready", result.stdout)
            self.assertIn("Batch complete: 2/2 tasks", result.stdout)
            self.assertIn("Transient Moca workload removed", result.stdout)

    def test_watcher_does_not_claim_failed_cleanup_succeeded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = root / "incidents"
            files.mkdir()
            telemetry = root / "telemetry.jsonl"
            telemetry.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in [
                        {"event": "cleanup_failed", "error": "context still in use"},
                        {"event": "batch_completed", "completed": 1, "tasks": 1},
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            done = root / "done"
            done.write_text("0\n", encoding="utf-8")

            result = subprocess.run(
                [
                    "python3", str(Path(__file__).with_name("watch_demo.py")),
                    "--telemetry", str(telemetry), "--files", str(files),
                    "--done", str(done), "--tasks", "1",
                ],
                check=True, capture_output=True, text=True,
            )

            self.assertIn("Workload cleanup failed", result.stdout)
            self.assertNotIn("Transient Moca workload removed", result.stdout)


if __name__ == "__main__":
    unittest.main()
