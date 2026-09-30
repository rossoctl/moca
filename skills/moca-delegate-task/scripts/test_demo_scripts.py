import importlib.util
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


if __name__ == "__main__":
    unittest.main()
