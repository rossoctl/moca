#!/usr/bin/env python3
"""Generate a deterministic incident corpus and one remote task per report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


SERVICES = ["checkout", "catalog", "identity", "search", "notifications"]
REGIONS = ["us-east", "us-south", "eu-de", "jp-tok"]
CAUSES = ["expired-certificate", "connection-pool", "bad-deployment", "quota-exhaustion"]
SEVERITIES = ["sev1", "sev2", "sev3"]


def generate(count: int, root: Path) -> tuple[Path, Path]:
    incidents = root / "incidents"
    incidents.mkdir(parents=True, exist_ok=True)
    for old_report in incidents.glob("incident-*.txt"):
        old_report.unlink()
    tasks = root / "tasks.jsonl"
    expected = root / "expected.json"
    answers: dict[str, dict[str, str]] = {}

    with tasks.open("w", encoding="utf-8") as task_stream:
        for number in range(1, count + 1):
            task_id = f"incident-{number:03d}"
            filename = f"{task_id}.txt"
            service = SERVICES[(number - 1) % len(SERVICES)]
            region = REGIONS[(number * 3 - 1) % len(REGIONS)]
            cause = CAUSES[(number * 5 - 1) % len(CAUSES)]
            severity = SEVERITIES[(number * 7 - 1) % len(SEVERITIES)]
            (incidents / filename).write_text(
                "\n".join([
                    f"Incident: {task_id}",
                    f"Service: {service}",
                    f"Region: {region}",
                    f"Severity: {severity}",
                    f"Observed cause: {cause}",
                    "Status: mitigated",
                    f"Resolution: operators isolated {service} and corrected {cause}.",
                    "",
                ]),
                encoding="utf-8",
            )
            prompt = (
                f"Read artifacts/index.json and locate the artifact named {filename}. "
                "Read its referenced object. Return one compact JSON object with exactly the keys "
                f"incident, service, region, severity, and cause for {task_id}."
            )
            task_stream.write(json.dumps({"id": task_id, "task": prompt}) + "\n")
            answers[task_id] = {
                "incident": task_id,
                "service": service,
                "region": region,
                "severity": severity,
                "cause": cause,
            }

    expected.write_text(json.dumps(answers, indent=2) + "\n", encoding="utf-8")
    return tasks, expected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=12)
    parser.add_argument("--output", default="/tmp/moca-context-fanout")
    args = parser.parse_args()
    if args.count < 1 or args.count > 500:
        parser.error("--count must be between 1 and 500")

    root = Path(args.output).expanduser().resolve()
    tasks, expected = generate(args.count, root)
    print(f"Generated {args.count} incidents in {root}")
    print(f"Tasks:    {tasks}")
    print(f"Expected: {expected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
