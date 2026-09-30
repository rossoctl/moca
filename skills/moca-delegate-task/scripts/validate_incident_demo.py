#!/usr/bin/env python3
"""Compare MOCA incident fan-out answers with the deterministic expected data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def first_object(text: str) -> dict[str, str] | None:
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", required=True)
    parser.add_argument("--expected", required=True)
    args = parser.parse_args()

    summary = json.loads(Path(args.results).read_text(encoding="utf-8"))
    expected = json.loads(Path(args.expected).read_text(encoding="utf-8"))
    results = summary.get("results", {})
    failures: list[str] = []
    for task_id, want in expected.items():
        result = results.get(task_id)
        if not isinstance(result, dict):
            failures.append(f"{task_id}: missing result")
            continue
        got = first_object(str(result.get("text", "")))
        if got != want:
            failures.append(f"{task_id}: expected {want}, got {got}")

    unexpected = sorted(set(results) - set(expected))
    failures.extend(f"{task_id}: unexpected result" for task_id in unexpected)
    if failures:
        print(f"FAILED: {len(failures)} problem(s)")
        for failure in failures[:20]:
            print(f"- {failure}")
        return 1
    print(f"PASS: {len(expected)} of {len(expected)} incident results matched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
