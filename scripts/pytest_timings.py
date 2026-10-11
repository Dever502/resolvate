"""Print a reviewable shard timing snapshot from successful pytest JUnit reports."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from xml.etree import ElementTree

from select_pytest_shard import discover_test_files


def collect_timings(reports: list[Path], root: Path) -> dict[str, float]:
    known = {item.path.as_posix() for item in discover_test_files(root)}
    totals: dict[str, float] = {}
    seen: set[tuple[str, str]] = set()
    for report in reports:
        tree = ElementTree.parse(report)
        if tree.findall(".//failure") or tree.findall(".//error"):
            raise ValueError("Only successful runs may replace the timing snapshot")
        for case in tree.iter("testcase"):
            if case.find("skipped") is not None:
                continue
            classname, name = case.get("classname", ""), case.get("name", "")
            if (classname, name) in seen:
                raise ValueError("Reports contain duplicate tests; use one complete run")
            seen.add((classname, name))
            parts = classname.split(".")
            while parts and (path := "/".join(parts) + ".py") not in known:
                parts.pop()
            if not parts:
                continue
            duration = float(case.get("time", "0"))
            if not math.isfinite(duration) or duration < 0:
                raise ValueError("Invalid duration in JUnit report")
            totals[path] = totals.get(path, 0) + duration
    if set(totals) != known:
        raise ValueError("Reports must cover every non-PostgreSQL-only test file")
    return {path: max(0.001, round(value, 3)) for path, value in sorted(totals.items())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+")
    args = parser.parse_args()
    print(json.dumps(collect_timings(args.reports, Path(__file__).resolve().parents[1]), indent=2))
